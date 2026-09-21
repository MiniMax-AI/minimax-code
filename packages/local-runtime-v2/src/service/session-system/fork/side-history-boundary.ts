import type { SessionHistoryMutationRead } from '../messages/history/mutation/session-history-mutation-adapter.js';
import { inspectCanonicalHistorySequence } from '../sessions/representation/canonical-history-contract.js';

/** Select and revalidate one complete, inclusive history prefix without waiting for live tools. */
export function resolveSideHistoryBoundary(
  history: SessionHistoryMutationRead,
  throughMessageId?: string,
): string | undefined {
  const artifacts = [
    history.active,
    ...[...history.snapshots]
      .sort((left, right) => right.generation - left.generation)
      .map((snapshot) => snapshot.records),
  ];
  for (const records of artifacts) {
    if (throughMessageId !== undefined) {
      const index = records.findIndex((row) => row.message_id === throughMessageId);
      if (index < 0) continue;
      return inspectCanonicalHistorySequence(records.slice(0, index + 1)).status === 'settled'
        ? throughMessageId
        : undefined;
    }
    const inspection = inspectCanonicalHistorySequence(records);
    const length =
      inspection.status === 'settled' ? records.length : inspection.settledPrefixLength;
    const boundary = records[length - 1];
    if (boundary) return boundary.message_id;
  }
  return undefined;
}
