import type { ToolResult } from '@mavis/agent-core/tools';

/**
 * One result shape for every namespaced desktop tool.
 *
 * Three properties make a result readable from a PTC program, and a tool that
 * skips any of them forces the program to parse `r.output`:
 *
 * 1. the payload is in both `text` and `programmatic.data`;
 * 2. `programmatic.completeness` states whether the output is whole, so
 *    `r.status` is `complete` instead of `unverified`;
 * 3. the tool name is registered in `VERIFIED_TOOL_MARKERS`
 *    (`desktop/ptc-result-projection.ts`), which is what makes (2) count.
 *
 * A paged list reports `has_more` / `next_cursor` in `data` and mirrors it as
 * `completeness.hasMore`.
 */

/** Stable error codes; the metrics layer counts these and nothing else. */
export const DESKTOP_TOOL_ERROR_CODES = [
  'SKILL_REQUIRED',
  'UI_UNAVAILABLE',
  'UI_REQUEST_FAILED',
  'SESSION_NOT_ACTIVE',
  'CONTENT_BLOCKED',
  'CONTENT_REVIEW_UNAVAILABLE',
  'NOT_FOUND',
  'INVALID_ARGUMENT',
  'CONFLICT',
  'INTERNAL',
  // session_create's own codes, so a refused argument is not counted as INTERNAL.
  'SESSION_CREATE_NO_CALLER',
  'SESSION_CREATE_INVALID_CONTENT',
  'SESSION_CREATE_INVALID_LOCATION',
  'SESSION_CREATE_INVALID_ARGUMENT',
  'SESSION_CREATE_INVALID_WORKSPACE',
  'SESSION_CREATE_UNKNOWN_PROJECT',
  'SESSION_CREATE_UNKNOWN_AGENT',
  'SESSION_CREATE_MODEL_UNRESOLVED',
  'SESSION_CREATE_ADMISSION_FAILED',
  'SESSION_CREATE_UNEXPECTED_ERROR',
] as const;

export type DesktopToolErrorCode = (typeof DESKTOP_TOOL_ERROR_CODES)[number];

export interface DesktopToolOkOptions {
  /**
   * The source has more beyond this page although nothing was cut. Paged tools
   * set it together with `has_more` / `next_cursor` in `data`.
   */
  readonly hasMore?: boolean;
}

/** A successful call: `{ ok: true, ...data }` as text, and the same object as PTC data. */
export function desktopToolOk(
  name: string,
  data: Readonly<Record<string, unknown>>,
  options: DesktopToolOkOptions = {},
): ToolResult {
  const payload = { ok: true, ...data };
  const text = JSON.stringify(payload);
  const hasMore = options.hasMore === true;
  return {
    tool_name: name,
    text,
    content: [{ type: 'text', text }],
    details: { ok: true, ...(hasMore ? { hasMore: true } : {}) },
    programmatic: {
      data: payload,
      completeness: { truncated: false, ...(hasMore ? { hasMore: true } : {}) },
    },
  };
}

/**
 * A failed call. `code` is one of `DESKTOP_TOOL_ERROR_CODES` so the metric label
 * stays bounded; a failure carries no completeness statement because a PTC
 * child that failed is `failed`, not `truncated`.
 */
export function desktopToolFailure(
  name: string,
  code: DesktopToolErrorCode,
  message: string,
): ToolResult {
  const text = JSON.stringify({ ok: false, command: name, error: { code, message } });
  return {
    tool_name: name,
    text,
    content: [{ type: 'text', text }],
    isError: true,
    details: { ok: false, errorCode: code },
  };
}

/** Maps a thrown value to a bounded error code; never leaks the raw message as a code. */
export function desktopToolErrorCode(error: unknown): DesktopToolErrorCode {
  const code = error instanceof Error && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && isDesktopToolErrorCode(code) ? code : 'INTERNAL';
}

export function isDesktopToolErrorCode(value: string): value is DesktopToolErrorCode {
  return (DESKTOP_TOOL_ERROR_CODES as readonly string[]).includes(value);
}

/** The failure message a thrown value becomes; the caller keeps it user-readable. */
export function desktopToolErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
