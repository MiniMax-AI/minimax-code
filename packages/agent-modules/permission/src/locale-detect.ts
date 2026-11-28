/**
 * User-language detection for localizing user-facing daemon output.
 *
 * # Why this exists
 *
 * Multiple daemon subsystems generate user-visible strings without going through an LLM (permission
 * decision reasons, team-plan engine notifications, etc.). Hardcoding English biases the UX for
 * English speakers; hardcoding Chinese biases the other way. This helper inspects recent user
 * messages and returns a coarse locale hint that callers can use to pick a localized template.
 *
 * # Scope
 *
 * Coarse classification only — `zh` (Chinese), `en` (English-like), or `unknown` (insufficient
 * signal). Callers must default to English when the hint is `unknown` to preserve backward
 * compatibility.
 *
 * # Heuristic
 *
 * Count CJK Han characters across the latest user messages. If the Han ratio is high enough (>= 20%
 * of non-whitespace characters), classify as `zh`. Otherwise classify as `en` when at least one
 * Latin letter is present, and `unknown` when there is no actionable signal (empty/only
 * symbols/numbers).
 *
 * The threshold is intentionally low — even a single Chinese instruction meaning "add Chinese
 * support to the feature above" wins over an English-heavy conversation, because the most recent
 * user instruction reflects current intent better than the long tail of prior turns.
 *
 * The classifier is **not** language detection in the linguistic sense — it is a one-bit signal:
 * "produce the Chinese template or the English template?". Treat any other language as `unknown`.
 */

import type { AgentMessageProtocol } from '@mavis/agent-core/protocol/agent-message';

/** Coarse user-language hint for picking localized templates. */
export type UserLocaleHint = 'zh' | 'en' | 'unknown';

/** Han (CJK Unified Ideographs) and Han-extension blocks (global, for ratio scan). */
// eslint-disable-next-line no-misleading-character-class -- intentional Unicode ranges
const HAN_REGEX_GLOBAL = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u{20000}-\u{2ffff}]/gu;
const LATIN_LETTER_REGEX = /[A-Za-z]/;

/** Han-character ratio threshold for classifying as `zh`. */
const HAN_RATIO_THRESHOLD = 0.2;

/**
 * Detect coarse user language from a single string.
 *
 * Returns `unknown` for empty input or input that is entirely whitespace /
 * symbols / numbers.
 */
export function detectTextLocale(text: string): UserLocaleHint {
  if (typeof text !== 'string') return 'unknown';
  const trimmed = text.trim();
  if (trimmed.length === 0) return 'unknown';

  // Strip whitespace before counting so the ratio reflects actual content.
  const compact = trimmed.replace(/\s+/g, '');
  if (compact.length === 0) return 'unknown';

  const hanMatches = compact.match(HAN_REGEX_GLOBAL);
  const hanCount = hanMatches ? hanMatches.length : 0;
  const hanRatio = hanCount / compact.length;

  if (hanRatio >= HAN_RATIO_THRESHOLD) return 'zh';
  if (LATIN_LETTER_REGEX.test(compact)) return 'en';
  return 'unknown';
}

/**
 * Detect coarse user language from a list of recent user messages.
 *
 * Strategy: scan the most-recent messages first; the first message that
 * yields a non-`unknown` verdict wins. This privileges the latest user
 * instruction over earlier turns.
 *
 * `messages` should contain only USER messages (or messages where the
 * `role` field is undefined and `msg_content` is treated as raw user
 * input). Callers should already filter assistant/tool messages so they
 * do not pollute the heuristic.
 *
 * Returns `unknown` when no message provides a usable signal.
 */
export function detectMessagesLocale(
  messages: ReadonlyArray<AgentMessageProtocol> | undefined,
): UserLocaleHint {
  if (!messages || messages.length === 0) return 'unknown';

  // Iterate newest-first. Callers typically pass messages in
  // recency order; we explicitly reverse to handle either input
  // direction (oldest-first DB rows OR newest-first peek output).
  // Cheaper: walk both ends and pick the most-recent non-empty one.
  // We accept the simplicity of reversing here — message context is
  // bounded to <10 entries per classifier call.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    const content = m.msg_content;
    if (!content) continue;
    const verdict = detectTextLocale(content);
    if (verdict !== 'unknown') return verdict;
  }
  return 'unknown';
}
