import {
  ConversationTurnRejectedError,
  hasConversationTaskModelSelection,
  type ConversationAcceptedTurn,
  type ConversationAttachment,
  type ConversationMessageInput,
  type ConversationQueuedItem,
  type ConversationSession,
  type ConversationSessionCreateInput,
  type ConversationSessionListOptions,
  type TurnCommittedFacts,
  type ConversationTurnResult,
  type RuntimeConversation,
} from '@mavis/conversation-contract';

import {
  isInlineDisplayDataUrl,
  toConversationCommittedMessage,
  type DisplayMessageRecord,
  type QueueItem,
  type QueueMessageAttachment,
  type QueueMessageInput,
  type SessionRecord,
  type SessionRecordService,
  type SessionRepository,
} from '../session-system/index.js';
import type { AgentHostTurnOutcome, RequestCompactionResult } from '../turn-system/index.js';
import type { V1ConversationCompatibilityOptions } from './contracts.js';

/** v2 service implementation injected into hosted v1 compatibility consumers. */
export class V1ConversationCompatibilityService implements RuntimeConversation {
  constructor(private readonly options: V1ConversationCompatibilityOptions) {}

  readonly query: RuntimeConversation['query'] = {
    getSession: async (sessionId) =>
      toConversationSession(await this.options.sessions.query.find(sessionId)),
    listSessions: async (options) =>
      (await this.options.sessions.query.listExact(toSessionListOptions(options))).map(
        toRequiredConversationSession,
      ),
    listMessages: async (sessionId, options) => {
      const page = await this.options.sessions.messages.query.list({
        sessionId,
        ...(options?.limit !== undefined ? { limit: options.limit } : {}),
        ...(options?.before ? { before: options.before } : {}),
      });
      return {
        messages: page.messages.map(toConversationCommittedMessage),
        hasMore: page.hasMore,
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
      };
    },
  };

  readonly lifecycle: RuntimeConversation['lifecycle'] = {
    createSession: (input) => this.createSession(input),
    createRootSession: async (input) => {
      if (!input.workspaceDir) {
        return toRequiredConversationSession(
          await this.options.sessions.root.getRootSessionByAgent(input.agentName),
        );
      }
      const agentName = await this.options.resolveAgentWriteTarget(input.agentName);
      const created = await this.options.sessions.lifecycle.createRootSession({
        agentName,
        workspaceDir: input.workspaceDir,
        isDefaultWorkspace: false,
      });
      return this.finalizeCreatedRoot(agentName, created);
    },
    replaceRootSession: (agentName, sessionId) =>
      this.options.sessions.root.replaceRootSessionWithResult(agentName, sessionId),
    updateSession: async (sessionId, fields) =>
      toRequiredConversationSession(
        await this.options.sessions.lifecycle.mutateSession(sessionId, fields),
      ),
    deleteSession: (sessionId) => this.deleteSession(sessionId),
  };

  readonly ingress: RuntimeConversation['ingress'] = {
    submit: async (input) => {
      const result = await this.options.submission.submit(input);
      if (!result.accepted) {
        throw new ConversationTurnRejectedError(input.sessionId, result.reason);
      }
      return this.acceptedTurn(input.sessionId, result);
    },
    resumeUserInput: async (input) => {
      const result = await this.options.submission.resumeUserInput(input);
      if (result.accepted) {
        return { turnId: result.turnId, mode: 'started' };
      }
      if (result.reason === 'duplicate') {
        return { turnId: result.turnId, mode: 'duplicate' };
      }
      throw new ConversationTurnRejectedError(input.sessionId, result.reason);
    },
    steer: async (input) => {
      const result = await this.options.submission.steer(input);
      if (!result.delivered) {
        throw new ConversationTurnRejectedError(input.sessionId, result.reason);
      }
      // An activated steer owns the Turn it started, so it projects committed
      // output exactly like submit. A steered/duplicate delivery joins someone
      // else's Turn and only carries the admission ACK.
      if (result.mode === 'activated') {
        return {
          turnId: result.turnId,
          mode: 'activated',
          completion: this.resolveAcceptedTurn(input.sessionId, result.turnId, result.completion),
        };
      }
      return { turnId: result.turnId, mode: result.mode };
    },
    listQueued: async (sessionId) =>
      (await this.options.sessions.queue.list(sessionId)).map(toQueuedItem),
    findQueuedByClientRequestId: async (sessionId, clientRequestId) => {
      const item = await this.options.sessions.queue.findByClientRequestId(
        sessionId,
        clientRequestId,
      );
      return item ? toQueuedItem(item) : undefined;
    },
    updateQueued: async (sessionId, itemId, update) => {
      const materialized = update.message
        ? await this.options.attachmentMaterializer.materialize({
            sessionId,
            message: update.message,
          })
        : undefined;
      const updated = await cleanupRejectedRegistration(
        () =>
          this.options.sessions.queue.update({
            sessionId,
            itemId,
            ...(materialized ? { message: toQueueMessage(materialized.message) } : {}),
            ...(update.model !== undefined
              ? { model: update.model ? toQueueModel(update.model) : null }
              : {}),
            ...(update.expiresAt !== undefined ? { expiresAt: update.expiresAt } : {}),
          }),
        materialized?.discardCreated,
      );
      if (!updated || updated === 'not_editable' || updated === 'invalid') {
        await materialized?.discardCreated();
        return updated === 'invalid' ? undefined : updated;
      }
      await this.wake(sessionId, itemId);
      return toQueuedItem(updated);
    },
    promoteQueuedSource: async (sessionId, itemId, source) => {
      const updated = await this.options.sessions.queue.promote(sessionId, itemId, source);
      if (!updated || updated === 'not_editable') return updated;
      await this.wake(sessionId, itemId);
      return toQueuedItem(updated);
    },
    cancelQueued: async (sessionId, itemId) => {
      const cancelled = await this.options.sessions.queue.cancel(sessionId, itemId);
      return !cancelled || cancelled === 'not_editable' ? cancelled : toQueuedItem(cancelled);
    },
    reorderQueued: async (sessionId, itemIds) => {
      const reordered = await this.options.sessions.queue.reorder({
        sessionId,
        itemIds,
      });
      if (reordered === 'invalid') throw new TypeError('Queue reorder input is invalid');
      return reordered.map(toQueuedItem);
    },
    abort: async (sessionId, reason, turnId) => {
      const result = await this.options.turns.abort({
        sessionId,
        reason: reason ?? 'lifecycle',
        ...(turnId ? { turnId } : {}),
      });
      return result.status === 'aborted' || result.status === 'released';
    },
    dispatchQueue: (sessionId) => this.wake(sessionId),
  };

  readonly maintenance: RuntimeConversation['maintenance'] = {
    compact: async (input) => {
      const session = await this.options.sessions.repository.get(input.sessionId);
      if (!session) return compactionFailure('SESSION_NOT_FOUND', 404, 'Session not found');
      if (session.agentName !== input.agentName) {
        return compactionFailure('FORBIDDEN', 403, 'Session does not belong to this Agent');
      }
      const result = await this.options.turns.requestCompaction({
        sessionId: input.sessionId,
        ...(input.reason ? { reason: input.reason } : {}),
        ...(input.customInstructions ? { customInstructions: input.customInstructions } : {}),
        ...(input.onStarted ? { onStarted: input.onStarted } : {}),
      });
      return toCompactionOutcome(result, input.sessionId);
    },
  };

  private async createSession(input: ConversationSessionCreateInput): Promise<ConversationSession> {
    const agentName = await this.options.resolveAgentWriteTarget(input.agentName);
    if (input.sessionType === 'root') {
      const workspaceDir = nonEmpty(input.workspaceDir);
      const created = await this.options.sessions.lifecycle.createRootSession({
        agentName,
        ...(workspaceDir ? { workspaceDir } : {}),
        ...(input.isDefaultWorkspace !== undefined
          ? { isDefaultWorkspace: input.isDefaultWorkspace }
          : {}),
      });
      return this.finalizeCreatedRoot(agentName, created);
    }
    const created = await this.options.sessions.lifecycle.createInternalSession(
      toInternalSessionInput({ ...input, agentName }),
    );
    return toRequiredConversationSession(created);
  }

  private async promoteCreatedRoot(
    agentName: string,
    created: SessionRecord,
  ): Promise<ConversationSession> {
    try {
      const committed = await this.options.sessions.root.replaceRootSessionWithResult(
        agentName,
        created.sessionId,
      );
      return committed.nextRoot;
    } catch (error) {
      try {
        await this.options.sessions.records.discardCreatedSession(created.sessionId);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Root replacement failed and cleanup did not complete: ${created.sessionId}`,
        );
      }
      throw error;
    }
  }

  private async finalizeCreatedRoot(
    agentName: string,
    created: SessionRecord,
  ): Promise<ConversationSession> {
    // The owning Agent Application provisions the Root before inserting the legacy Agent
    // row that points back to it. Promotion is only meaningful once that
    // owner row exists; the caller completes the initial pointer atomically
    // with its Agent insert.
    if (!(await this.options.rootAgents.get(agentName))) {
      return toRequiredConversationSession(created);
    }
    return this.promoteCreatedRoot(agentName, created);
  }

  private async deleteSession(sessionId: string): Promise<void> {
    await this.options.sessions.deletion.deleteSession(sessionId);
  }

  private acceptedTurn(
    sessionId: string,
    result: {
      readonly turnId: string;
      readonly mode: 'started' | 'queued';
      readonly completion: Promise<AgentHostTurnOutcome>;
      readonly queue?: {
        readonly itemId: string;
        readonly position: number;
        readonly ahead: number;
      };
    },
  ): ConversationAcceptedTurn {
    return {
      turnId: result.turnId,
      mode: result.mode,
      ...(result.queue
        ? {
            queue: {
              itemId: result.queue.itemId,
              position: result.queue.position,
              ahead: result.queue.ahead,
            },
          }
        : {}),
      completion: this.resolveAcceptedTurn(sessionId, result.turnId, result.completion),
    };
  }

  private async resolveAcceptedTurn(
    sessionId: string,
    turnId: string,
    completion: Promise<AgentHostTurnOutcome>,
  ): Promise<ConversationTurnResult> {
    const outcome = await completion;
    const [messages, session] = await Promise.all([
      this.options.sessions.messages.repository.listTurn(sessionId, turnId),
      this.options.sessions.repository.get(sessionId),
    ]);
    return toTurnResult(turnId, outcome, messages, session?.workspaceDir);
  }

  private async wake(sessionId: string, itemId?: string): Promise<void> {
    try {
      await this.options.turns.dispatchQueue(sessionId);
    } catch (error) {
      try {
        this.options.onQueueWakeFailure?.({ sessionId, itemId, error });
      } catch {
        // Queue persistence remains authoritative when diagnostics fail.
      }
    }
  }
}

function toSessionListOptions(
  options: ConversationSessionListOptions | undefined,
): Parameters<SessionRepository['list']>[0] {
  return options ? { ...options } : undefined;
}

function toConversationSession(
  session: SessionRecord | undefined,
): ConversationSession | undefined {
  return session ? toRequiredConversationSession(session) : undefined;
}

function toRequiredConversationSession(session: SessionRecord): ConversationSession {
  return { ...session };
}

function toInternalSessionInput(
  input: ConversationSessionCreateInput,
): Parameters<SessionRecordService['createInternalSession']>[0] {
  const workspaceDir = nonEmpty(input.workspaceDir);
  return {
    agentName: input.agentName,
    ...(workspaceDir ? { workspaceDir } : {}),
    sessionType: 'branch',
    ...sessionClassification(input),
    ...sessionPresentation(input),
    ...sessionExecutionPreferences(input),
  };
}

function nonEmpty(value: string | undefined): string | undefined {
  return value?.trim() ? value : undefined;
}

function sessionClassification(input: ConversationSessionCreateInput) {
  return {
    ...(input.sessionKind ? { sessionKind: input.sessionKind } : {}),
    ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
    ...(input.visibility ? { visibility: input.visibility } : {}),
    ...(input.purpose ? { purpose: input.purpose } : {}),
    ...(input.originCronId ? { originCronId: input.originCronId } : {}),
  };
}

function sessionPresentation(input: ConversationSessionCreateInput) {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.runLocation ? { runLocation: input.runLocation } : {}),
    ...(input.appMode ? { appMode: input.appMode } : {}),
  };
}

function sessionExecutionPreferences(input: ConversationSessionCreateInput) {
  return {
    ...(input.effectiveModel !== undefined ? { effectiveModel: input.effectiveModel } : {}),
    ...(input.effectiveModelVariant !== undefined
      ? { effectiveModelVariant: input.effectiveModelVariant }
      : {}),
    ...(input.effectiveModelThinking !== undefined
      ? { effectiveModelThinking: input.effectiveModelThinking }
      : {}),
    ...(hasConversationTaskModelSelection(input.taskModelSelection)
      ? { taskModelSelection: input.taskModelSelection }
      : {}),
    ...(input.isDefaultWorkspace !== undefined
      ? { isDefaultWorkspace: input.isDefaultWorkspace }
      : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.pluginAgentDefinition ? { pluginAgentDefinition: input.pluginAgentDefinition } : {}),
  };
}

function toQueueMessage(message: ConversationMessageInput): QueueMessageInput {
  return {
    content: message.content,
    attachments: (message.attachments ?? []).flatMap(toQueueAttachment),
    ...(message.hideUserMessage !== undefined ? { hideUserMessage: message.hideUserMessage } : {}),
    ...(message.displayContent !== undefined ? { displayContent: message.displayContent } : {}),
    ...(message.origin !== undefined ? { origin: message.origin } : {}),
    ...(message.quotedMessage ? { quotedMessage: { ...message.quotedMessage } } : {}),
    ...(message.channelContext ? { channelContext: { ...message.channelContext } } : {}),
  };
}

function toQueueAttachment(input: ConversationAttachment): QueueMessageAttachment[] {
  const filePath = input.filePath?.trim() ?? '';
  const candidateDataUrl = input.dataUrl?.trim();
  const inlineDataUrl = isInlineDisplayDataUrl(candidateDataUrl);
  if (inlineDataUrl && !filePath) {
    throw new TypeError('Inline attachment must be registered before Queue persistence.');
  }
  const dataUrl = inlineDataUrl ? undefined : candidateDataUrl;
  if (!hasQueueAttachmentPayload(input, filePath, dataUrl)) return [];
  return [
    {
      ...queueAttachmentMetadata(input, filePath),
      filePath,
      ...(dataUrl ? { dataUrl } : {}),
      ...(input.assetId ? { assetId: input.assetId } : {}),
      ...(input.error ? { error: input.error } : {}),
    },
  ];
}

function hasQueueAttachmentPayload(
  input: Pick<ConversationAttachment, 'assetId' | 'error'>,
  filePath: string,
  dataUrl: string | undefined,
): boolean {
  return Boolean(filePath || dataUrl || input.assetId || input.error);
}

async function cleanupRejectedRegistration<T>(
  operation: () => Promise<T>,
  discardCreated: (() => Promise<void>) | undefined,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    await discardCreated?.();
    throw error;
  }
}

function queueAttachmentMetadata(
  input: ConversationAttachment,
  filePath: string,
): Pick<QueueMessageAttachment, 'type' | 'fileName' | 'mimeType'> {
  return {
    type: input.type === 'image' ? 'image' : 'file',
    fileName: input.fileName?.trim() || attachmentFileName(filePath),
    mimeType: input.mimeType?.trim() ?? '',
  };
}

function attachmentFileName(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');
  return normalized.slice(normalized.lastIndexOf('/') + 1) || 'attachment';
}

function toQueueModel(model: NonNullable<ConversationMessageInput['model']>) {
  return {
    ...(model.providerId ? { provider_id: model.providerId } : {}),
    ...(model.modelId ? { model_id: model.modelId } : {}),
    ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
    ...(model.contextLimit !== undefined ? { context_limit: model.contextLimit } : {}),
    ...(model.thinking ? { thinking: model.thinking } : {}),
    ...(typeof model.variant === 'string' ? { variant: model.variant } : {}),
  };
}

function toQueuedItem(item: QueueItem): ConversationQueuedItem {
  return {
    itemId: item.itemId,
    sessionId: item.sessionId,
    agentName: item.agentName,
    source: item.source,
    status: item.status,
    message: {
      content: item.message.content,
      attachments: item.message.attachments.map(toConversationAttachment),
      ...(item.message.hideUserMessage !== undefined
        ? { hideUserMessage: item.message.hideUserMessage }
        : {}),
      ...(item.message.displayContent !== undefined
        ? { displayContent: item.message.displayContent }
        : {}),
      ...(item.message.origin !== undefined ? { origin: item.message.origin } : {}),
      ...(item.message.quotedMessage ? { quotedMessage: item.message.quotedMessage } : {}),
      ...(item.message.channelContext ? { channelContext: item.message.channelContext } : {}),
      ...(item.model ? { model: toConversationQueueModel(item.model) } : {}),
    },
    createdAt: item.createdAt,
    ...(item.clientRequestId ? { clientRequestId: item.clientRequestId } : {}),
    ...(item.dedupeKey ? { dedupeKey: item.dedupeKey } : {}),
    ...(item.expiresAt !== undefined ? { expiresAt: item.expiresAt } : {}),
  };
}

function toConversationAttachment(attachment: QueueMessageAttachment): ConversationAttachment {
  if (!isInlineDisplayDataUrl(attachment.dataUrl)) return attachment;
  const displayAttachment = { ...attachment };
  delete displayAttachment.dataUrl;
  return displayAttachment;
}

function toConversationQueueModel(model: NonNullable<QueueItem['model']>) {
  return {
    ...(model.provider_id ? { providerId: model.provider_id } : {}),
    ...(model.model_id ? { modelId: model.model_id } : {}),
    ...(typeof model.variant === 'string' ? { variant: model.variant } : {}),
  };
}

function toTurnResult(
  turnId: string,
  outcome: AgentHostTurnOutcome,
  messages: readonly DisplayMessageRecord[],
  workspaceDir: string | undefined,
): ConversationTurnResult {
  return {
    turnId,
    status: outcome.status,
    messages: messages.map(toConversationCommittedMessage),
    ...(workspaceDir ? { workspaceDir } : {}),
    ...(outcome.status === 'failed' ? { error: errorMessage(outcome.error) } : {}),
    ...(outcome.status === 'aborted' && outcome.reason ? { error: outcome.reason } : {}),
    ...(outcome.committedFacts
      ? { committedFacts: toConversationCommittedFacts(outcome.committedFacts) }
      : {}),
  };
}

function toConversationCommittedFacts(
  facts: NonNullable<AgentHostTurnOutcome['committedFacts']>,
): TurnCommittedFacts {
  const observation = facts.fileChangeObservation;
  if (!observation) return {};
  return {
    fileChangeObservation: {
      fileChange: observation.fileChange,
      ...(observation.changedFiles ? { changedFiles: [...observation.changedFiles] } : {}),
      observationNotes: [...observation.observationNotes],
    },
  };
}

function toCompactionOutcome(
  result: RequestCompactionResult,
  sessionId: string,
): Awaited<ReturnType<RuntimeConversation['maintenance']['compact']>> {
  if (!result.accepted) {
    const status = result.reason === 'invalid-session' ? 404 : 409;
    return compactionFailure(compactionRejectionCode(result.reason), status, result.reason);
  }
  const outcome = result.outcome;
  if (outcome.status === 'completed') {
    return {
      success: true,
      code: 'OK',
      status: 200,
      sessionId,
      compactionId: outcome.compactionId,
      messagesBefore: outcome.messagesBefore,
      messagesAfter: outcome.messagesAfter,
      tokensBefore: outcome.tokensBefore,
      tokensAfter: outcome.tokensAfter,
    };
  }
  if (outcome.status === 'unchanged') {
    return compactionFailure('NOTHING_TO_COMPACT', 400, 'Nothing to compact');
  }
  if (outcome.status === 'aborted') {
    return compactionFailure('COMPACTION_ABORTED', 409, outcome.reason ?? 'Compaction aborted');
  }
  return compactionFailure('COMPACTION_FAILED', 500, errorMessage(outcome.error));
}

function compactionFailure(code: string, status: number, error: string) {
  return { success: false, code, status, error };
}

function compactionRejectionCode(
  reason: Exclude<RequestCompactionResult, { readonly accepted: true }>['reason'],
): string {
  if (reason === 'invalid-session') return 'SESSION_NOT_FOUND';
  if (reason === 'priority-blocked') return 'SESSION_PRIORITY_BLOCKED';
  if (reason === 'ingress-conflict') return 'INGRESS_CONFLICT';
  if (reason === 'duplicate') return 'DUPLICATE';
  return 'SESSION_BUSY';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
