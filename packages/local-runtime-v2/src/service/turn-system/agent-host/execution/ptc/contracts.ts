// Type-only on purpose: the packaged QuickJS Worker loads this module from
// app.asar.unpacked, where @mavis/agent-core is not unpacked, so a value
// import here breaks every run_code in the desktop build.
import type {
  PtcExecutionDetails as AgentCorePtcExecutionDetails,
  PtcRetainedFact as AgentCorePtcRetainedFact,
  PtcToolCallRecord as AgentCorePtcToolCallRecord,
  ToolResultContent,
} from '@mavis/agent-core/tools';

export const PTC_LIMITS = {
  maxCodeBytes: 64 * 1024,
  maxHeapBytes: 64 * 1024 * 1024,
  maxComputeMs: 1_000,
  // Default only. run_code passes the time left until the Agent Core batch
  // deadline (raised by timeout_ms), the same deadline that refuses late
  // child calls, so the guest never outlives or undercuts that cutoff.
  // Agent Core's PTC_DEFAULT_WALL_CLOCK_MS, copied rather than imported (see
  // the import above); contracts.test.ts keeps the two equal.
  maxWallClockMs: 120_000,
  shutdownGraceMs: 5_000,
  // Every admitted call counts, failed ones included. Calls past the limit are
  // refused with PTC_TOOL_CALL_LIMIT_EXCEEDED instead of stopping the program.
  maxToolCalls: 100,
  // Parallel tools only; a sequential (writing) tool still runs alone.
  maxConcurrentToolCalls: 16,
  maxBridgeMessageBytes: 8 * 1024 * 1024,
  maxBridgeResultBytes: 16 * 1024 * 1024,
  maxOuterResultBytes: 64 * 1024,
  // console.* output shown in the outer result; the rest is cut with a note.
  maxConsoleBytes: 16 * 1024,
} as const;

/** Host-enumerated guest error code for a call refused by the per-program call budget. */
const PTC_TOOL_CALL_LIMIT_EXCEEDED = 'PTC_TOOL_CALL_LIMIT_EXCEEDED';

/**
 * Guest result for a call refused by the call budget. The call never reached a
 * tool, so it has no child record; `toolCallId` is the guest request id. The
 * refusal happens before the tool is looked up, so it cannot tell a native
 * tool from an MCP one and always carries the empty data of a call that did
 * not run.
 */
export function ptcToolCallLimitRefusal(requestId: string, maxToolCalls: number) {
  return {
    status: 'failed',
    isError: true,
    data: {},
    truncation: { truncated: 'unknown' },
    error: {
      code: PTC_TOOL_CALL_LIMIT_EXCEEDED,
      message: `PTC refused this call after reaching the ${maxToolCalls}-call limit; it was not executed.`,
      toolCallId: requestId,
    },
  } as const;
}

export interface PtcLimits {
  readonly maxCodeBytes: number;
  readonly maxHeapBytes: number;
  readonly maxComputeMs: number;
  readonly maxWallClockMs: number;
  readonly shutdownGraceMs: number;
  readonly maxToolCalls: number;
  readonly maxConcurrentToolCalls: number;
  readonly maxBridgeMessageBytes: number;
  readonly maxBridgeResultBytes: number;
  readonly maxOuterResultBytes: number;
  readonly maxConsoleBytes: number;
}

export type PtcToolExecutionMode = 'parallel' | 'sequential';

export interface PtcToolDescriptor {
  readonly name: string;
  readonly executionMode?: PtcToolExecutionMode;
}

export interface PtcToolCall {
  readonly requestId: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
}

/**
 * The pipeline owns the actual execution and projects only guest-safe data
 * here. Retained facts remain host-owned even when guest code drops a result.
 */
export interface PtcToolCallResult {
  readonly result?: unknown;
  readonly isError?: boolean;
  readonly error?: PtcFailure;
  readonly terminateAgent?: boolean;
  readonly stopPtcProgram?: boolean;
  /** Authoritative post-hook record; absent only in isolated executor tests. */
  readonly record?: PtcPersistedChildCall;
  readonly retainedFacts?: readonly PtcRetainedFact[];
  /** Host-delivered media; guest JS receives only corresponding refs. */
  readonly media?: readonly ToolResultContent[];
  readonly refs?: readonly { readonly uri: string; readonly mimeType?: string }[];
}

export interface PtcToolBridge {
  readonly toolNames: readonly string[];
  /** Allocates the host-visible child identity before the side effect begins. */
  describe?(input: {
    readonly requestId: string;
    readonly name: string;
    readonly args: Readonly<Record<string, unknown>>;
  }): PtcPersistedChildCall | undefined;
  invoke(call: PtcToolCall): Promise<PtcToolCallResult>;
  stop(reason: PtcStopReason): void | Promise<void>;
  drain(): Promise<void>;
}

export type PtcStopReason =
  | 'cancelled'
  | 'wall_clock_exceeded'
  | 'compute_budget_exceeded'
  | 'tool_call_limit_exceeded'
  | 'bridge_limit_exceeded'
  | 'tool_result_delivery_failed'
  | 'guest_finished_with_pending_calls'
  | 'worker_error';

type PtcFailureCode =
  | PtcStopReason
  | 'invalid_code'
  | 'invalid_tool_call'
  | 'invalid_tool_result'
  | 'guest_error'
  | 'worker_exit';

export interface PtcFailure {
  /** Pipeline error codes remain source-owned (for example PTC_PERMISSION_DENIED). */
  readonly code: PtcFailureCode | string;
  readonly message: string;
  readonly toolCallId?: string;
  readonly retryable?: boolean;
}

export interface PtcChildCallRecord {
  readonly requestId: string;
  readonly name: string;
  readonly state: 'accepted' | 'completed' | 'failed' | 'unknown';
  readonly retainedFacts: readonly unknown[];
}

export interface PtcMediaDelivery {
  readonly childToolCallId: string;
  readonly content: ToolResultContent;
  readonly refs: readonly { readonly uri: string; readonly mimeType?: string }[];
}

/** Durable outer-tool metadata. It deliberately excludes raw child output. */
type PtcPersistedChildCall = AgentCorePtcToolCallRecord;
export type PtcRetainedFact = AgentCorePtcRetainedFact;
export type PtcExecutionDetails = AgentCorePtcExecutionDetails;

export type PtcExecutionResult = (
  | {
      readonly status: 'completed';
      readonly value: unknown;
      /** Exact JSON text of the returned value; absent when the code returned nothing. */
      readonly valueJson?: string;
      readonly childCalls: readonly PtcChildCallRecord[];
      readonly details: PtcExecutionDetails;
      readonly media: readonly PtcMediaDelivery[];
      readonly incomplete: boolean;
      /** Undefined fields the return value lost to JSON.stringify rules. */
      readonly droppedUndefinedPaths?: readonly string[];
      readonly droppedUndefinedCount?: number;
    }
  | {
      readonly status: 'failed' | 'cancelled' | 'timed_out';
      readonly error: PtcFailure;
      readonly childCalls: readonly PtcChildCallRecord[];
      readonly details: PtcExecutionDetails;
      readonly media: readonly PtcMediaDelivery[];
      readonly incomplete: boolean;
    }
) & {
  /** Calls refused by the call budget without running; kept in memory only. */
  readonly refusedToolCalls?: number;
  /** console.* output, also after a failure; kept in memory only, never in details. */
  readonly console?: PtcConsoleOutput;
};

export interface PtcConsoleOutput {
  readonly text: string;
  readonly bytes: number;
  /** More was printed than `maxConsoleBytes`; the rest was dropped. */
  readonly truncated: boolean;
}

interface PtcGuestStartMessage {
  readonly type: 'start';
  readonly code: string;
  readonly toolNames: readonly string[];
  readonly limits: Pick<
    PtcLimits,
    'maxHeapBytes' | 'maxComputeMs' | 'maxToolCalls' | 'maxConsoleBytes'
  >;
}

export interface PtcGuestToolResultMessage {
  readonly type: 'tool_result';
  readonly requestId: string;
  readonly resultJson?: string;
  readonly error?: PtcFailure;
}

interface PtcGuestStopMessage {
  readonly type: 'stop';
  readonly reason: PtcStopReason;
}

export type PtcGuestInboundMessage =
  | PtcGuestStartMessage
  | PtcGuestToolResultMessage
  | PtcGuestStopMessage;

interface PtcGuestReadyMessage {
  readonly type: 'ready';
}

interface PtcGuestToolCallMessage {
  readonly type: 'tool_call';
  readonly requestId: string;
  readonly name: string;
  readonly argsJson: string;
}

/** Worker has accepted a reply, so its bytes no longer occupy the host bridge queue. */
interface PtcGuestToolConsumedMessage {
  readonly type: 'tool_consumed';
  readonly requestId: string;
}

/** A guest-side call budget refused one call before any host tool could run. */
interface PtcGuestLimitRejectedMessage {
  readonly type: 'limit_rejected';
  readonly budget: 'tool_calls';
}

interface PtcGuestActivityMessage {
  readonly type: 'activity';
  readonly active: boolean;
}

/** console.* text the Worker kept within the console budget, in call order. */
interface PtcGuestConsoleMessage {
  readonly type: 'console';
  readonly text: string;
  /** Set once, on the message that reached the budget. */
  readonly truncated?: boolean;
}

interface PtcGuestCompletedMessage {
  readonly type: 'completed';
  /** Absent when the code returned no value (`undefined`). */
  readonly valueJson?: string;
  readonly pendingRequestIds: readonly string[];
  readonly droppedUndefinedPaths?: readonly string[];
  readonly droppedUndefinedCount?: number;
}

interface PtcGuestFailedMessage {
  readonly type: 'failed';
  readonly error: PtcFailure;
  readonly pendingRequestIds: readonly string[];
}

export type PtcGuestOutboundMessage =
  | PtcGuestReadyMessage
  | PtcGuestActivityMessage
  | PtcGuestToolCallMessage
  | PtcGuestToolConsumedMessage
  | PtcGuestLimitRejectedMessage
  | PtcGuestConsoleMessage
  | PtcGuestCompletedMessage
  | PtcGuestFailedMessage;

export function mergedPtcLimits(overrides: Partial<PtcLimits> = {}): PtcLimits {
  return { ...PTC_LIMITS, ...overrides };
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function parsePtcToolArgs(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  if (!isPlainRecord(parsed) || !isJsonValue(parsed)) {
    throw new Error('Tool arguments must be a JSON object with safe property names.');
  }
  return parsed;
}

export function serializePtcValue(value: unknown, maximumBytes: number): string {
  if (!isPtcJsonValue(value))
    throw new PtcSerializationError('invalid_tool_result', 'Value is not JSON-serializable.');
  const json = JSON.stringify(value);
  if (json === undefined)
    throw new PtcSerializationError('invalid_tool_result', 'Value is not JSON-serializable.');
  if (utf8ByteLength(json) > maximumBytes) {
    throw new PtcSerializationError(
      'bridge_limit_exceeded',
      `Serialized value exceeds the ${maximumBytes}-byte PTC transport limit.`,
    );
  }
  return json;
}

export class PtcSerializationError extends Error {
  constructor(
    readonly code: 'invalid_tool_result' | 'bridge_limit_exceeded',
    message: string,
  ) {
    super(message);
    this.name = 'PtcSerializationError';
  }
}

/**
 * The bridge's JSON rule: finite numbers, plain objects without reserved keys
 * (`__proto__`, `constructor`, `prototype`) and at most 100 levels deep.
 * Callers use it to drop third-party payloads that the bridge would refuse.
 */
export function isPtcJsonValue(value: unknown): boolean {
  return isJsonValue(value);
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (depth > 100) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value))
    return Array.from(value).every((entry) => isJsonValue(entry, depth + 1));
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).every(
    ([key, entry]) =>
      key !== '__proto__' &&
      key !== 'constructor' &&
      key !== 'prototype' &&
      isJsonValue(entry, depth + 1),
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
