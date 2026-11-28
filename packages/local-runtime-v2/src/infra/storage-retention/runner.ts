import { incrementMetric } from '@mavis/shared/local-runtime-logging/metric-registry';
import type {
  StorageCleanupHost,
  StorageRetentionPolicyReport,
} from '@mavis/shared/storage-cleanup';
import { KeyedOperationLane } from '@mavis/shared/keyed-operation-lane';
import type {
  StorageRetentionOutcome,
  StorageRetentionPolicy,
  StorageRetentionRunControls,
  StorageRetentionSettings,
} from './contracts.js';

export type { StorageRetentionPolicyReport } from '@mavis/shared/storage-cleanup';

const DEFAULT_POLICY_DURATION_MS = 10_000;
const DEFAULT_POLICY_MAX_ENTRIES = 2_000;
const DEFAULT_RECLAIM_DURATION_MS = 15_000;
/** SQLite's default busy handler retries at most every 100 ms while it waits for a lock. */
const WRITER_PAUSE_MIN_MS = 100;
const MIB = 1024 * 1024;

interface CounterMetrics {
  counter(name: string, delta?: number, labels?: Record<string, string>): void;
}

interface RetentionLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

type StorageRetentionRunOutcome = StorageRetentionPolicyReport['outcome'];

export interface StorageSpaceReclaimResult {
  readonly outcome: 'reclaimed' | 'nothing_to_reclaim' | 'not_incremental' | 'partial';
  readonly freedBytes: number;
}

export interface StorageSpaceReclaimLimits {
  /** True once the reclaim deadline passed or the Runtime is stopping. */
  shouldStop(): boolean;
  /** Same pause as {@link StorageRetentionRunControls.yieldToOtherWriters}. */
  yieldToOtherWriters(): Promise<void>;
}

export interface StorageRetentionRunnerOptions {
  readonly hostCleanup?: StorageCleanupHost;
  /** Reads `storageRetention` from config.yaml once per run. */
  readonly readSettings?: () => StorageRetentionSettings | undefined;
  /** Returns database free pages to the file system after every policy has run. */
  readonly reclaimSpace?: (limits: StorageSpaceReclaimLimits) => Promise<StorageSpaceReclaimResult>;
  readonly metrics?: CounterMetrics;
  readonly logger?: RetentionLogger;
  readonly nowMs?: () => number;
  readonly policyDurationMs?: number;
  readonly policyMaxEntries?: number;
  readonly reclaimDurationMs?: number;
}

export interface StorageRetentionRunner {
  /** Adds a policy; policies run one after another in registration order. */
  register(policy: StorageRetentionPolicy): void;
  /**
   * Runs every policy once, then reclaims database space. Never throws. Once `signal` aborts, the
   * running policy ends at its next check and nothing after it starts.
   */
  run(
    signal?: AbortSignal,
    mode?: 'automatic' | 'manual',
    protectedSessionIds?: readonly string[],
  ): Promise<readonly StorageRetentionPolicyReport[]>;
  /** Waits for automatic and user-triggered passes before stores close. */
  drain(): Promise<void>;
}

/**
 * The single post-ready cleanup pass of the owner Runtime. Each policy gets its own deadline and
 * inspection budget, a failing or misconfigured policy never stops the others, and every policy
 * reports what it deleted.
 */
export function createStorageRetentionRunner(
  options: StorageRetentionRunnerOptions = {},
): StorageRetentionRunner {
  const policies: StorageRetentionPolicy[] = [];
  let started = false;
  let pending: Promise<void> = Promise.resolve();
  const lane = new KeyedOperationLane<'storage'>();
  return {
    register(policy) {
      if (started) throw new Error('Storage retention already started');
      if (policies.some((existing) => existing.name === policy.name)) {
        throw new Error(`Storage retention policy already registered: ${policy.name}`);
      }
      policies.push(policy);
    },
    run(signal, mode = 'automatic', protectedSessionIds = []) {
      started = true;
      const pass = lane.run('storage', async () => {
        const settings = mode === 'manual' ? undefined : readSettings(options);
        const reports: StorageRetentionPolicyReport[] = [];
        let cleanupId: string | undefined;
        try {
          cleanupId = await options.hostCleanup?.begin(mode);
        } catch (error) {
          options.logger?.warn({ error }, 'Storage cleanup observation unavailable');
          for (const policy of ['browser_cache', 'installer_cache'] as const)
            reports.push({
              policy,
              outcome: 'failed',
              deletedEntries: 0,
              deletedBytes: 0,
              durationMs: 0,
            });
        }
        for (const policy of policies) {
          if (signal?.aborted) {
            if (mode === 'manual')
              reports.push(finish(options, { policy, outcome: 'partial', durationMs: 0 }));
            break;
          }
          if (mode !== 'manual' && policy.retention.kind === 'manual') continue;
          reports.push(
            await runPolicy(policy, {
              settings,
              options,
              signal,
              manual: mode === 'manual',
              protectedSessionIds: new Set(protectedSessionIds),
            }),
          );
        }
        if (!signal?.aborted) await reclaimSpace(options, signal);
        await completeHostCleanup(options, cleanupId, reports, signal?.aborted);
        return reports;
      });
      pending = settledPass(pass);
      return pass;
    },
    drain: () => pending,
  };
}

async function completeHostCleanup(
  options: StorageRetentionRunnerOptions,
  cleanupId: string | undefined,
  reports: StorageRetentionPolicyReport[],
  cancelled: boolean | undefined,
): Promise<void> {
  if (cleanupId && options.hostCleanup) {
    try {
      const hostReports = await options.hostCleanup.complete(cleanupId, cancelled);
      reports.push(...hostReports);
    } catch (error) {
      options.logger?.warn({ error }, 'Electron storage cleanup failed');
      for (const policy of ['browser_cache', 'installer_cache'] as const)
        reports.push({
          policy,
          outcome: 'failed',
          deletedEntries: 0,
          deletedBytes: 0,
          durationMs: 0,
        });
    }
  }
}

async function settledPass(pass: Promise<unknown>): Promise<void> {
  try {
    await pass;
  } catch {
    /* A later pass must still be allowed after a failure. */
  }
}

async function runPolicy(
  policy: StorageRetentionPolicy,
  input: {
    settings: StorageRetentionSettings | undefined;
    options: StorageRetentionRunnerOptions;
    signal: AbortSignal | undefined;
    manual: boolean;
    protectedSessionIds: ReadonlySet<string>;
  },
): Promise<StorageRetentionPolicyReport> {
  const { settings, options, signal, manual } = input;
  const clock = options.nowMs ?? Date.now;
  const startedAtMs = readClock(clock);
  if (startedAtMs === undefined) {
    options.logger?.warn({ policy: policy.name }, 'storage retention clock is invalid; skipped');
    return finish(options, { policy, outcome: 'failed', durationMs: 0 });
  }
  const cutoffMs = retentionCutoff(policy, settings, startedAtMs, manual);
  if (cutoffMs === undefined) return invalidSettingReport(policy, settings, options);
  const controls = createPolicyControls(options, policy, startedAtMs, signal);
  try {
    const outcome = await policy.run({
      ...controls,
      manual,
      cutoffMs,
      protectedSessionIds: input.protectedSessionIds,
    });
    return finish(options, {
      policy,
      outcome: outcome.truncated || signal?.aborted ? 'partial' : 'ok',
      result: outcome,
      durationMs: elapsed(clock, startedAtMs),
    });
  } catch (error) {
    options.logger?.warn({ error, policy: policy.name }, 'storage retention policy failed');
    return finish(options, { policy, outcome: 'failed', durationMs: elapsed(clock, startedAtMs) });
  }
}

function retentionCutoff(
  policy: StorageRetentionPolicy,
  settings: StorageRetentionSettings | undefined,
  now: number,
  manual: boolean,
): number | undefined {
  if (manual) return now;
  const value = resolveSetting(policy, settings);
  if (value === undefined || policy.retention.kind !== 'age') return undefined;
  return Math.max(0, Math.floor(now - value * policy.retention.unitMs));
}

function invalidSettingReport(
  policy: StorageRetentionPolicy,
  settings: StorageRetentionSettings | undefined,
  options: StorageRetentionRunnerOptions,
): StorageRetentionPolicyReport {
  const setting = policy.retention.kind === 'age' ? policy.retention.setting : undefined;
  options.logger?.warn(
    {
      policy: policy.name,
      setting: `storageRetention.${setting ?? policy.name}`,
      value: String(setting ? settings?.[setting] : undefined),
    },
    'storage retention setting is invalid; policy skipped',
  );
  return finish(options, { policy, outcome: 'invalid_config', durationMs: 0 });
}

function createPolicyControls(
  options: StorageRetentionRunnerOptions,
  policy: StorageRetentionPolicy,
  startedAtMs: number,
  signal: AbortSignal | undefined,
) {
  return createControls({
    startedAtMs,
    clock: options.nowMs ?? Date.now,
    durationMs: options.policyDurationMs ?? DEFAULT_POLICY_DURATION_MS,
    maxEntries: policy.maxEntries ?? options.policyMaxEntries ?? DEFAULT_POLICY_MAX_ENTRIES,
    signal,
  });
}

interface FinishedRun {
  readonly policy: StorageRetentionPolicy;
  readonly outcome: StorageRetentionRunOutcome;
  readonly result?: StorageRetentionOutcome;
  readonly durationMs: number;
}

function finish(
  options: StorageRetentionRunnerOptions,
  { policy, outcome, result, durationMs }: FinishedRun,
): StorageRetentionPolicyReport {
  const report: StorageRetentionPolicyReport = {
    policy: policy.name,
    outcome,
    deletedEntries: countOrZero(result?.deletedEntries),
    deletedBytes: countOrZero(result?.deletedBytes),
    durationMs,
  };
  const labels = { policy: policy.name, platform: metricPlatform() };
  incrementMetric(options.metrics, 'storage_retention_runs_total', 1, { ...labels, outcome });
  incrementMetric(options.metrics, 'storage_retention_freed_total', 1, {
    ...labels,
    freed_bucket: freedBucket(report.deletedBytes),
  });
  incrementMetric(options.metrics, 'storage_retention_duration_total', 1, {
    ...labels,
    duration_bucket: durationBucket(durationMs),
  });
  if (report.deletedEntries > 0 || outcome === 'partial') {
    options.logger?.info({ ...report }, 'local-runtime-v2 storage retention policy finished');
  }
  return report;
}

async function reclaimSpace(
  options: StorageRetentionRunnerOptions,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!options.reclaimSpace) return;
  const clock = options.nowMs ?? Date.now;
  const startedAtMs = readClock(clock);
  if (startedAtMs === undefined) return;
  const deadlineAtMs = startedAtMs + (options.reclaimDurationMs ?? DEFAULT_RECLAIM_DURATION_MS);
  try {
    const result = await options.reclaimSpace({
      shouldStop: () => signal?.aborted === true || !isBefore(clock, deadlineAtMs),
      yieldToOtherWriters: createWriterPause(clock, signal),
    });
    incrementMetric(options.metrics, 'storage_space_reclaim_total', 1, {
      outcome: result.outcome,
      freed_bucket: freedBucket(result.freedBytes),
      platform: metricPlatform(),
    });
    if (result.freedBytes > 0 || result.outcome === 'partial') {
      options.logger?.info(
        { ...result, durationMs: elapsed(clock, startedAtMs) },
        'local-runtime-v2 storage space reclaimed',
      );
    }
  } catch (error) {
    incrementMetric(options.metrics, 'storage_space_reclaim_total', 1, {
      outcome: 'failed',
      freed_bucket: freedBucket(0),
      platform: metricPlatform(),
    });
    options.logger?.warn({ error }, 'local-runtime-v2 storage space reclaim failed');
  }
}

interface ControlLimits {
  readonly startedAtMs: number;
  readonly clock: () => number;
  readonly durationMs: number;
  readonly maxEntries: number;
  readonly signal: AbortSignal | undefined;
}

function createControls(limits: ControlLimits): StorageRetentionRunControls {
  const deadlineAtMs = limits.startedAtMs + limits.durationMs;
  const { maxEntries, signal } = limits;
  let remaining = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : 0;
  const shouldStop = (): boolean =>
    remaining <= 0 || signal?.aborted === true || !isBefore(limits.clock, deadlineAtMs);
  return {
    nowMs: limits.startedAtMs,
    shouldStop,
    consumeEntry: () => {
      if (shouldStop()) return false;
      remaining -= 1;
      return true;
    },
    yieldToOtherWriters: createWriterPause(limits.clock, signal),
  };
}

/**
 * Each write step holds the database write lock. A writer in another process waits in SQLite's
 * busy handler, which only retries every 100 ms at most, so a zero-length yield between steps
 * lets it in by luck only. The pause lasts as long as the step before it, and at least that
 * retry interval.
 */
function createWriterPause(
  clock: () => number,
  signal: AbortSignal | undefined,
): () => Promise<void> {
  let resumedAtMs = readClock(clock);
  return async () => {
    const now = readClock(clock);
    const stepMs = now === undefined || resumedAtMs === undefined ? 0 : now - resumedAtMs;
    await pause(Math.max(WRITER_PAUSE_MIN_MS, stepMs), signal);
    resumedAtMs = readClock(clock);
  };
}

/** Resolves after `ms`, or at once when `signal` aborts; never keeps the process alive alone. */
function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal?.addEventListener('abort', done, { once: true });
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
  });
}

function isBefore(clock: () => number, deadlineAtMs: number): boolean {
  const now = readClock(clock);
  return now !== undefined && now < deadlineAtMs;
}

function resolveSetting(
  policy: StorageRetentionPolicy,
  settings: StorageRetentionSettings | undefined,
): number | undefined {
  if (policy.retention.kind !== 'age') return undefined;
  const raw = policy.retention.setting ? settings?.[policy.retention.setting] : undefined;
  if (raw === undefined) return policy.retention.defaultValue;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

function readSettings(
  options: StorageRetentionRunnerOptions,
): StorageRetentionSettings | undefined {
  try {
    return options.readSettings?.();
  } catch (error) {
    options.logger?.warn({ error }, 'storage retention settings could not be read; using defaults');
    return undefined;
  }
}

function readClock(clock: () => number): number | undefined {
  try {
    const value = clock();
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function elapsed(clock: () => number, startedAtMs: number): number {
  const now = readClock(clock);
  return now === undefined ? 0 : Math.max(0, now - startedAtMs);
}

function countOrZero(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Byte totals are bucketed: large single counter increments are unreliable in the metrics gateway. */
function freedBucket(
  bytes: number,
): '0' | 'lt_10mib' | '10mib_100mib' | '100mib_1gib' | 'gte_1gib' {
  if (bytes <= 0) return '0';
  if (bytes < 10 * MIB) return 'lt_10mib';
  if (bytes < 100 * MIB) return '10mib_100mib';
  if (bytes < 1024 * MIB) return '100mib_1gib';
  return 'gte_1gib';
}

function durationBucket(ms: number): 'lt_1s' | '1s_10s' | 'gte_10s' {
  if (ms < 1_000) return 'lt_1s';
  if (ms < 10_000) return '1s_10s';
  return 'gte_10s';
}

function metricPlatform(): 'darwin' | 'win32' | 'linux' | 'other' {
  return process.platform === 'darwin' ||
    process.platform === 'win32' ||
    process.platform === 'linux'
    ? process.platform
    : 'other';
}
