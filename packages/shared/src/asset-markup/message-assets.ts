/**
 * Message-level asset collection helpers.
 *
 * Extracted from the UI's `WorkspacePanel/workspace-collector.ts` so the
 * local-runtime session asset indexer and the UI Workspace collector share
 * the same wrapper extraction, path filtering, normalization, and dedupe
 * semantics. Keep behavior in sync with the UI collector tests.
 */
import {
  type DeliverAssetItem,
  type ParseDeliverAssetsOptions,
  isBlobUrl,
  isHttpUrl,
  maskMarkdownProtectedRanges,
  parseDeliverAssetsContent,
} from './deliver-assets.js';
import { isDataUrl } from './data-url.js';

function findDeliverAssetsWrapperRanges(
  content: string,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let pos = 0;
  let hyphenExhausted = false;
  let underscoreExhausted = false;
  while (pos < content.length) {
    const hyphenIdx = hyphenExhausted ? -1 : content.indexOf('<deliver-assets>', pos);
    if (hyphenIdx === -1) hyphenExhausted = true;
    const underscoreIdx = underscoreExhausted ? -1 : content.indexOf('<deliver_assets>', pos);
    if (underscoreIdx === -1) underscoreExhausted = true;
    if (hyphenIdx === -1 && underscoreIdx === -1) break;
    const useHyphen =
      hyphenIdx !== -1 && (underscoreIdx === -1 || hyphenIdx < underscoreIdx);
    const openIdx = useHyphen ? hyphenIdx : underscoreIdx;
    const closeTag = useHyphen ? '</deliver-assets>' : '</deliver_assets>';
    const closeIdx = content.indexOf(closeTag, openIdx + 16);
    if (closeIdx === -1) {
      if (useHyphen) hyphenExhausted = true;
      else underscoreExhausted = true;
      pos = openIdx + 16;
      continue;
    }
    const end = closeIdx + 17;
    ranges.push({ start: openIdx, end });
    pos = end;
  }
  return ranges;
}

export interface CollectMessageAssetItemsOptions extends ParseDeliverAssetsOptions {
  /**
   * Collect standalone `<media />` tags outside `<deliver-assets>` wrappers.
   * Local-runtime keeps this on for all runtimes (the indexer owns the rule);
   * the UI collector still threads its own flag for the streaming fallback.
   */
  includeStandaloneMedia?: boolean;
}

/** Strip line number suffix (:42) from a file path. */
function stripLineNumber(p: string): string {
  return p.replace(/:\d+$/, '');
}

export function extractDeliverAssetsWrappers(content: string): string {
  return findDeliverAssetsWrapperRanges(content)
    .map(({ start, end }) => content.slice(start, end))
    .join('\n');
}

export function stripDeliverAssetsWrappers(content: string): string {
  const ranges = findDeliverAssetsWrapperRanges(content);
  if (ranges.length === 0) return content;
  let out = '';
  let cursor = 0;
  for (const { start, end } of ranges) {
    out += content.slice(cursor, start);
    cursor = end;
  }
  return out + content.slice(cursor);
}

/**
 * Normalize a path into the dedupe key used by Workspace and the session
 * asset index: strip `:line`, unify separators, drop trailing slashes, and
 * lowercase Windows drive letters.
 */
export function normalizeAssetPathKey(path: string): string {
  const trimmed = stripLineNumber(path.trim()).replace(/\\/g, '/');
  const withoutTrailingSlash = trimmed.length > 1 ? trimmed.replace(/\/+$/u, '') : trimmed;
  return /^[A-Z]:\//u.test(withoutTrailingSlash)
    ? withoutTrailingSlash[0]!.toLowerCase() + withoutTrailingSlash.slice(1)
    : withoutTrailingSlash;
}

/** Remote URLs, virtual URLs, and app API paths never enter the workspace. */
export function shouldSkipAssetPath(path: string): boolean {
  const trimmed = path.trim();
  return (
    isDataUrl(trimmed) ||
    isHttpUrl(trimmed) ||
    isBlobUrl(trimmed) ||
    /^\/(?:mavis\/api|api)\//u.test(trimmed)
  );
}

/** Prefer entries carrying more metadata (name/type) on dedupe collisions. */
export function hasRicherAssetMetadata(a: DeliverAssetItem, b: DeliverAssetItem): boolean {
  const aScore = (a.name ? 1 : 0) + (a.type ? 1 : 0) + (a.nodeId ? 1 : 0) + (a.coverPath ? 1 : 0);
  const bScore = (b.name ? 1 : 0) + (b.type ? 1 : 0) + (b.nodeId ? 1 : 0) + (b.coverPath ? 1 : 0);
  return aScore > bScore;
}

/** Add item to map keyed by normalized path, preferring richer metadata. */
export function addAssetItemToMap(
  map: Map<string, DeliverAssetItem>,
  item: DeliverAssetItem,
): void {
  if (shouldSkipAssetPath(item.path)) return;

  const key = normalizeAssetPathKey(item.path);
  const existing = map.get(key);
  const normalizedItem = item.path === key ? item : { ...item, path: key };
  if (!existing || hasRicherAssetMetadata(item, existing)) {
    map.set(key, normalizedItem);
  }
}

function collectFromAssetMarkup(
  map: Map<string, DeliverAssetItem>,
  content: string,
  options: ParseDeliverAssetsOptions,
): void {
  const segments = parseDeliverAssetsContent(content, options);
  for (const seg of segments) {
    if (seg.type === 'deliver-assets' || seg.type === 'image-gallery') {
      for (const item of seg.items) addAssetItemToMap(map, item);
    }
  }
}

/**
 * Collect asset items from one complete assistant message body.
 *
 * Sources match the UI Workspace collector:
 *  1. `<deliver-assets>` / `<deliver_assets>` wrapper blocks (always)
 *  2. standalone `<media />` tags (when `includeStandaloneMedia`, default on)
 *
 * Plain-text paths, inline-code paths, and code-fence content are ignored;
 * remote/virtual URLs and app API paths are filtered; results are deduped by
 * normalized path with richer metadata winning. Order follows first
 * appearance in the message.
 */
export function collectMessageAssetItems(
  msgContent: string,
  options: CollectMessageAssetItemsOptions = {},
): DeliverAssetItem[] {
  const { includeStandaloneMedia = true, ...parseOptions } = options;
  const byPath = new Map<string, DeliverAssetItem>();

  // Mask code fences / inline code before wrapper extraction so fenced
  // example markup never indexes. (The UI collector extracts wrappers from
  // the raw content for streaming display; the persisted index is stricter.)
  const searchableContent = maskMarkdownProtectedRanges(msgContent);

  const workspaceMarkup = extractDeliverAssetsWrappers(searchableContent);
  if (workspaceMarkup) {
    collectFromAssetMarkup(byPath, workspaceMarkup, parseOptions);
  }

  if (includeStandaloneMedia) {
    const standaloneMarkup = stripDeliverAssetsWrappers(searchableContent);
    if (standaloneMarkup.trim()) {
      collectFromAssetMarkup(byPath, standaloneMarkup, parseOptions);
    }
  }

  return [...byPath.values()];
}
