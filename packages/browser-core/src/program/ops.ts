import { platformModifier, splitKeyCombo } from '../browser-action-helpers.js';
import {
  MainFrameNavigationPending,
  pendingLoadFacts,
  pendingNavigationResult,
} from '../browser-main-frame-load.js';
import { selectMutationFailure, SELECT_MUTATION_FUNCTION } from '../browser-extended-actions.js';
import type { SelectMutationState } from '../browser-extended-actions.js';
import {
  ensureMainFrameKnown,
  sendMainFrameNavigationCommand,
  watchMainFrameNavigation,
  type MainFrameNavigationFacts as NavigationFacts,
} from '../browser-navigation-watch.js';
import { asString, cdp, delay, isRecord, type BrowserSessionState } from '../browser-state.js';
import { isBrowserOperationInterruption } from '../operation-timeout.js';
import {
  awaitMainFrameCommit,
  callOnceReady,
  isRetryablePageError,
  retryUntilOk,
} from './actionability.js';
import { BrowserProgramError, notActionable, waitTimedOut } from './errors.js';
import {
  callAtBackendNode,
  callAtLocator,
  callProgramPage,
  pinLocatorNode,
} from './locator-resolver.js';
import { runPageScript } from './page-evaluate.js';
import type { ProgramPageRequest, ProgramPageResponse } from './page-script.js';
import {
  describeProgramLocator,
  type ProgramElementState,
  type ProgramLoadState,
  type ProgramLocator,
  type ProgramOp,
  type ProgramTextMatch,
} from './types.js';

/** Actions wait this long for the element to become actionable, as the design says. */
const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
/** Navigations and explicit waits, the same as Playwright's defaults. */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const READBACK_RETRY_MS = 50;
const READBACK_RETRIES = 2;
/** A check whose click reached the control waits this long for a state that follows a server answer. */
const CHECK_SETTLE_MS = 1_000;
const POLL_INTERVAL_MS = 50;
const MAX_READ_ALL_ROWS = 5_000;
const DEFAULT_READ_ALL_ROWS = 2_000;
/** Characters a readAll carries; the rest of the rows are reported as truncated. */
const READ_ALL_CHAR_BUDGET = 4 * 1024 * 1024;
const MAX_OBSERVE_ELEMENTS = 300;

/** What Browser Core's session lends the ops; everything else they do in the page. */
export interface BrowserProgramHost {
  readonly state: BrowserSessionState;
  dispatchMouse(
    x: number,
    y: number,
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
    extra?: Record<string, unknown>,
  ): Promise<void>;
  dispatchKey(key: string, modifiers: string[]): Promise<void>;
  enableNetworkForSubmit(): Promise<void>;
  query(input: Record<string, unknown>): Promise<unknown>;
  inspect(input: Record<string, unknown>): Promise<unknown>;
  waitFor(input: Record<string, unknown>): Promise<unknown>;
  screenshot(input: Record<string, unknown>): Promise<unknown>;
  waitForDocumentReady(
    accepts: (state: { url: string; timeOrigin: number }) => boolean,
    timeoutMs: number,
  ): Promise<{ url: string; readyState: string; timeOrigin: number }>;
  waitForHistoryEntryReady(
    target: { index: number; entryId: number },
    timeoutMs: number,
  ): Promise<{ url: string }>;
  invalidate(): void;
  invalidateObservation(): void;
  /**
   * A page script sent a non-GET request, submitted a form or navigated:
   * recorded like an uncertain write, so the next write waits for a read.
   */
  recordPageScriptWrite(url: string | undefined): void;
}

function loadReached(readyState: unknown, wait: ProgramLoadState): boolean {
  return wait === 'load' ? readyState === 'complete' : readyState !== 'loading';
}

/**
 * Where a pointer action dispatches, in main-viewport pixels. A ref's element
 * in a frame whose place in the page could not be measured has only a point
 * in its frame's viewport: a click there would land on another element.
 */
function pointerPoint(located: ProgramPageResponse): { x: number; y: number } {
  if (
    located.frameLocal === true ||
    typeof located.x !== 'number' ||
    typeof located.y !== 'number'
  ) {
    throw new BrowserProgramError(
      'NOT_ACTIONABLE',
      'The target is inside a frame whose position in the page could not be measured, so the pointer cannot be aimed at it.',
      {
        retryable: false,
        recovery:
          'Locate it with page.locator(css), page.getByRole() or page.getByText() instead of the ref: locators reach into iframes.',
      },
    );
  }
  return { x: located.x, y: located.y };
}

/** The page operations: conditions instead of fixed delays, no page summaries, no screenshots. */
export class BrowserProgramOps {
  constructor(private readonly host: BrowserProgramHost) {}

  private get state(): BrowserSessionState {
    return this.host.state;
  }

  /** Runs one op inside the session gate; the result follows the Browser Core result shape. */
  run(op: ProgramOp): Promise<Record<string, unknown>> {
    switch (op.op) {
      case 'goto':
        return this.goto(op.url, op.wait ?? 'load', op.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
      case 'back':
        return this.back(op.wait ?? 'load', op.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
      case 'reload':
        return this.reload(op.wait ?? 'load', op.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS);
      case 'click':
      case 'dblclick':
        return this.click(op.target, op.op === 'dblclick' ? 2 : 1, this.actionTimeout(op));
      case 'hover':
        return this.hover(op.target, this.actionTimeout(op));
      case 'check':
      case 'uncheck':
        return this.setChecked(op.target, op.op === 'check', this.actionTimeout(op));
      case 'fill':
        return this.fill(op.target, op.value, this.actionTimeout(op));
      case 'type':
        return this.type(op.target, op.value, this.actionTimeout(op));
      case 'press':
        return this.press(op.target, op.key, this.actionTimeout(op));
      case 'selectOption':
        return this.selectOption(op.target, op.values, this.actionTimeout(op));
      case 'read':
        return this.read(op.target, op.what, this.actionTimeout(op));
      case 'readAll':
        return this.readAll(op.target, op.fields, op.limit, this.actionTimeout(op));
      case 'rows':
        return this.rows(op);
      case 'waitFor':
        return this.waitFor(op);
      case 'waitForResponse':
        return this.waitForResponse(
          op.urlIncludes,
          op.afterSequence,
          op.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS,
        );
      case 'observe':
        return this.observe(op.mode ?? 'interactive');
      case 'url':
      case 'title':
        return this.pageFact(op.op, this.actionTimeout(op));
      case 'screenshot':
        return this.screenshot(op.fullPage === true);
      case 'mouseClick':
        return this.mouseClick(op.x, op.y, op.button, op.clickCount);
      case 'mouseMove':
        return this.mouseMove(op.x, op.y);
      case 'mouseWheel':
        return this.mouseWheel(op.x, op.y, op.deltaX, op.deltaY);
      case 'evaluate':
        return runPageScript(this.host, op);
      default:
        throw new BrowserProgramError('INVALID_OP', `${op.op} does not run in the session gate.`);
    }
  }

  private actionTimeout(op: { readonly timeoutMs?: number }): number {
    return op.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  }

  /** page.mouse.click: real input at viewport coordinates, no element and no actionability check. */
  private async mouseClick(
    x: number,
    y: number,
    button: 'left' | 'right' | 'middle',
    clickCount: number,
  ): Promise<Record<string, unknown>> {
    await awaitMainFrameCommit(this.state, Date.now() + DEFAULT_ACTION_TIMEOUT_MS);
    await this.state.beforePointerAction?.(
      { action: clickCount > 1 ? 'double_click' : 'click', point: { x, y } },
      this.state.commandSignal,
    );
    await this.host.enableNetworkForSubmit();
    await ensureMainFrameKnown(this.state);
    const watch = watchMainFrameNavigation(this.state);
    try {
      await this.host.dispatchMouse(x, y, 'mouseMoved');
      for (let current = 1; current <= clickCount; current += 1) {
        await this.host.dispatchMouse(x, y, 'mousePressed', { button, clickCount: current });
        await this.host.dispatchMouse(x, y, 'mouseReleased', { button, clickCount: current });
      }
      return this.writeResult(await watch.settle());
    } finally {
      watch.dispose();
    }
  }

  private async mouseMove(x: number, y: number): Promise<Record<string, unknown>> {
    await awaitMainFrameCommit(this.state, Date.now() + DEFAULT_ACTION_TIMEOUT_MS);
    await this.state.beforePointerAction?.(
      { action: 'hover', point: { x, y } },
      this.state.commandSignal,
    );
    await this.host.dispatchMouse(x, y, 'mouseMoved');
    this.host.invalidateObservation();
    return { success: true, value: {}, effect: { dispatched: true } };
  }

  private async mouseWheel(
    x: number,
    y: number,
    deltaX: number,
    deltaY: number,
  ): Promise<Record<string, unknown>> {
    await awaitMainFrameCommit(this.state, Date.now() + DEFAULT_ACTION_TIMEOUT_MS);
    await cdp(this.state, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
    this.host.invalidateObservation();
    return { success: true, value: {}, effect: { dispatched: true } };
  }

  private async goto(
    url: string,
    wait: ProgramLoadState,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (!/^https?:\/\//iu.test(url) && url !== 'about:blank') {
      throw new BrowserProgramError('INVALID_OP', 'goto needs an absolute http(s) URL.');
    }
    const deadline = Date.now() + timeoutMs;
    // Buffers the page's requests for waitForResponse from its first request on.
    await this.state.cdpHelper.startDOMListener(this.state.commandSignal);
    const before = this.state.mainFrameLoad?.pending ? undefined : await this.documentIdentity();
    return this.pendingIfSlow('page.goto', async () => {
      const navigation = await sendMainFrameNavigationCommand<{
        errorText?: string;
        isDownload?: boolean;
      }>(this.state, 'Page.navigate', { url }, Math.max(1, deadline - Date.now()));
      if (
        navigation.errorText &&
        (navigation.errorText !== 'net::ERR_ABORTED' || navigation.isDownload === true)
      ) {
        throw new BrowserProgramError('NAVIGATION_FAILED', navigation.errorText, {
          recovery: 'Check the URL; the page was not loaded.',
        });
      }
      return this.settleNavigation(before, wait, deadline, navigation.errorText);
    });
  }

  /**
   * A GET the server answered whose document is still loading at the deadline
   * is a result with the pending load, not a timeout: the load goes on and the
   * next op waits for its commit (same as navigate and reload actions).
   */
  private async pendingIfSlow(
    op: string,
    navigate: () => Promise<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    try {
      return await navigate();
    } catch (error) {
      if (!(error instanceof MainFrameNavigationPending)) throw error;
      this.host.invalidate();
      const result = pendingNavigationResult(op, error.load, {});
      return { ...result, value: { url: error.load.url ?? '', loaded: false, pending: true } };
    }
  }

  private async back(wait: ProgramLoadState, timeoutMs: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    const history = await cdp<{
      currentIndex: number;
      entries: readonly { id: number; url: string }[];
    }>(this.state, 'Page.getNavigationHistory');
    const index = history.currentIndex - 1;
    const entry = history.entries[index];
    if (!entry) {
      throw new BrowserProgramError('NO_HISTORY', 'There is no earlier page in this tab.', {
        recovery: 'Use page.goto(url) instead.',
      });
    }
    await cdp(this.state, 'Page.navigateToHistoryEntry', { entryId: entry.id });
    await this.host.waitForHistoryEntryReady(
      { index, entryId: entry.id },
      Math.max(1, deadline - Date.now()),
    );
    return this.settleNavigation(undefined, wait, deadline);
  }

  private async reload(
    wait: ProgramLoadState,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    const before = this.state.mainFrameLoad?.pending ? undefined : await this.documentIdentity();
    return this.pendingIfSlow('page.reload', async () => {
      await sendMainFrameNavigationCommand(
        this.state,
        'Page.reload',
        { ignoreCache: false },
        Math.max(1, deadline - Date.now()),
      );
      return this.settleNavigation(before, wait, deadline);
    });
  }

  private async documentIdentity(): Promise<{ url: string; timeOrigin: number } | undefined> {
    const page = await callProgramPage(this.state, { kind: 'page' });
    return typeof page.url === 'string' && typeof page.timeOrigin === 'number'
      ? { url: page.url, timeOrigin: page.timeOrigin }
      : undefined;
  }

  private async settleNavigation(
    before: { url: string; timeOrigin: number } | undefined,
    wait: ProgramLoadState,
    deadline: number,
    errorText?: string,
  ): Promise<Record<string, unknown>> {
    try {
      await this.host.waitForDocumentReady(
        (state) => !before || state.url !== before.url || state.timeOrigin !== before.timeOrigin,
        Math.max(1, deadline - Date.now()),
      );
    } catch (error) {
      if (!errorText || error instanceof MainFrameNavigationPending) throw error;
      throw new BrowserProgramError('NAVIGATION_FAILED', errorText, {
        recovery: 'Check the URL; the page was not loaded.',
      });
    }
    let page = await callProgramPage(this.state, { kind: 'page' });
    let loaded = loadReached(page.readyState, wait);
    while (!loaded && Date.now() < deadline) {
      await delay(POLL_INTERVAL_MS, this.state.commandSignal);
      page = await callProgramPage(this.state, { kind: 'page' });
      loaded = loadReached(page.readyState, wait);
    }
    const url = asString(page.url);
    if (url.startsWith('chrome-error://')) {
      throw new BrowserProgramError('NAVIGATION_FAILED', 'Chrome rendered its error page.', {
        recovery: 'Check the URL and whether the site is reachable.',
      });
    }
    this.host.invalidate();
    const title = asString(page.title);
    return {
      success: true,
      url,
      title,
      value: { url, title, loaded },
      navigation: { detected: true, urlChanged: true, loaded, committed: true },
    };
  }

  private async pointerClick(located: ProgramPageResponse, clickCount: number): Promise<void> {
    const { x, y } = pointerPoint(located);
    await this.state.beforePointerAction?.(
      { action: clickCount > 1 ? 'double_click' : 'click', point: { x, y } },
      this.state.commandSignal,
    );
    await this.host.dispatchMouse(x, y, 'mouseMoved');
    for (let current = 1; current <= clickCount; current += 1) {
      await this.host.dispatchMouse(x, y, 'mousePressed', { button: 'left', clickCount: current });
      await this.host.dispatchMouse(x, y, 'mouseReleased', { button: 'left', clickCount: current });
    }
  }

  /** The result of a write that may navigate: what browser events showed, never a page read. */
  private writeResult(
    facts: NavigationFacts,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    this.host.invalidateObservation();
    const load =
      facts.committed || facts.sameDocument ? undefined : this.state.mainFrameLoad?.pending;
    const navigation: Record<string, unknown> | undefined =
      load || facts.detected
        ? {
            detected: true,
            ...(facts.url ? { url: facts.url } : {}),
            ...(facts.sameDocument ? { sameDocument: true } : {}),
            ...(facts.committed ? { committed: true } : {}),
            ...(load ? pendingLoadFacts(load) : {}),
          }
        : undefined;
    return {
      success: true,
      value: { ...(navigation ? { navigation } : {}), ...extra },
      effect: { dispatched: true },
      ...(navigation ? { navigation } : {}),
      ...(facts.url ? { url: facts.url } : {}),
    };
  }

  private async click(
    target: ProgramLocator,
    clickCount: number,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const located = await retryUntilOk(
      this.state,
      target,
      { kind: 'probe', checks: { enabled: true, pointer: true } },
      timeoutMs,
    );
    await this.host.enableNetworkForSubmit();
    await ensureMainFrameKnown(this.state);
    const watch = watchMainFrameNavigation(this.state);
    try {
      await this.pointerClick(located, clickCount);
      const facts = await watch.settle();
      return {
        ...this.writeResult(facts),
        ...(located.opensNewTab === true ? { opensNewTab: true } : {}),
      };
    } finally {
      watch.dispose();
    }
  }

  private async hover(target: ProgramLocator, timeoutMs: number): Promise<Record<string, unknown>> {
    const located = await retryUntilOk(
      this.state,
      target,
      { kind: 'probe', checks: { pointer: true } },
      timeoutMs,
    );
    const { x, y } = pointerPoint(located);
    await this.state.beforePointerAction?.(
      { action: 'hover', point: { x, y } },
      this.state.commandSignal,
    );
    await this.host.dispatchMouse(x, y, 'mouseMoved');
    this.host.invalidateObservation();
    return { success: true, value: {}, effect: { dispatched: true } };
  }

  private async setChecked(
    target: ProgramLocator,
    checked: boolean,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const before = await retryUntilOk(this.state, target, { kind: 'checkState' }, timeoutMs);
    if (before.checkable !== true) {
      throw new BrowserProgramError(
        'TARGET_NOT_CHECKABLE',
        'The target is not a checkbox or radio.',
        {
          recovery: 'Locate the checkbox or radio itself, or use click().',
        },
      );
    }
    if (before.checked === checked) {
      return { success: true, value: { checked }, effect: { dispatched: false } };
    }
    const located = await retryUntilOk(
      this.state,
      target,
      { kind: 'probe', checks: { enabled: true, pointer: true, labelFallback: true } },
      timeoutMs,
    );
    // The read-back and the fallback act on the element the click aimed at: a
    // locator such as `input:not(:checked)` names the next box once this one is checked.
    const pinned = await pinLocatorNode(this.state, target).catch((error: unknown) => {
      if (isBrowserOperationInterruption(error)) throw error;
      return undefined;
    });
    const at = pinned
      ? (request: ProgramPageRequest) =>
          callAtBackendNode(
            this.state,
            pinned.backendNodeId,
            { ...request, chain: [] },
            pinned.sessionId ? { sessionId: pinned.sessionId } : {},
          )
      : undefined;
    // Whether the pointer click reaches the control (or one of its labels):
    // one that did must not be clicked again, its state may follow a server answer.
    await at?.({ kind: 'armClick' }).catch((error: unknown) => {
      if (isBrowserOperationInterruption(error)) throw error;
    });
    await this.host.enableNetworkForSubmit();
    await ensureMainFrameKnown(this.state);
    // A checkbox whose change handler loads another URL (filter facets)
    // replaces the document: report the navigation like a click instead of
    // reading back a control that is gone.
    const watch = watchMainFrameNavigation(this.state);
    try {
      await this.pointerClick(located, 1);
      const facts = await watch.settle();
      if (facts.detected && !facts.sameDocument) return this.writeResult(facts, { checked });
    } finally {
      watch.dispose();
    }
    this.host.invalidateObservation();
    // A radio cannot be unchecked at all: no fallback click for that.
    const after = at
      ? await this.pinnedCheckState(at, checked, checked || before.type !== 'radio')
      : undefined;
    if (after?.checked === checked) {
      return { success: true, value: { checked }, effect: { dispatched: true } };
    }
    const action = checked ? 'check' : 'uncheck';
    if (!after) {
      // The page replaced the control, or it could not be pinned: nothing is
      // clicked again, and no other element's state, nor the detached old
      // node's, stands in for its own.
      return {
        success: false,
        code: 'CHECK_STATE_UNCONFIRMED',
        error: `The ${action} was dispatched, but the control it reached could not be read back.`,
        recovery: 'The click may have applied. Read the page before retrying.',
        effect: { dispatched: true },
      };
    }
    if (after.reached === true || after.reachUnknown === true) {
      return {
        success: false,
        code: 'CHECK_STATE_UNCONFIRMED',
        error:
          after.reached === true
            ? `The ${action} reached the control, but it is still ${after.checked === true ? 'checked' : 'unchecked'} ${CHECK_SETTLE_MS} ms later.`
            : `The ${action} was dispatched, but the control is still ${after.checked === true ? 'checked' : 'unchecked'}; whether the click reached it is unknown.`,
        recovery:
          'A control that follows a server answer may still change. Read it before retrying: clicking it again could toggle it back.',
        effect: { dispatched: true },
      };
    }
    return {
      success: false,
      code: 'CHECK_STATE_NOT_APPLIED',
      error: `The ${action} was dispatched, but the control is ${after.checked === true ? 'checked' : 'unchecked'}.`,
      recovery: 'The page may reject or control this field; read it before retrying.',
      effect: { dispatched: true },
    };
  }

  /**
   * The state of the control a check clicked, read from that node only. A
   * click that reached the control is never repeated: a control that follows a
   * server answer gets up to CHECK_SETTLE_MS to show it (`reached` in the
   * answer when it does not). Only a click that provably missed (a styled
   * label of another control) gets one direct activation; one whose reach is
   * unknown (`reachUnknown`: not armed, or a page handler stopped every click
   * before our listeners) gets none. A node the page took
   * out (detached, though CDP still resolves it while JavaScript holds it, or
   * gone) reads as undefined and gets no fallback click: its old handlers could
   * send the write a second time.
   */
  private async pinnedCheckState(
    at: (request: ProgramPageRequest) => Promise<ProgramPageResponse>,
    checked: boolean,
    canFallBack: boolean,
  ): Promise<(ProgramPageResponse & { reached?: true; reachUnknown?: true }) | undefined> {
    try {
      // Removes the listener whatever the state: read before anything else.
      const { reached } = await at({ kind: 'clickReached' });
      let after = await at({ kind: 'checkState' });
      if (after.connected === false) return undefined;
      if (after.checked === checked) return after;
      if (reached === true) {
        const deadline = Date.now() + CHECK_SETTLE_MS;
        while (after.checked !== checked && Date.now() < deadline) {
          await delay(POLL_INTERVAL_MS, this.state.commandSignal);
          after = await at({ kind: 'checkState' });
          if (after.connected === false) return undefined;
        }
        return after.checked === checked ? after : { ...after, reached: true };
      }
      // Unknown (undefined): whether the click reached it is unknown, so no second click.
      if (reached !== false) return { ...after, reachUnknown: true };
      if (!canFallBack) return after;
      if ((await at({ kind: 'activate' })).connected === false) return undefined;
      const again = await at({ kind: 'checkState' });
      return again.connected === false ? undefined : again;
    } catch (error) {
      if (error instanceof BrowserProgramError && error.code === 'STALE_ELEMENT_REF')
        return undefined;
      throw error;
    }
  }

  private async fill(
    target: ProgramLocator,
    value: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const generation = this.state.generation;
    const prepared = await retryUntilOk(
      this.state,
      target,
      { kind: 'prepareFill', value },
      timeoutMs,
    );
    if (prepared.mode === 'value') {
      this.host.invalidateObservation();
      if (asString(prepared.actual) === value) {
        return { success: true, value: { value }, effect: { dispatched: true } };
      }
      return {
        success: false,
        code: 'ACTION_EFFECT_MISMATCH',
        error: `The field normalized the value to ${JSON.stringify(prepared.actual)}.`,
        recovery: 'Use the format this input type accepts, for example YYYY-MM-DD for a date.',
        actual: prepared.actual,
        effect: { dispatched: true },
      };
    }
    // The text goes to whatever holds focus when it is inserted: a field whose
    // focus handler hands focus on (to an amount field, a search box) would get
    // it in another field. The read-back reads the field itself, not the focus;
    // a field the page re-rendered on input is read through the locator again.
    const pinned = await pinLocatorNode(this.state, target).catch((error: unknown) => {
      if (isBrowserOperationInterruption(error)) throw error;
      return undefined;
    });
    const at = async (request: ProgramPageRequest): Promise<ProgramPageResponse> => {
      if (!pinned) return callAtLocator(this.state, target, request);
      try {
        return await callAtBackendNode(
          this.state,
          pinned.backendNodeId,
          { ...request, chain: [] },
          pinned.sessionId ? { sessionId: pinned.sessionId } : {},
        );
      } catch (error) {
        if (!(error instanceof BrowserProgramError && error.code === 'STALE_ELEMENT_REF')) {
          throw error;
        }
        return callAtLocator(this.state, target, request);
      }
    };
    if ((await at({ kind: 'focused' })).focused !== true) {
      throw notActionable(describeProgramLocator(target), 'not_focusable', timeoutMs);
    }
    if (value === '') await this.host.dispatchKey('Backspace', []);
    else await cdp(this.state, 'Input.insertText', { text: value });
    return this.verifyFill(value, generation, at);
  }

  /** A controlled field may apply the value a tick later, so a mismatch is read again twice. */
  private async verifyFill(
    value: string,
    generation: number,
    at: (request: ProgramPageRequest) => Promise<ProgramPageResponse>,
  ): Promise<Record<string, unknown>> {
    this.host.invalidateObservation();
    if (this.state.generation !== generation) return unexpectedNavigationResult();
    let check = await at({ kind: 'fillCheck', expected: value });
    for (let retry = 0; check.matches !== true && retry < READBACK_RETRIES; retry += 1) {
      await delay(READBACK_RETRY_MS, this.state.commandSignal);
      if (this.state.generation !== generation) return unexpectedNavigationResult();
      check = await at({ kind: 'fillCheck', expected: value });
    }
    if (check.matches === true) {
      return { success: true, value: { value }, effect: { dispatched: true, verified: true } };
    }
    return {
      success: false,
      code: 'ACTION_EFFECT_MISMATCH',
      error: `After filling, the field holds ${typeof check.actual === 'string' ? JSON.stringify(check.actual) : 'a different value'}.`,
      recovery:
        'The page reformats or rejects this value. Read the field and decide; for a rich editor, end the program and use the single-step fill action on its ref.',
      ...(typeof check.actual === 'string' ? { actual: check.actual } : {}),
      effect: { dispatched: true, verified: false },
    };
  }

  private async type(
    target: ProgramLocator | undefined,
    value: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (target) await retryUntilOk(this.state, target, { kind: 'focus' }, timeoutMs);
    await cdp(this.state, 'Input.insertText', { text: value });
    this.host.invalidateObservation();
    return { success: true, value: {}, effect: { dispatched: true } };
  }

  private async press(
    target: ProgramLocator | undefined,
    combo: string,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (target) await retryUntilOk(this.state, target, { kind: 'focus' }, timeoutMs);
    const parts = splitKeyCombo(combo);
    const key = parts.at(-1) ?? combo;
    await this.host.enableNetworkForSubmit();
    await ensureMainFrameKnown(this.state);
    const watch = watchMainFrameNavigation(this.state);
    try {
      await this.host.dispatchKey(key, parts.slice(0, -1).map(platformModifier));
      return this.writeResult(await watch.settle());
    } finally {
      watch.dispose();
    }
  }

  private async selectOption(
    target: ProgramLocator,
    values: readonly string[],
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const startedAt = Date.now();
    await ensureMainFrameKnown(this.state);
    // A select whose change handler loads another URL (sort or page-size
    // pickers) navigates right after the selection: report it like a click.
    const watch = watchMainFrameNavigation(this.state);
    try {
      const answer = await retryUntilOk(
        this.state,
        target,
        { kind: 'select', values },
        timeoutMs,
        SELECT_MUTATION_FUNCTION,
      );
      const mutation = answer.mutation as SelectMutationState | undefined;
      const refused = selectMutationFailure(mutation, values, startedAt, undefined);
      if (refused) return refused;
      const selected = mutation?.selectedValues ?? [];
      const wanted = mutation?.resolvedValues ?? values;
      const facts = await watch.settle();
      if (facts.detected && !facts.sameDocument) {
        return this.writeResult(facts, { values: selected });
      }
      this.host.invalidateObservation();
      if (selected.length === wanted.length && wanted.every((value) => selected.includes(value))) {
        return { success: true, value: { values: selected }, effect: { dispatched: true } };
      }
    } finally {
      watch.dispose();
    }
    return {
      success: false,
      code: 'SELECT_STATE_NOT_APPLIED',
      error: 'A page script changed the selection right after it was made.',
      recovery: 'Read the select before retrying.',
      effect: { dispatched: true },
    };
  }

  private async read(
    target: ProgramLocator,
    what: Extract<ProgramOp, { op: 'read' }>['what'],
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    if (what === 'count') {
      const counted = await callOnceReady(
        this.state,
        target,
        { kind: 'count' },
        timeoutMs,
        (response) => response.count === 0,
      );
      return { success: true, value: counted.count ?? 0, visibleCount: counted.visible };
    }
    if (what === 'visible' || what === 'enabled' || what === 'checked') {
      // A control that is not there is not visible, enabled or checked; a program's
      // "is there a next page" check must not wait out a timeout or throw.
      const state = await callOnceReady(
        this.state,
        target,
        { kind: 'read', what },
        timeoutMs,
        (response) => response.error === 'not_found',
      );
      return { success: true, value: state.error === 'not_found' ? false : state.value };
    }
    const answer = await retryUntilOk(this.state, target, { kind: 'read', what }, timeoutMs);
    return { success: true, value: answer.value };
  }

  private async readAll(
    target: ProgramLocator,
    fields: Extract<ProgramOp, { op: 'readAll' }>['fields'],
    limit: number | undefined,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const answer = await callOnceReady(
      this.state,
      target,
      {
        kind: 'readAll',
        fields,
        limit: Math.min(limit ?? DEFAULT_READ_ALL_ROWS, MAX_READ_ALL_ROWS),
        budget: READ_ALL_CHAR_BUDGET,
      },
      timeoutMs,
      (response) => response.total === 0,
    );
    return {
      success: true,
      value: {
        rows: answer.rows ?? [],
        total: answer.total ?? 0,
        truncated: answer.truncated === true,
      },
    };
  }

  private async rows(op: Extract<ProgramOp, { op: 'rows' }>): Promise<Record<string, unknown>> {
    const [first] = op.target.chain;
    if (op.target.chain.length !== 1 || first?.by !== 'css') {
      throw new BrowserProgramError(
        'INVALID_OP',
        'rows() needs a plain page.locator(css) target.',
        {
          recovery: 'Use readAll() or allTextContents() for other locators.',
        },
      );
    }
    await awaitMainFrameCommit(
      this.state,
      Date.now() + (op.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS),
    );
    const page = await this.host.query({
      kind: 'rows',
      selector: first.selector,
      ...(op.fields ? { fields: op.fields } : {}),
      ...(op.limit === undefined ? {} : { limit: op.limit }),
      ...(op.offset === undefined ? {} : { offset: op.offset }),
      ...(op.maxChars === undefined ? {} : { maxChars: op.maxChars }),
    });
    if (!isRecord(page))
      throw new BrowserProgramError('BROWSER_OP_FAILED', 'rows returned nothing.');
    if (page.success === false) return page;
    return {
      success: true,
      value: {
        rows: page.rows ?? [],
        totalRows: page.totalRows ?? 0,
        ...(page.nextOffset === undefined ? {} : { nextOffset: page.nextOffset }),
      },
    };
  }

  private async waitFor(
    op: Extract<ProgramOp, { op: 'waitFor' }>,
  ): Promise<Record<string, unknown>> {
    const timeoutMs = op.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const what = describeWait(op.target, op.state, op.url, op.text, op.load);
    for (;;) {
      await awaitMainFrameCommit(this.state, Math.max(deadline, Date.now() + 1));
      if (await this.waitConditionMet(op)) return { success: true, value: { waited: true } };
      if (Date.now() >= deadline) throw waitTimedOut(what, timeoutMs);
      await delay(POLL_INTERVAL_MS, this.state.commandSignal);
    }
  }

  private async waitConditionMet(op: Extract<ProgramOp, { op: 'waitFor' }>): Promise<boolean> {
    if (op.url !== undefined || op.text !== undefined || op.load !== undefined) {
      const page = await callProgramPage(this.state, {
        kind: 'page',
        ...(op.url === undefined ? {} : { url: op.url }),
        ...(op.text === undefined ? {} : { text: op.text }),
      }).catch((error: unknown) => {
        if (isRetryablePageError(error)) return undefined;
        throw error;
      });
      if (!page) return false;
      if (op.url !== undefined && page.urlMatches !== true) return false;
      if (op.text !== undefined && page.textFound !== true) return false;
      if (op.load !== undefined && !loadReached(page.readyState, op.load)) return false;
    }
    if (!op.target) return true;
    const state = await callAtLocator(this.state, op.target, {
      kind: 'state',
      state: op.state ?? 'visible',
    }).catch((error: unknown) => {
      if (isRetryablePageError(error)) return undefined;
      throw error;
    });
    if (state?.error === 'invalid') {
      throw new BrowserProgramError(
        'LOCATOR_INVALID',
        state.message ?? 'The locator of this wait is invalid.',
      );
    }
    return state?.met === true;
  }

  private async waitForResponse(
    urlIncludes: string,
    afterSequence: number | undefined,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    const result = await this.host.waitFor({
      kind: 'network',
      filter: urlIncludes,
      timeout: timeoutMs,
      ...(afterSequence === undefined ? {} : { afterSequence }),
    });
    if (!isRecord(result))
      throw new BrowserProgramError('BROWSER_OP_FAILED', 'wait returned nothing.');
    if (result.success === false) {
      return result.code === 'ACTION_TIMEOUT' ? { ...result, code: 'TIMEOUT' } : result;
    }
    return { success: true, value: result.entry ?? {} };
  }

  private async observe(mode: 'outline' | 'interactive'): Promise<Record<string, unknown>> {
    const page = await this.host.inspect({ limit: MAX_OBSERVE_ELEMENTS });
    if (!isRecord(page))
      throw new BrowserProgramError('BROWSER_OP_FAILED', 'observe read nothing.');
    const elements = Array.isArray(page.elements) ? page.elements.filter(isRecord) : [];
    const compact = elements.map((element) => {
      const attributes = isRecord(element.attributes) ? element.attributes : {};
      const name = asString(element.text) || asString(attributes['aria-label']);
      return {
        ref: asString(element.ref),
        role: asString(element.role),
        ...(name ? { name } : {}),
        ...(typeof element.value === 'string' ? { value: element.value } : {}),
        ...(typeof element.checked === 'boolean' ? { checked: element.checked } : {}),
      };
    });
    const semanticTree = isRecord(page.semanticTree) ? page.semanticTree : undefined;
    return {
      success: true,
      url: page.url,
      title: page.title,
      value: {
        url: page.url,
        title: page.title,
        elements: compact,
        ...(page.truncated === true ? { truncated: true } : {}),
        ...(mode === 'outline' && Array.isArray(semanticTree?.roots)
          ? { outline: renderOutline(semanticTree.roots) }
          : {}),
      },
    };
  }

  private async pageFact(
    fact: 'url' | 'title',
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    await awaitMainFrameCommit(this.state, Date.now() + timeoutMs);
    const page = await callProgramPage(this.state, { kind: 'page' });
    return { success: true, url: asString(page.url), value: asString(page[fact]) };
  }

  private async screenshot(fullPage: boolean): Promise<Record<string, unknown>> {
    const shot = await this.host.screenshot({ scope: fullPage ? 'fullPage' : 'viewport' });
    if (!isRecord(shot)) throw new BrowserProgramError('BROWSER_OP_FAILED', 'screenshot failed.');
    return shot.success === false ? shot : { ...shot, success: true, value: shot };
  }
}

function unexpectedNavigationResult(): Record<string, unknown> {
  return {
    success: false,
    code: 'UNEXPECTED_NAVIGATION',
    error: 'Input changed the active page unexpectedly.',
    effect: { dispatched: true, verified: false },
    navigation: { detected: true },
  };
}

function describeWait(
  target: ProgramLocator | undefined,
  state: ProgramElementState | undefined,
  url: ProgramTextMatch | undefined,
  text: ProgramTextMatch | undefined,
  load: ProgramLoadState | undefined,
): string {
  return [
    ...(target ? [`the element to be ${state ?? 'visible'}`] : []),
    ...(url === undefined ? [] : ['the URL']),
    ...(text === undefined ? [] : ['the text']),
    ...(load ? [`the ${load} state`] : []),
  ].join(', ');
}

/** The semantic tree as indented lines with refs, for a model that looks at the page once. */
function renderOutline(roots: readonly unknown[]): string {
  const lines: string[] = [];
  const visit = (node: unknown, depth: number): void => {
    if (!isRecord(node)) return;
    const name = asString(node.name) || asString(node.text);
    lines.push(
      `${'  '.repeat(depth)}- ${asString(node.role)}${name ? ` ${JSON.stringify(name)}` : ''}${asString(node.ref) ? ` [${asString(node.ref)}]` : ''}`,
    );
    if (Array.isArray(node.children)) for (const child of node.children) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return lines.join('\n');
}
