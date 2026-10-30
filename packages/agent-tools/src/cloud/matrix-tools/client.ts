/**
 * Shared helper for the matrix-tools family.
 *
 * Sole responsibility: POST LLM input directly to archon-server's `/matrix/api/v1/mcp/<endpoint>`
 * REST proxy and wrap the response as `ToolResult`. RemoteArchonServerAdapter supplies identity
 * (user_id / biz_id / request_sk) in HTTP headers; api_key no longer enters the body. archon-server
 * derives Mavis chat context from the header identity.
 *
 * Failure semantics:
 * - `base_resp.status_code != 0`: Fixed business failure (`ok:false`), retaining numeric
 *   `status_code` without forwarding downstream `status_msg`.
 * - HTTP failure (non-2xx / network / JSON parsing): Fixed request failure (`ok:false`), retaining
 *   numeric `http_status` when identifiable, without exposing downstream raw text through
 *   tools/events/logs.
 *
 * Timeout: Each tool uses `MATRIX_TOOL_TIMEOUTS` (10 minutes for generation / 2 minutes otherwise),
 * overriding postJson's 15-second default. Server-side generation can take minutes; a 15-second
 * gate would fail all generation tools. Callers may override `timeoutMs` for tests.
 *
 * Text summary: Response fields vary (text / list / counts + items), so use
 * `JSON.stringify(response, …, 2)` as text rather than guessing one field; retain the original
 * structure in details. The LLM selects needed fields, and humans can inspect persisted OSS jsonl.
 * Oversized responses are later truncated to the token budget by `withToolResultTruncation`.
 */

import type { ToolResult } from '@mavis/agent-core/tools';

import type { MatrixExecutor as MatrixExecutorBase, MatrixToolContext } from './types.js';
import { MATRIX_TOOL_TIMEOUTS } from './tool-defs.js';

/**
 * Shared executor type for Matrix tools. It only requires `postJson`, so
 * tests can pass a vi.fn-backed object instead of a full host adapter.
 */
export type { MatrixExecutor } from './types.js';

export interface CallMatrixToolOptions {
  readonly toolName: string;
  readonly path: string;
  /**
   * matrix-tools request body: either a concrete typebox-inferred `Static<...>` (Pattern A tools
   * forward input directly) or an internally built `Record<string, unknown>` (Patterns B/C/D).
   * `object` supports both without casts; callMatrixTool spreads the body without depending on its
   * shape.
   */
  readonly input: object;
  readonly ctx: MatrixToolContext;
  readonly archonServer: MatrixExecutorBase;
  readonly signal?: AbortSignal;
  /**
   * Overrides `MATRIX_TOOL_TIMEOUTS[toolName]`. Do not pass in production; keep the timeout table
   * as the single source of truth. Reserved for unit tests asserting timeout forwarding.
   */
  readonly timeoutMs?: number;
}

interface BaseResp {
  status_code?: number;
}

const MATRIX_TOOL_REQUEST_FAILED = 'MATRIX_TOOL_REQUEST_FAILED';
const MATRIX_TOOL_BUSINESS_FAILED = 'MATRIX_TOOL_BUSINESS_FAILED';
const MATRIX_TOOL_REQUEST_FAILED_TEXT = 'MATRIX_TOOL_REQUEST_FAILED: Matrix tool request failed.';
const MATRIX_TOOL_BUSINESS_FAILED_TEXT =
  'MATRIX_TOOL_BUSINESS_FAILED: Matrix tool request was rejected.';

export async function callMatrixTool(opts: CallMatrixToolOptions): Promise<ToolResult> {
  const { toolName, path, input, archonServer, signal } = opts;

  if (signal?.aborted) throw new Error('Operation aborted');

  const startMs = Date.now();
  logCallStart(opts);
  let resp: Record<string, unknown>;
  try {
    resp = await archonServer.postJson(path, input as Record<string, unknown>, signal, {
      timeoutMs: resolveTimeout(opts),
    });
  } catch (err) {
    const httpStatus = httpStatusFromError(err);
    logCallError(opts, startMs, httpStatus);
    if (signal?.aborted) throw err;
    return matrixRequestFailure(toolName, path, httpStatus);
  }

  const baseResp = isRecord(resp.base_resp) ? (resp.base_resp as BaseResp) : undefined;
  const statusCode = baseResp?.status_code ?? 0;
  logCallEnd(opts, startMs, resp, statusCode);
  if (statusCode !== 0) {
    return matrixBusinessFailure(toolName, path, { statusCode });
  }

  // Remove base_resp: its information is already captured by ok:true, so retaining it adds noise.
  const payload = { ...resp };
  delete payload.base_resp;
  const text = JSON.stringify(payload, null, 2);
  return {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
    details: { ok: true, path },
    // The object the text serializes, for PTC programs; model calls drop it.
    programmatic: { data: payload },
  };
}

/**
 * Raw variant for file-I/O tools that need structured response fields such as `output_url` /
 * `success_items[].output_url` to download into the workspace; callMatrixTool's JSON.stringify text
 * does not expose structured data directly.
 *
 * Uses callMatrixTool's fixed failure results. Raw only means retaining a structured success
 * payload to access fields such as output_url. Top-level mcp-server payload `code`/`message` also
 * short-circuits to a fixed ToolResult, preventing downstream raw text from reaching tool/log
 * output.
 */
export type CallMatrixToolRawResult =
  | { readonly ok: true; readonly response: Record<string, unknown> }
  | { readonly ok: false; readonly result: ToolResult };

export async function callMatrixToolRaw(
  opts: CallMatrixToolOptions,
): Promise<CallMatrixToolRawResult> {
  const { toolName, path, input, archonServer, signal } = opts;

  if (signal?.aborted) throw new Error('Operation aborted');

  const startMs = Date.now();
  logCallStart(opts);
  let resp: Record<string, unknown>;
  try {
    resp = await archonServer.postJson(path, input as Record<string, unknown>, signal, {
      timeoutMs: resolveTimeout(opts),
    });
  } catch (err) {
    const httpStatus = httpStatusFromError(err);
    logCallError(opts, startMs, httpStatus);
    if (signal?.aborted) throw err;
    return { ok: false, result: matrixRequestFailure(toolName, path, httpStatus) };
  }

  const baseResp = isRecord(resp.base_resp) ? (resp.base_resp as BaseResp) : undefined;
  const statusCode = baseResp?.status_code ?? 0;
  logCallEnd(opts, startMs, resp, statusCode);
  if (statusCode !== 0) {
    return { ok: false, result: matrixBusinessFailure(toolName, path, { statusCode }) };
  }

  const payload = { ...resp };
  delete payload.base_resp;

  const bizCode =
    typeof payload.code === 'number' && Number.isInteger(payload.code) ? payload.code : 0;
  if (bizCode !== 0) {
    opts.ctx.matrixLogger?.warn(
      opts.ctx,
      `matrix-tools biz_error tool=${toolName} path=${path} code=${MATRIX_TOOL_BUSINESS_FAILED} payload_code=${bizCode} session=${opts.ctx.sessionId} turn=${opts.ctx.turnId}`,
    );
    return { ok: false, result: matrixBusinessFailure(toolName, path, { payloadCode: bizCode }) };
  }

  return { ok: true, response: payload };
}

function resolveTimeout(opts: CallMatrixToolOptions): number | undefined {
  if (typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
    return opts.timeoutMs;
  }
  return (MATRIX_TOOL_TIMEOUTS as Record<string, number>)[opts.toolName];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP call logs for archon-server `/matrix/api/v1/mcp/*` outbound traffic. Use the common prefix
// `[matrix-tools]` for a single Grafana LogQL query: `{app="cloud-runtime"} |~ "\\[matrix-tools\\]"`.
// Match `cloud-bash.ts` field formatting: `key=value` (JSON-serialize values containing spaces).
// Log only sizes and key markers, never full input/response bodies.
// ─────────────────────────────────────────────────────────────────────────────

function logCallStart(opts: CallMatrixToolOptions): void {
  const { toolName, path, ctx } = opts;
  const bodyBytes = approxJsonByteSize(opts.input);
  const timeoutMs = resolveTimeout(opts);
  ctx.matrixLogger?.info(
    ctx,
    `matrix-tools request tool=${toolName} path=${path} body_bytes=${bodyBytes} timeout_ms=${
      timeoutMs ?? 'default'
    } session=${ctx.sessionId} turn=${ctx.turnId}`,
  );
}

function logCallEnd(
  opts: CallMatrixToolOptions,
  startMs: number,
  resp: Record<string, unknown>,
  statusCode: number,
): void {
  const { toolName, path, ctx } = opts;
  const durationMs = Date.now() - startMs;
  const respBytes = approxJsonByteSize(resp);
  const ok = statusCode === 0;
  ctx.matrixLogger?.info(
    ctx,
    `matrix-tools response tool=${toolName} path=${path} ok=${ok} status_code=${statusCode} duration_ms=${durationMs} resp_bytes=${respBytes} session=${ctx.sessionId} turn=${ctx.turnId}`,
  );
}

function logCallError(
  opts: CallMatrixToolOptions,
  startMs: number,
  httpStatus: number | undefined,
): void {
  const { toolName, path, ctx, signal } = opts;
  const durationMs = Date.now() - startMs;
  ctx.matrixLogger?.warn(
    ctx,
    `matrix-tools error tool=${toolName} path=${path} stage=request code=${MATRIX_TOOL_REQUEST_FAILED} http_status=${httpStatus ?? 'none'} duration_ms=${durationMs} aborted=${signal?.aborted === true} session=${ctx.sessionId} turn=${ctx.turnId}`,
  );
}

function matrixRequestFailure(
  toolName: string,
  path: string,
  httpStatus: number | undefined,
): ToolResult {
  return {
    tool_name: toolName,
    text: MATRIX_TOOL_REQUEST_FAILED_TEXT,
    content: [{ type: 'text', text: MATRIX_TOOL_REQUEST_FAILED_TEXT }],
    details: {
      ok: false,
      path,
      error_code: MATRIX_TOOL_REQUEST_FAILED,
      ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
    },
  };
}

function matrixBusinessFailure(
  toolName: string,
  path: string,
  input: { readonly statusCode?: number; readonly payloadCode?: number },
): ToolResult {
  const text =
    input.payloadCode === 402
      ? 'Insufficient credits (code 402): account credits are insufficient. Please top up credits first. Do NOT retry the same request until credits are available.'
      : MATRIX_TOOL_BUSINESS_FAILED_TEXT;
  return {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
    details: {
      ok: false,
      path,
      error_code: MATRIX_TOOL_BUSINESS_FAILED,
      ...(input.statusCode !== undefined ? { status_code: input.statusCode } : {}),
      ...(input.payloadCode !== undefined ? { code: input.payloadCode } : {}),
    },
  };
}

function httpStatusFromError(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = /\bHTTP\s+(\d{3})\b/i.exec(error.message);
  return match ? Number(match[1]) : undefined;
}

function approxJsonByteSize(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    // Do not crash the caller if stringify fails on circular references, BigInt, etc.
    return -1;
  }
}
