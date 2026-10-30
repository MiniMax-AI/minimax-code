import { and, desc, eq, inArray } from 'drizzle-orm';

import type { AppDb } from '../../../infra/db/client.js';
import { turnIngress, turnIngressClientRequests } from '../../../infra/db/schema/turn.js';
import type { QueueCommittedFact } from '../../session-system/index.js';
import type { TurnClientRequestBinding } from '../admission-contracts.js';
import type { TurnRepository, TurnRepositoryOptions } from './contracts.js';

export function publishQueueFacts(
  options: TurnRepositoryOptions,
  facts: readonly QueueCommittedFact[],
): void {
  try {
    options.priorityFence.publishCommitted(facts);
  } catch {
    // Queue facts project committed state best-effort; authoritative reads converge later.
  }
}

export function persistedTurnConsumesQueuePause(db: AppDb, sessionId: string): boolean {
  const row = db
    .select({ inputMetadataJson: turnIngress.inputMetadataJson })
    .from(turnIngress)
    .where(and(eq(turnIngress.sessionId, sessionId), eq(turnIngress.status, 'accepted')))
    .orderBy(desc(turnIngress.acceptedSequence))
    .limit(1)
    .get();
  if (!row) return false;
  try {
    const metadata: unknown = JSON.parse(row.inputMetadataJson);
    return Boolean(
      metadata &&
      typeof metadata === 'object' &&
      !Array.isArray(metadata) &&
      (metadata as Readonly<Record<string, unknown>>).consumeQueuePause === true,
    );
  } catch {
    return false;
  }
}

type Transaction = Parameters<Parameters<TurnRepositoryOptions['db']['transaction']>[0]>[0];
type RepositoryDb = TurnRepositoryOptions['db'] | Transaction;

/**
 * Binds per-item aliases to the Turn that took the primary receipt. An alias already bound
 * to an earlier Turn keeps that first binding, so a retried item never moves.
 */
export function insertReceiptAliases(
  tx: Transaction,
  input: {
    readonly sessionId: string;
    readonly clientRequestId?: string;
    readonly turnId: string;
    readonly receiptAliases?: readonly string[];
  },
): void {
  const aliases = [...new Set(input.receiptAliases ?? [])].filter(
    (alias) => alias.length > 0 && alias !== input.clientRequestId,
  );
  aliases.forEach((clientRequestId, index) => {
    tx.insert(turnIngressClientRequests)
      .values({
        sessionId: input.sessionId,
        clientRequestId,
        turnId: input.turnId,
        ordinal: index + 1,
      })
      .onConflictDoNothing()
      .run();
  });
}

export function findClientRequestBindings(
  db: RepositoryDb,
  input: Parameters<TurnRepository['findClientRequestBindings']>[0],
): TurnClientRequestBinding[] {
  if (input.clientRequestIds.length === 0) return [];
  return db
    .select({
      clientRequestId: turnIngressClientRequests.clientRequestId,
      turnId: turnIngressClientRequests.turnId,
    })
    .from(turnIngressClientRequests)
    .where(
      and(
        eq(turnIngressClientRequests.sessionId, input.sessionId),
        inArray(turnIngressClientRequests.clientRequestId, [...new Set(input.clientRequestIds)]),
      ),
    )
    .all();
}
