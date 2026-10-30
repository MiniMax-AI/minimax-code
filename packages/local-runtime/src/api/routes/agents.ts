import { join } from "node:path";

import type {
  AgentDetail,
  CreateAgentInput as CreateAgentInput,
} from "@mavis/protocol/local";
import type {
  ConversationSessionKind,
  ConversationTaskModelSelection,
  RuntimeConversation,
} from "@mavis/conversation-contract";
import type { GlobalEventInput } from "@mavis/shared/global-events";
import { type ResolvedLocalRunLocation } from "../../runtime/run-location.js";
import type { LocalRuntimeConfig } from "../../config/types.js";
import type { LocalAgentRecord } from "../../persistence/ports.js";
import {
  isAgentNotFoundError,
  type LocalAgentRuntimePort,
} from "../../agent/runtime-port.js";
import { logger } from "../../common/logger.js";
import type { LegacyHistoryReader } from "../../legacy-opencode/legacy-history-reader.js";
import {
  LegacyOpencodeMigrationError,
  LegacyOpencodeMigrator,
} from "../../legacy-opencode/legacy-opencode-migrator.js";
import type {
  LocalSessionController,
  LocalSessionListOptions,
  LocalSessionOrigin,
  LocalSessionRecord,
} from "../../sessions/controller.js";
import { readLocalSessionListOptions } from "../../sessions/list-options.js";
import { buildArchivedRootSessionTitle } from "../../sessions/archived-session-title.js";
import type { LocalRuntimeMode } from "../../runtime/mode.js";
import { type LocalAppMode } from "../../runtime/app-mode.js";
import { type ModuleMetricsReporter } from "../../common/metrics.js";
import type { GlobalEventPublisher } from "../../events/global-events.js";
import {
  buildGeneratedAgentName,
  isValidLocalAgentName,
  json,
  notFound,
  readFirstString,
  readString,
} from "../host-helpers.js";
import {
  buildFailedLegacyMigrationStub,
  migrateLegacySessionsForList,
  presentLegacyStubAsPiAgent,
  presentLegacyStubsAsPiAgent,
} from "../host-support.js";
import { type LocalModelThinkingSelection } from "../../model-provider/model-selection.js";
import {
  isAgentInternalDefaultWorkspaceDir,
  normalizeAbsolutePath,
} from "../../project/canonical-workspace.js";

const DEFAULT_LOCAL_AGENT_AVATAR_URL =
  "https://filecdn.minimax.chat/public/d92edcbe-2404-417b-a133-b770b0b9bf61.svg";
const LEGACY_PRIMARY_AGENT_NAME = "main";

export interface LocalAgentRouteContext {
  controller: LocalSessionController;
  conversation?: RuntimeConversation;
  /**
   * Domain-layer service backing agent identity + main-session pointer. The
   * IM `/new` root-swap path reads and writes agent state through this, not
   * through the owning Agent runtime port. See
   * `knowledge/proposals/local-runtime-im-new-slash-root-swap-fix.md`.
   */
  agentRuntimePort: LocalAgentRuntimePort;
  legacyMigrator?: LegacyOpencodeMigrator;
  runtimeMode: LocalRuntimeMode;
  agentName: string;
  agentDisplayName: string;
  configGetter: () => LocalRuntimeConfig;
  nowMs: () => number;
  resolveDefaultWorkspaceDir: () => string;
  getLegacyRuntime: () => LegacyHistoryReader;
  getSessionById: (
    sessionId: string,
  ) => Promise<LocalSessionRecord | undefined>;
  listAllSessions: (
    agentName?: string,
    options?: LocalSessionListOptions,
  ) => Promise<LocalSessionRecord[]>;
  serializeSessions: (
    sessions: LocalSessionRecord[],
  ) => Promise<Array<Record<string, unknown>>>;
  serializeSessionTree: (
    sessions: LocalSessionRecord[],
    url: URL,
    agentName: string,
    getSessionById?: (
      sessionId: string,
    ) => Promise<LocalSessionRecord | undefined>,
  ) => Promise<Array<Record<string, unknown>>>;
  serializeSession: (
    session: LocalSessionRecord,
  ) => Promise<Record<string, unknown>>;
  isReadOnlyLegacySession: (session: LocalSessionRecord) => Promise<boolean>;
  markMigratedLegacySessionDeleted: (sessionId: string) => Promise<boolean>;
  requestCompaction: (
    session: LocalSessionRecord,
    body: Record<string, unknown>,
  ) => Promise<Response>;
  abortLocalSessionTurn: (sessionId: string) => void;
  normalizeCleanLocalSession: (
    session: LocalSessionRecord,
  ) => Promise<LocalSessionRecord | undefined>;
  publishGlobalEvent: GlobalEventPublisher;
  routeAgentIm?: (agentName: string, method: string) => Promise<Response>;
  getAgentChannelConfig?: (
    agentName: string,
  ) => Promise<Record<string, unknown> | undefined>;
  /** Resolve the runtime BCP-47 locale for the archived-title prefix. */
  resolveLocale?: () => string;
  metricsReporter?: ModuleMetricsReporter;
}

export class LocalApiAgentRoutes {
  private rootSessionId: string | undefined;

  constructor(private readonly ctx: LocalAgentRouteContext) {}

  clearRootSessionIf(sessionId: string): void {
    if (this.rootSessionId === sessionId) this.rootSessionId = undefined;
  }

  private get controller(): LocalSessionController {
    return this.ctx.controller;
  }
  private get conversation(): RuntimeConversation {
    if (!this.ctx.conversation) {
      throw new Error(
        "Runtime Conversation is unavailable for Agent Session operations",
      );
    }
    return this.ctx.conversation;
  }
  // Reads and owned-session updates stay tolerant of a missing Runtime
  // Conversation: `replaceRootSession` still keeps a `!ctx.conversation`
  // branch for hosts booted without Local Runtime V2, and that branch is the
  // only caller of `updateOwnedSession`. Session *creation* stays V2-only —
  // its former V1 fallback depended on `initMessageState`, which the Agent
  // cutover removed along with V1 message-state ownership.
  private querySession(
    sessionId: string,
  ): Promise<LocalSessionRecord | undefined> {
    return this.ctx.conversation
      ? this.ctx.conversation.query.getSession(sessionId)
      : this.controller.getSession(sessionId);
  }
  private querySessions(
    options?: LocalSessionListOptions,
  ): Promise<LocalSessionRecord[]> {
    return this.ctx.conversation
      ? this.ctx.conversation.query.listSessions(options)
      : this.controller.listSessions(options);
  }
  private updateOwnedSession(
    sessionId: string,
    fields: Parameters<LocalSessionController["updateSession"]>[1],
  ): Promise<LocalSessionRecord | undefined> {
    if (!this.ctx.conversation)
      return this.controller.updateSession(sessionId, fields);
    return this.conversation.lifecycle.updateSession(sessionId, {
      ...(fields.title !== undefined ? { title: fields.title } : {}),
      ...(fields.sessionType !== undefined
        ? { sessionType: fields.sessionType }
        : {}),
      ...(fields.parentSessionId !== undefined
        ? { parentSessionId: fields.parentSessionId }
        : {}),
      ...(fields.archived !== undefined ? { archived: fields.archived } : {}),
      ...(fields.effectiveModel !== undefined
        ? { effectiveModel: fields.effectiveModel }
        : {}),
      ...(fields.effectiveModelVariant !== undefined
        ? { effectiveModelVariant: fields.effectiveModelVariant }
        : {}),
    });
  }
  private get agentService(): LocalAgentRuntimePort {
    return this.ctx.agentRuntimePort;
  }
  private get legacyMigrator(): LegacyOpencodeMigrator | undefined {
    return this.ctx.legacyMigrator;
  }
  private get runtimeMode(): LocalRuntimeMode {
    return this.ctx.runtimeMode;
  }
  private get agentName(): string {
    return this.ctx.agentName;
  }
  private get agentDisplayName(): string {
    return this.ctx.agentDisplayName;
  }

  private configGetter(): LocalRuntimeConfig {
    return this.ctx.configGetter();
  }
  private nowMs(): number {
    return this.ctx.nowMs();
  }
  private resolveDefaultWorkspaceDir(): string {
    return this.ctx.resolveDefaultWorkspaceDir();
  }
  private getLegacyRuntime(): LegacyHistoryReader {
    return this.ctx.getLegacyRuntime();
  }
  private getSessionById(
    sessionId: string,
  ): Promise<LocalSessionRecord | undefined> {
    return this.ctx.getSessionById(sessionId);
  }
  private listAllSessions(
    agentName?: string,
    options?: LocalSessionListOptions,
  ): Promise<LocalSessionRecord[]> {
    return this.ctx.listAllSessions(agentName, options);
  }
  private serializeSessions(
    sessions: LocalSessionRecord[],
  ): Promise<Array<Record<string, unknown>>> {
    return this.ctx.serializeSessions(sessions);
  }
  private serializeSessionTree(
    sessions: LocalSessionRecord[],
    url: URL,
    agentName: string,
    getSessionById?: (
      sessionId: string,
    ) => Promise<LocalSessionRecord | undefined>,
  ): Promise<Array<Record<string, unknown>>> {
    return this.ctx.serializeSessionTree(
      sessions,
      url,
      agentName,
      getSessionById,
    );
  }
  private serializeSession(
    session: LocalSessionRecord,
  ): Promise<Record<string, unknown>> {
    return this.ctx.serializeSession(session);
  }
  private markMigratedLegacySessionDeleted(
    sessionId: string,
  ): Promise<boolean> {
    return this.ctx.markMigratedLegacySessionDeleted(sessionId);
  }
  private abortLocalSessionTurn(sessionId: string): void {
    this.ctx.abortLocalSessionTurn(sessionId);
  }
  private normalizeCleanLocalSession(
    session: LocalSessionRecord,
  ): Promise<LocalSessionRecord | undefined> {
    return this.ctx.normalizeCleanLocalSession(session);
  }
  private publishGlobalEvent(event: GlobalEventInput): void {
    this.ctx.publishGlobalEvent(event);
  }

  async ensureRootSession(): Promise<LocalSessionRecord> {
    let cachedRoot: LocalSessionRecord | undefined;
    if (this.rootSessionId) {
      const existing = await this.querySession(this.rootSessionId);
      if (existing && isActivePiRootSession(existing, this.agentName))
        return existing;
      if (existing && isPiRootSession(existing, this.agentName))
        cachedRoot = existing;
      this.rootSessionId = undefined;
    }
    const sessions = await this.querySessions();
    const existingRoot =
      sessions.find((session) =>
        isActivePiRootSession(session, this.agentName),
      ) ??
      cachedRoot ??
      sessions.find((session) => isPiRootSession(session, this.agentName));
    if (existingRoot) {
      this.rootSessionId = existingRoot.sessionId;
      return existingRoot;
    }
    // In clean mode, discovery-only migration deliberately does NOT create
    // pi-agent rows in the controller for legacy sessions until the user
    // touches them. If a legacy root session exists for this agent we must
    // materialize it right here — otherwise we would silently create a
    // brand-new empty root while a legacy root (potentially with hundreds
    // of messages) stays undiscoverable behind the compat boundary. The
    // legacy migrator handles primary-agent aliasing (main ↔ this.agentName)
    // inside listLegacySessions, so we do not need to double-check aliases.
    if (this.runtimeMode === "clean" && this.legacyMigrator) {
      const legacySessions = await this.legacyMigrator.listLegacySessions(
        this.agentName,
      );
      const legacyRoot = legacySessions.find(
        (session) => session.sessionType === "root",
      );
      if (legacyRoot) {
        try {
          const result = await this.legacyMigrator.migrateSession(
            legacyRoot.sessionId,
            {
              materialize: true,
            },
          );
          if (result?.session) {
            this.rootSessionId = result.session.sessionId;
            return result.session;
          }
        } catch {
          // Fall through to fresh root creation — the migration failure
          // will already be surfaced via the legacy migration telemetry
          // and the record.status='failed' stub. We don't want to leave
          // the agent without any root, so we still create a fresh one.
        }
      }
    }
    const session = await this.createSession({
      workspaceDir: this.resolveDefaultWorkspaceDir(),
      sessionType: "root",
      title: "Main",
      parentSessionId: null,
      isDefaultWorkspace: true,
      origin: "root-repair",
    });
    this.rootSessionId = session.sessionId;
    return session;
  }

  private async ensureLocalAgentRootSession(
    record: LocalAgentRecord,
  ): Promise<LocalSessionRecord> {
    const existing = await this.querySession(record.rootSessionId);
    if (
      existing &&
      existing.agentName === record.name &&
      existing.runtime === "pi-agent" &&
      existing.sessionType === "root"
    ) {
      return (await this.getMigrationAwareLocalAgentRoot(existing)) ?? existing;
    }
    const root = (await this.querySessions()).find(
      (session) =>
        session.agentName === record.name &&
        session.runtime === "pi-agent" &&
        session.sessionType === "root",
    );
    if (root) {
      const checkedRoot =
        (await this.getMigrationAwareLocalAgentRoot(root)) ?? root;
      if (root.sessionId !== record.rootSessionId) {
        await this.updateLocalAgentRoot(record, checkedRoot.sessionId);
      }
      return checkedRoot;
    }
    // Legacy root fallback for custom (non-primary) agents.
    // seeds `record.rootSessionId` with the legacy id — but under discovery-only
    // migration no pi-agent row is created for that root until the user touches it,
    // so the two lookups above both return undefined. Without this branch we would
    // `createSession()` a fresh empty root and `updateLocalAgentRoot()` would rewrite
    // the agent's rootSessionId, orphaning the legacy history behind the pointer.
    // Materialize the legacy root instead, then keep the agent pointer pointing at
    // its (unchanged) session id.
    if (this.runtimeMode === "clean" && this.legacyMigrator) {
      const legacyRootId = await this.pickLegacyRootIdForAgent(record);
      if (legacyRootId) {
        try {
          const result = await this.legacyMigrator.migrateSession(
            legacyRootId,
            {
              materialize: true,
            },
          );
          if (result?.session) {
            if (result.session.sessionId !== record.rootSessionId) {
              await this.updateLocalAgentRoot(record, result.session.sessionId);
            }
            return result.session;
          }
        } catch {
          // Fall through to a fresh empty root — the migration failure is already
          // surfaced via legacy migration telemetry and the record.status='failed'
          // stub. Leaving the agent without any root would hang the UI.
        }
      }
    }
    const workspaceDir =
      record.defaultWorkspaceDir ?? this.resolveDefaultWorkspaceDir();
    const created = await this.createSession({
      agentName: record.name,
      workspaceDir,
      sessionType: "root",
      title: "Main",
      parentSessionId: null,
      isDefaultWorkspace: this.isDefaultLocalAgentRootWorkspace(
        record,
        workspaceDir,
      ),
      origin: "root-repair",
    });
    await this.updateLocalAgentRoot(record, created.sessionId);
    return created;
  }

  private isDefaultLocalAgentRootWorkspace(
    record: LocalAgentRecord,
    workspaceDir: string,
  ): boolean {
    const workspace = normalizeAbsolutePath(workspaceDir);
    const runtimeDefault = normalizeAbsolutePath(
      this.resolveDefaultWorkspaceDir(),
    );
    if (!workspace || workspace === runtimeDefault) return true;
    const agentWorkspace = isValidLocalAgentName(record.name)
      ? join(this.configGetter().dataDir, "agents", record.name, "workspace")
      : undefined;
    return isAgentInternalDefaultWorkspaceDir(
      workspaceDir,
      agentWorkspace,
      record.name,
    );
  }

  private async pickLegacyRootIdForAgent(
    record: LocalAgentRecord,
  ): Promise<string | undefined> {
    if (!this.legacyMigrator) return undefined;
    // `listLegacySessions` already handles the primary agent alias
    // (main ↔ this.agentName) internally, but for custom agents the record
    // name is authoritative.
    const legacySessions = await this.legacyMigrator.listLegacySessions(
      record.name,
    );
    if (legacySessions.length === 0) return undefined;
    const preferred = resolvePreferredLegacyRootSession(
      legacySessions,
      record.rootSessionId || undefined,
    );
    return preferred?.sessionType === "root" ? preferred.sessionId : undefined;
  }

  private async getMigrationAwareLocalAgentRoot(
    session: LocalSessionRecord,
  ): Promise<LocalSessionRecord | undefined> {
    if (this.runtimeMode !== "clean") return session;
    const checked = await this.getSessionById(session.sessionId);
    if (
      checked &&
      checked.agentName === session.agentName &&
      checked.runtime === "pi-agent" &&
      checked.sessionType === "root"
    ) {
      return checked;
    }
    return undefined;
  }

  async replaceRootSession(
    agentName: string,
    sessionId: string,
  ): Promise<LocalSessionRecord | undefined> {
    if (this.ctx.conversation) {
      return this.replaceConversationRootSession(agentName, sessionId);
    }
    const baseLog = {
      scope: "agent-routes",
      op: "replaceRootSession",
      agentName,
      sessionId,
    };
    const nextRoot = await this.querySession(sessionId);
    if (!nextRoot) {
      logger.warn(
        { ...baseLog, reason: "next_root_not_found" },
        "replaceRootSession bailed",
      );
      return undefined;
    }
    if (nextRoot.agentName !== agentName) {
      logger.warn(
        {
          ...baseLog,
          reason: "agent_name_mismatch",
          actualAgent: nextRoot.agentName,
        },
        "replaceRootSession bailed",
      );
      return undefined;
    }
    if (nextRoot.runtime !== "pi-agent") {
      logger.warn(
        {
          ...baseLog,
          reason: "unsupported_runtime",
          runtime: nextRoot.runtime,
        },
        "replaceRootSession bailed",
      );
      return undefined;
    }
    // Pull the current root from the sessions table (not the agent record).
    // The agent record's `main_session_id` might be stale or point at a
    // demoted branch — the source of truth for "what session is currently
    // root for this agent" is `sessionType='root'` in the sessions table.
    let oldRoot: LocalSessionRecord | undefined;
    let oldRootFallbackName: string;
    if (agentName === this.agentName) {
      oldRoot = await this.ensureRootSession();
      oldRootFallbackName = this.agentDisplayName || agentName;
    } else {
      const preferred = await this.getPreferredSessionForAgent(agentName);
      if (preferred && isActivePiRootSession(preferred, agentName)) {
        oldRoot = preferred;
      } else {
        const sessions = await this.controller.listSessions({ agentName });
        oldRoot =
          sessions.find((session) =>
            isActivePiRootSession(session, agentName),
          ) ??
          (preferred && isPiRootSession(preferred, agentName)
            ? preferred
            : undefined) ??
          sessions.find((session) => isPiRootSession(session, agentName));
      }
      if (!oldRoot && !isPiRootSession(nextRoot, agentName)) {
        logger.error(
          {
            ...baseLog,
            reason: "no_existing_root",
            preferredSessionId: preferred?.sessionId,
            preferredSessionType: preferred?.sessionType,
          },
          "replaceRootSession bailed: cannot find existing root session for agent",
        );
        return undefined;
      }
      // Display name is a best-effort UX detail — a lookup failure must
      // NOT abort the promote. Fall back to `agentName` so the archive
      // title still renders.
      const detail = await this.getLocalAgent(agentName).catch((err) => {
        logger.warn(
          {
            ...baseLog,
            err: err instanceof Error ? err.message : String(err),
          },
          "replaceRootSession: getLocalAgent for display name failed (non-fatal)",
        );
        return undefined;
      });
      oldRootFallbackName = detail?.displayName || agentName;
    }

    const rootSessionsToDemote = (
      await this.controller.listSessions({ agentName })
    )
      .filter((session) => isPiRootSession(session, agentName))
      .filter((session) => session.sessionId !== nextRoot.sessionId);
    for (const root of rootSessionsToDemote) {
      // Abort the old root's in-flight foreground turn BEFORE archiving it.
      // Mirrors `main`'s `/new`, which runs `cleanupForegroundSession({
      // abortDaemon: true })` ahead of the archive: a `startTurn` on an
      // `archived` session throws `LocalSessionResumeError`, so the demote must
      // first end any active turn (e.g. a thread-goal loop) rather than leave a
      // live turn to crash on its next resume. Best-effort + synchronous.
      try {
        this.abortLocalSessionTurn(root.sessionId);
      } catch (err) {
        logger.warn(
          {
            ...baseLog,
            oldRootId: root.sessionId,
            err: err instanceof Error ? err.message : String(err),
          },
          "replaceRootSession: aborting old root turn failed (non-fatal)",
        );
      }
      // Demote the old root to a normal (archived) task session so it aligns
      // with `main`'s `/new` semantics: the previous connect-phone / IM root
      // moves into "Archived" with a localized "Memory archive: …" title instead of
      // lingering in the normal sidebar still titled "Main" (the reported
      // preview_train `/clean`-like divergence). The synchronous fallback
      // The display-name fallback lands synchronously. V2 owns any later
      // model-generated archive title.
      const fallbackTitle = buildArchivedRootSessionTitle({
        oldTitle: root.title,
        fallbackName: oldRootFallbackName,
        locale: this.ctx.resolveLocale?.(),
      });
      try {
        await this.updateOwnedSession(root.sessionId, {
          sessionType: "branch",
          archived: true,
          title: fallbackTitle,
        });
      } catch (err) {
        logger.error(
          {
            ...baseLog,
            oldRootId: root.sessionId,
            err: err instanceof Error ? err.message : String(err),
          },
          "replaceRootSession: demoting old root failed",
        );
        return undefined;
      }
    }
    let updated: LocalSessionRecord | undefined;
    try {
      updated = await this.updateOwnedSession(nextRoot.sessionId, {
        sessionType: "root",
        parentSessionId: null,
        archived: false,
        title: "Main",
      });
    } catch (err) {
      logger.error(
        {
          ...baseLog,
          err: err instanceof Error ? err.message : String(err),
        },
        "replaceRootSession: promoting new root failed",
      );
      return undefined;
    }
    await this.setRootSessionId(agentName, nextRoot.sessionId);
    if (oldRoot && oldRoot.sessionId !== nextRoot.sessionId) {
      // Notify the desktop UI that this agent's root session changed. The IM
      // `/new` command promotes a fresh Main here, but the daemon otherwise only
      // mutates in-memory/session state and emits no event the UI consumes. The
      // UI's `agent.updated` handler refetches agent info and updates
      // primaryAgent.root_session_id, so "Mobile control" follows the new Main session
      // in real time instead of only after a restart / full refetch.
      try {
        this.publishGlobalEvent({
          type: "agent.updated",
          payload: { agentName },
        });
      } catch (err) {
        logger.warn(
          {
            ...baseLog,
            err: err instanceof Error ? err.message : String(err),
          },
          "replaceRootSession: publishGlobalEvent(agent.updated) failed (non-fatal)",
        );
      }
    }
    logger.info(
      {
        ...baseLog,
        oldRootId: oldRoot?.sessionId,
        newRootId: nextRoot.sessionId,
        outcome: "ok",
      },
      "replaceRootSession completed",
    );
    return updated ?? nextRoot;
  }

  private async replaceConversationRootSession(
    agentName: string,
    sessionId: string,
  ): Promise<LocalSessionRecord | undefined> {
    const conversation = this.conversation;
    try {
      const replacement = await conversation.lifecycle.replaceRootSession(
        agentName,
        sessionId,
      );
      if (agentName === this.agentName)
        this.rootSessionId = replacement.nextRoot.sessionId;
      return replacement.nextRoot;
    } catch (error) {
      logger.warn(
        {
          agentName,
          sessionId,
          err: error instanceof Error ? error.message : String(error),
        },
        "v2-owned root Session replacement failed",
      );
      return undefined;
    }
  }

  async createSession(input: {
    agentName?: string;
    workspaceDir?: string;
    sessionType?: "root" | "branch";
    sessionKind?: ConversationSessionKind;
    title?: string | null;
    parentSessionId?: string | null;
    visibility?: "visible" | "hidden";
    purpose?: string;
    originCronId?: string;
    runLocation?: ResolvedLocalRunLocation;
    appMode?: LocalAppMode;
    effectiveModel?: string | null;
    effectiveModelVariant?: string | null;
    effectiveModelThinking?: LocalModelThinkingSelection | null;
    taskModelSelection?: ConversationTaskModelSelection;
    isDefaultWorkspace?: boolean;
    /**
     * Creation provenance persisted on the session record. Defaults to
     * `'user'` — every route-level creation (UI create, IM `/new` via
     * `replaceRootSession`) is an explicit user action and must
     * never receive a legacy phantom-root history import. Root-repair
     * callers (`ensureRootSession` / `ensureLocalAgentRootSession` fresh
     * mints) pass `'root-repair'` to stay phantom-fallback eligible.
     */
    origin?: LocalSessionOrigin;
  }): Promise<LocalSessionRecord> {
    const session = await this.conversation.lifecycle.createSession({
      ...input,
      agentName: input.agentName ?? this.agentName,
      sessionType: input.sessionType ?? "branch",
      sessionKind: input.sessionKind ?? "conversation",
      origin: input.origin ?? "user",
    });
    logger.info(
      {
        sessionId: session.sessionId,
        agentName: session.agentName,
        sessionType: session.sessionType,
        appMode: session.appMode ?? null,
      },
      "local session created",
    );
    return session;
  }

  async getLocalAgent(name: string): Promise<LocalAgentRecord | undefined> {
    try {
      const resp = await this.agentService.getAgent({
        name,
        include: "identity,persona,system_prompt",
      });
      if (!resp.agent) return undefined;
      return this.detailToRecord(resp.agent);
    } catch (err) {
      if (isAgentNotFoundError(err)) {
        return undefined;
      }
      logger.error(
        {
          scope: "agent-routes",
          op: "getLocalAgent",
          agentName: name,
          err: err instanceof Error ? err.message : String(err),
        },
        "getLocalAgent via Agent runtime port failed",
      );
      throw err;
    }
  }

  private detailToRecord(detail: AgentDetail): LocalAgentRecord {
    // thrift AgentCreationSource enum: 1=manual, 2=auto, 3=builtin, 0=unknown.
    // LocalAgentRecord only carries 'manual' | 'auto'; builtin projects to
    // 'auto' because builtin templates aren't user-managed IM records.
    const creationSource: LocalAgentRecord["creationSource"] =
      detail.creationSource === 1 ? "manual" : "auto";
    return {
      name: detail.name ?? "",
      displayName: detail.displayName ?? detail.name ?? "",
      ...(detail.description ? { description: detail.description } : {}),
      ...(detail.avatar ? { avatar: detail.avatar } : {}),
      ...(detail.persona ? { persona: detail.persona } : {}),
      ...(detail.systemPrompt ? { systemPrompt: detail.systemPrompt } : {}),
      ...(detail.defaultWorkspaceDir
        ? { defaultWorkspaceDir: detail.defaultWorkspaceDir }
        : {}),
      creationSource,
      rootSessionId: detail.rootSessionId ?? "",
      createdAtMs: detail.createdAt ?? 0,
      updatedAtMs: detail.updatedAt ?? 0,
    };
  }

  async listLocalAgents(): Promise<LocalAgentRecord[]> {
    // `excludePrimary: true` matches the pre-refactor behaviour of only
    // enumerating user-created agents (the primary agent is composed
    // separately via `buildAgentInfo(this.agentName)`).
    const resp = await this.agentService.listAgents({
      include: "identity",
      excludePrimary: true,
    });
    return (resp.agents ?? []).map((detail) => this.detailToRecord(detail));
  }

  /**
   * Create a brand-new local Pi agent and persist its root session.
   *
   * Used by `POST /mavis/api/agent` (with body). Without a body, the host
   *'s `ensureRootSession()` path returns the primary agent. With a body
   * (e.g. `{displayName, defaultWorkspaceDir, ...}`), this method mints a
   * fresh `agent-<hex12>` name (or uses the requested name), creates its
   * root session, and writes the local agent record. Returns 201 with
   * `{name, rootSessionId}`.
   */
  async createLocalAgent(body: Record<string, unknown>): Promise<Response> {
    const requestedName = readString(body, "name");
    const agentName = requestedName ?? buildGeneratedAgentName();
    if (!isValidLocalAgentName(agentName)) {
      return json(
        {
          error: `Invalid agent name: "${agentName}"`,
          code: "INVALID_AGENT_NAME",
          errorCode: 40001,
        },
        { status: 400 },
      );
    }
    // Preserve the legacy endpoint's read-only collision guard. The V2 Agent
    // owner is the sole writer; this check only prevents a requested key from
    // shadowing the primary Agent or an OpenCode-only legacy Agent.
    if (
      agentName === this.agentName ||
      (await this.getLocalAgent(agentName)) ||
      (await this.hasLegacyAgent(agentName))
    ) {
      return json(
        {
          error: `Agent name "${agentName}" already exists`,
          code: "AGENT_NAME_CONFLICT",
          errorCode: 40901,
        },
        { status: 409 },
      );
    }
    const displayName =
      readFirstString(body, ["displayName", "display_name"]) ??
      requestedName ??
      agentName;
    const defaultWorkspaceDir =
      readFirstString(body, ["defaultWorkspaceDir", "default_workspace_dir"]) ??
      this.resolveDefaultWorkspaceDir();
    const request: CreateAgentInput = {
      name: agentName,
      displayName,
      ...(readString(body, "description")
        ? { description: readString(body, "description") }
        : {}),
      ...(readString(body, "avatar")
        ? { avatar: readString(body, "avatar") }
        : {}),
      ...(readFirstString(body, ["persona"])
        ? { persona: readFirstString(body, ["persona"]) }
        : {}),
      ...(readFirstString(body, ["systemPrompt", "system_prompt"])
        ? {
            systemPrompt: readFirstString(body, [
              "systemPrompt",
              "system_prompt",
            ]),
          }
        : {}),
      ...(defaultWorkspaceDir ? { defaultWorkspaceDir } : {}),
    };
    try {
      const created = await this.agentService.createAgent(request);
      return json(
        { name: created.name, rootSessionId: created.rootSessionId },
        { status: 201 },
      );
    } catch (error) {
      if (isAgentNotFoundError(error)) return notFound("/agent");
      const status =
        typeof Object(error).status === "number" ? Object(error).status : 500;
      const code =
        typeof Object(error).code === "string"
          ? Object(error).code
          : "INTERNAL_ERROR";
      // 5xx: generic client text (full error stays in server logs upstream).
      // 4xx: keep the typed message the UI already keys on.
      const message =
        status >= 500
          ? "Internal error"
          : error instanceof Error
            ? error.message
            : "Request failed";
      return json({ error: message, code }, { status });
    }
  }

  private async updateLocalAgentRoot(
    record: LocalAgentRecord,
    rootSessionId: string,
  ): Promise<void> {
    // Persist the Agent Main pointer through the owning runtime port.
    await this.setRootSessionId(record.name, rootSessionId);
  }

  private async setRootSessionId(
    agentName: string,
    rootSessionId: string,
  ): Promise<void> {
    if (agentName === this.agentName) {
      this.rootSessionId = rootSessionId;
    }
    // Primary agent is also present in the `agents` table (built-in mavis
    // seed); flip its `main_session_id` too so the desktop sidebar sees the
    // new root without waiting for a full refetch.
    const ok = await this.agentService.setMainSession(agentName, rootSessionId);
    if (!ok) {
      logger.warn(
        {
          scope: "agent-routes",
          op: "setRootSessionId",
          agentName,
          rootSessionId,
        },
        "setMainSession: agent not found in agents store",
      );
    }
  }

  private async listAgentSessions(
    url: URL,
    agentName = this.agentName,
  ): Promise<LocalSessionRecord[]> {
    return this.listAllSessions(
      agentName,
      readLocalSessionListOptions(url, { agentName }),
    );
  }

  async listAgentInfos(
    options: { includeLegacy?: boolean } = {},
  ): Promise<Array<Record<string, unknown>>> {
    await this.ensureRootSession();
    const localAgents = (await this.listLocalAgents()).filter(
      (agent) => agent.name !== this.agentName,
    );
    const sessionAgentNames = new Set(
      (await this.listAllSessions())
        .map((session) => session.agentName)
        .filter(
          (agentName) =>
            agentName &&
            agentName !== this.agentName &&
            !localAgents.some((agent) => agent.name === agentName),
        ),
    );
    const legacyNames =
      this.runtimeMode === "clean" && options.includeLegacy === false
        ? new Set<string>()
        : this.runtimeMode === "clean"
          ? new Set(
              ((await this.legacyMigrator?.listLegacySessions()) ?? [])
                .map((session) => session.agentName)
                .filter(
                  (agentName) =>
                    agentName &&
                    agentName !== this.agentName &&
                    agentName !== LEGACY_PRIMARY_AGENT_NAME &&
                    !localAgents.some((agent) => agent.name === agentName) &&
                    !sessionAgentNames.has(agentName),
                ),
            )
          : new Set(
              (await this.getLegacyRuntime().listSessions())
                .map((session) => session.agentName)
                .filter(
                  (agentName) =>
                    agentName &&
                    agentName !== this.agentName &&
                    !localAgents.some((agent) => agent.name === agentName) &&
                    !sessionAgentNames.has(agentName),
                ),
            );
    return [
      await this.buildAgentInfo(this.agentName),
      ...(await Promise.all(
        localAgents.map((agent) => this.buildLocalAgentInfo(agent)),
      )),
      ...(await Promise.all(
        [...sessionAgentNames].map((agentName) =>
          this.buildAgentInfo(agentName),
        ),
      )),
      ...(await Promise.all(
        [...legacyNames].map((agentName) =>
          this.runtimeMode === "clean"
            ? this.buildCleanLegacyAgentInfo(agentName)
            : this.buildAgentInfo(agentName),
        ),
      )),
    ];
  }

  private async buildAgentInfo(
    agentName = this.agentName,
  ): Promise<Record<string, unknown>> {
    if (agentName !== this.agentName) {
      const localAgent = await this.getLocalAgent(agentName);
      if (localAgent) return this.buildLocalAgentInfo(localAgent);
      const sessionBacked = await this.buildSessionBackedAgentInfo(agentName);
      if (sessionBacked) return sessionBacked;
      return this.buildLegacyAgentInfo(agentName);
    }

    const root = await this.ensureRootSession();
    const sessions = await this.listAgentInfoSessions(this.agentName);
    const override = await this.getLocalAgent(this.agentName);
    const now = this.nowMs();
    return {
      name: this.agentName,
      displayName: this.agentDisplayName,
      agentRole: 1,
      frameworkType: "pi-agent",
      rootSessionId: root.sessionId,
      defaultWorkspaceDir:
        override?.defaultWorkspaceDir ?? this.resolveDefaultWorkspaceDir(),
      userDefaultWorkspaceDir: override?.defaultWorkspaceDir,
      sessionCount: sessions.filter(
        (session) => session.agentName === this.agentName,
      ).length,
      createdAt: root.createdAtMs,
      updatedAt: Math.max(now, override?.updatedAtMs ?? 0),
      creationSource: "builtin",
      isBuiltin: true,
      identity: {
        display_name: this.agentDisplayName,
        avatar: override?.avatar ?? DEFAULT_LOCAL_AGENT_AVATAR_URL,
      },
      description: override?.description ?? "Local Pi runtime agent",
      ...(override?.persona ? { persona: override.persona } : {}),
      ...(override?.systemPrompt
        ? { systemPrompt: override.systemPrompt }
        : {}),
      channel: await this.ctx.getAgentChannelConfig?.(this.agentName),
    };
  }

  private async buildLocalAgentInfo(
    record: LocalAgentRecord,
  ): Promise<Record<string, unknown>> {
    const root = await this.ensureLocalAgentRootSession(record);
    const sessions = await this.listAgentInfoSessions(record.name);
    const updatedAt = Math.max(
      record.updatedAtMs,
      ...sessions.map((session) => session.updatedAtMs),
    );
    return {
      name: record.name,
      displayName: record.displayName,
      agentRole: 0,
      frameworkType: "pi-agent",
      rootSessionId: root.sessionId,
      defaultWorkspaceDir:
        record.defaultWorkspaceDir ?? this.resolveDefaultWorkspaceDir(),
      userDefaultWorkspaceDir: record.defaultWorkspaceDir,
      sessionCount: sessions.filter(
        (session) => session.agentName === record.name,
      ).length,
      createdAt: record.createdAtMs,
      updatedAt,
      creationSource: record.creationSource,
      isBuiltin: false,
      identity: {
        display_name: record.displayName,
        avatar: record.avatar ?? DEFAULT_LOCAL_AGENT_AVATAR_URL,
      },
      description: record.description ?? "",
      ...(record.persona ? { persona: record.persona } : {}),
      ...(record.systemPrompt ? { systemPrompt: record.systemPrompt } : {}),
      channel: await this.ctx.getAgentChannelConfig?.(record.name),
    };
  }

  private async buildSessionBackedAgentInfo(
    agentName: string,
  ): Promise<Record<string, unknown> | undefined> {
    const sessions = await this.listAgentInfoSessions(agentName);
    if (sessions.length === 0) return undefined;
    const root =
      sessions.find((session) => session.sessionType === "root") ??
      sessions[0]!;
    const updatedAt = Math.max(
      ...sessions.map((session) => session.updatedAtMs),
    );
    return {
      name: agentName,
      displayName: agentName,
      agentRole: 0,
      frameworkType: "pi-agent",
      rootSessionId: root.sessionId,
      defaultWorkspaceDir:
        root.workspaceDir ?? this.resolveDefaultWorkspaceDir(),
      sessionCount: sessions.filter(
        (session) => session.agentName === agentName,
      ).length,
      createdAt: root.createdAtMs,
      updatedAt,
      creationSource: "manual",
      isBuiltin: false,
      identity: {
        display_name: agentName,
        avatar: DEFAULT_LOCAL_AGENT_AVATAR_URL,
      },
      description: "",
    };
  }

  private async buildCleanLegacyAgentInfo(
    agentName: string,
  ): Promise<Record<string, unknown>> {
    const sessions =
      (await this.legacyMigrator?.listLegacySessions(agentName)) ?? [];
    const legacyAgent = await this.legacyMigrator?.getLegacyAgent(agentName);
    const root = resolvePreferredLegacyRootSession(
      sessions,
      legacyAgent?.rootSessionId,
    );
    const now = this.nowMs();
    return {
      name: agentName,
      displayName: legacyAgent?.displayName ?? agentName,
      agentRole: 1,
      frameworkType: "pi-agent",
      rootSessionId: root?.sessionId ?? null,
      defaultWorkspaceDir:
        legacyAgent?.defaultWorkspaceDir ??
        root?.workspaceDir ??
        this.resolveDefaultWorkspaceDir(),
      userDefaultWorkspaceDir: legacyAgent?.defaultWorkspaceDir,
      sessionCount: sessions.length,
      createdAt: legacyAgent?.createdAtMs ?? root?.createdAtMs ?? now,
      updatedAt: Math.max(
        legacyAgent?.updatedAtMs ?? 0,
        root?.updatedAtMs ?? now,
      ),
      creationSource: "legacy-import",
      isBuiltin: true,
      identity: {
        display_name: legacyAgent?.displayName ?? agentName,
        avatar: legacyAgent?.avatar ?? DEFAULT_LOCAL_AGENT_AVATAR_URL,
      },
      description:
        legacyAgent?.description ??
        "Legacy opencode sessions pending local Pi migration",
      ...(legacyAgent?.persona ? { persona: legacyAgent.persona } : {}),
      ...(legacyAgent?.systemPrompt
        ? { systemPrompt: legacyAgent.systemPrompt }
        : {}),
    };
  }

  private async listAgentInfoSessions(
    agentName: string,
  ): Promise<LocalSessionRecord[]> {
    if (this.runtimeMode !== "clean") return this.listAllSessions(agentName);
    const local = await Promise.all(
      (await this.querySessions({ agentName })).map((session) =>
        this.normalizeCleanLocalSession(session),
      ),
    );
    const legacy =
      (await this.legacyMigrator?.listLegacySessions(agentName)) ?? [];
    const legacyAlias =
      agentName === this.agentName && agentName !== LEGACY_PRIMARY_AGENT_NAME
        ? ((await this.legacyMigrator?.listLegacySessions(
            LEGACY_PRIMARY_AGENT_NAME,
          )) ?? [])
        : [];
    const byId = new Map<string, LocalSessionRecord>();
    // Legacy discovery-only stubs land here with `runtime === 'opencode'`.
    // Present them as pi-agent so the wire `frameworkType` reflects the
    // clean-mode "no legacy concept" invariant — otherwise the UI hides
    // the composer input on every session the user has never opened. See
    // `presentLegacyStubAsPiAgent` docs for the full rationale.
    for (const session of legacy) {
      byId.set(session.sessionId, presentLegacyStubAsPiAgent(session));
    }
    for (const session of legacyAlias) {
      byId.set(
        session.sessionId,
        presentLegacyStubAsPiAgent(session, {
          primaryAgentName: this.agentName,
          legacyPrimaryAgentName: LEGACY_PRIMARY_AGENT_NAME,
        }),
      );
    }
    for (const session of local) {
      if (session) byId.set(session.sessionId, session);
    }
    return [...byId.values()];
  }

  async listSessionsForTree(): Promise<LocalSessionRecord[]> {
    if (this.runtimeMode !== "clean") return this.listAllSessions();
    const local = await Promise.all(
      (await this.querySessions()).map((session) =>
        this.normalizeCleanLocalSession(session),
      ),
    );
    const legacy = (await this.legacyMigrator?.listLegacySessions()) ?? [];
    // Discovery-only migration pass — mirrors what `GET /agent/:name/session`
    // does. Keeps the two entry points (tree + flat list) aligned: both
    // upsert a cheap `local_runtime_legacy_migrations` row per legacy
    // session, and neither builds a local pi-agent session row / agent row
    // until the user actually opens the session (`resolveLocalSessionById`
    // → materialize:true) or sends a message. Failed discoveries surface
    // via the existing `failedRecords` branch below so we intentionally
    // swallow the telemetry emit here (tree renders don't need per-session
    // failure fan-out — the sidebar just shows the failed stub).
    if (this.legacyMigrator && legacy.length > 0) {
      await migrateLegacySessionsForList({
        sessions: legacy,
        legacyMigrator: this.legacyMigrator,
        controller: this.controller,
        normalizeStalePiSession: async (session) => session,
        emitLegacyMigrationTelemetry: () => {},
      });
    }
    const byId = new Map<string, LocalSessionRecord>();
    for (const session of legacy) byId.set(session.sessionId, session);
    for (const session of local) {
      if (session) byId.set(session.sessionId, session);
    }
    const failedRecords =
      (await this.legacyMigrator?.listMigrationRecords())?.filter(
        (record) => record.status === "failed",
      ) ?? [];
    for (const record of failedRecords) {
      const session =
        byId.get(record.localSessionId) ?? byId.get(record.legacySessionId);
      if (!session) continue;
      byId.set(
        record.localSessionId,
        buildFailedLegacyMigrationStub(
          session,
          new LegacyOpencodeMigrationError(
            record,
            record.error ??
              new Error("Previous legacy opencode session migration failed."),
          ),
          record,
        ),
      );
      if (record.legacySessionId !== record.localSessionId)
        byId.delete(record.legacySessionId);
    }
    const results = [...byId.values()];
    // Fold legacy `main` alias into the current primary agent name AND
    // present `runtime === 'opencode'` discovery stubs as pi-agent so the
    // wire `frameworkType` reflects the clean-mode invariant. Both concerns
    // live in the same helper so they cannot drift out of sync — see
    // `presentLegacyStubAsPiAgent` docs in `host-support.ts`. Successfully
    // materialized pi-agent rows and failed stubs (already
    // `runtime === 'pi-agent'` via `buildFailedLegacyMigrationStub`) pass
    // through unchanged.
    return presentLegacyStubsAsPiAgent(results, {
      primaryAgentName: this.agentName,
      legacyPrimaryAgentName: LEGACY_PRIMARY_AGENT_NAME,
    });
  }

  async buildAgentInfoForSession(
    session: LocalSessionRecord,
  ): Promise<Record<string, unknown>> {
    if (session.runtime === "opencode") {
      return this.runtimeMode === "clean"
        ? this.buildCleanLegacyAgentInfo(session.agentName)
        : this.buildLegacyAgentInfo(session.agentName);
    }
    return this.buildAgentInfo(session.agentName);
  }

  private async buildLegacyAgentInfo(
    agentName: string,
  ): Promise<Record<string, unknown>> {
    const sessions = await this.getLegacyRuntime().listSessions(agentName);
    const root = sessions[0];
    const now = this.nowMs();
    return {
      name: agentName,
      displayName: agentName,
      agentRole: 1,
      frameworkType: "opencode",
      rootSessionId: root?.sessionId ?? null,
      sessionCount: sessions.length,
      createdAt: root?.createdAtMs ?? now,
      updatedAt: root?.updatedAtMs ?? now,
      creationSource: "legacy",
      isBuiltin: true,
      identity: {
        display_name: agentName,
        avatar: DEFAULT_LOCAL_AGENT_AVATAR_URL,
      },
      description: "Legacy opencode runtime agent",
    };
  }

  private async hasLegacyAgent(agentName: string): Promise<boolean> {
    if (this.runtimeMode === "clean") {
      const sessions = await this.legacyMigrator?.listLegacySessions(agentName);
      return (sessions?.length ?? 0) > 0;
    }
    return (await this.getLegacyRuntime().listSessions(agentName)).length > 0;
  }

  private async getPreferredSessionForAgent(
    agentName: string,
  ): Promise<LocalSessionRecord | undefined> {
    let preferredRootSessionId: string | undefined;
    if (this.runtimeMode === "clean") {
      const legacySessions =
        (await this.legacyMigrator?.listLegacySessions(agentName)) ?? [];
      const legacyAgent = await this.legacyMigrator?.getLegacyAgent(agentName);
      preferredRootSessionId = legacyAgent?.rootSessionId;
      const preferred = resolvePreferredLegacyRootSession(
        legacySessions,
        preferredRootSessionId,
      );
      const preferredMigration = preferred
        ? await this.legacyMigrator?.getMigrationRecordForLegacySession(
            preferred.sessionId,
          )
        : undefined;
      if (preferred && preferredMigration?.status !== "failed")
        return preferred;
    }
    const sessions = await this.listAllSessions(agentName);
    if (this.runtimeMode === "clean") {
      const preferred = resolvePreferredLegacyRootSession(
        sessions,
        preferredRootSessionId,
      );
      if (preferred) return preferred;
    }
    return (
      sessions.find((session) => session.sessionType === "root") ?? sessions[0]
    );
  }
}

function readOnlyLegacySessionResponse(): Response {
  return json(
    {
      success: false,
      error:
        "Legacy opencode sessions are read-only in clean local-runtime mode.",
      code: "read_only_legacy_session",
    },
    { status: 409 },
  );
}

function isPiRootSession(
  session: LocalSessionRecord,
  agentName: string,
): boolean {
  return (
    session.agentName === agentName &&
    session.runtime === "pi-agent" &&
    session.sessionType === "root"
  );
}

function isActivePiRootSession(
  session: LocalSessionRecord,
  agentName: string,
): boolean {
  return isPiRootSession(session, agentName) && !session.archived;
}

function resolvePreferredLegacyRootSession<
  T extends LocalSessionRecord & { legacyFrameworkSessionId?: string },
>(sessions: T[], preferredRootSessionId?: string): T | undefined {
  if (preferredRootSessionId) {
    const preferred = sessions.find(
      (session) =>
        session.sessionType === "root" &&
        (session.sessionId === preferredRootSessionId ||
          session.legacyFrameworkSessionId === preferredRootSessionId),
    );
    if (preferred) return preferred;
  }
  return (
    sessions.find((session) => session.sessionType === "root") ?? sessions[0]
  );
}
