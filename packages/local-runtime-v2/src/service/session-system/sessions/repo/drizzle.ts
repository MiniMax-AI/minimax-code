import { listInternalDefaultRootIds } from '../../shared/internal-default-roots.js';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  placeholder,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { AppDb } from '../../../../infra/db/client.js';
import { runWithWriteLock } from '../../../../infra/db/write-transaction.js';
import {
  sessionAgentDefinitions,
  taskSessionBindings,
  sessionAgentState,
  sessions,
} from '../../../../infra/db/schema/sessions.js';
import {
  assertSessionModelSnapshot,
  normalizeSessionModelUpdate,
  syncSessionAgentDefinitionModel,
} from './drizzle/model-update.js';
import { isSameSessionAgentName } from '../agent-name.js';
import { agentStateRow, assertAgentStateMutation, decideAgentState } from './agent-state.js';
import {
  decodeSessionRow,
  encodeSessionRow,
  withoutRootAppMode,
  type SessionStorageRow,
} from './drizzle/codec.js';
import type {
  AgentSessionStateMutation,
  AgentSessionStateWriteResult,
  SessionChildrenOptions,
  SessionCountOptions,
  SessionCreateInput,
  SessionCronOriginPageOptions,
  SessionHistoryIdentity,
  SessionListOptions,
  SessionPage,
  SessionProjectPreviewOptions,
  SessionProjectRootPageOptions,
  SessionRepository,
  SessionRepositoryOptions,
  SessionRootPageOptions,
  SessionRootSwapInput,
  SessionRootSwapResult,
  SessionSearchOptions,
  SessionAgentDefinitionBackfill,
  SessionTaskAgentBindingBackfill,
  SessionStaleOptions,
  SessionUpdateFields,
  SessionModelSnapshot,
  StaleSessionCandidate,
  SessionRecord,
  SessionWriteRecord,
} from './contract.js';
import {
  decodeSessionAgentDefinition,
  decodeTaskSessionBinding,
  isCurrentSessionAgentDefinition,
  serializeSessionAgentDefinition,
  serializeTaskSessionBinding,
  toLegacyTaskSessionBinding,
  type SessionAgentDefinition,
  type TaskSessionBinding,
} from './agent-binding.js';
import {
  SessionRootSwapError,
  SessionTitleConflictError,
  SessionUniqueViolation,
} from './contract.js';
import { sessionAgentNamePredicate } from './agent-name-predicate.js';
import { sessionListPredicate } from './drizzle/list-predicates.js';
import {
  INTERNAL_TREE_SESSION_KINDS,
  projectTaskRootPredicate,
  sessionTreePredicate,
} from './filters.js';
import {
  applySessionUpdate,
  isTaskSession,
  normalizeSessionType,
} from './drizzle/normalization.js';
import {
  decodeCreationCursor,
  decodeRecencyCursor,
  normalizePageLimit,
  sessionCreationPageFromRows,
  sessionPageFromRows,
  sortByRecency,
  type CreationCursor,
  type RecencyCursor,
} from './pagination.js';
import {
  deleteSessionSearchDocument,
  searchSessionIds,
  writeSessionSearchDocument,
} from './search.js';
import { recordFromCreate } from './drizzle/record-create.js';
import { projects } from '../../../../infra/db/schema/projects.js';
import { eligible } from '../../projects/sidebar/predicate.js';
import { recordProjectRemoval, sessionNotRemovedFromProject } from '../../shared/project-removal.js';

const DEFAULT_TREE_FILTER: SessionChildrenOptions = {
  archived: false,
  includeHidden: false,
  excludeInternalTreeSessions: true,
};

function prepareSessionRead(db: AppDb) {
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.sessionId, placeholder('sessionId')), eq(sessions.columnarVersion, 3)))
    .prepare();
}

const sessionReads = new WeakMap<AppDb, ReturnType<typeof prepareSessionRead>>();

export function createSessionRepository(options: SessionRepositoryOptions): SessionRepository {
  return new DrizzleSessionRepository(options);
}

export type EffectiveSessionInteractionMode = 'default' | 'plan' | 'goal';
export type SessionInteractionModeTransitionResult =
  | 'updated'
  | 'already-plan'
  | 'already-goal'
  | 'already-default'
  | 'not-found'
  | 'conflict';

export function readSessionInteractionModeInTransaction(
  db: AppDb,
  sessionId: string,
): EffectiveSessionInteractionMode | undefined {
  const row = db
    .select({ extraDataJson: sessions.extraDataJson })
    .from(sessions)
    .where(and(eq(sessions.sessionId, sessionId), eq(sessions.columnarVersion, 3)))
    .get();
  return row ? parseInteractionModeEnvelope(row.extraDataJson).mode : undefined;
}

export function compareAndSetSessionInteractionModeInTransaction(
  db: AppDb,
  input: {
    readonly sessionId: string;
    readonly expected: EffectiveSessionInteractionMode;
    readonly next: EffectiveSessionInteractionMode;
    readonly updatedAtMs: number;
  },
): boolean {
  return transitionSessionInteractionModeInTransaction(db, input) === 'updated';
}

export function transitionSessionInteractionModeInTransaction(
  db: AppDb,
  input: {
    readonly sessionId: string;
    readonly expected: EffectiveSessionInteractionMode;
    readonly next: EffectiveSessionInteractionMode;
    readonly updatedAtMs: number;
  },
): SessionInteractionModeTransitionResult {
  const row = db
    .select({ extraDataJson: sessions.extraDataJson })
    .from(sessions)
    .where(and(eq(sessions.sessionId, input.sessionId), eq(sessions.columnarVersion, 3)))
    .get();
  if (!row) return 'not-found';
  const envelope = parseInteractionModeEnvelope(row.extraDataJson);
  if (envelope.mode === input.next) {
    return alreadyInInteractionMode(input.next);
  }
  if (envelope.mode !== input.expected) return 'conflict';
  const nextExtraData = { ...envelope.data };
  if (input.next === 'plan' || input.next === 'goal') {
    nextExtraData.interactionMode = input.next;
  } else {
    delete nextExtraData.interactionMode;
  }
  const updated = db
    .update(sessions)
    .set({
      extraDataJson: JSON.stringify(nextExtraData),
      updatedAtMs: input.updatedAtMs,
    })
    .where(
      and(
        eq(sessions.sessionId, input.sessionId),
        eq(sessions.columnarVersion, 3),
        eq(sessions.extraDataJson, row.extraDataJson),
      ),
    )
    .run();
  return updated.changes === 1 ? 'updated' : 'conflict';
}

function alreadyInInteractionMode(
  mode: EffectiveSessionInteractionMode,
): SessionInteractionModeTransitionResult {
  if (mode === 'plan') return 'already-plan';
  if (mode === 'goal') return 'already-goal';
  return 'already-default';
}

class DrizzleSessionRepository implements SessionRepository {
  private readonly nowMs: () => number;

  constructor(private readonly options: SessionRepositoryOptions) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  async get(sessionId: string): Promise<SessionRecord | undefined> {
    const db = this.options.db;
    let query = sessionReads.get(db);
    if (!query) {
      query = prepareSessionRead(db);
      sessionReads.set(db, query);
    }
    const row = query.get({ sessionId });
    return row ? decodeSessionRow(row) : undefined;
  }

  async getMany(sessionIds: readonly string[]): Promise<Array<SessionRecord | undefined>> {
    if (sessionIds.length === 0) return [];
    const rows = this.options.db
      .select()
      .from(sessions)
      .where(and(inArray(sessions.sessionId, [...sessionIds]), eq(sessions.columnarVersion, 3)))
      .all();
    const byId = new Map(rows.map((row) => [row.sessionId, decodeSessionRow(row)]));
    return sessionIds.map((sessionId) => byId.get(sessionId));
  }

  async has(sessionId: string): Promise<boolean> {
    return (await this.get(sessionId)) !== undefined;
  }

  async create(input: SessionCreateInput): Promise<SessionRecord> {
    const nowMs = this.nowMs();
    const record = recordFromCreate(input, nowMs);
    const task = isTaskSession(record);
    const definitionInput = task ? (input.agentDefinition ?? input.taskAgentBinding) : undefined;
    const definition = definitionInput
      ? serializeSessionAgentDefinition(definitionInput)
      : undefined;
    assertSessionDefinitionCreate(record, definitionInput, definition);
    const taskBinding =
      task && definitionInput
        ? serializeTaskSessionBinding(toLegacyTaskSessionBinding(definitionInput))
        : undefined;
    try {
      await runWithWriteLock(
        this.options.db,(tx) => {
        tx.insert(sessions)
          .values(encodeSessionRow(record, { projectId: input.projectId }))
          .run();
        if (definition) {
          tx.insert(sessionAgentDefinitions)
            .values({ sessionId: record.sessionId, definitionJson: definition.definitionJson })
            .run();
        }
        if (taskBinding) {
          tx.insert(taskSessionBindings)
            .values({ sessionId: record.sessionId, definitionJson: taskBinding.definitionJson })
            .run();
        }
        writeSessionSearchDocument(tx, record);
        const project = tx.select({ project: projects }).from(projects)
          .innerJoin(sessions, eq(sessions.projectId, projects.projectId))
          .where(and(eq(sessions.sessionId, record.sessionId), eq(projects.hidden, 1)))
          .get()?.project;
        if (project) {
          // Older removals predate the boundary field. Preserve their hidden
          // history before restoring the project for a newly created session.
          if (!JSON.parse(project.extraDataJson).sidebarRemoval) {
            recordProjectRemoval(tx, project, project.updatedAtMs, record.sessionId);
          }
          const visible = tx.select({ id: sessions.sessionId }).from(sessions)
            .innerJoin(projects, eq(sessions.projectId, projects.projectId))
            .where(and(eq(sessions.sessionId, record.sessionId), eligible(true))).get();
          if (visible) tx.update(projects).set({ hidden: 0, updatedAtMs: nowMs })
            .where(eq(projects.projectId, project.projectId)).run();
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new SessionUniqueViolation(input.sessionId);
      throw error;
    }
    return record;
  }

  async getSessionAgentDefinition(sessionId: string): Promise<SessionAgentDefinition | undefined> {
    const row = this.options.db
      .select()
      .from(sessionAgentDefinitions)
      .where(eq(sessionAgentDefinitions.sessionId, sessionId))
      .get();
    return row ? decodeSessionAgentDefinition(row) : undefined;
  }

  async backfillSessionAgentDefinitionIfAbsent(
    sessionId: string,
    backfill: SessionAgentDefinitionBackfill,
  ): Promise<SessionAgentDefinition> {
    const serialized = serializeSessionAgentDefinition(backfill.agentDefinition);
    return runWithWriteLock(
      this.options.db,
      (tx) => {
        const row = selectRow(tx, sessionId);
        if (!row) throw new Error(`Session does not exist: ${sessionId}`);
        if (!isTaskSession(decodeSessionRow(row))) {
          throw new Error(`Session Agent definition requires a Task Session: ${sessionId}`);
        }
        tx.insert(sessionAgentDefinitions)
          .values({ sessionId, definitionJson: serialized.definitionJson })
          .onConflictDoNothing()
          .run();
        const definition = tx
          .select()
          .from(sessionAgentDefinitions)
          .where(eq(sessionAgentDefinitions.sessionId, sessionId))
          .get();
        if (!definition) throw new Error(`Session Agent definition was not created: ${sessionId}`);
        return decodeSessionAgentDefinition(definition);
      },
    );
  }

  async replaceSessionAgentDefinitionIfLegacy(
    sessionId: string,
    next: SessionAgentDefinitionBackfill,
  ): Promise<SessionAgentDefinition> {
    const serialized = serializeSessionAgentDefinition(next.agentDefinition);
    return runWithWriteLock(
      this.options.db,
      (tx) => {
        const row = selectRow(tx, sessionId);
        if (!row) throw new Error(`Session does not exist: ${sessionId}`);
        if (!isTaskSession(decodeSessionRow(row))) {
          throw new Error(`Session Agent definition requires a Task Session: ${sessionId}`);
        }
        const current = tx
          .select()
          .from(sessionAgentDefinitions)
          .where(eq(sessionAgentDefinitions.sessionId, sessionId))
          .get();
        if (!current) throw new Error(`Session Agent definition is missing: ${sessionId}`);
        const decoded = decodeSessionAgentDefinition(current);
        if (isCurrentSessionAgentDefinition(decoded.definition)) return decoded;
        tx.update(sessionAgentDefinitions)
          .set({ definitionJson: serialized.definitionJson })
          .where(eq(sessionAgentDefinitions.sessionId, sessionId))
          .run();
        return { sessionId, definition: next.agentDefinition.definition };
      },
    );
  }

  async getTaskAgentBinding(sessionId: string): Promise<TaskSessionBinding | undefined> {
    const row = this.options.db
      .select()
      .from(taskSessionBindings)
      .where(eq(taskSessionBindings.sessionId, sessionId))
      .get();
    return row ? decodeTaskSessionBinding(row) : undefined;
  }

  async backfillTaskAgentBindingIfAbsent(
    sessionId: string,
    backfill: SessionTaskAgentBindingBackfill,
  ): Promise<TaskSessionBinding> {
    const serialized = serializeTaskSessionBinding(backfill.taskAgentBinding);
    return runWithWriteLock(
      this.options.db,
      (tx) => {
        const row = selectRow(tx, sessionId);
        if (!row) throw new Error(`Session does not exist: ${sessionId}`);
        if (!isTaskSession(decodeSessionRow(row))) {
          throw new Error(`Task Agent binding requires a Task Session: ${sessionId}`);
        }
        tx.insert(taskSessionBindings)
          .values({ sessionId, definitionJson: serialized.definitionJson })
          .onConflictDoNothing()
          .run();
        const binding = tx
          .select()
          .from(taskSessionBindings)
          .where(eq(taskSessionBindings.sessionId, sessionId))
          .get();
        if (!binding) throw new Error(`Task Agent binding was not created: ${sessionId}`);
        return decodeTaskSessionBinding(binding);
      },
    );
  }

  async update(
    sessionId: string,
    fields: SessionUpdateFields,
    expectedModel?: SessionModelSnapshot,
    expectedTitle?: string | null,
  ): Promise<SessionRecord | undefined> {
    return runWithWriteLock(
      this.options.db,
      (tx) => {
        const row = selectRow(tx, sessionId);
        if (!row) return undefined;
        const current = decodeSessionRow(row);
        if (expectedTitle !== undefined && (current.title ?? null) !== expectedTitle) {
          throw new SessionTitleConflictError();
        }
        assertSessionModelSnapshot(current, expectedModel);
        const modelFields = normalizeSessionModelUpdate(current, fields);
        const record = withoutRootAppMode(applySessionUpdate(current, modelFields, this.nowMs()));
        writeRow(tx, row, record);
        // Updates only an existing model receipt; ordinary Agent definitions are never created here.
        syncSessionAgentDefinitionModel(tx, sessionId, modelFields);
        return record;
      },
    );
  }

  async detachCronSessions(
    originCronId: string,
    targetSessionId?: string,
  ): Promise<SessionRecord[]> {
    const normalizedCronId = originCronId.trim();
    if (!normalizedCronId) return [];
    const normalizedTargetSessionId = targetSessionId?.trim();
    return runWithWriteLock(
      this.options.db,
      (tx) => {
        const rows = tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.columnarVersion, 3),
              normalizedTargetSessionId
                ? or(
                    eq(sessions.originCronId, normalizedCronId),
                    eq(sessions.sessionId, normalizedTargetSessionId),
                  )
                : eq(sessions.originCronId, normalizedCronId),
            ),
          )
          .orderBy(desc(sessions.createdAtMs), asc(sessions.sessionId))
          .all();
        return rows.map((row) => {
          const current = decodeSessionRow(row);
          const detached: SessionRecord = {
            ...current,
            sessionKind: current.sessionKind === 'cron' ? 'conversation' : current.sessionKind,
            purpose: current.purpose?.startsWith('cron:') ? undefined : current.purpose,
            originCronId: undefined,
            // Detaching ownership must not make historical Cron runs look recently active.
            updatedAtMs: current.updatedAtMs,
          };
          writeRow(tx, row, detached);
          return detached;
        });
      },
    );
  }

  async upsert(record: SessionWriteRecord): Promise<void> {
    await this.writeUpsert(record, false);
  }

  async upsertImportedLegacy(record: SessionWriteRecord): Promise<void> {
    await this.writeUpsert(record, true);
  }

  async delete(sessionId: string): Promise<void> {
    await runWithWriteLock(
      this.options.db,(tx) => {
      deleteSessionSearchDocument(tx, sessionId);
      tx.delete(sessionAgentState).where(eq(sessionAgentState.sessionId, sessionId)).run();
      tx.delete(sessions).where(eq(sessions.sessionId, sessionId)).run();
    });
  }

  async touch(sessionId: string, updatedAtMs?: number): Promise<void> {
    this.options.db
      .update(sessions)
      .set({ updatedAtMs: updatedAtMs ?? this.nowMs() })
      .where(and(eq(sessions.sessionId, sessionId), eq(sessions.columnarVersion, 3)))
      .run();
  }

  async bindHistoryRelativeDir(
    sessionId: string,
    relativeDir: string,
  ): Promise<string | undefined> {
    return runWithWriteLock(
      this.options.db,
      (tx) => {
        const row = tx
          .select({ historyRelativeDir: sessions.historyRelativeDir })
          .from(sessions)
          .where(and(eq(sessions.sessionId, sessionId), eq(sessions.columnarVersion, 3)))
          .get();
        if (!row) return undefined;
        if (row.historyRelativeDir !== null) return row.historyRelativeDir;
        tx.update(sessions)
          .set({ historyRelativeDir: relativeDir })
          .where(
            and(
              eq(sessions.sessionId, sessionId),
              eq(sessions.columnarVersion, 3),
              isNull(sessions.historyRelativeDir),
            ),
          )
          .run();
        return (
          tx
            .select({ historyRelativeDir: sessions.historyRelativeDir })
            .from(sessions)
            .where(and(eq(sessions.sessionId, sessionId), eq(sessions.columnarVersion, 3)))
            .get()?.historyRelativeDir ?? undefined
        );
      },
    );
  }

  async swapRoot(input: SessionRootSwapInput): Promise<SessionRootSwapResult> {
    return runWithWriteLock(
      this.options.db,
      (tx) => {
        const nextRow = selectRow(tx, input.nextRootSessionId);
        if (!nextRow) throw new SessionRootSwapError('next-root-not-found');
        const next = decodeSessionRow(nextRow);
        if (!isSameSessionAgentName(next.agentName, input.agentName)) {
          throw new SessionRootSwapError('agent-mismatch');
        }
        if (next.runtime !== 'pi-agent') throw new SessionRootSwapError('unsupported-runtime');
        const previousRows = tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.columnarVersion, 3),
              sessionAgentNamePredicate(input.agentName),
              eq(sessions.runtime, 'pi-agent'),
              eq(sessions.sessionType, 'root'),
              // Cron / peek / task rows are separate internal trees that carry their
              // own `sessionType: 'root'`. Channel rows are user-facing in sidebar
              // trees, but still must never be adopted as an Agent root. `findRoots()`
              // already refuses these kinds, so demoting them here would archive a
              // user's scheduled-task or IM root as a side effect of replacing the
              // conversation root. Legacy rows with `sessionKind: 'unknown'` stay in
              // scope on purpose: upgraded installs keep their old conversation roots
              // demoted rather than stranded as a second root.
              notInArray(sessions.sessionKind, [...INTERNAL_TREE_SESSION_KINDS, 'channel', 'task']),
              ne(sessions.sessionId, input.nextRootSessionId),
            ),
          )
          .all();
        const previousRoots = sortByRecency(previousRows.map(decodeSessionRow));
        const nowMs = this.nowMs();
        for (const row of previousRows) {
          writeRow(
            tx,
            row,
            applySessionUpdate(
              decodeSessionRow(row),
              {
                sessionType: 'branch',
                archived: true,
                title: input.archivedRootTitle,
                ...(input.linkPreviousRootsToNext
                  ? { parentSessionId: input.nextRootSessionId }
                  : {}),
              },
              nowMs,
            ),
          );
        }
        const nextRoot = withoutRootAppMode(
          applySessionUpdate(
            next,
            { sessionType: 'root', parentSessionId: null, archived: false, title: 'Main' },
            nowMs,
          ),
        );
        writeRow(tx, nextRow, nextRoot);
        return { previousRoots, nextRoot };
      },
    );
  }

  async reparentChildren(
    parentSessionId: string,
    nextParentSessionId: string | null,
  ): Promise<void> {
    await runWithWriteLock(
      this.options.db,(tx) => {
      const nowMs = this.nowMs();
      const rows = tx
        .select()
        .from(sessions)
        .where(and(eq(sessions.columnarVersion, 3), eq(sessions.parentSessionId, parentSessionId)))
        .all();
      for (const row of rows) {
        writeRow(
          tx,
          row,
          applySessionUpdate(
            decodeSessionRow(row),
            { parentSessionId: nextParentSessionId },
            nowMs,
          ),
        );
      }
    });
  }

  async applyAgentState(input: AgentSessionStateMutation): Promise<AgentSessionStateWriteResult> {
    assertAgentStateMutation(input);
    return runWithWriteLock(
      this.options.db,
      (tx) => {
        const row = selectRow(tx, input.sessionId);
        if (!row) return { status: 'not-found' };
        const current = tx
          .select()
          .from(sessionAgentState)
          .where(eq(sessionAgentState.sessionId, input.sessionId))
          .get();
        const decision = decideAgentState(current, input);
        if (decision !== 'apply') return { status: decision };
        writeRow(tx, row, applySessionUpdate(decodeSessionRow(row), input.update, this.nowMs()));
        tx.insert(sessionAgentState)
          .values(agentStateRow(current, input, this.nowMs()))
          .onConflictDoUpdate({
            target: sessionAgentState.sessionId,
            set: agentStateRow(current, input, this.nowMs()),
          })
          .run();
        return { status: 'applied' };
      },
    );
  }

  async list(options: SessionListOptions = {}): Promise<SessionRecord[]> {
    const limit = positiveInteger(options.limit);
    return this.options.db
      .select()
      .from(sessions)
      .where(listScopePredicate(this.options.db, options, this.internalRootPredicate(options)))
      .orderBy(...recencyOrder())
      .limit(limit ?? -1)
      .all()
      .map(decodeSessionRow);
  }

  async listHistoryIdentities(): Promise<SessionHistoryIdentity[]> {
    return this.options.db
      .select({
        sessionId: sessions.sessionId,
        createdAtMs: sessions.createdAtMs,
        historyRelativeDir: sessions.historyRelativeDir,
      })
      .from(sessions)
      .where(and(eq(sessions.columnarVersion, 3), isNotNull(sessions.createdAtMs)))
      .all()
      .map((row) => ({
        sessionId: row.sessionId,
        createdAtMs: row.createdAtMs as number,
        ...(row.historyRelativeDir === null ? {} : { historyRelativeDir: row.historyRelativeDir }),
      }));
  }

  private internalRootPredicate(options: SessionListOptions | SessionCountOptions): SQL | undefined {
    if (!options.excludeInternalDefaultRoots) return undefined;
    const ids = listInternalDefaultRootIds(this.options.db, this.options.agentInternalWorkspaceDir);
    return sql`${sessions.sessionId} NOT IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;
  }

  async count(options: SessionCountOptions = {}): Promise<number> {
    return (
      this.options.db
        .select({ total: count() })
        .from(sessions)
        .where(and(sessionListPredicate(options), this.internalRootPredicate(options)))
        .get()?.total ?? 0
    );
  }

  async listPage(options: SessionListOptions = {}): Promise<SessionPage> {
    const limit = normalizePageLimit(options.limit);
    const cursor = decodeRecencyCursor(options.cursor);
    const records = this.options.db
      .select()
      .from(sessions)
      .where(and(
        listScopePredicate(this.options.db, options, this.internalRootPredicate(options)),
        recencyCursorPredicate(cursor),
      ))
      .orderBy(...recencyOrder())
      .limit(limit + 1)
      .all()
      .map(decodeSessionRow);
    return sessionPageFromRows(records, limit);
  }

  async searchPage(options: SessionSearchOptions = {}): Promise<SessionPage> {
    const keyword = options.keyword?.trim();
    if (!keyword) {
      return this.listPage({
        agentName: options.agentName,
        archived: false,
        includeHidden: false,
        excludeSessionKinds: ['peek', 'cron'],
        parentSessionId: null,
        limit: options.limit,
        cursor: options.cursor,
      });
    }
    const idPage = searchSessionIds(this.options.db, {
      keyword,
      agentName: options.agentName,
      limit: normalizePageLimit(options.limit),
      cursor: options.cursor,
    });
    const rows =
      idPage.sessionIds.length === 0
        ? []
        : this.options.db
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.columnarVersion, 3),
                inArray(sessions.sessionId, [...idPage.sessionIds]),
              ),
            )
            .all();
    const byId = new Map(rows.map((row) => [row.sessionId, decodeSessionRow(row)]));
    const records = idPage.sessionIds.map((sessionId) => {
      const record = byId.get(sessionId);
      if (!record) throw new Error(`Session FTS hydration missing for ${sessionId}`);
      return record;
    });
    return {
      sessions: records,
      hasMore: idPage.hasMore,
      ...(idPage.nextCursor ? { nextCursor: idPage.nextCursor } : {}),
    };
  }

  async listByCronOriginPage(options: SessionCronOriginPageOptions): Promise<SessionPage> {
    const originCronId = options.originCronId.trim();
    if (!originCronId) return { sessions: [], hasMore: false };
    const limit = normalizePageLimit(options.limit);
    const cursor = decodeCreationCursor(options.cursor, originCronId);
    const records = this.options.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.columnarVersion, 3),
          eq(sessions.originCronId, originCronId),
          options.archived === undefined
            ? undefined
            : eq(sessions.archived, options.archived ? 1 : 0),
          options.includeHidden === false ? ne(sessions.visibility, 'hidden') : undefined,
          creationCursorPredicate(cursor),
        ),
      )
      .orderBy(desc(sessions.createdAtMs), asc(sessions.sessionId))
      .limit(limit + 1)
      .all()
      .map(decodeSessionRow);
    return sessionCreationPageFromRows(records, limit, originCronId);
  }

  async listStalePiSessions(options: SessionStaleOptions = {}): Promise<StaleSessionCandidate[]> {
    const limit = normalizeStaleLimit(options.limit);
    return this.options.db
      .select({
        sessionId: sessions.sessionId,
        agentName: sessions.agentName,
        updatedAtMs: sessions.updatedAtMs,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.columnarVersion, 3),
          eq(sessions.runtime, 'pi-agent'),
          eq(sessions.status, 'started'),
          options.updatedBeforeMs === undefined
            ? undefined
            : lt(sessions.updatedAtMs, options.updatedBeforeMs),
          options.excludedSessionIds?.length
            ? notInArray(sessions.sessionId, [...options.excludedSessionIds])
            : undefined,
        ),
      )
      .orderBy(asc(sessions.updatedAtMs), asc(sessions.sessionId))
      .limit(limit)
      .all()
      .map(({ sessionId, agentName, updatedAtMs }) => ({
        sessionId,
        agentName: agentName ?? '',
        status: 'started',
        updatedAtMs,
      }));
  }

  async listRootPage(options: SessionRootPageOptions): Promise<SessionPage> {
    const limit = normalizePageLimit(options.limit);
    const cursor = decodeRecencyCursor(options.cursor);
    const records = this.options.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.columnarVersion, 3),
          sessionAgentNamePredicate(options.agentName),
          options.runtime ? eq(sessions.runtime, options.runtime) : undefined,
          isNull(sessions.parentSessionId),
          sessionTreePredicate(options),
          recencyCursorPredicate(cursor),
        ),
      )
      .orderBy(...recencyOrder())
      .limit(limit + 1)
      .all()
      .map(decodeSessionRow);
    return sessionPageFromRows(records, limit);
  }

  async listChildren(parentSessionId: string): Promise<SessionRecord[]> {
    return this.options.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.columnarVersion, 3), eq(sessions.parentSessionId, parentSessionId)))
      .orderBy(...recencyOrder())
      .all()
      .map(decodeSessionRow);
  }

  async listChildrenMany(
    parentSessionIds: readonly string[],
    options: SessionChildrenOptions = DEFAULT_TREE_FILTER,
  ): Promise<ReadonlyMap<string, readonly SessionRecord[]>> {
    const requested = [...new Set(parentSessionIds.filter(Boolean))];
    const result = new Map<string, SessionRecord[]>();
    if (requested.length === 0) return result;
    const records = this.options.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.columnarVersion, 3),
          inArray(sessions.parentSessionId, requested),
          sessionTreePredicate(options),
        ),
      )
      .orderBy(asc(sessions.parentSessionId), ...recencyOrder())
      .all()
      .map(decodeSessionRow);
    for (const record of records) {
      const parent = record.parentSessionId;
      if (!parent) continue;
      const values = result.get(parent) ?? [];
      values.push(record);
      result.set(parent, values);
    }
    return result;
  }

  async listProjectRootPage(options: SessionProjectRootPageOptions): Promise<SessionPage> {
    const limit = normalizePageLimit(options.limit);
    const cursor = decodeRecencyCursor(options.cursor);
    const records = this.options.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.columnarVersion, 3),
          eq(sessions.projectId, options.projectId),
          sessionNotRemovedFromProject(),
          sessionAgentNamePredicate(options.agentName),
          projectTaskRootPredicate(options),
          recencyCursorPredicate(cursor),
        ),
      )
      .orderBy(...recencyOrder())
      .limit(limit + 1)
      .all()
      .map(decodeSessionRow);
    return sessionPageFromRows(records, limit);
  }

  async listProjectRootPreviews(
    projectIds: readonly number[],
    options: SessionProjectPreviewOptions = DEFAULT_TREE_FILTER,
  ): Promise<ReadonlyMap<number, SessionPage>> {
    const requested = [...new Set(projectIds.filter((value) => value > 0))];
    const result = new Map<number, SessionPage>();
    if (requested.length === 0) return result;
    const limit = normalizePageLimit(options.limit);
    const rankedRoots = this.options.db.$with('ranked_project_roots').as(
      this.options.db
        .select({
          sessionId: sessions.sessionId,
          projectId: sessions.projectId,
          previewRank: sql<number>`row_number() OVER (
            PARTITION BY ${sessions.projectId}
            ORDER BY ${sessions.updatedAtMs} DESC, ${sessions.createdAtMs} DESC,
              ${sessions.sessionId} ASC
          )`.as('preview_rank'),
        })
        .from(sessions)
        .where(
          and(
            eq(sessions.columnarVersion, 3),
            inArray(sessions.projectId, requested),
            sessionNotRemovedFromProject(),
            sessionAgentNamePredicate(options.agentName),
            projectTaskRootPredicate(options),
          ),
        ),
    );
    const rows = this.options.db
      .with(rankedRoots)
      .select({
        record: sessions,
        projectId: rankedRoots.projectId,
        previewRank: rankedRoots.previewRank,
      })
      .from(rankedRoots)
      .innerJoin(sessions, eq(sessions.sessionId, rankedRoots.sessionId))
      .where(lte(rankedRoots.previewRank, limit + 1))
      .all();
    const recordsByProject = new Map<number, SessionRecord[]>();
    for (const { projectId, previewRank, record } of rows) {
      if (projectId === null || !Number.isSafeInteger(previewRank) || previewRank <= 0) continue;
      const records = recordsByProject.get(projectId) ?? [];
      records[previewRank - 1] = decodeSessionRow(record);
      recordsByProject.set(projectId, records);
    }
    for (const projectId of requested) {
      const records = (recordsByProject.get(projectId) ?? []).filter(
        (record): record is SessionRecord => record !== undefined,
      );
      result.set(projectId, sessionPageFromRows(records, limit));
    }
    return result;
  }

  private async writeUpsert(record: SessionWriteRecord, replaceIdentity: boolean): Promise<void> {
    const normalizedRecord: SessionRecord = {
      ...record,
      sessionType: normalizeSessionType(record.sessionType),
    };
    await runWithWriteLock(
      this.options.db,(tx) => {
      const existing = selectRow(tx, normalizedRecord.sessionId);
      if (!existing) {
        tx.insert(sessions).values(encodeSessionRow(normalizedRecord)).run();
        writeSessionSearchDocument(tx, normalizedRecord);
        return;
      }
      const current = decodeSessionRow(existing);
      const next = replaceIdentity
        ? { ...normalizedRecord, historyRelativeDir: current.historyRelativeDir }
        : {
            ...normalizedRecord,
            runtime: current.runtime,
            sessionKind: current.sessionKind,
            sessionOrigin: current.sessionOrigin,
            originCronId: current.originCronId,
            createdAtMs: current.createdAtMs,
            historyRelativeDir: current.historyRelativeDir,
          };
      writeRow(tx, existing, next);
    });
  }
}

function parseInteractionModeEnvelope(raw: string): {
  readonly data: Record<string, unknown>;
  readonly mode: EffectiveSessionInteractionMode;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('Session extra_data_json is not valid JSON', { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Session extra_data_json must be an object');
  }
  const data = parsed as Record<string, unknown>;
  const stored = data.interactionMode;
  if (stored === undefined || stored === null) return { data, mode: 'default' };
  if (stored === 'plan') return { data, mode: 'plan' };
  if (stored === 'goal') return { data, mode: 'goal' };
  throw new Error(`Session has invalid interactionMode: ${String(stored)}`);
}

function scanLimitPredicate(db: AppDb, value: number | undefined): SQL | undefined {
  const limit = positiveInteger(value);
  if (limit === undefined) return undefined;
  const scannedSessionIds = db
    .select({ sessionId: sessions.sessionId })
    .from(sessions)
    .where(eq(sessions.columnarVersion, 3))
    .orderBy(...recencyOrder())
    .limit(limit);
  return inArray(sessions.sessionId, scannedSessionIds);
}

function listScopePredicate(db: AppDb, options: SessionListOptions, internalRootFilter?: SQL): SQL | undefined {
  const base = and(sessionListPredicate(options), internalRootFilter, scanLimitPredicate(db, options.scanLimit));
  const offset = nonNegativeInteger(options.offset);
  if (offset === 0) return base;
  const skippedSessionIds = db
    .select({ sessionId: sessions.sessionId })
    .from(sessions)
    .where(base)
    .orderBy(...recencyOrder())
    .limit(offset);
  return and(base, notInArray(sessions.sessionId, skippedSessionIds));
}

function recencyCursorPredicate(cursor: RecencyCursor | undefined): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(sessions.updatedAtMs, cursor.updatedAtMs),
    and(eq(sessions.updatedAtMs, cursor.updatedAtMs), lt(sessions.createdAtMs, cursor.createdAtMs)),
    and(
      eq(sessions.updatedAtMs, cursor.updatedAtMs),
      eq(sessions.createdAtMs, cursor.createdAtMs),
      gt(sessions.sessionId, cursor.sessionId),
    ),
  );
}

function creationCursorPredicate(cursor: CreationCursor | undefined): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(sessions.createdAtMs, cursor.createdAtMs),
    and(eq(sessions.createdAtMs, cursor.createdAtMs), gt(sessions.sessionId, cursor.sessionId)),
  );
}

function recencyOrder(): [SQL, SQL, SQL] {
  return [desc(sessions.updatedAtMs), desc(sessions.createdAtMs), asc(sessions.sessionId)];
}

function positiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function nonNegativeInteger(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : 0;
}

function selectRow(db: AppDb, sessionId: string): SessionStorageRow | undefined {
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.sessionId, sessionId), eq(sessions.columnarVersion, 3)))
    .get();
}

function writeRow(db: AppDb, existing: SessionStorageRow, record: SessionRecord): void {
  const row = encodeSessionRow(record, {
    preservedRecordJson: existing.recordJson,
    projectId: existing.projectId,
  });
  db.update(sessions).set(row).where(eq(sessions.sessionId, record.sessionId)).run();
  writeSessionSearchDocument(db, record);
}

function assertSessionDefinitionCreate(
  record: SessionRecord,
  input: SessionCreateInput['agentDefinition'] | undefined,
  serialized: ReturnType<typeof serializeSessionAgentDefinition> | undefined,
): void {
  if (!isTaskSession(record)) return;
  if (!input || !serialized) {
    throw new Error(`Session requires an Agent definition: ${record.sessionId}`);
  }
  if (!isCurrentSessionAgentDefinition(input.definition)) {
    throw new Error(`Session requires a V2 Agent definition: ${record.sessionId}`);
  }
}

function normalizeStaleLimit(value: number | undefined): number {
  return value === undefined ? 100 : Math.min(normalizePageLimit(value, 1000), 1000);
}

function isUniqueViolation(error: unknown): boolean {
  return /UNIQUE constraint failed/iu.test(error instanceof Error ? error.message : String(error));
}
