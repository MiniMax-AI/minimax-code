import type {
  GlobalEvent,
  GlobalThreadGoal,
} from "@mavis/shared/global-events";
import type { ThreadGoalAttachment, ThreadGoalPatchInput } from "@mavis/goal";
import type {
  AskQuestionnaireReplyAnswer,
  AskQuestionnaireRequest,
} from "@mavis/shared/questionnaire";
import type { LocalSkillService } from "@mavis/local-runtime";
import type { LocalMcpPublicFacade } from "../../service/mcp/index.js";
import type {
  ListInstalledPluginsInput as ListInstalledPluginsReq,
  ListInstalledPluginsResult as ListInstalledPluginsResp,
  ListMarketplacePluginsInput as ListMarketplacePluginsReq,
  ListMarketplacePluginsResult as ListMarketplacePluginsResp,
  ListRuntimeSkillsInput as ListRuntimeSkillsReq,
  ListRuntimeSkillsResult as ListRuntimeSkillsResp,
  MutatePluginInput as MutatePluginReq,
  MutatePluginResult as MutatePluginResp,
} from "@mavis/protocol/local";
import type { MiniAppSurfaceSummary } from "@mavis/shared/miniapp-surface";
import type { SessionReportManifest } from "../../service/session-system/index.js";
import type {
  ByokProviderPresetView,
  CodexOAuthStartResult,
  CodexOAuthLoginOptions,
  CodexOAuthStatus,
  UserModelInputView,
} from "../../service/model-system/index.js";

export type ProcessLocalModelInput = Omit<UserModelInputView, "modalities"> & {
  modalities?: { input?: readonly string[]; output?: readonly string[] };
};

export interface ProcessLocalMiniAppLaunch {
  readonly miniApp: MiniAppSurfaceSummary;
  /** Main-process-only launch coordinates. Never forward this object to a renderer. */
  readonly launch: {
    readonly origin: string;
    readonly surfacePath: string;
    readonly runId: string;
  };
}

/** Host-owned presentation capability used by the Agent MiniApp control tool. */
export interface MiniAppPresenter {
  open(input: {
    readonly sessionId: string;
    readonly pluginId: string;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  /** Closes every managed native surface for one plugin after its runtime has stopped. */
  close(input: { readonly pluginId: string }): Promise<void>;
}

type LocalRuntimeBackgroundTaskStatus =
  | "queued"
  | "running"
  | "stopping"
  | "succeeded"
  | "failed"
  | "canceled"
  | "lost";

interface LocalRuntimeBackgroundTaskView {
  readonly taskId: string;
  readonly kind: "bash" | "subagent" | "workflow" | "custom";
  readonly status: LocalRuntimeBackgroundTaskStatus;
  readonly ownerSessionId: string;
  readonly description?: string;
  /** Persisted execution metadata, including the full Bash command when available. */
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly deliveredAt?: number;
  readonly lastError?: { readonly message: string };
}

interface LocalRuntimeBackgroundTaskQuery {
  readonly ownerSessionId: string;
  readonly statuses?: readonly LocalRuntimeBackgroundTaskStatus[];
  readonly kinds?: readonly LocalRuntimeBackgroundTaskView["kind"][];
  readonly undeliveredOnly?: boolean;
  readonly limit?: number;
}

/** Internal peripheral Application surface consumed by process-local delivery. */
export interface LocalRuntimeApplication {
  readonly events: {
    watch(signal?: AbortSignal): AsyncGenerator<GlobalEvent>;
  };
  readonly usage?: {
    watchCommits(signal?: AbortSignal): AsyncGenerator<string>;
  };
  readonly skills: Pick<LocalSkillService, "listSkills"> & {
    listRuntimeSkills(
      req: ListRuntimeSkillsReq,
    ): Promise<ListRuntimeSkillsResp>;
  };
  readonly plugins: {
    refresh(): Promise<void>;
    listMarketplacePlugins(
      req: ListMarketplacePluginsReq,
    ): Promise<ListMarketplacePluginsResp>;
    listInstalledPlugins(
      req: ListInstalledPluginsReq,
    ): Promise<ListInstalledPluginsResp>;
    installPlugin(req: MutatePluginReq): Promise<MutatePluginResp>;
    uninstallPlugin(req: MutatePluginReq): Promise<MutatePluginResp>;
    enablePlugin(req: MutatePluginReq): Promise<MutatePluginResp>;
    disablePlugin(req: MutatePluginReq): Promise<MutatePluginResp>;
  };
  readonly miniApps?: {
    list(): Promise<{ readonly miniApps: readonly MiniAppSurfaceSummary[] }>;
    open(input: {
      readonly pluginId: string;
      readonly signal?: AbortSignal;
    }): Promise<ProcessLocalMiniAppLaunch>;
    stop(input: {
      readonly pluginId: string;
      readonly signal?: AbortSignal;
    }): Promise<void>;
  };
  readonly goals?: {
    isEnabled(): boolean;
    get(sessionId: string): Promise<GlobalThreadGoal | undefined>;
    create(input: {
      sessionId: string;
      objective: string;
      tokenBudget?: number | null;
      kickoffAttachments?: readonly ThreadGoalAttachment[];
    }): Promise<GlobalThreadGoal>;
    patch(
      sessionId: string,
      patch: Pick<ThreadGoalPatchInput, "status" | "objective" | "tokenBudget">,
    ): Promise<GlobalThreadGoal>;
    clear(sessionId: string): Promise<boolean>;
  };
  readonly mcp?: Pick<
    LocalMcpPublicFacade,
    | "listLocalMcpServers"
    | "listMcpCapabilities"
    | "configureSessionServers"
    | "clearSessionServers"
    | "inspectProjectMcp"
  >;
  readonly questionnaires?: {
    getPending(input: {
      agentName: string;
      sessionId: string;
    }): Promise<AskQuestionnaireRequest | undefined>;
    getLatestPlanReview(input: {
      agentName: string;
      sessionId: string;
    }): Promise<AskQuestionnaireRequest | undefined>;
    reply(input: {
      agentName: string;
      requestId: string;
      answers: AskQuestionnaireReplyAnswer[];
      submittedAt: number;
    }): Promise<{
      ok: true;
      requestId: string;
      sessionId: string;
      agentName?: string;
      answeredAt: number;
    }>;
    dismiss(input: { agentName: string; requestId: string }): Promise<{
      ok: true;
      requestId: string;
      sessionId: string;
      agentName?: string;
      dismissedAt: number;
    }>;
  };
  readonly plan?: {
    isEntryEnabled(): boolean;
  };
  readonly backgroundTasks?: {
    list(
      input: LocalRuntimeBackgroundTaskQuery,
    ): Promise<readonly LocalRuntimeBackgroundTaskView[]>;
  };
  readonly workspace?: {
    readonly git: {
      getMetadata(workspaceDir: string): Promise<Record<string, unknown>>;
      getReviewLink?(
        workspaceDir: string,
        branch: string,
      ): Promise<Record<string, unknown> | undefined>;
    };
    listFileTree?(input: {
      workspaceDir: string;
      path?: string;
      signal?: AbortSignal;
    }): Promise<readonly unknown[]>;
    searchFiles?(input: {
      workspaceDir: string;
      query: string;
      limit: number;
      signal?: AbortSignal;
    }): Promise<readonly string[]>;
  };
  readonly permissions?: {
    listPending(input?: {
      signal?: AbortSignal;
    }): Promise<readonly LocalRuntimePendingPermission[]>;
    reply(input: {
      requestIds: readonly string[];
      decision: "allowAlways" | "allowOnce" | "deny";
    }): Promise<{ processed: readonly string[]; skipped: readonly string[] }>;
  };
  readonly account?: {
    getStatus(input?: {
      sessionId?: string;
      model?: string;
    }): Promise<Record<string, unknown>>;
  };
  readonly diagnostics?: {
    getRuntimeSnapshot(): Promise<Record<string, unknown>>;
    collectSessionReport?(sessionId: string): Promise<SessionReportManifest>;
  };
  readonly instructions?: {
    listSources(input: {
      workspaceDir: string;
    }): Promise<
      readonly { readonly scope: "global" | "project"; readonly path: string }[]
    >;
  };
  readonly configuration?: {
    getPermissionMode(): Promise<unknown>;
    setPermissionMode(input: {
      mode: "default" | "acceptEdits" | "bypassPermissions" | "auto" | "off";
    }): Promise<unknown>;
  };
  readonly models?: {
    list(input?: { sessionId?: string }): Promise<readonly unknown[]>;
    select(input: {
      providerId: string;
      modelId: string;
      variant?: string;
      sessionId?: string;
    }): Promise<boolean>;
    /** Adds or removes a model favorite; absent when the host has no preference store. */
    setFavorite?(input: {
      providerId: string;
      modelId: string;
      favorite: boolean;
    }): Promise<boolean>;
  };
  readonly modelProviders?: {
    listProviderPresets(): Promise<readonly ByokProviderPresetView[]>;
    getCodexOAuthStatus(): Promise<CodexOAuthStatus>;
    startCodexOAuthLogin(
      options?: CodexOAuthLoginOptions,
    ): Promise<CodexOAuthStartResult>;
    cancelCodexOAuthLogin(loginId: string): Promise<CodexOAuthStatus>;
    listUser(): Promise<readonly Record<string, unknown>[]>;
    getMiniMaxApiKeyStatus(): Promise<Record<string, unknown>>;
    getMiniMaxModelSource(): Promise<"token_plan" | "minimax_api_key">;
    setMiniMaxModelSource(input: {
      source: "token_plan" | "minimax_api_key";
    }): Promise<"token_plan" | "minimax_api_key">;
    upsertMiniMaxApiKey(input: {
      apiKey: string;
      saveAndUse?: boolean;
    }): Promise<unknown>;
    create(input: {
      name?: string;
      baseUrl: string;
      apiKey: string;
      apiFormat?: string;
      models?: readonly ProcessLocalModelInput[];
      saveAndUse?: boolean;
    }): Promise<unknown>;
    discoverCandidate(input: {
      providerId: string;
      expectedRevision: string;
      baseUrl: string;
    }): Promise<readonly { modelId: string; displayName?: string }[]>;
    saveCandidate(input: {
      candidate: {
        providerId?: string;
        expectedRevision?: string;
        name?: string;
        baseUrl: string;
        apiKey?: string;
        apiFormat?: string;
        models?: readonly ProcessLocalModelInput[];
      };
      modelId?: string;
      saveAndUse?: boolean;
      skipConnectionTest?: boolean;
    }): Promise<{
      success: boolean;
      status?: Record<string, unknown>;
      provider?: Record<string, unknown>;
    }>;
    update(input: {
      providerId: string;
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      apiFormat?: string;
      enabled?: boolean;
      models?: readonly ProcessLocalModelInput[];
      saveAndUse?: boolean;
    }): Promise<unknown>;
    delete(input: { providerId: string }): Promise<void>;
    testProvider(input: { providerId: string }): Promise<unknown>;
    testModel(input: { providerId: string; modelId: string }): Promise<unknown>;
  };
}

export interface LocalRuntimePendingPermission {
  readonly requestId: string;
  readonly sessionId: string;
  readonly agentName: string;
  readonly toolName: string;
  readonly ruleContents: readonly string[];
  readonly toolInput?: string;
  readonly toolDescription?: string;
  readonly reason: string;
  readonly allowAlwaysSupported: boolean;
  readonly createdAt: number;
}
