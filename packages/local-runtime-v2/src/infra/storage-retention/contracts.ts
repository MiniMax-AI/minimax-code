/** Retention policies that the owner Runtime runs once after it becomes ready. */
import type { StorageRetentionPolicyName } from '@mavis/shared/storage-cleanup';

/** Keys of the `storageRetention` section in config.yaml. */
type StorageRetentionSettingKey =
  | 'logsDays'
  | 'turnDiffsDays'
  | 'backgroundTasksDays'
  | 'historyMutationReceiptsHours'
  | 'legacyHistoryDays';

/**
 * User values from config.yaml. An absent key uses the policy default; a present value that is
 * not a positive finite number makes the runner skip that policy instead of guessing.
 */
export type StorageRetentionSettings = Partial<
  Readonly<Record<StorageRetentionSettingKey, number>>
>;

export const HOUR_MS = 60 * 60 * 1_000;
export const DAY_MS = 24 * HOUR_MS;

export interface StorageRetentionRunControls {
  /** Clock reading taken when the policy started. */
  readonly nowMs: number;
  /** Explicit user cleanup bypasses age, never ownership or in-use protections. */
  readonly manual?: boolean;
  readonly protectedSessionIds?: ReadonlySet<string>;
  /** Takes one unit of the inspection budget; false once the budget or the deadline is spent. */
  consumeEntry(): boolean;
  /** True once the deadline or the inspection budget is spent, or the Runtime is stopping. */
  shouldStop(): boolean;
  /**
   * Call between two write transactions. Waits as long as the work since the previous pause took,
   * and at least 100 ms, SQLite's longest busy-handler retry interval, so a writer waiting in
   * another process always gets the lock in between. Resolves at once when the Runtime stops.
   */
  yieldToOtherWriters(): Promise<void>;
}

export interface StorageRetentionOutcome {
  readonly deletedEntries: number;
  readonly deletedBytes: number;
  /** Set when a limit stopped the policy early; the rest waits for the next Runtime start. */
  readonly truncated?: boolean;
}

interface StorageRetentionPolicyBase {
  readonly name: StorageRetentionPolicyName;
  /** Inspection budget for one run; the runner default applies when absent. */
  readonly maxEntries?: number;
}

/** Deletes data that became eligible before `cutoffMs`. */
export interface AgeRetentionPolicy extends StorageRetentionPolicyBase {
  readonly retention: {
    readonly kind: 'age';
    readonly setting?: StorageRetentionSettingKey;
    readonly defaultValue: number;
    readonly unitMs: number;
  };
  run(
    controls: StorageRetentionRunControls & { readonly cutoffMs: number },
  ): Promise<StorageRetentionOutcome>;
}

export interface ManualCleanupPolicy extends StorageRetentionPolicyBase {
  readonly retention: { readonly kind: 'manual' };
  run(
    controls: StorageRetentionRunControls & { readonly cutoffMs: number },
  ): Promise<StorageRetentionOutcome>;
}

export type StorageRetentionPolicy = AgeRetentionPolicy | ManualCleanupPolicy;
