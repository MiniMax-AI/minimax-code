import type { PiBeforeLlmCallHookInput } from '@mavis/agent-core/pi-turn-runner';

type RequestMessage = PiBeforeLlmCallHookInput['messages'][number];

/**
 * Pi `compactionSummary` messages as both runtimes put them into history
 * (local compaction and cloud `@mavis/context-manager`): `timestamp` and
 * `tokensBefore` identify one compaction. Index of the latest one, or -1.
 */
export function findLastCompactionSummary(messages: readonly RequestMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && Reflect.get(message, 'role') === 'compactionSummary') return index;
  }
  return -1;
}

/** When the summary was written (Unix ms); 0 when it carries no usable time. */
export function compactionSummaryTimestamp(summary: RequestMessage): number {
  const timestamp: unknown = Reflect.get(summary, 'timestamp');
  return typeof timestamp === 'number' && Number.isFinite(timestamp) ? timestamp : 0;
}

/** Stable identity of one compaction, the same on every request that carries it. */
export function compactionSummaryKey(summary: RequestMessage): string {
  return `${compactionSummaryTimestamp(summary)}:${String(Reflect.get(summary, 'tokensBefore'))}`;
}
