import type { AssistantMessage } from '@earendil-works/pi-ai';

/**
 * Stable identity of a failure the stream layer itself decided (a watchdog
 * timeout, an empty reply, a reply stuck in a loop), as opposed to one the
 * provider reported. It travels on the failed message as a pi diagnostic, so
 * a host lease reading `LLMCallFailure.final` can tell these apart without
 * parsing the error words, and without calling the extension's classifier
 * (which only knows provider errors and reads these as a bad request).
 *
 * Shape: `final.diagnostics[]` holds
 * `{ type: 'mavis.llm_stream_failure', error: { name: 'LLMStreamFailure', code: <kind> } }`.
 * The type string and the kind values are a contract: never rename them.
 */
export const LLM_STREAM_FAILURE_DIAGNOSTIC_TYPE = 'mavis.llm_stream_failure';

export const LLM_STREAM_FAILURE_KINDS = [
  /** No stream event within the first-event bound: the provider accepted but never answered. */
  'llm_first_event_timeout',
  /** The stream went silent between events for longer than the idle bound. */
  'llm_stream_idle_timeout',
  /** The reply ended `stop` with no text and no tool call (reasoning alone counts as nothing). */
  'llm_empty_response',
  /** The reply's reasoning or text was stuck repeating the same few lines. */
  'llm_reply_loop',
] as const;
export type LLMStreamFailureKind = (typeof LLM_STREAM_FAILURE_KINDS)[number];

type Diagnostic = NonNullable<AssistantMessage['diagnostics']>[number];

const KINDS = new Set<string>(LLM_STREAM_FAILURE_KINDS);

function isKind(value: unknown): value is LLMStreamFailureKind {
  return typeof value === 'string' && KINDS.has(value);
}

export function llmStreamFailureDiagnostic(
  kind: LLMStreamFailureKind,
  message: string,
  details?: Record<string, unknown>,
): Diagnostic {
  return {
    type: LLM_STREAM_FAILURE_DIAGNOSTIC_TYPE,
    timestamp: Date.now(),
    error: { name: 'LLMStreamFailure', message, code: kind },
    ...(details ? { details } : {}),
  };
}

/** A detached copy of `message` that failed with `kind`; the source message is never mutated. */
export function withLLMStreamFailure(
  message: AssistantMessage,
  kind: LLMStreamFailureKind,
  errorMessage: string,
  details?: Record<string, unknown>,
): AssistantMessage {
  return {
    ...message,
    content: [...message.content],
    stopReason: 'error',
    errorMessage,
    diagnostics: [
      ...(message.diagnostics ?? []),
      llmStreamFailureDiagnostic(kind, errorMessage, details),
    ],
  };
}

/**
 * The stream-layer failure kind of a failed call, or `undefined` for a
 * provider failure. Reads the newest marker on `final`, then a thrown
 * stream-layer error carrying the same `code`.
 */
export function readLLMStreamFailureKind(failure: {
  readonly final?: AssistantMessage;
  readonly thrown?: unknown;
}): LLMStreamFailureKind | undefined {
  try {
    const diagnostics = failure.final?.diagnostics;
    if (Array.isArray(diagnostics)) {
      for (let index = diagnostics.length - 1; index >= 0; index -= 1) {
        const diagnostic = diagnostics[index];
        if (diagnostic?.type !== LLM_STREAM_FAILURE_DIAGNOSTIC_TYPE) continue;
        const code = diagnostic.error?.code;
        if (isKind(code)) return code;
      }
    }
    const thrown = failure.thrown as { llmStreamFailure?: unknown; code?: unknown } | undefined;
    if (thrown && typeof thrown === 'object' && thrown.llmStreamFailure === true) {
      return isKind(thrown.code) ? thrown.code : undefined;
    }
  } catch {
    // Untrusted shapes never make a provider failure look like a stream-layer one.
  }
  return undefined;
}
