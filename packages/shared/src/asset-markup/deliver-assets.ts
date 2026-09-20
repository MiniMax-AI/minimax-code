/**
 * Deliver-assets / media markup parser.
 *
 * Pure parsing logic extracted from the UI's `DeliverAssetsCard.tsx` so the
 * local-runtime session asset indexer and the UI share one implementation.
 * Behavior must stay identical to the original UI parser; the only extension
 * point is `ParseDeliverAssetsOptions.cloudDrivePathDetection`, which replaces
 * the UI's direct `CLOUD_LOGIC` read (the UI wrapper binds it).
 *
 * MUST NOT import from `@mavis/ui` — dependency direction is ui → shared.
 */
import { isImageAsset } from '../media-asset-meta.js';
import { isDataUrl, parseDataUrlSource } from './data-url.js';
import {
  findMarkdownProtectedRanges,
  replaceMarkdownOutsideProtected,
} from './markdown-protected.js';

export interface DeliverAssetItem {
  path: string;
  /** Cloud result lifecycle. Missing/unknown values are treated as available. */
  status?: 'available' | 'deleted';
  artifactId?: string;
  driveNodeId?: string;
  /** Runtime-trusted identity for a deployed website. */
  nodeId?: string;
  /** Runtime-materialized local screenshot used by the PC delivery card. */
  coverPath?: string;
  name?: string;
  type?: string;
  downloadUrl?: string;
  previewUrl?: string;
  mimeType?: string;
  /** True only for a runtime-validated file deletion; missing means false. */
  deleted?: boolean;
}

export type DeliverAssetsSegment =
  | { type: 'text'; content: string }
  | { type: 'deliver-assets'; items: DeliverAssetItem[] }
  | { type: 'image-gallery'; items: DeliverAssetItem[] };

export interface ParseDeliverAssetsOptions {
  /**
   * When true, bare non-path media sources (no scheme, no path shape) are
   * treated as cloud drive node ids. Mirrors the UI's `CLOUD_LOGIC` gate;
   * local-runtime keeps this false. `commit-id-*` transport ids are always
   * recognized regardless of this flag.
   */
  cloudDrivePathDetection?: boolean;
}

export const COMMIT_ID_PREFIX = 'commit-id-';

const SESSION_DELIVERABLE_CANVAS_REFERENCE_PREFIX = 'mavis-session-deliverable:';
const CANVAS_DELIVERABLE_DIRECTORY = '.mavis/canvas-assets';

/**
 * Encodes a Session deliverable path for the Canvas add-file command. The
 * Canvas owner resolves this opaque request back to a registered deliverable
 * and persists only its workspace-local materialized path.
 */
export function encodeSessionDeliverableCanvasReference(path: string): string | null {
  const normalized = path.trim();
  if (!normalized) return null;
  return `${SESSION_DELIVERABLE_CANVAS_REFERENCE_PREFIX}${encodeURIComponent(normalized)}`;
}

export function decodeSessionDeliverableCanvasReference(reference: string): string | null {
  if (!reference.startsWith(SESSION_DELIVERABLE_CANVAS_REFERENCE_PREFIX)) return null;
  try {
    const path = decodeURIComponent(
      reference.slice(SESSION_DELIVERABLE_CANVAS_REFERENCE_PREFIX.length),
    ).trim();
    return path || null;
  } catch {
    return null;
  }
}

/** Stable workspace-local identity used after a Session deliverable is imported. */
export function getCanvasDeliverableRelativePath(sourcePath: string): string {
  const normalized = sourcePath.trim().replace(/\\/gu, '/');
  const rawName = normalized.slice(normalized.lastIndexOf('/') + 1) || 'deliverable';
  const safeName =
    rawName
      .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '-')
      .replace(/[. ]+$/gu, '')
      .slice(-120) || 'deliverable';
  return `${CANVAS_DELIVERABLE_DIRECTORY}/${stablePathHash(normalized)}-${safeName}`;
}

/** Regenerable workspace projection for a Session-owned immutable asset. */
export function getCanvasAssetRelativePath(assetId: string, fileName: string): string {
  const safeAssetId =
    assetId
      .trim()
      .replace(/[^A-Za-z0-9_-]/gu, '-')
      .slice(0, 256) || 'asset';
  const safeName =
    fileName
      .trim()
      .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '-')
      .replace(/[. ]+$/gu, '')
      .slice(-120) || 'asset';
  return `${CANVAS_DELIVERABLE_DIRECTORY}/${safeAssetId}-${safeName}`;
}

function stablePathHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function isCommitIdTransportId(value?: string | null): boolean {
  return value?.trim().startsWith(COMMIT_ID_PREFIX) === true;
}

export function stripCommitIdPrefix(id: string): string {
  const trimmed = id.trim();
  return trimmed.startsWith(COMMIT_ID_PREFIX) ? trimmed.slice(COMMIT_ID_PREFIX.length) : trimmed;
}

export function getCloudDriveNodeId(item: DeliverAssetItem): string | null {
  const driveNodeId = item.driveNodeId?.trim();
  if (driveNodeId) {
    return stripCommitIdPrefix(driveNodeId);
  }
  const websiteNodeId = item.nodeId?.trim();
  if (websiteNodeId) {
    return stripCommitIdPrefix(websiteNodeId);
  }
  const artifactId = item.artifactId?.trim();
  if (isCommitIdTransportId(artifactId)) {
    return stripCommitIdPrefix(artifactId!);
  }
  return isCommitIdTransportId(item.path) ? stripCommitIdPrefix(item.path) : null;
}

export function isHttpUrl(path: string): boolean {
  return /^https?:\/\//u.test(path.trim());
}

export function isBlobUrl(path: string): boolean {
  return path.trim().startsWith('blob:');
}

const DELIVER_ASSETS_RE = /<(deliver-assets|deliver_assets)\b[^>]*>([\s\S]*?)<\/\1>/g;
const DELIVER_ASSETS_TAG_RE = /<\/?deliver[-_]assets\b[^>]*>/g;
const ITEM_RE = /<item>([\s\S]*?)<\/item>/g;
const ITEM_TAG_RE = /<item>[\s\S]*?<\/item>/g;
const MEDIA_TAG_RE = /<media\s+([^>]*?)\/>/g;
const MEDIA_TAG_STRIP_RE = /<media\s+[^>]*?\/>/g;
const MEDIA_ATTR_RE = /(\w+)="([^"]*)"/g;
const INTERNAL_ARTIFACT_WRAPPER_RE = /<\/?publish[_-]artifact\b[^>]*>/gi;
const PREVIEW_CARD_RE = /<preview_card\b[^>]*>([\s\S]*?)<\/preview_card>/gi;
const PREVIEW_CARD_LABEL_RE = /^\s*preview_cards?:\s*$/gim;

function escapeAssetMarkupText(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

function decodeAssetMarkupText(value: string): string {
  return value
    .replace(/&quot;/gu, '"')
    .replace(/&apos;|&#39;/gu, "'")
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&amp;/gu, '&');
}

function filePathFromNestedCitation(attributes: string, body: string): string {
  const pathMatch = /\b(?:data-path|path)\s*=\s*(?:"([^"]*)"|'([^']*)')/iu.exec(attributes);
  return decodeAssetMarkupText(pathMatch?.[1] ?? pathMatch?.[2] ?? body.trim());
}

/**
 * Recover a delivery tag whose `src` was accidentally rewritten as a File
 * citation. The source-reference pass must treat asset markup as opaque, but
 * persisted messages from older runtimes can still contain this shape.
 */
export function normalizeNestedFilePathMediaSources(content: string): string {
  return replaceMarkdownOutsideProtected(content, /<media\b[\s\S]*?\/>/giu, (tag) =>
    tag.replace(
      /\bsrc\s*=\s*"<filepath\b([^>]*)>([\s\S]*?)<\/filepath>"/giu,
      (_match, attributes: string, body: string) => {
        const path = filePathFromNestedCitation(attributes, body).trim();
        return path ? `src="${escapeAssetMarkupText(path)}"` : String(_match);
      },
    ),
  );
}

function isPathLikeMediaSource(src: string): boolean {
  const trimmed = src.trim();
  return (
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('~') ||
    trimmed.includes('/') ||
    /\.[A-Za-z0-9]{1,12}(?:[?#].*)?$/u.test(trimmed)
  );
}

function isCloudDriveMediaSource(src: string, cloudDrivePathDetection: boolean): boolean {
  const trimmed = src.trim();
  if (isCommitIdTransportId(trimmed)) {
    return true;
  }

  return (
    cloudDrivePathDetection &&
    !!trimmed &&
    !isHttpUrl(trimmed) &&
    !isBlobUrl(trimmed) &&
    !parseDataUrlSource(trimmed) &&
    !isPathLikeMediaSource(trimmed)
  );
}

function buildDeliverAssetsMarkup(item: DeliverAssetItem): string {
  return [
    '<deliver-assets>',
    '<item>',
    item.artifactId
      ? `<artifact_id>${escapeAssetMarkupText(item.artifactId)}</artifact_id>`
      : `<path>${escapeAssetMarkupText(item.path)}</path>`,
    item.name ? `<name>${escapeAssetMarkupText(item.name)}</name>` : '',
    item.type ? `<type>${escapeAssetMarkupText(item.type)}</type>` : '',
    '</item>',
    '</deliver-assets>',
  ]
    .filter(Boolean)
    .join('\n');
}

function readPreviewCardField(line: string, key: 'path' | 'name' | 'type'): string | null {
  const match = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'iu').exec(line.trim());
  return match?.[1]?.trim() || null;
}

function parseRawPreviewCardBody(body: string): DeliverAssetItem | null {
  const lines = body
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return null;
  }

  const pathLine =
    lines.map((line) => readPreviewCardField(line, 'path')).find(Boolean) ?? lines[0];
  const nameLine =
    lines.map((line) => readPreviewCardField(line, 'name')).find(Boolean) ??
    (lines[1] && !lines[1].includes(':') ? lines[1] : undefined);
  const typeLine =
    lines.map((line) => readPreviewCardField(line, 'type')).find(Boolean) ??
    (lines[2] && !lines[2].includes(':') ? lines[2] : undefined);
  const path = pathLine?.trim();

  if (!path || /\s/u.test(path)) {
    return null;
  }

  return {
    path,
    name: nameLine?.trim() || undefined,
    type: typeLine?.trim() || undefined,
  };
}

function normalizeInternalAssetMarkup(content: string): string {
  let result = replaceMarkdownOutsideProtected(content, INTERNAL_ARTIFACT_WRAPPER_RE, '');
  result = replaceMarkdownOutsideProtected(result, PREVIEW_CARD_RE, (_match, body: unknown) => {
    if (typeof body !== 'string') return _match;
    const trimmedBody = body.trim();
    if (
      trimmedBody.includes('<deliver-assets>') ||
      trimmedBody.includes('<deliver_assets>') ||
      /<media\s+/u.test(trimmedBody)
    ) {
      return trimmedBody;
    }

    const item = parseRawPreviewCardBody(trimmedBody);
    return item ? buildDeliverAssetsMarkup(item) : trimmedBody;
  });
  result = replaceMarkdownOutsideProtected(result, PREVIEW_CARD_LABEL_RE, '');
  return result.trim();
}

function hasNormalizableAssetMarkup(content: string): boolean {
  return (
    /<\/?publish[_-]artifact\b/iu.test(content) ||
    /<preview_card\b/iu.test(content) ||
    /^\s*preview_cards?:\s*$/imu.test(content)
  );
}

export function maskMarkdownProtectedRanges(content: string): string {
  const protectedRanges = findMarkdownProtectedRanges(content);
  if (protectedRanges.length === 0) {
    return content;
  }

  const chars = content.split('');
  for (const range of protectedRanges) {
    for (let index = range.start; index < range.end && index < chars.length; index += 1) {
      chars[index] = ' ';
    }
  }
  return chars.join('');
}

function readTagContent(
  content: string,
  tagName: 'path' | 'artifact_id' | 'name' | 'type',
): string | null {
  const strictMatch = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'iu').exec(content);
  const strictValue = strictMatch?.[1]?.trim();
  if (strictValue) {
    return decodeAssetMarkupText(strictValue);
  }

  // LLMs occasionally mistype one closing tag inside otherwise valid cards
  // (for example <path>report.html</name>). Recover the field up to the next
  // card tag so a previewable result does not degrade into raw local paths.
  const tolerantMatch = new RegExp(
    `<${tagName}>([\\s\\S]*?)(?=<\\/?(?:path|artifact_id|name|type|item|deliver-assets|deliver_assets)\\b|$)`,
    'iu',
  ).exec(content);
  const value = tolerantMatch?.[1]?.trim();
  return value ? decodeAssetMarkupText(value) : null;
}

function parseDeliverAssetsBlock(
  content: string,
  cloudDrivePathDetection: boolean,
): DeliverAssetItem[] {
  const items: DeliverAssetItem[] = [];
  let match: RegExpExecArray | null;
  const tokenRe = new RegExp(`${ITEM_RE.source}|${MEDIA_TAG_RE.source}`, 'g');
  tokenRe.lastIndex = 0;

  while ((match = tokenRe.exec(content)) !== null) {
    const itemBody = match[1];
    const mediaAttrs = match[2];
    if (typeof mediaAttrs === 'string') {
      const mediaItem = parseMediaItem(mediaAttrs, cloudDrivePathDetection);
      if (mediaItem) {
        items.push(mediaItem);
      }
      continue;
    }

    if (typeof itemBody === 'string') {
      const artifactId = readTagContent(itemBody, 'artifact_id')?.trim();
      const path = readTagContent(itemBody, 'path')?.trim();
      if (!path && !artifactId) {
        continue;
      }

      const artifactDriveNodeId =
        artifactId && isCommitIdTransportId(artifactId) ? stripCommitIdPrefix(artifactId) : null;
      if (!path && artifactId && !artifactDriveNodeId) {
        continue;
      }
      const pathDriveNodeId =
        !artifactId && path && isCloudDriveMediaSource(path, cloudDrivePathDetection)
          ? stripCommitIdPrefix(path)
          : null;
      const driveNodeId = artifactDriveNodeId ?? pathDriveNodeId ?? undefined;

      items.push(
        normalizeInlineDataImageItem({
          path: path ?? (artifactDriveNodeId ? (artifactId ?? '') : ''),
          ...(artifactId ? { artifactId } : {}),
          ...(driveNodeId ? { driveNodeId } : {}),
          name: readTagContent(itemBody, 'name') ?? undefined,
          type: readTagContent(itemBody, 'type') ?? undefined,
        }),
      );
    }
  }

  return items;
}

function stripAssetTags(content: string): string {
  return content.replace(ITEM_TAG_RE, '').replace(MEDIA_TAG_STRIP_RE, '').trim();
}

function parseMediaItem(
  attrString: string,
  cloudDrivePathDetection: boolean,
): DeliverAssetItem | null {
  const attrs: Record<string, string> = {};
  MEDIA_ATTR_RE.lastIndex = 0;
  let attrMatch: RegExpExecArray | null;

  while ((attrMatch = MEDIA_ATTR_RE.exec(attrString)) !== null) {
    const [, key, value] = attrMatch;
    if (key && value) {
      attrs[key] = decodeAssetMarkupText(value);
    }
  }

  // Some models emit a local file's path as an attribute instead of src.
  const src = attrs['src']?.trim() || attrs['path']?.trim();
  if (!src) {
    return null;
  }

  const status = attrs['status']?.trim().toLowerCase();
  const deleted = status === 'deleted' || attrs['deleted']?.trim().toLowerCase() === 'true';

  return normalizeInlineDataImageItem({
    path: src,
    ...(status === 'deleted' ? { status: 'deleted' as const } : {}),
    ...(isCloudDriveMediaSource(src, cloudDrivePathDetection)
      ? { driveNodeId: stripCommitIdPrefix(src) }
      : {}),
    name: attrs['name']?.trim() || attrs['caption']?.trim() || undefined,
    type: attrs['type']?.trim() || undefined,
    nodeId: attrs['node_id']?.trim() || undefined,
    coverPath: attrs['cover']?.trim() || undefined,
    ...(deleted ? { deleted: true } : {}),
  });
}

function normalizeInlineDataImageItem(item: DeliverAssetItem): DeliverAssetItem {
  const dataSource = parseDataUrlSource(item.path);
  if (!dataSource?.mimeType.startsWith('image/')) {
    return item;
  }

  return {
    ...item,
    name: item.name ?? `image.${imageExtensionForMimeType(dataSource.mimeType)}`,
    type: item.type ?? 'image',
    mimeType: item.mimeType ?? dataSource.mimeType,
  };
}

function imageExtensionForMimeType(mimeType: string): string {
  const subtype = mimeType.slice('image/'.length).toLowerCase();
  if (subtype === 'jpeg') return 'jpg';
  if (subtype === 'svg+xml') return 'svg';
  if (subtype === 'x-icon' || subtype === 'vnd.microsoft.icon') return 'ico';
  return /^[a-z0-9]+$/u.test(subtype) ? subtype : 'img';
}

function toResultSegment(items: DeliverAssetItem[]): DeliverAssetsSegment {
  if (items.length > 0 && items.every((item) => !item.deleted && isImageAsset(item))) {
    return { type: 'image-gallery', items };
  }

  return { type: 'deliver-assets', items };
}

function toResultSegments(items: DeliverAssetItem[]): DeliverAssetsSegment[] {
  const segments: DeliverAssetsSegment[] = [];
  let currentItems: DeliverAssetItem[] = [];
  let currentKind: 'image' | 'asset' | null = null;

  const flush = () => {
    if (currentItems.length > 0) {
      segments.push(toResultSegment(currentItems));
    }
    currentItems = [];
    currentKind = null;
  };

  for (const item of items) {
    const kind = !item.deleted && isImageAsset(item) ? 'image' : 'asset';
    if (currentKind && currentKind !== kind) {
      flush();
    }
    currentKind = kind;
    currentItems.push(item);
  }

  flush();
  return segments;
}

export function parseDeliverAssetsContent(
  content: string,
  options: ParseDeliverAssetsOptions = {},
): DeliverAssetsSegment[] {
  const cloudDrivePathDetection = options.cloudDrivePathDetection ?? false;
  const recoveredContent = normalizeNestedFilePathMediaSources(content);
  const normalizedContent = hasNormalizableAssetMarkup(recoveredContent)
    ? normalizeInternalAssetMarkup(recoveredContent)
    : recoveredContent;
  const searchableContent = maskMarkdownProtectedRanges(normalizedContent);
  const hasDeliverAssets = (() => {
    DELIVER_ASSETS_TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DELIVER_ASSETS_TAG_RE.exec(searchableContent)) !== null) {
      if (match[0].trim()) {
        return true;
      }
    }
    return false;
  })();
  const hasMediaTags = !hasDeliverAssets && /<media\s+/.test(searchableContent);

  if (!hasDeliverAssets && !hasMediaTags) {
    return [{ type: 'text', content: normalizedContent }];
  }

  const rawSegments: Array<
    | { type: 'text'; content: string }
    | { type: 'asset-item'; item: DeliverAssetItem }
    | { type: 'deliver-assets'; items: DeliverAssetItem[] }
  > = [];

  const tokenRe = hasDeliverAssets
    ? new RegExp(DELIVER_ASSETS_RE.source, 'g')
    : new RegExp(`${DELIVER_ASSETS_RE.source}|${MEDIA_TAG_RE.source}`, 'g');

  const pushText = (text: string): void => {
    if (text) {
      rawSegments.push({ type: 'text', content: text });
    }
  };

  let cursor = 0;
  let match: RegExpExecArray | null;
  let parsedAnyAssetMarkup = false;
  tokenRe.lastIndex = 0;

  while ((match = tokenRe.exec(searchableContent)) !== null) {
    parsedAnyAssetMarkup = true;

    const before = normalizedContent.slice(cursor, match.index).trim();
    pushText(before);

    const deliverAssetsBody = match[2];
    const mediaAttrs = match[3];

    if (typeof deliverAssetsBody === 'string') {
      const items = parseDeliverAssetsBlock(deliverAssetsBody, cloudDrivePathDetection);
      const leftoverText = stripAssetTags(deliverAssetsBody);
      if (items.length === 0) {
        pushText(leftoverText);
      } else {
        if (leftoverText) {
          rawSegments.push({ type: 'text', content: leftoverText });
        }
        rawSegments.push({ type: 'deliver-assets', items });
      }
    } else if (typeof mediaAttrs === 'string') {
      const item = parseMediaItem(mediaAttrs, cloudDrivePathDetection);
      if (item) {
        rawSegments.push({ type: 'asset-item', item });
      }
    }

    cursor = match.index + match[0].length;
  }

  if (!parsedAnyAssetMarkup) {
    return [{ type: 'text', content: normalizedContent }];
  }

  const tail = normalizedContent.slice(cursor).trim();
  pushText(tail);

  const segments: DeliverAssetsSegment[] = [];
  let pendingMediaItems: DeliverAssetItem[] = [];
  const seenAssetPaths = new Set<string>();

  const filterNewItems = (items: DeliverAssetItem[]): DeliverAssetItem[] =>
    items.filter((item) => {
      const key = item.artifactId?.trim() || item.path.trim();
      if (!key || seenAssetPaths.has(key)) {
        return false;
      }
      seenAssetPaths.add(key);
      return true;
    });

  const flushPendingMedia = () => {
    if (pendingMediaItems.length === 0) {
      return;
    }
    segments.push(...toResultSegments(pendingMediaItems));
    pendingMediaItems = [];
  };

  for (const segment of rawSegments) {
    if (segment.type === 'asset-item') {
      pendingMediaItems.push(...filterNewItems([segment.item]));
      continue;
    }

    flushPendingMedia();

    if (segment.type === 'deliver-assets') {
      const uniqueItems = filterNewItems(segment.items);
      if (uniqueItems.length > 0) {
        segments.push(...toResultSegments(uniqueItems));
      }
      continue;
    }

    const previous = segments.at(-1);
    if (previous?.type === 'text') {
      previous.content = `${previous.content}\n\n${segment.content}`.trim();
    } else {
      segments.push(segment);
    }
  }

  flushPendingMedia();

  return segments.length > 0 ? segments : [];
}
