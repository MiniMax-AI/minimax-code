// Keep the original patterns on modern engines and select the legacy path once.
const EMPHASIS_PATTERNS = (() => {
  try {
    return {
      // eslint-disable-next-line prefer-regex-literals -- The constructor lets older iOS versions catch unsupported syntax and use the fallback.
      asterisk: new RegExp('(?<!\\*)\\*(?=\\S)([\\s\\S]*?\\S)\\*(?!\\*)', 'gu'),
      // eslint-disable-next-line prefer-regex-literals -- The constructor lets older iOS versions catch unsupported syntax and use the fallback.
      underscore: new RegExp('(?<!_)_(?=\\S)([\\s\\S]*?\\S)_(?!_)', 'gu'),
      replacement: '$1',
    };
  } catch {
    return {
      asterisk: /(^|[^*])\*(?=\S)([\s\S]*?\S)\*(?!\*)/gu,
      underscore: /(^|[^_])_(?=\S)([\s\S]*?\S)_(?!_)/gu,
      replacement: '$1$2',
    };
  }
})();

const CHAT_CONTEXT_BLOCK_RE =
  /<(user-provided-context|mavis-chat-context|html-selection-context)\b[^>]*>([\s\S]*?)(?:<\/\1\s*>|$)/giu;
const NAVIGATION_BLOCK_RE =
  /<(agent-message|agent-context|system-reminder|peer-memory-path|deployed-website-context|engine-message|inbound-context|archon_internal_context|locale-context|runtime-data-context|permission-ask|permission-response|questionnaire-ask|questionnaire-response|deliver-assets|deliver_assets|mavis-thinking)\b[^>]*>[\s\S]*?<\/\1\s*>/giu;
const MEDIA_TAG_RE = /<media\b[^>]*\/?\s*>/giu;
const UNICODE_WHITESPACE_RE = /\s+/gu;
const USER_COMMENT_MARKER_RE = /^User comment \(requested change\):[ \t]*(.*)$/u;
const USER_REQUESTED_EDIT_MARKER_RE = /^Requested edit for this selected PPT region:[ \t]*(.*)$/u;
const USER_COMMENT_SUMMARY_RE = /^\d+\.\s+Comment \d+:[ \t]*(.+)$/u;
const UNTRUSTED_EVIDENCE_RE = /^Untrusted .+ evidence\b/iu;
const TRANSPORT_CONTEXT_MARKER_RE =
  /(?:^|\n)\s*(?:# Added chat context|(?:## )?(?:Selection sessions|User requested changes|Requested edits)|User comment \(requested change\):|Requested edit for this selected PPT region:|USER REQUEST \(user-authored\):|Untrusted .+ evidence\b|UNTRUSTED PPTX LOCATOR EVIDENCE)/iu;

function compactWhitespace(value: string): string {
  return value.trim().replace(UNICODE_WHITESPACE_RE, ' ');
}

function extractUserComments(blockBody: string): string[] {
  const lines = blockBody.replace(/\r\n?/gu, '\n').split('\n');
  const summaryFallbacks: string[] = [];
  const comments: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    const summaryMatch = USER_COMMENT_SUMMARY_RE.exec(line);
    if (summaryMatch?.[1]) summaryFallbacks.push(summaryMatch[1].trim());

    const markerMatch = USER_COMMENT_MARKER_RE.exec(line);
    const requestedEditMatch = USER_REQUESTED_EDIT_MARKER_RE.exec(line);
    if (!markerMatch && !requestedEditMatch) continue;

    const commentLines: string[] = [];
    const inlineComment = (markerMatch?.[1] ?? requestedEditMatch?.[1])?.trim();
    if (inlineComment) commentLines.push(inlineComment);

    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor]?.trim() ?? '';
      if (
        !candidate ||
        UNTRUSTED_EVIDENCE_RE.test(candidate) ||
        USER_COMMENT_MARKER_RE.test(candidate) ||
        USER_REQUESTED_EDIT_MARKER_RE.test(candidate)
      )
        break;
      commentLines.push(candidate);
    }

    const comment = markdownToPlainText(commentLines.join('\n'));
    if (comment) comments.push(comment);
  }

  return comments.length > 0 ? comments : summaryFallbacks.map(markdownToPlainText);
}

function markdownToPlainText(markdown: string): string {
  return compactWhitespace(
    markdown
      .replace(/\r\n?/gu, '\n')
      .replace(/^[ \t]{0,3}(?:[-*_][ \t]*){3,}$/gmu, '')
      .replace(/^[ \t]{0,3}(?:`{3,}|~{3,})[^\n]*$/gmu, '')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gmu, '')
      .replace(/^[ \t]{0,3}>[ \t]?/gmu, '')
      .replace(/^[ \t]*(?:[-+*]|\d+[.)])[ \t]+/gmu, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
      .replace(/(`+)([\s\S]*?)\1/gu, '$2')
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/gu, '$2')
      .replace(/~~(?=\S)([\s\S]*?\S)~~/gu, '$1')
      .replace(EMPHASIS_PATTERNS.asterisk, EMPHASIS_PATTERNS.replacement)
      .replace(EMPHASIS_PATTERNS.underscore, EMPHASIS_PATTERNS.replacement)
      .replace(/\\([\\`*_[\]{}()#+\-.!>])/gu, '$1'),
  );
}

function isClosedContextMatch(match: RegExpMatchArray): boolean {
  return /<\/(user-provided-context|mavis-chat-context|html-selection-context)\s*>$/iu.test(
    match[0] ?? '',
  );
}

function isTransportContextMatch(match: RegExpMatchArray): boolean {
  return isClosedContextMatch(match) || TRANSPORT_CONTEXT_MARKER_RE.test(match[2] ?? '');
}

function stripContextMatches(content: string, matches: RegExpMatchArray[]): string {
  let result = '';
  let cursor = 0;
  for (const match of matches) {
    const start = match.index ?? cursor;
    result += content.slice(cursor, start);
    cursor = start + (match[0]?.length ?? 0);
  }
  return result + content.slice(cursor);
}

/**
 * Projects protocol-wrapped Markdown message content into readable navigation copy.
 * User-authored comments are projected first in source order, followed by any
 * remaining visible body text. Protocol wrappers are never exposed.
 */
export function toNavigationPlainText(content: string | undefined): string {
  if (!content) return '';

  const contextMatches = Array.from(content.matchAll(CHAT_CONTEXT_BLOCK_RE)).filter(
    isTransportContextMatch,
  );
  const contextComments = contextMatches.flatMap((match) => extractUserComments(match[2] ?? ''));
  const visibleBody = markdownToPlainText(
    stripContextMatches(content, contextMatches)
      .replace(NAVIGATION_BLOCK_RE, '')
      .replace(MEDIA_TAG_RE, ''),
  );

  return markdownToPlainText([...contextComments, visibleBody].filter(Boolean).join('\n'));
}
