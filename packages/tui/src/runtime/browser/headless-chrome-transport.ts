import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, rm } from 'node:fs/promises';
import { platform } from 'node:os';
import { join, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type {
  BrowserEvaluateOptions,
  BrowserAttachedFrame,
  BrowserPageTransport,
  BrowserTransportCommandOptions,
  BrowserTransportEvent,
  BrowserTransportEventListener,
} from '@mavis/browser-core';
import { describeCdpException } from '@mavis/browser-core';
import { CdpConnection } from './headless-cdp-connection.js';

const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const PROCESS_EXIT_TIMEOUT_MS = 3_000;
const CHROME_PROFILE_LOCK_NAMES = ['SingletonCookie', 'SingletonLock', 'SingletonSocket'] as const;

export function resolveChromeSandboxArgs(
  runtimePlatform: NodeJS.Platform,
  effectiveUserId: number | undefined,
): readonly string[] {
  // Chrome refuses to start as Linux root with its process sandbox enabled.
  // Prefer a usable native-headless provider and scope the compatibility flag
  // strictly to that platform/user combination.
  return runtimePlatform === 'linux' && effectiveUserId === 0 ? ['--no-sandbox'] : [];
}

/** Create or repair a provider-owned Browser directory as private on POSIX hosts. */
export async function ensurePrivateBrowserDirectory(
  directory: string,
  runtimePlatform: NodeJS.Platform = platform(),
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (runtimePlatform !== 'win32') await chmod(directory, 0o700);
}

/** Probe a default Chrome candidate without reading the executable into memory. */
export async function isChromeExecutableCandidate(
  candidate: string,
  runtimePlatform: NodeJS.Platform = platform(),
): Promise<boolean> {
  try {
    await access(candidate, runtimePlatform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Parse the endpoint Chrome writes for its atomically allocated debugging port. */
export function parseDevToolsActivePort(contents: string): string | null {
  const [portLine, pathLine] = contents.split(/\r?\n/u);
  const port = Number(portLine?.trim());
  const endpointPath = pathLine?.trim() ?? '';
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  if (!/^\/devtools\/browser\/[^\s/]+$/u.test(endpointPath)) return null;
  return `ws://127.0.0.1:${port}${endpointPath}`;
}

export interface HeadlessChromeLaunchOptions {
  readonly chromePath?: string;
  readonly dataDir: string;
  readonly userDataDir?: string;
  readonly downloadDir?: string;
  readonly viewport?: { width: number; height: number };
  readonly extraArgs?: readonly string[];
  readonly commandTimeoutMs?: number;
}

/** Only the page session or one of its known child-frame sessions is owned by a page. */
export function isHeadlessSessionEventOwned(
  eventSessionId: string | undefined,
  rootSessionId: string,
  isAttachedFrame: (sessionId: string) => boolean,
): boolean {
  return (
    eventSessionId === rootSessionId ||
    (typeof eventSessionId === 'string' && isAttachedFrame(eventSessionId))
  );
}

/** Navigation failures from a child OOPIF must not fail the root document. */
export function isHeadlessRootSessionEvent(
  eventSessionId: string | undefined,
  rootSessionId: string,
): boolean {
  return eventSessionId === rootSessionId;
}

/** Browser domain download events are emitted without a page session. */
export function isHeadlessBrowserDownloadEvent(
  method: string,
  eventSessionId: string | undefined,
): boolean {
  return (
    eventSessionId === undefined &&
    (method === 'Browser.downloadWillBegin' || method === 'Browser.downloadProgress')
  );
}

/** A missing old target session is the only safe idempotent detach failure. */
export function isHeadlessSessionAlreadyAbsentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const protocolMessage = message.replace(/^CDP -?\d+: /u, '');
  return (
    /^Session with given id(?: [^\s]+)? not found\.?$/iu.test(protocolMessage) ||
    /^No session with given id(?: [^\s]+)?\.?$/iu.test(protocolMessage)
  );
}

export interface HeadlessChromePage {
  readonly targetId: string;
  readonly transport: BrowserPageTransport;
  waitForReady(
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ url: string; readyState: string }>;
  resetConnection(): Promise<void>;
  close(): Promise<void>;
}

interface RelatedPageTarget {
  readonly targetId: string;
  readonly sessionId: string;
}

/**
 * Small CDP browser owner used by the headless provider. It intentionally
 * speaks the browser-level protocol instead of depending on Playwright, so
 * the same page transport can be used by the Electron provider.
 */
export class HeadlessChromeBrowser {
  private readonly process: ChildProcess;
  private readonly connection: CdpConnection;
  private readonly pages = new Set<HeadlessChromePageImpl>();
  private readonly unexpectedExitListeners = new Set<(error: Error) => void>();
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private processFailure: Error | undefined;
  private readonly processErrorListener = (error: Error): void => {
    this.recordUnexpectedProcessFailure(
      new Error(`CHROME_PROCESS_ERROR: ${error.message}`, { cause: error }),
    );
  };
  private readonly processExitListener = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    this.recordUnexpectedProcessFailure(
      new Error(
        `CHROME_PROCESS_EXITED: Chrome exited unexpectedly (${code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`})`,
      ),
    );
  };

  private constructor(
    process: ChildProcess,
    connection: CdpConnection,
    private readonly downloadDir: string,
    private readonly userDataDir: string,
  ) {
    this.process = process;
    this.connection = connection;
    this.process.on('error', this.processErrorListener);
    this.process.on('exit', this.processExitListener);
  }

  static async launch(
    options: HeadlessChromeLaunchOptions,
    signal?: AbortSignal,
  ): Promise<HeadlessChromeBrowser> {
    throwIfAborted(signal);
    const chromePath = await resolveChromePath(options.chromePath);
    throwIfAborted(signal);
    const userDataDir =
      options.userDataDir ?? join(options.dataDir, 'browser', 'headless', 'profile');
    const downloadDir =
      options.downloadDir ?? join(options.dataDir, 'browser', 'headless', 'downloads');
    await ensurePrivateBrowserDirectory(options.dataDir);
    await ensurePrivateBrowserDirectory(userDataDir);
    await ensurePrivateBrowserDirectory(downloadDir);
    const devToolsActivePortPath = join(userDataDir, 'DevToolsActivePort');
    await rm(devToolsActivePortPath, { force: true });
    const viewport = options.viewport ?? DEFAULT_VIEWPORT;
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${userDataDir}`,
      `--download-default-directory=${downloadDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-sync',
      '--disable-features=Translate,MediaRouter',
      ...resolveChromeSandboxArgs(platform(), process.geteuid?.()),
      `--window-size=${viewport.width},${viewport.height}`,
      'about:blank',
      ...(options.extraArgs ?? []),
    ];
    const child = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    try {
      const endpoint = await waitForDevToolsEndpoint(child, devToolsActivePortPath, signal);
      const connection = await CdpConnection.connect(
        endpoint,
        options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        signal,
      );
      throwIfAborted(signal);
      return new HeadlessChromeBrowser(child, connection, downloadDir, userDataDir);
    } catch (error) {
      await terminateChildProcess(child).catch(() => undefined);
      // This launch never acquired ownership when Chrome rejected an already
      // locked profile. Removing Singleton* here would delete the live
      // owner's locks and let a third Chrome corrupt the same profile.
      throw error;
    }
  }

  async createPage(url = 'about:blank', signal?: AbortSignal): Promise<HeadlessChromePage> {
    this.assertOpen();
    throwIfAborted(signal);
    let targetId: string | undefined;
    try {
      const created = await this.connection.send<{ targetId: string }>(
        'Target.createTarget',
        { url },
        undefined,
        { signal },
      );
      targetId = created.targetId;
      throwIfAborted(signal);
      const attached = await this.connection.send<{ sessionId: string }>(
        'Target.attachToTarget',
        { targetId, flatten: true },
        undefined,
        { signal },
      );
      throwIfAborted(signal);
      const page = new HeadlessChromePageImpl(
        this.connection,
        targetId,
        attached.sessionId,
        this.downloadDir,
        () => this.pages.size === 1,
        (closedPage) => this.pages.delete(closedPage),
      );
      this.pages.add(page);
      try {
        await page.enable(signal);
        throwIfAborted(signal);
        return page;
      } catch (error) {
        this.pages.delete(page);
        await page.close().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (targetId) {
        await this.connection.send('Target.closeTarget', { targetId }).catch(() => undefined);
      }
      throw error;
    }
  }

  get downloadDirectory(): string {
    return this.downloadDir;
  }

  async takeRelatedPage(
    openerTargetId: string,
    signal?: AbortSignal,
  ): Promise<HeadlessChromePage | undefined> {
    this.assertOpen();
    throwIfAborted(signal);
    if (![...this.pages].some((page) => page.targetId === openerTargetId)) return undefined;
    const targets = await this.connection.send<{
      targetInfos?: Array<{
        targetId?: string;
        type?: string;
        openerId?: string;
      }>;
    }>('Target.getTargets', undefined, undefined, { signal });
    const ownedTargetIds = new Set([...this.pages].map((page) => page.targetId));
    const relatedTarget = targets.targetInfos?.find(
      (target) =>
        target.type === 'page' &&
        target.openerId === openerTargetId &&
        typeof target.targetId === 'string' &&
        !ownedTargetIds.has(target.targetId),
    );
    if (!relatedTarget?.targetId) return undefined;
    const attached = await this.connection.send<{ sessionId: string }>(
      'Target.attachToTarget',
      { targetId: relatedTarget.targetId, flatten: true },
      undefined,
      { signal },
    );
    return this.adoptRelatedPage(
      { targetId: relatedTarget.targetId, sessionId: attached.sessionId },
      signal,
    );
  }

  onUnexpectedExit(listener: (error: Error) => void): () => void {
    this.unexpectedExitListeners.add(listener);
    const failure = this.processFailure;
    if (failure) {
      queueMicrotask(() => {
        if (this.unexpectedExitListeners.has(listener)) listener(failure);
      });
    }
    return () => this.unexpectedExitListeners.delete(listener);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeOwnedResources();
    return this.closePromise;
  }

  private async closeOwnedResources(): Promise<void> {
    try {
      await Promise.allSettled([...this.pages].map((page) => page.close()));
      await this.connection.close().catch(() => undefined);
      await terminateChildProcess(this.process);
      await removeChromeProfileLocks(this.userDataDir);
    } finally {
      this.process.removeListener('error', this.processErrorListener);
      this.process.removeListener('exit', this.processExitListener);
      this.unexpectedExitListeners.clear();
    }
  }

  private async adoptRelatedPage(
    target: RelatedPageTarget,
    signal?: AbortSignal,
  ): Promise<HeadlessChromePage> {
    this.assertOpen();
    throwIfAborted(signal);
    const page = new HeadlessChromePageImpl(
      this.connection,
      target.targetId,
      target.sessionId,
      this.downloadDir,
      () => this.pages.size === 1,
      (closedPage) => this.pages.delete(closedPage),
    );
    this.pages.add(page);
    try {
      await page.enable(signal);
      throwIfAborted(signal);
      return page;
    } catch (error) {
      this.pages.delete(page);
      await page.close().catch(() => undefined);
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Headless Chrome browser is closed');
    if (this.processFailure) throw this.processFailure;
    if (childProcessExited(this.process)) {
      throw new Error('CHROME_PROCESS_EXITED: Chrome is no longer running');
    }
  }

  private recordUnexpectedProcessFailure(error: Error): void {
    if (this.closed || this.processFailure) return;
    this.processFailure = error;
    for (const listener of this.unexpectedExitListeners) listener(error);
  }
}

async function terminateChildProcess(child: ChildProcess): Promise<void> {
  if (childProcessExited(child)) return;
  const gracefulExit = waitForChildExit(child, PROCESS_EXIT_TIMEOUT_MS);
  child.kill();
  if (await gracefulExit) return;
  const forcedExit = waitForChildExit(child, PROCESS_EXIT_TIMEOUT_MS);
  child.kill('SIGKILL');
  if (await forcedExit) return;
  throw new Error(
    `CHROME_PROCESS_CLEANUP_FAILED: Chrome pid ${child.pid ?? 'unknown'} did not exit`,
  );
}

function childProcessExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (childProcessExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(childProcessExited(child)), timeoutMs);
    timer.unref?.();
    child.once('exit', onExit);
  });
}

async function removeChromeProfileLocks(userDataDir: string): Promise<void> {
  await Promise.all(
    CHROME_PROFILE_LOCK_NAMES.map((name) =>
      rm(join(userDataDir, name), { force: true, recursive: true }).catch(() => undefined),
    ),
  );
}

class HeadlessChromePageImpl implements HeadlessChromePage {
  private closed = false;
  private readonly attachedFrames = new Map<string, BrowserAttachedFrame>();
  private eventDisposer: (() => void) | undefined;

  constructor(
    private readonly connection: CdpConnection,
    public readonly targetId: string,
    private sessionId: string,
    private readonly downloadDir: string,
    private readonly canRouteBrowserDownloadEvent: () => boolean,
    private readonly onClosed: (page: HeadlessChromePageImpl) => void,
  ) {}

  get transport(): BrowserPageTransport {
    return this;
  }

  async enable(signal?: AbortSignal): Promise<void> {
    this.eventDisposer?.();
    this.eventDisposer = this.connection.onEvent((event) => this.trackAttachedTarget(event));
    const options = signal ? { signal } : undefined;
    // Keep auto-attach scoped to this already-attached page session. A
    // browser-level command would also attach unrelated top-level tabs and
    // would require a second global target demultiplexer in this provider.
    await this.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      undefined,
      options,
    );
    await this.send('Page.enable', undefined, undefined, options);
    await this.send('Runtime.enable', undefined, undefined, options);
    await this.send('DOM.enable', undefined, undefined, options);
    await this.send('Network.enable', undefined, undefined, options).catch((error) => {
      if (signal?.aborted) throw error;
    });
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true }, undefined, options);
    await this.send(
      'Page.setDownloadBehavior',
      { behavior: 'allow', downloadPath: this.downloadDir },
      undefined,
      options,
    ).catch((error) => {
      if (signal?.aborted) throw error;
    });
  }

  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
    options?: BrowserTransportCommandOptions,
  ): Promise<T> {
    this.assertOpen();
    return this.connection.send<T>(method, params, sessionId ?? this.sessionId, options);
  }

  evaluate<T = unknown>(expression: string, options: BrowserEvaluateOptions = {}): Promise<T> {
    return this.evaluateInSession<T>(this.sessionId, expression, options);
  }

  evaluateInAllFrames<T = unknown>(
    expression: string,
    options: BrowserEvaluateOptions = {},
  ): Promise<readonly T[]> {
    return Promise.all(
      [this.sessionId, ...this.attachedFrames.keys()].map((sessionId) =>
        this.evaluateInSession<T>(sessionId, expression, options),
      ),
    );
  }

  listAttachedFrames(): readonly BrowserAttachedFrame[] {
    return [...this.attachedFrames.values()];
  }

  private evaluateInSession<T>(
    sessionId: string,
    expression: string,
    options: BrowserEvaluateOptions,
  ): Promise<T> {
    return this.send<Record<string, unknown>>(
      'Runtime.evaluate',
      {
        expression,
        awaitPromise: options.awaitPromise ?? true,
        returnByValue: options.returnByValue ?? true,
        userGesture: options.userGesture ?? true,
      },
      sessionId,
      { signal: options.signal, timeoutMs: options.timeoutMs },
    ).then((payload) => {
      const exception = payload.exceptionDetails;
      if (exception && typeof exception === 'object') {
        // CDP's details.text is always "Uncaught"; the real error is in exception.description.
        throw new Error(describeCdpException(exception, 'Page evaluation failed'));
      }
      const result = payload.result;
      if (!result || typeof result !== 'object') return undefined as T;
      const remote = result as Record<string, unknown>;
      if ('value' in remote) return remote.value as T;
      if (remote.unserializableValue === 'undefined') return undefined as T;
      return remote.description as T;
    });
  }

  onEvent(listener: BrowserTransportEventListener): () => void {
    return this.connection.onEvent((event) => {
      if (isHeadlessBrowserDownloadEvent(event.method, event.sessionId)) {
        // Browser.download* events have no target session. Until the browser
        // owner maintains frame/guid ownership, forwarding them while sibling
        // pages are alive could attribute a background download to this page.
        if (!this.canRouteBrowserDownloadEvent()) return;
      } else if (
        event.sessionId !== this.sessionId &&
        !this.attachedFrames.has(event.sessionId ?? '')
      ) {
        return;
      }
      listener(event);
    });
  }

  stopLoading(): Promise<void> {
    return this.send('Page.stopLoading').then(() => undefined);
  }

  async waitForReady(
    timeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS,
    signal?: AbortSignal,
  ): Promise<{
    url: string;
    readyState: string;
  }> {
    this.assertOpen();
    throwIfAborted(signal);
    const deadline = Date.now() + Math.max(1_000, Math.min(120_000, Math.floor(timeoutMs)));
    let navigationFailure: string | undefined;
    const dispose = this.onEvent((event) => {
      if (event.method !== 'Network.loadingFailed') return;
      if (!isHeadlessRootSessionEvent(event.sessionId, this.sessionId)) return;
      const params = asRecord(event.params);
      if (asString(params.type) !== 'Document' || params.canceled === true) return;
      navigationFailure = asString(params.errorText) || 'Document navigation failed';
    });
    try {
      while (Date.now() <= deadline) {
        throwIfAborted(signal);
        if (navigationFailure) throw new Error(`NAVIGATION_FAILED: ${navigationFailure}`);
        try {
          const state = await this.evaluate<{ url: string; readyState: string }>(
            '({ url: location.href, readyState: document.readyState })',
            {
              timeoutMs: Math.min(5_000, Math.max(1, deadline - Date.now())),
              ...(signal ? { signal } : {}),
            },
          );
          if (
            (state.readyState === 'interactive' || state.readyState === 'complete') &&
            state.url !== 'about:blank'
          ) {
            return state;
          }
        } catch {
          // A navigation can replace the execution context between polls.
        }
        await delay(50);
      }
      if (navigationFailure) throw new Error(`NAVIGATION_FAILED: ${navigationFailure}`);
      throw new Error(`ACTION_TIMEOUT: Browser navigation was not DOM-ready within ${timeoutMs}ms`);
    } finally {
      dispose();
    }
  }

  async resetConnection(): Promise<void> {
    this.assertOpen();
    const previousSessionId = this.sessionId;
    try {
      await this.connection.send('Target.detachFromTarget', { sessionId: previousSessionId });
    } catch (error) {
      // If Chrome already discarded the old session, isolation is proven and
      // attaching a replacement is idempotent. Timeouts, socket failures and
      // all other protocol errors leave the old command uncertain and must
      // poison the Core session instead of being reported as recovery success.
      if (!isHeadlessSessionAlreadyAbsentError(error)) throw error;
    }
    const attached = await this.connection.send<{ sessionId: string }>('Target.attachToTarget', {
      targetId: this.targetId,
      flatten: true,
    });
    this.sessionId = attached.sessionId;
    this.attachedFrames.clear();
    await this.enable();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.eventDisposer?.();
      this.eventDisposer = undefined;
      this.attachedFrames.clear();
      await this.connection
        .send('Target.closeTarget', { targetId: this.targetId })
        .catch(() => undefined);
    } finally {
      this.onClosed(this);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Headless Chrome page is closed');
  }

  private trackAttachedTarget(event: BrowserTransportEvent): void {
    if (event.method === 'Target.attachedToTarget') {
      const parentSessionId = event.sessionId;
      if (
        !isHeadlessSessionEventOwned(parentSessionId, this.sessionId, (sessionId) =>
          this.attachedFrames.has(sessionId),
        )
      )
        return;
      const params = asRecord(event.params);
      const childSessionId = asString(params.sessionId);
      const targetInfo = asRecord(params.targetInfo);
      const frameId = asString(targetInfo.targetId);
      if (!childSessionId || !frameId || asString(targetInfo.type) !== 'iframe') return;
      this.attachedFrames.set(childSessionId, {
        sessionId: childSessionId,
        frameId,
        ...(parentSessionId !== this.sessionId ? { parentSessionId } : {}),
        ...(asString(targetInfo.url) ? { url: asString(targetInfo.url) } : {}),
      });
      void this.connection
        .send(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          childSessionId,
        )
        .catch(() => undefined);
      return;
    }
    if (event.method === 'Target.detachedFromTarget') {
      const childSessionId = asString(asRecord(event.params).sessionId);
      if (childSessionId) this.attachedFrames.delete(childSessionId);
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

async function waitForDevToolsEndpoint(
  child: ChildProcess,
  devToolsActivePortPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  let processError: Error | undefined;
  const onProcessError = (error: Error): void => {
    processError = error;
  };
  child.once('error', onProcessError);
  try {
    while (Date.now() < deadline) {
      throwIfAborted(signal);
      if (processError) {
        throw new Error(`CHROME_START_FAILED: ${processError.message}`);
      }
      if (childProcessExited(child)) {
        throw new Error(
          `Chrome exited during startup (${child.exitCode !== null ? `code ${child.exitCode}` : `signal ${child.signalCode ?? 'unknown'}`})`,
        );
      }
      try {
        const endpoint = parseDevToolsActivePort(await readFile(devToolsActivePortPath, 'utf8'));
        if (endpoint) return endpoint;
      } catch (error) {
        if (signal?.aborted) throw new Error('ABORTED: Chrome startup was cancelled');
        lastError = error;
      }
      await delay(100);
    }
    if (processError) throw new Error(`CHROME_START_FAILED: ${processError.message}`);
    throw new Error(
      `Timed out waiting for Chrome DevTools${lastError ? `: ${String(lastError)}` : ''}`,
    );
  } finally {
    child.removeListener('error', onProcessError);
  }
}

export function resolveDefaultChromeCandidates(
  runtimePlatform: NodeJS.Platform = platform(),
  environment: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  if (runtimePlatform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ];
  }
  if (runtimePlatform !== 'win32') {
    return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  }

  const programFiles = environment.PROGRAMFILES?.trim() || 'C:\\Program Files';
  const programFilesX86 = environment['PROGRAMFILES(X86)']?.trim() || 'C:\\Program Files (x86)';
  const localAppData =
    environment.LOCALAPPDATA?.trim() ||
    (environment.USERPROFILE?.trim()
      ? win32.join(environment.USERPROFILE.trim(), 'AppData', 'Local')
      : undefined);
  const candidates = [
    win32.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    win32.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    win32.join(programFiles, 'Chromium', 'Application', 'chrome.exe'),
    win32.join(programFilesX86, 'Chromium', 'Application', 'chrome.exe'),
  ];
  if (localAppData) {
    candidates.push(
      win32.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      win32.join(localAppData, 'Chromium', 'Application', 'chrome.exe'),
    );
  }
  return candidates;
}

async function resolveChromePath(explicit?: string): Promise<string> {
  if (explicit?.trim()) return explicit;
  const candidates = resolveDefaultChromeCandidates();
  for (const candidate of candidates) {
    if (await isChromeExecutableCandidate(candidate)) return candidate;
  }
  throw new Error(
    'Chrome executable not found; configure browser.chromePath or set MCODE_CHROME_PATH',
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('ABORTED: Chrome startup was cancelled');
}

export type { CdpEvent } from './headless-cdp-connection.js';
