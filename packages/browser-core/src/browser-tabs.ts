import { browserErrorTripleResult, type BrowserErrorTriple } from './browser-errors.js';

/**
 * Tab action results shared by every Browser provider. Providers own their
 * tabs; the shared AgentBrowserControl (tabs/agent-browser-control.ts) keeps
 * the lease, owners, openers and turn-end retention.
 */

export type BrowserTabFailureCode = 'TAB_NOT_FOUND' | 'TAB_LIMIT_REACHED';

export interface BrowserTabFailure {
  readonly success: false;
  readonly code: BrowserTabFailureCode;
  /** Why the tab action failed. */
  readonly error: string;
  /** What to do next. */
  readonly recovery: string;
  readonly tabId: number | null;
}

export const BROWSER_TAB_FAILURES: Record<
  BrowserTabFailureCode,
  Omit<BrowserErrorTriple, 'code'>
> = {
  TAB_NOT_FOUND: {
    reason: 'No open Browser tab in this session has that tabId.',
    next: 'Call list_tabs for the current tabs.',
  },
  TAB_LIMIT_REACHED: {
    reason: 'This session already keeps the maximum number of Browser tabs.',
    next: 'Call list_tabs, close a tab you no longer need with close_tab { tabId }, then retry.',
  },
};

export function browserTabFailure(
  code: BrowserTabFailureCode,
  tabId: number | null,
): BrowserTabFailure {
  return { ...browserErrorTripleResult({ code, ...BROWSER_TAB_FAILURES[code] }), code, tabId };
}

/** Reads the optional numeric `tabId` of a tab action input. */
export function readBrowserTabId(input: Record<string, unknown>): number | null {
  const value = input.tabId;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}
