import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { AppDb } from '../../infra/db/client.js';
import { queryCollapseViewStates } from '../../infra/db/schema/query-collapse.js';

export interface QueryCollapseViewState {
  readonly sessionId: string;
  readonly queryKey: string;
  readonly currentTurnId: string;
  readonly forceExpanded: boolean;
  readonly processingStartedAtMs: number;
  readonly processingFinishedAtMs?: number;
  readonly updatedAtMs: number;
}

export interface QueryCollapseState {
  start(input: {
    readonly sessionId: string;
    readonly queryKey: string;
    readonly currentTurnId: string;
  }): Promise<QueryCollapseViewState>;
  finish(input: {
    readonly sessionId: string;
    readonly queryKey: string;
    readonly currentTurnId: string;
    readonly forceExpanded: boolean;
  }): Promise<QueryCollapseViewState | undefined>;
  findByCurrentTurn(
    sessionId: string,
    currentTurnId: string,
  ): Promise<QueryCollapseViewState | undefined>;
  findProcessingByCurrentTurn(
    sessionId: string,
    currentTurnId: string,
  ): Promise<QueryCollapseViewState | undefined>;
  findByKey(sessionId: string, queryKey: string): Promise<QueryCollapseViewState | undefined>;
  listByKeys(input: {
    readonly sessionId: string;
    readonly queryKeys: readonly string[];
  }): Promise<QueryCollapseViewState[]>;
  list(sessionId: string): Promise<QueryCollapseViewState[]>;
  forceExpandForTurn(
    sessionId: string,
    currentTurnId: string,
  ): Promise<QueryCollapseViewState | undefined>;
  recoverUnfinished(): Promise<QueryCollapseViewState[]>;
  deleteSession(sessionId: string): Promise<void>;
}

export interface QueryCollapseStateOptions {
  readonly db: AppDb;
  readonly nowMs?: () => number;
}

/**
 * Query display sidecar with Turn fencing. It deliberately does not own Turn
 * admission or execution: currentTurnId only prevents stale lifecycle writes.
 */
export function createQueryCollapseState(options: QueryCollapseStateOptions): QueryCollapseState {
  const nowMs = options.nowMs ?? Date.now;
  return {
    start: async (input) => {
      const now = nowMs();
      options.db
        .insert(queryCollapseViewStates)
        .values({
          sessionId: input.sessionId,
          queryKey: input.queryKey,
          currentTurnId: input.currentTurnId,
          forceExpanded: 0,
          processingStartedAtMs: now,
          processingFinishedAtMs: null,
          updatedAtMs: now,
        })
        .onConflictDoUpdate({
          target: [queryCollapseViewStates.sessionId, queryCollapseViewStates.queryKey],
          set: {
            currentTurnId: input.currentTurnId,
            forceExpanded: 0,
            processingStartedAtMs: sql<number>`CASE
              WHEN ${queryCollapseViewStates.processingFinishedAtMs} IS NULL
              THEN ${queryCollapseViewStates.processingStartedAtMs}
              WHEN ${queryCollapseViewStates.processingFinishedAtMs} >= ${queryCollapseViewStates.processingStartedAtMs}
              THEN ${now} - (
                ${queryCollapseViewStates.processingFinishedAtMs} -
                ${queryCollapseViewStates.processingStartedAtMs}
              )
              ELSE ${now}
            END`,
            processingFinishedAtMs: null,
            updatedAtMs: now,
          },
        })
        .run();
      const state = readByKey(options.db, input.sessionId, input.queryKey);
      if (!state) {
        throw new Error(`Query collapse state missing: ${input.sessionId}/${input.queryKey}`);
      }
      return toState(state);
    },
    finish: async (input) => {
      const now = nowMs();
      const result = options.db
        .update(queryCollapseViewStates)
        .set({
          forceExpanded: sql`CASE
            WHEN ${queryCollapseViewStates.forceExpanded} = 1 OR ${input.forceExpanded ? 1 : 0} = 1
            THEN 1 ELSE 0 END`,
          processingFinishedAtMs: now,
          updatedAtMs: now,
        })
        .where(
          and(
            eq(queryCollapseViewStates.sessionId, input.sessionId),
            eq(queryCollapseViewStates.queryKey, input.queryKey),
            eq(queryCollapseViewStates.currentTurnId, input.currentTurnId),
            isNull(queryCollapseViewStates.processingFinishedAtMs),
          ),
        )
        .run();
      if (result.changes === 0) return undefined;
      const state = readByKey(options.db, input.sessionId, input.queryKey);
      return state ? toState(state) : undefined;
    },
    findByCurrentTurn: async (sessionId, currentTurnId) => {
      const state = options.db
        .select()
        .from(queryCollapseViewStates)
        .where(
          and(
            eq(queryCollapseViewStates.sessionId, sessionId),
            eq(queryCollapseViewStates.currentTurnId, currentTurnId),
          ),
        )
        .orderBy(desc(queryCollapseViewStates.updatedAtMs), desc(queryCollapseViewStates.queryKey))
        .get();
      return state ? toState(state) : undefined;
    },
    findProcessingByCurrentTurn: async (sessionId, currentTurnId) => {
      const state = readProcessingByCurrentTurn(options.db, sessionId, currentTurnId);
      return state ? toState(state) : undefined;
    },
    findByKey: async (sessionId, queryKey) => {
      const state = readByKey(options.db, sessionId, queryKey);
      return state ? toState(state) : undefined;
    },
    listByKeys: async (input) => readByKeys(options.db, input),
    list: async (sessionId) =>
      options.db
        .select()
        .from(queryCollapseViewStates)
        .where(eq(queryCollapseViewStates.sessionId, sessionId))
        .orderBy(
          asc(queryCollapseViewStates.processingStartedAtMs),
          asc(queryCollapseViewStates.queryKey),
        )
        .all()
        .map(toState),
    forceExpandForTurn: async (sessionId, currentTurnId) => {
      const now = nowMs();
      const result = options.db
        .update(queryCollapseViewStates)
        .set({ forceExpanded: 1, updatedAtMs: now })
        .where(
          and(
            eq(queryCollapseViewStates.sessionId, sessionId),
            eq(queryCollapseViewStates.currentTurnId, currentTurnId),
          ),
        )
        .run();
      if (result.changes === 0) return undefined;
      const state = readByCurrentTurn(options.db, sessionId, currentTurnId);
      return state ? toState(state) : undefined;
    },
    recoverUnfinished: async () => {
      const unfinished = options.db
        .select()
        .from(queryCollapseViewStates)
        .where(isNull(queryCollapseViewStates.processingFinishedAtMs))
        .all();
      if (unfinished.length === 0) return [];
      const now = nowMs();
      options.db
        .update(queryCollapseViewStates)
        .set({ forceExpanded: 1, processingFinishedAtMs: now, updatedAtMs: now })
        .where(isNull(queryCollapseViewStates.processingFinishedAtMs))
        .run();
      return unfinished.map((state) =>
        toState({
          ...state,
          forceExpanded: 1,
          processingFinishedAtMs: now,
          updatedAtMs: now,
        }),
      );
    },
    deleteSession: async (sessionId) => {
      options.db
        .delete(queryCollapseViewStates)
        .where(eq(queryCollapseViewStates.sessionId, sessionId))
        .run();
    },
  };
}

function readByCurrentTurn(db: AppDb, sessionId: string, currentTurnId: string) {
  return db
    .select()
    .from(queryCollapseViewStates)
    .where(
      and(
        eq(queryCollapseViewStates.sessionId, sessionId),
        eq(queryCollapseViewStates.currentTurnId, currentTurnId),
      ),
    )
    .orderBy(desc(queryCollapseViewStates.updatedAtMs), desc(queryCollapseViewStates.queryKey))
    .get();
}

const processingQueries = new WeakMap<AppDb, ReturnType<typeof prepareProcessingQuery>>();

function readProcessingByCurrentTurn(db: AppDb, sessionId: string, currentTurnId: string) {
  let query = processingQueries.get(db);
  if (!query) {
    query = prepareProcessingQuery(db);
    processingQueries.set(db, query);
  }
  return query.get({ sessionId, currentTurnId });
}

function prepareProcessingQuery(db: AppDb) {
  return db
    .select()
    .from(queryCollapseViewStates)
    .where(
      and(
        eq(queryCollapseViewStates.sessionId, sql.placeholder('sessionId')),
        eq(queryCollapseViewStates.currentTurnId, sql.placeholder('currentTurnId')),
        isNull(queryCollapseViewStates.processingFinishedAtMs),
      ),
    )
    .orderBy(desc(queryCollapseViewStates.updatedAtMs), desc(queryCollapseViewStates.queryKey))
    .prepare();
}

function readByKey(db: AppDb, sessionId: string, queryKey: string) {
  return db
    .select()
    .from(queryCollapseViewStates)
    .where(
      and(
        eq(queryCollapseViewStates.sessionId, sessionId),
        eq(queryCollapseViewStates.queryKey, queryKey),
      ),
    )
    .get();
}

function readByKeys(
  db: AppDb,
  input: { readonly sessionId: string; readonly queryKeys: readonly string[] },
): QueryCollapseViewState[] {
  const queryKeys = [...new Set(input.queryKeys.filter((queryKey) => queryKey.length > 0))];
  if (queryKeys.length === 0) return [];
  const states = db
    .select()
    .from(queryCollapseViewStates)
    .where(
      and(
        eq(queryCollapseViewStates.sessionId, input.sessionId),
        inArray(queryCollapseViewStates.queryKey, queryKeys),
      ),
    )
    .all();
  const statesByKey = new Map(states.map((state) => [state.queryKey, state]));
  return queryKeys.flatMap((queryKey) => {
    const state = statesByKey.get(queryKey);
    return state ? [toState(state)] : [];
  });
}

function toState(row: typeof queryCollapseViewStates.$inferSelect): QueryCollapseViewState {
  return {
    sessionId: row.sessionId,
    queryKey: row.queryKey,
    currentTurnId: row.currentTurnId,
    forceExpanded: row.forceExpanded === 1,
    processingStartedAtMs: row.processingStartedAtMs,
    ...(row.processingFinishedAtMs === null
      ? {}
      : { processingFinishedAtMs: row.processingFinishedAtMs }),
    updatedAtMs: row.updatedAtMs,
  };
}
