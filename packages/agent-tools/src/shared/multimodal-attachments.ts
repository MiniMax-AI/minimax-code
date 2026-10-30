/**
 * Shared native multimodal attachment selection for local/cloud hosts.
 *
 * Hosts own IO (download, local asset registration). This helper owns the
 * provider-facing contract: supported MIME allowlists, capability gates,
 * request/body caps, and the image encoding inline attachments share with
 * tool result images. Keeping that logic here prevents local-runtime and
 * cloud-runtime from drifting on video/image attachment behavior.
 */

import {
  encodeRequestImageDetails,
  type EncodedRequestImageDetails,
  type RequestImageEncoding,
} from '@mavis/context-manager';

/** Hosts that may not depend on context-manager pass the image encoding through this name. */
export type AttachmentImageEncoding = RequestImageEncoding;
export type EncodedAttachmentImage = EncodedRequestImageDetails;

export interface MultimodalAttachmentCapabilities {
  readonly support_image?: unknown;
  readonly support_video?: unknown;
  readonly max_image_bytes_inline?: unknown;
  readonly max_video_bytes_inline?: unknown;
  readonly max_request_body_bytes?: unknown;
  readonly max_attachments_count?: unknown;
}

export interface MultimodalAttachmentCandidate {
  readonly id: string;
  readonly mime: string;
  readonly sizeBytes: number;
}

export interface MultimodalAttachmentReferenceCandidate extends MultimodalAttachmentCandidate {
  readonly fileName?: string;
  readonly filePath?: string;
}

export type MultimodalAttachmentKind = 'image' | 'video';

export type MultimodalAttachmentDemoteReason =
  | 'unsupported_mime'
  | 'unsupported_model'
  | 'max_image_bytes_inline'
  | 'max_video_bytes_inline'
  | 'max_attachments_count'
  | 'max_request_body_bytes';

export interface SelectedMultimodalAttachment<T extends MultimodalAttachmentCandidate> {
  readonly candidate: T;
  readonly kind: MultimodalAttachmentKind;
  readonly mime: string;
  readonly base64SizeBytes: number;
}

export interface DemotedMultimodalAttachment<T extends MultimodalAttachmentCandidate> {
  readonly candidate: T;
  readonly reason: MultimodalAttachmentDemoteReason;
  readonly kind?: MultimodalAttachmentKind;
  readonly mime: string;
  readonly base64SizeBytes: number;
  readonly capBytes?: number;
}

export interface SelectMultimodalAttachmentsResult<T extends MultimodalAttachmentCandidate> {
  readonly kept: Array<SelectedMultimodalAttachment<T>>;
  readonly demoted: Array<DemotedMultimodalAttachment<T>>;
}

export interface MultimodalDemotionReference {
  readonly fileName: string;
  readonly mime: string;
  readonly reason: MultimodalAttachmentDemoteReason;
  readonly filePath?: string;
}

const SUPPORTED_NATIVE_IMAGE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

const SUPPORTED_NATIVE_VIDEO_MIME_TYPES = new Set([
  'video/mp4',
  'video/x-msvideo',
  'video/quicktime',
  'video/x-matroska',
  'video/mkv',
]);

export function normaliseMultimodalMimeType(mime: string | undefined): string {
  return mime?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

export function isSupportedNativeImageMime(mime: string | undefined): boolean {
  return SUPPORTED_NATIVE_IMAGE_MIME_TYPES.has(normaliseMultimodalMimeType(mime));
}

export function isSupportedNativeVideoMime(mime: string | undefined): boolean {
  return SUPPORTED_NATIVE_VIDEO_MIME_TYPES.has(normaliseMultimodalMimeType(mime));
}

export function nativeMultimodalKindForMime(
  mime: string | undefined,
): MultimodalAttachmentKind | undefined {
  const normalized = normaliseMultimodalMimeType(mime);
  if (isSupportedNativeImageMime(normalized)) return 'image';
  if (isSupportedNativeVideoMime(normalized)) return 'video';
  return undefined;
}

export function isMediaMime(mime: string | undefined): boolean {
  const normalized = normaliseMultimodalMimeType(mime);
  return normalized.startsWith('image/') || normalized.startsWith('video/');
}

export function base64EncodedSize(rawBytes: number): number {
  return Math.ceil(Math.max(0, rawBytes) / 3) * 4;
}

/**
 * Encode an inline image attachment like a tool result image, so it fits every
 * provider the session may switch to. `undefined` keeps the original bytes.
 */
export function encodeAttachmentImage(
  bytes: Uint8Array,
  mime: string,
  encoding?: AttachmentImageEncoding,
): Promise<EncodedAttachmentImage | undefined> {
  return encodeRequestImageDetails(bytes, mime, encoding);
}

export function selectMultimodalAttachments<T extends MultimodalAttachmentCandidate>(
  candidates: readonly T[],
  capabilities: MultimodalAttachmentCapabilities | undefined,
): SelectMultimodalAttachmentsResult<T> {
  const kept: Array<SelectedMultimodalAttachment<T>> = [];
  const demoted: Array<DemotedMultimodalAttachment<T>> = [];
  const maxImage = numberCap(capabilities, 'max_image_bytes_inline');
  const maxVideo = numberCap(capabilities, 'max_video_bytes_inline');
  const maxBody = numberCap(capabilities, 'max_request_body_bytes');
  const maxCount = integerCap(capabilities, 'max_attachments_count');
  let runningBase64Bytes = 0;

  for (const candidate of candidates) {
    const mime = normaliseMultimodalMimeType(candidate.mime);
    const kind = nativeMultimodalKindForMime(mime);
    const base64SizeBytes = base64EncodedSize(candidate.sizeBytes);

    if (!kind) {
      demoted.push({ candidate, reason: 'unsupported_mime', mime, base64SizeBytes });
      continue;
    }
    if (kind === 'image' && capabilities?.support_image !== true) {
      demoted.push({ candidate, reason: 'unsupported_model', kind, mime, base64SizeBytes });
      continue;
    }
    if (kind === 'video' && capabilities?.support_video !== true) {
      demoted.push({ candidate, reason: 'unsupported_model', kind, mime, base64SizeBytes });
      continue;
    }
    if (kind === 'image' && maxImage > 0 && candidate.sizeBytes > maxImage) {
      demoted.push({
        candidate,
        reason: 'max_image_bytes_inline',
        kind,
        mime,
        base64SizeBytes,
        capBytes: maxImage,
      });
      continue;
    }
    if (kind === 'video' && maxVideo > 0 && candidate.sizeBytes > maxVideo) {
      demoted.push({
        candidate,
        reason: 'max_video_bytes_inline',
        kind,
        mime,
        base64SizeBytes,
        capBytes: maxVideo,
      });
      continue;
    }
    if (maxCount > 0 && kept.length >= maxCount) {
      demoted.push({
        candidate,
        reason: 'max_attachments_count',
        kind,
        mime,
        base64SizeBytes,
        capBytes: maxCount,
      });
      continue;
    }
    if (maxBody > 0 && runningBase64Bytes + base64SizeBytes > maxBody) {
      demoted.push({
        candidate,
        reason: 'max_request_body_bytes',
        kind,
        mime,
        base64SizeBytes,
        capBytes: maxBody,
      });
      continue;
    }

    kept.push({ candidate, kind, mime, base64SizeBytes });
    runningBase64Bytes += base64SizeBytes;
  }

  return { kept, demoted };
}

export function multimodalDemotionReasonCounts(
  demoted: readonly DemotedMultimodalAttachment<MultimodalAttachmentCandidate>[],
): Map<MultimodalAttachmentDemoteReason, number> {
  const counts = new Map<MultimodalAttachmentDemoteReason, number>();
  for (const item of demoted) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1);
  return counts;
}

export function multimodalDemotionTextNotes(
  demoted: readonly DemotedMultimodalAttachment<MultimodalAttachmentCandidate>[],
): string[] {
  if (demoted.length === 0) return [];
  const counts = multimodalDemotionReasonCounts(demoted);
  const notes: string[] = [];
  const unsupported = counts.get('unsupported_model') ?? 0;
  if (unsupported > 0) {
    notes.push(
      `[Note: ${unsupported} media attachment(s) were received but the current model cannot view their modality. Ask the user for a text description if needed.]`,
    );
  }
  const capped =
    (counts.get('max_image_bytes_inline') ?? 0) +
    (counts.get('max_video_bytes_inline') ?? 0) +
    (counts.get('max_attachments_count') ?? 0) +
    (counts.get('max_request_body_bytes') ?? 0);
  if (capped > 0) {
    notes.push(
      `[Note: ${capped} media attachment(s) exceeded the current model's inline media limits and were left as file references.]`,
    );
  }
  return notes;
}

export function multimodalDemotionReferences<T extends MultimodalAttachmentReferenceCandidate>(
  demoted: readonly DemotedMultimodalAttachment<T>[],
): MultimodalDemotionReference[] {
  return demoted
    .filter((item) => item.reason !== 'unsupported_mime')
    .map((item) => ({
      fileName:
        item.candidate.fileName || item.candidate.filePath?.split('/').pop() || 'attachment',
      mime: item.mime || normaliseMultimodalMimeType(item.candidate.mime),
      reason: item.reason,
      ...(item.candidate.filePath ? { filePath: item.candidate.filePath } : {}),
    }));
}

export function renderMultimodalDemotionReference(ref: MultimodalDemotionReference): string {
  const attrs = [
    `name="${escapeAttachmentAttr(ref.fileName)}"`,
    `mime="${escapeAttachmentAttr(ref.mime)}"`,
    `reason="${escapeAttachmentAttr(ref.reason)}"`,
  ];
  return [
    `<attachment ${attrs.join(' ')}>`,
    ref.filePath
      ? `Media attachment was not sent inline. Local path: ${ref.filePath}`
      : 'Media attachment was not sent inline.',
    '</attachment>',
  ].join('\n');
}

function escapeAttachmentAttr(value: string): string {
  return value.replace(/[&"]/g, (char) => (char === '&' ? '&amp;' : '&quot;'));
}

function numberCap(
  capabilities: MultimodalAttachmentCapabilities | undefined,
  key:
    | 'max_image_bytes_inline'
    | 'max_video_bytes_inline'
    | 'max_request_body_bytes'
    | 'max_attachments_count',
): number {
  const value = capabilities?.[key];
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 0;
}

function integerCap(
  capabilities: MultimodalAttachmentCapabilities | undefined,
  key: 'max_attachments_count',
): number {
  const value = numberCap(capabilities, key);
  return Number.isInteger(value) ? value : 0;
}
