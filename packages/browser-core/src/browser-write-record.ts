import { formatBrowserErrorTriple } from './browser-errors.js';
import { asString, isRecord } from './browser-state.js';
import { isBrowserOperationInterruption } from './operation-timeout.js';

/**
 * The most recent page write of a Browser Core session (one per page), and
 * whether its outcome is known. A write whose outcome is uncertain (it timed
 * out, its page load had not finished, or it moved the page unexpectedly)
 * may already have taken effect on the site: repeating it before reading the
 * page can submit twice. The next write on the same target carries
 * `writeRetryWarning` (refused in a program or after page JavaScript); a
 * successful read of the page clears it, unless a main-frame load is still
 * pending (the page shown is then the one from before that load) or the
 * "read" was a timer.
 */

/**
 * Actions that write to the page. Same list as the online metric
 * `browser_write_action_total` (local-runtime-observability.md §10.4).
 */
export const BROWSER_WRITE_ACTIONS: Readonly<Record<string, true>> = {
  click: true,
  click_and_wait_for_navigation: true,
  double_click: true,
  triple_click: true,
  drag: true,
  fill: true,
  type: true,
  paste: true,
  press_key: true,
  check: true,
  uncheck: true,
  select_option: true,
  upload_files: true,
};

export type BrowserWriteOutcome = 'succeeded' | 'failed' | 'uncertain';

export type BrowserUncertainWriteReason =
  /** The action deadline or a provider command deadline ended the write. */
  | 'timeout'
  /** The write was cancelled while it ran. */
  | 'interrupted'
  /** The write started a main-document load that had not committed when it returned. */
  | 'navigation_pending'
  /** The write moved the page in a way that may have a side effect. */
  | 'unexpected_navigation'
  /** The write failed after the server had already answered a request it triggered. */
  | 'server_answered'
  /** Page JavaScript sent a non-GET request, submitted a form or navigated. */
  | 'page_script'
  /**
   * A check or uncheck was dispatched and the control does not show the state
   * yet: a control that follows a server answer may still apply it.
   */
  | 'state_unconfirmed'
  /**
   * Text was sent and the field could not be read back, or a type changed the
   * field into something else than the typed text: typing again appends it twice.
   */
  | 'input_unconfirmed';

export interface BrowserWriteRecord {
  readonly action: string;
  /** The locator the write used (`ref …`, `selector …`, `position …`, or `focused element`). */
  readonly target: string;
  /** Visible text of the target element when the ref resolved to a known element. */
  readonly targetLabel?: string;
  /** The key a press_key sent: a press of another key is a different write. */
  readonly key?: string;
  /** The page URL when the write started. */
  readonly url?: string;
  /** When the write ended (epoch ms). */
  readonly at: number;
  readonly outcome: BrowserWriteOutcome;
  readonly reason?: BrowserUncertainWriteReason;
  /** A successful read of the page happened after the write. */
  readonly verified: boolean;
  /** Page JavaScript has no single target: until a read, every next write repeats it. */
  readonly anyTarget?: true;
}

/** Actions whose successful result shows the model the page as it is now. */
export const BROWSER_PAGE_READ_ACTIONS: Readonly<Record<string, true>> = {
  inspect: true,
  query: true,
  get_dom: true,
  inspect_editable_targets: true,
  screenshot: true,
  verify_text: true,
  wait: true,
  wait_for: true,
};

const UNCERTAIN_REASON_TEXT: Record<BrowserUncertainWriteReason, string> = {
  timeout: 'it timed out',
  interrupted: 'it was cancelled while it ran',
  navigation_pending: 'the page load it started had not finished',
  unexpected_navigation: 'it changed the page unexpectedly',
  server_answered: 'it failed after the server had already answered its request',
  page_script: 'page JavaScript sent a write request, submitted a form or navigated',
  state_unconfirmed: 'the control did not show the new state when it returned',
  input_unconfirmed: 'its text was sent, but the field could not be confirmed to hold it',
};

const MAX_TARGET_TEXT = 200;
const MAX_LABEL_TEXT = 80;

/** The one "verify before repeating" sentence every uncertain write result carries. */
export function uncertainWriteNext(action: string): string {
  return `The ${action} may already have taken effect. Read the page (inspect, query or screenshot) and check its result before repeating it; do not repeat it just to find out whether it landed.`;
}

/**
 * Retry semantics of a write that ended on an unexpected navigation. Only a
 * navigation that started before any input was sent, and was not a form
 * submission (non-GET), is free of side effects and safe to retry.
 */
export function unexpectedNavigationRetry(
  action: string,
  facts: { readonly dispatched: boolean; readonly requestMethod?: string },
): { retryable: boolean; recovery: string } {
  const method = facts.requestMethod?.toUpperCase();
  if (!facts.dispatched && (method === undefined || method === 'GET')) {
    return {
      retryable: true,
      recovery: `The page changed before the ${action} sent any input, so it did not run. Inspect the current page and retry with a newly observed target if it still applies.`,
    };
  }
  return {
    retryable: false,
    recovery: `${method && method !== 'GET' ? `The page sent a ${method} request. ` : ''}${uncertainWriteNext(action)}`,
  };
}

function locatorKey(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const frame = asString(value.frame);
  const scope = frame ? `frame ${frame} ` : '';
  const ref = asString(value.ref);
  if (ref) return `${scope}ref ${ref}`;
  const selector = asString(value.selector);
  if (selector) return `${scope}selector ${selector}`;
  for (const key of ['position', 'normalized_position'] as const) {
    const point = value[key];
    if (isRecord(point) && typeof point.x === 'number' && typeof point.y === 'number') {
      return `${key} ${point.x},${point.y}`;
    }
  }
  return undefined;
}

/** The target identity two writes share when the second repeats the first. */
export function browserWriteTarget(action: string, input: Record<string, unknown>): string {
  const target =
    action === 'drag'
      ? `${locatorKey(input.source) ?? 'unknown'} -> ${locatorKey(input.target) ?? 'unknown'}`
      : (locatorKey(input) ?? 'focused element');
  return target.slice(0, MAX_TARGET_TEXT);
}

/** Outcome of a write that returned a result. */
export function classifyBrowserWriteResult(result: unknown): {
  outcome: BrowserWriteOutcome;
  reason?: BrowserUncertainWriteReason;
} {
  if (!isRecord(result)) return { outcome: 'succeeded' };
  if (result.code === 'UNEXPECTED_NAVIGATION') {
    return result.retryable === true
      ? { outcome: 'failed' }
      : { outcome: 'uncertain', reason: 'unexpected_navigation' };
  }
  const navigation = isRecord(result.navigation) ? result.navigation : {};
  // A write refused with PAGE_LOADING never gets here: it did not run.
  if (navigation.pending === true) {
    return { outcome: 'uncertain', reason: 'navigation_pending' };
  }
  const effect = isRecord(result.effect) ? result.effect : {};
  if (result.success === false && result.code === 'ACTION_TIMEOUT' && effect.dispatched === true) {
    return { outcome: 'uncertain', reason: 'timeout' };
  }
  // click_and_wait_for_navigation failed after its navigation committed.
  if (result.code === 'NAVIGATION_FAILED' && navigation.detected === true) {
    return { outcome: 'uncertain', reason: 'server_answered' };
  }
  // A dispatched check whose control does not show the state (yet): the page
  // may apply it when its server answers, and a repeat would toggle it back.
  if (
    (result.code === 'CHECK_STATE_NOT_APPLIED' || result.code === 'CHECK_STATE_UNCONFIRMED') &&
    effect.dispatched === true
  ) {
    return { outcome: 'uncertain', reason: 'state_unconfirmed' };
  }
  // Typed text went out and the field could not be read back, the type
  // reported the text in a field that does not show it (`effect.appended`), or
  // the text went to the field focus moved to (`effect.inputElsewhere`):
  // typing again appends it twice.
  if (
    result.success === false &&
    effect.dispatched === true &&
    (result.code === 'ACTION_VERIFICATION_UNAVAILABLE' ||
      effect.appended === true ||
      effect.inputElsewhere === true)
  ) {
    return { outcome: 'uncertain', reason: 'input_unconfirmed' };
  }
  return { outcome: result.success === false ? 'failed' : 'succeeded' };
}

/** Outcome of a write that threw after it started running. */
export function classifyBrowserWriteError(
  error: unknown,
  facts: {
    readonly aborted: boolean;
    readonly timedOut: boolean;
    readonly serverAnswered: boolean;
  },
): { outcome: BrowserWriteOutcome; reason?: BrowserUncertainWriteReason } {
  if (facts.aborted)
    return { outcome: 'uncertain', reason: facts.timedOut ? 'timeout' : 'interrupted' };
  const message = error instanceof Error ? error.message : String(error);
  if (/^ACTION_TIMEOUT:/u.test(message) || isBrowserOperationInterruption(error)) {
    return { outcome: 'uncertain', reason: 'timeout' };
  }
  if (facts.serverAnswered) return { outcome: 'uncertain', reason: 'server_answered' };
  return { outcome: 'failed' };
}

function describePrevious(previous: BrowserWriteRecord): string {
  const label = previous.targetLabel ? ` ("${previous.targetLabel}")` : '';
  const reason = previous.reason ? UNCERTAIN_REASON_TEXT[previous.reason] : 'its result is unknown';
  return `The previous ${previous.action} on ${previous.target}${label} has an uncertain result (${reason}) and the page has not been read since`;
}

const UNVERIFIED_RETRY_NEXT =
  'Read the page first (inspect, query or screenshot) and check whether the earlier action took effect; to repeat it on purpose, call the action again with input.confirmRetry: true.';

/**
 * UNVERIFIED_WRITE_RETRY for a refused write (not retryable as is): in a
 * program, or after page JavaScript.
 */
export function unverifiedWriteRetryError(action: string, previous: BrowserWriteRecord): Error {
  return new Error(
    formatBrowserErrorTriple({
      code: 'UNVERIFIED_WRITE_RETRY',
      reason: `${describePrevious(previous)}. The ${action} did not run.`,
      next: UNVERIFIED_RETRY_NEXT,
    }),
  );
}

/** Structured warning on a single-step write that repeated an unverified uncertain write. */
export function unverifiedWriteRetryWarning(
  action: string,
  previous: BrowserWriteRecord,
): Record<string, unknown> {
  return {
    code: 'UNVERIFIED_WRITE_RETRY',
    message: `${describePrevious(previous)}; this ${action} ran anyway and may have repeated it. Read the page and check the result before writing again.`,
    previous: {
      action: previous.action,
      target: previous.target,
      ...(previous.targetLabel ? { targetLabel: previous.targetLabel } : {}),
      ...(previous.reason ? { reason: previous.reason } : {}),
      at: new Date(previous.at).toISOString(),
    },
  };
}

export class BrowserWriteLedger {
  private latest: BrowserWriteRecord | undefined;
  /** The latest uncertain write that no read has verified yet. */
  private unverified: BrowserWriteRecord | undefined;
  /** The next new document is the unverified write's own result, not another page. */
  private awaitsOwnDocument = false;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly loadPending: () => boolean = () => false,
  ) {}

  get last(): BrowserWriteRecord | undefined {
    return this.latest;
  }

  /** The unverified uncertain write that this write would repeat, unless confirmed. */
  repeatedBy(action: string, input: Record<string, unknown>): BrowserWriteRecord | undefined {
    const previous = this.unverified;
    if (!previous || BROWSER_WRITE_ACTIONS[action] !== true || input.confirmRetry === true) {
      return undefined;
    }
    if (previous.anyTarget === true) return previous;
    if (previous.target !== browserWriteTarget(action, input)) return undefined;
    // Escape after an uncertain Enter on the same element does not repeat it.
    if (previous.action === 'press_key' && action === 'press_key') {
      return previous.key === asString(input.key) ? previous : undefined;
    }
    return previous;
  }

  record(
    action: string,
    input: Record<string, unknown>,
    outcome: { outcome: BrowserWriteOutcome; reason?: BrowserUncertainWriteReason },
    page: {
      readonly url?: string;
      readonly targetLabel?: string;
      readonly anyTarget?: boolean;
    } = {},
  ): BrowserWriteRecord {
    const record: BrowserWriteRecord = {
      action,
      target: page.anyTarget === true ? 'the page' : browserWriteTarget(action, input),
      ...(page.targetLabel ? { targetLabel: page.targetLabel.slice(0, MAX_LABEL_TEXT) } : {}),
      ...(action === 'press_key' && asString(input.key) ? { key: asString(input.key) } : {}),
      ...(page.url ? { url: page.url } : {}),
      at: this.now(),
      outcome: outcome.outcome,
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      verified: false,
      ...(page.anyTarget === true ? { anyTarget: true as const } : {}),
    };
    this.latest = record;
    // Only a read clears an unverified write: a later write on the same target,
    // confirmed or not, does not show whether the earlier one landed.
    if (record.outcome === 'uncertain') {
      this.unverified = record;
      this.awaitsOwnDocument = this.loadPending();
    }
    return record;
  }

  /** A provider learned after the fact that the latest write may have had a side effect. */
  markLastUncertain(reason: BrowserUncertainWriteReason): void {
    if (!this.latest) return;
    this.latest = { ...this.latest, outcome: 'uncertain', reason, verified: false };
    this.unverified = this.latest;
    this.awaitsOwnDocument = false;
  }

  /** A successful read showed the page as it is now. */
  pageRead(): void {
    if (this.latest && !this.latest.verified) this.latest = { ...this.latest, verified: true };
    this.unverified = undefined;
  }

  /** The Agent asked for another page: any document from now on is not the write's result. */
  navigationStarted(): void {
    this.awaitsOwnDocument = false;
  }

  /**
   * The main frame committed a new document. The page the unverified write
   * was loading is its result and still has to be read. Any other document is a
   * different page: the same locator there is a new write, not a repeat.
   */
  documentCommitted(): void {
    if (this.awaitsOwnDocument) this.awaitsOwnDocument = false;
    else this.unverified = undefined;
  }
}
