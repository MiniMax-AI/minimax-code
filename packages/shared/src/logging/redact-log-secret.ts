/**
 * Secret redaction for anything that leaves the process as text: runtime logs,
 * error messages surfaced to the user, and diagnostic bundles built from them.
 *
 * One vocabulary lives here so the log arm, the BYOK error arm, and any future
 * artifact writer cannot drift into covering different key names or patterns.
 *
 * The key list is deliberately a fixed set of unambiguous credential names. Bare
 * `token` / `tokens` / `key` are excluded on purpose: the runtime logs token
 * accounting fields (`context_usage`, `cache_read`, `tokens`) that users read for
 * throughput numbers, and blanket-redacting them destroys the signal.
 */

export const REDACTED = '***';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'proxyauthorization',
  'apikey',
  'apisecret',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'bearertoken',
  'sessiontoken',
  'bearertokens',
  'clientsecret',
  'clientsecrets',
  'clientappsecret',
  'accesskey',
  'accesskeyid',
  'accesskeysecret',
  'secretaccesskey',
  'privatekey',
  'signingkey',
  'credential',
  'credentials',
  'password',
  'passwd',
  'pwd',
  'cookie',
  'cookies',
  'jwt',
  'secret',
  'secrets',
]);

const API_KEY_LITERAL = /\bsk-[A-Za-z0-9._-]{8,}\b/gu;
// A credential header is `Authorization: <scheme> <payload>`. The scheme and the
// payload are separate tokens, so consuming only the first leaves the payload in
// clear: `Basic dXNlcjpwYXNz` used to lose `Basic` and keep the base64.
// The header runs to the end of its value, not to the next space: `Digest
// username="x", nonce="y"` is one credential spread over several fields. The
// scheme word stays so the line still says which auth was attempted.
const AUTHORIZATION_VALUE = /\b(authorization\s*[:=]\s*)((?:[A-Za-z][A-Za-z-]*)\s+)?[^,\n}]*/giu;
// Quoted JSON pairs sit next to a quote, which the unquoted value pattern cannot
// reach: `{"x-api-key":"..."}` matched nothing at all before this rule.
const QUOTED_NAMED_VALUE =
  /("(?:api[_-]?key|apikey|x-api-key|authorization|access[_-]?token|refresh[_-]?token|client[_-]?secret)"\s*:\s*)"(?:\\.|[^"\\])*"/giu;
const NAMED_KEY_VALUE = /((?:api[_-]?key|x-api-key|client[_-]?secret)\s*[:=]\s*)[^\s"',}]+/giu;
const BEARER_TOKEN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu;

/** Credential terms that also cover vendor-prefixed headers (`x-api-key`, …). */
const SENSITIVE_KEY_SUFFIXES = [
  'authorization',
  'apikey',
  'apisecret',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authtoken',
  'bearertoken',
  'sessiontoken',
  'clientsecret',
  'privatekey',
  'signingkey',
  'password',
  'passwd',
  'secret',
  'credential',
];

/** True when a structured field name denotes a credential. */
export function isSecretKey(key: string): boolean {
  const normalized = normalizeKey(key);
  return (
    SENSITIVE_KEYS.has(normalized) ||
    SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

/** Strips credential literals and `key: value` credential headers from a string. */
export function redactSecretText(text: string): string {
  return text
    .replace(API_KEY_LITERAL, `sk-${REDACTED}`)
    .replace(QUOTED_NAMED_VALUE, `$1"${REDACTED}"`)
    .replace(AUTHORIZATION_VALUE, (_match, prefix: string, scheme: string | undefined) =>
      `${prefix}${scheme ?? ''}${REDACTED}`,
    )
    .replace(NAMED_KEY_VALUE, `$1${REDACTED}`)
    .replace(BEARER_TOKEN, `$1${REDACTED}`);
}

const MAX_REDACTION_DEPTH = 8;
/** Branch was too deep to walk, or could not be enumerated. */
const TRUNCATED = '[truncated]';
/** Reference back to an ancestor already in this branch. */
const CIRCULAR = '[circular]';

/**
 * Returns a copy of `value` with credential fields and credential literals
 * removed. A branch that cannot be walked — past the depth cap, back to an
 * ancestor, or un-enumerable — becomes a marker string rather than the original
 * value, so no unredacted subtree can reach the log line.
 */
export function redactSecretValue<T>(value: T): T {
  return redactValue(value, new WeakSet<object>(), 0) as T;
}

/**
 * Every path that cannot finish redacting a branch yields a marker, never the
 * original value. Handing back the input at the depth cap, on a cycle, or when
 * enumeration throws would put an unredacted subtree straight into the log
 * line, which is the one outcome this function exists to prevent.
 */
function redactValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === 'string') return redactSecretText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_REDACTION_DEPTH) return TRUNCATED;
  if (seen.has(value)) return CIRCULAR;
  seen.add(value);

  try {
    if (Array.isArray(value)) {
      return value.map((entry) => redactValue(entry, seen, depth + 1));
    }
    const record: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      record[key] = isSecretKey(key) ? REDACTED : redactValue(entry, seen, depth + 1);
    }
    return record;
  } catch {
    return TRUNCATED;
  } finally {
    seen.delete(value);
  }
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

// YAML / JSON parse errors quote raw config lines (`appSecret: …`,
// `botToken: …`, `encryptKey: …`) that the fixed key set above does not name.
const MESSAGE_KEY_VALUE = /(?<![\w.-])((["']?)([\w.-]+)\2\s*[:=]\s*["']?)[^\s"',;}]+/gu;
const CREDENTIAL_KEY_PART =
  /secret|token|passw|credential|api[-_]?key|encrypt[-_]?key|aes[-_]?key/iu;

export interface RedactedErrorLogFacts {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly errorStackTop: string[];
}

/**
 * Bounded name / message / top stack frames of an unknown throwable for one
 * log line. Never spreads the error: only these three projections reach disk.
 * The message additionally redacts quoted `key: value` lines whose key merely
 * looks like a credential.
 */
export function redactErrorForLog(
  error: unknown,
  limits: { readonly messageChars: number; readonly stackFrames: number },
): RedactedErrorLogFacts {
  if (!(error instanceof Error)) {
    return {
      errorName: 'NonError',
      errorMessage: `non-Error throwable (${typeof error})`,
      errorStackTop: [],
    };
  }
  const message = redactSecretText(String(error.message)).replace(
    MESSAGE_KEY_VALUE,
    (match, prefix: string, _quote: string, key: string) =>
      isSecretKey(key) || CREDENTIAL_KEY_PART.test(key) ? `${prefix}${REDACTED}` : match,
  );
  return {
    errorName: error.name || 'Error',
    errorMessage:
      message.length > limits.messageChars
        ? `${message.slice(0, limits.messageChars)}…[truncated]`
        : message,
    errorStackTop: stackTopFrames(error.stack, limits.stackFrames),
  };
}

/** `fn (file.js:line)` for the first frames; directories (user home) dropped. */
function stackTopFrames(stack: unknown, limit: number): string[] {
  if (typeof stack !== 'string') return [];
  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    const frame = parseStackFrame(line);
    if (!frame) continue;
    const location = `${frame.file.split(/[\\/]/u).pop() ?? ''}:${frame.line}`;
    frames.push(frame.fn ? `${frame.fn} (${location})` : location);
    if (frames.length >= limit) break;
  }
  return frames;
}

const DIGITS = /^\d+$/u;

/**
 * `at [async] [fn (]file:line[:col][)]` parsed with index scans (no
 * backtracking regex over untrusted stack text).
 */
function parseStackFrame(raw: string): { fn?: string; file: string; line: string } | undefined {
  let rest = raw.trim();
  if (!rest.startsWith('at ')) return undefined;
  rest = rest.slice(3);
  if (rest.startsWith('async ')) rest = rest.slice(6);
  let fn: string | undefined;
  const open = rest.indexOf(' (');
  if (open > 0 && rest.endsWith(')')) {
    fn = rest.slice(0, open);
    rest = rest.slice(open + 2, -1);
  } else if (rest.endsWith(')')) {
    rest = rest.slice(0, -1);
  }
  const colon = rest.lastIndexOf(':');
  if (colon <= 0) return undefined;
  let line = rest.slice(colon + 1);
  let file = rest.slice(0, colon);
  const inner = file.lastIndexOf(':');
  if (inner > 0 && DIGITS.test(file.slice(inner + 1))) {
    line = file.slice(inner + 1);
    file = file.slice(0, inner);
  }
  if (!DIGITS.test(line) || !file) return undefined;
  return fn ? { fn, file, line } : { file, line };
}
