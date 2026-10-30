import { readFile } from 'node:fs/promises';

import type { UserMessageInput } from '@mavis/agent-core/pi-turn-runner';
import {
  encodeAttachmentImage,
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

/** Concrete local media IO kept outside the AgentHost orchestration core. */
export async function prepareLocalInlineMedia(
  candidates: readonly LocalInlineMediaCandidate[],
  capabilities: LocalMultimodalAttachmentCapabilities | undefined,
  encoding?: LocalAttachmentImageEncoding,
): Promise<{
  readonly attachments: NonNullable<UserMessageInput['attachments']>;
  readonly inlinedKeys: ReadonlySet<string>;
  readonly items: readonly {
    readonly key: string;
    readonly attachment: NonNullable<UserMessageInput['attachments']>[number];
  }[];
}> {
  const selected = selectMultimodalAttachments(candidates, capabilities);
  const materialized = await Promise.all(
    selected.kept.map(async ({ candidate, kind, mime }) => {
      const bytes = await readInlineMediaBytes(candidate);
      if (!bytes) return undefined;
      const media = (kind === 'image'
        ? await encodeAttachmentImage(bytes, mime, encoding)
        : undefined) ?? {
        data: candidate.data ?? Buffer.from(bytes).toString('base64'),
        mimeType: mime,
      };
      return { key: candidate.key, attachment: { type: 'image' as const, ...media } };
    }),
  );
  const available = materialized.filter(
    (item): item is NonNullable<typeof item> => item !== undefined,
  );
  return {
    attachments: available.map(({ attachment }) => attachment),
    items: available,
    inlinedKeys: new Set(available.map(({ key }) => key)),
  };
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
