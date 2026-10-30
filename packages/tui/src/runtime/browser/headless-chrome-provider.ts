import type {
  LocalBrowserAdapter,
  LocalBrowserToolAction,
  LocalRuntimeToolContext,
} from '@mavis/agent-tools/desktop';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  BrowserCore,
  IsolatedClipboardProvider,
  isRecord,
  type BrowserCoreSession,
  type BrowserEvaluateOptions,
  type BrowserAttachedFrame,
  type BrowserTransport,
  type BrowserTransportCommandOptions,
  type BrowserTransportEvent,
  type BrowserTransportEventListener,
  type ClipboardProvider,
} from '@mavis/browser-core';
import {
  HeadlessChromeBrowser,
  type HeadlessChromeLaunchOptions,
  type HeadlessChromePage,
} from './headless-chrome-transport.js';

const HEADLESS_ACTIONS = [
  'inspect',
  'query',
  'navigate',
  'open_tab',
  'return_to_previous_tab',
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
] as const satisfies readonly LocalBrowserToolAction[];

const MAX_PRESERVED_TABS_PER_SESSION = 8;
const MAX_LIVE_BROWSER_SESSIONS = 4;
const PREVIOUS_TAB_LIVENESS_TIMEOUT_MS = 1_000;

export interface HeadlessChromeBrowserProviderOptions extends HeadlessChromeLaunchOptions {
  /** Creates one isolated clipboard for each logical TUI session. */
  readonly clipboardProviderFactory?: (sessionId: string) => ClipboardProvider;
}

/**
 * Native headless provider backed by the provider-neutral Browser Core.
 * Chrome owns process/profile state; Browser Core owns refs, semantic snapshots,
 * pagination and action/effect semantics.
 */
export class HeadlessChromeBrowserProvider implements LocalBrowserAdapter {
  private readonly sessions = new Map<string, Promise<BrowserCoreSession>>();
  private readonly tabHistory = new Map<string, BrowserCoreSession[]>();
  private readonly core: BrowserCore<LocalBrowserToolAction>;
  private readonly browsers = new Map<string, Promise<HeadlessChromeBrowser>>();
  private readonly sessionInitializationControllers = new Map<string, AbortController>();
  private readonly browserExitDisposers = new Map<string, () => void>();
  private readonly clipboardProviders = new Map<string, ClipboardProvider>();
  private readonly sessionClosingPromises = new Map<string, Promise<void>>();
  private readonly sessionActivity = new Map<string, number>();
  private readonly activeExecutions = new Map<string, number>();
  private activitySequence = 0;
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
    return { ...this.core.getCapabilities(), interactiveTakeover: false } as const;
  }

  async disposeSession(sessionId: string): Promise<void> {
    await this.closeSession(sessionId);
    await disposeHeadlessSessionStorage(this.options, sessionId);
  }

  async execute(
    ctx: LocalRuntimeToolContext,
    action: LocalBrowserToolAction,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.core.assertAction(action);
    this.core.assertNotAborted(signal);
    const sessionId = this.core.assertContext(ctx);
    if (this.closed) throw new Error('Headless browser provider is closed');
    const actionInput = normalizeHeadlessActionInput(action, input);
    this.markSessionActive(sessionId);
    let session: BrowserCoreSession | undefined;
    try {
      session = await this.getSession(sessionId, signal);
      if (action === 'open_tab') return this.openTab(sessionId, session, actionInput, signal);
      if (action === 'return_to_previous_tab') {
        return this.returnToPreviousTab(sessionId, session, signal);
      }
      const expectsRelatedPage =
        action === 'click_and_wait_for_navigation' && isBlankTargetRef(session, actionInput);
      const coreAction = expectsRelatedPage ? 'click' : action;
      const result = await session.execute(coreAction, actionInput, signal);
      if (
        action === 'click' ||
        action === 'double_click' ||
        action === 'triple_click' ||
        expectsRelatedPage
      ) {
        return this.adoptRelatedPage(sessionId, session, result, expectsRelatedPage, signal);
      }
      return result;
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

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.closed = true;
    this.disposePromise = this.disposeOwnedResources();
    return this.disposePromise;
  }

  private async disposeOwnedResources(): Promise<void> {
    const sessionIds = [
      ...new Set([
        ...this.sessions.keys(),
        ...this.tabHistory.keys(),
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
    this.sessions.clear();
    this.tabHistory.clear();
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

  private async openTab(
    sessionId: string,
    session: BrowserCoreSession,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!/^https?:\/\//iu.test(url))
      throw new Error('Only http(s) URLs are supported for open_tab');
    const history = this.tabHistory.get(sessionId) ?? [];
    if (history.length >= MAX_PRESERVED_TABS_PER_SESSION) {
      throw new Error(
        `TAB_LIMIT_REACHED: Headless Browser preserves at most ${MAX_PRESERVED_TABS_PER_SESSION} previous tabs per session; return to a previous tab before opening another`,
      );
    }
    const browser = await this.getBrowser(sessionId, signal);
    const page = await browser.createPage('about:blank', signal);
    let nextSession: BrowserCoreSession | undefined;
    try {
      throwIfAborted(signal);
      const transport = this.createTransport(page, browser.downloadDirectory);
      nextSession = this.createCoreSession(sessionId, transport);
      const navigationResult = await nextSession.execute('navigate', { ...input, url }, signal);
      throwIfAborted(signal);
      if (!isRecord(navigationResult) || navigationResult.success !== true) {
        throw new Error('NAVIGATION_FAILED: Browser Core did not confirm the new tab navigation');
      }
      history.push(session);
      this.tabHistory.set(sessionId, history);
      this.sessions.set(sessionId, Promise.resolve(nextSession));
      return {
        ...navigationResult,
        openedInNewTab: true,
        preservedTabs: history.length,
      };
    } catch (error) {
      nextSession?.dispose();
      await page.close().catch(() => undefined);
      throw error;
    }
  }

  private async returnToPreviousTab(
    sessionId: string,
    current: BrowserCoreSession,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const history = this.tabHistory.get(sessionId) ?? [];
    let previous: BrowserCoreSession | undefined;
    while (history.length > 0) {
      const candidate = history[history.length - 1];
      if (!candidate) break;
      if (await isBrowserSessionAlive(candidate, signal)) {
        previous = candidate;
        history.pop();
        break;
      }
      history.pop();
      candidate.dispose();
      await candidate.transport.close().catch(() => undefined);
    }
    if (history.length === 0) this.tabHistory.delete(sessionId);
    else this.tabHistory.set(sessionId, history);
    if (!previous) {
      throw new Error(
        'NO_PREVIOUS_TAB: No live preserved Headless Browser tab is available; continue in the current tab',
      );
    }
    this.sessions.set(sessionId, Promise.resolve(previous));
    current.dispose();
    await current.transport.close();
    return {
      success: true,
      returnedToPreviousTab: true,
      preservedTabs: history.length,
      recovery: 'Inspect the restored tab before continuing so its current page state is explicit.',
    };
  }

  private async adoptRelatedPage(
    sessionId: string,
    current: BrowserCoreSession,
    actionResult: unknown,
    requireRelatedPage: boolean,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const browser = await this.getBrowser(sessionId, signal);
    const page = await browser.takeRelatedPage(current.transport.sessionId, signal);
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
    const history = this.tabHistory.get(sessionId) ?? [];
    if (history.length >= MAX_PRESERVED_TABS_PER_SESSION) {
      await page.close().catch(() => undefined);
      return {
        ...(isRecord(actionResult) ? actionResult : {}),
        success: false,
        code: 'TAB_LIMIT_REACHED',
        error: `Headless Browser preserves at most ${MAX_PRESERVED_TABS_PER_SESSION} previous tabs per session; the related popup was closed`,
      };
    }
    let nextSession: BrowserCoreSession | undefined;
    try {
      await page.waitForReady(undefined, signal);
      throwIfAborted(signal);
      nextSession = this.createCoreSession(
        sessionId,
        this.createTransport(page, browser.downloadDirectory),
      );
      history.push(current);
      this.tabHistory.set(sessionId, history);
      this.sessions.set(sessionId, Promise.resolve(nextSession));
      return {
        ...(isRecord(actionResult) ? actionResult : {}),
        openedInNewTab: true,
        preservedTabs: history.length,
      };
    } catch (error) {
      nextSession?.dispose();
      await page.close().catch(() => undefined);
      throw error;
    }
  }

  private async getSession(sessionId: string, signal?: AbortSignal): Promise<BrowserCoreSession> {
    const closing = this.sessionClosingPromises.get(sessionId);
    if (closing) {
      await closing;
      throwIfAborted(signal);
      if (this.closed) throw new Error('Headless browser provider is closed');
    }
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const initializationController = new AbortController();
    this.sessionInitializationControllers.set(sessionId, initializationController);
    const initializationSignal = signal
      ? AbortSignal.any([signal, initializationController.signal])
      : initializationController.signal;
    let browser: HeadlessChromeBrowser | undefined;
    let page: HeadlessChromePage | undefined;
    const pending = (async () => {
      try {
        throwIfAborted(initializationSignal);
        browser = await this.getBrowser(sessionId, initializationSignal);
        throwIfAborted(initializationSignal);
        page = await browser.createPage('about:blank', initializationSignal);
        throwIfAborted(initializationSignal);
        const transport = this.createTransport(page, browser.downloadDirectory);
        return this.createCoreSession(sessionId, transport);
      } catch (error) {
        await page?.close().catch(() => undefined);
        if (browser) {
          await browser.close().catch(() => undefined);
          this.browsers.delete(sessionId);
        }
        throw error;
      } finally {
        if (this.sessionInitializationControllers.get(sessionId) === initializationController) {
          this.sessionInitializationControllers.delete(sessionId);
        }
      }
    })();
    this.sessions.set(sessionId, pending);
    pending.catch(() => {
      if (this.sessions.get(sessionId) === pending) this.sessions.delete(sessionId);
      this.clipboardProviders.delete(sessionId);
    });
    return pending;
  }

  private createTransport(page: HeadlessChromePage, downloadDirectory: string): BrowserTransport {
    return new CoreTransport(page, downloadDirectory);
  }

  private createCoreSession(sessionId: string, transport: BrowserTransport): BrowserCoreSession {
    return this.core.createSession(transport, {
      clipboardProvider: this.getClipboardProvider(sessionId),
      commandTimeoutMs: this.options.commandTimeoutMs,
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
    const closing = this.sessionClosingPromises.get(sessionId);
    if (closing) {
      await closing;
      throwIfAborted(signal);
      if (this.closed) throw new Error('Headless browser provider is closed');
    }
    const existing = this.browsers.get(sessionId);
    if (existing) return existing;
    const promise = HeadlessChromeBrowser.launch(
      resolveHeadlessSessionLaunchOptions(this.options, sessionId),
      signal,
    ).then((browser) => {
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

  private evictCrashedBrowser(
    sessionId: string,
    browserPromise: Promise<HeadlessChromeBrowser>,
    browser: HeadlessChromeBrowser,
  ): void {
    if (this.browsers.get(sessionId) !== browserPromise) return;
    this.browsers.delete(sessionId);
    this.browserExitDisposers.get(sessionId)?.();
    this.browserExitDisposers.delete(sessionId);

    const pending = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    const history = this.tabHistory.get(sessionId) ?? [];
    this.tabHistory.delete(sessionId);
    this.clipboardProviders.delete(sessionId);
    this.sessionActivity.delete(sessionId);

    // Evict synchronously, but keep the cleanup registered until the crashed
    // process has released its profile. A replacement using the same profile
    // must not race the old browser's final Singleton* lock cleanup.
    const cleanup = (async () => {
      const current = await pending?.catch(() => undefined);
      const coreSessions = uniqueSessions(current, history);
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
    const pending = this.sessions.get(sessionId);
    const history = this.tabHistory.get(sessionId) ?? [];
    const clipboardProvider = this.clipboardProviders.get(sessionId);
    const exitDisposer = this.browserExitDisposers.get(sessionId);
    this.sessionActivity.delete(sessionId);

    initializationController?.abort();
    if (this.sessionInitializationControllers.get(sessionId) === initializationController) {
      this.sessionInitializationControllers.delete(sessionId);
    }
    if (this.sessions.get(sessionId) === pending) this.sessions.delete(sessionId);
    if (this.tabHistory.get(sessionId) === history) this.tabHistory.delete(sessionId);
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
      const session = await pending?.catch(() => undefined);
      const coreSessions = uniqueSessions(session, history);
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
  }

  private markSessionIdle(sessionId: string): void {
    const remaining = (this.activeExecutions.get(sessionId) ?? 1) - 1;
    if (remaining > 0) this.activeExecutions.set(sessionId, remaining);
    else this.activeExecutions.delete(sessionId);
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
  history: readonly BrowserCoreSession[],
): BrowserCoreSession[] {
  return [...new Set([...(active ? [active] : []), ...history])];
}

async function isBrowserSessionAlive(
  session: BrowserCoreSession,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await session.transport.send('Page.getFrameTree', undefined, undefined, {
      ...(signal ? { signal } : {}),
      timeoutMs: PREVIOUS_TAB_LIVENESS_TIMEOUT_MS,
    });
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
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

/** Resolve all persistent Chrome paths under the logical TUI session boundary. */
export function resolveHeadlessSessionLaunchOptions(
  options: HeadlessChromeBrowserProviderOptions,
  sessionId: string,
): HeadlessChromeLaunchOptions {
  const suffix = safeSessionId(sessionId);
  return {
    dataDir: join(options.dataDir, 'sessions', suffix),
    ...(options.chromePath ? { chromePath: options.chromePath } : {}),
    ...(options.userDataDir ? { userDataDir: join(options.userDataDir, suffix) } : {}),
    ...(options.downloadDir ? { downloadDir: join(options.downloadDir, suffix) } : {}),
    ...(options.viewport ? { viewport: options.viewport } : {}),
    ...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
    ...(options.commandTimeoutMs !== undefined
      ? { commandTimeoutMs: options.commandTimeoutMs }
      : {}),
  };
}

/** Remove the exact persistent roots owned by one logical Headless Browser session. */
export async function disposeHeadlessSessionStorage(
  options: HeadlessChromeBrowserProviderOptions,
  sessionId: string,
): Promise<void> {
  const launchOptions = resolveHeadlessSessionLaunchOptions(options, sessionId);
  const sessionDirectories = new Set([
    launchOptions.dataDir,
    ...(launchOptions.userDataDir ? [launchOptions.userDataDir] : []),
    ...(launchOptions.downloadDir ? [launchOptions.downloadDir] : []),
  ]);
  for (const directory of sessionDirectories) {
    await rm(directory, { recursive: true, force: true });
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
