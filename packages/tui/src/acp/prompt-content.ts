import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import * as acp from '@agentclientprotocol/sdk';

import {
  MINIMAX_CODE_MAX_ATTACHMENT_COUNT,
  MINIMAX_CODE_MAX_TOTAL_ATTACHMENT_BYTES,
  findTuiAttachmentLimitViolation,
} from '../application/attachment-policy.js';
import type { TuiAttachment } from '../application/invocation.js';
import type { TuiMessageAttachment } from '../runtime/stream-events.js';

const ACP_PROMPT_IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/u;
const TEMPORARY_DIRECTORY_PREFIX = 'minimax-code-acp-prompt-';
/** Per-image bound for history replay; larger images replay as a text placeholder. */
export const TUI_ACP_HISTORY_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

interface TuiAcpPromptImage {
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: Buffer;
}

/** A validated ACP prompt: text for the Runtime plus decoded image attachments. */
export interface TuiAcpPrompt {
  readonly content: string;
  readonly images: readonly TuiAcpPromptImage[];
}

export interface TuiAcpPromptAttachments {
  readonly attachments: readonly TuiAttachment[];
  dispose(): Promise<void>;
}

/**
 * Validates every ACP prompt block before the Session is touched. Unsupported
 * blocks and malformed or oversized images are rejected as invalid params.
 */
export function parseTuiAcpPrompt(blocks: readonly acp.ContentBlock[]): TuiAcpPrompt {
  const text: string[] = [];
  const imageBlocks: Extract<acp.ContentBlock, { type: 'image' }>[] = [];
  for (const block of blocks) {
    if (block.type === 'text') {
      text.push(block.text);
    } else if (block.type === 'resource_link') {
      text.push(`Referenced resource: ${block.title ?? block.name} (${block.uri})`);
    } else if (block.type === 'image') {
      imageBlocks.push(block);
    } else {
      throw invalidPrompt(`Prompt content type ${block.type} is not supported.`);
    }
  }
  // Enforce count and total size from the encoded lengths before any image is
  // decoded, so an over-limit prompt never allocates its decoded buffers.
  const violation = findTuiAttachmentLimitViolation(
    imageBlocks.map((block) => ({ sizeBytes: estimateDecodedBytes(block.data) })),
  );
  if (violation === 'count') {
    throw invalidPrompt(
      `A prompt can include at most ${MINIMAX_CODE_MAX_ATTACHMENT_COUNT} images.`,
    );
  }
  if (violation === 'total-bytes') {
    throw invalidPrompt(
      `Prompt images exceed the ${MINIMAX_CODE_MAX_TOTAL_ATTACHMENT_BYTES / (1024 * 1024)} MB total limit.`,
    );
  }
  const images = imageBlocks.map((block, index) => decodePromptImage(block, index + 1));
  return { content: text.join('\n\n'), images };
}

/**
 * Writes decoded images to a private temporary directory so the Runtime can
 * register them like interactive TUI attachments. The Runtime copies each file
 * into Session assets on admission; callers dispose after the Turn settles.
 */
export async function writeTuiAcpPromptAttachments(
  prompt: TuiAcpPrompt,
  options: { readonly tempRoot?: string } = {},
): Promise<TuiAcpPromptAttachments> {
  if (prompt.images.length === 0) {
    return { attachments: [], dispose: async () => undefined };
  }
  const directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), TEMPORARY_DIRECTORY_PREFIX));
  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    await rm(directory, { force: true, recursive: true });
  };
  try {
    const attachments: TuiAttachment[] = [];
    for (const image of prompt.images) {
      const filePath = join(directory, image.fileName);
      await writeFile(filePath, image.bytes, { mode: 0o600 });
      attachments.push({
        type: 'image',
        fileName: image.fileName,
        mimeType: image.mimeType,
        filePath,
        sizeBytes: image.bytes.byteLength,
      });
    }
    return { attachments, dispose };
  } catch (error) {
    await dispose().catch(() => undefined);
    throw error;
  }
}

/**
 * Rebuilds ACP content for the image attachments of a persisted user message.
 * Images are read from their Runtime Session asset path; a missing, unreadable,
 * or oversized image replays as a text placeholder so the turn stays visible.
 */
export async function readTuiAcpHistoryImages(
  attachments: readonly TuiMessageAttachment[] | undefined,
  options: { readonly maxBytes?: number } = {},
): Promise<acp.ContentBlock[]> {
  const maxBytes = options.maxBytes ?? TUI_ACP_HISTORY_IMAGE_MAX_BYTES;
  const blocks: acp.ContentBlock[] = [];
  for (const attachment of attachments ?? []) {
    if (attachment.type !== 'image') continue;
    const data = await readHistoryImage(attachment, maxBytes);
    blocks.push(
      data
        ? { type: 'image', mimeType: attachment.mimeType, data }
        : { type: 'text', text: `[Image: ${attachment.fileName}]` },
    );
  }
  return blocks;
}

async function readHistoryImage(
  attachment: TuiMessageAttachment,
  maxBytes: number,
): Promise<string | undefined> {
  if (!attachment.filePath || !isAbsolute(attachment.filePath)) return undefined;
  if (!attachment.mimeType.toLowerCase().startsWith('image/')) return undefined;
  try {
    const info = await stat(attachment.filePath);
    if (!info.isFile() || info.size === 0 || info.size > maxBytes) return undefined;
    return (await readFile(attachment.filePath)).toString('base64');
  } catch {
    return undefined;
  }
}

function decodePromptImage(
  block: Extract<acp.ContentBlock, { type: 'image' }>,
  index: number,
): TuiAcpPromptImage {
  const mimeType = block.mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  const extension = ACP_PROMPT_IMAGE_EXTENSIONS[mimeType];
  if (!extension) {
    throw invalidPrompt(
      `Prompt image MIME type ${block.mimeType} is not supported. Use PNG, JPEG, WebP, or GIF.`,
    );
  }
  const data = block.data.replace(/\s/gu, '');
  if (!data || data.length % 4 === 1 || !BASE64_PATTERN.test(data)) {
    throw invalidPrompt(`Prompt image ${index} is not valid base64 data.`);
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.byteLength === 0) {
    throw invalidPrompt(`Prompt image ${index} is empty.`);
  }
  return { fileName: `image-${index}.${extension}`, mimeType, bytes };
}

/** Upper bound of the decoded size, computed without decoding. */
function estimateDecodedBytes(data: string): number {
  let length = 0;
  let padding = 0;
  for (let index = 0; index < data.length; index += 1) {
    const code = data.charCodeAt(index);
    // Skip ASCII whitespace, matching the decoder's normalization.
    if (code === 0x20 || (code >= 0x09 && code <= 0x0d)) continue;
    length += 1;
    padding = code === 0x3d ? padding + 1 : 0;
  }
  return Math.max(0, Math.floor((length * 3) / 4) - Math.min(padding, 2));
}

function invalidPrompt(message: string): acp.RequestError {
  return acp.RequestError.invalidParams(undefined, message);
}
