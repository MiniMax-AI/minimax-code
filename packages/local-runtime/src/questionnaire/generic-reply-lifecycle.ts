import type { AskQuestionnaireReplyPayload } from '@mavis/shared/questionnaire';

import type {
  LocalQuestionnaireServiceDeps,
  ReplyQuestionnaireInput,
  ReplyQuestionnaireResult,
} from './contracts.js';
import { LocalQuestionnaireError } from './errors.js';
import {
  QuestionnaireValidationError,
  sanitizeReplyAnswers,
  validateQuestionnaireReply,
} from './normalize.js';
import {
  isOwnedQuestionnaireRequest,
  QuestionnaireOwnedActionLifecycle,
} from './owned-action-lifecycle.js';
import { isQuestionnaireAgentAllowed } from './request-lifecycle.js';
import type { QuestionnaireRequestRecord } from './store.js';

export class QuestionnaireGenericReplyLifecycle {
  constructor(
    private readonly deps: LocalQuestionnaireServiceDeps,
    private readonly ownedActionLifecycle: QuestionnaireOwnedActionLifecycle,
    private readonly wakeQueueAfterDuplicateResume: (
      record: QuestionnaireRequestRecord,
    ) => Promise<void>,
  ) {}

  async reply(input: ReplyQuestionnaireInput): Promise<ReplyQuestionnaireResult> {
    const record = await this.requireReplyRecord(input.requestId, input.agentName);
    const session = await this.deps.getSessionById(record.sessionId);
    if (!session) {
      await this.deps.store.delete(record.requestId);
      throw new LocalQuestionnaireError(404, 'SESSION_NOT_FOUND', record.sessionId);
    }

    let reply: AskQuestionnaireReplyPayload;
    try {
      validateQuestionnaireReply(record.request, input.reply);
      reply = {
        schemaVersion: 2,
        requestId: input.reply.requestId,
        answers: sanitizeReplyAnswers(input.reply),
        submittedAt: input.reply.submittedAt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code =
        err instanceof QuestionnaireValidationError
          ? 'QUESTIONNAIRE_INVALID_REPLY'
          : 'VALIDATION_ERROR';
      throw new LocalQuestionnaireError(400, code, message);
    }

    const ownedAction = isOwnedQuestionnaireRequest(record.request);
    const persistedReply =
      !ownedAction && record.status === 'answered' ? record.replyPayload : undefined;
    if (persistedReply && !haveSameAnswers(persistedReply, reply)) {
      throw new LocalQuestionnaireError(
        409,
        'QUESTIONNAIRE_ALREADY_ANSWERED',
        `Questionnaire request is ${record.status}`,
      );
    }
    const continuationReply = persistedReply ?? reply;
    const answeredAt = record.answeredAt ?? continuationReply.submittedAt;
    if (!persistedReply) {
      const settled = this.deps.store.settleReply
        ? await this.deps.store.settleReply(record.requestId, answeredAt, continuationReply, {
            requirePending: ownedAction,
          })
        : await this.deps.store.markAnswered(record.requestId, answeredAt, continuationReply);
      if (!settled) {
        throw new LocalQuestionnaireError(
          ownedAction ? 410 : 409,
          ownedAction ? 'QUESTIONNAIRE_NOT_PENDING' : 'QUESTIONNAIRE_ALREADY_ANSWERED',
          'Questionnaire request changed while the reply was being submitted',
        );
      }
    }

    const answeredRecord: QuestionnaireRequestRecord = {
      ...record,
      status: 'answered',
      answeredAt,
      replyPayload: continuationReply,
    };
    let completed:
      | Awaited<ReturnType<QuestionnaireOwnedActionLifecycle['processAnswered']>>
      | undefined;
    try {
      completed = await this.ownedActionLifecycle.processAnswered(
        answeredRecord,
        continuationReply,
        true,
      );
    } catch (err) {
      this.deps.emitBusEvent('questionnaire.inject_failed', {
        requestId: record.requestId,
        sessionId: record.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      const recoverOwnedAction = this.ownedActionRecovery(ownedAction);
      if (recoverOwnedAction) {
        recoverOwnedAction(record.requestId);
      } else {
        throw new LocalQuestionnaireError(
          503,
          'QUESTIONNAIRE_CONTINUATION_NOT_STARTED',
          `Questionnaire answer was saved, but the continuation could not start: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (completed && !completed.completed) {
      this.deps.emitBusEvent('questionnaire.inject_failed', {
        requestId: record.requestId,
        sessionId: record.sessionId,
        ...(completed.status !== undefined ? { status: completed.status } : {}),
        ...(completed.error ? { error: completed.error } : {}),
      });
      const recoverOwnedAction = this.ownedActionRecovery(ownedAction);
      if (recoverOwnedAction) {
        recoverOwnedAction(record.requestId);
      } else {
        throw new LocalQuestionnaireError(
          completed.status ?? 503,
          'QUESTIONNAIRE_CONTINUATION_NOT_STARTED',
          `Questionnaire answer was saved, but the continuation could not start${
            completed.status === undefined ? '.' : ` (HTTP ${completed.status}).`
          }`,
        );
      }
    }
    if (completed?.completed && completed.markInjected) {
      await this.deps.store.markInjected(record.requestId, this.deps.nowMs());
      if (completed.admissionMode === 'duplicate') {
        await this.wakeQueueAfterDuplicateResume(record);
      }
      if (ownedAction) {
        await this.ownedActionLifecycle.notifyAfterConsumed({
          record: answeredRecord,
          action: { kind: 'reply', reply: continuationReply },
          dispatch: true,
        });
      }
    }

    this.deps.publishGlobalEvent?.({
      type: 'questionnaire.dismiss',
      payload: {
        requestId: record.requestId,
        sessionId: record.sessionId,
        agentName: record.agentName,
        status: 'answered',
      },
    });
    return {
      ok: true,
      requestId: record.requestId,
      sessionId: record.sessionId,
      ...(record.agentName ? { agentName: record.agentName } : {}),
      answeredAt,
      injected: completed?.completed === true,
    };
  }

  /**
   * An owned action's saved answer is resumed by its owner's recovery hook.
   * Without one nothing retries it before the next startup reconciliation, so
   * the caller must see the failure instead of an accepted reply.
   */
  private ownedActionRecovery(ownedAction: boolean): ((requestId: string) => void) | undefined {
    return ownedAction ? this.deps.onOwnedActionFailure : undefined;
  }

  private async requireReplyRecord(
    requestId: string,
    agentName: string,
  ): Promise<QuestionnaireRequestRecord> {
    const record = await this.deps.store.get(requestId);
    if (!record) {
      throw new LocalQuestionnaireError(
        404,
        'QUESTIONNAIRE_NOT_FOUND',
        'Questionnaire request not found',
      );
    }
    if (!isQuestionnaireAgentAllowed(record, agentName)) {
      throw new LocalQuestionnaireError(
        403,
        'AGENT_SCOPE_MISMATCH',
        'Questionnaire request is not visible to this agent',
      );
    }
    if (record.status === 'answered' && !record.injectedAt && record.replyPayload) {
      return record;
    }
    if (record.status === 'answered') {
      throw new LocalQuestionnaireError(
        409,
        'QUESTIONNAIRE_ALREADY_ANSWERED',
        `Questionnaire request is ${record.status}`,
      );
    }
    if (record.status !== 'pending') {
      throw new LocalQuestionnaireError(
        410,
        'QUESTIONNAIRE_NOT_PENDING',
        `Questionnaire request is ${record.status}`,
      );
    }
    return record;
  }
}

function haveSameAnswers(
  left: AskQuestionnaireReplyPayload,
  right: AskQuestionnaireReplyPayload,
): boolean {
  return JSON.stringify(canonicalAnswers(left)) === JSON.stringify(canonicalAnswers(right));
}

function canonicalAnswers(reply: AskQuestionnaireReplyPayload): Array<{
  stepId: string;
  selectedOptionIds: string[];
  selectedOther: boolean;
  otherText?: string;
  skipped: boolean;
}> {
  return reply.answers
    .map((answer) => ({
      stepId: answer.stepId,
      selectedOptionIds: [...(answer.selectedOptionIds ?? [])].sort(),
      selectedOther: answer.selectedOther === true,
      ...(answer.otherText ? { otherText: answer.otherText } : {}),
      skipped: answer.skipped === true,
    }))
    .sort((left, right) => left.stepId.localeCompare(right.stepId));
}
