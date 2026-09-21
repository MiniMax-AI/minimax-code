import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import type { TuiAttachment } from '../../../application/invocation.js';
import { inferTuiNativeVideoMimeType } from '../../../application/video-mime.js';
import { resolveWslPath } from '../../../host/wsl-path.js';
import { sanitizeTerminalText } from '../../rendering/terminal-text.js';
import type { TranscriptAttachment } from '../../transcript/model.js';
import { getTuiTerminalImagePasteFallbackPath } from './terminal-image-paste.js';

export type { TuiAttachment } from '../../../application/invocation.js';

export function tuiAttachmentLabel(
  attachment: { type: 'image' | 'file'; mimeType: string; fileName: string },
  index: number,
): string {
  if (attachment.type === 'image') return `[Image #${index + 1}]`;
  if (!attachment.mimeType.startsWith('video/')) return `[File #${index + 1}]`;
  const name = attachment.fileName.replaceAll(/[\u0000-\u001F\u007F[\]]/gu, '_').trim();
  return `[Video #${index + 1} ${name || 'video'}]`;
}

export interface ResolveTuiAttachmentOptions {
  workspaceDir: string;
  homeDir?: string;
  source?: 'terminal-paste';
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.csv': 'text/csv',
  '.gif': 'image/gif',
  '.html': 'text/html',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tsv': 'text/tab-separated-values',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
};

export async function resolveTuiAttachment(
  reference: string,
  options: ResolveTuiAttachmentOptions,
): Promise<TuiAttachment> {
  const normalizedReference = stripMatchingQuotes(reference.trim());
  if (!normalizedReference) throw new Error('Attachment path is required.');
  const userHome = options.homeDir ?? homedir();
  const expanded = await resolveWslPath(
    normalizedReference === '~'
      ? userHome
      : normalizedReference.startsWith('~/') || normalizedReference.startsWith('~\\')
        ? resolve(userHome, normalizedReference.slice(2))
        : normalizedReference,
  );
  let filePath = isAbsolute(expanded) ? resolve(expanded) : resolve(options.workspaceDir, expanded);
  const info = await stat(filePath)
    .catch((error: unknown) => {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      const canRetryPath = code === 'ENOENT' || code === 'ENOTDIR' || code === 'ENAMETOOLONG';
      if (options.source !== 'terminal-paste' || !canRetryPath) {
        throw error;
      }
      const fallbackPath = getTuiTerminalImagePasteFallbackPath(reference);
      if (!fallbackPath) throw error;
      filePath = resolve(fallbackPath);
      return stat(filePath);
    })
    .catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Cannot attach ${sanitizeTerminalText(normalizedReference)}: ${sanitizeTerminalText(reason)}`,
      );
    });
  if (!info.isFile()) {
    throw new Error(
      `Cannot attach ${sanitizeTerminalText(normalizedReference)}: path is not a file.`,
    );
  }
  const fileName = basename(filePath);
  const mimeType =
    MIME_BY_EXTENSION[extname(fileName).toLowerCase()] ??
    inferTuiNativeVideoMimeType(fileName) ??
    'application/octet-stream';
  return {
    type: mimeType.startsWith('image/') ? 'image' : 'file',
    filePath,
    fileName,
    mimeType,
    sizeBytes: info.size,
  };
}

export function formatTuiAttachments(attachments: readonly TuiAttachment[]): string {
  return attachments
    .map(
      (attachment, index) =>
        `${index + 1}. ${sanitizeTerminalText(attachment.fileName)} · ${attachment.mimeType} · ${formatBytes(attachment.sizeBytes)}`,
    )
    .join('\n');
}

export function formatTuiSubmission(
  content: string,
  _attachments: readonly { fileName: string }[],
): string {
  return content;
}

export function formatTuiHistorySubmission(
  content: string,
  _attachments: readonly {
    fileName: string;
    mimeType: string;
    sizeBytes?: number;
  }[],
): string {
  return content;
}

export function toTuiTranscriptAttachments(
  attachments: readonly {
    type: 'file' | 'image';
    fileName: string;
    mimeType: string;
    sizeBytes?: number;
    filePath?: string;
    assetId?: string;
    previewUrl?: string;
  }[],
): TranscriptAttachment[] {
  return attachments.map((attachment) => ({
    type: attachment.type,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    ...(attachment.sizeBytes !== undefined ? { sizeBytes: attachment.sizeBytes } : {}),
    ...(attachment.filePath ? { filePath: attachment.filePath } : {}),
    ...(attachment.assetId ? { assetId: attachment.assetId } : {}),
    ...(attachment.previewUrl ? { previewUrl: attachment.previewUrl } : {}),
  }));
}

function stripMatchingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value.at(-1);
  return (first === '"' && last === '"') || (first === "'" && last === "'")
    ? value.slice(1, -1)
    : value;
}

export function formatBytes(sizeBytes: number): string {
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${formatUnit(sizeBytes / 1024)} KB`;
  if (sizeBytes < 1024 * 1024 * 1024) return `${formatUnit(sizeBytes / (1024 * 1024))} MB`;
  return `${formatUnit(sizeBytes / (1024 * 1024 * 1024))} GB`;
}

function formatUnit(value: number): string {
  return value >= 10 || Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}
