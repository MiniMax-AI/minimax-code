/**
 * Host-facing contracts for programmatic tool calls (PTC).
 *
 * The runtime owns admission, guest projection, and persistence. Agent-core
 * only gives an already-running tool a narrow way to execute another tool
 * through the same Pi lifecycle.
 */

import type { ProgrammaticImageEncoding } from './programmatic.js';
import type { ProgrammaticToolResult, RuntimeTool } from './types.js';

export type PtcChildCallStatus = 'completed' | 'failed' | 'unknown';
export type PtcToolSource = 'builtin' | 'builtin-matrix' | 'configured';

export interface PtcToolCallRecord {
  readonly child_tool_call_id: string;
  readonly parent_tool_call_id: string;
  readonly tool_name: string;
  readonly input?: Readonly<Record<string, unknown>>;
  readonly status: PtcChildCallStatus;
  readonly is_error?: boolean;
  readonly outcome_unknown?: boolean;
  readonly result_ref?: string;
}

export type PtcRetainedFact =
  | { readonly kind: 'terminate_agent' }
  | { readonly kind: 'outcome_unknown'; readonly child_tool_call_id: string }
  | {
      readonly kind: 'child_error';
      readonly child_tool_call_id: string;
      readonly code: string;
      readonly cancelled?: boolean;
      /**
       * `code` of the error object the child tool threw, kept so host checks
       * can tell failures apart without parsing text; `code` above stays the
       * PTC_* wrapper. Never shown to the guest or the model.
       */
      readonly tool_error_code?: string;
    }
  | {
      readonly kind: 'truncation';
      readonly child_tool_call_id: string;
      readonly truncated: 'true' | 'unknown';
      readonly continuation?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: 'background_task';
      readonly child_tool_call_id: string;
      readonly task_id: string;
    }
  | {
      readonly kind: 'bash_exit';
      readonly child_tool_call_id: string;
      readonly exit_code: number | null;
    }
  | {
      readonly kind: 'media_delivery';
      readonly child_tool_call_id: string;
      readonly status: 'delivered' | 'unavailable' | 'budget_exceeded';
      readonly refs?: readonly { readonly uri: string; readonly mimeType?: string }[];
    }
  | {
      readonly kind: 'approval';
      readonly child_tool_call_id: string;
      readonly status: 'denied' | 'expired';
    }
  | {
      readonly kind: 'plugin_feedback';
      readonly child_tool_call_id: string;
      readonly phase: 'additional_context' | 'post_tool_feedback' | 'updated_result';
      readonly text?: string;
    }
  | {
      readonly kind: 'delivery_incomplete';
      readonly reason: 'outer_limit';
      readonly reference?: string;
    }
  | {
      readonly kind: 'budget_exceeded';
      readonly budget: 'tool_calls' | 'bridge' | 'code';
      /**
       * Calls refused after the tool-call budget was reached. Present only
       * since refusals stopped ending the program; a `tool_calls` fact without
       * it comes from older runs, where reaching the budget stopped the program.
       */
      readonly refused_calls?: number;
    };

export interface PtcToolResultProjectionInput {
  readonly childToolCallId: string;
  readonly parentToolCallId: string;
  readonly toolName: string;
  /** Trusted source from the final authorized child catalog. */
  readonly source?: PtcToolSource;
  /** Final, already-admitted params after prepare and before-tool hooks. */
  readonly args?: unknown;
  /** Final result after after-tool hooks. This never reaches the guest directly. */
  readonly result?: unknown;
  readonly isError?: boolean;
  /** Source-owned distinction between tool failure and an after-hook override. */
  readonly isErrorOrigin?: 'tool' | 'hook';
  readonly status: PtcChildCallStatus;
  /**
   * The tool's own programmatic payload, present only when no hook rewrote
   * the result content or error state (see PtcToolExecutionOutcome).
   */
  readonly programmatic?: ProgrammaticToolResult;
}

/**
 * Trusted host projection. Returning no input is safer than exposing raw
 * parameters; callers must explicitly whitelist what their guest may retain.
 */
export interface PtcToolResultProjection {
  project(input: PtcToolResultProjectionInput): {
    readonly input?: Readonly<Record<string, unknown>>;
    readonly resultRef?: string;
    readonly retainedFacts?: readonly PtcRetainedFact[];
    /** A source-owned completion classification, for example Bash exitCode. */
    readonly status?: Exclude<PtcChildCallStatus, 'unknown'>;
    readonly isError?: boolean;
  };
}

export interface PtcToolExecutionRequest {
  readonly parentToolCallId: string;
  /** User-visible run_code description preserved for child approval surfaces. */
  readonly parentDescription?: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  /** In-process host identity only; never accepted from guest arguments or persisted. */
  readonly evidenceSource?: {
    readonly tool: RuntimeTool;
    readonly source: PtcToolSource;
  };
}

/** Wall clock of a run_code program when the model sets no `timeout_ms`. */
export const PTC_DEFAULT_WALL_CLOCK_MS = 120_000;
/** Largest `timeout_ms` a run_code program may use; larger requests are capped to it. */
export const PTC_MAX_WALL_CLOCK_MS = 3_600_000;

/**
 * How a requested wall clock was resolved: `default` (not set), `requested`
 * (used as given), `capped` (above the maximum) or `invalid` (not a finite
 * positive number, so the default applies).
 */
export type PtcWallClockSource = 'default' | 'requested' | 'capped' | 'invalid';

export interface PtcWallClock {
  readonly ms: number;
  readonly source: PtcWallClockSource;
}

/**
 * The one rule for turning a model-supplied `timeout_ms` into a wall clock.
 * run_code and the batch deadline both use it, so the guest wall clock, the
 * child-call cutoff and a PTC Bash child's timeout derive from one value.
 */
export function resolvePtcWallClock(requested: unknown): PtcWallClock {
  if (requested === undefined) return { ms: PTC_DEFAULT_WALL_CLOCK_MS, source: 'default' };
  if (typeof requested !== 'number' || !Number.isFinite(requested) || requested <= 0) {
    return { ms: PTC_DEFAULT_WALL_CLOCK_MS, source: 'invalid' };
  }
  if (requested > PTC_MAX_WALL_CLOCK_MS) return { ms: PTC_MAX_WALL_CLOCK_MS, source: 'capped' };
  return { ms: requested, source: 'requested' };
}

export interface PtcToolExecutionBatch {
  /** Stable only within one assistant message, not across model iterations. */
  readonly id: string;
  /**
   * Wall-clock deadline shared by every run_code call in this assistant batch:
   * the first call's start plus the largest wall clock any call in the batch
   * asked for. A later call may raise it but never restarts it, so several
   * run_code calls in one response cannot each claim a fresh budget. A
   * foreground Bash child with a longer `timeout` may also move it later
   * (`PtcChildDeadline.extendForTimeout`), so read it again rather than keep it.
   */
  readonly deadlineAtMs: number;
}

/**
 * Deadline of the run_code program that issued a PTC child call. Present only
 * on PTC child contexts and equal to the batch deadline that refuses late
 * child calls and stops the guest program.
 */
export interface PtcChildDeadline {
  /** Unix ms; always the current batch deadline, including any extension. */
  readonly atMs: number;
  /**
   * Called by a foreground Bash child with its own `timeout` (seconds). When
   * that is longer than the program has left, the batch deadline moves to fit
   * it instead of the command being cut short (rule and one-hour cap in the
   * batch clock of pi-turn-runner/ptc-tool-executor.ts). Returns the deadline
   * after the call; unchanged when the timeout fits or is not a finite
   * positive number, when the program has already expired, or at the cap.
   */
  readonly extendForTimeout?: (timeoutSeconds: number) => number;
  /**
   * Lets a child tool that bounded its own timeout by `atMs` record that
   * decision in the host log; the desktop tool layer holds no logger.
   */
  readonly reportTimeout?: (decision: PtcChildTimeoutDecision) => void;
}

export interface PtcChildTimeoutDecision {
  /**
   * `program_remaining`: no usable timeout was given, so the time left was
   * used; `requested`: the given timeout fits in the time left (after any
   * extension); `requested_capped`: the given timeout was cut to the time
   * left, which with extension happens only at the one-hour maximum or for
   * a program that had already expired.
   */
  readonly source: 'program_remaining' | 'requested' | 'requested_capped';
  readonly timeoutSeconds: number;
  readonly remainingMs: number;
}

export interface PtcToolExecutionOutcome {
  /** Final Pi result after after-tool hooks; runtime projects this for the guest. */
  readonly result?: unknown;
  readonly isError?: boolean;
  /** Original runtime source used by permissions and tool hooks. */
  readonly source?: PtcToolSource;
  /** Host-verified ownership for result projection, independent of permission source. */
  readonly evidenceSource?: PtcToolSource;
  readonly error?: PtcToolExecutionError;
  /**
   * The tool's own programmatic payload (data, completeness, raw error).
   * Present only when the final result is still the tool's own: no hook
   * changed its content or error state and no host safety step replaced it,
   * so guest code can never read data that a hook or safety check withheld.
   */
  readonly programmatic?: ProgrammaticToolResult;
  /**
   * A hook or host safety step changed the final result, so `programmatic`
   * was withheld. Guest projections then expose no structured fields from
   * `details` either: those may describe what the hook replaced.
   */
  readonly resultRewritten?: true;
  /**
   * Set with `resultRewritten` when the only change was the host's request
   * image encoder (recordImageEncodedContent) applied to the tool's own
   * content: its facts per changed image, and the tool's own `data`, so a
   * projection that knows the tool can state the image's final form.
   */
  readonly imageEncoding?: {
    readonly images: readonly ProgrammaticImageEncoding[];
    readonly data?: Readonly<Record<string, unknown>>;
  };
  readonly record: PtcToolCallRecord;
  readonly retainedFacts: readonly PtcRetainedFact[];
  /** Stop the current PTC program without terminating the outer agent. */
  readonly stopPtcProgram?: boolean;
  readonly terminateAgent: boolean;
}

export interface PtcToolExecutionError {
  /** Host-enumerated code (PTC_*); never copied from tool or third-party content. */
  readonly code: string;
  /** One-line explanation; the tool's own error text when it reported one, at most 1000 characters. */
  readonly message: string;
  /**
   * True when `message` is the final result text that the model would also
   * see without PTC (no hook rewrote it, no safety step intercepted it), so
   * the host may quote it in the outer run_code result.
   */
  readonly quotable?: boolean;
}

/**
 * Trusted PTC terminal state attached only to the durable display result of a
 * child tool call. It is separate from the outer run_code `details.ptc`
 * envelope because it exists before the guest program can produce that outer
 * result.
 */
export interface PtcChildExecutionDetails {
  readonly version: 1;
  readonly record: PtcToolCallRecord;
  readonly retained_facts: readonly PtcRetainedFact[];
}

/** Turn-local host fact buffer shared by PTC hook collection and projection. */
export interface PtcToolFactCollector {
  record(childToolCallId: string, facts: readonly PtcRetainedFact[]): void;
  read(childToolCallId: string): readonly PtcRetainedFact[];
}

export function createPtcToolFactCollector(): PtcToolFactCollector {
  const factsByChildCall = new Map<string, PtcRetainedFact[]>();
  return {
    record(childToolCallId, facts) {
      if (!childToolCallId || facts.length === 0) return;
      const existing = factsByChildCall.get(childToolCallId) ?? [];
      factsByChildCall.set(childToolCallId, [...existing, ...facts]);
    },
    read(childToolCallId) {
      return [...(factsByChildCall.get(childToolCallId) ?? [])];
    },
  };
}

export interface PtcToolExecutor {
  /**
   * The batch of the assistant message carrying `parentToolCallId`. A run_code
   * call passes its resolved wall clock (ms) to create the batch or raise its
   * deadline; child dispatch passes none and only reads it.
   */
  getBatch(parentToolCallId: string, wallClockMs?: number): PtcToolExecutionBatch | undefined;
  getToolExecutionMode(toolName: string): 'parallel' | 'sequential' | undefined;
  execute(input: PtcToolExecutionRequest): Promise<PtcToolExecutionOutcome>;
}

export interface PtcExecutionDetails {
  readonly version: 1;
  readonly child_calls: readonly PtcToolCallRecord[];
  readonly retained_facts: readonly PtcRetainedFact[];
  /** Host-authored mandatory prefix already present in the outer run_code content. */
  readonly host_forced_content?: string;
}

/**
 * Reads only the trusted PTC envelope on a real Pi run_code tool result. It
 * deliberately does not parse user text, arbitrary tool content, or an
 * untyped `details` object from another tool.
 */
export function readPtcExecutionDetails(message: unknown): PtcExecutionDetails | undefined {
  if (!isRecord(message) || message.role !== 'toolResult' || message.toolName !== 'run_code') {
    return undefined;
  }
  const details = isRecord(message.details) ? message.details : undefined;
  const ptc = details && isRecord(details.ptc) ? details.ptc : undefined;
  if (
    !ptc ||
    ptc.version !== 1 ||
    !Array.isArray(ptc.child_calls) ||
    !Array.isArray(ptc.retained_facts) ||
    (ptc.host_forced_content !== undefined && typeof ptc.host_forced_content !== 'string')
  ) {
    return undefined;
  }
  const childCalls = ptc.child_calls.filter(isPtcToolCallRecord);
  const retainedFacts = ptc.retained_facts.filter(isPtcRetainedFact);
  if (
    childCalls.length !== ptc.child_calls.length ||
    retainedFacts.length !== ptc.retained_facts.length
  ) {
    return undefined;
  }
  return {
    version: 1,
    child_calls: childCalls,
    retained_facts: retainedFacts,
    ...(typeof ptc.host_forced_content === 'string'
      ? { host_forced_content: ptc.host_forced_content }
      : {}),
  };
}

export function readPtcToolCallRecords(message: unknown): readonly PtcToolCallRecord[] {
  return readPtcExecutionDetails(message)?.child_calls ?? [];
}

/**
 * Reads a terminal PTC child only from a durable RuntimeToolCall-shaped
 * display record. The persisted parent id must agree with the signed child
 * record, so arbitrary result content cannot impersonate a PTC child.
 */
export function readPtcChildExecutionDetails(value: unknown): PtcChildExecutionDetails | undefined {
  if (
    !isRecord(value) ||
    !isNonEmptyString(value.tool_call_id) ||
    !isNonEmptyString(value.parent_tool_call_id) ||
    !isRecord(value.result)
  ) {
    return undefined;
  }
  const details = isRecord(value.result.details) ? value.result.details : undefined;
  const ptcChild = details && isRecord(details.ptc_child) ? details.ptc_child : undefined;
  if (
    !ptcChild ||
    ptcChild.version !== 1 ||
    !isPtcToolCallRecord(ptcChild.record) ||
    !Array.isArray(ptcChild.retained_facts)
  ) {
    return undefined;
  }
  const retainedFacts = ptcChild.retained_facts.filter(isPtcRetainedFact);
  if (
    retainedFacts.length !== ptcChild.retained_facts.length ||
    ptcChild.record.child_tool_call_id !== value.tool_call_id ||
    ptcChild.record.parent_tool_call_id !== value.parent_tool_call_id
  ) {
    return undefined;
  }
  return {
    version: 1,
    record: ptcChild.record,
    retained_facts: retainedFacts,
  };
}

function isPtcToolCallRecord(value: unknown): value is PtcToolCallRecord {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.child_tool_call_id) &&
    isNonEmptyString(value.parent_tool_call_id) &&
    isNonEmptyString(value.tool_name) &&
    (value.input === undefined || isRecord(value.input)) &&
    (value.status === 'completed' || value.status === 'failed' || value.status === 'unknown') &&
    (value.is_error === undefined || typeof value.is_error === 'boolean') &&
    (value.outcome_unknown === undefined || typeof value.outcome_unknown === 'boolean') &&
    (value.result_ref === undefined || isNonEmptyString(value.result_ref))
  );
}

function isPtcRetainedFact(value: unknown): value is PtcRetainedFact {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  switch (value.kind) {
    case 'terminate_agent':
      return true;
    case 'outcome_unknown':
      return isNonEmptyString(value.child_tool_call_id);
    case 'child_error':
      return (
        isNonEmptyString(value.child_tool_call_id) &&
        isNonEmptyString(value.code) &&
        (value.cancelled === undefined || typeof value.cancelled === 'boolean') &&
        (value.tool_error_code === undefined || isPtcToolErrorCode(value.tool_error_code))
      );
    case 'truncation':
      return (
        isNonEmptyString(value.child_tool_call_id) &&
        (value.truncated === 'true' || value.truncated === 'unknown') &&
        (value.continuation === undefined || isRecord(value.continuation))
      );
    case 'background_task':
      return isNonEmptyString(value.child_tool_call_id) && isNonEmptyString(value.task_id);
    case 'bash_exit':
      return (
        isNonEmptyString(value.child_tool_call_id) &&
        (value.exit_code === null || isSafeInteger(value.exit_code))
      );
    case 'media_delivery':
      return (
        isNonEmptyString(value.child_tool_call_id) &&
        (value.status === 'delivered' ||
          value.status === 'unavailable' ||
          value.status === 'budget_exceeded') &&
        (value.refs === undefined ||
          (Array.isArray(value.refs) && value.refs.every(isPtcMediaReference)))
      );
    case 'approval':
      return (
        isNonEmptyString(value.child_tool_call_id) &&
        (value.status === 'denied' || value.status === 'expired')
      );
    case 'plugin_feedback':
      return (
        isNonEmptyString(value.child_tool_call_id) &&
        (value.phase === 'additional_context' ||
          value.phase === 'post_tool_feedback' ||
          value.phase === 'updated_result') &&
        (value.text === undefined || typeof value.text === 'string')
      );
    case 'delivery_incomplete':
      return (
        value.reason === 'outer_limit' &&
        (value.reference === undefined || isNonEmptyString(value.reference))
      );
    case 'budget_exceeded':
      return (
        (value.budget === 'tool_calls' || value.budget === 'bridge' || value.budget === 'code') &&
        (value.refused_calls === undefined ||
          (isSafeInteger(value.refused_calls) && value.refused_calls > 0))
      );
    default:
      return false;
  }
}

/** Longest tool error code kept; longer values are free text, not a code. */
const MAX_PTC_TOOL_ERROR_CODE_CHARS = 128;

/** Shared by the writer and the envelope reader so both accept the same codes. */
export function isPtcToolErrorCode(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= MAX_PTC_TOOL_ERROR_CODE_CHARS
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function isPtcMediaReference(
  value: unknown,
): value is { readonly uri: string; readonly mimeType?: string } {
  return (
    isRecord(value) &&
    isNonEmptyString(value.uri) &&
    (value.mimeType === undefined || typeof value.mimeType === 'string')
  );
}
