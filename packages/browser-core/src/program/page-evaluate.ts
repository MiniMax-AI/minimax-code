import { Script } from 'node:vm';

import {
  ensureMainFrameKnown,
  watchMainFrameNavigation,
  type MainFrameNavigationFacts as NavigationFacts,
  type MainFrameNavigationWatch,
} from '../browser-navigation-watch.js';
import { stopPageExecution } from '../browser-script.js';
import {
  asString,
  delay,
  describeCdpException,
  isRecord,
  resolveBrowserSnapshotElement,
  describeUnresolvedBrowserRef,
  type BrowserSessionState,
} from '../browser-state.js';
import type { BrowserTransportEvent } from '../browser-transport.js';
import { sanitizeNetworkDiagnosticUrl } from '../cdp-diagnostic-helpers.js';
import {
  isBrowserOperationInterruption,
  OperationAbortedError,
  withTimeout,
} from '../operation-timeout.js';
import { awaitMainFrameCommit } from './actionability.js';
import {
  BrowserProgramError,
  locatorAmbiguous,
  locatorNotFound,
  pageScriptUnsupportedPage,
  waitTimedOut,
  type ProgramCandidate,
} from './errors.js';
import { callProgramPage } from './locator-resolver.js';
import type { BrowserProgramHost } from './ops.js';
import { PROGRAM_PAGE_SOURCE } from './page-script.js';
import {
  describeProgramLocator,
  type ProgramEvaluateOp,
  type ProgramOp,
  type ProgramPageScriptAudit,
  type ProgramPageScriptEffects,
  type ProgramPageScriptRequest,
} from './types.js';

/**
 * Page JavaScript of a program (page.evaluate, locator.evaluate/evaluateAll,
 * page.waitForFunction). It runs in the page's main world, like page.evaluate
 * in a run_script page script, so it can call the site's own functions and
 * uses the user's session on that site. The constraints:
 *
 * - Only on a web page (http or https), and only on the origin the page had
 *   when the call started, whose site the request blocking below is keyed
 *   on; the check runs in the same evaluation, so a navigation in between
 *   cannot move it.
 * - One call runs at most 10 s (a busy loop is stopped with
 *   Runtime.terminateExecution); its result is JSON of at most 256 KiB.
 * - While it runs, requests to another site (eTLD+1) are failed through CDP
 *   Fetch, and its effects are measured: DOM mutations, form submits, requests
 *   (the network buffer of query kind "network") and a main-frame navigation.
 *   A non-GET request, a submit or a navigation is recorded like an uncertain
 *   write: the next write waits for a read.
 *
 * The interception and measurement window (PageScriptEffectWindow) and the
 * page-side counters are shared with run_script's page.evaluate
 * (browser-script.ts).
 * Interception opens and closes around each call instead of staying on for a
 * whole program: left on, it would pause the page's own requests between calls,
 * and a request paused before a window but reported inside it would be refused
 * as if the script had sent it. It also ends when the main frame commits a new
 * document (the call's document is gone; the new page loads its own resources),
 * and never outlasts its action (`endLeftoverPageScriptInterception`).
 *
 * Limits of the measurement, stated in the spec: effects are counted over the
 * call's time window, so the page's own activity in it counts too; work the
 * script leaves running after it returns (a timer, an unawaited fetch after the
 * drain below) is not seen; Fetch covers the page target only (not
 * out-of-process iframes, workers, service workers or WebSockets); the site
 * rule uses a short list of second-level public suffixes, not the full Public
 * Suffix List.
 */

const EVALUATE_TIMEOUT_MS = 10_000;
/** The transport waits this much longer than the page-side deadline before it stops the page. */
const EVALUATE_STOP_MARGIN_MS = 1_000;
const MAX_RESULT_BYTES = 256 * 1024;
const DEFAULT_POLL_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;
/** Requests the script started just before it returned still reach the Fetch window. */
const REQUEST_DRAIN_MS = 50;
/** After interception stops taking new requests, the ones in preparation get this long to pause. */
const REQUEST_PREPARATION_MS = 25;
const ANSWER_TIMEOUT_MS = 2_000;
/** How long closing a window waits for the answers to paused requests. */
const ANSWER_DRAIN_MS = 1_000;
/** The second answer of a request whose first one was not confirmed. */
const FINAL_ANSWER_TIMEOUT_MS = 500;
const MAX_LISTED_REQUESTS = 20;
const AUDIT_SOURCE_CHARS = 4 * 1024;
const MAX_ERROR_CHARS = 2_000;

/** Second-level labels under a two-letter country code that are public suffixes (co.uk, com.cn). */
const SECOND_LEVEL_SUFFIXES: Readonly<Record<string, true>> = {
  ac: true,
  co: true,
  com: true,
  edu: true,
  gov: true,
  ltd: true,
  ne: true,
  net: true,
  or: true,
  org: true,
  plc: true,
};

/**
 * The site (approximate eTLD+1) of a URL: the host for an IP address or a
 * single label, else the last two labels, or three under a known second-level
 * suffix such as co.uk. Undefined for a URL without a host.
 */
export function pageScriptSite(url: string): string | undefined {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (!host) return undefined;
  if (host.startsWith('[') || /^\d+(?:\.\d+){3}$/u.test(host)) return host;
  const labels = host.replace(/\.$/u, '').split('.');
  if (labels.length <= 2) return labels.join('.');
  const tld = labels.at(-1) ?? '';
  const second = labels.at(-2) ?? '';
  const keep = tld.length === 2 && SECOND_LEVEL_SUFFIXES[second] === true ? 3 : 2;
  return labels.slice(-keep).join('.');
}

/** The origin of a page: scheme, host and port (`about:` for blank pages). */
export function pageScriptOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? parsed.protocol : parsed.origin;
  } catch {
    return url;
  }
}

/** Page JavaScript runs only on web pages: about:, data:, file:, chrome: and the like have no site. */
export function isPageScriptWebPage(url: string): boolean {
  return /^https?:\/\//iu.test(url);
}

/**
 * Page-side counters of DOM mutations and form submits: an expression whose
 * value is `done(out)`, which stops counting and adds both counts to `out`.
 * Missing DOM APIs leave the counts at 0 instead of failing the call.
 */
export const PAGE_SCRIPT_EFFECT_COUNTER = `(() => {
  let mutations = 0;
  let submits = 0;
  let observer = null;
  try {
    observer = new MutationObserver((records) => { mutations += records.length; });
    observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch (error) { observer = null; }
  const onSubmit = () => { submits += 1; };
  let listening = false;
  try { document.addEventListener('submit', onSubmit, true); listening = true; } catch (error) { listening = false; }
  return (out) => {
    if (observer) { mutations += observer.takeRecords().length; observer.disconnect(); observer = null; }
    if (listening) { document.removeEventListener('submit', onSubmit, true); listening = false; }
    out.mutations = mutations;
    out.submits = submits;
    return out;
  };
})()`;

/**
 * The model's source must be one expression: it is inserted into the page
 * wrapper between parentheses, and text that closes them could run before
 * the origin check. It compiles (never runs) both as `(source)` and as
 * `[source]`: text that leaves either bracket fails one of the two, so what
 * passes is a single (possibly comma) expression.
 */
export function assertPageScriptExpression(source: string, label = 'The page script'): void {
  try {
    for (const wrapped of [`(\n${source}\n)`, `[\n${source}\n]`]) {
      // eslint-disable-next-line no-new -- compiling is the check; the script never runs
      new Script(wrapped, { filename: 'page-script.js' });
    }
  } catch (error) {
    throw new BrowserProgramError(
      'INVALID_OP',
      `${label} must be one function or expression: ${error instanceof Error ? error.message : String(error)}`,
      { recovery: 'Pass a function, for example page.evaluate(() => document.title).' },
    );
  }
}

/**
 * The function the page runs: origin check, effect counters, the target
 * elements (through the fixed locator script), the model's function, the
 * JSON result. `this` is the element a ref resolved to, if any. The model's
 * expression is evaluated only after the origin check, in a scope that cannot
 * see the counters. A sandboxed frame (opaque origin) is not a web page, and
 * a ref in a frame of another origin is refused: request blocking is keyed
 * on the page's site.
 */
function pageScriptFunction(source: string): string {
  return `function (request) {
  const make = () => (
${source}
);
  return (async function (request) {
  if (location.origin === 'null') return { unsupportedPage: 'null' };
  if (location.origin !== request.origin) return request.scoped ? { otherFrame: location.origin } : { moved: location.origin };
  const pageScript = ${PROGRAM_PAGE_SOURCE};
  const done = ${PAGE_SCRIPT_EFFECT_COUNTER};
  const stringify = JSON.stringify;
  try {
    let subject;
    if (request.chain) {
      if (request.all) {
        subject = pageScript.call(this, { kind: 'elements', chain: request.chain });
      } else {
        const picked = pageScript.call(this, { kind: 'pick', chain: request.chain });
        if (!picked.element) return done({ locator: picked.error === 'ambiguous' ? { error: 'ambiguous', count: picked.count, candidates: picked.candidates } : { error: 'not_found' } });
        subject = picked.element;
      }
    }
    const fn = make();
    const call = () => request.chain ? fn(subject, request.arg) : (typeof fn === 'function' ? fn(request.arg) : fn);
    const expired = {};
    let timer;
    const value = await Promise.race([
      Promise.resolve().then(call),
      new Promise((resolve) => { timer = setTimeout(() => resolve(expired), request.timeoutMs); }),
    ]);
    clearTimeout(timer);
    if (value === expired) return done({ timedOut: true });
    const json = value === undefined ? undefined : stringify(value);
    if (json === undefined) return done({ undefined: true });
    if (json.length > request.maxChars) return done({ tooLarge: json.length });
    return done({ json });
  } catch (error) {
    return done({ thrown: String((error && (error.stack || error.message)) || error).slice(0, ${MAX_ERROR_CHARS}) });
  }
  }).call(this, request);
}`;
}

interface PageScriptAnswer {
  /** The page is on another origin than when the call started. */
  readonly moved?: string;
  /** The document is not a web page: `null` for a sandboxed frame. */
  readonly unsupportedPage?: string;
  /** The origin of the frame a ref is in, when it is not the page's origin. */
  readonly otherFrame?: string;
  readonly locator?: {
    readonly error: 'ambiguous' | 'not_found';
    readonly count?: number;
    readonly candidates?: readonly ProgramCandidate[];
  };
  readonly timedOut?: true;
  readonly undefined?: true;
  readonly tooLarge?: number;
  readonly json?: string;
  readonly thrown?: string;
  readonly mutations?: number;
  readonly submits?: number;
}

interface CdpEvaluation {
  readonly result?: { readonly value?: unknown };
  readonly exceptionDetails?: unknown;
}

/** A paused request and the answer it gets. */
interface PausedRequest {
  readonly requestId: string;
  readonly blocked: boolean;
  readonly sessionId: string | undefined;
}

/** Fetch interception of page JavaScript on one session. */
interface SessionInterception {
  /** Fetch.enable with a pattern was sent and no Fetch.disable got through since. */
  mayBeOn: boolean;
  /** Gates whose listener answers paused requests. */
  openGates: number;
}

const interceptions = new WeakMap<BrowserSessionState, SessionInterception>();

function interceptionOf(state: BrowserSessionState): SessionInterception {
  let interception = interceptions.get(state);
  if (!interception) {
    interception = { mayBeOn: false, openGates: 0 };
    interceptions.set(state, interception);
  }
  return interception;
}

/** Fetch.disable without the action's signal: it also runs once the action is over. */
async function disableInterception(state: BrowserSessionState, timeoutMs: number): Promise<void> {
  try {
    await withTimeout(
      state.transport.send('Fetch.disable', {}, undefined, { timeoutMs }),
      timeoutMs,
      'Fetch.disable',
    );
    interceptionOf(state).mayBeOn = false;
  } catch {
    // Still recorded as on: the end of the next action sends it again.
  }
}

/**
 * Interception must not outlast an action: every request of the tab would
 * wait for an answer nobody gives. At the end of an action, when no window is
 * open any more and interception may still be on (a Fetch.enable cut off by a
 * dialog after it reached Chromium, a Fetch.disable that did not get through),
 * Fetch.disable is sent once more.
 */
export async function endLeftoverPageScriptInterception(
  state: BrowserSessionState,
  timeoutMs: number,
): Promise<void> {
  const interception = interceptions.get(state);
  if (!interception?.mayBeOn || interception.openGates > 0) return;
  await disableInterception(state, timeoutMs);
}

/** Page.frameNavigated of the main frame: it committed a new document. */
function isMainFrameCommit(state: BrowserSessionState, event: BrowserTransportEvent): boolean {
  if (event.method !== 'Page.frameNavigated') return false;
  const params = isRecord(event.params) ? event.params : {};
  const frame = isRecord(params.frame) ? params.frame : {};
  if (asString(frame.parentId)) return false;
  const mainFrameId = state.cdpHelper.getMainFrameId() ?? state.mainFrameLoad?.mainFrameId;
  if (mainFrameId) return asString(frame.id) === mainFrameId;
  return !event.sessionId || event.sessionId === state.transport.sessionId;
}

/** Requests the Fetch window saw, and the ones it refused. */
class PageScriptRequestGate {
  readonly seen: ProgramPageScriptRequest[] = [];
  private readonly answers: Promise<void>[] = [];
  /** Paused requests whose answer the browser has not confirmed. */
  private readonly unanswered = new Map<string, PausedRequest>();
  private disposeListener: (() => void) | undefined;
  private enabled = false;
  /** Fetch.disable was sent: Chromium released whatever is paused, nothing is answered any more. */
  private disabled = false;
  private closing: Promise<void> | undefined;
  /**
   * The main frame committed a new document while interception was on: the
   * calls of the window ran in the old one, whose JavaScript is gone, and the
   * requests now are the new page loading (its stylesheets and scripts on a
   * CDN). The gate closes at once; what pauses until then is let through. The
   * navigation request itself paused before the commit: one to another site
   * was refused.
   */
  navigated = false;

  constructor(
    private readonly state: BrowserSessionState,
    private readonly pageSite: string | undefined,
    /** The command signal of the action the window belongs to. */
    private readonly actionSignal: AbortSignal | undefined,
  ) {}

  async open(): Promise<void> {
    const { state } = this;
    // A window that starts after its action ended (run_script gave it up while
    // it was opening) must not intercept: nothing would end it.
    if (state.commandSignal !== this.actionSignal || this.actionSignal?.aborted) {
      throw new OperationAbortedError('the action of this page JavaScript ended');
    }
    // Reopened after `close` for the next poll of a waitForFunction, which
    // runs on the call's origin again (checked in the page), so on the same site.
    this.disabled = false;
    this.navigated = false;
    this.closing = undefined;
    const interception = interceptionOf(state);
    // Fetch is enabled on the page session only, so every paused request is
    // this page's. Its event carries the CDP session id, which a provider's
    // transport may name differently (the TUI names the transport by target id).
    const dispose = state.transport.onEvent((event) => {
      if (isMainFrameCommit(state, event)) {
        if (!this.enabled || this.navigated) return;
        this.navigated = true;
        // Not from inside the event (see below).
        setImmediate(() => void this.close());
        return;
      }
      if (event.method !== 'Fetch.requestPaused') return;
      const params = isRecord(event.params) ? event.params : {};
      const request = isRecord(params.request) ? params.request : {};
      const requestId = asString(params.requestId);
      if (!requestId) return;
      const url = asString(request.url);
      const method = asString(request.method, 'GET').toUpperCase();
      const site = /^https?:/iu.test(url) ? pageScriptSite(url) : undefined;
      // A request paused as Fetch.disable went out is released, whatever its site.
      const blocked =
        !this.disabled &&
        !this.navigated &&
        site !== undefined &&
        this.pageSite !== undefined &&
        site !== this.pageSite;
      // Listed as the network buffer lists it (no query or hash), so the two
      // sides of one request merge; the site check above used the full URL.
      this.seen.push({
        method,
        url: sanitizeNetworkDiagnosticUrl(url),
        ...(blocked ? { blocked: true as const } : {}),
      });
      if (this.disabled) return;
      const paused = { requestId, blocked, sessionId: event.sessionId };
      this.unanswered.set(requestId, paused);
      // Never from inside the event. Electron delivers it on Chromium's stack, in
      // InterceptionJob::NotifyClient, and its debugger runs a command at once: a
      // failRequest there destroys the job NotifyClient goes on using (SIGSEGV on
      // a POST with a body and no cookies). A microtask would still run on that stack.
      this.answers.push(
        new Promise<void>((resolve) => {
          setImmediate(resolve);
        }).then(() => this.answer(paused, ANSWER_TIMEOUT_MS)),
      );
    });
    interception.openGates += 1;
    this.disposeListener = () => {
      dispose();
      interception.openGates -= 1;
    };
    interception.mayBeOn = true;
    try {
      await state.transport.send(
        'Fetch.enable',
        { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
        undefined,
        commandOptions(state),
      );
      if (state.commandSignal !== this.actionSignal || this.actionSignal?.aborted) {
        throw new OperationAbortedError('the action of this page JavaScript ended');
      }
      this.enabled = true;
    } catch (error) {
      this.disposeListener();
      this.disposeListener = undefined;
      if (isBrowserOperationInterruption(error)) {
        // Cut off locally (a JavaScript dialog aborts the command) after it may
        // have reached Chromium, or enabled after the action ended: interception
        // could be on with nobody answering, and every request of the tab would
        // stay paused.
        await disableInterception(state, ANSWER_TIMEOUT_MS);
        throw error;
      }
      // Without interception the script cannot run: nothing would stop a cross-site request.
      throw new BrowserProgramError(
        'PAGE_SCRIPT_UNAVAILABLE',
        'Page JavaScript needs request interception, which this page does not allow.',
        { recovery: 'Read the page with locator methods instead.' },
      );
    }
  }

  /** Ends interception (once, also when the main frame committed a new document). */
  close(): Promise<void> {
    this.closing ??= this.end();
    return this.closing;
  }

  /**
   * Ends interception in the order Chromium needs. A request it is still
   * preparing (reading cookies or a Blob body) has not paused yet, and
   * Fetch.disable would leave it stuck forever: first new requests stop being
   * intercepted, then the ones in preparation pause and get their answer, and
   * only then Fetch.disable. Requests to another site are refused until then:
   * Chromium would let a paused one out.
   */
  private async end(): Promise<void> {
    if (this.enabled) {
      this.enabled = false;
      await withTimeout(
        this.state.transport.send('Fetch.enable', { patterns: [] }, undefined, {
          timeoutMs: ANSWER_TIMEOUT_MS,
        }),
        ANSWER_TIMEOUT_MS,
        'Fetch.enable',
      ).catch(() => undefined);
      await delay(REQUEST_PREPARATION_MS).catch(() => undefined);
      await this.drainAnswers();
      this.disabled = true;
      await disableInterception(this.state, ANSWER_TIMEOUT_MS);
    }
    this.disposeListener?.();
    this.disposeListener = undefined;
  }

  /**
   * Ends interception at once when a call in the window never came back:
   * Fetch.disable on a short budget (Chromium releases what is paused), no
   * drain, and the listener goes with it, so nothing here answers requests
   * later.
   */
  async abandon(timeoutMs: number): Promise<void> {
    this.enabled = false;
    this.disabled = true;
    this.disposeListener?.();
    this.disposeListener = undefined;
    await disableInterception(this.state, timeoutMs);
  }

  private async answer(paused: PausedRequest, timeoutMs: number): Promise<void> {
    if (this.disabled) return;
    const { requestId, blocked, sessionId } = paused;
    try {
      await withTimeout(
        this.state.transport.send(
          blocked ? 'Fetch.failRequest' : 'Fetch.continueRequest',
          blocked ? { requestId, errorReason: 'BlockedByClient' } : { requestId },
          sessionId,
          { timeoutMs },
        ),
        timeoutMs,
        'the answer to a paused request',
      );
      this.unanswered.delete(requestId);
    } catch {
      // The request is gone or the browser did not reply; `drainAnswers` repeats it once.
    }
  }

  /** Waits for the answers, also those of requests paused meanwhile; what is left gets its answer again. */
  private async drainAnswers(): Promise<void> {
    const deadline = Date.now() + ANSWER_DRAIN_MS;
    let awaited = 0;
    for (
      let left = ANSWER_DRAIN_MS;
      awaited < this.answers.length && left > 0;
      left = deadline - Date.now()
    ) {
      const batch = this.answers.slice(awaited);
      awaited = this.answers.length;
      await withTimeout(Promise.all(batch), left, 'the answers to paused requests').catch(
        () => undefined,
      );
    }
    await Promise.all(
      [...this.unanswered.values()].map((paused) => this.answer(paused, FINAL_ANSWER_TIMEOUT_MS)),
    );
  }
}

function commandOptions(state: BrowserSessionState): {
  signal?: AbortSignal;
  timeoutMs?: number;
} {
  return {
    ...(state.commandSignal ? { signal: state.commandSignal } : {}),
    ...(state.commandTimeoutMs ? { timeoutMs: state.commandTimeoutMs } : {}),
  };
}

/** The requests of the window: the network buffer's entries, plus what only Fetch saw. */
function windowRequests(
  state: BrowserSessionState,
  checkpoint: number | undefined,
  fetched: readonly ProgramPageScriptRequest[],
): ProgramPageScriptRequest[] {
  const buffered: ProgramPageScriptRequest[] =
    checkpoint === undefined
      ? []
      : state.cdpHelper
          .getNetworkDiagnostics({ afterSequence: checkpoint, limit: 200 })
          .entries.map((entry) => ({
            method: entry.method.toUpperCase(),
            url: entry.url,
            ...(entry.status === undefined ? {} : { status: entry.status }),
          }));
  const out = [...buffered];
  for (const request of fetched) {
    const index = out.findIndex(
      (entry) =>
        entry.method === request.method && entry.url === request.url && entry.blocked !== true,
    );
    // The buffer lists a refused request as failed; Fetch says why.
    if (index >= 0 && request.blocked) out[index] = { ...out[index]!, blocked: true };
    else if (index < 0) out.push(request);
  }
  return out;
}

function effectsOf(input: {
  readonly origin: string;
  readonly durationMs: number;
  readonly mutations: number;
  readonly submits: number;
  readonly requests: readonly ProgramPageScriptRequest[];
  readonly navigation: NavigationFacts;
}): ProgramPageScriptEffects {
  // HEAD reads; OPTIONS is the CORS preflight of a request listed on its own.
  const nonGetRequests = input.requests.filter(
    (request) =>
      request.blocked !== true &&
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      request.method !== 'OPTIONS',
  ).length;
  const blockedRequests = input.requests.filter((request) => request.blocked === true).length;
  const navigation = input.navigation.detected
    ? {
        detected: true,
        ...(input.navigation.url ? { url: input.navigation.url } : {}),
        ...(input.navigation.committed ? { committed: true } : {}),
        ...(input.navigation.sameDocument ? { sameDocument: true } : {}),
      }
    : undefined;
  // A same-document history update is not a write by itself.
  const navigated = navigation !== undefined && input.navigation.sameDocument !== true;
  return {
    origin: input.origin,
    durationMs: input.durationMs,
    mutations: input.mutations,
    submits: input.submits,
    requests: input.requests.slice(0, MAX_LISTED_REQUESTS),
    requestCount: input.requests.length,
    nonGetRequests,
    blockedRequests,
    ...(navigation ? { navigation } : {}),
    writeLike: nonGetRequests > 0 || input.submits > 0 || navigated,
  };
}

/**
 * The time window of page JavaScript on one page: requests to another site
 * are failed while it is intercepting, and its effects (requests from the
 * network buffer and Fetch, a main-frame navigation, plus the page-side
 * counts the caller adds) are measured until `finish`. A program evaluate op
 * opens one per op; a run_script opens one while any page.evaluate runs.
 */
export class PageScriptEffectWindow {
  private readonly startedAt = Date.now();

  private constructor(
    private readonly state: BrowserSessionState,
    private readonly checkpoint: number | undefined,
    private readonly gate: PageScriptRequestGate,
    private readonly watch: MainFrameNavigationWatch,
  ) {}

  /** Starts measuring on the page at `url`. Requests are not intercepted until `intercept`. */
  static async start(state: BrowserSessionState, url: string): Promise<PageScriptEffectWindow> {
    const actionSignal = state.commandSignal;
    await ensureMainFrameKnown(state);
    const ready = await state.cdpHelper
      .ensureNetworkDiagnosticsReady(state.commandSignal)
      .catch((error: unknown) => {
        if (isBrowserOperationInterruption(error)) throw error;
        return false;
      });
    const checkpoint = ready
      ? state.cdpHelper.getNetworkDiagnostics({ limit: 1 }).lastSequence
      : undefined;
    return new PageScriptEffectWindow(
      state,
      checkpoint,
      new PageScriptRequestGate(state, pageScriptSite(url), actionSignal),
      watchMainFrameNavigation(state),
    );
  }

  /**
   * Fails requests to another site from now on, until the main frame commits
   * a new document: then interception ends (see `released`). Throws
   * PAGE_SCRIPT_UNAVAILABLE when the page does not allow interception, and an
   * interruption when the window's action already ended: the script must not
   * run then. `finish` still ends the window.
   */
  intercept(): Promise<void> {
    return this.gate.open();
  }

  /**
   * The main frame committed a new document since `intercept`: interception
   * ended (measurement goes on until `finish`), and a call that runs now is
   * not protected.
   */
  get released(): boolean {
    return this.gate.navigated;
  }

  /**
   * Stops failing requests between two calls of one window (the interval of a
   * waitForFunction poll): the page's own cross-site requests in that time are
   * not the script's, and failing them could keep the awaited condition from
   * ever coming true. Measurement goes on; `intercept` resumes before the next call.
   */
  async pause(): Promise<void> {
    await delay(REQUEST_DRAIN_MS).catch(() => undefined);
    await this.gate.close();
  }

  /** Ends interception and measurement (after a short drain for requests just started). */
  async finish(
    origin: string,
    counts: { readonly mutations: number; readonly submits: number },
  ): Promise<ProgramPageScriptEffects> {
    await delay(REQUEST_DRAIN_MS).catch(() => undefined);
    await this.gate.close();
    return this.effects(origin, counts);
  }

  /**
   * Ends a window a call never came back from: interception stops at once
   * (see the gate's `abandon`), and the effects are what was seen until now.
   */
  async abandon(
    origin: string,
    counts: { readonly mutations: number; readonly submits: number },
    timeoutMs: number,
  ): Promise<ProgramPageScriptEffects> {
    await this.gate.abandon(timeoutMs);
    return this.effects(origin, counts);
  }

  private async effects(
    origin: string,
    counts: { readonly mutations: number; readonly submits: number },
  ): Promise<ProgramPageScriptEffects> {
    const navigation = await this.watch.settle();
    this.watch.dispose();
    return effectsOf({
      origin,
      durationMs: Date.now() - this.startedAt,
      mutations: counts.mutations,
      submits: counts.submits,
      requests: windowRequests(this.state, this.checkpoint, this.gate.seen),
      navigation,
    });
  }
}

/** Where the page script runs: the whole page, or the element a ref names (then the chain's rest). */
async function scriptScope(
  state: BrowserSessionState,
  op: ProgramEvaluateOp,
): Promise<{ objectId?: string; sessionId?: string; chain?: readonly unknown[] }> {
  const chain = op.target?.chain;
  if (!chain) return {};
  const [first, ...rest] = chain;
  if (first?.by !== 'ref') return { chain };
  const resolved = resolveBrowserSnapshotElement(state, first.ref);
  if (!resolved) throw new Error(describeUnresolvedBrowserRef(state, first.ref));
  const sessionId = resolved.element.commandSessionId;
  const node = await state.transport
    .send<{
      object?: { objectId?: string };
    }>(
      'DOM.resolveNode',
      { backendNodeId: resolved.element.backendNodeId },
      sessionId,
      commandOptions(state),
    )
    .catch(() => ({ object: undefined }));
  const objectId = node.object?.objectId;
  if (!objectId) {
    throw new BrowserProgramError(
      'STALE_ELEMENT_REF',
      'The element of this ref was replaced or removed.',
      { recovery: 'Call page.observe() again and use the new ref, or use a role or text locator.' },
    );
  }
  return { objectId, ...(sessionId ? { sessionId } : {}), chain: rest };
}

/** One call of the model's function in the page; a busy page is stopped at the deadline. */
async function callOnce(
  state: BrowserSessionState,
  op: ProgramEvaluateOp,
  origin: string,
  timeoutMs: number,
): Promise<PageScriptAnswer> {
  // The action's signal, read now: once a dialog ends the action, the session
  // no longer holds it, and the check below must still see it aborted.
  const signal = state.commandSignal;
  const scope = await scriptScope(state, op);
  const request = {
    origin,
    timeoutMs,
    maxChars: MAX_RESULT_BYTES,
    ...(scope.chain ? { chain: scope.chain } : {}),
    ...(scope.objectId ? { scoped: true } : {}),
    ...(op.all === true ? { all: true } : {}),
    ...(op.arg === undefined ? {} : { arg: op.arg }),
  };
  const declaration = pageScriptFunction(op.source);
  const options = {
    ...(signal ? { signal } : {}),
    timeoutMs: timeoutMs + EVALUATE_STOP_MARGIN_MS,
  };
  let payload: CdpEvaluation;
  try {
    payload = scope.objectId
      ? await state.transport.send<CdpEvaluation>(
          'Runtime.callFunctionOn',
          {
            objectId: scope.objectId,
            functionDeclaration: declaration,
            arguments: [{ value: request }],
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
          },
          scope.sessionId,
          options,
        )
      : await state.transport.send<CdpEvaluation>(
          'Runtime.evaluate',
          {
            expression: `(${declaration}).call(null, ${JSON.stringify(request)})`,
            awaitPromise: true,
            returnByValue: true,
            userGesture: true,
          },
          undefined,
          options,
        );
  } catch (error) {
    if (!isBrowserOperationInterruption(error) || signal?.aborted) throw error;
    // A busy loop: the transport gave up; stop the page's JavaScript so the tab stays usable.
    if (!(await stopPageExecution(state))) {
      state.pageUnresponsive = true;
      throw error;
    }
    return { timedOut: true };
  } finally {
    if (scope.objectId) {
      await state.transport
        .send('Runtime.releaseObject', { objectId: scope.objectId }, scope.sessionId, {
          timeoutMs: 2_000,
        })
        .catch(() => undefined);
    }
  }
  if (payload.exceptionDetails) {
    throw new BrowserProgramError(
      'PAGE_SCRIPT_FAILED',
      describeCdpException(payload.exceptionDetails, 'The page script failed'),
      { recovery: 'Fix the function; it runs in the page, where only page globals exist.' },
    );
  }
  const value = payload.result?.value;
  return isRecord(value) ? (value as PageScriptAnswer) : {};
}

/** The value of one answer, or the failure it reports. */
function answerValue(
  answer: PageScriptAnswer,
  op: ProgramEvaluateOp,
  origin: string,
  timeoutMs: number,
): { readonly value: unknown } {
  if (answer.unsupportedPage !== undefined) throw pageScriptUnsupportedPage(answer.unsupportedPage);
  if (answer.otherFrame !== undefined) {
    throw new BrowserProgramError(
      'PAGE_SCRIPT_UNSUPPORTED_PAGE',
      `The element of this ref is in a frame on ${answer.otherFrame}; page JavaScript runs only in documents of the page's origin, ${origin}.`,
      {
        retryable: false,
        recovery:
          'Read the element with locator methods instead: textContent(), innerHTML(), getAttribute().',
      },
    );
  }
  if (answer.moved !== undefined) {
    throw new BrowserProgramError(
      'PAGE_LOADING',
      `The page moved from ${origin} to ${answer.moved} as the page script started; it did not run.`,
      {
        recovery:
          'Wait with page.waitForLoadState("load"), check the page, then run the page script again.',
      },
    );
  }
  if (answer.locator && op.target) {
    const target = describeProgramLocator(op.target);
    if (answer.locator.error === 'ambiguous') {
      throw locatorAmbiguous(target, answer.locator.count ?? 0, answer.locator.candidates ?? []);
    }
    throw locatorNotFound(target, 0);
  }
  if (answer.timedOut) {
    throw new BrowserProgramError(
      'PAGE_SCRIPT_TIMEOUT',
      `The page script did not finish within ${timeoutMs} ms.`,
      {
        recovery:
          'Do less per call. An async function may still continue in the page; read the page before relying on it.',
      },
    );
  }
  if (answer.thrown !== undefined) {
    throw new BrowserProgramError('PAGE_SCRIPT_FAILED', answer.thrown.split('\n')[0] ?? '', {
      recovery: 'Fix the function; it runs in the page, where only page globals exist.',
      details: { stack: answer.thrown },
    });
  }
  const size =
    answer.tooLarge ?? (answer.json === undefined ? 0 : Buffer.byteLength(answer.json, 'utf8'));
  if (size > MAX_RESULT_BYTES) {
    throw new BrowserProgramError(
      'PAGE_SCRIPT_RESULT_TOO_LARGE',
      `The page script returned ${size} bytes of JSON; the limit is ${MAX_RESULT_BYTES}.`,
      { recovery: 'Return only what the program needs (filter or summarize in the function).' },
    );
  }
  if (answer.undefined || answer.json === undefined) return { value: undefined };
  return { value: JSON.parse(answer.json) as unknown };
}

/** Runs one evaluate op inside the session gate. */
export async function runPageScript(
  host: BrowserProgramHost,
  op: Extract<ProgramOp, { op: 'evaluate' }>,
): Promise<Record<string, unknown>> {
  const { state } = host;
  const startedAt = Date.now();
  const deadline = startedAt + (op.poll ? (op.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS) : 0);
  assertPageScriptExpression(op.source);
  await awaitMainFrameCommit(state, Date.now() + EVALUATE_TIMEOUT_MS);
  const page = await callProgramPage(state, { kind: 'page' });
  const url = asString(page.url);
  const origin = pageScriptOrigin(url);
  if (!isPageScriptWebPage(url)) throw pageScriptUnsupportedPage(origin);
  const window = await PageScriptEffectWindow.start(state, url);
  let mutations = 0;
  let submits = 0;
  let calls = 0;
  let result: { readonly value: unknown } | undefined;
  let failure: unknown;
  try {
    for (;;) {
      await window.intercept();
      // One call: 10 s at most, less when the program asked for a shorter timeout.
      const remaining = op.poll ? deadline - Date.now() : (op.timeoutMs ?? EVALUATE_TIMEOUT_MS);
      const timeoutMs = Math.max(1, Math.min(EVALUATE_TIMEOUT_MS, remaining));
      calls += 1;
      const answer = await callOnce(state, op, origin, timeoutMs);
      mutations += answer.mutations ?? 0;
      submits += answer.submits ?? 0;
      const current = answerValue(answer, op, origin, timeoutMs);
      if (!op.poll || Boolean(current.value)) {
        result = current;
        break;
      }
      if (Date.now() + POLL_INTERVAL_MS >= deadline) {
        throw waitTimedOut(
          'the page function to return a truthy value',
          op.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS,
        );
      }
      await window.pause();
      await delay(POLL_INTERVAL_MS, state.commandSignal);
    }
  } catch (error) {
    failure = error;
  }
  const effects = await window.finish(origin, { mutations, submits });
  if (effects.writeLike) host.recordPageScriptWrite(url);
  if (effects.navigation) host.invalidate();
  else if (effects.mutations > 0) host.invalidateObservation();
  const audit: ProgramPageScriptAudit = {
    ...effects,
    source: op.source.slice(0, AUDIT_SOURCE_CHARS),
    ...(op.source.length > AUDIT_SOURCE_CHARS ? { sourceTruncated: true as const } : {}),
    ...(calls > 1 ? { calls } : {}),
  };
  if (failure !== undefined) {
    if (failure instanceof BrowserProgramError) {
      throw new BrowserProgramError(failure.code, failure.message.replace(/^[A-Z_]+: /u, ''), {
        ...(failure.recovery ? { recovery: failure.recovery } : {}),
        retryable: failure.retryable,
        details: { ...failure.details, pageScript: audit },
      });
    }
    throw failure;
  }
  return {
    success: true,
    url,
    value: {
      value: result?.value ?? null,
      ...(result?.value === undefined ? { undefined: true } : {}),
      effects,
    },
    pageScript: audit,
  };
}
