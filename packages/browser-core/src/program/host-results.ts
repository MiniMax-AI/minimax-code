import {
  readBrowserTabId,
  type BrowserTabFailure,
  type BrowserTabFailureCode,
} from '../browser-tabs.js';
import { browserErrorTripleResult } from '../browser-errors.js';
import { browserUserTakeoverError } from '../tabs/agent-browser-control.js';
import { BrowserProgramError, programFailureFrom } from './errors.js';
import { describeProgramLocator, parseProgramOp } from './types.js';

/**
 * Browser programs (run_script on a PTC Turn) on any provider: the internal
 * `program_op` action carries one page operation of the program. These
 * helpers shape a provider's answers like Browser Core's own op results, so
 * the program library reads tab ops, a missing tab and a thrown failure the
 * same way as a page op.
 */

/**
 * How long a click whose target opens a new tab waits for that page to start
 * opening; a page already opening is waited for like any page an Agent action opens.
 */
export const PROGRAM_POPUP_WAIT_MS = 2_000;
export const PROGRAM_POPUP_POLL_MS = 25;

/** Tab ops run on the session's tab registry, not on a page. */
/**
 * What a carryover mark tells the model, on both providers: mark_tab's wording
 * for single steps, page.keep()'s for programs.
 */
export const CARRYOVER_NOTICE =
  "Kept for the next turn only: there it is listed as temporary again and closes at that turn's end unless you select_tab it and mark it again.";
export const PROGRAM_CARRYOVER_NOTICE =
  "Kept for the next turn only: there it is temporary again and closes at that turn's end unless you call keep() on it again.";

export const PROGRAM_TAB_OPS: Readonly<Record<string, true>> = {
  newPage: true,
  tabs: true,
  selectTab: true,
  closeTab: true,
  keep: true,
  show: true,
};

/**
 * The `keep` op (`page.keep({ deliverable })`): mark_tab on the program path,
 * carryover by default, deliverable when asked. The host applies mark_tab's rules.
 */
export function readProgramKeepOp(op: Readonly<Record<string, unknown>>): {
  readonly tabId: number;
  readonly retention: 'carryover' | 'deliverable';
} {
  const tabId = readBrowserTabId(op);
  if (tabId === null) {
    throw new BrowserProgramError('INVALID_OP', 'keep needs the tabId of a page.', {
      recovery:
        'Call keep() on a page from browser.page(), browser.tabs() or browser.newPage(url).',
    });
  }
  return { tabId, retention: op.deliverable === true ? 'deliverable' : 'carryover' };
}

const PROGRAM_TAB_RECOVERY: Readonly<Record<BrowserTabFailureCode, string>> = {
  TAB_NOT_FOUND:
    'The page is closed (pages a program opened close when the turn ends unless page.keep() kept them). Call browser.tabs() for the open pages, or open one with browser.newPage(url).',
  TAB_LIMIT_REACHED:
    'Call browser.tabs(), close a page you no longer need with page.close(), then retry.',
};

/** A tab failure in a program's words: browser.tabs(), newPage() and page.close(), not tab actions. */
export function programTabFailure(
  code: BrowserTabFailureCode,
  tabId: number | null,
): BrowserTabFailure {
  const reason =
    code === 'TAB_NOT_FOUND'
      ? `No open page in this session has tabId ${tabId ?? 'null'}.`
      : 'This session already keeps the maximum number of Browser pages.';
  return {
    ...browserErrorTripleResult({ code, reason, next: PROGRAM_TAB_RECOVERY[code] }),
    code,
    tabId,
  };
}

/**
 * TAB_NOT_CONTROLLED on the program path: a write on a page the Agent does
 * not control (a user's page, or none controlled). A program takes control
 * with page.bringToFront(), not select_tab.
 */
export function programTabNotControlledError(tabId: number | null): BrowserProgramError {
  return new BrowserProgramError(
    'TAB_NOT_CONTROLLED',
    tabId === null
      ? 'No page is under Agent control, so a program cannot write.'
      : `Page ${tabId} is the user's page and not under Agent control, so a program cannot write it.`,
    {
      recovery:
        tabId === null
          ? 'Pick a page from browser.tabs() and call page.bringToFront() on it, or open one with browser.newPage(url).'
          : 'Call page.bringToFront() on it first to take control, or open your own page with browser.newPage(url).',
    },
  );
}

/**
 * page.close() on a page the Agent did not open (the user's page, or a Mini
 * App page the user opened): a program closes only the pages it opened.
 * close_tab, an explicit tab action, is not refused.
 */
export function programCloseNotOwnedFailure(tabId: number): {
  success: false;
  code: string;
  error: string;
  recovery: string;
  tabId: number;
} {
  return {
    ...browserErrorTripleResult({
      code: 'TAB_NOT_CONTROLLED',
      reason: `Page ${tabId} is the user's page, so a program does not close it.`,
      next: "Leave the user's page open; close only pages you opened (browser.newPage(url) or a popup your click opened).",
    }),
    tabId,
  };
}

/** The tab a page op names (its own `tabId`, else its locator's); null for the current tab. */
export function programOpTabId(op: Record<string, unknown>): number | null {
  const own = readBrowserTabId(op);
  if (own !== null) return own;
  const target = op.target;
  return target && typeof target === 'object' && !Array.isArray(target)
    ? readBrowserTabId(target as Record<string, unknown>)
    : null;
}

/**
 * What a step the host answered itself acted on: the locator as the program
 * wrote it, so a refused write still names its target. Empty without a valid one.
 */
function hostStepTarget(rawOp: Readonly<Record<string, unknown>> | undefined): {
  readonly target?: string;
} {
  if (!rawOp || rawOp.target === undefined) return {};
  try {
    const parsed = parseProgramOp(rawOp);
    return 'target' in parsed && parsed.target
      ? { target: describeProgramLocator(parsed.target) }
      : {};
  } catch {
    return {};
  }
}

/**
 * A tab op's host result (or a tab failure) as a program op result. `rawOp`,
 * the op as the program sent it, names a page op's target on its step.
 */
export function programTabResult(
  op: string,
  result: unknown,
  startedAt: number,
  rawOp?: Readonly<Record<string, unknown>>,
): unknown {
  const record =
    result && typeof result === 'object' && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : {};
  const step = { op, write: false, durationMs: Date.now() - startedAt, ...hostStepTarget(rawOp) };
  if (record.success === false) {
    const code = typeof record.code === 'string' ? record.code : 'BROWSER_OP_FAILED';
    const reason = typeof record.error === 'string' ? record.error : 'The tab operation failed.';
    return {
      ok: false,
      error: {
        code,
        message: reason.startsWith(`${code}:`) ? reason : `${code}: ${reason}`,
        retryable: false,
        ...(typeof record.recovery === 'string' ? { recovery: record.recovery } : {}),
      },
      step: { ...step, code },
    };
  }
  return { ok: true, value: record, step };
}

/** A thrown host failure as a program op result: a program op never throws. */
export function programThrownResult(
  op: string,
  error: unknown,
  startedAt: number,
  rawOp?: Readonly<Record<string, unknown>>,
): unknown {
  const failure = programFailureFrom(error);
  return {
    ok: false,
    error: failure,
    step: {
      op,
      write: false,
      durationMs: Date.now() - startedAt,
      ...hostStepTarget(rawOp),
      code: failure.code,
    },
  };
}

/**
 * BROWSER_USER_TAKEOVER for an op the user's takeover interrupted. A write
 * Browser Core already ran (`ran`: its op result) keeps its step and becomes
 * outcome unknown: it may have landed, so it is never reported as not written.
 */
export function programUserTakeoverResult(
  op: string,
  ran: unknown,
  startedAt: number,
  rawOp?: Readonly<Record<string, unknown>>,
): unknown {
  const record =
    ran && typeof ran === 'object' && !Array.isArray(ran) ? (ran as Record<string, unknown>) : {};
  const step =
    record.step && typeof record.step === 'object' && !Array.isArray(record.step)
      ? (record.step as Record<string, unknown>)
      : undefined;
  if (step?.write !== true) {
    return programThrownResult(op, browserUserTakeoverError(), startedAt, rawOp);
  }
  const failure = programFailureFrom(browserUserTakeoverError());
  return {
    ok: false,
    error: {
      ...failure,
      writeOutcomeUnknown: true,
      recovery: `The ${op} may already have taken effect; the user has the Browser now.`,
    },
    step: { ...step, outcome: 'uncertain', code: failure.code },
  };
}
