import type {
  SessionCompactionFact,
  SessionSystemFactPorts,
} from '../../service/session-system/index.js';
import type { GlobalEventPublisher } from '../events.js';
import { QueueCommittedEventProjector } from '../queue/queue-application.js';
import { SessionLifecycleEventProjector } from './lifecycle-application.js';
import type {
  ModelProviderSessionPort,
  ModelProviderSessionView,
} from './model-provider-contracts.js';
import { RootArchiveTitleEventProjector } from './root-application.js';

export interface CreateApplicationFactPortsOptions {
  readonly publish: GlobalEventPublisher;
}

type ModelProviderSessionUpdate =
  | Parameters<ModelProviderSessionPort['update']>[1]
  | { readonly advisor: Parameters<ModelProviderSessionPort['updateAdvisor']>[1] };

/** Preserves write-before-event ordering for model selection composed before SessionLifecycleService. */
export function createCommittedModelProviderSessionPort<TSession extends ModelProviderSessionView>(
  input: {
    readonly get: (sessionId: string) => Promise<TSession | undefined>;
    readonly update: (sessionId: string, fields: ModelProviderSessionUpdate) => Promise<TSession>;
    readonly onCommittedUpdate: (session: TSession) => void;
  },
): ModelProviderSessionPort {
  return {
    get: input.get,
    update: async (sessionId, fields) => {
      const updated = await input.update(sessionId, fields);
      input.onCommittedUpdate(updated);
      return updated;
    },
    updateAdvisor: async (sessionId, advisor) => {
      const updated = await input.update(sessionId, { advisor });
      input.onCommittedUpdate(updated);
      return updated;
    },
  };
}

export function publishSessionCompactionFact(
  publish: GlobalEventPublisher,
  fact: SessionCompactionFact,
): void {
  if (fact.kind === 'started') {
    publish({
      type: 'session.compaction.started',
      payload: { sessionId: fact.sessionId, compactionId: fact.attemptId },
    });
    return;
  }
  if (fact.kind === 'completed') {
    publish({
      type: 'session.compaction.completed',
      payload: {
        sessionId: fact.sessionId,
        compactionId: fact.attemptId,
        messagesBefore: fact.messagesBefore,
        messagesAfter: fact.messagesAfter,
        tokensBefore: fact.tokensBefore,
        tokensAfter: fact.tokensAfter,
        ...(fact.tokenUsage === undefined ? {} : { tokenUsage: fact.tokenUsage }),
      },
    });
    return;
  }
  publish({
    type: 'session.compaction.failed',
    payload: {
      sessionId: fact.sessionId,
      compactionId: fact.attemptId,
      ...(fact.tokenUsage === undefined ? {} : { tokenUsage: fact.tokenUsage }),
    },
  });
}

/** Projects v2-owned committed facts directly into the v2 EventBus. */
export function createApplicationFactPorts(
  options: CreateApplicationFactPortsOptions,
): SessionSystemFactPorts {
  const sessionEvents = new SessionLifecycleEventProjector({ publish: options.publish });
  const queueEvents = new QueueCommittedEventProjector({ publish: options.publish });
  const archiveTitleEvents = new RootArchiveTitleEventProjector({ publish: options.publish });
  return {
    session: {
      handle: (fact) => sessionEvents.handle(fact),
    },
    queue: {
      handle: (facts) => queueEvents.handle(facts),
    },
    conversation: {
      handle: (fact) => {
        if (fact.kind === 'attempt-recalled') {
          options.publish({
            type: 'message.rewind',
            payload: { sessionId: fact.sessionId, contextReset: true },
          });
          return;
        }
        if (fact.kind === 'network-stopped') {
          options.publish({
            type: 'content.retry.exceeded',
            payload: { sessionId: fact.sessionId, variant: 'network' },
          });
          return;
        }
        options.publish({
          type: 'content.retry.exceeded',
          payload: {
            sessionId: fact.sessionId,
            variant: fact.variant,
            ...(fact.lastUserMsgId ? { lastUserMsgId: fact.lastUserMsgId } : {}),
          },
        });
        options.publish({
          type: 'message.rewind',
          payload: { sessionId: fact.sessionId, contextReset: true },
        });
      },
    },
    archiveTitle: {
      observe: async (fact) => {
        archiveTitleEvents.observe(fact);
      },
    },
  };
}
