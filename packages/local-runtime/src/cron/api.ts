import {
  CronExecutor,
  CronRegistry,
  configureCronHost,
  type AgentSpawnerPort,
  type ChannelDeliveryPort,
  type CronAgentResponseHandler,
  type CronConfig,
  type CronConfigUpdate,
  type CronEventBusPort,
  type CronLoadResult,
  type CronSessionBridgePort,
  type CronSessionInfo,
  type CronSessionStatus,
  type CronHostUtils,
  type CronSchedulerPort,
  type CronSessionRecord,
  type CronStorePort,
  type CronTaskResponse,
  type CronTaskState,
  type AgentMessage as BridgeAgentMessage,
  type MessageQueuePort,
  type SessionLifecyclePort,
} from '@mavis/cron';
import {
  MsgType,
  RespDataType,
  Role as AgentMessageRole,
} from '@mavis/agent-core/protocol/agent-message';
import { Cron } from 'croner';

import type { LocalApiAgentRoutes } from '../api/routes/agents.js';
import { json, isValidLocalAgentName, notFound, readJsonBody } from '../api/host-helpers.js';
import { startCronRuntimeWithMigration } from './legacy-md-migration.js';
import { collectChannelResponseFromSse } from '../channels/runner.js';
import type { LocalMessageQueueStore, LocalQueuedMessage } from '../messages/queue.js';
import type { LocalSessionRecord, LocalSessionStatus } from '../sessions/controller.js';
import type { ModuleMetricsReporter } from '../runtime/observability-host-wiring.js';
import type { LocalRuntimeStartupExecutionPolicy } from '../runtime/startup-execution-policy.js';
import { buildCronHistoryMessage } from './history-message.js';

const CRON_NAME_RE = /^[^\s/\\:*?"<>|]+$/;
const ACTIVE_HOURS_RE = /^\d{2}:\d{2}$/;
/** Queued cron prompts expire after 30 minutes (daemon executor parity). */
const CRON_QUEUE_ITEM_TTL_MS = 30 * 60 * 1000;

export interface LocalCronRuntime {
  readonly registry: CronRegistry;
  readonly cronStore: CronStorePort;
  readonly cronConsumerEnabled: boolean;
  ensureConfigured(): void;
  ensureStarted(reason?: string): Promise<void>;
  deleteAgentTasks(agentName: string): Promise<void>;
  /**
   * Host hook for turn-terminal points (wherever `activePiTurns` entries are
   * removed). Translates the local turn status into the cron event bus
   * terminal events that drive the executor's BusyQueue drain.
   */
  notifyTurnFinished(sessionId: string, status: LocalSessionStatus): void;
  stop(): void;
}

export interface LocalCronRuntimeOptions {
  cronStore: CronStorePort;
  agentRoutes: LocalApiAgentRoutes;
  queueStore: LocalMessageQueueStore;
  activePiTurns: { has(sessionId: string): boolean };
  /** Starts a real headless turn for a queued message (409s when busy). */
  runQueuedTurn: (input: {
    session: LocalSessionRecord;
    queuedMessage: LocalQueuedMessage;
  }) => Promise<Response>;
  nowMs: () => number;
  /** Resolves the runtime data dir; used to locate legacy on-disk `.md` crons. */
  dataDir: () => string;
  primaryAgentName: string;
  resolveDefaultWorkspaceDir: () => string;
  getSessionById: (sessionId: string) => Promise<LocalSessionRecord | undefined>;
  listAllSessions: (
    agentName?: string,
    options?: { includePurposePrefix?: string; includeHidden?: boolean; limit?: number },
  ) => Promise<LocalSessionRecord[]>;
  updateSession: (
    sessionId: string,
    fields: Partial<Pick<LocalSessionRecord, 'archived' | 'title'>>,
  ) => Promise<LocalSessionRecord | undefined>;
  deleteSession: (sessionId: string) => Promise<void>;
  deleteMessageState: (sessionId: string) => Promise<void>;
  /** Local ChannelDeliveryPort (explicit delivery + IM auto-delivery). */
  channelDelivery?: ChannelDeliveryPort;
  emitBusEvent: (type: string, payload: Record<string, unknown>) => void;
  metricsReporter?: ModuleMetricsReporter;
  runtimeOwnerKind?: string;
  runtimeOwnerId?: string;
  runtimeMode?: string;
  capabilities?: { cliEmbedded?: boolean; electronHost?: boolean };
  cronConsumerEnabled?: boolean;
  startupExecutionPolicy?: LocalRuntimeStartupExecutionPolicy;
}

export function createLocalCronRuntime(options: LocalCronRuntimeOptions): LocalCronRuntime {
  const eventBus = new LocalCronEventBus((type, payload) => options.emitBusEvent(type, payload));
  // Handler registry behind the bridge's `onResponse` (daemon SessionBridge
  // parity); shared with the queued-cron drain so retried dispatches feed the
  // same channel-delivery listeners.
  const responseHandlers = new Set<CronAgentResponseHandler>();
  const fanOutTurnResponse = buildCronTurnFanOut(options, responseHandlers);
  const sessionBridge = buildLocalCronSessionBridge(options, responseHandlers, fanOutTurnResponse);
  const sessionLifecycle = buildLocalCronSessionLifecycle(options);
  const agentSpawner = buildLocalCronAgentSpawner(options);
  const messageQueue = new LocalCronMessageQueue();
  const cronHost: CronHostUtils = {
    cronStore: options.cronStore,
    sessionLifecycle,
    agentSpawner,
    messageQueue,
    ...(options.channelDelivery ? { channelDelivery: options.channelDelivery } : {}),
  };

  const ensureConfigured = () => {
    configureCronHost({
      datetimeHelpers: buildLocalCronDatetimeHelpers(options.nowMs),
      ...(options.metricsReporter ? { metricsReporter: options.metricsReporter } : {}),
    });
  };

  ensureConfigured();

  const executor = new CronExecutor(sessionBridge, eventBus, cronHost);
  const registry = new CronRegistry(executor, eventBus, {
    unrefTimers: true,
    scheduler: localCronScheduler,
    cronHost,
  });
  const cronConsumerEnabled = options.cronConsumerEnabled ?? true;
  let startPromise: Promise<void> | undefined;

  const ensureStarted = (reason = 'unspecified'): Promise<void> => {
    ensureConfigured();
    const alreadyRequested = Boolean(startPromise);
    options.emitBusEvent(
      'cron.runtime_start_requested',
      buildCronStartupDiagnostics(options, reason, alreadyRequested),
    );
    if (!cronConsumerEnabled) {
      options.emitBusEvent('cron.runtime_start_skipped', {
        ...buildCronStartupDiagnostics(options, reason, alreadyRequested),
        skipReason: 'consumer_disabled',
      });
      return Promise.resolve();
    }
    if (!startPromise) {
      options.emitBusEvent(
        'cron.runtime_starting',
        buildCronStartupDiagnostics(options, reason, false),
      );
      startPromise = startCronRuntimeWithMigration(options, localCronScheduler, registry)
        .then(() => {
          options.emitBusEvent('cron.runtime_started', {
            ...buildCronStartupDiagnostics(options, reason, false),
            taskCount: registry.listAllTasks().length,
          });
        })
        .catch((err: unknown) => {
          options.emitBusEvent('cron.runtime_start_failed', {
            ...buildCronStartupDiagnostics(options, reason, false),
            error: err instanceof Error ? err.message : String(err),
          });
          throw err;
        });
    }
    return startPromise;
  };

  return {
    registry,
    cronStore: options.cronStore,
    cronConsumerEnabled,
    ensureConfigured,
    ensureStarted,
    deleteAgentTasks: async (agentName) => {
      if (!cronConsumerEnabled) {
        const tasks = await options.cronStore.listByAgent(agentName);
        for (const task of tasks) await options.cronStore.delete(agentName, task.cronName);
        return;
      }
      await ensureStarted('delete_agent_tasks');
      for (const task of registry.listTasks(agentName)) {
        await registry.deleteTask(agentName, task.cronName, { mutationSource: 'system' });
      }
    },
    notifyTurnFinished: (sessionId, status) => {
      // The executor drains its BusyQueue on terminal events emitted with
      // source 'session-bridge' (executor.ts subscriptions): session.finish,
      // session.error and session.abort.
      const type =
        status === 'finished'
          ? 'session.finish'
          : status === 'error'
            ? 'session.error'
            : status === 'aborted' || status === 'interrupted'
              ? 'session.abort'
              : undefined;
      if (!type) return;
      eventBus.emitInternal(type, 'session-bridge', { sessionId });
      // Recover cron prompts stranded by the 409 dispatch race (see
      // drainQueuedCronPrompts) now that this session's turn ended.
      void drainQueuedCronPrompts(options, fanOutTurnResponse, sessionId).catch(() => {});
    },
    stop: () => registry.stop(),
  };
}

function buildCronStartupDiagnostics(
  options: LocalCronRuntimeOptions,
  reason: string,
  alreadyRequested: boolean,
): Record<string, unknown> {
  return {
    reason,
    alreadyRequested,
    runtimeOwnerKind: options.runtimeOwnerKind ?? null,
    runtimeOwnerId: options.runtimeOwnerId ?? null,
    runtimeMode: options.runtimeMode ?? null,
    cliEmbedded: options.capabilities?.cliEmbedded ?? null,
    electronHost: options.capabilities?.electronHost ?? null,
    dataDir: options.dataDir(),
    pid: process.pid,
    ppid: process.ppid,
    execPath: process.execPath,
    argv: sanitizeProcessArgv(process.argv),
    cwd: process.cwd(),
    platform: process.platform,
    nodeVersion: process.version,
  };
}

function sanitizeProcessArgv(argv: string[]): string[] {
  const secretName =
    /(?:token|secret|password|passwd|pwd|api[-_]?key|apikey|credential|authorization|auth)/i;
  const sanitized: string[] = [];
  let redactNext = false;
  for (const arg of argv.slice(0, 40)) {
    if (redactNext) {
      sanitized.push('[REDACTED]');
      redactNext = false;
      continue;
    }
    const equalsIndex = arg.indexOf('=');
    if (equalsIndex > 0) {
      const name = arg.slice(0, equalsIndex);
      const value = arg.slice(equalsIndex + 1);
      if (secretName.test(name) || secretName.test(value)) {
        sanitized.push(`${name}=[REDACTED]`);
        continue;
      }
    }
    if (secretName.test(arg)) {
      if (/^-{1,2}[^=:]+$/.test(arg)) {
        sanitized.push(arg);
        redactNext = true;
        continue;
      }
      sanitized.push('[REDACTED]');
      continue;
    }
    sanitized.push(arg);
  }
  if (argv.length > sanitized.length) sanitized.push(`...(${argv.length - sanitized.length} more)`);
  return sanitized;
}

const localCronScheduler: CronSchedulerPort = {
  createJob(config, options, onTick) {
    return new Cron(
      cronerPatternForConfig(config),
      {
        timezone: config.scheduleType === 'once' ? undefined : config.timezone,
        unref: options.unref,
      },
      onTick,
    );
  },
  assertSchedulable(config) {
    const job = new Cron(cronerPatternForConfig(config), {
      timezone: config.scheduleType === 'once' ? undefined : config.timezone,
      unref: true,
    });
    try {
      job.nextRun();
    } finally {
      job.stop();
    }
  },
};

function cronerPatternForConfig(config: CronConfig): string | Date {
  if (config.scheduleType !== 'once') return config.schedule;
  if (typeof config.runAtMs !== 'number') {
    throw new Error('runAtMs is required for once cron tasks');
  }
  return new Date(config.runAtMs);
}

function buildLocalCronDatetimeHelpers(nowMs: () => number) {
  return {
    nowMs,
    formatLocalMonthDayTime: (ts: number | Date) => formatLocalDateParts(ts).slice(5, 16),
    formatLocalDateTime: (ts: number | Date) => formatLocalDateParts(ts),
    formatLocalDate: (date: Date) => formatLocalDateParts(date).slice(0, 10),
    todayLocal: () => formatLocalDateParts(nowMs()).slice(0, 10),
  };
}

function formatLocalDateParts(ts: number | Date): string {
  const date = ts instanceof Date ? ts : new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export async function routeLocalCronApi(input: {
  runtime: LocalCronRuntime;
  listAllSessions: LocalCronRuntimeOptions['listAllSessions'];
  method: string;
  request: Request;
  parts: string[];
}): Promise<Response> {
  await input.runtime.ensureStarted('legacy_cron_route');
  const tail = input.parts.slice(1);
  if (input.method === 'GET' && tail.length === 0) {
    const taskStates = input.runtime.cronConsumerEnabled
      ? input.runtime.registry.listAllTasks()
      : await listStoredCronTasks(input.runtime.cronStore);
    const tasks = taskStates.map(toCronResponse);
    return json({ tasks, count: tasks.length });
  }
  if (input.method === 'GET' && tail.length === 1 && tail[0] === 'sessions') {
    const sessions = await input.listAllSessions(undefined, {
      includeHidden: true,
      includePurposePrefix: 'cron:',
      limit: readPositiveInt(new URL(input.request.url).searchParams.get('limit')) ?? 200,
    });
    return json({
      sessions: sessions.map((session) => ({
        id: session.sessionId,
        agentId: session.agentName,
        purpose: session.purpose,
        title: session.title ?? null,
        status: session.status,
        created_at: session.createdAtMs,
      })),
    });
  }
  return notFound(`/cron/${tail.join('/')}`);
}

export async function routeLocalAgentCronApi(input: {
  runtime: LocalCronRuntime;
  agentName: string;
  agentExists: (agentName: string) => Promise<boolean>;
  getSessionById: LocalCronRuntimeOptions['getSessionById'];
  nowMs: () => number;
  method: string;
  request: Request;
  parts: string[];
}): Promise<Response> {
  await input.runtime.ensureStarted('agent_cron_route');
  const tail = input.parts.slice(1);
  const agentError = await validateAgentForCron(input.agentName, input.agentExists);
  if (agentError) return agentError;

  if (input.method === 'GET' && tail.length === 0) {
    const taskStates = input.runtime.cronConsumerEnabled
      ? input.runtime.registry.listTasks(input.agentName)
      : await listStoredCronTasks(input.runtime.cronStore, input.agentName);
    const tasks = taskStates.map(toCronResponse);
    return json({ tasks, count: tasks.length });
  }

  const cronName = tail[0];
  if (!cronName) return notFound(`/agent/${input.agentName}/cron`);
  const cronNameError = validateCronName(cronName);
  if (cronNameError) return cronNameError;

  try {
    if (input.method === 'GET' && tail.length === 1) {
      const task = input.runtime.cronConsumerEnabled
        ? input.runtime.registry.getTask(input.agentName, cronName)
        : await getStoredCronTask(input.runtime.cronStore, input.agentName, cronName);
      if (!task) return cronNotFound(input.agentName, cronName);
      return json(toCronResponse(task));
    }
    if (input.method === 'POST' && tail.length === 1) {
      const parsed = await readCreateCronConfigResponse(input.request);
      if (parsed instanceof Response) return parsed;
      const config = parsed;
      const scheduleValidation = validateCronSchedule(config);
      if (scheduleValidation) return scheduleValidation;
      const state = input.runtime.cronConsumerEnabled
        ? await input.runtime.registry.createTask(input.agentName, cronName, config)
        : await createStoredCronTask(input.runtime.cronStore, input.agentName, cronName, config);
      return json(toCronResponse(state), { status: 201 });
    }
    if (input.method === 'PATCH' && tail.length === 1) {
      const parsed = await readCronConfigUpdateResponse(input.request);
      if (parsed instanceof Response) return parsed;
      const update = parsed;
      if (Object.keys(update).length === 0) {
        return json({ error: 'At least one field must be provided' }, { status: 400 });
      }
      const existing = input.runtime.cronConsumerEnabled
        ? input.runtime.registry.getTask(input.agentName, cronName)
        : await getStoredCronTask(input.runtime.cronStore, input.agentName, cronName);
      if (!existing) return cronNotFound(input.agentName, cronName);
      const scheduleValidation = validateCronSchedule(
        applyUpdateForValidation(existing.config, update),
      );
      if (scheduleValidation) return scheduleValidation;
      const updated = input.runtime.cronConsumerEnabled
        ? await input.runtime.registry.updateConfig(input.agentName, cronName, update)
        : await updateStoredCronTask(input.runtime.cronStore, input.agentName, cronName, update);
      if (!updated) return cronNotFound(input.agentName, cronName);
      return json(toCronResponse(updated));
    }
    if (input.method === 'DELETE' && tail.length === 1) {
      const deleted = input.runtime.cronConsumerEnabled
        ? await input.runtime.registry.deleteTask(input.agentName, cronName)
        : await deleteStoredCronTask(input.runtime.cronStore, input.agentName, cronName);
      if (!deleted) return cronNotFound(input.agentName, cronName);
      return json({ success: true });
    }
    if (input.method === 'POST' && tail.length === 2 && tail[1] === 'trigger') {
      if (!input.runtime.cronConsumerEnabled) {
        return json(
          { error: 'Cron consumer is disabled for this runtime', code: 'CRON_CONSUMER_DISABLED' },
          { status: 409 },
        );
      }
      const task = input.runtime.registry.getTask(input.agentName, cronName);
      if (!task) return cronNotFound(input.agentName, cronName);
      const result = await input.runtime.registry.triggerTask(input.agentName, cronName);
      const accepted = result.executed || result.reason === 'enqueued';
      return json({
        success: accepted,
        triggeredAt: String(input.nowMs()),
        ...(result.reason ? { reason: result.reason } : {}),
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      });
    }
    if (input.method === 'GET' && tail.length === 2 && tail[1] === 'history') {
      const task = input.runtime.cronConsumerEnabled
        ? input.runtime.registry.getTask(input.agentName, cronName)
        : await getStoredCronTask(input.runtime.cronStore, input.agentName, cronName);
      if (!task) return cronNotFound(input.agentName, cronName);
      const query = new URL(input.request.url).searchParams;
      const sessions = await input.runtime.registry.getSessionHistory(input.agentName, cronName);
      const page = pageCronSessionRecords(
        sessions.slice().reverse(),
        query.get('cursor') ?? undefined,
        readPositiveInt(query.get('limit')),
      );
      return json({
        sessions: page.items,
        total: sessions.length,
        hasMore: page.hasMore,
      });
    }
    if (input.method === 'GET' && tail.length === 2 && tail[1] === 'sessions') {
      const task = input.runtime.cronConsumerEnabled
        ? input.runtime.registry.getTask(input.agentName, cronName)
        : await getStoredCronTask(input.runtime.cronStore, input.agentName, cronName);
      if (!task) return cronNotFound(input.agentName, cronName);
      const query = new URL(input.request.url).searchParams;
      const history = await input.runtime.registry.getSessionHistory(input.agentName, cronName);
      const page = pageCronSessionRecords(
        history.slice().reverse(),
        query.get('cursor') ?? undefined,
        readPositiveInt(query.get('limit')),
      );
      const enriched = await Promise.all(
        page.items.map(async (record) => {
          const session = await input.getSessionById(record.sessionId).catch(() => undefined);
          return {
            sessionId: record.sessionId,
            createdAt: record.createdAt,
            ...(session?.title ? { title: session.title } : {}),
            ...(session ? { status: toCronSessionStatus(session.status) } : {}),
          };
        }),
      );
      return json({
        sessions: enriched,
        total: history.length,
        hasMore: page.hasMore,
      });
    }
  } catch (err) {
    return cronErrorResponse(err);
  }

  return notFound(`/agent/${input.agentName}/cron/${tail.join('/')}`);
}

/** Fan a drained turn SSE out to the bridge's onResponse handlers. */
type CronTurnFanOut = (sessionId: string, raw: string) => void;

function buildCronTurnFanOut(
  options: LocalCronRuntimeOptions,
  responseHandlers: Set<CronAgentResponseHandler>,
): CronTurnFanOut {
  return (sessionId, raw) => {
    if (responseHandlers.size === 0) return;
    const collected = collectChannelResponseFromSse(raw);
    const message: BridgeAgentMessage = {
      rawData: '',
      end: true,
      source: 'cron',
      ...(collected.text
        ? {
            respData: {
              type: RespDataType.AgentMessage,
              agent_message: {
                msg_id: `cron-turn:${sessionId}:${options.nowMs()}`,
                role: AgentMessageRole.Assistant,
                msg_type: MsgType.AgentContent,
                msg_content: collected.text,
                timestamp: options.nowMs(),
              },
            },
          }
        : {}),
    };
    for (const handler of [...responseHandlers]) handler(sessionId, message);
  };
}

/**
 * Dispatch still-queued cron prompts once the session is idle again.
 *
 * Covers the dispatch race the bridge cannot retry by itself: the executor's
 * busy check saw the session idle (so nothing was parked in its BusyQueue),
 * but a user/API turn won the `openLocalMessageStream` gate and the bridge's
 * `runQueuedTurn` came back 409, leaving the enqueued cron item stranded
 * (cron items are excluded from mid-turn injection). Invoked from
 * `notifyTurnFinished` on every turn-terminal event — daemon parity with
 * `SessionInboundQueue`'s idle drain. Dispatches at most one turn per call;
 * that turn's own terminal event drains any remaining items.
 */
export async function drainQueuedCronPrompts(
  options: LocalCronRuntimeOptions,
  fanOut: CronTurnFanOut,
  sessionId: string,
): Promise<void> {
  if (options.activePiTurns.has(sessionId)) return;
  const queued = (await options.queueStore.list(sessionId)).filter(
    (item) => item.status === 'queued' && item.source === 'cron',
  );
  if (queued.length === 0) return;
  const session = await options.getSessionById(sessionId);
  if (!session) return;
  for (const item of queued) {
    if (options.activePiTurns.has(sessionId)) return;
    const response = await options.runQueuedTurn({ session, queuedMessage: item });
    // 409: lost the idle race again — the next terminal event retries.
    if (response.status === 409) return;
    // Other failures stay queued; the 30min expiry bounds the backlog.
    if (response.status >= 400) continue;
    void response
      .text()
      .then((raw) => fanOut(sessionId, raw))
      .catch(() => {});
    return;
  }
}

function buildLocalCronSessionBridge(
  options: LocalCronRuntimeOptions,
  responseHandlers: Set<CronAgentResponseHandler>,
  fanOutTurnResponse: CronTurnFanOut,
): CronSessionBridgePort {
  return {
    sendMessage: async (_ctx, agentName, sessionId, msg) => {
      const session = await options.getSessionById(sessionId);
      if (!session) throw new Error(`Session not found: ${sessionId}`);
      if (session.agentName !== agentName) {
        throw new Error(`Session ${sessionId} does not belong to agent ${agentName}`);
      }
      const cronName = readInboundCronName(msg.inboundContext);
      const historyMessage = buildCronHistoryMessage(msg);
      const queued = await options.queueStore.enqueue(
        session,
        {
          content: historyMessage.content,
          ...(historyMessage.source ? { source: historyMessage.source } : {}),
          ...(historyMessage.origin !== undefined ? { origin: historyMessage.origin } : {}),
        },
        {
          source: 'cron',
          // Latest-wins per cron: a repeat tick replaces the still-queued
          // prompt from the previous tick (daemon executor parity:
          // dedupeKey `cron:<cronName>`, expiry 30min).
          ...(cronName ? { dedupeKey: `${msg.source ?? 'cron'}:${cronName}` } : {}),
          expiresAt: options.nowMs() + CRON_QUEUE_ITEM_TTL_MS,
        },
      );
      if (!queued) throw new Error(`Failed to enqueue cron prompt for session ${sessionId}`);
      if (options.activePiTurns.has(sessionId)) return;
      const response = await options.runQueuedTurn({ session, queuedMessage: queued });
      if (response.status === 409) {
        // Lost the idle-check race — a turn started in between. Leave the
        // item queued; the executor BusyQueue retries on the next terminal
        // event and dedupe/expiry bound any backlog.
        return;
      }
      if (response.status >= 400) {
        const detail = await response.text().catch(() => '');
        throw new Error(
          `Cron dispatch failed for session ${sessionId}: HTTP ${response.status}${detail ? ` ${detail}` : ''}`,
        );
      }
      // Drain the SSE response in the background so the stream never hangs.
      // Queue item lifecycle (running → completed/failed) is owned by
      // openLocalMessageStream's queueItemId startDrain/finishDrain. The
      // collected assistant text is fanned out to onResponse handlers
      // registered by the executor for explicit or automatic channel delivery.
      void response
        .text()
        .then((raw) => fanOutTurnResponse(sessionId, raw))
        .catch(() => {
          // Turn failures are already reflected on the queue item by
          // finishDrain; nothing else to do here.
        });
    },
    onResponse: (handler) => {
      responseHandlers.add(handler);
      return () => responseHandlers.delete(handler);
    },
    hasActiveTurn: (sessionId) => options.activePiTurns.has(sessionId),
    getActiveSource: () => undefined,
  };
}

function readInboundCronName(inboundContext: unknown): string | undefined {
  if (!inboundContext || typeof inboundContext !== 'object') return undefined;
  const value = (inboundContext as { cronName?: unknown }).cronName;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function buildLocalCronSessionLifecycle(options: LocalCronRuntimeOptions): SessionLifecyclePort {
  return {
    getRootSession: async (agentName) => {
      const sessions = await options.listAllSessions(agentName, { includeHidden: true });
      return sessions
        .filter((session) => session.sessionType === 'root')
        .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
        .map(toCronSessionInfo)[0];
    },
    getSession: async (sessionId) => {
      const session = await options.getSessionById(sessionId);
      return session ? toCronSessionInfo(session) : undefined;
    },
    getSessionStatus: async (_ctx, sessionId) => {
      // Busy truth lives in activePiTurns (the in-process turn tracker).
      // The stored record may keep status 'started' while no turn is active
      // (stale rows are normalized lazily, other-process locks linger), so
      // stored 'started' without an active turn must not report busy.
      if (options.activePiTurns.has(sessionId)) return { type: 'started' };
      const session = await options.getSessionById(sessionId);
      if (!session) return { type: 'error', message: 'not found' };
      const status = toCronSessionStatus(session.status);
      return status.type === 'started' ? { type: 'finished' } : status;
    },
    setSessionArchived: async (sessionId, archived) => {
      const session = await options.getSessionById(sessionId);
      if (!session) return;
      await options.updateSession(sessionId, { archived });
    },
    deleteSession: async (sessionId) => {
      await options.deleteSession(sessionId);
      await options.deleteMessageState(sessionId);
    },
    listByPurposePrefix: async (purposePrefix) => {
      const sessions = await options.listAllSessions(undefined, {
        includeHidden: true,
        includePurposePrefix: purposePrefix,
      });
      return sessions.map(toCronSessionInfo);
    },
    seedGeneratedTitle: async (sessionId, title, seedOptions) => {
      const session = await options.getSessionById(sessionId);
      if (!session) return;
      if (seedOptions?.onlyIfEmpty && session.title && session.title.trim()) return;
      await options.updateSession(sessionId, { title });
    },
  };
}

function buildLocalCronAgentSpawner(options: LocalCronRuntimeOptions): AgentSpawnerPort {
  return {
    newSession: async (
      _ctx,
      agentName,
      workspaceDir,
      parentSessionId,
      title,
      _taskTreeId,
      _teamModeOff,
      createOptions,
    ) => {
      const parent = parentSessionId ? await options.getSessionById(parentSessionId) : undefined;
      const localAgent = await options.agentRoutes.getLocalAgent(agentName);
      if (!localAgent && agentName !== options.primaryAgentName) {
        throw new Error(`Agent not found: ${agentName}`);
      }
      const session = await options.agentRoutes.createSession({
        agentName,
        workspaceDir:
          workspaceDir ??
          parent?.workspaceDir ??
          localAgent?.defaultWorkspaceDir ??
          options.resolveDefaultWorkspaceDir(),
        sessionType: 'branch',
        sessionKind: 'cron',
        parentSessionId: parentSessionId ?? null,
        title: title ?? null,
        visibility: createOptions?.visibility,
        purpose: createOptions?.purpose,
        isDefaultWorkspace: workspaceDir !== undefined ? false : parent?.isDefaultWorkspace,
      });
      return { sessionId: session.sessionId };
    },
  };
}

class LocalCronMessageQueue implements MessageQueuePort {
  private readonly buckets = new Map<string, Promise<unknown>>();

  async enqueue<T>(
    _lane: string,
    bucketKey: string,
    task: () => Promise<T>,
    _opts?: { timeoutMs?: number },
  ): Promise<T> {
    const previous = this.buckets.get(bucketKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(task);
    this.buckets.set(bucketKey, next);
    try {
      return await next;
    } finally {
      if (this.buckets.get(bucketKey) === next) this.buckets.delete(bucketKey);
    }
  }
}

class LocalCronEventBus implements CronEventBusPort {
  private readonly listeners = new Map<
    string,
    Set<(event: { type: string; source?: string; payload?: unknown }) => void>
  >();

  constructor(
    private readonly emitRuntimeEvent: (type: string, payload: Record<string, unknown>) => void,
  ) {}

  emit(type: string, source: string, payload?: Record<string, unknown>): void {
    this.emitRuntimeEvent(type, payload ?? {});
    this.emitInternal(type, source, payload);
  }

  emitInternal(type: string, source: string, payload?: Record<string, unknown>): void {
    for (const handler of this.listeners.get(type) ?? []) {
      handler({ type, source, payload });
    }
  }

  on(
    type: string,
    handler: (event: { type: string; source?: string; payload?: unknown }) => void,
  ): () => void {
    const handlers = this.listeners.get(type) ?? new Set();
    handlers.add(handler);
    this.listeners.set(type, handlers);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) this.listeners.delete(type);
    };
  }
}

function toCronSessionInfo(session: LocalSessionRecord): CronSessionInfo {
  return {
    sessionId: session.sessionId,
    agentName: session.agentName,
    sessionType: session.sessionType === 'root' ? 1 : 0,
    // Local runtime has no compaction concept: `archived` is user-facing
    // archive state, not compaction, so archived sessions must not be
    // dropped from cron history as compacted-out.
    compressed: false,
    status: { type: session.status },
    purpose: session.purpose,
  };
}

function toCronSessionStatus(status: LocalSessionStatus): CronSessionStatus {
  if (status === 'started') return { type: 'started' };
  if (status === 'error') return { type: 'error' };
  if (status === 'aborted') return { type: 'aborted' };
  if (status === 'interrupted') return { type: 'interrupted' };
  return { type: 'finished' };
}

function toCronResponse(state: CronTaskState): CronTaskResponse {
  return {
    cronName: state.cronName,
    agentName: state.agentName,
    ...(state.cronId ? { cronId: state.cronId } : {}),
    schedule: state.config.schedule,
    ...(state.config.scheduleType !== 'cron' ? { scheduleType: state.config.scheduleType } : {}),
    ...(state.config.runAtMs !== undefined ? { runAtMs: state.config.runAtMs } : {}),
    ...(state.config.deleteAfterRun !== undefined
      ? { deleteAfterRun: state.config.deleteAfterRun }
      : {}),
    timezone: state.config.timezone,
    enabled: state.enabled,
    prompt: state.config.prompt,
    session: state.config.session,
    delivery: state.config.delivery,
    reportToRoot: false,
    reportToMain: false,
    activeHours: state.config.activeHours,
    status: state.status,
    lastRun: state.lastRun,
    lastResult: state.lastResult,
    lastError: state.lastError,
    nextRun: state.nextRun,
  };
}

export async function listStoredCronTasks(
  store: CronStorePort,
  agentName?: string,
): Promise<CronTaskState[]> {
  const entries = agentName ? await store.listByAgent(agentName) : await store.listAll();
  return entries.map(cronLoadResultToState);
}

export async function getStoredCronTask(
  store: CronStorePort,
  agentName: string,
  cronName: string,
): Promise<CronTaskState | undefined> {
  const entries = await store.listByAgent(agentName);
  const entry = entries.find((candidate) => candidate.cronName === cronName);
  return entry ? cronLoadResultToState(entry) : undefined;
}

export async function createStoredCronTask(
  store: CronStorePort,
  agentName: string,
  cronName: string,
  config: CronConfig,
): Promise<CronTaskState> {
  localCronScheduler.assertSchedulable(config);
  await store.create(agentName, cronName, config);
  return (
    (await getStoredCronTask(store, agentName, cronName)) ??
    cronLoadResultToState({
      agentName,
      cronName,
      config,
      configPath: await store.configPath(agentName, cronName),
    })
  );
}

export async function updateStoredCronTask(
  store: CronStorePort,
  agentName: string,
  cronName: string,
  update: CronConfigUpdate,
): Promise<CronTaskState | undefined> {
  const existing = await getStoredCronTask(store, agentName, cronName);
  if (!existing) return undefined;
  localCronScheduler.assertSchedulable(applyUpdateForValidation(existing.config, update));
  await store.update(agentName, cronName, update);
  return getStoredCronTask(store, agentName, cronName);
}

export async function deleteStoredCronTask(
  store: CronStorePort,
  agentName: string,
  cronName: string,
): Promise<boolean> {
  const existing = await store.get(agentName, cronName);
  if (!existing) return false;
  await store.delete(agentName, cronName);
  return true;
}

function cronLoadResultToState(entry: CronLoadResult): CronTaskState {
  return {
    agentName: entry.agentName,
    cronName: entry.cronName,
    config: entry.config,
    ...(entry.cronId ? { cronId: entry.cronId } : {}),
    enabled: !entry.config.disabled,
    lastRun: null,
    lastResult: null,
    lastError: null,
    nextRun: null,
    status: 'idle',
  };
}

async function validateAgentForCron(
  agentName: string,
  agentExists: (agentName: string) => Promise<boolean>,
): Promise<Response | undefined> {
  if (!isValidLocalAgentName(agentName)) {
    return json({ error: `Invalid agent name: "${agentName}"` }, { status: 400 });
  }
  if (!(await agentExists(agentName))) {
    return json({ error: 'Agent not found', code: 'AGENT_NOT_FOUND' }, { status: 404 });
  }
  return undefined;
}

function validateCronName(cronName: string): Response | undefined {
  if (!cronName || cronName.length > 64 || !CRON_NAME_RE.test(cronName)) {
    return json({ error: `Invalid cron name: "${cronName}"` }, { status: 400 });
  }
  return undefined;
}

function cronNotFound(agentName: string, cronName: string): Response {
  return json(
    { error: `Cron task not found: ${agentName}/${cronName}`, code: 'CRON_TASK_NOT_FOUND' },
    { status: 404 },
  );
}

async function readCreateCronConfigResponse(request: Request): Promise<CronConfig | Response> {
  try {
    return readCreateCronConfig(await readJsonBody(request));
  } catch (err) {
    return validationErrorResponse(err);
  }
}

async function readCronConfigUpdateResponse(
  request: Request,
): Promise<CronConfigUpdate | Response> {
  try {
    return readCronConfigUpdate(await readJsonBody(request));
  } catch (err) {
    return validationErrorResponse(err);
  }
}

function validationErrorResponse(err: unknown): Response {
  // Prefer a short, single-line message from our own validation Errors; never
  // forward multi-line / stack-shaped text to the client.
  const raw = err instanceof Error ? err.message : '';
  const message =
    raw && !raw.includes('\n') && !raw.includes('\r') && raw.length <= 300
      ? raw
      : 'Invalid request';
  return json(
    {
      error: message,
      code: 'VALIDATION_ERROR',
    },
    { status: 400 },
  );
}

function readCreateCronConfig(body: Record<string, unknown>): CronConfig {
  const enabled = typeof body.enabled === 'boolean' ? body.enabled : undefined;
  return cleanConfig({
    schedule: readRequiredString(body, 'schedule'),
    scheduleType: 'cron',
    prompt: readRequiredString(body, 'prompt'),
    timezone: readOptionalString(body.timezone),
    activeHours: readActiveHours(body.activeHours ?? body.active_hours),
    session: readSessionConfig(body.session) ?? { mode: 'new' },
    delivery: readDelivery(body.delivery),
    disabled: enabled === undefined ? false : !enabled,
    report_to_root: readOptionalBoolean(body.report_to_root),
    report_to_main: readOptionalBoolean(body.report_to_main),
  });
}

function readCronConfigUpdate(body: Record<string, unknown>): CronConfigUpdate {
  return cleanConfig({
    ...(typeof body.enabled === 'boolean' ? { disabled: !body.enabled } : {}),
    ...(body.schedule !== undefined ? { schedule: readRequiredString(body, 'schedule') } : {}),
    ...(body.prompt !== undefined ? { prompt: readRequiredString(body, 'prompt') } : {}),
    ...(body.timezone !== undefined ? { timezone: readNullableString(body.timezone) } : {}),
    ...(body.activeHours !== undefined || body.active_hours !== undefined
      ? { activeHours: readNullableActiveHours(body.activeHours ?? body.active_hours) }
      : {}),
    ...(body.session !== undefined ? { session: readRequiredSessionConfig(body.session) } : {}),
    ...(body.delivery !== undefined ? { delivery: readNullableDelivery(body.delivery) } : {}),
    ...(body.report_to_root !== undefined
      ? { report_to_root: readNullableBoolean(body.report_to_root) }
      : {}),
    ...(body.report_to_main !== undefined
      ? { report_to_main: readNullableBoolean(body.report_to_main) }
      : {}),
  });
}

function applyUpdateForValidation(config: CronConfig, update: CronConfigUpdate): CronConfig {
  return {
    ...config,
    ...(update.disabled !== undefined ? { disabled: update.disabled } : {}),
    ...(update.schedule !== undefined ? { schedule: update.schedule } : {}),
    ...(update.prompt !== undefined ? { prompt: update.prompt } : {}),
    ...(update.session !== undefined ? { session: update.session } : {}),
    ...(update.timezone !== undefined
      ? update.timezone === null
        ? { timezone: undefined }
        : { timezone: update.timezone }
      : {}),
    ...(update.activeHours !== undefined
      ? update.activeHours === null
        ? { activeHours: undefined }
        : { activeHours: update.activeHours }
      : {}),
    ...(update.delivery !== undefined
      ? update.delivery === null
        ? { delivery: undefined }
        : { delivery: update.delivery }
      : {}),
    ...(update.report_to_root !== undefined
      ? update.report_to_root === null
        ? { report_to_root: undefined }
        : { report_to_root: update.report_to_root }
      : {}),
    ...(update.report_to_main !== undefined
      ? update.report_to_main === null
        ? { report_to_main: undefined }
        : { report_to_main: update.report_to_main }
      : {}),
  };
}

function validateCronSchedule(config: CronConfig): Response | undefined {
  try {
    const job = new Cron(config.schedule, {
      timezone: config.timezone,
      unref: true,
    });
    job.nextRun();
    job.stop();
  } catch (err) {
    return validationErrorResponse(err);
  }
  return undefined;
}

function cronErrorResponse(err: unknown): Response {
  const candidate = err as { statusCode?: unknown; code?: unknown; message?: unknown };
  const status = typeof candidate.statusCode === 'number' ? candidate.statusCode : 500;
  const rawMessage = typeof candidate.message === 'string' ? candidate.message : '';
  const code = typeof candidate.code === 'string' ? candidate.code : undefined;
  // Duplicate / not-found detection still keys off the server-side message.
  const message = rawMessage;
  // Duplicate detection is independent of the incoming statusCode — see
  // the same-shaped fix in `contract.ts:toCronContractError`. The
  // `agent-modules/cron` `AppError` throws with `statusCode = 409` and
  // `code = 'CRON_TASK_EXISTS'`; older paths throw a plain `Error` at
  // 500. Both must resolve to `errorCode = 40903` for the UI resolver.
  const isDuplicate =
    code === 'CRON_TASK_EXISTS' || /already exists|already registered/i.test(message);
  const isNotFound = /not found/i.test(message);
  const derivedStatus = isDuplicate ? 409 : status === 500 && isNotFound ? 404 : status;
  // Attach a numeric `errorCode` so the UI's `resolveSessionErrorCodeText`
  // can map to a localized string (e.g. `errors.codes.40903 = Cron task already exists`)
  // instead of showing the raw daemon English text like
  // `Cron task already registered: mavis/end-of-workday`. Keeps the same convention as
  // `packages/local-runtime/src/api/routes/agents.ts` (40901 conflict etc.).
  const errorCode = isDuplicate ? 40903 : undefined;
  const publicMessage =
    derivedStatus >= 500
      ? 'Internal error'
      : message && !message.includes('\n') && !message.includes('\r') && message.length <= 300
        ? message
        : 'Request failed';
  return json(
    {
      error: publicMessage,
      ...(code ? { code } : {}),
      ...(errorCode !== undefined ? { errorCode } : {}),
    },
    { status: derivedStatus },
  );
}

function readRequiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNullableString(value: unknown): string | null {
  if (value === null) return null;
  const parsed = readOptionalString(value);
  if (!parsed) throw new Error('Expected string or null');
  return parsed;
}

function readOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readNullableBoolean(value: unknown): boolean | null {
  if (value === null) return null;
  if (typeof value !== 'boolean') throw new Error('Expected boolean or null');
  return value;
}

function readActiveHours(value: unknown): CronConfig['activeHours'] {
  if (!value) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected activeHours object');
  }
  const record = value as Record<string, unknown>;
  const start = readOptionalString(record.start);
  const end = readOptionalString(record.end);
  if (!start || !end) throw new Error('activeHours.start and activeHours.end are required');
  if (!ACTIVE_HOURS_RE.test(start) || !ACTIVE_HOURS_RE.test(end)) {
    throw new Error('activeHours must use HH:MM format');
  }
  return { start, end };
}

function readNullableActiveHours(
  value: unknown,
): NonNullable<CronConfigUpdate['activeHours']> | null {
  if (value === null) return null;
  const parsed = readActiveHours(value);
  if (!parsed) throw new Error('Expected activeHours object or null');
  return parsed;
}

function readDelivery(value: unknown): CronConfig['delivery'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const channel = readOptionalString(record.channel);
  const chatId = readOptionalString(record.chatId);
  return channel && chatId ? { channel, chatId } : undefined;
}

function readNullableDelivery(value: unknown): CronConfigUpdate['delivery'] {
  if (value === null) return null;
  const parsed = readDelivery(value);
  if (!parsed) throw new Error('Expected delivery object or null');
  return parsed;
}

function readSessionConfig(value: unknown): CronConfig['session'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return readRequiredSessionConfig(value);
}

function readRequiredSessionConfig(value: unknown): CronConfig['session'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected session config object');
  }
  const record = value as Record<string, unknown>;
  const mode = record.mode;
  if (mode === 'root') return { mode: 'root' };
  if (mode === 'sessionId') {
    const sessionId = readOptionalString(record.sessionId);
    if (!sessionId) throw new Error('session.sessionId is required');
    return { mode: 'sessionId', sessionId };
  }
  if (mode === 'new') {
    const keep = record.keepSessions;
    if (keep === undefined) return { mode: 'new' };
    if (keep === null) return { mode: 'new', keepSessions: null };
    if (typeof keep === 'number' && Number.isInteger(keep) && keep >= 1) {
      return { mode: 'new', keepSessions: keep };
    }
  }
  throw new Error('Invalid session config');
}

function cleanConfig<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, next]) => next !== undefined)) as T;
}

function readPositiveInt(raw: string | null): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

function pageCronSessionRecords(
  records: CronSessionRecord[],
  cursor: string | undefined,
  limit: number | undefined,
): { items: CronSessionRecord[]; hasMore: boolean } {
  const start =
    cursor === undefined
      ? 0
      : Math.max(0, records.findIndex((record) => record.sessionId === cursor) + 1);
  const remaining = records.slice(start);
  if (limit === undefined || limit <= 0) return { items: remaining, hasMore: false };
  const items = remaining.slice(0, limit);
  const hasMore = remaining.length > limit;
  return {
    items,
    hasMore,
  };
}
