import type { TuiPendingPermission, TuiQuestionnaireRequest } from './runtime-models.js';
import type { CompactionTokenUsage, GlobalThreadGoal } from '@mavis/shared/global-events';
import type {
  SessionLLMRetryReason,
  SessionLLMRetryScope,
  SessionLLMRetryStatus,
} from '@mavis/shared/llm-retry-event';

interface TuiRuntimeEventBase {
  timestampMs: number;
  source: string;
  sessionId?: string;
}

export type TuiSessionLifecycleEvent = TuiRuntimeEventBase & {
  type:
    | 'session.start'
    | 'session.finish'
    | 'session.error'
    | 'session.abort'
    | 'session.active_run.action';
  turnId?: string;
  taskId?: string;
  runSource?: string;
  queueItemIds: string[];
  error?: string;
  errorCode?: number;
  errorSource?: string;
  errorDetail?: string;
  errorProviderId?: string;
};

export type TuiQueueUpdatedEvent = TuiRuntimeEventBase & {
  type: 'session.queue.updated';
  itemId?: string;
  status?: string;
  queuedCount?: number;
  failedReason?: string;
  reason?: string;
  admissionReason?: string;
};

export type TuiQuestionnaireEvent =
  | (TuiRuntimeEventBase & {
      type: 'questionnaire.ask';
      request: TuiQuestionnaireRequest;
      agentName?: string;
    })
  | (TuiRuntimeEventBase & {
      type: 'questionnaire.dismiss' | 'questionnaire.superseded';
      requestId: string;
    });

export type TuiPermissionEvent =
  | (TuiRuntimeEventBase & {
      type: 'permission.ask';
      request: TuiPendingPermission;
    })
  | (TuiRuntimeEventBase & {
      type: 'permission.resolved';
      requestId: string;
      decision?: 'allowOnce' | 'allowAlways' | 'deny';
    });

export type TuiSessionCatalogEvent =
  | (TuiRuntimeEventBase & {
      type: 'session.created';
      agentName: string;
      sessionType: 'root' | 'branch';
      sessionKind?: string;
      visibility?: 'visible' | 'hidden';
      title?: string;
      parentSessionId?: string;
    })
  | (TuiRuntimeEventBase & {
      type: 'session.deleted';
      agentName?: string;
    })
  | (TuiRuntimeEventBase & {
      type: 'session.title_updated';
      agentName?: string;
      title: string;
    })
  | (TuiRuntimeEventBase & {
      type: 'session.pinned_updated';
      agentName?: string;
      pinned: boolean;
    });

export type TuiCompactionEvent = TuiRuntimeEventBase & {
  type: 'session.compaction.started' | 'session.compaction.completed' | 'session.compaction.failed';
  compactionId: string;
  messagesBefore?: number;
  messagesAfter?: number;
  tokensBefore?: number;
  tokensAfter?: number;
  tokenUsage?: CompactionTokenUsage;
};

export type TuiContentLifecycleEvent =
  | (TuiRuntimeEventBase & {
      type: 'content.retry.exceeded';
      turnId?: string;
      variant: 'content' | 'network' | 'auth';
      lastUserMsgId?: string;
    })
  | (TuiRuntimeEventBase & {
      type: 'message.rewind';
      contextReset?: boolean;
    });

export type TuiRotationEvent = TuiRuntimeEventBase & {
  type: 'rotation.completed';
  agentName: string;
  oldSessionId: string;
  newSessionId: string;
  reason: string;
};

export type TuiLlmRetryEvent = TuiRuntimeEventBase & {
  type: 'session.llm_retry';
  sessionId: string;
  turnId: string;
  callId: string;
  scope: SessionLLMRetryScope;
  status: SessionLLMRetryStatus;
  retryAttempt: number;
  maxRetries: number;
  requestAttempt: number;
  delayMs?: number;
  nextRetryAtMs?: number;
  error?: {
    reason: SessionLLMRetryReason;
    code?: number;
  };
};

export type TuiThreadGoalEvent =
  | (TuiRuntimeEventBase & {
      type: 'thread_goal.updated';
      sessionId: string;
      goal: GlobalThreadGoal;
    })
  | (TuiRuntimeEventBase & {
      type: 'thread_goal.cleared';
      sessionId: string;
      goalId: string;
    });

/** A validated next-message suggestion for one settled Turn of `sessionId`. */
export type TuiPromptSuggestionEvent = TuiRuntimeEventBase & {
  type: 'turn.prompt_suggestion.generated';
  sessionId: string;
  turnId: string;
  suggestion: string;
  promptVersion?: string;
  elapsedMs?: number;
};

export type TuiUnknownRuntimeEvent = TuiRuntimeEventBase & {
  type: 'unknown';
  originalType: string;
};

export type TuiRuntimeEvent =
  | TuiSessionLifecycleEvent
  | TuiQueueUpdatedEvent
  | TuiQuestionnaireEvent
  | TuiPermissionEvent
  | TuiSessionCatalogEvent
  | TuiCompactionEvent
  | TuiContentLifecycleEvent
  | TuiRotationEvent
  | TuiLlmRetryEvent
  | TuiThreadGoalEvent
  | TuiPromptSuggestionEvent
  | TuiUnknownRuntimeEvent;
