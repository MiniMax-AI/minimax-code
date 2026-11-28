/**
 * Messages between the Browser program executor and its Worker. The Worker
 * loads this module, so it must not import anything at runtime.
 */

/** What `state` held when the program ended; an error keeps the earlier state. */
export type BrowserProgramStateCapture =
  | { readonly json: string; readonly error?: undefined }
  | { readonly json?: undefined; readonly error: string };

export interface BrowserProgramFailure {
  /**
   * `browser`: a page operation failed and the program did not catch it;
   * `guest`: any other exception (syntax, TypeError); `timeout` and `memory`:
   * a limit ended the guest.
   */
  readonly kind: 'browser' | 'guest' | 'timeout' | 'memory';
  readonly name: string;
  readonly message: string;
  readonly code?: string;
  readonly recovery?: string;
  /** Line in the model's code. */
  readonly line?: number;
  /** Syntax errors: the column in that line, and the line with a marker under the error. */
  readonly column?: number;
  readonly snippet?: string;
}

export interface BrowserProgramStartMessage {
  readonly type: 'start';
  readonly code: string;
  readonly initialStateJson?: string;
  readonly maxHeapBytes: number;
  readonly deadlineAt: number;
}

interface BrowserProgramOpResultMessage {
  readonly type: 'op_result';
  readonly id: number;
  readonly resultJson: string;
}

export type BrowserProgramInboundMessage =
  | BrowserProgramStartMessage
  | BrowserProgramOpResultMessage;

interface BrowserProgramOpMessage {
  readonly type: 'op';
  readonly id: number;
  readonly opJson: string;
}

interface BrowserProgramConsoleMessage {
  readonly type: 'console';
  readonly line: string;
}

export interface BrowserProgramDoneMessage {
  readonly type: 'done';
  readonly ok: boolean;
  readonly valueJson?: string;
  readonly error?: BrowserProgramFailure;
  readonly state?: BrowserProgramStateCapture;
  /** Worker-side time from each op request to its answer, summed. */
  readonly opRoundTripMs: number;
  /** Freeing QuickJS failed after the result was computed; the host only logs it. */
  readonly disposeFailure?: string;
}

export type BrowserProgramOutboundMessage =
  | BrowserProgramOpMessage
  | BrowserProgramConsoleMessage
  | BrowserProgramDoneMessage;
