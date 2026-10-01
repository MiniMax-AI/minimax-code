import type { LocalTaskRunnerHostWithSessionLookup } from '../api/local-task-host.js';
import {
  isTerminalTaskStatus,
  type BackgroundTask,
  type BackgroundTaskKind,
  type BackgroundTaskStatus,
} from './domain.js';

/**
 * Target collection and child-Session ownership for the Session stop cascade in
 * `session-cascade.ts`: which rows a cascade looks at, and which child-Session rows
 * belong to a sweep. Kept apart so the cascade stays within the local-runtime layout
 * line budget. This module is a leaf: it must never import the cascade back.
 */

/** Which child Turn owns a child-Session sweep; see `StopSessionBackgroundWorkInput`. */
export type CascadeChildScope = { readonly ownerTurnId: string; readonly parentTaskId: string };

/** Rows scanned per Session. Far above any real Session's live task count. */
const MAX_CASCADE_TASKS = 512;

const ACTIVE_STATUSES: readonly BackgroundTaskStatus[] = ['queued', 'running', 'stopping'];
const TERMINAL_STATUSES: readonly BackgroundTaskStatus[] = [
  'succeeded',
  'failed',
  'canceled',
  'lost',
];

/**
 * Subagents whose result the model already read (`deliveredAt` set) are not
 * targets — there is nothing to stop or suppress — but their child Session may,
 * as a fallback, still hold live work. Only their child Session is swept: the row
 * itself is not stopped, not registered for suppression, not reported and not
 * counted in metrics. The boundary still applies, protecting subagents launched
 * by the user's next message.
 */
export async function collectReadSubagents(
  host: LocalTaskRunnerHostWithSessionLookup,
  sessionId: string,
  boundaryMs: number,
): Promise<BackgroundTask[]> {
  // No delivered-only filter exists on the store, so list terminal subagents and
  // pick the read ones here. Foreground rows count too: any executionMode.
  const terminalSubagents = await listTasks(host, sessionId, TERMINAL_STATUSES, {
    kinds: ['subagent'],
  });
  return terminalSubagents.filter(
    (task) =>
      task.ownerSessionId === sessionId &&
      task.kind === 'subagent' &&
      isTerminalTaskStatus(task.status) &&
      task.deliveredAt !== undefined &&
      task.createdAt <= boundaryMs &&
      readChildSessionId(task) !== undefined,
  );
}

/**
 * Targets = this Session's non-terminal tasks, plus terminal ones whose result was
 * never delivered (they finished just before the stop and their notice is still in
 * retry backoff — delivering it later is exactly the wake-up we must prevent).
 */
export async function collectCascadeTargets(
  host: LocalTaskRunnerHostWithSessionLookup,
  sessionId: string,
  boundaryMs: number,
): Promise<BackgroundTask[]> {
  const [active, undelivered] = await Promise.all([
    listTasks(host, sessionId, ACTIVE_STATUSES),
    listTasks(host, sessionId, TERMINAL_STATUSES, { undeliveredOnly: true }),
  ]);
  const byId = new Map<string, BackgroundTask>();
  for (const task of [...active, ...undelivered]) {
    if (task.ownerSessionId !== sessionId) continue;
    if (task.createdAt > boundaryMs) continue;
    if (isTerminalTaskStatus(task.status) && task.deliveredAt !== undefined) continue;
    // Foreground subagent rows (plain `task` calls and Goal verification) belong to
    // the aborted Turn and are settled by it: terminal ones are already latched as
    // delivered, and running ones were never admitted here. Excluding them keeps
    // `cascade_skipped_not_owned` meaningful as a cross-process signal.
    if (isForegroundSubagentRow(task)) continue;
    byId.set(task.taskId, task);
  }
  return [...byId.values()];
}

async function listTasks(
  host: LocalTaskRunnerHostWithSessionLookup,
  sessionId: string,
  statuses: readonly BackgroundTaskStatus[],
  options: { readonly undeliveredOnly?: boolean; readonly kinds?: BackgroundTaskKind[] } = {},
): Promise<BackgroundTask[]> {
  const result = await host.backgroundTaskService.list({
    ownerSessionId: sessionId,
    statuses: [...statuses],
    limit: MAX_CASCADE_TASKS,
    ...(options.undeliveredOnly ? { undeliveredOnly: true } : {}),
    ...(options.kinds ? { kinds: options.kinds } : {}),
  });
  return result.items;
}

function isForegroundSubagentRow(task: BackgroundTask): boolean {
  return task.kind === 'subagent' && readExecutionMode(task) === 'foreground';
}

function readExecutionMode(task: BackgroundTask): string | undefined {
  const mode = task.metadata?.['executionMode'];
  return typeof mode === 'string' ? mode : undefined;
}

/**
 * Splits child-Session rows by the Turn that spawned them. Without a scope (the
 * root Session) every row passes; rows lacking `parentTurnId` are never swept,
 * only counted, because their owner cannot be established.
 */
export function scopeToOwnerTurn(
  tasks: readonly BackgroundTask[],
  childScope: CascadeChildScope | undefined,
): { owned: BackgroundTask[]; skippedOtherTurn: number; skippedMissingOwner: number } {
  if (!childScope) return { owned: [...tasks], skippedOtherTurn: 0, skippedMissingOwner: 0 };
  const owned: BackgroundTask[] = [];
  let skippedOtherTurn = 0;
  let skippedMissingOwner = 0;
  for (const task of tasks) {
    const parentTurnId = readMetadataString(task, 'parentTurnId');
    if (parentTurnId === undefined) skippedMissingOwner += 1;
    else if (parentTurnId !== childScope.ownerTurnId) skippedOtherTurn += 1;
    else owned.push(task);
  }
  return { owned, skippedOtherTurn, skippedMissingOwner };
}

export function readSubTurnId(task: BackgroundTask): string | undefined {
  return readMetadataString(task, 'subTurnId');
}

function readMetadataString(task: BackgroundTask, key: string): string | undefined {
  const value = task.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function readChildSessionId(task: BackgroundTask): string | undefined {
  const childSessionId = task.metadata?.['childSessionId'];
  return typeof childSessionId === 'string' && childSessionId.trim() ? childSessionId : undefined;
}
