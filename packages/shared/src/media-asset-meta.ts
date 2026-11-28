/**
 * Shared media-asset metadata inferers — single source of truth for the
 * "agent never emits mime/size, and `type` is often absent, so kind/mime
 * must be INFERRED from type/extension" rule.
 *
 * These were originally defined in the UI's `result-card-utils.ts`. They are
 * PORTED here so the IM outbound side (`outbound-media.ts`) has a canonical,
 * UI-free implementation it can depend on. The UI's `result-card-utils.ts`
 * still carries a parallel copy for now; deduplicating it to re-export from
 * this module is a tracked follow-up (out of scope for the foundation MR that
 * introduced this file). Until then, do NOT add a THIRD copy — extend here.
 *
 * IMPORTANT: this module lives in `@mavis/shared` and MUST NOT import from
 * `@mavis/ui` (that would create a package cycle). The dependency direction
 * is strictly ui → shared.
 */

/**
 * Minimal structural input for the metadata inferers. The UI's
 * `DeliverAssetItem` (which carries extra UI-only fields like `downloadUrl`)
 * is structurally assignable to this, so callers can keep passing their
 * richer objects unchanged.
 */
export interface MediaAssetMetaInput {
  path: string;
  name?: string;
  type?: string;
  mimeType?: string;
}

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'tif',
  'tiff',
  'avif',
]);

/**
 * Image formats that the workspace file preview and Canvas surfaces can render.
 * Keep this narrower than `IMAGE_EXTENSIONS`: formats added here must be
 * supported by the local Runtime media boundary and browser preview pipeline
 * (TIFF uses a bounded worker conversion to PNG; AVIF relies on Chromium's
 * native decoder).
 */
export const WORKSPACE_IMAGE_PREVIEW_MIME_TYPES = {
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  gif: 'image/gif',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
} as const;

export type WorkspaceImagePreviewMimeType =
  (typeof WORKSPACE_IMAGE_PREVIEW_MIME_TYPES)[keyof typeof WORKSPACE_IMAGE_PREVIEW_MIME_TYPES];

const WEB_EXTENSIONS = new Set(['html', 'htm']);

export const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  avif: 'image/avif',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  key: 'application/vnd.apple.keynote',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  js: 'text/javascript',
  jsx: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  css: 'text/css',
  scss: 'text/x-scss',
  sql: 'application/sql',
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  mkv: 'video/x-matroska',
};

function getPathWithoutQuery(path: string): string {
  return path.split('#')[0]?.split('?')[0] ?? path;
}

function getPathExtension(path: string): string {
  const cleanPath = getPathWithoutQuery(path.trim());
  const lastSegment = cleanPath.split('/').pop() ?? cleanPath;
  const dotIndex = lastSegment.lastIndexOf('.');
  if (dotIndex < 0 || dotIndex === lastSegment.length - 1) {
    return '';
  }
  return lastSegment.slice(dotIndex + 1).toLowerCase();
}

export function getWorkspaceImagePreviewMimeType(
  path: string,
): WorkspaceImagePreviewMimeType | undefined {
  const extension = getPathExtension(path);
  return WORKSPACE_IMAGE_PREVIEW_MIME_TYPES[
    extension as keyof typeof WORKSPACE_IMAGE_PREVIEW_MIME_TYPES
  ];
}

export function supportsWorkspaceImagePreview(path: string): boolean {
  return getWorkspaceImagePreviewMimeType(path) !== undefined;
}

/**
 * Canvas region annotations are currently validated end to end only for JPEG
 * and PNG. Other previewable formats stay on the direct add-to-chat path until
 * their product semantics are defined, especially GIF frame/timeline anchors.
 */
export function supportsCanvasImageAnnotation(path: string): boolean {
  const mimeType = getWorkspaceImagePreviewMimeType(path);
  return mimeType === 'image/jpeg' || mimeType === 'image/png';
}

function getAssetType(item: MediaAssetMetaInput): string {
  return item.type?.trim().toLowerCase() ?? '';
}

function getBaseMimeType(item: MediaAssetMetaInput): string {
  return item.mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function isHttpUrl(path: string): boolean {
  return /^https?:\/\//u.test(path.trim());
}

export function isImageAsset(item: MediaAssetMetaInput): boolean {
  const type = getAssetType(item);
  if (type === 'image') {
    return true;
  }
  if (IMAGE_EXTENSIONS.has(type)) {
    return true;
  }
  if (type) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(getPathExtension(item.path));
}

export function isWebAsset(item: MediaAssetMetaInput): boolean {
  const type = getAssetType(item);
  const mimeType = getBaseMimeType(item);
  if (type === 'image') {
    return false;
  }
  if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') {
    return true;
  }
  if (type === 'file') {
    return false;
  }
  if (
    type === 'html' ||
    type === 'web' ||
    type === 'website' ||
    type === 'url' ||
    type === 'link'
  ) {
    return true;
  }
  if (isHttpUrl(item.path)) {
    return true;
  }
  return WEB_EXTENSIONS.has(getPathExtension(item.path));
}

export function isWebsiteAsset(item: MediaAssetMetaInput): boolean {
  return getAssetType(item) === 'website';
}

export function inferAssetMimeType(item: MediaAssetMetaInput): string | undefined {
  if (item.mimeType) {
    return item.mimeType;
  }

  const type = getAssetType(item);
  if (type === 'html' || type === 'web' || type === 'website') {
    return 'text/html';
  }
  if (type === 'url' || type === 'link') {
    return 'text/html';
  }
  if (type === 'audio') {
    return 'audio/mpeg';
  }
  if (type === 'video') {
    return 'video/mp4';
  }
  if (type === 'ppt' || type === 'pptx' || type === 'powerpoint' || type === 'presentation') {
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  }
  if (type === 'doc' || type === 'docx' || type === 'word' || type === 'document') {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (type === 'xls' || type === 'xlsx' || type === 'excel' || type === 'spreadsheet') {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  if (MIME_BY_EXTENSION[type]) {
    return MIME_BY_EXTENSION[type];
  }

  const nameExtension = item.name ? getPathExtension(item.name) : '';
  const pathExtension = getPathExtension(item.path);
  return MIME_BY_EXTENSION[nameExtension] ?? MIME_BY_EXTENSION[pathExtension];
}

// ---------------------------------------------------------------------------
// Outbound media kind classification
// ---------------------------------------------------------------------------

/**
 * Coarse media kind used by IM outbound senders to pick a transport
 * (image / file / audio / video). Distinct from the finer-grained
 * image/web/website classifiers above — those drive UI card rendering,
 * whereas this maps onto the four send primitives IM platforms expose.
 */
export type OutboundMediaKind = 'image' | 'file' | 'audio' | 'video';

const KIND_IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'avif',
  'heic',
]);

const KIND_AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'opus', 'silk']);

const KIND_VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'avi']);

/** Semantic `type` tokens the agent emits that map to a non-file kind. */
const IMAGE_TYPE_TOKENS = new Set(['image', 'img', 'photo']);
const AUDIO_TYPE_TOKENS = new Set(['audio', 'voice', 'mp3']);
const VIDEO_TYPE_TOKENS = new Set(['video', 'mp4', 'm4v', 'mov']);

/**
 * Derive the coarse outbound media kind, in precedence order:
 *
 *   1. explicit `mimeType` prefix (`image/*` / `audio/*` / `video/*`)
 *   2. semantic `type` token (image/img/photo → image; audio/voice/mp3 →
 *      audio; video/mp4/mov → video)
 *   3. file extension of `name` (preferred) or `path`
 *   4. default `'file'`
 */
export function deriveMediaKind(input: {
  type?: string;
  mimeType?: string;
  name?: string;
  path?: string;
}): OutboundMediaKind {
  const mimeType = input.mimeType?.trim().toLowerCase() ?? '';
  if (mimeType.startsWith('image/')) {
    return 'image';
  }
  if (mimeType.startsWith('audio/')) {
    return 'audio';
  }
  if (mimeType.startsWith('video/')) {
    return 'video';
  }

  const type = input.type?.trim().toLowerCase() ?? '';
  if (type) {
    if (IMAGE_TYPE_TOKENS.has(type)) {
      return 'image';
    }
    if (AUDIO_TYPE_TOKENS.has(type)) {
      return 'audio';
    }
    if (VIDEO_TYPE_TOKENS.has(type)) {
      return 'video';
    }
  }

  const extension =
    (input.name ? getPathExtension(input.name) : '') ||
    (input.path ? getPathExtension(input.path) : '');
  if (extension) {
    if (KIND_IMAGE_EXTENSIONS.has(extension)) {
      return 'image';
    }
    if (KIND_AUDIO_EXTENSIONS.has(extension)) {
      return 'audio';
    }
    if (KIND_VIDEO_EXTENSIONS.has(extension)) {
      return 'video';
    }
  }

  return 'file';
}
