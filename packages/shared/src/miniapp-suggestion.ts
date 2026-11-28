import {
  findMarkdownProtectedRanges,
  isIndexInMarkdownProtectedRange,
  replaceMarkdownOutsideProtected,
} from './asset-markup/markdown-protected.js';

/** The complete model proposal. Structural rules are never variable inputs. */
export interface MiniAppSuggestionBrief {
  title: string;
  reason: string;
  accepted: string;
  rules: string;
  inputs: string;
  outputs: string;
}
const FIELDS = ['title', 'reason', 'accepted', 'rules', 'inputs', 'outputs'] as const;
// Comparison operators can appear in quoted rule values. Only a delimiter outside
// quotes ends the tag.
const SUGGESTION_TAG = /<genui-miniapp-suggestion(?=[\s/])((?:[^<>"]|"[^"]*")*?)\/>/gu;

/** Keeps the general GenUI parser's tag boundaries intact for quoted comparison rules. */
export function normalizeMiniAppSuggestionTags(text: string): string {
  if (!text.includes('<genui-miniapp-suggestion')) return text;
  return replaceMarkdownOutsideProtected(text, SUGGESTION_TAG, (tag, body) =>
    typeof body === 'string'
      ? `<genui-miniapp-suggestion${body.replaceAll('<', '&lt;').replaceAll('>', '&gt;')}/>`
      : tag,
  );
}

/** Removes generated card metadata from assistant prose while keeping code examples. */
export function stripMiniAppSuggestionTags(text: string): string {
  if (!text.includes('<genui-miniapp-suggestion')) return text;
  return replaceMarkdownOutsideProtected(text, SUGGESTION_TAG, '');
}

export function readMiniAppSuggestion(value: unknown): MiniAppSuggestionBrief | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const fields = value as Record<string, unknown>;
  if (Object.keys(fields).length !== FIELDS.length) return undefined;
  const brief = {} as MiniAppSuggestionBrief;
  let length = 0;
  for (const key of FIELDS) {
    const text = fields[key];
    if (typeof text !== 'string') return undefined;
    length += text.length;
    if (
      length > 6000 ||
      !text.trim() ||
      /^(?:[.\s…]+|tbd|todo|n\/a|待补充|待确认)$/iu.test(text.trim())
    )
      return undefined;
    brief[key] = text.trim();
  }
  return brief;
}

export function readMiniAppSuggestionResult(raw: unknown): MiniAppSuggestionBrief | undefined {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  const result = value as {
    isError?: boolean;
    details?: { kind?: string; miniapp_suggestion?: unknown };
  } | null;
  if (result?.isError || result?.details?.kind !== 'miniapp_suggestion') return undefined;
  return readMiniAppSuggestion(result.details.miniapp_suggestion);
}

export function readMiniAppSuggestionBrief(
  attributes: Record<string, string>,
): MiniAppSuggestionBrief | undefined {
  const brief = readMiniAppSuggestion(attributes);
  if (brief) for (const key of FIELDS) brief[key] = decode(brief[key]);
  return brief;
}

/** Only one complete tag outside Markdown code can be reviewed. */
export function miniAppSuggestionFromText(text: string): MiniAppSuggestionBrief | undefined {
  if (!text.includes('<genui-miniapp-suggestion')) return undefined;
  const protectedRanges = findMarkdownProtectedRanges(text);
  const outsideCode = ({ index }: RegExpMatchArray) =>
    index !== undefined && !isIndexInMarkdownProtectedRange(index, protectedRanges);
  const tags = [...text.matchAll(SUGGESTION_TAG)].filter(outsideCode);
  const starts = [...text.matchAll(/<genui-miniapp-suggestion\b/gu)].filter(outsideCode);
  if (tags.length !== 1 || starts.length !== 1) return undefined;
  const body = tags[0]?.[1];
  if (body === undefined) return undefined;
  const attributes: Record<string, string> = {};
  let offset = 0;
  while (offset < body.length) {
    const start = offset;
    while (offset < body.length && /\s/u.test(body[offset]!)) offset += 1;
    if (offset >= body.length) break;
    if (offset === start) return undefined;
    const keyStart = offset;
    while (offset < body.length) {
      const code = body.charCodeAt(offset);
      if (code < 97 || code > 122) break;
      offset += 1;
    }
    if (offset === keyStart) return undefined;
    const key = body.slice(keyStart, offset);
    if (Object.hasOwn(attributes, key)) return undefined;
    while (offset < body.length && isAsciiHtmlSpace(body.charCodeAt(offset))) offset += 1;
    if (body[offset] !== '=') return undefined;
    offset += 1;
    while (offset < body.length && isAsciiHtmlSpace(body.charCodeAt(offset))) offset += 1;
    if (body[offset] !== '"') return undefined;
    offset += 1;
    const closeQuote = body.indexOf('"', offset);
    if (closeQuote === -1) return undefined;
    attributes[key] = body.slice(offset, closeQuote);
    offset = closeQuote + 1;
  }
  return readMiniAppSuggestionBrief(attributes);
}

function isAsciiHtmlSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 13 || code === 10;
}

function decode(value: string): string {
  return value
    .replace(
      /&(?:quot|apos|lt|gt|amp);/gu,
      (entity) =>
        ({
          '&quot;': '"',
          '&apos;': "'",
          '&lt;': '<',
          '&gt;': '>',
          '&amp;': '&',
        })[entity] ?? entity,
    )
    .trim();
}
