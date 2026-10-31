import type { ToolResult } from '@mavis/agent-core/tools';

import type { LocalBrowserAdapter, LocalRuntimeToolContext } from './types.js';

// The observe read lives in its own file because local-browser.ts sits at the
// repository's source-file line limit.

const OBSERVE_DEFAULT_WAIT_MS = 5_000;
const OBSERVE_DEFAULT_TEXT_CHARS = 4_000;
/** Settle time before reading: the action's own settle covers sync DOM work, not async renders. */
const OBSERVE_SETTLE_MS = 300;
/**
 * Pause between attempts while the session is still busy. Each rejected
 * attempt costs the provider nothing (it is refused before touching the page),
 * so a short pause keeps the read close to the moment the session frees up.
 */
const OBSERVE_IDLE_RETRY_MS = 250;

export interface BrowserObserveRequest {
  readonly kind: 'inspect' | 'text';
  readonly selector?: string;
  readonly waitForText?: string;
  readonly timeout?: number;
  readonly maxChars?: number;
}

/**
 * The read that follows a successful page-changing action in the same call.
 * Uses the provider's own wait/inspect/query actions, so refs, redaction and
 * budgets are the same as a separate call; it adds no new page capability.
 *
 * The first step waits until the provider has released the session: an
 * abandoned post-action screenshot keeps Browser Core busy while it recovers,
 * and the Desktop broker has already reported that screenshot as finished by
 * then, so the caller's settle wait cannot see it. `idleWaitMs` bounds that wait.
 */
export async function observePage(
  observe: BrowserObserveRequest,
  adapter: LocalBrowserAdapter,
  ctx: LocalRuntimeToolContext,
  signal: AbortSignal,
  idleWaitMs: number,
): Promise<{ kind: 'inspect' | 'text'; result: unknown; waitTimedOut: boolean }> {
  const waitInput = observe.waitForText
    ? {
        kind: 'text',
        text: observe.waitForText,
        timeout: observe.timeout ?? OBSERVE_DEFAULT_WAIT_MS,
      }
    : { kind: 'timeout', timeout: OBSERVE_SETTLE_MS };
  const waited = await whenSessionIdle(
    () => adapter.execute(ctx, 'wait', waitInput, signal),
    signal,
    idleWaitMs,
  );
  const waitTimedOut = observe.waitForText ? !isRecord(waited) || waited.success !== true : false;
  if (observe.kind === 'inspect') {
    return {
      kind: 'inspect',
      result: await adapter.execute(ctx, 'inspect', {}, signal),
      waitTimedOut,
    };
  }
  const result = await adapter.execute(
    ctx,
    'query',
    {
      kind: 'text',
      ...(observe.selector ? { selector: observe.selector } : {}),
      maxChars: observe.maxChars ?? OBSERVE_DEFAULT_TEXT_CHARS,
    },
    signal,
  );
  return { kind: 'text', result, waitTimedOut };
}

/**
 * A read that throws (the session stayed busy past the bound, the transport
 * dropped) says nothing about whether the action ran. Shape it like a read that
 * returned a failure, so the observation carries `observationFailed` and the
 * action keeps its own result, the same way an UNEXPECTED_NAVIGATION click whose
 * new page could not be read is reported.
 */
export function observationReadFailure(
  toolName: string,
  observe: BrowserObserveRequest,
  error: unknown,
): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    (isRecord(error) && typeof error.code === 'string' ? error.code : undefined) ??
    /^([A-Z][A-Z0-9_]+):/u.exec(message)?.[1] ??
    'execution_failed';
  const action = observe.kind === 'inspect' ? 'inspect' : 'query';
  const result = { success: false, code, error: message };
  const text = JSON.stringify({ action, result });
  return {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
    details: { action, ok: false, result },
    isError: true,
  };
}

/**
 * Runs a read-only step, retrying while the provider reports the session busy,
 * until `idleWaitMs` has passed. Any other failure is returned at once.
 */
async function whenSessionIdle(
  run: () => Promise<unknown>,
  signal: AbortSignal,
  idleWaitMs: number,
): Promise<unknown> {
  const deadline = Date.now() + idleWaitMs;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (
        signal.aborted ||
        !isSessionBusy(error) ||
        Date.now() + OBSERVE_IDLE_RETRY_MS > deadline
      ) {
        throw error;
      }
      await pause(OBSERVE_IDLE_RETRY_MS, signal);
    }
  }
}

/**
 * Browser Core refuses an action with BROWSER_SESSION_BUSY while another one,
 * or the recovery of an abandoned one, still holds the session. In-process
 * providers pass that message through; the Desktop broker forwards it only as
 * its generic `browser_action_failed` code. The retried step is a read-only
 * wait, so treating both as busy cannot repeat a page side effect.
 */
function isSessionBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message.startsWith('BROWSER_SESSION_BUSY')) return true;
  return (error as { brokerCode?: unknown }).brokerCode === 'browser_action_failed';
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
