import {
  executeToolCall,
  type Agent,
  type AgentContext,
  type AgentEvent,
  type AgentToolCall,
  type AgentToolResult,
  type ToolCallFailure,
  type ToolCallLifecycleConfig,
} from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type {
  ProgrammaticToolResult,
  PtcChildDeadline,
  PtcChildTimeoutDecision,
  PtcRetainedFact,
  PtcToolCallRecord,
  PtcToolExecutionBatch,
  PtcToolExecutionError,
  PtcToolExecutionOutcome,
  PtcToolExecutionRequest,
  PtcToolExecutor,
  PtcToolResultProjection,
  RuntimeTool,
  ToolExecutionContext,
  ToolResult,
} from '../tools/index.js';
import {
  type ProgrammaticImageEncoding,
  readImageEncodedContent,
  readProgrammaticErrorData,
  readProgrammaticErrorRaw,
} from '../tools/programmatic.js';
import {
  isPtcToolErrorCode,
  PTC_DEFAULT_WALL_CLOCK_MS,
  PTC_MAX_WALL_CLOCK_MS,
  resolvePtcWallClock,
} from '../tools/ptc.js';
import { newRuntimeTool, runtimeToolResultIsError } from './tools.js';
import type { turnState } from './turn.js';
import type { PiTurnRunnerLogger } from './types.js';

/** Default batch wall clock; run_code raises it per batch through `timeout_ms`. */
export const PTC_BATCH_WALL_CLOCK_MS = PTC_DEFAULT_WALL_CLOCK_MS;
/** Table 1 of the PTC guest contract: `error.message` carries at most 1000 characters. */
const MAX_PTC_ERROR_MESSAGE_CHARS = 1_000;

type PtcChildTerminalEvent = Extract<AgentEvent, { type: 'tool_execution_end' }>;

interface PtcToolExecutorOptions<TCtx extends ToolExecutionContext> {
  readonly agent: Agent;
  readonly turn: turnState<TCtx>;
  readonly emit: (event: AgentEvent) => Promise<void>;
  readonly nowMs: () => number;
}

/**
 * Builds the turn-local capability exposed to a run_code tool. It resolves
 * the parent against Pi's real assistant message, so guest code cannot forge
 * another session, tool catalog, hook chain, or event sequence.
 */
export function createPtcToolExecutor<TCtx extends ToolExecutionContext>(
  options: PtcToolExecutorOptions<TCtx>,
): PtcToolExecutor {
  const batches = new WeakMap<AssistantMessage, BatchClock>();
  let nextBatchId = 0;

  const findParent = (parentToolCallId: string): AssistantMessage | undefined =>
    findAssistantMessage(options.agent, parentToolCallId);

  const getClock = (parentToolCallId: string, wallClockMs?: number): BatchClock | undefined => {
    if (!options.turn.input.toolConfig.ptcTools) return undefined;
    const parent = findParent(parentToolCallId);
    if (!parent) return undefined;
    // Re-resolved here too, so no caller can push the deadline past the maximum.
    const requested = wallClockMs === undefined ? undefined : resolvePtcWallClock(wallClockMs).ms;
    const existing = batches.get(parent);
    if (existing) {
      // Raise, never restart: the batch keeps its first start, so splitting
      // work across several run_code calls in one response gains no time.
      if (requested !== undefined && requested > existing.wallClockMs) {
        existing.wallClockMs = requested;
      }
      return existing;
    }
    const created: BatchClock = {
      id: `ptc_batch_${++nextBatchId}`,
      startedAtMs: options.nowMs(),
      wallClockMs: requested ?? PTC_DEFAULT_WALL_CLOCK_MS,
    };
    batches.set(parent, created);
    return created;
  };

  return {
    getBatch(parentToolCallId, wallClockMs) {
      const clock = getClock(parentToolCallId, wallClockMs);
      return clock ? batchView(clock) : undefined;
    },
    getToolExecutionMode(toolName) {
      const tool = findRuntimeTool(options.turn, toolName);
      return tool?.def.executionMode ?? (tool ? 'sequential' : undefined);
    },
    async execute(request): Promise<PtcToolExecutionOutcome> {
      const baseRecord = {
        child_tool_call_id: request.toolCallId,
        parent_tool_call_id: request.parentToolCallId,
        tool_name: request.toolName,
      } as const;
      const parent = findParent(request.parentToolCallId);
      if (!parent) {
        return failedOutcome(
          baseRecord,
          'PTC_PARENT_NOT_FOUND',
          'PTC parent tool call is unavailable.',
        );
      }
      if (!options.turn.input.toolConfig.ptcTools) {
        return failedOutcome(baseRecord, 'PTC_NOT_AVAILABLE', 'PTC is unavailable for this turn.');
      }
      const clock = getClock(request.parentToolCallId);
      if (!clock || options.nowMs() >= deadlineOf(clock)) {
        return failedOutcome(baseRecord, 'PTC_BATCH_EXPIRED', 'PTC batch deadline has expired.');
      }
      if (request.signal?.aborted) {
        return failedOutcome(
          baseRecord,
          'PTC_ABORTED',
          'PTC execution was cancelled before dispatch.',
        );
      }

      const runtimeTool = findRuntimeTool(options.turn, request.toolName);
      // The tool's own return value or thrown error, seen before Pi hooks run.
      const own: OwnToolOutcome = {};
      const childTool = runtimeTool
        ? newRuntimeTool(
            runtimeTool,
            {
              ...options.turn.input.toolConfig.context,
              parentToolCallId: request.parentToolCallId,
              ...(request.parentDescription?.trim()
                ? { ptcParentDescription: request.parentDescription.trim() }
                : {}),
              // LocalBashTool reads this host capability. Other tools ignore it.
              // Always false, even when the Turn itself may auto-promote: a
              // program waits for its tools.bash to finish. Moving a long one
              // to the background left the model polling task_output from the
              // top level, one full request per poll, while waiting inside the
              // program costs no tokens.
              allowBashAutoPromotion: false,
              // Same deadline as the dispatch check above and the guest wall
              // clock, so a foreground Bash child cannot outlive its program;
              // a longer Bash timeout extends this one clock instead.
              ptcDeadline: childDeadline(
                clock,
                options.nowMs,
                () => readTurnLogger(options.turn),
                baseRecord,
              ),
            } as TCtx,
            () => options.turn.bridge.getActiveAssistantMessageId(),
            {
              // Recorded now, before Pi runs the after-tool hooks: the hooks
              // receive this same content array, so an in-place edit such as
              // `result.content[0].text = '[redacted]'` would otherwise still
              // compare as the tool's own content.
              onResult: (result) => {
                own.returned = {
                  result,
                  isError: runtimeToolResultIsError(result),
                  contentJson: contentJson(result.content),
                };
              },
              onError: (error) => {
                own.thrown = { error };
              },
            },
          )
        : undefined;
      const childContext: AgentContext = {
        systemPrompt: options.agent.state.systemPrompt,
        messages: [...options.agent.state.messages],
        tools: childTool ? [childTool] : [],
      };
      const toolCall = {
        type: 'toolCall',
        id: request.toolCallId,
        name: request.toolName,
        arguments: { ...request.args },
      } as AgentToolCall;
      const lifecycleConfig: ToolCallLifecycleConfig = {
        ...(options.agent.beforeToolCall ? { beforeToolCall: options.agent.beforeToolCall } : {}),
        ...(options.agent.onToolExecutionStart
          ? { onToolExecutionStart: options.agent.onToolExecutionStart }
          : {}),
        ...(options.agent.afterToolCall ? { afterToolCall: options.agent.afterToolCall } : {}),
      };
      let startAcknowledged = false;
      let deferredTerminalEvent: PtcChildTerminalEvent | undefined;
      let terminalEmissionAttempted = false;
      let finalizedOutcome: PtcToolExecutionOutcome | undefined;
      const emitChildLifecycleEvent = async (event: AgentEvent): Promise<void> => {
        if (event.type === 'tool_execution_end') {
          deferredTerminalEvent = event;
          return;
        }
        await options.emit(event);
        if (event.type === 'tool_execution_start') startAcknowledged = true;
      };

      try {
        const finalized = await executeToolCall(
          childContext,
          parent,
          toolCall,
          lifecycleConfig,
          request.signal,
          emitChildLifecycleEvent,
          {
            parentToolCallId: request.parentToolCallId,
            ...(request.parentDescription?.trim()
              ? { parentDescription: request.parentDescription.trim() }
              : {}),
          },
        );
        const outcome = completedOutcome(
          baseRecord,
          finalized.args,
          finalized.result,
          finalized.isError,
          finalized.failure,
          finalized.isErrorOrigin,
          finalized.terminateAgent === true,
          outcomeSources(runtimeTool, request),
          options.turn.input.toolConfig.context.ptcResultProjection,
          own,
          readTurnLogger(options.turn),
        );
        finalizedOutcome = outcome;
        terminalEmissionAttempted = true;
        await emitPtcChildTerminalEvent(options.emit, deferredTerminalEvent, request, outcome);
        return outcome;
      } catch {
        const unknown = unknownOutcome(
          baseRecord,
          'PTC_OUTCOME_UNKNOWN',
          'PTC execution did not report a terminal outcome.',
        );
        const outcome = finalizedOutcome
          ? {
              ...finalizedOutcome,
              ...unknown,
              record: { ...finalizedOutcome.record, ...unknown.record },
              retainedFacts: [...finalizedOutcome.retainedFacts, ...unknown.retainedFacts],
              terminateAgent: finalizedOutcome.terminateAgent,
            }
          : unknown;
        if (startAcknowledged && !terminalEmissionAttempted) {
          try {
            terminalEmissionAttempted = true;
            await emitPtcChildTerminalEvent(options.emit, deferredTerminalEvent, request, outcome);
          } catch {
            // A failed durable end is itself unknown; the persisted start lets recovery mark it so.
          }
        }
        return outcome;
      }
    },
  };
}

async function emitPtcChildTerminalEvent(
  emit: (event: AgentEvent) => Promise<void>,
  terminal: PtcChildTerminalEvent | undefined,
  request: PtcToolExecutionRequest,
  outcome: PtcToolExecutionOutcome,
): Promise<void> {
  const rawResult = terminal?.result ?? unknownPtcChildResult(outcome);
  await emit({
    type: 'tool_execution_end',
    toolCallId: terminal?.toolCallId ?? request.toolCallId,
    toolName: terminal?.toolName ?? request.toolName,
    result: withPtcChildExecutionDetails(rawResult, outcome),
    isError: outcome.isError === true,
    parentToolCallId: terminal?.parentToolCallId ?? request.parentToolCallId,
  });
}

function withPtcChildExecutionDetails(
  result: AgentToolResult<unknown>,
  outcome: PtcToolExecutionOutcome,
): AgentToolResult<unknown> {
  const details = isRecord(result.details)
    ? result.details
    : result.details === undefined
      ? {}
      : { original_tool_details: result.details };
  return {
    ...result,
    details: {
      ...details,
      ptc_child: {
        version: 1,
        record: outcome.record,
        retained_facts: outcome.retainedFacts,
      },
    },
  };
}

function unknownPtcChildResult(outcome: PtcToolExecutionOutcome): AgentToolResult<unknown> {
  return {
    content: [
      {
        type: 'text',
        text: outcome.error?.message ?? 'PTC execution did not report a terminal outcome.',
      },
    ],
    details: {},
  };
}

function findRuntimeTool<TCtx extends ToolExecutionContext>(
  turn: turnState<TCtx>,
  toolName: string,
): RuntimeTool | undefined {
  return turn.input.toolConfig.ptcTools?.find((tool) => tool.def.name === toolName);
}

function outcomeSources(
  runtimeTool: RuntimeTool | undefined,
  request: PtcToolExecutionRequest,
): Pick<PtcToolExecutionOutcome, 'source' | 'evidenceSource'> {
  const evidenceSource =
    runtimeTool && request.evidenceSource?.tool === runtimeTool
      ? request.evidenceSource.source
      : runtimeTool?.source;
  return {
    ...(runtimeTool?.source === undefined ? {} : { source: runtimeTool.source }),
    ...(evidenceSource === undefined ? {} : { evidenceSource }),
  };
}

function findAssistantMessage(
  agent: Agent,
  parentToolCallId: string,
): AssistantMessage | undefined {
  if (!agent.state.pendingToolCalls.has(parentToolCallId)) return undefined;
  for (const message of [...agent.state.messages].reverse()) {
    if (message.role !== 'assistant') continue;
    const assistant = message as AssistantMessage;
    if (
      assistant.content.some(
        (block) =>
          block.type === 'toolCall' && block.id === parentToolCallId && block.name === 'run_code',
      )
    ) {
      return assistant;
    }
  }
  return undefined;
}

function failedOutcome(
  baseRecord: Omit<PtcToolCallRecord, 'status' | 'is_error'>,
  code: string,
  message: string,
): PtcToolExecutionOutcome {
  return {
    isError: true,
    error: { code, message },
    record: { ...baseRecord, status: 'failed', is_error: true },
    retainedFacts: [
      {
        kind: 'child_error',
        child_tool_call_id: baseRecord.child_tool_call_id,
        code,
        ...(code === 'PTC_ABORTED' ? { cancelled: true } : {}),
      },
    ],
    terminateAgent: false,
  };
}

function unknownOutcome(
  baseRecord: Omit<PtcToolCallRecord, 'status' | 'is_error' | 'outcome_unknown'>,
  code: string,
  message: string,
): PtcToolExecutionOutcome {
  return {
    isError: true,
    error: { code, message },
    record: { ...baseRecord, status: 'unknown', is_error: true, outcome_unknown: true },
    retainedFacts: [
      { kind: 'outcome_unknown', child_tool_call_id: baseRecord.child_tool_call_id },
      { kind: 'child_error', child_tool_call_id: baseRecord.child_tool_call_id, code },
    ],
    terminateAgent: false,
  };
}

function completedOutcome(
  baseRecord: Omit<PtcToolCallRecord, 'status' | 'is_error' | 'input' | 'result_ref'>,
  args: unknown,
  result: AgentToolResult<unknown>,
  isError: boolean,
  failure: ToolCallFailure | undefined,
  isErrorOrigin: 'tool' | 'hook' | undefined,
  terminateAgent: boolean,
  sources: Pick<PtcToolExecutionOutcome, 'source' | 'evidenceSource'>,
  projection: PtcToolResultProjection | undefined,
  own: OwnToolOutcome,
  logger: Partial<PiTurnRunnerLogger> | undefined,
): PtcToolExecutionOutcome {
  const defaultStatus = isError ? 'failed' : 'completed';
  const ownership = resolveToolOwnership(own, result, isError, failure, isErrorOrigin);
  const programmatic = ownership.owned ? ownership.programmatic : undefined;
  if (!ownership.owned) logWithheldPayload(logger, baseRecord, own, ownership.reason);
  const projected = projection?.project({
    childToolCallId: baseRecord.child_tool_call_id,
    parentToolCallId: baseRecord.parent_tool_call_id,
    toolName: baseRecord.tool_name,
    ...(sources.evidenceSource === undefined ? {} : { source: sources.evidenceSource }),
    ...(args === undefined ? {} : { args }),
    result,
    isError,
    ...(isErrorOrigin === undefined ? {} : { isErrorOrigin }),
    status: defaultStatus,
    ...(programmatic ? { programmatic } : {}),
  });
  const status = projected?.status ?? defaultStatus;
  const effectiveIsError = projected?.isError ?? isError;
  const error = effectiveIsError ? outcomeError(failure, result, ownership.owned) : undefined;
  const toolErrorCode = error ? thrownToolErrorCode(own, failure) : undefined;
  const retainedFacts: PtcRetainedFact[] = [
    ...(projected?.retainedFacts ?? []),
    ...(error
      ? [
          {
            kind: 'child_error' as const,
            child_tool_call_id: baseRecord.child_tool_call_id,
            code: error.code,
            ...(failure?.kind === 'cancelled' ? { cancelled: true } : {}),
            ...(toolErrorCode === undefined ? {} : { tool_error_code: toolErrorCode }),
          },
        ]
      : []),
    ...(failure?.kind === 'blocked' && failure.approvalStatus !== undefined
      ? [
          {
            kind: 'approval' as const,
            child_tool_call_id: baseRecord.child_tool_call_id,
            status: failure.approvalStatus,
          },
        ]
      : []),
    ...(terminateAgent ? [{ kind: 'terminate_agent' } as const] : []),
  ];
  return {
    result,
    isError: effectiveIsError,
    ...sources,
    ...(error ? { error } : {}),
    ...(programmatic ? { programmatic } : {}),
    ...(ownership.owned ? {} : { resultRewritten: true as const }),
    ...(!ownership.owned && ownership.imageEncoding
      ? { imageEncoding: ownership.imageEncoding }
      : {}),
    record: {
      ...baseRecord,
      ...(projected?.input ? { input: projected.input } : {}),
      status,
      ...(effectiveIsError ? { is_error: true } : {}),
      ...(projected?.resultRef ? { result_ref: projected.resultRef } : {}),
    },
    retainedFacts,
    ...(failure?.kind === 'blocked' && failure.approvalStatus === 'denied'
      ? { stopPtcProgram: true }
      : {}),
    terminateAgent,
  };
}

/** The tool's own return value or thrown error, captured before Pi hooks ran. */
interface OwnToolOutcome {
  returned?: OwnToolResult;
  thrown?: { readonly error: unknown };
}

/**
 * A tool result as it left the tool. Pi passes the hooks the same content
 * array (and, while `isError` is unset, the same details object), so a hook
 * that edits in place changes `result` as well; the error state and the
 * content JSON are therefore taken before any hook runs.
 */
interface OwnToolResult {
  readonly result: ToolResult;
  readonly isError: boolean;
  /** JSON text of `result.content`; undefined when it cannot be serialized. */
  readonly contentJson: string | undefined;
}

type ToolOwnership =
  | { readonly owned: true; readonly programmatic?: ProgrammaticToolResult }
  | {
      readonly owned: false;
      readonly reason:
        | 'after_hook_failed'
        | 'hook_changed_error_state'
        | 'hook_changed_content'
        | 'content_unreadable';
      /** The content change was only the host image encoder's; see `imageEncoding` on the outcome. */
      readonly imageEncoding?: NonNullable<PtcToolExecutionOutcome['imageEncoding']>;
    };

/**
 * Whether the final Pi result is still exactly what the tool produced. Only
 * then may PTC expose the tool's programmatic payload (data, completeness,
 * raw error) or quote its error text: a hook that redacted, replaced or
 * re-classified a result, or a safety check that intercepted it (it fails the
 * after-hook chain), must not be bypassed through that side channel.
 * Immediate failures (unknown tool, invalid arguments, blocked call) never ran
 * an after-hook, so their final text is Pi's own and stays quotable.
 */
function resolveToolOwnership(
  own: OwnToolOutcome,
  result: AgentToolResult<unknown>,
  isError: boolean,
  failure: ToolCallFailure | undefined,
  isErrorOrigin: 'tool' | 'hook' | undefined,
): ToolOwnership {
  if (failure?.kind === 'after_hook') return { owned: false, reason: 'after_hook_failed' };
  if (own.returned) {
    if (failure !== undefined) return { owned: false, reason: 'after_hook_failed' };
    if (isErrorOrigin === 'hook' || isError !== own.returned.isError) {
      return { owned: false, reason: 'hook_changed_error_state' };
    }
    // Content and error state only, as the proposal defines ownership.
    // details are not compared because the host itself adds fields such as
    // `is_error` there, so a hook that rewrites only details does not change
    // `data` (for MCP, structuredContent is also in details.mcp; README §4.13).
    const same = sameToolContent(result.content, own.returned.contentJson);
    if (same !== true) return { owned: false, reason: same, ...encodedOnly(own.returned, result) };
    const programmatic = own.returned.result.programmatic;
    return { owned: true, ...(programmatic ? { programmatic } : {}) };
  }
  if (own.thrown && failure?.kind === 'execution') {
    // Pi replaced the throw with `createErrorToolResult(message)` before the hooks ran.
    if (isErrorOrigin === 'hook' || !isError) {
      return { owned: false, reason: 'hook_changed_error_state' };
    }
    const expected = contentJson([{ type: 'text', text: failure.message }]);
    const same = sameToolContent(result.content, expected);
    if (same !== true) return { owned: false, reason: same };
    const errorRaw = readProgrammaticErrorRaw(own.thrown.error);
    const data = readProgrammaticErrorData(own.thrown.error);
    const programmatic = {
      ...(errorRaw === undefined ? {} : { errorRaw }),
      ...(data === undefined ? {} : { data }),
    };
    return { owned: true, ...(Object.keys(programmatic).length > 0 ? { programmatic } : {}) };
  }
  return { owned: true };
}

/**
 * The result stays rewritten (no completeness, no details projection), but
 * when the host's request image encoder alone turned the tool's own content
 * into the final one, its facts and the tool's own data go with it, so the
 * projection can say how the image was sent. Any other hook change, before or
 * after the encoder, breaks the digest check and leaves nothing.
 */
function encodedOnly(
  own: OwnToolResult,
  result: AgentToolResult<unknown>,
): { readonly imageEncoding?: NonNullable<PtcToolExecutionOutcome['imageEncoding']> } {
  const images: readonly ProgrammaticImageEncoding[] | undefined = readImageEncodedContent(
    result.content,
    own.contentJson,
  );
  if (!images) return {};
  const data = own.result.programmatic?.data;
  return { imageEncoding: { images, ...(data ? { data } : {}) } };
}

/** JSON text of tool content; undefined when it cannot be serialized (cycles, BigInt). */
function contentJson(content: unknown): string | undefined {
  try {
    return JSON.stringify(content);
  } catch {
    // Reported by the caller as `content_unreadable`, never as unchanged.
    return undefined;
  }
}

/**
 * Compares the final content with the tool's own content as JSON text, never
 * by reference. Content that cannot be serialized cannot be proven unchanged,
 * so it counts as rewritten.
 */
function sameToolContent(
  actual: unknown,
  expectedJson: string | undefined,
): true | 'hook_changed_content' | 'content_unreadable' {
  const actualJson = contentJson(actual);
  if (expectedJson === undefined || actualJson === undefined) return 'content_unreadable';
  return actualJson === expectedJson ? true : 'hook_changed_content';
}

/** Records why the tool's payload was withheld; never logs the payload or content itself. */
function logWithheldPayload(
  logger: Partial<PiTurnRunnerLogger> | undefined,
  record: Pick<PtcToolCallRecord, 'child_tool_call_id' | 'parent_tool_call_id' | 'tool_name'>,
  own: OwnToolOutcome,
  reason: Extract<ToolOwnership, { owned: false }>['reason'],
): void {
  const payload = own.returned?.result.programmatic;
  const hasRaw =
    own.thrown !== undefined && readProgrammaticErrorRaw(own.thrown.error) !== undefined;
  const hasThrownData =
    own.thrown !== undefined && readProgrammaticErrorData(own.thrown.error) !== undefined;
  if (!payload && !hasRaw && !hasThrownData && reason !== 'after_hook_failed') return;
  try {
    logger?.info?.(
      {
        child_tool_call_id: record.child_tool_call_id,
        parent_tool_call_id: record.parent_tool_call_id,
        tool_name: record.tool_name,
        reason,
        had_data: payload?.data !== undefined || hasThrownData,
        had_completeness: payload?.completeness !== undefined,
        had_error_raw: payload?.errorRaw !== undefined || hasRaw,
      },
      'ptc child programmatic payload withheld',
    );
  } catch {
    // Diagnostics must not change the child outcome.
  }
}

function readTurnLogger(turn: object): Partial<PiTurnRunnerLogger> | undefined {
  // Unit-test turns may omit the logger; production turns always carry one.
  return (turn as { readonly logger?: Partial<PiTurnRunnerLogger> }).logger;
}

/** Mutable batch clock; callers only ever see the derived deadline. */
interface BatchClock {
  readonly id: string;
  readonly startedAtMs: number;
  /**
   * Largest resolved wall clock any run_code call in the batch asked for, or
   * more when a foreground Bash child extended it (extendForChildTimeout).
   */
  wallClockMs: number;
}

function deadlineOf(clock: BatchClock): number {
  return clock.startedAtMs + clock.wallClockMs;
}

function batchView(clock: BatchClock): PtcToolExecutionBatch {
  return { id: clock.id, deadlineAtMs: deadlineOf(clock) };
}

type ChildRecord = Pick<
  PtcToolCallRecord,
  'child_tool_call_id' | 'parent_tool_call_id' | 'tool_name'
>;

/**
 * The deadline one child sees. This batch clock is the only place the
 * deadline is computed or extended: `atMs` reads it live, the dispatch check
 * reads it, and run_code reads it again through getBatch when the guest wall
 * clock fires, so the three never disagree.
 */
function childDeadline(
  clock: BatchClock,
  nowMs: () => number,
  logger: () => Partial<PiTurnRunnerLogger> | undefined,
  record: ChildRecord,
): PtcChildDeadline {
  return {
    get atMs() {
      return deadlineOf(clock);
    },
    extendForTimeout: (timeoutSeconds: number) => {
      const extension = extendForChildTimeout(clock, nowMs(), timeoutSeconds);
      if (extension) logWallClockExtended(logger(), record, timeoutSeconds, extension);
      return deadlineOf(clock);
    },
    reportTimeout: (decision: PtcChildTimeoutDecision) =>
      logChildTimeout(logger(), record, decision),
  };
}

/**
 * Room after a Bash child's own timeout: a command that runs to its timeout
 * still has its result delivered and the program can return. Without it the
 * program deadline would land on the same moment and report a wall clock stop.
 */
const CHILD_TIMEOUT_MARGIN_MS = 5_000;

interface WallClockExtension {
  readonly remainingMs: number;
  readonly extendedRemainingMs: number;
  readonly capped: boolean;
}

/**
 * A foreground Bash child asked for a `timeout` longer than the program has
 * left. In the 969645 eval 59 programs hit the 120s wall clock this way (a
 * long tools.bash timeout but no run_code timeout_ms): the command was cut
 * short and the next round ran it again. So the deadline moves to now plus
 * that timeout plus a margin, never past one hour from the batch start (the
 * timeout_ms maximum; a millisecond value written into the seconds argument
 * stops there) and never earlier. An expired program is not revived.
 */
function extendForChildTimeout(
  clock: BatchClock,
  nowMs: number,
  timeoutSeconds: number,
): WallClockExtension | undefined {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return undefined;
  const deadlineAtMs = deadlineOf(clock);
  const remainingMs = deadlineAtMs - nowMs;
  if (remainingMs <= 0 || timeoutSeconds * 1_000 <= remainingMs) return undefined;
  const wantedAtMs = nowMs + timeoutSeconds * 1_000 + CHILD_TIMEOUT_MARGIN_MS;
  const maxAtMs = clock.startedAtMs + PTC_MAX_WALL_CLOCK_MS;
  const extendedAtMs = Math.min(wantedAtMs, maxAtMs);
  if (extendedAtMs <= deadlineAtMs) return undefined;
  clock.wallClockMs = extendedAtMs - clock.startedAtMs;
  return { remainingMs, extendedRemainingMs: extendedAtMs - nowMs, capped: wantedAtMs > maxAtMs };
}

/** One line per extension; never logs the command or other arguments. */
function logWallClockExtended(
  logger: Partial<PiTurnRunnerLogger> | undefined,
  record: ChildRecord,
  timeoutSeconds: number,
  extension: WallClockExtension,
): void {
  try {
    logger?.info?.(
      {
        child_tool_call_id: record.child_tool_call_id,
        parent_tool_call_id: record.parent_tool_call_id,
        tool_name: record.tool_name,
        requested_timeout_s: timeoutSeconds,
        remaining_ms: Math.round(extension.remainingMs),
        extended_remaining_ms: Math.round(extension.extendedRemainingMs),
        capped: extension.capped,
      },
      'ptc wall clock extended for bash timeout',
    );
  } catch {
    // Diagnostics must not change the child outcome.
  }
}

/**
 * Records how a child tool bounded its timeout by the program deadline, so a
 * command that stopped early can be traced to this rule. Never logs arguments.
 */
function logChildTimeout(
  logger: Partial<PiTurnRunnerLogger> | undefined,
  record: Pick<PtcToolCallRecord, 'child_tool_call_id' | 'parent_tool_call_id' | 'tool_name'>,
  decision: PtcChildTimeoutDecision,
): void {
  try {
    logger?.info?.(
      {
        child_tool_call_id: record.child_tool_call_id,
        parent_tool_call_id: record.parent_tool_call_id,
        tool_name: record.tool_name,
        timeout_source: decision.source,
        timeout_s: decision.timeoutSeconds,
        remaining_ms: decision.remainingMs,
      },
      'ptc child timeout bounded by program deadline',
    );
  } catch {
    // Diagnostics must not change the child outcome.
  }
}

/**
 * Guest-facing error for a failed child. `code` always comes from the host's
 * enumeration below. `message` is the tool's own error text when the tool
 * returned an error result that no hook rewrote (MCP/plugin `isError`);
 * otherwise it stays the host or Pi message used before.
 */
function outcomeError(
  failure: ToolCallFailure | undefined,
  result: AgentToolResult<unknown>,
  owned: boolean,
): PtcToolExecutionError {
  const base = errorFromFailure(failure);
  if (failure === undefined) {
    const text = owned ? boundErrorMessage(resultText(result)) : '';
    return text ? { code: base.code, message: text, quotable: true } : base;
  }
  return {
    code: base.code,
    message: boundErrorMessage(base.message),
    ...(owned && failure.kind !== 'after_hook' ? { quotable: true } : {}),
  };
}

function errorFromFailure(failure: ToolCallFailure | undefined): {
  readonly code: string;
  readonly message: string;
} {
  if (!failure) return { code: 'PTC_TOOL_FAILED', message: 'Tool execution failed.' };
  const codeByKind = {
    tool_not_found: 'PTC_TOOL_NOT_FOUND',
    argument_preparation: 'PTC_ARGUMENT_PREPARATION_FAILED',
    argument_validation: 'PTC_ARGUMENT_VALIDATION_FAILED',
    before_hook: 'PTC_BEFORE_TOOL_HOOK_FAILED',
    blocked: failure.blockedBy === 'permission' ? 'PTC_PERMISSION_DENIED' : 'PTC_TOOL_BLOCKED',
    cancelled: 'PTC_CANCELLED',
    execution: 'PTC_TOOL_EXECUTION_FAILED',
    after_hook: 'PTC_AFTER_TOOL_HOOK_FAILED',
  } as const;
  return { code: codeByKind[failure.kind], message: failure.message };
}

/**
 * Pi's failure keeps only the message of a thrown error, so the tool's own
 * code (for example `computer_aborted`) is read from the object the tool
 * threw. It is host metadata only: the guest and the model keep seeing the
 * PTC_* code and the unchanged message.
 */
function thrownToolErrorCode(
  own: OwnToolOutcome,
  failure: ToolCallFailure | undefined,
): string | undefined {
  if (failure?.kind !== 'execution' || !own.thrown || !isRecord(own.thrown.error)) {
    return undefined;
  }
  const code = own.thrown.error.code;
  return isPtcToolErrorCode(code) ? code : undefined;
}

function resultText(result: AgentToolResult<unknown>): string {
  return (Array.isArray(result.content) ? result.content : [])
    .flatMap((block) => (isRecord(block) && typeof block.text === 'string' ? [block.text] : []))
    .join('\n')
    .trim();
}

function boundErrorMessage(message: string): string {
  const characters = Array.from(message);
  if (characters.length <= MAX_PTC_ERROR_MESSAGE_CHARS) return message;
  return `${characters.slice(0, MAX_PTC_ERROR_MESSAGE_CHARS - 1).join('')}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
