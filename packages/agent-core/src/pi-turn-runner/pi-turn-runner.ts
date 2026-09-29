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
import {
  newTurn,
  type LlmCaptureAgentEventSource,
  type LlmCaptureRecorder,
  type messageIDAllocator,
} from './turn.js';
import { setToolHooks } from './tools.js';
import type { ToolContextSizeEstimator } from './tool-context-size.js';
import type { PiTurnRunnerLogger, RunTurnInput as PiRunTurnInput } from './types.js';
import type { ToolExecutionContext } from '../tools/index.js';

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
   * Optional host callback invoked on each confirmed physical LLM provider request failure,
   * excluding user cancellation. The host uses it for out-of-band error-log reporting; agent-core
   * only classifies failures and forwards raw errors. See {@link PiLLMRequestFailureHook}.
   */
  onLLMRequestFailure?: PiLLMRequestFailureHook;
  /** Optional host-owned observer for each physical LLM request lifecycle. */
  observeLLMRequest?: PiLLMRequestObserver;
  /**
   * Optional factory for a per-turn LLM context capture recorder. Injected only by hosts that need
   * to observe provider context (the development desktop Inspector). When omitted, turn assembly
   * remains identical to the pre-injection behavior, with no capture code on the request path.
   *
   * Like the metrics recorder, it is created per turn: capture state must not be reused across
   * turns.
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
   */
  async runTurn<TCtx extends ToolExecutionContext = ToolExecutionContext>(
    input: PiRunTurnInput<TCtx>,
  ): Promise<void> {
    // Metrics recorder spans the whole turn; `finish` runs in the outer
    // `finally` so turn totals / the active-turns gauge stay balanced on every
    // exit path (completed / failed / aborted / thrown). `termination` staying
    // undefined means runTurn threw before reaching a terminal frame.
    const recorder = this.metrics.beginTurn(input.caller, input.llm.model, {
      sessionId: input.sessionId,
      turnId: input.turnId,
      logger: this.logger,
      ...(this.toolContextSizeEstimator ? { estimator: this.toolContextSizeEstimator } : {}),
    });
    let termination: TurnTerminationReason | undefined;
    let llmCapture: LlmCaptureRecorder | undefined;
    let unsubscribeCaptureRelay: (() => void) | undefined;
    try {
      // Step 1: Build state for a single turn. `newTurn` resolves model config and creates all
      // objects that cannot be reused across turns: the tool list, composed streamFn, EventBridge
      // (which translates AgentEvent into RuntimeEvent), and per-turn event-id / seq
      // counters. The PiTurnRunner instance itself holds only process-level defaults.
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

      // Step 2: Announce that the turn is running. Emit the first `session.status`
      // RuntimeEvent so subscribers see the turn start before any LLM / tool output arrives.
      await emitRunning(turn);

      // Step 3: Create the pi Agent (injecting system prompt, model, tools, and history),
      // and a history cursor tracking how much of `agent.state.messages` has been reported
      // to the onHistoryChanged hook.
      const agent = newAgent(turn);
      if (llmCapture) {
        type CaptureListener = Parameters<LlmCaptureAgentEventSource['subscribe']>[0];
        const captureListeners = new Set<CaptureListener>();
        unsubscribeCaptureRelay = agent.subscribe((event) => {
          for (const listener of captureListeners) {
            try {
              listener(event);
            } catch {
              // Capture observation is best-effort and cannot affect Agent delivery.
            }
          }
        });
        llmCapture.observeAgentEvents({
          subscribe(listener) {
            captureListeners.add(listener);
            return () => captureListeners.delete(listener);
          },
        });
      }
      recorder.observeAgent(agent, input.toolConfig.tools);
      const history = newHistory(turn, agent);

      // Step 4: Install Agent hooks. Tool hooks wrap tool execution; LLM hooks wrap
      // each model call and feed compaction / message rewrites back through the history cursor.
      setToolHooks(agent, turn);
      setLLMHook(agent, turn, history);

      // Step 5: Subscribe to the Agent event stream. Parallel pi tool calls may finish in different promise
      // branches, so `subscribeEvents` feeds every AgentEvent into a single serial queue:
      // translate events through the bridge, flush resulting RuntimeEvents to the writer, drive
      // history.flushTail() at message / tool boundaries, and run onStepEnd. A single queue keeps
      // RuntimeEvent ordering identical to the old monolithic runner. The later `events.drain()`
      // waits for this queue.
      const events = subscribeEvents(agent, turn, history, this.now);

      // Step 6: Wire cancellation. If the caller's signal is already aborted, do not start
      // the Agent: unsubscribe, drain queued events, and emit the terminal `aborted` frame. Otherwise,
      // forward subsequent aborts to `agent.abort()` so `runAgent` settles promptly.
      if (input.signal) {
        if (input.signal.aborted) {
          events.unsubscribe();
          await events.drain();
          termination = { kind: 'aborted' };
          await emitTerminal(turn, termination);
          return;
        }
        input.signal.addEventListener(
          'abort',
          () => {
            agent.abort();
          },
          { once: true },
        );
      }

      // Step 7: Drive the turn. `runAgent` prompts the Agent with the user message, or natively
      // continues from existing history, and waits for idle;
      // only abort / error returns a non-undefined TurnTerminationReason. Normal completion
      // returns undefined. Always unsubscribe in `finally`, whether or not an error is thrown,
      // to ensure the listener is detached.
      let reason: Awaited<ReturnType<typeof runAgent>>;
      try {
        reason = await runAgent(agent, turn, events.convergeAtIdle);
      } finally {
        events.unsubscribe();
      }

      // Step 8: Finalize once the Agent stops producing events:
      //   a) drain(): Wait for the serial event queue to flush completely.
      //   b) flushTail(): Scan history one last time for messages appended by pi without matching
      //      message_end / tool_execution_end callbacks.
      //   c) emitTerminal(): Write the final `session.status` frame; if `runAgent`
      //      returned no abort / error reason, default to `completed`.
      await events.drain();
      await history.flushTail();
      termination = reason ?? events.forcedTermination() ?? { kind: 'completed' };
      await emitTerminal(turn, termination);
    } finally {
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
      recorder.finish(termination, input.signal?.reason);
    }
  }
}
