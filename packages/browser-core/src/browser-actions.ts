import { captureBrowserScreenshot, observeBrowserDownload } from './browser-action-artifacts.js';
import {
  buttonName,
  classifyBrowserNavigationEvent,
  waitExpression,
  waitSelectorTimeoutRecovery,
  type BrowserWaitPoll,
} from './browser-action-helpers.js';
import { BrowserActionTargetSupport } from './browser-action-targets.js';
import { EDITABLE_FIELD_SOURCE } from './browser-editable-field.js';
import {
  describeInputDiagnosis,
  diagnoseUnfocusedInput,
  unfocusedInputRecovery,
} from './browser-input-diagnosis.js';
import { browserPrintableKeyDescriptor } from './browser-keyboard.js';
import {
  aimAtProbe,
  probeBrowserClickTarget,
  targetNotFocusableResult,
  targetNotInteractableResult,
  type BrowserClickProbe,
} from './browser-click-interactability.js';
import {
  answeredGetLoad,
  MainFrameNavigationPending,
  pendingLoadFacts,
  pendingNavigationResult,
} from './browser-main-frame-load.js';
import {
  sendMainFrameNavigationCommand,
  watchMainFrameNavigation,
  type MainFrameNavigationFacts,
  type MainFrameNavigationWatch,
} from './browser-navigation-watch.js';
import {
  asNumber,
  asString,
  cdp,
  delay,
  type CdpExceptionDetails,
  describeCdpException,
  evaluate,
  isRecord,
  resolveBrowserSnapshotElement,
  stringArray,
  type Rect,
  type BrowserSessionState as SessionState,
} from './browser-state.js';
import type {
  CDPEditableState,
  CDPNetworkDiagnosticResourceType,
  CDPNetworkDiagnosticStatusFilter,
  CDPRenderedState,
} from './cdp-helper-contracts.js';
import { isBrowserOperationInterruption, throwIfAborted } from './operation-timeout.js';
import { uncertainWriteNext, unexpectedNavigationRetry } from './browser-write-record.js';

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
/** A request counts for wait kind "network" once it loaded, got an HTTP error or failed. */
const FINISHED_NETWORK_STATUS: CDPNetworkDiagnosticStatusFilter[] = [
  'success',
  'failed',
  '4xx',
  '5xx',
];
const ACTION_SETTLE_DELAY_MS = 100;
const CLICK_NAVIGATION_DETECTION_MS = 1_000;
const NAVIGATION_READY_TIMEOUT_MS = 30_000;
/** What a navigation keeps after its waits to settle and read the new page. */
const NAVIGATION_RESULT_RESERVE_MS = 1_000;
const MAX_NAVIGATION_READY_TIMEOUT_MS = 120_000;
const HISTORY_READY_TIMEOUT_MS = 10_000;
const SCROLL_BOUNDARY_EPSILON = 1;
const VERIFIED_FILL_SAMPLE_COUNT = 4;
const VERIFIED_FILL_SAMPLE_DELAY_MS = 50;

interface BrowserScrollSnapshot {
  ownerId: string;
  kind: 'document' | 'element' | 'unknown';
  scrollable: boolean;
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
}

function normalizeScrollSnapshot(value: unknown, axis: 'x' | 'y'): BrowserScrollSnapshot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  const numericFields = [
    'scrollTop',
    'scrollLeft',
    'scrollHeight',
    'scrollWidth',
    'clientHeight',
    'clientWidth',
  ] as const;
  if (
    (candidate.kind === 'document' ||
      candidate.kind === 'element' ||
      candidate.kind === 'unknown') &&
    typeof candidate.ownerId === 'string' &&
    candidate.ownerId.length > 0 &&
    typeof candidate.scrollable === 'boolean' &&
    numericFields.every(
      (field) => typeof candidate[field] === 'number' && Number.isFinite(candidate[field]),
    )
  ) {
    return candidate as unknown as BrowserScrollSnapshot;
  }

  // Keep the original document-only response shape readable while providers
  // and focused test transports move to owner-aware snapshots.
  const legacyNumericFields = [
    'x',
    'y',
    'scrollHeight',
    'scrollWidth',
    'clientHeight',
    'clientWidth',
  ] as const;
  if (
    !legacyNumericFields.every(
      (field) => typeof candidate[field] === 'number' && Number.isFinite(candidate[field]),
    )
  ) {
    return null;
  }
  const scrollHeight = candidate.scrollHeight as number;
  const scrollWidth = candidate.scrollWidth as number;
  const clientHeight = candidate.clientHeight as number;
  const clientWidth = candidate.clientWidth as number;
  return {
    ownerId: 'document',
    kind: 'document',
    scrollable:
      axis === 'y'
        ? scrollHeight > clientHeight + SCROLL_BOUNDARY_EPSILON
        : scrollWidth > clientWidth + SCROLL_BOUNDARY_EPSILON,
    scrollTop: candidate.y as number,
    scrollLeft: candidate.x as number,
    scrollHeight,
    scrollWidth,
    clientHeight,
    clientWidth,
  };
}

interface DocumentReadiness {
  readonly url: string;
  readonly readyState: string;
  readonly timeOrigin: number;
}

interface NavigationHistoryEntry {
  readonly id: number;
  readonly url: string;
}

interface NavigationHistory {
  readonly currentIndex: number;
  readonly entries: readonly NavigationHistoryEntry[];
}

interface NavigationEventObservation {
  readonly method: 'Page.frameNavigated' | 'Page.navigatedWithinDocument';
  readonly params: unknown;
  readonly sessionId?: string;
}

/** Resolves with the main-document navigation event, or undefined at the timeout. */
function observeMainDocumentNavigation(
  session: SessionState,
  timeoutMs: number,
  mainFrameId?: string,
): Promise<NavigationEventObservation | undefined> {
  const childSessionIds = new Set(
    (session.transport.listAttachedFrames?.() ?? []).map((frame) => frame.sessionId),
  );
  return new Promise((resolve) => {
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    const signal = session.commandSignal;
    const finish = (value: NavigationEventObservation | undefined): void => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      unsubscribe?.();
      resolve(value);
    };
    const onAbort = (): void => finish(undefined);

    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    unsubscribe = session.transport.onEvent((event) => {
      if (
        event.method !== 'Page.frameNavigated' &&
        event.method !== 'Page.navigatedWithinDocument'
      ) {
        return;
      }
      if (event.sessionId && childSessionIds.has(event.sessionId)) return;
      const observation: NavigationEventObservation = {
        method: event.method,
        params: event.params,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      };
      if (classifyBrowserNavigationEvent(observation, session.transport, mainFrameId) !== 'main')
        return;
      finish(observation);
    });
    if (finished) {
      unsubscribe();
      return;
    }
    timer = setTimeout(() => finish(undefined), timeoutMs);
    timer.unref?.();
  });
}

export abstract class BrowserActionSupport extends BrowserActionTargetSupport {
  protected async navigate(
    session: SessionState,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const url = asString(input.url);
    if (!isSupportedBrowserUrl(url)) {
      throw new Error('Unsupported Browser URL: expected http(s), file, data, or about URL');
    }
    const startedAt = Date.now();
    // A page still loading a document cannot be read (the read would wait for
    // the commit): any document after this navigation then counts as new.
    const loading = session.mainFrameLoad?.pending !== undefined;
    const beforeUrl = loading ? undefined : (await this.readPageSummary(session)).url;
    // Register the shared diagnostics listener before the first external
    // navigation. Enabling Runtime/Network at the transport layer does not
    // buffer events for a CDPHelper listener that has not been attached yet.
    await session.cdpHelper.startDOMListener(session.commandSignal);
    const beforeTimeOrigin = loading
      ? undefined
      : await this.evaluateMainDocument<number>(session, 'performance.timeOrigin');
    const movedToNewDocument = (state: DocumentReadiness): boolean =>
      beforeUrl === undefined || state.url !== beforeUrl || state.timeOrigin !== beforeTimeOrigin;
    try {
      const navigation = await sendMainFrameNavigationCommand<{
        errorText?: string;
        isDownload?: boolean;
      }>(session, 'Page.navigate', { url }, this.navigationBudgetMs(session));
      // Chromium answers ERR_ABORTED when a redirect or a cross-process swap
      // replaces the requested load while the tab still commits the target
      // document. The retired Electron loadURL path ignored ERR_ABORTED for this
      // reason; in one desktop evaluation the first cross-site navigate from an
      // inspected about:blank failed in 35/43 tasks although the page had committed.
      // Only a tab that never reaches a new document failed.
      if (
        navigation.errorText &&
        (navigation.errorText !== 'net::ERR_ABORTED' || navigation.isDownload === true)
      ) {
        throw new Error(`NAVIGATION_FAILED: ${navigation.errorText}`);
      }
      await this.waitForDocumentReady(
        session,
        movedToNewDocument,
        this.navigationBudgetMs(session),
      ).catch((error: unknown) => {
        // Transport interruptions carry a code and keep their recovery path.
        const transportInterruption = error instanceof Error && 'code' in error;
        if (
          !navigation.errorText ||
          session.commandSignal?.aborted ||
          transportInterruption ||
          error instanceof MainFrameNavigationPending
        ) {
          throw error;
        }
        throw new Error(`NAVIGATION_FAILED: ${navigation.errorText}`);
      });
    } catch (error) {
      if (!(error instanceof MainFrameNavigationPending)) throw error;
      this.invalidate(session);
      return pendingNavigationResult('navigate', error.load, {
        durationMs: Date.now() - startedAt,
      });
    }
    await delay(ACTION_SETTLE_DELAY_MS, session.commandSignal);
    this.invalidate(session);
    const page = await this.readPageSummary(session);
    this.assertNotChromeErrorPage(page, `while navigating to ${url}`);
    return {
      success: true,
      url: page.url,
      title: page.title,
      durationMs: Date.now() - startedAt,
      navigation: {
        detected: true,
        urlChanged: true,
        loaded: true,
        generation: session.generation,
      },
    };
  }

  protected async history(session: SessionState, direction: 'back' | 'forward'): Promise<unknown> {
    const startedAt = Date.now();
    const before = await this.readPageSummary(session);
    const history = await this.readNavigationHistory(session);
    const targetIndex = history.currentIndex + (direction === 'back' ? -1 : 1);
    const target = history.entries[targetIndex];
    if (!target) {
      return {
        success: false,
        durationMs: Date.now() - startedAt,
        url: before.url,
        title: before.title,
        navigation: { detected: false, urlChanged: false, loaded: true },
      };
    }
    await this.sendMainDocumentCommand(session, 'Page.navigateToHistoryEntry', {
      entryId: target.id,
    });
    await this.waitForHistoryEntryReady(
      session,
      { index: targetIndex, entryId: target.id },
      HISTORY_READY_TIMEOUT_MS,
    );
    await delay(ACTION_SETTLE_DELAY_MS, session.commandSignal);
    this.invalidate(session);
    const after = await this.readPageSummary(session);
    this.assertNotChromeErrorPage(after, `while navigating ${direction}`);
    return {
      success: true,
      durationMs: Date.now() - startedAt,
      url: after.url,
      title: after.title,
      navigation: {
        detected: true,
        urlChanged: before.url !== after.url,
        loaded: true,
        generation: session.generation,
      },
    };
  }

  protected async reload(session: SessionState): Promise<unknown> {
    const startedAt = Date.now();
    const beforeTimeOrigin =
      session.mainFrameLoad?.pending === undefined
        ? await this.evaluateMainDocument<number>(session, 'performance.timeOrigin')
        : undefined;
    try {
      await sendMainFrameNavigationCommand(
        session,
        'Page.reload',
        { ignoreCache: false },
        this.navigationBudgetMs(session),
      );
      await this.waitForDocumentReady(
        session,
        (state) => beforeTimeOrigin === undefined || state.timeOrigin !== beforeTimeOrigin,
        this.navigationBudgetMs(session),
      );
    } catch (error) {
      if (!(error instanceof MainFrameNavigationPending)) throw error;
      this.invalidate(session);
      return pendingNavigationResult('reload', error.load, {
        durationMs: Date.now() - startedAt,
      });
    }
    await delay(ACTION_SETTLE_DELAY_MS, session.commandSignal);
    this.invalidate(session);
    const page = await this.readPageSummary(session);
    this.assertNotChromeErrorPage(page, 'while reloading the current page');
    return {
      success: true,
      url: page.url,
      title: page.title,
      navigation: { detected: true, loaded: true },
    };
  }

  /**
   * How long a navigation step may still wait: the readiness window, cut so
   * that a slow document is reported (pending) before the action deadline
   * fires, whose recovery resets the connection.
   */
  private navigationBudgetMs(session: SessionState): number {
    const untilDeadline =
      session.actionDeadlineAt === undefined
        ? NAVIGATION_READY_TIMEOUT_MS
        : session.actionDeadlineAt - Date.now() - NAVIGATION_RESULT_RESERVE_MS;
    return Math.max(1, Math.min(NAVIGATION_READY_TIMEOUT_MS, untilDeadline));
  }

  protected async waitForDocumentReady(
    session: SessionState,
    acceptsUrl: (state: DocumentReadiness) => boolean,
    timeoutMs: number,
  ): Promise<DocumentReadiness> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      // Until the new document commits a renderer read would wait for it and
      // run into its own deadline (a slow reload ended that way); wait for
      // the commit with browser events instead.
      const mainFrameLoad = session.mainFrameLoad;
      if (mainFrameLoad?.pending) {
        await mainFrameLoad.waitForCommit(
          Math.max(1, deadline - Date.now()),
          session.commandSignal,
        );
        throwIfAborted(session.commandSignal);
        if (mainFrameLoad.pending) break;
        continue;
      }
      try {
        const state = await this.evaluateMainDocument<DocumentReadiness>(
          session,
          '({ url: location.href, readyState: document.readyState, timeOrigin: performance.timeOrigin })',
        );
        if (
          acceptsUrl(state) &&
          (state.readyState === 'interactive' || state.readyState === 'complete')
        ) {
          return state;
        }
      } catch (error) {
        if (session.commandSignal?.aborted || isBrowserOperationInterruption(error)) throw error;
        // A navigation may briefly destroy the prior execution context.
      }
      await delay(50, session.commandSignal);
    }
    const pending = answeredGetLoad(session.mainFrameLoad?.pending);
    if (pending) throw new MainFrameNavigationPending(pending);
    throw new Error(`ACTION_TIMEOUT: Browser navigation was not DOM-ready within ${timeoutMs}ms`);
  }

  protected assertNotChromeErrorPage(page: { readonly url: string }, context: string): void {
    if (!page.url.startsWith('chrome-error://')) return;
    throw new Error(`NAVIGATION_FAILED: Browser rendered an internal error page ${context}`);
  }

  protected evaluateMainDocument<T>(session: SessionState, expression: string): Promise<T> {
    return session.transport.evaluate<T>(expression, {
      ...(session.commandSignal ? { signal: session.commandSignal } : {}),
      ...(session.commandTimeoutMs ? { timeoutMs: session.commandTimeoutMs } : {}),
    });
  }

  private sendMainDocumentCommand<T = unknown>(
    session: SessionState,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    return session.transport.send<T>(method, params, undefined, {
      ...(session.commandSignal ? { signal: session.commandSignal } : {}),
      ...(session.commandTimeoutMs ? { timeoutMs: session.commandTimeoutMs } : {}),
    });
  }

  private async readMainFrameId(session: SessionState): Promise<string | undefined> {
    try {
      const result = await this.sendMainDocumentCommand<{
        frameTree?: { frame?: { id?: string } };
      }>(session, 'Page.getFrameTree');
      return typeof result.frameTree?.frame?.id === 'string'
        ? result.frameTree.frame.id
        : undefined;
    } catch (error) {
      if (isBrowserOperationInterruption(error)) throw error;
      return undefined;
    }
  }

  /**
   * Watches for a main-frame navigation the page's own handlers start after
   * an element input (a select whose change handler loads another URL).
   * Browser events only, so it is safe while the new document is loading.
   */
  protected async watchInputNavigation(session: SessionState): Promise<MainFrameNavigationWatch> {
    const mainFrameId = await this.readMainFrameId(session);
    if (mainFrameId && session.mainFrameLoad) session.mainFrameLoad.mainFrameId = mainFrameId;
    return watchMainFrameNavigation(session);
  }

  /**
   * Whether the page left its document after an input: a cross-document
   * navigation was seen, a main-frame load is pending, or the page generation
   * moved. The old element can no longer be read back then.
   */
  protected inputNavigated(
    session: SessionState,
    facts: MainFrameNavigationFacts,
    generation: number,
  ): boolean {
    return (
      (facts.detected && facts.sameDocument !== true) ||
      session.mainFrameLoad?.pending !== undefined ||
      session.generation !== generation
    );
  }

  /**
   * The result of an element input whose page navigated: the input was
   * applied and the page moved on, so it is a completed action with the same
   * navigation facts as a navigating click, not a read-back failure.
   */
  protected navigatedByInputResult(
    session: SessionState,
    action: string,
    facts: MainFrameNavigationFacts,
    fields: Record<string, unknown>,
  ): Record<string, unknown> {
    this.invalidateObservation(session);
    const load = facts.committed ? undefined : session.mainFrameLoad?.pending;
    return {
      success: true,
      ...fields,
      navigation: {
        detected: true,
        urlChanged: true,
        generation: session.generation,
        ...(facts.url ? { url: facts.url } : {}),
        ...(load ? pendingLoadFacts(load) : {}),
      },
      message: `The ${action} made the page navigate${load ? '; the new page is still loading' : ''}. Refs from earlier snapshots are no longer valid.`,
      recovery: load
        ? 'Wait for the new page (wait with a url or load condition) or inspect it in a few seconds before the next interaction.'
        : 'Inspect or query the new page before the next interaction.',
    };
  }

  private readNavigationHistory(session: SessionState): Promise<NavigationHistory> {
    return this.sendMainDocumentCommand<NavigationHistory>(session, 'Page.getNavigationHistory');
  }

  protected async waitForHistoryEntryReady(
    session: SessionState,
    target: { index: number; entryId: number },
    timeoutMs: number,
  ): Promise<DocumentReadiness> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      try {
        const history = await this.readNavigationHistory(session);
        const currentEntry = history.entries[history.currentIndex];
        if (history.currentIndex === target.index && currentEntry?.id === target.entryId) {
          const state = await this.evaluateMainDocument<DocumentReadiness>(
            session,
            '({ url: location.href, readyState: document.readyState, timeOrigin: performance.timeOrigin })',
          );
          if (state.readyState === 'interactive' || state.readyState === 'complete') return state;
        }
      } catch (error) {
        if (session.commandSignal?.aborted || isBrowserOperationInterruption(error)) throw error;
        // Cross-document history traversal can briefly destroy the old
        // execution context. Keep polling the root page until the target
        // history entry and its document are both observable.
      }
      await delay(50, session.commandSignal);
    }
    throw new Error(`ACTION_TIMEOUT: Browser history was not DOM-ready within ${timeoutMs}ms`);
  }

  protected async click(session: SessionState, input: Record<string, unknown>): Promise<unknown> {
    const startedAt = Date.now();
    const before = await this.readPageSummary(session);
    const explicitNavigationTimeout = input.__navigationTimeoutMs;
    const navigationTimeoutMs =
      explicitNavigationTimeout === undefined
        ? (session.clickNavigationDetectionMs ?? CLICK_NAVIGATION_DETECTION_MS)
        : Math.max(
            CLICK_NAVIGATION_DETECTION_MS,
            Math.min(
              MAX_NAVIGATION_READY_TIMEOUT_MS,
              Math.floor(asNumber(explicitNavigationTimeout, CLICK_NAVIGATION_DETECTION_MS)),
            ),
          );
    const coordinateTarget =
      input.position !== undefined || input.normalized_position !== undefined;
    const clickCount = Math.max(1, Math.floor(asNumber(input.clickCount ?? input.click_count, 1)));
    const pointerAction =
      clickCount > 2 ? 'triple_click' : clickCount > 1 ? 'double_click' : 'click';
    const resolved = await this.resolveTarget(session, input).catch((error: unknown) =>
      error instanceof Error ? error : new Error(String(error)),
    );
    if (resolved instanceof Error) {
      // A ref whose element has no box at all (display: none, a collapsed
      // menu) reads as stale; say what hides it when the element still exists.
      if (!coordinateTarget && /no longer has a live box/u.test(resolved.message)) {
        const hidden = await probeBrowserClickTarget(session, input);
        if (hidden.blocked) {
          return targetNotInteractableResult(pointerAction, hidden.blocked, Date.now() - startedAt);
        }
      }
      throw resolved;
    }
    // Pre-click hit test: a click whose center would land on another element
    // (an overlay) or on nothing (a hidden target) is not dispatched.
    const probe: BrowserClickProbe = coordinateTarget
      ? {}
      : await probeBrowserClickTarget(session, input);
    if (probe.blocked) {
      return targetNotInteractableResult(pointerAction, probe.blocked, Date.now() - startedAt);
    }
    // The click lands where the probe hit-tested the target (see aimAtProbe).
    const target = aimAtProbe(resolved, probe);
    const hitTarget = coordinateTarget
      ? await this.inspectCoordinateHitTarget(
          session,
          target.contextX ?? target.x,
          target.contextY ?? target.y,
        )
      : undefined;
    await session.beforePointerAction?.(
      { action: pointerAction, point: { x: target.x, y: target.y } },
      session.commandSignal,
    );
    const effectProbe = await this.startClickEffectProbe(
      session,
      target.contextX ?? target.x,
      target.contextY ?? target.y,
    );
    const downloadEvent = observeBrowserDownload(session, { signal: session.commandSignal });
    const mainFrameId = await this.readMainFrameId(session);
    if (mainFrameId && session.mainFrameLoad) session.mainFrameLoad.mainFrameId = mainFrameId;
    const navigationEvent = observeMainDocumentNavigation(
      session,
      navigationTimeoutMs,
      mainFrameId,
    );
    await this.dispatchMouse(session, target.x, target.y, 'mouseMoved');
    const delayMs = Math.max(0, Math.floor(asNumber(input.delay, 50)));
    if (delayMs > 0) await delay(delayMs, session.commandSignal);
    for (let currentClick = 1; currentClick <= clickCount; currentClick += 1) {
      await this.dispatchMouse(session, target.x, target.y, 'mousePressed', {
        button: buttonName(input.button),
        clickCount: currentClick,
      });
      if (delayMs > 0) await delay(delayMs, session.commandSignal);
      await this.dispatchMouse(session, target.x, target.y, 'mouseReleased', {
        button: buttonName(input.button),
        clickCount: currentClick,
      });
      if (currentClick < clickCount && delayMs > 0) {
        await delay(delayMs, session.commandSignal);
      }
    }
    const navigationEventResult = await navigationEvent;
    await delay(ACTION_SETTLE_DELAY_MS, session.commandSignal);
    const download = await downloadEvent;
    // The click started a main-frame navigation that has not committed (a
    // submit whose next page is slow): renderer reads would wait for the
    // commit, so the page is reported as the previous one with the pending
    // load instead of being read.
    const loading = session.mainFrameLoad?.pending;
    // A navigation can replace the execution context before the first
    // post-click summary is available. The navigation event is the source of
    // truth for click-and-wait; keep ordinary click bounded and let its caller
    // perform the full ready-state wait.
    const after = loading
      ? before
      : await this.readPageSummary(session).catch((error) => {
          if (isBrowserOperationInterruption(error)) throw error;
          return before;
        });
    const unobserved = {
      observed: false,
      mutations: 0,
      focusChanged: false,
      targetStateChanged: false,
    };
    const effect = loading
      ? unobserved
      : await this.finishClickEffectProbe(session, effectProbe).catch((error) => {
          if (isBrowserOperationInterruption(error)) throw error;
          return unobserved;
        });
    const navigationDetected =
      classifyBrowserNavigationEvent(navigationEventResult, session.transport, mainFrameId) ===
        'main' || before.url !== after.url;
    this.invalidateObservation(session);
    const result = {
      // Ordinary click success means that Browser input was dispatched. DOM
      // mutation/focus probes are diagnostics, not proof that the caller's
      // business goal completed. Main-document navigation remains the one
      // fail-closed exception for this non-navigation action.
      success: !navigationDetected,
      durationMs: Date.now() - startedAt,
      target: {
        resolved: true,
        rect: target.rect,
        ...(coordinateTarget
          ? {
              resolvedPosition: { x: target.x, y: target.y },
              ...(hitTarget ? { hitTarget, rect: hitTarget.rect } : {}),
            }
          : {}),
        // What the clicked control does (link, form submit, in-page), for the
        // follow-up a caller suggests after a click that showed no navigation.
        ...(probe.control ? { control: probe.control } : {}),
      },
      effect: {
        ...effect,
        dispatched: true,
        verified: false,
        verificationRequired: true,
      },
      navigation: {
        detected: navigationDetected,
        urlChanged: navigationDetected,
        generation: session.generation,
        ...(loading ? pendingLoadFacts(loading) : {}),
      },
    } as Record<string, unknown>;
    if (download) {
      result.download = download;
      if (download.state === 'canceled') {
        result.success = false;
        result.code = 'DOWNLOAD_CANCELED';
        result.error = 'Browser download was canceled before completion.';
      } else if (download.state !== 'completed') {
        // The click and download start were observed. Do not report an action
        // failure merely because a large/slow file outlived our observation
        // window; callers can inspect the explicit in-progress timeout state.
        result.success = true;
        result.download = { ...download, observation: 'timeout' };
        result.recovery = 'The download is still in progress; do not click again.';
      } else {
        result.success = true;
      }
    }
    if (navigationDetected && result.code !== 'DOWNLOAD_CANCELED') {
      // The click was dispatched and the page observably navigated. Clicking a
      // link is the most common way to navigate, so this is a completed action,
      // not a failure (eval: 139 false failures on successful link clicks).
      // Keep the navigation facts explicit because every earlier ref is now
      // invalid; the caller must observe the new page before acting on it.
      result.success = true;
      result.message =
        'The click navigated the page. Refs from earlier snapshots are no longer valid.';
      result.recovery = 'Inspect or query the new page before the next interaction.';
    }
    if (loading && !navigationDetected && result.code !== 'DOWNLOAD_CANCELED') {
      const status = loading.httpStatus ?? loading.redirectStatus;
      result.message = `The click started a ${loading.requestMethod ?? 'page'} navigation that is still loading; the page shown is still the previous one.${status === undefined ? '' : ` The server already answered the request with HTTP ${status}.`}`;
      result.recovery =
        'Do not click or submit again. Wait for the new page (wait with a url condition) or inspect again in a few seconds; check the result on the site before any retry.';
    }
    return result;
  }

  private async inspectCoordinateHitTarget(
    session: SessionState,
    x: number,
    y: number,
  ): Promise<
    | {
        tag: string;
        role: string;
        name: string;
        text: string;
        rect: { x: number; y: number; width: number; height: number };
      }
    | undefined
  > {
    return evaluate<
      | {
          tag: string;
          role: string;
          name: string;
          text: string;
          rect: { x: number; y: number; width: number; height: number };
        }
      | undefined
    >(
      session,
      `(() => {
        const point = { x: ${JSON.stringify(x)}, y: ${JSON.stringify(y)} };
        let element = document.elementFromPoint(point.x, point.y);
        while (element?.shadowRoot && typeof element.shadowRoot.elementFromPoint === 'function') {
          const deeper = element.shadowRoot.elementFromPoint(point.x, point.y);
          if (!deeper || deeper === element) break;
          element = deeper;
        }
        if (!(element instanceof Element)) return undefined;
        const rect = element.getBoundingClientRect();
        const text = String(element.textContent || '').replace(/\\s+/gu, ' ').trim();
        const name = element.getAttribute('aria-label') || element.getAttribute('title') || text;
        return {
          tag: String(element.tagName || '').toLowerCase().slice(0, 80),
          role: String(element.getAttribute('role') || '').slice(0, 80),
          name: String(name || '').slice(0, 300),
          text: text.slice(0, 300),
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      })()`,
    ).catch((error) => {
      if (isBrowserOperationInterruption(error)) throw error;
      return undefined;
    });
  }

  private async startClickEffectProbe(
    session: SessionState,
    x: number,
    y: number,
  ): Promise<{ key: string; before: string }> {
    const key = `__mavisClickProbe_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const before = await evaluate<string>(
      session,
      `(() => {
        const key = ${JSON.stringify(key)};
        const pointed = document.elementFromPoint(${x}, ${y});
        const state = (node) => node ? JSON.stringify({
          tag: node.tagName,
          id: node.id,
          value: 'value' in node ? String(node.value ?? '') : '',
          checked: 'checked' in node ? Boolean(node.checked) : undefined,
          pressed: node.getAttribute?.('aria-pressed'),
          expanded: node.getAttribute?.('aria-expanded'),
          selected: node.getAttribute?.('aria-selected'),
          disabled: node.getAttribute?.('aria-disabled'),
          className: typeof node.className === 'string' ? node.className : '',
        }) : '';
        const record = { count: 0, observer: null, beforeTarget: state(pointed), x: ${x}, y: ${y} };
        record.observer = new MutationObserver((entries) => { record.count += entries.length; });
        record.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        window[key] = record;
        return JSON.stringify({ active: state(document.activeElement), target: record.beforeTarget });
      })()`,
    );
    return { key, before };
  }

  private async finishClickEffectProbe(
    session: SessionState,
    probe: { key: string; before: string },
  ): Promise<{
    observed: boolean;
    mutations: number;
    focusChanged: boolean;
    targetStateChanged: boolean;
  }> {
    return evaluate(
      session,
      `(() => {
      const key = ${JSON.stringify(probe.key)};
      const record = window[key];
      if (!record) return { observed: false, mutations: 0, focusChanged: false, targetStateChanged: false };
      record.observer?.disconnect();
      const pointed = document.elementFromPoint(record.x, record.y);
      const state = (node) => node ? JSON.stringify({
        tag: node.tagName,
        id: node.id,
        value: 'value' in node ? String(node.value ?? '') : '',
        checked: 'checked' in node ? Boolean(node.checked) : undefined,
        pressed: node.getAttribute?.('aria-pressed'),
        expanded: node.getAttribute?.('aria-expanded'),
        selected: node.getAttribute?.('aria-selected'),
        disabled: node.getAttribute?.('aria-disabled'),
        className: typeof node.className === 'string' ? node.className : '',
      }) : '';
      const before = JSON.parse(${JSON.stringify(probe.before)});
      const active = state(document.activeElement);
      const target = state(pointed);
      const focusChanged = before.active !== active;
      const targetStateChanged = before.target !== target;
      const mutations = Number(record.count || 0);
      delete window[key];
      return { observed: mutations > 0 || focusChanged || targetStateChanged, mutations, focusChanged, targetStateChanged };
    })()`,
    );
  }

  protected async type(session: SessionState, input: Record<string, unknown>): Promise<unknown> {
    const startedAt = Date.now();
    const beforeGeneration = session.generation;
    const target = await this.resolveTarget(session, input, true, false, true);
    const text = asString(input.text);
    const delayMs = Math.max(0, Math.floor(asNumber(input.delay, 0)));
    const unexpectedNavigation = (dispatched: boolean): Record<string, unknown> => ({
      success: false,
      code: 'UNEXPECTED_NAVIGATION',
      error: 'Typing changed the active Browser page unexpectedly.',
      // Retryable only before any input was sent (Browser Core rechecks the request method).
      ...unexpectedNavigationRetry('type', { dispatched }),
      durationMs: Date.now() - startedAt,
      target: { resolved: true, rect: target.rect },
      effect: {
        dispatched,
        verified: false,
        verificationRequired: true,
        expectedTextLength: text.length,
      },
      navigation: { detected: true, generation: session.generation },
    });
    let inputDispatched = false;
    if (session.generation !== beforeGeneration) return unexpectedNavigation(false);
    if (target.backendNodeId === undefined) {
      // Coordinate locators (absolute or normalized) focus the field under the
      // point with a real click, then type into whatever received focus.
      const coordinateTarget =
        (input.normalized_position !== undefined || input.position !== undefined) &&
        !asString(input.ref) &&
        !asString(input.selector);
      if (!coordinateTarget) throw new Error('TYPE_REQUIRES_ELEMENT_REF');
      // A point on a native date/time/range control must take the same value
      // path as a ref: click + insertText is exactly what failed on these
      // controls in eval 761096, and here it would fail silently (verified:false).
      const pointedInput = await this.resolveControlAtPoint(session, target, 'input');
      if (session.generation !== beforeGeneration) return unexpectedNavigation(false);
      if (pointedInput !== undefined) {
        const pointedValueControl = await this.readValueControlType(session, pointedInput);
        if (session.generation !== beforeGeneration) return unexpectedNavigation(false);
        if (pointedValueControl) {
          return this.applyValueControl(session, {
            backendNodeId: pointedInput,
            inputType: pointedValueControl,
            text,
            rect: target.rect,
            startedAt,
            beforeGeneration,
          });
        }
      }
      await session.beforePointerAction?.(
        { action: 'type', point: { x: target.x, y: target.y } },
        session.commandSignal,
      );
      await this.dispatchMouse(session, target.x, target.y, 'mouseMoved');
      inputDispatched = true;
      if (session.generation !== beforeGeneration) return unexpectedNavigation(inputDispatched);
      await delay(50, session.commandSignal);
      if (session.generation !== beforeGeneration) return unexpectedNavigation(inputDispatched);
      const clickCount = input.clear === true ? 3 : 1;
      for (let currentClick = 1; currentClick <= clickCount; currentClick += 1) {
        await this.dispatchMouse(session, target.x, target.y, 'mousePressed', {
          button: 'left',
          clickCount: currentClick,
        });
        inputDispatched = true;
        await delay(50, session.commandSignal);
        await this.dispatchMouse(session, target.x, target.y, 'mouseReleased', {
          button: 'left',
          clickCount: currentClick,
        });
        if (session.generation !== beforeGeneration) return unexpectedNavigation(inputDispatched);
        if (currentClick < clickCount) {
          await delay(50, session.commandSignal);
          if (session.generation !== beforeGeneration) {
            return unexpectedNavigation(inputDispatched);
          }
        }
      }
      await delay(ACTION_SETTLE_DELAY_MS, session.commandSignal);
      if (session.generation !== beforeGeneration) return unexpectedNavigation(inputDispatched);
      inputDispatched =
        (await this.insertText(session, text, delayMs, beforeGeneration)) || inputDispatched;
      if (session.generation !== beforeGeneration) return unexpectedNavigation(inputDispatched);
      await delay(ACTION_SETTLE_DELAY_MS, session.commandSignal);
      if (session.generation !== beforeGeneration) return unexpectedNavigation(inputDispatched);
      this.invalidateObservation(session);
      return {
        success: true,
        durationMs: Date.now() - startedAt,
        target: {
          resolved: true,
          rect: target.rect,
          resolvedPosition: { x: target.x, y: target.y },
        },
        effect: {
          dispatched: true,
          verified: false,
          verificationRequired: true,
          expectedTextLength: text.length,
        },
      };
    }
    const backendNodeId = target.backendNodeId;
    const ref = asString(input.ref);
    const observedElement = ref
      ? (resolveBrowserSnapshotElement(session, ref)?.element ??
        session.elementMap.getElementByOpaqueRef(ref))
      : null;
    if (target.virtualEditor !== true) {
      // Refs carry the inspected input type, so the common path costs no extra
      // CDP round trip; only selector targets read it from the live node.
      const valueControlType = observedElement
        ? valueControlTypeOf(observedElement.tag, observedElement.attributes.type)
        : await this.readValueControlType(session, backendNodeId);
      if (session.generation !== beforeGeneration) return unexpectedNavigation(false);
      if (valueControlType) {
        return this.applyValueControl(session, {
          backendNodeId,
          inputType: valueControlType,
          text,
          rect: target.rect,
          startedAt,
          beforeGeneration,
        });
      }
    }
    const inspectionOptions = {
      ...(session.commandSignal ? { signal: session.commandSignal } : {}),
      ...(session.commandTimeoutMs ? { timeoutMs: session.commandTimeoutMs } : {}),
      ...(session.commandSessionId ? { commandSessionId: session.commandSessionId } : {}),
    };
    const inspectTextState = (
      expectedText?: string,
    ): Promise<CDPEditableState | CDPRenderedState> =>
      target.virtualEditor === true
        ? session.cdpHelper.inspectRenderedStateByBackendNodeId(
            backendNodeId,
            expectedText,
            inspectionOptions,
          )
        : session.cdpHelper.inspectEditableStateByBackendNodeId(
            backendNodeId,
            expectedText,
            inspectionOptions,
          );
    let before: CDPEditableState | CDPRenderedState;
    try {
      before = await inspectTextState();
    } catch (error) {
      if (isBrowserOperationInterruption(error)) throw error;
      if (session.generation !== beforeGeneration) return unexpectedNavigation(false);
      throw error;
    }
    if (session.generation !== beforeGeneration) return unexpectedNavigation(false);
    const targetMetadata = {
      resolved: true,
      tag: 'tag' in before ? before.tag : (observedElement?.tag ?? ''),
      role: 'role' in before ? before.role : (observedElement?.role ?? ''),
      contentEditable:
        'contentEditable' in before
          ? before.contentEditable
          : observedElement?.attributes.contenteditable === 'true',
      ...(observedElement?.attributes.type
        ? { inputType: observedElement.attributes.type.toLowerCase() }
        : {}),
      ...(target.virtualEditor === true ? { virtual: true } : {}),
      rect: target.rect,
    };
    if (target.virtualEditor !== true && 'editable' in before && !before.editable) {
      return {
        success: false,
        code: 'TARGET_NOT_EDITABLE',
        error: 'The resolved Browser target is not editable.',
        message: 'The resolved Browser target is not editable.',
        retryable: false,
        recovery: 'Inspect the page and choose an input, textarea, or contenteditable ref.',
        durationMs: Date.now() - startedAt,
        target: targetMetadata,
        effect: { dispatched: false, verified: false, verificationRequired: true },
        navigation: { detected: false, generation: session.generation },
      };
    }
    if (target.coordinateSpace !== 'unavailable') {
      await session.beforePointerAction?.(
        {
          action: 'type',
          point: { x: target.x, y: target.y },
        },
        session.commandSignal,
      );
    }
    if (target.virtualEditor === true) {
      if (target.coordinateSpace === 'unavailable') {
        throw new Error(
          'FRAME_COORDINATES_UNAVAILABLE: virtual editor activation requires safe viewport coordinates',
        );
      }
      inputDispatched = true;
      try {
        await this.activateVirtualEditor(session, {
          x: target.x,
          y: target.y,
          backendNodeId: target.backendNodeId,
        });
      } catch (error) {
        if (isBrowserOperationInterruption(error)) throw error;
        if (session.generation !== beforeGeneration) {
          return unexpectedNavigation(inputDispatched);
        }
        throw error;
      }
    } else {
      try {
        await cdp(session, 'DOM.focus', { backendNodeId: target.backendNodeId });
      } catch (error) {
        if (isBrowserOperationInterruption(error)) throw error;
        if (!/element is not focusable/iu.test(error instanceof Error ? error.message : '')) {
          throw error;
        }
        // Nothing was typed. The hit test says whether an inert or collapsed
        // group holds the field (open it first), the field is disabled, or the
        // target is no field.
        const probe = await probeBrowserClickTarget(session, input, { nativeDisabled: true });
        return targetNotFocusableResult(
          input.clear === true ? 'fill' : 'type',
          probe.blocked,
          Date.now() - startedAt,
        );
      }
    }
    if (session.generation !== beforeGeneration) return unexpectedNavigation(inputDispatched);
    if (input.clear === true) {
      inputDispatched = true;
      await session.cdpHelper.selectAllAtCurrentFocus({
        ...(session.commandSignal ? { signal: session.commandSignal } : {}),
        ...(session.commandTimeoutMs ? { timeoutMs: session.commandTimeoutMs } : {}),
      });
      if (session.generation !== beforeGeneration) return unexpectedNavigation(inputDispatched);
      // Native inputs replace the selection with the inserted text in one input
      // event. Deleting first exposes an empty intermediate value that
      // controlled number fields reset to "0", so fill "13" produced "013"
      // (eval 762809). Only an empty replacement still needs Backspace; virtual
      // editors keep the explicit delete because their key path is not insertText.
      if (target.virtualEditor === true || text.length === 0) {
        await this.dispatchKey(session, 'Backspace', []);
        if (session.generation !== beforeGeneration) return unexpectedNavigation(inputDispatched);
      }
    }
    if (target.virtualEditor === true) {
      for (const char of text) {
        if (session.generation !== beforeGeneration) return unexpectedNavigation(inputDispatched);
        inputDispatched = true;
        await this.dispatchVirtualEditorCharacter(session, char);
        if (session.generation !== beforeGeneration) return unexpectedNavigation(inputDispatched);
        if (delayMs > 0) {
          await delay(delayMs, session.commandSignal);
          if (session.generation !== beforeGeneration) {
            return unexpectedNavigation(inputDispatched);
          }
        }
      }
    } else {
      inputDispatched =
        (await this.insertText(session, text, delayMs, beforeGeneration)) || inputDispatched;
      if (session.generation !== beforeGeneration) return unexpectedNavigation(inputDispatched);
    }
    // The text went out: a read-back that fails for another reason than a
    // timeout or a page change is no failed write the model may simply
    // repeat (type would append the text a second time).
    const readBackFailed = (error: unknown): Record<string, unknown> => {
      if (!inputDispatched) throw error;
      this.invalidateObservation(session);
      const reason = `The text was sent, but the field could not be read back: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return {
        success: false,
        code: 'ACTION_VERIFICATION_UNAVAILABLE',
        error: reason,
        message: reason,
        retryable: false,
        recovery: uncertainWriteNext(input.clear === true ? 'fill' : 'type'),
        durationMs: Date.now() - startedAt,
        target: targetMetadata,
        effect: {
          dispatched: true,
          verified: false,
          verificationRequired: true,
          expectedTextLength: text.length,
        },
        navigation: { detected: false, generation: session.generation },
      };
    };
    await delay(ACTION_SETTLE_DELAY_MS, session.commandSignal);
    const clear = input.clear === true;
    const samples: Array<CDPEditableState | CDPRenderedState> = [];
    try {
      const sampleCount = clear ? VERIFIED_FILL_SAMPLE_COUNT : 1;
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        if (sampleIndex > 0) {
          await delay(VERIFIED_FILL_SAMPLE_DELAY_MS, session.commandSignal);
          if (session.generation !== beforeGeneration) {
            return unexpectedNavigation(inputDispatched);
          }
        }
        samples.push(await inspectTextState(text));
      }
    } catch (error) {
      if (isBrowserOperationInterruption(error)) throw error;
      if (session.generation !== beforeGeneration) return unexpectedNavigation(inputDispatched);
      return readBackFailed(error);
    }
    if (session.generation !== beforeGeneration) return unexpectedNavigation(inputDispatched);
    const after = samples[samples.length - 1];
    const previous = samples[samples.length - 2];
    if (!after) throw new Error('Browser input verification did not produce a final sample.');
    const changed = after.fingerprint !== before.fingerprint;
    const matchesExpected = clear
      ? previous?.matchesExpected === true &&
        after.matchesExpected === true &&
        previous.fingerprint === after.fingerprint
      : undefined;
    const containsExpected = clear
      ? undefined
      : text.length === 0 || (changed && after.containsExpected === true);
    let focused = 'focused' in after ? after.focused === true : false;
    if (target.virtualEditor === true) {
      try {
        const focusedState = await session.cdpHelper.inspectFocusedEditableStateByBackendNodeId(
          target.backendNodeId,
          inspectionOptions,
        );
        if (session.generation !== beforeGeneration) return unexpectedNavigation(inputDispatched);
        focused =
          focusedState.editable === true &&
          focusedState.focused === true &&
          focusedState.withinTarget === true;
      } catch (error) {
        if (isBrowserOperationInterruption(error)) throw error;
        if (session.generation !== beforeGeneration) return unexpectedNavigation(inputDispatched);
        return readBackFailed(error);
      }
    }
    const verified =
      target.virtualEditor === true && !focused
        ? false
        : clear
          ? matchesExpected === true
          : containsExpected === true;
    const continuationRef = asString(input.ref);
    this.invalidateObservation(session);
    if (continuationRef) {
      session.keyboardContinuationTarget = {
        ref: continuationRef,
        backendNodeId: target.backendNodeId,
        ...(target.rect ? { rect: target.rect } : {}),
        ...(observedElement?.frameId ? { frameId: observedElement.frameId } : {}),
        ...(session.commandSessionId ? { commandSessionId: session.commandSessionId } : {}),
      };
    }
    // Typed text that did not verify but changed the field (a mask, an
    // upper-casing handler, an editor that dropped focus after taking the
    // text) is in the field: typing it again appends it twice. The write
    // record reads this fact; a fill replaces the whole value instead.
    const appended = !verified && !clear && changed;
    const result = {
      success: verified,
      durationMs: Date.now() - startedAt,
      target: targetMetadata,
      effect: {
        dispatched: true,
        verified,
        verificationRequired: true,
        focused,
        expectedTextLength: text.length,
        textLength: after.textLength,
        textChanged: changed,
        ...(clear ? { matchesExpected } : {}),
        ...(!clear ? { containsExpected } : {}),
        ...(appended ? { appended: true } : {}),
      },
      navigation: { detected: false, generation: session.generation },
    } as Record<string, unknown>;
    if (!verified) {
      const virtualEditor = target.virtualEditor === true;
      const code =
        virtualEditor && !focused
          ? 'INPUT_FOCUS_REJECTED'
          : clear
            ? virtualEditor
              ? changed
                ? 'INPUT_PARTIAL_EFFECT'
                : 'INPUT_EVENT_NOT_CONSUMED'
              : 'ACTION_EFFECT_MISMATCH'
            : changed
              ? 'INPUT_PARTIAL_EFFECT'
              : virtualEditor
                ? 'INPUT_EVENT_NOT_CONSUMED'
                : 'ACTION_EFFECT_NOT_OBSERVED';
      const error =
        code === 'INPUT_FOCUS_REJECTED'
          ? 'The visible editor host no longer owns the current editable focus.'
          : clear
            ? 'The editable target does not contain the exact requested value after filling.'
            : changed
              ? 'The editable target does not contain the complete requested text after typing.'
              : 'The editable target did not change after typing.';
      result.code = code;
      result.error = error;
      result.message = error;
      result.retryable = !appended;
      // Text already in the field outranks the other advice: typing again appends it twice.
      result.recovery = appended
        ? 'The field changed; read it, then replace its whole value with fill.'
        : code === 'INPUT_FOCUS_REJECTED'
          ? 'Inspect the page again and choose the current visible editor ref.'
          : 'Inspect the page and retry with the current editable ref.';
    }
    // The field never held focus: say which field takes input there instead,
    // so the retry goes to that field rather than to this ref again.
    if (!verified && target.virtualEditor !== true && !focused) {
      const diagnosis = await diagnoseUnfocusedInput(
        session,
        backendNodeId,
        target.coordinateSpace === 'unavailable'
          ? undefined
          : { x: target.contextX ?? target.x, y: target.contextY ?? target.y },
      );
      if (diagnosis) {
        result.inputTarget = diagnosis;
        if (appended) {
          // The target itself changed: replacing it with fill stays the advice.
          result.recovery = `${String(result.recovery)} ${describeInputDiagnosis(diagnosis)}`;
        } else {
          if (!clear && diagnosis.focusMovedTo) {
            // Typed text went to the field focus moved to: typing again appends it there.
            (result.effect as Record<string, unknown>).inputElsewhere = true;
            result.retryable = false;
          }
          result.recovery = unfocusedInputRecovery(diagnosis, clear ? 'fill' : 'type');
        }
      }
    }
    return result;
  }

  /**
   * Native date/time/color/range inputs ignore Input.insertText: their editors
   * are segmented or non-textual, so keystroke text never becomes the value
   * (eval 761096: 16 ACTION_EFFECT_MISMATCH + 5 NOT_OBSERVED on date fields).
   * Like Playwright's fill, set the canonical value through the native setter
   * and dispatch input/change so framework listeners observe it.
   */
  private async readValueControlType(
    session: SessionState,
    backendNodeId: number,
  ): Promise<ValueControlType | undefined> {
    let objectId: string | undefined;
    try {
      const resolved = await cdp<{ object?: { objectId?: string } }>(session, 'DOM.resolveNode', {
        backendNodeId,
      });
      objectId = resolved.object?.objectId;
      if (!objectId) return undefined;
      const state = await cdp<{ result?: { value?: unknown } }>(session, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () {
          return this instanceof HTMLInputElement ? String(this.type || '').toLowerCase() : '';
        }`,
        returnByValue: true,
      });
      const type = state.result?.value;
      return valueControlTypeOf('input', typeof type === 'string' ? type : undefined);
    } catch (error) {
      if (isBrowserOperationInterruption(error)) throw error;
      return undefined;
    } finally {
      if (objectId) {
        await cdp(session, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
      }
    }
  }

  private async applyValueControl(
    session: SessionState,
    request: {
      backendNodeId: number;
      inputType: ValueControlType;
      text: string;
      rect: Rect | undefined;
      startedAt: number;
      beforeGeneration: number;
    },
  ): Promise<Record<string, unknown>> {
    const { backendNodeId, inputType, text, startedAt } = request;
    const resolved = await cdp<{ object?: { objectId?: string } }>(session, 'DOM.resolveNode', {
      backendNodeId,
    });
    const objectId = resolved.object?.objectId;
    if (!objectId) {
      throw new Error(
        'STALE_ELEMENT_REF: the inspected element was replaced or removed; inspect again and use the new ref',
      );
    }
    let applied: { value?: unknown; disabled?: unknown } | undefined;
    try {
      const response = await cdp<{ result?: { value?: unknown } }>(
        session,
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: `function (value) {
            if (this.disabled || this.readOnly) return { disabled: true, value: String(this.value) };
            this.focus();
            const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
            if (setter && setter.set) setter.set.call(this, value);
            else this.value = value;
            this.dispatchEvent(new Event('input', { bubbles: true }));
            this.dispatchEvent(new Event('change', { bubbles: true }));
            return { disabled: false, value: String(this.value) };
          }`,
          arguments: [{ value: text }],
          returnByValue: true,
        },
      );
      applied = response.result?.value as typeof applied;
    } finally {
      await cdp(session, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
    const generationChanged = session.generation !== request.beforeGeneration;
    this.invalidateObservation(session);
    const actual = typeof applied?.value === 'string' ? applied.value : '';
    const disabled = applied?.disabled === true;
    const matches =
      inputType === 'color'
        ? actual.toLowerCase() === text.toLowerCase()
        : inputType === 'range'
          ? Number(actual) === Number(text)
          : inputType === 'time' || inputType === 'datetime-local'
            ? // Clearing is a valid fill; only a non-empty value the browser
              // rejected (sanitized to '') counts as a mismatch.
              text.trim() === ''
              ? actual === ''
              : actual !== '' && canonicalTemporalValue(actual) === canonicalTemporalValue(text)
            : actual === text;
    const verified = !disabled && matches;
    const format = VALUE_CONTROL_FORMATS[inputType];
    const result: Record<string, unknown> = {
      success: verified,
      durationMs: Date.now() - startedAt,
      target: { resolved: true, tag: 'input', inputType, rect: request.rect },
      effect: {
        dispatched: !disabled,
        verified,
        verificationRequired: !verified,
        mode: 'value',
        value: actual,
      },
      navigation: { detected: generationChanged, generation: session.generation },
    };
    if (!verified) {
      const error = disabled
        ? `The <input type="${inputType}"> is disabled or read-only.`
        : actual === ''
          ? `The <input type="${inputType}"> rejected "${text}": it only accepts the format ${format}.`
          : `The <input type="${inputType}"> normalized "${text}" to "${actual}".`;
      result.code = disabled ? 'TARGET_NOT_EDITABLE' : 'ACTION_EFFECT_MISMATCH';
      result.error = error;
      result.message = error;
      result.retryable = !disabled;
      result.recovery = disabled
        ? 'Inspect the page; enable the field first or choose a different control.'
        : `Retry fill with the value in ${format} (not the displayed locale format); do not type into the field segments.`;
    }
    return result;
  }

  private async insertText(
    session: SessionState,
    text: string,
    delayMs: number,
    expectedGeneration: number,
  ): Promise<boolean> {
    let dispatched = false;
    if (session.generation !== expectedGeneration) return dispatched;
    if (delayMs > 0) {
      for (const char of text) {
        if (session.generation !== expectedGeneration) return dispatched;
        await cdp(session, 'Input.insertText', { text: char });
        dispatched = true;
        if (session.generation !== expectedGeneration) return dispatched;
        await delay(delayMs, session.commandSignal);
        if (session.generation !== expectedGeneration) return dispatched;
      }
      return dispatched;
    }
    await cdp(session, 'Input.insertText', { text });
    return true;
  }

  private async dispatchVirtualEditorCharacter(session: SessionState, char: string): Promise<void> {
    const key = browserPrintableKeyDescriptor(char);
    if (!key) {
      await cdp(session, 'Input.insertText', { text: char });
      return;
    }
    await cdp(session, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.windowsVirtualKeyCode,
      modifiers: key.modifiers,
    });
    await cdp(session, 'Input.dispatchKeyEvent', {
      type: 'char',
      key: key.key,
      text: char,
      unmodifiedText: char,
    });
    await cdp(session, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.windowsVirtualKeyCode,
      modifiers: key.modifiers,
    });
  }

  private async activateVirtualEditor(
    session: SessionState,
    target: {
      x: number;
      y: number;
      backendNodeId: number;
    },
  ): Promise<void> {
    await this.dispatchMouse(session, target.x, target.y, 'mouseMoved');
    await delay(50, session.commandSignal);
    await this.dispatchMouse(session, target.x, target.y, 'mousePressed', {
      button: 'left',
      clickCount: 1,
    });
    await delay(50, session.commandSignal);
    await this.dispatchMouse(session, target.x, target.y, 'mouseReleased', {
      button: 'left',
      clickCount: 1,
    });
    await delay(50, session.commandSignal);

    const resolved = await cdp<{ object?: { objectId?: string } }>(session, 'DOM.resolveNode', {
      backendNodeId: target.backendNodeId,
    });
    const objectId = resolved.object?.objectId;
    if (!objectId) throw new Error('INPUT_FOCUS_REJECTED: editor host was not resolved');
    try {
      const focused = await cdp<{
        result?: { value?: { focused?: boolean; editable?: boolean; withinTarget?: boolean } };
        exceptionDetails?: CdpExceptionDetails;
      }>(session, 'Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function () {
          let active = this.ownerDocument?.activeElement || null;
          while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
          const editable = (${EDITABLE_FIELD_SOURCE})(active);
          let withinTarget = false;
          let cursor = active;
          while (cursor) {
            if (cursor === this) {
              withinTarget = true;
              break;
            }
            cursor = cursor.parentNode || cursor.getRootNode?.()?.host || null;
          }
          return { focused: Boolean(active), editable, withinTarget };
        }`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (focused.exceptionDetails) {
        throw new Error(describeCdpException(focused.exceptionDetails, 'INPUT_FOCUS_REJECTED'));
      }
      const state = focused.result?.value;
      if (!state?.focused || !state.editable || !state.withinTarget) {
        throw new Error(
          'INPUT_FOCUS_REJECTED: activating the editor host did not focus its editable proxy',
        );
      }
    } finally {
      await cdp(session, 'Runtime.releaseObject', { objectId }).catch(() => undefined);
    }
  }

  protected async pressKey(
    session: SessionState,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const startedAt = Date.now();
    const ref = asString(input.ref);
    const hasTarget = Boolean(ref || asString(input.selector));
    const continuation =
      ref &&
      !session.elementMap.hasOpaqueRef(ref) &&
      session.keyboardContinuationTarget?.ref === ref
        ? session.keyboardContinuationTarget
        : undefined;
    session.keyboardContinuationTarget = undefined;
    const target =
      continuation ??
      (hasTarget ? await this.resolveTarget(session, input, true, false) : undefined);
    if (target && target.backendNodeId === undefined) {
      throw new Error('PRESS_KEY_TARGET_NOT_RESOLVED');
    }
    if (target?.backendNodeId !== undefined) {
      session.commandSessionId = target.commandSessionId;
      await cdp(session, 'DOM.focus', { backendNodeId: target.backendNodeId });
    }
    const generation = session.generation;
    const watch = await this.watchInputNavigation(session);
    try {
      await this.dispatchKey(session, asString(input.key), stringArray(input.modifiers));
      await delay(ACTION_SETTLE_DELAY_MS, session.commandSignal);
      const fields = {
        durationMs: Date.now() - startedAt,
        ...(target ? { target: { resolved: true, rect: target.rect } } : {}),
        effect: { dispatched: true },
      };
      // Enter in a search box or form submits it: say the page navigated.
      const facts = await watch.settle();
      if (this.inputNavigated(session, facts, generation)) {
        return this.navigatedByInputResult(session, 'press_key', facts, fields);
      }
      this.invalidateObservation(session);
      return { success: true, ...fields };
    } finally {
      watch.dispose();
    }
  }

  private async inspectScrollSnapshot(
    session: SessionState,
    point: { x: number; y: number } | null,
    axis: 'x' | 'y',
  ): Promise<BrowserScrollSnapshot | null> {
    const command = { point, axis };
    const raw = await evaluate<unknown>(
      session,
      `(() => {
      const command = ${JSON.stringify(command)};
      const documentScroller = document.scrollingElement || document.documentElement;
      const ownerRegistryKey = Symbol.for('mavis.browser.scroll-owner-registry');
      const ownerRegistry = globalThis[ownerRegistryKey] ||
        (globalThis[ownerRegistryKey] = { nextId: 1, ids: new WeakMap() });
      const ownerId = (element) => {
        if (element === documentScroller) return 'document';
        let id = ownerRegistry.ids.get(element);
        if (!id) {
          id = 'element:' + ownerRegistry.nextId++;
          ownerRegistry.ids.set(element, id);
        }
        return id;
      };
      const isScrollable = (element) => {
        if (!(element instanceof Element)) return false;
        const style = getComputedStyle(element);
        const overflow = command.axis === 'y' ? style.overflowY : style.overflowX;
        const allowsUserScroll = overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
        const hasOverflow = command.axis === 'y'
          ? element.scrollHeight > element.clientHeight + ${SCROLL_BOUNDARY_EPSILON}
          : element.scrollWidth > element.clientWidth + ${SCROLL_BOUNDARY_EPSILON};
        return allowsUserScroll && hasOverflow;
      };
      const resolveScrollTarget = (point) => {
        let element = point ? document.elementFromPoint(point.x, point.y) : documentScroller;
        if (element instanceof HTMLIFrameElement) return null;
        if (point) {
          while (element && element !== documentScroller && !isScrollable(element)) {
            element = element.parentElement;
          }
        }
        if (!element || (element !== documentScroller && !isScrollable(element))) {
          element = documentScroller;
        }
        return element || null;
      };
      const element = resolveScrollTarget(command.point);
      if (!element) {
        return {
          ownerId: 'unknown',
          kind: 'unknown',
          scrollable: false,
          scrollTop: 0,
          scrollLeft: 0,
          scrollHeight: 0,
          scrollWidth: 0,
          clientHeight: 0,
          clientWidth: 0,
        };
      }
      const hasScrollableExtent = command.axis === 'y'
        ? element.scrollHeight > element.clientHeight + ${SCROLL_BOUNDARY_EPSILON}
        : element.scrollWidth > element.clientWidth + ${SCROLL_BOUNDARY_EPSILON};
      return {
        ownerId: ownerId(element),
        kind: element === documentScroller ? 'document' : 'element',
        scrollable: element === documentScroller ? hasScrollableExtent : isScrollable(element),
        scrollTop: Number(element.scrollTop || 0),
        scrollLeft: Number(element.scrollLeft || 0),
        scrollHeight: Number(element.scrollHeight || 0),
        scrollWidth: Number(element.scrollWidth || 0),
        clientHeight: Number(element.clientHeight || 0),
        clientWidth: Number(element.clientWidth || 0),
      };
    })()`,
    );
    return normalizeScrollSnapshot(raw, axis);
  }

  protected async scroll(session: SessionState, input: Record<string, unknown>): Promise<unknown> {
    const direction = asString(input.direction, 'down');
    const axis = direction === 'left' || direction === 'right' ? 'x' : 'y';
    const viewport = await this.readCssViewport(session);
    const distance = Math.max(1, asNumber(input.distance, Math.round(viewport.height * 0.8)));
    const deltaX = direction === 'left' ? -distance : direction === 'right' ? distance : 0;
    const deltaY = direction === 'up' ? -distance : direction === 'down' ? distance : 0;
    const hasExplicitTarget = ['ref', 'selector', 'position', 'normalized_position'].some((key) =>
      Object.prototype.hasOwnProperty.call(input, key),
    );
    // body, html or the scrolling element as the target means the page
    // itself: their box is the whole document, so its center is usually below
    // the viewport and a wheel there reported "outside the current viewport".
    const documentTarget = hasExplicitTarget && (await this.targetsWholeDocument(session, input));
    const target =
      hasExplicitTarget && !documentTarget
        ? await this.resolveTarget(session, input, false)
        : undefined;
    if (
      target &&
      (!Number.isFinite(target.x) ||
        !Number.isFinite(target.y) ||
        target.x < 0 ||
        target.y < 0 ||
        target.x > viewport.width ||
        target.y > viewport.height)
    ) {
      return {
        success: false,
        code: 'NO_SCROLL_EFFECT',
        error: 'Scroll target is outside the current viewport.',
        retryable: true,
        recovery:
          'Inspect the current viewport and choose a visible scroll container, ref, selector, or normalized position.',
        effect: {
          observed: false,
          moved: false,
          actualDeltaX: 0,
          actualDeltaY: 0,
          atStart: false,
          atEnd: false,
        },
      };
    }
    const observationPoint = target
      ? { x: target.contextX ?? target.x, y: target.contextY ?? target.y }
      : null;
    const before = await this.inspectScrollSnapshot(session, observationPoint, axis);
    const beforeObserved = before !== null && before.kind !== 'unknown';
    const beforePosition = axis === 'y' ? (before?.scrollTop ?? 0) : (before?.scrollLeft ?? 0);
    const beforeExtent = axis === 'y' ? (before?.scrollHeight ?? 0) : (before?.scrollWidth ?? 0);
    const beforeViewport = axis === 'y' ? (before?.clientHeight ?? 0) : (before?.clientWidth ?? 0);
    const beforeAtRequestedBoundary =
      beforeObserved &&
      Boolean(before?.scrollable) &&
      (direction === 'down' || direction === 'right'
        ? beforePosition + beforeViewport >= beforeExtent - SCROLL_BOUNDARY_EPSILON
        : beforePosition <= SCROLL_BOUNDARY_EPSILON);

    let after = before;
    let usedUnobservedWheelFallback = false;
    if (!beforeAtRequestedBoundary) {
      if (target) {
        usedUnobservedWheelFallback =
          before?.kind === 'unknown' || (beforeObserved && !before?.scrollable);
        await session.beforePointerAction?.(
          { action: 'scroll', point: { x: target.x, y: target.y } },
          session.commandSignal,
        );
        await this.dispatchMouse(session, target.x, target.y, 'mouseMoved');
        await this.dispatchMouse(session, target.x, target.y, 'mouseWheel', { deltaX, deltaY });
      } else {
        // An untargeted scroll owns the document contract. Dispatching a wheel
        // at the viewport center can instead move an unrelated nested
        // container, so use the document scrolling primitive just like the
        // mature Electron path.
        await evaluate(session, `window.scrollBy(${deltaX}, ${deltaY})`);
      }
      await delay(ACTION_SETTLE_DELAY_MS, session.commandSignal);
      after = await this.inspectScrollSnapshot(session, observationPoint, axis);
    }

    const observed =
      before !== null &&
      after !== null &&
      !usedUnobservedWheelFallback &&
      before.kind !== 'unknown' &&
      before.ownerId === after.ownerId;
    const actualDeltaX = observed && before && after ? after.scrollLeft - before.scrollLeft : 0;
    const actualDeltaY = observed && before && after ? after.scrollTop - before.scrollTop : 0;
    const moved =
      observed &&
      ((deltaX !== 0 &&
        Math.sign(actualDeltaX) === Math.sign(deltaX) &&
        Math.abs(actualDeltaX) >= SCROLL_BOUNDARY_EPSILON) ||
        (deltaY !== 0 &&
          Math.sign(actualDeltaY) === Math.sign(deltaY) &&
          Math.abs(actualDeltaY) >= SCROLL_BOUNDARY_EPSILON));
    const finalSnapshot = after ?? before;
    const relevantPosition =
      axis === 'y' ? (finalSnapshot?.scrollTop ?? 0) : (finalSnapshot?.scrollLeft ?? 0);
    const relevantExtent =
      axis === 'y' ? (finalSnapshot?.scrollHeight ?? 0) : (finalSnapshot?.scrollWidth ?? 0);
    const relevantViewport =
      axis === 'y' ? (finalSnapshot?.clientHeight ?? 0) : (finalSnapshot?.clientWidth ?? 0);
    // Keep the existing public effect semantics: only the boundary in the
    // requested direction is reported by this action result.
    const atStart =
      observed &&
      (direction === 'up' || direction === 'left') &&
      relevantPosition <= SCROLL_BOUNDARY_EPSILON;
    const atEnd =
      observed &&
      (direction === 'down' || direction === 'right') &&
      relevantPosition + relevantViewport >= relevantExtent - SCROLL_BOUNDARY_EPSILON;
    const requestedBoundaryReached = direction === 'up' || direction === 'left' ? atStart : atEnd;
    this.invalidateObservation(session);
    const effect = { observed, moved, actualDeltaX, actualDeltaY, atStart, atEnd };
    if (!observed) {
      return {
        success: false,
        code: 'SCROLL_EFFECT_UNVERIFIED',
        error: 'Scroll input was dispatched, but its page effect could not be verified.',
        retryable: true,
        recovery:
          'Inspect the page once and choose a newly observed scroll target or confirm the intended state before continuing.',
        effect,
      };
    }
    const finalExplicitTargetIsNotScrollable = target !== undefined && !finalSnapshot?.scrollable;
    if (!moved && (finalExplicitTargetIsNotScrollable || !requestedBoundaryReached)) {
      return {
        success: false,
        code: 'NO_SCROLL_EFFECT',
        error: 'Scroll action produced no observable movement.',
        retryable: true,
        recovery:
          'Inspect the page and choose a different scroll target, selector, ref, or normalized position.',
        effect,
      };
    }
    return {
      success: true,
      effect,
    };
  }

  /** Whether a scroll target names body, html or the document scrolling element. */
  private async targetsWholeDocument(
    session: SessionState,
    input: Record<string, unknown>,
  ): Promise<boolean> {
    const ref = asString(input.ref);
    if (ref) {
      const element = resolveBrowserSnapshotElement(session, ref)?.element;
      return (
        element !== undefined &&
        (!element.frameId || element.frameId === 'main') &&
        /^(?:body|html)$/iu.test(element.tag)
      );
    }
    const selector = asString(input.selector);
    if (!selector) return false;
    return (
      (await evaluate<boolean>(
        session,
        `(() => { try { const element = document.querySelector(${JSON.stringify(selector).replace(/[<>/\u2028\u2029]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}); return element !== null && (element === document.body || element === document.documentElement || element === document.scrollingElement); } catch { return false; } })()`,
      ).catch((error: unknown) => {
        if (isBrowserOperationInterruption(error)) throw error;
        return false;
      })) === true
    );
  }

  protected async waitFor(session: SessionState, input: Record<string, unknown>): Promise<unknown> {
    const kind = asString(input.kind);
    const timeoutMs = Math.max(0, Math.floor(asNumber(input.timeout, DEFAULT_WAIT_TIMEOUT_MS)));
    if (kind === 'timeout') {
      await delay(timeoutMs, session.commandSignal);
      return { success: true, kind: 'timeout', waitedMs: timeoutMs };
    }
    if (kind === 'network') return this.waitForNetwork(session, input, timeoutMs);
    const selector = asString(input.selector);
    const text = asString(input.text);
    const url = asString(input.url);
    const load = input.load === true || kind === 'load';
    if (kind === 'selector' && !selector) {
      throw new Error('WAIT_REQUIRES_SELECTOR');
    }
    if (kind === 'text' && !text) throw new Error('WAIT_REQUIRES_TEXT');
    if (kind === 'url' && !url) throw new Error('WAIT_REQUIRES_URL');
    if (!selector && !text && !url && !load) throw new Error('WAIT_REQUIRES_CONDITION');
    const deadline = Date.now() + timeoutMs;
    let poll: BrowserWaitPoll = { met: false };
    while (Date.now() <= deadline) {
      // A transport that answers the expression with a bare boolean (or
      // nothing) still decides the poll; only the counts are then missing.
      const value = await evaluate<unknown>(session, waitExpression(input));
      poll = isRecord(value) ? (value as unknown as BrowserWaitPoll) : { met: value === true };
      if (poll.met)
        return { success: true, waitedMs: timeoutMs - Math.max(0, deadline - Date.now()) };
      await delay(50, session.commandSignal);
    }
    const recovery = selector
      ? waitSelectorTimeoutRecovery(selector, asString(input.state, 'visible'), poll)
      : undefined;
    return {
      success: false,
      code: 'ACTION_TIMEOUT',
      error: 'Browser wait condition timed out.',
      ...(poll.matched !== undefined ? { matched: poll.matched } : {}),
      ...(poll.visible !== undefined ? { visible: poll.visible } : {}),
      ...(recovery ? { recovery } : {}),
    };
  }

  /**
   * kind "network" (a SPA page was read before its data request
   * finished): waits until a request whose sanitized URL contains `filter` has
   * finished, optionally narrowed by status, resource type and an
   * `afterSequence` checkpoint. A matching request that already finished when
   * the wait starts satisfies it at once, so a wait right after navigate does
   * not miss a fast response.
   */
  private async waitForNetwork(
    session: SessionState,
    input: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const filter = asString(input.filter);
    if (!filter) throw new Error('WAIT_REQUIRES_FILTER');
    const cdpHelper = session.cdpHelper;
    const ready = await cdpHelper.ensureNetworkDiagnosticsReady(session.commandSignal);
    if (!ready || !cdpHelper.isNetworkDiagnosticsAvailable()) {
      return {
        success: false,
        code: 'NETWORK_DIAGNOSTICS_UNAVAILABLE',
        error: 'Network diagnostics are unavailable for the current Browser tab.',
        recovery: 'Keep the current Browser tab open and retry once it finishes initializing.',
      };
    }
    const requestedStatus = stringArray(input.status).filter(
      (status) => status !== 'pending',
    ) as CDPNetworkDiagnosticStatusFilter[];
    const query = {
      filter,
      ...(input.resourceTypes !== undefined
        ? { resourceTypes: stringArray(input.resourceTypes) as CDPNetworkDiagnosticResourceType[] }
        : {}),
      ...(input.afterSequence !== undefined
        ? { afterSequence: Math.max(0, Math.floor(asNumber(input.afterSequence))) }
        : {}),
      limit: 200,
    };
    const status = requestedStatus.length > 0 ? requestedStatus : FINISHED_NETWORK_STATUS;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;
    for (;;) {
      const page = cdpHelper.getNetworkDiagnostics({ ...query, status });
      // A status class can match a request whose body is still loading; take
      // the newest finished one.
      const entry = [...page.entries]
        .reverse()
        .find((candidate) => candidate.outcome !== 'pending');
      if (entry) {
        return {
          success: true,
          kind: 'network',
          waitedMs: Date.now() - startedAt,
          entry,
          lastSequence: page.lastSequence,
        };
      }
      if (Date.now() >= deadline) {
        const pending = cdpHelper.getNetworkDiagnostics({ ...query, status: ['pending'] });
        return {
          success: false,
          code: 'ACTION_TIMEOUT',
          kind: 'network',
          error: `No finished request whose URL contains "${filter}" was observed within ${timeoutMs} ms.`,
          pendingMatches: pending.totalEntries,
          lastSequence: page.lastSequence,
          recovery:
            pending.totalEntries > 0
              ? 'A matching request is still loading; wait again with a longer timeout.'
              : 'No matching request was sent. Check the filter with query kind "network" without filter, or repeat the page action that sends the request and wait with afterSequence set to this lastSequence.',
        };
      }
      await delay(Math.min(100, deadline - Date.now()), session.commandSignal);
    }
  }

  protected async screenshot(
    session: SessionState,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    const startedAt = Date.now();
    if (session.captureScreenshot) {
      if (!session.commandSignal || session.commandTimeoutMs === undefined) {
        throw new Error('SCREENSHOT_CAPTURE_CONTEXT_UNAVAILABLE');
      }
      const captured = await session.captureScreenshot(input, {
        signal: session.commandSignal,
        timeoutMs: session.commandTimeoutMs,
      });
      return withScreenshotCaptureTiming(captured, Date.now() - startedAt);
    }
    const captured = await captureBrowserScreenshot(session, input, () =>
      this.readPageSummary(session),
    );
    return withScreenshotCaptureTiming(captured, Date.now() - startedAt);
  }
}

/**
 * Provider-side screenshot timing, read by the runtime's post-action visual
 * metrics and removed by the Browser tool before any model-visible result.
 * A provider seam that already split capture from encoding keeps its split;
 * otherwise the whole provider capture (CDP encodes inside Chrome) is capture.
 */
function withScreenshotCaptureTiming(result: unknown, elapsedMs: number): unknown {
  if (!isRecord(result) || result.success === false) return result;
  if (isRecord(result.captureTiming)) return result;
  return { ...result, captureTiming: { captureMs: Math.max(0, elapsedMs) } };
}

function isSupportedBrowserUrl(url: string): boolean {
  return /^(?:https?|file|data|about):/iu.test(url.trim());
}

const VALUE_CONTROL_FORMATS = {
  date: 'YYYY-MM-DD, e.g. 2026-03-09',
  time: 'HH:MM or HH:MM:SS in 24-hour time, e.g. 14:30',
  'datetime-local': 'YYYY-MM-DDTHH:MM, e.g. 2026-03-09T14:30',
  month: 'YYYY-MM, e.g. 2026-03',
  week: 'YYYY-Www, e.g. 2026-W10',
  color: 'lowercase #rrggbb, e.g. #1a2b3c',
  range: 'a number within the slider min/max and step',
} as const;
type ValueControlType = keyof typeof VALUE_CONTROL_FORMATS;

/**
 * Chrome stores time and datetime-local values in a canonical form: zero
 * seconds/milliseconds are dropped and a space separator becomes "T"
 * ("2026-03-09 14:30:00" → "2026-03-09T14:30"). Compare both sides in that
 * form so an accepted value is not reported as ACTION_EFFECT_MISMATCH.
 */
function canonicalTemporalValue(value: string): string {
  const match = /^(?:(\d{4,}-\d{2}-\d{2})[T ])?(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u.exec(
    value.trim(),
  );
  if (!match) return value;
  const [, date, hours, minutes, seconds = '00', fraction = ''] = match;
  const millis = fraction.padEnd(3, '0');
  const time =
    millis !== '000'
      ? `${hours}:${minutes}:${seconds}.${millis}`
      : seconds !== '00'
        ? `${hours}:${minutes}:${seconds}`
        : `${hours}:${minutes}`;
  return date ? `${date}T${time}` : time;
}

function valueControlTypeOf(
  tag: string | undefined,
  type: string | undefined,
): ValueControlType | undefined {
  if (tag?.toLowerCase() !== 'input' || !type) return undefined;
  const normalized = type.toLowerCase();
  return Object.prototype.hasOwnProperty.call(VALUE_CONTROL_FORMATS, normalized)
    ? (normalized as ValueControlType)
    : undefined;
}
