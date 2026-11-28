import type { AllowedMetricName } from '@mavis/shared/local-runtime-logging/metrics';
import type { PluginSystemOptions } from '../../contracts.js';
import { PluginSystemError } from '../../errors.js';
import type { PluginRepositoryScope } from './repository.js';
import type {
  OfficialPluginMutationState,
  PreparedOfficialPluginReconciliation,
} from './official-reconciler.js';

type Reconciler = NonNullable<PluginSystemOptions['officialReconciler']>;
export type OfficialSyncTrigger = 'startup' | 'manual' | 'recovery';

const DEFAULT_AUTH_BARRIER_TIMEOUT_MS = 5_000;

type BarrierWakeReason = 'changed' | 'disposed' | 'timeout';
type BarrierMetricResult = 'disposed' | 'immediate' | 'logged_out' | 'timeout' | 'waited';
export type OfficialPluginAuthBarrierOutcome = 'disposed' | 'logged_out' | 'ready' | 'timeout';

type OfficialPluginAuthSnapshot = {
  readonly accessToken?: string;
  readonly realUserID?: string;
  readonly authState?: 'pending' | 'authenticated' | 'logged_out';
};

export function resolveOfficialPluginAuthState(
  auth: OfficialPluginAuthSnapshot | undefined,
): 'logged_out' | 'pending' | 'ready' {
  if (auth?.authState === 'pending') return 'pending';
  if (auth?.authState === 'logged_out') return 'logged_out';
  if (auth?.accessToken?.trim() && auth.realUserID?.trim()) return 'ready';

  // CLI/TUI snapshots predate Electron's propagation state. Preserve their
  // original logged-out behavior instead of treating a missing optional field
  // as an in-flight Renderer -> Main -> Utility rotation.
  return auth?.authState === 'authenticated' ? 'pending' : 'logged_out';
}

interface OfficialPluginAuthBarrierOptions {
  readonly isReady: () => boolean;
  readonly isLoggedOut?: () => boolean;
  readonly metrics?: {
    incr(name: AllowedMetricName, tags?: Record<string, string>): void;
    latency(name: AllowedMetricName, durationMs: number, tags?: Record<string, string>): void;
  };
  readonly timeoutMs?: number;
}

/**
 * Bridges asynchronous Renderer -> Main -> Utility auth propagation for
 * user-triggered official Plugin mutations without delaying global login.
 */
export class OfficialPluginAuthBarrier {
  private readonly waiters = new Set<(reason: BarrierWakeReason) => void>();
  private disposed = false;

  constructor(private readonly options: OfficialPluginAuthBarrierOptions) {}

  async waitUntilReady(): Promise<OfficialPluginAuthBarrierOutcome> {
    const startedAt = Date.now();
    if (this.disposed) return this.finish(startedAt, 'disposed', 'disposed');
    const initialOutcome = this.currentAuthOutcome();
    if (initialOutcome) {
      return this.finishAuthOutcome(startedAt, initialOutcome, 'immediate');
    }

    const deadline = startedAt + (this.options.timeoutMs ?? DEFAULT_AUTH_BARRIER_TIMEOUT_MS);
    while (!this.disposed) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return this.finish(startedAt, 'timeout', 'timeout');
      const wakeReason = await this.waitForChange(remainingMs);
      if (wakeReason === 'disposed') return this.finish(startedAt, 'disposed', 'disposed');
      if (wakeReason === 'timeout') return this.finish(startedAt, 'timeout', 'timeout');
      const outcome = this.currentAuthOutcome();
      if (outcome) {
        return this.finishAuthOutcome(startedAt, outcome, 'waited');
      }
    }
    return this.finish(startedAt, 'disposed', 'disposed');
  }

  authContextChanged(): void {
    this.wakeAll('changed');
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.wakeAll('disposed');
  }

  private waitForChange(timeoutMs: number): Promise<BarrierWakeReason> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (reason: BarrierWakeReason) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve(reason);
      };
      const timer = setTimeout(() => finish('timeout'), timeoutMs);
      timer.unref?.();
      this.waiters.add(finish);

      // Close the subscribe/check race: auth may become ready immediately
      // before this waiter is registered, without another change event.
      if (this.disposed) finish('disposed');
      else if (this.options.isReady() || this.options.isLoggedOut?.()) finish('changed');
    });
  }

  private wakeAll(reason: BarrierWakeReason): void {
    for (const waiter of [...this.waiters]) waiter(reason);
  }

  private currentAuthOutcome(): 'logged_out' | 'ready' | undefined {
    if (this.options.isReady()) return 'ready';
    return this.options.isLoggedOut?.() ? 'logged_out' : undefined;
  }

  private finishAuthOutcome(
    startedAt: number,
    outcome: 'logged_out' | 'ready',
    readyResult: 'immediate' | 'waited',
  ): OfficialPluginAuthBarrierOutcome {
    return this.finish(startedAt, outcome === 'ready' ? readyResult : 'logged_out', outcome);
  }

  private finish(
    startedAt: number,
    result: BarrierMetricResult,
    outcome: OfficialPluginAuthBarrierOutcome,
  ): OfficialPluginAuthBarrierOutcome {
    const tags = { result };
    this.options.metrics?.incr('plugin_official_auth_barrier_total', tags);
    this.options.metrics?.latency(
      'plugin_official_auth_barrier_wait_duration_ms',
      Date.now() - startedAt,
      tags,
    );
    return outcome;
  }
}

async function prepareOfficialFull(input: {
  readonly reconciler: Reconciler | undefined;
  readonly scope: PluginRepositoryScope;
  readonly shouldCommit: () => boolean;
  readonly signal?: AbortSignal;
}): Promise<PreparedOfficialPluginReconciliation | undefined> {
  if (!input.reconciler) return undefined;
  if (input.reconciler.prepareReconcile) {
    return input.reconciler.prepareReconcile(input.scope, input.shouldCommit, input.signal);
  }
  await input.reconciler.reconcile(input.scope, input.shouldCommit);
  return undefined;
}

export async function prepareOfficialFullState(input: {
  readonly reconciler: Reconciler | undefined;
  readonly scope: PluginRepositoryScope | undefined;
  readonly isCurrentScope: () => boolean;
  readonly signal: AbortSignal;
  readonly trigger: OfficialSyncTrigger;
  readonly record: (status: 'success' | 'error' | 'superseded', startedAt: number) => void;
  readonly scheduleRecovery: () => void;
}): Promise<PreparedOfficialPluginReconciliation | undefined> {
  if (!input.scope || !input.reconciler) return undefined;
  const startedAt = Date.now();
  try {
    const prepared = await prepareOfficialFull({
      reconciler: input.reconciler,
      scope: input.scope,
      shouldCommit: input.isCurrentScope,
      signal: input.signal,
    });
    if (input.isCurrentScope()) {
      input.record('success', startedAt);
      return prepared;
    }
    await prepared?.abort();
    input.record('superseded', startedAt);
    return undefined;
  } catch (error) {
    input.record('error', startedAt);
    if (input.trigger !== 'startup') throw error;
    input.scheduleRecovery();
    return undefined;
  }
}

export function handleIncompleteOfficialSync(input: {
  readonly trigger: OfficialSyncTrigger;
  readonly failedPackageCount: number;
  readonly scheduleRecovery: () => void;
}): void {
  if (input.trigger === 'startup') {
    input.scheduleRecovery();
    return;
  }
  throw new PluginSystemError(
    'OFFICIAL_SYNC_INCOMPLETE',
    `official Plugin sync could not prepare ${input.failedPackageCount} package(s)`,
  );
}

export async function decidePreparedOfficialSync(input: {
  readonly unavailable: boolean;
  readonly forcePublication: boolean;
  readonly revisionChanged: boolean;
  readonly cachedRestoreCurrent: boolean;
  readonly prepared: PreparedOfficialPluginReconciliation | undefined;
}): Promise<'complete' | 'proceed' | 'retry'> {
  if (input.unavailable) {
    await input.prepared?.abort();
    return 'complete';
  }
  if (input.prepared && input.revisionChanged) {
    await input.prepared.abort();
    return 'retry';
  }
  if (
    !input.forcePublication &&
    input.cachedRestoreCurrent &&
    (!input.prepared || !input.prepared.changed)
  ) {
    await input.prepared?.abort();
    return 'complete';
  }
  return 'proceed';
}

export async function waitForOfficialPublication(input: {
  readonly completion: Promise<void>;
  readonly requestedScopeKey: string;
  readonly currentScopeKey: () => string;
}): Promise<'complete' | 'retry'> {
  try {
    await input.completion;
    return 'complete';
  } catch (error) {
    if (isSuperseded(error) && input.requestedScopeKey === input.currentScopeKey()) return 'retry';
    throw error;
  }
}

function isSuperseded(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'PUBLICATION_SUPERSEDED'
  );
}

export async function prepareOfficialMutation(input: {
  readonly reconciler: Reconciler | undefined;
  readonly scope: PluginRepositoryScope;
  readonly mutation: OfficialPluginMutationState;
  readonly shouldCommit: () => boolean;
  readonly signal: AbortSignal;
}): Promise<PreparedOfficialPluginReconciliation | undefined> {
  if (!input.reconciler?.reconcileMutation) {
    throw new PluginSystemError('AUTH_REQUIRED', 'official Plugin mutation requires identity');
  }
  if (input.reconciler.prepareMutation) {
    return input.reconciler.prepareMutation(
      input.scope,
      input.mutation,
      input.shouldCommit,
      input.signal,
    );
  }
  await input.reconciler.reconcileMutation(input.scope, input.mutation, input.shouldCommit);
  return undefined;
}

const DEFAULT_RECOVERY_DELAYS_MS = [30_000, 60_000, 120_000, 240_000, 300_000] as const;

export interface OfficialPluginRecoveryOptions {
  readonly delaysMs?: readonly number[];
  readonly isCurrentScope: (scopeKey: string) => boolean;
  readonly synchronize: (scopeKey: string) => Promise<void>;
}

/** Owns bounded, scope-aware retry scheduling for authoritative full-state recovery. */
export class OfficialPluginRecovery {
  private scopeKey = '';
  private failureCount = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly activeScopes = new Set<string>();
  private readonly rerunScopes = new Set<string>();
  private readonly tasks = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(private readonly options: OfficialPluginRecoveryOptions) {}

  request(scopeKey: string): void {
    if (!this.canRun(scopeKey)) return;
    this.cancelDelay();
    if (this.activeScopes.has(scopeKey)) {
      this.rerunScopes.add(scopeKey);
      return;
    }
    this.start(scopeKey);
  }

  schedule(scopeKey: string): void {
    if (!this.canRun(scopeKey)) return;
    this.ensureScope(scopeKey);
    if (this.timer) return;
    const delays = this.delays();
    const delayMs = delays[Math.min(this.failureCount, delays.length - 1)] ?? 300_000;
    this.failureCount += 1;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.start(scopeKey);
    }, delayMs);
    this.timer.unref?.();
  }

  succeeded(scopeKey: string): void {
    if (!this.options.isCurrentScope(scopeKey)) return;
    this.cancelDelay();
    this.scopeKey = scopeKey;
    this.failureCount = 0;
  }

  scopeChanged(): void {
    this.cancelDelay();
    this.rerunScopes.clear();
    this.scopeKey = '';
    this.failureCount = 0;
  }

  cancelDelay(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelDelay();
    this.rerunScopes.clear();
    await Promise.allSettled([...this.tasks.values()]);
  }

  private start(scopeKey: string): void {
    if (!this.canRun(scopeKey) || this.activeScopes.has(scopeKey)) return;
    this.ensureScope(scopeKey);
    this.activeScopes.add(scopeKey);
    this.tasks.set(scopeKey, this.runAttempt(scopeKey));
  }

  private async runAttempt(scopeKey: string): Promise<void> {
    try {
      await this.options.synchronize(scopeKey);
      this.succeeded(scopeKey);
    } catch {
      this.schedule(scopeKey);
    } finally {
      const rerun = this.rerunScopes.delete(scopeKey);
      this.activeScopes.delete(scopeKey);
      this.tasks.delete(scopeKey);
      if (rerun) this.request(scopeKey);
    }
  }

  private canRun(scopeKey: string): boolean {
    return !this.disposed && this.options.isCurrentScope(scopeKey);
  }

  private ensureScope(scopeKey: string): void {
    if (this.scopeKey === scopeKey) return;
    this.scopeChanged();
    this.scopeKey = scopeKey;
  }

  private delays(): readonly number[] {
    return this.options.delaysMs?.length ? this.options.delaysMs : DEFAULT_RECOVERY_DELAYS_MS;
  }
}
