import { Worker } from 'node:worker_threads';

import {
  mergedPtcLimits,
  parsePtcToolArgs,
  ptcToolCallLimitRefusal,
  PtcSerializationError,
  serializePtcValue,
  type PtcChildCallRecord,
  type PtcExecutionDetails,
  type PtcExecutionResult,
  type PtcFailure,
  type PtcGuestInboundMessage,
  type PtcGuestOutboundMessage,
  type PtcLimits,
  type PtcMediaDelivery,
  type PtcRetainedFact,
  type PtcStopReason,
  type PtcToolBridge,
  type PtcToolCallResult,
} from '../../execution/ptc/contracts.js';
import { ptcWorkerUrl } from './worker-path.js';

interface PtcWorkerPort {
  postMessage(message: PtcGuestInboundMessage): void;
  terminate(): Promise<number>;
  on(event: 'message', listener: (message: PtcGuestOutboundMessage) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
}

export type PtcWorkerFactory = (url: URL) => PtcWorkerPort;

export interface ExecutePtcQuickJsInput {
  readonly code: string;
  readonly bridge: PtcToolBridge;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<PtcLimits>;
  readonly workerFactory?: PtcWorkerFactory;
  /**
   * Current program deadline (Unix ms), read when `maxWallClockMs` runs out.
   * A foreground Bash child with a long `timeout` may have moved it later
   * (Agent Core extends the batch deadline); the timer then waits for the
   * rest instead of stopping the program. Without it the limit is final.
   */
  readonly readDeadlineAtMs?: () => number | undefined;
}

/** The host owns time limits, bridge admission and every execution record. */
export async function executePtcQuickJs(
  input: ExecutePtcQuickJsInput,
): Promise<PtcExecutionResult> {
  const limits = mergedPtcLimits(input.limits);
  if (new TextEncoder().encode(input.code).byteLength > limits.maxCodeBytes) {
    return failed(
      'invalid_code',
      `PTC source exceeds the ${limits.maxCodeBytes}-byte limit.`,
      false,
      [{ kind: 'budget_exceeded', budget: 'code' }],
    );
  }
  return await new PtcQuickJsExecution(input, limits).run();
}

type GuestToolCall = Extract<PtcGuestOutboundMessage, { readonly type: 'tool_call' }>;

/** One concrete Worker lifetime; no state is shared with another guest program. */
class PtcQuickJsExecution {
  private readonly worker: PtcWorkerPort;
  private readonly controller = new AbortController();
  private readonly childCalls = new Map<string, PtcChildCallRecord>();
  private readonly childFacts = new Map<string, PtcRetainedFact[]>();
  private readonly globalFacts: PtcRetainedFact[] = [];
  private readonly persisted = new Map<string, PtcExecutionDetails['child_calls'][number]>();
  private readonly provisionalChildIds = new Map<string, string>();
  private readonly mediaByChild = new Map<string, PtcMediaDelivery[]>();
  private readonly unownedMedia: PtcMediaDelivery[] = [];
  private readonly pendingReplyBytes = new Map<string, number>();
  private pendingBridgeBytes = 0;
  private toolCalls = 0;
  /** Calls refused by the call budget (guest-side or host-side) without running. */
  private refusedToolCalls = 0;
  private consoleText = '';
  private consoleBytes = 0;
  private consoleTruncated = false;
  private finished = false;
  private acceptingCalls = true;
  private stopReason: PtcStopReason | undefined;
  private resultAfterGrace: PtcExecutionResult | undefined;
  private computeElapsedMs = 0;
  private computeStartedAtMs: number | undefined;
  private wallTimer: ReturnType<typeof setTimeout> | undefined;
  private computeTimer: ReturnType<typeof setTimeout> | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private resolveResult!: (result: PtcExecutionResult) => void;
  private readonly pendingWork = new Map<object, Promise<void>>();
  private readonly pendingHostCalls = new Map<object, Promise<void>>();

  constructor(
    private readonly input: ExecutePtcQuickJsInput,
    private readonly limits: PtcLimits,
  ) {
    this.worker = (input.workerFactory ?? createNodePtcWorker)(ptcWorkerUrl());
  }

  run(): Promise<PtcExecutionResult> {
    return new Promise((resolve) => {
      this.resolveResult = resolve;
      this.input.signal?.addEventListener('abort', this.onExternalAbort, { once: true });
      this.worker.on('message', this.onMessage);
      this.worker.on('error', this.onError);
      this.worker.on('exit', this.onExit);
      this.wallTimer = setTimeout(this.onWallClock, this.limits.maxWallClockMs);
      if (this.input.signal?.aborted) this.onExternalAbort();
    });
  }

  private readonly onExternalAbort = () => this.stop('cancelled');

  private readonly onWallClock = (): void => {
    let deadlineAtMs: number | undefined;
    try {
      deadlineAtMs = this.input.readDeadlineAtMs?.();
    } catch {
      // An unreadable deadline keeps the limit the program started with.
    }
    const remainingMs = deadlineAtMs === undefined ? 0 : deadlineAtMs - Date.now();
    if (remainingMs > 0 && !this.finished && !this.stopReason) {
      this.wallTimer = setTimeout(this.onWallClock, remainingMs);
      return;
    }
    this.stop('wall_clock_exceeded');
  };

  private readonly onMessage = (message: PtcGuestOutboundMessage): void => {
    if (this.ignoreMessage(message)) return;
    switch (message.type) {
      case 'ready':
        this.startGuest();
        break;
      case 'activity':
        this.observeComputeActivity(message.active);
        break;
      case 'tool_call':
        this.startWork(this.handleToolCall(message), true);
        break;
      case 'tool_consumed':
        this.consumeReply(message.requestId);
        break;
      case 'console':
        this.appendConsole(message.text, message.truncated === true);
        break;
      case 'limit_rejected':
        // The worker already answered the refused call; the program continues
        // and only the count reaches the outer result and its durable fact.
        this.refusedToolCalls += 1;
        break;
      case 'completed':
        this.completeGuest(message);
        break;
      case 'failed':
        this.failGuest(message);
        break;
    }
  };

  private failGuest(message: Extract<PtcGuestOutboundMessage, { type: 'failed' }>): void {
    const pending = message.pendingRequestIds.length > 0;
    this.endGuest(
      {
        status: failureStatus(message.error.code),
        error: message.error,
        childCalls: [],
        details: emptyDetails(),
        media: [],
        incomplete: pending,
      },
      pending ? 'guest_finished_with_pending_calls' : undefined,
    );
  }

  private ignoreMessage(message: PtcGuestOutboundMessage): boolean {
    // Console lines printed before a stop are still shown, like the facts of
    // children that settled before it.
    return (
      this.finished ||
      Boolean(this.stopReason && message.type !== 'activity' && message.type !== 'console')
    );
  }

  /** The Worker enforces the console budget; this host-side cap holds even if it did not. */
  private appendConsole(text: string, truncated: boolean): void {
    if (this.consoleTruncated) return;
    const bytes = new TextEncoder().encode(text).byteLength;
    const room = this.limits.maxConsoleBytes - this.consoleBytes;
    if (bytes > room) {
      this.consoleText += new TextDecoder().decode(
        new TextEncoder().encode(text).slice(0, Math.max(0, room)),
        { stream: true },
      );
      this.consoleBytes = this.limits.maxConsoleBytes;
      this.consoleTruncated = true;
      return;
    }
    this.consoleText += text;
    this.consoleBytes += bytes;
    if (truncated) this.consoleTruncated = true;
  }

  /** Node event callbacks cannot await; retain and settle their actual async work. */
  private startWork(operation: Promise<void>, hostCall = false): void {
    const work = {};
    const pending: Promise<void> = (async () => {
      try {
        await operation;
      } catch (error) {
        this.onError(error);
      } finally {
        this.pendingWork.delete(work);
        this.pendingHostCalls.delete(work);
      }
    })();
    this.pendingWork.set(work, pending);
    if (hostCall) this.pendingHostCalls.set(work, pending);
  }

  private startGuest(): void {
    this.worker.postMessage({
      type: 'start',
      code: this.input.code,
      toolNames: this.input.bridge.toolNames,
      limits: {
        maxHeapBytes: this.limits.maxHeapBytes,
        maxComputeMs: this.limits.maxComputeMs,
        maxToolCalls: this.limits.maxToolCalls,
        maxConsoleBytes: this.limits.maxConsoleBytes,
      },
    });
  }

  private consumeReply(requestId: string): void {
    const bytes = this.pendingReplyBytes.get(requestId);
    if (bytes === undefined) return;
    this.pendingReplyBytes.delete(requestId);
    this.pendingBridgeBytes -= bytes;
  }

  /**
   * A return value larger than the outer result is no longer an error: the
   * children already ran, so run_code shows its beginning with a note rather
   * than discarding all of it. Only values the bridge could carry are parsed
   * to validate them; larger ones are only ever shown as a text prefix.
   */
  private completeGuest(message: Extract<PtcGuestOutboundMessage, { type: 'completed' }>): void {
    const pending = message.pendingRequestIds.length > 0;
    const reason = pending ? 'guest_finished_with_pending_calls' : undefined;
    const valueJson = typeof message.valueJson === 'string' ? message.valueJson : undefined;
    let value: unknown;
    if (
      valueJson !== undefined &&
      new TextEncoder().encode(valueJson).byteLength <= this.limits.maxBridgeMessageBytes
    ) {
      try {
        value = JSON.parse(valueJson);
      } catch {
        this.endGuest(failed('guest_error', 'PTC returned invalid JSON.', pending), reason);
        return;
      }
    }
    this.endGuest(
      {
        status: 'completed',
        value,
        ...(valueJson === undefined ? {} : { valueJson }),
        childCalls: [],
        details: emptyDetails(),
        media: [],
        incomplete: pending,
        ...returnValueDrops(message),
      },
      reason,
    );
  }

  private endGuest(result: PtcExecutionResult, reason?: PtcStopReason): void {
    this.startWork(this.finishAfterDrain(result, reason));
  }

  private async finishAfterDrain(
    result: PtcExecutionResult,
    reason?: PtcStopReason,
  ): Promise<void> {
    this.acceptingCalls = false;
    if (reason) {
      this.stop(reason, result);
      return;
    }
    await this.input.bridge.stop('guest_finished_with_pending_calls');
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.drainHostCalls(),
        new Promise<void>((resolve) => {
          drainTimer = setTimeout(resolve, this.limits.shutdownGraceMs);
        }),
      ]);
    } finally {
      clearTimeout(drainTimer);
    }
    this.markOutstandingUnknown();
    await this.finish(result);
  }

  private async drainHostCalls(): Promise<void> {
    await this.input.bridge.drain();
    // Scheduler drainage can precede the continuation that records the final facts.
    // Only invocation work belongs here; cleanup work would wait on itself.
    await Promise.all(this.pendingHostCalls.values());
  }

  private async finish(result: PtcExecutionResult): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.clearTimers();
    this.input.signal?.removeEventListener('abort', this.onExternalAbort);
    let finalResult = result;
    try {
      await this.worker.terminate();
    } catch (error) {
      finalResult = failed(
        'worker_error',
        `PTC Worker termination failed: ${safeMessage(error)}`,
        true,
      );
    }
    this.resolveResult(this.withDetails(finalResult));
  }

  private stop(reason: PtcStopReason, plannedResult?: PtcExecutionResult): void {
    if (this.stopReason || this.finished) return;
    this.acceptingCalls = false;
    this.stopReason = reason;
    this.resultAfterGrace = plannedResult;
    this.controller.abort(reason);
    try {
      this.worker.postMessage({ type: 'stop', reason });
    } catch {
      // A stuck or exited guest is terminated independently below.
    }
    this.startWork(this.finishStoppedAfterDrain(reason));
    this.graceTimer = setTimeout(() => {
      this.markOutstandingUnknown();
      this.startWork(this.finish(this.resultAfterGrace ?? stoppedResult(reason)));
    }, this.limits.shutdownGraceMs);
  }

  private async finishStoppedAfterDrain(reason: PtcStopReason): Promise<void> {
    await Promise.all([
      this.stopBridge(reason),
      this.terminateStoppedWorker(),
      this.drainHostCalls(),
    ]);
    this.markOutstandingUnknown();
    await this.finish(this.resultAfterGrace ?? stoppedResult(reason));
  }

  private async stopBridge(reason: PtcStopReason): Promise<void> {
    try {
      await this.input.bridge.stop(reason);
    } catch (error) {
      this.resultAfterGrace ??= failed(
        'worker_error',
        `PTC bridge cancellation failed: ${safeMessage(error)}`,
        true,
      );
    }
  }

  private async terminateStoppedWorker(): Promise<void> {
    try {
      await this.worker.terminate();
    } catch (error) {
      this.resultAfterGrace ??= failed(
        'worker_error',
        `PTC Worker termination failed: ${safeMessage(error)}`,
        true,
      );
    }
  }

  private readonly onError = (error: unknown): void => {
    if (this.finished || this.stopReason) return;
    this.endGuest(failed('worker_error', safeMessage(error), true), 'worker_error');
  };

  private readonly onExit = (code: number): void => {
    if (this.finished || this.stopReason) return;
    this.endGuest(
      failed('worker_exit', `PTC Worker exited with code ${code}.`, true),
      'worker_error',
    );
  };

  private async handleToolCall(message: GuestToolCall): Promise<void> {
    const initial: PtcChildCallRecord = {
      requestId: message.requestId,
      name: message.name,
      state: 'accepted',
      retainedFacts: [],
    };
    this.childCalls.set(message.requestId, initial);
    let invocationSettled = false;
    try {
      const args = this.admitToolCall(message);
      if (args === REFUSED_BY_CALL_BUDGET) {
        // Never a child call: no record, no fact, nothing to mark unknown later.
        this.childCalls.delete(message.requestId);
        this.sendReply(
          message.requestId,
          JSON.stringify(ptcToolCallLimitRefusal(message.requestId, this.limits.maxToolCalls)),
        );
        return;
      }
      const result = await this.input.bridge.invoke({
        requestId: message.requestId,
        name: message.name,
        args,
        signal: this.controller.signal,
      });
      const childToolCallId =
        result.record?.child_tool_call_id ?? this.provisionalChildIds.get(message.requestId);
      this.recordOutcome(message, result, childToolCallId);
      invocationSettled = true;
      const guestResult = guestResultFor(result, childToolCallId ?? message.requestId);
      const resultJson = this.serializeChildResult(message, guestResult, childToolCallId);
      this.sendReply(message.requestId, resultJson);
    } catch (error) {
      if (!invocationSettled)
        this.childCalls.set(message.requestId, { ...initial, state: 'failed' });
      this.sendFailure(
        message.requestId,
        toToolFailure(error, this.provisionalChildIds.get(message.requestId) ?? message.requestId),
      );
    }
  }

  private admitToolCall(
    message: GuestToolCall,
  ): Readonly<Record<string, unknown>> | typeof REFUSED_BY_CALL_BUDGET {
    if (!this.acceptingCalls || this.stopReason || this.controller.signal.aborted)
      throw new Error('PTC execution was stopped.');
    if (++this.toolCalls > this.limits.maxToolCalls) {
      // The worker refuses over-budget calls itself; this host-side count keeps
      // the budget in force even if a guest reaches the bridge another way.
      this.refusedToolCalls += 1;
      return REFUSED_BY_CALL_BUDGET;
    }
    if (new TextEncoder().encode(message.argsJson).byteLength > this.limits.maxBridgeMessageBytes) {
      this.recordBudgetExceeded('bridge');
      this.stop('bridge_limit_exceeded');
      throw new Error('PTC tool arguments exceed the bridge message limit.');
    }
    const args = parsePtcToolArgs(message.argsJson);
    const provisional = this.input.bridge.describe?.({
      requestId: message.requestId,
      name: message.name,
      args,
    });
    if (provisional) {
      this.persisted.set(provisional.child_tool_call_id, provisional);
      this.provisionalChildIds.set(message.requestId, provisional.child_tool_call_id);
    }
    return args;
  }

  private recordOutcome(
    message: GuestToolCall,
    result: PtcToolCallResult,
    childToolCallId: string | undefined,
  ): void {
    const facts = result.retainedFacts ? [...result.retainedFacts] : [];
    if (childToolCallId) this.addChildFacts(childToolCallId, facts);
    else this.globalFacts.push(...facts);
    this.recordMedia(message.requestId, result, childToolCallId);
    if (result.record) this.persisted.set(result.record.child_tool_call_id, result.record);
    this.childCalls.set(message.requestId, {
      requestId: message.requestId,
      name: message.name,
      state: childOutcomeState(result),
      retainedFacts: facts,
    });
  }

  private recordMedia(
    requestId: string,
    result: PtcToolCallResult,
    childToolCallId: string | undefined,
  ): void {
    if (!result.media) return;
    const entries = result.media.map((content) => ({
      childToolCallId: childToolCallId ?? requestId,
      content,
      refs: result.refs ?? [],
    }));
    if (!childToolCallId) {
      this.unownedMedia.push(...entries);
      return;
    }
    this.mediaByChild.set(childToolCallId, [
      ...(this.mediaByChild.get(childToolCallId) ?? []),
      ...entries,
    ]);
  }

  private serializeChildResult(
    message: GuestToolCall,
    result: unknown,
    childToolCallId: string | undefined,
  ): string {
    try {
      return serializePtcValue(result, this.limits.maxBridgeMessageBytes);
    } catch (error) {
      const failure: PtcFailure = {
        code: error instanceof PtcSerializationError ? error.code : 'invalid_tool_result',
        message: `PTC child result delivery failed: ${safeMessage(error)}`,
        toolCallId: childToolCallId ?? message.requestId,
      };
      this.recordDeliveryFailure(childToolCallId ?? message.requestId, failure);
      throw new PtcChildFailure(failure);
    }
  }

  private recordDeliveryFailure(childToolCallId: string, failure: PtcFailure): void {
    const fact: PtcRetainedFact = {
      kind: 'child_error',
      child_tool_call_id: childToolCallId,
      code: 'PTC_RESULT_DELIVERY_FAILED',
    };
    if (this.persisted.has(childToolCallId)) this.addChildFacts(childToolCallId, [fact]);
    else this.globalFacts.push(fact);
    const reason =
      failure.code === 'bridge_limit_exceeded'
        ? 'bridge_limit_exceeded'
        : 'tool_result_delivery_failed';
    if (reason === 'bridge_limit_exceeded') this.recordBudgetExceeded('bridge');
    this.endGuest(failed(failure.code, failure.message, false), reason);
  }

  private sendReply(requestId: string, resultJson: string): void {
    const bytes = new TextEncoder().encode(resultJson).byteLength;
    if (this.pendingBridgeBytes + bytes > this.limits.maxBridgeResultBytes) {
      this.recordBudgetExceeded('bridge');
      this.stop('bridge_limit_exceeded');
      throw new Error('PTC tool results exceed the cumulative bridge limit.');
    }
    this.pendingReplyBytes.set(requestId, bytes);
    this.pendingBridgeBytes += bytes;
    if (!this.acceptingCalls || this.finished || this.stopReason) return;
    this.worker.postMessage({ type: 'tool_result', requestId, resultJson });
  }

  private sendFailure(requestId: string, failure: PtcFailure): void {
    if (!this.acceptingCalls || this.finished || this.stopReason) return;
    try {
      this.worker.postMessage({ type: 'tool_result', requestId, error: failure });
    } catch {
      // Termination may race a rejected child. Admission has already stopped.
    }
  }

  private observeComputeActivity(active: boolean): void {
    if (this.finished || this.stopReason) return;
    if (active) {
      if (this.computeStartedAtMs !== undefined) return;
      this.computeStartedAtMs = performance.now();
      this.computeTimer = setTimeout(
        () => this.stop('compute_budget_exceeded'),
        Math.max(0, this.limits.maxComputeMs - this.computeElapsedMs),
      );
      return;
    }
    if (this.computeStartedAtMs === undefined) return;
    this.computeElapsedMs += performance.now() - this.computeStartedAtMs;
    this.computeStartedAtMs = undefined;
    clearTimeout(this.computeTimer);
    this.computeTimer = undefined;
    if (this.computeElapsedMs >= this.limits.maxComputeMs) this.stop('compute_budget_exceeded');
  }

  private markOutstandingUnknown(): void {
    for (const [requestId, call] of this.childCalls) {
      if (call.state !== 'accepted') continue;
      this.childCalls.set(requestId, { ...call, state: 'unknown' });
      const childToolCallId = this.provisionalChildIds.get(requestId);
      if (!childToolCallId) continue;
      const record = this.persisted.get(childToolCallId);
      if (record)
        this.persisted.set(childToolCallId, {
          ...record,
          status: 'unknown',
          outcome_unknown: true,
        });
      if (
        !(this.childFacts.get(childToolCallId) ?? []).some(
          (fact) => fact.kind === 'outcome_unknown',
        )
      ) {
        this.addChildFacts(childToolCallId, [
          { kind: 'outcome_unknown', child_tool_call_id: childToolCallId },
        ]);
      }
    }
  }

  private recordBudgetExceeded(budget: 'tool_calls' | 'bridge' | 'code'): void {
    if (!this.globalFacts.some((fact) => fact.kind === 'budget_exceeded' && fact.budget === budget))
      this.globalFacts.push({ kind: 'budget_exceeded', budget });
  }

  private addChildFacts(childToolCallId: string, facts: readonly PtcRetainedFact[]): void {
    if (facts.length > 0)
      this.childFacts.set(childToolCallId, [
        ...(this.childFacts.get(childToolCallId) ?? []),
        ...facts,
      ]);
  }

  private withDetails(result: PtcExecutionResult): PtcExecutionResult {
    const childIds = [...this.persisted.keys()];
    // Refusals no longer stop the program, so the durable budget fact carries
    // how many calls were refused; older facts without the count meant "stopped".
    const refusalFacts: PtcRetainedFact[] =
      this.refusedToolCalls > 0
        ? [{ kind: 'budget_exceeded', budget: 'tool_calls', refused_calls: this.refusedToolCalls }]
        : [];
    return {
      ...result,
      refusedToolCalls: this.refusedToolCalls,
      ...(this.consoleBytes > 0 || this.consoleTruncated
        ? {
            console: {
              text: this.consoleText,
              bytes: this.consoleBytes,
              truncated: this.consoleTruncated,
            },
          }
        : {}),
      childCalls: [...this.childCalls.values()],
      details: {
        version: 1,
        child_calls: [...this.persisted.values()].map((record) => ({
          ...record,
          input: { ...record.input },
        })),
        retained_facts: [
          ...childIds.flatMap((id) => this.childFacts.get(id) ?? []),
          ...this.globalFacts,
          ...refusalFacts,
        ].map((fact) => ({ ...fact })),
      },
      media: [...childIds.flatMap((id) => this.mediaByChild.get(id) ?? []), ...this.unownedMedia],
    };
  }

  private clearTimers(): void {
    clearTimeout(this.wallTimer);
    clearTimeout(this.computeTimer);
    clearTimeout(this.graceTimer);
  }
}

function createNodePtcWorker(url: URL): PtcWorkerPort {
  return new Worker(url, {
    execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
  });
}

function emptyDetails(): PtcExecutionDetails {
  return { version: 1, child_calls: [], retained_facts: [] };
}

function failed(
  code: PtcFailure['code'],
  message: string,
  incomplete: boolean,
  retainedFacts: readonly PtcRetainedFact[] = [],
): PtcExecutionResult {
  return {
    status: failureStatus(code),
    error: { code, message },
    childCalls: [],
    details: { version: 1, child_calls: [], retained_facts: retainedFacts },
    media: [],
    incomplete,
  };
}

function failureStatus(code: PtcFailure['code']): 'failed' | 'cancelled' | 'timed_out' {
  if (code === 'cancelled') return 'cancelled';
  if (code === 'compute_budget_exceeded' || code === 'wall_clock_exceeded') return 'timed_out';
  return 'failed';
}

function stoppedResult(reason: PtcStopReason): PtcExecutionResult {
  if (reason === 'cancelled') return failed('cancelled', 'PTC execution was cancelled.', true);
  return failed(reason, `PTC stopped: ${reason}.`, true);
}

const REFUSED_BY_CALL_BUDGET = Symbol('refused-by-call-budget');

/**
 * The guest payload of one settled child. A tool failure resolves with
 * `isError: true` and an `error` object instead of rejecting, so one failing
 * call inside Promise.all no longer discards its siblings. `isError` is always
 * present and always the host's verdict. Only a settled call that produced no
 * guest payload at all (an internal error) still rejects.
 */
function guestResultFor(result: PtcToolCallResult, toolCallId: string): unknown {
  const isFailure =
    result.isError === true ||
    result.record?.status === 'failed' ||
    result.record?.status === 'unknown';
  if (result.result === undefined) {
    if (!isFailure) {
      throw new PtcChildFailure({
        code: 'invalid_tool_result',
        message: 'PTC child call did not produce a completed guest result.',
      });
    }
    return {
      status: 'failed',
      isError: true,
      truncation: { truncated: 'unknown' },
      error: guestError(result.error, toolCallId),
    };
  }
  if (!isRecord(result.result)) return result.result;
  const projected = result.result;
  const rest = Object.fromEntries(
    Object.entries(projected).filter(
      ([key]) => key !== 'status' && key !== 'isError' && key !== 'error',
    ),
  );
  // status and isError come from this one verdict, so "failed" is exactly isError.
  return {
    status: isFailure ? 'failed' : completedGuestStatus(projected.status),
    isError: isFailure,
    ...rest,
    ...(isFailure
      ? {
          error: isRecord(projected.error) ? projected.error : guestError(result.error, toolCallId),
        }
      : {}),
  };
}

/** The projection's status of a completed call; an unrecognised one cannot claim completeness. */
function completedGuestStatus(status: unknown): string {
  return status === 'complete' ||
    status === 'truncated' ||
    status === 'resized' ||
    status === 'omitted'
    ? status
    : 'unverified';
}

function guestError(error: PtcFailure | undefined, toolCallId: string) {
  return {
    code: error?.code ?? 'PTC_TOOL_FAILED',
    message: error?.message ?? 'Tool execution failed.',
    ...(error?.retryable === undefined ? {} : { retryable: error.retryable }),
    toolCallId: error?.toolCallId ?? toolCallId,
  };
}

function returnValueDrops(
  message: Extract<PtcGuestOutboundMessage, { type: 'completed' }>,
): Pick<
  Extract<PtcExecutionResult, { status: 'completed' }>,
  'droppedUndefinedPaths' | 'droppedUndefinedCount'
> {
  const paths = Array.isArray(message.droppedUndefinedPaths)
    ? message.droppedUndefinedPaths.filter((path): path is string => typeof path === 'string')
    : [];
  const count =
    typeof message.droppedUndefinedCount === 'number' &&
    Number.isSafeInteger(message.droppedUndefinedCount)
      ? Math.max(message.droppedUndefinedCount, paths.length)
      : paths.length;
  return count > 0 ? { droppedUndefinedPaths: paths, droppedUndefinedCount: count } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function childOutcomeState(result: PtcToolCallResult): PtcChildCallRecord['state'] {
  if (result.record?.status === 'unknown') return 'unknown';
  if (result.record?.status === 'failed') return 'failed';
  return 'completed';
}

function toToolFailure(error: unknown, toolCallId: string): PtcFailure {
  if (error instanceof PtcChildFailure) return error.failure;
  const message = safeMessage(error);
  return { code: toolFailureCode(message), message, toolCallId };
}

function toolFailureCode(message: string): PtcFailure['code'] {
  if (message.includes('bridge message limit') || message.includes('cumulative bridge limit'))
    return 'bridge_limit_exceeded';
  if (message.includes('call limit')) return 'tool_call_limit_exceeded';
  if (message.includes('stopped') || message.includes('cancelled')) return 'cancelled';
  return 'invalid_tool_call';
}

class PtcChildFailure extends Error {
  constructor(readonly failure: PtcFailure) {
    super(failure.message);
    this.name = 'PtcChildFailure';
  }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
