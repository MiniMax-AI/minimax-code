import type { RunTurnCaller, UserMessageInput } from '@mavis/agent-core/pi-turn-runner';

import type { SessionRecord } from '../../../session-system/index.js';
import type { AcceptedTurnLease } from '../runner/contracts.js';
import type { AgentHostTurnCapabilityView } from './turn-capability-lifecycle.js';
import type {
  AgentExecutionSnapshot,
  AgentHostBrowserAsset,
  AgentHostCanonicalUserInput,
  AgentHostChannelContext,
  AgentHostInputAttachment,
  AgentHostExecutionRequest,
  AgentHostQueuedUserInput,
  AgentHostTurnProvenance,
  AgentHostUserInput,
  LocalTurnPreparation,
} from '../preparation/contracts.js';
import {
  createCanonicalAgentHostSteeringInput,
  createCanonicalAgentHostUserInput,
} from '../canonical-user-input.js';
import { createBackgroundTaskHostMetadata } from '../history/background/host-metadata.js';
import { assertAgentHostCapabilityAvailable } from '../empty-dependencies.js';
import { messagesCarrySessionId } from '../compaction/session-identity.js';
import {
  prepareLocalInlineMedia,
  type LocalInlineMediaCandidate,
  type LocalMultimodalAttachmentCapabilities,
} from '../preparation/inline-media.js';
import {
  projectLocalAgentReferencesForModel,
  type LocalAgentReferenceProjection,
} from '../preparation/agent-prompt-surface.js';

type AgentReferenceResolution = Awaited<
  ReturnType<LocalAgentReferenceProjection['resolveAgentReference']>
>;

export interface LocalTurnPreparedAttachment {
  readonly filePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly kind: 'image' | 'video' | 'text' | 'file';
  /** Product IO fact; v2 still owns capability/limit selection and final reads. */
  readonly inlineMedia?: {
    readonly id: string;
    readonly sizeBytes: number;
    readonly data?: string;
    /**
     * Mime of the inlined payload when it differs from the stored file — image
     * preprocessing may transcode a large PNG to JPEG to fit the inline budget.
     * `mimeType` above keeps describing the stored asset.
     */
    readonly mime?: string;
  };
}

export interface LocalTurnAttachmentMaterializer {
  materialize(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly messageIndex: number;
    readonly attachmentIndex: number;
    /** Total image attachment count across this canonical user input. */
    readonly imageAttachmentCount: number;
    readonly attachment: AgentHostInputAttachment;
    readonly modelCapabilities?: LocalMultimodalAttachmentCapabilities;
  }): Promise<LocalTurnPreparedAttachment>;
}

export interface LocalTurnReminderFacts {
  readonly buildBackground: (input: {
    readonly session: SessionRecord;
  }) => Promise<BackgroundReminderFacts>;
  /**
   * Confirms actual successful `task_output` reads against current durable
   * Session-scoped task state. This must not be bound to the reminder snapshot.
   */
  readonly confirmBackgroundTaskReads: (input: {
    readonly sessionId: string;
    readonly taskIds: readonly string[];
  }) => readonly string[] | Promise<readonly string[]>;
  readonly buildSystem: (input: {
    readonly session: SessionRecord;
    readonly agent: AgentExecutionSnapshot;
    readonly agentConfig: Readonly<Record<string, unknown>>;
    readonly promptText: string;
    readonly turnId: string;
    readonly desktopCapabilities?: AgentHostTurnCapabilityView;
    /**
     * True when a user message in the model-visible history since the latest
     * compaction already contains this session's ID, so per-turn reminders may
     * omit it. False on the first turn and after a compaction dropped it.
     */
    readonly sessionIdInContext?: boolean;
  }) => Promise<{
    readonly content: string;
    readonly diagnostic?: unknown;
    readonly finalizeTelemetry?: (input: {
      readonly content: string;
      readonly diagnostic?: unknown;
    }) => void;
  }>;
}

interface BackgroundReminderTaskFact {
  readonly taskId: string;
  readonly status: 'succeeded' | 'failed' | 'canceled' | 'lost';
  readonly endedAtMs?: number;
}

export interface BackgroundReminderFacts {
  readonly tasks: readonly BackgroundReminderTaskFact[];
  readonly undeliveredTotal: number;
  readonly terminalTotal: number;
}

export interface LocalTurnInputPreparerOptions {
  readonly assets?: LocalTurnAttachmentMaterializer;
  /** Product-owned source materialization that must finish before reminder/model preparation. */
  readonly materializePrompt?: (input: {
    readonly content: string;
    readonly workspaceDir: string;
    readonly signal: AbortSignal;
  }) => Promise<string>;
  /**
   * Runtime-owned resolver for persisted Agent reference protocol. Incoming and
   * display objects are never mutated in place; prepared Pi input and canonical
   * history use expanded text.
   */
  readonly agentReferenceProjection?: LocalAgentReferenceProjection;
  readonly reminders: LocalTurnReminderFacts;
}

export interface LocalTurnInputPreparationRequest {
  readonly lease: AcceptedTurnLease;
  readonly session: SessionRecord;
  readonly agent: AgentExecutionSnapshot;
  readonly preparation: LocalTurnPreparation;
  readonly canonicalUserInput: AgentHostCanonicalUserInput;
  readonly genuineUserQueryText: string;
  readonly immediateSendBatch?: AgentHostExecutionRequest['immediateSendBatch'];
  readonly provenance: AgentHostTurnProvenance;
  readonly desktopCapabilities?: AgentHostTurnCapabilityView;
  /** Provider-facing history before this turn's user message. */
  readonly history?: readonly unknown[];
}

export interface PreparedLocalTurnInput {
  readonly initialBatchMessages?: readonly UserMessageInput[];
  readonly initialBatchGenuineUserQueryTexts?: readonly string[];
  readonly promptText: string;
  readonly genuineUserQueryText: string;
  readonly userMessage: Readonly<Omit<UserMessageInput, 'text'>>;
  readonly caller: RunTurnCaller;
  readonly reminderBlocks: readonly string[];
  readonly loadBackgroundReminder: () => Promise<BackgroundReminderFacts>;
  readonly browserAssets: readonly AgentHostBrowserAsset[];
  readonly channelContext?: AgentHostChannelContext;
  readonly systemReminderDiagnostic?: unknown;
}

/**
 * V2-owned projection from admitted input facts into runner-ready message
 * metadata. Concrete storage/reminder owners supply raw facts; this class owns
 * FIFO attachment mapping, capability selection, reminder order and caller
 * classification.
 */
export class LocalTurnInputPreparer {
  constructor(private readonly options: LocalTurnInputPreparerOptions) {
    assertAgentHostCapabilityAvailable(
      'background-reminder-facts',
      typeof options.reminders?.buildBackground === 'function',
    );
    assertAgentHostCapabilityAvailable(
      'background-task-read-confirmation',
      typeof options.reminders?.confirmBackgroundTaskReads === 'function',
    );
    assertAgentHostCapabilityAvailable(
      'system-reminder-facts',
      typeof options.reminders?.buildSystem === 'function',
    );
  }

  async prepare(input: LocalTurnInputPreparationRequest): Promise<PreparedLocalTurnInput> {
    const projectAgentReferences = this.createAgentReferenceProjector(
      input.preparation.agentConfig,
    );
    const {
      batchInputs,
      canonicalUserInput,
      promptText,
      promptTexts,
      genuineUserQueryText,
      genuineUserQueryTexts,
    } = await this.prepareInitialPromptBatch(input, projectAgentReferences);
    const attachments = await this.prepareAttachments({
      lease: input.lease,
      preparation: input.preparation,
      messages: canonicalUserInput.messages,
      messageIndexOffset: 0,
    });
    const capabilities = modelCapabilities(input.preparation.agentConfig);
    const selectedMedia = await prepareLocalInlineMedia(
      inlineMediaCandidates(attachments),
      capabilities,
    );
    const systemValue = await this.options.reminders.buildSystem({
      session: input.session,
      agent: input.agent,
      agentConfig: input.preparation.agentConfig,
      promptText,
      turnId: input.lease.turnId,
      ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
      ...(input.history && messagesCarrySessionId(input.history, input.session.sessionId)
        ? { sessionIdInContext: true }
        : {}),
    });
    const system = validateSystemReminder(systemValue);
    const systemBlock = optionalReminderBlock('system', system.content);
    system.finalizeTelemetry?.({
      content: systemBlock,
      ...(system.diagnostic !== undefined ? { diagnostic: system.diagnostic } : {}),
    });
    const attachmentBlock = buildAttachmentReminder(
      attachments,
      selectedMedia.inlinedKeys,
      capabilities,
    );
    const skillBlock = buildSlashSkillReminder(canonicalUserInput, input.preparation.agentConfig);
    const channelContext = canonicalUserInput.messages.find(
      (message) => message.channelContext,
    )?.channelContext;
    return {
      ...(batchInputs
        ? {
            initialBatchMessages: batchInputs.map((member, index) => {
              const keys = new Set(
                attachments
                  .filter((entry) => entry.messageIndex === index)
                  .map((entry) => attachmentKey(entry.messageIndex, entry.prepared)),
              );
              const inline = selectedMedia.items
                .filter((item) => keys.has(item.key))
                .map((item) => item.attachment);
              return {
                text: promptTexts[index]!,
                ...(inline.length > 0 ? { attachments: inline } : {}),
                ...backgroundTaskOrigin(member.messages),
              };
            }),
            initialBatchGenuineUserQueryTexts: genuineUserQueryTexts,
          }
        : {}),
      promptText,
      genuineUserQueryText,
      userMessage: {
        ...(selectedMedia.attachments.length > 0 ? { attachments: selectedMedia.attachments } : {}),
        ...backgroundTaskOrigin(canonicalUserInput.messages),
      },
      caller: mapCaller(input.provenance.source, channelContext),
      browserAssets: toBrowserAssets(attachments),
      reminderBlocks: [systemBlock, attachmentBlock, skillBlock].filter((block): block is string =>
        Boolean(block),
      ),
      loadBackgroundReminder: async () =>
        validateBackgroundReminder(
          await this.options.reminders.buildBackground({ session: input.session }),
        ),
      ...(channelContext ? { channelContext } : {}),
      ...(system.diagnostic !== undefined ? { systemReminderDiagnostic: system.diagnostic } : {}),
    };
  }

  private async prepareInitialPromptBatch(
    input: LocalTurnInputPreparationRequest,
    projectAgentReferences: ((content: string) => Promise<string>) | undefined,
  ): Promise<{
    readonly batchInputs: AgentHostCanonicalUserInput[] | undefined;
    readonly canonicalUserInput: AgentHostCanonicalUserInput;
    readonly promptText: string;
    readonly promptTexts: readonly string[];
    readonly genuineUserQueryText: string;
    readonly genuineUserQueryTexts: readonly string[];
  }> {
    const batchInputs = input.immediateSendBatch?.members.map((member) =>
      createCanonicalAgentHostUserInput({
        input: member.input,
        genuineUserQueryText: member.genuineUserQueryText,
        provenance: member.provenance,
      }),
    );
    const canonicalUserInputs = batchInputs ?? [input.canonicalUserInput];
    const rawGenuineUserQueryTexts = input.immediateSendBatch
      ? input.immediateSendBatch.members.map((member) => member.genuineUserQueryText)
      : [input.genuineUserQueryText];
    const promptTexts: string[] = [];
    const genuineUserQueryTexts: string[] = [];
    for (const [index, canonicalUserInput] of canonicalUserInputs.entries()) {
      const projected = await this.projectCanonicalUserInput({
        canonicalUserInput,
        genuineUserQueryText: rawGenuineUserQueryTexts[index] ?? '',
        provenance: input.immediateSendBatch
          ? (input.immediateSendBatch.members[index]?.provenance ?? input.provenance)
          : input.provenance,
        projectAgentReferences,
      });
      promptTexts.push(
        await this.materializePrompt({ ...input, canonicalUserInput }, projected.content),
      );
      genuineUserQueryTexts.push(projected.genuineUserQueryText);
    }
    const promptText = promptTexts.join('\n\n');
    return {
      batchInputs,
      canonicalUserInput: batchInputs
        ? { text: promptText, messages: batchInputs.flatMap((member) => member.messages) }
        : input.canonicalUserInput,
      promptText,
      promptTexts,
      genuineUserQueryText: genuineUserQueryTexts[0] ?? '',
      genuineUserQueryTexts,
    };
  }

  private async materializePrompt(
    input: LocalTurnInputPreparationRequest,
    content: string,
  ): Promise<string> {
    const materializePrompt = this.options.materializePrompt;
    if (!materializePrompt) return content;
    const promptText = await materializePrompt({
      content,
      workspaceDir: input.session.workspaceDir,
      signal: input.lease.signal,
    });
    if (typeof promptText !== 'string') {
      throw new TypeError('Prompt materializer returned an invalid v2 prompt.');
    }
    return promptText;
  }

  async prepareSteering(input: {
    readonly lease: AcceptedTurnLease;
    readonly preparation: LocalTurnPreparation;
    readonly message: AgentHostUserInput;
    readonly genuineUserQueryText: string;
    readonly provenance: AgentHostTurnProvenance;
    readonly messageIndexOffset: number;
  }): Promise<{
    readonly userMessage: UserMessageInput;
    readonly genuineUserQueryText: string;
    readonly browserAssets: readonly AgentHostBrowserAsset[];
  }> {
    const projectAgentReferences = this.createAgentReferenceProjector(
      input.preparation.agentConfig,
    );
    const canonical = createCanonicalAgentHostSteeringInput({
      input: input.message,
      provenance: input.provenance,
    });
    const attachments = await this.prepareAttachments({
      lease: input.lease,
      preparation: input.preparation,
      messages: canonical.messages,
      messageIndexOffset: input.messageIndexOffset,
    });
    const capabilities = modelCapabilities(input.preparation.agentConfig);
    const selectedMedia = await prepareLocalInlineMedia(
      inlineMediaCandidates(attachments),
      capabilities,
    );
    const reminderBlocks = [
      buildAttachmentReminder(attachments, selectedMedia.inlinedKeys, capabilities),
      buildSlashSkillReminder(canonical, input.preparation.agentConfig),
    ].filter((block): block is string => Boolean(block));
    const projected = await this.projectCanonicalUserInput({
      canonicalUserInput: canonical,
      genuineUserQueryText: input.genuineUserQueryText,
      provenance: input.provenance,
      projectAgentReferences,
    });
    return {
      userMessage: {
        text: [...reminderBlocks, projected.content].filter(Boolean).join('\n\n'),
        ...(selectedMedia.attachments.length > 0 ? { attachments: selectedMedia.attachments } : {}),
        ...backgroundTaskOrigin(canonical.messages),
      },
      genuineUserQueryText: projected.genuineUserQueryText,
      browserAssets: toBrowserAssets(attachments),
    };
  }

  private async projectCanonicalUserInput(input: {
    readonly canonicalUserInput: AgentHostCanonicalUserInput;
    readonly genuineUserQueryText: string;
    readonly provenance: AgentHostTurnProvenance;
    readonly projectAgentReferences: ((content: string) => Promise<string>) | undefined;
  }): Promise<{ readonly content: string; readonly genuineUserQueryText: string }> {
    const projectAgentReferences = input.projectAgentReferences;
    if (!projectAgentReferences || !isUserAuthoredSource(input.provenance.source)) {
      return {
        content: input.canonicalUserInput.text,
        genuineUserQueryText: input.genuineUserQueryText,
      };
    }
    const projectedMessages = await Promise.all(
      input.canonicalUserInput.messages.map(async (message, index) => {
        if (!shouldProjectUserMessage(message, index, input.genuineUserQueryText)) return message;
        const text = await projectAgentReferences(message.text);
        return text === message.text ? message : { ...message, text };
      }),
    );
    const matchingMessageIndex = input.canonicalUserInput.messages.findIndex(
      (message) => message.text === input.genuineUserQueryText,
    );
    const matchingMessage = input.canonicalUserInput.messages[matchingMessageIndex];
    const shouldKeepGenuineUserQueryText =
      input.genuineUserQueryText.length === 0 ||
      (matchingMessage &&
        !shouldProjectUserMessage(
          matchingMessage,
          matchingMessageIndex,
          input.genuineUserQueryText,
        )) ||
      (!matchingMessage && input.canonicalUserInput.messages[0]?.origin);
    let genuineUserQueryText = input.genuineUserQueryText;
    if (!shouldKeepGenuineUserQueryText) {
      if (matchingMessage) {
        genuineUserQueryText = projectedMessages[matchingMessageIndex]!.text;
      } else {
        genuineUserQueryText = await projectAgentReferences(input.genuineUserQueryText);
      }
    }
    const [primary, ...queuedMessages] = projectedMessages;
    const canonical = createCanonicalAgentHostSteeringInput({
      input: {
        ...primary!,
        ...(queuedMessages.length > 0 ? { queuedMessages } : {}),
      },
      provenance: input.provenance,
    });
    return { content: canonical.text, genuineUserQueryText };
  }

  private createAgentReferenceProjector(
    agentConfig: Readonly<Record<string, unknown>>,
  ): ((content: string) => Promise<string>) | undefined {
    const projection = this.options.agentReferenceProjection;
    if (!projection) return undefined;
    // This projector belongs to one prepared turn. Its resolver cache covers
    // current input without holding authorization decisions after the turn ends.
    const resolutions = new Map<string, Promise<AgentReferenceResolution>>();
    const resolveAgentReference = (requestRef: string): Promise<AgentReferenceResolution> => {
      const cached = resolutions.get(requestRef);
      if (cached) return cached;
      const resolution = resolveProjectedAgentReference(projection, requestRef);
      resolutions.set(requestRef, resolution);
      return resolution;
    };
    return async (content: string) =>
      await projectLocalAgentReferencesForModel({
        content,
        agentConfig,
        projection: { ...projection, resolveAgentReference },
      });
  }

  private async prepareAttachments(input: {
    readonly lease: AcceptedTurnLease;
    readonly preparation: LocalTurnPreparation;
    readonly messages: AgentHostCanonicalUserInput['messages'];
    readonly messageIndexOffset: number;
  }): Promise<PreparedAttachmentEntry[]> {
    const raw = input.messages.flatMap((message, messageIndex) =>
      (message.attachments ?? []).map((attachment, attachmentIndex) => ({
        attachment,
        attachmentIndex,
        messageIndex: input.messageIndexOffset + messageIndex,
      })),
    );
    if (raw.length === 0) return [];
    const imageAttachmentCount = raw.filter(({ attachment }) =>
      isImageAttachment(attachment),
    ).length;
    const assets = this.options.assets;
    const capabilities = modelCapabilities(input.preparation.agentConfig);
    assertAgentHostCapabilityAvailable(
      'attachment-materializer',
      typeof assets?.materialize === 'function',
    );
    if (!assets) {
      throw new TypeError('Attachment materializer is unavailable.');
    }
    return Promise.all(
      raw.map(async (entry) => ({
        ...entry,
        prepared: validatePreparedAttachment(
          await assets.materialize({
            sessionId: input.lease.sessionId,
            turnId: input.lease.turnId,
            messageIndex: entry.messageIndex,
            attachmentIndex: entry.attachmentIndex,
            imageAttachmentCount,
            attachment: entry.attachment,
            ...(capabilities ? { modelCapabilities: capabilities } : {}),
          }),
        ),
      })),
    );
  }
}

function shouldProjectUserMessage(
  message: AgentHostQueuedUserInput,
  index: number,
  genuineUserQueryText: string,
): boolean {
  if (message.origin) return false;
  return index > 0 || genuineUserQueryText.length > 0;
}

function isUserAuthoredSource(source: string): boolean {
  return (
    source === 'api' ||
    source === 'code_review' ||
    source === 'channel' ||
    source.startsWith('channel:')
  );
}

async function resolveProjectedAgentReference(
  projection: LocalAgentReferenceProjection,
  requestRef: string,
): Promise<AgentReferenceResolution> {
  return await projection.resolveAgentReference(requestRef);
}

function toBrowserAssets(attachments: readonly PreparedAttachmentEntry[]): AgentHostBrowserAsset[] {
  return attachments.map(({ prepared }) => ({
    filePath: prepared.filePath,
    fileName: prepared.fileName,
    mimeType: prepared.mimeType,
  }));
}

/** Align batch accounting with the v1 hosted attachment classifier before materialization. */
const SUPPORTED_NATIVE_IMAGE_PATH = /\.(?:jpe?g|png|gif|webp)$/iu;

function isImageAttachment(attachment: AgentHostInputAttachment): boolean {
  if (attachment.type === 'image') return true;
  if (attachment.mimeType?.trim().toLowerCase().startsWith('image/')) return true;
  if (/^data:image\/[^,;]*[;,]/i.test(attachment.dataUrl ?? '')) return true;
  return [attachment.fileName, attachment.filePath].some((value) =>
    SUPPORTED_NATIVE_IMAGE_PATH.test(value ?? ''),
  );
}

function validateBackgroundReminder(
  value: Awaited<ReturnType<LocalTurnReminderFacts['buildBackground']>>,
): Awaited<ReturnType<LocalTurnReminderFacts['buildBackground']>> {
  if (
    !value ||
    !Array.isArray(value.tasks) ||
    !Number.isSafeInteger(value.undeliveredTotal) ||
    value.undeliveredTotal < 0 ||
    !Number.isSafeInteger(value.terminalTotal) ||
    value.terminalTotal < value.undeliveredTotal ||
    value.tasks.length > 5 ||
    value.tasks.length > value.undeliveredTotal ||
    value.tasks.some(
      (task) =>
        !task ||
        typeof task.taskId !== 'string' ||
        !task.taskId ||
        !['succeeded', 'failed', 'canceled', 'lost'].includes(task.status) ||
        (task.endedAtMs !== undefined && !Number.isFinite(task.endedAtMs)),
    )
  ) {
    throw new TypeError('Background reminder owner returned invalid v2 facts.');
  }
  return value;
}

function backgroundTaskOrigin(
  messages: AgentHostCanonicalUserInput['messages'],
): Pick<UserMessageInput, 'hostMetadata'> {
  const origins = messages.flatMap((message) =>
    message.origin?.kind === 'background-task-terminal' ? [message.origin] : [],
  );
  if (origins.length === 0) return {};
  const observedCounts = origins.flatMap((origin) =>
    origin.observedTerminalCount === undefined ? [] : [origin.observedTerminalCount],
  );
  return {
    hostMetadata: createBackgroundTaskHostMetadata({
      kind: 'background-task-terminal',
      taskIds: [
        ...new Set(
          origins.flatMap((origin) => origin.taskIds.filter((taskId) => taskId.length > 0)),
        ),
      ],
      ...(observedCounts.length > 0 ? { observedTerminalCount: Math.max(...observedCounts) } : {}),
    }),
  };
}

function validateSystemReminder(
  value: Awaited<ReturnType<LocalTurnReminderFacts['buildSystem']>>,
): Awaited<ReturnType<LocalTurnReminderFacts['buildSystem']>> {
  if (!value || typeof value.content !== 'string') {
    throw new TypeError('System reminder owner returned invalid v2 facts.');
  }
  return value;
}

interface PreparedAttachmentEntry {
  readonly attachment: AgentHostInputAttachment;
  readonly attachmentIndex: number;
  readonly messageIndex: number;
  readonly prepared: LocalTurnPreparedAttachment;
}

function validatePreparedAttachment(
  attachment: LocalTurnPreparedAttachment,
): LocalTurnPreparedAttachment {
  if (!hasValidPreparedAttachmentFields(attachment)) {
    throw new TypeError('Attachment materializer returned an invalid v2 attachment fact.');
  }
  if (!hasValidInlineMedia(attachment.inlineMedia)) {
    throw new TypeError('Attachment materializer returned invalid v2 media facts.');
  }
  return attachment;
}

function hasValidPreparedAttachmentFields(attachment: LocalTurnPreparedAttachment): boolean {
  return (
    Boolean(attachment) &&
    ['image', 'video', 'text', 'file'].includes(attachment.kind) &&
    typeof attachment.filePath === 'string' &&
    Boolean(attachment.filePath) &&
    typeof attachment.fileName === 'string' &&
    Boolean(attachment.fileName) &&
    typeof attachment.mimeType === 'string'
  );
}

function hasValidInlineMedia(media: LocalTurnPreparedAttachment['inlineMedia']): boolean {
  if (!media) return true;
  return (
    typeof media.id === 'string' &&
    Boolean(media.id) &&
    Number.isFinite(media.sizeBytes) &&
    media.sizeBytes >= 0 &&
    (media.data === undefined || typeof media.data === 'string')
  );
}

function buildAttachmentReminder(
  entries: readonly PreparedAttachmentEntry[],
  inlinedKeys: ReadonlySet<string>,
  capabilities: LocalMultimodalAttachmentCapabilities | undefined,
): string {
  if (entries.length === 0) return '';
  const lines = entries.map(({ messageIndex, prepared }) => {
    const inline = inlinedKeys.has(attachmentKey(messageIndex, prepared)) ? 'true' : 'false';
    return [
      `<attachment name="${escapeAttribute(prepared.fileName)}" mime="${escapeAttribute(prepared.mimeType)}" path="${escapeAttribute(prepared.filePath)}" message_index="${messageIndex + 1}" kind="${prepared.kind}" inline="${inline}">`,
      attachmentWorkflowInstruction(prepared.kind, inline === 'true', capabilities),
      '</attachment>',
    ].join('\n');
  });
  return [
    '<system-reminder>',
    'The user provided local attachments for this turn. Use the exact file paths below and do not guess filenames.',
    ...lines,
    '</system-reminder>',
  ].join('\n');
}

function attachmentWorkflowInstruction(
  kind: LocalTurnPreparedAttachment['kind'],
  inlined: boolean,
  capabilities: LocalMultimodalAttachmentCapabilities | undefined,
): string {
  if (inlined) return 'This media attachment is also provided inline to the resolved model.';
  if (kind === 'image' && capabilities?.support_image !== true) {
    return 'The current model cannot read this image inline. Do not use the read tool to infer its visual contents. If images_understand is available, pass the exact path to it; otherwise explain the limitation and ask the user to switch to a multimodal model or provide a text description.';
  }
  if (kind === 'video' && capabilities?.support_video !== true) {
    return 'The current model cannot read this video inline. Do not use the read tool to infer its visual contents. If videos_understand is available, pass the exact path to it; otherwise explain the limitation and ask the user to switch to a multimodal model or provide a text description.';
  }
  return 'Use the exact local path with an appropriate file/tool workflow when its contents are needed.';
}

function inlineMediaCandidates(
  entries: readonly PreparedAttachmentEntry[],
): LocalInlineMediaCandidate[] {
  return entries.flatMap((entry): LocalInlineMediaCandidate[] => {
    const media = entry.prepared.inlineMedia;
    return media
      ? [
          {
            key: attachmentKey(entry.messageIndex, entry.prepared),
            id: `${entry.messageIndex}:${entry.attachmentIndex}:${media.id}`,
            mime: media.mime ?? entry.prepared.mimeType,
            sizeBytes: media.sizeBytes,
            filePath: entry.prepared.filePath,
            ...(media.data ? { data: media.data } : {}),
          },
        ]
      : [];
  });
}

function attachmentKey(messageIndex: number, attachment: LocalTurnPreparedAttachment): string {
  return `${messageIndex}:${attachment.filePath}`;
}

/** Inline image payloads a steering message already carries as data URLs. */
const TEARDOWN_INLINE_IMAGE_DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/iu;

/**
 * Teardown has no resolved model, so the reminder must not claim the current
 * model cannot read media; non-inlined media keeps the generic path workflow.
 */
const TEARDOWN_ATTACHMENT_CAPABILITIES: LocalMultimodalAttachmentCapabilities = {
  support_image: true,
  support_video: true,
};

interface SteeringTeardownCanonicalInput {
  readonly text: string;
  readonly attachments: readonly NonNullable<UserMessageInput['attachments']>[number][];
}

/**
 * Decision v5 fall-to-session projection: renders one admitted-but-unconsumed
 * steering message into the canonical user input the teardown commit appends,
 * without a running Turn. It reuses the consumption path's canonical text
 * conversion (quoted-message rendering) and attachment-reminder format; the
 * Turn-bound materializer (file reads, transcode, capability-driven inline
 * selection) is unavailable here, so inline content degrades to the data-URL
 * images the message already carries while every attachment keeps its exact
 * path reference for the next model request. Never throws: a shape the strict
 * canonical capture rejects degrades to the raw message text.
 */
export function prepareSteeringTeardownCanonicalInput(input: {
  readonly message: AgentHostUserInput;
  readonly provenance: AgentHostTurnProvenance;
}): SteeringTeardownCanonicalInput {
  const canonical = teardownCanonicalInput(input);
  const entries: PreparedAttachmentEntry[] = [];
  const inlinedKeys = new Set<string>();
  const inline: NonNullable<UserMessageInput['attachments']>[number][] = [];
  canonical.messages.forEach((message, messageIndex) => {
    (message.attachments ?? []).forEach((attachment, attachmentIndex) => {
      const prepared = teardownPreparedAttachment(attachment);
      if (!prepared) return;
      const image = teardownInlineImage(attachment);
      if (image) {
        inline.push(image);
        inlinedKeys.add(attachmentKey(messageIndex, prepared));
      }
      entries.push({ attachment, attachmentIndex, messageIndex, prepared });
    });
  });
  const reminder = buildAttachmentReminder(entries, inlinedKeys, TEARDOWN_ATTACHMENT_CAPABILITIES);
  return {
    text: [reminder, canonical.text].filter(Boolean).join('\n\n'),
    attachments: inline,
  };
}

function teardownCanonicalInput(input: {
  readonly message: AgentHostUserInput;
  readonly provenance: AgentHostTurnProvenance;
}): AgentHostCanonicalUserInput {
  try {
    return createCanonicalAgentHostSteeringInput({
      input: input.message,
      provenance: input.provenance,
    });
  } catch {
    // Robustness: a shape the strict canonical capture rejects must not lose
    // the user's words on the teardown lane.
    return {
      text: typeof input.message?.text === 'string' ? input.message.text : '',
      messages: [],
    };
  }
}

/**
 * node:path is off-limits for the orchestration core (dependency-cruiser
 * agent-host-orchestration-core-self-contained), so derive the display name
 * with a plain string split; unexpected shapes fall back to the raw path.
 */
function teardownAttachmentBaseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath;
}

function teardownPreparedAttachment(
  attachment: AgentHostInputAttachment,
): LocalTurnPreparedAttachment | undefined {
  const filePath = (attachment.filePath ?? '').trim();
  const dataUrl = (attachment.dataUrl ?? '').trim();
  if (!filePath && !dataUrl && !attachment.assetId) return undefined;
  const mimeType = (attachment.mimeType ?? '').trim();
  return {
    filePath,
    fileName: attachment.fileName?.trim() || teardownAttachmentBaseName(filePath) || 'attachment',
    mimeType,
    kind: teardownAttachmentKind(attachment, mimeType),
  };
}

function teardownAttachmentKind(
  attachment: AgentHostInputAttachment,
  mimeType: string,
): LocalTurnPreparedAttachment['kind'] {
  if (isImageAttachment(attachment)) return 'image';
  if (mimeType.toLowerCase().startsWith('video/')) return 'video';
  return 'file';
}

function teardownInlineImage(
  attachment: AgentHostInputAttachment,
): NonNullable<UserMessageInput['attachments']>[number] | undefined {
  const match = TEARDOWN_INLINE_IMAGE_DATA_URL.exec((attachment.dataUrl ?? '').trim());
  if (!match) return undefined;
  const data = match[2]!.replace(/\s+/gu, '');
  if (!data) return undefined;
  return { type: 'image', data, mimeType: match[1]!.toLowerCase() };
}

function modelCapabilities(
  agentConfig: Readonly<Record<string, unknown>>,
): LocalMultimodalAttachmentCapabilities | undefined {
  return readRecord(readRecord(agentConfig.model)?.capabilities);
}

function buildSlashSkillReminder(
  canonical: AgentHostCanonicalUserInput,
  agentConfig: Readonly<Record<string, unknown>>,
): string {
  const requested = canonical.messages.reduce<string | undefined>((found, message) => {
    if (found) return found;
    return /^\/([A-Za-z0-9][A-Za-z0-9._-]*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?)(?:\s|$)/u.exec(
      message.text.trimStart(),
    )?.[1];
  }, undefined);
  if (!requested) return '';
  const skills = Array.isArray(agentConfig.skills) ? agentConfig.skills : [];
  const match = skills.find((skill) => {
    const name = readString(readRecord(skill), 'name');
    return name?.toLowerCase() === requested.toLowerCase();
  });
  const name = readString(readRecord(match), 'name');
  return name
    ? [
        '<system-reminder>',
        `The user explicitly requested the \`${name}\` skill. Load it with the \`skill\` tool and follow it.`,
        '</system-reminder>',
      ].join('\n')
    : '';
}

function optionalReminderBlock(owner: string, content: string): string {
  const block = content.trim();
  if (!block) return '';
  if (!isCompleteReminderBlock(block)) {
    throw new TypeError(
      `Local Turn ${owner} reminder owner must return one complete <system-reminder> block or an empty string.`,
    );
  }
  return block;
}

function isCompleteReminderBlock(content: string): boolean {
  const opening = '<system-reminder>';
  const closing = '</system-reminder>';
  if (!content.startsWith(opening) || !content.endsWith(closing)) return false;
  const body = content.slice(opening.length, -closing.length);
  return Boolean(body.trim()) && !/<\s*\/?\s*system-reminder(?=[\s/>])/iu.test(body);
}

function mapCaller(
  source: string,
  channelContext: AgentHostChannelContext | undefined,
): RunTurnCaller {
  if (source === 'cron') return 'cron';
  if (source === 'team') return 'team';
  if (channelContext || source.startsWith('channel:')) return 'channel_feishu';
  return 'chat';
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function readString(
  value: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const candidate = value?.[key];
  return typeof candidate === 'string' && candidate ? candidate : undefined;
}
