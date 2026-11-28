import { asNumber, asString, isRecord } from './browser-state.js';
import type { BrowserTransportEvent } from './browser-transport.js';

/** A main-frame navigation that started and has not committed or stopped yet. */
export interface BrowserPendingMainFrameLoad {
  readonly startedAt: number;
  /** Method of the first main-document request, e.g. the POST of a submitted form. */
  readonly requestMethod?: string;
  /** Latest requested URL (after redirects). */
  readonly url?: string;
  /** First redirect status: the server already answered the request, e.g. a 302 after a submit. */
  readonly redirectStatus?: number;
  /** Final response status: the new document is arriving. */
  readonly httpStatus?: number;
}

/**
 * After this long a pending record is treated as lost rather than loading:
 * beyond any page the Agent should keep waiting for, and it bounds the cost
 * of a commit event missed during a connection reset.
 */
export const MAX_PENDING_LOAD_MS = 120_000;

/**
 * Tracks the main frame between the start of a navigation and its commit.
 *
 * In that window Chromium answers no renderer-bound CDP command for the frame
 * (Runtime.evaluate, DOM.*, Page.createIsolatedWorld all wait for the commit;
 * real Chrome 156: a GET link or a POST→302 to a page that answers after 6 s
 * held Runtime.evaluate for 5.9 s). On a forum site the page a submit redirected
 * to answered after 48 s, so the reads after the click ran into their command
 * deadline and the recovery stopped the load. Browser Core uses this tracker
 * to wait for the commit with browser-side events only and to report a page
 * that is still loading instead of reading it.
 *
 * Only events are used. If an event is lost (a connection reset while the
 * page committed), the record expires after `MAX_PENDING_LOAD_MS`.
 */
export class BrowserMainFrameLoad {
  private current: BrowserPendingMainFrameLoad | undefined;
  private documentRequestId: string | undefined;
  private readonly waiters = new Set<() => void>();
  /**
   * The main frame id from a main-frame commit or a frame tree read, for
   * events that arrive before the caller's own record of it.
   */
  mainFrameId: string | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  get pending(): BrowserPendingMainFrameLoad | undefined {
    if (this.current && this.now() - this.current.startedAt >= MAX_PENDING_LOAD_MS) this.settle();
    return this.current;
  }

  /** Whether the server already answered the pending navigation's request. */
  get answered(): boolean {
    const load = this.pending;
    return load?.redirectStatus !== undefined || load?.httpStatus !== undefined;
  }

  /**
   * Feed every transport event. Events are attributed by frame id: the main
   * frame's id is unique across the page and its out-of-process frames (a
   * flattened CDP connection may deliver the page's own events under a
   * session id other than the transport's).
   */
  handle(event: BrowserTransportEvent, mainFrameId: string | null | undefined): void {
    const params = isRecord(event.params) ? event.params : {};
    const frame = isRecord(params.frame) ? params.frame : {};
    const frameId = asString(frame.id) || asString(params.frameId);
    // Before the main frame is known no event can be attributed to it safely.
    const knownMainFrameId = mainFrameId || this.mainFrameId;
    const mainFrame = Boolean(knownMainFrameId) && frameId === knownMainFrameId;
    switch (event.method) {
      // A requested navigation is not a load yet: a beforeunload answered
      // "stay" cancels it without any further event. The load starts once
      // the frame starts loading or its document request is sent.
      case 'Page.frameStartedLoading':
        if (mainFrame && !this.current) {
          this.documentRequestId = undefined;
          this.current = { startedAt: this.now() };
        }
        return;
      case 'Network.requestWillBeSent': {
        if (asString(params.type) !== 'Document' || !mainFrame) return;
        const request = isRecord(params.request) ? params.request : {};
        const redirect = isRecord(params.redirectResponse) ? params.redirectResponse : undefined;
        const started = this.current ?? { startedAt: this.now() };
        const redirectStatus = redirect ? asNumber(redirect.status, 0) : 0;
        this.documentRequestId = asString(params.requestId) || this.documentRequestId;
        this.current = {
          ...started,
          ...(started.requestMethod || !asString(request.method)
            ? {}
            : { requestMethod: asString(request.method) }),
          ...(asString(request.url) ? { url: asString(request.url) } : {}),
          ...(started.redirectStatus === undefined && redirectStatus > 0 ? { redirectStatus } : {}),
        };
        return;
      }
      case 'Network.responseReceived': {
        if (!this.current || asString(params.type) !== 'Document' || !mainFrame) return;
        if (this.documentRequestId && asString(params.requestId) !== this.documentRequestId) return;
        const response = isRecord(params.response) ? params.response : {};
        const status = asNumber(response.status, 0);
        if (status > 0) this.current = { ...this.current, httpStatus: status };
        return;
      }
      case 'Network.loadingFailed':
        if (this.documentRequestId && asString(params.requestId) === this.documentRequestId) {
          this.settle();
        }
        return;
      case 'Page.frameNavigated':
        // Only the main frame's commit ends the load; a child frame has a parentId.
        if (asString(frame.parentId) || (knownMainFrameId && !mainFrame)) return;
        if (frameId) this.mainFrameId = frameId;
        this.settle();
        return;
      case 'Page.frameStoppedLoading':
      case 'Page.frameDetached':
        if (mainFrame) this.settle();
        break;
      default:
        break;
    }
  }

  /**
   * Resolves true once no main-frame navigation is pending, false when the
   * timeout or the signal ends the wait first.
   */
  waitForCommit(timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const load = this.pending;
    if (!load) return Promise.resolve(true);
    if (signal?.aborted || timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve(this.pending === undefined);
      };
      const expiresInMs = load.startedAt + MAX_PENDING_LOAD_MS - this.now();
      const timer = setTimeout(finish, Math.min(timeoutMs, expiresInMs));
      timer.unref?.();
      this.waiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  private settle(): void {
    this.current = undefined;
    this.documentRequestId = undefined;
    for (const waiter of [...this.waiters]) waiter();
  }
}

/**
 * The result of an action that did not run because the main frame is still
 * loading a new document: the page cannot be read or used until it commits.
 */
export function pageStillLoadingResult(
  action: string,
  load: BrowserPendingMainFrameLoad,
  now: number = Date.now(),
): Record<string, unknown> {
  const seconds = Math.max(0, Math.round((now - load.startedAt) / 1_000));
  const status = load.httpStatus ?? load.redirectStatus;
  const answered =
    status === undefined
      ? ''
      : ` The server already answered${load.requestMethod ? ` the ${load.requestMethod} request` : ''} with HTTP ${status}.`;
  return {
    success: false,
    code: 'PAGE_LOADING',
    error: `The page has been loading a new document${load.url ? ` (${load.url})` : ''} for ${seconds}s, so ${action} did not run: the page cannot be read or used until the new document arrives.${answered}`,
    recovery: isGetLoad(load)
      ? 'Wait for the page with wait (a url or load condition, longer timeout), or inspect again in a few seconds.'
      : 'Wait for the page with wait (a url or text condition, longer timeout), or inspect again in a few seconds. Do not repeat the click or submit that started this load.',
    navigation: pendingLoadFacts(load),
  };
}

/**
 * A url or load wait whose condition is the commit of a load that did not
 * come within the wait: it ran and timed out, with what is still loading.
 */
export function waitStillLoadingResult(
  load: BrowserPendingMainFrameLoad,
  now: number = Date.now(),
): Record<string, unknown> {
  const seconds = Math.max(0, Math.round((now - load.startedAt) / 1_000));
  const status = load.httpStatus ?? load.redirectStatus;
  return {
    success: false,
    code: 'ACTION_TIMEOUT',
    error: `Browser wait condition timed out: the new document${load.url ? ` (${load.url})` : ''} was still loading after ${seconds}s.${status === undefined ? '' : ` The server already answered with HTTP ${status}.`}`,
    recovery: isGetLoad(load)
      ? 'The page is slow, not stuck: wait again with a longer timeout, or inspect in a few seconds.'
      : 'The page is slow, not stuck: wait again with a longer timeout, or inspect in a few seconds. Do not repeat the click or submit that started this load.',
    navigation: pendingLoadFacts(load),
  };
}

/** The navigation facts every result about a pending load reports. */
export function pendingLoadFacts(load: BrowserPendingMainFrameLoad): Record<string, unknown> {
  return {
    pending: true,
    ...(load.requestMethod ? { requestMethod: load.requestMethod } : {}),
    ...(load.redirectStatus !== undefined ? { redirectStatus: load.redirectStatus } : {}),
    ...(load.httpStatus !== undefined ? { httpStatus: load.httpStatus } : {}),
    ...(load.url ? { pendingUrl: load.url } : {}),
  };
}

/**
 * What a read returned while a load is pending reports: the page shown is the
 * one from before that load, so the read says nothing about what the load
 * brings and does not verify an earlier write.
 */
export function pendingNavigationReport(
  load: BrowserPendingMainFrameLoad,
): Record<string, unknown> {
  return {
    ...(load.requestMethod ? { requestMethod: load.requestMethod } : {}),
    startedAt: load.startedAt,
    ...(load.url ? { pendingUrl: load.url } : {}),
    message:
      'The page shown is still the one from before this navigation; the new page is still loading. This result does not show the outcome of an earlier write: read again after the page arrives (wait with a url or load condition) before repeating any write.',
  };
}

/** Only a recorded GET counts: a load whose request was not seen may be a form post. */
function isGetLoad(load: BrowserPendingMainFrameLoad): boolean {
  return load.requestMethod?.toUpperCase() === 'GET';
}

/**
 * A GET navigation the server already answered (a redirect or the response)
 * whose new document has not committed: nothing is resubmitted by leaving it
 * loading, so navigate and reload report it as pending instead of timing out
 * and resetting the connection, which would also stop the load.
 */
export function answeredGetLoad(
  load: BrowserPendingMainFrameLoad | undefined,
): BrowserPendingMainFrameLoad | undefined {
  return load &&
    isGetLoad(load) &&
    (load.redirectStatus !== undefined || load.httpStatus !== undefined)
    ? load
    : undefined;
}

/** Thrown by the navigation waits when an answered GET load is still pending at their deadline. */
export class MainFrameNavigationPending extends Error {
  constructor(readonly load: BrowserPendingMainFrameLoad) {
    super(
      `NAVIGATION_PENDING: the new document${load.url ? ` (${load.url})` : ''} is still loading`,
    );
    this.name = 'MainFrameNavigationPending';
  }
}

/**
 * The result of navigate or reload whose answered GET load is still pending:
 * the request reached the server, the page shown is still the previous one,
 * and the load goes on (same facts as a click whose submit is still loading).
 */
export function pendingNavigationResult(
  action: string,
  load: BrowserPendingMainFrameLoad,
  fields: Record<string, unknown>,
  now: number = Date.now(),
): Record<string, unknown> {
  const seconds = Math.max(0, Math.round((now - load.startedAt) / 1_000));
  const status = load.httpStatus ?? load.redirectStatus;
  return {
    success: true,
    ...fields,
    ...(load.url ? { url: load.url } : {}),
    navigation: { detected: true, urlChanged: true, loaded: false, ...pendingLoadFacts(load) },
    message: `The server answered the ${action} with HTTP ${status}, but the new page was still loading after ${seconds}s; the page shown is still the previous one.`,
    recovery:
      'Wait for the page with wait (a url or load condition, longer timeout), or inspect again in a few seconds. Navigating again starts the slow load over.',
  };
}
