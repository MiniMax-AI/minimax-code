import { parsePluginMentions } from '@mavis/shared/plugin-mention';
import type { TuiMessage } from '../../../runtime/port.js';
import {
  formatTuiHistorySubmission,
  toTuiTranscriptAttachments,
} from '../../features/composer/attachments.js';
import type { TranscriptAttachment, TranscriptCell } from '../../transcript/model.js';
import {
  extractQuestionnaireResponseRequestId,
  extractQuestionnaireResponseSummary,
} from '../../interaction/questionnaire.js';
import { visibleSessionMutationContent } from '../../features/session-mutation/transport.js';
import type { TranscriptStore } from '../../transcript/store.js';

export class TuiUserProjection {
  constructor(private readonly transcript: TranscriptStore) {}

  hydrate(message: TuiMessage, messageId: string, turnId: string, timestamp: number): void {
    const content = message.content ?? '';
    const questionnaireSummary = extractQuestionnaireResponseSummary(content);
    if (questionnaireSummary !== undefined) {
      if (questionnaireSummary) {
        const requestId = extractQuestionnaireResponseRequestId(content);
        this.transcript.upsert({
          id: requestId ? `question:${requestId}` : `history:question:${messageId}`,
          kind: 'question',
          status: 'resolved',
          title: 'Answers sent',
          content: questionnaireSummary,
          turnId,
          createdAtMs: timestamp,
          updatedAtMs: timestamp,
        });
      }
      return;
    }
    const visibleContent =
      message.source === 'code_review' ? '/review' : visibleUserContent(content);
    this.transcript.upsert({
      id: `history:user:${messageId}`,
      kind: 'user',
      status: 'succeeded',
      content: formatTuiHistorySubmission(visibleContent, message.attachments ?? []),
      ...(message.attachments?.length
        ? { attachments: toTuiTranscriptAttachments(message.attachments) }
        : {}),
      turnId,
      sourceMessageId: messageId,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
    });
  }

  applyLive(turnId: string, message: TuiMessage, timestamp: number): boolean {
    const content = message.content ?? '';
    const questionnaireSummary = extractQuestionnaireResponseSummary(content);
    if (questionnaireSummary !== undefined) {
      const requestId = extractQuestionnaireResponseRequestId(content);
      const question = requestId ? this.transcript.get(`question:${requestId}`) : undefined;
      if (question) {
        this.transcript.upsert({
          id: question.id,
          status: 'resolved',
          title: 'Answers sent',
          content: questionnaireSummary,
          ephemeral: false,
          updatedAtMs: timestamp,
        });
      }
      return false;
    }
    const formatted = formatTuiHistorySubmission(
      message.source === 'code_review' ? '/review' : visibleUserContent(content),
      message.attachments ?? [],
    );
    const attachments = toTuiTranscriptAttachments(message.attachments ?? []);
    const existing = findMatchingUserCell(this.transcript.snapshot(), {
      turnId,
      message,
      formattedContent: formatted,
      attachments,
    });
    if (existing) {
      const beginsUserWave = existing.userPresentation === 'pending-steer';
      this.transcript.upsert({
        id: existing.id,
        status: 'succeeded',
        content: formatted,
        attachments: mergeTranscriptAttachments(existing.attachments, attachments),
        turnId,
        ...(message.id ? { sourceMessageId: message.id } : {}),
        userPresentation: undefined,
        ephemeral: false,
        updatedAtMs: timestamp,
      });
      return beginsUserWave;
    }
    this.transcript.upsert({
      id: `stream:user:${message.id ?? turnId}`,
      kind: 'user',
      status: 'succeeded',
      content: formatted,
      ...(attachments.length > 0 ? { attachments } : {}),
      turnId,
      ...(message.id ? { sourceMessageId: message.id } : {}),
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
    });
    return true;
  }
}

interface UserMessageMatchCriteria {
  readonly turnId: string;
  readonly message: TuiMessage;
  readonly formattedContent: string;
  readonly attachments: readonly TranscriptAttachment[];
}

function findMatchingUserCell(
  cells: readonly TranscriptCell[],
  criteria: UserMessageMatchCriteria,
): TranscriptCell | undefined {
  const candidates = cells.filter((cell) => matchesUserMessage(cell, criteria));
  const exactMessage = candidates.find(
    (cell) => criteria.message.id !== undefined && cell.sourceMessageId === criteria.message.id,
  );
  return exactMessage ?? candidates.find(isActivePendingSteer) ?? candidates.at(-1);
}

function matchesUserMessage(cell: TranscriptCell, criteria: UserMessageMatchCriteria): boolean {
  if (!isEligibleUserMessageCell(cell, criteria)) return false;
  if (criteria.message.id !== undefined && cell.sourceMessageId === criteria.message.id)
    return true;
  if (cell.sourceMessageId !== undefined) return false;
  if (cell.content.trim() !== criteria.formattedContent.trim()) return false;
  if (!sameTranscriptAttachments(cell.attachments, criteria.attachments)) return false;
  return (
    cell.id === `user:${criteria.turnId}` || cell.id.startsWith('optimistic:user:') || !cell.turnId
  );
}

function isEligibleUserMessageCell(
  cell: TranscriptCell,
  criteria: UserMessageMatchCriteria,
): boolean {
  if (cell.kind !== 'user') return false;
  if (cell.userPresentation !== 'pending-steer') return true;
  if (!isActivePendingSteer(cell)) return false;
  return (
    cell.turnId === undefined ||
    cell.turnId === criteria.turnId ||
    cell.turnId === criteria.message.turnId
  );
}

function isActivePendingSteer(cell: TranscriptCell): boolean {
  return (
    cell.userPresentation === 'pending-steer' &&
    (cell.status === 'pending' || cell.status === 'running')
  );
}

function sameTranscriptAttachments(
  left: readonly TranscriptAttachment[] | undefined,
  right: readonly TranscriptAttachment[],
): boolean {
  if ((left?.length ?? 0) !== right.length) return false;
  return right.every((attachment, index) => {
    const candidate = left?.[index];
    return (
      candidate?.type === attachment.type &&
      candidate.fileName === attachment.fileName &&
      candidate.mimeType === attachment.mimeType &&
      (candidate.sizeBytes === undefined ||
        attachment.sizeBytes === undefined ||
        candidate.sizeBytes === attachment.sizeBytes)
    );
  });
}

function mergeTranscriptAttachments(
  existing: readonly TranscriptAttachment[] | undefined,
  incoming: readonly TranscriptAttachment[],
): TranscriptAttachment[] {
  return incoming.map((attachment, index) => ({
    ...existing?.[index],
    ...attachment,
  }));
}

/** Older persisted rows may still contain the durable plugin transport links. */
function visibleUserContent(content: string): string {
  let visible = visibleSessionMutationContent(content);
  for (const mention of parsePluginMentions(visible).reverse()) {
    visible = visible.slice(0, mention.start) + mention.label + visible.slice(mention.end);
  }
  return visible;
}
