import { answeredGetLoad, MainFrameNavigationPending } from './browser-main-frame-load.js';
import { asString, cdp, isRecord, type BrowserSessionState } from './browser-state.js';
import type { BrowserTransportEvent } from './browser-transport.js';

/**
 * After an input, how long a main-frame navigation may take to show up in
 * browser events. It ends at the first event, so only an input that does not
 * navigate spends all of it.
 */
const NAVIGATION_DETECTION_MS = 40;
/** A requested navigation that has not started loading yet gets this much longer to start. */
const NAVIGATION_START_MS = 200;

/** What browser events showed about a main-frame navigation after an input. */
export interface MainFrameNavigationFacts {
  readonly detected: boolean;
  readonly url?: string;
  readonly sameDocument?: true;
  readonly committed?: true;
}

export interface MainFrameNavigationWatch {
  /** Waits briefly for the navigation the input may have started; never reads the page. */
  settle(): Promise<MainFrameNavigationFacts>;
  dispose(): void;
}

/**
 * Main-frame events can only be attributed once the main frame id is known:
 * read it from the frame tree when the load record does not have it yet.
 */
export async function ensureMainFrameKnown(state: BrowserSessionState): Promise<void> {
  const load = state.mainFrameLoad;
  if (!load || load.mainFrameId || state.cdpHelper.getMainFrameId()) return;
  const tree = await cdp<{ frameTree?: { frame?: { id?: string } } }>(state, 'Page.getFrameTree');
  const id = tree.frameTree?.frame?.id;
  if (id) load.mainFrameId = id;
}

/**
 * Watches browser events only: a renderer command would hang on a navigation
 * in progress. Shared by the program ops and the element actions whose page
 * handlers can navigate (a select whose change handler loads another URL).
 */
export function watchMainFrameNavigation(state: BrowserSessionState): MainFrameNavigationWatch {
  let requested = false;
  let started = false;
  let committed: MainFrameNavigationFacts | undefined;
  let wake: (() => void) | undefined;
  const isMain = (event: BrowserTransportEvent, frameId: string): boolean => {
    const mainFrameId = state.cdpHelper.getMainFrameId() ?? state.mainFrameLoad?.mainFrameId;
    if (mainFrameId) return frameId === mainFrameId;
    return !event.sessionId || event.sessionId === state.transport.sessionId;
  };
  const dispose = state.transport.onEvent((event) => {
    const params = isRecord(event.params) ? event.params : {};
    const frame = isRecord(params.frame) ? params.frame : {};
    const frameId = asString(frame.id) || asString(params.frameId);
    switch (event.method) {
      case 'Page.frameRequestedNavigation':
        if (
          isMain(event, frameId) &&
          (params.disposition === undefined || params.disposition === 'currentTab')
        ) {
          requested = true;
          wake?.();
        }
        return;
      case 'Page.frameStartedLoading':
        if (isMain(event, frameId)) {
          started = true;
          wake?.();
        }
        return;
      case 'Page.frameNavigated':
        if (!asString(frame.parentId) && isMain(event, frameId)) {
          committed = { detected: true, committed: true, url: asString(frame.url) };
          wake?.();
        }
        return;
      case 'Page.navigatedWithinDocument':
        if (isMain(event, frameId)) {
          committed = { detected: true, sameDocument: true, url: asString(params.url) };
          wake?.();
        }
        break;
      default:
    }
  });
  const waitForEvent = async (ms: number, done: () => boolean): Promise<void> => {
    if (done()) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      wake = () => {
        if (!done()) return;
        clearTimeout(timer);
        resolve();
      };
    });
    wake = undefined;
  };
  return {
    settle: async () => {
      await waitForEvent(NAVIGATION_DETECTION_MS, () => requested || started || !!committed);
      if (requested && !started && !committed) {
        await waitForEvent(NAVIGATION_START_MS, () => started || !!committed);
      }
      return committed ?? { detected: requested || started };
    },
    dispose,
  };
}

/** Time kept before the command deadline to decide about a load that is still pending. */
const NAVIGATION_COMMAND_MARGIN_MS = 1_000;

/**
 * Sends Page.navigate or Page.reload. Page.navigate does not answer until the
 * new document commits, so on a page whose server answers a GET (a redirect,
 * or the response of a slow page) but delivers the document late, the command
 * used to run into its deadline, and the recovery reset the connection and
 * stopped the load. When such an answered GET load is still pending shortly
 * before the command deadline (or `budgetMs`), this throws
 * MainFrameNavigationPending instead; the browser keeps loading. Any other
 * outcome is the command's own.
 */
export async function sendMainFrameNavigationCommand<T>(
  state: BrowserSessionState,
  method: 'Page.navigate' | 'Page.reload',
  params: Record<string, unknown>,
  budgetMs: number,
): Promise<T> {
  const commandTimeoutMs = state.commandTimeoutMs;
  const decideAfterMs = Math.max(
    1,
    Math.min(budgetMs, (commandTimeoutMs ?? budgetMs) - NAVIGATION_COMMAND_MARGIN_MS),
  );
  const abort = new AbortController();
  const forwardAbort = (): void => abort.abort();
  if (state.commandSignal?.aborted) abort.abort();
  state.commandSignal?.addEventListener('abort', forwardAbort, { once: true });
  const command = state.transport.send<T>(method, params, undefined, {
    signal: abort.signal,
    ...(commandTimeoutMs ? { timeoutMs: commandTimeoutMs } : {}),
  });
  command.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([
      command.then((value) => ({ value })),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), decideAfterMs);
        timer.unref?.();
      }),
    ]);
    if (settled) return settled.value;
    const load = answeredGetLoad(state.mainFrameLoad?.pending);
    if (load) {
      // Settles the command here only; Chromium goes on loading the page.
      abort.abort();
      throw new MainFrameNavigationPending(load);
    }
    return await command;
  } finally {
    clearTimeout(timer);
    state.commandSignal?.removeEventListener('abort', forwardAbort);
  }
}
