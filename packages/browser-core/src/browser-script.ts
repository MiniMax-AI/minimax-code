import { buttonName, modifierBit } from './browser-action-helpers.js';
import {
  browserKeyDescriptor,
  browserPhysicalKeyDescriptor,
  browserPrintableKeyDescriptor,
  browserShiftedKey,
  type BrowserKeyDescriptor,
} from './browser-keyboard.js';
import {
  BrowserScriptOperationError,
  BROWSER_SCRIPT_MAX_LOG_ENTRIES,
  BROWSER_SCRIPT_RUNTIME_FILENAME,
  runBrowserScriptWorker,
  type BrowserScriptWorkerError,
  type BrowserScriptWorkerOutcome,
} from './browser-script-worker.js';
import {
  asNumber,
  asString,
  delay,
  inputCoordinate,
  isRecord,
  stringArray,
  type BrowserSessionState,
} from './browser-state.js';
import type { CDPConsoleDiagnosticLevelFilter } from './cdp-helper-contracts.js';
import { sanitizeConsoleDiagnosticUrl } from './console-diagnostic-sanitizer.js';
import { isBrowserOperationInterruption, withTimeout } from './operation-timeout.js';
import { BrowserProgramError, pageScriptUnsupportedPageMessage } from './program/errors.js';
import {
  assertPageScriptExpression,
  isPageScriptWebPage,
  PAGE_SCRIPT_EFFECT_COUNTER,
  PageScriptEffectWindow,
  pageScriptOrigin,
} from './program/page-evaluate.js';
import type { ProgramPageScriptEffects, ProgramPageScriptRequest } from './program/types.js';

export const BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS = 30_000;
export const BROWSER_SCRIPT_MAX_TIMEOUT_MS = 120_000;
/** Release, recovery and result assembly run after the script deadline. */
export const BROWSER_SCRIPT_CLEANUP_BUDGET_MS = 5_000;
export const BROWSER_SCRIPT_MAX_CODE_BYTES = 200 * 1024;
export function browserScriptTimeoutMs(input: Record<string, unknown>): number {
  const requested = asNumber(input.timeout, BROWSER_SCRIPT_DEFAULT_TIMEOUT_MS);
  return Math.max(1_000, Math.min(BROWSER_SCRIPT_MAX_TIMEOUT_MS, Math.floor(requested)));
}

export function browserScriptActionDeadlineMs(input: Record<string, unknown>): number {
  return browserScriptTimeoutMs(input) + BROWSER_SCRIPT_CLEANUP_BUDGET_MS;
}

const SHIFT_MODIFIER = 8;
const MAX_SCRIPT_CALLS = 20_000;
const MAX_SCREENSHOTS = 4;
const MAX_FAILURE_SCREENSHOTS = 1;
const MAX_RETURN_BYTES = 16 * 1024;
const MAX_EVALUATE_RESULT_BYTES = 256 * 1024;
const MAX_EVALUATE_SOURCE_BYTES = 64 * 1024;
const MAX_EVALUATE_RECORDS = 50;
const MAX_HELD_KEYS = 16;
/** Bridge operations behind the script's keyboard.* and mouse.* APIs. */
const SCRIPT_INPUT_OPERATIONS: Readonly<Record<string, true>> = {
  key: true,
  type: true,
  insertText: true,
  mouseMove: true,
  mouseDown: true,
  mouseUp: true,
  wheel: true,
};
const MAX_TYPE_CHARS = 2_000;
const MAX_CONSOLE_ENTRIES = 100;
const MAX_ERROR_STACK_LINES = 8;
const EVALUATE_TIMEOUT_MS = 10_000;
const RELEASE_BUDGET_MS = 2_000;
/** Ends interception after a stalled call; with the stall wait and the input release it fits the cleanup budget. */
const FORCED_FETCH_DISABLE_MS = 1_000;
const MAX_ERROR_CHARS = 2_000;
const MAX_LISTED_REQUESTS = 20;

/**
 * The page side of one page.evaluate / waitForFunction poll. `make` is the
 * model's code as a thunk built at the top of the expression, so it sees only
 * page globals. In the same evaluation: the page must be a web page and still
 * on the origin its effect window opened for (`request.origin`, whose site
 * request blocking is keyed on), else nothing of the model's runs; then the
 * effect counters run around the call, and a poll is bounded by its
 * remaining time.
 */
const RUN_SCRIPT_PAGE_FUNCTION = `async (make, request) => {
  const pageOrigin = location.origin === 'null' ? location.protocol : location.origin;
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return { unsupportedPage: pageOrigin };
  if (pageOrigin !== request.origin) return { moved: pageOrigin };
  const done = ${PAGE_SCRIPT_EFFECT_COUNTER};
  try {
    const pending = Promise.resolve().then(make);
    if (request.timeoutMs > 0) {
      const expired = {};
      let timer;
      const value = await Promise.race([pending, new Promise((resolve) => { timer = setTimeout(() => resolve(expired), request.timeoutMs); })]);
      clearTimeout(timer);
      return done(value === expired ? { timedOut: true } : { value });
    }
    return done({ value: await pending });
  } catch (error) {
    return done({ thrown: String((error && (error.stack || error.message)) || error).slice(0, ${MAX_ERROR_CHARS}) });
  }
}`;

export interface BrowserScriptScreenshot {
  readonly label: string;
  /** Base64 image payload captured through the provider screenshot path. */
  readonly data: string;
  readonly format: 'png' | 'jpeg';
  readonly width?: number;
  readonly height?: number;
  readonly reason: 'script' | 'failure';
}

export interface BrowserScriptCallSite {
  readonly line: number;
  readonly column: number;
}

export interface BrowserScriptResult {
  readonly success: boolean;
  readonly code?: string;
  readonly durationMs: number;
  readonly filename: string;
  readonly value?: unknown;
  readonly valueTruncated?: boolean;
  readonly logs: readonly { readonly level: string; readonly text: string }[];
  readonly logsTruncated?: { readonly omittedEntries: number };
  readonly error?: {
    readonly name: string;
    readonly message: string;
    readonly code?: string;
    readonly location?: BrowserScriptCallSite;
    readonly stack?: readonly string[];
  };
  readonly pageEvaluate: {
    readonly calls: number;
    readonly sites: readonly (BrowserScriptCallSite & {
      readonly api: 'evaluate' | 'waitForFunction';
      readonly calls: number;
    })[];
    readonly sitesTruncated?: boolean;
    /**
     * page.evaluate calls that did not finish before the script ended. An
     * async function among them may still run in the page afterwards.
     */
    readonly interrupted?: number;
  };
  readonly input: {
    readonly keyEvents: number;
    readonly mouseEvents: number;
    /** Keys and mouse buttons still held when the script ended and released by the runtime. */
    readonly autoReleased: readonly string[];
  };
  /**
   * keyboard.* / mouse.* bridge calls the script made, including calls that
   * were refused and `keyboard.insertText` (which dispatches no key event).
   * Runtime metrics read it to tell read-only scripts apart; the Browser tool
   * does not show it to the model.
   */
  readonly inputApiCalls: number;
  readonly pageErrors: readonly { readonly level: string; readonly message: string }[];
  readonly screenshots: readonly BrowserScriptScreenshot[];
  readonly screenshotsSkipped?: number;
  readonly recovery?: string;
  /**
   * What the page JavaScript the script ran (page.evaluate, waitForFunction)
   * did while it ran. Absent when it ran none. The code is the action's own
   * input, so the record does not repeat it.
   */
  readonly pageScript?: BrowserScriptPageScriptAudit;
}

/**
 * The audit record of a run_script's page JavaScript: the effects of every
 * window in which page JavaScript ran, added up (program evaluate ops report
 * the same effects per op, with their source).
 */
export interface BrowserScriptPageScriptAudit extends Omit<ProgramPageScriptEffects, 'origin'> {
  /** Origins of the pages page JavaScript ran on, first use first. */
  readonly origins: readonly string[];
  /** page.evaluate calls and waitForFunction polls that reached the page. */
  readonly calls: number;
}

export interface BrowserScriptRunOptions {
  readonly code: string;
  readonly filename: string;
  readonly timeoutMs: number;
  /** Provider screenshot path, already bound to the action command budget. */
  readonly captureScreenshot: (input: Record<string, unknown>) => Promise<unknown>;
  readonly signal: AbortSignal;
  /** Page JavaScript sent a non-GET request, submitted a form or navigated on the page at `url`. */
  readonly recordPageScriptWrite: (url: string) => void;
}

interface HeldKey {
  readonly descriptor: BrowserKeyDescriptor;
  readonly modifier: number;
}

interface OpenedPageWindow {
  readonly window: PageScriptEffectWindow;
  readonly url: string;
  readonly origin: string;
}

interface OpenPageWindow {
  readonly opened: Promise<OpenedPageWindow>;
  /** Set once `opened` settles with a window. */
  window?: PageScriptEffectWindow;
  /** Settles when the window has ended (`end`). */
  readonly ended: Promise<void>;
  readonly end: () => void;
  mutations: number;
  submits: number;
}

/**
 * The effect windows (program/page-evaluate.ts) of one run_script's page
 * JavaScript. One window is open while any page.evaluate call runs:
 * concurrent calls share its Fetch interception (enabling and disabling it
 * per call would leave one call unprotected when another one ends), and
 * their effects are measured together. Input the script sends while a window
 * is open falls inside it: its requests to another site are failed too.
 * Once the main frame commits a new document the window stops intercepting
 * (the calls in it ran in the old document): a call that comes then waits for
 * it to end and opens its own, on the new page's origin and site.
 */
class RunScriptPageWindows {
  private current: OpenPageWindow | undefined;
  private users = 0;
  private closing: Promise<void> = Promise.resolve();
  private readonly origins = new Set<string>();
  private readonly requests: ProgramPageScriptRequest[] = [];
  private totals = {
    durationMs: 0,
    mutations: 0,
    submits: 0,
    requestCount: 0,
    nonGetRequests: 0,
    blockedRequests: 0,
    writeLike: false,
  };
  private navigation: Readonly<Record<string, unknown>> | undefined;
  /** page.evaluate calls and waitForFunction polls that reached the page. */
  calls = 0;

  constructor(
    private readonly session: BrowserSessionState,
    private readonly readUrl: () => Promise<string>,
    private readonly recordWrite: (url: string) => void,
  ) {}

  /**
   * Joins the open window or opens one, and returns the origin it is open
   * for. Throws, with nothing of the model's run, when the page is not a web
   * page or does not allow request interception.
   */
  async enter(): Promise<string> {
    // A window that is closing ends (Fetch.disable) before the next one starts.
    for (;;) {
      const closing = this.closing;
      await closing;
      if (closing !== this.closing) continue;
      const current = this.current;
      if (!current?.window?.released) break;
      await current.ended;
    }
    this.users += 1;
    if (!this.current) {
      let end = (): void => undefined;
      const ended = new Promise<void>((resolve) => {
        end = resolve;
      });
      const current: OpenPageWindow = {
        opened: this.readUrl().then((url) => this.open(url, pageScriptOrigin(url))),
        ended,
        end,
        mutations: 0,
        submits: 0,
      };
      current.opened.then(
        (opened) => {
          current.window = opened.window;
        },
        () => undefined,
      );
      this.current = current;
    }
    try {
      return (await this.current.opened).origin;
    } catch (error) {
      await this.leave({ mutations: 0, submits: 0 });
      throw error;
    }
  }

  /** Leaves the window with this call's page-side counts; the last caller closes it. */
  async leave(counts: { readonly mutations: number; readonly submits: number }): Promise<void> {
    const current = this.current;
    // The window was ended by `finish` while this call was stuck in it.
    if (!current) return;
    current.mutations += counts.mutations;
    current.submits += counts.submits;
    this.users -= 1;
    if (this.users > 0) return;
    this.current = undefined;
    const closing = this.close(current).finally(current.end);
    this.closing = closing;
    await closing;
  }

  /**
   * After the script settled and its calls got their time to end: a call still
   * in the window never came back, and interception must not outlive the
   * action, so the window ends here on a short budget (its listeners too); the
   * call's late return finds no window. Returns the added-up effects
   * (undefined when no page JavaScript ran).
   */
  async finish(): Promise<BrowserScriptPageScriptAudit | undefined> {
    const stuck = this.users > 0 ? this.current : undefined;
    if (stuck) {
      this.current = undefined;
      this.users = 0;
      try {
        const opened = await withTimeout(
          stuck.opened,
          FORCED_FETCH_DISABLE_MS,
          'the page JavaScript window',
        ).catch(() => undefined);
        if (opened) {
          this.add(
            opened,
            await opened.window.abandon(opened.origin, stuck, FORCED_FETCH_DISABLE_MS),
          );
        } else {
          await withTimeout(
            this.session.transport.send('Fetch.disable', {}, undefined, {
              timeoutMs: FORCED_FETCH_DISABLE_MS,
            }),
            FORCED_FETCH_DISABLE_MS,
            'Fetch.disable',
          ).catch(() => undefined);
        }
      } finally {
        stuck.end();
      }
    }
    if (this.origins.size === 0 && this.calls === 0) return undefined;
    return {
      origins: [...this.origins],
      ...this.totals,
      requests: this.requests,
      ...(this.navigation ? { navigation: this.navigation } : {}),
      calls: this.calls,
    };
  }

  private async open(url: string, origin: string): Promise<OpenedPageWindow> {
    if (!isPageScriptWebPage(url)) {
      throw new BrowserScriptOperationError(
        'PAGE_SCRIPT_UNSUPPORTED_PAGE',
        pageScriptUnsupportedPageMessage(origin),
      );
    }
    const window = await PageScriptEffectWindow.start(this.session, url);
    try {
      await window.intercept();
    } catch (error) {
      await window.finish(origin, { mutations: 0, submits: 0 });
      if (!(error instanceof BrowserProgramError)) throw error;
      // Without interception the call cannot run: nothing would stop a cross-site request.
      throw new BrowserScriptOperationError(error.code, error.message.replace(/^[A-Z_]+: /u, ''));
    }
    return { window, url, origin };
  }

  private async close(current: OpenPageWindow): Promise<void> {
    let opened: OpenedPageWindow;
    try {
      opened = await current.opened;
    } catch {
      return; // Refused before it opened (or the failed open already ended it).
    }
    this.add(
      opened,
      await opened.window.finish(opened.origin, {
        mutations: current.mutations,
        submits: current.submits,
      }),
    );
  }

  /** Adds one window's effects to the run's; a write-like window is recorded. */
  private add(opened: OpenedPageWindow, effects: ProgramPageScriptEffects): void {
    if (effects.writeLike) this.recordWrite(opened.url);
    this.origins.add(opened.origin);
    const totals = this.totals;
    totals.durationMs += effects.durationMs;
    totals.mutations += effects.mutations;
    totals.submits += effects.submits;
    totals.requestCount += effects.requestCount;
    totals.nonGetRequests += effects.nonGetRequests;
    totals.blockedRequests += effects.blockedRequests;
    totals.writeLike ||= effects.writeLike;
    this.requests.push(...effects.requests.slice(0, MAX_LISTED_REQUESTS - this.requests.length));
    this.navigation ??= effects.navigation;
  }
}

/**
 * One `run_script` execution bound to a Browser Core session.
 *
 * Owns held-input state so every exit path (success, script error, timeout,
 * cancellation, worker crash) releases keys and buttons through the same
 * CDP session that pressed them.
 */
export class BrowserScriptRun {
  private readonly heldKeys = new Map<string, HeldKey>();
  private readonly heldButtons = new Set<string>();
  private modifiers = 0;
  /**
   * Pointer position this script has set. The real pointer position is not
   * known at script start (single-step actions and earlier scripts move it),
   * so positionless operations (mouse.down/up/wheel) require an explicit
   * mouse.move or mouse.click first instead of silently acting at (0, 0).
   */
  private pointer: { x: number; y: number } | undefined;
  private keyEvents = 0;
  private mouseEvents = 0;
  private inputApiCalls = 0;
  private readonly logs: { level: string; text: string }[] = [];
  private omittedLogs = 0;
  private evaluateCalls = 0;
  private readonly evaluateSites = new Map<
    string,
    { api: 'evaluate' | 'waitForFunction'; line: number; column: number; calls: number }
  >();
  private evaluateSitesTruncated = false;
  /**
   * page.evaluate calls whose result never came back (timeout, cancellation,
   * script settled). Runtime.terminateExecution stops running JavaScript but
   * cannot cancel an async function waiting on a promise or timer, so such a
   * call may still continue in the page after the tool returns.
   */
  private interruptedEvaluations = 0;
  private readonly screenshots: BrowserScriptScreenshot[] = [];
  private screenshotsSkipped = 0;
  /** Script screenshot slots reserved, including captures still in flight. */
  private scriptScreenshotSlots = 0;
  private consoleBaseline = 0;
  /** Aborted when the action is cancelled or the script settles. */
  private readonly operations = new AbortController();
  /** Tail of the serialized input chain; see serializeInput. */
  private inputQueue: Promise<void> = Promise.resolve();
  /** First CDP timeout/transport-closed error seen while the script ran. */
  private transportInterruption: unknown;
  /** Fetch interception and effect measurement around page JavaScript. */
  private readonly pageWindows: RunScriptPageWindows;

  constructor(
    private readonly session: BrowserSessionState,
    private readonly options: BrowserScriptRunOptions,
  ) {
    const forward = (): void => this.operations.abort();
    if (options.signal.aborted) forward();
    else options.signal.addEventListener('abort', forward, { once: true });
    this.pageWindows = new RunScriptPageWindows(
      session,
      async () => {
        const payload = await this.send<{ result?: { value?: unknown } }>(
          'Runtime.evaluate',
          { expression: 'location.href', returnByValue: true },
          EVALUATE_TIMEOUT_MS,
        );
        return asString(payload.result?.value);
      },
      options.recordPageScriptWrite,
    );
  }

  private get operationSignal(): AbortSignal {
    return this.operations.signal;
  }

  /**
   * Run input operations one at a time, in the order the script issued them.
   * Bridge calls arrive concurrently (for example under Promise.all), but a
   * keyboard and mouse are sequential devices: interleaving would let a
   * keyUp's bookkeeping erase a concurrent keyDown, or mix modifier state
   * between events. Non-input operations (evaluate, screenshot, sleep) stay
   * concurrent.
   */
  private serializeInput<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.inputQueue.then(operation);
    this.inputQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Page commands issued by the script. Input goes to the root page session
   * (CDP routes it by viewport); everything else follows the current frame.
   *
   * `clampToCommand` keeps ordinary operations inside the per-command budget.
   * A waitForFunction poll opts out: its deadline is the caller's condition
   * timeout, still bounded by the script deadline through operationSignal.
   */
  private send<T = unknown>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = this.session.commandTimeoutMs,
    clampToCommand = true,
  ): Promise<T> {
    const effectiveTimeout =
      timeoutMs !== undefined && clampToCommand
        ? Math.min(timeoutMs, this.session.commandTimeoutMs ?? timeoutMs)
        : timeoutMs;
    return this.session.transport.send<T>(
      method,
      params,
      method.startsWith('Input.') ? undefined : this.session.commandSessionId,
      {
        signal: this.operationSignal,
        ...(effectiveTimeout !== undefined ? { timeoutMs: effectiveTimeout } : {}),
      },
    );
  }

  async run(): Promise<BrowserScriptResult> {
    const startedAt = Date.now();
    this.consoleBaseline = await this.readConsoleSequence();
    const outcome = await runBrowserScriptWorker({
      code: this.options.code,
      filename: this.options.filename,
      timeoutMs: this.options.timeoutMs,
      maxCalls: MAX_SCRIPT_CALLS,
      signal: this.options.signal,
      handle: (op, args) => this.handleTracked(op, isRecord(args) ? args : {}),
      onLog: (level, text) => this.appendLog(level, text),
      onOmittedLogs: (count) => {
        this.omittedLogs += count;
      },
      // A settled script must not keep sleeping or waiting on the page while
      // the runtime releases input; in-flight operations abort here.
      onSettle: () => this.operations.abort(),
      // Nothing answered these commands, so what they did is unknown: Browser
      // Core must reset the connection like after any interrupted command.
      onStalled: (count) => {
        this.transportInterruption ??= Object.assign(
          new Error(
            `BROWSER_OPERATION_TIMEOUT: ${count} browser operation(s) of run_script did not finish after the script ended`,
          ),
          { code: 'BROWSER_OPERATION_TIMEOUT' },
        );
      },
    });
    // Before anything below can throw: interception ends and a page write is
    // recorded on every exit path.
    const pageScript = await this.pageWindows.finish();
    const released = await this.releaseHeldInput();
    if (released.failed) {
      // Input may still be held in the page. Report it as an interrupted
      // operation so Browser Core resets the connection, or poisons the
      // session for recreation when the reset fails, instead of reusing it.
      throw this.withInterruptedEvaluations(
        Object.assign(
          new Error(
            `BROWSER_OPERATION_TIMEOUT: run_script could not release held input (${released.released.join(', ')})`,
          ),
          { code: 'BROWSER_OPERATION_TIMEOUT' },
        ),
      );
    }
    if (outcome.status === 'aborted') {
      // Cancellation must stay a cancellation: Browser Core resets the
      // connection and the caller reports the interruption.
      throw this.withInterruptedEvaluations(
        Object.assign(new Error('ABORTED: Browser script was cancelled'), { code: 'ABORTED' }),
      );
    }
    if (this.transportInterruption) {
      // A CDP command timed out or the transport closed while the script was
      // running. Its side effect is uncertain whatever the script did with the
      // error, so Browser Core must reset (or poison) before the next action.
      throw this.withInterruptedEvaluations(this.transportInterruption);
    }
    if (outcome.status === 'failed' || outcome.status === 'crashed') {
      await this.captureFailureScreenshot();
    }
    const pageErrors = await this.readPageErrors();
    return this.buildResult(
      outcome,
      released.released,
      pageErrors,
      Date.now() - startedAt,
      pageScript,
    );
  }

  /**
   * Interruptions end the action with an error instead of a result. A page
   * function left running can still change the page, so the warning that a
   * normal result carries in `recovery` is appended to the error message,
   * which is what reaches the model in the tool error.
   */
  private withInterruptedEvaluations(error: unknown): unknown {
    if (this.interruptedEvaluations === 0 || !(error instanceof Error)) return error;
    error.message = `${error.message}. ${this.interruptedEvaluations} page.evaluate call(s) did not finish and may still change the page; reload or re-inspect it before relying on its state.`;
    return error;
  }

  /**
   * Record the first transport interruption a bridge operation hits while the
   * script is still running. Interruptions after settlement are the runtime's
   * own aborts of in-flight work and do not count.
   */
  private async handleTracked(op: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      return await this.handle(op, args);
    } catch (error) {
      if (
        !this.operationSignal.aborted &&
        !this.transportInterruption &&
        isBrowserOperationInterruption(error)
      ) {
        this.transportInterruption = error;
      }
      throw error;
    }
  }

  private async handle(op: string, args: Record<string, unknown>): Promise<unknown> {
    if (SCRIPT_INPUT_OPERATIONS[op] === true) this.inputApiCalls += 1;
    switch (op) {
      case 'sleep':
        // The script deadline bounds every wait; no per-call cap that would
        // silently shorten a timed hold.
        await delay(Math.max(0, asNumber(args.ms)), this.operationSignal);
        return undefined;
      case 'key':
        return this.serializeInput(() => this.key(asString(args.type), asString(args.key)));
      case 'type':
        return this.serializeInput(() =>
          this.type(asString(args.text), Math.max(0, asNumber(args.delay))),
        );
      case 'insertText':
        return this.serializeInput(async () => {
          await this.send('Input.insertText', { text: limitedText(asString(args.text)) });
        });
      case 'mouseMove':
        return this.serializeInput(() =>
          this.mouseMove(asNumber(args.x), asNumber(args.y), asNumber(args.steps, 1)),
        );
      case 'mouseDown':
        return this.serializeInput(() =>
          this.mouseButton('mousePressed', buttonName(args.button), asNumber(args.clickCount, 1)),
        );
      case 'mouseUp':
        return this.serializeInput(() =>
          this.mouseButton('mouseReleased', buttonName(args.button), asNumber(args.clickCount, 1)),
        );
      case 'wheel':
        return this.serializeInput(async () => {
          await this.dispatchMouse('mouseWheel', {
            deltaX: asNumber(args.deltaX),
            deltaY: asNumber(args.deltaY),
          });
        });
      case 'evaluate':
        return this.evaluate(args);
      case 'screenshot':
        return this.screenshot(args);
      case 'consoleMessages':
        return this.consoleMessages(args);
      case 'pageInfo':
        return this.pageInfo();
      default:
        throw new BrowserScriptOperationError('UNSUPPORTED_OPERATION', `Unknown operation: ${op}`);
    }
  }

  /**
   * Stop page JavaScript the script started (see stopPageExecution). If the
   * page does not respond afterwards it may still be stuck: mark it so Browser
   * Core re-checks after reconnecting, and record an interruption regardless
   * of the aborted signal so the action cannot return a normal result.
   */
  private async terminatePageExecution(): Promise<void> {
    if (await stopPageExecution(this.session)) return;
    this.session.pageUnresponsive = true;
    this.transportInterruption ??= Object.assign(
      new Error(
        'BROWSER_OPERATION_TIMEOUT: page JavaScript started by run_script could not be stopped',
      ),
      { code: 'BROWSER_OPERATION_TIMEOUT' },
    );
  }

  private async key(type: string, key: string): Promise<void> {
    if (!key)
      throw new BrowserScriptOperationError('INVALID_KEY', 'Key must be a non-empty string');
    const descriptor = scriptKeyDescriptor(key);
    if (type === 'down') {
      if (!this.heldKeys.has(descriptor.code) && this.heldKeys.size >= MAX_HELD_KEYS) {
        throw new BrowserScriptOperationError(
          'TOO_MANY_HELD_KEYS',
          `At most ${MAX_HELD_KEYS} keys can be held at once`,
        );
      }
      const modifier = modifierBit(descriptor.key);
      const autoRepeat = this.heldKeys.has(descriptor.code);
      this.heldKeys.set(descriptor.code, { descriptor, modifier });
      this.modifiers |= modifier;
      await this.dispatchKey('keyDown', descriptor, autoRepeat);
      return;
    }
    const held = this.heldKeys.get(descriptor.code);
    if (held?.modifier) this.modifiers &= ~held.modifier;
    await this.dispatchKey('keyUp', held?.descriptor ?? descriptor, false);
    // Forget the key only once its keyUp reached the page; an aborted
    // dispatch leaves it for releaseHeldInput.
    this.heldKeys.delete(descriptor.code);
  }

  private async dispatchKey(
    type: 'keyDown' | 'keyUp',
    descriptor: BrowserKeyDescriptor,
    autoRepeat: boolean,
  ): Promise<void> {
    this.keyEvents += 1;
    await this.send('Input.dispatchKeyEvent', this.keyEventParams(type, descriptor, autoRepeat));
  }

  /**
   * Key event as a physical US keyboard reports it under the current
   * modifiers: Shift selects the key's shifted character (D, !, ?), and
   * Ctrl/Alt/Meta shortcuts insert no text. Script input and automatic release
   * share this so a page that tracks `event.key` sees matching pairs.
   */
  private keyEventParams(
    type: 'keyDown' | 'keyUp',
    descriptor: BrowserKeyDescriptor,
    autoRepeat: boolean,
  ): Record<string, unknown> {
    const shiftedKey =
      (this.modifiers & SHIFT_MODIFIER) !== 0 && descriptor.text !== undefined
        ? browserShiftedKey(descriptor.code)
        : undefined;
    const key = shiftedKey ?? descriptor.key;
    const text =
      type === 'keyDown' &&
      descriptor.text !== undefined &&
      (this.modifiers & ~SHIFT_MODIFIER) === 0
        ? (shiftedKey ?? descriptor.text)
        : undefined;
    return {
      type,
      key,
      code: descriptor.code,
      modifiers: this.modifiers,
      ...(descriptor.windowsVirtualKeyCode === undefined
        ? {}
        : { windowsVirtualKeyCode: descriptor.windowsVirtualKeyCode }),
      ...(text === undefined ? {} : { text, unmodifiedText: descriptor.text }),
      ...(autoRepeat ? { autoRepeat: true } : {}),
    };
  }

  private async type(text: string, delayMs: number): Promise<void> {
    // Same rule as the virtual-editor typing path: characters with a physical
    // US-layout key are typed as key events; everything else (CJK, emoji,
    // control characters) is inserted with Input.insertText, which is how
    // Chrome receives IME-committed text.
    const strokes = Array.from(limitedText(text)).map((char) => typedStroke(char));
    // Typing a key the script is holding would send a keyUp and end the hold
    // early while the runtime still records it as down. Reject the call up
    // front so the page and the held-key record cannot diverge.
    const conflict = strokes
      .flatMap((stroke) => (stroke.key ? [stroke.key.code] : []))
      .find((code) => this.heldKeys.has(code));
    if (conflict) {
      throw new BrowserScriptOperationError(
        'KEY_ALREADY_HELD',
        `keyboard.type would release held key ${conflict}; call keyboard.up('${conflict}') first`,
      );
    }
    for (const stroke of strokes) {
      if (stroke.key) {
        // Track each typed key like a held key so cancellation between
        // keyDown and keyUp still releases it.
        this.heldKeys.set(stroke.key.code, { descriptor: stroke.key, modifier: 0 });
        await this.dispatchKey('keyDown', stroke.key, false);
        await this.dispatchKey('keyUp', stroke.key, false);
        this.heldKeys.delete(stroke.key.code);
      } else {
        await this.send('Input.insertText', { text: stroke.text });
      }
      if (delayMs > 0) await delay(delayMs, this.operationSignal);
    }
  }

  private async mouseMove(x: number, y: number, steps: number): Promise<void> {
    // Present the destination once; interpolation must not wait for an animation per step.
    await this.session.beforePointerAction?.(
      { action: 'run_script', point: { x, y } },
      this.operationSignal,
    );
    // Without a known start the first move jumps straight to the target.
    const from = this.pointer ?? { x, y };
    const count = this.pointer ? Math.max(1, Math.min(100, Math.floor(steps))) : 1;
    for (let step = 1; step <= count; step += 1) {
      this.pointer = {
        x: from.x + ((x - from.x) * step) / count,
        y: from.y + ((y - from.y) * step) / count,
      };
      await this.dispatchMouse('mouseMoved', {});
    }
  }

  private async mouseButton(
    type: 'mousePressed' | 'mouseReleased',
    button: string,
    clickCount: number,
  ): Promise<void> {
    // Reject before recording the press: a refused mouse.down must leave no
    // held state behind (no later release at (0, 0), no stray button mask).
    this.requirePointer();
    if (type === 'mousePressed') this.heldButtons.add(button);
    await this.dispatchMouse(type, {
      button,
      clickCount: Math.max(1, Math.floor(clickCount)),
      // The release event reports the buttons still down after it.
      ...(type === 'mouseReleased' ? { buttons: heldButtonMask(this.heldButtons, button) } : {}),
    });
    if (type === 'mouseReleased') this.heldButtons.delete(button);
  }

  private requirePointer(): { x: number; y: number } {
    if (!this.pointer) {
      throw new BrowserScriptOperationError(
        'POINTER_POSITION_UNKNOWN',
        'Call page.mouse.move(x, y) or page.mouse.click(x, y) before mouse.down/up/wheel; the pointer position is not carried between actions',
      );
    }
    return this.pointer;
  }

  private async dispatchMouse(type: string, extra: Record<string, unknown>): Promise<void> {
    const pointer = this.requirePointer();
    this.mouseEvents += 1;
    await this.send('Input.dispatchMouseEvent', {
      type,
      ...inputCoordinate(this.session, pointer),
      modifiers: this.modifiers,
      buttons: heldButtonMask(this.heldButtons),
      ...extra,
    });
  }

  private async evaluate(args: Record<string, unknown>): Promise<unknown> {
    const source = asString(args.source);
    if (Buffer.byteLength(source, 'utf8') > MAX_EVALUATE_SOURCE_BYTES) {
      throw new BrowserScriptOperationError(
        'EVALUATE_SOURCE_TOO_LARGE',
        `page.evaluate source exceeds ${MAX_EVALUATE_SOURCE_BYTES} bytes`,
      );
    }
    if (args.record === true) this.recordEvaluate(args);
    // The source is inserted into the page wrapper: it must be one
    // expression, or text closing the wrapper could run before the checks.
    try {
      assertPageScriptExpression(source, 'page.evaluate');
    } catch (error) {
      throw new BrowserScriptOperationError(
        'PAGE_EVALUATE_FAILED',
        firstLine(error instanceof Error ? error.message.replace(/^INVALID_OP: /u, '') : ''),
      );
    }
    const argJson = JSON.stringify(args.arg ?? null);
    const make =
      args.isFunction === true ? `() => (${source}\n)(${argJson})` : `() => (${source}\n)`;
    // waitForFunction bounds each poll to its remaining time inside the page:
    // a condition promise that settles too late reports a timeout instead of
    // counting as success. A synchronous loop still hits the transport
    // deadline below and is terminated.
    const pageTimeoutMs = asNumber(args.pageTimeoutMs, 0);
    // Requests to another site fail while page JavaScript runs; without
    // interception the call does not run.
    const origin = await this.pageWindows.enter();
    const request = {
      origin,
      timeoutMs: pageTimeoutMs > 0 ? Math.ceil(pageTimeoutMs) : 0,
    };
    // The page and origin checks run in the same evaluation as the call, so a
    // navigation in between cannot move the call to a page of another site
    // than the one requests are checked against.
    const expression = `(${RUN_SCRIPT_PAGE_FUNCTION})(${make}, ${JSON.stringify(request)})`;
    let answer: Record<string, unknown> = {};
    try {
      let payload: {
        result?: { value?: unknown };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };
      try {
        payload = await this.send(
          'Runtime.evaluate',
          { expression, awaitPromise: true, returnByValue: true, userGesture: true },
          // A waitForFunction poll is bounded inside the page by its remaining
          // condition budget; the transport deadline only needs to outlast that
          // plus a response margin. The script deadline still cancels it.
          pageTimeoutMs > 0 ? Math.ceil(pageTimeoutMs) + RELEASE_BUDGET_MS : EVALUATE_TIMEOUT_MS,
          pageTimeoutMs <= 0,
        );
      } catch (error) {
        // The page may still be running this code (for example a sync loop):
        // a transport deadline or the settled script's abort does not stop it.
        // Stop it explicitly so the tab stays usable for the rest of the script
        // and later actions. An async continuation (await on a timer or
        // promise) cannot be cancelled this way; record it so the result says
        // so. Not when the action itself was ended (a JavaScript dialog
        // interrupted it, or it was cancelled): the page may be paused on the
        // dialog, and the termination would kill the page code that runs once
        // the dialog is answered. Browser Core recovers the page then, as for
        // a program.
        this.interruptedEvaluations += 1;
        if (!this.options.signal.aborted) await this.terminatePageExecution();
        throw error;
      }
      if (payload.exceptionDetails) {
        const description =
          payload.exceptionDetails.exception?.description ?? payload.exceptionDetails.text;
        throw new BrowserScriptOperationError(
          'PAGE_EVALUATE_FAILED',
          firstLine(description ?? 'Page evaluation failed'),
        );
      }
      answer = isRecord(payload.result?.value) ? payload.result.value : {};
    } finally {
      await this.pageWindows.leave({
        mutations: asNumber(answer.mutations),
        submits: asNumber(answer.submits),
      });
    }
    if (typeof answer.unsupportedPage === 'string') {
      throw new BrowserScriptOperationError(
        'PAGE_SCRIPT_UNSUPPORTED_PAGE',
        pageScriptUnsupportedPageMessage(answer.unsupportedPage),
      );
    }
    if (typeof answer.moved === 'string') {
      throw new BrowserScriptOperationError(
        'PAGE_EVALUATE_FAILED',
        `The page moved from ${origin} to ${answer.moved} as page.evaluate started; the function did not run. Wait for the page to load and call it again.`,
      );
    }
    this.pageWindows.calls += 1;
    if (typeof answer.thrown === 'string') {
      throw new BrowserScriptOperationError('PAGE_EVALUATE_FAILED', firstLine(answer.thrown));
    }
    // A waitForFunction poll that hit its page-side deadline leaves the
    // condition function running in the page; it can still change the page.
    if (pageTimeoutMs > 0 && answer.timedOut === true) {
      this.interruptedEvaluations += 1;
      return { timedOut: true };
    }
    const value = pageTimeoutMs > 0 ? { value: answer.value } : answer.value;
    const bytes = Buffer.byteLength(JSON.stringify(value ?? null), 'utf8');
    if (bytes > MAX_EVALUATE_RESULT_BYTES) {
      throw new BrowserScriptOperationError(
        'EVALUATE_RESULT_TOO_LARGE',
        `page.evaluate returned ${bytes} bytes; the limit is ${MAX_EVALUATE_RESULT_BYTES}`,
      );
    }
    return value;
  }

  private recordEvaluate(args: Record<string, unknown>): void {
    this.evaluateCalls += 1;
    const site = isRecord(args.site) ? args.site : undefined;
    const api = args.api === 'waitForFunction' ? 'waitForFunction' : 'evaluate';
    const line = Math.max(0, Math.floor(asNumber(site?.line)));
    const column = Math.max(0, Math.floor(asNumber(site?.column)));
    const key = `${api}:${line}:${column}`;
    const existing = this.evaluateSites.get(key);
    if (existing) {
      existing.calls += 1;
    } else if (this.evaluateSites.size < MAX_EVALUATE_RECORDS) {
      this.evaluateSites.set(key, { api, line, column, calls: 1 });
    } else {
      this.evaluateSitesTruncated = true;
    }
  }

  private async screenshot(args: Record<string, unknown>): Promise<unknown> {
    const index = this.screenshots.length + this.screenshotsSkipped + 1;
    const label = asString(args.label).slice(0, 80) || `screenshot-${index}`;
    // Reserve the slot before the first await: bridge calls run concurrently,
    // so counting completed captures would let Promise.all exceed the limit.
    if (this.scriptScreenshotSlots >= MAX_SCREENSHOTS) {
      this.screenshotsSkipped += 1;
      return {
        captured: false,
        label,
        reason: `At most ${MAX_SCREENSHOTS} screenshots per script`,
      };
    }
    this.scriptScreenshotSlots += 1;
    const clip = isRecord(args.clip) ? args.clip : undefined;
    let shot: BrowserScriptScreenshot;
    try {
      shot = await this.capture(label, 'script', clip);
    } catch (error) {
      this.scriptScreenshotSlots -= 1;
      throw error;
    }
    return {
      captured: true,
      label,
      ...(shot.width !== undefined ? { width: shot.width } : {}),
      ...(shot.height !== undefined ? { height: shot.height } : {}),
    };
  }

  private async capture(
    label: string,
    reason: BrowserScriptScreenshot['reason'],
    clip?: Record<string, unknown>,
  ): Promise<BrowserScriptScreenshot> {
    const raw = await this.options.captureScreenshot(
      clip ? { scope: 'clip', clip } : { scope: 'viewport' },
    );
    const record = isRecord(raw) ? raw : {};
    const data = asString(record.data);
    if (!data) throw new BrowserScriptOperationError('SCREENSHOT_EMPTY', 'Screenshot was empty');
    const shot: BrowserScriptScreenshot = {
      label,
      data,
      format: record.format === 'jpeg' || record.format === 'jpg' ? 'jpeg' : 'png',
      ...(typeof record.width === 'number' ? { width: record.width } : {}),
      ...(typeof record.height === 'number' ? { height: record.height } : {}),
      reason,
    };
    this.screenshots.push(shot);
    return shot;
  }

  private async captureFailureScreenshot(): Promise<void> {
    if (
      this.screenshots.filter((shot) => shot.reason === 'failure').length >= MAX_FAILURE_SCREENSHOTS
    ) {
      return;
    }
    await this.capture('failure', 'failure').catch(() => undefined);
  }

  private async consoleMessages(args: Record<string, unknown>): Promise<unknown> {
    const ready = await this.session.cdpHelper.ensureConsoleDiagnosticsReady(this.operationSignal);
    if (!ready) {
      throw new BrowserScriptOperationError(
        'CONSOLE_DIAGNOSTICS_UNAVAILABLE',
        'Console diagnostics are unavailable for the current Browser tab',
      );
    }
    const page = this.session.cdpHelper.getConsoleDiagnostics({
      ...(args.levels !== null && args.levels !== undefined
        ? { levels: stringArray(args.levels) as CDPConsoleDiagnosticLevelFilter[] }
        : {}),
      ...(typeof args.filter === 'string' ? { filter: args.filter } : {}),
      limit: Math.max(1, Math.min(MAX_CONSOLE_ENTRIES, Math.floor(asNumber(args.limit, 50)))),
    });
    return page.entries.map((entry) => ({
      level: entry.level,
      message: entry.message,
      source: entry.source,
      ...(entry.url ? { url: sanitizeConsoleDiagnosticUrl(entry.url) } : {}),
      ...(entry.lineNumber !== undefined ? { lineNumber: entry.lineNumber } : {}),
    }));
  }

  private async pageInfo(): Promise<unknown> {
    const payload = await this.send<{
      result?: { value?: { url?: string; title?: string; width?: number; height?: number } };
    }>(
      'Runtime.evaluate',
      {
        expression:
          '({ url: location.href, title: document.title, width: innerWidth, height: innerHeight })',
        returnByValue: true,
      },
      EVALUATE_TIMEOUT_MS,
    );
    const value = payload.result?.value ?? {};
    return {
      url: sanitizeConsoleDiagnosticUrl(asString(value.url)),
      title: asString(value.title),
      viewport: { width: asNumber(value.width), height: asNumber(value.height) },
    };
  }

  /** Release every held key and button. Runs on all exit paths. */
  private async releaseHeldInput(): Promise<{ released: string[]; failed: boolean }> {
    const released: string[] = [];
    const events: Array<{ method: string; params: Record<string, unknown> }> = [];
    for (const button of [...this.heldButtons]) {
      this.heldButtons.delete(button);
      released.push(`mouse:${button}`);
      events.push({
        method: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseReleased',
          // A held button implies the press set a position; fall back to the
          // origin only to keep the release itself unconditional.
          ...inputCoordinate(this.session, this.pointer ?? { x: 0, y: 0 }),
          button,
          clickCount: 1,
          modifiers: this.modifiers,
          buttons: heldButtonMask(this.heldButtons),
        },
      });
    }
    for (const [code, held] of [...this.heldKeys].reverse()) {
      this.heldKeys.delete(code);
      // Same order as keyboard.up(): a modifier's own bit clears before its
      // keyUp, while other held modifiers still apply (D under Shift is "D").
      if (held.modifier) this.modifiers &= ~held.modifier;
      released.push(held.descriptor.code);
      events.push({
        method: 'Input.dispatchKeyEvent',
        params: this.keyEventParams('keyUp', held.descriptor, false),
      });
    }
    const undelivered = await deliverInputRelease(this.session, events);
    // Whatever did not reach the page stays on the session: Browser Core
    // retries it once the connection is recovered.
    this.session.pendingInputRelease = undelivered.length > 0 ? undelivered : undefined;
    return { released, failed: undelivered.length > 0 };
  }

  private async readConsoleSequence(): Promise<number> {
    const ready = await this.session.cdpHelper
      .ensureConsoleDiagnosticsReady(this.session.commandSignal)
      .catch(() => false);
    if (!ready) return Number.POSITIVE_INFINITY;
    const last = this.session.cdpHelper.getConsoleDiagnostics({ limit: 1 }).entries.at(-1);
    return last?.sequence ?? 0;
  }

  private async readPageErrors(): Promise<{ level: string; message: string }[]> {
    if (!Number.isFinite(this.consoleBaseline)) return [];
    return this.session.cdpHelper
      .getConsoleDiagnostics({ levels: ['error'], limit: 20 })
      .entries.filter((entry) => entry.sequence > this.consoleBaseline)
      .map((entry) => ({ level: entry.level, message: entry.message.slice(0, 500) }));
  }

  /**
   * The worker enforces the entry and byte quota before posting. The count
   * check here only guards against a worker that ignores it.
   */
  private appendLog(level: string, text: string): void {
    if (this.logs.length >= BROWSER_SCRIPT_MAX_LOG_ENTRIES) {
      this.omittedLogs += 1;
      return;
    }
    this.logs.push({ level, text });
  }

  private buildResult(
    outcome: Exclude<BrowserScriptWorkerOutcome, { status: 'aborted' }>,
    autoReleased: readonly string[],
    pageErrors: { level: string; message: string }[],
    durationMs: number,
    pageScript: BrowserScriptPageScriptAudit | undefined,
  ): BrowserScriptResult {
    const base = {
      durationMs,
      filename: this.options.filename,
      logs: this.logs,
      ...(this.omittedLogs > 0 ? { logsTruncated: { omittedEntries: this.omittedLogs } } : {}),
      pageEvaluate: {
        calls: this.evaluateCalls,
        sites: [...this.evaluateSites.values()],
        ...(this.evaluateSitesTruncated ? { sitesTruncated: true } : {}),
        ...(this.interruptedEvaluations > 0 ? { interrupted: this.interruptedEvaluations } : {}),
      },
      input: {
        keyEvents: this.keyEvents,
        mouseEvents: this.mouseEvents,
        autoReleased,
      },
      inputApiCalls: this.inputApiCalls,
      pageErrors,
      screenshots: this.screenshots,
      ...(this.screenshotsSkipped > 0 ? { screenshotsSkipped: this.screenshotsSkipped } : {}),
      ...(pageScript ? { pageScript } : {}),
      // Interrupted page JavaScript can change the page after this returns,
      // whatever the outcome; say so on every result that has any.
      ...(this.interruptedEvaluations > 0
        ? {
            recovery:
              'An interrupted page.evaluate may still finish in the page and change it. Reload or re-inspect the page before relying on its state.',
          }
        : {}),
    };
    if (outcome.status === 'completed') {
      return { success: true, ...base, ...returnValue(outcome.value) };
    }
    if (outcome.status === 'timeout') {
      return {
        success: false,
        code: 'SCRIPT_TIMEOUT',
        ...base,
        error: {
          name: 'TimeoutError',
          message: `Script exceeded ${this.options.timeoutMs}ms`,
        },
        recovery:
          this.interruptedEvaluations > 0
            ? `${base.recovery} Then shorten waits or split the scenario.`
            : 'Shorten waits or split the scenario into several scripts, then retry.',
      };
    }
    if (outcome.status === 'call-limit') {
      return {
        success: false,
        code: 'SCRIPT_CALL_LIMIT',
        ...base,
        error: {
          name: 'Error',
          message: `Script exceeded ${MAX_SCRIPT_CALLS} browser operations`,
        },
      };
    }
    const error = scriptError(outcome.error, this.options.filename);
    return {
      success: false,
      code:
        outcome.status === 'crashed'
          ? 'SCRIPT_WORKER_CRASHED'
          : outcome.phase === 'compile'
            ? 'SCRIPT_SYNTAX_ERROR'
            : error.name === 'AssertionError'
              ? 'SCRIPT_ASSERTION_FAILED'
              : 'SCRIPT_ERROR',
      ...base,
      error,
    };
  }
}

/**
 * Stop JavaScript running in the page. `Runtime.terminateExecution`
 * interrupts a busy main thread (sync loops included) and leaves the page
 * usable. CDP applies it to the current *or next* execution, so a probe
 * evaluation follows; it also consumes a pending termination when the page
 * was already idle, which would otherwise kill the next unrelated
 * evaluation. Returns whether the probe came back, i.e. the page responds.
 * Uses its own short deadline: callers usually hold an aborted signal.
 */
export async function stopPageExecution(session: BrowserSessionState): Promise<boolean> {
  const options = { timeoutMs: RELEASE_BUDGET_MS };
  const sessionId = session.commandSessionId;
  await session.transport
    .send('Runtime.terminateExecution', {}, sessionId, options)
    .catch(() => undefined);
  try {
    await session.transport.send(
      'Runtime.evaluate',
      { expression: '0', returnByValue: true },
      sessionId,
      options,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Send release events in order on a fresh bounded budget, independent of any
 * aborted script signal. Returns the events that did not reach the page, in
 * order, so a caller can retry them after the connection is recovered.
 */
export async function deliverInputRelease(
  session: BrowserSessionState,
  events: ReadonlyArray<{ method: string; params: Record<string, unknown> }>,
): Promise<Array<{ method: string; params: Record<string, unknown> }>> {
  const deadline = Date.now() + RELEASE_BUDGET_MS;
  const undelivered: Array<{ method: string; params: Record<string, unknown> }> = [];
  for (const event of events) {
    try {
      const timeoutMs = Math.max(1, deadline - Date.now());
      await withTimeout(
        session.transport.send(event.method, event.params, undefined, { timeoutMs }),
        timeoutMs,
        event.method,
      );
    } catch {
      undelivered.push(event);
    }
  }
  return undelivered;
}

const MODIFIER_KEYS: Readonly<Record<string, BrowserKeyDescriptor>> = {
  shift: { key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 },
  control: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 },
  ctrl: { key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17 },
  alt: { key: 'Alt', code: 'AltLeft', windowsVirtualKeyCode: 18 },
  meta: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 },
  command: { key: 'Meta', code: 'MetaLeft', windowsVirtualKeyCode: 91 },
};

/**
 * Resolve Playwright-style key names: `KeyW`/`Digit5` codes, modifier names,
 * and the shared named/printable keys. Physical codes are kept distinct so
 * games listening to `event.code` see the key the script asked for.
 */
function scriptKeyDescriptor(key: string): BrowserKeyDescriptor {
  const modifier = MODIFIER_KEYS[key.toLowerCase()];
  if (modifier) return modifier;
  return (
    browserPhysicalKeyDescriptor(key) ??
    (Array.from(key).length === 1 ? characterKeyDescriptor(key) : browserKeyDescriptor(key))
  );
}

/**
 * A single character keeps its own `key` and `text` ("!" stays "!"), as
 * Playwright sends it, but reports the physical US-layout `code` (Digit1) so
 * pages reading `event.code` and the Shift layer agree.
 */
function characterKeyDescriptor(char: string): BrowserKeyDescriptor {
  const printable = browserPrintableKeyDescriptor(char);
  if (!printable) return browserKeyDescriptor(char);
  return {
    key: char,
    code: printable.code,
    windowsVirtualKeyCode: printable.windowsVirtualKeyCode,
    text: char,
  };
}

/**
 * How keyboard.type delivers one character: a key event when the character
 * has a physical US-layout key, otherwise a text insertion. Control
 * characters such as \n and \t are inserted as text too: a synthetic
 * Enter/Tab key event does not insert a line break or a tab. Without this,
 * browserKeyDescriptor would produce a text-less key event for an emoji (two
 * UTF-16 units) and the character would be lost.
 */
function typedStroke(
  char: string,
): { key: BrowserKeyDescriptor; text?: never } | { key?: never; text: string } {
  return browserPrintableKeyDescriptor(char)
    ? { key: characterKeyDescriptor(char) }
    : { text: char };
}

function returnValue(json: string | undefined): { value?: unknown; valueTruncated?: boolean } {
  if (json === undefined) return {};
  if (Buffer.byteLength(json, 'utf8') <= MAX_RETURN_BYTES) return { value: JSON.parse(json) };
  return { value: `${json.slice(0, MAX_RETURN_BYTES)}…`, valueTruncated: true };
}

/** Map a worker error to script-relative location and stack frames. */
function scriptError(
  error: BrowserScriptWorkerError,
  filename: string,
): NonNullable<BrowserScriptResult['error']> {
  const frames = (error.stack ?? '')
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(
      (line) => line.includes(`${filename}:`) && !line.includes(BROWSER_SCRIPT_RUNTIME_FILENAME),
    );
  const syntaxLine = /^[^\n]*?:(\d+)\n/u.exec(error.stack ?? '');
  const location =
    locationFromFrame(frames[0], filename) ??
    (syntaxLine && (error.stack ?? '').startsWith(`${filename}:`)
      ? { line: Number(syntaxLine[1]), column: 0 }
      : undefined);
  return {
    name: error.name,
    message: error.message.slice(0, 2_000),
    ...(error.code ? { code: error.code } : {}),
    ...(location ? { location } : {}),
    ...(frames.length > 0 ? { stack: frames.slice(0, MAX_ERROR_STACK_LINES) } : {}),
  };
}

function locationFromFrame(
  frame: string | undefined,
  filename: string,
): BrowserScriptCallSite | undefined {
  if (!frame) return undefined;
  const index = frame.lastIndexOf(`${filename}:`);
  const match = /^:(\d+):(\d+)/u.exec(frame.slice(index + filename.length));
  return match ? { line: Number(match[1]), column: Number(match[2]) } : undefined;
}

/** Buttons still down, optionally excluding one being released. */
function heldButtonMask(buttons: ReadonlySet<string>, releasing?: string): number {
  let mask = 0;
  if (buttons.has('left') && releasing !== 'left') mask |= 1;
  if (buttons.has('right') && releasing !== 'right') mask |= 2;
  if (buttons.has('middle') && releasing !== 'middle') mask |= 4;
  return mask;
}

function limitedText(text: string): string {
  if (text.length > MAX_TYPE_CHARS) {
    throw new BrowserScriptOperationError(
      'TEXT_TOO_LONG',
      `Text input is limited to ${MAX_TYPE_CHARS} characters per call`,
    );
  }
  return text;
}

function firstLine(text: string): string {
  return text.split('\n')[0]?.slice(0, 1_000) ?? '';
}
