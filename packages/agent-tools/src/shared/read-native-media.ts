/**
 * Native audio / PDF reads for the `read` tool.
 *
 * Only a model whose transport carries audio and PDF natively (Gemini) sets
 * `support_audio` / `support_pdf`; for it the file rides pi-ai's media path as
 * an `ImageContent` block with the real MIME, like video. Every other model
 * keeps the previous behavior (audio is a binary-file error, PDF is extracted
 * text), so the caller falls through when this returns `undefined`.
 */

import type { ToolResult } from '@mavis/agent-core/tools';

import {
  selectMultimodalAttachments,
  type MultimodalAttachmentCapabilities,
} from './multimodal-attachments.js';
import { readFile, stat } from './physical-fs.js';

export interface ReadNativeMediaOptions {
  readonly toolName: string;
  readonly absolutePath: string;
  readonly kind: 'audio' | 'pdf';
  readonly mimeType: string;
  readonly capabilities: MultimodalAttachmentCapabilities | undefined;
  readonly signal?: AbortSignal;
}

/**
 * Inline result, a text-only notice when the file exceeds the model's inline
 * caps, or `undefined` when the model does not read this kind natively.
 */
export async function readNativeMediaAsToolResult(
  opts: ReadNativeMediaOptions,
): Promise<ToolResult | undefined> {
  const supportKey = opts.kind === 'audio' ? 'support_audio' : 'support_pdf';
  if (opts.capabilities?.[supportKey] !== true) return undefined;
  if (opts.signal?.aborted) throw new Error('Operation aborted');
  const info = await stat(opts.absolutePath);
  if (opts.signal?.aborted) throw new Error('Operation aborted');

  const label = opts.kind === 'audio' ? 'audio' : 'PDF';
  const selection = selectMultimodalAttachments(
    [{ id: opts.absolutePath, mime: opts.mimeType, sizeBytes: info.size }],
    opts.capabilities,
  );
  const kept = selection.kept[0];
  if (!kept) {
    const demoted = selection.demoted[0];
    const reason = demoted?.reason ?? 'unsupported_mime';
    const cap = demoted?.capBytes ? ` (limit ${String(demoted.capBytes)} bytes)` : '';
    const text = `Read ${label} file [${opts.mimeType}]\n[${label} omitted: ${String(info.size)} bytes exceeds the current model's inline media limit ${reason}${cap}.]`;
    // A PDF still has a text fallback; let the caller extract it instead.
    if (opts.kind === 'pdf') return undefined;
    return {
      tool_name: opts.toolName,
      text,
      content: [{ type: 'text', text }],
      details: {
        media: {
          kind: opts.kind,
          mime_type: opts.mimeType,
          size_bytes: info.size,
          inline: false,
          reason,
        },
      },
    };
  }

  const bytes = await readFile(opts.absolutePath);
  if (opts.signal?.aborted) throw new Error('Operation aborted');
  const text = `Read ${label} file [${kept.mime}]`;
  return {
    tool_name: opts.toolName,
    text,
    content: [
      { type: 'text', text },
      { type: 'image', data: bytes.toString('base64'), mimeType: kept.mime },
    ],
    details: {
      media: { kind: opts.kind, mime_type: kept.mime, size_bytes: info.size, inline: true },
    },
  };
}
