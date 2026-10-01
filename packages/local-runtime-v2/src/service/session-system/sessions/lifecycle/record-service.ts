import { randomUUID } from 'node:crypto';
import {
  hasConversationTaskModelSelection,
  type ConversationModelThinkingSelection,
  type ConversationModelSelection,
  type ConversationTaskModelSelection,
} from '@mavis/conversation-contract';

import type {
  SessionKind,
  SessionOrigin,
  SessionAgentDefinitionBackfill,
  SessionPage,
  SessionRecord,
  SessionModelSnapshot,
  SessionTaskAgentBindingBackfill,
} from '../repo/contract.js';
import {
  isCurrentSessionAgentDefinition,
  withCurrentSessionAgentDefinitionProject,
  type FrozenAgentExecutionDefinition,
  type LegacyFrozenAgentExecutionDefinition,
  type SessionAgentDefinition,
  type SessionAgentDefinitionCreate,
  type TaskSessionBinding,
  type TaskSessionBindingCreate,
} from '../repo/agent-binding.js';
import { isTaskSession } from '../repo/drizzle/normalization.js';
import { AgentServiceError } from '../../../agent/errors.js';
import { SessionServiceError } from '../errors.js';
import { isDefaultProjectWorkspace } from '../../shared/project-workspace.js';
import type {
  SessionMutationFields,
  SessionMetadataCreateInput,
  SessionMetadataWriter,
} from './lifecycle-contract.js';
import {
  appModeFields,
  assertNativeMutation,
  assertTaskParent,
  createDefaultWorkspaceIdentity,
  errorMessage,
  internalDefaultWorkspaceIdentity,
  internalExplicitWorkspaceDir,
  modelKey,
  nonEmpty,
  normalizeAppMode,
  normalizeMemoryPolicyMutation,
  optionalModelVariant,
  sessionCaptureCandidate,
  sessionNotFound,
  taskMemoryPolicyFor,
  taskWorkspaceFor,
  visibilityForInternalKind,
  visibilityForKind,
  whenDefined,
  whenPresent,
  type SessionAppMode,
} from './record-service-fields.js';

export type { SessionMetadataCreateInput, SessionMetadataWriter } from './lifecycle-contract.js';

/** Immutable execution payload captured before Session+definition persistence begins. */
export interface CapturedTaskAgentBinding {
  readonly agentDefinition: SessionAgentDefinitionCreate;
  /** Downlevel Task-only mirror used by rollback-compatible persistence. */
  readonly taskAgentBinding: TaskSessionBindingCreate;
  readonly effectiveModel: string;
  readonly effectiveModelVariant?: string;
  readonly effectiveModelThinking?: ConversationModelThinkingSelection;
  readonly effectiveModelContextWindow?: number;
  readonly effectiveModelMaxOutputTokens?: number;
}

export interface SessionCreateInput {
  readonly agentName: string;
  readonly workspaceDir?: string;
  readonly title?: string | null;
  readonly parentSessionId?: string | null;
  readonly visibility?: 'visible' | 'hidden';
  readonly purpose?: string;
  readonly sessionKind?: SessionKind;
  readonly appMode?: SessionAppMode;
  readonly isDefaultWorkspace?: boolean;
  readonly runLocation?: unknown;
  readonly model?: ConversationModelSelection;
  readonly effectiveModelContextWindow?: number;
  readonly effectiveModelMaxOutputTokens?: number;
}

export interface InternalSessionCreateInput {
  readonly agentName: string;
  readonly workspaceDir?: string;
  readonly sessionType?: 'root' | 'branch';
  readonly sessionKind?: SessionKind;
  readonly title?: string | null;
  readonly parentSessionId?: string | null;
  readonly visibility?: 'visible' | 'hidden';
  readonly purpose?: string;
  readonly originCronId?: string;
  readonly runLocation?: SessionRecord['runLocation'];
  readonly appMode?: SessionAppMode;
  readonly effectiveModel?: string | null;
  readonly effectiveModelVariant?: string | null;
  readonly effectiveModelThinking?: ConversationModelThinkingSelection | null;
  readonly effectiveModelContextWindow?: number | null;
  readonly effectiveModelMaxOutputTokens?: number | null;
  readonly taskModelSelection?: ConversationTaskModelSelection;
  readonly isDefaultWorkspace?: boolean;
  /** Preserve an owner-supplied Project identity even when Fork adds a run location. */
  readonly preserveDefaultWorkspaceIdentity?: boolean;
  /** Trusted Fork-only snapshot; its owner, prompt, capabilities and model remain immutable. */
  readonly forkedAgentDefinition?: SessionAgentDefinitionCreate;
  readonly origin?: SessionOrigin;
}

export interface SessionInternalCreationCapability {
  createInternalSession(input: InternalSessionCreateInput): Promise<SessionRecord>;
}

export interface SessionRootCreationCapability {
  createRootSession(input: {
    readonly agentName: string;
    readonly workspaceDir?: string;
    readonly isDefaultWorkspace?: boolean;
  }): Promise<SessionRecord>;
}

export type SessionCommittedFact =
  | { readonly kind: 'created'; readonly session: SessionRecord }
  | { readonly kind: 'visibility-updated'; readonly session: SessionRecord }
  | { readonly kind: 'title-updated'; readonly session: SessionRecord; readonly title: string }
  | { readonly kind: 'model-updated'; readonly session: SessionRecord }
  | { readonly kind: 'interaction-mode-updated'; readonly session: SessionRecord }
  | { readonly kind: 'archive-changed'; readonly sessionId: string; readonly archived: boolean }
  | { readonly kind: 'deleted'; readonly sessionId: string };

export interface SessionFactSink {
  handle(fact: SessionCommittedFact): void;
}

/**
 * Stable, narrow entry emitted when the startup full-Session-definition backfill
 * deliberately skips a single Session because the historical Agent name no longer
 * resolves. The set of fields is frozen so the runtime / product can rely on
 * them for log filtering and post-incident triage; consumers MUST NOT add
 * `systemPrompt`, captured definition bodies, or any on-disk path content.
 */
export interface SessionAgentDefinitionBackfillSkip {
  readonly code: 'AGENT_NOT_FOUND';
  readonly reason: 'startup-backfill-deleted-agent-skip';
  readonly sessionId: string;
  readonly agentName: string;
  readonly status: SessionRecord['status'];
  readonly sessionKind: SessionKind;
}

export interface SessionBackfillDiagnostics {
  /**
   * One Session in the startup backfill threw AGENT_NOT_FOUND. The Session is
   * intentionally left without a captured definition; subsequent pages continue.
   * Per-Session `ensureSessionAgentDefinition` keeps failing closed so the
   * same dead reference surfaces again the moment the owner explicitly reopens
   * the Session. The hook MUST be best-effort; throwing aborts the backfill.
   */
  reportAgentDefinitionSkip(entry: SessionAgentDefinitionBackfillSkip): void;
}

export interface SessionRecordServiceDeps {
  readonly sessions: {
    get(sessionId: string): Promise<SessionRecord | undefined>;
    listPage?(options?: {
      readonly cursor?: string;
      readonly limit?: number;
    }): Promise<SessionPage>;
  };
  /**
   * The only persistence path for binding backfill on an existing Session.
   * It stays narrow so Turn and Fork owners cannot manufacture a frozen
   * definition from an incomplete pre-ready view.
   */
  readonly agentBindings?: {
    getSessionAgentDefinition(sessionId: string): Promise<SessionAgentDefinition | undefined>;
    backfillSessionAgentDefinitionIfAbsent(
      sessionId: string,
      backfill: SessionAgentDefinitionBackfill,
    ): Promise<SessionAgentDefinition>;
    replaceSessionAgentDefinitionIfLegacy(
      sessionId: string,
      next: SessionAgentDefinitionBackfill,
    ): Promise<SessionAgentDefinition>;
    getTaskAgentBinding(sessionId: string): Promise<TaskSessionBinding | undefined>;
    backfillTaskAgentBindingIfAbsent(
      sessionId: string,
      backfill: SessionTaskAgentBindingBackfill,
    ): Promise<TaskSessionBinding>;
  };
  readonly metadata: SessionMetadataWriter;
  /** Model-only admission for ordinary explicit selections, before record persistence. */
  readonly resolveRequestedModel?: (
    model: ConversationModelSelection,
  ) => ConversationModelSelection;
  readonly agents: {
    getDefaults(agentName: string): Promise<{ readonly defaultWorkspaceDir?: string } | undefined>;
  };
  readonly runLocation: {
    resolve(input: unknown, workspaceDir: string): Promise<SessionRecord['runLocation']>;
  };
  readonly titlePolicy: { blocks(title: string, session: SessionRecord): Promise<boolean> };
  readonly artifacts?: {
    initialize(sessionId: string): Promise<void>;
    delete(sessionId: string): Promise<void>;
  };
  readonly facts: SessionFactSink;
  readonly workspace?: { initialize(workspaceDir: string): Promise<void> };
  /**
   * Optional best-effort diagnostic sink for the startup full-Session-definition
   * backfill. Missing or test-only compositions may omit it; production wires
   * the existing runtime `logger` + `reportFailure` here.
   */
  readonly backfillDiagnostics?: SessionBackfillDiagnostics;
  /** Runtime-owned default Project directory used only when creating Root Sessions. */
  readonly defaultWorkspaceDir?: () => string;
  /** Current Agent-private fallback directory used only when creating Root Sessions. */
  readonly agentInternalWorkspaceDir?: (agentName: string) => string;
  readonly sessionDefaultWorkspaceDir?: (sessionId: string) => string;
  readonly makeSessionId?: () => string;
  /** Required by production creation paths so a Task is inserted already frozen. */
  readonly taskAgentBindingCapture?: {
    capture(input: {
      readonly agentName: string;
      readonly session?: SessionRecord;
      readonly parent?: SessionRecord;
      readonly appMode?: SessionRecord['appMode'];
      readonly taskModelSelection?: ConversationTaskModelSelection;
      readonly requestedModel?: ConversationModelSelection;
      readonly parentModel?: FrozenAgentExecutionDefinition['model'];
    }): Promise<CapturedTaskAgentBinding>;
    captureSessionDefinition(input: {
      readonly agentName: string;
      readonly session?: SessionRecord;
      readonly parent?: SessionRecord;
      readonly appMode?: SessionRecord['appMode'];
      readonly legacyDefinition?: LegacyFrozenAgentExecutionDefinition;
    }): Promise<SessionAgentDefinitionBackfill>;
    captureFrozenDefinition(input: {
      readonly agentName: string;
      readonly parent: SessionRecord;
      readonly appMode?: SessionRecord['appMode'];
    }): Promise<SessionTaskAgentBindingBackfill>;
  };
}

export class SessionRecordService
  implements SessionRootCreationCapability, SessionInternalCreationCapability
{
  private readonly makeSessionId: () => string;
  private taskAgentBindingCapture: SessionRecordServiceDeps['taskAgentBindingCapture'];

  constructor(private readonly deps: SessionRecordServiceDeps) {
    this.makeSessionId = deps.makeSessionId ?? (() => `mvs_${randomUUID().replaceAll('-', '')}`);
    this.taskAgentBindingCapture = deps.taskAgentBindingCapture;
  }

  /** Bound by production composition only after Agent and ModelSystem are ready. */
  bindTaskAgentBindingCapture(
    capture: NonNullable<SessionRecordServiceDeps['taskAgentBindingCapture']>,
  ): void {
    this.taskAgentBindingCapture = capture;
  }

  isTaskSession(session: SessionRecord): boolean {
    return isTaskSession(session);
  }

  /**
   * Read gate for frozen Task execution. A missing or V1 definition is upgraded
   * before execution; ordinary Sessions always read the live Agent definition.
   */
  async ensureSessionAgentDefinition(
    sessionId: string,
  ): Promise<SessionAgentDefinition | undefined> {
    const session = await this.requireSession(sessionId);
    if (!isTaskSession(session)) return undefined;
    const bindings = this.requireSessionAgentBindings();
    const existing = await bindings.getSessionAgentDefinition(sessionId);
    if (existing && isCurrentSessionAgentDefinition(existing.definition)) return existing;
    const legacyDefinition =
      existing && !isCurrentSessionAgentDefinition(existing.definition)
        ? existing.definition
        : undefined;

    const parent = await this.resolveParent(session.parentSessionId);
    const backfill = await this.captureHistoricalSessionAgentDefinition({
      agentName: session.agentName,
      session,
      parent,
      appMode: session.appMode,
      ...(legacyDefinition ? { legacyDefinition } : {}),
    });
    if (existing) {
      return bindings.replaceSessionAgentDefinitionIfLegacy(sessionId, backfill);
    }
    return bindings.backfillSessionAgentDefinitionIfAbsent(sessionId, backfill);
  }

  /** Reads historical routing identity without creating or upgrading a definition. */
  async readSessionAgentRouting(sessionId: string): Promise<
    | {
        readonly session: SessionRecord;
        readonly definition?: SessionAgentDefinition;
      }
    | undefined
  > {
    const session = await this.deps.sessions.get(sessionId);
    if (!session) return undefined;
    const definition = await this.deps.agentBindings?.getSessionAgentDefinition(sessionId);
    return { session, ...(definition ? { definition } : {}) };
  }

  /** Startup gate: complete/upgrade historical rows before inbound Turn admission. */
  async backfillAllSessionAgentDefinitions(): Promise<void> {
    const sessions = this.deps.sessions;
    if (!sessions.listPage) {
      throw new SessionServiceError(
        'task-agent-capture-unavailable',
        'Session Agent definition enumeration is unavailable',
      );
    }
    let cursor: string | undefined;
    do {
      const page = await sessions.listPage({ ...(cursor ? { cursor } : {}), limit: 100 });
      for (const session of page.sessions) {
        await this.backfillSessionAgentDefinitionForStartup(session);
      }
      cursor = page.nextCursor;
      if (!page.hasMore) return;
    } while (cursor);
  }

  private async backfillSessionAgentDefinitionForStartup(session: SessionRecord): Promise<void> {
    if (!isTaskSession(session)) return;
    try {
      await this.ensureSessionAgentDefinition(session.sessionId);
    } catch (error) {
      // Startup backfill sweep tolerates a deleted historical Agent so one dead
      // reference does not stop the runtime from reaching `ready()`. Explicit
      // Session reopen still fails closed through ensureSessionAgentDefinition.
      if (!this.isAgentNotFoundError(error)) throw error;
      this.reportDeletedAgentBackfillSkip(session);
    }
  }

  private reportDeletedAgentBackfillSkip(session: SessionRecord): void {
    // Telemetry delivery MUST stay best-effort here. The capture layer has
    // already decided this is a deleted-Agent skip and the sweep must continue.
    try {
      this.deps.backfillDiagnostics?.reportAgentDefinitionSkip({
        code: 'AGENT_NOT_FOUND',
        reason: 'startup-backfill-deleted-agent-skip',
        sessionId: session.sessionId,
        agentName: session.agentName,
        status: session.status,
        sessionKind: session.sessionKind,
      });
    } catch (sinkError) {
      // A failing logger or network sink cannot re-escalate the skipped row.
      void sinkError;
    }
  }

  /**
   * True only when the error is an `AgentServiceError` carrying the stable
   * `AGENT_NOT_FOUND` code. Other `AgentServiceError` codes, Session-level
   * errors, plain Errors, and any wrapped error keep failing the sweep.
   */
  private isAgentNotFoundError(error: unknown): boolean {
    return error instanceof AgentServiceError && error.code === 'AGENT_NOT_FOUND';
  }

  /** Backfills only the frozen definition of a historical Task, once. */
  async ensureTaskAgentBinding(sessionId: string): Promise<TaskSessionBinding> {
    const bindings = this.deps.agentBindings;
    if (!bindings) {
      throw new SessionServiceError(
        'task-agent-capture-unavailable',
        'Task Session Agent binding persistence is unavailable',
      );
    }
    const existing = await bindings.getTaskAgentBinding(sessionId);
    if (existing) return existing;

    const session = await this.requireSession(sessionId);
    if (!isTaskSession(session)) {
      throw new SessionServiceError(
        'invalid-session-kind',
        'Task Agent binding requires a Task Session',
      );
    }

    const parent = await this.resolveParent(session.parentSessionId);
    if (!parent) {
      throw new SessionServiceError('parent-required', 'task Session requires a parent Session');
    }
    const backfill = await this.captureHistoricalTaskAgentBinding({
      agentName: session.agentName,
      parent,
      appMode: session.appMode,
    });
    return bindings.backfillTaskAgentBindingIfAbsent(sessionId, backfill);
  }

  async createSession(input: SessionCreateInput): Promise<SessionRecord> {
    const context = await this.prepareSessionCreate(input);
    return this.createRecord(toMetadataCreateInput(context));
  }

  async createInternalSession(input: InternalSessionCreateInput): Promise<SessionRecord> {
    const context = await this.prepareInternalSessionCreate(input);
    return this.createRecord(toInternalMetadataCreateInput(context));
  }

  private resolveCreateModel(input: SessionCreateInput): SessionCreateInput {
    if (input.sessionKind === 'task' || !input.model) return input;
    if (!this.deps.resolveRequestedModel)
      throw new Error('Session model resolution is unavailable');
    return { ...input, model: this.deps.resolveRequestedModel(input.model) };
  }

  private async prepareSessionCreate(requested: SessionCreateInput): Promise<CreateMetadataContext> {
    const sessionId = this.makeSessionId();
    const agent = await this.requireAgentDefaults(requested.agentName);
    const parent = await this.resolveParent(requested.parentSessionId);
    const input = this.resolveCreateModel(requested);
    const sessionKind = input.sessionKind ?? 'conversation';
    assertTaskParent(sessionKind, parent);
    const explicitWorkspaceDir = nonEmpty(input.workspaceDir);
    const workspace = await this.resolveCreateWorkspace({
      sessionId,
      sessionKind,
      parent,
      explicitWorkspaceDir,
      agent,
    });
    const appMode = normalizeAppMode(input.appMode ?? parent?.appMode);
    const runLocation = await this.resolveCreateRunLocation(
      input.runLocation,
      appMode,
      workspace.workspaceDir,
    );
    const isDefaultWorkspace = createDefaultWorkspaceIdentity({
      taskWorkspace: workspace.taskWorkspace,
      parent,
      runLocation,
      explicitWorkspaceDir,
      requested: input.isDefaultWorkspace,
    });
    const taskCapture = await this.captureSessionAgentDefinition({
      agentName: input.agentName,
      ...(input.model ? { requestedModel: input.model } : {}),
      session: sessionCaptureCandidate({
        sessionId,
        agentName: input.agentName,
        workspaceDir: workspace.taskWorkspace ?? runLocation?.resolvedDir ?? workspace.workspaceDir,
        isDefaultWorkspace,
        sessionType: 'branch',
        sessionKind,
        parentSessionId: input.parentSessionId ?? null,
        visibility:
          visibilityForKind(sessionKind, input.visibility, parent?.visibility) ?? 'visible',
        appMode,
        effectiveModel: modelKey(input.model?.providerId, input.model?.modelId),
        effectiveModelVariant: optionalModelVariant(input.model?.variant),
        effectiveModelContextWindow: input.effectiveModelContextWindow,
        effectiveModelMaxOutputTokens: input.effectiveModelMaxOutputTokens,
      }),
      parent,
      appMode,
    });
    return {
      input,
      sessionId,
      requestedWorkspaceDir: workspace.workspaceDir,
      appMode,
      runLocation,
      taskWorkspace: workspace.taskWorkspace,
      isDefaultWorkspace,
      parentVisibility: parent?.visibility,
      taskMemoryPolicy: taskMemoryPolicyFor(sessionKind, parent),
      taskCapture,
    };
  }

  private async prepareInternalSessionCreate(
    input: InternalSessionCreateInput,
  ): Promise<InternalMetadataContext> {
    const sessionId = this.makeSessionId();
    const agent = await this.requireAgentDefaults(input.agentName);
    const parent = await this.resolveParent(input.parentSessionId);
    const sessionKind = input.sessionKind ?? 'conversation';
    assertTaskParent(sessionKind, parent);
    const taskWorkspace = taskWorkspaceFor(sessionKind, parent);
    const explicitWorkspaceDir = taskWorkspace ?? internalExplicitWorkspaceDir(input);
    const workspace = await this.resolveCreateWorkspace({
      sessionId,
      sessionKind,
      parent,
      explicitWorkspaceDir,
      agent,
    });
    const appMode = input.appMode ?? parent?.appMode;
    const sessionType = input.sessionType ?? 'branch';
    const isDefaultWorkspace =
      taskWorkspace !== undefined
        ? parent?.isDefaultWorkspace === true
        : internalDefaultWorkspaceIdentity(input, workspace.implicitDefaultWorkspace);
    const workspaceDir = taskWorkspace ?? input.runLocation?.resolvedDir ?? workspace.workspaceDir;
    const definition = await this.prepareInternalAgentDefinition({
      input,
      sessionId,
      parent,
      sessionKind,
      sessionType,
      workspaceDir,
      isDefaultWorkspace,
      appMode,
      taskModelSelection: input.taskModelSelection,
    });
    return {
      input,
      sessionId,
      parent,
      sessionKind,
      taskWorkspace,
      workspace,
      taskMemoryPolicy: taskMemoryPolicyFor(sessionKind, parent),
      workspaceDir,
      isDefaultWorkspace,
      ...definition,
    };
  }

  private async prepareInternalAgentDefinition(input: {
    readonly input: InternalSessionCreateInput;
    readonly sessionId: string;
    readonly parent: SessionRecord | undefined;
    readonly sessionKind: SessionKind;
    readonly sessionType: 'root' | 'branch';
    readonly workspaceDir: string;
    readonly isDefaultWorkspace: boolean;
    readonly appMode: SessionAppMode | undefined;
    readonly taskModelSelection?: ConversationTaskModelSelection;
  }): Promise<Pick<InternalMetadataContext, 'taskCapture' | 'forkedAgentDefinition'>> {
    const session = sessionCaptureCandidate({
      sessionId: input.sessionId,
      agentName: input.input.agentName,
      workspaceDir: input.workspaceDir,
      isDefaultWorkspace: input.isDefaultWorkspace,
      sessionType: input.sessionType,
      sessionKind: input.sessionKind,
      parentSessionId: input.input.parentSessionId ?? null,
      visibility:
        visibilityForInternalKind(
          input.sessionKind,
          input.input.visibility,
          input.parent?.visibility,
        ) ?? 'visible',
      appMode: input.appMode,
      effectiveModel: input.input.effectiveModel,
      effectiveModelVariant: input.input.effectiveModelVariant,
      effectiveModelThinking: input.input.effectiveModelThinking,
      effectiveModelContextWindow: input.input.effectiveModelContextWindow,
      effectiveModelMaxOutputTokens: input.input.effectiveModelMaxOutputTokens,
    });
    if (input.input.forkedAgentDefinition && isTaskSession(session)) {
      return {
        taskCapture: undefined,
        forkedAgentDefinition: withCurrentSessionAgentDefinitionProject(
          input.input.forkedAgentDefinition,
          {
            workspaceDir: input.workspaceDir,
            isDefaultWorkspace: input.isDefaultWorkspace,
          },
        ),
      };
    }
    return {
      forkedAgentDefinition: undefined,
      taskCapture: await this.captureSessionAgentDefinition({
        agentName: input.input.agentName,
        session,
        parent: input.parent,
        appMode: input.appMode,
        ...(hasConversationTaskModelSelection(input.taskModelSelection)
          ? { taskModelSelection: input.taskModelSelection }
          : {}),
      }),
    };
  }

  private async resolveCreateWorkspace(input: {
    readonly sessionId: string;
    readonly sessionKind: SessionKind;
    readonly parent: SessionRecord | undefined;
    readonly explicitWorkspaceDir: string | undefined;
    readonly agent: { readonly defaultWorkspaceDir?: string };
  }): Promise<ResolvedCreateWorkspace> {
    const taskWorkspace = taskWorkspaceFor(input.sessionKind, input.parent);
    if (taskWorkspace) {
      return {
        workspaceDir: taskWorkspace,
        implicitDefaultWorkspace: input.parent?.isDefaultWorkspace === true,
        taskWorkspace,
      };
    }
    const workspace = await this.resolveWorkspace(
      input.sessionId,
      input.explicitWorkspaceDir,
      input.agent,
    );
    return { ...workspace, taskWorkspace };
  }

  private async resolveCreateRunLocation(
    requested: unknown,
    appMode: SessionAppMode,
    workspaceDir: string,
  ): Promise<SessionRecord['runLocation']> {
    if (!requested || appMode !== 'coding') return undefined;
    return this.resolveRunLocation(requested, workspaceDir);
  }

  async createRootSession(input: {
    readonly agentName: string;
    readonly workspaceDir?: string;
    readonly isDefaultWorkspace?: boolean;
  }): Promise<SessionRecord> {
    const sessionId = this.makeSessionId();
    const explicitWorkspaceDir = nonEmpty(input.workspaceDir);
    const agent = explicitWorkspaceDir ? {} : await this.requireAgentDefaults(input.agentName);
    const workspace = await this.resolveWorkspace(sessionId, explicitWorkspaceDir, agent);
    const isDefaultWorkspace = this.rootWorkspaceIdentity({
      agentName: input.agentName,
      sessionId,
      requested: input.isDefaultWorkspace,
      workspace,
    });
    return this.createRecord({
      sessionId,
      agentName: input.agentName,
      workspaceDir: workspace.workspaceDir,
      isDefaultWorkspace,
      sessionType: 'root',
      sessionKind: 'conversation',
      title: 'Main',
      parentSessionId: null,
      origin: 'root-repair',
    });
  }

  private async resolveWorkspace(
    sessionId: string,
    explicitWorkspaceDir: string | undefined,
    agent: { readonly defaultWorkspaceDir?: string },
  ): Promise<ResolvedWorkspace> {
    if (explicitWorkspaceDir) {
      return { workspaceDir: explicitWorkspaceDir, implicitDefaultWorkspace: false };
    }
    const agentDefaultWorkspaceDir = nonEmpty(agent.defaultWorkspaceDir);
    if (agentDefaultWorkspaceDir) {
      return {
        workspaceDir: agentDefaultWorkspaceDir,
        implicitDefaultWorkspace: true,
        agentDefaultWorkspaceDir,
      };
    }
    const sessionDefaultWorkspaceDir = nonEmpty(this.deps.sessionDefaultWorkspaceDir?.(sessionId));
    if (!sessionDefaultWorkspaceDir) {
      throw new SessionServiceError(
        'workspace-required',
        'Session workspace directory is required',
      );
    }
    await this.deps.workspace?.initialize(sessionDefaultWorkspaceDir);
    return { workspaceDir: sessionDefaultWorkspaceDir, implicitDefaultWorkspace: true };
  }

  private rootWorkspaceIdentity(input: {
    readonly agentName: string;
    readonly sessionId: string;
    readonly requested: boolean | undefined;
    readonly workspace: ResolvedWorkspace;
  }): boolean {
    if (input.requested !== undefined) return input.requested;
    if (input.workspace.agentDefaultWorkspaceDir === undefined) {
      return input.workspace.implicitDefaultWorkspace;
    }
    return isDefaultProjectWorkspace({
      sessionId: input.sessionId,
      workspaceDir: input.workspace.workspaceDir,
      defaultWorkspaceDir: this.deps.defaultWorkspaceDir?.(),
      sessionDefaultWorkspaceDir: this.deps.sessionDefaultWorkspaceDir?.(input.sessionId),
      agentInternalWorkspaceDir: this.deps.agentInternalWorkspaceDir?.(input.agentName),
      agentName: input.agentName,
    });
  }

  private async captureSessionAgentDefinition(input: {
    readonly agentName: string;
    readonly session: SessionRecord;
    readonly parent: SessionRecord | undefined;
    readonly appMode?: SessionRecord['appMode'];
    readonly taskModelSelection?: ConversationTaskModelSelection;
    readonly requestedModel?: ConversationModelSelection;
  }): Promise<CapturedTaskAgentBinding | undefined> {
    if (!isTaskSession(input.session)) return undefined;
    const capture = this.taskAgentBindingCapture;
    if (!capture) {
      throw new SessionServiceError(
        'task-agent-capture-unavailable',
        'Session Agent definition capture is unavailable',
      );
    }
    const parentDefinition = input.parent
      ? await this.deps.agentBindings?.getSessionAgentDefinition(input.parent.sessionId)
      : undefined;
    const parentModel =
      parentDefinition?.definition.definitionVersion === 2
        ? parentDefinition.definition.model
        : undefined;
    return capture.capture({
      agentName: input.agentName,
      session: input.session,
      ...(input.parent ? { parent: input.parent } : {}),
      ...(input.appMode ? { appMode: input.appMode } : {}),
      ...(parentModel?.parameterSnapshot ? { parentModel } : {}),
      ...(input.requestedModel ? { requestedModel: input.requestedModel } : {}),
      ...(hasConversationTaskModelSelection(input.taskModelSelection)
        ? { taskModelSelection: input.taskModelSelection }
        : {}),
    });
  }

  private async captureHistoricalTaskAgentBinding(input: {
    readonly agentName: string;
    readonly parent: SessionRecord;
    readonly appMode?: SessionRecord['appMode'];
  }): Promise<SessionTaskAgentBindingBackfill> {
    const capture = this.taskAgentBindingCapture;
    if (!capture) {
      throw new SessionServiceError(
        'task-agent-capture-unavailable',
        'Task Agent binding capture is unavailable',
      );
    }
    return capture.captureFrozenDefinition({
      agentName: input.agentName,
      parent: input.parent,
      ...(input.appMode ? { appMode: input.appMode } : {}),
    });
  }

  private requireSessionAgentBindings(): NonNullable<SessionRecordServiceDeps['agentBindings']> {
    const bindings = this.deps.agentBindings;
    if (!bindings) {
      throw new SessionServiceError(
        'task-agent-capture-unavailable',
        'Session Agent definition persistence is unavailable',
      );
    }
    return bindings;
  }

  private async captureHistoricalSessionAgentDefinition(input: {
    readonly agentName: string;
    readonly session: SessionRecord;
    readonly parent: SessionRecord | undefined;
    readonly appMode?: SessionRecord['appMode'];
    readonly legacyDefinition?: LegacyFrozenAgentExecutionDefinition;
  }): Promise<SessionAgentDefinitionBackfill> {
    const capture = this.taskAgentBindingCapture;
    if (!capture) {
      throw new SessionServiceError(
        'task-agent-capture-unavailable',
        'Session Agent definition capture is unavailable',
      );
    }
    return capture.captureSessionDefinition({
      agentName: input.agentName,
      session: input.session,
      ...(input.parent ? { parent: input.parent } : {}),
      ...(input.appMode ? { appMode: input.appMode } : {}),
      ...(input.legacyDefinition ? { legacyDefinition: input.legacyDefinition } : {}),
    });
  }

  private async requireAgentDefaults(
    agentName: string,
  ): Promise<{ readonly defaultWorkspaceDir?: string }> {
    const agent = await this.deps.agents.getDefaults(agentName);
    if (agent) return agent;
    throw new SessionServiceError('agent-not-found', `Agent not found: ${agentName}`);
  }

  async mutateSession(
    sessionId: string,
    fields: SessionMutationFields,
    expectedModel?: SessionModelSnapshot,
    expectedTitle?: string | null,
  ): Promise<SessionRecord> {
    const current = await this.requireSession(sessionId);
    assertNativeMutation(current);
    if (
      fields.title !== undefined &&
      fields.title !== null &&
      (await this.deps.titlePolicy.blocks(fields.title, current))
    ) {
      throw new SessionServiceError('content-policy-rejected', 'Content validation failed');
    }
    const normalizedFields = normalizeMemoryPolicyMutation(current, fields);
    if (Object.keys(normalizedFields).length === 0) return current;
    const updated = await this.deps.metadata.update(
      sessionId,
      normalizedFields,
      expectedModel,
      expectedTitle,
    );
    if (!updated) throw sessionNotFound(sessionId);
    if (
      Object.hasOwn(normalizedFields, 'visibility') &&
      (current.visibility ?? 'visible') !== (updated.visibility ?? 'visible')
    ) {
      this.deps.facts.handle({ kind: 'visibility-updated', session: updated });
    }
    return updated;
  }

  deleteSessionRecord(sessionId: string): Promise<void> {
    return this.deps.metadata.delete(sessionId);
  }

  async discardCreatedSession(sessionId: string): Promise<void> {
    const failures = await this.cleanupCreatedSession(sessionId);
    if (failures.length > 0) {
      throw new AggregateError(failures, `Transient Session cleanup failed: ${sessionId}`);
    }
    this.deps.facts.handle({ kind: 'deleted', sessionId });
  }

  async requireSession(sessionId: string): Promise<SessionRecord> {
    const session = await this.deps.sessions.get(sessionId);
    if (!session) throw sessionNotFound(sessionId);
    return session;
  }

  private async createRecord(input: SessionMetadataCreateInput): Promise<SessionRecord> {
    const created = await this.deps.metadata.create(input);
    try {
      await this.deps.artifacts?.initialize(created.sessionId);
    } catch (error) {
      await this.compensateCreate(created.sessionId, error);
    }
    this.deps.facts.handle({ kind: 'created', session: created });
    return created;
  }

  private async compensateCreate(sessionId: string, original: unknown): Promise<never> {
    const failures = await this.cleanupCreatedSession(sessionId);
    if (failures.length > 0) {
      throw new AggregateError(
        [original, ...failures],
        `${errorMessage(original)}; Session create compensation failed`,
      );
    }
    throw original;
  }

  private async cleanupCreatedSession(sessionId: string): Promise<unknown[]> {
    try {
      await this.deps.artifacts?.delete(sessionId);
    } catch (error) {
      // Artifact deletion resolves its path from the Session row. Preserve the
      // row on failure so the whole compensation remains retryable.
      return [error];
    }
    try {
      await this.deps.metadata.delete(sessionId);
      return [];
    } catch (error) {
      return [error];
    }
  }

  private async resolveParent(
    parentSessionId: string | null | undefined,
  ): Promise<SessionRecord | undefined> {
    if (!parentSessionId) return undefined;
    const parent = await this.deps.sessions.get(parentSessionId);
    if (!parent)
      throw new SessionServiceError(
        'parent-not-found',
        `Parent Session not found: ${parentSessionId}`,
      );
    return parent;
  }

  private async resolveRunLocation(
    input: unknown,
    workspaceDir: string,
  ): Promise<SessionRecord['runLocation']> {
    try {
      return await this.deps.runLocation.resolve(input, workspaceDir);
    } catch (error) {
      const code =
        error && typeof error === 'object' && typeof Reflect.get(error, 'code') === 'string'
          ? String(Reflect.get(error, 'code'))
          : undefined;
      throw new SessionServiceError('run-location-invalid', errorMessage(error), code);
    }
  }
}

interface CreateMetadataContext {
  readonly input: SessionCreateInput;
  readonly sessionId: string;
  readonly requestedWorkspaceDir: string;
  readonly appMode: SessionAppMode;
  readonly runLocation: SessionRecord['runLocation'];
  /** Task Sessions retain the parent workspace even when a run location is present. */
  readonly taskWorkspace?: string;
  readonly isDefaultWorkspace: boolean;
  readonly parentVisibility: SessionRecord['visibility'];
  readonly taskMemoryPolicy?: SessionRecord['memoryPolicy'];
  readonly taskCapture?: CapturedTaskAgentBinding;
}

interface ResolvedWorkspace {
  readonly workspaceDir: string;
  readonly implicitDefaultWorkspace: boolean;
  readonly agentDefaultWorkspaceDir?: string;
}

interface ResolvedCreateWorkspace extends ResolvedWorkspace {
  readonly taskWorkspace?: string;
}

interface InternalMetadataContext {
  readonly input: InternalSessionCreateInput;
  readonly sessionId: string;
  readonly parent: SessionRecord | undefined;
  readonly sessionKind: SessionKind;
  readonly taskWorkspace?: string;
  readonly workspace: ResolvedCreateWorkspace;
  readonly taskMemoryPolicy?: SessionRecord['memoryPolicy'];
  readonly workspaceDir: string;
  readonly isDefaultWorkspace: boolean;
  readonly taskCapture?: CapturedTaskAgentBinding;
  readonly forkedAgentDefinition?: CurrentSessionAgentDefinitionCreate;
}

type CurrentSessionAgentDefinitionCreate = ReturnType<
  typeof withCurrentSessionAgentDefinitionProject
>;

function toMetadataCreateInput(context: CreateMetadataContext): SessionMetadataCreateInput {
  const requestedKind = metadataSessionKind(context.input);
  return {
    ...metadataIdentityFields(context, requestedKind),
    sessionType: 'branch',
    sessionKind: requestedKind,
    ...whenDefined('memoryPolicy', context.taskMemoryPolicy),
    ...metadataModelFields(context.input, context.taskCapture),
    ...metadataBindingFields(context.taskCapture),
    origin: 'user',
  };
}

function toInternalMetadataCreateInput(
  context: InternalMetadataContext,
): SessionMetadataCreateInput {
  const sessionType = context.input.sessionType ?? 'branch';
  return {
    ...internalIdentityFields(context),
    sessionType,
    sessionKind: context.sessionKind,
    ...whenDefined('memoryPolicy', context.taskMemoryPolicy),
    ...internalMetadataFields(context, sessionType),
    ...internalModelFields(context.input, context.taskCapture, context.forkedAgentDefinition),
    ...internalBindingFields(context.taskCapture, context.forkedAgentDefinition),
    origin: context.input.origin ?? 'user',
  };
}

function metadataSessionKind(input: SessionCreateInput): SessionKind {
  const requestedKind = input.sessionKind ?? 'conversation';
  if (requestedKind === 'unknown') {
    throw new SessionServiceError(
      'invalid-session-kind',
      `Unsupported Session kind: ${requestedKind}`,
    );
  }
  if ((requestedKind === 'task' || requestedKind === 'peek') && !input.parentSessionId) {
    throw new SessionServiceError(
      'parent-required',
      `${requestedKind} Session requires a parent Session`,
    );
  }
  return requestedKind;
}

function metadataIdentityFields(
  context: CreateMetadataContext,
  sessionKind: SessionKind,
): Pick<
  SessionMetadataCreateInput,
  | 'sessionId'
  | 'agentName'
  | 'workspaceDir'
  | 'isDefaultWorkspace'
  | 'title'
  | 'parentSessionId'
  | 'visibility'
  | 'purpose'
  | 'runLocation'
  | 'appMode'
> {
  const { input, taskWorkspace, runLocation } = context;
  return {
    sessionId: context.sessionId,
    agentName: input.agentName,
    workspaceDir: taskWorkspace ?? runLocation?.resolvedDir ?? context.requestedWorkspaceDir,
    isDefaultWorkspace: context.isDefaultWorkspace,
    title: input.title ?? null,
    parentSessionId: input.parentSessionId ?? null,
    visibility:
      visibilityForKind(sessionKind, input.visibility, context.parentVisibility) ?? 'visible',
    ...whenPresent('purpose', nonEmpty(input.purpose)),
    ...whenPresent('runLocation', runLocation),
    appMode: context.appMode,
  };
}

function metadataModelFields(
  input: SessionCreateInput,
  taskCapture: CapturedTaskAgentBinding | undefined,
): Pick<
  SessionMetadataCreateInput,
  | 'effectiveModel'
  | 'effectiveModelVariant'
  | 'effectiveModelThinking'
  | 'effectiveModelContextWindow'
  | 'effectiveModelMaxOutputTokens'
> {
  const effectiveModel = modelKey(input.model?.providerId, input.model?.modelId);
  return {
    ...whenPresent('effectiveModel', taskCapture?.effectiveModel ?? effectiveModel),
    ...metadataVariantField(input, taskCapture),
    ...whenDefined(
      'effectiveModelThinking',
      taskCapture ? taskCapture.effectiveModelThinking : input.model?.thinking,
    ),
    ...whenDefined(
      'effectiveModelContextWindow',
      taskCapture?.effectiveModelContextWindow ??
        input.model?.contextLimit ??
        input.effectiveModelContextWindow,
    ),
    ...whenDefined(
      'effectiveModelMaxOutputTokens',
      taskCapture?.effectiveModelMaxOutputTokens ?? input.effectiveModelMaxOutputTokens,
    ),
  };
}

function metadataVariantField(
  input: SessionCreateInput,
  taskCapture: CapturedTaskAgentBinding | undefined,
): Pick<SessionMetadataCreateInput, 'effectiveModelVariant'> {
  if (taskCapture) return whenDefined('effectiveModelVariant', taskCapture.effectiveModelVariant);
  return whenDefined('effectiveModelVariant', optionalModelVariant(input.model?.variant));
}

function metadataBindingFields(
  taskCapture: CapturedTaskAgentBinding | undefined,
): Pick<SessionMetadataCreateInput, 'agentDefinition' | 'taskAgentBinding'> {
  if (!taskCapture) return {};
  return {
    agentDefinition: taskCapture.agentDefinition,
    taskAgentBinding: taskCapture.taskAgentBinding,
  };
}

function internalIdentityFields(
  context: InternalMetadataContext,
): Pick<
  SessionMetadataCreateInput,
  'sessionId' | 'agentName' | 'workspaceDir' | 'isDefaultWorkspace' | 'title' | 'parentSessionId'
> {
  const { input } = context;
  return {
    sessionId: context.sessionId,
    agentName: input.agentName,
    workspaceDir: context.workspaceDir,
    isDefaultWorkspace: context.isDefaultWorkspace,
    title: input.title ?? null,
    parentSessionId: input.parentSessionId ?? null,
  };
}

function internalMetadataFields(
  context: InternalMetadataContext,
  sessionType: 'root' | 'branch',
): Pick<
  SessionMetadataCreateInput,
  'visibility' | 'purpose' | 'originCronId' | 'runLocation' | 'appMode'
> {
  const { input, parent, sessionKind } = context;
  const visibility = visibilityForInternalKind(sessionKind, input.visibility, parent?.visibility);
  return {
    ...whenPresent('visibility', visibility),
    ...whenPresent('purpose', input.purpose),
    ...whenPresent('originCronId', input.originCronId),
    ...whenPresent('runLocation', input.runLocation),
    ...appModeFields(sessionType, input.appMode ?? parent?.appMode),
  };
}

function internalModelFields(
  input: InternalSessionCreateInput,
  taskCapture: CapturedTaskAgentBinding | undefined,
  forkedAgentDefinition: CurrentSessionAgentDefinitionCreate | undefined,
): Pick<
  SessionMetadataCreateInput,
  | 'effectiveModel'
  | 'effectiveModelVariant'
  | 'effectiveModelThinking'
  | 'effectiveModelContextWindow'
  | 'effectiveModelMaxOutputTokens'
> {
  if (forkedAgentDefinition) return modelFieldsFromDefinition(forkedAgentDefinition.definition);
  return {
    ...whenPresent('effectiveModel', taskCapture?.effectiveModel ?? input.effectiveModel),
    ...internalVariantField(input, taskCapture),
    ...whenDefined(
      'effectiveModelThinking',
      taskCapture?.effectiveModelThinking ?? input.effectiveModelThinking,
    ),
    ...whenDefined(
      'effectiveModelContextWindow',
      taskCapture?.effectiveModelContextWindow ?? input.effectiveModelContextWindow,
    ),
    ...whenDefined(
      'effectiveModelMaxOutputTokens',
      taskCapture?.effectiveModelMaxOutputTokens ?? input.effectiveModelMaxOutputTokens,
    ),
  };
}

function internalVariantField(
  input: InternalSessionCreateInput,
  taskCapture: CapturedTaskAgentBinding | undefined,
): Pick<SessionMetadataCreateInput, 'effectiveModelVariant'> {
  if (taskCapture) return whenDefined('effectiveModelVariant', taskCapture.effectiveModelVariant);
  return whenDefined('effectiveModelVariant', input.effectiveModelVariant);
}

function internalBindingFields(
  taskCapture: CapturedTaskAgentBinding | undefined,
  forkedAgentDefinition: CurrentSessionAgentDefinitionCreate | undefined,
): Pick<SessionMetadataCreateInput, 'agentDefinition' | 'taskAgentBinding'> {
  if (forkedAgentDefinition) return { agentDefinition: forkedAgentDefinition };
  return metadataBindingFields(taskCapture);
}

function modelFieldsFromDefinition(
  definition: FrozenAgentExecutionDefinition,
): Pick<
  SessionMetadataCreateInput,
  | 'effectiveModel'
  | 'effectiveModelVariant'
  | 'effectiveModelThinking'
  | 'effectiveModelContextWindow'
  | 'effectiveModelMaxOutputTokens'
> {
  return {
    effectiveModel: `${definition.model.providerId}/${definition.model.modelId}`,
    ...whenDefined('effectiveModelVariant', definition.model.variant),
    ...whenDefined('effectiveModelThinking', definition.model.thinking),
    ...whenDefined('effectiveModelContextWindow', definition.model.contextWindow),
    ...whenDefined('effectiveModelMaxOutputTokens', definition.model.maxOutputTokens),
  };
}
