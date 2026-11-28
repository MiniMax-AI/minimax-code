import { serverOfToolEntry } from './search-index.js';
import type {
  ToolAvailabilityNotice,
  ToolSearchDeviations,
  ToolSearchWindow,
  ToolSearchWindowInput,
} from './window.js';

/**
 * Process-local Tool Search memory for one session: the prefix window
 * (`ToolSearchWindow`), what the tool-availability notices left in the history
 * tell the model, and the definitions to carry across compaction. Nothing here
 * is persisted: a restarted process starts a new window (one prompt-cache miss
 * at most) and learns from the request history that earlier notices exist.
 *
 * Every notice states the complete current deviation and replaces the earlier
 * ones, so the model's view is the newest notice in the history. Notices are
 * confirmed on send: a Turn's commit only stores its notice (`pending`); the
 * request hook (`createToolSearchContextHook`) confirms it when the newest
 * notice among the user messages after the request's last assistant message is
 * exactly that text. That request was built from the history, so the notice is
 * there whether or not the provider answers it. A notice no request confirmed
 * (a continuation Turn, a Plugin hook that stops the Turn, a failure before the
 * first request or an abort in the compaction hook) may still sit in the
 * history: Pi saves the user message before those hooks run. So what was told
 * is unknown from then on, and the next Turn states the deviation again,
 * superseding it.
 */
export interface ToolSearchSessionState {
  /** Frozen declarations since the session start or the last compaction. */
  window?: ToolSearchWindow;
  /** When the window started (Unix ms); older summaries in resumed history do not end it. */
  windowStartedAtMs?: number;
  /**
   * The window the latest Turn planned, until a response to a request of that
   * Turn arrives (`receiveToolSearchResponse`); absent when the Turn kept the
   * current one.
   */
  unsentWindow?: PlannedToolSearchWindow;
  /**
   * The deviation the newest sent notice stated (none sent: empty). Undefined:
   * unknown, so the next Turn states the full deviation again.
   */
  told: ToolSearchDeviations | undefined;
  /** The text of the notice that stated `told`; none sent or `told` unknown: absent. */
  toldText?: string;
  /** A notice was sent in this Session, or found in its history. */
  everTold: boolean;
  /** Tools a sent notice announced as added in this window, with their servers; missing ones are unavailable. */
  readonly addedInWindow: Map<string, string | undefined>;
  /** Tools a sent notice announced as changed in this window (kept across forgetting what was told). */
  readonly changedInWindow: Set<string>;
  /** The latest Turn's notice, until a request sends it and after (to re-confirm a retry). */
  pending?: PendingToolSearchNotice;
  /** The latest Turn committed a notice; stays when a compaction drops `pending`. */
  latestTurnCarriedNotice?: boolean;
  /** History was searched for notices of an earlier process since it last changed under us. */
  historyChecked: boolean;
  /** Deferred tool names returned by `tool_search`, oldest first, unique. */
  readonly discovered: string[];
  /** Key of the latest compaction summary already handled. */
  lastSummaryKey?: string;
  /** Names discovered before the latest compaction; their definitions are re-supplied. */
  carried: readonly string[];
}

interface PendingToolSearchNotice {
  /** The `<tool-availability-update>` text the Turn's user message carries. */
  readonly text: string;
  readonly deviation: ToolSearchDeviations;
  /** Tools the notice lists as new (outside the window), with their servers. */
  readonly added: ReadonlyMap<string, string | undefined>;
  confirmed: boolean;
}

/** A window a Turn planned, until one of its requests is answered. */
export interface PlannedToolSearchWindow {
  readonly window: ToolSearchWindow | undefined;
  readonly atMs: number;
  readonly onEffective?: () => void;
  /** The Turn's request hook ran for a request: the provider may answer it. */
  sent: boolean;
}

const MAX_SESSIONS = 512;
const states = new Map<string, ToolSearchSessionState>();
const NOTHING_TOLD: ToolSearchWindowInput = {
  told: { snapshot: new Map(), everTold: false },
  addedInWindow: new Map(),
  changedInWindow: new Set(),
};

/** The session's state, created on demand; access refreshes its place in the LRU. */
export function toolSearchSessionState(sessionId: string): ToolSearchSessionState {
  const existing = states.get(sessionId);
  if (existing) {
    states.delete(sessionId);
    states.set(sessionId, existing);
    return existing;
  }
  if (states.size >= MAX_SESSIONS) {
    const oldest = states.keys().next().value;
    if (oldest !== undefined) states.delete(oldest);
  }
  const created: ToolSearchSessionState = {
    told: new Map(),
    everTold: false,
    addedInWindow: new Map(),
    changedInWindow: new Set(),
    historyChecked: false,
    discovered: [],
    carried: [],
  };
  states.set(sessionId, created);
  return created;
}

/** What a catalog build reads; never creates state but refreshes an existing entry. */
export function toolSearchWindowOf(sessionId: string): ToolSearchWindowInput {
  if (!states.has(sessionId)) return NOTHING_TOLD;
  const state = toolSearchSessionState(sessionId);
  return {
    ...(state.window ? { current: state.window } : {}),
    told: hasUnconfirmedNotice(state)
      ? { snapshot: undefined, everTold: true }
      : {
          snapshot: state.told,
          everTold: state.everTold,
          ...(state.toldText === undefined ? {} : { text: state.toldText }),
        },
    addedInWindow: state.addedInWindow,
    changedInWindow: state.changedInWindow,
  };
}

/** The latest notice may be in the history, though no request confirmed it. */
function hasUnconfirmedNotice(state: ToolSearchSessionState): boolean {
  return state.pending !== undefined && !state.pending.confirmed;
}

/** What the notices in the history say can no longer be known. */
function forgetTold(state: ToolSearchSessionState): void {
  state.told = undefined;
  state.toldText = undefined;
}

/** An unconfirmed notice stops being pending: it stays a possible notice in the history. */
function retirePendingNotice(state: ToolSearchSessionState): void {
  if (!hasUnconfirmedNotice(state)) return;
  forgetTold(state);
  state.everTold = true;
}

/** Drops the session's state; a disposed session starts empty if it ever returns. */
export function forgetToolSearchSessionState(sessionId: string): void {
  states.delete(sessionId);
}

/** Test seam: every Session starts empty again. */
export function forgetAllToolSearchSessionStates(): void {
  states.clear();
}

/**
 * Stores a Turn's window (none: Tool Search is off for its model) and the notice
 * its user message carries, which only counts once a request sends it
 * (`confirmToolSearchAnnouncement`); the notice it replaces no longer can.
 * Without a notice the deviation is what the model was already told. A new
 * window only replaces the current one once a request of the Turn is answered
 * (`receiveToolSearchResponse`): a Turn that gets no answer (cancelled before
 * its first request, rejected by the provider, or stopped before the first
 * token) wrote no prompt cache, so it freezes nothing and the next Turn plans
 * afresh. `onEffective` runs when the new window takes effect.
 */
export function commitToolSearchWindow(
  sessionId: string,
  window: ToolSearchWindow | undefined,
  notice: { readonly text: string; readonly availability: ToolAvailabilityNotice } | undefined,
  nowMs: number,
  onEffective?: () => void,
): void {
  const state = toolSearchSessionState(sessionId);
  state.unsentWindow =
    !window || state.window !== window
      ? { window, atMs: nowMs, sent: false, ...(onEffective ? { onEffective } : {}) }
      : undefined;
  retirePendingNotice(state);
  state.latestTurnCarriedNotice = notice !== undefined;
  state.pending = notice
    ? {
        text: notice.text,
        deviation: notice.availability.deviation,
        added: new Map(
          notice.availability.added.map((entry) => [entry.tool.def.name, serverOfToolEntry(entry)]),
        ),
        confirmed: false,
      }
    : undefined;
}

/** The window the latest Turn planned and that has not taken effect; hooks of that Turn hold on to it. */
export function plannedToolSearchWindow(sessionId: string): PlannedToolSearchWindow | undefined {
  return states.get(sessionId)?.unsentWindow;
}

/**
 * A request of the Turn that planned `planned` was answered: that window becomes
 * the Session's. Only when it is still the latest Turn's plan and the Turn's
 * request hook ran for a request: a reply the host made up without a provider
 * request (a `respond` decision ends the hook chain first), or the late answer
 * of an earlier Turn's request, makes no window. Its notice was confirmed on
 * send, earlier; a new window's notice states no deviation, so clearing what
 * notices announced in the old window loses nothing it recorded.
 */
export function receiveToolSearchResponse(
  sessionId: string,
  planned: PlannedToolSearchWindow | undefined,
): void {
  const state = states.get(sessionId);
  const unsent = state?.unsentWindow;
  if (!state || !unsent || unsent !== planned || !unsent.sent) return;
  state.unsentWindow = undefined;
  state.window = unsent.window;
  state.windowStartedAtMs = unsent.window ? unsent.atMs : undefined;
  state.addedInWindow.clear();
  state.changedInWindow.clear();
  try {
    unsent.onEffective?.();
  } catch {
    // Diagnostics must not affect the Turn.
  }
}

/** The window the latest Turn declares: the one it planned, in effect or not. */
export function toolSearchTurnWindow(sessionId: string): ToolSearchWindow | undefined {
  const state = states.get(sessionId);
  return state?.unsentWindow ? state.unsentWindow.window : state?.window;
}

/** The notice still waiting for a request to send it, if any. */
export function pendingToolSearchNotice(sessionId: string): string | undefined {
  const pending = states.get(sessionId)?.pending;
  return pending && !pending.confirmed ? pending.text : undefined;
}

/** A request sent the pending notice: it is now the newest notice in the history. */
export function confirmToolSearchAnnouncement(sessionId: string): void {
  const state = states.get(sessionId);
  const pending = state?.pending;
  if (!state || !pending || pending.confirmed) return;
  pending.confirmed = true;
  state.told = pending.deviation;
  state.toldText = pending.text;
  state.everTold = true;
  for (const [name, server] of pending.added) state.addedInWindow.set(name, server);
  for (const [name, entry] of pending.deviation) {
    if (entry.status === 'changed') state.changedInWindow.add(name);
  }
}

/**
 * The request history holds a notice this process did not send (a restart, a
 * fork): the next Turn states the full deviation, superseding it. Checked on the
 * first request of a Session that has told nothing yet, and again after the
 * history was rewound or restored (it may bring back such a notice from before a
 * compaction). Never creates state.
 */
export function noteToolSearchNoticeInHistory(sessionId: string, hasNotice: () => boolean): void {
  const state = states.get(sessionId);
  if (!state || state.historyChecked) return;
  state.historyChecked = true;
  if (state.everTold || !hasNotice()) return;
  state.everTold = true;
  forgetTold(state);
}

/**
 * A compaction durably replaced the history: the window ends and the next Turn
 * plans afresh against the tools it sees then. Notices may survive in the kept
 * recent tail, so a stated deviation becomes unknown and the next Turn sends a
 * notice that supersedes them. Nothing to supersede when the newest notice said
 * all tools are as shown: the tail keeps that one or none. Each host calls it
 * where the replacement is committed (local: next to the PTC mode refresh;
 * cloud: after the context lifecycle persisted the snapshot), so the very next
 * Turn already starts a new window; the request hook (`noteCompaction`) also
 * ends it on seeing a new summary. That is the fallback for history resumed
 * after a restart, and on cloud it usually comes first, because the hook runs
 * in the compacting request's pipeline before the commit. Never creates state.
 */
export function endToolSearchWindow(sessionId: string): void {
  const state = states.get(sessionId);
  if (!state) return;
  state.window = undefined;
  state.windowStartedAtMs = undefined;
  state.unsentWindow = undefined;
  retirePendingNotice(state);
  if (state.told?.size) forgetTold(state);
  state.addedInWindow.clear();
  state.changedInWindow.clear();
  state.pending = undefined;
}

/**
 * User messages that may have carried notices left the history (a rewind, a
 * retracted Turn, a safety recall): what the model was told becomes unknown and
 * the next Turn states the full deviation again. The latest notice waits to be
 * sent again: a retry that re-sends the same user message confirms it once more.
 * The restored history may hold a notice of an earlier process (from before a
 * compaction), so the next request checks the history again. The window and its
 * declarations stay, so the prompt cache is unaffected. Never creates state.
 */
export function forgetToolSearchAnnouncements(sessionId: string): void {
  const state = states.get(sessionId);
  if (!state) return;
  forgetTold(state);
  if (state.pending) state.pending.confirmed = false;
  state.historyChecked = false;
}

/**
 * Only the latest Turn left the history (a safety recall restores the history
 * before it, earlier notices included): what was told changes only when that
 * Turn carried a notice, sent or not, even when a compaction during the Turn
 * already dropped it as pending. Never creates state.
 */
export function forgetLatestTurnToolSearchNotice(sessionId: string): void {
  if (states.get(sessionId)?.latestTurnCarriedNotice) forgetToolSearchAnnouncements(sessionId);
}

export function recordDiscoveredTools(sessionId: string, names: readonly string[]): void {
  const state = toolSearchSessionState(sessionId);
  for (const name of names) {
    const at = state.discovered.indexOf(name);
    if (at !== -1) state.discovered.splice(at, 1);
    state.discovered.push(name);
  }
}

/**
 * Called once per newly seen compaction summary: the window ends, and
 * everything discovered so far becomes the carried set. A summary written
 * before the window started (history resumed after a restart) keeps the window;
 * a summary without a usable time ends it.
 */
export function noteCompaction(
  sessionId: string,
  summaryKey: string,
  summaryAtMs: number,
): boolean {
  const state = toolSearchSessionState(sessionId);
  if (state.lastSummaryKey === summaryKey) return false;
  state.lastSummaryKey = summaryKey;
  // A window not yet in effect starts when its Turn planned it: the history of a
  // resumed Session can hold older summaries before its first response arrives.
  const startedAtMs = state.unsentWindow?.window
    ? state.unsentWindow.atMs
    : state.windowStartedAtMs;
  const predatesWindow = startedAtMs !== undefined && summaryAtMs > 0 && summaryAtMs < startedAtMs;
  if (!predatesWindow) endToolSearchWindow(sessionId);
  state.carried = [...state.discovered];
  return true;
}
