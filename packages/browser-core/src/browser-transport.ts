import type { BrowserJsDialogSource } from './browser-js-dialog.js';
import type { BrowserTransportCommandParams } from './browser-transport-types.js';

export interface BrowserEvaluateOptions {
  awaitPromise?: boolean;
  returnByValue?: boolean;
  userGesture?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface BrowserTransportEvent {
  method: string;
  params?: unknown;
  sessionId?: string;
}

export type BrowserTransportEventListener = (event: BrowserTransportEvent) => void;

export interface BrowserTransportCommandOptions {
  /** Abort the caller's wait and discard a late CDP response. */
  readonly signal?: AbortSignal;
  /** Per-command deadline. Providers may clamp this to a stricter limit. */
  readonly timeoutMs?: number;
}

export interface BrowserAttachedFrame {
  /** Flattened CDP session used to address the out-of-process frame. */
  readonly sessionId: string;
  /** Chromium frame/target identity, stable for the attached document. */
  readonly frameId: string;
  /** Session that owns the iframe element; omitted for a direct child of the main page. */
  readonly parentSessionId?: string;
  readonly url?: string;
}

export interface BrowserPageLifecycle {
  readonly sessionId: string;
  /**
   * Attach the page. A provider without `jsDialogs` must return with the CDP
   * Page domain enabled on the page session (also after `resetConnection`):
   * Browser Core then learns about JavaScript dialogs only from
   * `Page.javascriptDialogOpening/Closed`.
   */
  start(signal?: AbortSignal): Promise<void>;
  /**
   * Reset the provider connection/session without closing the page.
   *
   * Browser Core uses this after a command timeout or cancellation. Providers
   * that do not need a reconnect may implement it as a no-op. `close()` is
   * reserved for permanently destroying the page and its provider resources.
   */
  resetConnection?(): Promise<void>;
  stopLoading(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Provider-neutral lower boundary for a browser page.
 *
 * The browser core only depends on this lifecycle/command contract. A
 * concrete provider owns the process and implements the transport (the
 * current provider is Headless Chrome over a DevTools WebSocket).
 */
export interface BrowserTransport extends BrowserPageLifecycle {
  /** Provider-owned directory used for completed browser downloads. */
  readonly downloadDirectory?: string;
  /**
   * Open a sibling page within the same provider-owned browser/profile.
   * The returned page is started and ready for Browser Core actions.
   */
  openTab?(url: string): Promise<BrowserTransport>;
  /**
   * Send one protocol command.
   *
   * Providers must reject caller cancellation with `code: "ABORTED"` and a
   * command deadline with `code: "BROWSER_OPERATION_TIMEOUT"`. Browser Core
   * uses these structured codes to reset a connection whose late command may
   * still reach Chromium.
   */
  send<T = unknown>(
    method: string,
    params?: BrowserTransportCommandParams,
    sessionId?: string,
    options?: BrowserTransportCommandOptions,
  ): Promise<T>;
  evaluate<T = unknown>(expression: string, options?: BrowserEvaluateOptions): Promise<T>;
  /**
   * Evaluate in every currently attached frame execution context.
   *
   * Electron implements this through WebFrameMain while the native provider
   * routes through attached CDP target sessions. Browser Core uses it only for
   * probes whose result must include OOPIFs (for example drag-start state).
   */
  evaluateInAllFrames?<T = unknown>(
    expression: string,
    options?: BrowserEvaluateOptions,
  ): Promise<readonly T[]>;
  /** Current flattened OOPIF sessions attached below this page. */
  listAttachedFrames?(): readonly BrowserAttachedFrame[];
  /**
   * Provider-owned JavaScript dialog source. Providers whose dialogs cannot be
   * suppressed through CDP alone (Electron) supply it; others omit it and
   * Browser Core tracks dialogs through the CDP Page domain.
   */
  readonly jsDialogs?: BrowserJsDialogSource;
  /**
   * CDP-tracked providers only: `Page.javascriptDialogOpening` params of a
   * dialog that is still open and was observed before this Browser Core
   * session subscribed to events (a popup that opened a dialog while loading,
   * before the first Agent action). Chromium reports a dialog only once, so
   * the session's dialog tracker starts from it.
   */
  pendingJavaScriptDialog?(): Record<string, unknown> | undefined;
  onEvent(listener: BrowserTransportEventListener): () => void;
  waitForEvent(
    method: string,
    timeoutMs?: number,
    options?: Pick<BrowserTransportCommandOptions, 'signal'>,
  ): Promise<unknown>;
}

/** Backward-compatible name used by the native-headless test seam. */
export type CdpTransport = BrowserTransport;
