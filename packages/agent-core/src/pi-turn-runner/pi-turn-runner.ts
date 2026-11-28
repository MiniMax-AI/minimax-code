/**
 * `PiTurnRunner` — assemble pi-coding-agent's runtime for a single turn
 * and bridge its event stream into canonical `RuntimeEvent`s.
 *
 * `PiTurnRunner` is reusable across sessions, but every call to
 * {@link runTurn} constructs a fresh Agent, EventBridge, event queue and
 * history cursor. Per-turn state stays inside the turn object created by
 * `newTurn(...)`; the class only owns process-level defaults.
 *
 * @see packages/agent-core/ARCHITECTURE.md
 */

import type { AgentEvent } from '@earendil-works/pi-agent-core';
import type { MetricsClient } from '@mavis/shared/metrics-proxy';
import type { TurnTerminationReason } from '../event-bridge/types.js';
import { newAgent, runAgent } from './agent.js';
import { defaultMessageIdAllocator, defaultNowMs, noopLogger } from './defaults.js';
import { emitRunning, emitTerminal, subscribeEvents } from './events.js';
import { newHistory } from './history.js';
import { setLLMHook, wrapStreamFnWithTimeout } from './llm.js';
import {
  newPiTurnMetrics,
  type PiTurnMetrics,
  type PiLLMRequestFailureHook,
  type PiLLMRequestObserver,
} from './metrics.js';
import { _computeFailureTerminationReasonForTest } from './terminal.js';
import { turnConversation } from './turn-conversation.js';
import {
  newTurn,
  type LlmCaptureAgentEventSource,
  type LlmCaptureRecorder,
  type messageIDAllocator,
} from './turn.js';
import { setToolHooks } from './tools.js';
import { createPtcToolExecutor } from './ptc-tool-executor.js';
import type { PtcToolExecutor, ToolExecutionContext } from '../tools/index.js';
import type { ToolContextSizeEstimator } from './tool-context-size.js';
import {
  isRunYieldAbort,
  type PiTurnRunnerLogger,
  type RunTurnInput as PiRunTurnInput,
  type RunTurnResult,
} from './types.js';

export { LLM_REQUEST_TIMEOUT_MS } from './defaults.js';
export { _computeFailureTerminationReasonForTest, wrapStreamFnWithTimeout };

/** Optional message-id allocator (defaults to `crypto.randomUUID()`). */
export interface PiMessageIdAllocator extends messageIDAllocator {
  /**
   * Allocate a globally-unique assistant `message_id` for the supplied
   * turn. Callers that route through archon_server's `BeginAssistantMessage`
   * RPC can return its assigned id; local callers can use a UUID.
   */
  allocateAssistantMessageId(sessionId: string, turnId: string): Promise<string>;
}

export interface PiTurnRunnerOptions {
  messageIdAllocator?: PiMessageIdAllocator;
  nowMs?: () => number;
  metricsClient?: MetricsClient;
  logger?: PiTurnRunnerLogger;
  toolContextSizeEstimator?: ToolContextSizeEstimator;
  /**
   * 可选的宿主回调，每次确认 LLM provider 物理请求失败时调用，用户取消除外。
   * 宿主用它驱动旁路错误日志上报；agent-core 只分类失败并转交原始错误。
   * 详见 {@link PiLLMRequestFailureHook}。
   */
  onLLMRequestFailure?: PiLLMRequestFailureHook;
  /** Optional host-owned observer for each physical LLM request lifecycle. */
  observeLLMRequest?: PiLLMRequestObserver;
  /**
   * The host reports Pi metrics with the Desktop metric registry
   * (packages/shared/src/local-runtime-logging/metric-registry.ts): busy time
   * instead of the active-turn gauge, `route` on the request metrics, the
   * first-output, preparation, response-header and transport metrics, and
   * local resource error kinds. Omitted (the cloud runtime), the runner keeps
   * the Pi metrics it shipped before the registry.
   */
  registryMetrics?: boolean;
  /**
   * 可选的 per-turn LLM context capture recorder 工厂。只有需要观测 provider
   * 上下文的宿主（开发期 desktop Inspector）才注入；缺省时 turn 装配与注入前
   * 完全一致，capture 代码不出现在请求路径上。
   *
   * 与 metrics recorder 一样按 turn 创建：capture 状态不能跨 turn 复用。
   */
  llmCaptureFactory?: (input: {
    readonly sessionId: string;
    readonly turnId: string;
  }) => LlmCaptureRecorder | undefined;
}

/**
 * Pi assembly layer. Runtime adapters construct one instance and call
 * {@link runTurn} for every LLM turn.
 */
export class PiTurnRunner {
  private readonly messageIdAllocator: PiMessageIdAllocator;
  private readonly now: () => number;
  private readonly logger: Required<PiTurnRunnerLogger>;
  private readonly metrics: PiTurnMetrics;
  private readonly toolContextSizeEstimator?: ToolContextSizeEstimator;
  private readonly llmCaptureFactory?: PiTurnRunnerOptions['llmCaptureFactory'];
  readonly metricsClient?: MetricsClient;

  constructor(options: PiTurnRunnerOptions = {}) {
    this.messageIdAllocator = options.messageIdAllocator ?? defaultMessageIdAllocator;
    this.now = options.nowMs ?? defaultNowMs;
    this.metricsClient = options.metricsClient;
    this.metrics = newPiTurnMetrics(
      options.metricsClient,
      this.now,
      options.onLLMRequestFailure,
      options.observeLLMRequest,
      options.registryMetrics,
    );
    this.logger = { ...noopLogger, ...(options.logger ?? {}) };
    this.toolContextSizeEstimator = options.toolContextSizeEstimator;
    this.llmCaptureFactory = options.llmCaptureFactory;
  }

  /**
   * Run a single LLM turn end-to-end:
   * - build tools and Agent
   * - bridge pi AgentEvents into RuntimeEvents
   * - notify history hooks as pi state changes
   * - emit the terminal session.status frame
   *
   * 返回值只在本轮因网关 content_error 结束时带 `contentReview` 结果，其余情况为空对象。
   */
  async runTurn<TCtx extends ToolExecutionContext = ToolExecutionContext>(
    input: PiRunTurnInput<TCtx>,
  ): Promise<RunTurnResult> {
    // Metrics recorder spans the whole turn; `finish` runs in the outer
    // `finally` so turn totals and busy time stay balanced on every exit path
    // (completed / failed / aborted / thrown). `termination` staying
    // undefined means runTurn threw before reaching a terminal frame.
    const recorder = this.metrics.beginTurn(
      input.caller,
      input.llm.model,
      {
        sessionId: input.sessionId,
        turnId: input.turnId,
        logger: this.logger,
        ...(this.toolContextSizeEstimator ? { estimator: this.toolContextSizeEstimator } : {}),
      },
      {
        route: input.llm.route,
        timing: input.turnTiming,
        agentKind: input.agentKind,
        wake: input.wake,
        conversation: turnConversation(input.history),
        visibleText: input.turnVisibleText,
        // A run stopped at its tail settles as aborted; only the abort reason tells it yielded.
        isYielded: () => input.isYieldStopped?.() === true || isRunYieldAbort(input.signal?.reason),
      },
    );
    let termination: TurnTerminationReason | undefined;
    let thrown: unknown;
    let llmCapture: LlmCaptureRecorder | undefined;
    let unsubscribeCaptureRelay: (() => void) | undefined;
    // Set only when an Inspector capture recorder exists for this Turn.
    let relayToCapture: ((event: AgentEvent) => void) | undefined;
    let ptcExecutor: PtcToolExecutor | undefined;
    // Takes the abort forwarding off the caller's signal: it closes over the Agent and, through it, the whole Turn.
    let detachAbort: (() => void) | undefined;
    try {
      // 步骤 1 —— 构造单次 turn 的状态。`newTurn` 解析 model config，并创建所有
      // 不能跨 turn 复用的对象：tool 列表、组合后的 streamFn、EventBridge
      // （负责把 AgentEvent 翻译成 RuntimeEvent）以及 per-turn 的 event-id / seq
      // 计数器。PiTurnRunner 实例本身只持有进程级默认值。
      llmCapture = this.llmCaptureFactory?.({
        sessionId: input.sessionId,
        turnId: input.turnId,
      });
      const turn = newTurn(input, {
        allocator: this.messageIdAllocator,
        nowMs: this.now,
        logger: this.logger,
        metrics: recorder,
        ...(llmCapture ? { llmCapture } : {}),
      });

      // 步骤 2 —— 宣告 turn 进入 running。写出第一帧 `session.status`
      // RuntimeEvent，让订阅方在任何 LLM / tool 输出到达之前就能看到 turn 启动。
      await emitRunning(turn);
      recorder.markRunning();

      // 步骤 3 —— 构造 pi Agent（注入 system prompt、model、tools 和历史消息），
      // 以及一个 history cursor，用来记录 `agent.state.messages` 已经通知到
      // onHistoryChanged hook 的位置。
      const agent = newAgent(turn);
      if (llmCapture) {
        type CaptureListener = Parameters<LlmCaptureAgentEventSource['subscribe']>[0];
        const captureListeners = new Set<CaptureListener>();
        relayToCapture = (event) => {
          for (const listener of captureListeners) {
            try {
              listener(event);
            } catch {
              // Capture observation is best-effort and cannot affect Agent delivery.
            }
          }
        };
        unsubscribeCaptureRelay = agent.subscribe(relayToCapture);
        llmCapture.observeAgentEvents({
          subscribe(listener) {
            captureListeners.add(listener);
            return () => captureListeners.delete(listener);
          },
        });
      }
      recorder.observeAgent(agent, input.toolConfig.tools);
      const history = newHistory(turn, agent);

      // 步骤 4 —— 给 Agent 装 hook。tool hook 包裹 tool 执行的前后；LLM hook
      // 包裹每次模型调用，并把 compaction / 消息重写经由 history cursor 回灌。
      setToolHooks(agent, turn);
      setLLMHook(agent, turn, history);

      // 步骤 5 —— 订阅 Agent 的事件流。pi 的并行 tool call 可能从不同的 promise
      // 分支结束，所以 `subscribeEvents` 把每个 AgentEvent 都汇入同一个串行队列：
      // 经 bridge 翻译事件、把产出的 RuntimeEvent flush 给 writer、在 message /
      // tool 边界驱动 history.flushTail()、并执行 onStepEnd hook。单一队列保证
      // RuntimeEvent 的顺序与旧的单体 runner 完全一致。后面的 `events.drain()`
      // 等待的就是这个队列。
      const events = subscribeEvents(agent, turn, history, this.now);
      ptcExecutor = createPtcToolExecutor({
        agent,
        turn,
        emit: events.dispatch,
        nowMs: this.now,
        // PTC child events go through the serialized dispatch, not
        // agent.subscribe, so the capture relay needs them separately.
        ...(relayToCapture ? { observeChildLifecycle: relayToCapture } : {}),
        // Host hook over the child display copy only; the program's own value
        // and the model-visible result never pass through it.
        ...(input.toolConfig.context.shapePtcChildDisplayResult
          ? { shapePtcChildDisplayResult: input.toolConfig.context.shapePtcChildDisplayResult }
          : {}),
      });
      input.toolConfig.context.ptcExecutor = ptcExecutor;

      // 步骤 6 —— 接好取消逻辑。如果 caller 的 signal 已经 aborted，就根本不启动
      // Agent：直接退订、drain 掉已入队的事件，然后发出 `aborted` 终止帧。否则，
      // 后续的 abort 会转发到 `agent.abort()`，让 `runAgent` 尽快收敛。
      if (input.signal) {
        if (input.signal.aborted) {
          events.unsubscribe();
          await events.drain();
          termination = { kind: 'aborted' };
          // A yielded run leaves no terminal frame; the resuming run owns it.
          if (input.isYieldStopped?.() !== true) await emitTerminal(turn, termination);
          return {};
        }
        const signal = input.signal;
        const onAbort = (): void => {
          agent.abort();
        };
        signal.addEventListener('abort', onAbort, { once: true });
        detachAbort = () => signal.removeEventListener('abort', onAbort);
      }

      // 步骤 7 —— 驱动 turn。`runAgent` 用 user message prompt Agent，或从已有
      // history 原生 continue，并等待 idle；
      // 只有 abort / error 才返回非 undefined 的 TurnTerminationReason，正常完成
      // 返回 undefined。无论是否抛错，都在 `finally` 里 unsubscribe，确保 listener
      // 被解绑。
      let reason: Awaited<ReturnType<typeof runAgent>>;
      const unbindPreemption = input.llmPreemption?.bind({
        preempt: () => (turn.preemption.active?.preempt() ? 'preempted' : 'not-streaming'),
      });
      try {
        reason = await runAgent(agent, turn, events.convergeAtIdle, events.dispatch);
      } finally {
        unbindPreemption?.();
        events.unsubscribe();
      }

      // 步骤 8 —— Agent 不再产生事件后做收尾：
      //   a) drain() —— 等待串行事件队列彻底 flush 完。
      //   b) flushTail() —— 最后再扫一遍 history，捕捉 pi 追加了、但没有配对的
      //      message_end / tool_execution_end 回调的消息。
      //   c) emitTerminal() —— 写出最终的 `session.status` 帧；当 `runAgent`
      //      没有返回 abort / error reason 时，默认按 `completed` 处理。
      await events.drain();
      await history.flushTail();
      if (input.isYieldStopped?.() === true) {
        // A yielded run leaves no terminal frame; the resuming run owns it.
        termination = { kind: 'aborted' };
        return {};
      }
      termination = reason ?? events.forcedTermination() ?? { kind: 'completed' };
      await emitTerminal(turn, termination);
      const contentReview = turn.contentReview.outcome;
      return contentReview ? { contentReview } : {};
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      detachAbort?.();
      if (input.toolConfig.context.ptcExecutor === ptcExecutor) {
        delete input.toolConfig.context.ptcExecutor;
      }
      unsubscribeCaptureRelay?.();
      unsubscribeCaptureRelay = undefined;
      if (llmCapture?.drain) {
        try {
          await llmCapture.drain();
        } catch (error) {
          this.logger.warn(
            { error, sessionId: input.sessionId, turnId: input.turnId },
            'LLM capture drain failed',
          );
        }
      }
      await recorder.settle();
      recorder.finish(termination, input.signal?.reason, thrown);
    }
  }
}
