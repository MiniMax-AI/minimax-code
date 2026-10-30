import { logger } from '../common/logger.js';
import type { LocalPermissionRuleStore } from '../permissions/rules.js';
import type { GlobalEventInput } from '@mavis/shared/global-events';
import type {
  LocalPermissionDecision,
  LocalPermissionRequest,
  LocalPermissionRequestWaiter,
} from './host-helpers.js';
import { localPermissionRuleToolName } from './host-permission-rules.js';
import { makeId, serializePermissionRequest } from './host-helpers.js';
import {
  emitAskReplyMetric,
  emitAskShownMetric,
  emitAskWaitMetric,
} from './routes/permission-metrics.js';
import {
  findPendingLocalPermissionRequest,
  type LocalPermissionRequestInput,
} from './routes/permission-request-helpers.js';
import type { ChannelPermissionOutboundPort } from '../channels/permission-bridge.js';
import type { MetricsClient } from '../common/metrics.js';

export interface LocalPermissionApprovalServiceDeps {
  agentName: string;
  nowMs: () => number;
  permissionRules: LocalPermissionRuleStore;
  publishGlobalEvent: (event: GlobalEventInput) => void;
  channelPermissionOutbound?: ChannelPermissionOutboundPort;
  metricsClient?: MetricsClient;
  permissionMode?: string;
}

export interface LocalPermissionApprovalHandle {
  requestId: string;
  promise: Promise<LocalPermissionDecision>;
}

/**
 * Owns the local permission ask lifecycle. Policy/checker code decides that an
 * ask is needed; this service only registers, exposes, replies to, aborts and
 * persists the resulting approval. HTTP, DesktopService and channel adapters
 * should not manipulate pending records directly.
 */
type PermissionRequestLifecycle = 'pending' | 'settling';

export class LocalPermissionApprovalService {
  private readonly pendingPermissionRequests = new Map<string, LocalPermissionRequest>();
  private readonly requestStates = new Map<string, PermissionRequestLifecycle>();
  private readonly origins = new Map<string, LocalPermissionRequestInput['origin']>();

  constructor(private readonly deps: LocalPermissionApprovalServiceDeps) {}

  begin(input: LocalPermissionRequestInput, signal?: AbortSignal): LocalPermissionApprovalHandle {
    const existing = findPendingLocalPermissionRequest(this.pendingPermissionRequests, input);
    if (existing) {
      logger.info(
        {
          request_id: existing.requestId,
          session_id: input.sessionId,
          lifecycle: 'deduped',
          pending_count: this.pendingPermissionRequests.size,
        },
        'permission.lifecycle',
      );
      return { requestId: existing.requestId, promise: this.attachWaiter(existing, signal) };
    }

    const requestId = makeId('perm');
    const record: LocalPermissionRequest = {
      requestId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      agentName: input.agentName || this.deps.agentName,
      toolName: input.toolName,
      ruleContents: [...input.ruleContents],
      ...(input.ruleMatchers ? { ruleMatchers: input.ruleMatchers.map(cloneRuleMatcher) } : {}),
      ...(input.persistWholeToolRuleOnReply
        ? { persistWholeToolRuleOnReply: input.persistWholeToolRuleOnReply }
        : {}),
      ...(input.toolInput ? { toolInput: input.toolInput } : {}),
      toolDescription: input.toolDescription ?? input.toolName,
      ...ptcRequestFields(input),
      reason: input.reason,
      createdAt: this.deps.nowMs(),
      waiters: new Set<LocalPermissionRequestWaiter>(),
      resolve: (decision) => {
        if (this.claim(record)) this.settle(record, decision);
      },
      cleanup: () => {
        for (const waiter of [...record.waiters]) waiter.detach();
      },
    };
    this.pendingPermissionRequests.set(requestId, record);
    this.requestStates.set(requestId, 'pending');
    this.origins.set(requestId, input.origin);
    const promise = this.attachWaiter(record, signal);

    // An already-aborted signal removes the record before this point.
    if (this.pendingPermissionRequests.has(requestId)) this.announce(record);
    logger.info(
      {
        request_id: requestId,
        session_id: record.sessionId,
        lifecycle: 'created',
        pending_count: this.pendingPermissionRequests.size,
        waiter_count: record.waiters.size,
        origin: input.origin?.platform ?? 'local',
      },
      'permission.lifecycle',
    );
    return { requestId, promise };
  }

  listPending(): ReturnType<typeof serializePermissionRequest>[] {
    return [...this.pendingPermissionRequests.values()].map((record) =>
      serializePermissionRequest(record),
    );
  }

  async reply(
    requestIds: readonly string[],
    decision: LocalPermissionDecision,
  ): Promise<{ processed: string[]; skipped: string[] }> {
    const processed: string[] = [];
    const skipped: string[] = [];
    for (const requestId of requestIds) {
      const record = this.pendingPermissionRequests.get(requestId);
      if (!record || !this.claim(record)) {
        skipped.push(requestId);
        logger.info(
          {
            request_id: requestId,
            session_id: record?.sessionId ?? 'unknown',
            decision,
            result: 'skipped',
          },
          'permission.skipped',
        );
        continue;
      }
      const ruleContents =
        record.ruleContents.length > 0
          ? record.ruleContents
          : record.persistWholeToolRuleOnReply
            ? ['*']
            : [];
      try {
        if (ruleContents.length > 0) {
          const global = decision === 'allowAlways';
          const persistenceSource = global ? 'global' : 'session';
          logger.info(
            {
              request_id: requestId,
              session_id: record.sessionId,
              lifecycle: 'rule_persist_start',
              source: persistenceSource,
              rule_count: ruleContents.length,
            },
            'permission.lifecycle',
          );
          await this.deps.permissionRules.applyUpdate({
            type: 'addRules',
            source: global ? 'global' : 'session',
            destination: global ? 'global' : record.sessionId,
            behavior: decision === 'deny' ? 'deny' : 'allow',
            rules: ruleContents.map((ruleContent, index) => ({
              tool_name:
                decision === 'deny'
                  ? record.toolName
                  : localPermissionRuleToolName(record.toolName),
              ...(record.ruleMatchers?.[index]
                ? { matcher: record.ruleMatchers[index] }
                : { rule_content: ruleContent }),
            })),
          });
          logger.info(
            {
              request_id: requestId,
              session_id: record.sessionId,
              lifecycle: 'rule_persisted',
              source: persistenceSource,
              rule_count: ruleContents.length,
            },
            'permission.lifecycle',
          );
        }
        emitAskReplyMetric(this.deps.metricsClient, decision);
        if (record.announced)
          emitAskWaitMetric(this.deps.metricsClient, this.deps.nowMs, record, 'replied');
        this.settle(record, decision);
        processed.push(requestId);
        logger.info(
          {
            request_id: requestId,
            session_id: record.sessionId,
            tool_name: record.toolName,
            decision,
            decision_source: 'user_reply',
            result: 'processed',
          },
          'permission.processed',
        );
      } catch (error) {
        logger.error(
          {
            request_id: requestId,
            session_id: record.sessionId,
            lifecycle: 'persistence_failed',
            error: error instanceof Error ? error.message : String(error),
          },
          'permission.lifecycle',
        );
        this.settle(record, 'deny');
      }
    }
    return { processed, skipped };
  }

  dismiss(requestId: string): boolean {
    const record = this.pendingPermissionRequests.get(requestId);
    if (!record || !this.claim(record)) {
      logger.info({ request_id: requestId, lifecycle: 'dismiss_skipped' }, 'permission.lifecycle');
      return false;
    }
    record.cleanup();
    logger.info(
      { request_id: requestId, session_id: record.sessionId, lifecycle: 'dismissed' },
      'permission.lifecycle',
    );
    this.settle(record, 'deny');
    return true;
  }

  abortSession(sessionId: string): void {
    let abortedCount = 0;
    for (const record of [...this.pendingPermissionRequests.values()]) {
      if (record.sessionId !== sessionId || !this.claim(record)) continue;
      abortedCount += 1;
      record.cleanup();
      if (record.announced)
        emitAskWaitMetric(this.deps.metricsClient, this.deps.nowMs, record, 'abandoned');
      this.settle(record, 'deny');
    }
    logger.info(
      { session_id: sessionId, lifecycle: 'session_aborted', aborted_count: abortedCount },
      'permission.lifecycle',
    );
  }

  private announce(record: LocalPermissionRequest): void {
    record.announced = true;
    logger.info(
      {
        request_id: record.requestId,
        session_id: record.sessionId,
        tool_name: record.toolName,
        decision: 'ask',
        rule_count: record.ruleContents.length,
      },
      'permission.ask',
    );
    this.deps.publishGlobalEvent({
      type: 'permission.ask',
      payload: serializePermissionRequest(record),
    });
    emitAskShownMetric(this.deps.metricsClient, this.deps.permissionMode ?? 'default');
    const outbound = this.deps.channelPermissionOutbound;
    const origin = this.origins.get(record.requestId);
    if (outbound) {
      logger.info(
        {
          request_id: record.requestId,
          session_id: record.sessionId,
          lifecycle: 'channel_dispatch',
        },
        'permission.lifecycle',
      );
      void outbound.onPermissionAsk({
        requestId: record.requestId,
        sessionId: record.sessionId,
        agentName: record.agentName,
        ...(origin ? { origin } : {}),
        request: {
          requestId: record.requestId,
          sessionId: record.sessionId,
          agentName: record.agentName,
          toolName: record.toolName,
          ...channelToolDescription(record),
          ...(record.toolInput ? { toolInput: record.toolInput } : {}),
          reason: record.parentToolCallId ? `来自 PTC：${record.reason}` : record.reason,
          ruleContents: record.ruleContents,
          createdAt: record.createdAt,
        },
      });
    }
  }

  private claim(record: LocalPermissionRequest): boolean {
    if (this.requestStates.get(record.requestId) !== 'pending') return false;
    this.requestStates.set(record.requestId, 'settling');
    return true;
  }

  private settle(record: LocalPermissionRequest, decision: LocalPermissionDecision): void {
    if (this.requestStates.get(record.requestId) !== 'settling') return;
    this.requestStates.delete(record.requestId);
    this.pendingPermissionRequests.delete(record.requestId);
    this.origins.delete(record.requestId);
    for (const waiter of [...record.waiters]) waiter.settle(decision);
    logger.info(
      { request_id: record.requestId, session_id: record.sessionId, decision },
      'permission.resolved',
    );
    this.deps.publishGlobalEvent({
      type: 'permission.resolved',
      payload: { requestId: record.requestId, sessionId: record.sessionId, decision },
    });
  }

  private attachWaiter(
    record: LocalPermissionRequest,
    signal?: AbortSignal,
  ): Promise<LocalPermissionDecision> {
    return new Promise((resolve) => {
      let settled = false;
      const detach = () => signal?.removeEventListener('abort', onAbort);
      const waiter: LocalPermissionRequestWaiter = {
        settle: (decision) => {
          if (settled) return;
          settled = true;
          detach();
          record.waiters.delete(waiter);
          resolve(decision);
        },
        detach,
      };
      const onAbort = () => {
        waiter.settle('deny');
        if (record.waiters.size === 0 && this.pendingPermissionRequests.has(record.requestId)) {
          if (record.announced)
            emitAskWaitMetric(this.deps.metricsClient, this.deps.nowMs, record, 'abandoned');
          record.resolve('deny');
        }
      };
      record.waiters.add(waiter);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

function cloneRuleMatcher<T extends NonNullable<LocalPermissionRequest['ruleMatchers']>[number]>(
  matcher: T,
): T {
  return {
    ...matcher,
    ...(matcher.kind === 'path' && matcher.actions ? { actions: [...matcher.actions] } : {}),
  } as T;
}

/** Fields present only when the ask comes from a trusted PTC child call. */
function ptcRequestFields(
  input: LocalPermissionRequestInput,
): Pick<LocalPermissionRequest, 'parentToolCallId' | 'parentToolDescription' | 'stopPtcOnDeny'> {
  return {
    ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
    ...(input.parentToolDescription ? { parentToolDescription: input.parentToolDescription } : {}),
    ...(input.stopPtcOnDeny ? { stopPtcOnDeny: true } : {}),
  };
}

/** A PTC child ask names its run_code program on the channel card. */
function channelToolDescription(record: LocalPermissionRequest): { toolDescription?: string } {
  if (record.parentToolDescription) {
    return { toolDescription: `PTC: ${record.parentToolDescription}` };
  }
  return record.toolDescription ? { toolDescription: record.toolDescription } : {};
}
