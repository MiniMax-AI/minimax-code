import type {
  InternalTurnPromptReadRegistry,
  PromptSnapshotSource,
} from "@mavis/agent-runtime";
import {
  buildCompressedModelImageFromBuffer,
  closeAgentDb,
  createUserStopCascade,
  type UserStopCascade,
  createLocalWorkspaceGitFacade,
  emitSubagentTelemetry,
  listFileTree,
  LocalQuestionnaireService,
  ManagedWorktreeService,
  readLocalPermissionMode,
  registerLocalAsset,
  replyLocalPermissionRequests,
  resolveTaskTarget,
  roleClass,
  searchFiles,
  SUBAGENT_TELEMETRY_EVENT,
  ThreadGoalContractError,
  updateLocalConfigFile,
  withAgentNameConflictMigrationLock,
  type CreateConversationCompatibilityHostOptions,
  type CreatedLocalRuntimeHost,
  type ManagedWorktreeServicePort,
  type QuestionnaireOwnedActionHandler,
  type QuestionnaireRequestAdmission,
  type CreateLocalRuntimeHostOptions as V1CreateLocalRuntimeHostOptions,
  type LocalRuntimeProductHostOptions as V1LocalRuntimeProductHostOptions,
} from "@mavis/local-runtime";
import type { AgentReferenceResolver } from "@mavis/shared";
import type {
  GlobalEventInput,
  GlobalThreadGoal,
} from "@mavis/shared/global-events";
import type {
  InitializeMcpServiceOptions,
  McpRuntimeCapability,
} from "../../service/mcp/index.js";

import type {
  LocalRuntimeApplication,
  MiniAppPresenter,
} from "../../application/session/process-local-application-contract.js";
import type {
  AgentStorageLockScope,
  AgentSystemFactCallbacks,
} from "../../service/agent/index.js";
import type { ContentSafetyReviewPort } from "../../service/content-safety/index.js";
import type { CronService } from "../../service/cron/index.js";
import type { PluginServiceCompatibility } from "../../service/plugin-system/index.js";
import {
  createV1AgentHostProductCapabilities,
  createV1AttachmentRegistration,
  createV1ChannelProductCapabilities,
  type V1AgentHostProductCapabilities,
  type V1AttachmentRegistration,
  type V1ChannelProductCapabilities,
  type V1GeneratedAssetInfrastructure,
} from "./agent-host.js";
import { createV1CronAgentCleanupBridge } from "./cron.js";
import {
  createV1SessionCompatibility,
  type V1SessionCompatibility,
} from "./session.js";

type LocalRuntimeProductHostOptions = V1LocalRuntimeProductHostOptions & {
  readonly configSource?: "default" | "explicit";
  readonly promptConfigKey?: Uint8Array;
  readonly miniAppSurface?: MiniAppPresenter;
};

type CreateLocalRuntimeHostOptions = V1CreateLocalRuntimeHostOptions &
  LocalRuntimeProductHostOptions;

type GlobalEventPublisher = (event: GlobalEventInput) => void;
type RuntimeConversation = NonNullable<
  CreateLocalRuntimeHostOptions["runtimeConversation"]
>;

interface AgentRuntimeTelemetryBinding {
  readonly metricsClient: {
    counter(name: string, value: number, labels?: Record<string, string>): void;
    gauge(name: string, value: number, labels?: Record<string, string>): void;
    histogram(
      name: string,
      value: number,
      labels?: Record<string, string>,
    ): void;
  };
  readonly emitBusEvent?: (
    type: string,
    payload: Record<string, unknown>,
  ) => void;
}

interface AgentRuntimeTelemetry {
  readonly facts: AgentSystemFactCallbacks;
  bind(input: AgentRuntimeTelemetryBinding): void;
  close(): void;
}

/**
 * Validates a persisted Agent mention through the same trusted v1 resolver
 * chain that Task uses. The primary family is intentionally excluded: a main
 * session may nominate only a delegatable SubAgent, never itself.
 */
async function resolveDelegatableAgentReference(
  resolver: AgentReferenceResolver,
  requestRef: string,
): Promise<"authorized" | "unauthorized" | "unknown"> {
  try {
    const scope = await resolver.resolveAgentReadScope(requestRef);
    if (scope.canonicalName === scope.primaryName) return "unauthorized";

    await resolveTaskTarget(resolver, requestRef);
    return "authorized";
  } catch {
    // Resolver failures must neither reveal roster details nor emit Task text.
    return "unknown";
  }
}

/** Cross-process cutover lock shared with the legacy conflict migration. */
export function withAgentStorageLock<T>(
  dataDir: string,
  operation: (scope: AgentStorageLockScope) => T | PromiseLike<T>,
): Promise<T> {
  return withAgentNameConflictMigrationLock(dataDir, async (legacyScope) => {
    let active = true;
    const applyCollision = (nowMs?: () => number) => {
      if (!active)
        throw new Error("Agent storage lock scope is no longer active");
      let result: ReturnType<typeof legacyScope.applyCollision> | undefined;
      let didApplyThrow = false;
      let applyError: unknown;
      try {
        result = legacyScope.applyCollision(nowMs);
      } catch (error) {
        didApplyThrow = true;
        applyError = error;
      }
      try {
        closeAgentDb(dataDir);
      } catch (closeError) {
        if (didApplyThrow) {
          const details =
            applyError && typeof applyError === "object"
              ? (applyError as {
                  failureStep?: unknown;
                  secondaryFailureStep?: unknown;
                })
              : {};
          throw Object.assign(
            new AggregateError(
              [applyError, closeError],
              "Agent storage migration apply and cached DB cleanup failed",
              { cause: applyError },
            ),
            {
              migrationId: legacyCollisionMigrationId(applyError),
              failureStep: details.failureStep,
              secondaryFailureStep: details.secondaryFailureStep,
            },
          );
        }
        throw Object.assign(
          new AggregateError(
            [closeError],
            "Agent storage migration cached DB cleanup failed",
            {
              cause: closeError,
            },
          ),
          { migrationId: result?.migrationId },
        );
      }
      if (didApplyThrow) throw applyError;
      if (!result)
        throw new Error("legacy_agent_source_collision_apply_missing_result");
      return result;
    };
    try {
      return await operation({
        inspectLegacyAgentStorage: () => {
          if (!active)
            throw new Error("Agent storage lock scope is no longer active");
          return legacyScope.inspectCollision();
        },
        applyLegacyAgentStorage: applyCollision,
        repairBuiltinAgentNameConflicts: async (input) => {
          if (!active)
            throw new Error("Agent storage lock scope is no longer active");
          await legacyScope.repairBuiltinAgentNameConflicts(input);
        },
      });
    } finally {
      active = false;
    }
  });
}

function legacyCollisionMigrationId(error: unknown): string | undefined {
  const migrationId =
    error && typeof error === "object" && "migrationId" in error
      ? (error as { migrationId?: unknown }).migrationId
      : undefined;
  return typeof migrationId === "string" &&
    /^agent-name-conflicts-\d+$/u.test(migrationId)
    ? migrationId
    : undefined;
}

/** Deferred, fail-open adapter for Agent facts emitted before v1 host binding. */
export function createDeferredAgentRuntimeTelemetry(): AgentRuntimeTelemetry {
  let sink: Parameters<typeof emitSubagentTelemetry>[0];
  let closed = false;
  const facts: AgentSystemFactCallbacks = {
    onNameCompatResolve: (fact) => {
      emitSubagentTelemetry(sink, SUBAGENT_TELEMETRY_EVENT.nameCompatResolve, {
        intent: fact.intent,
        canonical_class: fact.canonicalClass,
        source: fact.source,
        success: fact.success,
        ...(fact.memberCountBucket
          ? { member_count_bucket: fact.memberCountBucket }
          : {}),
        ...(fact.errorCode ? { error_code: fact.errorCode } : {}),
      });
    },
    onAgentRoleObservation: (fact) => {
      emitSubagentTelemetry(
        sink,
        SUBAGENT_TELEMETRY_EVENT.agentRoleObservation,
        {
          status: fact.status,
          source: fact.source,
          role_class: roleClass(fact.role),
        },
      );
    },
    // Emitted on EVERY overlay branch, including the skips. "My old display
    // name did not carry over" must be answerable from one event, not from
    // the absence of a repository write.
    onPrimaryProfileOverlay: (fact) => {
      emitSubagentTelemetry(
        sink,
        SUBAGENT_TELEMETRY_EVENT.primaryProfileOverlay,
        {
          outcome: fact.outcome,
          // Field names only: a displayName or workspace path is user content.
          adopted_fields: fact.adoptedFields.join(","),
          adopted_count: fact.adoptedFields.length,
          display_name_locked: fact.displayNameLocked,
        },
      );
    },
  };
  return {
    facts,
    bind: (input) => {
      if (closed) return;
      sink = createAgentTelemetryHost(input);
    },
    close: () => {
      closed = true;
      sink = undefined;
    },
  };
}

function createAgentTelemetryHost(
  input: AgentRuntimeTelemetryBinding,
): Parameters<typeof emitSubagentTelemetry>[0] {
  const client = input.metricsClient;
  return {
    metrics: {
      incr: (name, labels) => client.counter(name, 1, labels),
      gauge: (name, value, labels) => client.gauge(name, value, labels),
      latency: (name, durationMs, labels) =>
        client.histogram(name, durationMs, labels),
    },
    ...(input.emitBusEvent ? { emitBusEvent: input.emitBusEvent } : {}),
  };
}

export interface DeferredV1ConversationBridge extends RuntimeConversation {
  bind(conversation: RuntimeConversation): void;
  fail(error: unknown): void;
  shutdown(error?: unknown): void;
}

interface V1GlobalEventPublisherBinding {
  bindPublisher(publisher: GlobalEventPublisher): () => void;
}

export interface V1ServiceCompatibility extends V1ProcessLocalSupport {
  readonly sandbox: {
    readonly eval?: Pick<
      NonNullable<CreatedLocalRuntimeHost["evalReporterFactory"]>,
      "canReport" | "reportRuntimeEvent"
    >;
    writeConfig(candidate: unknown): Promise<void>;
  };
  /** V1-owned Git process capability exposed to the V2 worktree controller. */
  readonly managedWorktrees: ManagedWorktreeServicePort;
  readonly cron: {
    bindAgentCleanup(
      service: Pick<CronService, "deleteDefinitionsByAgent">,
    ): void;
    deleteAgentTasks(agentName: string): Promise<void>;
  };
  readonly modelProvider?: {
    refreshOfficialModels(): Promise<void>;
  };
  readonly agentReferences: {
    resolveDelegatable(
      requestRef: string,
    ): Promise<"authorized" | "unauthorized" | "unknown">;
  };
  readonly agentHost: V1AgentHostProductCapabilities;
  /** Neutral codec/storage infrastructure used by V2 product owners. */
  readonly generatedAssets: V1GeneratedAssetInfrastructure;
  readonly promptConfig: { readonly autoUpdate: boolean } | undefined;
  readonly promptSnapshots: {
    bind(source: PromptSnapshotSource | undefined): void;
  };
  readonly internalTurnPromptReads: {
    bind(registry: InternalTurnPromptReadRegistry | undefined): void;
  };
  readonly attachmentRegistration: V1AttachmentRegistration;
  readonly channel: V1ChannelProductCapabilities;
  readonly backgroundTasks: {
    bindRuntimeOwner(owner: {
      readonly ownerId: string;
      isOwnerAlive(ownerId: string): boolean | undefined;
    }): void;
    recover(recoveredTurnIds: readonly string[]): Promise<boolean | void>;
    pollRecovery(): Promise<boolean>;
    readonly userStop: UserStopCascade;
  };
  readonly conversation: {
    bind(conversation: RuntimeConversation): Promise<void>;
    fail(error: unknown): void;
    shutdown(error?: unknown): void;
  };
  readonly events: V1GlobalEventPublisherBinding;
  /** Electron-owned native MiniApp presenter; absent outside the desktop Host. */
  readonly miniAppSurface?: MiniAppPresenter;
  readonly safety: {
    readonly review: ContentSafetyReviewPort;
  };
  readonly greeting: {
    canSend(): boolean;
    sendSystemReminder(input: {
      readonly agentName: string;
      readonly sessionId: string;
      readonly content: string;
      readonly requestedTurnId: string;
    }): Promise<
      "finished" | { readonly status: "accepted"; readonly turnId: string }
    >;
  };
  readonly questionnaires: {
    resolveLocale(): string;
    createService(): LocalQuestionnaireService;
    bindOwnedAction(
      handler: QuestionnaireOwnedActionHandler,
      onFailure?: (requestId: string) => void,
    ): void;
    bindRequestAdmission(admission: QuestionnaireRequestAdmission): void;
  };
  readonly sessionV2: V1SessionCompatibility;
  readonly plugin: Omit<
    PluginServiceCompatibility,
    "database" | "logger" | "mcp" | "listReservations"
  >;
  readonly mcp: Omit<
    InitializeMcpServiceOptions,
    "dataDir" | "nowMs" | "metrics"
  >;
}

interface PreparedV1ShellPorts {
  readonly skillEnabledState: {
    getDisabledLocationUris(): Promise<ReadonlySet<string>>;
    setEnabled(locationUri: string, enabled: boolean): Promise<void>;
    forget(locationUri: string): Promise<void>;
  };
  readonly runLegacyImCredentialMigration: (
    action: () => Promise<void>,
  ) => Promise<void>;
  readonly cliSunsetNotice: {
    evaluate(
      nowMs: number,
      loadFiles: () => Promise<
        readonly { path: string; content: string; mtimeMs: number }[]
      >,
    ): Promise<{ paths: string[]; teamPaths: string[] } | undefined>;
  };
}

export interface V1ServiceFactory {
  create(): V1ServiceCompatibility;
}

export interface V1RuntimeCompatibility {
  configureHostOptions(
    options: LocalRuntimeProductHostOptions,
    agentResolver: AgentReferenceResolver,
    ports: PreparedV1ShellPorts,
  ): CreateConversationCompatibilityHostOptions;
  createServiceCompatibility(
    host: CreatedLocalRuntimeHost,
    options: CreateLocalRuntimeHostOptions,
  ): V1ServiceCompatibility;
  failConversation(error: unknown): void;
  shutdownConversation(error?: unknown): void;
}

/** Owns the temporary v1/v2 reference slice; runtime.ts sees no service-specific wiring. */
export function createV1RuntimeCompatibility(
  conversation: DeferredV1ConversationBridge,
  factories: {
    createQuestionnaireService(
      host: CreatedLocalRuntimeHost,
    ): LocalQuestionnaireService;
  } = {
    createQuestionnaireService: (host) =>
      new LocalQuestionnaireService(host.apiHost.questionnaireServiceDeps()),
  },
): V1RuntimeCompatibility {
  const agentCleanup = createV1CronAgentCleanupBridge();
  const globalEvents = createDeferredGlobalEventPublisher();
  const mcp = createDeferredMcpRuntimeCapability();
  return {
    configureHostOptions: (options, agentResolver, ports) => ({
      ...options,
      cronConsumerEnabled: false,
      mcpRuntime: mcp.capability,
      agentResolver,
      disableLegacyConversation: true,
      deferQuestionnaireRecovery: true,
      runtimeConversation: conversation,
      globalEventPublisher: globalEvents.publish,
      deleteAgentCronTasks: (agentName) =>
        agentCleanup.deleteAgentCronTasks(agentName),
      skillEnabledState: ports.skillEnabledState,
      runLegacyImCredentialMigration: ports.runLegacyImCredentialMigration,
      cliSunsetNotice: ports.cliSunsetNotice,
    }),
    createServiceCompatibility: (host, options) => {
      const api = host.apiHost;
      const processLocal = createV1ProcessLocalSupport(host);
      return {
        ...processLocal,
        sandbox: {
          eval: host.evalReporterFactory,
          writeConfig: async (candidate) => {
            await updateLocalConfigFile({}, new Set(["sandbox"]), {
              sandbox: structuredClone(candidate),
            });
          },
        },
        managedWorktrees: new ManagedWorktreeService({
          listRunningWorktreeDirs: async () =>
            (await api.listAllSessions())
              .filter((session) => session.status === "started")
              .map(
                (session) =>
                  session.runLocation?.resolvedDir ?? session.workspaceDir,
              ),
        }),
        cron: {
          bindAgentCleanup: (service) => agentCleanup.bind(service),
          deleteAgentTasks: (agentName) => api.deleteAgentCronTasks(agentName),
        },
        modelProvider: {
          refreshOfficialModels: () => api.refreshOfficialModels(),
        },
        agentReferences: {
          resolveDelegatable: (requestRef) =>
            resolveDelegatableAgentReference(api.agentResolver, requestRef),
        },
        agentHost: createV1AgentHostProductCapabilities(
          host.apiHost,
          host.evalReporterFactory,
        ),
        generatedAssets: {
          compressModelImage: (input) => {
            const compressed = buildCompressedModelImageFromBuffer(
              Buffer.from(input.bytes),
              input.fileName,
              undefined,
              input.budget,
            );
            return compressed
              ? {
                  dataUrl: compressed.filePart.url,
                  width: compressed.width,
                  height: compressed.height,
                }
              : undefined;
          },
          registerGeneratedAsset: async (input) => {
            const record = await registerLocalAsset({
              ...input,
              dataDir: api.configGetter().dataDir,
            });
            return {
              assetId: record.assetId,
              absolutePath: record.absolutePath,
              fileName: record.fileName,
              mimeType: record.mimeType,
              bytes: record.bytes,
            };
          },
        },
        promptConfig: api.configGetter().promptConfig,
        promptSnapshots: {
          bind: (source) => api.bindPromptSnapshots(source),
        },
        internalTurnPromptReads: {
          bind: (registry) => api.bindInternalTurnPromptReads(registry),
        },
        attachmentRegistration: createV1AttachmentRegistration(host.apiHost),
        channel: createV1ChannelProductCapabilities(host.apiHost),
        backgroundTasks: {
          bindRuntimeOwner: (owner) =>
            api.backgroundTaskService.bindRuntimeOwner(owner),
          recover: async (recoveredTurnIds) => {
            await api.backgroundTaskService.reconcileStartupLostTasks({
              recoveredTurnIds,
            });
            return api.backgroundTaskService.hasPendingStartupRecovery();
          },
          pollRecovery: () => api.backgroundTaskService.pollStartupLostTasks(),
          userStop: createUserStopCascade({
            host: api,
            pauseActiveGoal: (sessionId) => api.threadGoal.pauseActiveGoalForAbort(sessionId),
          }),
        },
        conversation: {
          bind: async (service) => {
            await api.recoverThreadGoalKickoffs(service);
            conversation.bind(service);
          },
          fail: (error) => conversation.fail(error),
          shutdown: (error) => conversation.shutdown(error),
        },
        events: { bindPublisher: globalEvents.bindPublisher },
        ...(options.miniAppSurface
          ? { miniAppSurface: options.miniAppSurface }
          : {}),
        safety: {
          review: api.contentSafetyChecker,
        },
        greeting: {
          canSend: () =>
            Boolean(api.authContextGetter?.()?.accessToken?.trim()),
          sendSystemReminder: (input) => api.sendGreetingSystemReminder(input),
        },
        questionnaires: {
          resolveLocale: () =>
            api.questionnaireServiceDeps().resolveLocale?.() ?? "en",
          createService: () => factories.createQuestionnaireService(host),
          bindOwnedAction: (handler, onFailure) =>
            api.bindQuestionnaireOwnedActionHandler(handler, onFailure),
          bindRequestAdmission: (admission) =>
            api.bindQuestionnaireRequestAdmission(admission),
        },
        sessionV2: createV1SessionCompatibility(host),
        plugin: {
          dataDir: host.dataDir,
          authContextGetter: options.authContextGetter ?? (() => undefined),
          fetchImpl: options.fetchImpl ?? globalThis.fetch,
          ...(options.appVersion ? { appVersion: options.appVersion } : {}),
          metrics: host.metricsClient,
          skill: host.apiHost.skillService,
          standaloneSkillIdentities: () =>
            host.apiHost.skillHubStore.getInstalledIdentities(),
        },
        mcp: {
          enableLiveMcp: options.enableLiveMcp === true,
          builtinMatrix: false,
          matrixWebSearchOnly: false,
          bindRuntime: mcp.bind,
          diagnostics: host.observability,
          ...(options.mcpLogger ? { logger: options.mcpLogger } : {}),
          ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        },
      };
    },
    failConversation: (error) => conversation.fail(error),
    shutdownConversation: (error) => conversation.shutdown(error),
  };
}

function createDeferredGlobalEventPublisher(): {
  readonly publish: GlobalEventPublisher;
  readonly bindPublisher: V1GlobalEventPublisherBinding["bindPublisher"];
} {
  let publisher: GlobalEventPublisher | undefined;
  return {
    publish: (event) => publisher?.(event),
    bindPublisher: (next) => {
      publisher = next;
      return () => {
        if (publisher === next) publisher = undefined;
      };
    },
  };
}

export async function cleanupFailedV1Startup(
  v1: CreatedLocalRuntimeHost | undefined,
  closeV1: (() => Promise<void>) | undefined,
  warn: (cleanupStep: string, error: unknown) => void,
): Promise<void> {
  const steps: Array<[string, () => void | Promise<void>]> = [
    ["stop_v1_cron", () => v1?.apiHost.cronRuntime.stop()],
    ["stop_channels", () => v1?.apiHost.shutdownChannelSubsystem()],
    ["close_v1", () => closeV1?.()],
    ["close_metrics", () => v1?.metricsClient.close()],
  ];
  for (const [cleanupStep, step] of steps) {
    try {
      await step();
    } catch (error) {
      try {
        warn(cleanupStep, error);
      } catch {
        // Cleanup and its original startup failure stay primary even if reporting fails.
      }
    }
  }
}

type PeripheralCapabilityKey =
  | "goals"
  | "questionnaires"
  | "workspace"
  | "permissions"
  | "account"
  | "diagnostics"
  | "configuration"
  | "backgroundTasks";

type V1ProcessLocalPeripheralApplication = {
  readonly [Key in PeripheralCapabilityKey]-?: NonNullable<
    LocalRuntimeApplication[Key]
  >;
};

interface V1ProcessLocalSupport {
  readonly peripherals: V1ProcessLocalPeripheralApplication;
  readonly skills: LocalRuntimeApplication["skills"];
}

function createV1ProcessLocalSupport(
  host: CreatedLocalRuntimeHost,
): V1ProcessLocalSupport {
  return {
    peripherals: createPeripheralApplication(host),
    skills: host.apiHost.skillService,
  };
}

function createPeripheralApplication(
  host: CreatedLocalRuntimeHost,
): V1ProcessLocalPeripheralApplication {
  const questionnaires = new LocalQuestionnaireService(
    host.apiHost.questionnaireServiceDeps(),
  );
  return {
    goals: createThreadGoalApplication(host.apiHost.threadGoal, (sessionId) =>
      host.apiHost.isReadOnlyLegacySession(sessionId),
    ),
    questionnaires: {
      getPending: async (input) =>
        (await questionnaires.getPending(input))?.request ?? undefined,
      getLatestPlanReview: async (input) =>
        (await questionnaires.getLatestPlanReview(input))?.request ?? undefined,
      reply: async (input) =>
        questionnaires.reply({
          agentName: input.agentName,
          requestId: input.requestId,
          reply: {
            schemaVersion: 2,
            requestId: input.requestId,
            answers: input.answers,
            submittedAt: input.submittedAt,
          },
        }),
      dismiss: (input) => questionnaires.dismiss(input),
    },
    workspace: {
      git: createLocalWorkspaceGitFacade(),
      listFileTree: async ({ workspaceDir, path = "", signal }) => {
        signal?.throwIfAborted();
        const entries = await listFileTree(workspaceDir, path);
        signal?.throwIfAborted();
        return entries;
      },
      searchFiles: async ({ workspaceDir, query, limit, signal }) => {
        signal?.throwIfAborted();
        const matches = await searchFiles(workspaceDir, query, limit);
        signal?.throwIfAborted();
        return matches;
      },
    },
    permissions: {
      listPending: async ({ signal } = {}) => {
        signal?.throwIfAborted();
        return host.apiHost
          .permissionRouteContext()
          .approvalService.listPending();
      },
      reply: ({ requestIds, decision }) =>
        replyLocalPermissionRequests(
          host.apiHost.permissionRouteContext(),
          [...requestIds],
          decision,
        ),
    },
    account: {
      getStatus: ({ sessionId, model } = {}) =>
        host.apiHost.getProcessLocalAccountStatus(sessionId, model),
    },
    diagnostics: {
      getRuntimeSnapshot: async () =>
        host.apiHost.getProcessLocalRuntimeDiagnostics(),
    },
    configuration: {
      getPermissionMode: async () =>
        readLocalPermissionMode(host.apiHost.configGetter().permissionMode),
      setPermissionMode: ({ mode }) =>
        host.apiHost.setProcessLocalPermissionMode(mode),
    },
    backgroundTasks: {
      list: async ({
        ownerSessionId,
        statuses,
        kinds,
        undeliveredOnly,
        limit,
      }) =>
        (
          await host.apiHost.backgroundTaskService.list({
            ownerSessionId,
            ...(statuses ? { statuses: [...statuses] } : {}),
            ...(kinds ? { kinds: [...kinds] } : {}),
            ...(undeliveredOnly !== undefined ? { undeliveredOnly } : {}),
            limit: Math.min(Math.max(1, limit ?? 50), 100),
            orderBy: "updated_at",
            order: "desc",
          })
        ).items,
    },
  };
}

type ThreadGoalIntegration = CreatedLocalRuntimeHost["apiHost"]["threadGoal"];
type ThreadGoalState = NonNullable<
  Awaited<ReturnType<ThreadGoalIntegration["store"]["getBySession"]>>
>;
type GoalApplication = NonNullable<LocalRuntimeApplication["goals"]>;
type GoalApplicationPatch = Parameters<GoalApplication["patch"]>[1];

/** Process-local facade over the authoritative v1 Thread Goal integration. */
function createThreadGoalApplication(
  integration: ThreadGoalIntegration,
  isReadOnlyLegacySession: (sessionId: string) => Promise<boolean>,
): GoalApplication {
  const requireEnabled = () => {
    if (!integration.isEnabled()) throw new Error("Thread Goal is disabled.");
  };
  const assertMutable = async (sessionId: string) => {
    if (await isReadOnlyLegacySession(sessionId)) {
      throw new Error(
        "Legacy opencode sessions are read-only in clean local-runtime mode.",
      );
    }
  };
  return {
    isEnabled: () => integration.isEnabled(),
    get: async (sessionId) => {
      requireEnabled();
      const state = await integration.getGoalForResponse(
        requireGoalSessionId(sessionId),
      );
      return state ? toGlobalThreadGoal(state) : undefined;
    },
    create: async ({
      sessionId,
      objective: rawObjective,
      tokenBudget,
      kickoffAttachments,
    }) => {
      requireEnabled();
      const normalizedSessionId = requireGoalSessionId(sessionId);
      await assertMutable(normalizedSessionId);
      const objective = requireGoalObjective(rawObjective);
      const input = {
        sessionId: normalizedSessionId,
        objective,
        ...(tokenBudget !== undefined ? { tokenBudget } : {}),
        ...(kickoffAttachments?.length ? { kickoffAttachments } : {}),
      };
      const created = kickoffAttachments?.length
        ? await integration.createGoal(input, { requireKickoffAdmission: true })
        : await integration.createGoal(input);
      return toGlobalThreadGoal(created);
    },
    patch: async (sessionId, patch) => {
      requireEnabled();
      const normalizedSessionId = requireGoalSessionId(sessionId);
      await assertMutable(normalizedSessionId);
      // Same intent split as the HTTP route: a bare `paused` is the user
      // leaving the Goal and must take the atomic lifecycle transition, not
      // the generic field patch.
      const updated = isBareUserPause(patch)
        ? await integration.pauseGoalByUser(normalizedSessionId)
        : await integration.patchGoal(
            normalizedSessionId,
            normalizeProcessLocalGoalPatch(patch),
          );
      if (!updated) throw goalNotFound(normalizedSessionId);
      return toGlobalThreadGoal(updated);
    },
    clear: async (sessionId) => {
      requireEnabled();
      const normalizedSessionId = requireGoalSessionId(sessionId);
      await assertMutable(normalizedSessionId);
      if (!(await integration.deleteGoal(normalizedSessionId))) {
        throw goalNotFound(normalizedSessionId);
      }
      return true;
    },
  };
}

function goalNotFound(sessionId: string): ThreadGoalContractError {
  return new ThreadGoalContractError(
    404,
    `Goal not found for session: ${sessionId}`,
    "GOAL_NOT_FOUND",
  );
}

function normalizeGoalObjectivePatch(
  objective: string | undefined,
): string | undefined {
  return objective === undefined ? undefined : requireGoalObjective(objective);
}

/**
 * A bare `status: 'paused'` carries the user's intent to leave the Goal.
 * Anything paired with an objective or budget edit stays a field patch.
 */
function isBareUserPause(patch: GoalApplicationPatch): boolean {
  return (
    patch.status === "paused" &&
    patch.objective === undefined &&
    patch.tokenBudget === undefined
  );
}

function normalizeProcessLocalGoalPatch(
  patch: GoalApplicationPatch,
): Parameters<ThreadGoalIntegration["patchGoal"]>[1] {
  const objective = normalizeGoalObjectivePatch(patch.objective);
  if (
    patch.status === undefined &&
    objective === undefined &&
    patch.tokenBudget === undefined
  ) {
    throw new Error(
      "Goal patch must include status, objective, or tokenBudget.",
    );
  }
  return {
    ...(patch.status ? { status: patch.status } : {}),
    ...(objective !== undefined ? { objective } : {}),
    ...(patch.tokenBudget !== undefined
      ? { tokenBudget: patch.tokenBudget }
      : {}),
  };
}

function toGlobalThreadGoal(state: ThreadGoalState): GlobalThreadGoal {
  return {
    goalId: state.goalId,
    sessionId: state.sessionId,
    objective: state.objective,
    status: state.status,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    tokensUsed: state.tokensUsed,
    turnsUsed: state.turnsUsed,
    timeUsedSeconds: state.timeUsedSeconds,
    tokenBudget: state.tokenBudget,
    statusReason: state.statusReason,
    executionWait: state.executionWait,
    ...(state.lastVerification !== undefined
      ? {
          lastVerification: {
            backend: state.lastVerification.backend,
            verdict: state.lastVerification.verdict,
            reason: state.lastVerification.reason,
            missing: [...state.lastVerification.missing],
            notMetStreak: state.lastVerification.notMetStreak,
            at: state.lastVerification.at,
          },
        }
      : {}),
    hasKickoffAttachments: state.kickoffAttachments.length > 0,
  };
}

function requireGoalSessionId(value: string): string {
  const sessionId = value.trim();
  if (!sessionId) throw new Error("sessionId is required.");
  return sessionId;
}

function requireGoalObjective(value: string): string {
  const objective = value.trim();
  if (!objective) throw new Error("goal objective must not be empty");
  return objective;
}

/** Only forwards old consumers to the V2 instance; has no settings, pool or registry. */
function createDeferredMcpRuntimeCapability(): {
  readonly capability: McpRuntimeCapability;
  bind(value: McpRuntimeCapability): () => void;
} {
  let current: McpRuntimeCapability | undefined;
  const requireOwner = (): McpRuntimeCapability => {
    if (!current)
      throw new Error("MCP runtime is not initialized or has been closed");
    return current;
  };
  return {
    capability: {
      isBuiltinMatrixAvailable: () => requireOwner().isBuiltinMatrixAvailable(),
      readConfiguredServerNames: () =>
        requireOwner().readConfiguredServerNames(),
      createMavisAdapter: (emit) => requireOwner().createMavisAdapter(emit),
      listToolEntriesForTurn: (input) =>
        requireOwner().listToolEntriesForTurn(input),
    },
    bind: (value) => {
      if (current) throw new Error("MCP runtime is already bound");
      current = value;
      return () => {
        if (current === value) current = undefined;
      };
    },
  };
}
