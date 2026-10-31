import { planModeExtension } from '@mavis/agent-extension';
import type {
  LocalQuestionnaireService,
  QuestionnaireOwnedActionHandler,
} from '@mavis/local-runtime';
import { QUESTIONNAIRE_TTL_MS } from '@mavis/shared/questionnaire';

import type { PlanImplementationReceipt, PlanService } from './contracts.js';
import type { AppDb } from '../../infra/db/client.js';
import type {
  CommittedQueueCapability,
  SessionInteractionModeCapability,
} from '../session-system/index.js';
import type { PlanDocumentPort } from '../session-system/sessions/support/plan-document.js';
import {
  createPlanAdmissionPolicy,
  createPlanLifecycleAdmissionFence,
  hasAnyPendingQuestionnaire,
} from './questionnaire/admission.js';
import { createPlanApplication } from './application.js';
import { createPlanLifecycleReconciler } from './lifecycle-reconciler.js';
import {
  recoverPlanImplementationQueue,
  recoverPlanLifecycleAndImplementationQueue,
} from './implementation-queue-recovery.js';
import { createPlanQuestionnaireActionHandler } from './questionnaire/questionnaire-action-handler.js';
import { createPlanQuestionnaireAdmissionReadModel } from './questionnaire/questionnaire-admission-read-model.js';
import { createPlanPolicyGuard } from './tool-guard.js';

export function initializePlanService(options: {
  readonly db: AppDb;
  readonly modes: SessionInteractionModeCapability;
  readonly documents: PlanDocumentPort;
  readonly questionnaires: {
    resolveLocale(): string;
    createService(): LocalQuestionnaireService;
    bindOwnedAction(
      handler: QuestionnaireOwnedActionHandler,
      onFailure?: (requestId: string) => void,
    ): void;
  };
  readonly queue: Pick<
    CommittedQueueCapability,
    | 'listPendingSessionIds'
    | 'list'
    | 'cancel'
    | 'requireMutableSession'
    | 'findByClientRequestId'
    | 'enqueue'
    | 'cancel'
  >;
  readonly receipts: {
    findReceipt(turnId: string): Promise<PlanImplementationReceipt | undefined>;
  };
  readonly dispatchQueue: (sessionId: string) => Promise<void>;
  readonly entryEnabled: () => boolean;
  readonly agentEntryEnabled: () => boolean;
  readonly reportFailure: (error: unknown) => void;
  /** Agent-turn Review fallback rejections; defaults to `reportFailure`. */
  readonly reportReviewFallbackFailure?: (error: unknown) => void;
  readonly nowMs?: () => number;
}): PlanService {
  const nowMs = options.nowMs ?? Date.now;
  const questionnaireReadModel = createPlanQuestionnaireAdmissionReadModel();
  const lifecycleFence = createPlanLifecycleAdmissionFence({
    db: options.db,
    readModel: questionnaireReadModel,
    nowMs,
  });
  const application = createPlanApplication({
    entryEnabled: options.entryEnabled,
    agentEntryEnabled: options.agentEntryEnabled,
    modes: options.modes,
    lifecycleFence,
    pendingQuestionnaires: {
      hasAny: async (sessionId) =>
        hasAnyPendingQuestionnaire(
          questionnaireReadModel,
          options.db,
          sessionId,
          nowMs() - QUESTIONNAIRE_TTL_MS,
        ),
    },
    documents: options.documents,
    questionnaires: options.questionnaires,
    queue: options.queue,
    receipts: options.receipts,
  });
  let questionnaireService: LocalQuestionnaireService | undefined;
  const lifecycleReconciler = createPlanLifecycleReconciler({
    recover: async (dispatch) => {
      const service = (questionnaireService ??= options.questionnaires.createService());
      return recoverPlanLifecycleAndImplementationQueue({
        dispatch,
        recoverLifecycle: () => service.reconcileOwnedActions(dispatch),
        recoverImplementationQueue: () =>
          recoverPlanImplementationQueue({
            queue: options.queue,
            dispatchQueue: options.dispatchQueue,
            entryEnabled: options.entryEnabled,
          }),
      });
    },
    dispatchQueue: options.dispatchQueue,
    reportFailure: options.reportFailure,
  });
  const questionnaireActionHandler = createPlanQuestionnaireActionHandler({
    application,
    dispatchQueue: options.dispatchQueue,
    onDispatchFailure: (sessionId) => lifecycleReconciler.scheduleQueueWake(sessionId),
  });
  options.questionnaires.bindOwnedAction(questionnaireActionHandler, (requestId) =>
    lifecycleReconciler.schedule(requestId),
  );
  return {
    toolGuard: createPlanPolicyGuard(),
    lifecycleFence,
    admission: createPlanAdmissionPolicy({
      lifecycleFence,
      modes: options.modes,
      questionnaireReadModel,
      nowMs,
      entryEnabled: options.entryEnabled,
    }),
    application,
    extension: planModeExtension({
      actions: {
        enter: (input) => application.enterFromAgent(input),
        exit: (input) => application.exitFromAgent(input),
      },
      agentEntryEnabled: options.agentEntryEnabled,
      onReviewFallbackFailed: options.reportReviewFallbackFailure ?? options.reportFailure,
    }),
    questionnaireActionHandler,
    lifecycleReconciler,
  };
}
