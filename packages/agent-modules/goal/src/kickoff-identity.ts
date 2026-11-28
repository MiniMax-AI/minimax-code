/**
 * Wire identity of a Goal kickoff Queue item. The Goal owner (local-runtime-v2)
 * builds and classifies these items; other Queue readers only need to
 * recognise them, so the prefix and origin type live here once.
 */
export const THREAD_GOAL_KICKOFF_PREFIX = 'thread-goal-kickoff:';
export const THREAD_GOAL_KICKOFF_ORIGIN_TYPE = 'thread-goal-kickoff';

/** The kickoff `origin` record of a Queue message, or `undefined` for any other origin. */
export function readThreadGoalKickoffOriginRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return record.type === THREAD_GOAL_KICKOFF_ORIGIN_TYPE ? record : undefined;
}

export function isThreadGoalKickoffQueueItem(item: {
  readonly clientRequestId?: string;
  readonly message: { readonly origin?: unknown };
}): boolean {
  return (
    item.clientRequestId?.startsWith(THREAD_GOAL_KICKOFF_PREFIX) === true ||
    readThreadGoalKickoffOriginRecord(item.message.origin) !== undefined
  );
}
