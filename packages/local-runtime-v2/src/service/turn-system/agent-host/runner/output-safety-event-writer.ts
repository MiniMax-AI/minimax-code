import type { PiEventWriter } from '@mavis/agent-core/pi-turn-runner';
import {
  MsgType,
  RespDataType,
  ToolCallStatus,
  type AgentMessage,
  type RespData,
  type ToolCall,
} from '@mavis/agent-core/protocol/agent-message';
import { readPtcChildExecutionDetails, readPtcExecutionDetails } from '@mavis/agent-core/tools';
import {
  sanitizePtcChildExecutionDetailsForSafety,
  sanitizePtcExecutionDetailsForSafety,
} from '@mavis/agent-tools';
import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import type { MetricsClient } from '@mavis/shared/metrics-proxy';
import {
  RUNTIME_EVENT_SCHEMA,
  RuntimeEventStatus,
  RuntimeEventType,
  type IRuntimeEvent,
} from '@mavis/protocol';

import {
  reviewBlocks,
  SAFETY_SCENE,
  type ContentSafetyReviewPort,
  type SafetyScene,
  type SafetyCheckResult,
} from '../../../content-safety/index.js';

export const OUTPUT_SAFETY_CHUNK_THRESHOLD = 80;
/** A safety review that waited at least this long is reported as a slow read. */
export const SAFETY_REVIEW_SLOW_READ_MS = 15_000;
export const OUTPUT_SAFETY_LOCAL_ERROR_MAX_RETRIES = 3;
export const OUTPUT_SAFETY_LOCAL_ERROR_RETRY_MAX_DELAY_MS = 5_000;

export interface LocalOutputSafetyOptions {
  readonly sessionId: string;
  readonly turnId: string;
  readonly reviewRequired?: boolean;
  readonly checkText: ContentSafetyReviewPort;
  readonly chunkThreshold?: number;
  readonly localErrorMaxRetries?: number;
  readonly retryDelay?: () => Promise<void>;
  readonly onBlocked?: () => void;
  readonly persistApprovedPartialOnNetworkStop?: boolean;
  readonly authErrorVariant?: 'auth';
  readonly metricsClient?: MetricsClient;
  /** Called for every review that waited at least `SAFETY_REVIEW_SLOW_READ_MS` (pass, block and error); the caller dedupes. */
  readonly onSlowReview?: () => void;
  /** Set only by the host's final authorized PTC catalog. */
  readonly ptcEnabled?: boolean;
}

/**
 * V2-owned review-before-release writer. It preserves producer order in one queue and releases text
 * only after threshold, phase-boundary, or final review. `finish` and the first tool-call settle
 * short text windows before their frames become releasable, so a foreground tool cannot make the
 * parent stream wait for the delayed final message. Content rejection and review-network exhaustion
 * are exposed as state for the owning runner; no v1 sink is involved.
 */
export class LocalOutputSafetyEventWriter implements PiEventWriter {
  blocked = false;
  immediateBlock = false;
  guidePrompt: string | undefined;
  networkStopped = false;
  reviewStopVariant: 'network' | 'auth' = 'network';
  terminalFailed = false;

  private readonly pendingQueue: PendingEvent[] = [];
  private readonly thinkingWindow: PendingEvent[] = [];
  private readonly contentWindow: PendingEvent[] = [];
  private readonly threshold: number;
  private readonly localErrorMaxRetries: number;
  private readonly retryDelay: () => Promise<void>;
  private readonly deliveryLane = new KeyedOperationLane<'delivery'>();
  private thinkingText = '';
  private contentText = '';
  private approvedThinking = '';
  private approvedContent = '';
  private approvedMsgId: string | undefined;
  private safetyReviewUnknown = false;
  private readonly attemptMessageIds = new Set<string>();
  private deliveryTail: Promise<void> = Promise.resolve();
  private deliveryFailure: { readonly error: unknown } | undefined;
  private readonly ptcParentIds = new Set<string>();
  private ptcChildObserved = false;

  constructor(
    private readonly inner: PiEventWriter,
    private readonly options: LocalOutputSafetyOptions,
  ) {
    this.threshold = options.chunkThreshold ?? OUTPUT_SAFETY_CHUNK_THRESHOLD;
    this.localErrorMaxRetries =
      options.localErrorMaxRetries ?? OUTPUT_SAFETY_LOCAL_ERROR_MAX_RETRIES;
    this.retryDelay = options.retryDelay ?? defaultLocalErrorRetryDelay;
  }

  getApprovedPartial(): {
    readonly thinking: string;
    readonly content: string;
    readonly msgId: string | undefined;
  } {
    return {
      thinking: this.approvedThinking,
      content: this.approvedContent,
      msgId: this.approvedMsgId,
    };
  }

  getAttemptMessageIds(): readonly string[] {
    return [...this.attemptMessageIds];
  }

  hasPtcChildCalls(): boolean {
    return this.ptcChildObserved;
  }

  async pushRuntime(event: IRuntimeEvent): Promise<void> {
    if (this.options.reviewRequired === false) {
      const waitForDelivery = await this.deliveryLane.run('delivery', async () => {
        if (this.ptcLifecycleChunk(event)) return this.deliverRuntime(event);
        this.recordUnreviewedPartial(event);
        this.enqueueReady(event);
        return true;
      });
      if (waitForDelivery) await this.drain();
      return;
    }
    const waitForDelivery = await this.deliveryLane.run('delivery', () =>
      this.deliverRuntime(event),
    );
    if (waitForDelivery) await this.drain();
  }

  private async deliverRuntime(event: IRuntimeEvent): Promise<boolean> {
    const ptc = this.ptcLifecycleChunk(event);
    if (ptc) {
      await this.deliverPtcLifecycle(event, ptc);
      return true;
    }
    if (this.blocked) return false;
    if (this.networkStopped) {
      await this.handleNetworkStoppedEvent(event);
      return false;
    }
    if (event.type !== RuntimeEventType.STREAM_RESP) {
      this.enqueueReady(event);
      return true;
    }

    const response = parseStreamResp(event);
    if (!response) {
      this.enqueueReady(event);
      return true;
    }
    if (response.type === RespDataType.AgentMessageChunk && response.agent_message_chunk) {
      await this.handleChunk(event, response.agent_message_chunk);
      return true;
    }
    if (response.type === RespDataType.AgentMessage && response.agent_message) {
      return this.deliverFinalMessage(event, response.agent_message);
    }
    this.enqueueReady(event);
    return true;
  }

  private async deliverFinalMessage(event: IRuntimeEvent, message: AgentMessage): Promise<boolean> {
    if (message.msg_type === MsgType.SystemEvent) {
      this.enqueueReady(event);
      return false;
    }
    await this.handleFinalMessage(event, message);
    return true;
  }

  private ptcLifecycleChunk(
    event: IRuntimeEvent,
  ): NonNullable<RespData['agent_message_chunk']> | undefined {
    if (this.options.ptcEnabled !== true || event.type !== RuntimeEventType.STREAM_RESP)
      return undefined;
    const response = parseStreamResp(event);
    const chunk =
      response?.type === RespDataType.AgentMessageChunk ? response.agent_message_chunk : undefined;
    return chunk?.tool_calls?.some(isPtcLifecycleCall) ? chunk : undefined;
  }

  private async deliverPtcLifecycle(
    event: IRuntimeEvent,
    chunk: NonNullable<RespData['agent_message_chunk']>,
  ): Promise<void> {
    const calls = (chunk.tool_calls ?? []).filter(isPtcLifecycleCall);
    if (calls.some((call) => call.tool_call_status === ToolCallStatus.Start)) {
      if (this.isStopped() || !(await this.flushStreamingWindows())) {
        throw new Error(
          'PTC start delivery was blocked by safety review; no child operation was admitted.',
        );
      }
    }
    this.registerPtcCalls(calls);
    if (chunk.msg_id) this.attemptMessageIds.add(chunk.msg_id);
    const safeChunk = {
      ...chunk,
      tool_calls: this.isStopped() ? calls.map(safeStoppedPtcCall) : calls,
    };
    delete safeChunk.msg_content;
    delete safeChunk.thinking_content;
    await this.queueDelivery(() =>
      this.inner.appendEvents([
        {
          ...event,
          payload: {
            ...event.payload,
            stream_resp: JSON.stringify({
              type: RespDataType.AgentMessageChunk,
              agent_message_chunk: safeChunk,
            }),
          },
        },
      ]),
    );
  }

  private registerPtcCalls(calls: readonly ToolCall[]): void {
    for (const call of calls) {
      if (call.parent_tool_call_id && !this.ptcParentIds.has(call.parent_tool_call_id)) {
        throw new Error('PTC child delivery has no acknowledged parent start.');
      }
      if (
        !call.parent_tool_call_id &&
        call.tool_name === 'run_code' &&
        call.tool_call_status === ToolCallStatus.Start
      ) {
        this.ptcParentIds.add(call.tool_call_id);
      }
      if (call.parent_tool_call_id && call.tool_call_status === ToolCallStatus.Start)
        this.ptcChildObserved = true;
    }
  }

  /** BYOK output is released immediately but still needs a cancellation history snapshot. */
  private recordUnreviewedPartial(event: IRuntimeEvent): void {
    if (event.type !== RuntimeEventType.STREAM_RESP) return;
    const response = parseStreamResp(event);
    if (response?.type === RespDataType.AgentMessageChunk && response.agent_message_chunk) {
      this.recordReleasedText(response.agent_message_chunk, false);
    } else if (
      response?.type === RespDataType.AgentMessage &&
      response.agent_message &&
      response.agent_message.msg_type !== MsgType.SystemEvent
    ) {
      this.recordReleasedText(response.agent_message, true);
    }
  }

  private recordReleasedText(
    message: Pick<
      AgentMessage,
      'msg_id' | 'thinking_content' | 'msg_content' | 'msg_content_source'
    >,
    isFinal: boolean,
  ): void {
    if (message.msg_id && message.msg_id !== this.approvedMsgId) {
      this.approvedMsgId = message.msg_id;
      this.approvedThinking = '';
      this.approvedContent = '';
      this.attemptMessageIds.add(message.msg_id);
    }
    if (message.thinking_content) {
      this.approvedThinking = isFinal
        ? message.thinking_content
        : this.approvedThinking + message.thinking_content;
    }
    if (message.msg_content && message.msg_content_source !== 'system_error') {
      this.approvedContent = isFinal
        ? message.msg_content
        : this.approvedContent + message.msg_content;
    }
  }

  private async handleNetworkStoppedEvent(event: IRuntimeEvent): Promise<void> {
    if (
      event.type !== RuntimeEventType.SESSION_STATUS ||
      event.payload?.status !== RuntimeEventStatus.FAILED
    ) {
      return;
    }
    this.terminalFailed = true;
    await this.queueDelivery(() => this.inner.pushRuntime(event));
  }

  async appendEvents(events: IRuntimeEvent[]): Promise<void> {
    if (this.options.reviewRequired === false) {
      for (const event of events) {
        await this.pushRuntime(event);
        await yieldToEventLoop();
      }
      return;
    }
    let waitForDelivery = false;
    await this.deliveryLane.run('delivery', async () => {
      for (const event of events) {
        waitForDelivery = (await this.deliverRuntime(event)) || waitForDelivery;
      }
    });
    if (waitForDelivery) await this.drain();
  }

  async drain(): Promise<void> {
    await this.deliveryTail;
    if (this.deliveryFailure) throw this.deliveryFailure.error;
  }

  block(): void {
    if (this.blocked) return;
    this.blocked = true;
    this.clearPending();
    this.options.onBlocked?.();
  }

  async softStopNetwork(variant: 'network' | 'auth' = 'network'): Promise<void> {
    if (this.blocked || this.networkStopped) return;
    this.networkStopped = true;
    this.reviewStopVariant = variant;
    try {
      await this.flushApprovedOnNetworkStop();
    } finally {
      this.clearPending();
      this.options.onBlocked?.();
    }
  }

  private async handleChunk(
    event: IRuntimeEvent,
    chunk: NonNullable<RespData['agent_message_chunk']>,
  ): Promise<void> {
    if (typeof chunk.msg_id === 'string' && chunk.msg_id) {
      this.approvedMsgId = chunk.msg_id;
      this.attemptMessageIds.add(chunk.msg_id);
    }
    if (chunk.thinking_content) {
      const pending = this.enqueuePending(event);
      this.thinkingWindow.push(pending);
      this.thinkingText += chunk.thinking_content;
      if (this.thinkingText.length >= this.threshold) {
        await this.flushStreamingWindow('thinking');
      }
      return;
    }
    if (chunk.msg_content) {
      if (!(await this.flushStreamingWindow('thinking'))) return;
      const pending = this.enqueuePending(event);
      this.contentWindow.push(pending);
      this.contentText += chunk.msg_content;
      if (this.contentText.length >= this.threshold) {
        await this.flushStreamingWindow('content');
      }
      return;
    }
    if (isStreamingPhaseBoundary(chunk)) {
      if (!(await this.flushStreamingWindows())) return;
    }
    this.enqueueReady(event);
  }

  private async handleFinalMessage(event: IRuntimeEvent, message: AgentMessage): Promise<void> {
    if (typeof message.msg_id === 'string' && message.msg_id) {
      this.approvedMsgId = message.msg_id;
      this.attemptMessageIds.add(message.msg_id);
    }
    if (
      !(await this.reviewFinalWindow(
        message.thinking_content,
        this.thinkingText,
        SAFETY_SCENE.ThinkingContent,
      ))
    ) {
      return;
    }
    this.approvedThinking =
      message.thinking_content && message.thinking_content.length > 0
        ? message.thinking_content
        : this.approvedThinking + this.thinkingText;
    this.releaseWindow(this.thinkingWindow);
    this.thinkingText = '';
    this.flushReady();

    if (
      !(await this.reviewFinalWindow(
        message.msg_content,
        this.contentText,
        SAFETY_SCENE.MessageOutput,
      ))
    ) {
      return;
    }
    this.approvedContent =
      message.msg_content && message.msg_content.length > 0
        ? message.msg_content
        : this.approvedContent + this.contentText;
    this.releaseWindow(this.contentWindow);
    this.contentText = '';
    this.enqueueReady(this.safetyReviewUnknown ? markSafetyReviewUnknown(event, message) : event);
  }

  /** Settle all short streaming windows before a finish/tool-call frame can enter ready state. */
  private async flushStreamingWindows(): Promise<boolean> {
    if (!(await this.flushStreamingWindow('thinking'))) return false;
    return this.flushStreamingWindow('content');
  }

  /**
   * Shared settlement path for threshold, thinking-to-content, finish, and tool-call boundaries.
   * A false result means review blocked or network-soft-stopped the attempt; callers must not
   * enqueue the current boundary frame.
   */
  private async flushStreamingWindow(kind: 'thinking' | 'content'): Promise<boolean> {
    const thinking = kind === 'thinking';
    const text = thinking ? this.thinkingText : this.contentText;
    if (text.length === 0) return true;
    const scene = thinking ? SAFETY_SCENE.ThinkingContent : SAFETY_SCENE.StreamChunk;
    if (!(await this.review(text, scene))) return false;

    if (thinking) {
      this.approvedThinking += text;
      this.thinkingText = '';
      this.releaseWindow(this.thinkingWindow);
    } else {
      this.approvedContent += text;
      this.contentText = '';
      this.releaseWindow(this.contentWindow);
    }
    this.flushReady();
    return true;
  }

  private async review(text: string, scene: SafetyScene): Promise<boolean> {
    if (this.isStopped()) return false;
    if (!text.trim()) return true;
    const metrics = this.options.metricsClient;
    let reviewScene = scene;
    for (let attempt = 0; attempt <= this.localErrorMaxRetries; attempt += 1) {
      const startMs = Date.now();
      const result = await this.options.checkText(text, reviewScene);
      if (this.isStopped()) return false;
      if (result.retryWithV2) reviewScene = sceneForV2Retry(reviewScene);
      metrics?.histogram('output_safety_check_duration_ms', Date.now() - startMs);
      if (this.isAuthSoftStop(result)) {
        metrics?.counter('output_safety_error_total', 1, { errorKind: 'auth_error' });
        metrics?.counter('output_safety_check_total', 1, { decision: 'soft_stop_auth' });
        await this.softStopNetwork('auth');
        return false;
      }
      if (isLocalReviewError(result)) {
        metrics?.counter('output_safety_error_total', 1, { errorKind: 'local_error' });
        if (attempt < this.localErrorMaxRetries) {
          metrics?.counter('output_safety_check_total', 1, { decision: 'local_error' });
          await this.retryDelay();
          continue;
        }
        metrics?.counter('output_safety_check_total', 1, { decision: 'soft_stop_network' });
        await this.softStopNetwork();
        return false;
      }
      if (result.errorKind === 'api_error') {
        this.safetyReviewUnknown = true;
        metrics?.counter('output_safety_error_total', 1, { errorKind: 'api_error' });
      }
      return this.applyVerdict(result);
    }
    await this.softStopNetwork();
    return false;
  }

  private isStopped(): boolean {
    return this.blocked || this.networkStopped;
  }

  private isAuthSoftStop(result: SafetyCheckResult): boolean {
    return result.errorKind === 'auth_error' && this.options.authErrorVariant === 'auth';
  }

  private applyVerdict(result: SafetyCheckResult): boolean {
    const metrics = this.options.metricsClient;
    if (result.action === 'guide') {
      this.guidePrompt = result.guide_prompt?.trim() || undefined;
      metrics?.counter('output_safety_check_total', 1, { decision: 'review' });
      this.block();
      return false;
    }
    if (reviewBlocks(result)) {
      this.immediateBlock = result.action === 'reject';
      metrics?.counter('output_safety_check_total', 1, { decision: 'block' });
      metrics?.counter('output_safety_block_total', 1);
      this.block();
      return false;
    }
    metrics?.counter('output_safety_check_total', 1, { decision: 'pass' });
    return true;
  }

  private async reviewFinalWindow(
    completeText: string | undefined,
    windowText: string,
    scene: SafetyScene,
  ): Promise<boolean> {
    const text = completeText && completeText.length > 0 ? completeText : windowText;
    return text ? this.review(text, scene) : true;
  }

  private enqueuePending(event: IRuntimeEvent): PendingEvent {
    const pending = { event, releasable: false };
    this.pendingQueue.push(pending);
    return pending;
  }

  private enqueueReady(event: IRuntimeEvent): void {
    if (this.blocked) return;
    if (isTerminalEvent(event)) {
      this.clearPending();
      this.scheduleDelivery(() => this.inner.pushRuntime(event));
      return;
    }
    this.pendingQueue.push({ event, releasable: true });
    this.flushReady();
  }

  private releaseWindow(window: PendingEvent[]): void {
    window.forEach((pending) => {
      pending.releasable = true;
    });
    window.length = 0;
  }

  private flushReady(): void {
    const batch: IRuntimeEvent[] = [];
    while (this.pendingQueue[0]?.releasable) {
      const pending = this.pendingQueue.shift();
      if (pending) batch.push(pending.event);
    }
    if (batch.length > 0) {
      this.scheduleDelivery(() => this.inner.appendEvents(batch));
    }
  }

  private async flushApprovedOnNetworkStop(): Promise<void> {
    if (this.options.persistApprovedPartialOnNetworkStop === false) return;
    if ((!this.approvedThinking && !this.approvedContent) || !this.approvedMsgId) return;
    const message: AgentMessage = {
      msg_id: this.approvedMsgId,
      role: 'assistant',
      ...(this.approvedThinking ? { thinking_content: this.approvedThinking } : {}),
      msg_content: this.approvedContent,
    };
    await this.queueDelivery(() =>
      this.inner.pushRuntime({
        schema: RUNTIME_EVENT_SCHEMA,
        event_id: `local-output-network-stop-approved-${this.approvedMsgId}`,
        session_id: this.options.sessionId,
        turn_id: this.options.turnId,
        type: RuntimeEventType.STREAM_RESP,
        payload: {
          stream_resp: JSON.stringify({
            type: RespDataType.AgentMessage,
            agent_message: message,
          }),
        },
      } as IRuntimeEvent),
    );
  }

  private queueDelivery(operation: () => void | Promise<void>): Promise<void> {
    const delivery = this.deliverAfter(this.deliveryTail, operation);
    this.deliveryTail = this.captureDeliveryFailure(delivery);
    return delivery;
  }

  private scheduleDelivery(operation: () => void | Promise<void>): void {
    const delivery = this.deliverAfter(this.deliveryTail, operation);
    this.deliveryTail = this.captureDeliveryFailure(delivery);
  }

  private async deliverAfter(
    previous: Promise<void>,
    operation: () => void | Promise<void>,
  ): Promise<void> {
    await previous;
    if (this.deliveryFailure) throw this.deliveryFailure.error;
    await operation();
  }

  private async captureDeliveryFailure(delivery: Promise<void>): Promise<void> {
    try {
      await delivery;
    } catch (error) {
      this.deliveryFailure ??= { error };
    }
  }

  private clearPending(): void {
    this.pendingQueue.length = 0;
    this.thinkingWindow.length = 0;
    this.contentWindow.length = 0;
    this.thinkingText = '';
    this.contentText = '';
  }
}

function safeStoppedPtcCall(call: ToolCall): ToolCall {
  const { ptcChild, ptc } = readStoppedPtcFacts(call);
  const safeChild = ptcChild ? sanitizePtcChildExecutionDetailsForSafety(ptcChild) : undefined;
  const safePtc = ptc ? sanitizePtcExecutionDetailsForSafety(ptc) : undefined;
  return {
    ...call,
    tool_call_args: JSON.stringify(
      safeChild?.record.input ??
        (safePtc ? { description: 'PTC execution stopped by safety review.' } : {}),
    ),
    tool_call_args_delta: '',
    tool_call_result_data: JSON.stringify({
      content: [
        {
          type: 'text',
          text: 'PTC execution facts were retained after safety review stopped the response. Do not replay operations with unknown outcomes automatically.',
        },
      ],
      details: safeChild ? { ptc_child: safeChild } : { ptc: safePtc },
    }),
  };
}

function readStoppedPtcFacts(call: ToolCall) {
  let result: unknown;
  try {
    result = JSON.parse(call.tool_call_result_data ?? 'null');
  } catch {
    throw new Error('PTC stopped terminal delivery has no valid host facts.');
  }
  const ptcChild = readPtcChildExecutionDetails({
    tool_call_id: call.tool_call_id,
    parent_tool_call_id: call.parent_tool_call_id,
    result,
  });
  const details = result && typeof result === 'object' ? Reflect.get(result, 'details') : undefined;
  const ptc = readPtcExecutionDetails({ role: 'toolResult', toolName: call.tool_name, details });
  if (!ptcChild && !ptc)
    throw new Error('PTC stopped terminal delivery has no trusted execution facts.');
  return { ptcChild, ptc };
}

function isPtcLifecycleCall(call: ToolCall): boolean {
  return (
    (call.tool_name === 'run_code' || Boolean(call.parent_tool_call_id)) &&
    (call.tool_call_status === ToolCallStatus.Start ||
      call.tool_call_status === ToolCallStatus.Finished ||
      call.tool_call_status === ToolCallStatus.Failed)
  );
}

interface PendingEvent {
  readonly event: IRuntimeEvent;
  releasable: boolean;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function defaultLocalErrorRetryDelay(): Promise<void> {
  const delayMs = Math.floor(Math.random() * (OUTPUT_SAFETY_LOCAL_ERROR_RETRY_MAX_DELAY_MS + 1));
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function parseStreamResp(event: IRuntimeEvent): RespData | undefined {
  const raw = event.payload?.stream_resp;
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw) as RespData;
  } catch {
    return undefined;
  }
}

function isLocalReviewError(result: SafetyCheckResult): boolean {
  return result.errorKind === 'local_error' || result.errorKind === 'auth_error';
}

function sceneForV2Retry(scene: SafetyScene): SafetyScene {
  return scene === SAFETY_SCENE.StreamChunk ? SAFETY_SCENE.MessageOutput : scene;
}

function isStreamingPhaseBoundary(chunk: NonNullable<RespData['agent_message_chunk']>): boolean {
  return chunk.finish === true || (chunk.tool_calls?.length ?? 0) > 0;
}
function isTerminalEvent(event: IRuntimeEvent): boolean {
  if (event.type !== RuntimeEventType.SESSION_STATUS) return false;
  return [
    RuntimeEventStatus.COMPLETED,
    RuntimeEventStatus.FAILED,
    RuntimeEventStatus.ABORTED,
  ].includes(event.payload?.status as RuntimeEventStatus);
}

/**
 * Safety gateway API errors degrade-pass for delivery, but the completed
 * assistant message must retain that fact so durable query presentation does
 * not later collapse an answer whose review outcome was unknown.
 */
function markSafetyReviewUnknown(event: IRuntimeEvent, message: AgentMessage): IRuntimeEvent {
  return {
    ...event,
    payload: {
      ...event.payload,
      stream_resp: JSON.stringify({
        type: RespDataType.AgentMessage,
        agent_message: { ...message, safety_review_unknown: true },
      }),
    },
  } as IRuntimeEvent;
}
