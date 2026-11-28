import { SessionActivityKind, SessionActivityState } from '@mavis/local-runtime-v2/cli-service';
import type { GetSessionActivityResp } from '@mavis/local-runtime-v2/cli-service';

import type { TuiStreamEvent } from '../runtime/stream-events.js';
import type { TuiAcpPromptContinuation } from './prompt-continuation.js';
import type { TuiAcpRuntime } from './runtime.js';

/** Timing of the wait after the admitted Turn; production uses the defaults. */
export interface TuiAcpSettleOptions {
  /** Bound on waiting for work left after the admitted Turn; the Prompt then ends anyway. */
  readonly maxWaitMs?: number;
  /** Re-read interval while work is outstanding; Turn lifecycle events wake the wait earlier. */
  readonly pollMs?: number;
}

// The bound codex-acp gives outstanding sub-agents before it ends a Prompt.
const DEFAULT_SETTLE_MAX_WAIT_MS = 600_000;
const DEFAULT_SETTLE_POLL_MS = 1_000;

/**
 * After the admitted Turn succeeds, background Tasks, sub-Agents, queue drains, Goal
 * continuations and self reminders can still start root Turns that carry the real answer
 * (a finished Task steers a `turn_task_delivery_*` Turn into its owner). Ending the Prompt
 * at the admitted Turn hands the client an intermediate reply and hides that Turn
 * (measured with acpx 0.11.2: `end_turn` at 5.8 s, the delivery Turn ran 33-40 s).
 *
 * Like codex-acp waiting for its outstanding sub-agents, the Prompt waits only while such
 * work is outstanding, streams every root Turn it starts into the same Prompt, and ends as
 * soon as nothing is left: a session with nothing outstanding ends after one snapshot read.
 */
export async function settleTuiAcpSession(options: {
  readonly runtime: Pick<TuiAcpRuntime, 'getSessionActivity' | 'watchSessionTurn' | 'abortSession'>;
  readonly sessionId: string;
  readonly followedTurnIds: readonly string[];
  readonly continuation: TuiAcpPromptContinuation;
  readonly signal: AbortSignal;
  readonly settle: TuiAcpSettleOptions;
  readonly onSessionEvent: (event: TuiStreamEvent) => void;
  readonly onFollowTurn: (turnId: string | undefined) => void;
  readonly now?: () => number;
}): Promise<'end_turn' | 'cancelled'> {
  const now = options.now ?? Date.now;
  const pollMs = options.settle.pollMs ?? DEFAULT_SETTLE_POLL_MS;
  const deadline = now() + (options.settle.maxWaitMs ?? DEFAULT_SETTLE_MAX_WAIT_MS);
  const followed = new Set(options.followedTurnIds);
  let polled = false;
  while (!options.signal.aborted) {
    let next = options.continuation.takeStartedTurn(followed);
    if (!next) {
      let activity: GetSessionActivityResp | undefined;
      try {
        activity = await options.runtime.getSessionActivity(options.sessionId);
      } catch {
        // Without a first snapshot nothing is known: end at the admitted Turn as before.
        // A later failed read proves nothing either way; the next read decides.
        if (!polled) return 'end_turn';
      }
      polled = true;
      if (activity) {
        next = activity.items?.find(
          (item) =>
            item.kind === SessionActivityKind.Turn &&
            item.sessionId === options.sessionId &&
            item.refId !== undefined &&
            !followed.has(item.refId),
        )?.refId;
        if (
          !next &&
          !outstanding(activity, deadline) &&
          !options.continuation.hasOpenQuestionnaire()
        ) {
          return 'end_turn';
        }
      }
    }
    if (next) {
      followed.add(next);
      await followTurn(options, next);
      continue;
    }
    if (now() >= deadline) return 'end_turn';
    await options.continuation.waitForEvent(options.signal, pollMs);
  }
  return 'cancelled';
}

async function followTurn(
  options: Parameters<typeof settleTuiAcpSession>[0],
  turnId: string,
): Promise<void> {
  options.onFollowTurn(turnId);
  try {
    for await (const event of options.runtime.watchSessionTurn(
      options.sessionId,
      turnId,
      options.signal,
    )) {
      options.onSessionEvent(event);
      if (isSessionTurnTerminal(event)) return;
    }
  } finally {
    options.onFollowTurn(undefined);
    // The cancelled Prompt owns this Turn now; do not leave it running behind the client.
    if (options.signal.aborted) {
      await options.runtime.abortSession({ id: options.sessionId, turnId }).catch(() => undefined);
    }
  }
}

/**
 * Whether the session tree can still move without a new Prompt:
 * - Running (a Turn, queued message, background Task, undelivered Task result, Goal or
 *   Cron Run), an unknown state, or a truncated tree that cannot prove otherwise;
 * - a pending questionnaire or permission: ACP forwards each one to the Client, whose answer
 *   resumes the session and whose refusal dismisses it, so the tree moves either way;
 * - a self reminder due before the deadline, whose Turn often carries the final answer.
 * A paused queue waits for a user Continue ACP cannot send, and a user Cron schedule may
 * recur forever; neither keeps the Prompt open.
 */
function outstanding(activity: GetSessionActivityResp, deadline: number): boolean {
  if (activity.truncated === true) return true;
  const items = activity.items ?? [];
  switch (activity.state) {
    case SessionActivityState.Idle:
      return false;
    case SessionActivityState.WaitingForUser:
      return items.some(
        (item) =>
          item.kind === SessionActivityKind.Questionnaire ||
          item.kind === SessionActivityKind.Permission,
      );
    case SessionActivityState.Scheduled:
      return items.some(
        (item) =>
          item.kind === SessionActivityKind.CronSchedule &&
          item.detail === 'self_reminder' &&
          item.atMs !== undefined &&
          Number(item.atMs) <= deadline,
      );
    default:
      return true;
  }
}

export function isSessionTurnTerminal(event: TuiStreamEvent): boolean {
  if (event.type === 'done' || event.type === 'error') return true;
  return (
    event.type === 'session-status' &&
    (event.status === 'finished' ||
      event.status === 'error' ||
      event.status === 'aborted' ||
      event.status === 'interrupted')
  );
}
