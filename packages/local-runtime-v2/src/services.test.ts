import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LLMRetryEvent,
  RunTurnInput,
} from "@mavis/agent-core/pi-turn-runner";
import { createAgentRuntime, type AgentExtension } from "@mavis/agent-runtime";
import { baseCtx } from "../../agent-runtime/src/testing/fixtures.js";
import type { RuntimeTool } from "@mavis/agent-core/tools";
import { LocalSkillToolDef } from "@mavis/agent-tools/desktop";
import type {
  DatabaseLike,
  QuestionnaireOwnedActionHandler,
} from "@mavis/local-runtime";
import type {
  GlobalEvent,
  GlobalEventInput,
} from "@mavis/shared/global-events";

import { createRuntimeSourceReferenceExtension } from "./application/agent/source-reference-extension.js";
import type { V1ServiceCompatibility } from "./compat/v1/runtime.js";
import type { AppDb } from "./infra/db/client.js";
import { readPreferenceValue } from "./infra/db/preference-values.js";
import { migratePluginTestDatabase } from "../test/helpers/plugin-database.js";
import { EventBus } from "./infra/event-bus/index.js";
import type { SchedulerClient } from "./infra/scheduler/index.js";
import type { LocalAgentService } from "./service/agent/index.js";
import { resolveAgentPromptSurface } from "./service/turn-system/agent-host/preparation/agent-prompt-surface.js";
import type { InitializeTurnSystemOptions } from "./service/turn-system/index.js";
import {
  requireAgentRuntime,
  requireTurnSystem,
} from "./service/turn-system/lifecycle/runtime-initialization-guards.js";
import {
  createRuntimeServices as createRuntimeServicesGraph,
  type CreateRuntimeServicesOptions,
  type RuntimeServices,
} from "./services.js";

type QueueClassifier = NonNullable<
  InitializeTurnSystemOptions["classifyQueuedItem"]
>;
type QueueFifoYieldPolicy = NonNullable<
  InitializeTurnSystemOptions["shouldYieldFifoPosition"]
>;

type CapturedTurnOptions = {
  readonly disposeRuntimeSession?: InitializeTurnSystemOptions["disposeRuntimeSession"];
  readonly processStartedAtMs: number;
  readonly classifyQueuedItem?: QueueClassifier;
  readonly shouldYieldFifoPosition?: QueueFifoYieldPolicy;
  readonly resumeSessionDeletion?: NonNullable<
    InitializeTurnSystemOptions["resumeSessionDeletion"]
  >;
  readonly turnSettlement?: InitializeTurnSystemOptions["turnSettlement"];
};

type QueryCollapseStartInput = {
  readonly sessionId: string;
  readonly queryKey: string;
  readonly currentTurnId: string;
};

const queryCollapseMocked = vi.hoisted(() => ({
  keyResolverOptions: undefined as Record<string, unknown> | undefined,
  deliveryOptions: undefined as Record<string, unknown> | undefined,
  keys: {
    queryKeyForTurn: vi.fn(
      async (_sessionId: string, turnId: string) => `turn:${turnId}`,
    ),
    queryKeyForContinuation: vi.fn(
      async (_sessionId: string, turnId: string) => `turn:${turnId}`,
    ),
  },
}));

const runtimeOwnerIdentity: CreateRuntimeServicesOptions["runtimeOwnerIdentity"] =
  {
    instanceId: "runtime-test",
    recoveryRetryMs: 10_000,
    createOwnerId: (kind) => `${kind}:1:runtime-test.operation`,
    ownsOwnerId: (ownerId) => ownerId.includes(":1:runtime-test."),
    isOwnerAlive: () => false,
    onCompromised: () => () => undefined,
    close: async () => undefined,
  };
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as new (
  filename: string,
) => DatabaseLike;

function createRuntimeServices(
  options: Omit<CreateRuntimeServicesOptions, "runtimeOwnerIdentity">,
) {
  return createRuntimeServicesGraph({
    ...options,
    runtimeOwnerIdentity,
  });
}

function createAgentServiceMock(vitest: Pick<typeof vi, "fn">) {
  return {
    ensureBuiltinRows: vitest.fn(async () => []),
    list: vitest.fn(async () => []),
    get: vitest.fn(async () => undefined as never),
    create: vitest.fn(async () => undefined as never),
    update: vitest.fn(async () => undefined as never),
    delete: vitest.fn(async () => undefined),
    resolveAgentReadScope: vitest.fn(async (requestedName: string) => ({
      requestedName,
      canonicalName: requestedName,
      primaryName: "mavis",
      compatibleNames: [requestedName],
      exact: true,
      source: "stable_name" as const,
      exactOwnerName: requestedName,
    })),
    resolveAgentWriteTarget: vitest.fn(
      async (requestedName: string) => requestedName,
    ),
    resolveAgentExecutionTarget: vitest.fn(
      async (exactOwnerName: string) => exactOwnerName,
    ),
    requireExactAgentKey: vitest.fn(async (name: string) =>
      name.replace(/^agent:/u, ""),
    ),
    clearRootSession: vi.fn(async () => true),
    setRootSession: vitest.fn(async () => true),
    getPersistedOwner: vitest.fn(
      async (_exactOwnerName: string) =>
        undefined as
          | {
              readonly exactOwnerName: string;
              readonly requestRef: string;
              readonly canonicalViewName: string;
              readonly resolvedAgentName: string;
              readonly agentRole: string;
              readonly creationSource: "builtin" | "manual" | "auto";
              readonly displayName: string;
            }
          | undefined,
    ),
    getPersistedOwnerForFrozenTask: vitest.fn(
      async (_exactOwnerName: string) =>
        undefined as
          | {
              readonly exactOwnerName: string;
              readonly requestRef: string;
              readonly canonicalViewName: string;
              readonly resolvedAgentName: string;
              readonly agentRole: string;
              readonly creationSource: "builtin" | "manual" | "auto";
              readonly displayName: string;
            }
          | undefined,
    ),
    resolvePrimaryExecutionIdentity: vitest.fn(
      async (_storageOwnerName: string) =>
        undefined as
          | {
              readonly storageOwnerName: string;
              readonly executionOwnerName: string;
              readonly outcome: "canonical" | "legacy_fallback" | "conflict";
            }
          | undefined,
    ),
    setRootSessionByExactOwner: vitest.fn(async () => true),
    renderProfile: vitest.fn(
      async (_input: {
        readonly exactOwnerName: string;
        readonly surface?: string;
      }) => undefined as never,
    ),
    listBuiltinDefinitions: vitest.fn(async () => []),
    listLegacyPinnedAgentRefs: vitest.fn(async () => []),
    getGreetingState: vitest.fn(async () => undefined),
    markGreetingSent: vitest.fn(async () => true),
    buildGreetingReminder: vitest.fn(async () => ""),
    bindBuiltinModelGroupResolver: vitest.fn(),
    bindPromptConfig: vitest.fn(),
    bindConfigPreviewDiagnostics: vitest.fn(),
    bindEffectiveConfigResolver: vitest.fn(),
    bindCandidateModelValidator: vitest.fn(),
    close: vitest.fn(),
  };
}

function createSessionAndTurnSystemMocks(
  vitest: Pick<typeof vi, "fn">,
  events: string[],
) {
  return {
    sessionSystem: {
      repositories: {
        sessions: { get: vitest.fn(), list: vitest.fn(), update: vitest.fn() },
        projects: {
          listPage: vitest.fn(async () => ({ projects: [], hasMore: false })),
          setPinned: vitest.fn(),
          putOrder: vitest.fn(),
        },
      },
      projects: { service: { resolve: vitest.fn() } },
      sessions: {
        repository: { get: vitest.fn(), has: vitest.fn() },
        query: { find: vitest.fn() },
        records: {
          ensureSessionAgentDefinition: vitest.fn(),
          createInternalSession: vitest.fn(),
          bindTaskAgentBindingCapture: vitest.fn(),
          backfillAllSessionAgentDefinitions: vitest.fn(async () => undefined),
        },
        interactionMode: {
          get: vitest.fn(async () => "default" as const),
          setPlan: vitest.fn(async () => "updated" as const),
          ensureDefault: vitest.fn(async () => "updated" as const),
        },
      },
      messages: {
        query: {},
        repository: { get: vitest.fn(), listTurn: vitest.fn() },
        userMessages: {
          commit: vitest.fn(
            async (input: {
              sessionId: string;
              turnId: string;
              messageKey: string;
              content?: string;
            }) => ({
              sessionId: input.sessionId,
              turnId: input.turnId,
              messageKey: input.messageKey,
              created: true,
              firstUserMessageForSession: true,
              message: {
                msg_id: "message-1",
                role: "user",
                msg_content: input.content ?? "",
                timestamp: 1,
              },
            }),
          ),
        },
      },
      titles: {
        generate: vitest.fn(),
        generateAfterAcceptedUserMessage: vitest.fn(),
      },
      queue: {
        committed: {
          listPendingSessionIds: vitest.fn(async () => []),
          list: vitest.fn(async () => []),
          requireMutableSession: vitest.fn(),
          findByClientRequestId: vitest.fn(),
          enqueue: vitest.fn(),
        },
      },
      planDocuments: {
        resolveAndEnsure: vitest.fn(async () => ({
          canonicalPath: "/history/session-1/artifacts/plan.md",
        })),
        prepareNewDraft: vitest.fn(),
        readFrozenSnapshot: vitest.fn(),
        copyForFork: vitest.fn(async () => ({
          canonicalPath: "/history/child/artifacts/plan.md",
          copied: true,
        })),
        reconcilePreparedDrafts: vitest.fn(async () => {
          events.push("plan-documents:reconcile");
        }),
      },
      files: {},
      usage: { repository: {} },
      canonicalHistory: { inspectActive: vitest.fn() },
      fork: {
        sessionDataVersion: 4,
        boundary: { resolve: vitest.fn() },
        sessions: {
          get: vitest.fn(),
          create: vitest.fn(),
          update: vitest.fn(),
          delete: vitest.fn(),
        },
        display: {
          list: vitest.fn(),
          probePrefix: vitest.fn(),
          copyPrefix: vitest.fn(),
          copyPrefixAndAppendForkOrigin: vitest.fn(),
          appendForkOrigin: vitest.fn(),
          latestRevision: vitest.fn(),
          deleteSession: vitest.fn(),
        },
        assets: {
          copyPrefix: vitest.fn(),
          probe: vitest.fn(),
          compensate: vitest.fn(),
        },
      },
      conversationMutationState: {
        isActive: vitest.fn(() => false),
        readPlanState: vitest.fn(async () => ({
          active: false,
          interactionMode: "default" as const,
          lifecycleActive: false,
        })),
        bindPlanStateReader: vitest.fn(),
      },
      stream: {
        resume: vitest.fn(),
        write: vitest.fn(),
        deleteSession: vitest.fn(),
      },
      queryCollapse: {
        state: {
          start: vitest.fn(async (input: QueryCollapseStartInput) => ({
            ...input,
            forceExpanded: false,
            processingStartedAtMs: 1,
            updatedAtMs: 1,
          })),
          finish: vitest.fn(),
          findByCurrentTurn: vitest.fn(),
          findProcessingByCurrentTurn: vitest.fn(),
          findByKey: vitest.fn(),
        },
      },
      ready: vitest.fn(async () => {
        events.push("session:ready");
      }),
      runStorageMaintenance: vitest.fn(async () => undefined),
      close: vitest.fn(async () => {
        events.push("session:close");
      }),
    },
    turnSystem: {
      turns: {
        submit: vitest.fn(),
        steer: vitest.fn(),
        abort: vitest.fn(),
        requestCompaction: vitest.fn(),
        dispatchQueue: vitest.fn(),
        sessionDeletion: vitest.fn(),
      },
      sessionLifecycle: {
        runExclusive: vitest.fn((_sessionId, operation) => operation()),
        tryRunExclusive: vitest.fn(
          async (
            _sessionId,
            operation: (signal?: AbortSignal) => Promise<unknown>,
          ) => ({
            acquired: true as const,
            value: await operation(new AbortController().signal),
          }),
        ),
      },
      pluginHookSessionOwnership: {
        latest: vitest.fn(async () => ({
          ownershipClaimId: "owner-turn-1",
          turnId: "turn-owner",
          claimedAtMs: 100,
        })),
        tryClaimSessionEnd: vitest.fn(async () => ({
          status: "claimed" as const,
        })),
        completeSessionEnd: vitest.fn(async () => true),
      },
      inspection: {
        activeTurnId: vitest.fn(),
        activeTurn: vitest.fn(async () => undefined),
        latestTurnActivity: vitest.fn(async () => undefined),
      },
      queueSteer: { pause: vitest.fn() },
      maintenance: {
        tryAcquireSessionMaintenance: vitest.fn(),
        renewSessionMaintenance: vitest.fn(),
        releaseSessionMaintenance: vitest.fn(),
      },
      receipts: { findReceipt: vitest.fn() },
      ready: vitest.fn(async () => {
        events.push("turn:ready");
      }),
      close: vitest.fn(async () => {
        events.push("turn:close");
      }),
    },
  };
}

const mocked = vi.hoisted(() => {
  const events: string[] = [];
  return {
    events,
    cronOptions: undefined as Record<string, unknown> | undefined,
    channelOptions: undefined as Record<string, unknown> | undefined,
    agentHostOptions: undefined as Record<string, unknown> | undefined,
    sessionTitleOptions: undefined as Record<string, unknown> | undefined,
    sessionOptions: undefined as Record<string, unknown> | undefined,
    sessionApplicationOptions: undefined as Record<string, unknown> | undefined,
    conversationApplicationOptions: undefined as
      | Record<string, unknown>
      | undefined,
    turnOptions: undefined as CapturedTurnOptions | undefined,
    initializedSessionApplicationSystem: {
      marker: "session-application-system",
      session: { lifecycle: { marker: "session-lifecycle" } },
    },
    applicationOptions: undefined as Record<string, unknown> | undefined,
    processLocalApplicationOptions: undefined as
      | Record<string, unknown>
      | undefined,
    conversationApplication: { marker: "conversation-application" },
    applicationFactOptions: undefined as Record<string, unknown> | undefined,
    runtimeRegion: "cn" as "cn" | "en",
    applicationFactPorts: {
      session: { handle: vi.fn() },
      queue: { handle: vi.fn() },
      archiveTitle: { observe: vi.fn() },
    },
    runtimeApplications: {
      marker: "runtime-applications",
      session: {
        lifecycle: { deleteSessionById: vi.fn(async () => undefined) },
        root: { replaceRootSessionWithResult: vi.fn() },
      },
    },
    processLocalApplication: { marker: "process-local-application" },
    service: { marker: "cron-service" },
    cleanupServices: [] as unknown[],
    defaultDelivery: { deliver: async () => ({ delivered: true as const }) },
    readyError: undefined as Error | undefined,
    closeError: undefined as Error | undefined,
    turnInitializationError: undefined as Error | undefined,
    conversationBindings: [] as unknown[],
    conversationShutdowns: [] as unknown[],
    conversationOptions: undefined as Record<string, unknown> | undefined,
    attachmentMaterializerOptions: undefined as
      | Record<string, unknown>
      | undefined,
    conversationService: { marker: "v1-conversation-compatibility" },
    attachmentMaterializer: { materialize: vi.fn() },
    questionnaireActionBindings: [] as unknown[],
    questionnaireService: {
      beginOwned: vi.fn(),
      reconcileOwnedActions: vi.fn(async (dispatch: boolean) => {
        events.push(`questionnaire:plan-reconcile:${String(dispatch)}`);
        return 0;
      }),
      recoverOnStartup: vi.fn(async () => {
        events.push("questionnaire:recover");
        return { expired: 0, reinjected: 0, reemitted: 0 };
      }),
    },
    v1Submission: { submit: vi.fn() },
    sessionTitleModel: { summarize: vi.fn() },
    archiveTitleOptions: undefined as Record<string, unknown> | undefined,
    agentPreparationOptions: undefined as Record<string, unknown> | undefined,
    agentPreparation: {
      marker: "shared-agent-preparation",
      bindSessionModelRepair: vi.fn(),
      bindTaskSessionBindings: vi.fn(),
    },
    createSessionModelRepair: vi.fn(() => ({ repairSessionModel: vi.fn() })),
    agentService: createAgentServiceMock(vi),
    agentRuntimeLifecycle: { disposeSession: vi.fn(async () => undefined) },
    channelSystem: {
      terminalReplies: { observeRuntimeEvent: vi.fn() },
      turnLifecycle: { beforeExecution: vi.fn(), end: vi.fn() },
    },
    ...createSessionAndTurnSystemMocks(vi, events),
    plugin: { marker: "plugin-service" },
    hostConnectorGateway: { marker: "host-connector-gateway" },
    mcp: {
      marker: "mcp-service",
      disposeSession: vi.fn(async () => undefined),
    },
    mcpSettings: { marker: "mcp-settings-service" },
    skill: { marker: "skill-service" },
    runtimeSkillApplication: {
      listRuntimeSkills: vi.fn(),
      setSkillEnabled: vi.fn(),
    },
    pluginTurnCapabilities: undefined as unknown,
    pluginHookSessionEndFence: undefined as
      | { run(input: Record<string, unknown>): Promise<unknown> }
      | undefined,
    hostPluginHookSessionOwnership: undefined as unknown,
    miniAppOptions: undefined as Record<string, unknown> | undefined,
    materializeMiniAppRuntimePackage: vi.fn(async () => undefined),
    miniAppSupervisor: {
      ready: vi.fn(async () => {
        events.push("miniapp:ready");
      }),
      close: vi.fn(async () => {
        events.push("miniapp:close");
      }),
    },
    modelConfig: {
      provider: {},
      dataDir: "/data",
      custom_provider: { "openai-work": {} },
    },
  };
});

const localAgentService = mocked.agentService as unknown as LocalAgentService;

vi.mock("./service/cron/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./service/cron/index.js")>();
  return {
    ...actual,
    createHostCronSessionCreation: (host: unknown) => ({
      create: vi.fn(),
      host,
    }),
    initializeCronService: (options: Record<string, unknown>) => {
      mocked.events.push("cron:create");
      mocked.cronOptions = options;
      return {
        service: mocked.service,
        ready: async () => {
          mocked.events.push("cron:ready");
          if (mocked.readyError) throw mocked.readyError;
        },
        close: async () => {
          mocked.events.push("cron:close");
          if (mocked.closeError) throw mocked.closeError;
        },
      };
    },
  };
});

vi.mock("./service/channel-system/index.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./service/channel-system/index.js")
  >()),
  initializeOptionalChannelSystem: (
    enabled: boolean,
    options: Record<string, unknown>,
  ) => {
    if (!enabled) return undefined;
    mocked.events.push("channel:create");
    mocked.channelOptions = options;
    return mocked.channelSystem;
  },
}));
vi.mock("./service/plugin-system/index.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./service/plugin-system/index.js")
  >()),
  initializePluginService: (
    options: Record<string, unknown>,
    turnCapabilities: unknown,
  ) => {
    mocked.events.push("plugin:create");
    mocked.pluginTurnCapabilities = turnCapabilities;
    return {
      plugin: mocked.plugin,
      mcp: mocked.mcp,
      skill: mocked.skill,
      hostConnectorGateway: mocked.hostConnectorGateway,
      attachMiniAppPublication: () =>
        mocked.events.push("plugin:attach-miniapp"),
      restartMiniApp: async () => mocked.events.push("plugin:restart-miniapp"),
      verifyMiniAppCandidate: async () => true,
      materializeMiniAppRuntimePackage: mocked.materializeMiniAppRuntimePackage,
      listAvailableMiniApps: async () => [],
      listAcceptedMiniApps: () => [],
      isAcceptedMiniAppRunning: () => false,
      publishWorkspaceMiniApp: async () => undefined as never,
      initializeWorkspaceMiniApp: async () => undefined as never,
      activateMiniApp: async () => undefined,
      stopMiniApp: async () => undefined,
      authContextChanged: () =>
        mocked.events.push("plugin:auth-context-changed"),
      enabledHookPluginNames: () => new Set<string>(),
      ready: async () => mocked.events.push("plugin:ready"),
      close: async () => mocked.events.push("plugin:close"),
      options,
    };
  },
}));

vi.mock("./service/mcp/index.js", () => ({
  initializeMcpService: (options: Record<string, unknown>) => {
    mocked.events.push("mcp:create");
    return {
      service: mocked.mcpSettings,
      runtime: mocked.mcp,
      public: mocked.mcp,
      ready: async () => mocked.events.push("mcp:ready"),
      close: async () => mocked.events.push("mcp:close"),
      options,
    };
  },
}));

vi.mock("./service/miniapp/initialize.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./service/miniapp/initialize.js")>();
  return {
    ...actual,
    initializeMiniAppSupervisor: (options: Record<string, unknown>) => {
      mocked.events.push("miniapp:create");
      mocked.miniAppOptions = options;
      return mocked.miniAppSupervisor;
    },
  };
});

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

vi.mock("./service/session-system/index.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./service/session-system/index.js")>();
  return {
    isCurrentSessionAgentDefinition: actual.isCurrentSessionAgentDefinition,
    isTaskSession: actual.isTaskSession,
    ComposerSendBehaviorPreference: actual.ComposerSendBehaviorPreference,
    retryUserMessageCommit: <T>(operation: () => Promise<T>) => operation(),
    createCanonicalRecoveryLoggerAdapter:
      (logger: {
        info(fields: Record<string, unknown>, message: string): void;
      }) =>
      (event: Record<string, unknown>) =>
        logger.info(
          { ...event },
          "[local-runtime-v2] legacy Session canonical recovery",
        ),
    initializeSessionSystem: (options: Record<string, unknown>) => {
      mocked.events.push("session:create");
      mocked.sessionOptions = options;
      return mocked.sessionSystem;
    },
    initializeSessionApplicationSystem: (options: Record<string, unknown>) => {
      mocked.events.push("session-applications:create");
      mocked.sessionApplicationOptions = options;
      return mocked.initializedSessionApplicationSystem;
    },
  };
});

vi.mock("@mavis/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mavis/config")>()),
  allowsManagedMinimaxProviderOverride: () => false,
  getRuntimeRegion: () => mocked.runtimeRegion,
}));

vi.mock("./service/model-system/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service/model-system/index.js")>()),
  createLocalModelSystemConfigPort: () => ({
    read: () => mocked.modelConfig,
    updateByok: vi.fn(async () => undefined),
    compareAndSetModelContext: vi.fn(async () => true),
    setDefaultModel: vi.fn(async () => undefined),
    removeProvider: vi.fn(async () => undefined),
  }),
}));

vi.mock("./application/session/fact-ports.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./application/session/fact-ports.js")
  >()),
  createApplicationFactPorts: (options: Record<string, unknown>) => {
    mocked.applicationFactOptions = options;
    return mocked.applicationFactPorts;
  },
}));

vi.mock("./application/index.js", async (importOriginal) => {
  class TestAgentApplication {
    constructor(
      private readonly options: { service: typeof mocked.agentService },
    ) {}

    ensureBuiltinDefinitionsForPhase2() {
      mocked.events.push("agent:ensure");
      return this.options.service
        .ensureBuiltinRows()
        .then(() => this.options.service.list());
    }

    materializeLegacyCustomAgents() {
      return Promise.resolve({
        materialized: 0,
        alreadyCanonical: 0,
        notLegacy: 0,
      });
    }

    close() {
      this.options.service.close();
    }

    notifyGreetingTurnTerminal = vi.fn(async () => undefined);

    resolveAgentWriteTarget(requestRef: string) {
      return this.options.service.resolveAgentWriteTarget(requestRef);
    }
  }

  return {
    ...(await importOriginal<typeof import("./application/index.js")>()),
    AgentApplication: TestAgentApplication,
    createRuntimeAgentApplication: (input: {
      agentService: typeof mocked.agentService;
    }) => new TestAgentApplication({ service: input.agentService }),
    createAgentSessionPorts: () => ({
      directory: { get: vi.fn() },
      clearRootSession: vi.fn(async () => true),
      roots: { get: vi.fn(), setRootSession: vi.fn() },
      resolveWriteTarget: vi.fn(async (requestRef: string) => requestRef),
    }),
    initializeApplications: (options: Record<string, unknown>) => {
      mocked.events.push("applications:create");
      mocked.applicationOptions = options;
      return mocked.runtimeApplications;
    },
    createProcessLocalApplication: (options: Record<string, unknown>) => {
      mocked.processLocalApplicationOptions = options;
      return mocked.processLocalApplication;
    },
    createRuntimeSkillApplication: () => mocked.runtimeSkillApplication,
  };
});

vi.mock("./application/conversation/index.js", async (importOriginal) => {
  const original =
    await importOriginal<
      typeof import("./application/conversation/index.js")
    >();
  return {
    ...original,
    createQueryCollapseKeyResolver: (options: Record<string, unknown>) => {
      queryCollapseMocked.keyResolverOptions = options;
      return queryCollapseMocked.keys;
    },
    UserMessageTurnDeliveryService: class extends original.UserMessageTurnDeliveryService {
      constructor(
        options: ConstructorParameters<
          typeof original.UserMessageTurnDeliveryService
        >[0],
      ) {
        queryCollapseMocked.deliveryOptions = options as unknown as Record<
          string,
          unknown
        >;
        super(options);
      }
    },
    createConversationApplication: (options: Record<string, unknown>) => {
      mocked.conversationApplicationOptions = options;
      return mocked.conversationApplication;
    },
  };
});

vi.mock("./service/turn-system/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./service/turn-system/index.js")>()),
  AgentHostTurnCapabilityLifecycle: class AgentHostTurnCapabilityLifecycle {},
  composeTurnAdmissionPolicies: (...policies: unknown[]) => ({ policies }),
  configureLocalPluginHookEnabledResolver: vi.fn(),
  configureLocalPluginHookSessionEndFence: vi.fn((fence: unknown) => {
    mocked.pluginHookSessionEndFence =
      fence as typeof mocked.pluginHookSessionEndFence;
  }),
  configureLocalPluginHookObservability: vi.fn(),
  deactivateLocalPluginHooks: vi.fn(),
  disposeLocalPluginHookSessions: vi.fn(),
  endAllLocalPluginHookSessionsForLogout: vi.fn(async () => undefined),
  endLocalPluginHookSession: vi.fn(async () => undefined),
  isUserSteeringProducer: (producerId: string) =>
    producerId === "queue-immediate-send" ||
    producerId === "composer-steer" ||
    producerId === "paused-queue-composer",
  requireAgentRuntime,
  requireTurnSystem,
  resolveAgentPromptSurface,
  composeTurnSubmissionPreparations: (...candidates: unknown[]) =>
    candidates.find((candidate) => candidate !== undefined),
  createGoalTurnSubmissionPreparation: (input: {
    prepare?: (candidate: Record<string, unknown>) => unknown;
    hasPendingPlan: (sessionId: string) => unknown;
    hasPriorityMailboxWork: (sessionId: string) => unknown;
  }) =>
    input.prepare
      ? {
          prepare: (candidate: Record<string, unknown>) =>
            input.prepare?.({
              ...candidate,
              hasPendingPlan: input.hasPendingPlan,
              hasPriorityMailboxWork: input.hasPriorityMailboxWork,
            }),
        }
      : undefined,
  hasPriorityUserQueueItem: (items: readonly { readonly source: string }[]) =>
    items.some(
      ({ source }) =>
        source === "api" ||
        source === "questionnaire" ||
        source === "communication" ||
        source === "code_review" ||
        source.startsWith("channel:"),
    ),
  initializeTurnSystem: async (options: {
    disposeRuntimeSession?: InitializeTurnSystemOptions["disposeRuntimeSession"];
    processStartedAtMs: number;
    classifyQueuedItem?: QueueClassifier;
    shouldYieldFifoPosition?: QueueFifoYieldPolicy;
    resumeSessionDeletion?: InitializeTurnSystemOptions["resumeSessionDeletion"];
    turnSettlement?: InitializeTurnSystemOptions["turnSettlement"];
    createHost(input: {
      turnControl: unknown;
      turnFacts: unknown;
      pluginHookSessionOwnership: unknown;
    }): Promise<unknown>;
  }) => {
    mocked.events.push("turn:create");
    if (mocked.turnInitializationError) throw mocked.turnInitializationError;
    mocked.turnOptions = {
      disposeRuntimeSession: options.disposeRuntimeSession,
      processStartedAtMs: options.processStartedAtMs,
      ...(options.classifyQueuedItem
        ? { classifyQueuedItem: options.classifyQueuedItem }
        : {}),
      ...(options.shouldYieldFifoPosition
        ? { shouldYieldFifoPosition: options.shouldYieldFifoPosition }
        : {}),
      ...(options.resumeSessionDeletion
        ? { resumeSessionDeletion: options.resumeSessionDeletion }
        : {}),
      ...(options.turnSettlement
        ? { turnSettlement: options.turnSettlement }
        : {}),
    };
    const pluginHookSessionOwnership = {
      prepare: vi.fn(async () => undefined),
      activate: vi.fn(async () => undefined),
    };
    mocked.hostPluginHookSessionOwnership = pluginHookSessionOwnership;
    await options.createHost({
      turnControl: {},
      turnFacts: {},
      pluginHookSessionOwnership,
    });
    return mocked.turnSystem;
  },
  createProductionAgentPreparation: vi.fn(
    (options: Record<string, unknown>) => {
      mocked.agentPreparationOptions = options;
      return mocked.agentPreparation;
    },
  ),
  createSessionModelRepair: mocked.createSessionModelRepair,
  combineAgentEventObservers: vi.fn((...observers: unknown[]) => ({
    observers,
  })),
  createSessionLLMRetryEventObserver:
    (publish: (event: GlobalEventInput<"session.llm_retry">) => void) =>
    (event: LLMRetryEvent) => {
      if (event.scope === "title") return;
      publish({
        type: "session.llm_retry",
        payload: { schemaVersion: 1, ...event },
      });
    },
  createLocalAgentHost: vi.fn(async (options: Record<string, unknown>) => {
    mocked.agentHostOptions = options;
    return {
      host: {},
      lifecycle: mocked.agentRuntimeLifecycle,
    };
  }),
  createProductionSessionTitleModel: vi.fn(
    (options: Record<string, unknown>) => {
      mocked.sessionTitleOptions = options;
      return mocked.sessionTitleModel;
    },
  ),
  createProductionRootArchiveTitleModel: vi.fn(
    (options: Record<string, unknown>) => {
      mocked.archiveTitleOptions = options;
      return {
        summarize: vi.fn(async () => null),
      };
    },
  ),
}));

vi.mock("./application/session/fact-ports.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./application/session/fact-ports.js")
  >()),
  createApplicationFactPorts: (options: Record<string, unknown>) => {
    mocked.applicationFactOptions = options;
    return mocked.applicationFactPorts;
  },
}));

// The composition root now assembles the v1 Conversation surface through the
// real `composeV1Conversation`, so the leaf factories are what gets stubbed —
// the assertions below still observe exactly what that composition hands over.
vi.mock("./service/v1-conversation-compat/attachments/index.js", () => ({
  createV1ConversationAttachmentMaterializer: vi.fn(
    (options: Record<string, unknown>) => {
      mocked.attachmentMaterializerOptions = options;
      return mocked.attachmentMaterializer;
    },
  ),
}));
vi.mock(
  "./service/v1-conversation-compat/v1-compatible-turn-submission.service.js",
  () => ({
    createV1CompatibleTurnSubmission: vi.fn(() => mocked.v1Submission),
  }),
);
vi.mock("./service/v1-conversation-compat/initialize.js", () => ({
  createV1ConversationCompatibility: vi.fn(
    (options: Record<string, unknown>) => {
      mocked.conversationOptions = options;
      return mocked.conversationService;
    },
  ),
}));

afterEach(() => vi.unstubAllEnvs());

beforeEach(() => {
  mocked.agentRuntimeLifecycle.disposeSession.mockReset();
  mocked.mcp.disposeSession.mockClear();
  mocked.events.length = 0;
  mocked.cronOptions = undefined;
  mocked.channelOptions = undefined;
  mocked.agentHostOptions = undefined;
  mocked.sessionTitleOptions = undefined;
  mocked.sessionOptions = undefined;
  mocked.sessionApplicationOptions = undefined;
  mocked.conversationApplicationOptions = undefined;
  mocked.turnOptions = undefined;
  queryCollapseMocked.keyResolverOptions = undefined;
  queryCollapseMocked.deliveryOptions = undefined;
  queryCollapseMocked.keys.queryKeyForTurn.mockClear();
  queryCollapseMocked.keys.queryKeyForContinuation.mockClear();
  mocked.applicationOptions = undefined;
  mocked.processLocalApplicationOptions = undefined;
  mocked.applicationFactOptions = undefined;
  mocked.runtimeRegion = "cn";
  mocked.archiveTitleOptions = undefined;
  mocked.agentPreparationOptions = undefined;
  mocked.createSessionModelRepair.mockClear();
  mocked.agentPreparation.bindSessionModelRepair.mockClear();
  mocked.agentPreparation.bindTaskSessionBindings.mockClear();
  mocked.readyError = undefined;
  mocked.closeError = undefined;
  mocked.turnInitializationError = undefined;
  mocked.cleanupServices.length = 0;
  mocked.pluginTurnCapabilities = undefined;
  mocked.pluginHookSessionEndFence = undefined;
  mocked.hostPluginHookSessionOwnership = undefined;
  mocked.miniAppOptions = undefined;
  mocked.materializeMiniAppRuntimePackage.mockClear();
  mocked.miniAppSupervisor.ready.mockClear();
  mocked.miniAppSupervisor.close.mockClear();
  mocked.conversationBindings.length = 0;
  mocked.conversationShutdowns.length = 0;
  mocked.conversationOptions = undefined;
  mocked.agentService.ensureBuiltinRows.mockClear();
  mocked.agentService.bindBuiltinModelGroupResolver.mockClear();
  mocked.agentService.bindPromptConfig.mockClear();
  mocked.agentService.bindConfigPreviewDiagnostics.mockClear();
  mocked.agentService.bindEffectiveConfigResolver.mockClear();
  mocked.agentService.bindCandidateModelValidator.mockClear();
  mocked.agentService.list.mockClear();
  mocked.agentService.close.mockClear();
  mocked.agentService.renderProfile.mockReset();
  mocked.agentService.renderProfile.mockResolvedValue(undefined as never);
  mocked.agentService.getPersistedOwner.mockReset();
  mocked.agentService.getPersistedOwner.mockResolvedValue(undefined);
  mocked.agentService.resolvePrimaryExecutionIdentity.mockReset();
  mocked.agentService.resolvePrimaryExecutionIdentity.mockResolvedValue(
    undefined,
  );
  mocked.attachmentMaterializerOptions = undefined;
  mocked.questionnaireActionBindings.length = 0;
  mocked.turnSystem.turns.steer.mockReset();
  mocked.turnSystem.turns.steer.mockResolvedValue({
    delivered: true,
    mode: "activated",
    turnId: "turn-1",
  });
  mocked.turnSystem.sessionLifecycle.tryRunExclusive?.mockReset();
  mocked.turnSystem.sessionLifecycle.tryRunExclusive?.mockImplementation(
    async (
      _sessionId: string,
      operation: (signal?: AbortSignal) => Promise<unknown>,
    ) => ({
      acquired: true as const,
      value: await operation(new AbortController().signal),
    }),
  );
  mocked.turnSystem.pluginHookSessionOwnership.tryClaimSessionEnd.mockReset();
  mocked.turnSystem.pluginHookSessionOwnership.tryClaimSessionEnd.mockResolvedValue(
    {
      status: "claimed",
    },
  );
  mocked.turnSystem.pluginHookSessionOwnership.completeSessionEnd.mockReset();
  mocked.turnSystem.pluginHookSessionOwnership.completeSessionEnd.mockResolvedValue(
    true,
  );
  mocked.turnSystem.pluginHookSessionOwnership.latest.mockReset();
  mocked.turnSystem.pluginHookSessionOwnership.latest.mockResolvedValue({
    ownershipClaimId: "owner-turn-1",
    turnId: "turn-owner",
    claimedAtMs: 100,
  });
  mocked.turnSystem.inspection.latestTurnActivity.mockReset();
  mocked.turnSystem.inspection.latestTurnActivity.mockResolvedValue(undefined);
  mocked.sessionSystem.canonicalHistory.inspectActive.mockReset();
  mocked.sessionSystem.messages.repository.get.mockReset();
  mocked.sessionSystem.messages.repository.listTurn.mockReset();
  mocked.sessionSystem.sessions.repository.get.mockReset();
  mocked.sessionSystem.titles.generate.mockReset();
  mocked.sessionSystem.messages.userMessages.commit.mockClear();
  mocked.sessionSystem.stream.write.mockClear();
  mocked.runtimeApplications.session.lifecycle.deleteSessionById.mockClear();
  mocked.sessionSystem.queryCollapse.state.start.mockClear();
  mocked.sessionSystem.queryCollapse.state.finish.mockClear();
  mocked.sessionSystem.queryCollapse.state.findByCurrentTurn.mockClear();
  mocked.sessionSystem.queryCollapse.state.findProcessingByCurrentTurn.mockClear();
  mocked.sessionSystem.queryCollapse.state.findByKey.mockClear();
});

type InputReviewResolved = (input: {
  readonly sessionId: string;
  readonly turnId: string;
  readonly userInput: string;
  readonly rejected: boolean;
}) => void;

async function assertInputReviewTitlePolicy(
  reportFailure: NonNullable<
    V1ServiceCompatibility["agentHost"]["executor"]["reportFailure"]
  >,
): Promise<void> {
  mocked.sessionSystem.messages.repository.listTurn.mockResolvedValue([
    { msg_id: "message-safe", role: "user", msg_content: "Ship the objective" },
  ]);
  const onInputReviewResolved = mocked.agentHostOptions?.[
    "onInputReviewResolved"
  ] as InputReviewResolved;
  onInputReviewResolved({
    sessionId: "session-1",
    turnId: "turn-safe",
    userInput: "<internal-goal-prompt />",
    rejected: false,
  });
  onInputReviewResolved({
    sessionId: "session-1",
    turnId: "turn-blocked",
    userInput: "blocked input",
    rejected: true,
  });
  await vi.waitFor(() =>
    expect(mocked.sessionSystem.titles.generate).toHaveBeenCalledOnce(),
  );
  expect(
    mocked.sessionSystem.messages.repository.listTurn,
  ).toHaveBeenCalledOnce();
  expect(
    mocked.sessionSystem.messages.repository.listTurn,
  ).toHaveBeenCalledWith("session-1", "turn-safe");
  expect(mocked.sessionSystem.titles.generate).toHaveBeenCalledWith(
    "session-1",
    "Ship the objective",
  );

  mocked.sessionSystem.messages.repository.listTurn.mockRejectedValueOnce(
    new Error("message read unavailable"),
  );
  onInputReviewResolved({
    sessionId: "session-1",
    turnId: "turn-read-failed",
    userInput: "approved input",
    rejected: false,
  });
  await vi.waitFor(() =>
    expect(reportFailure).toHaveBeenCalledWith(
      "session-1",
      "session_title_source_resolution_failed:message read unavailable",
    ),
  );
  expect(mocked.sessionSystem.titles.generate).toHaveBeenCalledOnce();
}

async function assertSessionCompositionPolicies(input: {
  readonly compatibility: V1ServiceCompatibility;
  readonly metricsCounter: ReturnType<typeof vi.fn>;
  readonly projectedEvents: readonly GlobalEvent[];
}): Promise<void> {
  const reportFailure = input.compatibility.agentHost.executor.reportFailure;
  if (!reportFailure)
    throw new Error("test compatibility requires failure reporting");
  await assertInputReviewTitlePolicy(reportFailure);
  const titlePolicy = mocked.sessionOptions?.["titlePolicy"] as {
    blocks(title: string): Promise<boolean>;
  };
  await expect(titlePolicy.blocks("generated title")).resolves.toBe(false);
  expect(input.compatibility.safety.review).toHaveBeenCalledWith(
    "generated title",
    205,
  );
  const title = mocked.sessionOptions?.["title"] as {
    readonly onOutcome: (outcome: string) => void;
    readonly onFailure: (input: {
      readonly stage: string;
      readonly sessionId: string;
      readonly error: unknown;
    }) => void;
  };
  title.onOutcome("success");
  const warn = vi.spyOn(noopLogger, "warn");
  title.onFailure({
    stage: "model",
    sessionId: "session-1",
    error: new Error("provider failed"),
  });
  expect(input.metricsCounter).toHaveBeenCalledWith(
    "session_title_generation_total",
    1,
    {
      outcome: "success",
    },
  );
  // A title helper failure is a Session-scoped diagnostic; it must not enter the
  // runtime turn failure channel that surfaces as a generic model-service error.
  expect(warn).toHaveBeenCalledWith(
    {
      sessionId: "session-1",
      stage: "model",
      reason: "session_title_model_failed:provider failed",
    },
    "session title generation failed",
  );
  expect(
    input.compatibility.agentHost.executor.reportFailure,
  ).not.toHaveBeenCalledWith(
    "session-1",
    expect.stringContaining("session_title_model_failed"),
  );
  warn.mockRestore();
  assertCompactionFacts(input.projectedEvents);
}

function assertCompactionFacts(projectedEvents: readonly GlobalEvent[]): void {
  const compactionFacts = mocked.sessionOptions?.["compactionFacts"] as {
    readonly handle: (fact: Record<string, unknown>) => void;
  };
  expect(
    compactionFacts.handle({
      kind: "started",
      sessionId: "session-1",
      attemptId: "attempt-1",
    }),
  ).toBeUndefined();
  expect(
    compactionFacts.handle({
      kind: "completed",
      sessionId: "session-1",
      attemptId: "attempt-1",
      messagesBefore: 10,
      messagesAfter: 2,
      tokensBefore: 1_000,
      tokensAfter: 200,
    }),
  ).toBeUndefined();
  expect(
    compactionFacts.handle({
      kind: "failed",
      sessionId: "session-2",
      attemptId: "attempt-2",
    }),
  ).toBeUndefined();
  expect(projectedEvents).toEqual([
    {
      type: "session.compaction.started",
      timestamp: 1_700_000_000_000,
      source: "local-runtime",
      payload: { sessionId: "session-1", compactionId: "attempt-1" },
    },
    {
      type: "session.compaction.completed",
      timestamp: 1_700_000_000_000,
      source: "local-runtime",
      payload: {
        sessionId: "session-1",
        compactionId: "attempt-1",
        messagesBefore: 10,
        messagesAfter: 2,
        tokensBefore: 1_000,
        tokensAfter: 200,
      },
    },
    {
      type: "session.compaction.failed",
      timestamp: 1_700_000_000_000,
      source: "local-runtime",
      payload: { sessionId: "session-2", compactionId: "attempt-2" },
    },
  ]);
}

async function assertMiniAppStartupFailureCleanup(): Promise<void> {
  const failure = new Error("turn initialization failed");
  mocked.turnInitializationError = failure;

  await expect(
    createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility: defaultCompatibility(),
      agentService: localAgentService,
      runtimeOwnerKind: "electron",
      promptConfigKey: new Uint8Array(32).fill(7),
    }),
  ).rejects.toBe(failure);

  expect(mocked.events).toContain("miniapp:create");
  expect(mocked.events.filter((event) => event.endsWith(":close"))).toEqual([
    "plugin:close",
    "mcp:close",
    "session:close",
    "miniapp:close",
  ]);
}

async function assertGoalQueueReadsPlanFence(): Promise<void> {
  const compatibility = defaultCompatibility();
  const getPending = vi.fn(async () => undefined as never);
  const classifyGoalItem = vi.mocked(
    compatibility.sessionV2.goals.classifyQueuedItem,
  );
  const planFenceReads: string[] = [];
  const services = await createRuntimeServices({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => ({ get: () => undefined }) }),
        }),
      }),
    } as unknown as AppDb,
    dataDir: "/data",
    scheduler: {} as SchedulerClient,
    eventBus: new EventBus<GlobalEvent>(),
    compatibility: {
      ...compatibility,
      peripherals: { questionnaires: { getPending } } as never,
    },
    agentService: localAgentService,
  });
  const classifier = mocked.turnOptions?.classifyQueuedItem;
  if (!classifier)
    throw new Error("Turn System queue classifier was not composed");
  const item = {
    itemId: "goal-queue-1",
    sessionId: "session-1",
    agentName: "mavis",
    source: "thread-goal" as const,
    status: "queued" as const,
    clientRequestId: "thread-goal-followup:turn-1",
    message: { content: "continue goal", attachments: [] },
    createdAt: 1,
  };
  classifyGoalItem.mockImplementation(async (_item, hasPendingPlan) => {
    if (hasPendingPlan)
      planFenceReads.push(await hasPendingPlan("session-1").then(String));
    return "ready" as const;
  });

  await expect(classifier(item)).resolves.toBe("ready");

  // The Plan fence reader is handed to Goal selection so a Plan-blocked Goal can
  // name `plan` as its wait reason. It is an addition, not a replacement: the
  // shared questionnaire precheck and the outer Plan fence both still run for
  // Goal items, so nothing (budget-limit continuations included) can be admitted
  // by skipping them.
  expect(getPending).toHaveBeenCalledWith({
    agentName: "mavis",
    sessionId: "session-1",
  });
  expect(classifyGoalItem).toHaveBeenCalledWith(item, expect.any(Function));
  expect(planFenceReads).toEqual(["false"]);
  await services.close();
}

async function assertGoalQueueYieldsToUserWork(): Promise<void> {
  const services = await createRuntimeServices({
    db: {} as AppDb,
    dataDir: "/data",
    scheduler: {} as SchedulerClient,
    eventBus: new EventBus<GlobalEvent>(),
    compatibility: defaultCompatibility(),
    agentService: localAgentService,
  });
  const yields = mocked.turnOptions?.shouldYieldFifoPosition;
  if (!yields) throw new Error("Queue FIFO yield policy was not composed");
  const list = vi.mocked(mocked.sessionSystem.queue.committed.list);
  const queueItem = (source: string) => ({
    itemId: `item-${source}`,
    sessionId: "session-1",
    agentName: "mavis",
    source,
    status: "queued" as const,
    message: { content: "queued", attachments: [] },
    createdAt: 1,
  });
  const goalItem = queueItem("thread-goal");
  const userItem = queueItem("api");

  list.mockResolvedValueOnce([queueItem("api")] as never);
  await expect(yields(goalItem as never)).resolves.toBe(true);
  // A queued questionnaire reply is user work too: it is what unblocks the very
  // gate the Goal is waiting on.
  list.mockResolvedValueOnce([queueItem("questionnaire")] as never);
  await expect(yields(goalItem as never)).resolves.toBe(true);
  // Autonomous work behind an autonomous head never preempts it.
  list.mockResolvedValueOnce([queueItem("thread-goal")] as never);
  await expect(yields(goalItem as never)).resolves.toBe(false);
  // Only the Goal source yields: an ordinary user item that a gate defers keeps
  // blocking the queue, so nothing bypasses the questionnaire gate.
  list.mockResolvedValueOnce([queueItem("api")] as never);
  await expect(yields(userItem as never)).resolves.toBe(false);
  expect(list).toHaveBeenCalledWith("session-1");
  await services.close();
}

async function assertAskUserGateDefersQueueClassification(): Promise<void> {
  const compatibility = defaultCompatibility();
  const getPending = vi
    .fn()
    .mockResolvedValueOnce({ id: "question-1" } as never)
    .mockResolvedValueOnce(undefined as never);
  const classifyGoalItem = vi.mocked(
    compatibility.sessionV2.goals.classifyQueuedItem,
  );
  const services = await createRuntimeServices({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => ({ get: () => undefined }) }),
        }),
      }),
    } as unknown as AppDb,
    dataDir: "/data",
    scheduler: {} as SchedulerClient,
    eventBus: new EventBus<GlobalEvent>(),
    compatibility: {
      ...compatibility,
      peripherals: { questionnaires: { getPending } } as never,
    },
    agentService: localAgentService,
  });
  const classifier = mocked.turnOptions?.classifyQueuedItem;
  if (!classifier)
    throw new Error("Turn System queue classifier was not composed");
  const item = {
    itemId: "queue-1",
    sessionId: "session-1",
    agentName: "mavis",
    source: "api" as const,
    status: "queued" as const,
    message: { content: "send after AskUser", attachments: [] },
    createdAt: 1,
  };

  await expect(classifier(item)).resolves.toBe("defer");

  expect(getPending).toHaveBeenCalledWith({
    agentName: "mavis",
    sessionId: "session-1",
  });
  expect(classifyGoalItem).not.toHaveBeenCalled();

  await expect(classifier(item)).resolves.toBe("ready");
  expect(classifyGoalItem).toHaveBeenCalledWith(item, expect.any(Function));
  await services.close();
}

async function assertQuestionnaireReplyBypassesAskUserGates(): Promise<void> {
  const compatibility = defaultCompatibility();
  const getPending = vi.fn(async () => ({ id: "question-1" }) as never);
  const classifyGoalItem = vi.mocked(
    compatibility.sessionV2.goals.classifyQueuedItem,
  );
  const services = await createRuntimeServices({
    db: {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => ({ get: () => undefined }) }),
        }),
      }),
    } as unknown as AppDb,
    dataDir: "/data",
    scheduler: {} as SchedulerClient,
    eventBus: new EventBus<GlobalEvent>(),
    compatibility: {
      ...compatibility,
      peripherals: { questionnaires: { getPending } } as never,
    },
    agentService: localAgentService,
  });
  const classifier = mocked.turnOptions?.classifyQueuedItem;
  if (!classifier)
    throw new Error("Turn System queue classifier was not composed");
  // The queued reply is the message that resolves the questionnaire the
  // gates wait on: even with a pending AskUser reported, it must dispatch.
  const item = {
    itemId: "queue-reply-1",
    sessionId: "session-1",
    agentName: "mavis",
    source: "questionnaire" as const,
    status: "queued" as const,
    message: {
      content: "<questionnaire-response />",
      attachments: [],
      origin: {
        kind: "questionnaire-response",
        requestId: "request-1",
        mode: "questionnaire",
        purpose: "ordinary",
      },
    },
    createdAt: 1,
  };

  await expect(classifier(item)).resolves.toBe("ready");

  expect(getPending).not.toHaveBeenCalled();
  expect(classifyGoalItem).not.toHaveBeenCalled();
  await services.close();
}

async function assertImportedSessionPinBinding(): Promise<void> {
  const raw = new Database(":memory:");
  const db = migratePluginTestDatabase(raw);
  const services = await createRuntimeServices({
    db,
    dataDir: "/data",
    scheduler: {} as SchedulerClient,
    eventBus: new EventBus<GlobalEvent>(),
    compatibility: defaultCompatibility(),
    agentService: localAgentService,
  });
  try {
    const onImported = mocked.sessionOptions?.["onPinnedSessionImported"] as
      | ((sessionId: string) => Promise<void>)
      | undefined;
    if (!onImported)
      throw new Error("Imported Session Pin callback was not composed");
    await onImported("recovered-session");
    expect(readPreferenceValue(db, "pinned-items-order")).toEqual([
      { type: "session", id: "recovered-session" },
    ]);
  } finally {
    await services.close();
    raw.close();
  }
}

async function assertCanonicalSessionRecoveryLogging(): Promise<void> {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  await createRuntimeServices({
    db: {} as AppDb,
    dataDir: "/data",
    logger,
    scheduler: {} as SchedulerClient,
    eventBus: new EventBus<GlobalEvent>(),
    compatibility: defaultCompatibility(),
    agentService: localAgentService,
  });
  const onCanonicalRecovery = (
    mocked.sessionOptions?.["legacyMigration"] as {
      readonly onCanonicalRecovery: (event: Record<string, unknown>) => void;
    }
  ).onCanonicalRecovery;
  const event = {
    session_id: "session-1",
    trigger: "source_missing",
    result: "recovered",
  };
  onCanonicalRecovery(event);
  expect(logger.info).toHaveBeenCalledWith(
    event,
    "[local-runtime-v2] legacy Session canonical recovery",
  );
}

describe("runtime services composition", () => {
  it.each([false, true])(
    "keeps source hooks and projection disabled for every build identity (internal=%s)",
    async (internal) => {
      vi.stubEnv("__MAVIS_BUILD_INTERNAL", String(internal));
      vi.stubEnv("__MAVIS_BUILD_INSIDE", "false");
      const services = await createRuntimeServices({
        db: {} as AppDb,
        dataDir: "/data",
        scheduler: {} as SchedulerClient,
        eventBus: new EventBus<GlobalEvent>(),
        compatibility: defaultCompatibility(),
        agentService: localAgentService,
        runtimeOwnerKind: "electron",
        promptConfigKey: new Uint8Array(32).fill(7),
      });
      const extensions = mocked.agentHostOptions?.[
        "normalExtensions"
      ] as readonly AgentExtension[];
      expect(extensions.some(({ id }) => id === "source-reference")).toBe(
        false,
      );
      expect(mocked.sessionOptions?.["sourceProjectionEnabled"]).toBe(false);
      await services.close();
    },
  );
  it(
    "assembles the owner graph and exposes a read-only global event facade",
    assertRuntimeServicesComposition,
  );

  it(
    "resolves workspace bash file sources",
    assertWorkspaceBashFileSourceResolution,
  );

  it(
    "binds imported Session Pin recovery before the service graph is returned",
    assertImportedSessionPinBinding,
  );

  it(
    "routes canonical Session recovery events through the runtime logger",
    assertCanonicalSessionRecoveryLogging,
  );

  it("owns an explicitly provided MiniApp Host capability without changing the default graph", async () => {
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility: defaultCompatibility(),
      agentService: localAgentService,
      miniApp: {},
    });

    expect(services.miniApp).toBe(mocked.miniAppSupervisor);
    assertProcessLocalMiniAppComposition();
    expect(mocked.miniAppOptions).toMatchObject({
      db: {},
      connectorGateway: mocked.hostConnectorGateway,
      verifyCandidate: expect.any(Function),
      materializePackage: expect.any(Function),
      resolvePluginDataDir: expect.any(Function),
    });
    expect(mocked.events).toContain("plugin:attach-miniapp");
    expect(mocked.events.indexOf("plugin:attach-miniapp")).toBeLessThan(
      mocked.events.indexOf("turn:create"),
    );
    expect(
      (
        mocked.agentHostOptions?.["normalExtensions"] as readonly {
          readonly id: string;
        }[]
      ).map(({ id }) => id),
    ).toContain("miniapp-control");
    expect(
      (
        mocked.agentHostOptions?.["product"] as {
          readonly preparation: {
            readonly configBuilder: { readonly miniappAvailable: boolean };
          };
        }
      ).preparation.configBuilder.miniappAvailable,
    ).toBe(true);
    const materializePackage = mocked.miniAppOptions?.[
      "materializePackage"
    ] as (input: {
      readonly sourceRoot: string;
      readonly targetRoot: string;
    }) => Promise<void>;
    await materializePackage({
      sourceRoot: "/workspace",
      targetRoot: "/runtime",
    });
    expect(mocked.materializeMiniAppRuntimePackage).toHaveBeenCalledWith({
      sourceRoot: "/workspace",
      targetRoot: "/runtime",
    });

    mocked.events.length = 0;
    await services.ready();
    expect(mocked.miniAppSupervisor.ready).toHaveBeenCalledOnce();
    expect(mocked.events.indexOf("miniapp:ready")).toBeGreaterThan(
      mocked.events.indexOf("plugin:ready"),
    );

    mocked.events.length = 0;
    await services.close();
    expect(mocked.events).toContain("plugin:close");
    expect(mocked.events).toContain("session:close");
    expect(mocked.events.indexOf("miniapp:close")).toBeGreaterThan(
      mocked.events.indexOf("plugin:close"),
    );
    expect(mocked.events.indexOf("miniapp:close")).toBeGreaterThan(
      mocked.events.indexOf("session:close"),
    );
  });

  it(
    "preserves startup failure while draining PluginSystem before the Electron Supervisor",
    assertMiniAppStartupFailureCleanup,
  );

  it(
    "defers queue classification during AskUser and resumes it once clear",
    assertAskUserGateDefersQueueClassification,
  );

  it(
    "admits a queued questionnaire reply without consulting the AskUser gates",
    assertQuestionnaireReplyBypassesAskUserGates,
  );

  it("generates a session title when sessionTitle.enabled is true (default)", async () => {
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility: defaultCompatibility(),
      agentService: localAgentService,
    });
    mocked.sessionSystem.messages.repository.listTurn.mockResolvedValue([
      { msg_id: "m1", role: "user", msg_content: "Ship the objective" },
    ]);
    const onInputReviewResolved = mocked.agentHostOptions?.[
      "onInputReviewResolved"
    ] as InputReviewResolved;
    onInputReviewResolved({
      sessionId: "session-1",
      turnId: "turn-1",
      userInput: "approved input",
      rejected: false,
    });
    await vi.waitFor(() =>
      expect(mocked.sessionSystem.titles.generate).toHaveBeenCalledOnce(),
    );
    await services.close();
  });

  it("wires a no-op title handler when the injected sessionTitle.enabled is false", async () => {
    (
      mocked.modelConfig as { sessionTitle?: { enabled: boolean } }
    ).sessionTitle = {
      enabled: false,
    };
    try {
      const services = await createRuntimeServices({
        db: {} as AppDb,
        dataDir: "/data",
        scheduler: {} as SchedulerClient,
        eventBus: new EventBus<GlobalEvent>(),
        compatibility: defaultCompatibility(),
        agentService: localAgentService,
      });
      mocked.sessionSystem.messages.repository.listTurn.mockResolvedValue([
        { msg_id: "m1", role: "user", msg_content: "Ship the objective" },
      ]);
      const onInputReviewResolved = mocked.agentHostOptions?.[
        "onInputReviewResolved"
      ] as InputReviewResolved;
      onInputReviewResolved({
        sessionId: "session-1",
        turnId: "turn-1",
        userInput: "approved input",
        rejected: false,
      });
      // No-op handler: the title model request and the message read must never fire.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(mocked.sessionSystem.titles.generate).not.toHaveBeenCalled();
      expect(
        mocked.sessionSystem.messages.repository.listTurn,
      ).not.toHaveBeenCalled();
      await services.close();
    } finally {
      delete (mocked.modelConfig as { sessionTitle?: { enabled: boolean } })
        .sessionTitle;
    }
  });
});

describe("runtime services Goal queue composition", () => {
  it(
    "hands the Plan fence reader to Goal queue classification without replacing the shared gates",
    assertGoalQueueReadsPlanFence,
  );

  it(
    "lets a blocked Goal item yield the FIFO head to queued user work only",
    assertGoalQueueYieldsToUserWork,
  );
});

async function assertRuntimeServicesComposition() {
  const db = {} as AppDb;
  const scheduler = {} as SchedulerClient;
  const metrics = { counter: vi.fn(), histogram: vi.fn() };
  const eventBus = new EventBus<GlobalEvent>();
  const compatibility = defaultCompatibility();
  const nowMs = () => 1_700_000_000_000;
  const services = await createRuntimeServices({
    db,
    dataDir: "/data",
    logger: noopLogger,
    scheduler,
    metrics,
    eventBus,
    compatibility,
    agentService: localAgentService,
    nowMs,
  });
  const projectedEvents: GlobalEvent[] = [];
  services.globalEvents.subscribe({
    next: (event) => projectedEvents.push(event),
  });

  expect(mocked.events).toEqual([
    "session:create",
    "channel:create",
    "mcp:create",
    "plugin:create",
    "turn:create",
    "session-applications:create",
    "applications:create",
    "cron:create",
  ]);
  expect(mocked.channelOptions).toEqual({
    messages: mocked.sessionSystem.messages.repository,
    sessions: mocked.sessionSystem.sessions.repository,
    product: compatibility.channel,
  });
  expect(mocked.agentHostOptions).toMatchObject({
    preparation: mocked.agentPreparation,
    sessions: mocked.sessionSystem,
    safety: services.safety,
    turnCapabilities: mocked.pluginTurnCapabilities,
    onInputReviewResolved: expect.any(Function),
    eventObserver: {
      observers: [
        mocked.channelSystem.terminalReplies,
        expect.objectContaining({ observeRuntimeEvent: expect.any(Function) }),
      ],
    },
  });
  expect(mocked.agentHostOptions).not.toHaveProperty("contentReviewEnabled");
  expect(mocked.agentHostOptions).not.toHaveProperty("tuiProductPolicy");
  expect(mocked.agentHostOptions).not.toHaveProperty("cliProductPolicy");
  const composedProduct = mocked.agentHostOptions?.["product"] as {
    readonly agents: { readonly getExecutionSnapshot: unknown };
    readonly preparation: {
      readonly configBuilder: {
        readonly nowMs?: () => number;
        readonly profile?: { readonly render: unknown };
      };
    };
  };
  expect(composedProduct).not.toBe(compatibility.agentHost);
  expect(composedProduct.agents.getExecutionSnapshot).toEqual(
    expect.any(Function),
  );
  expect(composedProduct.preparation.configBuilder.nowMs).toBe(nowMs);
  expect(composedProduct.preparation.configBuilder.profile?.render).toEqual(
    expect.any(Function),
  );
  expect(mocked.turnOptions).toMatchObject({
    processStartedAtMs: 1_700_000_000_000,
  });
  expect(queryCollapseMocked.keyResolverOptions).toEqual({
    state: mocked.sessionSystem.queryCollapse.state,
    messages: mocked.sessionSystem.messages.repository,
    getGoalBySession: compatibility.sessionV2.goals.getBySession,
  });
  expect(queryCollapseMocked.deliveryOptions).toMatchObject({
    messages: mocked.sessionSystem.messages.userMessages,
    stream: mocked.sessionSystem.stream,
    queryCollapse: {
      resolveQueryKey: expect.any(Function),
      start: expect.any(Function),
    },
  });
  const queryCollapse = queryCollapseMocked.deliveryOptions?.[
    "queryCollapse"
  ] as {
    readonly resolveQueryKey: (
      sessionId: string,
      turnId: string,
      input?: { readonly reuseLatestVisibleQuery?: boolean },
    ) => Promise<string>;
    readonly start: (input: QueryCollapseStartInput) => Promise<unknown>;
  };
  await expect(
    queryCollapse.resolveQueryKey("session-1", "turn-1"),
  ).resolves.toBe("turn:turn-1");
  await expect(
    queryCollapse.resolveQueryKey("session-1", "turn-2", {
      reuseLatestVisibleQuery: true,
    }),
  ).resolves.toBe("turn:turn-2");
  const queryCollapseState = mocked.sessionSystem.queryCollapse.state;
  await queryCollapse.start({
    sessionId: "session-1",
    queryKey: "turn:turn-1",
    currentTurnId: "turn-1",
  });
  expect(queryCollapseMocked.keys.queryKeyForTurn).toHaveBeenCalledWith(
    "session-1",
    "turn-1",
  );
  expect(queryCollapseMocked.keys.queryKeyForContinuation).toHaveBeenCalledWith(
    "session-1",
    "turn-2",
  );
  expect(queryCollapseState.start).toHaveBeenCalledWith({
    sessionId: "session-1",
    queryKey: "turn:turn-1",
    currentTurnId: "turn-1",
  });
  expect(mocked.sessionTitleOptions).toEqual({
    agents: composedProduct.agents,
    preparation: mocked.agentPreparation,
  });
  expect(mocked.archiveTitleOptions).toMatchObject({
    safety: services.safety,
  });
  expect(mocked.createSessionModelRepair).toHaveBeenCalledWith(
    mocked.sessionSystem.sessions.records,
    noopLogger,
  );
  expect(mocked.cronOptions).toEqual({
    db,
    scheduler,
    metrics,
    sessionPorts: expect.any(Object),
    modelSelection: { resolve: expect.any(Function) },
    nowMs,
    recoverPendingRuns: true,
  });
  expect(mocked.sessionOptions).toMatchObject({
    facts: mocked.applicationFactPorts.session,
    queueFacts: mocked.applicationFactPorts.queue,
    compactionFacts: { handle: expect.any(Function) },
    title: {
      model: mocked.sessionTitleModel,
      onOutcome: expect.any(Function),
      onFailure: expect.any(Function),
    },
  });
  expect(mocked.applicationOptions).toMatchObject({
    metrics,
    attachmentRegistration: compatibility.attachmentRegistration,
  });
  const directSend = mocked.conversationApplicationOptions?.["directSend"] as {
    readonly options: Record<string, unknown>;
  };
  expect(directSend.options).not.toHaveProperty("workspaceGate");
  // preview_train moved content-safety review out of ConversationApplication into
  // the turn-system production composition; this guard keeps it from creeping back.
  expect(mocked.conversationApplicationOptions).not.toHaveProperty("safety");
  expect(mocked.conversationApplicationOptions).toMatchObject({
    attachmentRegistration: compatibility.attachmentRegistration,
    threadGoal: {
      pauseActiveForAbort: compatibility.sessionV2.goals.pauseActiveForAbort,
    },
  });
  expect(mocked.conversationApplicationOptions).not.toHaveProperty(
    "workspaceGate",
  );
  expect(mocked.attachmentMaterializerOptions).toEqual({
    registration: compatibility.attachmentRegistration,
  });
  expect(mocked.conversationOptions).toMatchObject({
    attachmentMaterializer: mocked.attachmentMaterializer,
    submission: mocked.v1Submission,
  });
  await assertSessionCompositionPolicies({
    compatibility,
    metricsCounter: metrics.counter,
    projectedEvents,
  });
  expect(services.cron).toBe(mocked.service);
  expect(services.channelSystem).toBe(mocked.channelSystem);
  expect(services.cronDelivery?.deliver).toEqual(expect.any(Function));
  expect(services.plugin).toBe(mocked.plugin);
  expect(services.mcp).toBe(mocked.mcpSettings);
  await assertModelProviderComposition(services, compatibility);
  expect(services.skill).toBe(mocked.runtimeSkillApplication);
  expect(mocked.cleanupServices).toEqual([mocked.service]);
  expect(mocked.conversationBindings).toEqual([]);
  expect(services.safety).toEqual(expect.any(Object));
  expect(services.conversation).toBe(mocked.conversationApplication);
  expect(services.globalEvents.subscribe).toEqual(expect.any(Function));
  expect(services.globalEvents).not.toHaveProperty("write");
  expect(services.applications).toBe(mocked.runtimeApplications);
  await assertRuntimeReadyAndAuth(services);
}

async function assertRuntimeReadyAndAuth(
  services: RuntimeServices,
): Promise<void> {
  services.notifyAuthContextChanged();
  expect(mocked.events).toContain("plugin:auth-context-changed");
  await services.ready();
  expect(mocked.conversationBindings).toEqual([mocked.conversationService]);
}

async function assertModelProviderComposition(
  services: RuntimeServices,
  compatibility: V1ServiceCompatibility,
): Promise<void> {
  expect(services.modelSystem.resolver).toEqual(expect.any(Object));
  expect(services.modelSystem.providers).toEqual(expect.any(Object));
  expect(services.modelSystem.oauth).toEqual(expect.any(Object));
  expect(services.modelProviderApplication).toEqual(expect.any(Object));
  await services.modelProviderApplication.refresh();
  expect(
    compatibility.modelProvider?.refreshOfficialModels,
  ).toHaveBeenCalledOnce();
  expect(mocked.agentPreparationOptions?.modelResolver).toBe(
    services.modelSystem.resolver,
  );
  expect(mocked.processLocalApplicationOptions).toMatchObject({
    modelProvider: {
      application: services.modelProviderApplication,
      providers: services.modelSystem.providers,
      listProviderPresets: services.modelSystem.listProviderPresets,
      oauth: services.modelSystem.oauth,
    },
  });
}

function assertProcessLocalMiniAppComposition(): void {
  expect(mocked.processLocalApplicationOptions).toMatchObject({
    miniApps: {
      list: expect.any(Function),
      open: expect.any(Function),
      stop: expect.any(Function),
    },
  });
}
describe("runtime services CLI composition", () => {
  it.each([true, false])(
    "keeps Electron prompts local with autoUpdate=%s",
    async (autoUpdate) => {
      const compatibility = defaultCompatibility();
      Object.assign(compatibility, { promptConfig: { autoUpdate } });
      const services = await createRuntimeServices({
        db: {} as AppDb,
        dataDir: "/data/prompt-update-disabled",
        logger: noopLogger,
        scheduler: {} as SchedulerClient,
        eventBus: new EventBus<GlobalEvent>(),
        compatibility,
        agentService: localAgentService,
        runtimeOwnerKind: "electron",
      });

      expect(mocked.agentService.bindPromptConfig).not.toHaveBeenCalled();
      expect(compatibility.promptSnapshots.bind).toHaveBeenCalledWith(
        undefined,
      );
      await services.close();
    },
  );

  it("composes the CLI core without Channel or Cron owners and keeps ready ordering explicit", async () => {
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data/cli",
      logger: noopLogger,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility: defaultCompatibility(),
      agentService: localAgentService,
      runtimeOwnerKind: "cli",
      capabilityProfile: "cli",
    });

    expect(mocked.events).toEqual([
      "session:create",
      "mcp:create",
      "plugin:create",
      "turn:create",
      "session-applications:create",
      "applications:create",
    ]);
    expect(services.channelSystem).toBeUndefined();
    expect(services.cron).toBeUndefined();
    expect(services.cronDelivery).toBeUndefined();
    expect(mocked.agentService.bindPromptConfig).not.toHaveBeenCalled();
    expect(services.plugin).toBe(mocked.plugin);
    expect(services.mcp).toBe(mocked.mcpSettings);
    expect(services.skill).toBe(mocked.runtimeSkillApplication);
    const processLocalSkills = mocked.processLocalApplicationOptions?.[
      "skills"
    ] as
      | {
          listRuntimeSkills(input: {
            agentName?: string;
            includePluginSkills?: boolean;
          }): Promise<unknown>;
        }
      | undefined;
    await processLocalSkills?.listRuntimeSkills({
      agentName: "mavis",
      includePluginSkills: true,
    });
    expect(
      mocked.runtimeSkillApplication.listRuntimeSkills,
    ).toHaveBeenCalledWith({
      agentName: "mavis",
      includePluginSkills: true,
    });
    expect(mocked.agentHostOptions).toMatchObject({
      cliProductPolicy: true,
    });
    expect(mocked.agentHostOptions).not.toHaveProperty("tuiProductPolicy");
    expect(mocked.agentHostOptions).not.toHaveProperty("contentReviewEnabled");

    mocked.events.length = 0;
    await services.ready();
    expect(mocked.events).toEqual([
      "session:ready",
      "plan-documents:reconcile",
      "mcp:ready",
      "plugin:ready",
      "turn:ready",
      "conversation:bind",
      "questionnaire:recover",
      "questionnaire:plan-reconcile:true",
    ]);
    await expect(services.builtinAgentDefinitionsReady).resolves.toBe(true);
    expect(mocked.events.at(-1)).toBe("agent:ensure");
  });

  /**
   * The Inspector is composed on a test build, so composition must tolerate a
   * product that carries no model resolver at all. Reading `.fetchImpl` off an
   * absent resolver used to throw and take the whole runtime graph down, and
   * skipping the wrapper entirely left hosts without a resolved transport (TUI)
   * publishing every captured Call with a missing request payload.
   */
  it("composes without a model resolver and captures through the global transport", async () => {
    const compatibility = defaultCompatibility();
    const globalFetch = vi.fn(async () => new Response("{}"));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = globalFetch as unknown as typeof fetch;

    try {
      const services = await createRuntimeServices({
        db: {} as AppDb,
        dataDir: "/data/no-resolver",
        logger: noopLogger,
        scheduler: {} as SchedulerClient,
        eventBus: new EventBus<GlobalEvent>(),
        compatibility,
        agentService: localAgentService,
        runtimeOwnerKind: "electron",
        promptConfigKey: new Uint8Array(32).fill(7),
      });

      expect(services).toBeDefined();
      expect(mocked.agentService.bindPromptConfig).not.toHaveBeenCalled();
      const composedProduct = mocked.agentHostOptions?.["product"] as {
        readonly preparation: {
          readonly modelResolver?: { readonly fetchImpl?: typeof fetch };
        };
      };
      const composedFetch =
        composedProduct.preparation.modelResolver?.fetchImpl;
      // No host transport, but the provider SDK would still reach the global
      // fetch, so capture has to observe that request rather than skip it.
      expect(composedFetch).toBeTypeOf("function");
      await composedFetch?.("https://example.invalid/v1/messages");
      // Verify provider capture independently of the disabled prompt control plane.
      expect(
        vi
          .mocked(globalThis.fetch)
          .mock.calls.filter(
            ([request]) => request === "https://example.invalid/v1/messages",
          ),
      ).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("decorates the host transport for capture rather than replacing it", async () => {
    const compatibility = defaultCompatibility();
    const hostFetch = vi.fn(async () => new Response("{}"));
    (
      compatibility.agentHost.preparation as unknown as {
        modelResolver: { fetchImpl: typeof hostFetch };
      }
    ).modelResolver = { fetchImpl: hostFetch };

    await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data/with-resolver",
      logger: noopLogger,
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility,
      agentService: localAgentService,
      runtimeOwnerKind: "electron",
      promptConfigKey: new Uint8Array(32).fill(7),
    });

    const composedProduct = mocked.agentHostOptions?.["product"] as {
      readonly preparation: {
        readonly modelResolver: { readonly fetchImpl: typeof fetch };
      };
    };
    const composedFetch = composedProduct.preparation.modelResolver.fetchImpl;
    // A wrapper, not the original — and the original still performs the request,
    // so the Electron proxy/net fetch is never discarded.
    expect(composedFetch).not.toBe(hostFetch);
    await composedFetch("https://example.invalid/v1/messages");
    expect(hostFetch).toHaveBeenCalledTimes(1);
  });

  /**
   * TUI opts into capture through the environment variable but composes no host
   * transport. A wrapper that only decorated an existing transport left every
   * captured Call publishing `CAPTURE_FAILED` for its request while the
   * reassembled response still landed, which is not an observable failure the
   * Inspector can explain to the developer reading it.
   */
  it("captures TUI requests even though the host composes no transport", async () => {
    const compatibility = defaultCompatibility();
    const globalFetch = vi.fn(async () => new Response("{}"));
    const originalFetch = globalThis.fetch;
    const originalOptIn = process.env.MAVIS_TUI_LLM_CONTEXT_INSPECTOR;
    globalThis.fetch = globalFetch as unknown as typeof fetch;
    process.env.MAVIS_TUI_LLM_CONTEXT_INSPECTOR = "1";

    try {
      await createRuntimeServices({
        db: {} as AppDb,
        dataDir: "/data/tui-inspector",
        logger: noopLogger,
        scheduler: {} as SchedulerClient,
        eventBus: new EventBus<GlobalEvent>(),
        compatibility,
        agentService: localAgentService,
        runtimeOwnerKind: "tui",
        capabilityProfile: "cli",
        promptConfigKey: new Uint8Array(32).fill(7),
      });
      // Provider-preset refresh owns its own best-effort background request.
      // Count it separately so this contract stays about the captured provider
      // request composed below.
      const startupFetchCount = globalFetch.mock.calls.length;

      const composedProduct = mocked.agentHostOptions?.["product"] as {
        readonly preparation: {
          readonly modelResolver?: { readonly fetchImpl?: typeof fetch };
        };
      };
      const composedFetch =
        composedProduct.preparation.modelResolver?.fetchImpl;
      expect(composedFetch).toBeTypeOf("function");
      await composedFetch?.("https://example.invalid/v1/messages");
      expect(globalFetch).toHaveBeenCalledTimes(startupFetchCount + 1);
      expect(globalFetch).toHaveBeenLastCalledWith(
        "https://example.invalid/v1/messages",
        undefined,
      );
    } finally {
      globalThis.fetch = originalFetch;
      if (originalOptIn === undefined)
        delete process.env.MAVIS_TUI_LLM_CONTEXT_INSPECTOR;
      else process.env.MAVIS_TUI_LLM_CONTEXT_INSPECTOR = originalOptIn;
    }
  });
});

describe("runtime services agent profile composition", () => {
  it("selects task-child prompts only for hidden task-purpose branches and preserves frozen read refs", async () => {
    mocked.agentService.renderProfile.mockImplementation(
      async (input: {
        readonly exactOwnerName: string;
        readonly surface?: string;
      }) =>
        ({
          requestRef: "main",
          resourceReadRef: "mavis",
          exactOwnerName: input.exactOwnerName,
          canonicalViewName: "mavis",
          resolvedAgentName: "mavis",
          agentRole: "orchestrator",
          creationSource: "builtin",
          surface: input.surface ?? "interactive",
          memoryReadAgentNames: ["mavis", "main"],
          corePrompt: "core",
          surfacePrompt: "surface",
          capabilityCeiling: {
            personaEnabled: true,
            features: { mavis: false, delegation: false, webSearch: false },
          },
          provenance: {
            source: "legacy-read-through",
            assetAgentName: "mavis",
            locale: "en-US",
          },
        }) as never,
    );
    await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      eventBus: new EventBus<GlobalEvent>(),
      compatibility: defaultCompatibility(),
      agentService: localAgentService,
      runtimeOwnerKind: "cli",
      capabilityProfile: "cli",
    });
    const profile = (
      mocked.agentHostOptions?.["product"] as {
        readonly preparation: {
          readonly configBuilder: {
            readonly profile: {
              render(input: {
                readonly session: unknown;
                readonly agent: unknown;
              }): Promise<{
                readonly resourceReadRef: string;
                readonly memoryReadAgentNames: readonly string[];
              }>;
            };
          };
        };
      }
    ).preparation.configBuilder.profile;
    const agent = {
      agentName: "main",
      metadata: { requestRef: "main" },
    };
    const cases = [
      {
        sessionType: "branch",
        sessionKind: "task",
        parentSessionId: "parent",
        visibility: "hidden",
        purpose: "local-task:turn:tool",
        expected: "task-child",
      },
      {
        sessionType: "branch",
        sessionKind: "task",
        parentSessionId: "parent",
        visibility: "hidden",
        purpose: "local-background-task:task:delivery",
        expected: "task-child",
      },
      {
        sessionType: "branch",
        sessionKind: "task",
        parentSessionId: "parent",
        visibility: "hidden",
        purpose: "team-plan:plan:task",
        expected: "task-child",
      },
      {
        sessionType: "branch",
        sessionKind: "conversation",
        parentSessionId: "parent",
        visibility: "visible",
        purpose: "local-task:turn:tool",
        expected: "cli",
      },
      {
        sessionType: "branch",
        sessionKind: "task",
        parentSessionId: "parent",
        visibility: "visible",
        purpose: "direct-child",
        expected: "task-child",
      },
      {
        sessionType: "root",
        sessionKind: "cron",
        parentSessionId: null,
        visibility: "visible",
        purpose: "cron:run",
        expected: "cli",
      },
      {
        sessionType: "branch",
        sessionKind: "channel",
        parentSessionId: "parent",
        visibility: "hidden",
        purpose: "channel:message",
        expected: "cli",
      },
    ] as const;

    for (const entry of cases) {
      const rendered = await profile.render({
        session: {
          sessionId: `session-${entry.sessionKind}-${entry.expected}`,
          agentName: "main",
          workspaceDir: "/workspace",
          runtime: "pi-agent",
          archived: false,
          status: "idle",
          createdAtMs: 1,
          updatedAtMs: 1,
          ...entry,
        },
        agent,
      });
      expect(rendered).toMatchObject({
        resourceReadRef: "mavis",
        memoryReadAgentNames: ["mavis", "main"],
      });
    }
    expect(
      mocked.agentService.renderProfile.mock.calls.map(
        ([input]) => input.surface,
      ),
    ).toEqual(cases.map((entry) => entry.expected));
    expect(mocked.agentService.renderProfile.mock.calls).toEqual(
      cases.map(() => [
        expect.objectContaining({
          memoryEnabled: false,
          cronEnabled: false,
          capabilities: expect.objectContaining({
            features: expect.objectContaining({ mavis: false }),
          }),
        }),
      ]),
    );
  });
});

describe("production Session title policy wiring", () => {
  it("skips the signed-out gateway only for the selected BYOK Session", async () => {
    const compatibility = defaultCompatibility();
    const review = vi.mocked(compatibility.safety.review);
    review.mockResolvedValue({ pass: false, errorKind: "auth_error" });
    await createRuntimeServices({
      db: {} as AppDb, dataDir: "/data", logger: noopLogger,
      eventBus: new EventBus<GlobalEvent>(), compatibility,
      agentService: localAgentService, runtimeOwnerKind: "tui", capabilityProfile: "cli",
    });
    const policy = mocked.sessionOptions?.["titlePolicy"] as import("./service/session-system/index.js").SessionRecordServiceDeps["titlePolicy"];
    const session: import("./service/session-system/index.js").SessionRecord = {
      sessionId: "rename", agentName: "test", workspaceDir: "/data",
      runtime: "pi-agent", sessionType: "branch", sessionKind: "conversation",
      archived: false, status: "idle", createdAtMs: 1, updatedAtMs: 1,
      effectiveModel: "custom_provider:openai-work/test-model",
    };
    review.mockClear();
    await expect(policy.blocks("Local rename", session)).resolves.toBe(false);
    expect(review).not.toHaveBeenCalled();
    await expect(policy.blocks("Managed rename", { ...session, effectiveModel: "minimax/MiniMax-M3" })).resolves.toBe(true);
    expect(review).toHaveBeenCalledWith("Managed rename", 205);
  });
});

describe("runtime startup preserves Session model selections", () => {
  it.each(["tui", "electron"] as const)(
    "does not scan or rewrite shared Sessions for %s",
    async (runtimeOwnerKind) => {
      await createRuntimeServices({
        db: {} as AppDb,
        dataDir: "/data/shared",
        logger: noopLogger,
        scheduler: {} as SchedulerClient,
        eventBus: new EventBus<GlobalEvent>(),
        compatibility: defaultCompatibility(),
        agentService: localAgentService,
        runtimeOwnerKind,
        capabilityProfile: "cli",
        promptConfigKey: new Uint8Array(32).fill(7),
      });

      expect(
        mocked.sessionSystem.repositories.sessions.list,
      ).not.toHaveBeenCalled();
      expect(
        mocked.sessionSystem.repositories.sessions.update,
      ).not.toHaveBeenCalled();
    },
  );
});

describe("runtime services LLM retry progress projection", () => {
  it("wires the product retry observer into the production AgentHost", async () => {
    const eventBus = new EventBus<GlobalEvent>();
    const events: GlobalEvent[] = [];
    eventBus.subscribe({ next: (event) => events.push(event) });
    await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data/tui-retry-visibility",
      logger: noopLogger,
      eventBus,
      compatibility: defaultCompatibility(),
      agentService: localAgentService,
      runtimeOwnerKind: "tui",
      capabilityProfile: "cli",
      nowMs: () => 123,
    });

    const resolveLlmRetry = mocked.agentHostOptions?.["resolveLlmRetry"] as
      | ((
          input: unknown,
        ) =>
          | NonNullable<RunTurnInput["llmRetry"]>
          | Promise<NonNullable<RunTurnInput["llmRetry"]>>)
      | undefined;
    expect(resolveLlmRetry).toEqual(expect.any(Function));
    const retryOptions = await resolveLlmRetry?.({});
    const waiting: LLMRetryEvent = {
      sessionId: "session-1",
      turnId: "turn-1",
      callId: "call-1",
      scope: "agent",
      status: "waiting",
      retryAttempt: 1,
      maxRetries: 5,
      requestAttempt: 2,
      delayMs: 1_000,
      nextRetryAtMs: 2_000,
      error: {
        reason: "network",
        message: "LLM provider network request failed",
      },
    };

    await retryOptions?.observer?.(waiting);

    expect(events).toContainEqual({
      type: "session.llm_retry",
      timestamp: 123,
      source: "local-runtime",
      payload: { schemaVersion: 1, ...waiting },
    });
  });
});

describe("runtime services region content-review policy", () => {
  it("disables content review only for the overseas TUI runtime", async () => {
    mocked.runtimeRegion = "en";

    await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data/tui-overseas",
      logger: noopLogger,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility: defaultCompatibility(),
      agentService: localAgentService,
      runtimeOwnerKind: "tui",
      capabilityProfile: "cli",
    });

    expect(mocked.agentHostOptions).toMatchObject({
      cliProductPolicy: true,
      tuiProductPolicy: true,
      contentReviewEnabled: false,
    });
  });

  it("does not apply the TUI region policy to the legacy CLI runtime", async () => {
    mocked.runtimeRegion = "en";

    await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data/cli-overseas",
      logger: noopLogger,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility: defaultCompatibility(),
      agentService: localAgentService,
      runtimeOwnerKind: "cli",
      capabilityProfile: "cli",
    });

    expect(mocked.agentHostOptions).toMatchObject({ cliProductPolicy: true });
    expect(mocked.agentHostOptions).not.toHaveProperty("tuiProductPolicy");
    expect(mocked.agentHostOptions).not.toHaveProperty("contentReviewEnabled");
  });
});

describe("runtime active-steer consumption", () => {
  it("publishes Message SSE and wakes the frontend resume path", async () => {
    const eventBus = new EventBus<GlobalEvent>();
    const events: GlobalEvent[] = [];
    eventBus.subscribe({ next: (event) => events.push(event) });
    mocked.sessionSystem.sessions.repository.get.mockResolvedValue({
      sessionId: "session-1",
      agentName: "mavis",
    });
    await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus,
      compatibility: defaultCompatibility(),
      agentService: localAgentService,
      nowMs: () => 100,
    });
    const onSteeringConsumed = mocked.agentHostOptions?.[
      "onSteeringConsumed"
    ] as (input: Record<string, unknown>) => Promise<void>;

    await onSteeringConsumed({
      sessionId: "session-1",
      turnId: "turn-active",
      message: {
        producerId: "communication",
        idempotencyKey: "message-1",
        message: { text: "hello" },
        provenance: {
          source: "communication",
          routingFingerprint: "communication:message-1",
        },
      },
    });

    expect(
      mocked.sessionSystem.messages.userMessages.commit,
    ).toHaveBeenCalledOnce();
    expect(mocked.sessionSystem.stream.write).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "message-committed",
        turnId: "turn-active",
      }),
    );
    expect(events).toContainEqual({
      type: "session.start",
      timestamp: 100,
      source: "local-runtime",
      payload: {
        sessionId: "session-1",
        agentName: "mavis",
        turnId: "turn-active",
      },
    });
  });
});

describe("runtime services Plugin Hook durable fence composition", () => {
  type CapturedFence = {
    run(input: {
      readonly sessionId: string;
      readonly reason: "archive" | "idle_timeout";
      readonly idleSinceMs?: number;
      readonly sessionOwnershipClaim?: string;
      readonly operation: (signal?: AbortSignal) => Promise<unknown>;
    }): Promise<unknown>;
  };

  async function configureFence(): Promise<CapturedFence> {
    await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility: defaultCompatibility(),
      agentService: localAgentService,
    });
    return mocked.pluginHookSessionEndFence as CapturedFence;
  }

  it("wires durable ownership into AgentHost and fences SessionEnd by Hook claim", async () => {
    mocked.turnSystem.inspection.latestTurnActivity.mockResolvedValue({
      turnId: "newer-admitted-without-hook-claim",
      acceptedAtMs: 200,
      activityAtMs: 200,
    } as never);
    const fence = await configureFence();

    expect(mocked.agentHostOptions?.["pluginHookSessionOwnership"]).toBe(
      mocked.hostPluginHookSessionOwnership,
    );
    const operation = vi.fn(async (signal?: AbortSignal) => ({ signal }));
    await expect(
      fence.run({
        sessionId: "session-1",
        reason: "archive",
        sessionOwnershipClaim: "owner-turn-1",
        operation,
      }),
    ).resolves.toMatchObject({ status: "executed" });
    expect(operation).toHaveBeenCalledWith(expect.any(AbortSignal));
    expect(
      mocked.turnSystem.pluginHookSessionOwnership.tryClaimSessionEnd,
    ).toHaveBeenCalledWith({
      sessionId: "session-1",
      ownershipClaimId: "owner-turn-1",
      sessionEndClaimId: "owner-turn-1:session-end",
      reason: "archive",
    });
    expect(
      mocked.turnSystem.pluginHookSessionOwnership.completeSessionEnd,
    ).toHaveBeenCalledOnce();

    mocked.turnSystem.pluginHookSessionOwnership.tryClaimSessionEnd.mockResolvedValueOnce(
      {
        status: "already-claimed",
      } as never,
    );
    const duplicate = vi.fn(async () => undefined);
    await expect(
      fence.run({
        sessionId: "session-1",
        reason: "archive",
        sessionOwnershipClaim: "owner-turn-1",
        operation: duplicate,
      }),
    ).resolves.toEqual({ status: "superseded" });
    expect(duplicate).not.toHaveBeenCalled();
  });

  it("executes SessionEnd without a maintenance signal when exclusive fencing is unavailable", async () => {
    const tryRunExclusive = mocked.turnSystem.sessionLifecycle.tryRunExclusive;
    const sessionLifecycle = mocked.turnSystem.sessionLifecycle as {
      tryRunExclusive?: typeof tryRunExclusive;
    };
    sessionLifecycle.tryRunExclusive = undefined;
    try {
      const fence = await configureFence();
      const operation = vi.fn(async () => "completed");

      await expect(
        fence.run({
          sessionId: "session-1",
          reason: "archive",
          sessionOwnershipClaim: "owner-turn-1",
          operation,
        }),
      ).resolves.toEqual({ status: "executed", result: "completed" });
      expect(operation).toHaveBeenCalledWith();
      expect(
        mocked.turnSystem.pluginHookSessionOwnership.tryClaimSessionEnd,
      ).not.toHaveBeenCalled();
    } finally {
      sessionLifecycle.tryRunExclusive = tryRunExclusive;
    }
  });

  it("supersedes SessionEnd when the durable ownership claim is absent or stale", async () => {
    const fence = await configureFence();
    const operation = vi.fn(async () => undefined);
    mocked.turnSystem.pluginHookSessionOwnership.latest
      .mockResolvedValueOnce(undefined as never)
      .mockResolvedValueOnce({ ownershipClaimId: "owner-turn-2" } as never);

    for (const sessionId of ["missing-owner", "stale-owner"]) {
      await expect(
        fence.run({
          sessionId,
          reason: "archive",
          sessionOwnershipClaim: "owner-turn-1",
          operation,
        }),
      ).resolves.toEqual({ status: "superseded" });
    }

    expect(operation).not.toHaveBeenCalled();
    expect(
      mocked.turnSystem.pluginHookSessionOwnership.tryClaimSessionEnd,
    ).not.toHaveBeenCalled();
  });

  it("defers a stale idle sweep but executes after activity remains at the observed boundary", async () => {
    const fence = await configureFence();
    const operation = vi.fn(async () => "completed");
    mocked.turnSystem.inspection.latestTurnActivity
      .mockResolvedValueOnce({ activityAtMs: 201 } as never)
      .mockResolvedValueOnce({ activityAtMs: 200 } as never);

    await expect(
      fence.run({
        sessionId: "session-1",
        reason: "idle_timeout",
        idleSinceMs: 200,
        sessionOwnershipClaim: "owner-turn-1",
        operation,
      }),
    ).resolves.toEqual({ status: "deferred", latestActivityAtMs: 201 });
    expect(operation).not.toHaveBeenCalled();

    await expect(
      fence.run({
        sessionId: "session-1",
        reason: "idle_timeout",
        idleSinceMs: 200,
        sessionOwnershipClaim: "owner-turn-1",
        operation,
      }),
    ).resolves.toEqual({ status: "executed", result: "completed" });
    expect(operation).toHaveBeenCalledWith(expect.any(AbortSignal));
  });
});

describe("runtime services Cron composition", () => {
  it("keeps Cron-specific test overrides inside service composition", async () => {
    const customDelivery = {
      deliver: async () => ({ delivered: true as const }),
    };
    const sessionPorts = {
      sessionCreation: {},
      delivery: mocked.defaultDelivery,
    };
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      logger: noopLogger,
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility: defaultCompatibility(),
      agentService: localAgentService,
      overrides: {
        cron: {
          sessionPorts: sessionPorts as never,
          turnDelivery: customDelivery,
        },
      },
    });

    expect(mocked.events).toEqual([
      "session:create",
      "channel:create",
      "mcp:create",
      "plugin:create",
      "turn:create",
      "session-applications:create",
      "applications:create",
      "cron:create",
    ]);
    expect(mocked.cronOptions).toMatchObject({
      sessionPorts,
    });
    expect(mocked.cronOptions).not.toHaveProperty("turnDelivery");
    expect(services.cronDelivery).toBe(customDelivery);
  });

  it("routes scheduled and generated Cron delivery through the same steer-or-activate port", async () => {
    const compatibility = defaultCompatibility();
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility,
      agentService: localAgentService,
    });
    const scheduledDelivery = (
      mocked.cronOptions?.["sessionPorts"] as {
        readonly delivery: {
          deliver(input: CronDeliveryInput): Promise<unknown>;
        };
      }
    ).delivery;
    const request: CronDeliveryInput = {
      cronId: "cron-1",
      runId: "run-1",
      sessionId: "session-1",
      text: "inspect the build",
    };

    await expect(scheduledDelivery.deliver(request)).resolves.toEqual({
      delivered: true,
    });
    await expect(services.cronDelivery?.deliver(request)).resolves.toEqual({
      delivered: true,
    });

    expect(mocked.turnSystem.turns.steer).toHaveBeenCalledTimes(2);
    expect(mocked.turnSystem.turns.steer).toHaveBeenNthCalledWith(1, {
      sessionId: "session-1",
      input: { text: "inspect the build" },
      producerId: "cron:cron-1",
      idempotencyKey: "run-1",
      provenance: {
        source: "cron",
        routingFingerprint: "cron:cron-1:run-1",
        sourceContext: { cronId: "cron-1", runId: "run-1" },
      },
    });
    expect(mocked.turnSystem.turns.steer).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        producerId: "cron:cron-1",
        idempotencyKey: "run-1",
      }),
    );
  });

  it("disables persisted Cron recovery for a quarantined runtime clone", async () => {
    await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility: defaultCompatibility(),
      agentService: localAgentService,
      recoverPersistedState: false,
    });

    expect(mocked.cronOptions).toMatchObject({ recoverPendingRuns: false });
  });
});

describe("runtime Root lifecycle diagnostics", () => {
  it("routes v2 Root participant failures through the production reporter", async () => {
    const compatibility = defaultCompatibility();
    await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility,
      agentService: localAgentService,
    });
    const rootDiagnostics = mocked.applicationOptions as {
      readonly onRootBestEffortFailure: (input: {
        readonly stage: "turn-abort";
        readonly sessionId: string;
        readonly error: unknown;
      }) => void;
    };

    rootDiagnostics.onRootBestEffortFailure({
      stage: "turn-abort",
      sessionId: "root-1",
      error: new Error("abort failed"),
    });

    expect(compatibility.agentHost.executor.reportFailure).toHaveBeenCalledWith(
      "root-1",
      "root_replacement_abort_failed:abort failed",
    );
  });
});

describe("runtime Session Application composition", () => {
  it.each([false, true])(
    "cleans both MCP scopes when disposing a session (agent failure: %s)",
    async (fails) => {
      const services = await createRuntimeServices({
        db: {} as AppDb,
        dataDir: "/data",
        scheduler: {} as SchedulerClient,
        eventBus: new EventBus<GlobalEvent>(),
        compatibility: defaultCompatibility(),
        agentService: localAgentService,
      });
      const dispose = mocked.turnOptions?.disposeRuntimeSession;
      if (!dispose)
        throw new Error("Runtime session disposal was not composed");
      if (fails)
        mocked.agentRuntimeLifecycle.disposeSession.mockRejectedValueOnce(
          new Error("agent disposal failed"),
        );
      const disposing = dispose("session-mcp");
      if (fails)
        await expect(disposing).rejects.toThrow("agent disposal failed");
      else await disposing;
      expect(mocked.agentRuntimeLifecycle.disposeSession).toHaveBeenCalledWith(
        "session-mcp",
      );
      expect(mocked.mcp.disposeSession).toHaveBeenCalledWith("session-mcp");
      await services.close();
    },
  );

  it("resumes Session deletion through the bound Application lifecycle", async () => {
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility: defaultCompatibility(),
      agentService: localAgentService,
    });
    const resumeSessionDeletion = mocked.turnOptions?.resumeSessionDeletion;
    if (!resumeSessionDeletion)
      throw new Error("Session deletion recovery was not composed");

    await resumeSessionDeletion("session-deleting");

    expect(
      mocked.runtimeApplications.session.lifecycle.deleteSessionById,
    ).toHaveBeenCalledWith("session-deleting");
    await services.close();
  });

  it("always composes Applications over the main SessionSystem owner graph", async () => {
    const db = {} as AppDb;
    const compatibility = defaultCompatibility();
    const services = await createRuntimeServices({
      db,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility,
      agentService: localAgentService,
    });

    expect(mocked.sessionApplicationOptions).toMatchObject({
      owner: mocked.sessionSystem,
      canvas: services.canvas,
      compatibility: compatibility.sessionV2,
      maintenance: mocked.turnSystem.maintenance,
      facts: mocked.applicationFactPorts,
    });
    expect(mocked.applicationFactOptions).toEqual({
      publish: expect.any(Function),
    });
    expect(mocked.applicationOptions).toMatchObject({
      sessionSystem: mocked.initializedSessionApplicationSystem,
      compatibility: compatibility.sessionV2,
      turn: mocked.turnSystem.turns,
    });
    expect(services.applications).toBe(mocked.runtimeApplications);

    mocked.events.length = 0;
    await services.ready();
    expect(mocked.events).toEqual([
      "session:ready",
      "plan-documents:reconcile",
      "mcp:ready",
      "plugin:ready",
      "turn:ready",
      "conversation:bind",
      "questionnaire:recover",
      "questionnaire:plan-reconcile:true",
      "cron:ready",
    ]);
    await expect(services.builtinAgentDefinitionsReady).resolves.toBe(true);
    expect(mocked.events.at(-1)).toBe("agent:ensure");
    expect(mocked.agentService.ensureBuiltinRows).toHaveBeenCalledOnce();
    expect(
      mocked.agentService.bindBuiltinModelGroupResolver,
    ).toHaveBeenCalledWith(expect.any(Function));
    expect(
      mocked.agentService.bindConfigPreviewDiagnostics,
    ).toHaveBeenCalledWith(expect.any(Function));
    expect(
      mocked.agentService.bindEffectiveConfigResolver,
    ).toHaveBeenCalledWith(expect.any(Function));
    expect(
      mocked.agentService.bindCandidateModelValidator,
    ).toHaveBeenCalledWith(expect.any(Function));

    mocked.events.length = 0;
    await services.close();
    expect(mocked.events).toEqual([
      "cron:close",
      "turn:close",
      "plugin:close",
      "mcp:close",
      "session:close",
    ]);
  });
});

describe("runtime persisted-state recovery policy", () => {
  it("skips persisted Questionnaire and Plan recovery for a quarantined runtime clone", async () => {
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility: defaultCompatibility(),
      recoverPersistedState: false,
      agentService: localAgentService,
    });
    mocked.events.length = 0;

    await services.ready();

    expect(mocked.events).toEqual([
      "session:ready",
      "mcp:ready",
      "plugin:ready",
      "turn:ready",
      "conversation:bind",
      "cron:ready",
    ]);
    await expect(services.builtinAgentDefinitionsReady).resolves.toBe(true);
    expect(mocked.events.at(-1)).toBe("agent:ensure");
  });
});

describe("Goal verifier service binding", () => {
  it("binds both backends, immutable transcript capture, and the readonly child extension", async () => {
    const bindVerifier =
      vi.fn<
        NonNullable<
          V1ServiceCompatibility["sessionV2"]["goals"]["bindVerifier"]
        >
      >();
    const compatibility = defaultCompatibility();
    Object.assign(compatibility.sessionV2.goals, { bindVerifier });
    const canonicalMessage = { role: "user", content: "fixed evidence" };
    mocked.sessionSystem.canonicalHistory.inspectActive.mockResolvedValue({
      revision: "sha256:goal-evaluator",
      messages: [canonicalMessage],
    });
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility,
      agentService: localAgentService,
    });

    expect(bindVerifier).toHaveBeenCalledOnce();
    const [verifier, reader] = bindVerifier.mock.calls[0] ?? [];
    expect(verifier?.dispatch).toEqual(expect.any(Function));
    expect(mocked.agentHostOptions?.["normalExtensions"]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "local-goal-verifier-readonly" }),
        expect.objectContaining({ id: "local-goal-budget-summary" }),
      ]),
    );
    // Without this the child's per-request cap would never reach the Turn, and
    // only the coordinator's cumulative check would remain.
    const outputTokenCap = mocked.agentHostOptions?.["outputTokenCap"] as
      | { resolveOutputTokenCap: (input: unknown) => number | undefined }
      | undefined;
    expect(outputTokenCap?.resolveOutputTokenCap).toEqual(expect.any(Function));
    expect(outputTokenCap?.resolveOutputTokenCap({})).toBeUndefined();
    const captured = await reader?.capture("session-goal");
    canonicalMessage.content = "concurrent mutation";
    expect(captured).toEqual({
      messages: [{ role: "user", content: "fixed evidence" }],
      truncated: false,
    });
    expect(
      mocked.sessionSystem.canonicalHistory.inspectActive,
    ).toHaveBeenCalledWith("session-goal");
    await services.close();
  });

  it("captures only the newest bounded Goal verifier transcript and reports truncation", async () => {
    const bindVerifier =
      vi.fn<
        NonNullable<
          V1ServiceCompatibility["sessionV2"]["goals"]["bindVerifier"]
        >
      >();
    const compatibility = defaultCompatibility();
    Object.assign(compatibility.sessionV2.goals, { bindVerifier });
    const canonicalMessages = Array.from({ length: 201 }, (_, index) => ({
      role: "user",
      content: `evidence-${index}`,
    }));
    mocked.sessionSystem.canonicalHistory.inspectActive.mockResolvedValue({
      revision: "sha256:goal-evaluator-bounded",
      messages: canonicalMessages,
    });
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility,
      agentService: localAgentService,
    });

    const [, reader] = bindVerifier.mock.calls[0] ?? [];
    const captured = await reader?.capture("session-goal-bounded");
    const newestCanonicalMessage = canonicalMessages.at(-1);
    if (!newestCanonicalMessage)
      throw new Error("expected bounded canonical transcript");
    newestCanonicalMessage.content = "concurrent mutation";
    expect(captured).toMatchObject({
      truncated: true,
      truncationNote: expect.stringContaining("newest 200 messages"),
    });
    expect(captured?.messages).toHaveLength(200);
    expect(captured?.messages[0]).toEqual({
      role: "user",
      content: "evidence-1",
    });
    expect(captured?.messages[199]).toEqual({
      role: "user",
      content: "evidence-200",
    });
    await services.close();
  });
});

describe("runtime Browser services lifecycle", () => {
  it("treats an unspecified runtime owner as Desktop Plugin-managed Browser activation", async () => {
    const compatibility = defaultCompatibility();
    Object.assign(compatibility.agentHost.preparation.configBuilder, {
      config: () => ({
        provider: {},
        dataDir: "/data",
        custom_provider: { "openai-work": {} },
        beta: { filePanelBrowser: true, browserUseTooling: true },
      }),
    });
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility,
      browserUse: { adapter: { execute: vi.fn() } },
      agentService: localAgentService,
    });

    expect(services.browserUse.builtinSkillDescriptor()).toBeUndefined();
    expect(
      services.browserUse.admitQuestionnaireRequest({
        request: {
          mode: "feature-enable",
          modePayload: { featureKey: "browser-use" },
        },
      }),
    ).toMatchObject({ status: 403, code: "BROWSER_PLUGIN_MANAGED" });
    await services.close();
  });

  it("clears V2 Browser receipts only for committed context-reset rewinds", async () => {
    const compatibility = defaultCompatibility();
    Object.assign(compatibility.agentHost.preparation.configBuilder, {
      config: () => ({
        provider: {},
        dataDir: "/data",
        custom_provider: { "openai-work": {} },
        beta: { filePanelBrowser: true, browserUseTooling: true },
      }),
    });
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility,
      browserUse: { adapter: { execute: vi.fn() } },
      agentService: localAgentService,
      runtimeOwnerKind: "cli",
    });
    const publish = mocked.applicationFactOptions?.["publish"] as (
      event: GlobalEventInput,
    ) => void;
    const baseSkill = {
      def: LocalSkillToolDef,
      impl: { execute: vi.fn(async () => ({ content: [] })) },
    } as unknown as RuntimeTool;
    const browserCapability = services.browserUse.resolveTurnCapability({
      sessionId: "assembly-session",
      turnId: "assembly-turn",
      surface: "interactive",
      workspaceRoot: "/data",
      baseTools: [baseSkill],
    });
    const skill = browserCapability.tools.find(
      (candidate) => candidate.def.name === "skill",
    );
    const browser = browserCapability.tools.find(
      (candidate) => candidate.def.name === "browser",
    );
    if (!skill || !browser) throw new Error("expected Browser tools");
    for (const sessionId of [
      "session-reset",
      "session-ui-only",
      "session-deleted",
    ]) {
      await skill.impl.execute(
        { sessionId, turnId: "turn-a" },
        {
          name: "control-in-app-browser",
        },
      );
    }
    services.browserUse.turnContext.record({
      sessionId: "session-reset",
      turnId: "turn-reset",
      inAppBrowser: { visible: true, selectedTab: true },
    });
    services.browserUse.turnContext.record({
      sessionId: "session-deleted",
      turnId: "turn-deleted",
      inAppBrowser: { visible: true, selectedTab: false },
    });

    publish({
      type: "message.rewind",
      payload: { sessionId: "session-reset", contextReset: true },
    });
    publish({
      type: "message.rewind",
      payload: { sessionId: "session-ui-only", contextReset: false },
    });
    publish({
      type: "content.retry.exceeded",
      payload: { sessionId: "session-retry", variant: "content" },
    });
    publish({
      type: "session.deleted",
      payload: { sessionId: "session-deleted" },
    });

    await expect(
      browser.impl.execute(
        { sessionId: "session-reset", turnId: "turn-a" },
        {
          action: "inspect",
          input: {},
        },
      ),
    ).resolves.toMatchObject({
      isError: true,
      details: { code: "SKILL_REQUIRED" },
    });
    await expect(
      browser.impl.execute(
        { sessionId: "session-ui-only", turnId: "turn-a" },
        {
          action: "inspect",
          input: {},
        },
      ),
    ).resolves.toMatchObject({ details: { action: "inspect" } });
    expect(
      services.browserUse.turnContext.read("session-reset", "turn-reset"),
    ).toEqual({
      visible: true,
      selectedTab: true,
    });
    await expect(
      browser.impl.execute(
        { sessionId: "session-deleted", turnId: "turn-a" },
        {
          action: "inspect",
          input: {},
        },
      ),
    ).resolves.toMatchObject({
      isError: true,
      details: { code: "SKILL_REQUIRED" },
    });
    expect(
      services.browserUse.turnContext.read("session-deleted", "turn-deleted"),
    ).toBeUndefined();
    await services.close();
  });
});

describe("runtime services lifecycle", () => {
  it("keeps startup available when ordinary Questionnaire recovery fails", async () => {
    const failure = new Error("Questionnaire query failed");
    mocked.questionnaireService.recoverOnStartup.mockRejectedValueOnce(failure);
    const compatibility = defaultCompatibility();
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility,
      agentService: localAgentService,
    });

    await expect(services.ready()).resolves.toBeUndefined();
    expect(compatibility.agentHost.executor.reportFailure).toHaveBeenCalledWith(
      "questionnaire-recovery",
      "owner=questionnaire;stage=startup-recovery;error=Questionnaire query failed",
    );
  });

  it("keeps startup available when Plan draft recovery reports isolated failures", async () => {
    const failure = new AggregateError(
      [new Error("bad manifest")],
      "draft recovery failed",
    );
    mocked.sessionSystem.planDocuments.reconcilePreparedDrafts.mockRejectedValueOnce(
      failure,
    );
    const compatibility = defaultCompatibility();
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility,
      agentService: localAgentService,
    });

    await expect(services.ready()).resolves.toBeUndefined();
    expect(compatibility.agentHost.executor.reportFailure).toHaveBeenCalledWith(
      "plan-document-recovery",
      "owner=session-system;component=plan-document;stage=startup-reconcile;error=draft recovery failed",
    );
  });

  it("accepts v1 events through the injected write port once and detaches on close", async () => {
    let publish:
      | Parameters<V1ServiceCompatibility["events"]["bindPublisher"]>[0]
      | undefined;
    const unbind = vi.fn();
    const bindPublisher = vi.fn<
      V1ServiceCompatibility["events"]["bindPublisher"]
    >((publisher) => {
      publish = publisher;
      return unbind;
    });
    const eventBus = new EventBus<GlobalEvent>();
    const compatibility = defaultCompatibility({ bindPublisher });
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus,
      compatibility,
      agentService: localAgentService,
      nowMs: () => 1_700_000_000_000,
    });
    const received: GlobalEvent[] = [];
    services.globalEvents.subscribe({ next: (event) => received.push(event) });

    expect(publish).toBeUndefined();
    await services.ready();
    publish?.({ type: "agent.created", payload: { agentName: "mavis" } });

    expect(received).toEqual([
      {
        type: "agent.created",
        timestamp: 1_700_000_000_000,
        source: "local-runtime",
        payload: { agentName: "mavis" },
      },
    ]);
    publish?.({
      type: "session.finish",
      payload: {
        sessionId: "session-1",
        agentName: "mavis",
        turnId: "turn-greeting",
        status: "finished",
      },
    });
    expect(received[1]).toMatchObject({
      type: "session.finish",
      payload: { turnId: "turn-greeting" },
    });
    publish?.({
      type: "session.error",
      payload: {
        sessionId: "session-1",
        agentName: "mavis",
        turnId: "turn-failed-greeting",
        status: "error",
      },
    });
    publish?.({
      type: "session.abort",
      payload: {
        sessionId: "session-1",
        agentName: "mavis",
        turnId: "turn-cancelled-greeting",
        status: "aborted",
      },
    });
    await services.close();
    expect(bindPublisher).toHaveBeenCalledOnce();
    expect(unbind).toHaveBeenCalledOnce();
    expect(mocked.conversationShutdowns).toHaveLength(1);

    publish?.({ type: "agent.created", payload: { agentName: "late-event" } });
    expect(received).toHaveLength(4);
  });
});

describe("runtime services readiness and shutdown", () => {
  it("swallows greeting terminal persistence failures without leaking a rejection", async () => {
    let publish:
      | Parameters<V1ServiceCompatibility["events"]["bindPublisher"]>[0]
      | undefined;
    const bindPublisher = vi.fn<
      V1ServiceCompatibility["events"]["bindPublisher"]
    >((publisher) => {
      publish = publisher;
      return () => undefined;
    });
    const compatibility = defaultCompatibility({ bindPublisher });

    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility,
      agentService: localAgentService,
      greetingEnabled: true,
    });
    await services.ready();

    const notification = vi.mocked(services.agent.notifyGreetingTurnTerminal);
    notification.mockRejectedValueOnce(
      new Error("greeting state write failed"),
    );
    publish?.({
      type: "session.finish",
      payload: {
        sessionId: "session-1",
        agentName: "mavis",
        turnId: "turn-greeting-persistence-failure",
        status: "finished",
      },
    });
    await Promise.resolve();
    expect(notification).toHaveBeenCalledOnce();
    await services.close();
  });
});

describe("runtime services ready and close", () => {
  it("runs post-infra service readiness once and preserves its failure", async () => {
    const failure = new Error("Cron recovery failed");
    mocked.readyError = failure;
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      logger: noopLogger,
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility: defaultCompatibility(),
      agentService: localAgentService,
    });

    const first = services.ready();
    const second = services.ready();

    expect(second).toBe(first);
    await expect(first).rejects.toBe(failure);
    expect(mocked.conversationBindings).toEqual([mocked.conversationService]);
    expect(mocked.events).toEqual([
      "session:create",
      "channel:create",
      "mcp:create",
      "plugin:create",
      "turn:create",
      "session-applications:create",
      "applications:create",
      "cron:create",
      "session:ready",
      "plan-documents:reconcile",
      "mcp:ready",
      "plugin:ready",
      "turn:ready",
      "conversation:bind",
      "questionnaire:recover",
      "questionnaire:plan-reconcile:true",
      "cron:ready",
    ]);
  });

  it("keeps runtime startup available while a failed Plan recovery retries after Queue readiness", async () => {
    const failure = new Error("Plan recovery temporarily unavailable");
    mocked.questionnaireService.reconcileOwnedActions.mockRejectedValueOnce(
      failure,
    );
    const compatibility = defaultCompatibility();
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility,
      agentService: localAgentService,
    });

    await expect(services.ready()).resolves.toBeUndefined();
    await vi.waitFor(() => {
      expect(mocked.events).toContain("questionnaire:plan-reconcile:true");
    });

    await expect(services.builtinAgentDefinitionsReady).resolves.toBe(true);
    expect(mocked.events.filter((event) => event !== "agent:ensure")).toEqual([
      "session:create",
      "channel:create",
      "mcp:create",
      "plugin:create",
      "turn:create",
      "session-applications:create",
      "applications:create",
      "cron:create",
      "session:ready",
      "plan-documents:reconcile",
      "mcp:ready",
      "plugin:ready",
      "turn:ready",
      "conversation:bind",
      "questionnaire:recover",
      "cron:ready",
      "questionnaire:plan-reconcile:true",
    ]);
    expect(
      mocked.events.filter((event) => event === "agent:ensure"),
    ).toHaveLength(1);
    expect(compatibility.agentHost.executor.reportFailure).toHaveBeenCalledWith(
      "plan-lifecycle",
      "owner=plan;stage=lifecycle-reconcile;error=Plan recovery temporarily unavailable",
    );

    await services.close();
  });

  it("shares close, closes Cron once, and cannot become ready afterwards", async () => {
    const bindPublisher = vi.fn(() => () => undefined);
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      logger: noopLogger,
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility: defaultCompatibility({ bindPublisher }),
      agentService: localAgentService,
    });
    mocked.events.length = 0;

    const closePreview = vi.spyOn(services.workspace.htmlPreview, "close");
    const first = services.close();
    const second = services.close();

    expect(second).toBe(first);
    await first;
    expect(closePreview).toHaveBeenCalledTimes(1);
    await services.ready();
    expect(mocked.events).toEqual([
      "cron:close",
      "turn:close",
      "plugin:close",
      "mcp:close",
      "session:close",
    ]);
    expect(bindPublisher).not.toHaveBeenCalled();
    expect(mocked.conversationShutdowns).toHaveLength(1);
  });

  it("closes Cron when publisher cleanup fails and preserves the first failure", async () => {
    const failure = new Error("global events close failed");
    const compatibility = defaultCompatibility({
      bindPublisher: () => () => {
        throw failure;
      },
    });
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility,
      agentService: localAgentService,
    });
    await services.ready();
    mocked.events.length = 0;

    const closePreview = vi.spyOn(services.workspace.htmlPreview, "close");
    await expect(services.close()).rejects.toBe(failure);
    expect(closePreview).toHaveBeenCalledTimes(1);

    expect(mocked.events).toEqual([
      "cron:close",
      "turn:close",
      "plugin:close",
      "mcp:close",
      "session:close",
    ]);
  });
});

describe("runtime services greeting terminal timing", () => {
  it("invokes greeting terminal observation before publishing the terminal event", async () => {
    let publish:
      | Parameters<V1ServiceCompatibility["events"]["bindPublisher"]>[0]
      | undefined;
    const bindPublisher = vi.fn<
      V1ServiceCompatibility["events"]["bindPublisher"]
    >((publisher) => {
      publish = publisher;
      return () => undefined;
    });
    const eventBus = new EventBus<GlobalEvent>();
    const order: string[] = [];
    eventBus.subscribe({ next: () => order.push("event") });
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus,
      compatibility: defaultCompatibility({ bindPublisher }),
      agentService: localAgentService,
      greetingEnabled: true,
    });
    await services.ready();

    const notification = vi.mocked(services.agent.notifyGreetingTurnTerminal);
    notification.mockImplementationOnce(() => {
      order.push("notify");
      return Promise.resolve();
    });
    publish?.({
      type: "session.finish",
      payload: {
        sessionId: "session-1",
        agentName: "mavis",
        turnId: "turn-greeting-order",
        status: "finished",
      },
    });

    expect(order).toEqual(["notify", "event"]);
    await services.close();
  });

  it("swallows synchronous greeting terminal observer failures", async () => {
    let publish:
      | Parameters<V1ServiceCompatibility["events"]["bindPublisher"]>[0]
      | undefined;
    const bindPublisher = vi.fn<
      V1ServiceCompatibility["events"]["bindPublisher"]
    >((publisher) => {
      publish = publisher;
      return () => undefined;
    });
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility: defaultCompatibility({ bindPublisher }),
      agentService: localAgentService,
      greetingEnabled: true,
    });
    await services.ready();

    const notification = vi.mocked(services.agent.notifyGreetingTurnTerminal);
    notification.mockImplementationOnce(() => {
      throw new Error("synchronous greeting observer failure");
    });
    publish?.({
      type: "session.finish",
      payload: {
        sessionId: "session-1",
        agentName: "mavis",
        turnId: "turn-greeting-sync-failure",
        status: "finished",
      },
    });

    expect(notification).toHaveBeenCalledOnce();
    await services.close();
  });
});

describe("runtime Plan lifecycle recovery", () => {
  it("releases recovered Plan review Queue work only after TurnSystem is ready", async () => {
    mocked.questionnaireService.reconcileOwnedActions.mockImplementationOnce(
      async (dispatch: boolean) => {
        mocked.events.push(`questionnaire:plan-reconcile:${String(dispatch)}`);
        const binding = mocked.questionnaireActionBindings[0] as {
          readonly handler: QuestionnaireOwnedActionHandler;
        };
        await binding.handler.afterConsumed?.({
          record: {
            requestId: "plan-review-request",
            sessionId: "session-plan-review",
            request: {
              mode: "plan",
              modePayload: {
                planReview: {
                  markdown: "# Frozen plan",
                  path: "/history/session-1/artifacts/plan.md",
                },
              },
            },
          } as never,
          action: {
            kind: "reply",
            reply: {
              schemaVersion: 2,
              requestId: "plan-review-request",
              answers: [
                {
                  stepId: "plan-review-decision",
                  selectedOptionIds: ["approve"],
                  selectedOther: false,
                },
              ],
              submittedAt: 1_700_000_000_000,
            },
          },
          dispatch,
        });
        return 1;
      },
    );
    mocked.turnSystem.turns.dispatchQueue.mockImplementationOnce(
      async (sessionId: string) => {
        mocked.events.push(`queue:dispatch:${sessionId}`);
      },
    );
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility: defaultCompatibility(),
      agentService: localAgentService,
    });

    await services.ready();
    await vi.waitFor(() => {
      expect(mocked.events).toContain("queue:dispatch:session-plan-review");
    });

    expect(
      mocked.events.indexOf("queue:dispatch:session-plan-review"),
    ).toBeGreaterThan(mocked.events.indexOf("turn:ready"));

    await services.close();
  });
});

async function assertWorkspaceBashFileSourceResolution(): Promise<void> {
  // The rollout kill switch keeps the extension out of every composed runtime,
  // so exercise the retained implementation directly for future re-enable.
  const compatibility = defaultCompatibility();
  const extension = createRuntimeSourceReferenceExtension(
    compatibility.attachmentRegistration,
  );
  const runtime = await createAgentRuntime({ base: [extension] });
  const turn = baseCtx({
    sessionId: "session-workspace-source",
    turnId: "turn-workspace-source",
    workspaceDir: "/workspace/project",
  });
  const assembly = await runtime.assembleTurn(turn);
  const afterToolCall = assembly.hooks.afterToolCallHook?.[0];
  if (!afterToolCall)
    throw new Error("source-reference tool hook was not registered");

  const insidePatch = await afterToolCall({
    assistantMessage: {} as never,
    toolCall: { id: "bash-inside", name: "bash" } as never,
    args: {
      command: "unzip -q /workspace/project/demo.docx -d /tmp/docx_extract",
    },
    result: { content: [{ type: "text", text: "document body" }], details: {} },
    isError: false,
    context: {} as never,
  });
  const outsidePatch = await afterToolCall({
    assistantMessage: {} as never,
    toolCall: { id: "bash-outside", name: "bash" } as never,
    args: { command: "unzip -q /outside/private.docx -d /tmp/docx_extract" },
    result: { content: [{ type: "text", text: "private body" }], details: {} },
    isError: false,
    context: {} as never,
  });

  expect(insidePatch?.content?.at(-1)).toEqual({
    type: "text",
    text: expect.stringContaining(
      "Citation candidate: [demo.docx](#mavis-source=file:L3dvcmtzcGFjZS9wcm9qZWN0L2RlbW8uZG9jeA)",
    ),
  });
  expect(insidePatch?.details).toMatchObject({
    source_references: [
      expect.objectContaining({
        type: "file",
        path: "/workspace/project/demo.docx",
        name: "demo.docx",
      }),
    ],
  });
  expect(outsidePatch).toBeUndefined();
  expect(
    compatibility.attachmentRegistration.resolveSource,
  ).toHaveBeenCalledTimes(2);
}

function defaultCompatibility(
  events: V1ServiceCompatibility["events"] = {
    bindPublisher: () => () => undefined,
  },
  generatedAssets: Partial<V1ServiceCompatibility["generatedAssets"]> = {},
): V1ServiceCompatibility {
  return {
    sandbox: { writeConfig: vi.fn(async () => undefined) },
    modelProvider: { refreshOfficialModels: vi.fn(async () => undefined) },
    peripherals: {} as never,
    skills: {
      listSkills: vi.fn(async () => ({ skills: [], hasMore: false })),
    } as never,
    managedWorktrees: {
      list: vi.fn(async () => ({ success: true, worktrees: [] })),
      remove: vi.fn(async () => ({ status: 200, body: { success: true } })),
      removeBatch: vi.fn(async () => ({
        success: true,
        removedPaths: [],
        failedItems: [],
      })),
    },
    agentReferences: {
      resolveDelegatable: vi.fn(
        async (): Promise<"authorized"> => "authorized",
      ),
    },
    cron: {
      bindAgentCleanup: (service) => mocked.cleanupServices.push(service),
      deleteAgentTasks: vi.fn(async () => undefined),
    },
    agentHost: {
      preparation: {
        configBuilder: {
          config: () => ({
            provider: {},
            dataDir: "/data",
            custom_provider: { "openai-work": {} },
          }),
          skills: {
            listRuntimeSkills: vi.fn(async () => ({
              skills: [],
              refreshedAt: 0,
            })),
            renderCatalog: vi.fn(async () => ""),
          },
        },
      },
      toolSources: {
        resolve: vi.fn(async () => ({
          nativeTools: [],
          mcpEntries: [],
          threadGoalTools: [],
          cuRuntimeAvailable: false,
        })),
      },
      inputPreparation: {
        reminders: {
          buildSystem: vi.fn(async () => ({ content: "" })),
        },
      },
      runner: {},
      executor: { reportFailure: vi.fn() },
    } as never,
    generatedAssets: {
      compressModelImage: vi.fn(() => undefined),
      registerGeneratedAsset: vi.fn(),
      ...generatedAssets,
    },
    promptConfig: { autoUpdate: true },
    promptSnapshots: {
      bind: vi.fn(),
    },
    internalTurnPromptReads: {
      bind: vi.fn(),
    },
    attachmentRegistration: {
      register: vi.fn(async ({ attachments }) => attachments),
      discard: vi.fn(async () => undefined),
      resolveSource: vi.fn(() => undefined),
    },
    channel: {
      finalReplies: { deliver: vi.fn() },
      typing: { start: vi.fn(), end: vi.fn() },
    },
    backgroundTasks: {
      bindRuntimeOwner: vi.fn(),
      recover: vi.fn(async () => undefined),
      pollRecovery: vi.fn(async () => false),
    },
    conversation: {
      bind: async (service) => {
        mocked.conversationBindings.push(service);
        mocked.events.push("conversation:bind");
      },
      fail: vi.fn(),
      shutdown: (error) => mocked.conversationShutdowns.push(error),
    },
    events,
    safety: {
      review: vi.fn(async () => ({ pass: true })),
    },
    greeting: {
      canSend: vi.fn(() => false),
      sendSystemReminder: vi.fn(),
    },
    questionnaires: {
      resolveLocale: vi.fn(() => "en-US"),
      createService: () => mocked.questionnaireService as never,
      bindOwnedAction: (handler, onFailure) => {
        mocked.questionnaireActionBindings.push({ handler, onFailure });
      },
      bindRequestAdmission: vi.fn(),
    },
    sessionV2: {
      bindSessionPinReader: vi.fn(),
      legacyMigration: {
        primaryAgentName: "mavis",
        assets: {
          register: vi.fn(),
        },
      },
      canvasAssets: {
        importDeliverable: vi.fn(async () => undefined),
        importExternal: vi.fn(async () => undefined),
        resolve: vi.fn(async () => undefined),
      },
      diff: {
        capability: {} as never,
        rewind: {} as never,
        inputNavigation: {
          listSessionDiffs: vi.fn(async () => []),
        },
        pruneExpired: vi.fn(async () => undefined),
        deleteSession: vi.fn(async () => undefined),
      },
      communication: {
        deleteSession: vi.fn(async () => undefined),
      },
      channelBindings: {
        listSessionIds: vi.fn(async () => []),
        deleteSession: vi.fn(async () => undefined),
      },
      questionnaires: {
        copyPendingForFork: vi.fn(async () => undefined),
        deleteSession: vi.fn(async () => undefined),
      },
      permissions: {
        copyForFork: vi.fn(async () => undefined),
        deleteSession: vi.fn(async () => undefined),
      },
      goals: {
        deleteSession: vi.fn(async () => undefined),
        getBySession: vi.fn(async () => undefined),
        classifyQueuedItem: vi.fn(async () => "ready" as const),
        pauseActiveForAbort: vi.fn(async () => undefined),
      },
      workspace: {
        defaultDirectory: () => "/workspace",
      },
    },
    mcp: {
      enableLiveMcp: false,
      builtinMatrix: false,
      matrixWebSearchOnly: false,
    },
    plugin: {
      dataDir: "/tmp/plugin",
      authContextGetter: () => undefined,
      fetchImpl: globalThis.fetch,
      metrics: {} as never,
      skill: {} as never,
      standaloneSkillIdentities: async () => ({
        names: new Set(),
        sourceUrls: new Set(),
      }),
    },
  };
}

interface CronDeliveryInput {
  readonly cronId: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly text: string;
}

describe("runtime services Agent reference projection", () => {
  type AgentReferenceResolver = (requestRef: string) => Promise<unknown>;

  const resetAgentGet = () => {
    mocked.agentService.get.mockReset();
    mocked.agentService.get.mockResolvedValue(undefined as never);
  };

  beforeEach(resetAgentGet);
  afterEach(resetAgentGet);

  async function composeAgentReferenceResolver(
    compatibility: V1ServiceCompatibility,
  ): Promise<{
    readonly services: RuntimeServices;
    readonly resolve: AgentReferenceResolver;
  }> {
    const services = await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility,
      agentService: localAgentService,
    });
    const product = mocked.agentHostOptions?.["product"] as
      | {
          readonly inputPreparation: {
            readonly agentReferenceProjection: {
              readonly resolveAgentReference: AgentReferenceResolver;
            };
          };
        }
      | undefined;
    if (!product) {
      await services.close();
      throw new Error("Agent reference projection was not composed.");
    }
    return {
      services,
      resolve:
        product.inputPreparation.agentReferenceProjection.resolveAgentReference,
    };
  }

  it("reads a trusted display name only after authorization", async () => {
    const compatibility = defaultCompatibility();
    const resolveDelegatable = vi.mocked(
      compatibility.agentReferences.resolveDelegatable,
    );
    const order: string[] = [];
    resolveDelegatable.mockImplementation(async (requestRef) => {
      order.push(`authorize:${requestRef}`);
      return "authorized";
    });
    mocked.agentService.get.mockImplementation(async () => {
      order.push("read");
      return { displayName: "马来 / 两个圈" } as never;
    });
    const { services, resolve } =
      await composeAgentReferenceResolver(compatibility);

    try {
      await expect(resolve("agent:9007199254740993123")).resolves.toEqual({
        status: "authorized",
        trustedDisplayName: "马来 / 两个圈",
      });
      expect(order).toEqual(["authorize:agent:9007199254740993123", "read"]);
      expect(mocked.agentService.get).toHaveBeenCalledWith(
        "agent:9007199254740993123",
      );
    } finally {
      await services.close();
    }
  });

  it("does not read an Agent when delegation is denied", async () => {
    const compatibility = defaultCompatibility();
    vi.mocked(
      compatibility.agentReferences.resolveDelegatable,
    ).mockResolvedValue("unauthorized");
    const { services, resolve } =
      await composeAgentReferenceResolver(compatibility);

    try {
      await expect(resolve("agent:9007199254740993123")).resolves.toBe(
        "unauthorized",
      );
      expect(mocked.agentService.get).not.toHaveBeenCalled();
    } finally {
      await services.close();
    }
  });

  it("keeps authorization when the trusted Agent read fails", async () => {
    const compatibility = defaultCompatibility();
    mocked.agentService.get.mockRejectedValue(new Error("Agent read failed"));
    const { services, resolve } =
      await composeAgentReferenceResolver(compatibility);

    try {
      await expect(resolve("agent:9007199254740993123")).resolves.toEqual({
        status: "authorized",
      });
    } finally {
      await services.close();
    }
  });

  it("keeps authorization when the trusted display name is blank", async () => {
    const compatibility = defaultCompatibility();
    mocked.agentService.get.mockResolvedValue({ displayName: "  " } as never);
    const { services, resolve } =
      await composeAgentReferenceResolver(compatibility);

    try {
      await expect(resolve("agent:9007199254740993123")).resolves.toEqual({
        status: "authorized",
      });
    } finally {
      await services.close();
    }
  });
});

describe("runtime services primary family execution identity", () => {
  interface ComposedAgentSources {
    readonly agents: {
      getExecutionSnapshot(
        agentName: string,
        context?: { sessionId: string; sessionKind?: "task" },
      ): Promise<
        | {
            readonly agentName: string;
            readonly executionOwnerName?: string;
            readonly resourceAgentName?: string;
            readonly displayName?: string;
            readonly agentRole?: string;
            readonly metadata?: Record<string, unknown>;
          }
        | undefined
      >;
    };
    readonly preparation: {
      readonly configBuilder: {
        readonly profile: {
          render(input: {
            readonly session: unknown;
            readonly agent: unknown;
            readonly isSessionFirstTurn: boolean;
          }): Promise<unknown>;
        };
      };
    };
  }

  function view(
    name: string,
    displayName: string,
    canonicalViewName = "mavis",
  ) {
    return {
      exactOwnerName: name,
      requestRef: canonicalViewName,
      canonicalViewName,
      resolvedAgentName: canonicalViewName,
      agentRole: "orchestrator",
      creationSource: "builtin" as const,
      displayName,
    };
  }

  async function composeAgentSources(
    logger = noopLogger,
  ): Promise<ComposedAgentSources> {
    await createRuntimeServices({
      db: {} as AppDb,
      dataDir: "/data",
      logger,
      scheduler: {} as SchedulerClient,
      eventBus: new EventBus<GlobalEvent>(),
      compatibility: defaultCompatibility(),
      agentService: localAgentService,
    });
    return mocked.agentHostOptions?.[
      "product"
    ] as unknown as ComposedAgentSources;
  }

  function primaryFamilyViews(canonicalDisplayName: string): void {
    mocked.agentService.getPersistedOwnerForFrozenTask.mockImplementation(
      async (name) =>
        name === "mavis"
          ? view("mavis", canonicalDisplayName)
          : name === "main"
            ? view("main", "Legacy Main")
            : undefined,
    );
    mocked.agentService.resolvePrimaryExecutionIdentity.mockImplementation(
      async (name) => ({
        storageOwnerName: name,
        executionOwnerName: "mavis",
        outcome: "canonical" as const,
      }),
    );
  }

  it("binds Task Session definition reads into the production execution source", async () => {
    mocked.sessionSystem.sessions.records.ensureSessionAgentDefinition.mockResolvedValueOnce(
      {
        sessionId: "saved-session",
        definition: {
          definitionVersion: 2,
          exactOwnerName: "deleted-agent",
          ownerInstanceId: "old-instance",
          systemPrompt: "saved prompt",
          capabilities: {
            tools: [],
            mcpServers: [],
            skills: [],
            extensionSkills: [],
          },
          model: { providerId: "minimax", modelId: "MiniMax-M3" },
          project: { workspaceDir: "/workspace", isDefaultWorkspace: false },
        },
      },
    );
    const sources = await composeAgentSources();
    await expect(
      sources.agents.getExecutionSnapshot("deleted-agent", {
        sessionId: "saved-session",
        sessionKind: "task",
      }),
    ).resolves.toMatchObject({
      agentName: "deleted-agent",
      systemPrompt: "saved prompt",
    });
    expect(
      mocked.sessionSystem.sessions.records.ensureSessionAgentDefinition,
    ).toHaveBeenCalledWith("saved-session");
    expect(
      mocked.agentService.getPersistedOwnerForFrozenTask,
    ).not.toHaveBeenCalled();
  });

  it("keeps the main storage owner while sourcing identity from canonical mavis", async () => {
    primaryFamilyViews("Mavis Canonical");
    const info = vi.fn();
    const sources = await composeAgentSources({ ...noopLogger, info });

    await expect(
      sources.agents.getExecutionSnapshot("main"),
    ).resolves.toMatchObject({
      agentName: "main",
      executionOwnerName: "mavis",
      resourceAgentName: "mavis",
      displayName: "Mavis Canonical",
      metadata: { requestRef: "mavis", canonicalViewName: "mavis" },
    });
    await expect(
      sources.agents.getExecutionSnapshot("mavis"),
    ).resolves.toMatchObject({
      agentName: "mavis",
      executionOwnerName: "mavis",
      resourceAgentName: "mavis",
      displayName: "Mavis Canonical",
    });
    expect(info).toHaveBeenCalledWith(
      { storage_owner: "main", execution_owner: "mavis", outcome: "canonical" },
      "primary_agent_execution_identity",
    );
  });

  it("renders the Turn profile from the resolved execution owner, not the storage owner", async () => {
    primaryFamilyViews("Mavis Canonical");
    mocked.agentService.renderProfile.mockResolvedValue({
      requestRef: "mavis",
      resourceReadRef: "mavis",
      exactOwnerName: "mavis",
      canonicalViewName: "mavis",
      resolvedAgentName: "mavis",
      agentRole: "orchestrator",
      creationSource: "builtin",
      surface: "interactive",
      memoryReadAgentNames: ["mavis", "main"],
      corePrompt: "core",
      surfacePrompt: "surface",
      capabilityCeiling: {
        personaEnabled: true,
        features: { mavis: true, delegation: true, webSearch: true },
      },
      provenance: {
        source: "builtin",
        assetAgentName: "mavis",
        locale: "en-US",
      },
    } as never);
    const sources = await composeAgentSources();
    const snapshot = await sources.agents.getExecutionSnapshot("main");

    await expect(
      sources.preparation.configBuilder.profile.render({
        session: {
          sessionId: "session-1",
          sessionType: "root",
          sessionKind: "conversation",
        },
        agent: snapshot,
        isSessionFirstTurn: true,
      }),
      // Memory keeps reading the whole trusted family; behaviour does not.
    ).resolves.toMatchObject({ memoryReadAgentNames: ["mavis", "main"] });

    expect(mocked.agentService.renderProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        exactOwnerName: "mavis",
        requestRef: "mavis",
        capabilities: undefined,
      }),
    );
  });

  it("leaves every non-primary Agent executing as its own persisted row", async () => {
    mocked.agentService.getPersistedOwnerForFrozenTask.mockImplementation(
      async (name) =>
        name === "explore" ? view("explore", "Explore", "explore") : undefined,
    );
    const info = vi.fn();
    const sources = await composeAgentSources({ ...noopLogger, info });

    await expect(
      sources.agents.getExecutionSnapshot("explore"),
    ).resolves.toMatchObject({
      agentName: "explore",
      executionOwnerName: "explore",
    });
    expect(info).not.toHaveBeenCalled();
  });
});
