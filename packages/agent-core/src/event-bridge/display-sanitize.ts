/**
 * Display-layer sanitisation for tool-call results.
 *
 * # Why this exists
 *
 * The pi `read` tool returns image and video payloads as
 * `{ type: 'image', data: <base64>, mimeType: 'image/*' | 'video/*' }`
 * content blocks. pi-ai needs those blocks intact in the assistant turn's
 * `messages` array so the model can actually see the image / video.
 *
 * Before this helper existed, the wire-level
 * `RuntimeEvent.stream.resp → AgentMessageChunk.tool_calls[*].tool_call_result_data`
 * field JSON-serialised the entire result envelope, which dragged the full
 * base64 payload into:
 *
 *   1. The local SQLite `local_runtime_message_rows.data_json` row
 *   2. The `display.jsonl` session transcript
 *   3. The `stream.resp` SSE payload streamed to the UI
 *   4. The cloud runtime → archon-server exchange
 *
 * A single read-image call (3-4 MB base64) would inflate each row by that
 * much; an 80-message page would balloon to >100 MB and freeze the
 * Electron UI. The bug was introduced together with `EventBridge` in
 * `a30533d9f` (2026-05-21) and remained latent until production users
 * hit the symptom.
 *
 * # What this module guarantees
 *
 *   - `tc.result` is **never** mutated. pi keeps a reference to the same
 *     object inside the assistant-turn `messages` array, which feeds the
 *     next LLM request. We must deep-clone before stripping so the model
 *     still sees the original binary.
 *   - Image / video / audio content blocks have their `data` field removed
 *     from the display copy. The block itself is dropped (not replaced by a
 *     placeholder string) because the UI does not consume the wire payload
 *     for read-image calls — see
 *     `packages/ui/src/components/message/tool-renderers/ToolCallRow.tsx`
 *     `isImageReadToolCall` short-circuit (success path returns no detail
 *     panel). Dropping the block keeps the wire JSON compact and avoids
 *     ever shipping base64 to the renderer.
 *   - All other content blocks (`type === 'text'`, `toolCall`,
 *     non-multimodal metadata blocks) pass through untouched.
 *   - `details` is preserved as-is so future UI affordances can still read
 *     `details.media.kind` / `size_bytes` if they want to surface "Read
 *     video (12 MB)" without re-fetching the binary.
 *
 * # Where the function is wired in
 *
 *   - `packages/agent-core/src/event-bridge/converters.ts::toolCallFromRuntime`
 *     — single chokepoint for the SSE / SQLite / display.jsonl / cloud
 *     uplink channels.
 *   - `packages/local-runtime/src/legacy-opencode/legacy-opencode-migrator.ts`
 *     — companion `sanitizeWireToolCallResultData` for already-stringified
 *     legacy payloads that bypass the converter.
 */

import type { RuntimeToolCall } from '../protocol/runtime-event.js';

/** Threshold above which a string is treated as an inline binary payload. */
export const INLINE_BINARY_INLINE_THRESHOLD = 1024;

/**
 * Pi / pi-ai content block shape used inside a tool result's `content`
 * array. We deliberately duck-type rather than import `@earendil-works/pi-ai`
 * so agent-core stays runtime-agnostic (same pattern as `extractAssistantText`).
 */
interface DisplayContentBlock {
  readonly type?: unknown;
  readonly text?: unknown;
  readonly data?: unknown;
  readonly mimeType?: unknown;
  readonly [key: string]: unknown;
}

interface DisplayToolResultShape {
  readonly content?: unknown;
  readonly details?: unknown;
  readonly text?: unknown;
  readonly [key: string]: unknown;
}

/**
 * Decide whether a content block carries an inline binary payload that
 * must NOT be serialised into the display wire envelope.
 *
 * Matches:
 *   - `{ type: 'image' | 'video' | 'audio', data: <base64>, mimeType: '...' }`
 *   - `{ type: 'file', data: <base64> }`
 *   - Any block whose `data` field is a large base64-shaped string, even if
 *     the `type` discriminator is missing — this catches future block kinds
 *     that we have not enumerated explicitly.
 */
export function isInlineBinaryContentBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  const b = block as DisplayContentBlock;
  const type = typeof b.type === 'string' ? b.type : '';
  const data = b.data;
  if (typeof data !== 'string') return false;

  if (type === 'image' || type === 'video' || type === 'audio' || type === 'file') {
    return true;
  }

  // Heuristic fallback: large base64-looking strings without a recognised
  // type. Uses length + charset to avoid misclassifying normal prose.
  if (data.length >= INLINE_BINARY_INLINE_THRESHOLD && isLikelyBase64(data)) {
    return true;
  }
  return false;
}

const BASE64_CHARS_RE = /^[A-Za-z0-9+/_=\s-]+$/;

/**
 * Conservative base64 detector. Allows URL-safe alphabet and whitespace so
 * the heuristic also catches line-wrapped base64 the way pi sometimes emits.
 */
export function isLikelyBase64(input: string): boolean {
  if (!input.length) return false;
  // Sample the first 256 chars to avoid scanning multi-megabyte strings.
  const sample = input.length > 256 ? input.slice(0, 256) : input;
  return BASE64_CHARS_RE.test(sample);
}

/**
 * Return a deep-cloned `content` array with inline-binary blocks stripped.
 *
 * The clone uses `structuredClone` when available (Node 17+) and falls back
 * to a JSON round-trip otherwise. The fallback is safe because every
 * surviving block is plain JSON-serialisable data (text strings, mimeType,
 * small metadata).
 */
export function stripInlineBinaryFromContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  const filtered = content.filter((block) => !isInlineBinaryContentBlock(block));
  if (filtered.length === content.length) return content;
  return cloneStructured(filtered);
}

/**
 * Deep-clone a JSON-safe value. We need a clone (not in-place strip)
 * because `tc.result` is the same object pi retains in its in-memory
 * `messages` array.
 */
function cloneStructured<T>(value: T): T {
  const structuredCloneFn = (globalThis as { structuredClone?: (v: unknown) => unknown })
    .structuredClone;
  if (typeof structuredCloneFn === 'function') {
    return structuredCloneFn(value) as T;
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * Produce a display-safe copy of a tool-call result envelope.
 *
 * Behaviour:
 *   - `content[]` — inline-binary blocks removed (the rest pass through).
 *   - everything else (`details`, `text`, `isError`, …) — preserved as-is
 *     because none of it can ship megabytes.
 *
 * The input is never mutated.
 */
export function sanitizeToolResultForDisplay(raw: unknown): unknown {
  if (raw === undefined || raw === null) return raw;
  if (typeof raw !== 'object') return raw;
  const shape = raw as DisplayToolResultShape;
  const stripped = stripInlineBinaryFromContent(shape.content);
  if (stripped === shape.content) return raw;
  return { ...(raw as Record<string, unknown>), content: stripped };
}

/**
 * Wrap a `RuntimeToolCall` for serialisation into the wire-level
 * `ToolCall` shape. Always returns a deep clone — pi retains the
 * original `tc.result` reference inside the assistant turn's `messages`
 * array, and a future maintainer must not be able to mutate that state
 * by editing the display copy. The clone additionally strips inline
 * binary blocks from the display-side `result.content`.
 */
export function sanitizeToolCallForDisplay(tc: RuntimeToolCall): RuntimeToolCall {
  if (tc.result === undefined) {
    // No result to strip, but still clone so the caller can mutate the
    // returned envelope without leaking back into pi's state.
    return cloneStructured(tc);
  }
  const sanitisedResult = sanitizeToolResultForDisplay(tc.result);
  return cloneStructured({
    ...tc,
    result: sanitisedResult,
  });
}

/**
 * Companion helper for legacy payloads that have already been
 * JSON-stringified (the `tool_call_result_data` wire field). Parses,
 * strips inline binary, re-serialises. Falls back to a length-capped
 * placeholder when the payload is not valid JSON or carries raw binary
 * outside the structured shape.
 */
export function sanitizeWireToolCallResultData(raw: string): string {
  if (typeof raw !== 'string') return raw;
  if (raw.length === 0) return raw;
  // Quick reject: if the payload is not even wrapped as a JSON object, we
  // cannot safely strip structured fields. Cap it instead so an opaque
  // 4MB string cannot sneak through.
  const firstNonWs = raw.trimStart()[0];
  if (firstNonWs !== '{' && firstNonWs !== '[') {
    return raw.length > INLINE_BINARY_INLINE_THRESHOLD
      ? `<omitted:non-json ${raw.length} bytes>`
      : raw;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.length > INLINE_BINARY_INLINE_THRESHOLD
      ? `<omitted:invalid-json ${raw.length} bytes>`
      : raw;
  }
  const cleaned = sanitizeToolResultForDisplay(parsed);
  if (cleaned === parsed) return raw;
  return JSON.stringify(cleaned);
}
