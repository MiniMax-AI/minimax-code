/**
 * matrix-tools 工具系列共享 helper。
 *
 * 单一职责:把 LLM 给的 input 直接 POST 到 archon-server 暴露的
 * `/matrix/api/v1/mcp/<endpoint>` REST 代理,把响应包成 `ToolResult`。
 * 身份(user_id / biz_id / request_sk)由 RemoteArchonServerAdapter 的
 * HTTP header 自带,api_key 不再进 body —— archon-server 端从 header
 * 取用户身份后自己派生 Mavis chat 上下文。
 *
 * 失败语义:
 *   - `base_resp.status_code != 0` → 固定业务失败(`ok:false`),保留数值
 *     `status_code`，不透传下游 `status_msg`。
 *   - 请求前缺凭据(`MatrixAuthRequiredError`) → `MATRIX_TOOL_AUTH_REQUIRED`,
 *     文案直接告诉模型/用户需要登录 MiniMax 或设置 MATRIX_TOKEN。
 *   - HTTP 层失败(非 2xx / 超时 / 网络 / JSON 解析失败) → 固定请求失败(`ok:false`),
 *     按固定枚举 `failure_cause` 说明原因，能识别时保留数值 `http_status`；
 *     文案只由本地枚举拼出，不把下游原文交给 tool/event/log 出口。
 *
 * 超时:每个工具从 `MATRIX_TOOL_TIMEOUTS` 表查自己的超时(生成类 10 min /
 * 其他 2 min),覆盖 `postJson` 默认的 15s —— 服务端生成动辄数分钟,
 * 15s gate 会把所有生成类工具一律打挂。caller 可以传 `timeoutMs` 覆盖,
 * 单测用得到。
 *
 * 文本摘要:服务端响应字段千差万别(text / list / 计数 + items),不再做
 * "挑一个字段当 ToolResult.text"的猜测,统一 `JSON.stringify(response, …, 2)`
 * 作为 text,details 里附原结构。LLM 自己抽自己需要的字段,人也能直观看 OSS
 * 持久化的 jsonl。如果某个 tool 的响应过大,后续 truncation wrapper
 * (`withToolResultTruncation`)会按 token budget 自动截断。
 */

import type { ToolResult } from '@mavis/agent-core/tools';

import {
  readMatrixAuthRequiredReason,
  readMatrixGatewayBackend,
  type MatrixAuthRequiredReason,
  type MatrixGatewayBackend,
  type MatrixExecutor as MatrixExecutorBase,
  type MatrixToolContext,
} from './types.js';
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
   * matrix-tools 工具调用 body —— 可以是 typebox 推导出的具体 `Static<...>`
   * 类型(Pattern A 的工具直接透传 input),也可以是 tool 内部 build 出来的
   * `Record<string, unknown>`(Pattern B/C/D)。这里用 `object` 让两类调用方
   * 都不用强转。callMatrixTool 内部 spread 进 body 不依赖具体形态。
   */
  readonly input: object;
  readonly ctx: MatrixToolContext;
  readonly archonServer: MatrixExecutorBase;
  readonly signal?: AbortSignal;
  /**
   * 覆盖 `MATRIX_TOOL_TIMEOUTS[toolName]` 默认值。生产代码不要传 —— 让 timeout
   * 表保持 single source of truth。预留给单测断言 timeout forwarding。
   */
  readonly timeoutMs?: number;
}

interface BaseResp {
  status_code?: number;
}

const MATRIX_TOOL_REQUEST_FAILED = 'MATRIX_TOOL_REQUEST_FAILED';
const MATRIX_TOOL_AUTH_REQUIRED = 'MATRIX_TOOL_AUTH_REQUIRED';
const MATRIX_TOOL_BUSINESS_FAILED = 'MATRIX_TOOL_BUSINESS_FAILED';
const MATRIX_TOOL_REQUEST_FAILED_TEXT = 'MATRIX_TOOL_REQUEST_FAILED: Matrix tool request failed.';
const MATRIX_TOOL_BUSINESS_FAILED_TEXT =
  'MATRIX_TOOL_BUSINESS_FAILED: Matrix tool request was rejected.';
const MATRIX_TOOL_AUTH_REQUIRED_TEXT: Record<MatrixAuthRequiredReason, string> = {
  managed_login:
    'MATRIX_TOOL_AUTH_REQUIRED: This tool needs a signed-in MiniMax account, and none is signed in. Ask the user to sign in to MiniMax (for example /login in the MiniMax Code CLI), then retry. Do NOT retry before the user signs in.',
  matrix_token:
    'MATRIX_TOOL_AUTH_REQUIRED: MATRIX_BASE_URL points to a custom Matrix backend, but MATRIX_TOKEN is not set. Ask the user to set MATRIX_TOKEN, then retry.',
};

/** Fixed, locally derived reason a request produced no Matrix response. */
type MatrixRequestFailureCause =
  | 'aborted'
  | 'auth_required'
  | 'http_error'
  | 'timeout'
  | 'network_error'
  | 'invalid_response'
  | 'unknown';

interface MatrixRequestFailure {
  readonly cause: MatrixRequestFailureCause;
  readonly httpStatus?: number;
  readonly backend?: MatrixGatewayBackend;
  readonly authReason?: MatrixAuthRequiredReason;
  readonly timeoutMs?: number;
}

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
    const failure = classifyRequestFailure(err, resolveTimeout(opts), signal?.aborted === true);
    logCallError(opts, startMs, failure);
    if (signal?.aborted) throw err;
    return matrixRequestFailure(toolName, path, failure);
  }

  const baseResp = isRecord(resp.base_resp) ? (resp.base_resp as BaseResp) : undefined;
  const statusCode = baseResp?.status_code ?? 0;
  logCallEnd(opts, startMs, resp, statusCode);
  if (statusCode !== 0) {
    return matrixBusinessFailure(toolName, path, { statusCode });
  }

  // base_resp 剥掉,信息已经被吸收到 ok:true,留着只是噪声。
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
 * Raw 版本 —— 给依赖文件 I/O 的工具用,因为它们要从原始 response 取
 * `output_url` / `success_items[].output_url` 等字段下载到 workspace,
 * `callMatrixTool` 的 JSON.stringify text 拿不回结构化数据。
 *
 * 失败语义沿用 `callMatrixTool` 的固定失败出口；Raw 仅表示成功响应需要
 * 保留结构化 payload 以取 `output_url` 等字段。mcp-server 的 payload 顶层
 * `code`/`message` 也会短路成固定 ToolResult，避免下游原文进入 tool/log 出口。
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
    const failure = classifyRequestFailure(err, resolveTimeout(opts), signal?.aborted === true);
    logCallError(opts, startMs, failure);
    if (signal?.aborted) throw err;
    return { ok: false, result: matrixRequestFailure(toolName, path, failure) };
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
// HTTP 调用日志 —— archon-server `/matrix/api/v1/mcp/*` 出口流量。统一 prefix
// `[matrix-tools]`,方便 grafana logQL `{app="cloud-runtime"} |~ "\\[matrix-tools\\]"`
// 一把抓。字段风格跟 `cloud-bash.ts` 对齐:`key=value`(value 含空格的就 JSON
// 序列化),不打 input/response 全文,只打 size + 关键 marker。
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
  failure: MatrixRequestFailure,
): void {
  const { toolName, path, ctx, signal } = opts;
  const durationMs = Date.now() - startMs;
  ctx.matrixLogger?.warn(
    ctx,
    `matrix-tools error tool=${toolName} path=${path} stage=request code=${requestFailureCode(failure)} cause=${failure.cause} http_status=${failure.httpStatus ?? 'none'} duration_ms=${durationMs} aborted=${signal?.aborted === true} session=${ctx.sessionId} turn=${ctx.turnId}`,
  );
}

function matrixRequestFailure(
  toolName: string,
  path: string,
  failure: MatrixRequestFailure,
): ToolResult {
  const text = requestFailureText(failure);
  return {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
    details: {
      ok: false,
      path,
      error_code: requestFailureCode(failure),
      failure_cause: failure.cause,
      ...(failure.authReason !== undefined ? { auth_reason: failure.authReason } : {}),
      ...(failure.httpStatus !== undefined ? { http_status: failure.httpStatus } : {}),
    },
  };
}

function requestFailureCode(failure: MatrixRequestFailure): string {
  return failure.cause === 'auth_required' ? MATRIX_TOOL_AUTH_REQUIRED : MATRIX_TOOL_REQUEST_FAILED;
}

/**
 * Built only from the local cause enum and numeric status, never from the error
 * message: a gateway error message can embed the downstream response body.
 */
function requestFailureText(failure: MatrixRequestFailure): string {
  switch (failure.cause) {
    case 'auth_required':
      return MATRIX_TOOL_AUTH_REQUIRED_TEXT[failure.authReason ?? 'managed_login'];
    case 'http_error':
      return `MATRIX_TOOL_REQUEST_FAILED: Matrix tool request failed (HTTP ${failure.httpStatus}).${httpFailureHint(failure)}`;
    case 'timeout':
      return failure.timeoutMs !== undefined
        ? `MATRIX_TOOL_REQUEST_FAILED: Matrix tool request timed out after ${Math.max(1, Math.round(failure.timeoutMs / 1000))}s.`
        : 'MATRIX_TOOL_REQUEST_FAILED: Matrix tool request timed out.';
    case 'network_error':
      return 'MATRIX_TOOL_REQUEST_FAILED: Matrix tool request failed: network error before any response.';
    case 'invalid_response':
      return 'MATRIX_TOOL_REQUEST_FAILED: Matrix tool request failed: the response was not valid JSON.';
    case 'aborted':
      return 'MATRIX_TOOL_REQUEST_FAILED: Matrix tool request was cancelled.';
    case 'unknown':
      return MATRIX_TOOL_REQUEST_FAILED_TEXT;
  }
}

/**
 * A 401 names the credential of the backend that rejected it; 403 can also mean
 * an entitlement, region or feature denial, so it does not blame the sign-in.
 */
function httpFailureHint(failure: MatrixRequestFailure): string {
  if (failure.httpStatus === 403) return ' Access was denied.';
  if (failure.httpStatus !== 401) return '';
  if (failure.backend === 'managed') {
    return ' The MiniMax sign-in was rejected and may have expired; ask the user to sign in again.';
  }
  if (failure.backend === 'custom') {
    return ' MATRIX_TOKEN was rejected by the custom Matrix backend; ask the user to check MATRIX_TOKEN.';
  }
  return ' The credentials were rejected.';
}

/**
 * Maps a request error to a fixed cause. Only an abort the caller did not ask
 * for is the request timeout; a caller abort is logged as such and rethrown.
 */
function classifyRequestFailure(
  error: unknown,
  timeoutMs: number | undefined,
  callerAborted: boolean,
): MatrixRequestFailure {
  if (callerAborted) return { cause: 'aborted' };
  const authReason = readMatrixAuthRequiredReason(error);
  if (authReason) return { cause: 'auth_required', authReason };
  const httpStatus = httpStatusFromError(error);
  if (httpStatus !== undefined) {
    const backend = readMatrixGatewayBackend(error);
    return { cause: 'http_error', httpStatus, ...(backend ? { backend } : {}) };
  }
  if (!(error instanceof Error)) return { cause: 'unknown' };
  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return { cause: 'timeout', ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
  }
  if (error instanceof SyntaxError) return { cause: 'invalid_response' };
  // undici reports connection, DNS and TLS failures as `TypeError: fetch failed`.
  if (error instanceof TypeError) return { cause: 'network_error' };
  return { cause: 'unknown' };
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
    // Circular ref / BigInt 等 stringify 抛错时不要把 caller 也带挂。
    return -1;
  }
}
