/**
 * The text a BYOK stream writes when the user's own provider fails, and the one
 * reader every consumer uses: the Runtime's session status, the harness Turn
 * outcome, the retry layer, the UI and the LLM error classifier. Keeping both
 * here means a change to the format reaches every reader at once.
 *
 * Format: `BYOK upstream error: {json}`, whose `message` is
 * `BYOK provider <id> upstream error: <detail>`. Older Runtimes wrote only
 * that inner sentence, which still parses.
 */

export const BYOK_UPSTREAM_ERROR_PREFIX = 'BYOK upstream error';
export const BYOK_UPSTREAM_ERROR_SOURCE = 'byok_upstream';

const LEGACY_BYOK_MESSAGE_RE =
  /^BYOK provider (?<providerId>.+?) upstream error:\s*(?<detail>[\s\S]*)$/u;
const ERROR_LINE_PREFIX_RE = /^\[Error\]\s*/iu;

export interface ByokErrorAttribution {
  /** The classified code the formatter recorded; absent for the legacy sentence. */
  readonly errorCode?: number;
  readonly message: string;
  readonly errorDetail: string;
  readonly errorProviderId: string;
}

/** The attributed failure text for one provider error. */
export function formatByokErrorAttribution(input: {
  readonly errorCode: number;
  readonly providerId: string;
  readonly detail: string;
}): string {
  return `${BYOK_UPSTREAM_ERROR_PREFIX}: ${JSON.stringify({
    errorCode: input.errorCode,
    message: `BYOK provider ${input.providerId} upstream error: ${input.detail}`,
    errorSource: BYOK_UPSTREAM_ERROR_SOURCE,
    errorDetail: input.detail,
    errorProviderId: input.providerId,
  })}`;
}

/**
 * Whether a failure text is already attributed, so it is not wrapped twice.
 * Exactly the texts the parser reads count, so a text is either read or
 * wrapped, never neither.
 */
export function isByokErrorAttribution(text: string): boolean {
  return parseByokErrorAttribution(text) !== undefined;
}

/** The provider and detail a BYOK failure text names, or undefined for any other text. */
export function parseByokErrorAttribution(
  text: string | undefined,
): ByokErrorAttribution | undefined {
  const raw = text === undefined ? undefined : normalizedText(text);
  if (!raw) return undefined;
  if (raw.startsWith(BYOK_UPSTREAM_ERROR_PREFIX)) {
    const payload = readEnvelope(raw);
    const attributed = payload ? attributionFromPayload(payload) : undefined;
    if (attributed) return attributed;
  }
  return parseLegacyMessage(raw);
}

/**
 * The provider's own error text inside a failure text, for classifying it:
 * the attribution names a user-chosen provider id, which is not an error
 * signal. Any other text comes back normalized like an attribution would be
 * (trimmed, without an `[Error]` line prefix). An envelope whose detail did not
 * survive gives undefined, so nothing in its metadata is read as the error.
 */
export function byokProviderErrorDetail(text: string): string | undefined {
  const raw = normalizedText(text);
  if (raw.startsWith(BYOK_UPSTREAM_ERROR_PREFIX)) {
    const payload = readEnvelope(raw);
    const inner = trimmedText(payload?.errorDetail) ?? trimmedText(payload?.message);
    if (!inner) return undefined;
    return legacyDetail(inner) ?? inner;
  }
  return legacyDetail(raw) ?? raw;
}

/** Surrounding space and an `[Error]` line prefix are not part of the attribution. */
function normalizedText(text: string): string {
  return text.trim().replace(ERROR_LINE_PREFIX_RE, '');
}

function legacyDetail(raw: string): string | undefined {
  return LEGACY_BYOK_MESSAGE_RE.exec(raw)?.groups?.detail?.trim();
}

function parseLegacyMessage(raw: string): ByokErrorAttribution | undefined {
  const match = LEGACY_BYOK_MESSAGE_RE.exec(raw);
  const providerId = match?.groups?.providerId?.trim();
  const detail = match?.groups?.detail?.trim();
  return providerId && detail
    ? { message: raw, errorDetail: detail, errorProviderId: providerId }
    : undefined;
}

function attributionFromPayload(
  payload: Readonly<Record<string, unknown>>,
): ByokErrorAttribution | undefined {
  const message = typeof payload.message === 'string' ? payload.message.trim() : '';
  const legacy = message ? parseLegacyMessage(message) : undefined;
  const providerId = trimmedText(payload.errorProviderId) ?? legacy?.errorProviderId;
  const detail = trimmedText(payload.errorDetail) ?? legacy?.errorDetail;
  if (!providerId || !detail) return undefined;
  return {
    ...(typeof payload.errorCode === 'number' ? { errorCode: payload.errorCode } : {}),
    message: message || `BYOK provider ${providerId} upstream error: ${detail}`,
    errorDetail: detail,
    errorProviderId: providerId,
  };
}

function readEnvelope(raw: string): Readonly<Record<string, unknown>> | undefined {
  return parseJsonObject(raw) ?? readEnvelopeFields(raw);
}

function parseJsonObject(raw: string): Readonly<Record<string, unknown>> | undefined {
  const start = raw.indexOf('{');
  if (start < 0) return undefined;
  try {
    const parsed = JSON.parse(raw.slice(start)) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Error extraction may cut the envelope after its first `message` field.
 * Decode the string fields that are still complete, so a cut envelope still
 * names its provider and detail.
 */
function readEnvelopeFields(raw: string): Readonly<Record<string, unknown>> | undefined {
  const fields: Record<string, unknown> = {};
  for (const key of ['message', 'errorDetail', 'errorProviderId']) {
    const encoded = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`, 'u').exec(raw)?.[1];
    if (!encoded) continue;
    try {
      fields[key] = JSON.parse(encoded) as unknown;
    } catch {
      // A field cut inside an escape stays unread.
    }
  }
  const errorCode = /"errorCode"\s*:\s*(\d+)/u.exec(raw)?.[1];
  if (errorCode) fields.errorCode = Number(errorCode);
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function trimmedText(value: unknown): string | undefined {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}
