import type {
  LocalSkillsCatalogEntry,
  LocalSkillsCatalogRenderResult,
  SkillCatalogUsage,
} from '@mavis/context-manager';
import { skillSnapshot, type SkillDeviation, type SkillSnapshot } from './deviation.js';
import { SKILL_AVAILABILITY_NOTICE_TAG, userMessageText } from './notice.js';
import {
  adoptSkillCatalogSessionState,
  disposeSkillCatalogSession,
  forgetSkillCatalogAnnouncements,
  peekSkillCatalogSessionState,
  type FrozenSkillCatalog,
  type SkillCatalogSessionState,
} from './state.js';

/**
 * Persisted form of one Session's skill-catalog state, for Hosts whose Sessions
 * outlive a process (the cloud Host keeps one per Session in object storage):
 * JSON-safe, with Skill snapshots stored as their entries and rebuilt on restore.
 * The window a Turn planned but no answer adopted is not kept, so a restored
 * Session continues the window in effect, as the next Turn of one process would.
 */
export interface SkillCatalogSessionRecord {
  readonly version: typeof RECORD_VERSION;
  readonly window?: FrozenSkillCatalogRecord;
  /** Absent: what the updates in the history state is unknown. */
  readonly told?: Pairs<SkillDeviation>;
  readonly everTold: boolean;
  readonly newestNotice?: string;
  readonly addedInWindow: Pairs<string>;
  readonly changedInWindow: readonly string[];
  readonly pending?: {
    readonly text: string;
    readonly deviation: Pairs<SkillDeviation>;
    readonly confirmed: boolean;
  };
  readonly historyChecked: boolean;
  readonly lastSummaryKey?: string;
  readonly endedByCompaction: boolean;
  readonly everEffective: boolean;
  readonly turn?: {
    readonly listing: Pairs<Listing>;
    readonly live: readonly LocalSkillsCatalogEntry[];
    readonly shadow: boolean;
  };
}

interface FrozenSkillCatalogRecord {
  readonly entries: readonly LocalSkillsCatalogEntry[];
  readonly usage: Pairs<SkillCatalogUsage>;
  readonly render: Omit<LocalSkillsCatalogRenderResult, 'nameOnly'> & {
    readonly nameOnly: readonly string[];
  };
  readonly listing: Pairs<Listing>;
  readonly contextWindowTokens?: number;
  readonly upstreamFingerprint: string;
  readonly startedAtMs: number;
}

type Pairs<V> = readonly (readonly [string, V])[];
type Listing = 'described' | 'name_only';

const RECORD_VERSION = 1;

/** The Session's state as a record; undefined when this process keeps none. */
export function exportSkillCatalogSession(
  sessionId: string,
): SkillCatalogSessionRecord | undefined {
  const state = peekSkillCatalogSessionState(sessionId);
  if (!state) return undefined;
  return {
    version: RECORD_VERSION,
    ...(state.window ? { window: windowRecord(state.window) } : {}),
    ...(state.told ? { told: deviationPairs(state.told) } : {}),
    everTold: state.everTold,
    ...(state.newestNotice === undefined ? {} : { newestNotice: state.newestNotice }),
    addedInWindow: [...state.addedInWindow],
    changedInWindow: [...state.changedInWindow],
    ...(state.pending
      ? {
          pending: {
            text: state.pending.text,
            deviation: deviationPairs(state.pending.deviation),
            confirmed: state.pending.confirmed,
          },
        }
      : {}),
    historyChecked: state.historyChecked,
    ...(state.lastSummaryKey === undefined ? {} : { lastSummaryKey: state.lastSummaryKey }),
    endedByCompaction: state.endedByCompaction,
    everEffective: state.everEffective,
    ...(state.turn
      ? {
          turn: {
            listing: [...state.turn.listing],
            live: snapshotEntries(state.turn.live),
            shadow: state.turn.shadow,
          },
        }
      : {}),
  };
}

/**
 * Replaces the Session's process-local state with `record` before its first
 * Turn in this process; undefined (none stored) clears it, so the next Turn
 * starts a window. Returns false, leaving no state, when the record is not one
 * this version reads. With `history` (the stored messages the Turn continues),
 * updates the record counts as told but the history no longer shows as the
 * newest (a rewind, or a record older than the history) become unknown, as
 * `forgetSkillCatalogAnnouncements` makes them.
 */
export function restoreSkillCatalogSession(
  sessionId: string,
  record: unknown,
  history?: readonly unknown[],
): boolean {
  disposeSkillCatalogSession(sessionId);
  if (record === undefined) return true;
  let state: SkillCatalogSessionState;
  try {
    state = parseRecord(record);
  } catch {
    return false;
  }
  adoptSkillCatalogSessionState(sessionId, state);
  if (history && !historyShowsTold(state, history)) forgetSkillCatalogAnnouncements(sessionId);
  return true;
}

/**
 * The newest update in the history is the one the state last sent; with none
 * there, nothing it still counts as told was lost (it told no deviation, or a
 * compaction dropped an update that said all Skills are as shown).
 */
function historyShowsTold(state: SkillCatalogSessionState, history: readonly unknown[]): boolean {
  const text = newestNoticeHolder(history);
  if (text === undefined) return !state.told?.size;
  const notice = state.newestNotice;
  if (notice === undefined) return false;
  const sent = text.lastIndexOf(notice);
  const newest = text.lastIndexOf(SKILL_AVAILABILITY_NOTICE_TAG);
  return sent !== -1 && sent + notice.indexOf(SKILL_AVAILABILITY_NOTICE_TAG) === newest;
}

/** Text of the newest user message carrying an update. */
function newestNoticeHolder(messages: readonly unknown[]): string | undefined {
  for (let at = messages.length - 1; at >= 0; at -= 1) {
    const text = userMessageText(messages[at]);
    if (text?.includes(SKILL_AVAILABILITY_NOTICE_TAG)) return text;
  }
  return undefined;
}

function windowRecord(window: FrozenSkillCatalog): FrozenSkillCatalogRecord {
  const { render } = window;
  return {
    entries: snapshotEntries(window.entries),
    usage: [...window.usage].map(([key, usage]) => [
      key,
      {
        useCount: usage.useCount,
        lastUsedAtMs: usage.lastUsedAtMs,
        ...(usage.firstSeenAtMs === undefined ? {} : { firstSeenAtMs: usage.firstSeenAtMs }),
      },
    ]),
    render: {
      catalog: render.catalog,
      descriptionsDropped: render.descriptionsDropped,
      nameOnly: [...render.nameOnly],
      descriptionCapTruncated: render.descriptionCapTruncated,
      catalogTokens: render.catalogTokens,
    },
    listing: [...window.listing],
    ...(window.contextWindowTokens === undefined
      ? {}
      : { contextWindowTokens: window.contextWindowTokens }),
    upstreamFingerprint: window.upstreamFingerprint,
    startedAtMs: window.startedAtMs,
  };
}

function snapshotEntries(snapshot: SkillSnapshot): LocalSkillsCatalogEntry[] {
  return [...snapshot.values()].map(({ entry }) => ({
    name: entry.name,
    description: entry.description,
    builtin: entry.builtin,
  }));
}

function deviationPairs(deviations: ReadonlyMap<string, SkillDeviation>): Pairs<SkillDeviation> {
  return [...deviations].map(([key, deviation]) => [
    key,
    {
      status: deviation.status,
      name: deviation.name,
      ...(deviation.signature === undefined ? {} : { signature: deviation.signature }),
    },
  ]);
}

class MalformedSkillCatalogRecord extends Error {}

function parseRecord(value: unknown): SkillCatalogSessionState {
  const record = object(value);
  if (record.version !== RECORD_VERSION) throw new MalformedSkillCatalogRecord();
  const window = optional(record.window, parseWindow);
  const told = optional(record.told, (pairs) => map(pairs, parseDeviation));
  const newestNotice = optional(record.newestNotice, string);
  const pending = optional(record.pending, (raw) => {
    const fields = object(raw);
    return {
      text: string(fields.text),
      deviation: map(fields.deviation, parseDeviation),
      confirmed: boolean(fields.confirmed),
    };
  });
  const lastSummaryKey = optional(record.lastSummaryKey, string);
  const turn = optional(record.turn, (raw) => {
    const fields = object(raw);
    return {
      listing: map(fields.listing, parseListing),
      live: skillSnapshot(list(fields.live, parseEntry)),
      shadow: boolean(fields.shadow),
    };
  });
  return {
    ...(window ? { window } : {}),
    told,
    everTold: boolean(record.everTold),
    ...(newestNotice === undefined ? {} : { newestNotice }),
    addedInWindow: map(record.addedInWindow, string),
    changedInWindow: new Set(list(record.changedInWindow, string)),
    ...(pending ? { pending } : {}),
    historyChecked: boolean(record.historyChecked),
    ...(lastSummaryKey === undefined ? {} : { lastSummaryKey }),
    endedByCompaction: boolean(record.endedByCompaction),
    everEffective: boolean(record.everEffective),
    ...(turn ? { turn } : {}),
  };
}

function parseWindow(value: unknown): FrozenSkillCatalog {
  const fields = object(value);
  const render = object(fields.render);
  return {
    entries: skillSnapshot(list(fields.entries, parseEntry)),
    usage: map(fields.usage, (raw) => {
      const usage = object(raw);
      const firstSeenAtMs = optional(usage.firstSeenAtMs, number);
      return {
        useCount: number(usage.useCount),
        lastUsedAtMs: number(usage.lastUsedAtMs),
        ...(firstSeenAtMs === undefined ? {} : { firstSeenAtMs }),
      };
    }),
    render: {
      catalog: string(render.catalog),
      descriptionsDropped: number(render.descriptionsDropped),
      nameOnly: new Set(list(render.nameOnly, string)),
      descriptionCapTruncated: boolean(render.descriptionCapTruncated),
      catalogTokens: number(render.catalogTokens),
    },
    listing: map(fields.listing, parseListing),
    contextWindowTokens: optional(fields.contextWindowTokens, number),
    upstreamFingerprint: string(fields.upstreamFingerprint),
    startedAtMs: number(fields.startedAtMs),
  };
}

function parseEntry(value: unknown): LocalSkillsCatalogEntry {
  const fields = object(value);
  return {
    name: string(fields.name),
    description: string(fields.description),
    builtin: boolean(fields.builtin),
  };
}

function parseDeviation(value: unknown): SkillDeviation {
  const fields = object(value);
  const status = fields.status;
  if (status !== 'added' && status !== 'removed' && status !== 'changed') {
    throw new MalformedSkillCatalogRecord();
  }
  const signature = optional(fields.signature, string);
  return {
    status,
    name: string(fields.name),
    ...(signature === undefined ? {} : { signature }),
  };
}

function parseListing(value: unknown): Listing {
  if (value === 'described' || value === 'name_only') return value;
  throw new MalformedSkillCatalogRecord();
}

function object(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Readonly<Record<string, unknown>>;
  }
  throw new MalformedSkillCatalogRecord();
}

function list<T>(value: unknown, item: (raw: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new MalformedSkillCatalogRecord();
  return value.map((raw: unknown) => item(raw));
}

function map<V>(value: unknown, item: (raw: unknown) => V): Map<string, V> {
  return new Map(
    list(value, (pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) throw new MalformedSkillCatalogRecord();
      return [string(pair[0]), item(pair[1])] as const;
    }),
  );
}

function optional<T>(value: unknown, parse: (raw: unknown) => T): T | undefined {
  return value === undefined ? undefined : parse(value);
}

function string(value: unknown): string {
  if (typeof value === 'string') return value;
  throw new MalformedSkillCatalogRecord();
}

function number(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new MalformedSkillCatalogRecord();
}

function boolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  throw new MalformedSkillCatalogRecord();
}
