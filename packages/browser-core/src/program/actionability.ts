import { attachSnapshotRefs } from '../browser-selector-candidates.js';
import { diagnoseSelectorMiss } from '../browser-selector-diagnostics.js';
import { delay, isRecord, type BrowserSessionState } from '../browser-state.js';
import { isBrowserOperationInterruption } from '../operation-timeout.js';
import {
  BrowserProgramError,
  locatorAmbiguous,
  locatorNotFound,
  notActionable,
  programCandidateFromSelector,
  type ProgramBlockerControl,
  type ProgramCandidate,
  type ProgramNotActionableFacts,
  type ProgramNotActionableReason,
} from './errors.js';
import { callAtLocator, callProgramPage } from './locator-resolver.js';
import type { ProgramPageRequest, ProgramPageResponse } from './page-script.js';
import { describeProgramLocator, type ProgramLocator } from './types.js';

const NARROWING_STEPS: ReadonlySet<string> = new Set(['css', 'nth', 'filter']);
const MAX_BLOCKER_TAG_CHARS = 24;
const MAX_BLOCKER_TEXT_CHARS = 60;
const RETRY_INTERVAL_MS = 50;
const MAX_RETRY_INTERVAL_MS = 100;

/**
 * Waits for a main-frame load in progress to commit: renderer commands hang
 * until then, so a poll must not run into its command deadline. A load still
 * pending at the deadline fails the op as PAGE_LOADING.
 */
export async function awaitMainFrameCommit(
  state: BrowserSessionState,
  deadline: number,
): Promise<void> {
  const load = state.mainFrameLoad;
  if (!load?.pending) return;
  const committed = await load.waitForCommit(deadline - Date.now(), state.commandSignal);
  if (!committed && load.pending) {
    throw new BrowserProgramError(
      'PAGE_LOADING',
      `The page is still loading a new document${load.pending.url ? ` (${load.pending.url})` : ''}.`,
      {
        // The guest page has waitForLoadState (Playwright's name), not waitForLoad.
        recovery:
          'Wait with page.waitForLoadState("load", { timeout }) and do not repeat the click or submit that started this load.',
      },
    );
  }
}

/** Context loss while the page navigates is one more failed attempt, not a failure. */
export function isRetryablePageError(error: unknown): boolean {
  if (isBrowserOperationInterruption(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  return /context was destroyed|Cannot find context|Inspected target navigated|No frame|frame with the given id/iu.test(
    message,
  );
}

function strictFailure(
  response: ProgramPageResponse,
  target: string,
): BrowserProgramError | undefined {
  if (response.error === 'ambiguous') {
    return locatorAmbiguous(
      target,
      typeof response.count === 'number' ? response.count : 0,
      (response.candidates ?? []) as readonly ProgramCandidate[],
    );
  }
  if (response.error === 'invalid') {
    return new BrowserProgramError(
      'LOCATOR_INVALID',
      `${target}: ${response.message ?? 'the locator is invalid'}`,
      {
        recovery:
          'Fix the selector. page.locator() takes CSS, a selector list (a, b), "text=…" and the pseudo-classes :has-text(), :text(), :text-is() and :visible; it has no XPath or other Playwright selector engines (>>, nth=, internal:).',
      },
    );
  }
  return undefined;
}

/**
 * For a locator that matched nothing: up to 5 elements whose name or text
 * resembles what it asked for, with their actual role. Best effort; a failure
 * here leaves the error without candidates.
 */
async function similarElements(
  state: BrowserSessionState,
  locator: ProgramLocator,
): Promise<readonly ProgramCandidate[]> {
  if (locator.chain[0]?.by === 'ref') return [];
  try {
    const response = await callProgramPage(state, { kind: 'near', chain: locator.chain });
    return Array.isArray(response.candidates)
      ? (response.candidates as readonly ProgramCandidate[])
      : [];
  } catch (error) {
    if (isBrowserOperationInterruption(error)) throw error;
    return [];
  }
}

/**
 * Repeats a page request until it answers `ok` or the timeout ends: the element
 * may not exist yet, may be hidden, disabled, moving or covered. Strict-mode
 * ambiguity and an invalid selector fail at once; waiting cannot fix them.
 */
export async function retryUntilOk(
  state: BrowserSessionState,
  locator: ProgramLocator,
  request: ProgramPageRequest,
  timeoutMs: number,
  selectMutation?: string,
): Promise<ProgramPageResponse> {
  const target = describeProgramLocator(locator);
  const deadline = Date.now() + timeoutMs;
  let last: ProgramPageResponse = { error: 'not_found' };
  let interval = 0;
  for (;;) {
    await awaitMainFrameCommit(state, Math.max(deadline, Date.now() + 1));
    try {
      last = await callAtLocator(state, locator, request, selectMutation);
    } catch (error) {
      if (!isRetryablePageError(error)) throw error;
      last = { error: 'not_found' };
    }
    if (last.ok === true) return last;
    const refused = strictFailure(last, target);
    if (refused) throw refused;
    if (Date.now() >= deadline) break;
    // Stability already waited a frame in the page.
    if (last.reason !== 'unstable') {
      await delay(Math.min(interval, Math.max(0, deadline - Date.now())), state.commandSignal);
      interval = Math.min(MAX_RETRY_INTERVAL_MS, interval + RETRY_INTERVAL_MS);
    }
  }
  if (last.error === 'not_found' || last.reason === undefined) {
    // A locator built only from CSS is a selector miss like any other; role and
    // text locators have no selector words to compare, so they get the elements
    // whose name resembles what they asked for.
    // `nth` and `filter` only narrow what the selector matched.
    const selectors = locator.chain.flatMap((step) => (step.by === 'css' ? [step.selector] : []));
    const namesElement = locator.chain.some((step) => !NARROWING_STEPS.has(step.by));
    if (namesElement || selectors.length === 0) {
      throw locatorNotFound(target, timeoutMs, await similarElements(state, locator));
    }
    const { candidates } = await diagnoseSelectorMiss(state, selectors.join(' '));
    throw locatorNotFound(target, timeoutMs, candidates?.map(programCandidateFromSelector));
  }
  const reason = last.reason as ProgramNotActionableReason;
  throw notActionable(
    target,
    reason,
    timeoutMs,
    await withBlockerControls(state, notActionableFacts(last), reason, (explain) =>
      callAtLocator(state, locator, explain),
    ),
  );
}

/**
 * Adds to a blocked target's facts what its page offers: the toggle of a
 * collapsed container, the close control of what covers it, the empty required
 * fields of a disabled control. Asked once, at the end, because a retry loop
 * should not pay for it on every poll. Best effort.
 */
export async function withBlockerControls(
  state: BrowserSessionState,
  facts: ProgramNotActionableFacts,
  reason: ProgramNotActionableReason,
  call: (request: ProgramPageRequest) => Promise<ProgramPageResponse>,
): Promise<ProgramNotActionableFacts> {
  try {
    const answer = await call({ kind: 'explain', reason });
    const opener = blockerControl(answer.opener);
    const closer = blockerControl(answer.closer);
    const missing = Array.isArray(answer.missing)
      ? answer.missing.flatMap((field) => blockerControl(field) ?? [])
      : [];
    await attachSnapshotRefs(state, [
      ...(opener ? [opener] : []),
      ...(closer ? [closer] : []),
      ...missing,
    ]);
    return {
      ...facts,
      ...(opener ? { opener } : {}),
      ...(closer ? { closer } : {}),
      ...(answer.closable === false ? { closable: false as const } : {}),
      ...(missing.length > 0 ? { missing } : {}),
    };
  } catch (error) {
    if (isBrowserOperationInterruption(error)) throw error;
    return facts;
  }
}

/** Page output is untrusted: only the expected fields, bounded, survive. */
function blockerControl(value: unknown): ProgramBlockerControl | undefined {
  if (!isRecord(value) || typeof value.tag !== 'string') return undefined;
  return {
    tag: value.tag.slice(0, MAX_BLOCKER_TAG_CHARS),
    ...(typeof value.text === 'string'
      ? { text: value.text.slice(0, MAX_BLOCKER_TEXT_CHARS) }
      : {}),
    ...(typeof value.selector === 'string' ? { selector: value.selector } : {}),
    ...(value.guessed === true ? { guessed: true as const } : {}),
  };
}

/** The probe's description of why a target cannot take the pointer. */
export function notActionableFacts(response: ProgramPageResponse): ProgramNotActionableFacts {
  return {
    ...(typeof response.coveredBy === 'string' ? { coveredBy: response.coveredBy } : {}),
    ...(typeof response.hiddenBy === 'string' ? { hiddenBy: response.hiddenBy } : {}),
    ...(response.collapsed === true ? { collapsed: true } : {}),
    ...(typeof response.href === 'string' ? { href: response.href } : {}),
  };
}

/** A single page request whose only retry reason is a document still parsing. */
export async function callOnceReady(
  state: BrowserSessionState,
  locator: ProgramLocator,
  request: ProgramPageRequest,
  timeoutMs: number,
  isEmpty: (response: ProgramPageResponse) => boolean,
): Promise<ProgramPageResponse> {
  const target = describeProgramLocator(locator);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await awaitMainFrameCommit(state, Math.max(deadline, Date.now() + 1));
    let response: ProgramPageResponse | undefined;
    try {
      response = await callAtLocator(state, locator, request);
    } catch (error) {
      if (!isRetryablePageError(error)) throw error;
    }
    if (response) {
      const refused = strictFailure(response, target);
      if (refused) throw refused;
      if (!isEmpty(response) || response.readyState !== 'loading' || Date.now() >= deadline) {
        return response;
      }
    } else if (Date.now() >= deadline) {
      throw locatorNotFound(target, timeoutMs);
    }
    await delay(RETRY_INTERVAL_MS, state.commandSignal);
  }
}
