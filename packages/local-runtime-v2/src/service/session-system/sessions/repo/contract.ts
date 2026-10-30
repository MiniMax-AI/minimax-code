import type { AppDb } from '../../../../infra/db/client.js';
import type { ConversationModelThinkingSelection } from '@mavis/conversation-contract';
import type {
  SessionAgentDefinition,
  FrozenAgentExecutionDefinition,
  SessionAgentDefinitionCreate,
  TaskSessionBinding,
  TaskSessionBindingCreate,
} from './agent-binding.js';
import type { SessionMemoryPolicy } from '../memory-policy.js';

export const SESSION_RUNTIMES = ['pi-agent', 'opencode'] as const;
export const SESSION_TYPES = ['root', 'branch'] as const;
export const SESSION_STATUSES = ['idle', 'started', 'error', 'aborted', 'interrupted'] as const;
export const LEGACY_SESSION_STATUSES = [...SESSION_STATUSES, 'finished'] as const;
export const SESSION_VISIBILITIES = ['visible', 'hidden'] as const;
export const SESSION_KINDS = [
  'conversation',
  'task',
  'peek',
  'channel',
  'cron',
  'unknown',
] as const;
export const SESSION_RUN_LOCATION_MODES = ['current', 'new-worktree', 'existing-worktree'] as const;

export type SessionRuntime = (typeof SESSION_RUNTIMES)[number];
export type SessionType = (typeof SESSION_TYPES)[number];
export type SessionTypeInput = SessionType | 'task';
export type SessionStatus = (typeof SESSION_STATUSES)[number];
export type LegacySessionStatus = (typeof LEGACY_SESSION_STATUSES)[number];
export type SessionVisibility = (typeof SESSION_VISIBILITIES)[number];
export type SessionKind = (typeof SESSION_KINDS)[number];
export type SessionRunLocationMode = (typeof SESSION_RUN_LOCATION_MODES)[number];
export type SessionDataOrigin = 'local-runtime' | 'legacy-opencode' | 'unknown';
export type SessionOrigin = 'user' | 'root-repair';
export type AppMode = 'coding' | 'work';
/**
 * How a Session calls tools: `ptc` hides ordinary tools behind run_code, `native` calls them
 * directly. Absent (Sessions created before the field existed) reads as `native`.
 */
export type SessionToolCallMode = 'native' | 'ptc';
export type SessionInteractionMode = 'plan' | 'goal';

export interface SessionRunLocation {
  readonly mode: SessionRunLocationMode;
  readonly resolvedDir: string;
  readonly resolvedBranch?: string;
  readonly parentRepoDir?: string;
  readonly createdAt: number;
}

export interface SessionRecord {
  readonly sessionId: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  readonly isDefaultWorkspace?: boolean;
  readonly runtime: SessionRuntime;
  readonly sessionType: SessionType;
  readonly sessionKind: SessionKind;
  readonly archived: boolean;
  readonly title?: string | null;
  readonly parentSessionId?: string | null;
  readonly visibility?: SessionVisibility;
  readonly purpose?: string;
  readonly originCronId?: string;
  readonly runLocation?: SessionRunLocation;
  readonly appMode?: AppMode;
  /**
   * Set when the Session is created and refreshed only after a summary (`llm_checkpoint`)
   * compaction, so a `beta.ptc` toggle never rewrites the prompt prefix of an ongoing
   * conversation.
   */
  readonly toolCallMode?: SessionToolCallMode;
  readonly interactionMode?: SessionInteractionMode;
  readonly memoryPolicy?: SessionMemoryPolicy;
  readonly status: SessionStatus;
  readonly errorMessage?: string;
  readonly errorCode?: number;
  readonly errorSource?: string;
  readonly errorDetail?: string;
  readonly errorProviderId?: string;
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
  readonly effectiveModelThinking?: ConversationModelThinkingSelection | null;
  readonly effectiveModelContextWindow?: number | null;
  readonly effectiveModelMaxOutputTokens?: number | null;
  readonly scratchpadPath?: string;
  readonly origin?: SessionOrigin;
  readonly sessionDataVersion?: number;
  readonly sessionOrigin?: SessionDataOrigin;
  /** Directory relative to <dataDir>/v2/sessions; assigned once by the history owner. */
  readonly historyRelativeDir?: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export type SessionWriteRecord = Omit<SessionRecord, 'sessionType'> & {
  readonly sessionType: SessionTypeInput;
};

/** Lightweight identity sufficient to resolve the canonical history directory. */
export type SessionHistoryIdentity = Pick<
  SessionRecord,
  'sessionId' | 'createdAtMs' | 'historyRelativeDir'
>;

export interface SessionCreateInput {
  readonly sessionId: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  /** Storage-only Project association used by the Project list query. */
  readonly projectId?: number | null;
  readonly runtime: SessionRuntime;
  readonly sessionKind?: SessionKind;
  readonly sessionType?: SessionTypeInput;
  readonly status?: SessionStatus;
  readonly archived?: boolean;
  readonly visibility?: 'visible' | 'hidden';
  readonly title?: string | null;
  readonly parentSessionId?: string | null;
  readonly purpose?: string;
  readonly originCronId?: string;
  readonly isDefaultWorkspace?: boolean;
  readonly runLocation?: SessionRecord['runLocation'];
  readonly appMode?: SessionRecord['appMode'];
  readonly toolCallMode?: SessionRecord['toolCallMode'];
  readonly errorMessage?: string;
  readonly errorCode?: number;
  readonly errorSource?: string;
  readonly errorDetail?: string;
  readonly errorProviderId?: string;
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
  readonly effectiveModelThinking?: ConversationModelThinkingSelection | null;
  readonly effectiveModelContextWindow?: number | null;
  readonly effectiveModelMaxOutputTokens?: number | null;
  readonly memoryPolicy?: SessionMemoryPolicy;
  readonly origin?: SessionOrigin;
  readonly sessionOrigin?: SessionDataOrigin;
  readonly sessionDataVersion?: number;
  readonly scratchpadPath?: string;
  /** Immutable execution authority, written atomically with every new Task Session row. */
  readonly agentDefinition?: SessionAgentDefinitionCreate;
  /** V1 compatibility input for Task callers that have not moved to `agentDefinition`. */
  readonly taskAgentBinding?: TaskSessionBindingCreate;
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
}

/** Frozen config snapshot persisted for a historical Task without rewriting its model group. */
export interface SessionTaskAgentBindingBackfill {
  readonly taskAgentBinding: TaskSessionBindingCreate;
}

/** Frozen config snapshot persisted without changing a historical model group. */
export interface SessionAgentDefinitionBackfill {
  readonly agentDefinition: SessionAgentDefinitionCreate;
}

type CanonicalSessionUpdateFields = Partial<
  Omit<
    SessionRecord,
    | 'sessionId'
    | 'createdAtMs'
    | 'runtime'
    | 'sessionOrigin'
    | 'originCronId'
    | 'sessionKind'
    | 'sessionDataVersion'
    | 'historyRelativeDir'
  >
>;

export type SessionUpdateFields = Omit<CanonicalSessionUpdateFields, 'sessionType'> & {
  readonly sessionType?: SessionTypeInput;
  readonly modelParameterSnapshot?: FrozenAgentExecutionDefinition['model']['parameterSnapshot'];
};

export interface SessionListOptions {
  readonly excludeInternalDefaultRoots?: boolean;
  readonly agentName?: string;
  readonly runtime?: SessionRuntime;
  readonly workspaceDir?: string;
  readonly requireWorkspaceDir?: boolean;
  readonly originCronId?: string;
  readonly parentSessionId?: string | null;
  readonly archived?: boolean;
  readonly includeHidden?: boolean;
  readonly includeSessionKinds?: readonly SessionKind[];
  readonly excludeSessionKinds?: readonly SessionKind[];
  readonly includePurposePrefix?: string;
  readonly excludePurposePrefix?: string;
  readonly sessionType?: SessionType;
  readonly search?: string;
  readonly cursor?: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly scanLimit?: number;
}

export type SessionCountOptions = Omit<
  SessionListOptions,
  'originCronId' | 'search' | 'cursor' | 'offset' | 'limit' | 'scanLimit'
>;

export interface SessionPage {
  readonly sessions: readonly SessionRecord[];
  readonly hasMore: boolean;
  readonly nextCursor?: string;
}

export interface SessionSearchOptions {
  readonly keyword?: string;
  readonly agentName?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface SessionCronOriginPageOptions {
  readonly originCronId: string;
  readonly archived?: boolean;
  readonly includeHidden?: boolean;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SessionTreeFilter {
  readonly archived?: boolean;
  readonly includeHidden: boolean;
  readonly excludeInternalTreeSessions: boolean;
  readonly includeSessionKinds?: readonly SessionKind[];
  readonly excludeSessionKinds?: readonly SessionKind[];
  readonly includePurposePrefix?: string;
  readonly excludePurposePrefix?: string;
}

export type SessionRootPageOptions = SessionTreeFilter & {
  /**
   * Scopes the root scan to a single Agent. Leaving it undefined keeps the scan
   * cross-Agent, which is what the sidebar aggregate needs: Desktop renders one
   * Recents list covering every Agent, not just the primary one.
   * `sessionAgentNamePredicate` already emits no WHERE clause for `undefined`,
   * so the cross-Agent read reuses the same keyset-cursor query instead of a
   * second SQL path.
   */
  readonly agentName?: string;
  readonly runtime?: SessionRuntime;
  readonly limit?: number;
  readonly cursor?: string;
};

export type SessionProjectRootPageOptions = SessionTreeFilter & {
  readonly projectId: number;
  readonly agentName?: string;
  readonly limit?: number;
  readonly cursor?: string;
};

export type SessionProjectPreviewOptions = SessionTreeFilter & {
  readonly agentName?: string;
  readonly limit?: number;
};

export type SessionChildrenOptions = SessionTreeFilter;

export interface SessionStaleOptions {
  readonly updatedBeforeMs?: number;
  readonly excludedSessionIds?: readonly string[];
  readonly limit?: number;
}

export interface StaleSessionCandidate {
  readonly sessionId: string;
  readonly agentName: string;
  readonly status: 'started';
  readonly updatedAtMs: number;
}

export interface SessionRootSwapInput {
  readonly agentName: string;
  readonly nextRootSessionId: string;
  readonly archivedRootTitle: string;
  readonly linkPreviousRootsToNext?: boolean;
}

export interface SessionRootSwapResult {
  readonly previousRoots: readonly SessionRecord[];
  readonly nextRoot: SessionRecord;
}

export type AgentSessionTerminalOutcome = 'completed' | 'failed' | 'aborted';

export interface AgentSessionStateMutation {
  readonly sessionId: string;
  readonly turnId: string;
  readonly turnSequence: number;
  readonly eventId: string;
  readonly runtimeSeq?: number;
  readonly update: SessionUpdateFields & { readonly status: SessionStatus };
  readonly terminalOutcome?: AgentSessionTerminalOutcome;
}

export type AgentSessionStateWriteResult =
  | { readonly status: 'applied' }
  | { readonly status: 'duplicate' }
  | { readonly status: 'stale' }
  | { readonly status: 'not-found' }
  | { readonly status: 'conflict' };

export const SESSION_REPOSITORY_CAPABILITIES = [
  'get',
  'getMany',
  'has',
  'create',
  'getTaskAgentBinding',
  'backfillTaskAgentBindingIfAbsent',
  'upsertImportedLegacy',
  'upsert',
  'update',
  'detachCronSessions',
  'delete',
  'touch',
  'swapRoot',
  'reparentChildren',
  'applyAgentState',
  'list',
  'count',
  'listPage',
  'searchPage',
  'listByCronOriginPage',
  'listStalePiSessions',
  'listRootPage',
  'listChildren',
  'listChildrenMany',
  'listProjectRootPage',
  'listProjectRootPreviews',
] as const;

export interface SessionRepository {
  get(sessionId: string): Promise<SessionRecord | undefined>;
  getMany(sessionIds: readonly string[]): Promise<Array<SessionRecord | undefined>>;
  has(sessionId: string): Promise<boolean>;
  create(input: SessionCreateInput): Promise<SessionRecord>;
  getSessionAgentDefinition(sessionId: string): Promise<SessionAgentDefinition | undefined>;
  backfillSessionAgentDefinitionIfAbsent(
    sessionId: string,
    backfill: SessionAgentDefinitionBackfill,
  ): Promise<SessionAgentDefinition>;
  replaceSessionAgentDefinitionIfLegacy(
    sessionId: string,
    next: SessionAgentDefinitionBackfill,
  ): Promise<SessionAgentDefinition>;
  /** V1 rollback mirror only; production turns must use the generic API above. */
  getTaskAgentBinding(sessionId: string): Promise<TaskSessionBinding | undefined>;
  backfillTaskAgentBindingIfAbsent(
    sessionId: string,
    backfill: SessionTaskAgentBindingBackfill,
  ): Promise<TaskSessionBinding>;
  upsertImportedLegacy(record: SessionWriteRecord): Promise<void>;
  upsert(record: SessionWriteRecord): Promise<void>;
  /** Expectations are checked atomically with the write; undefined skips title checks, null expects no title. */
  update(
    sessionId: string,
    fields: SessionUpdateFields,
    expectedModel?: SessionModelSnapshot,
    expectedTitle?: string | null,
  ): Promise<SessionRecord | undefined>;
  /** Remove scheduled-task ownership while preserving the conversation and its content. */
  detachCronSessions(originCronId: string, targetSessionId?: string): Promise<SessionRecord[]>;
  delete(sessionId: string): Promise<void>;
  touch(sessionId: string, updatedAtMs?: number): Promise<void>;
  swapRoot(input: SessionRootSwapInput): Promise<SessionRootSwapResult>;
  reparentChildren(parentSessionId: string, nextParentSessionId: string | null): Promise<void>;
  applyAgentState(input: AgentSessionStateMutation): Promise<AgentSessionStateWriteResult>;
  /** First writer wins; returns the authoritative persisted directory. */
  bindHistoryRelativeDir(sessionId: string, relativeDir: string): Promise<string | undefined>;
  listHistoryIdentities(): Promise<SessionHistoryIdentity[]>;
  list(options?: SessionListOptions): Promise<SessionRecord[]>;
  count(options?: SessionCountOptions): Promise<number>;
  listPage(options?: SessionListOptions): Promise<SessionPage>;
  searchPage(options?: SessionSearchOptions): Promise<SessionPage>;
  listByCronOriginPage(options: SessionCronOriginPageOptions): Promise<SessionPage>;
  listStalePiSessions(options?: SessionStaleOptions): Promise<StaleSessionCandidate[]>;
  listRootPage(options: SessionRootPageOptions): Promise<SessionPage>;
  listChildren(parentSessionId: string): Promise<SessionRecord[]>;
  listChildrenMany(
    parentSessionIds: readonly string[],
    options?: SessionChildrenOptions,
  ): Promise<ReadonlyMap<string, readonly SessionRecord[]>>;
  listProjectRootPage(options: SessionProjectRootPageOptions): Promise<SessionPage>;
  listProjectRootPreviews(
    projectIds: readonly number[],
    options?: SessionProjectPreviewOptions,
  ): Promise<ReadonlyMap<number, SessionPage>>;
}

export interface SessionRepositoryOptions {
  readonly agentInternalWorkspaceDir?: (agentName: string) => string;
  readonly db: AppDb;
  readonly nowMs?: () => number;
}

export class SessionUniqueViolation extends Error {
  constructor(readonly sessionId: string) {
    super(`Session ${sessionId} already exists`);
    this.name = 'SessionUniqueViolation';
  }
}

export class SessionRootSwapError extends Error {
  constructor(readonly reason: 'next-root-not-found' | 'agent-mismatch' | 'unsupported-runtime') {
    super(`Session root swap failed: ${reason}`);
    this.name = 'SessionRootSwapError';
  }
}

export class SessionTitleConflictError extends Error {
  constructor() {
    super('Session title changed');
    this.name = 'SessionTitleConflictError';
  }
}

/** All model-owned fields observed by a conditional model repair. */
export type SessionModelSnapshot = Pick<
  SessionRecord,
  | 'effectiveModel'
  | 'effectiveModelVariant'
  | 'effectiveModelThinking'
  | 'effectiveModelContextWindow'
  | 'effectiveModelMaxOutputTokens'
>;
