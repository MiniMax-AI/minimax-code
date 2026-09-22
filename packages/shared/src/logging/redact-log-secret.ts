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
