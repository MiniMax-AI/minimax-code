import {
  parseDeliverAssetsContent,
  splitMarkdownProtectedSegments,
  type DeliverAssetItem,
  type DeliverAssetsSegment,
} from '@mavis/shared/asset-markup';
import { sanitizeTerminalText } from '../tui/rendering/terminal-text.js';

const RICH_CONTENT_RE =
  /<(?:deliver[-_]assets|media|publish[_-]artifact|preview_card|genui-|mavis-widget|mavis-thinking|mavis-progress|think|final|permission-(?:ask|response)|questionnaire-(?:ask|response))\b|^\s*preview_cards?:\s*$/imu;

export interface TerminalDeliveredAsset {
  readonly path: string;
  readonly name?: string;
}

export interface TerminalAssistantContent {
  readonly text: string;
  readonly assets: readonly TerminalDeliveredAsset[];
}

export function simplifyAssistantContentForTerminal(content: string): string {
  const presentation = projectAssistantContentForTerminal(content);
  if (presentation.assets.length === 0) return presentation.text;
  return [presentation.text, formatAssetGroup(presentation.assets)].filter(Boolean).join('\n\n');
}

export function projectAssistantContentForTerminal(rawContent: string): TerminalAssistantContent {
  // Model content is data. Only the renderer may introduce terminal controls.
  const content = sanitizeTerminalText(rawContent);
  if (!content || !RICH_CONTENT_RE.test(content)) return { text: content, assets: [] };

  const segments = splitMarkdownProtectedSegments(content);
  const protectedContent: string[] = [];
  const assets: DeliverAssetItem[] = [];
  let markerPrefix = '\uE000mcode-protected';
  while (content.includes(markerPrefix)) markerPrefix += '-';
  let changed = false;
  const simplified = segments
    .map((segment) => {
      if (segment.type === 'protected') {
        const index = protectedContent.push(segment.content) - 1;
        return `${markerPrefix}-${index}\uE001`;
      }
      if (!RICH_CONTENT_RE.test(segment.content)) {
        return segment.content;
      }
      changed = true;
      return simplifyUnprotectedContent(segment.content, assets);
    })
    .join('');

  if (!changed) return { text: content, assets: [] };
  let result = cleanVisibleText(simplified);
  protectedContent.forEach((value, index) => {
    result = result.replace(`${markerPrefix}-${index}\uE001`, value);
  });
  const uniqueAssets = [...new Map(assets.map((item) => [item.path.trim(), item])).values()];
  return {
    text: result,
    assets: uniqueAssets.map((item) => ({
      path: item.path.trim(),
      ...(item.name?.trim() ? { name: item.name.trim() } : {}),
    })),
  };
}

function simplifyUnprotectedContent(content: string, assets: DeliverAssetItem[]): string {
  let output = content;
  output = stripPairedBlocks(output, 'mavis-thinking');
  output = stripPairedBlocks(output, 'think');
  output = unwrapPairedBlocks(output, 'mavis-progress');
  output = stripPairedBlocks(output, 'permission-ask');
  output = stripPairedBlocks(output, 'permission-response');
  output = stripPairedBlocks(output, 'questionnaire-ask');
  output = stripPairedBlocks(output, 'questionnaire-response');
  output = output.replace(/<\/?final\b[^>]*>/giu, '');
  output = simplifyWidgets(output);
  output = simplifyGenui(output);
  output = stripEmptyAssetWrappers(output);
  output = neutralizeUnmatchedAssetWrappers(output);
  output = simplifyAssetMarkup(output, assets);
  output = output
    .replace(/<\/?(?:deliver-assets|deliver_assets)\b[^>]*>/giu, 'file attachment')
    .replace(/<media\b[^>]*\/?>/giu, 'file attachment')
    .replace(/<media\b[^>]*$/iu, '');
  return output;
}

function stripPairedBlocks(content: string, tagName: string): string {
  const pattern = new RegExp(
    `<${tagName}\\b[^>]*>((?:(?!<${tagName}\\b)[\\s\\S])*?)<\\/${tagName}\\s*>`,
    'giu',
  );
  let previous = content;
  let next = content.replace(pattern, '');
  while (next !== previous) {
    previous = next;
    next = next.replace(pattern, '');
  }
  return next;
}

function unwrapPairedBlocks(content: string, tagName: string): string {
  const pattern = new RegExp(
    `<${tagName}\\b[^>]*>((?:(?!<${tagName}\\b)[\\s\\S])*?)<\\/${tagName}\\s*>`,
    'giu',
  );
  let previous = content;
  let next = content.replace(pattern, (_match, body: string) => body.trim());
  while (next !== previous) {
    previous = next;
    next = next.replace(pattern, (_match, body: string) => body.trim());
  }
  return next;
}

function simplifyWidgets(content: string): string {
  const completeWidgetRe = /<mavis-widget\b([^>]*)>([\s\S]*?)<\/mavis-widget\s*>/giu;
  let output = content.replace(completeWidgetRe, (_match, rawAttributes: string, body: string) => {
    const fallback = /<mavis-fallback\b[^>]*>([\s\S]*?)<\/mavis-fallback\s*>/iu.exec(body)?.[1];
    if (fallback?.trim()) return fallback.trim();
    return formatWidgetFallback(parseAttributes(rawAttributes));
  });

  output = output.replace(/<mavis-widget\b([^>]*)>[\s\S]*$/iu, (_match, rawAttributes: string) =>
    formatWidgetFallback(parseAttributes(rawAttributes)),
  );
  return output.replace(/<mavis-widget\b[^>]*$/iu, 'Interactive content is loading…');
}

function formatWidgetFallback(attributes: Readonly<Record<string, string>>): string {
  const kind = attributes['kind']?.trim();
  const title = attributes['title']?.trim();
  if (kind && title) return `Interactive ${kind}: ${title} (open in Desktop).`;
  if (title) return `Interactive content: ${title} (open in Desktop).`;
  return 'Interactive content available in Desktop.';
}

function simplifyGenui(content: string): string {
  const pairRe = /<genui-([\w-]+)\b([^>]*)>[\s\S]*?<\/genui-\1\s*>/giu;
  const selfClosingRe = /<genui-([\w-]+)\b([^>]*?)\/\s*>/giu;
  let output = content.replace(pairRe, (_match, name: string, rawAttributes: string) =>
    formatGenuiFallback(name, parseAttributes(rawAttributes)),
  );
  output = output.replace(selfClosingRe, (_match, name: string, rawAttributes: string) =>
    formatGenuiFallback(name, parseAttributes(rawAttributes)),
  );
  return output.replace(/<genui-[\w-]*\b[^>]*$/iu, 'Interactive content is loading…');
}

function formatGenuiFallback(name: string, attributes: Readonly<Record<string, string>>): string {
  if (name.toLocaleLowerCase() === 'mcp-auth') {
    const label = attributes['label']?.trim() || attributes['server-id']?.trim();
    return label
      ? `MCP authorization required: ${label} (open in Desktop).`
      : 'MCP authorization required (open in Desktop).';
  }
  if (name.toLocaleLowerCase() === 'agent-team-recommendation') {
    const status = attributes['status']?.trim().toLocaleLowerCase();
    if (status === 'accepted') return 'Team recommendation accepted.';
    if (status === 'skipped') return 'Team recommendation skipped.';
    return 'Team recommendation available in Desktop.';
  }
  return 'Interactive content available in Desktop.';
}

function parseAttributes(raw: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([\w-]+)\s*=\s*(["'])(.*?)\2/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    const key = match[1];
    const value = match[3];
    if (key && value !== undefined) attributes[key] = decodeMarkup(value);
  }
  return attributes;
}

function stripEmptyAssetWrappers(content: string): string {
  const pattern = /<(deliver-assets|deliver_assets)\b[^>]*>\s*<\/\1\s*>/giu;
  let previous = content;
  let next = content.replace(pattern, '');
  while (next !== previous) {
    previous = next;
    next = next.replace(pattern, '');
  }
  return next;
}

function decodeMarkup(value: string): string {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&apos;|&#39;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');
}

interface AssetWrapperToken {
  start: number;
  end: number;
  name: string;
  closing: boolean;
}

function neutralizeUnmatchedAssetWrappers(content: string): string {
  const tagRe = /<\/?(deliver-assets|deliver_assets)\b[^>]*>/giu;
  const tokens: AssetWrapperToken[] = [];
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(content)) !== null) {
    tokens.push({
      start: match.index,
      end: tagRe.lastIndex,
      name: match[1]?.toLocaleLowerCase() ?? '',
      closing: match[0].startsWith('</'),
    });
  }
  if (tokens.length === 0) return content;

  const stack: number[] = [];
  const matched = new Set<number>();
  tokens.forEach((token, index) => {
    if (!token.closing) {
      stack.push(index);
      return;
    }
    for (let stackIndex = stack.length - 1; stackIndex >= 0; stackIndex -= 1) {
      const openingIndex = stack[stackIndex];
      if (openingIndex === undefined || tokens[openingIndex]?.name !== token.name) continue;
      stack.splice(stackIndex, 1);
      matched.add(openingIndex);
      matched.add(index);
      return;
    }
  });
  if (matched.size === tokens.length) return content;

  let cursor = 0;
  let output = '';
  tokens.forEach((token, index) => {
    output += content.slice(cursor, token.start);
    output += matched.has(index) ? content.slice(token.start, token.end) : 'file attachment';
    cursor = token.end;
  });
  return output + content.slice(cursor);
}

function simplifyAssetMarkup(content: string, assets: DeliverAssetItem[]): string {
  let remaining = content;
  for (let pass = 0; pass < 3; pass += 1) {
    const segments = parseDeliverAssetsContent(remaining);
    const extracted = collectAssetSegments(segments);
    // Keep the parser's cleanup even when every attachment was invalid.
    remaining = extracted.text;
    if (extracted.assets.length === 0) break;
    assets.push(...extracted.assets);
  }
  return remaining;
}

function collectAssetSegments(segments: readonly DeliverAssetsSegment[]): {
  text: string;
  assets: DeliverAssetItem[];
} {
  const text: string[] = [];
  const assets: DeliverAssetItem[] = [];
  for (const segment of segments) {
    if (segment.type === 'deliver-assets' || segment.type === 'image-gallery') {
      assets.push(...segment.items);
    } else if (segment.content.trim()) {
      text.push(segment.content.trim());
    }
  }
  return { text: text.join('\n\n'), assets };
}

function formatAssetGroup(items: readonly TerminalDeliveredAsset[]): string {
  const first = items[0];
  if (!first) return '';
  if (items.length === 1) return `File: ${formatAsset(first)}`;
  return ['Files:', ...items.map((item) => `- ${formatAsset(item)}`)].join('\n');
}

function formatAsset(item: TerminalDeliveredAsset): string {
  const path = item.path.trim();
  const name = item.name?.trim();
  const basename = path.split(/[\\/]/u).filter(Boolean).at(-1);
  if (!name || name === path || name === basename) return path;
  const embeddedPathStart = path ? name.indexOf(path) : -1;
  if (embeddedPathStart >= 0) {
    return name.slice(0, embeddedPathStart + path.length).trimEnd();
  }
  return `${name} · ${path}`;
}

function cleanVisibleText(content: string): string {
  return content
    .replace(/[^\S\r\n]+$/gmu, '')
    .replace(/(?:\r?\n[\t ]*){3,}/gu, '\n\n')
    .trim();
}
