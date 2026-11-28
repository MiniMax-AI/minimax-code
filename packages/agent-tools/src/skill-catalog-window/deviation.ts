import {
  normalizeSkillUsageKey,
  skillCatalogDescription,
  type LocalSkillsCatalogEntry,
} from '@mavis/context-manager';
import { noticeDue } from '../mcp-disclosure/window-notice.js';

/** A Skill as a catalog showed or shows it; `signature` tells a visible description change apart. */
export interface SkillSnapshotEntry {
  readonly entry: LocalSkillsCatalogEntry;
  readonly signature: string;
}

/** Skills by `normalizeSkillUsageKey(name)`. */
export type SkillSnapshot = ReadonlyMap<string, SkillSnapshotEntry>;

/** How a Skill differs from what `<available_skills>` shows; Skills as shown have none. */
export type SkillDeviationStatus = 'added' | 'removed' | 'changed';

export interface SkillDeviation {
  readonly status: SkillDeviationStatus;
  readonly name: string;
  /** Absent for removed Skills. */
  readonly signature?: string;
}

/** Every Skill that differs from the frozen catalog, by normalized name. */
export type SkillDeviations = ReadonlyMap<string, SkillDeviation>;

/** What the skill-availability updates left in the history tell the model. */
export interface SkillToldState {
  /** The deviation the newest sent update stated; undefined: unknown, so state it all again. */
  readonly snapshot: SkillDeviations | undefined;
  /** An update was sent in this Session, or found in its history. */
  readonly everTold: boolean;
}

/**
 * What a Turn's `<skill-availability-update>` states: the complete current
 * deviation, replacing every earlier update.
 */
export interface SkillAvailability {
  readonly deviation: SkillDeviations;
  /** Present Skills outside the frozen catalog, by name. */
  readonly added: readonly LocalSkillsCatalogEntry[];
  /** Present Skills whose shown description differs from the frozen catalog, by name. */
  readonly changed: readonly LocalSkillsCatalogEntry[];
  readonly removed: readonly string[];
  /** Told as removed (or, when the window restarted, as changed) and shown as they are now. */
  readonly availableAgain: readonly string[];
  /** Told as changed in this window and back to what the frozen catalog shows. */
  readonly reverted: readonly string[];
}

/**
 * Skills by normalized name; of names that normalize alike, the first by name
 * wins. The signature is the description as catalog lines and updates show it
 * (protected Skills whole, others capped): an edit past the cap, or a
 * builtin-tier flip, changes nothing the model sees, so it is no change to announce.
 */
export function skillSnapshot(entries: readonly LocalSkillsCatalogEntry[]): SkillSnapshot {
  const snapshot = new Map<string, SkillSnapshotEntry>();
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const key = normalizeSkillUsageKey(entry.name);
    if (!snapshot.has(key)) {
      snapshot.set(key, { entry, signature: skillCatalogDescription(entry) });
    }
  }
  return snapshot;
}

/**
 * How the live Skills differ from the frozen catalog. Skills an update
 * announced as added in this window count as known: gone, they are removed.
 */
export function skillDeviation(
  frozen: SkillSnapshot,
  live: SkillSnapshot,
  addedInWindow: ReadonlyMap<string, string>,
): SkillDeviations {
  const deviation = new Map<string, SkillDeviation>();
  for (const [key, { entry, signature }] of live) {
    const shown = frozen.get(key);
    if (!shown) deviation.set(key, { status: 'added', name: entry.name, signature });
    else if (shown.signature !== signature) {
      deviation.set(key, { status: 'changed', name: entry.name, signature });
    }
  }
  for (const [key, shown] of frozen) {
    if (!live.has(key)) deviation.set(key, { status: 'removed', name: shown.entry.name });
  }
  for (const [key, name] of addedInWindow) {
    if (!live.has(key) && !frozen.has(key)) deviation.set(key, { status: 'removed', name });
  }
  return deviation;
}

/**
 * The update this Turn's user message carries, if any: when the deviation
 * differs from the last told one, or when what was told is unknown and there is
 * a deviation to state or an earlier update to supersede. `changedInWindow` is
 * given only when the window continues; without it the window restarted, so
 * nothing can revert to a catalog the model never saw.
 */
export function skillAvailability(
  told: SkillToldState,
  deviation: SkillDeviations,
  live: SkillSnapshot,
  changedInWindow?: ReadonlySet<string>,
): SkillAvailability | undefined {
  if (!noticeDue(told, deviation)) return undefined;
  const last = told.snapshot;
  const byName = (a: string, b: string) => a.localeCompare(b);
  const entries = (status: SkillDeviationStatus) =>
    [...deviation]
      .flatMap(([key, entry]) => {
        const present = entry.status === status ? live.get(key)?.entry : undefined;
        return present ? [present] : [];
      })
      .sort((a, b) => byName(a.name, b.name));
  const asShown = (key: string) => !deviation.has(key) && live.has(key);
  const nameOf = (key: string) => live.get(key)?.entry.name ?? key;
  const restored: readonly SkillDeviationStatus[] = changedInWindow
    ? ['removed']
    : ['removed', 'changed'];
  return {
    deviation,
    added: entries('added'),
    changed: entries('changed'),
    removed: [...deviation.values()]
      .flatMap((entry) => (entry.status === 'removed' ? [entry.name] : []))
      .sort(byName),
    availableAgain: [...(last ?? [])]
      .flatMap(([key, entry]) =>
        restored.includes(entry.status) && asShown(key) ? [nameOf(key)] : [],
      )
      .sort(byName),
    // Only Skills the last known update listed as changed: one it listed as
    // removed and that is back is available again, not reverted.
    reverted: [...(changedInWindow ?? [])]
      .filter((key) => asShown(key) && (last === undefined || last.get(key)?.status === 'changed'))
      .map(nameOf)
      .sort(byName),
  };
}
