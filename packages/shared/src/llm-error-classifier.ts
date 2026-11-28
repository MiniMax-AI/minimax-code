/**
 * Shared LLM error classifier — single source of truth for both daemon
 * (`runtime=llm-client`, `runtime=Vercel` finishStep) and the legacy local runtime
 * plugin (`finish-step` / `error` events).
 *
 * Why shared instead of two parallel copies:
 *   • The metric label `error_reason` on `llm_call_total` and
 *     `tool_call_total` consumes a fixed bounded enum. If daemon and
 *     plugin classify the same error differently, we get two different
 *     time series for the same incident — Grafana dashboards break.
 *   • The plugin only sees the post-SDK normalised shape (a plain
 *     `{ statusCode, errorMessage, finishReason }` triple) while the daemon
 *     sees the raw thrown value (often `APICallError` or a `DOMException`).
 *     Both inputs collapse into the same enum here.
 *
 * Adding a new bucket: append to `LLM_ERROR_REASONS`, update the matching
 * branch in `classifyLLMError`, and bump the
 * `metrics-runtime.test.ts > schema enum sync` snapshot if needed.
 *
 * Local resource exhaustion (`local-resource-errors.ts`) is not a reason:
 * retry decisions, protocol codes and retry events never carry it. Only the
 * failure metrics read it, through {@link toLLMFailureErrorKind}.
 */

import { byokProviderErrorDetail } from './byok-error-attribution.js';
import {
  classifyLocalResourceError,
  type LocalResourceErrorKind,
} from './local-resource-errors.js';
import { USER_SEND_RESTRICTED_ERROR_CODE } from './platform-error-codes.js';

export const LLM_ERROR_REASONS = [
  'abort',
  'timeout',
  'rate_limited',
  'tpm_rate_limited',
  'usage_limit',
  'credits_exhausted',
  'auth',
  'bad_request',
  'not_found',
  'content_filter',
  'server_error',
  'overloaded',
  'network',
  'empty_response',
  /** The reply was cut because it kept repeating itself (agent-core's loop guard). */
  'reply_loop',
  'unknown',
  'length',
] as const;
export type LLMErrorReason = (typeof LLM_ERROR_REASONS)[number];
export type LLMMetricErrorKind = LLMErrorReason;

export const LLM_RETRY_REASONS = [
  'timeout',
  'network',
  'rate_limited',
  'tpm_rate_limited',
  'overloaded',
] as const;
export type LLMRetryReason = (typeof LLM_RETRY_REASONS)[number];

/** A retry caused by the connection itself (no answer or a broken transport), not by the provider's verdict. */
export function isLLMTransportRetryReason(reason: LLMRetryReason | LLMMetricErrorKind): boolean {
  return reason === 'network' || reason === 'timeout';
}

export type LLMRetryDecision =
  | { retryable: true; reason: LLMRetryReason }
  | { retryable: false; reason: LLMMetricErrorKind };

export type LLMErrorSignal =
  | 'usage_limit'
  | 'credits_exhausted'
  | 'tpm_rate_limit'
  | 'content_filter'
  | 'refusal'
  | 'network'
  | 'empty_response'
  | 'length'
  | 'image_limit'
  | 'invalid_request'
  | 'invalid_argument'
  | 'request_too_large'
  | 'context_overflow'
  | 'incomplete_stream'
  | 'stream_interval_timeout'
  | 'stream_socket_closed';

/**
 * Model-side safety classifier decline. Providers surface it in their own wording; the remaining
 * text is provider-controlled and must not feed status/network heuristics.
 *
 * - Anthropic Messages ends the stream with `stop_reason: "refusal"`.
 * - OpenAI Chat Completions declines the prompt in its safety layer before the model runs. It
 *   reports `invalid_prompt` as the error code, and gateways that flatten the body into prose keep
 *   the usage-policy sentence. Resending the identical prompt is rejected again, so this must not
 *   be retried either.
 * - Reseller proxies in front of a Messages-API provider decline on their own usage-policy check
 *   and report `content_policy_rejected`, wrapping it in prose such as `<model> refused this
 *   request (safety filter: …)` or `blocked by <vendor>'s usage policy check`. The decline depends
 *   on the prompt alone, so switching models does not get past it and retrying is pointless. Prose
 *   that only says a request was refused stays unclassified; a policy marker has to accompany it.
 */
const PROVIDER_REFUSAL_MESSAGE_RES = [
  /\bstop_reason:\s*refusal\b/i,
  /\bflagged as potentially violating our usage policy\b/i,
  /["'](?:code|type)["']\s*:\s*["'](?:invalid_prompt|content_policy_violation)["']/i,
  /^(?:(?:\[Error\]|Error:)\s*)?(?:[45]\d\d[: ]\s*)?(?:invalid_prompt|content_policy_violation)(?:\s*:|\s*$)/i,
  /\bcontent_policy_rejected\b/i,
  /\brefused this request\b[\s\S]{0,200}?\b(?:safety|policy|moderation|content[_ ]?filter)\b/i,
  /\bblocked by\b[\s\S]{0,80}?\busage policy\b/i,
] as const;

/** True when an LLM error message reports a provider safety refusal; it must not be retried. */
export function isLLMProviderRefusalMessage(message: string | undefined): boolean {
  if (typeof message !== 'string') return false;
  // BYOK attribution names a user-chosen provider id, which is not an error signal.
  const detail = byokProviderErrorDetail(message);
  return (
    detail !== undefined && PROVIDER_REFUSAL_MESSAGE_RES.some((pattern) => pattern.test(detail))
  );
}

/**
 * pi-ai's Messages stream completeness guard for a provider stream that ended
 * without a non-empty `stop_reason`: the upstream truncated the answer. Only this
 * wording matches, whatever provider prefix precedes it; the `without
 * message_start` / `before message_stop` guards keep their own classification.
 * The diagnostics after it are event counts and timings, so they must never feed
 * the numeric status/code heuristics.
 */
const MISSING_STOP_REASON_MESSAGE_RE = /\bstream ended without stop_reason\b/;

function isLLMIncompleteStreamMessage(message: string | undefined): boolean {
  return typeof message === 'string' && MISSING_STOP_REASON_MESSAGE_RE.test(message);
}

export interface LLMErrorFacts {
  explicitAbort: boolean;
  timeout: boolean;
  /** Local resource the failed call ran out of, from the system error code. */
  localResource?: LocalResourceErrorKind;
  httpStatus?: number;
  upstreamStatusCode?: number;
  providerMessageCode?: number;
  existingProtocolCode?: number;
  signals: ReadonlySet<LLMErrorSignal>;
}

export interface LLMErrorInput {
  raw?: unknown;
  /**
   * The error a provider reported through `onProviderError` when it encoded
   * the failure into the final message. Read only when `raw` is absent, and
   * only for its system error code, so no other classification changes.
   */
  providerError?: unknown;
  finishReason?: string;
  errorMessage?: string;
  statusCode?: number;
  explicitAbort?: boolean;
}

export interface NormalizedLLMError {
  facts: LLMErrorFacts;
  sanitizedMessage?: string;
}

export interface LLMProtocolClassification {
  code: number;
  message?: string;
}

const EMPTY_FACTS = (): LLMErrorFacts => ({
  explicitAbort: false,
  timeout: false,
  signals: new Set<LLMErrorSignal>(),
});
const SAFE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'UND_ERR_SOCKET',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ESOCKETTIMEDOUT',
  'ECONNABORTED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_NETWORK_IO_SUSPENDED',
  'ERR_NETWORK_CHANGED',
  'ERR_NAME_NOT_RESOLVED',
  'ERR_INTERNET_DISCONNECTED',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_PROXY_CONNECTION_FAILED',
  'ERR_HTTP2_PROTOCOL_ERROR',
  // Retry this record-integrity failure, not arbitrary TLS/certificate errors.
  'ERR_SSL_BAD_RECORD_MAC_ALERT',
  'ERR_TIMED_OUT',
  'ERR_CONNECTION_TIMED_OUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);
const CONNECTION_ERROR_MESSAGE_RE = /Connection error\.?/i;
const ABORT_MESSAGE_RE = /\babort(?:ed|ing)?\b/i;
const TRANSIENT_TIMEOUT_MESSAGE_RE =
  /\b(?:timed?\s*out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)\b/i;
const TRANSIENT_NETWORK_MESSAGE_RE =
  /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed|network)\b/i;
const SAFE_TRANSPORT_NETWORK_MESSAGE_RE = /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|fetch failed)\b/i;
const CHROMIUM_NETWORK_MESSAGE_RE =
  /\bnet::ERR_(?:CONNECTION_(?:RESET|CLOSED|REFUSED)|NETWORK_IO_SUSPENDED|NETWORK_CHANGED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED|HTTP2_PROTOCOL_ERROR|SSL_BAD_RECORD_MAC_ALERT)\b/i;
const CHROMIUM_TIMEOUT_MESSAGE_RE = /\bnet::ERR_(?:TIMED_OUT|CONNECTION_TIMED_OUT)\b/i;
// Stable transport codes and premature-EOF diagnostics emitted by our Pi
// providers. The provider-name prefix varies, so only the fixed EOF phrase is
// matched. Do not treat bare "terminated" or arbitrary "closed" as network
// failures: those can also describe cancellation or application errors. The
// Messages `without message_start` / `before message_stop` guards keep their
// own (unclassified) handling, like `without stop_reason` above.
const STREAM_DISCONNECT_MESSAGE_RE =
  /\b(?:UND_ERR_SOCKET|ERR_STREAM_PREMATURE_CLOSE|socket hang up)\b|\bstream ended without any message events\b|\bStream ended without (?:a finish reason|finish_reason)\b|\bWebSocket stream closed before response\.completed\b/i;
/**
 * Provider rejected the request for carrying too many images, e.g.
 * `Too many images in request: 31 > 30` (#425) or Hunyuan's
 * `InvalidParameter.ImageCountLimitExceededError`. Re-sending the same history
 * always fails again, so this is never a transient condition.
 */
const LLM_IMAGE_LIMIT_MESSAGE_RE =
  /\btoo many images\b|\b(?:max|maximum) (?:number of |of \d+ )?images\b|\bnumber of images\b[^.]{0,40}\bexceed|\bimages? (?:count |limit )?exceed(?:s|ed)?\b|\bat most \d+ images?\b|\bImageCountLimitExceeded/i;
/**
 * MiniMax's rejection of one image or video block it cannot or will not take
 * (`invalid params` / `invalid param`, code 2013), in the gateway's own words:
 * - its decoder failed and it names nothing: `invalid params, 400 (2013)` for a
 *   video (a sample table pointing past the file, no video track, no
 *   keyframe), `invalid params, 410 (2013)` for an image with a 2px edge;
 * - the bytes are not readable media: `invalid param: invalid video content: run
 *   ffprobe: exit status 1 (2013)`, `invalid image content: decode image config:
 *   ... (2013)`;
 * - the format is not allowed: `invalid param: video format ".webm" not allowed
 *   (2013)`, `image format ".bmp" not allowed (2013)`;
 * - the block breaks a rule: `invalid params, messages[0]'s content[0] video's
 *   duration is bigger than 1800 seconds, please check your input (2013)`,
 *   `... image's aspect ratio exceeds 200:1 ...`.
 * The same media is rejected on every resend; the request goes through without
 * it. Context overflow (`context window exceeds limit (2013)`) names no media and
 * a media count limit is read by {@link parseLLMMediaCountLimitMessage}.
 */
const LLM_MEDIA_CONTENT_REJECTION_MESSAGE_RES: readonly RegExp[] = [
  /\binvalid params?,\s*\d{3}\s*\(2013\)/i,
  /\binvalid params?\b[^()]{0,300}?\b(?:video|image)(?:'s|s)?\b[^()]{0,300}?\(2013\)/i,
];
/** MiniMax: `invalid params, the num of video is larger than the limit:  20 (2013)`. */
const LLM_MEDIA_COUNT_LIMIT_MESSAGE_RE =
  /\bthe num of (video|image)s? is larger than the limit:\s*(\d+)/i;
/** Common provider error type for a request the provider will never accept as sent. */
const LLM_INVALID_REQUEST_MESSAGE_RE = /\binvalid_request_error\b/i;
/**
 * Gateway rejection of the request shape itself, reported inside a 5xx: e.g.
 * `500 upstream error (invalid_argument): There is an issue with this request,
 * please try a different model.` Resending the same body fails identically.
 */
const LLM_INVALID_ARGUMENT_MESSAGE_RE =
  /\binvalid_argument\b|\bthere is an issue with this request\b/i;
/**
 * The request is over a provider or client size limit: HTTP 413 bodies
 * (`request_too_large`, "Request Entity Too Large", "Payload Too Large"), the
 * local pre-send check (`Request body too large: N bytes exceeds client limit`),
 * gateway rewrites (AWSB's "Input is too long."), a 413 a gateway reports inside
 * another status, a body length limit (http-body's `length limit exceeded`;
 * axum answers `Failed to buffer the request body: length limit exceeded` with a
 * 400 when the limit error reaches it wrapped), each provider's own body, field
 * or attachment limit below, and per-image size or dimension limits. The same
 * request is rejected again on every resend; fewer or smaller images may fit.
 */
const LLM_REQUEST_TOO_LARGE_MESSAGE_RES: readonly RegExp[] = [
  // OpenRouter reports the same limits as `payload_too_large` / `image_too_large`.
  /\brequest_too_large\b|\bREQUEST_BODY_TOO_LARGE\b|\bpayload_too_large\b|\bimage_too_large\b/i,
  /\brequest entity too large\b|\bpayload too large\b/i,
  /\binput is too long\b/i,
  /\b(?:request|body)(?: body)? (?:is )?too large\b/i,
  /\bexceeds? (?:the )?max(?:imum)? (?:allowed )?(?:request |body |payload )?size\b/i,
  /\blength limit exceeded\b/i,
  // Gemini API / Vertex AI: `Request payload size exceeds the limit: 20971520 bytes.`
  /\brequest payload size exceeds the limit\b/i,
  // Tencent Cloud API (Hunyuan): `RequestSizeLimitExceeded`, `Your current request size exceed max 10485760B`.
  /\bRequestSizeLimitExceeded\b|\brequest size exceeds? max\b/i,
  // Kimi: `total message size 5943865 exceeds limit 2097152`.
  /\btotal message size \d+ exceeds limit\b/i,
  // OpenAI per-field limit on message content (not the `user` field):
  // `Invalid 'messages[1].content': string too long. Expected a string with maximum length ...`.
  /\binvalid '(?:messages|input)\b[^']*': string too long\b/i,
  /\b413\b/,
  /\bimages? (?:exceeds?|is too large|too large)\b/i,
  /\bimage dimensions? exceeds?\b/i,
  // DashScope (Qwen-VL): `Exceeded limit on max bytes per data-uri item : 10485760`, `Multimodal file size is too large`.
  /\bexceeded limit on max bytes per data-uri item\b|\bmultimodal file size is too large\b/i,
  // Azure OpenAI: `The image size must be greater than zero and cannot exceed 20971520 bytes.`;
  // OpenAI: `You uploaded an unsupported image. Please make sure your image is below 20 MB in size`.
  /\bimage size must be greater than zero and cannot exceed\b|\bimage is below \d+ ?MB\b/i,
  // Messages API: `A maximum of 100 PDF pages may be provided.`
  /\bmaximum of \d+ PDF pages\b/i,
];
/**
 * The prompt is over the model context window, in each provider's wording.
 * Kept to unambiguous shapes: bare provider codes (MiniMax 2013, Zhipu 1261 and
 * 1210) are generic invalid-params codes and are not read on their own.
 */
const LLM_CONTEXT_OVERFLOW_MESSAGE_RES: readonly RegExp[] = [
  // Messages API: `prompt is too long: N tokens > M maximum`, `input length and `max_tokens` exceed context limit: ...`.
  /\bprompt is too long\b|\bexceeds? (?:the )?context limit\b/i,
  // MiniMax: `invalid params, context window exceeds limit (2013)`.
  /\bcontext window exceeds limit\b/i,
  // OpenAI: `Your input exceeds the context window of this model`, `Input tokens exceed the configured limit of 272000 tokens`.
  /\bexceeds the context window\b|\binput tokens exceed the configured limit\b/i,
  // OpenAI / DeepSeek / OpenRouter: `This model's maximum context length is N tokens`.
  /\bmaximum context length\b|\bmodel'?s maximum context limit\b/i,
  // Bedrock: `Input is too long for requested model.`; Bedrock Mantle: `prompt tokens (N) exceed model maximum (M)`.
  /\binput is too long for requested model\b|\bprompt tokens \(\d+\) exceed model maximum\b/i,
  /\bcontext[_ ]length[_ ]exceeded\b|\bmodel_context_window_exceeded\b/i,
  // Gemini API: `The input token count (N) exceeds the maximum number of tokens allowed (M).`;
  // Vertex AI: `Unable to submit request because the input token count is N but model only supports up to M.`
  /\bexceeds the maximum number of tokens allowed\b|\binput token count is \d+ but model only supports up to\b/i,
  // Kimi: `Your request exceeded model token limit: N`, `k3-256k supports only 256K context.`, `model max length exceeded`.
  /\bexceeded model token limit\b|\bsupports only \d+k context\b|\bmodel max length exceeded\b/i,
  // Zhipu / Z.AI: `Prompt exceeds max length` and `Prompt 超长` (1261), Coding Plan
  // `tokens in request more than max tokens allowed` (1210).
  /\bprompt exceeds max(?:imum)? length\b|prompt\s*超长|\btokens in request more than max tokens allowed\b/i,
  // DashScope (Qwen): `Range of input length should be [1, N]`, `Total message token length exceed model limit`.
  /\brange of input length should be\b|\btotal message token length exceeds? model limit\b/i,
  // Together: `is longer than the model's context length`; llama.cpp: `exceeds the available context size`.
  /\bis longer than the model'?s context length\b|\bexceeds the available context size\b/i,
];
const LLM_USAGE_LIMIT_UPSTREAM_STATUS_CODES = [2056, 2067] as const;
const LLM_USAGE_LIMIT_UPSTREAM_STATUS_CODE_SET = new Set<number>(
  LLM_USAGE_LIMIT_UPSTREAM_STATUS_CODES,
);
const LLM_USAGE_LIMIT_UPSTREAM_STATUS_CODE_RE = /\b(?:2056|2067)\b/u;
// MiniMax "请求处理超时，请稍后重试 (2066)": the provider gave up on the request
// server-side. It is a transient timeout, but its text has no English timeout
// keyword, so recognise the provider code itself.
const LLM_TIMEOUT_UPSTREAM_STATUS_CODE = 2066;
const LLM_TIMEOUT_UPSTREAM_STATUS_CODE_RE = /\b2066\b/u;
/**
 * 已输出后可以安全重发的临时流中断证据，只用既有 signal，不新增宽松匹配：
 * - `stream_interval_timeout` — 上游「输出分片间隔超时」（715 known shape）；
 * - `stream_socket_closed` — 传输层 typed code `UND_ERR_SOCKET`（连接中途断开）；
 * - `network` — 明确的传输层中断（ECONNRESET / socket 错误 / fetch failed）；
 * - `incomplete_stream` — provider 流在没有 stop_reason 的情况下截断；
 * - `facts.timeout` — provider 或本地 watchdog 判定的流超时。
 * 普通 unknown 错误没有任何一条，保持 fail closed。
 */
const RECOVERABLE_STREAM_INTERRUPTION_SIGNALS = [
  'stream_interval_timeout',
  'stream_socket_closed',
  'network',
  'incomplete_stream',
] as const satisfies readonly LLMErrorSignal[];

/** 出现任一即视为确定性拒绝，断流恢复必须让位（额度/参数/大小/上下文/安全）。 */
const DETERMINISTIC_STREAM_RECOVERY_SIGNALS = [
  'usage_limit',
  'credits_exhausted',
  'content_filter',
  'refusal',
  'image_limit',
  'invalid_request',
  'request_too_large',
  'context_overflow',
] as const satisfies readonly LLMErrorSignal[];

/**
 * 上游「输出分片间隔超时」：网关把 provider 的 715 包装成 `1000 unknown error,715`
 * 后再映射为 50113，文本里没有英文 timeout 关键字。只认这两种 known shape，
 * 不用裸 `\b715\b`——耗时、计数或其他错误码里出现的 715 不构成临时证据。
 * 该 signal 只供「已输出后的断流恢复」判断使用，不参与通用 retry/metric 分类，
 * 因此不会改变 cloud-runtime 等既有路径的行为。
 */
const LLM_STREAM_INTERVAL_TIMEOUT_MESSAGE_RE =
  /\bunknown error,\s*715\b|\boutput chunk interval timeout\b/i;

/**
 * 传输层「连接中途被关闭」的 typed code：undici 在 socket 被断开时给的是
 * `UND_ERR_SOCKET`，而正文只有 `terminated`，没有任何可用的英文关键字。
 * 只按 typed code 精确识别，不做裸 `terminated` 之类的宽泛匹配；
 * 该 signal 只供「已输出后的断流恢复」判定使用，不参与通用 retry/metric 分类，
 * 因此不会改变 cloud-runtime 等既有路径的行为。
 */
const LLM_STREAM_SOCKET_CLOSED_CODES: ReadonlySet<string> = new Set(['UND_ERR_SOCKET']);

function isLLMUsageLimitUpstreamStatusCode(statusCode: number | undefined): boolean {
  return statusCode !== undefined && LLM_USAGE_LIMIT_UPSTREAM_STATUS_CODE_SET.has(statusCode);
}

/** Best-effort, bounded and no-throw extraction of stable LLM error facts. */
export function normalizeLLMError(input: LLMErrorInput): NormalizedLLMError {
  try {
    const facts = EMPTY_FACTS();
    const signals = facts.signals as Set<LLMErrorSignal>;
    facts.explicitAbort = input.explicitAbort === true || input.finishReason === 'aborted';
    if (input.finishReason === 'length') signals.add('length');
    if (input.finishReason === 'content-filter' || input.finishReason === 'content_filter') {
      signals.add('content_filter');
    }

    const localResource = classifyLocalResourceError(
      input.raw !== undefined ? input.raw : input.providerError,
    );
    if (localResource) facts.localResource = localResource;

    const extracted = safeExtract(input.raw);
    facts.httpStatus ??= validHttpStatus(input.statusCode) ?? extracted.httpStatus;
    facts.upstreamStatusCode ??= extracted.upstreamStatusCode;
    facts.providerMessageCode ??= extracted.providerMessageCode;
    facts.existingProtocolCode ??= extracted.existingProtocolCode;
    facts.explicitAbort ||= extracted.explicitAbort === true;
    facts.timeout ||= extracted.timeout === true;
    if (extracted.network) signals.add('network');
    if (extracted.socketClosed) signals.add('stream_socket_closed');
    const visibleMessage = extracted.message ?? input.errorMessage;
    if (isLLMProviderRefusalMessage(visibleMessage)) {
      signals.add('refusal');
      signals.add('content_filter');
      return { facts, ...(visibleMessage ? { sanitizedMessage: visibleMessage } : {}) };
    }
    const legacy = extractLegacyMessageFacts(visibleMessage);
    const message = legacy.message ?? visibleMessage;
    if (isLLMIncompleteStreamMessage(visibleMessage)) {
      // Counts and millisecond timings in the diagnostics look like status codes
      // (429, 1008, 2066, ...); keep only the structural signal.
      signals.add('incomplete_stream');
      return { facts, ...(message ? { sanitizedMessage: message } : {}) };
    }
    facts.httpStatus ??= legacy.httpStatus;
    facts.upstreamStatusCode ??= legacy.upstreamStatusCode;
    facts.existingProtocolCode ??= legacy.existingProtocolCode;
    applyMessageSignals(message, facts, signals);
    // Payload extraction keeps only the inner `message`, which drops a JSON
    // `type` such as `invalid_request_error`; check the raw text for the two
    // deterministic-rejection signals as well.
    if (visibleMessage && visibleMessage !== message) {
      const boundedVisible = sanitizeMessage(visibleMessage);
      if (LLM_IMAGE_LIMIT_MESSAGE_RE.test(boundedVisible)) signals.add('image_limit');
      if (LLM_INVALID_REQUEST_MESSAGE_RE.test(boundedVisible)) signals.add('invalid_request');
      if (LLM_INVALID_ARGUMENT_MESSAGE_RE.test(boundedVisible)) signals.add('invalid_argument');
      if (isLLMRequestTooLargeMessage(boundedVisible)) signals.add('request_too_large');
      if (isLLMContextOverflowMessage(boundedVisible)) signals.add('context_overflow');
    }
    applyNumericSignals(facts, signals);
    return { facts, ...(message ? { sanitizedMessage: message } : {}) };
  } catch {
    return {
      facts: EMPTY_FACTS(),
      ...(typeof input.errorMessage === 'string' ? { sanitizedMessage: input.errorMessage } : {}),
    };
  }
}

/** True when an LLM error message reports that the request carried too many images. */
export function isLLMImageLimitMessage(message: string | undefined): boolean {
  return typeof message === 'string' && LLM_IMAGE_LIMIT_MESSAGE_RE.test(message);
}

/**
 * True when MiniMax rejected an image or video block the request carries for
 * its content, format or a per-block rule (see
 * {@link LLM_MEDIA_CONTENT_REJECTION_MESSAGE_RES}). Only the wording is read:
 * a caller acts on it only for a request that carries media. A request over a
 * size limit (`invalid params, 413 (2013)`) is not a rejection of one block:
 * {@link isLLMRequestTooLargeMessage} reads it.
 */
export function isLLMMediaContentRejectionMessage(message: string | undefined): boolean {
  if (typeof message !== 'string' || !message) return false;
  if (LLM_MEDIA_COUNT_LIMIT_MESSAGE_RE.test(message)) return false;
  if (isLLMContextOverflowMessage(message)) return false;
  if (isLLMRequestTooLargeMessage(message)) return false;
  return LLM_MEDIA_CONTENT_REJECTION_MESSAGE_RES.some((pattern) => pattern.test(message));
}

/** The media count MiniMax said one request may carry, when it rejected one for carrying more. */
export function parseLLMMediaCountLimitMessage(
  message: string | undefined,
): { readonly media: 'image' | 'video'; readonly limit: number } | undefined {
  if (typeof message !== 'string') return undefined;
  const match = LLM_MEDIA_COUNT_LIMIT_MESSAGE_RE.exec(message);
  if (!match?.[1] || !match[2]) return undefined;
  const limit = Number(match[2]);
  if (!Number.isSafeInteger(limit) || limit < 0) return undefined;
  return { media: match[1].toLowerCase() === 'image' ? 'image' : 'video', limit };
}

/**
 * True when an LLM error message reports a request over a size limit. Retry
 * classification and request media recovery both read it, so a rejection is
 * either recovered at once or not treated as a size rejection at all.
 */
export function isLLMRequestTooLargeMessage(message: string | undefined): boolean {
  // The missing-stop_reason diagnostics are counts and timings; a count of 413 is not a 413.
  if (isLLMIncompleteStreamMessage(message)) return false;
  return (
    typeof message === 'string' &&
    LLM_REQUEST_TOO_LARGE_MESSAGE_RES.some((pattern) => pattern.test(message))
  );
}

/**
 * True when an LLM error message reports a prompt over the model context
 * window. Request media recovery and the checkpoint candidate ladder read it
 * next to Pi's `isContextOverflow`, whose patterns miss several providers.
 */
export function isLLMContextOverflowMessage(message: string | undefined): boolean {
  return (
    typeof message === 'string' &&
    LLM_CONTEXT_OVERFLOW_MESSAGE_RES.some((pattern) => pattern.test(message))
  );
}

/**
 * Classify a flattened error message (no structured HTTP status available, as
 * in UI layers) as a deterministic request rejection. `invalid_request` also
 * requires a visible 400 so transient errors that merely mention the type stay
 * unclassified.
 */
export function classifyLLMRequestRejectionMessage(
  message: string | undefined,
): 'image_limit' | 'invalid_request' | undefined {
  if (typeof message !== 'string' || !message) return undefined;
  if (LLM_IMAGE_LIMIT_MESSAGE_RE.test(message)) return 'image_limit';
  if (LLM_INVALID_REQUEST_MESSAGE_RE.test(message) && /\b400\b/u.test(message)) {
    return 'invalid_request';
  }
  return undefined;
}

/**
 * A provider rejection that repeats identically for the same request: an image
 * count limit, an HTTP 400 that names `invalid_request_error`, or a gateway
 * `invalid_argument` rejection (reported by some gateways as a 500).
 *
 * BYOK retries every pre-output failure because custom gateways report
 * transient errors inconsistently. These rejections are the exception: the
 * request is malformed or over a hard limit, so retrying only re-sends it and
 * delays the actionable error. Anything that also looks transient — timeout,
 * network, rate limiting, overload or a 5xx — stays retryable.
 */
export function isLLMDeterministicRequestRejection(normalized: NormalizedLLMError): boolean {
  const { facts } = normalized;
  if (facts.explicitAbort || facts.timeout || facts.signals.has('network')) return false;
  const status = effectiveHttpStatus(facts);
  if (status === 408 || status === 429) return false;
  // Named argument rejection: the gateway refused this exact body, whatever
  // outer status it chose (often 500). Only `invalid_argument` crosses the 5xx
  // boundary; a bare `invalid_request_error` inside a 5xx stays retryable.
  if (facts.signals.has('invalid_argument') && status !== 503 && status !== 529) return true;
  if (status !== undefined && status >= 500) return false;
  if (facts.signals.has('image_limit')) {
    return status === undefined || status === 400 || status === 413 || status === 422;
  }
  if (isLLMRequestOversized(normalized)) return true;
  return status === 400 && facts.signals.has('invalid_request');
}

/**
 * 已产生可见输出之后的断流是否可安全恢复：只认明确的上游流中断证据
 * （见 {@link RECOVERABLE_STREAM_INTERRUPTION_SIGNALS} 与 `facts.timeout`）。
 *
 * abort 与确定性拒绝（鉴权、额度、请求/上下文超限、参数、安全拒绝）优先级更高，
 * 一律不恢复；普通 unknown 50113 不带任何证据时保持 fail closed。
 */
export function isLLMRecoverableStreamInterruption(normalized: NormalizedLLMError): boolean {
  const { facts } = normalized;
  const transient =
    facts.timeout ||
    RECOVERABLE_STREAM_INTERRUPTION_SIGNALS.some((signal) => facts.signals.has(signal));
  if (!transient) return false;
  // abort 与用户取消优先级最高。
  if (facts.explicitAbort) return false;
  return !isLLMDeterministicStreamRefusal(normalized);
}

/**
 * 确定性拒绝：把同一个请求原样重发只会再被拒一次——鉴权、额度/余额、参数、
 * 请求过大、上下文超限、安全拒绝。
 *
 * abort 不在此列：那是用户意图，不是「被拒绝」。判定同时服务两处：断流恢复是否
 * 可以重发，以及恢复路径内后续 attempt 的重试决策。后者必须让确定性拒绝最终
 * 否决，否则正文里出现的临时单词（例如 `invalid_request_error: timeout
 * parameter must be positive`）会把 4xx 翻回可重试，白白再发一次请求。
 *
 * 这里不复用 isLLMDeterministicRequestRejection：它只覆盖 image_limit / 超限 /
 * 400+invalid_request，鉴权与额度会漏。
 */
export function isLLMDeterministicStreamRefusal(normalized: NormalizedLLMError): boolean {
  const { facts } = normalized;
  if (DETERMINISTIC_STREAM_RECOVERY_SIGNALS.some((signal) => facts.signals.has(signal))) {
    return true;
  }
  // 鉴权与额度不一定带 message signal：网关可以把 typed code 放进 `errorCode`
  // 而正文只有包装后的文本。只看 signals 会漏挡，必须按 typed code 判定。
  // LLM_UPSTREAM_ERROR（=50113，本次事故码）不在此列，它是通用上游错误。
  switch (facts.existingProtocolCode) {
    case LLM_ERROR_CODES.USAGE_LIMIT_EXCEEDED:
    case LLM_ERROR_CODES.LLM_CREDITS_EXHAUSTED:
    case LLM_ERROR_CODES.LLM_AUTH_ERROR:
      return true;
  }
  if (isLLMUsageLimitUpstreamStatusCode(facts.upstreamStatusCode)) return true;
  const status = effectiveHttpStatus(facts);
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
    return true;
  }
  return isLLMRequestOversized(normalized);
}

/**
 * The request is too big to be accepted as sent: an HTTP 413, a size-limit
 * rejection (`isLLMRequestTooLargeMessage`) or a context window overflow. Resending the same request fails again, so it must not be
 * retried.
 * Anything that also looks transient (timeout, network, 408/429/5xx) is excluded.
 */
function isLLMRequestOversized(normalized: NormalizedLLMError): boolean {
  const { facts } = normalized;
  if (facts.explicitAbort || facts.timeout || facts.signals.has('network')) return false;
  if (facts.signals.has('tpm_rate_limit')) return false;
  const status = effectiveHttpStatus(facts);
  if (status !== undefined && (status === 408 || status === 429 || status >= 500)) return false;
  if (status === 413) return true;
  if (!facts.signals.has('request_too_large') && !facts.signals.has('context_overflow')) {
    return false;
  }
  return status === undefined || status === 400 || status === 413 || status === 422;
}

export function toLLMMetricErrorKind(facts: LLMErrorFacts): LLMMetricErrorKind {
  try {
    if (facts.explicitAbort) return 'abort';
    if (facts.signals.has('refusal')) return 'content_filter';
    if (facts.signals.has('credits_exhausted')) return 'credits_exhausted';
    if (facts.signals.has('usage_limit')) return 'usage_limit';
    if (facts.signals.has('tpm_rate_limit')) return 'tpm_rate_limited';
    if (facts.timeout && effectiveHttpStatus(facts) === 529) return 'overloaded';
    if (facts.timeout) return 'timeout';
    if (facts.signals.has('content_filter')) return 'content_filter';
    if (facts.signals.has('empty_response')) return 'empty_response';
    if (facts.signals.has('length')) return 'length';
    switch (facts.existingProtocolCode) {
      case LLM_ERROR_CODES.USAGE_LIMIT_EXCEEDED:
        return 'usage_limit';
      case LLM_ERROR_CODES.LLM_CREDITS_EXHAUSTED:
        return 'credits_exhausted';
      case LLM_ERROR_CODES.LLM_TPM_RATE_LIMITED:
        return 'tpm_rate_limited';
      case LLM_ERROR_CODES.LLM_RATE_LIMITED:
        return 'rate_limited';
      case LLM_ERROR_CODES.LLM_AUTH_ERROR:
        return 'auth';
      case LLM_ERROR_CODES.LLM_CLUSTER_OVERLOADED:
        return 'overloaded';
    }
    const status = effectiveHttpStatus(facts);
    if (status === 429) return 'rate_limited';
    if (status === 401 || status === 403) return 'auth';
    if (status === 404) return 'not_found';
    if (status !== undefined && status >= 400 && status < 500) return 'bad_request';
    if (status === 529) return 'overloaded';
    if (facts.signals.has('network')) return 'network';
    if (status !== undefined && status >= 500) return 'server_error';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/** `errorKind` label of the failure metrics: a metric kind or a local resource kind. */
export type LLMFailureErrorKind = LLMMetricErrorKind | LocalResourceErrorKind;

/**
 * The metric kind, except that a call which ran out of a local resource names
 * that resource. Cancellation still reports `abort`.
 */
export function toLLMFailureErrorKind(facts: LLMErrorFacts): LLMFailureErrorKind {
  const kind = toLLMMetricErrorKind(facts);
  return kind !== 'abort' && facts.localResource ? facts.localResource : kind;
}

/**
 * Strict transport-retry policy shared by all hosts that opt into framework retry.
 *
 * Product quota, credits, auth and explicit cancellation always win over an outer
 * transient-looking HTTP status. Only the bounded allowlist below is retryable;
 * generic 5xx and unknown failures deliberately fail closed.
 */
export function toLLMRetryDecision(normalized: NormalizedLLMError): LLMRetryDecision {
  const { facts } = normalized;
  const metricKind = toLLMMetricErrorKind(facts);

  if (
    facts.explicitAbort ||
    facts.signals.has('usage_limit') ||
    facts.signals.has('credits_exhausted') ||
    facts.signals.has('content_filter') ||
    facts.signals.has('refusal') ||
    metricKind === 'abort' ||
    metricKind === 'usage_limit' ||
    metricKind === 'credits_exhausted' ||
    metricKind === 'auth'
  ) {
    return { retryable: false, reason: metricKind };
  }
  const status = effectiveHttpStatus(facts);
  if (
    facts.existingProtocolCode === LLM_ERROR_CODES.LLM_AUTH_ERROR ||
    status === 401 ||
    status === 403
  ) {
    return { retryable: false, reason: 'auth' };
  }
  if (facts.timeout) return { retryable: true, reason: 'timeout' };
  if (facts.signals.has('network')) return { retryable: true, reason: 'network' };

  switch (facts.existingProtocolCode) {
    case LLM_ERROR_CODES.LLM_RATE_LIMITED:
      return { retryable: true, reason: 'rate_limited' };
    case LLM_ERROR_CODES.LLM_TPM_RATE_LIMITED:
      return { retryable: true, reason: 'tpm_rate_limited' };
    case LLM_ERROR_CODES.LLM_CLUSTER_OVERLOADED:
      return { retryable: true, reason: 'overloaded' };
  }

  if (status === 429) {
    return {
      retryable: true,
      reason: facts.signals.has('tpm_rate_limit') ? 'tpm_rate_limited' : 'rate_limited',
    };
  }
  if (status === 529) return { retryable: true, reason: 'overloaded' };
  return { retryable: false, reason: metricKind };
}

export function toLLMProtocolClassification(
  normalized: NormalizedLLMError,
): LLMProtocolClassification | null {
  try {
    const { facts, sanitizedMessage } = normalized;
    const httpStatus = effectiveHttpStatus(facts);
    let code: number | undefined;
    if (facts.existingProtocolCode && isClassifiedErrorStatusCode(facts.existingProtocolCode)) {
      code = facts.existingProtocolCode;
    } else if (facts.signals.has('credits_exhausted')) {
      code = LLM_ERROR_CODES.LLM_CREDITS_EXHAUSTED;
    } else if (isLLMUsageLimitUpstreamStatusCode(facts.upstreamStatusCode)) {
      code = LLM_ERROR_CODES.USAGE_LIMIT_EXCEEDED;
    } else if (httpStatus === 429 && facts.signals.has('tpm_rate_limit')) {
      code = LLM_ERROR_CODES.LLM_TPM_RATE_LIMITED;
    } else if (httpStatus === 529) {
      code = LLM_ERROR_CODES.LLM_CLUSTER_OVERLOADED;
    } else if (httpStatus !== undefined) {
      code = mapUpstreamHttpError(httpStatus);
    } else if (facts.timeout) {
      code = LLM_ERROR_CODES.LLM_UPSTREAM_ERROR;
    } else if (facts.signals.has('incomplete_stream')) {
      code = LLM_ERROR_CODES.LLM_UPSTREAM_ERROR;
    }
    return code === undefined
      ? null
      : { code, ...(sanitizedMessage ? { message: sanitizedMessage } : {}) };
  } catch {
    return null;
  }
}

interface SafeExtracted {
  httpStatus?: number;
  upstreamStatusCode?: number;
  providerMessageCode?: number;
  existingProtocolCode?: number;
  explicitAbort?: boolean;
  timeout?: boolean;
  network?: boolean;
  socketClosed?: boolean;
  message?: string;
}

function safeExtract(raw: unknown): SafeExtracted {
  const out: SafeExtracted = {};
  const seen = new WeakSet<object>();
  const queue: Array<{ value: unknown; depth: number }> = [{ value: raw, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited++ < 32) {
    const item = queue.shift()!;
    if (item.depth > 4 || typeof item.value !== 'object' || item.value === null) continue;
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    if (
      item.value instanceof Error ||
      (typeof DOMException !== 'undefined' && item.value instanceof DOMException)
    ) {
      const builtinError = item.value;
      if (builtinError.name === 'AbortError') out.explicitAbort = true;
      if (/TimeoutError/u.test(builtinError.name)) out.timeout = true;
      if (!out.message && builtinError.message) out.message = sanitizeMessage(builtinError.message);
    }
    let descriptors: PropertyDescriptorMap;
    try {
      descriptors = Object.getOwnPropertyDescriptors(item.value);
    } catch {
      continue;
    }
    const value = (key: string): unknown => {
      const descriptor = descriptors[key];
      return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    };
    const name = value('name');
    const code = value('code');
    if (name === 'AbortError') out.explicitAbort = true;
    if (typeof name === 'string' && /TimeoutError/u.test(name)) out.timeout = true;
    if (typeof code === 'string' && SAFE_NETWORK_CODES.has(code)) {
      out.network = true;
      if (isLLMTransportTimeoutCode(code)) out.timeout = true;
    }
    if (typeof code === 'string' && LLM_STREAM_SOCKET_CLOSED_CODES.has(code)) {
      out.socketClosed = true;
    }
    const statusCode = validHttpStatus(value('statusCode')) ?? validHttpStatus(value('status'));
    out.httpStatus ??= statusCode;
    if (name === 'APICallError' && statusCode === undefined && item.value instanceof Error) {
      out.network = true;
    }
    const upstream = validInteger(value('status_code'));
    out.upstreamStatusCode ??= upstream;
    const existing = validInteger(value('errorCode'));
    out.existingProtocolCode ??= existing;
    const providerCode = validInteger(value('code'));
    if (providerCode !== undefined && providerCode < 10000)
      out.providerMessageCode ??= providerCode;
    const statusMessage = value('status_message') ?? value('status_msg');
    const message = value('message');
    if (typeof statusMessage === 'string') out.message = sanitizeMessage(statusMessage);
    else if (!out.message && typeof message === 'string') out.message = sanitizeMessage(message);
    const responseBody = value('responseBody');
    if (typeof responseBody === 'string' && responseBody.length <= 64_000) {
      try {
        queue.push({ value: JSON.parse(responseBody), depth: item.depth + 1 });
      } catch {
        /* compatibility fallback */
      }
    }
    for (const key of ['cause', 'error', 'data']) {
      queue.push({ value: value(key), depth: item.depth + 1 });
    }
  }
  return out;
}

function validInteger(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 2_000_000_000
    ? value
    : undefined;
}
function validHttpStatus(value: unknown): number | undefined {
  const n = validInteger(value);
  return n !== undefined && n >= 100 && n <= 599 ? n : undefined;
}
function sanitizeMessage(message: string): string {
  return message.slice(0, 4096);
}

function extractLegacyMessageFacts(message: string | undefined): {
  httpStatus?: number;
  upstreamStatusCode?: number;
  existingProtocolCode?: number;
  message?: string;
} {
  if (!message) return {};
  const boundedMessage = sanitizeMessage(message);
  const extracted = tryExtractFromPayload({ message: boundedMessage });
  const classified = classifyLLMErrorToCode(boundedMessage);
  const statusCode = validInteger(extracted.statusCode);
  const httpStatus = validHttpStatus(statusCode);
  return {
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(statusCode !== undefined && httpStatus === undefined
      ? { upstreamStatusCode: statusCode }
      : {}),
    ...(classified ? { existingProtocolCode: classified.status_code } : {}),
    ...(extracted.message ? { message: sanitizeMessage(extracted.message) } : {}),
  };
}

function applyNumericSignals(facts: LLMErrorFacts, signals: Set<LLMErrorSignal>): void {
  const httpStatus = effectiveHttpStatus(facts);
  if (
    facts.upstreamStatusCode === 1400010161 ||
    facts.providerMessageCode === 1008 ||
    httpStatus === 402
  )
    signals.add('credits_exhausted');
  if (isLLMUsageLimitUpstreamStatusCode(facts.upstreamStatusCode)) signals.add('usage_limit');
  if (
    facts.upstreamStatusCode === LLM_TIMEOUT_UPSTREAM_STATUS_CODE ||
    facts.providerMessageCode === LLM_TIMEOUT_UPSTREAM_STATUS_CODE
  )
    facts.timeout = true;
  if (
    httpStatus === 429 &&
    [2045, 2046, 2047, 1039, 1041].includes(facts.providerMessageCode ?? -1)
  )
    signals.add('tpm_rate_limit');
}

function effectiveHttpStatus(facts: LLMErrorFacts): number | undefined {
  return validHttpStatus(facts.upstreamStatusCode) ?? facts.httpStatus;
}
function applyMessageSignals(
  message: string | undefined,
  facts: LLMErrorFacts,
  signals: Set<LLMErrorSignal>,
): void {
  if (!message) return;
  if (/\brequest was aborted\b/i.test(message)) facts.explicitAbort = true;
  if (/\b429\b/u.test(message) || /rate[_\s-]?limit(?:ed)?/i.test(message))
    facts.httpStatus ??= 429;
  if (/\b529\b/u.test(message) || /cluster\s+overload/i.test(message)) facts.httpStatus ??= 529;
  if (/\b(?:2045|2046|2047|1039|1041)\b/u.test(message)) signals.add('tpm_rate_limit');
  if (
    LLM_USAGE_LIMIT_UPSTREAM_STATUS_CODE_RE.test(message) ||
    /usage[_\s-](?:limit[_\s-])?(?:reached|exceeded|not[_\s-]included)/i.test(message)
  )
    signals.add('usage_limit');
  if (
    /\b(?:1400010161|1008)\b/u.test(message) ||
    /credits?\s+exhausted|insufficient\s+balance/i.test(message)
  )
    signals.add('credits_exhausted');
  if (
    ABORT_MESSAGE_RE.test(message) ||
    TRANSIENT_TIMEOUT_MESSAGE_RE.test(message) ||
    CHROMIUM_TIMEOUT_MESSAGE_RE.test(message) ||
    LLM_TIMEOUT_UPSTREAM_STATUS_CODE_RE.test(message)
  )
    facts.timeout = true;
  if (
    CONNECTION_ERROR_MESSAGE_RE.test(message) ||
    TRANSIENT_NETWORK_MESSAGE_RE.test(message) ||
    STREAM_DISCONNECT_MESSAGE_RE.test(message) ||
    CHROMIUM_NETWORK_MESSAGE_RE.test(message)
  )
    signals.add('network');
  if (LLM_STREAM_INTERVAL_TIMEOUT_MESSAGE_RE.test(message)) {
    signals.add('stream_interval_timeout');
  }
  if (/\bempty.?response/i.test(message)) signals.add('empty_response');
  if (LLM_IMAGE_LIMIT_MESSAGE_RE.test(message)) signals.add('image_limit');
  if (LLM_INVALID_REQUEST_MESSAGE_RE.test(message)) signals.add('invalid_request');
  if (LLM_INVALID_ARGUMENT_MESSAGE_RE.test(message)) signals.add('invalid_argument');
  if (isLLMRequestTooLargeMessage(message)) signals.add('request_too_large');
  if (isLLMContextOverflowMessage(message)) signals.add('context_overflow');
  const hasStructuredError =
    facts.existingProtocolCode !== undefined || effectiveHttpStatus(facts) !== undefined;
  if (!hasStructuredError && /\b(content.?filter|content.?policy|safety|blocked)\b/i.test(message))
    signals.add('content_filter');
}

/**
 * Plugin-friendly classifier — accepts a structured triple instead of a
 * thrown value. Mirrors the daemon-side `classifyLLMError` minus the
 * SDK-instance branches (no `APICallError.isInstance`, no `DOMException`).
 *
 * Returns `undefined` when there's no signal of an error at all (success
 * path); callers stamp `error_reason: ''` in that case so success and
 * failure series carry the same label keys and one query covers both.
 */
export interface FinishStepClassifierInput {
  finishReason?: string;
  statusCode?: number;
  errorMessage?: string;
}

export function classifyFinishStepError(
  input: FinishStepClassifierInput,
): LLMErrorReason | undefined {
  const { finishReason, statusCode, errorMessage } = input;
  if (finishReason === 'length') return 'length';
  if (isLLMProviderRefusalMessage(errorMessage)) return 'content_filter';
  if (finishReason === 'content-filter' || finishReason === 'content_filter') {
    return 'content_filter';
  }
  if (typeof statusCode === 'number') {
    if (statusCode === 429) return 'rate_limited';
    if (statusCode === 401 || statusCode === 403) return 'auth';
    if (statusCode === 404) return 'not_found';
    if (statusCode >= 400 && statusCode < 500) return 'bad_request';
  }
  if (errorMessage) {
    if (
      ABORT_MESSAGE_RE.test(errorMessage) ||
      TRANSIENT_TIMEOUT_MESSAGE_RE.test(errorMessage) ||
      CHROMIUM_TIMEOUT_MESSAGE_RE.test(errorMessage) ||
      LLM_TIMEOUT_UPSTREAM_STATUS_CODE_RE.test(errorMessage)
    ) {
      return 'timeout';
    }
    if (
      CONNECTION_ERROR_MESSAGE_RE.test(errorMessage) ||
      TRANSIENT_NETWORK_MESSAGE_RE.test(errorMessage) ||
      STREAM_DISCONNECT_MESSAGE_RE.test(errorMessage) ||
      CHROMIUM_NETWORK_MESSAGE_RE.test(errorMessage)
    ) {
      return 'network';
    }
    if (/\bempty.?response/i.test(errorMessage)) return 'empty_response';
    if (/\b(content.?filter|content.?policy|safety|blocked)/i.test(errorMessage)) {
      return 'content_filter';
    }
  }
  if (typeof statusCode === 'number' && statusCode >= 500) return 'server_error';
  if (finishReason === 'error') return 'unknown';
  return undefined;
}

/**
 * Daemon-side classifier — accepts a raw thrown value (`APICallError`
 * instance, `DOMException`, plain `Error`, anything). Falls through to
 * `classifyFinishStepError` for the message-pattern branches and the
 * statusCode branches when the value carries those fields.
 *
 * Plugin code should prefer `classifyFinishStepError` directly because the
 * SDK has already normalised the shape. Daemon code uses this entry point.
 */
export function classifyLLMError(err: unknown): LLMErrorReason {
  if (err instanceof Error && isLLMProviderRefusalMessage(err.message)) return 'content_filter';
  // DOMException AbortError or Error message-text "timeout/abort" — same
  // bucket whether it came from `AbortController.abort()` or a server-side
  // 504 with no explicit status.
  const isAbort =
    (typeof DOMException !== 'undefined' &&
      err instanceof DOMException &&
      err.name === 'AbortError') ||
    (err instanceof Error &&
      (ABORT_MESSAGE_RE.test(err.message) ||
        TRANSIENT_TIMEOUT_MESSAGE_RE.test(err.message) ||
        CHROMIUM_TIMEOUT_MESSAGE_RE.test(err.message)));
  if (isAbort) return 'timeout';

  // Vercel AI SDK's APICallError carries statusCode but isn't a subclass of
  // Error in older versions. Detect via duck-typing on `name === 'APICallError'`
  // (or via the SDK's `isInstance` when available — see daemon shim).
  const errorCode = extractErrorCode(err);
  const errorMessage = extractErrorMessage(err);
  const apiStatus = extractAPICallErrorStatus(err);
  if (apiStatus !== undefined) {
    if (apiStatus === 429) return 'rate_limited';
    if (apiStatus === 401 || apiStatus === 403) return 'auth';
    if (apiStatus === 404) return 'not_found';
    if (apiStatus >= 400 && apiStatus < 500) return 'bad_request';
    if (errorCode !== undefined && SAFE_NETWORK_CODES.has(errorCode)) {
      return isLLMTransportTimeoutCode(errorCode) ? 'timeout' : 'network';
    }
    if (errorMessage !== undefined) {
      if (isLLMTransportTimeoutSignal(errorMessage)) return 'timeout';
      if (isLLMTransportNetworkSignal(errorMessage)) return 'network';
    }
    if (apiStatus >= 500) return 'server_error';
    // statusCode === undefined on APICallError is the SDK's "no response
    // came back at all" sentinel — treat as a network error.
  }

  if (errorCode !== undefined && SAFE_NETWORK_CODES.has(errorCode)) {
    return isLLMTransportTimeoutCode(errorCode) ? 'timeout' : 'network';
  }

  const isAPICallErrorWithoutStatus =
    apiStatus === undefined && err instanceof Error && err.name === 'APICallError';
  if (isAPICallErrorWithoutStatus) return 'network';

  if (
    err instanceof TypeError ||
    (err instanceof Error &&
      (CONNECTION_ERROR_MESSAGE_RE.test(err.message) ||
        TRANSIENT_NETWORK_MESSAGE_RE.test(err.message) ||
        STREAM_DISCONNECT_MESSAGE_RE.test(err.message) ||
        CHROMIUM_NETWORK_MESSAGE_RE.test(err.message)))
  ) {
    return 'network';
  }

  if (
    err instanceof Error &&
    /\b(content.?filter|content.?policy|safety|blocked)/i.test(err.message)
  ) {
    return 'content_filter';
  }

  if (err instanceof Error && /\bempty.?response/i.test(err.message)) {
    return 'empty_response';
  }

  return 'unknown';
}

/**
 * Best-effort extraction of `statusCode` from an unknown thrown value. We
 * read the field directly so this module stays free of the `ai` package
 * dependency (which `@mavis/shared` cannot import — it would pull the
 * Vercel AI SDK into the plugin bundle).
 */
function extractAPICallErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as { statusCode?: unknown; name?: unknown };
  if (candidate.name !== 'APICallError') return undefined;
  if (typeof candidate.statusCode === 'number') return candidate.statusCode;
  return undefined;
}

function extractErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as { code?: unknown };
  return typeof candidate.code === 'string' ? candidate.code : undefined;
}

function extractErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error) return err.message;
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as { message?: unknown };
  return typeof candidate.message === 'string' ? candidate.message : undefined;
}

// ────────────────────────────────────────────────────────────────────────────
// LLM error → shared session-status status_code (cloud-runtime wire normalize)
// ────────────────────────────────────────────────────────────────────────────
//
// 跟上面 `classifyLLMError` 的 bounded metric label 互补:这里产出的是
// runtime numeric status_code,塞进 wire (BusEvent.errorCode /
// ProtocolError.code),让前端 typed error-code 文案和状态分支命中。
// 其中 42212 / 50110 / 50150 会进入 UI `ChatStatus.RunOutOfCredit`;
// 50111 是短期请求限流，进入 output retry；50151 展示集群高负载错误文案。
//
// 这些 code 是跨 runtime 共享 wire 常量。不能从某个宿主包反向 import,
// 否则 cloud-runtime/local-runtime 会重新耦合到本地宿主实现。

export const LLM_ERROR_STATUS_CODES = {
  /** USAGE_LIMIT_EXCEEDED — quota 满 / 用量到顶 */
  USAGE_LIMIT_EXCEEDED: 42212,
  /** LLM_CREDITS_EXHAUSTED — provider 报余额耗尽 / HTTP 402 */
  LLM_CREDITS_EXHAUSTED: 50110,
  /** daemon LLM_RATE_LIMITED — HTTP 429 */
  LLM_RATE_LIMITED: 50111,
  /** daemon LLM_AUTH_ERROR — HTTP 401/403 */
  LLM_AUTH_ERROR: 50112,
  /** daemon LLM_UPSTREAM_ERROR — generic 4xx/5xx fallback */
  LLM_UPSTREAM_ERROR: 50113,
  /** daemon LLM_MIGRATION_ERROR — OP migration path failed */
  LLM_MIGRATION_ERROR: 50114,
  /** daemon LLM_TPM_RATE_LIMITED — provider TPM/RPM short-term throttling */
  LLM_TPM_RATE_LIMITED: 50150,
  /** LLM_CLUSTER_OVERLOADED — HTTP 529 */
  LLM_CLUSTER_OVERLOADED: 50151,
} as const;
export type LLMErrorStatusCode =
  (typeof LLM_ERROR_STATUS_CODES)[keyof typeof LLM_ERROR_STATUS_CODES];

// Backward-compatible name for UI typed-match imports.
export const LLM_ERROR_CODES = LLM_ERROR_STATUS_CODES;

/**
 * 分类器能给出的错误码：模型错误码，加上 biz-gateway 模型代理写进 `errorCode` 的平台业务拒绝。
 * 桌面端本地会话请求平台模型时，这类拒绝沿模型调用失败的链路上来，只有这里能读到。
 */
export type ClassifiedErrorStatusCode = LLMErrorStatusCode | typeof USER_SEND_RESTRICTED_ERROR_CODE;

function isClassifiedErrorStatusCode(code: number): code is ClassifiedErrorStatusCode {
  return (
    code === USER_SEND_RESTRICTED_ERROR_CODE ||
    (Object.values(LLM_ERROR_CODES) as number[]).includes(code)
  );
}

export const LLM_TPM_RATE_LIMIT_MESSAGE_CODES = [2045, 2046, 2047, 1039, 1041] as const;

const LLM_TPM_RATE_LIMIT_MESSAGE_CODE_RE = /\b(?:2045|2046|2047|1039|1041)\b/u;

export function isLLMTpmRateLimitMessage(message: string | undefined): boolean {
  return message !== undefined && LLM_TPM_RATE_LIMIT_MESSAGE_CODE_RE.test(message);
}

/**
 * 上游 MiniMax / OpenAI 风格 provider 的 status_code → daemon ErrorCode 映射。
 * 数值跟 daemon `local-proxy-handler.ts::UPSTREAM_CODE_MAP` 同源。
 */
export const UPSTREAM_STATUS_CODE_MAP: Record<number, LLMErrorStatusCode> = {
  // MiniMax internal status: 余额不足 → 50110
  1400010161: LLM_ERROR_CODES.LLM_CREDITS_EXHAUSTED,
  // MiniMax internal status: 用量超限 → 42212
  2056: LLM_ERROR_CODES.USAGE_LIMIT_EXCEEDED,
  // Token Plan 已达限且积分自动消耗关闭 → 42212
  2067: LLM_ERROR_CODES.USAGE_LIMIT_EXCEEDED,
};

/**
 * 从未知 raw value 抠 `{ status_code, errorCode, code, message }` 信号 — 兼容
 * 多种 envelope 嵌套(`{error: {responseBody: '{"status_code":...}'}}` 这种
 * Vercel AI SDK / DOMException 包装)。
 *
 * 递归 unwrap 三层:`err.responseBody` (JSON string) → `err.error` (nested obj)
 * → `err.data` → `err.status`。
 */
export function tryExtractFromPayload(raw: unknown): {
  statusCode?: number;
  errorCode?: number;
  message?: string;
} {
  if (typeof raw !== 'object' || raw === null) return {};
  const obj = raw as Record<string, unknown>;
  const out: { statusCode?: number; errorCode?: number; message?: string } = {};

  // ── pass 1: nested envelopes first ──────────────────────────────────────
  // Business-level codes (inner upstream `status_code`) MUST take priority
  // over transport-level codes (outer HTTP `statusCode`). AI SDK
  // APICallError wraps upstream payload as `{statusCode: 500,
  // responseBody: '{"status_code": 1400010161, ...}'}` — the inner 1400010161
  // is the real cause (MiniMax credit exhausted → 50110), the outer 500 is
  // just HTTP transport. We collect nested signals FIRST, then let outer
  // fields fill in only what nested didn't provide.

  let nested: { statusCode?: number; errorCode?: number; message?: string } = {};
  if (typeof obj.responseBody === 'string') {
    try {
      const inner = JSON.parse(obj.responseBody) as Record<string, unknown>;
      const innerExtract = tryExtractFromPayload(inner);
      nested = { ...innerExtract };
    } catch {
      // ignore parse fail
    }
  }
  if (typeof obj.error === 'object' && obj.error !== null) {
    const innerExtract = tryExtractFromPayload(obj.error);
    nested.statusCode ??= innerExtract.statusCode;
    nested.errorCode ??= innerExtract.errorCode;
    nested.message ??= innerExtract.message;
  }
  if (typeof obj.data === 'object' && obj.data !== null) {
    const innerExtract = tryExtractFromPayload(obj.data);
    nested.statusCode ??= innerExtract.statusCode;
    nested.errorCode ??= innerExtract.errorCode;
    nested.message ??= innerExtract.message;
  }
  // `obj.cause` (Error chain root cause via `new Error('...', { cause: orig })`)
  // — some SDK wrappers (Vercel AI / Vercel) re-throw the original
  // provider Error as `.cause` while putting their own format string in
  // `.message`. Recurse so the original typed signal isn't lost.
  if (typeof obj.cause === 'object' && obj.cause !== null) {
    const innerExtract = tryExtractFromPayload(obj.cause);
    nested.statusCode ??= innerExtract.statusCode;
    nested.errorCode ??= innerExtract.errorCode;
    nested.message ??= innerExtract.message;
  }
  out.statusCode = nested.statusCode;
  out.errorCode = nested.errorCode;
  out.message = nested.message;

  // ── pass 2: outer fields fill blanks ────────────────────────────────────
  if (out.statusCode === undefined && typeof obj.status_code === 'number') {
    out.statusCode = obj.status_code;
  }
  if (out.statusCode === undefined && typeof obj.statusCode === 'number') {
    out.statusCode = obj.statusCode;
  }
  // Messages-compatible SDK `APIError` uses `.status` (number); other SDKs
  // use `.statusCode`. Pick whichever appears.
  if (out.statusCode === undefined && typeof obj.status === 'number') {
    out.statusCode = obj.status;
  }
  if (out.errorCode === undefined && typeof obj.errorCode === 'number') {
    out.errorCode = obj.errorCode;
  }
  if (out.errorCode === undefined && typeof obj.code === 'number') {
    out.errorCode = obj.code;
  }
  if (!out.message && typeof obj.message === 'string') out.message = obj.message;
  if (!out.message && typeof obj.status_message === 'string') out.message = obj.status_message;
  if (!out.message && typeof obj.status_msg === 'string') out.message = obj.status_msg;
  if (!out.message && typeof obj.error === 'string') out.message = obj.error;

  // ── pass 3: message string fallback ──────────────────────────────────────
  // Some SDKs throw APIError whose toString() is
  // `[Error] <status> <json-body>`, Vercel / Vercel AI re-wrappers, etc.)
  // collapse the typed fields into a plain text `message` string before
  // throwing. Try to recover the signal from that string when typed fields
  // didn't already cover it.
  if (typeof obj.message === 'string') {
    const fromMsg = extractFromMessageString(obj.message);
    out.statusCode ??= fromMsg.statusCode;
    out.errorCode ??= fromMsg.errorCode;
    // Inner JSON payload may also carry a richer message (e.g. provider
    // `error.message: "invalid api key"`); prefer it over the noisy raw
    // outer string when available.
    if (fromMsg.message) out.message = fromMsg.message;
  }

  return out;
}

// extractFromMessageString — best-effort parse of a raw error-message
// string for an HTTP status prefix and an embedded JSON body.
//
// Handles shapes seen in real cloud-runtime logs:
//
//   `[Error] 401 {"type":"error","error":{"type":"authentication_error",
//                                          "message":"invalid api key"},
//                 "request_id":"..."}`   (Messages-compatible providers)
//   `Provider API error (429): rate limited`
//   `OpenAI 401: invalid api key`
//   `500 Internal Server Error - {"status_code":1400010161,...}`
//
// Returns `{ statusCode?, message? }`:
//   - statusCode: first 3-digit HTTP-shaped number in [400, 599] found in
//     the prefix segment (before the first `{`). Stops at 599 so random
//     numeric content in JSON body doesn't trigger false positives.
//   - message: the most specific human-readable message found in the
//     embedded JSON (`error.message` → `message` → `error` as string).
function extractFromMessageString(s: string): {
  statusCode?: number;
  errorCode?: number;
  message?: string;
} {
  const out: { statusCode?: number; errorCode?: number; message?: string } = {};
  if (!s) return out;

  // 1. Find the embedded JSON body (first `{` ... last `}`).
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  const prefix = firstBrace > 0 ? s.slice(0, firstBrace) : s;
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const jsonSlice = s.slice(firstBrace, lastBrace + 1);
    try {
      const parsed = JSON.parse(jsonSlice) as unknown;
      const innerExtract = tryExtractFromPayload(parsed);
      if (innerExtract.statusCode !== undefined) out.statusCode = innerExtract.statusCode;
      if (innerExtract.errorCode !== undefined) out.errorCode = innerExtract.errorCode;
      if (innerExtract.message) out.message = innerExtract.message;
    } catch {
      // ignore — not JSON
    }
  }

  // 2. If no statusCode from JSON body, grab first 4xx/5xx number in prefix.
  if (out.statusCode === undefined) {
    const m = prefix.match(/\b([45]\d{2})\b/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n >= 400 && n <= 599) {
        out.statusCode = n;
      }
    }
  }

  return out;
}

/**
 * HTTP status → daemon ErrorCode fallback(当无 typed errorCode / upstream
 * status_code 命中时)。
 */
export function mapUpstreamHttpError(httpStatus: number): LLMErrorStatusCode | undefined {
  if (httpStatus === 402) return LLM_ERROR_CODES.LLM_CREDITS_EXHAUSTED;
  if (httpStatus === 429) return LLM_ERROR_CODES.LLM_RATE_LIMITED;
  if (httpStatus === 529) return LLM_ERROR_CODES.LLM_CLUSTER_OVERLOADED;
  if (httpStatus === 401 || httpStatus === 403) return LLM_ERROR_CODES.LLM_AUTH_ERROR;
  if (httpStatus >= 400) return LLM_ERROR_CODES.LLM_UPSTREAM_ERROR;
  return undefined;
}

/**
 * 把 LLM 调用抛出的 raw err 归一化成 session-status status_code + sanitized message。
 *
 * 优先级:
 *   1. payload 里显式带的 `errorCode` / `code` (status_code enum) 直接用
 *   2. provider 流缺失 stop_reason(`stream ended without stop_reason`)→ LLM_UPSTREAM_ERROR(50113);
 *      其后诊断里的计数/毫秒数不参与下面的数字判定
 *   3. payload 里的上游 `status_code` 命中 UPSTREAM_STATUS_CODE_MAP(MiniMax 1400010161 / 2056 / 2067)
 *   4. message-only quota/credits signal, e.g. "usage limit exceeded (2056)"
 *   5. HTTP 429 + TPM provider message code → LLM_TPM_RATE_LIMITED(50150)
 *   6. LLM HTTP timeout signal → LLM_UPSTREAM_ERROR(50113)
 *   7. LLM transport network signal → LLM_UPSTREAM_ERROR(50113)
 *   8. payload / `err.statusCode` 是 HTTP status → mapUpstreamHttpError
 *
 * 返 `null` 表示不识别(caller 走 fallback ProtocolErrorCode.INTERNAL_ERROR)。
 *
 * `message` 字段优先用 payload 里 sanitized message(string_message / message /
 * error 文本字段);err.message 兜底。
 */
export function classifyLLMErrorToCode(
  err: unknown,
): { status_code: ClassifiedErrorStatusCode; message: string } | null {
  // Accept plain strings (some callers — notably pi-turn-runner capturing
  // `agent.state.errorMessage`) have already collapsed the typed error
  // shape into a single line. Wrap into `{message: str}` so the existing
  // `pass 3` string-fallback inside `tryExtractFromPayload` (status prefix
  // + embedded JSON parse) still fires.
  const normalized = typeof err === 'string' ? { message: err } : err;
  // A provider refusal is a policy outcome, not a transport/quota error. Its explanation text is
  // provider-controlled, so never derive status codes from it.
  if (isLLMProviderRefusalMessage(typeof err === 'string' ? err : extractErrorMessage(err))) {
    return null;
  }
  const extracted = tryExtractFromPayload(normalized);
  // 1. typed errorCode
  if (extracted.errorCode !== undefined) {
    if (isClassifiedErrorStatusCode(extracted.errorCode)) {
      return {
        status_code: extracted.errorCode,
        message: extracted.message ?? fallbackMessage(err),
      };
    }
  }
  // 1b. Provider stream truncated before a stop_reason. Its diagnostics are
  // event counts and timings, so stop before any numeric status/quota check.
  if (isLLMIncompleteStreamMessage(extracted.message ?? fallbackMessage(err))) {
    return {
      status_code: LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
      message: extracted.message ?? fallbackMessage(err),
    };
  }
  // 2. upstream status_code 命中
  if (extracted.statusCode !== undefined && UPSTREAM_STATUS_CODE_MAP[extracted.statusCode]) {
    return {
      status_code: UPSTREAM_STATUS_CODE_MAP[extracted.statusCode]!,
      message: extracted.message ?? fallbackMessage(err),
    };
  }

  // 3. Message-only quota fallback. Some SDK/proxy wrappers collapse the
  // upstream body into plain text while keeping only a generic HTTP 500 outside.
  // Treat the business signal in the text as stronger than the transport status.
  const messageOnly = classifyQuotaSignalFromMessage(extracted.message ?? fallbackMessage(err));
  if (messageOnly) return messageOnly;

  const codeMessage = extracted.message ?? fallbackMessage(err);
  const transportCode = extractErrorCode(err);
  const httpStatus =
    extracted.statusCode ??
    (typeof (err as { statusCode?: unknown })?.statusCode === 'number'
      ? (err as { statusCode: number }).statusCode
      : undefined);

  // 4. Provider TPM/rate-window fallback. These 429s are short-term request
  // throttles, not quota exhaustion, so they get their own product code.
  if (httpStatus === 429 && isLLMTpmRateLimitMessage(codeMessage)) {
    return {
      status_code: LLM_ERROR_CODES.LLM_TPM_RATE_LIMITED,
      message: codeMessage,
    };
  }

  // 5. Structured business HTTP statuses remain stronger than transport text.
  // A misleading wrapper message such as "timed out" must not turn auth,
  // quota, rate-limit, not-found, or the explicit 529 overload response into
  // a generic transient capacity error. 5xx statuses are intentionally left
  // for the transport checks below because a 5xx wrapper may represent a
  // connection failure with no usable upstream response.
  if (httpStatus !== undefined && (httpStatus < 500 || httpStatus === 529)) {
    const mapped = mapUpstreamHttpError(httpStatus);
    if (mapped !== undefined) {
      return { status_code: mapped, message: extracted.message ?? fallbackMessage(err) };
    }
  }

  // 6. LLM HTTP timeout fallback. A transport deadline does not prove that
  // the provider returned an explicit cluster-overload response.
  const timeoutMessage = codeMessage;
  if (isLLMHttpTimeoutSignal(err, timeoutMessage)) {
    return {
      status_code: LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
      message: timeoutMessage,
    };
  }

  // 7. Remaining HTTP status fallback (normally generic 5xx).
  if (httpStatus !== undefined) {
    const mapped = mapUpstreamHttpError(httpStatus);
    if (mapped !== undefined) {
      return { status_code: mapped, message: extracted.message ?? fallbackMessage(err) };
    }
  }

  // 8. LLM transport network fallback. No dedicated daemon wire code exists for
  // network, so use the generic upstream code while preserving the raw detail.
  const networkMessage = codeMessage;
  if (isLLMTransportNetworkSignal(networkMessage) || isLLMTransportNetworkCode(transportCode)) {
    return {
      status_code: LLM_ERROR_CODES.LLM_UPSTREAM_ERROR,
      message: networkMessage,
    };
  }
  return null;
}

function isLLMHttpTimeoutSignal(err: unknown, message: string): boolean {
  if (
    /\b(timed?\s*out|timeout|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)\b/i.test(
      message,
    )
  ) {
    return true;
  }

  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { name?: unknown; code?: unknown };
  return (
    (typeof candidate.name === 'string' &&
      /\b(?:TimeoutError|ConnectTimeoutError|HeadersTimeoutError|BodyTimeoutError)\b/i.test(
        candidate.name,
      )) ||
    (typeof candidate.code === 'string' && isLLMTransportTimeoutCode(candidate.code))
  );
}

function isLLMTransportTimeoutCode(code: string): boolean {
  return /\b(?:ETIMEDOUT|ESOCKETTIMEDOUT|ECONNABORTED|ERR_(?:CONNECTION_)?TIMED_OUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT)\b/u.test(
    code,
  );
}

function isLLMTransportTimeoutSignal(message: string): boolean {
  return TRANSIENT_TIMEOUT_MESSAGE_RE.test(message) || CHROMIUM_TIMEOUT_MESSAGE_RE.test(message);
}

function isLLMTransportNetworkSignal(message: string): boolean {
  return (
    CONNECTION_ERROR_MESSAGE_RE.test(message) ||
    STREAM_DISCONNECT_MESSAGE_RE.test(message) ||
    CHROMIUM_NETWORK_MESSAGE_RE.test(message) ||
    SAFE_TRANSPORT_NETWORK_MESSAGE_RE.test(message)
  );
}

function isLLMTransportNetworkCode(code: string | undefined): boolean {
  return code !== undefined && SAFE_NETWORK_CODES.has(code) && !isLLMTransportTimeoutCode(code);
}

function classifyQuotaSignalFromMessage(
  message: string,
): { status_code: LLMErrorStatusCode; message: string } | null {
  if (
    /\b(?:1400010161|1008)\b/u.test(message) ||
    /credits?\s+exhausted/i.test(message) ||
    /insufficient\s+balance/i.test(message)
  ) {
    return { status_code: LLM_ERROR_CODES.LLM_CREDITS_EXHAUSTED, message };
  }

  if (
    LLM_USAGE_LIMIT_UPSTREAM_STATUS_CODE_RE.test(message) ||
    /usage\s+limit\s+exceeded/i.test(message) ||
    /package\s+quota\s+has\s+reached(?:\s+its)?\s+limit/i.test(message)
  ) {
    return { status_code: LLM_ERROR_CODES.USAGE_LIMIT_EXCEEDED, message };
  }

  if (/\bhibernation\b/i.test(message)) {
    return { status_code: LLM_ERROR_CODES.LLM_CREDITS_EXHAUSTED, message };
  }

  if (/requests?\s+(?:are\s+)?too\s+frequent/i.test(message)) {
    return { status_code: LLM_ERROR_CODES.LLM_RATE_LIMITED, message };
  }

  return null;
}

function fallbackMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'LLM call failed';
}
