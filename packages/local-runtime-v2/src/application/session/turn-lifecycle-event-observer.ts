import {
  RuntimeEventStatus,
  RuntimeEventType,
  type RuntimeEvent,
} from '@mavis/agent-core/protocol';

import { parseByokErrorStatus } from '../../service/model-system/index.js';
import type { SessionRepository } from '../../service/session-system/index.js';
import type {
  AgentEventBestEffortObserver,
  AgentEventContext,
} from '../../service/turn-system/index.js';
import type { GlobalEventPublisher } from '../events.js';

export interface SessionTurnLifecycleEventObserverOptions {
  readonly sessions: Pick<SessionRepository, 'get'>;
  readonly publish: GlobalEventPublisher;
  readonly terminalMemory?: {
    record(input: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly agentName: string;
      readonly status: 'finished' | 'error' | 'aborted' | 'interrupted';
      readonly errorMessage?: string;
    }): Promise<unknown>;
  };
}

export function createSessionTurnLifecycleEvents(
  sessions: SessionTurnLifecycleEventObserverOptions['sessions'],
  publish: GlobalEventPublisher,
  terminalMemory: SessionTurnLifecycleEventObserverOptions['terminalMemory'],
): SessionTurnLifecycleEventObserver {
  return new SessionTurnLifecycleEventObserver({
    sessions,
    publish,
    terminalMemory,
  });
}

interface StartedTurnIdentity {
  readonly agentName: string;
  readonly resourceAgentName: string;
  readonly memoryWriteEnabled: boolean;
}

/**
 * Projects committed v2 AgentHost lifecycle facts to the product EventBus.
 *
 * Direct and detached Turns share this observer, so UI, CLI and remote clients
 * see one lifecycle regardless of which ingress admitted the Turn.
 */
export class SessionTurnLifecycleEventObserver implements AgentEventBestEffortObserver {
  private readonly startedTurns = new Map<string, StartedTurnIdentity>();

  constructor(private readonly options: SessionTurnLifecycleEventObserverOptions) {}

  async observeRuntimeEvent(input: {
    readonly context: AgentEventContext;
    readonly event: RuntimeEvent;
  }): Promise<void> {
    const status = lifecycleStatus(input.event);
    if (!status) return;
    const identity = await this.ensureStarted(input.context);
    if (status === 'running') return;
    try {
      await this.recordTerminalMemory(input.context, identity, status, input.event);
      this.publishTerminal(input.context, identity.agentName, status, input.event);
    } finally {
      this.startedTurns.delete(turnKey(input.context));
    }
  }

  private async ensureStarted(context: AgentEventContext): Promise<StartedTurnIdentity> {
    const key = turnKey(context);
    const startedAgent = this.startedTurns.get(key);
    if (startedAgent) return startedAgent;
    const session = await this.options.sessions.get(context.sessionId);
    if (!session) {
      throw new Error(`Session lifecycle event Session not found: ${context.sessionId}`);
    }
    const queueItemIds = context.queueItemIds?.length ? [...context.queueItemIds] : undefined;
    const backgroundTask = backgroundTaskDeliveryIdentity(context);
    this.options.publish({
      type: 'session.start',
      payload: {
        sessionId: context.sessionId,
        agentName: session.agentName,
        turnId: context.turnId,
        ...(backgroundTask ??
          (queueItemIds ? { source: 'queued-drain' as const, queueItemIds } : {})),
      },
    });
    const identity = {
      agentName: session.agentName,
      resourceAgentName: context.resourceAgentName ?? session.agentName,
      memoryWriteEnabled: session.memoryPolicy?.writeEnabled !== false,
    };
    this.startedTurns.set(key, identity);
    return identity;
  }

  private async recordTerminalMemory(
    context: AgentEventContext,
    identity: StartedTurnIdentity,
    status: Exclude<LifecycleStatus, 'running'>,
    event: RuntimeEvent,
  ): Promise<void> {
    const record = this.options.terminalMemory?.record;
    if (!record || !identity.memoryWriteEnabled) return;
    const errorMessage = terminalErrorMessage(event);
    try {
      await record({
        sessionId: context.sessionId,
        turnId: context.turnId,
        agentName: identity.resourceAgentName,
        status: terminalMemoryStatus(status),
        ...(errorMessage ? { errorMessage } : {}),
      });
    } catch {
      // Memory bookkeeping is best-effort and cannot replace the terminal lifecycle event.
    }
  }

  private publishTerminal(
    context: AgentEventContext,
    agentName: string,
    status: Exclude<LifecycleStatus, 'running'>,
    event: RuntimeEvent,
  ): void {
    const common = {
      sessionId: context.sessionId,
      agentName,
      turnId: context.turnId,
      ...(cronRunIdentity(context) ?? {}),
      ...(backgroundTaskDeliveryIdentity(context) ?? {}),
    };
    if (status === 'completed') {
      this.options.publish({
        type: 'session.finish',
        payload: { ...common, status: 'finished' },
      });
      return;
    }
    if (status === 'aborted') {
      this.options.publish({
        type: 'session.abort',
        payload: { ...common, status: 'aborted' },
      });
      return;
    }
    const message = terminalErrorMessage(event);
    this.options.publish({
      type: 'session.error',
      payload: {
        ...common,
        status: 'error',
        ...(message ? { error: message } : {}),
        ...terminalErrorFields(event.payload.error, message),
      },
    });
  }
}

function terminalMemoryStatus(
  status: Exclude<LifecycleStatus, 'running'>,
): 'finished' | 'error' | 'aborted' {
  if (status === 'completed') return 'finished';
  if (status === 'failed') return 'error';
  return 'aborted';
}

function terminalErrorFields(
  error: RuntimeEvent['payload']['error'],
  message: string | undefined,
): {
  errorCode?: number;
  errorSource?: string;
  errorDetail?: string;
  errorProviderId?: string;
} {
  const errorCode = typeof error?.code === 'number' ? error.code : undefined;
  const byok = parseByokErrorStatus(message, errorCode);
  if (byok) {
    return {
      errorCode: byok.errorCode,
      errorSource: byok.errorSource,
      errorDetail: byok.errorDetail,
      errorProviderId: byok.errorProviderId,
    };
  }
  return {
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(error ? { errorSource: 'agent-runtime' } : {}),
    ...(error?.details ? { errorDetail: error.details } : {}),
  };
}

function terminalErrorMessage(event: RuntimeEvent): string | undefined {
  return event.payload.error?.message?.trim() || event.payload.stop_reason?.message?.trim();
}

type LifecycleStatus = 'running' | 'completed' | 'failed' | 'aborted';

function lifecycleStatus(event: RuntimeEvent): LifecycleStatus | undefined {
  if (
    event.type !== RuntimeEventType.SESSION_STATUS &&
    event.type !== RuntimeEventType.TURN_TERMINAL
  ) {
    return undefined;
  }
  if (event.payload.status === RuntimeEventStatus.RUNNING) return 'running';
  if (event.payload.status === RuntimeEventStatus.COMPLETED) return 'completed';
  if (event.payload.status === RuntimeEventStatus.FAILED) return 'failed';
  return event.payload.status === RuntimeEventStatus.ABORTED ? 'aborted' : undefined;
}

function turnKey(context: Pick<AgentEventContext, 'sessionId' | 'turnId'>): string {
  return `${context.sessionId}\0${context.turnId}`;
}

function cronRunIdentity(
  context: AgentEventContext,
): { readonly cronId: string; readonly cronRunId: string } | undefined {
  if (context.provenance?.source !== 'cron') return undefined;
  const sourceContext = context.provenance.sourceContext;
  const cronId = sourceContext?.cronId;
  const runId = sourceContext?.runId;
  if (typeof cronId !== 'string' || !cronId.trim() || typeof runId !== 'string' || !runId.trim()) {
    return undefined;
  }
  return { cronId, cronRunId: runId };
}

function backgroundTaskDeliveryIdentity(
  context: AgentEventContext,
): { readonly source: 'background-task-delivery'; readonly taskId: string } | undefined {
  if (context.provenance?.source !== 'background-task') return undefined;
  const origin = context.provenance.sourceContext?.origin;
  if (!origin || typeof origin !== 'object') return undefined;
  if (Reflect.get(origin, 'kind') !== 'background-task-terminal') return undefined;
  const taskIds = Reflect.get(origin, 'taskIds');
  if (!Array.isArray(taskIds)) return undefined;
  const taskId = taskIds.find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.trim().length > 0,
  );
  return taskId ? { source: 'background-task-delivery', taskId } : undefined;
}
