import type { LLMCallFailure } from '@mavis/agent-core/pi-turn-runner';

/**
 * Host-side failure classification for BYOK multi-key rotation: pure functions over a failed call's HTTP
 * status and error words, with no I/O. Ported in part from an MIT-licensed project (see
 * THIRD_PARTY_NOTICES.md). It only supplements a
 * provider's own classification; it never sees credentials.
 */
type GenericFailureKind =
  | 'restricted'
  | 'overflow'
  | 'quota'
  | 'credit'
  | 'rate-limit'
  | 'model'
  | 'credential'
  | 'network'
  | 'other';

export interface FailureEvidence {
  readonly status?: number;
  readonly text: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface GenericFailure {
  readonly kind: GenericFailureKind;
  readonly status?: number;
  /** Vendor-supplied recovery timestamp in Unix ms. */
  readonly retryAtMs?: number;
}

const MINUTE_MS = 60_000;

/** Used only when the vendor says nothing about when the account is back. */
export const FAILOVER_DEFAULT_COOLDOWN_MS: Readonly<{
  quota: number;
  credit: number;
  'rate-limit': number;
}> = Object.freeze({ quota: 15 * MINUTE_MS, credit: 30 * MINUTE_MS, 'rate-limit': MINUTE_MS });

/** Error words beyond this are not read: the classification needs the head, not a whole body. */
const MAX_TEXT = 16 * 1024;
/** A reset time further off than a week is more likely a misreading than a reset. */
const LONGEST_RESET_MS = 7 * 24 * 60 * MINUTE_MS;

// --- words ---

/** The account or key has no money left ("balancer", as in a load balancer, is not). */
const creditWords =
  /insufficient.?(balance|credit|fund)|balance(?!r)|credit|billing|payment|arrear|overdue|suspended|余额|欠费|充值|账户.*(不足|停)/i;
/** A 429 that says the balance itself is spent (Zhipu 1113, upstream gateway). */
const brokeWords =
  /insufficient.?(balance|credit|fund)|\bcredits? (are )?exhausted\b|余额不足|欠费|请充值/i;
/** Used up what the plan allows for now. */
const usedUpWords =
  /quota|usage.?limit|out of budget|budget (exceeded|exhausted)|limit.?reached|hit your .*limit|limit.{0,24}resets|exceeded.*(plan|limit)|额度|用量|套餐|上限|限额/i;
/** A 429 that is a short rate limit: requests or tokens per second/minute. */
const rateWords =
  /rate.?limit|too many requests|per.?(second|sec|minute|min)\b|\b[rt]pm\b|频率|太频繁|请求过于频繁/i;
/** A 429 that says the plan's own allowance is used, rate words or not. */
const plannedWords =
  /quota|usage.?limit|hit your .*limit|limit.{0,24}resets|per.?(day|week|month)|daily|weekly|monthly|额度|用量|套餐|限额已用完/i;
/** A vendor's own code for a used-up allowance, which alone makes a 5xx one over the quota. */
const quotaCodes = /limit reached\|\d{10}\b|usage_limit_reached|RESOURCE_EXHAUSTED/i;
/** Claude Code's "usage limit reached|<unix seconds>". */
const resetsWords = /limit reached\|(\d{10})\b/i;
/** A reset time in words beside a whole date, time and offset (upstream gateway). */
const resetsWhen =
  /(?:\bresets? at|将在|将于)\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})\s*(?:UTC|GMT)([+-])(\d{1,2})(?::?(\d{2}))?(?:\s*(?:重置|[,.;，。；]))/i;
/**
 * Zhipu's 1308 / 1310 (GLM Coding Plan) write the reset time without a zone;
 * it is Beijing time (UTC+8). Only these words, then a whole date and a time to the minute at
 * least, with no digit, colon or zone after it (one with a zone is resetsWhen's).
 */
const zhipuResets =
  /(?:\bYour limit will reset at|您的限额将在)\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(\s*\S{0,3})/u;
const ZHIPU_OFFSET_MS = 8 * 60 * MINUTE_MS;
/** "Try again in 23h 59m" (Cline's free-model refusal), days/hours/minutes. */
const tryAgainIn =
  /\btry again in (?:(\d+)\s*d(?:ays?)?\b\s*)?(?:(\d+)\s*h(?:ours?|rs?)?\b\s*)?(?:(\d+)\s*m(?:in(?:utes?|s)?)?\b)?/iu;
/**
 * The vendor restricted the account itself (upstream gateway
 * 11140, "账号存在异常行为，已被限制使用", #1849). An appeal lifts it, not a wait.
 */
const restrictedWords =
  /account has been restricted due to unusual activity|账号存在异常行为|帳號存在異常行為|已被限制使用/iu;
/** "Out of quota" or "slow down" said without a status that does. */
const quotaWords =
  /quota|insufficient|balance|credit|billing|out of budget|budget (exceeded|exhausted)|exceeded|rate.?limit|usage.?limit|limit.?reached|hit your .*limit|limit.{0,24}resets|too many requests|overloaded|余额|额度|欠费|限流|频率|套餐|用量|上限/i;
/** The model isn't one the vendor serves this key / plan. */
const unservedWords =
  /model.{0,80}(not (supported|accessible|available|found|enabled|allowed)|unsupported|does ?n[o']t exist|unknown|invalid)|(no such|unknown|invalid|unsupported) model|model_not_found|not have access to (the )?model|模型.{0,12}(不存在|不支持|无权|未开通)/i;
/** A 404 that is about the model, not the route. */
const missingModelWords =
  /model_not_found|model.{0,80}(not found|does ?n[o']t exist)|模型.{0,12}不存在/i;
/** The vendor won't take requests from this client at all. */
const refusedWords = /unapproved channel|illegal api invocation/i;
/** The conversation is more than the model's context holds (as vendors word it). */
const tooLongRe = new RegExp(
  [
    "context_length_exceeded|prompt is too long|input is too long|(exceeds?|exceeded|over|beyond)( the)?( model'?s?)?( maximum)? context",
    'context (length|limit|window) (exceeded|is exceeded)|maximum context length|too many (input |prompt )?tokens',
    '上下文(长度)?(超|过长)|超(过|出)(了)?(模型)?(的)?(最大)?上下文',
    "input token count.*exceeds the maximum|maximum prompt length is \\d|reduce the length of the messages|maximum allowed input length|longer than the model'?s context length",
    'available context size|greater than the context length|prompt token count of [\\d,]+ exceeds the limit|context window exceeds limit|exceeded model token limit',
    'configured context size|prompt too long|prompt exceeds max length|context_window_exceeded|exceeded (max |maximum )?context length',
    'range of input length should be|token limit exceeded|input tokens? (count )?(exceeds?|exceeded) (the )?(max(imum)? )?limit',
  ].join('|'),
  'i',
);
/** A limit on how fast or how much, not on one prompt's size. */
const paceWords =
  /rate.?limit|per (minute|hour|day)|\bTP[MD]\b|please wait|try again later|throttl/i;

// --- evidence ---

function errorStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599
    ? value
    : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

const STATUS_IN_TEXT = [
  /^\s*([45]\d\d)\b/u,
  /\(([45]\d\d)\)/u,
  /\bcodex_http_([45]\d\d)\b/u,
  /\bstatus(?:[ _]code)?\s*[:=]\s*([45]\d\d)\b/iu,
];

function statusInText(text: string): number | undefined {
  for (const pattern of STATUS_IN_TEXT) {
    const match = pattern.exec(text);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * What a failed call says about itself. A non-error response status (a stream that opened 200
 * then failed) is not a verdict, so the thrown error and the words are read next.
 */
export function failureEvidence(failure: LLMCallFailure): FailureEvidence {
  const thrown = record(failure.thrown);
  const raw =
    textOf(failure.final?.errorMessage) ??
    textOf(thrown?.message) ??
    textOf(thrown?.errorMessage) ??
    '';
  const text = raw.length > MAX_TEXT ? raw.slice(0, MAX_TEXT) : raw;
  const status =
    errorStatus(failure.response?.status) ??
    errorStatus(thrown?.status) ??
    errorStatus(thrown?.statusCode) ??
    statusInText(text);
  const headers = failure.response?.headers;
  return {
    ...(status === undefined ? {} : { status }),
    text,
    ...(headers ? { headers } : {}),
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // pi prefixes SDK error bodies with their status ("429 {...}").
    const start = text.search(/[{[]/u);
    if (start <= 0) return undefined;
    try {
      return JSON.parse(text.slice(start)) as unknown;
    } catch {
      return undefined;
    }
  }
}

/**
 * A JSON body that escapes non-ASCII as \uXXXX has its strings decoded and put
 * after it, one per line, so "用量" or "将在 … 重置" are read either way. Other text is unchanged.
 * @internal Exported for focused tests.
 */
export function decodedWords(text: string): string {
  if (!text.includes('\\u')) return text;
  const value = parseJson(text);
  if (value === undefined || typeof value !== 'object' || value === null) return text;
  const parts: string[] = [text];
  const walk = (item: unknown, depth: number): void => {
    if (depth > 32) return;
    if (typeof item === 'string') parts.push(item);
    else if (Array.isArray(item)) for (const entry of item) walk(entry, depth + 1);
    else if (typeof item === 'object' && item !== null)
      for (const entry of Object.values(item)) walk(entry, depth + 1);
  };
  walk(value, 0);
  return parts.join('\n');
}

// --- reset times ---

function within(atMs: number, nowMs: number): number | undefined {
  return Number.isSafeInteger(atMs) && atMs > nowMs && atMs - nowMs <= LONGEST_RESET_MS
    ? atMs
    : undefined;
}

/** Unix seconds (10 digits) or ms (13 digits). */
function unixToMs(value: number): number {
  return value < 100_000_000_000 ? value * 1000 : value;
}

/** The instant a written date and time names in UTC; undefined when it isn't a real one. */
function exactUtc(parts: readonly number[]): number | undefined {
  const [y = 0, mo = 0, d = 0, h = 0, mi = 0, s = 0] = parts;
  const at = Date.UTC(y, mo - 1, d, h, mi, s);
  const back = new Date(at);
  // A date Date.UTC had to carry over (2026-13-45, 24:61) is not one.
  const same = [
    back.getUTCFullYear(),
    back.getUTCMonth() + 1,
    back.getUTCDate(),
    back.getUTCHours(),
    back.getUTCMinutes(),
    back.getUTCSeconds(),
  ].every((value, index) => value === parts[index]);
  return same ? at : undefined;
}

function writtenReset(words: string, nowMs: number): number | undefined {
  const match = resetsWhen.exec(words);
  if (!match) return undefined;
  const offH = Number(match[8]);
  const offM = Number(match[9] ?? 0);
  if (offH > 14 || offM > 59) return undefined;
  const local = exactUtc(match.slice(1, 7).map(Number));
  if (local === undefined) return undefined;
  const offset = (match[7] === '-' ? -1 : 1) * (offH * 60 + offM) * MINUTE_MS;
  return within(local - offset, nowMs);
}

/** The time a Zhipu 1308 / 1310 names, read in Beijing time. */
function zhipuReset(words: string, nowMs: number): number | undefined {
  const match = zhipuResets.exec(words);
  if (!match) return undefined;
  // Cut in its seconds ("20:12:1") or a zone after it: not this form.
  const after = (match[7] ?? '').trimStart();
  if (/^(?:[0-9:+\-Z]|UTC|GMT)/iu.test(after)) return undefined;
  const local = exactUtc(match.slice(1, 7).map((part) => Number(part ?? 0)));
  return local === undefined ? undefined : within(local - ZHIPU_OFFSET_MS, nowMs);
}

/** How long the words say until the account is back. */
function tryAgainAt(words: string, nowMs: number): number | undefined {
  const match = tryAgainIn.exec(words);
  if (!match || !(match[1] || match[2] || match[3])) return undefined;
  const ms =
    (Number(match[1] ?? 0) * 24 * 60 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) *
    MINUTE_MS;
  return ms > 0 ? within(nowMs + ms, nowMs) : undefined;
}

/** The reset time the body states (not headers); undefined when none is usable. */
function bodyResetAt(words: string, nowMs: number): number | undefined {
  const limitReset = resetsWords.exec(words);
  if (limitReset) {
    const at = within(Number(limitReset[1]) * 1000, nowMs);
    if (at !== undefined) return at;
  }
  const resetsAt = /"resets?_at"\s*:\s*"?(\d{10,13})\b/u.exec(words);
  if (resetsAt) {
    const at = within(unixToMs(Number(resetsAt[1])), nowMs);
    if (at !== undefined) return at;
  }
  const resetsIn = /"resets?_in_seconds"\s*:\s*"?(\d{1,9})\b/u.exec(words);
  if (resetsIn) {
    const at = within(nowMs + Number(resetsIn[1]) * 1000, nowMs);
    if (at !== undefined) return at;
  }
  return writtenReset(words, nowMs) ?? zhipuReset(words, nowMs);
}

function header(
  headers: Readonly<Record<string, string>> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  for (const [key, value] of Object.entries(headers))
    if (key.toLowerCase() === name && typeof value === 'string') return value.trim();
  return undefined;
}

function headerResetAt(
  headers: Readonly<Record<string, string>> | undefined,
  nowMs: number,
): number | undefined {
  const ms = header(headers, 'retry-after-ms');
  if (ms && /^\d+(\.\d+)?$/u.test(ms)) {
    const at = within(nowMs + Math.ceil(Number(ms)), nowMs);
    if (at !== undefined) return at;
  }
  const after = header(headers, 'retry-after');
  if (!after) return undefined;
  if (/^\d+(\.\d+)?$/u.test(after)) return within(nowMs + Math.ceil(Number(after) * 1000), nowMs);
  const date = Date.parse(after);
  return Number.isFinite(date) ? within(date, nowMs) : undefined;
}

/**
 * When the vendor says the account is back, as absolute Unix ms: Claude Code's
 * "limit reached|<unix>", ChatGPT's resets_at / resets_in_seconds, a time written with its offset
 * beside the reset words, then Retry-After / retry-after-ms. Past or over-a-week times are ignored.
 * @internal Exported for focused tests.
 */
export function resetsAtMs(evidence: FailureEvidence, nowMs: number): number | undefined {
  const words = decodedWords(evidence.text);
  return (
    bodyResetAt(words, nowMs) ??
    // "Try again in …" only sets the time, never the verdict (a rate limit may say it too).
    tryAgainAt(words, nowMs) ??
    headerResetAt(evidence.headers, nowMs)
  );
}

/**
 * A 401 that says the sign-in itself is gone (not expired for
 * a refresh to mend). No wait mends it: only a new sign-in does.
 */
const revokedWords =
  /\btoken_revoked\b|\btoken_invalidated\b|\brefresh_token_(reused|invalidated|expired)\b|\binvalid_grant\b|invalidated oauth token|(token|sign-in) (has been|was) revoked/iu;

export function signInRevokedSaid(evidence: FailureEvidence): boolean {
  return evidence.status === 401 && revokedWords.test(decodedWords(evidence.text));
}

/**
 * The prefix agent-core's stream watchdog puts in front of a synthesized timeout
 * (llm-stream-timeout.ts LLM_STREAM_TIMEOUT_MESSAGE_PREFIX, then ": no response …" for the first
 * event or ": the provider stream was idle …"). The bare "LLM request timed out" (no colon) is
 * the logical call's own deadline, which is not an account's slowness.
 */
const LLM_STREAM_TIMEOUT_PREFIX = 'LLM request timed out:';

const STREAM_TIMEOUT_CODES = new Set(['llm_first_event_timeout', 'llm_stream_idle_timeout']);

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

/**
 * A failed attempt that never produced its first token in time. Read from
 * agent-core's marker when present (a `mavis.llm_stream_failure` diagnostic on the final message,
 * or `code` / `errorKind: 'timeout'` / `timeoutPhase` on the thrown error), else from the
 * watchdog's message prefix. Another stream-layer failure (empty reply, loop) is not slowness. Only uncommitted attempts reach the pool,
 * so an idle timeout seen here also stalled before any output.
 * @internal Exported for focused tests.
 */
export function firstTokenTimeout(failure: LLMCallFailure): boolean {
  const marked = markedStreamTimeout(failure.final);
  if (marked !== undefined) return marked;
  if ([failure.thrown, failure.final].some(timeoutFields)) return true;
  const text = textOf(failure.final?.errorMessage) ?? textOf(field(failure.thrown, 'message'));
  return typeof text === 'string' && text.startsWith(LLM_STREAM_TIMEOUT_PREFIX);
}

/**
 * agent-core's stream-failure marker: final.diagnostics[] { type: 'mavis.llm_stream_failure',
 * error: { code } } (llm-stream-failure.ts). Read structurally; the newest one decides.
 * Undefined when there is none.
 */
function markedStreamTimeout(final: unknown): boolean | undefined {
  const diagnostics = (final as { readonly diagnostics?: unknown } | undefined)?.diagnostics;
  if (!Array.isArray(diagnostics)) return undefined;
  const marker = [...diagnostics]
    .reverse()
    .find((item: unknown) => field(item, 'type') === 'mavis.llm_stream_failure');
  return marker === undefined
    ? undefined
    : STREAM_TIMEOUT_CODES.has(field(field(marker, 'error'), 'code') as string);
}

/** `errorKind: 'timeout'`, a first/idle `timeoutPhase` or a stream timeout `code`. */
function timeoutFields(source: unknown): boolean {
  if (!source || typeof source !== 'object') return false;
  if (field(source, 'errorKind') === 'timeout') return true;
  const phase = field(source, 'timeoutPhase');
  if (phase === 'first' || phase === 'idle') return true;
  return STREAM_TIMEOUT_CODES.has(field(source, 'code') as string);
}

// --- the request, not the account ---

/**
 * The vendor turned the request's
 * content away (ChatGPT's "response protection is unavailable", a safety filter's refusal). The
 * account is not at fault and none of its provider's other accounts would take the same request.
 */
const protectionWords = /response protection is unavailable/i;
/**
 * upstream gateway): a system prompt refused as an unapproved channel,
 * the same for every account of the group; the extension ends it with this fixed hint.
 */
const channelRefused = /refused words in this client's prompt/;
const filterCodes =
  /["'](?:code|type)["']\s*:\s*["'](?:refusal|content_filter|content_policy_violation|SAFETY|PROHIBITED_CONTENT|BLOCKLIST|SPII|IMAGE_SAFETY|[a-z]+_policy)["']|stop_reason:? ?["']?refusal\b|finish_reason:? ?["']?content_filter\b/u;
const flaggedPrompt = /invalid_prompt[\s\S]{0,200}(flagged|usage polic)/i;
const highRisk =
  /^\s*(?:\d{3}\s+)?The request was rejected because it was considered high risk\s*$/u;

export function contentRefused(evidence: FailureEvidence): boolean {
  const words = decodedWords(evidence.text);
  return (
    protectionWords.test(words) ||
    channelRefused.test(words) ||
    filterCodes.test(words) ||
    flaggedPrompt.test(words) ||
    highRisk.test(words)
  );
}

/**
 * A 400 saying the reasoning level sent isn't one this account's plan takes
 * (a Free ChatGPT account and gpt-6-luna at high, #520): another account may take it, and this one
 * does not rest for it. A refusal of another field's value (text.verbosity) is not one.
 */
const unsupportedEffort = /unsupported value:?\s*['"`]?([a-z]+)['"`]?\s+is not supported/i;
const effortNamed = /reasoning[._ ]?effort/i;
const effortDenied =
  /not supported|unsupported|not available|isn'?t available|not allowed|invalid value|upgrade|your plan/i;

export function effortRefused(evidence: FailureEvidence, sent: string | undefined): boolean {
  if (!sent || (evidence.status !== undefined && evidence.status !== 400)) return false;
  const words = decodedWords(evidence.text);
  const param = /["']param["']\s*:\s*["']([^"']*)["']/u.exec(words)?.[1];
  if (param && !effortNamed.test(param)) return false;
  const m = unsupportedEffort.exec(words);
  if (m) return m[1]!.toLowerCase() === sent.toLowerCase();
  return effortNamed.test(words) && effortDenied.test(words);
}

/**
 * The vendor's firewall (Alibaba Cloud's 405 in front of zcode.z.ai) blocked
 * this address. Every account of that vendor sits behind it; another provider goes another way.
 */
const edgeWords =
  /request has been blocked|errors\.aliyun\.com|network firewall blocked requests from this IP/i;

export function edgeBlocked(evidence: FailureEvidence): boolean {
  return (evidence.status ?? 0) >= 400 && edgeWords.test(decodedWords(evidence.text));
}

/** The proxy itself could not be reached; no account failed. */
const proxyDownWords =
  /proxyconnect |socks connect |ECONNREFUSED[^\n]{0,80}proxy|proxy[^\n]{0,40}(ECONNREFUSED|refused|unreachable|tunnel)/i;

export function proxyDown(evidence: FailureEvidence): boolean {
  return evidence.status === undefined && proxyDownWords.test(evidence.text);
}

/**
 * A 403 that says nothing of why (no quota, credit, rate, restriction, a
 * model not served). One such 403 may be the account's; the same from another account of the
 * provider is the request's.
 */
export function plainForbidden(evidence: FailureEvidence, nowMs: number): boolean {
  if (evidence.status !== 403) return false;
  const words = decodedWords(evidence.text);
  return (
    kindOf(403, words, nowMs) === 'other' &&
    !restrictedWords.test(words) &&
    !contentRefused(evidence)
  );
}

// --- classification ---

/**
 * A request error whose words say the conversation no longer fits. One about the
 * reply's max_tokens, or a rate limit counted in tokens, is not.
 */
function tooLong(status: number | undefined, words: string): boolean {
  if (status !== undefined && status !== 400 && status !== 413 && status !== 422) return false;
  const lower = words.toLowerCase();
  if (
    lower.includes('max_tokens') ||
    lower.includes('max_output_tokens') ||
    lower.includes('max_completion_tokens')
  )
    return false;
  return !paceWords.test(words) && tooLongRe.test(words);
}

type Rule = (status: number | undefined, words: string, nowMs: number) => boolean;

const is5xx = (status: number | undefined): boolean => status !== undefined && status >= 500;
const insufficientQuota = (words: string): boolean => words.includes('insufficient_quota');

/** Ordered by precedence; the first that holds decides. */
const RULES: readonly (readonly [GenericFailureKind, Rule])[] = [
  // Our own marker is read whatever the status; the vendor's words only on an error status.
  [
    'restricted',
    (status, words) =>
      (status !== undefined && restrictedWords.test(words)),
  ],
  // Without an error status (a stream that failed after opening), words are read as a 400's are.
  ['overflow', (status, words) => tooLong(status, words)],
  [
    'quota',
    (status, words) =>
      status === 402 &&
      usedUpWords.test(words) &&
      !creditWords.test(words) &&
      !insufficientQuota(words),
  ],
  [
    'credit',
    (status, words) =>
      status === 402 ||
      (creditWords.test(words) && (status !== 429 || brokeWords.test(words))) ||
      insufficientQuota(words),
  ],
  // A 429 naming when the account is back is a used-up allowance, even once that time is read
  // as past or too far off (the time is then not used, the verdict is).
  [
    'quota',
    (status, words, nowMs) =>
      status === 429 && (resetsWhen.test(words) || bodyResetAt(words, nowMs) !== undefined),
  ],
  [
    'rate-limit',
    (status, words) => status === 429 && rateWords.test(words) && !plannedWords.test(words),
  ],
  [
    'quota',
    (status, words) =>
      (is5xx(status) && quotaCodes.test(words)) ||
      (!is5xx(status) && usedUpWords.test(words)) ||
      (status === 429 && plannedWords.test(words)),
  ],
  ['rate-limit', (status) => status === 429],
  [
    'model',
    (status, words) =>
      status === 403 &&
      unservedWords.test(words) &&
      !quotaWords.test(words) &&
      !refusedWords.test(words),
  ],
  ['other', (status) => status === 403],
  // 400 / 422 are never read as the model's: unsure means the account is not changed.
  [
    'model',
    (status, words) => status === 404 && missingModelWords.test(words) && !quotaWords.test(words),
  ],
  ['credential', (status) => status === 401],
  ['network', (status) => is5xx(status)],
];

function kindOf(status: number | undefined, words: string, nowMs: number): GenericFailureKind {
  return RULES.find(([, holds]) => holds(status, words, nowMs))?.[0] ?? 'other';
}

/** Why a call failed, by status and words, in rule order. */
export function classifyGenericFailure(evidence: FailureEvidence, nowMs: number): GenericFailure {
  const words = decodedWords(evidence.text);
  const status = errorStatus(evidence.status);
  const kind = kindOf(status, words, nowMs);
  const retryAtMs =
    kind === 'quota' || kind === 'credit' || kind === 'rate-limit'
      ? resetsAtMs(evidence, nowMs)
      : undefined;
  return {
    kind,
    ...(status === undefined ? {} : { status }),
    ...(retryAtMs === undefined ? {} : { retryAtMs }),
  };
}

