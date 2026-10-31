import { createHash } from 'node:crypto';

/** Line endings and outer whitespace are presentation variance. */
function normalizePresentation(text: string): string {
  return text.replace(/\r\n?|\n/gu, '\n').trim();
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Build the durable no-progress fingerprint for one main-worker reply:
 * `<digit-insensitive sha256>:<exact sha256>`. The first part replaces every
 * run of decimal digits with one placeholder, so a status that only advances a
 * counter or a clock ("running for 80 minutes" → "81 minutes") still reads as
 * the same reply; the second part keeps the reply as written. All other
 * content stays semantic.
 */
export function fingerprintThreadGoalReply(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const normalized = normalizePresentation(text);
  if (!normalized) return undefined;
  return `${sha256(normalized.replace(/\p{Nd}+/gu, '#'))}:${sha256(normalized)}`;
}

/**
 * How a reply fingerprint compares with the previous one: the same reply word
 * for word, the same reply once its numbers are ignored, or a different reply.
 * A fingerprint stored before the two-part format compares whole, so it can
 * only ever be `exact` or `different`.
 */
export function compareThreadGoalReplyFingerprints(
  previous: string | null,
  next: string,
): 'exact' | 'numbers_only' | 'different' {
  if (previous === null) return 'different';
  if (previous === next) return 'exact';
  const [previousLoose, previousExact] = previous.split(':');
  const [nextLoose, nextExact] = next.split(':');
  if (previousExact === undefined || nextExact === undefined) return 'different';
  return previousLoose === nextLoose ? 'numbers_only' : 'different';
}

/**
 * Build the no-progress fingerprint for one committed tool call: the tool, its
 * arguments with object keys in a stable order, and the text it returned. Two
 * calls share a fingerprint when a Turn asked the same thing and got the same
 * answer, such as polling a file listing that has not changed.
 *
 * Arguments and result are compared exactly, digits included: `batch-1.json`
 * and `batch-2.json` are different files, whether asked for or returned.
 */
export function fingerprintThreadGoalToolCall(call: {
  readonly name: string;
  readonly arguments: unknown;
  readonly result: string;
}): string {
  return sha256(
    [call.name, stableStringify(call.arguments), normalizePresentation(call.result)].join('\u0000'),
  );
}

function stableStringify(value: unknown): string {
  return (
    JSON.stringify(value, (_key, entry: unknown) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return entry;
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        ),
      );
    }) ?? ''
  );
}
