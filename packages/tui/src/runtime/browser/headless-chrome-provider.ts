import {
  BROWSER_PROGRAM_OP_ACTION,
  type LocalBrowserAdapter,
  type LocalBrowserAdapterAction,
  type LocalBrowserLifecycleEvent,
  type LocalBrowserToolAction,
  type LocalRuntimeToolContext,
} from '@mavis/agent-tools/desktop';
import { createHash } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join, sep } from 'node:path';

import {
  AGENT_READ_ACTIONS,
  AgentBrowserControl,
  BROWSER_TAB_FAILURES,
  BrowserCore,
  browserJsDialogActiveResult,
  BrowserRelatedPageDialogPause,
  IsolatedClipboardProvider,
  browserErrorTripleResult,
  browserTabFailure,
  formatBrowserErrorTriple,
  isRecord,
  PROGRAM_POPUP_POLL_MS,
  PROGRAM_POPUP_WAIT_MS,
  PROGRAM_READ_OPS,
  PROGRAM_TAB_OPS,
  programOpTabId,
  programTabFailure,
  programTabNotControlledError,
  programTabResult,
  programThrownResult,
  readBrowserTabId,
  CARRYOVER_NOTICE,
  PROGRAM_CARRYOVER_NOTICE,
  readProgramKeepOp,
  tabNotControlledError,
  withTimeout,
  type BrowserCoreSession,
  type BrowserEvaluateOptions,
  type BrowserAttachedFrame,
  type BrowserTabFailure,
  type BrowserTransport,
  type BrowserTransportCommandOptions,
  type BrowserTransportEvent,
  type BrowserTransportEventListener,
  type ClipboardProvider,
} from '@mavis/browser-core';
import {
  HeadlessChromeBrowser,
  isChromeProfileInUse,
  type HeadlessChromeLaunchOptions,
  type HeadlessChromePage,
  resolveHeadlessDownloadDir,
  type RelatedPageClaim,
} from './headless-chrome-transport.js';

const HEADLESS_ACTIONS = [
  'inspect',
  'query',
  'navigate',
  'open_tab',
  'list_tabs',
  'select_tab',
  'close_tab',
  'mark_tab',
  'back',
  'forward',
  'reload',
  'click',
  'click_and_wait_for_navigation',
  'double_click',
  'triple_click',
  'drag',
  'fill',
  'type',
  'press_key',
  'check',
  'uncheck',
  'select_option',
  'upload_files',
  'paste',
  'scroll',
  'hover',
  'wait',
  'wait_for',
  'get_dom',
  'screenshot',
  'verify_text',
  'inspect_editable_targets',
  'run_script',
  'get_js_dialog',
  'handle_js_dialog',
] as const satisfies readonly LocalBrowserToolAction[];

/** Tabs a session keeps besides one more (the TAB_LIMIT_REACHED bound). */
const MAX_PRESERVED_TABS_PER_SESSION = 8;
const MAX_LIVE_BROWSER_SESSIONS = 4;
const TAB_PROBE_TIMEOUT_MS = 1_000;
const JS_DIALOG_DISMISS_TIMEOUT_MS = 1_000;

/**
 * Open tabs of one logical session, each tab's Browser Core session by its
 * tab id. Tab ids are unique across the provider: they key the shared
 * AgentBrowserControl, which owns the lease, owners, openers and retention.
 */
interface HeadlessTabSet {
  readonly tabs: Map<number, BrowserCoreSession>;
  /** The tab the Agent controlled last; reads without a controlled tab use it. */
  lastControlledTabId: number | null;
}

/** A tab a page action runs on. */
interface TargetTab {
  readonly tabId: number;
  readonly session: BrowserCoreSession;
  /** The controlled tab closed itself; the lease went back to the tab that opened it. */
  readonly leaseReturnedTo?: number;
}

export interface HeadlessChromeBrowserProviderOptions extends Omit<
  HeadlessChromeLaunchOptions,
  'chromeForTestingDir'
> {
  /** Chrome for Testing cache; defaults under `dataDir`, shared by every session. */
  readonly chromeForTestingDir?: string;
  /** Creates one isolated clipboard for each logical TUI session. */
  readonly clipboardProviderFactory?: (sessionId: string) => ClipboardProvider;
  /** `beta.browserReadV2`: reads carry live form-control state. */
  readonly browserReadV2?: boolean;
  /** Close a session's Chrome after this long without Browser actions. */
  readonly idleCloseMs?: number;
}

/** Same default as omp's `browser.idleCloseSec`. */
const DEFAULT_IDLE_CLOSE_MS = 30 * 60_000;

interface IdleCloseTimer {
  readonly timer: NodeJS.Timeout;
  readonly browser: Promise<HeadlessChromeBrowser>;
}

interface SessionProfile {
  kind: 'persistent' | 'isolated';
  initialized: boolean;
}

/**
 * Native headless provider backed by the provider-neutral Browser Core.
 * Chrome owns process/profile state; Browser Core owns refs, semantic snapshots,
 * pagination and action/effect semantics.
 */
export class HeadlessChromeBrowserProvider implements LocalBrowserAdapter {
  /** A session's first page while it is being created (the session had no tab). */
  private readonly blankTabCreations = new Map<string, Promise<TargetTab>>();
  private readonly tabSets = new Map<string, HeadlessTabSet>();
  /** Agent tab lease, page ownership and turn-end tidying of every session. */
  private readonly control = new AgentBrowserControl();
  private nextTabId = 1;
  /** Sub-Agent sessions: an isolated profile, removed when the sub-Agent's turn ends. */
  private readonly ephemeralSessions = new Set<string>();
  private readonly core: BrowserCore<LocalBrowserToolAction>;
  private readonly browsers = new Map<string, Promise<HeadlessChromeBrowser>>();
  private readonly sessionInitializationControllers = new Map<string, AbortController>();
  private readonly browserExitDisposers = new Map<string, () => void>();
  private readonly clipboardProviders = new Map<string, ClipboardProvider>();
  private readonly sessionClosingPromises = new Map<string, Promise<void>>();
  private readonly sessionActivity = new Map<string, number>();
  private readonly activeExecutions = new Map<string, number>();
  private readonly idleCloseTimers = new Map<string, IdleCloseTimer>();
  private readonly sessionProfiles = new Map<string, SessionProfile>();
  private readonly sessionDisposals = new Map<string, Promise<void>>();
  private activitySequence = 0;
  /** Logical session reserving the shared profile, including while its Chrome is idle. */
  private persistentProfileOwner: string | undefined;
  private closed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly options: HeadlessChromeBrowserProviderOptions) {
    this.core = new BrowserCore({
      provider: 'native-headless-chrome',
      version: 1,
      actions: HEADLESS_ACTIONS,
    });
  }

  getCapabilities() {
    return {
      ...this.core.getCapabilities(),
      interactiveTakeover: false,
      programOps: true,
    } as const;
  }

  /**
   * Closes the session's Browser and removes its storage. `keepDownloads`
   * leaves the files it downloaded in place: a sub-Agent's turn end hands
   * their paths to its parent.
   */
  disposeSession(sessionId: string, options: { keepDownloads?: boolean } = {}): Promise<void> {
    const existing = this.sessionDisposals.get(sessionId);
    if (existing) return existing;
    this.control.dropSession(sessionId);
    const disposal = (async () => {
      await this.closeSession(sessionId);
      await disposeHeadlessSessionStorage(this.options, sessionId, options);
      this.sessionProfiles.delete(sessionId);
      this.releasePersistentProfile(sessionId);
      this.ephemeralSessions.delete(sessionId);
    })();
    this.sessionDisposals.set(sessionId, disposal);
    void disposal.then(
      () => this.sessionDisposals.delete(sessionId),
      () => undefined,
    );
    return disposal;
  }

  /**
   * Turn lifecycle from the Runtime. Turn end releases the lease and closes
   * the Agent's temporary pages that were not marked; a sub-Agent's turn end
   * closes its whole Browser and removes its isolated profile and session
   * data, keeping its downloads. Headless has no user, so no page counts as
   * used by the user.
   */
  notifyLifecycle(event: LocalBrowserLifecycleEvent): void {
    const sessionId = event.sessionId.trim();
    if (!sessionId || this.closed) return;
    if (event.type !== 'turn_end') return;
    if (
      event.ephemeral === true ||
      this.control.isEphemeral(sessionId) ||
      this.ephemeralSessions.has(sessionId)
    ) {
      void this.disposeSession(sessionId, { keepDownloads: true }).catch(() => undefined);
      return;
    }
    if (!this.control.peekSession(sessionId)) return;
    void this.finalizeTurn(sessionId, event.turnId).catch(() => undefined);
  }

  async execute(
    ctx: LocalRuntimeToolContext,
    action: LocalBrowserAdapterAction,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (action === BROWSER_PROGRAM_OP_ACTION) return this.executeProgramOp(ctx, input, signal);
    this.core.assertAction(action);
    this.core.assertNotAborted(signal);
    const sessionId = this.core.assertContext(ctx);
    if (this.closed) throw new Error('Headless browser provider is closed');
    const actionInput = normalizeHeadlessActionInput(action, input);
    this.markSessionActive(sessionId);
    let session: BrowserCoreSession | undefined;
    try {
      await this.beginAgentCall(sessionId, ctx, signal);
      switch (action) {
        case 'open_tab':
          return await this.openTab(sessionId, actionInput, signal);
        case 'list_tabs':
          return await this.listTabs(sessionId, signal);
        case 'select_tab':
          return await this.selectTab(sessionId, actionInput, signal);
        case 'close_tab':
          return await this.closeTab(sessionId, actionInput);
        case 'mark_tab':
          return this.markTab(sessionId, actionInput);
        default:
          break;
      }
      const read = AGENT_READ_ACTIONS[action] === true;
      const target = await this.resolveTargetTab(sessionId, read, signal);
      session = target.session;
      if (!read && target.leaseReturnedTo !== undefined) {
        // The write was meant for the popup; the opener's page may not be what the model expects.
        return leaseReturnedWriteFailure(action, target.leaseReturnedTo);
      }
      const result = await this.executePageAction(sessionId, target, action, actionInput, signal);
      let leaseReturnedTo = target.leaseReturnedTo;
      // A popup's own button (sign-in done, "close") may close the popup: control returns now.
      const set = this.tabSets.get(sessionId);
      if (
        !read &&
        set &&
        this.control.controlledTabId(sessionId) === target.tabId &&
        this.control.tab(target.tabId)?.openerTabId !== undefined &&
        !(await isHeadlessTabAlive(target.session, signal))
      ) {
        leaseReturnedTo = await this.closeTabs(set, [target.tabId]);
      }
      if (leaseReturnedTo === undefined || !isRecord(result)) return result;
      return {
        ...result,
        leaseReturnedTo,
        controlledTabId: this.control.controlledTabId(sessionId),
        notice: POPUP_CLOSED_NOTICE,
      };
    } catch (error) {
      // A failed page-session reset cannot be repaired in place. Evict the
      // provider-owned Chrome/profile resources so the next action starts from
      // a clean session instead of reusing an uncertain protocol connection.
      if (session?.requiresRecreation) await this.closeSession(sessionId);
      throw error;
    } finally {
      this.markSessionIdle(sessionId);
      await this.evictIdleSessions(sessionId);
    }
  }

  /**
   * Enters the call's turn, after waiting for a closing or disposed Chrome of
   * the session. A turn that never reported its end is tidied first.
   */
  private async beginAgentCall(
    sessionId: string,
    ctx: LocalRuntimeToolContext,
    signal?: AbortSignal,
  ): Promise<void> {
    const ephemeral = ctx.browserEphemeral === true;
    if (ephemeral) this.ephemeralSessions.add(sessionId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const begun = this.control.beginAgentCall(
        sessionId,
        ctx.turnId,
        ephemeral ? { ephemeral: true } : {},
      );
      if (!begun.unfinishedTurnId) break;
      await this.finalizeTurn(sessionId, begun.unfinishedTurnId);
    }
    const disposal = this.sessionDisposals.get(sessionId);
    if (disposal) await disposal;
    const closing = this.sessionClosingPromises.get(sessionId);
    if (closing) await closing;
    throwIfAborted(signal);
    if (this.closed) throw new Error('Headless browser provider is closed');
  }

  /** Turn end: release the lease, close the Agent's temporary pages. */
  private async finalizeTurn(sessionId: string, turnId: string | undefined): Promise<void> {
    const set = this.tabSets.get(sessionId);
    const outcome = this.control.finalizeTurn(sessionId, turnId, {
      visibleTabId: null,
      isMiniApp: () => false,
      sessionTabIds: set ? [...set.tabs.keys()] : [],
    });
    if (set && outcome.close.length > 0) await this.closeTabs(set, outcome.close, 'agent');
  }

  /**
   * The internal action `program_op`: one page operation of a Browser program
   * (run_script in program mode), never a model action. Every page op names
   * its tab. A read may use any tab of the session. A write on an Agent page
   * that is not the controlled tab takes the lease first (the program form of
   * select_tab, reported as `leaseTaken`); a write on a user page still needs
   * page.bringToFront(). A controlled popup that closed itself gives the lease
   * back to its opener (`leaseReturnedTo`). Tab ops take the same paths as the
   * tab actions. A click keeps the click action's popup handling. Every
   * outcome is a result, never a throw.
   */
  private async executeProgramOp(
    ctx: LocalRuntimeToolContext,
    op: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const name = typeof op.op === 'string' ? op.op : 'unknown';
    const startedAt = Date.now();
    let session: BrowserCoreSession | undefined;
    let sessionId: string | undefined;
    let target: TargetTab | undefined;
    try {
      this.core.assertNotAborted(signal);
      sessionId = this.core.assertContext(ctx);
      if (this.closed) throw new Error('Headless browser provider is closed');
      this.markSessionActive(sessionId);
      if (name === 'goto') normalizeHeadlessActionInput('navigate', { url: op.url });
      await this.beginAgentCall(sessionId, ctx, signal);
      if (PROGRAM_TAB_OPS[name] === true) {
        return programTabResult(
          name,
          await this.runProgramTabOp(sessionId, name, op, signal),
          startedAt,
        );
      }
      const read = PROGRAM_READ_OPS[name] === true;
      const set = this.tabSet(sessionId);
      const tabId = programOpTabId(op) ?? (await this.programCurrentTab(sessionId, signal));
      let leaseReturnedTo: number | undefined;
      const controlledTabId = this.control.controlledTabId(sessionId);
      if (!read && controlledTabId !== null && controlledTabId !== tabId) {
        leaseReturnedTo = await this.reclaimClosedPopup(sessionId, set, controlledTabId, signal);
      }
      const tab = set.tabs.get(tabId);
      if (!tab) {
        return withLeaseReturn(
          programTabResult(name, programTabFailure('TAB_NOT_FOUND', tabId), startedAt, op),
          leaseReturnedTo,
        );
      }
      let leaseTaken = false;
      if (!read && this.control.controlledTabId(sessionId) !== tabId) {
        if (this.control.ownerOf(tabId) === 'user') {
          return withLeaseReturn(
            programThrownResult(name, programTabNotControlledError(tabId), startedAt, op),
            leaseReturnedTo,
          );
        }
        this.grantLease(sessionId, set, tabId, { bumpRevision: true });
        leaseTaken = true;
      }
      target = { tabId, session: tab };
      session = tab;
      const runOp = op.tabId === tabId ? op : { ...op, tabId };
      // mouse.click / mouse.dblclick (mouseClick) open popups like a click: adopt them.
      const result = await (name === 'click' || name === 'dblclick' || name === 'mouseClick'
        ? this.runProgramClick(sessionId, target, runOp, signal)
        : tab.executeOp(runOp, signal));
      if (isRecord(result) && result.ok === false) {
        const gone = await this.forgetClosedTab(set, target, signal);
        if (gone) {
          // A write that may have landed keeps its unknown outcome; otherwise the tab was already gone.
          const unknown = isRecord(result.error) && result.error.writeOutcomeUnknown === true;
          return withLeaseReturn(
            unknown
              ? result
              : programTabResult(name, programTabFailure('TAB_NOT_FOUND', tabId), startedAt, op),
            gone.leaseReturnedTo ?? leaseReturnedTo,
          );
        }
      }
      // A popup's own button (sign-in done, "close") may close the popup: control returns now.
      if (!read && this.control.controlledTabId(sessionId) === tabId) {
        leaseReturnedTo =
          (await this.reclaimClosedPopup(sessionId, set, tabId, signal)) ?? leaseReturnedTo;
      }
      if (!isRecord(result)) return result;
      return withLeaseReturn(
        leaseTaken ? { ...result, leaseTaken: true } : result,
        leaseReturnedTo,
      );
    } catch (error) {
      if (session?.requiresRecreation && sessionId) await this.closeSession(sessionId);
      else if (target && sessionId) {
        const set = this.tabSets.get(sessionId);
        const gone = set ? await this.forgetClosedTab(set, target, signal) : undefined;
        if (gone) {
          return withLeaseReturn(
            programTabResult(name, programTabFailure('TAB_NOT_FOUND', target.tabId), startedAt, op),
            gone.leaseReturnedTo,
          );
        }
      }
      return programThrownResult(name, error, startedAt, op);
    } finally {
      if (sessionId) {
        this.markSessionIdle(sessionId);
        await this.evictIdleSessions(sessionId);
      }
    }
  }

  /**
   * The tab a program's `browser.page()` lands on: the controlled tab, else
   * the tab reads use (the tab controlled last, else the newest). A session
   * without tabs gets a blank Agent page under control, like a first action.
   */
  private async programCurrentTab(sessionId: string, signal?: AbortSignal): Promise<number> {
    const set = this.tabSet(sessionId);
    const current = this.control.controlledTabId(sessionId) ?? readFallbackTabId(set);
    if (current !== null) return current;
    const created = await this.createBlankTab(sessionId, set, signal);
    this.grantLease(sessionId, set, created.tabId);
    return created.tabId;
  }

  /**
   * A controlled popup whose page is gone: forgets it, and the lease goes back
   * to the tab that opened it. Returns that tab; undefined when nothing returned.
   */
  private async reclaimClosedPopup(
    sessionId: string,
    set: HeadlessTabSet,
    tabId: number,
    signal?: AbortSignal,
  ): Promise<number | undefined> {
    if (this.control.controlledTabId(sessionId) !== tabId) return undefined;
    if (this.control.tab(tabId)?.openerTabId === undefined) return undefined;
    const session = set.tabs.get(tabId);
    if (session && (await isHeadlessTabAlive(session, signal))) return undefined;
    return this.closeTabs(set, [tabId]);
  }

  /** A tab an op failed on whose page is gone: forgets it (a controlled popup returns the lease). */
  private async forgetClosedTab(
    set: HeadlessTabSet,
    tab: TargetTab,
    signal?: AbortSignal,
  ): Promise<{ leaseReturnedTo?: number } | undefined> {
    if (set.tabs.get(tab.tabId) !== tab.session) return undefined;
    if (await isHeadlessTabAlive(tab.session, signal).catch(() => true)) return undefined;
    const leaseReturnedTo = await this.closeTabs(set, [tab.tabId]);
    return leaseReturnedTo === undefined ? {} : { leaseReturnedTo };
  }

  /**
   * A program's tab op, as the matching tab action: `tabs` lists the same rows
   * as list_tabs (with the program's `current` naming the controlled tab) and
   * the tab `browser.page()` lands on, `newPage` is open_tab, `selectTab` is
   * select_tab, `closeTab` is close_tab, `keep` is mark_tab. `show` has no
   * panel to show the page in: it reports the page as not shown, so a program
   * written for the desktop Browser still runs. A missing tab fails with the
   * program's recovery.
   */
  private async runProgramTabOp(
    sessionId: string,
    name: string,
    op: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (name === 'newPage') {
      return this.openTab(
        sessionId,
        normalizeHeadlessActionInput('open_tab', { url: op.url }),
        signal,
      );
    }
    if (name === 'tabs') {
      const listed = await this.listTabs(sessionId, signal);
      // browser.panel() only reads the list: resolving the current page could open a blank one.
      const currentTabId =
        op.current === false ? null : await this.programCurrentTab(sessionId, signal);
      const rows = listed.tabs.some((row) => row.tabId === currentTabId)
        ? listed.tabs
        : (await this.listTabs(sessionId, signal)).tabs;
      return {
        tabs: rows.map((row) => ({ ...row, current: row.controlled === true })),
        currentTabId,
      };
    }
    if (name === 'show') {
      const tabId = readBrowserTabId(op) ?? this.control.controlledTabId(sessionId);
      if (tabId === null || !this.tabSet(sessionId).tabs.has(tabId)) {
        return programTabFailure('TAB_NOT_FOUND', tabId);
      }
      return {
        tabId,
        shown: false,
        panelVisible: false,
        notice: 'Headless Chrome has no Browser panel; the page stays in the background.',
      };
    }
    if (name === 'keep') {
      const { tabId, retention } = readProgramKeepOp(op);
      const marked = this.markTab(sessionId, { tabId, retention });
      if (marked.success === false) return programTabFailure('TAB_NOT_FOUND', tabId);
      // A user's tab never closes at turn end: it stays like a deliverable.
      if (this.control.ownerOf(tabId) === 'user') return { tabId, retention: 'deliverable' };
      return {
        tabId,
        retention,
        ...(retention === 'carryover' ? { notice: PROGRAM_CARRYOVER_NOTICE } : {}),
      };
    }
    const result =
      name === 'selectTab'
        ? await this.selectTab(sessionId, { tabId: op.tabId }, signal)
        : await this.closeTab(sessionId, {
            tabId: op.tabId ?? this.control.controlledTabId(sessionId) ?? undefined,
          });
    return result.success === false && result.code === 'TAB_NOT_FOUND'
      ? programTabFailure('TAB_NOT_FOUND', readBrowserTabId(op))
      : result;
  }

  /**
   * A fast click returns before a target=_blank page attaches, so a click whose
   * target opens a new tab looks for it a little longer.
   */
  private async runProgramClick(
    sessionId: string,
    tab: TargetTab,
    op: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const browser = await this.getBrowser(sessionId, signal);
    const openedAfter = browser.relatedPageCheckpoint();
    const result = await this.runWithRelatedPage(
      sessionId,
      tab,
      false,
      (runSignal) => tab.session.executeOp(op, runSignal),
      signal,
    );
    if (!isRecord(result) || result.opensNewTab !== true || result.openedInNewTab === true) {
      return result;
    }
    const deadline = Date.now() + PROGRAM_POPUP_WAIT_MS;
    while (Date.now() < deadline && !signal?.aborted) {
      const adopted = await this.adoptRelatedPage(sessionId, tab, result, false, {
        openedAfter,
        ...(signal ? { signal } : {}),
      });
      if (isRecord(adopted) && adopted.openedInNewTab === true) return adopted;
      await new Promise((resolve) => setTimeout(resolve, PROGRAM_POPUP_POLL_MS));
    }
    return result;
  }

  private async executePageAction(
    sessionId: string,
    tab: TargetTab,
    action: LocalBrowserToolAction,
    actionInput: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const { session } = tab;
    const expectsRelatedPage =
      action === 'click_and_wait_for_navigation' && isBlankTargetRef(session, actionInput);
    const coreAction = expectsRelatedPage ? 'click' : action;
    if (
      action !== 'click' &&
      action !== 'double_click' &&
      action !== 'triple_click' &&
      !expectsRelatedPage
    ) {
      return await session.execute(coreAction, actionInput, signal);
    }
    return this.runWithRelatedPage(
      sessionId,
      tab,
      expectsRelatedPage,
      (runSignal) => session.execute(coreAction, actionInput, runSignal),
      signal,
    );
  }

  /** A click: adopts the page it opens, and ends as paused if that page's dialog blocks it. */
  private async runWithRelatedPage(
    sessionId: string,
    tab: TargetTab,
    expectsRelatedPage: boolean,
    run: (signal: AbortSignal) => Promise<unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const browser = await this.getBrowser(sessionId, signal);
    const openerTargetId = tab.session.transport.sessionId;
    // Only a popup created while this click runs belongs to it; older
    // unclaimed popups stay unclaimed until they expire.
    const openedAfter = browser.relatedPageCheckpoint();
    const popupDialog = browser.watchRelatedPageDialog(openerTargetId, openedAfter);
    // Ends this click if a popup's dialog pauses it (see below).
    const relatedDialogPause = new AbortController();
    const execution = run(
      signal ? AbortSignal.any([signal, relatedDialogPause.signal]) : relatedDialogPause.signal,
    );
    let settled:
      | { readonly result: unknown; readonly dialogTargetId?: undefined }
      | { readonly dialogTargetId: string };
    try {
      settled = await Promise.race([
        execution.then((result) => ({ result })),
        popupDialog.opened.then((dialogTargetId) => ({ dialogTargetId })),
      ]);
    } finally {
      popupDialog.dispose();
    }
    if (settled.dialogTargetId === undefined) {
      return await this.adoptRelatedPage(sessionId, tab, settled.result, expectsRelatedPage, {
        openedAfter,
        signal,
      });
    }
    // The click opened a popup whose dialog also pauses this page's
    // renderer, so the click cannot finish until the model answers the
    // dialog in the popup, which may take longer than the click's deadline
    // (the model asks the user first). End the click now as paused, without
    // Browser Core's interruption reset, and switch to that popup.
    relatedDialogPause.abort(new BrowserRelatedPageDialogPause());
    await execution.catch(() => undefined);
    return await this.adoptRelatedPage(
      sessionId,
      tab,
      {
        success: true,
        effect: { dispatched: true, verified: false, verificationRequired: true },
      },
      true,
      { openedAfter, targetId: settled.dialogTargetId, signal },
    );
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.closed = true;
    for (const { timer } of this.idleCloseTimers.values()) clearTimeout(timer);
    this.idleCloseTimers.clear();
    this.disposePromise = this.disposeOwnedResources();
    return this.disposePromise;
  }

  private async disposeOwnedResources(): Promise<void> {
    const sessionIds = [
      ...new Set([
        ...this.blankTabCreations.keys(),
        ...this.tabSets.keys(),
        ...this.browsers.keys(),
        ...this.sessionInitializationControllers.keys(),
        ...this.sessionClosingPromises.keys(),
      ]),
    ];
    const failures: unknown[] = [];
    const sessionCleanupResults = await Promise.allSettled(
      sessionIds.map((sessionId) => this.closeSession(sessionId)),
    );
    for (const result of sessionCleanupResults) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    const browserCleanupResults = await Promise.allSettled(
      [...this.browsers.values()].map(async (pending) => {
        const browser = await pending.catch(() => undefined);
        if (!browser) return;
        await browser.close();
      }),
    );
    for (const result of browserCleanupResults) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    const disposalResults = await Promise.allSettled(this.sessionDisposals.values());
    for (const result of disposalResults) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    this.sessionDisposals.clear();
    this.sessionProfiles.clear();
    this.persistentProfileOwner = undefined;
    this.blankTabCreations.clear();
    this.tabSets.clear();
    this.browsers.clear();
    this.sessionInitializationControllers.clear();
    this.browserExitDisposers.clear();
    this.clipboardProviders.clear();
    this.sessionActivity.clear();
    this.activeExecutions.clear();
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Headless Browser provider cleanup failed');
    }
  }

  close(): Promise<void> {
    return this.dispose();
  }

  /** The session's tabs, created empty. */
  private tabSet(sessionId: string): HeadlessTabSet {
    let set = this.tabSets.get(sessionId);
    if (!set) {
      set = { tabs: new Map(), lastControlledTabId: null };
      this.tabSets.set(sessionId, set);
    }
    return set;
  }

  /** Registers a page of the session as an Agent tab; `openerTabId` for a page an Agent click opened. */
  private addTab(
    sessionId: string,
    set: HeadlessTabSet,
    session: BrowserCoreSession,
    openerTabId?: number,
  ): number {
    const tabId = this.nextTabId;
    this.nextTabId += 1;
    set.tabs.set(tabId, session);
    this.control.registerTab(
      sessionId,
      tabId,
      'agent',
      openerTabId === undefined ? {} : { openerTabId },
    );
    return tabId;
  }

  private grantLease(
    sessionId: string,
    set: HeadlessTabSet,
    tabId: number,
    options: { bumpRevision?: boolean } = {},
  ): void {
    this.control.grantLease(sessionId, tabId, options);
    set.lastControlledTabId = tabId;
  }

  /**
   * Closes and forgets tabs. `agent`: the Agent closed them (close_tab, turn
   * end); without it the page is gone by itself, and a controlled popup hands
   * the lease back to the tab that opened it. Returns that tab.
   */
  private async closeTabs(
    set: HeadlessTabSet,
    tabIds: readonly number[],
    closedBy?: 'agent',
  ): Promise<number | undefined> {
    let leaseReturnedTo: number | undefined;
    const sessions: BrowserCoreSession[] = [];
    for (const tabId of tabIds) {
      const session = set.tabs.get(tabId);
      set.tabs.delete(tabId);
      if (set.lastControlledTabId === tabId) set.lastControlledTabId = null;
      const forgotten = this.control.forgetTab(tabId, {
        ...(closedBy ? { closedBy } : {}),
        isAlive: (candidate) => set.tabs.has(candidate),
      });
      if (forgotten.leaseReturnedTo !== undefined) {
        leaseReturnedTo = forgotten.leaseReturnedTo;
        set.lastControlledTabId = leaseReturnedTo;
      }
      if (session) sessions.push(session);
    }
    await Promise.all(
      sessions.map(async (session) => {
        session.dispose();
        await session.transport.close().catch(() => undefined);
      }),
    );
    return leaseReturnedTo;
  }

  /**
   * The tab a page action runs on: the controlled tab. A read without one
   * uses the tab controlled last, else the newest tab. A session without tabs
   * gets a blank Agent page under control. A write without the lease fails
   * with TAB_NOT_CONTROLLED. A controlled popup that closed itself returns
   * the lease to the tab that opened it; a read runs there, a write is not
   * run (the caller reports it) so the model inspects the opener first.
   */
  private async resolveTargetTab(
    sessionId: string,
    read: boolean,
    signal?: AbortSignal,
  ): Promise<TargetTab> {
    const set = this.tabSet(sessionId);
    const controlledTabId = this.control.controlledTabId(sessionId);
    if (controlledTabId !== null) {
      const controlled = set.tabs.get(controlledTabId);
      if (controlled && (await isHeadlessTabAlive(controlled, signal))) {
        return { tabId: controlledTabId, session: controlled };
      }
      if (controlled) {
        const leaseReturnedTo = await this.closeTabs(set, [controlledTabId]);
        const opener = leaseReturnedTo === undefined ? undefined : set.tabs.get(leaseReturnedTo);
        if (opener && leaseReturnedTo !== undefined) {
          return { tabId: leaseReturnedTo, session: opener, leaseReturnedTo };
        }
      } else {
        this.control.releaseLease(sessionId);
      }
    }
    if (set.tabs.size === 0) {
      const created = await this.createBlankTab(sessionId, set, signal);
      this.grantLease(sessionId, set, created.tabId);
      return created;
    }
    if (read) {
      const tabId = readFallbackTabId(set);
      const session = tabId === null ? undefined : set.tabs.get(tabId);
      if (tabId !== null && session) return { tabId, session };
    }
    throw tabNotControlledError();
  }

  private async openTab(
    sessionId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!/^https?:\/\//iu.test(url))
      throw new Error('Only http(s) URLs are supported for open_tab');
    const set = this.tabSet(sessionId);
    if (set.tabs.size > MAX_PRESERVED_TABS_PER_SESSION) {
      throw new Error(
        formatBrowserErrorTriple({
          code: 'TAB_LIMIT_REACHED',
          reason: `Headless Browser keeps at most ${MAX_PRESERVED_TABS_PER_SESSION + 1} tabs per session.`,
          next: BROWSER_TAB_FAILURES.TAB_LIMIT_REACHED.next,
        }),
      );
    }
    const browser = await this.getBrowser(sessionId, signal);
    const page = await browser.createPage('about:blank', signal);
    let nextSession: BrowserCoreSession | undefined;
    try {
      throwIfAborted(signal);
      const transport = this.createTransport(page, browser.downloadDirectory);
      nextSession = this.createCoreSession(sessionId, transport);
      const profile = this.sessionProfiles.get(sessionId);
      if (profile) profile.initialized = true;
      const navigationResult = await nextSession.execute('navigate', { ...input, url }, signal);
      throwIfAborted(signal);
      if (!isRecord(navigationResult) || navigationResult.success !== true) {
        throw new Error('NAVIGATION_FAILED: Browser Core did not confirm the new tab navigation');
      }
      const previousTabId = this.control.controlledTabId(sessionId);
      const tabId = this.addTab(sessionId, set, nextSession);
      this.grantLease(sessionId, set, tabId);
      return {
        ...navigationResult,
        tabId,
        previousTabId,
        controlledTabId: tabId,
        owner: 'agent',
        retention: 'temporary',
        openedInNewTab: true,
        preservedTabs: set.tabs.size - 1,
      };
    } catch (error) {
      nextSession?.dispose();
      await page.close().catch(() => undefined);
      throw error;
    }
  }

  /** A list_tabs row, with the same fields as the Electron FilePanel's web tab rows. */
  private describeTab(
    sessionId: string,
    tabId: number,
    info: { readonly url: string; readonly title: string },
  ): Record<string, unknown> {
    const owner = this.control.ownerOf(tabId);
    return {
      tabId,
      surfaceKind: 'web',
      url: info.url,
      title: info.title,
      owner,
      ...(owner === 'agent'
        ? { retention: this.control.tab(tabId)?.retention ?? 'temporary' }
        : {}),
      ...(this.control.controlledTabId(sessionId) === tabId ? { controlled: true } : {}),
    };
  }

  private async listTabs(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{
    success: true;
    tabs: Record<string, unknown>[];
    controlledTabId: number | null;
  }> {
    const set = this.tabSets.get(sessionId);
    const probes = set
      ? await Promise.all(
          [...set.tabs].map(async ([tabId, session]) => ({
            tabId,
            info: await readHeadlessTabInfo(session, signal),
          })),
        )
      : [];
    const gone = probes.flatMap(({ tabId, info }) => (info ? [] : [tabId]));
    if (set && gone.length > 0) await this.closeTabs(set, gone);
    return {
      success: true,
      tabs: probes.flatMap(({ tabId, info }) =>
        info ? [this.describeTab(sessionId, tabId, info)] : [],
      ),
      controlledTabId: this.control.controlledTabId(sessionId),
    };
  }

  /** `select_tab`: the tab becomes the controlled tab. */
  private async selectTab(
    sessionId: string,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | BrowserTabFailure> {
    const set = this.tabSets.get(sessionId);
    const tabId = readBrowserTabId(input);
    const target = tabId === null ? undefined : set?.tabs.get(tabId);
    if (tabId === null || !set || !target) return browserTabFailure('TAB_NOT_FOUND', tabId);
    const info = await readHeadlessTabInfo(target, signal);
    if (!info) {
      await this.closeTabs(set, [tabId]);
      return browserTabFailure('TAB_NOT_FOUND', tabId);
    }
    const previousTabId = this.control.controlledTabId(sessionId);
    this.grantLease(sessionId, set, tabId, { bumpRevision: true });
    const entry = this.describeTab(sessionId, tabId, info);
    return {
      success: true,
      ...entry,
      controlled: true,
      previousTabId,
      controlledTabId: tabId,
      ...(entry.owner === 'user'
        ? {
            notice:
              "This is the user's tab: navigate replaces its page. Use open_tab for other URLs unless the user asked to change this page.",
          }
        : {}),
    };
  }

  /** `close_tab { tabId }`: closing the controlled tab releases control. */
  private async closeTab(
    sessionId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown> | BrowserTabFailure> {
    const set = this.tabSets.get(sessionId);
    const tabId = readBrowserTabId(input);
    if (tabId === null || !set?.tabs.has(tabId)) return browserTabFailure('TAB_NOT_FOUND', tabId);
    const releasedControl = this.control.controlledTabId(sessionId) === tabId;
    await this.closeTabs(set, [tabId], 'agent');
    return {
      success: true,
      closedTabIds: [tabId],
      releasedControl,
      controlledTabId: this.control.controlledTabId(sessionId),
      ...(releasedControl
        ? {
            notice:
              'The controlled tab is closed. Call select_tab or open_tab before the next page-changing action.',
          }
        : {}),
    };
  }

  /** `mark_tab`: keeps an Agent page past the turn end (carryover) or leaves it to the user (deliverable). */
  private markTab(
    sessionId: string,
    input: Record<string, unknown>,
  ): Record<string, unknown> | BrowserTabFailure {
    if (this.control.isEphemeral(sessionId)) {
      throw new Error(
        "SUBAGENT_TAB_NOT_RETAINABLE: A sub-Agent's pages close when it ends and cannot be kept",
      );
    }
    const tabId = readBrowserTabId(input);
    if (tabId === null || !this.tabSets.get(sessionId)?.tabs.has(tabId)) {
      return browserTabFailure('TAB_NOT_FOUND', tabId);
    }
    const retention = input.retention;
    if (retention !== 'carryover' && retention !== 'deliverable') {
      throw new Error('retention must be "carryover" or "deliverable"');
    }
    if (this.control.ownerOf(tabId) === 'user') {
      return {
        success: true,
        tabId,
        owner: 'user',
        notice: "This is the user's tab; it never closes at turn end. No mark is needed.",
      };
    }
    if (retention === 'deliverable') {
      this.control.promoteToUser(tabId);
      return { success: true, tabId, owner: 'user', retention: 'deliverable' };
    }
    this.control.setRetention(tabId, 'carryover');
    return {
      success: true,
      tabId,
      owner: 'agent',
      retention: 'carryover',
      notice: CARRYOVER_NOTICE,
    };
  }

  /**
   * The page an Agent click opened becomes an Agent tab whose opener is the
   * clicked tab, and the lease follows into it (the click ran on the
   * controlled tab).
   */
  private async adoptRelatedPage(
    sessionId: string,
    opener: TargetTab,
    actionResult: unknown,
    requireRelatedPage: boolean,
    claim: RelatedPageClaim,
  ): Promise<unknown> {
    const { signal } = claim;
    const browser = await this.getBrowser(sessionId, signal);
    const page = await browser.takeRelatedPage(opener.session.transport.sessionId, claim);
    if (!page) {
      if (!requireRelatedPage) return actionResult;
      return {
        ...(isRecord(actionResult) ? actionResult : {}),
        success: false,
        code: 'ACTION_TIMEOUT',
        error: 'The click did not open the expected related Browser page.',
        recovery: 'Inspect the current page before deciding whether to retry.',
      };
    }
    const set = this.tabSet(sessionId);
    if (set.tabs.size > MAX_PRESERVED_TABS_PER_SESSION) {
      await page.close().catch(() => undefined);
      return {
        ...(isRecord(actionResult) ? actionResult : {}),
        ...browserErrorTripleResult({
          code: 'TAB_LIMIT_REACHED',
          reason: `Headless Browser keeps at most ${MAX_PRESERVED_TABS_PER_SESSION + 1} tabs per session; the related popup was closed.`,
          next: BROWSER_TAB_FAILURES.TAB_LIMIT_REACHED.next,
        }),
      };
    }
    let nextSession: BrowserCoreSession | undefined;
    try {
      const ready = await page.waitForReady(undefined, signal);
      throwIfAborted(signal);
      nextSession = this.createCoreSession(
        sessionId,
        this.createTransport(page, browser.downloadDirectory),
      );
      // A dialog the popup opened before its Core session existed is seeded
      // from the transport; report it with the click, which it interrupts.
      const jsDialog = nextSession.jsDialog;
      const tabId = this.addTab(sessionId, set, nextSession, opener.tabId);
      this.grantLease(sessionId, set, tabId);
      const title = jsDialog
        ? ''
        : await nextSession.transport
            .evaluate<unknown>('document.title', {
              returnByValue: true,
              timeoutMs: TAB_PROBE_TIMEOUT_MS,
              ...(signal ? { signal } : {}),
            })
            .catch(() => '');
      return {
        ...(isRecord(actionResult) ? actionResult : {}),
        tabId,
        openedInNewTab: true,
        preservedTabs: set.tabs.size - 1,
        openedTab: { tabId, url: ready.url, title: typeof title === 'string' ? title : '' },
        previousTabId: opener.tabId,
        controlledTabId: tabId,
        notice:
          'The page opened a new tab; it is now the controlled tab. Inspect it before acting.',
        ...(jsDialog ? browserJsDialogActiveResult(jsDialog) : {}),
      };
    } catch (error) {
      nextSession?.dispose();
      await page.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * A blank Agent page for a session without tabs, launching its Chrome when
   * needed. Concurrent first actions share the page.
   */
  private createBlankTab(
    sessionId: string,
    set: HeadlessTabSet,
    signal?: AbortSignal,
  ): Promise<TargetTab> {
    const existing = this.blankTabCreations.get(sessionId);
    if (existing) return existing;
    const initializationController = new AbortController();
    this.sessionInitializationControllers.set(sessionId, initializationController);
    const initializationSignal = signal
      ? AbortSignal.any([signal, initializationController.signal])
      : initializationController.signal;
    let browser: HeadlessChromeBrowser | undefined;
    let page: HeadlessChromePage | undefined;
    const pending = (async (): Promise<TargetTab> => {
      try {
        throwIfAborted(initializationSignal);
        browser = await this.getBrowser(sessionId, initializationSignal);
        throwIfAborted(initializationSignal);
        page = await browser.createPage('about:blank', initializationSignal);
        throwIfAborted(initializationSignal);
        const profile = this.sessionProfiles.get(sessionId);
        if (!profile) throw new Error('Browser profile was released during session initialization');
        const transport = this.createTransport(page, browser.downloadDirectory);
        const session = this.createCoreSession(sessionId, transport);
        profile.initialized = true;
        return { tabId: this.addTab(sessionId, set, session), session };
      } catch (error) {
        await page?.close().catch(() => undefined);
        if (browser) {
          this.browserExitDisposers.get(sessionId)?.();
          this.browserExitDisposers.delete(sessionId);
          // A first initialization that never became usable can give its reservation back.
          // Recreating an established session must keep its original identity, even on failure.
          const closed = await browser.close().then(
            () => true,
            () => false,
          );
          this.browsers.delete(sessionId);
          if (closed && !this.sessionProfiles.get(sessionId)?.initialized) {
            this.sessionProfiles.delete(sessionId);
            this.releasePersistentProfile(sessionId);
          }
        }
        throw error;
      } finally {
        if (this.sessionInitializationControllers.get(sessionId) === initializationController) {
          this.sessionInitializationControllers.delete(sessionId);
        }
      }
    })();
    this.blankTabCreations.set(sessionId, pending);
    void pending.then(
      () => {
        if (this.blankTabCreations.get(sessionId) === pending) {
          this.blankTabCreations.delete(sessionId);
        }
      },
      () => {
        if (this.blankTabCreations.get(sessionId) === pending) {
          this.blankTabCreations.delete(sessionId);
        }
        this.clipboardProviders.delete(sessionId);
      },
    );
    return pending;
  }

  private createTransport(page: HeadlessChromePage, downloadDirectory: string): BrowserTransport {
    return new CoreTransport(page, downloadDirectory);
  }

  private createCoreSession(sessionId: string, transport: BrowserTransport): BrowserCoreSession {
    return this.core.createSession(transport, {
      clipboardProvider: this.getClipboardProvider(sessionId),
      commandTimeoutMs: this.options.commandTimeoutMs,
      ...(this.options.browserReadV2 ? { readLiveFormState: () => true } : {}),
    });
  }

  private getClipboardProvider(sessionId: string): ClipboardProvider {
    const existing = this.clipboardProviders.get(sessionId);
    if (existing) return existing;
    const created =
      this.options.clipboardProviderFactory?.(sessionId) ?? new IsolatedClipboardProvider();
    this.clipboardProviders.set(sessionId, created);
    return created;
  }

  private async getBrowser(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<HeadlessChromeBrowser> {
    if (this.sessionDisposals.has(sessionId)) {
      throw new Error('Headless browser session is being disposed');
    }
    const closing = this.sessionClosingPromises.get(sessionId);
    if (closing) {
      await closing;
      throwIfAborted(signal);
      if (this.closed) throw new Error('Headless browser provider is closed');
    }
    const existing = this.browsers.get(sessionId);
    if (existing) return existing;
    const promise = this.launchBrowser(sessionId, signal).then((browser) => {
      const disposer = browser.onUnexpectedExit(() => {
        this.evictCrashedBrowser(sessionId, promise, browser);
      });
      this.browserExitDisposers.set(sessionId, disposer);
      return browser;
    });
    this.browsers.set(sessionId, promise);
    promise.catch(() => {
      if (this.browsers.get(sessionId) === promise) this.browsers.delete(sessionId);
    });
    return promise;
  }

  /** Select a profile once; idle/LRU/crash cleanup only releases Chrome resources. */
  private async launchBrowser(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<HeadlessChromeBrowser> {
    const existing = this.sessionProfiles.get(sessionId);
    // A sub-Agent never takes the shared profile: its Browser ends with its turn.
    const profile: SessionProfile = existing ?? {
      kind:
        this.persistentProfileOwner === undefined && !this.ephemeralSessions.has(sessionId)
          ? 'persistent'
          : 'isolated',
      initialized: false,
    };
    if (!existing) {
      this.sessionProfiles.set(sessionId, profile);
      if (profile.kind === 'persistent') this.persistentProfileOwner = sessionId;
    }
    try {
      if (
        profile.kind === 'persistent' &&
        (await isChromeProfileInUse(resolvePersistentProfileDir(this.options)))
      ) {
        if (existing) {
          throw new Error(
            "This session's browser profile is in use by another Chrome process; close that process and retry. The session will not switch profiles.",
          );
        }
        this.releasePersistentProfile(sessionId);
        profile.kind = 'isolated';
      }
      return await HeadlessChromeBrowser.launch(
        resolveHeadlessSessionLaunchOptions(this.options, sessionId, profile.kind),
        signal,
      );
    } catch (error) {
      if (!existing) {
        this.sessionProfiles.delete(sessionId);
        this.releasePersistentProfile(sessionId);
      }
      throw error;
    }
  }

  private releasePersistentProfile(sessionId: string): void {
    if (this.persistentProfileOwner === sessionId) this.persistentProfileOwner = undefined;
  }

  private evictCrashedBrowser(
    sessionId: string,
    browserPromise: Promise<HeadlessChromeBrowser>,
    browser: HeadlessChromeBrowser,
  ): void {
    if (this.browsers.get(sessionId) !== browserPromise) return;
    this.browsers.delete(sessionId);
    this.browserExitDisposers.get(sessionId)?.();
    this.browserExitDisposers.delete(sessionId);

    const pending = this.blankTabCreations.get(sessionId);
    this.blankTabCreations.delete(sessionId);
    const tabSet = this.tabSets.get(sessionId);
    const tabs = [...(tabSet?.tabs.values() ?? [])];
    for (const tabId of tabSet?.tabs.keys() ?? []) {
      this.control.forgetTab(tabId, { closedBy: 'agent' });
    }
    this.tabSets.delete(sessionId);
    this.clipboardProviders.delete(sessionId);
    this.sessionActivity.delete(sessionId);

    // Evict synchronously, but keep the cleanup registered until the crashed
    // process has released its profile. A replacement using the same profile
    // must not race the old browser's final Singleton* lock cleanup.
    const cleanup = (async () => {
      const current = await pending?.catch(() => undefined);
      const coreSessions = uniqueSessions(current?.session, tabs);
      for (const coreSession of coreSessions) {
        coreSession.dispose();
      }
      await browser.close();
    })();
    this.trackSessionCleanup(sessionId, cleanup);
  }

  private closeSession(sessionId: string): Promise<void> {
    const existingCleanup = this.sessionClosingPromises.get(sessionId);
    if (existingCleanup) return existingCleanup;

    const browserPending = this.browsers.get(sessionId);
    const initializationController = this.sessionInitializationControllers.get(sessionId);
    const pending = this.blankTabCreations.get(sessionId);
    const tabSet = this.tabSets.get(sessionId);
    const clipboardProvider = this.clipboardProviders.get(sessionId);
    const exitDisposer = this.browserExitDisposers.get(sessionId);
    this.sessionActivity.delete(sessionId);

    initializationController?.abort();
    if (this.sessionInitializationControllers.get(sessionId) === initializationController) {
      this.sessionInitializationControllers.delete(sessionId);
    }
    if (this.blankTabCreations.get(sessionId) === pending) this.blankTabCreations.delete(sessionId);
    if (this.tabSets.get(sessionId) === tabSet) this.tabSets.delete(sessionId);
    // Closing Chrome closes every tab: the lease ends; no tab opener takes it.
    for (const tabId of tabSet?.tabs.keys() ?? []) {
      this.control.forgetTab(tabId, { closedBy: 'agent' });
    }
    if (this.clipboardProviders.get(sessionId) === clipboardProvider) {
      this.clipboardProviders.delete(sessionId);
    }
    if (this.browserExitDisposers.get(sessionId) === exitDisposer) {
      exitDisposer?.();
      this.browserExitDisposers.delete(sessionId);
    }
    if (this.browsers.get(sessionId) === browserPending) {
      this.browsers.delete(sessionId);
    }

    const cleanup = (async (): Promise<void> => {
      const created = await pending?.catch(() => undefined);
      const coreSessions = uniqueSessions(created?.session, [...(tabSet?.tabs.values() ?? [])]);
      // Headless has no user surface to hand a held dialog back to. Dismiss it
      // (alert: close) before teardown so no business action is confirmed.
      await Promise.all(coreSessions.map((coreSession) => dismissHeldJsDialog(coreSession)));
      for (const coreSession of coreSessions) {
        coreSession.dispose();
      }
      await Promise.all(
        coreSessions.map((coreSession) => coreSession.transport.close().catch(() => undefined)),
      );
      const browser = await browserPending?.catch(() => undefined);
      if (browser) await browser.close();
    })();
    return this.trackSessionCleanup(sessionId, cleanup);
  }

  private markSessionActive(sessionId: string): void {
    this.activitySequence += 1;
    this.sessionActivity.set(sessionId, this.activitySequence);
    this.activeExecutions.set(sessionId, (this.activeExecutions.get(sessionId) ?? 0) + 1);
    clearTimeout(this.idleCloseTimers.get(sessionId)?.timer);
    this.idleCloseTimers.delete(sessionId);
  }

  private markSessionIdle(sessionId: string): void {
    const remaining = (this.activeExecutions.get(sessionId) ?? 1) - 1;
    if (remaining > 0) {
      this.activeExecutions.set(sessionId, remaining);
      return;
    }
    this.activeExecutions.delete(sessionId);
    this.scheduleIdleClose(sessionId);
  }

  /**
   * Reclaim Chrome after a quiet period. Only process and page state go away;
   * the profile stays on disk, so the next action relaunches with the same
   * cookies and storage. A timer whose browser was already replaced or closed
   * is a no-op, so close paths do not need to cancel it.
   */
  private scheduleIdleClose(sessionId: string): void {
    const browser = this.browsers.get(sessionId);
    if (this.closed || !browser) return;
    const entry: IdleCloseTimer = {
      browser,
      timer: setTimeout(() => {
        void this.closeIdleSession(sessionId, entry).catch(() => undefined);
      }, this.options.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS),
    };
    entry.timer.unref?.();
    this.idleCloseTimers.set(sessionId, entry);
  }

  /**
   * An unanswered JavaScript dialog never times out: closing Chrome would end
   * the page the model or user still has to answer. Such a session waits
   * another idle period, on any of its tabs.
   */
  private async closeIdleSession(sessionId: string, expected: IdleCloseTimer): Promise<void> {
    const created = await this.blankTabCreations.get(sessionId)?.catch(() => undefined);
    // An action that started meanwhile removed this timer and schedules its own.
    if (this.idleCloseTimers.get(sessionId) !== expected) return;
    this.idleCloseTimers.delete(sessionId);
    if (this.browsers.get(sessionId) !== expected.browser) return;
    const tabs = uniqueSessions(created?.session, [
      ...(this.tabSets.get(sessionId)?.tabs.values() ?? []),
    ]);
    if (tabs.some((tab) => tab.jsDialog !== null)) {
      this.scheduleIdleClose(sessionId);
      return;
    }
    await this.closeSession(sessionId);
  }

  private async evictIdleSessions(protectedSessionId: string): Promise<void> {
    while (this.browsers.size > MAX_LIVE_BROWSER_SESSIONS) {
      const candidate = [...this.browsers.keys()]
        .filter(
          (sessionId) => sessionId !== protectedSessionId && !this.activeExecutions.has(sessionId),
        )
        .sort(
          (left, right) =>
            (this.sessionActivity.get(left) ?? 0) - (this.sessionActivity.get(right) ?? 0),
        )[0];
      if (!candidate) return;
      // LRU eviction closes process/page resources only. The isolated profile
      // stays on disk and is reused if the logical session becomes active again.
      await this.closeSession(candidate).catch(() => undefined);
    }
  }

  private trackSessionCleanup(sessionId: string, cleanup: Promise<void>): Promise<void> {
    this.sessionClosingPromises.set(sessionId, cleanup);
    // Process cleanup does not end the logical session or hand its profile to another one.
    // Keep failed cleanup registered because Chrome may still hold the profile.
    void cleanup.then(
      () => {
        if (this.sessionClosingPromises.get(sessionId) === cleanup) {
          this.sessionClosingPromises.delete(sessionId);
        }
      },
      () => undefined,
    );
    return cleanup;
  }
}

function isBlankTargetRef(session: BrowserCoreSession, input: Record<string, unknown>): boolean {
  const ref = typeof input.ref === 'string' ? input.ref : '';
  return ref !== '' && session.resolveOpaqueRef(ref)?.attributes.target?.toLowerCase() === '_blank';
}

function uniqueSessions(
  active: BrowserCoreSession | undefined,
  tabs: readonly BrowserCoreSession[],
): BrowserCoreSession[] {
  return [...new Set([...(active ? [active] : []), ...tabs])];
}

/** The tab reads use without a controlled tab: the tab controlled last, else the newest. */
function readFallbackTabId(set: HeadlessTabSet): number | null {
  if (set.lastControlledTabId !== null && set.tabs.has(set.lastControlledTabId)) {
    return set.lastControlledTabId;
  }
  return [...set.tabs.keys()].at(-1) ?? null;
}

/** A program op result that also reports a lease that went back to a popup's opener. */
function withLeaseReturn(result: unknown, leaseReturnedTo: number | undefined): unknown {
  if (leaseReturnedTo === undefined || !isRecord(result)) return result;
  return { ...result, leaseReturnedTo };
}

const POPUP_CLOSED_NOTICE =
  'The opened tab closed itself; control returned to the tab that opened it.';

/**
 * A single-step write whose controlled popup closed itself before it ran: the
 * write is not run on the opener, which got the lease back.
 */
function leaseReturnedWriteFailure(action: string, openerTabId: number): Record<string, unknown> {
  return {
    success: false,
    code: 'STALE_SNAPSHOT',
    error: `${action} was not run: the tab you controlled closed itself; control returned to tab ${openerTabId}. Inspect it before writing.`,
    recovery: `Inspect tab ${openerTabId} before writing.`,
    leaseReturnedTo: openerTabId,
    controlledTabId: openerTabId,
    notice: POPUP_CLOSED_NOTICE,
  };
}

/**
 * Whether a tab's page still exists. Chrome answers Target.getTargetInfo
 * itself, so a renderer paused by a JavaScript dialog or busy with script
 * still answers; a probe that times out counts as alive.
 */
async function isHeadlessTabAlive(
  session: BrowserCoreSession,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await session.transport.send('Target.getTargetInfo', undefined, undefined, {
      ...(signal ? { signal } : {}),
      timeoutMs: TAB_PROBE_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    return isRecord(error) && error.code === 'BROWSER_OPERATION_TIMEOUT';
  }
}

async function dismissHeldJsDialog(session: BrowserCoreSession): Promise<void> {
  await withTimeout(
    () => session.dismissJsDialog(),
    JS_DIALOG_DISMISS_TIMEOUT_MS,
    'Headless JavaScript dialog dismiss',
  ).catch(() => false);
}

/**
 * Reads a tab's URL and title; undefined when its page is gone. A probe that
 * times out is a busy or paused renderer, not a closed page: a JavaScript
 * dialog in a same-site popup pauses the opener too, and treating that as gone
 * would close the opener under the model. Such a tab reads as blank until it
 * answers again.
 */
async function readHeadlessTabInfo(
  session: BrowserCoreSession,
  signal?: AbortSignal,
): Promise<{ url: string; title: string } | undefined> {
  const options = { ...(signal ? { signal } : {}), timeoutMs: TAB_PROBE_TIMEOUT_MS };
  let frameTree: unknown;
  try {
    frameTree = await session.transport.send('Page.getFrameTree', undefined, undefined, options);
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = (error as { code?: unknown }).code === 'BROWSER_OPERATION_TIMEOUT';
    return timedOut ? { url: '', title: '' } : undefined;
  }
  const frame =
    isRecord(frameTree) && isRecord(frameTree.frameTree) && isRecord(frameTree.frameTree.frame)
      ? frameTree.frameTree.frame
      : {};
  const url =
    typeof frame.url === 'string'
      ? `${frame.url}${typeof frame.urlFragment === 'string' ? frame.urlFragment : ''}`
      : '';
  // Page JavaScript cannot run while this tab's own dialog is open.
  const title = session.jsDialog
    ? ''
    : await session.transport
        .evaluate<unknown>('document.title', { returnByValue: true, ...options })
        .catch(() => '');
  return { url, title: typeof title === 'string' ? title : '' };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('ABORTED: Browser action was cancelled');
}

class CoreTransport implements BrowserTransport {
  readonly sessionId: string;
  readonly downloadDirectory?: string;

  constructor(
    private readonly page: HeadlessChromePage,
    downloadDirectory?: string,
  ) {
    this.sessionId = page.targetId;
    this.downloadDirectory = downloadDirectory;
  }

  start(): Promise<void> {
    return Promise.resolve();
  }

  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    options?: BrowserTransportCommandOptions,
  ): Promise<T> {
    return this.page.transport.send<T>(method, params, sessionId, options);
  }

  evaluate<T = unknown>(expression: string, options?: BrowserEvaluateOptions): Promise<T> {
    return this.page.transport.evaluate<T>(expression, options);
  }

  evaluateInAllFrames<T = unknown>(
    expression: string,
    options?: BrowserEvaluateOptions,
  ): Promise<readonly T[]> {
    return this.page.transport.evaluateInAllFrames
      ? this.page.transport.evaluateInAllFrames<T>(expression, options)
      : this.page.transport.evaluate<T>(expression, options).then((value) => [value]);
  }

  listAttachedFrames(): readonly BrowserAttachedFrame[] {
    return this.page.transport.listAttachedFrames?.() ?? [];
  }

  pendingJavaScriptDialog(): Record<string, unknown> | undefined {
    return this.page.pendingJavaScriptDialog();
  }

  onEvent(listener: BrowserTransportEventListener): () => void {
    return this.page.transport.onEvent(listener);
  }

  waitForEvent(
    method: string,
    timeoutMs = 5_000,
    options?: Pick<BrowserTransportCommandOptions, 'signal'>,
  ): Promise<unknown> {
    return new Promise((resolve) => {
      let done = false;
      const unsubscribe = this.onEvent((event: BrowserTransportEvent) => {
        if (event.method !== method) return;
        finish(event.params);
      });
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      const finish = (value: unknown): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        options?.signal?.removeEventListener('abort', onAbort);
        unsubscribe();
        resolve(value);
      };
      const onAbort = (): void => finish(undefined);
      options?.signal?.addEventListener('abort', onAbort, { once: true });
      if (options?.signal?.aborted) onAbort();
    });
  }

  stopLoading(): Promise<void> {
    return this.page.transport.stopLoading();
  }

  resetConnection(): Promise<void> {
    return this.page.resetConnection();
  }

  close(): Promise<void> {
    return this.page.close();
  }
}

/**
 * Keep profile paths readable while retaining a collision-resistant identity.
 * Session IDs are untrusted input and two IDs may normalize to the same path.
 */
export function safeSessionId(value: string): string {
  const readable = value.replace(/[^a-zA-Z0-9._-]+/gu, '-').slice(0, 64) || 'session';
  const digest = createHash('sha256').update(value).digest('hex').slice(0, 16);
  return `${readable}-${digest}`;
}

/** One profile per data directory, reused across sessions and restarts. */
function resolvePersistentProfileDir(options: HeadlessChromeBrowserProviderOptions): string {
  return options.userDataDir
    ? join(options.userDataDir, 'persistent')
    : join(options.dataDir, 'browser', 'profile');
}

/** Resolve all Chrome paths of one logical TUI session. */
export function resolveHeadlessSessionLaunchOptions(
  options: HeadlessChromeBrowserProviderOptions,
  sessionId: string,
  profile: 'persistent' | 'isolated' = 'isolated',
): HeadlessChromeLaunchOptions {
  const suffix = safeSessionId(sessionId);
  const userDataDir =
    profile === 'persistent'
      ? resolvePersistentProfileDir(options)
      : options.userDataDir && join(options.userDataDir, suffix);
  return {
    dataDir: join(options.dataDir, 'sessions', suffix),
    ...(options.chromePath ? { chromePath: options.chromePath } : {}),
    // One Chrome for Testing install serves every session of this data directory.
    chromeForTestingDir:
      options.chromeForTestingDir ?? join(options.dataDir, 'browser', 'chrome-for-testing'),
    ...(userDataDir ? { userDataDir } : {}),
    ...(options.downloadDir ? { downloadDir: join(options.downloadDir, suffix) } : {}),
    ...(options.viewport ? { viewport: options.viewport } : {}),
    ...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
    ...(options.commandTimeoutMs !== undefined
      ? { commandTimeoutMs: options.commandTimeoutMs }
      : {}),
    ...(options.headless === false ? { headless: false } : {}),
  };
}

/**
 * Remove the exact persistent roots owned by one logical Headless Browser
 * session. `keepDownloads` keeps its download directory (and the folders
 * leading to it), so download paths already reported stay valid.
 */
export async function disposeHeadlessSessionStorage(
  options: HeadlessChromeBrowserProviderOptions,
  sessionId: string,
  { keepDownloads = false }: { keepDownloads?: boolean } = {},
): Promise<void> {
  const launchOptions = resolveHeadlessSessionLaunchOptions(options, sessionId);
  const downloadDir = resolveHeadlessDownloadDir(launchOptions);
  const sessionDirectories = new Set([
    launchOptions.dataDir,
    ...(launchOptions.userDataDir ? [launchOptions.userDataDir] : []),
    downloadDir,
  ]);
  if (keepDownloads) sessionDirectories.delete(downloadDir);
  for (const directory of sessionDirectories) {
    if (keepDownloads && downloadDir.startsWith(directory + sep)) {
      await removeAllExcept(directory, downloadDir);
    } else {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

/** Removes everything under `root` except `keep` and the folders leading to it. */
async function removeAllExcept(root: string, keep: string): Promise<void> {
  const entries = await readdir(root).catch(() => [] as string[]);
  for (const name of entries) {
    const entry = join(root, name);
    if (entry === keep) continue;
    if (keep.startsWith(entry + sep)) await removeAllExcept(entry, keep);
    else await rm(entry, { recursive: true, force: true });
  }
}

/**
 * Accept both the compact TUI wait_for schema and the canonical Core wait
 * kinds. The browser tool schema intentionally keeps selector/text/state
 * fields flat, while direct provider and eval callers may still send
 * kind-based input. Normalize at the adapter boundary so Browser Core only
 * evaluates one semantic contract.
 */
export function normalizeHeadlessWaitInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const withDefaultTimeout = Object.hasOwn(input, 'timeout')
    ? input
    : { ...input, timeout: 30_000 };
  const kind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
  if (!kind) {
    const timeoutOnly =
      typeof input.timeout === 'number' &&
      Number.isFinite(input.timeout) &&
      input.selector === undefined &&
      input.text === undefined &&
      input.url === undefined &&
      input.load === undefined &&
      input.state === undefined;
    return timeoutOnly ? { ...input, kind: 'timeout' } : withDefaultTimeout;
  }
  switch (kind) {
    case 'timeout':
      return { kind, timeout: withDefaultTimeout.timeout };
    case 'selector':
      return {
        ...withDefaultTimeout,
        kind,
        state:
          typeof input.state === 'string' && input.state.trim().length > 0
            ? input.state
            : 'visible',
      };
    case 'text':
    case 'url':
    case 'load':
    case 'network':
      return { ...withDefaultTimeout, kind, ...(kind === 'load' ? { load: true } : {}) };
    default:
      throw new Error(`Unsupported Browser wait kind: ${kind}`);
  }
}

/** Keep local file/data URL support out of the model-facing TUI provider. */
export function normalizeHeadlessActionInput(
  action: LocalBrowserToolAction,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (action === 'navigate' || action === 'open_tab') {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!/^https?:\/\//iu.test(url)) {
      throw new Error(`Only http(s) URLs are supported for ${action}`);
    }
    return url === input.url ? input : { ...input, url };
  }
  return action === 'wait' || action === 'wait_for' ? normalizeHeadlessWaitInput(input) : input;
}
