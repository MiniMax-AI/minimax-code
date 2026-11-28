import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, open, readFile, readlink, rm, statfs } from 'node:fs/promises';
import { hostname, platform } from 'node:os';
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
import { ensureChromeForTesting, isChromeExecutableCandidate } from './chrome-for-testing.js';
import { CdpConnection } from './headless-cdp-connection.js';

const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const PROCESS_EXIT_TIMEOUT_MS = 3_000;
const CHROME_PROFILE_LOCK_NAMES = ['SingletonCookie', 'SingletonLock', 'SingletonSocket'] as const;
/** Unclaimed popups of owned pages kept at once; the oldest is closed beyond this. */
export const MAX_PREPARED_RELATED_PAGES = 8;
/**
 * An unclaimed popup is closed after this. Only an action that started before
 * the popup was created claims it, right after the action settles, so this
 * outlives the longest claiming action (its navigation wait is capped at 120s).
 */
export const PREPARED_RELATED_PAGE_TTL_MS = 180_000;

export function resolveChromeSandboxArgs(
  runtimePlatform: NodeJS.Platform,
  effectiveUserId: number | undefined,
): readonly string[] {
  // Chrome refuses to start as Linux root with its process sandbox enabled.
  // Prefer a usable native-headless provider and scope the compatibility flag
  // strictly to that platform/user combination.
  return runtimePlatform === 'linux' && effectiveUserId === 0 ? ['--no-sandbox'] : [];
}

/**
 * Below this, ordinary content pages overflow Chrome's renderer shared memory.
 * Docker and Kubernetes mount a 64 MB /dev/shm by default; a Linux host mounts
 * half of physical memory, where Chrome's default placement is the fast path.
 */
export const MIN_DEV_SHM_BYTES = 256 * 1024 * 1024;

export async function resolveChromeSharedMemoryArgs(
  runtimePlatform: NodeJS.Platform,
  devShmBytes: () => Promise<number | undefined> = measureDevShmBytes,
): Promise<readonly string[]> {
  if (runtimePlatform !== 'linux') return [];
  // Measured in the eval sandbox: weibo/feishu pages peak at 62-63 MB, so a
  // 64 MB mount crashes the renderer and, after a few crashes, Chrome itself.
  // An unreadable mount is treated as small: the flag is harmless on a large
  // one, while a missed small one takes the browser down.
  const bytes = await devShmBytes();
  return bytes === undefined || bytes < MIN_DEV_SHM_BYTES ? ['--disable-dev-shm-usage'] : [];
}

async function measureDevShmBytes(): Promise<number | undefined> {
  try {
    const stats = await statfs('/dev/shm');
    return Number(stats.blocks) * Number(stats.bsize);
  } catch {
    return undefined;
  }
}

/** Create or repair a provider-owned Browser directory as private on POSIX hosts. */
export async function ensurePrivateBrowserDirectory(
  directory: string,
  runtimePlatform: NodeJS.Platform = platform(),
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (runtimePlatform !== 'win32') await chmod(directory, 0o700);
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
  /** Chrome for Testing cache, shared by every session of the data directory. Unused with `chromePath`. */
  readonly chromeForTestingDir: string;
  readonly userDataDir?: string;
  readonly downloadDir?: string;
  readonly viewport?: { width: number; height: number };
  readonly extraArgs?: readonly string[];
  readonly commandTimeoutMs?: number;
  /** `false` opens a visible Chrome window; default is headless. */
  readonly headless?: boolean;
}

/** Where one launch saves downloads: the configured directory, else under its data directory. */
export function resolveHeadlessDownloadDir(
  options: Pick<HeadlessChromeLaunchOptions, 'dataDir' | 'downloadDir'>,
): string {
  return options.downloadDir ?? join(options.dataDir, 'browser', 'headless', 'downloads');
}

/** Fixed Chrome command line for one provider-owned launch. */
export function resolveChromeLaunchArgs(options: {
  readonly userDataDir: string;
  readonly downloadDir: string;
  readonly viewport: { width: number; height: number };
  readonly headless: boolean;
  readonly platformArgs: readonly string[];
  readonly extraArgs?: readonly string[];
}): string[] {
  return [
    ...(options.headless ? ['--headless=new'] : []),
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${options.userDataDir}`,
    `--download-default-directory=${options.downloadDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter',
    ...options.platformArgs,
    `--window-size=${options.viewport.width},${options.viewport.height}`,
    'about:blank',
    ...(options.extraArgs ?? []),
  ];
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
  /**
   * Resolve once the document is DOM-ready. Also resolves, with readyState
   * `dialog`, when a JavaScript dialog pauses the page first: the page cannot
   * progress until the model answers it, which Browser Core reports.
   */
  waitForReady(
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<{ url: string; readyState: string }>;
  resetConnection(): Promise<void>;
  /** See BrowserTransport.pendingJavaScriptDialog. */
  pendingJavaScriptDialog(): Record<string, unknown> | undefined;
  close(): Promise<void>;
}

interface PreparedRelatedPage {
  readonly openerTargetId: string;
  readonly page: HeadlessChromePageImpl;
  /** Page session enabled; the target was then released to run. */
  readonly ready: Promise<void>;
  /** Creation order across this browser; see relatedPageCheckpoint. */
  readonly sequence: number;
  /** Absent in a visible window, whose popups only the user closes. */
  readonly expiry: NodeJS.Timeout | undefined;
}

export interface RelatedPageClaim {
  /** relatedPageCheckpoint() taken before the action; older popups are never claimed. */
  readonly openedAfter: number;
  /** Claim exactly this popup (the one whose dialog paused the action), not the oldest. */
  readonly targetId?: string;
  readonly signal?: AbortSignal;
}

/** See HeadlessChromeBrowser.watchRelatedPageDialog. */
export interface RelatedPageDialogWatch {
  /** Resolves with the target id of the popup whose dialog opened. */
  readonly opened: Promise<string>;
  readonly dispose: () => void;
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
  /**
   * Popups of owned pages, keyed by target id, until takeRelatedPage adopts
   * them. Map insertion order is creation order, so the first match is the
   * oldest (FIFO). Bounded by MAX_PREPARED_RELATED_PAGES and
   * PREPARED_RELATED_PAGE_TTL_MS; an evicted or expired popup is closed. A
   * visible window has neither bound: an unclaimed popup there can be the
   * user's own, such as a sign-in window opened between agent actions.
   */
  private readonly preparedRelatedPages = new Map<string, PreparedRelatedPage>();
  private relatedPageSequence = 0;
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
    private readonly headed = false,
  ) {
    this.process = process;
    this.connection = connection;
    this.process.on('error', this.processErrorListener);
    this.process.on('exit', this.processExitListener);
  }

  static async launch(
    options: HeadlessChromeLaunchOptions,
    signal?: AbortSignal,
    sources: ChromeExecutableSources = DEFAULT_CHROME_EXECUTABLE_SOURCES,
  ): Promise<HeadlessChromeBrowser> {
    throwIfAborted(signal);
    const { chromeForTestingDir } = options;
    const chromePath = await resolveChromeExecutable(
      {
        ...(options.chromePath ? { chromePath: options.chromePath } : {}),
        chromeForTestingDir,
      },
      signal,
      sources,
    );
    const userDataDir =
      options.userDataDir ?? join(options.dataDir, 'browser', 'headless', 'profile');
    try {
      return await HeadlessChromeBrowser.start(chromePath, userDataDir, options, signal);
    } catch (error) {
      if (options.chromePath?.trim()) throw error;
      const local = await localChromeAfterStartFailure(
        error,
        { chromePath, chromeForTestingDir, userDataDir },
        signal,
        sources,
      );
      if (!local) throw error;
      try {
        return await HeadlessChromeBrowser.start(local, userDataDir, options, signal);
      } catch (fallbackError) {
        // Both failed: keep why Chrome for Testing did not start.
        throw new Error(
          `${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)} (local Chrome ${local}, after Chrome for Testing ${chromePath} failed to start: ${error instanceof Error ? error.message : String(error)})`,
          { cause: error },
        );
      }
    }
  }

  private static async start(
    chromePath: string,
    userDataDir: string,
    options: HeadlessChromeLaunchOptions,
    signal?: AbortSignal,
  ): Promise<HeadlessChromeBrowser> {
    throwIfAborted(signal);
    const downloadDir = resolveHeadlessDownloadDir(options);
    await ensurePrivateBrowserDirectory(options.dataDir);
    await ensurePrivateBrowserDirectory(userDataDir);
    await ensurePrivateBrowserDirectory(downloadDir);
    const devToolsActivePortPath = join(userDataDir, 'DevToolsActivePort');
    await rm(devToolsActivePortPath, { force: true });
    const args = resolveChromeLaunchArgs({
      userDataDir,
      downloadDir,
      viewport: options.viewport ?? DEFAULT_VIEWPORT,
      headless: options.headless !== false,
      platformArgs: [
        ...resolveChromeSandboxArgs(platform(), process.geteuid?.()),
        ...(await resolveChromeSharedMemoryArgs(platform())),
      ],
      ...(options.extraArgs ? { extraArgs: options.extraArgs } : {}),
    });
    const child = spawn(chromePath, args, { stdio: ['ignore', 'ignore', 'ignore'] });
    try {
      const endpoint = await waitForDevToolsEndpoint(child, devToolsActivePortPath, signal);
      const connection = await CdpConnection.connect(
        endpoint,
        options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
        signal,
      );
      throwIfAborted(signal);
      const browser = new HeadlessChromeBrowser(
        child,
        connection,
        downloadDir,
        userDataDir,
        options.headless === false,
      );
      await browser.holdNewPagesUntilEnabled(signal);
      return browser;
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

  /**
   * Sequence of the newest popup prepared so far. An action takes it before it
   * runs and passes it to takeRelatedPage/watchRelatedPageDialog, so a popup
   * opened earlier (by a page timer or an earlier action, never claimed) is not
   * mistaken for the one this action opened.
   */
  relatedPageCheckpoint(): number {
    return this.relatedPageSequence;
  }

  /**
   * Adopt the oldest popup `openerTargetId` opened after `claim.openedAfter`
   * (or exactly `claim.targetId`). The adopted page becomes an owned page: its
   * own popups are prepared, and closing it or the browser closes it.
   * Every popup is held by browser-level auto-attach before it runs
   * (holdNewPagesUntilEnabled), so prepared popups are the only candidates.
   */
  async takeRelatedPage(
    openerTargetId: string,
    claim: RelatedPageClaim,
  ): Promise<HeadlessChromePage | undefined> {
    this.assertOpen();
    throwIfAborted(claim.signal);
    if (![...this.pages].some((page) => page.targetId === openerTargetId)) return undefined;
    const entry = this.findPreparedRelatedPage(openerTargetId, claim.openedAfter, claim.targetId);
    if (!entry) return undefined;
    this.takePreparedRelatedPage(entry.page.targetId);
    this.pages.add(entry.page);
    try {
      await entry.ready;
      throwIfAborted(claim.signal);
      return entry.page;
    } catch (error) {
      this.pages.delete(entry.page);
      await entry.page.close().catch(() => undefined);
      throw error;
    }
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
      const preparedPages = [...this.preparedRelatedPages.keys()].flatMap(
        (targetId) => this.takePreparedRelatedPage(targetId)?.page ?? [],
      );
      await Promise.allSettled([...this.pages, ...preparedPages].map((page) => page.close()));
      await this.connection.close().catch(() => undefined);
      await terminateChildProcess(this.process);
      await removeChromeProfileLocks(this.userDataDir, this.process.pid);
    } finally {
      this.process.removeListener('error', this.processErrorListener);
      this.process.removeListener('exit', this.processExitListener);
      this.unexpectedExitListeners.clear();
    }
  }

  /**
   * Resolve with the target id of a popup that `openerTargetId` opened after
   * `openedAfter` (relatedPageCheckpoint), not adopted yet, once it shows a
   * JavaScript dialog. A same-site popup shares its opener's renderer, so its
   * dialog pauses the opener too: an action running there cannot finish
   * until the dialog is answered in the popup.
   */
  watchRelatedPageDialog(openerTargetId: string, openedAfter: number): RelatedPageDialogWatch {
    let resolveOpened: (targetId: string) => void = () => undefined;
    const opened = new Promise<string>((resolve) => {
      resolveOpened = resolve;
    });
    const check = (): void => {
      for (const entry of this.preparedRelatedPages.values()) {
        if (
          entry.openerTargetId === openerTargetId &&
          entry.sequence > openedAfter &&
          entry.page.pendingJavaScriptDialog()
        ) {
          resolveOpened(entry.page.targetId);
          return;
        }
      }
    };
    // A popup prepared during the watch registers its tracker after this
    // listener; check once every listener has seen the event.
    const dispose = this.connection.onEvent((event) => {
      if (event.method === 'Page.javascriptDialogOpening') queueMicrotask(check);
    });
    check();
    return { opened, dispose };
  }

  private findPreparedRelatedPage(
    openerTargetId: string,
    openedAfter: number,
    targetId: string | undefined,
  ): PreparedRelatedPage | undefined {
    for (const entry of this.preparedRelatedPages.values()) {
      if (entry.openerTargetId !== openerTargetId || entry.sequence <= openedAfter) continue;
      if (targetId === undefined || entry.page.targetId === targetId) return entry;
    }
    return undefined;
  }

  /** Remove a prepared popup from the registry and stop its expiry; the caller owns the page. */
  private takePreparedRelatedPage(targetId: string): PreparedRelatedPage | undefined {
    const entry = this.preparedRelatedPages.get(targetId);
    if (!entry) return undefined;
    this.preparedRelatedPages.delete(targetId);
    clearTimeout(entry.expiry);
    return entry;
  }

  private discardPreparedRelatedPage(targetId: string): void {
    void this.takePreparedRelatedPage(targetId)?.page.close();
  }

  /**
   * A page Chrome opens by itself (window.open, a target=_blank link) can show
   * a dialog from its first script. Attaching it after the opener's action
   * returned is too late: Page.enable then waits on the paused renderer, and
   * Chromium cannot answer a dialog it reported to no Page-enabled session
   * ("No dialog is showing"), so the popup and its opener, which shares the
   * renderer, stay paused. Browser-level auto-attach holds every new page
   * before it runs; a popup of an owned page gets its page session enabled
   * before it is released, every other new page is released at once.
   */
  private async holdNewPagesUntilEnabled(signal?: AbortSignal): Promise<void> {
    this.connection.onEvent((event) => this.handleBrowserTargetEvent(event));
    await this.connection.send(
      'Target.setAutoAttach',
      { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }] },
      undefined,
      signal ? { signal } : undefined,
    );
  }

  private handleBrowserTargetEvent(event: BrowserTransportEvent): void {
    if (event.sessionId) return;
    const params = asRecord(event.params);
    if (event.method === 'Target.detachedFromTarget') {
      this.discardPreparedRelatedPage(asString(params.targetId));
      return;
    }
    // Explicit Target.attachToTarget sessions and pages that existed before
    // auto-attach was enabled are reported without waitingForDebugger.
    if (event.method !== 'Target.attachedToTarget' || params.waitingForDebugger !== true) return;
    const sessionId = asString(params.sessionId);
    const targetInfo = asRecord(params.targetInfo);
    const targetId = asString(targetInfo.targetId);
    const openerTargetId = asString(targetInfo.openerId);
    if (!sessionId || !targetId) return;
    const release = (): Promise<unknown> =>
      this.connection
        .send('Runtime.runIfWaitingForDebugger', undefined, sessionId)
        .catch(() => undefined);
    if (this.closed || ![...this.pages].some((page) => page.targetId === openerTargetId)) {
      // createPage attaches its own session; nothing else here is owned.
      void release().then(() =>
        this.connection.send('Target.detachFromTarget', { sessionId }).catch(() => undefined),
      );
      return;
    }
    const page = new HeadlessChromePageImpl(
      this.connection,
      targetId,
      sessionId,
      this.downloadDir,
      () => this.pages.size === 1,
      (closedPage) => this.pages.delete(closedPage),
    );
    const ready = page.enable(undefined, release);
    // Never leave a page held when enabling failed before the release was sent.
    ready.catch(() => release());
    this.relatedPageSequence += 1;
    const expiry = this.headed
      ? undefined
      : setTimeout(() => this.discardPreparedRelatedPage(targetId), PREPARED_RELATED_PAGE_TTL_MS);
    expiry?.unref();
    this.preparedRelatedPages.set(targetId, {
      openerTargetId,
      page,
      ready,
      sequence: this.relatedPageSequence,
      expiry,
    });
    if (!this.headed && this.preparedRelatedPages.size > MAX_PREPARED_RELATED_PAGES) {
      const [oldestTargetId] = this.preparedRelatedPages.keys();
      if (oldestTargetId) this.discardPreparedRelatedPage(oldestTargetId);
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

/**
 * Remove the Singleton* entries the exited Chrome left behind. They stay when
 * SingletonLock names another live Chrome, which took the profile meanwhile:
 * deleting its locks would let a further Chrome open the same profile.
 */
async function removeChromeProfileLocks(
  userDataDir: string,
  chromePid: number | undefined,
): Promise<void> {
  const lockOwner = await readlink(join(userDataDir, 'SingletonLock')).catch(() => undefined);
  if (lockOwner !== `${hostname()}-${chromePid}` && (await isChromeProfileInUse(userDataDir))) {
    return;
  }
  await Promise.all(
    CHROME_PROFILE_LOCK_NAMES.map((name) =>
      rm(join(userDataDir, name), { force: true, recursive: true }).catch(() => undefined),
    ),
  );
}

/**
 * Whether a live Chrome, possibly owned by another MCode process, holds this
 * profile. POSIX Chrome writes `SingletonLock -> <host>-<pid>`; Windows Chrome
 * keeps `lockfile` open exclusively. Unknown owners count as live: a wrong
 * "in use" only costs an isolated profile, a wrong "free" makes Chrome hand
 * the launch to the other process and exit.
 */
export async function isChromeProfileInUse(
  userDataDir: string,
  runtimePlatform: NodeJS.Platform = platform(),
): Promise<boolean> {
  if (runtimePlatform === 'win32') {
    try {
      const handle = await open(join(userDataDir, 'lockfile'), 'r+');
      await handle.close();
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
  }
  let owner: string;
  try {
    owner = await readlink(join(userDataDir, 'SingletonLock'));
  } catch {
    return false;
  }
  const separator = owner.lastIndexOf('-');
  const pid = Number(owner.slice(separator + 1));
  if (separator <= 0 || owner.slice(0, separator) !== hostname() || !Number.isInteger(pid)) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

class HeadlessChromePageImpl implements HeadlessChromePage {
  private closed = false;
  private readonly attachedFrames = new Map<string, BrowserAttachedFrame>();
  private eventDisposer: (() => void) | undefined;
  /** `Page.javascriptDialogOpening` params of the dialog still open on this page. */
  private openDialog: Record<string, unknown> | undefined;

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

  pendingJavaScriptDialog(): Record<string, unknown> | undefined {
    return this.openDialog;
  }

  /**
   * Enable the page session. `releaseHeldTarget` resumes a page Chrome holds
   * for the debugger (holdNewPagesUntilEnabled): it is sent right after the
   * enable commands, not after their replies. A popup without a renderer yet
   * (a `noopener` / target=_blank link opens one in a new process) cannot
   * answer Page.enable until its navigation runs, which the hold blocks. The
   * session queues the commands in order, so Page events still reach this
   * session before the page's first script.
   */
  async enable(signal?: AbortSignal, releaseHeldTarget?: () => Promise<unknown>): Promise<void> {
    this.eventDisposer?.();
    this.eventDisposer = this.connection.onEvent((event) => {
      this.trackAttachedTarget(event);
      this.trackOpenDialog(event);
    });
    const options = signal ? { signal } : undefined;
    const ignoreUnlessAborted = (error: unknown): void => {
      if (signal?.aborted) throw error;
    };
    const commands = [
      // Keep frame auto-attach scoped to this already-attached page session.
      // The browser owner's own auto-attach only holds new top-level pages
      // (holdNewPagesUntilEnabled); frames stay demultiplexed per page here.
      this.send(
        'Target.setAutoAttach',
        { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
        undefined,
        options,
      ),
      this.send('Page.enable', undefined, undefined, options),
      this.send('Runtime.enable', undefined, undefined, options),
      this.send('DOM.enable', undefined, undefined, options),
      this.send('Network.enable', undefined, undefined, options).catch(ignoreUnlessAborted),
      this.send('Page.setLifecycleEventsEnabled', { enabled: true }, undefined, options),
      this.send(
        'Page.setDownloadBehavior',
        { behavior: 'allow', downloadPath: this.downloadDir },
        undefined,
        options,
      ).catch(ignoreUnlessAborted),
    ];
    if (releaseHeldTarget) commands.push(releaseHeldTarget());
    await Promise.all(commands);
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
    // A dialog pauses the page: the running poll would wait on it until its
    // deadline, so the dialog aborts it and is returned below.
    let pausedPoll = new AbortController();
    const dispose = this.onEvent((event) => {
      if (!isHeadlessRootSessionEvent(event.sessionId, this.sessionId)) return;
      if (event.method === 'Page.javascriptDialogOpening') {
        pausedPoll.abort();
        return;
      }
      if (event.method !== 'Network.loadingFailed') return;
      const params = asRecord(event.params);
      if (asString(params.type) !== 'Document' || params.canceled === true) return;
      navigationFailure = asString(params.errorText) || 'Document navigation failed';
    });
    try {
      while (Date.now() <= deadline) {
        throwIfAborted(signal);
        if (navigationFailure) throw new Error(`NAVIGATION_FAILED: ${navigationFailure}`);
        if (this.openDialog) {
          return { url: asString(this.openDialog.url), readyState: 'dialog' };
        }
        pausedPoll = new AbortController();
        try {
          const state = await this.evaluate<{ url: string; readyState: string }>(
            '({ url: location.href, readyState: document.readyState })',
            {
              timeoutMs: Math.min(5_000, Math.max(1, deadline - Date.now())),
              signal: signal ? AbortSignal.any([signal, pausedPoll.signal]) : pausedPoll.signal,
            },
          );
          if (
            (state.readyState === 'interactive' || state.readyState === 'complete') &&
            state.url !== 'about:blank'
          ) {
            return state;
          }
        } catch {
          // A navigation can replace the execution context between polls; a
          // dialog aborts the paused poll and is returned above.
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
    // Chromium does not report a dialog to the replacement session.
    this.openDialog = undefined;
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

  private trackOpenDialog(event: BrowserTransportEvent): void {
    // Chromium reports dialogs, also those of OOPIFs, on the page session.
    if (!isHeadlessRootSessionEvent(event.sessionId, this.sessionId)) return;
    if (event.method === 'Page.javascriptDialogOpening') {
      this.openDialog = asRecord(event.params);
    } else if (event.method === 'Page.javascriptDialogClosed') {
      this.openDialog = undefined;
    } else if (
      event.method === 'Page.frameNavigated' &&
      !asRecord(asRecord(event.params).frame).parentId
    ) {
      this.openDialog = undefined;
    }
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

/** Chrome did not open DevTools: a spawn error, an exit during startup, or a timeout. */
class ChromeStartError extends Error {}

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
        throw new ChromeStartError(`CHROME_START_FAILED: ${processError.message}`);
      }
      if (childProcessExited(child)) {
        throw new ChromeStartError(
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
    if (processError) throw new ChromeStartError(`CHROME_START_FAILED: ${processError.message}`);
    throw new ChromeStartError(
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

export interface ChromeExecutableSources {
  readonly ensureChromeForTesting: (options: {
    cacheDir: string;
    signal?: AbortSignal;
  }) => Promise<string>;
  readonly findLocalChrome: () => Promise<string | undefined>;
}

const DEFAULT_CHROME_EXECUTABLE_SOURCES: ChromeExecutableSources = {
  ensureChromeForTesting,
  findLocalChrome: async () => {
    for (const candidate of resolveDefaultChromeCandidates()) {
      if (await isChromeExecutableCandidate(candidate)) return candidate;
    }
    return undefined;
  },
};

/** Local Chrome chosen after Chrome for Testing failed, per cache, for this process. */
const localChromeFallbacks = new Map<string, string>();

/**
 * Configured path first, then the pinned Chrome for Testing build, then a
 * local Chrome install. A successful local fallback is reused for the process
 * lifetime so an offline host does not retry the download on every launch.
 * HeadlessChromeBrowser.launch also falls back when the build cannot start;
 * see localChromeAfterStartFailure.
 */
export async function resolveChromeExecutable(
  options: { readonly chromePath?: string; readonly chromeForTestingDir: string },
  signal?: AbortSignal,
  sources: ChromeExecutableSources = DEFAULT_CHROME_EXECUTABLE_SOURCES,
): Promise<string> {
  if (options.chromePath?.trim()) return options.chromePath;
  const cacheDir = options.chromeForTestingDir;
  const remembered = localChromeFallbacks.get(cacheDir);
  if (remembered) return remembered;
  let chromeForTestingError: unknown;
  try {
    return await sources.ensureChromeForTesting({ cacheDir, ...(signal ? { signal } : {}) });
  } catch (error) {
    throwIfAborted(signal);
    chromeForTestingError = error;
  }
  const local = await sources.findLocalChrome();
  if (local) {
    localChromeFallbacks.set(cacheDir, local);
    return local;
  }
  const reason =
    chromeForTestingError instanceof Error
      ? chromeForTestingError.message
      : String(chromeForTestingError);
  throw new Error(
    `Chrome executable not found: Chrome for Testing is unavailable (${reason}) and no local Chrome was found; configure browser.chromePath or set MCODE_CHROME_PATH`,
    { cause: chromeForTestingError },
  );
}

/**
 * The local Chrome to start once after a Chrome for Testing build installed
 * but did not start here (musl libc, an unsupported OS version, blocked by
 * policy, a broken extract). Like a failed download, the choice is kept for
 * the cache. Undefined when the failed executable was already the local
 * fallback, startup was cancelled, or Chrome exited because another live
 * Chrome holds the profile, which is not the build's fault.
 */
async function localChromeAfterStartFailure(
  error: unknown,
  failed: { chromePath: string; chromeForTestingDir: string; userDataDir: string },
  signal: AbortSignal | undefined,
  sources: ChromeExecutableSources,
): Promise<string | undefined> {
  if (!(error instanceof ChromeStartError) || signal?.aborted) return undefined;
  if (localChromeFallbacks.get(failed.chromeForTestingDir) === failed.chromePath) return undefined;
  if (await isChromeProfileInUse(failed.userDataDir)) return undefined;
  const local = await sources.findLocalChrome();
  if (!local || local === failed.chromePath) return undefined;
  localChromeFallbacks.set(failed.chromeForTestingDir, local);
  return local;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('ABORTED: Chrome startup was cancelled');
}

export type { CdpEvent } from './headless-cdp-connection.js';
