import { readFile } from 'node:fs/promises';

import type { UserMessageInput } from '@mavis/agent-core/pi-turn-runner';
import {
  encodeAttachmentImage,
  nativeMultimodalKindForMime,
  selectMultimodalAttachments,
  type AttachmentImageEncoding,
  type MultimodalAttachmentCapabilities,
} from '@mavis/agent-tools';

export type LocalMultimodalAttachmentCapabilities = MultimodalAttachmentCapabilities;
export type LocalAttachmentImageEncoding = AttachmentImageEncoding;

export interface LocalInlineMediaCandidate {
  readonly key: string;
  readonly id: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly filePath: string;
  readonly data?: string;
}

interface EncodedInlineMediaCandidate extends LocalInlineMediaCandidate {
  readonly dimensionNote?: string;
}

/**
 * Concrete local media IO kept outside the AgentHost orchestration core.
 *
 * Images are encoded to `encoding` before the capability limits are checked,
 * so a large original that encodes small enough is still sent inline. An
 * image that cannot be decoded is never inlined and stays a path reference:
 * history would replay its bytes into every later request.
 */
export async function prepareLocalInlineMedia(
  candidates: readonly LocalInlineMediaCandidate[],
  capabilities: LocalMultimodalAttachmentCapabilities | undefined,
  encoding?: LocalAttachmentImageEncoding,
): Promise<{
  readonly attachments: NonNullable<UserMessageInput['attachments']>;
  readonly inlinedKeys: ReadonlySet<string>;
  /** Original-size notes of inlined images that were scaled down, by candidate key. */
  readonly dimensionNotes: ReadonlyMap<string, string>;
  readonly items: readonly {
    readonly key: string;
    readonly attachment: NonNullable<UserMessageInput['attachments']>[number];
  }[];
}> {
  const encoded = await Promise.all(
    candidates.map((candidate) => encodeInlineImage(candidate, capabilities, encoding)),
  );
  const selected = selectMultimodalAttachments(
    encoded.filter(
      (candidate): candidate is EncodedInlineMediaCandidate => candidate !== undefined,
    ),
    capabilities,
  );
  const materialized = await Promise.all(
    selected.kept.map(async ({ candidate, mime }) => {
      const data = candidate.data ?? (await readInlineMediaData(candidate));
      if (!data) return undefined;
      return {
        key: candidate.key,
        attachment: { type: 'image' as const, data, mimeType: mime },
        dimensionNote: candidate.dimensionNote,
      };
    }),
  );
  const available = materialized.filter(
    (item): item is NonNullable<typeof item> => item !== undefined,
  );
  return {
    attachments: available.map(({ attachment }) => attachment),
    items: available.map(({ key, attachment }) => ({ key, attachment })),
    inlinedKeys: new Set(available.map(({ key }) => key)),
    dimensionNotes: new Map(
      available.flatMap(({ key, dimensionNote }) =>
        dimensionNote ? [[key, dimensionNote] as const] : [],
      ),
    ),
  };
}

async function encodeInlineImage(
  candidate: LocalInlineMediaCandidate,
  capabilities: LocalMultimodalAttachmentCapabilities | undefined,
  encoding: LocalAttachmentImageEncoding | undefined,
): Promise<EncodedInlineMediaCandidate | undefined> {
  if (
    nativeMultimodalKindForMime(candidate.mime) !== 'image' ||
    capabilities?.support_image !== true
  ) {
    return candidate;
  }
  const bytes = await readInlineMediaBytes(candidate);
  if (!bytes) return candidate;
  const encoded = await encodeAttachmentImage(bytes, candidate.mime, encoding);
  if (encoded === 'undecodable') return undefined;
  if (!encoded) {
    return candidate.data
      ? candidate
      : { ...candidate, data: Buffer.from(bytes).toString('base64'), sizeBytes: bytes.length };
  }
  return {
    ...candidate,
    data: encoded.image.data,
    mime: encoded.image.mimeType,
    sizeBytes: Buffer.byteLength(encoded.image.data, 'base64'),
    ...(encoded.dimensionNote ? { dimensionNote: encoded.dimensionNote } : {}),
  };
}

async function readInlineMediaData(
  candidate: LocalInlineMediaCandidate,
): Promise<string | undefined> {
  const bytes = await readInlineMediaBytes(candidate);
  return bytes ? Buffer.from(bytes).toString('base64') : undefined;
}

async function readInlineMediaBytes(
  candidate: LocalInlineMediaCandidate,
): Promise<Uint8Array | undefined> {
  if (candidate.data) return Buffer.from(candidate.data, 'base64');
  try {
    return await readFile(candidate.filePath);
  } catch {
    return undefined;
  }
}
