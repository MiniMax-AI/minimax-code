import { basename, extname } from 'node:path';

import {
  createSessionAssetPathIndex,
  discardLocalAssetRegistrations,
  registerMessageAttachments,
  resolveSessionLocalAssetSource,
  type LocalAssetRegistrationReceipt,
  type RegisteredMessageAttachment,
} from '../assets/store.js';
import type { LocalRuntimeConfig } from '../config/types.js';
import type { RemoteAssetTransport } from '../assets/remote-source.js';
import {
  loadUserMediaCandidatesForMessages,
  type LocalMessageAttachment,
} from '../messages/input.js';

export interface HostedAttachmentInput {
  readonly type?: string;
  readonly filePath?: string;
  readonly fileName?: string;
  readonly mimeType?: string;
  readonly desktopPath?: string;
  readonly dataUrl?: string;
  readonly assetId?: string;
  readonly error?: string;
}

export interface HostedRegisteredAttachment extends RegisteredMessageAttachment {
  readonly registrationReceipt?: LocalAssetRegistrationReceipt;
}

interface HostedAttachmentCapabilitiesHost {
  readonly configGetter: () => Pick<LocalRuntimeConfig, 'dataDir'>;
  readonly remoteAssetTransport?: RemoteAssetTransport;
}

export function createHostedAttachmentCapabilities(host: HostedAttachmentCapabilitiesHost) {
  const sessionAssets = createSessionAssetPathIndex(() => host.configGetter().dataDir);
  return {
    /**
     * Asset files the given Sessions registered (attachments, generated media).
     * The runtime hands the Agent these paths, so they become its read grant.
     */
    listSessionReadablePaths: async (sessionIds: readonly string[]) =>
      sessionAssets.listSessionAssetPaths(sessionIds),
    register: (input: {
      readonly sessionId: string;
      readonly turnId?: string;
      readonly attachments: readonly HostedAttachmentInput[];
    }) => registerAttachments(host, input),
    discard: (input: {
      readonly sessionId: string;
      readonly receipts: readonly LocalAssetRegistrationReceipt[];
    }) =>
      discardLocalAssetRegistrations({
        dataDir: host.configGetter().dataDir,
        sessionId: input.sessionId,
        receipts: input.receipts,
      }),
    resolveSource: (input: { readonly sessionId: string; readonly filePath: string }) =>
      resolveSessionLocalAssetSource({
        dataDir: host.configGetter().dataDir,
        sessionId: input.sessionId,
        filePath: input.filePath,
      }),
    materialize: (input: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly attachmentIndex: number;
      readonly attachment: HostedAttachmentInput;
    }) => materializeAttachment(host, input),
  } as const;
}

/**
 * Registers one attachment and reports its stored bytes as the inline media
 * source. Images are not resized here: the turn encodes them once, to
 * `requestMedia.image`, like every other image entering the conversation.
 */
async function materializeAttachment(
  host: HostedAttachmentCapabilitiesHost,
  input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly attachmentIndex: number;
    readonly attachment: HostedAttachmentInput;
  },
) {
  const raw = normalizeAttachment(input.attachment, input.attachmentIndex);
  const [registered] = await registerAttachments(
    host,
    {
      sessionId: input.sessionId,
      turnId: input.turnId,
      attachments: [input.attachment],
    },
    input.attachmentIndex,
  );
  if (!registered) throw new Error('Attachment registration returned no result.');
  const media = await loadUserMediaCandidatesForMessages(
    [{ content: '', attachments: [raw] }],
    [{ content: '', attachments: [registered] }],
    { preprocessImages: false },
  );
  const candidate = media?.[0];
  return {
    // Read the immutable upload snapshot. Original-path metadata is resolved
    // separately for provenance; it must not change the bytes sent by the user.
    filePath: registered.filePath,
    fileName: registered.fileName,
    mimeType: registered.mimeType,
    kind: attachmentKind(registered),
    ...(candidate
      ? {
          inlineMedia: {
            id: candidate.id,
            sizeBytes: candidate.sizeBytes,
            ...(candidate.data ? { data: candidate.data } : {}),
            ...(candidate.mime ? { mime: candidate.mime } : {}),
          },
        }
      : {}),
  };
}

async function registerAttachments(
  host: HostedAttachmentCapabilitiesHost,
  input: {
    readonly sessionId: string;
    readonly turnId?: string;
    readonly attachments: readonly HostedAttachmentInput[];
  },
  firstAttachmentIndex = 0,
): Promise<HostedRegisteredAttachment[]> {
  const normalized = input.attachments.map((attachment, index) =>
    normalizeAttachment(attachment, firstAttachmentIndex + index),
  );
  const registered = await registerMessageAttachments({
    dataDir: host.configGetter().dataDir,
    attachments: normalized,
    sessionId: input.sessionId,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(host.remoteAssetTransport ? { remoteAssetTransport: host.remoteAssetTransport } : {}),
  });
  return registered.map((attachment, index) => ({
    ...attachment,
    ...createdRegistrationReceipt(normalized[index], attachment),
  }));
}

function createdRegistrationReceipt(
  source: LocalMessageAttachment | undefined,
  registered: RegisteredMessageAttachment,
): Pick<HostedRegisteredAttachment, 'registrationReceipt'> {
  if (!registered.assetId || !registered.filePath) return {};
  if (source?.assetId === registered.assetId && source.filePath === registered.filePath) return {};
  return {
    registrationReceipt: { assetId: registered.assetId, filePath: registered.filePath },
  };
}

function normalizeAttachment(attachment: HostedAttachmentInput, index = 0): LocalMessageAttachment {
  const filePath = attachment.filePath?.trim() ?? '';
  const dataUrl = attachment.dataUrl?.trim();
  if (!filePath && !dataUrl) throw new Error(`Attachment ${String(index)} has no readable source.`);
  const mimeType = attachment.mimeType?.trim() || 'application/octet-stream';
  return {
    type:
      attachment.type === 'image' || mimeType.toLowerCase().startsWith('image/') ? 'image' : 'file',
    filePath,
    fileName:
      attachment.fileName?.trim() || (filePath ? basename(filePath) : `attachment-${index}`),
    mimeType,
    ...(attachment.desktopPath ? { desktopPath: attachment.desktopPath } : {}),
    ...(dataUrl ? { dataUrl } : {}),
    ...(attachment.assetId ? { assetId: attachment.assetId } : {}),
    ...(attachment.error ? { error: attachment.error } : {}),
  };
}

function attachmentKind(
  attachment: Pick<LocalMessageAttachment, 'fileName' | 'mimeType' | 'type'>,
): 'image' | 'video' | 'text' | 'file' {
  const mime = attachment.mimeType.toLowerCase();
  if (attachment.type === 'image' || mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (
    mime.startsWith('text/') ||
    ['.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.ts', '.tsx', '.js'].includes(
      extname(attachment.fileName).toLowerCase(),
    )
  ) {
    return 'text';
  }
  return 'file';
}
