import type { CronEventBusPort } from './host-ports.js';
import {
  logger,
  backgroundCtx,
  getMetricsReporter,
  AppError,
  getCronStore,
  type CronHostUtils,
} from './host-utils.js';
import type { CronExecutor, ExecuteResult } from './executor.js';
import type { CronConfig, CronTaskState, CronConfigUpdate, SessionConfig } from './types.js';

/** Bounded origin of a cron config mutation. Keep this low-cardinality. */
export type CronMutationSource = 'ui' | 'agent_tool' | 'http_api' | 'system';

/** Bounded origin of a cron trigger attempt. */
export type CronTriggerSource = 'schedule' | 'ui' | 'agent_tool' | 'http_api' | 'system';

/** Semantic delivery target. Never put the concrete session id into metrics labels. */
export type CronDeliveryTarget = 'new' | 'root' | 'me' | 'session_id';

export interface CronMutationMetricsContext {
  mutationSource?: CronMutationSource;
  deliveryTarget?: CronDeliveryTarget;
}

export interface CronTriggerMetricsContext {
  triggerSource?: CronTriggerSource;
  deliveryTarget?: CronDeliveryTarget;
}

export interface CronRegistryOptions {
  /**
   * Unreference Croner timers so short-lived embedded hosts can finish after
   * serving a one-shot request. Long-lived daemon hosts keep the default false.
   */
  unrefTimers?: boolean;
  scheduler: CronSchedulerPort;
  cronHost?: CronHostUtils;
}

export interface CronRegistryStartOptions {
  /**
   * Whether tasks restored from disk may execute immediately. A quarantined
   * clone still registers tasks for inspection and later user mutations.
   */
  restoredTaskExecution?: 'enabled' | 'quarantined';
}

export interface CronJobPort {
  nextRun(): Date | null;
  stop(): void;
}

export interface CronSchedulerPort {
  createJob(
    config: CronConfig,
    options: { unref?: boolean | undefined },
    onTick: () => void,
  ): CronJobPort;
  assertSchedulable(config: CronConfig): void;
}

export class CronRegistry {
  private readonly tasks: Map<string, { state: CronTaskState; job: CronJobPort }> = new Map();

  private globalEnabled = true;

  private eventBus: CronEventBusPort | null = null;

  constructor(
    executor: CronExecutor,
    eventBus: CronEventBusPort | undefined,
    options: CronRegistryOptions,
  );
  constructor(
    private readonly executor: CronExecutor,
    eventBus?: CronEventBusPort,
    private readonly options: Partial<CronRegistryOptions> = {},
  ) {
    this.eventBus = eventBus ?? null;
  }

  private get scheduler(): CronSchedulerPort {
    const scheduler = this.options.scheduler;
    if (!scheduler) {
      throw new AppError(
        '[@mavis/cron] CronRegistry requires a host-provided CronSchedulerPort. ' +
          'Runtime hosts must inject a scheduler instead of relying on agent-core timers.',
        'CRON_SCHEDULER_MISSING',
        500,
      );
    }
    return scheduler;
  }

  private get cronStore() {
    return this.options.cronHost?.cronStore ?? getCronStore();
  }

  /** Scan disk, register all cron jobs. Called once at startup. */
  async start(startOptions: CronRegistryStartOptions = {}): Promise<void> {
    this.assertSchedulerConfigured();
    const cronStore = this.cronStore;
    const configs = await cronStore.listAll();

    for (const { agentName, cronName, config, cronId } of configs) {
      const key = this.taskKey(agentName, cronName);
      const state: CronTaskState = {
        agentName,
        cronName,
        config,
        ...(cronId ? { cronId } : {}),
        enabled: startOptions.restoredTaskExecution !== 'quarantined' && !config.disabled,
        lastRun: null,
        lastResult: null,
        lastError: null,
        nextRun: null,
        status: 'idle',
      };

      try {
        const job = this.createJob(config, state);

        state.nextRun = job.nextRun()?.getTime() ?? null;
        this.tasks.set(key, { state, job });

        logger.info(
          { agentName, cronName, schedule: config.schedule, nextRun: state.nextRun },
          '[cron] Task registered',
        );
      } catch (err) {
        logger.error(
          { agentName, cronName, schedule: config.schedule, err: (err as Error).message },
          '[cron] Failed to register task — invalid schedule?',
        );
      }
    }

    logger.info(backgroundCtx(), `[cron] Registry started, count=${this.tasks.size}`);
    getMetricsReporter().incr('cron_engine_started_total');

    // Fire-and-forget: at startup, sweep every cron's persisted session
    // history to apply retention policy that was previously dependent on
    // an in-memory map and therefore lost across daemon restarts.
    const sweepCtx = backgroundCtx();
    logger.info(sweepCtx, '[cron] Startup session retention sweep — begin');
    void this.executor
      .cleanupAllCronSessions()
      .then(() => {
        logger.info(sweepCtx, '[cron] Startup session retention sweep — done');
      })
      .catch((err: unknown) => {
        logger.warn(
          sweepCtx,
          `[cron] Startup session retention sweep failed (non-fatal), err=${(err as Error).message}`,
        );
      });

    // Fire-and-forget: delete sessions whose purpose matches a cron task
    // that no longer exists (orphans from older deletion logic that didn't
    // sweep the session store by purpose).
    //
    // Build aliveKeys from `configs` (config files present on disk) rather
    // than `this.tasks` (jobs that successfully constructed). A cron whose
    // schedule/timezone temporarily fails Croner validation must NOT have its
    // session history wiped — the config file is still present, the user
    // hasn't deleted the task, only registration failed.
    const aliveKeys = new Set(
      configs.map(({ agentName, cronName }) => this.taskKey(agentName, cronName)),
    );
    void this.executor
      .cleanupOrphanCronSessions(aliveKeys)
      .then(() => {
        logger.debug(backgroundCtx(), '[cron] Orphan cron session cleanup — done');
      })
      .catch((err: unknown) => {
        logger.warn(
          backgroundCtx(),
          `[cron] Orphan cron session cleanup failed (non-fatal), err=${(err as Error).message}`,
        );
      });
  }

  /** Stop all cron jobs. */
  stop(): void {
    for (const [key, { job }] of this.tasks) {
      job.stop();
      logger.debug(backgroundCtx(), `[cron] Job stopped, key=${key}`);
    }
    this.tasks.clear();
    logger.info(backgroundCtx(), '[cron] Registry stopped');
  }

  /** List all tasks for a given agent. */
  listTasks(agentName: string): CronTaskState[] {
    const result: CronTaskState[] = [];
    for (const { state, job } of this.tasks.values()) {
      if (state.agentName === agentName) {
        state.nextRun = job.nextRun()?.getTime() ?? null;
        result.push(state);
      }
    }
    return result;
  }

  /** Get a specific task by agent name and cron name. */
  getTask(agentName: string, cronName: string): CronTaskState | undefined {
    const entry = this.tasks.get(this.taskKey(agentName, cronName));
    if (entry) {
      entry.state.nextRun = entry.job.nextRun()?.getTime() ?? null;
    }
    return entry?.state;
  }

  /** Trigger a task immediately (manual trigger via API). */
  async triggerTask(
    agentName: string,
    cronName: string,
    context: CronTriggerMetricsContext = {},
  ): Promise<ExecuteResult> {
    const entry = this.tasks.get(this.taskKey(agentName, cronName));
    if (!entry) {
      throw new AppError(
        `Cron task '${cronName}' not found for agent '${agentName}'`,
        'CRON_TASK_NOT_FOUND',
        404,
      );
    }
    const result = await this.executeAndRecordTrigger(entry.state, {
      triggerSource: context.triggerSource ?? 'http_api',
      deliveryTarget: context.deliveryTarget,
      force: true,
    });
    if (entry.state.config.scheduleType === 'once') {
      await this.completeOnceAfterExecution(agentName, cronName, result);
    }
    return result;
  }

  /**
   * Update cron task configuration — persists to config.yaml and updates in-memory state.
   * If schedule or timezone changed, recreates the Cron job (new job created before old one stopped).
   */
  async updateConfig(
    agentName: string,
    cronName: string,
    update: CronConfigUpdate,
    context: CronMutationMetricsContext = {},
  ): Promise<CronTaskState | undefined> {
    const cronStore = this.cronStore;
    const key = this.taskKey(agentName, cronName);
    const entry = this.tasks.get(key);
    if (!entry) return undefined;

    const oldConfig = entry.state.config;
    const needsRecreate = update.schedule !== undefined || update.timezone !== undefined;
    if (needsRecreate) {
      this.assertCronConfigSchedulable(applyCronScheduleUpdate(oldConfig, update));
    }

    const newConfig = await cronStore.update(agentName, cronName, update);

    if (needsRecreate) {
      // Create new job first — if this throws (invalid schedule), old job remains running
      const newJob = this.createJob(newConfig, entry.state);

      // Success — stop old job and replace
      entry.job.stop();
      entry.job = newJob;
      entry.state.nextRun = newJob.nextRun()?.getTime() ?? null;
    }

    // Update in-memory state
    entry.state.config = newConfig;
    entry.state.enabled = !newConfig.disabled;

    this.eventBus?.emit('cron.updated', 'cron-registry', { agentName, cronName });
    getMetricsReporter().incr(
      'cron_task_updated_total',
      cronMutationMetricLabels(entry.state, context),
    );

    return entry.state;
  }

  async createTask(
    agentName: string,
    cronName: string,
    config: CronConfig,
    context: CronMutationMetricsContext = {},
  ): Promise<CronTaskState> {
    const cronStore = this.cronStore;
    const key = this.taskKey(agentName, cronName);
    if (this.tasks.has(key)) {
      throw new AppError(
        `Cron task already registered: ${agentName}/${cronName}`,
        'CRON_TASK_EXISTS',
        409,
      );
    }

    this.assertCronConfigSchedulable(config);
    await cronStore.create(agentName, cronName, config);

    // Surface the store-minted cron_id (archon_biz cron contract parity).
    // `create` returns only the config, so resolve the id via a best-effort
    // read-back; failure is non-fatal and simply leaves cronId undefined
    // (engine keying is unchanged either way).
    const cronId = await this.resolveCreatedCronId(agentName, cronName);

    const state: CronTaskState = {
      agentName,
      cronName,
      config,
      ...(cronId ? { cronId } : {}),
      enabled: !config.disabled,
      lastRun: null,
      lastResult: null,
      lastError: null,
      nextRun: null,
      status: 'idle',
    };

    const job = this.createJob(config, state);

    state.nextRun = job.nextRun()?.getTime() ?? null;
    this.tasks.set(key, { state, job });

    logger.info(
      { agentName, cronName, schedule: config.schedule, nextRun: state.nextRun },
      '[cron] Task created',
    );
    this.eventBus?.emit('cron.created', 'cron-registry', { agentName, cronName });
    getMetricsReporter().incr('cron_task_created_total', cronMutationMetricLabels(state, context));

    return state;
  }

  /** Delete a cron task — stops the job and removes from disk. */
  async deleteTask(
    agentName: string,
    cronName: string,
    context: CronMutationMetricsContext = {},
  ): Promise<boolean> {
    const cronStore = this.cronStore;
    const key = this.taskKey(agentName, cronName);
    const entry = this.tasks.get(key);
    if (!entry) return false;

    entry.job.stop();
    this.tasks.delete(key);
    const cancelledQueued = this.executor.cancelQueuedCron?.(agentName, cronName) ?? 0;
    if (cancelledQueued > 0) {
      logger.info(
        backgroundCtx(),
        `[cron] Cancelled queued messages for deleted task, agentName=${agentName}, cronName=${cronName}, count=${cancelledQueued}`,
      );
    }

    // Archive cron-created sessions before removing history
    try {
      await this.executor.cleanupSessionsOnDelete(agentName, cronName);
    } catch (err) {
      logger.warn(
        backgroundCtx(),
        `[cron] Session cleanup on delete failed (non-fatal), agentName=${agentName}, cronName=${cronName}, err=${(err as Error).message}`,
      );
    }

    // Delegate file deletion to the store
    await cronStore.delete(agentName, cronName);

    logger.info(
      backgroundCtx(),
      `[cron] Task deleted, agentName=${agentName}, cronName=${cronName}`,
    );
    this.eventBus?.emit('cron.deleted', 'cron-registry', { agentName, cronName });
    getMetricsReporter().incr(
      'cron_task_deleted_total',
      cronMutationMetricLabels(entry.state, context),
    );
    return true;
  }

  /** Get session run history for a cron task (oldest-first). */
  async getSessionHistory(
    agentName: string,
    cronName: string,
  ): ReturnType<ReturnType<typeof getCronStore>['getSessionHistory']> {
    const cronStore = this.cronStore;
    return cronStore.getSessionHistory(agentName, cronName);
  }

  /** List all tasks across all agents. */
  listAllTasks(): CronTaskState[] {
    const result: CronTaskState[] = [];
    for (const { state, job } of this.tasks.values()) {
      state.nextRun = job.nextRun()?.getTime() ?? null;
      result.push(state);
    }
    return result;
  }

  /** Set global enabled flag. */
  setGlobalEnabled(enabled: boolean): void {
    this.globalEnabled = enabled;
    logger.info(backgroundCtx(), `[cron] Global enabled flag changed, enabled=${enabled}`);
  }

  /** Get global enabled flag. */
  isGlobalEnabled(): boolean {
    return this.globalEnabled;
  }

  // ── Harness registration ──

  /**
   * Register cron tasks from a harness's crons directory.
   */
  async registerHarnessCrons(harnessName: string, agentNameList: string[]): Promise<string[]> {
    this.assertSchedulerConfigured();
    const cronStore = this.cronStore;
    const registered: string[] = [];

    for (const agentName of agentNameList) {
      const configs = await cronStore.listByAgent(agentName);
      for (const { cronName, config, cronId } of configs) {
        try {
          // Register or update in-memory timer
          const key = this.taskKey(agentName, cronName);
          if (this.tasks.has(key)) {
            // Task already loaded — re-sync config and possibly recreate timer
            const existing = this.tasks.get(key)!;
            const oldConfig = existing.state.config;
            const needsRecreate =
              oldConfig.schedule !== config.schedule || oldConfig.timezone !== config.timezone;

            if (needsRecreate) {
              const newJob = this.createJob(config, existing.state);

              existing.job.stop();
              existing.job = newJob;
              existing.state.nextRun = newJob.nextRun()?.getTime() ?? null;
            }

            existing.state.config = config;
            existing.state.enabled = !config.disabled;
            this.eventBus?.emit('cron.updated', 'cron-registry', { agentName, cronName });
          } else {
            // New task — create in-memory timer
            const state: CronTaskState = {
              agentName,
              cronName,
              config,
              ...(cronId ? { cronId } : {}),
              enabled: !config.disabled,
              lastRun: null,
              lastResult: null,
              lastError: null,
              nextRun: null,
              status: 'idle',
            };

            const job = this.createJob(config, state);

            state.nextRun = job.nextRun()?.getTime() ?? null;
            this.tasks.set(key, { state, job });

            logger.info(
              { agentName, cronName, schedule: config.schedule, nextRun: state.nextRun },
              '[cron] Task created',
            );
            this.eventBus?.emit('cron.created', 'cron-registry', { agentName, cronName });
          }

          registered.push(cronName);
        } catch (err) {
          logger.error(
            { harnessName, cronName, err: (err as Error).message },
            '[cron] Failed to register harness cron timer',
          );
        }
      }
    }

    if (registered.length > 0) {
      logger.info(
        backgroundCtx(),
        `[cron] Harness crons registered, harnessName=${harnessName}, count=${registered.length}`,
      );
    }
    return registered;
  }

  /**
   * Remove all cron tasks registered by a specific harness.
   * Delegates symlink cleanup to CronStore, then stops in-memory timers.
   */
  async unregisterHarnessCrons(harnessName: string): Promise<string[]> {
    // 1. Stop in-memory timers for matching tasks
    const exactPrefix = `${harnessName}:`;
    const reinPrefix = `${harnessName}--`;
    const toRemove: Array<{ agentName: string; cronName: string }> = [];

    for (const [key, { state }] of this.tasks) {
      if (key.startsWith(exactPrefix) || key.startsWith(reinPrefix)) {
        toRemove.push({ agentName: state.agentName, cronName: state.cronName });
      }
    }

    const removed: string[] = [];

    for (const { agentName, cronName } of toRemove) {
      const key = this.taskKey(agentName, cronName);
      const entry = this.tasks.get(key);
      if (entry) {
        entry.job.stop();
        this.tasks.delete(key);
        this.eventBus?.emit('cron.deleted', 'cron-registry', { agentName, cronName });
        removed.push(cronName);
      }
    }

    if (removed.length > 0) {
      logger.info(
        backgroundCtx(),
        `[cron] Harness crons unregistered, harnessName=${harnessName}, count=${removed.length}`,
      );
    }
    return removed;
  }

  // ── Private ──

  private createJob(config: CronConfig, state: CronTaskState): CronJobPort {
    const { agentName, cronName } = state;
    return this.scheduler.createJob(config, { unref: this.options.unrefTimers }, () => {
      if (!this.globalEnabled) return;
      this.executeAndRecordTrigger(state, { triggerSource: 'schedule' })
        .then((result) => {
          if (state.config.scheduleType === 'once') {
            void this.completeOnceAfterExecution(agentName, cronName, result).catch(
              (err: unknown) => {
                logger.error(
                  { agentName, cronName, err: (err as Error).message },
                  '[cron] Failed to complete once task',
                );
              },
            );
          }
        })
        .catch((err: unknown) => {
          logger.error(
            { agentName, cronName, err: (err as Error).message },
            '[cron] Unhandled execution error',
          );
        });
    });
  }

  private async executeAndRecordTrigger(
    state: CronTaskState,
    context: CronTriggerMetricsContext & { force?: boolean },
  ): Promise<ExecuteResult> {
    const triggerSource = context.triggerSource ?? 'schedule';
    const result = await this.executor.execute(state, { force: context.force });
    getMetricsReporter().incr('cron_task_triggered_total', {
      trigger_source: triggerSource,
      trigger_outcome: cronTriggerOutcome(result),
      ...cronTaskMetricLabels(state, context.deliveryTarget),
    });
    return result;
  }

  private async completeOnceAfterExecution(
    agentName: string,
    cronName: string,
    result: ExecuteResult,
  ): Promise<void> {
    if (result.executed) {
      await this.completeOnceTask(agentName, cronName);
      return;
    }

    if (result.reason !== 'enqueued' || !result.queuedSend) return;
    void result.queuedSend.then((drainResult) => {
      if (drainResult !== 'sent') return;
      return this.completeOnceTask(agentName, cronName).catch((err: unknown) => {
        logger.error(
          { agentName, cronName, err: (err as Error).message },
          '[cron] Failed to complete once task after queued send',
        );
      });
    });
  }

  private async completeOnceTask(agentName: string, cronName: string): Promise<void> {
    const key = this.taskKey(agentName, cronName);
    const entry = this.tasks.get(key);
    if (!entry || entry.state.config.scheduleType !== 'once') return;
    if (entry.state.config.deleteAfterRun === false) return;
    entry.job.stop();
    this.tasks.delete(key);
    await this.cronStore.delete(agentName, cronName);
    getMetricsReporter().incr(
      'cron_task_deleted_total',
      cronMutationMetricLabels(entry.state, { mutationSource: 'system' }),
    );
    logger.info(
      backgroundCtx(),
      `[cron] Once task completed and deleted, agentName=${agentName}, cronName=${cronName}`,
    );
    this.eventBus?.emit('cron.deleted', 'cron-registry', { agentName, cronName });
  }

  private assertCronConfigSchedulable(config: CronConfig): void {
    try {
      this.scheduler.assertSchedulable(config);
    } catch (err) {
      if (err instanceof AppError) throw err;
      // Keep the scheduler detail on the server; clients get a stable validation code.
      logger.warn(
        backgroundCtx(),
        `[cron] schedule rejected by scheduler: ${err instanceof Error ? err.message : 'unknown'}`,
      );
      throw new AppError('Invalid cron schedule', 'VALIDATION_ERROR', 400);
    }
  }

  private assertSchedulerConfigured(): void {
    void this.scheduler;
  }

  private taskKey(agentName: string, cronName: string): string {
    return `${agentName}:${cronName}`;
  }

  /**
   * Best-effort resolution of a freshly created cron's stable cron_id.
   * `CronStorePort.create` returns only the config, so we read the id back
   * from `listByAgent` (the only required port method that carries cronId).
   * Any failure is swallowed — cronId is purely additive metadata and the
   * engine never keys on it.
   */
  private async resolveCreatedCronId(
    agentName: string,
    cronName: string,
  ): Promise<string | undefined> {
    try {
      const list = await this.cronStore.listByAgent(agentName);
      return list.find((entry) => entry.cronName === cronName)?.cronId;
    } catch {
      return undefined;
    }
  }
}

function cronMutationMetricLabels(
  state: CronTaskState,
  context: CronMutationMetricsContext,
): Record<string, string> {
  return {
    mutation_source: context.mutationSource ?? 'http_api',
    ...cronTaskMetricLabels(state, context.deliveryTarget),
  };
}

function cronTaskMetricLabels(
  state: CronTaskState,
  deliveryTarget?: CronDeliveryTarget,
): Record<string, string> {
  return {
    owner_agent: state.agentName,
    schedule_type: state.config.scheduleType ?? 'cron',
    delivery_target: deliveryTarget ?? deliveryTargetForSession(state.config.session),
  };
}

function deliveryTargetForSession(session: SessionConfig): CronDeliveryTarget {
  if (session.mode === 'new') return 'new';
  if (session.mode === 'root') return 'root';
  return 'session_id';
}

function cronTriggerOutcome(result: ExecuteResult): string {
  if (result.executed) return 'executed';
  if (result.reason === 'enqueued') return 'enqueued';
  if (result.reason === 'error') return 'error';
  return 'skipped';
}

function applyCronScheduleUpdate(config: CronConfig, update: CronConfigUpdate): CronConfig {
  return {
    ...config,
    ...(update.schedule !== undefined ? { schedule: update.schedule } : {}),
    ...(update.timezone !== undefined
      ? update.timezone === null
        ? { timezone: undefined }
        : { timezone: update.timezone }
      : {}),
  };
}
