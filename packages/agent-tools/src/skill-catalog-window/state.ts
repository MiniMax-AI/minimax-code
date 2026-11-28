import {
  normalizeSkillUsageKey,
  type LocalSkillsCatalogRenderResult,
  type SkillCatalogUsageMap,
} from '@mavis/context-manager';
import type { SkillDeviations, SkillSnapshot, SkillToldState } from './deviation.js';

/** How the latest Turn's prompt shows a Skill: catalog line with or without description, update, or not at all. */
export type SkillCatalogListing = 'described' | 'name_only' | 'notice' | 'unlisted';

/**
 * The `<available_skills>` a window froze: from a Session start or a compaction
 * up to the next compaction, the system prompt repeats `render.catalog` byte for
 * byte and later changes go into skill-availability updates.
 */
export interface FrozenSkillCatalog {
  readonly entries: SkillSnapshot;
  /** Usage read when the window started; it ranks descriptions for the whole window. */
  readonly usage: SkillCatalogUsageMap;
  readonly render: LocalSkillsCatalogRenderResult;
  readonly listing: ReadonlyMap<string, 'described' | 'name_only'>;
  readonly contextWindowTokens: number | undefined;
  readonly upstreamFingerprint: string;
  /** When the Turn that planned it started (Unix ms); decay and new-skill protection use it. */
  readonly startedAtMs: number;
}

/**
 * Process-local skill-catalog memory for one Session, kept apart from Tool
 * Search's (which has no window while it is off for a model) but run through
 * the same lifecycle: a planned window takes effect once a request of its Turn
 * is answered; an update counts as told once a request sends it; a compaction
 * ends the window; a rewind forgets what was told. A Host whose Sessions outlive
 * the process carries it over with `exportSkillCatalogSession` and
 * `restoreSkillCatalogSession` (see `record.ts`); otherwise a restarted process
 * starts a new window.
 */
export interface SkillCatalogSessionState {
  window?: FrozenSkillCatalog;
  /** The window the latest Turn planned, until a response to a request of that Turn arrives. */
  unsentWindow?: PlannedSkillCatalogWindow;
  /** The deviation the newest sent update stated (none sent: empty); undefined: unknown. */
  told: SkillDeviations | undefined;
  everTold: boolean;
  /**
   * Text of the newest update a request of this process sent; undefined once a
   * rewind forgot it. A restored state checks the stored history against it.
   */
  newestNotice?: string;
  /** Skills a sent update announced as added in this window, with their names. */
  readonly addedInWindow: Map<string, string>;
  /** Skills a sent update announced as changed in this window. */
  readonly changedInWindow: Set<string>;
  /** The latest Turn's update, until a request sends it and after (to re-confirm a retry). */
  pending?: PendingSkillNotice;
  /** History was searched for updates of an earlier process since it last changed under us. */
  historyChecked: boolean;
  lastSummaryKey?: string;
  /** The window ended at a compaction (or a host reset) and none started since. */
  endedByCompaction: boolean;
  /** Some window of this process took effect. */
  everEffective: boolean;
  /** What the latest committed Turn's prompt showed, and the Skills it found. */
  turn?: TurnSkillView;
}

interface PendingSkillNotice {
  readonly text: string;
  readonly deviation: SkillDeviations;
  confirmed: boolean;
}

/** A window a Turn planned, until one of its requests is answered. */
export interface PlannedSkillCatalogWindow {
  readonly window: FrozenSkillCatalog;
  /** The Turn's request hook ran for a request: the provider may answer it. */
  sent: boolean;
}

/** What the latest committed Turn's prompt showed, and the live Skills it found. */
export interface TurnSkillView {
  readonly listing: ReadonlyMap<string, 'described' | 'name_only'>;
  /** The live Skills this Turn planned against; the next Turn measures its change from them. */
  readonly live: SkillSnapshot;
  /** Shadow mode: the prompt showed a fresh render and no update. */
  readonly shadow: boolean;
}

const MAX_SESSIONS = 512;
const states = new Map<string, SkillCatalogSessionState>();
const NOTHING_TOLD: SkillToldState = { snapshot: new Map(), everTold: false };

/** The Session's state, created on demand; access refreshes its place in the LRU. */
export function skillCatalogSessionState(sessionId: string): SkillCatalogSessionState {
  const existing = states.get(sessionId);
  if (existing) {
    states.delete(sessionId);
    states.set(sessionId, existing);
    return existing;
  }
  const created: SkillCatalogSessionState = {
    told: new Map(),
    everTold: false,
    addedInWindow: new Map(),
    changedInWindow: new Set(),
    historyChecked: false,
    endedByCompaction: false,
    everEffective: false,
  };
  adoptSkillCatalogSessionState(sessionId, created);
  return created;
}

/** Makes `state` the Session's, replacing any it had; the newest entry of the LRU. */
export function adoptSkillCatalogSessionState(
  sessionId: string,
  state: SkillCatalogSessionState,
): void {
  states.delete(sessionId);
  if (states.size >= MAX_SESSIONS) {
    const oldest = states.keys().next().value;
    if (oldest !== undefined) states.delete(oldest);
  }
  states.set(sessionId, state);
}

/** The state if the Session has one; never creates it or touches the LRU. */
export function peekSkillCatalogSessionState(
  sessionId: string,
): Readonly<SkillCatalogSessionState> | undefined {
  return states.get(sessionId);
}

/** What the updates in the history tell the model; an unconfirmed latest one makes it unknown. */
export function skillToldState(
  state: Readonly<SkillCatalogSessionState> | undefined,
): SkillToldState {
  if (!state) return NOTHING_TOLD;
  return state.pending && !state.pending.confirmed
    ? { snapshot: undefined, everTold: true }
    : { snapshot: state.told, everTold: state.everTold };
}

/** An unconfirmed update stops being pending: it stays a possible update in the history. */
function retirePendingNotice(state: SkillCatalogSessionState): void {
  if (!state.pending || state.pending.confirmed) return;
  state.told = undefined;
  state.everTold = true;
}

/**
 * Stores what a committing Turn planned: a new window (taking effect when a
 * request of the Turn is answered) or none (the current one continues), the
 * update its user message carries (told once a request sends it), and what its
 * prompt shows.
 */
export function commitSkillCatalogTurn(
  state: SkillCatalogSessionState,
  turn: {
    readonly window: FrozenSkillCatalog | undefined;
    readonly notice: { readonly text: string; readonly deviation: SkillDeviations } | undefined;
    readonly view: TurnSkillView;
  },
): void {
  state.unsentWindow = turn.window ? { window: turn.window, sent: false } : undefined;
  retirePendingNotice(state);
  state.pending = turn.notice ? { ...turn.notice, confirmed: false } : undefined;
  state.turn = turn.view;
}

/** The window the latest Turn planned and that has not taken effect; its hooks hold on to it. */
export function plannedSkillCatalogWindow(
  sessionId: string,
): PlannedSkillCatalogWindow | undefined {
  return states.get(sessionId)?.unsentWindow;
}

/**
 * A request of the Turn that planned `planned` was answered: that window becomes
 * the Session's, if it is still the latest Turn's plan and the Turn's request
 * hook ran for a request (a reply the host made up, or the late answer of an
 * earlier Turn, makes no window).
 */
export function receiveSkillCatalogResponse(
  sessionId: string,
  planned: PlannedSkillCatalogWindow | undefined,
): void {
  const state = states.get(sessionId);
  const unsent = state?.unsentWindow;
  if (!state || !unsent || unsent !== planned || !unsent.sent) return;
  state.unsentWindow = undefined;
  state.window = unsent.window;
  state.endedByCompaction = false;
  state.everEffective = true;
  state.addedInWindow.clear();
  state.changedInWindow.clear();
}

/** The update still waiting for a request to send it, if any. */
export function pendingSkillCatalogNotice(sessionId: string): string | undefined {
  const pending = states.get(sessionId)?.pending;
  return pending && !pending.confirmed ? pending.text : undefined;
}

/** A request sent the pending update: it is now the newest update in the history. */
export function confirmSkillCatalogAnnouncement(sessionId: string): void {
  const state = states.get(sessionId);
  const pending = state?.pending;
  if (!state || !pending || pending.confirmed) return;
  pending.confirmed = true;
  state.told = pending.deviation;
  state.everTold = true;
  state.newestNotice = pending.text;
  for (const [key, entry] of pending.deviation) {
    if (entry.status === 'added') state.addedInWindow.set(key, entry.name);
    if (entry.status === 'changed') state.changedInWindow.add(key);
  }
}

/**
 * The request history holds an update this process did not send (a restart, a
 * fork): the next Turn states the full deviation, superseding it. Checked on the
 * first request of a Session that has told nothing yet, and again after the
 * history was rewound. Never creates state.
 */
export function noteSkillCatalogNoticeInHistory(sessionId: string, hasNotice: () => boolean): void {
  const state = states.get(sessionId);
  if (!state || state.historyChecked) return;
  state.historyChecked = true;
  if (state.everTold || !hasNotice()) return;
  state.everTold = true;
  state.told = undefined;
}

/**
 * Called for the latest compaction summary of each request: a new one ends the
 * window, unless it was written before the window started (history resumed after
 * a restart). A summary without a usable time ends it. Never creates state.
 */
export function noteSkillCatalogCompaction(
  sessionId: string,
  summaryKey: string,
  summaryAtMs: number,
): void {
  const state = states.get(sessionId);
  if (!state || state.lastSummaryKey === summaryKey) return;
  state.lastSummaryKey = summaryKey;
  const startedAtMs = (state.unsentWindow?.window ?? state.window)?.startedAtMs;
  const predatesWindow = startedAtMs !== undefined && summaryAtMs > 0 && summaryAtMs < startedAtMs;
  if (!predatesWindow) endSkillCatalogWindow(sessionId);
}

/**
 * A compaction durably replaced the history (or a host reset the segment): the
 * window ends and the next Turn starts a new one against the Skills it finds.
 * Updates may survive in the kept recent tail, so a stated deviation becomes
 * unknown and the next Turn sends an update that supersedes them; nothing to
 * supersede when the newest one said all Skills are as shown. Never creates state.
 */
export function endSkillCatalogWindow(sessionId: string): void {
  const state = states.get(sessionId);
  if (!state) return;
  state.window = undefined;
  state.unsentWindow = undefined;
  retirePendingNotice(state);
  if (state.told?.size) state.told = undefined;
  state.addedInWindow.clear();
  state.changedInWindow.clear();
  state.pending = undefined;
  state.endedByCompaction = true;
}

/**
 * User messages that may have carried updates left the history (a rewind, a
 * retracted Turn, a repair): what the model was told becomes unknown and the
 * next Turn states the full deviation again. The latest update waits to be sent
 * again, and the next request checks the history for updates of an earlier
 * process. The window stays, so the prompt cache is unaffected. Never creates state.
 */
export function forgetSkillCatalogAnnouncements(sessionId: string): void {
  const state = states.get(sessionId);
  if (!state) return;
  state.told = undefined;
  state.newestNotice = undefined;
  if (state.pending) state.pending.confirmed = false;
  state.historyChecked = false;
}

/** Drops everything kept for a deleted Session. */
export function disposeSkillCatalogSession(sessionId: string): void {
  states.delete(sessionId);
}

/** Skills an update of this window announced as added, sent or still pending. */
function announcedAdded(state: Readonly<SkillCatalogSessionState>, key: string): boolean {
  return state.addedInWindow.has(key) || state.pending?.deviation.get(key)?.status === 'added';
}

/** How the latest committed Turn's prompt shows `name`. */
export function skillCatalogListing(sessionId: string, name: string): SkillCatalogListing {
  const state = states.get(sessionId);
  if (!state?.turn) return 'unlisted';
  const key = normalizeSkillUsageKey(name);
  const listed = state.turn.listing.get(key);
  if (listed) return listed;
  return !state.turn.shadow && announcedAdded(state, key) ? 'notice' : 'unlisted';
}

/**
 * `name` is in the catalog the latest Turn shows or an update of this window
 * announced it as added, but the latest live Skills lack it. Shadow mode shows
 * the live Skills, so nothing is unavailable there.
 */
export function isSkillUnavailableInWindow(sessionId: string, name: string): boolean {
  const state = states.get(sessionId);
  if (!state?.turn || state.turn.shadow) return false;
  const key = normalizeSkillUsageKey(name);
  if (state.turn.live.has(key)) return false;
  // The window the latest Turn shows: the one it planned, in effect or not.
  const window = state.unsentWindow?.window ?? state.window;
  return Boolean(window?.entries.has(key)) || announcedAdded(state, key);
}
