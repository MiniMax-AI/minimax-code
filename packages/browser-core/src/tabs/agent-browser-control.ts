/**
 * Agent control of one session's Browser: which tab the Agent may write to
 * (the controlled tab, held as a per-turn lease), who owns each tab, and what
 * happens to Agent pages when the turn ends. Shared by every provider (the
 * Electron FilePanel and headless Chrome).
 *
 * Pure bookkeeping: the provider applies the decisions (close pages, block
 * input, persist owners). See `.harness/docs/specs/browser-tab-control.md`
 * for the product rules this encodes.
 */

export type BrowserControlMode = 'idle' | 'agent' | 'user';
export type BrowserTabOwner = 'agent' | 'user';
export type BrowserTabRetention = 'temporary' | 'carryover' | 'deliverable';
export type BrowserTakeoverReason = 'button' | 'close' | 'navigation';

export interface BrowserTabControlRecord {
  sessionId: string;
  owner: BrowserTabOwner;
  retention: BrowserTabRetention;
  openerTabId?: number;
  /** The user clicked, typed or navigated in this page during the current turn. */
  userTouched?: boolean;
  /**
   * The user switched to this page themselves during the current turn. A page
   * the panel or the Agent put on screen (show_tab, open_tab { show }, the
   * session's first page) does not count.
   */
  userViewed?: boolean;
  /** Taken over by the user; the next turn's tab listing reports it. */
  takenOverAt?: number;
  takenOverTurnId?: string;
}

export interface BrowserSessionControl {
  mode: BrowserControlMode;
  revision: number;
  turnId?: string;
  controlledTabId: number | null;
  ephemeral: boolean;
  takeover?: { tabId: number; at: number; reason: BrowserTakeoverReason; turnId?: string };
  /** The last turns finalizeTurn tidied: a repeated or late turn end of one changes nothing. */
  finalizedTurnIds?: string[];
}

/** How many finalized turn ids a session remembers. */
const FINALIZED_TURN_MEMORY = 8;

export interface BrowserControlSnapshot {
  readonly mode: BrowserControlMode;
  readonly revision: number;
  readonly controlledTabId: number | null;
}

export interface BrowserTurnFinalization {
  /** Agent pages to close now. */
  readonly close: number[];
  /** Agent pages that become the user's pages (delivered or touched by the user). */
  readonly promoteToUser: number[];
}

export interface BeginAgentCallResult {
  /**
   * A previous turn that never reported its end. Nothing changed: finalize it,
   * then begin the call again.
   */
  readonly unfinishedTurnId?: string;
  readonly newTurn: boolean;
}

export const BROWSER_USER_TAKEOVER_MESSAGE =
  'BROWSER_USER_TAKEOVER: The user has taken over the browser. Stop browser actions for this turn. In your reply, tell the user in plain words which step you stopped at and what they can do next, then end the turn; do not call ask_user to ask whether to continue (its answer does not return control). Do not retry or reacquire control in this turn; you can continue after the user sends a new message.';

export const TAB_NOT_CONTROLLED_MESSAGE =
  'TAB_NOT_CONTROLLED: No tab is selected for Agent control. Call list_tabs, then select_tab an existing tab or open_tab a new one before this action.';

export const MINIAPP_NAVIGATE_BLOCKED_MESSAGE =
  'CURRENT_TAB_OCCUPIED: This tab is a Mini App; navigate cannot replace its page. For a page inside the app, click its links or use the miniapp open action with a path; for any other web page, use open_tab { url }.';

export function miniAppNavigateBlockedError(): Error & { code: string } {
  return Object.assign(new Error(MINIAPP_NAVIGATE_BLOCKED_MESSAGE), {
    code: 'CURRENT_TAB_OCCUPIED',
  });
}

export function browserUserTakeoverError(): Error & { code: string } {
  return Object.assign(new Error(BROWSER_USER_TAKEOVER_MESSAGE), {
    code: 'BROWSER_USER_TAKEOVER',
  });
}

export function tabNotControlledError(detail?: string): Error & { code: string } {
  return Object.assign(
    new Error(detail ? `${TAB_NOT_CONTROLLED_MESSAGE} ${detail}` : TAB_NOT_CONTROLLED_MESSAGE),
    { code: 'TAB_NOT_CONTROLLED' },
  );
}

/** Agent actions that only read a page; they never need the controlled tab. */
export const AGENT_READ_ACTIONS: Readonly<Record<string, true>> = {
  inspect: true,
  query: true,
  screenshot: true,
  wait: true,
  wait_for: true,
  get_dom: true,
  verify_text: true,
  inspect_editable_targets: true,
  get_js_dialog: true,
};

/** Browser program ops that only read a page (the program forms of AGENT_READ_ACTIONS). */
export const PROGRAM_READ_OPS: Readonly<Record<string, true>> = {
  read: true,
  readAll: true,
  rows: true,
  waitFor: true,
  waitForResponse: true,
  observe: true,
  url: true,
  title: true,
  screenshot: true,
  networkCheckpoint: true,
};

type ControlListener = (sessionId: string, snapshot: BrowserControlSnapshot) => void;

export class AgentBrowserControl {
  private readonly sessions = new Map<string, BrowserSessionControl>();
  private readonly tabs = new Map<number, BrowserTabControlRecord>();

  constructor(private readonly onChange?: ControlListener) {}

  session(sessionId: string): BrowserSessionControl {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { mode: 'idle', revision: 0, controlledTabId: null, ephemeral: false };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  peekSession(sessionId: string): BrowserSessionControl | undefined {
    return this.sessions.get(sessionId);
  }

  snapshot(sessionId: string): BrowserControlSnapshot {
    const state = this.sessions.get(sessionId);
    return {
      mode: state?.mode ?? 'idle',
      revision: state?.revision ?? 0,
      controlledTabId: state?.controlledTabId ?? null,
    };
  }

  isEphemeral(sessionId: string | null | undefined): boolean {
    return typeof sessionId === 'string' && this.sessions.get(sessionId)?.ephemeral === true;
  }

  markEphemeral(sessionId: string): void {
    this.session(sessionId).ephemeral = true;
  }

  // ---- tabs ---------------------------------------------------------------

  registerTab(
    sessionId: string,
    tabId: number,
    owner: BrowserTabOwner,
    extra: { openerTabId?: number } = {},
  ): BrowserTabControlRecord {
    const record: BrowserTabControlRecord = {
      sessionId,
      owner,
      retention: 'temporary',
      ...(extra.openerTabId !== undefined ? { openerTabId: extra.openerTabId } : {}),
    };
    this.tabs.set(tabId, record);
    return record;
  }

  tab(tabId: number): BrowserTabControlRecord | undefined {
    return this.tabs.get(tabId);
  }

  /** Unregistered pages (opened by the user or restored without an owner) belong to the user. */
  ownerOf(tabId: number): BrowserTabOwner {
    return this.tabs.get(tabId)?.owner ?? 'user';
  }

  setRetention(tabId: number, retention: BrowserTabRetention): void {
    const record = this.tabs.get(tabId);
    if (record) record.retention = retention;
  }

  promoteToUser(tabId: number): void {
    const record = this.tabs.get(tabId);
    if (!record) return;
    record.owner = 'user';
    record.retention = 'temporary';
  }

  noteUserTouched(tabId: number): void {
    const record = this.tabs.get(tabId);
    if (record) record.userTouched = true;
  }

  noteUserViewed(tabId: number): void {
    const record = this.tabs.get(tabId);
    if (record) record.userViewed = true;
  }

  /** Reads and clears the "taken over last turn" marker for a tab listing. */
  consumeTakenOver(tabId: number): boolean {
    const record = this.tabs.get(tabId);
    if (!record?.takenOverAt) return false;
    delete record.takenOverAt;
    delete record.takenOverTurnId;
    return true;
  }

  /**
   * A tab is gone. When it held the lease, the lease returns to the page that
   * opened it (a popup closing itself) unless the Agent or the user closed it.
   * The opener may be the user's page, which has no record: the popup's own
   * record names the session, and `isAlive` says whether the opener is still
   * open in that session.
   */
  forgetTab(
    tabId: number,
    options: {
      closedBy?: 'agent' | 'user';
      isAlive?: (tabId: number, sessionId: string) => boolean;
    } = {},
  ): { sessionId?: string; wasControlled: boolean; leaseReturnedTo?: number } {
    const record = this.tabs.get(tabId);
    this.tabs.delete(tabId);
    for (const [sessionId, state] of this.sessions) {
      if (state.controlledTabId !== tabId) continue;
      const opener = record?.openerTabId;
      const openerSessionId =
        opener === undefined ? undefined : (this.tabs.get(opener)?.sessionId ?? record?.sessionId);
      if (
        options.closedBy === undefined &&
        opener !== undefined &&
        openerSessionId === sessionId &&
        (options.isAlive?.(opener, sessionId) ?? true)
      ) {
        state.controlledTabId = opener;
        this.emit(sessionId);
        return { sessionId, wasControlled: true, leaseReturnedTo: opener };
      }
      state.controlledTabId = null;
      this.emit(sessionId);
      return { sessionId, wasControlled: true };
    }
    return { ...(record ? { sessionId: record.sessionId } : {}), wasControlled: false };
  }

  // ---- lease --------------------------------------------------------------

  /**
   * Every Agent Browser call starts here. A new turn unlocks a takeover and
   * re-enters agent mode without a lease; the model selects or opens a tab.
   */
  beginAgentCall(
    sessionId: string,
    turnId: string | undefined,
    options: { ephemeral?: boolean } = {},
  ): BeginAgentCallResult {
    const state = this.session(sessionId);
    if (options.ephemeral) state.ephemeral = true;
    if (!turnId || state.turnId === turnId) {
      if (state.mode === 'idle') {
        state.mode = 'agent';
        this.emit(sessionId);
      }
      return { newTurn: false };
    }
    if (state.turnId !== undefined && state.mode === 'agent') {
      return { newTurn: false, unfinishedTurnId: state.turnId };
    }
    state.turnId = turnId;
    state.revision += 1;
    state.mode = 'agent';
    delete state.takeover;
    this.emit(sessionId);
    return { newTurn: true };
  }

  assertNotTakenOver(sessionId: string): void {
    if (this.sessions.get(sessionId)?.mode === 'user') throw browserUserTakeoverError();
  }

  controlledTabId(sessionId: string): number | null {
    return this.sessions.get(sessionId)?.controlledTabId ?? null;
  }

  /**
   * Moves the lease. Selecting a tab bumps the revision so a stale in-flight
   * action notices; a popup the Agent itself opened does not.
   */
  grantLease(sessionId: string, tabId: number, options: { bumpRevision?: boolean } = {}): void {
    const state = this.session(sessionId);
    if (state.mode === 'idle') state.mode = 'agent';
    if (state.controlledTabId === tabId && !options.bumpRevision) return;
    state.controlledTabId = tabId;
    if (options.bumpRevision) state.revision += 1;
    this.emit(sessionId);
  }

  releaseLease(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state || state.controlledTabId === null) return;
    state.controlledTabId = null;
    this.emit(sessionId);
  }

  /** User input on this tab is blocked while the Agent holds it in agent mode. */
  shouldBlockUserInput(tabId: number): boolean {
    const record = this.tabs.get(tabId);
    const sessionId = record?.sessionId ?? this.sessionOfControlledTab(tabId);
    if (!sessionId) return false;
    const state = this.sessions.get(sessionId);
    return state?.mode === 'agent' && state.controlledTabId === tabId && !state.ephemeral;
  }

  sessionOfControlledTab(tabId: number): string | undefined {
    for (const [sessionId, state] of this.sessions) {
      if (state.controlledTabId === tabId) return sessionId;
    }
    return undefined;
  }

  /**
   * The user takes the controlled tab (button or closing it). Only valid in
   * agent mode on the controlled tab; returns false otherwise.
   */
  takeover(sessionId: string, tabId: number, reason: BrowserTakeoverReason, at: number): boolean {
    const state = this.sessions.get(sessionId);
    if (!state || state.mode !== 'agent' || state.controlledTabId !== tabId) return false;
    state.mode = 'user';
    state.revision += 1;
    state.takeover = { tabId, at, reason, ...(state.turnId ? { turnId: state.turnId } : {}) };
    if (reason === 'close') state.controlledTabId = null;
    const record = this.tabs.get(tabId);
    if (record) {
      record.owner = 'user';
      record.retention = 'temporary';
      record.takenOverAt = at;
      if (state.turnId) record.takenOverTurnId = state.turnId;
      else delete record.takenOverTurnId;
    }
    this.emit(sessionId);
    return true;
  }

  /**
   * The model hands the controlled page to the user (release_tab): sign-in,
   * verification or another step only the user can do. The lease goes, so the
   * user's input is no longer blocked and does not count as a takeover; the
   * Agent selects the tab again to write it. An Agent page it was using this
   * turn stays through this turn end (carryover): the user may act in it after
   * an answer that does not wait (async ask_user) ends the turn. `tabId`, when
   * given, must be the controlled tab. Returns the released tab, or null when
   * nothing was controlled (a repeated release changes nothing).
   */
  releaseControl(sessionId: string, tabId?: number): number | null {
    const state = this.sessions.get(sessionId);
    const controlled = state?.controlledTabId ?? null;
    // Releasing twice, or after the turn already lost the lease, is a no-op.
    if (!state || controlled === null) return null;
    if (tabId !== undefined && tabId !== controlled) {
      throw tabNotControlledError('release_tab names a tab you do not control');
    }
    const record = this.tabs.get(controlled);
    if (record?.owner === 'agent' && record.retention === 'temporary') {
      record.retention = 'carryover';
    }
    state.controlledTabId = null;
    this.emit(sessionId);
    return controlled;
  }

  /**
   * Turn end (completed, failed or stopped). Releases the lease and decides
   * which Agent pages close: every temporary Agent page the user did not use
   * closes, so pages the Agent opens last one turn unless mark_tab keeps them.
   * A carryover mark keeps a page through this turn end only; the next turn
   * end closes it unless the Agent marks it again. A takeover stays locked
   * until the next turn. `visibleTabId` is the page on screen in a visible
   * Browser panel (null without one). A page the user switched to and is
   * still looking at stays, like a touched page. Being on screen alone does
   * not keep an Agent page: the panel or the Agent may have put it there, and
   * only mark_tab keeps those (decision T10).
   *
   * A turn without Browser calls (it only answered in text, or an automatic
   * continuation that did not touch the Browser) does not count: pages, marks
   * and takeover reports wait for the next turn that calls the Browser. The
   * end of another turn while one is running (a late end of a turn already
   * tidied by beginAgentCall), or a repeated end, changes nothing.
   */
  finalizeTurn(
    sessionId: string,
    turnId: string | undefined,
    context: {
      visibleTabId: number | null;
      isMiniApp: (tabId: number) => boolean;
      sessionTabIds: readonly number[];
    },
  ): BrowserTurnFinalization {
    const state = this.sessions.get(sessionId);
    const running = state?.mode === 'agent';
    if (state && turnId) {
      if (state.turnId && state.turnId !== turnId && running) {
        return { close: [], promoteToUser: [] };
      }
      if (state.finalizedTurnIds?.includes(turnId)) {
        // Calls carried this turn's id after its end: release control, close nothing.
        if (running) this.releaseTurn(sessionId, state);
        return { close: [], promoteToUser: [] };
      }
      state.finalizedTurnIds = [
        ...(state.finalizedTurnIds ?? []).slice(1 - FINALIZED_TURN_MEMORY),
        turnId,
      ];
    }
    // Only a turn that called the Browser tidies pages (its calls carried this turn's id, or
    // none while the session is in Agent control); the others leave everything as it was.
    if (turnId && state?.turnId !== turnId && !running) return { close: [], promoteToUser: [] };
    const close: number[] = [];
    const promoteToUser: number[] = [];
    for (const tabId of context.sessionTabIds) {
      const record = this.tabs.get(tabId);
      if (!record || record.sessionId !== sessionId) continue;
      const touched =
        record.userTouched === true ||
        record.takenOverAt !== undefined ||
        (record.userViewed === true && context.visibleTabId === tabId);
      delete record.userTouched;
      delete record.userViewed;
      // A takeover is reported during the turn after it, then forgotten.
      if (record.takenOverAt !== undefined && record.takenOverTurnId !== turnId) {
        delete record.takenOverAt;
        delete record.takenOverTurnId;
      }
      if (record.owner === 'user') continue;
      if (context.isMiniApp(tabId)) continue;
      if (state?.ephemeral) continue;
      if (record.retention === 'deliverable' || touched) {
        record.owner = 'user';
        record.retention = 'temporary';
        promoteToUser.push(tabId);
        continue;
      }
      if (record.retention === 'carryover') {
        // Kept for the next turn only; that turn's end closes it unless marked again.
        record.retention = 'temporary';
        continue;
      }
      close.push(tabId);
    }
    if (state) this.releaseTurn(sessionId, state);
    return { close, promoteToUser };
  }

  /** The turn's lease goes; a takeover stays locked until the next turn. */
  private releaseTurn(sessionId: string, state: BrowserSessionControl): void {
    state.controlledTabId = null;
    if (state.mode !== 'user') state.mode = 'idle';
    this.emit(sessionId);
  }

  /**
   * A draft session's Browser moved to its real session id. A session that
   * already has control state keeps it; the moved pages keep their records.
   */
  moveSession(fromSessionId: string, toSessionId: string): void {
    if (fromSessionId === toSessionId) return;
    for (const record of this.tabs.values()) {
      if (record.sessionId === fromSessionId) record.sessionId = toSessionId;
    }
    const source = this.sessions.get(fromSessionId);
    if (!source) return;
    this.sessions.delete(fromSessionId);
    if (!this.sessions.has(toSessionId)) {
      this.sessions.set(toSessionId, source);
      this.emit(toSessionId);
    }
  }

  dropSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    for (const [tabId, record] of this.tabs) {
      if (record.sessionId === sessionId) this.tabs.delete(tabId);
    }
  }

  private emit(sessionId: string): void {
    try {
      this.onChange?.(sessionId, this.snapshot(sessionId));
    } catch {
      // Renderer notification is best-effort.
    }
  }
}
