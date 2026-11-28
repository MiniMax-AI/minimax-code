import { asNumber, asString, isRecord } from './browser-state.js';
import type { BrowserTransport, BrowserTransportEvent } from './browser-transport.js';

/** Main-document request facts observed while one Browser action ran. */
export interface BrowserDocumentResponse {
  requestMethod?: string;
  /** First redirect status, e.g. the 302 that answers a submitted form. */
  redirectStatus?: number;
  httpStatus?: number;
  url?: string;
}

/**
 * Records the main-document request an action triggered. A submit whose
 * navigation outlives the action deadline has usually already been answered
 * by the server (evaluation runs resubmitted a POST that had
 * landed), so the caller must see that answer before it submits again.
 */
export class BrowserDocumentResponseTracker {
  private document: BrowserDocumentResponse | undefined;

  constructor(private readonly transport: BrowserTransport) {}

  handle(event: BrowserTransportEvent, mainFrameId: string | null | undefined): void {
    if (
      event.method !== 'Network.requestWillBeSent' &&
      event.method !== 'Network.responseReceived'
    ) {
      return;
    }
    const params = isRecord(event.params) ? event.params : {};
    if (asString(params.type) !== 'Document') return;
    const frameId = asString(params.frameId);
    if (mainFrameId && frameId && frameId !== mainFrameId) return;
    // A flattened CDP connection (TUI headless Chrome) delivers the page's own
    // events under a session id other than the transport's: the main frame id
    // identifies them. Without it, only the transport's session counts.
    const mainFrameEvent = Boolean(mainFrameId) && frameId === mainFrameId;
    if (event.sessionId && event.sessionId !== this.transport.sessionId && !mainFrameEvent) return;
    if (event.method === 'Network.requestWillBeSent') {
      const request = isRecord(params.request) ? params.request : {};
      const redirect = isRecord(params.redirectResponse) ? params.redirectResponse : undefined;
      if (!this.document) {
        this.document = {
          ...(asString(request.method) ? { requestMethod: asString(request.method) } : {}),
        };
      }
      if (redirect && this.document.redirectStatus === undefined) {
        const status = asNumber(redirect.status, 0);
        if (status > 0) this.document.redirectStatus = status;
      }
      return;
    }
    const response = isRecord(params.response) ? params.response : {};
    const status = asNumber(response.status, 0);
    this.document = {
      ...this.document,
      ...(status > 0 ? { httpStatus: status } : {}),
      ...(asString(response.url) ? { url: asString(response.url) } : {}),
    };
  }

  /** A response observed before the action belongs to an earlier page load. */
  beginAction(): void {
    this.document = undefined;
  }

  /**
   * Attach the observed response to an action result and clear it. A main
   * document request still unanswered when the action ends is reported as a
   * pending load, so the caller waits for it instead of acting again (one
   * evaluation clicked a submit whose follow-up page loaded 48 s later).
   */
  annotate(result: unknown): unknown {
    const document = this.document;
    this.document = undefined;
    // Only an action that reports navigation facts gets the response; a
    // read never caused the page's own reloads.
    if (!isRecord(result) || !isRecord(result.navigation) || !document) return result;
    if (
      document.requestMethod &&
      document.httpStatus === undefined &&
      result.navigation.detected !== true &&
      result.success !== false
    ) {
      return {
        ...result,
        navigation: { ...result.navigation, pending: true, ...document },
        ...(result.recovery === undefined
          ? {
              recovery: `The action started a ${document.requestMethod} page load that is still running; the URL changes when the new page arrives. Inspect the page again before acting${document.requestMethod === 'GET' ? '' : ', and do not submit again'}.`,
            }
          : {}),
      };
    }
    if (document.httpStatus === undefined && document.redirectStatus === undefined) return result;
    return { ...result, navigation: { ...result.navigation, ...document } };
  }

  /** One sentence for an action that failed after the server already answered it. */
  describeAndClear(): string {
    const document = this.document;
    this.document = undefined;
    if (document?.httpStatus === undefined && document?.redirectStatus === undefined) return '';
    const method = document.requestMethod?.toUpperCase();
    const statuses = [document.redirectStatus, document.httpStatus]
      .filter((status) => status !== undefined)
      .join(' then ');
    const answered = `The server already answered this page's ${method ? `${method} ` : ''}request with HTTP ${statuses}${document.url ? ` (${document.url})` : ''}`;
    // A GET submits nothing, so loading it again is harmless; a form post or
    // a request that was not seen may land twice.
    return method === 'GET'
      ? `${answered}.`
      : `${answered}; do not repeat a submission before inspecting the page.`;
  }
}
