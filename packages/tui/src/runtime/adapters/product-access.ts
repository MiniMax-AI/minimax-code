import { isLegacyManagedMinimaxProvider } from "@mavis/config";
import {
  normalizeTuiPermissionMode,
  type TuiPermissionMode,
} from "../../application/permission-mode.js";
import type {
  TuiAccountStatus,
  TuiAccountStatusOptions,
  TuiActiveRunSnapshot,
  TuiAdvisor,
  TuiAdvisorSelection,
  TuiCompactionResult,
  TuiContextSnapshotResponse,
  TuiInstructionSource,
  TuiMcpAuthClearResult,
  TuiMcpAuthOutcome,
  TuiMcpAuthScope,
  TuiMcpAuthStartResult,
  TuiMcpAuthStateView,
  TuiMcpAuthTarget,
  TuiMcpServer,
  TuiProjectMcpPreview,
  TuiModel,
  TuiModelSelection,
  TuiRuntimeDiagnostics,
  TuiSessionUsage,
  TuiSessionUsageSummary,
  TuiSkillList,
} from "../port.js";
import type { TuiRuntimeAccessContext } from "./access-context.js";
import type {
  McodeCreateProviderInput,
  McodeCodexOAuthStartResult,
  McodeCodexOAuthLoginOptions,
  McodeCodexOAuthStatus,
  McodeMiniMaxModelSource,
  McodeProviderTemplate,
  McodeProviderTestResult,
  McodeRuntimeProviderView,
  McodeSaveProviderCandidateInput,
  McodeSaveProviderCandidateResult,
  McodeUpdateProviderInput,
} from "../../provider/contract.js";
import {
  normalizeAccountStatus,
  normalizeRuntimeDiagnostics,
} from "./normalizers.js";
import { projectTuiContextSnapshot } from "../projections/context-snapshot.js";

export class TuiProductAccess {
  constructor(
    private readonly context: TuiRuntimeAccessContext,
    private readonly defaultAgentName: string,
    private readonly workspaceDir?: string,
  ) {}

  async getAccountStatus(
    sessionId?: string,
    options?: TuiAccountStatusOptions,
  ): Promise<TuiAccountStatus> {
    return normalizeAccountStatus(
      await this.context.service("runtime.account").getAccountStatus({
        ...(sessionId ? { sessionId } : {}),
        ...(options?.model
          ? { model: `${options.model.providerId}/${options.model.modelId}` }
          : {}),
      }),
    );
  }

  async getRuntimeDiagnostics(): Promise<TuiRuntimeDiagnostics> {
    return normalizeRuntimeDiagnostics(
      await this.context.service("runtime.diagnostics").getRuntimeDiagnostics(),
    );
  }

  getInstructionSources(
    workspaceDir: string,
  ): Promise<readonly TuiInstructionSource[]> {
    return this.context
      .service("runtime.instructions")
      .getInstructionSources({ workspaceDir });
  }

  async getPermissionMode(): Promise<TuiPermissionMode | undefined> {
    return normalizeTuiPermissionMode(
      await this.context.service("config.permission.read").getPermissionMode(),
    );
  }

  async setPermissionMode(mode: TuiPermissionMode): Promise<TuiPermissionMode> {
    return (
      normalizeTuiPermissionMode(
        await this.context
          .service("config.permission.write")
          .setPermissionMode({ mode }),
      ) ?? mode
    );
  }

  /** Undefined when this Runtime cannot read the switch. */
  async getPromptSuggestionEnabled(): Promise<boolean | undefined> {
    return this.context.service('config.prompt-suggestion.read').getPromptSuggestionEnabled();
  }

  /** Undefined when this Runtime cannot persist the switch. */
  async setPromptSuggestionEnabled(enabled: boolean): Promise<boolean | undefined> {
    return this.context
      .service('config.prompt-suggestion.write')
      .setPromptSuggestionEnabled(enabled);
  }

  /** Undefined when this Runtime cannot read the switch. */
  async getAdvisorEnabled(): Promise<boolean | undefined> {
    return this.context.service('config.advisor.read').getAdvisorEnabled();
  }

  /** Undefined when this Runtime cannot persist the switch. */
  async setAdvisorEnabled(enabled: boolean): Promise<boolean | undefined> {
    return this.context.service('config.advisor.write').setAdvisorEnabled(enabled);
  }

  /** Undefined when this Runtime cannot read the switch. */
  async getPtcEnabled(): Promise<boolean | undefined> {
    return this.context.service('config.ptc.read').getPtcEnabled();
  }

  /** Undefined when this Runtime cannot persist the switch. */
  async setPtcEnabled(enabled: boolean): Promise<boolean | undefined> {
    return this.context.service('config.ptc.write').setPtcEnabled(enabled);
  }

  async listModels(sessionId?: string): Promise<TuiModel[]> {
    const service = this.context.service("model.list");
    const request = { ...(sessionId ? { sessionId } : {}) };
    return (await service.listModels(request)).map(projectTuiModelCatalogEntry);
  }

  async selectModel(
    model: TuiModelSelection,
    sessionId?: string,
  ): Promise<boolean> {
    const service = this.context.service("model.select");
    const request = modelRequest(model);
    if (!sessionId) return service.selectModel(request);

    const savedAsDefault = await service.selectModel(request);
    if (!savedAsDefault) return false;
    return this.selectSessionModel(model, sessionId);
  }

  setModelFavorite(
    model: TuiModelSelection,
    favorite: boolean,
  ): Promise<boolean> {
    return this.context.service("model.favorite").setModelFavorite({
      providerId: model.providerId,
      modelId: model.modelId,
      favorite,
    });
  }

  selectSessionModel(
    model: TuiModelSelection,
    sessionId: string,
  ): Promise<boolean> {
    return this.context.service("model.select").selectModel({
      ...modelRequest(model),
      sessionId,
    });
  }

  getAdvisor(sessionId?: string): Promise<TuiAdvisor> {
    return this.context
      .service('model.advisor.read')
      .getAdvisor({ ...(sessionId ? { sessionId } : {}) });
  }

  /** Same order as `selectModel`: the default first, so a rejected default leaves the Session alone. */
  async selectAdvisor(selection: TuiAdvisorSelection, sessionId?: string): Promise<TuiAdvisor> {
    const saved = await this.context
      .service('model.advisor.select')
      .selectAdvisor(advisorRequest(selection));
    if (!sessionId) return saved;
    return this.selectSessionAdvisor(selection, sessionId);
  }

  selectSessionAdvisor(selection: TuiAdvisorSelection, sessionId: string): Promise<TuiAdvisor> {
    return this.context.service('model.advisor.select').selectAdvisor({
      ...advisorRequest(selection),
      sessionId,
    });
  }

  async listUserModelProviders(): Promise<readonly McodeRuntimeProviderView[]> {
    const providers = (await this.context
      .service("provider.list")
      .listUserModelProviders()) as unknown as readonly McodeRuntimeProviderView[];
    return providers.filter(
      (provider) =>
        !isLegacyManagedMinimaxProvider(provider.providerId, provider.baseUrl),
    );
  }

  async listProviderPresets(): Promise<readonly McodeProviderTemplate[]> {
    return (await this.context
      .service("provider.presets")
      .listProviderPresets()) as readonly McodeProviderTemplate[];
  }

  async getCodexOAuthStatus(): Promise<McodeCodexOAuthStatus> {
    return (await this.context
      .service("provider.codex-oauth.status")
      .getCodexOAuthStatus()) as McodeCodexOAuthStatus;
  }

  async startCodexOAuthLogin(
    options?: McodeCodexOAuthLoginOptions,
  ): Promise<McodeCodexOAuthStartResult> {
    return (await this.context
      .service("provider.codex-oauth.start")
      .startCodexOAuthLogin(options)) as McodeCodexOAuthStartResult;
  }

  async cancelCodexOAuthLogin(loginId: string): Promise<McodeCodexOAuthStatus> {
    return (await this.context
      .service("provider.codex-oauth.cancel")
      .cancelCodexOAuthLogin(loginId)) as McodeCodexOAuthStatus;
  }

  async getMiniMaxApiKeyStatus(): Promise<{
    readonly hasApiKey: boolean;
    readonly maskedApiKey?: string;
    readonly cachedStatus?: McodeProviderTestResult["status"];
  }> {
    return (await this.context
      .service("provider.minimax.status")
      .getMiniMaxApiKeyStatus()) as {
      hasApiKey: boolean;
      maskedApiKey?: string;
      cachedStatus?: McodeProviderTestResult["status"];
    };
  }

  getMiniMaxModelSource(): Promise<McodeMiniMaxModelSource> {
    return this.context
      .service("provider.minimax.source")
      .getMiniMaxModelSource();
  }

  setMiniMaxModelSource(
    source: McodeMiniMaxModelSource,
  ): Promise<McodeMiniMaxModelSource> {
    return this.context
      .service("provider.minimax.source")
      .setMiniMaxModelSource({ source });
  }

  async upsertMiniMaxApiKey(input: {
    readonly apiKey: string;
    readonly saveAndUse?: boolean;
  }): Promise<void> {
    await this.context
      .service("provider.minimax.upsert")
      .upsertMiniMaxApiKey(input);
  }

  async createUserModelProvider(
    input: McodeCreateProviderInput,
  ): Promise<void> {
    await this.context.service("provider.create").createUserModelProvider({
      ...input,
      models: [...input.models],
    });
  }

  discoverUserModelsCandidate(
    input: import("../../provider/contract.js").McodeDiscoverProviderModelsInput,
  ) {
    return this.context
      .service("provider.discover")
      .discoverUserModelsCandidate(input);
  }

  async saveUserModelProviderCandidate({
    modelId,
    saveAndUse,
    skipConnectionTest,
    ...candidate
  }: McodeSaveProviderCandidateInput): Promise<McodeSaveProviderCandidateResult> {
    return (await this.context
      .service("provider.save-candidate")
      .saveUserModelProviderCandidate({
        candidate: {
          ...candidate,
          ...(candidate.models
            ? { models: candidate.models.map((model) => ({ ...model })) }
            : {}),
        },
        modelId,
        ...(skipConnectionTest !== undefined ? { skipConnectionTest } : {}),
        ...(saveAndUse !== undefined ? { saveAndUse } : {}),
      })) as McodeSaveProviderCandidateResult;
  }

  async updateUserModelProvider(
    input: McodeUpdateProviderInput,
  ): Promise<void> {
    await this.context.service("provider.update").updateUserModelProvider({
      ...input,
      ...(input.models ? { models: [...input.models] } : {}),
    });
  }

  async deleteUserModelProvider(providerId: string): Promise<void> {
    await this.context
      .service("provider.delete")
      .deleteUserModelProvider({ providerId });
  }

  async testUserModelProvider(
    providerId: string,
  ): Promise<McodeProviderTestResult> {
    return (await this.context
      .service("provider.test")
      .testUserModelProvider({ providerId })) as McodeProviderTestResult;
  }

  async testUserModel(
    providerId: string,
    modelId: string,
  ): Promise<McodeProviderTestResult> {
    return (await this.context
      .service("provider.test-model")
      .testUserModel({ providerId, modelId })) as McodeProviderTestResult;
  }

  async getSessionUsage(sessionId: string): Promise<TuiSessionUsage> {
    const response = await this.context
      .service("session.usage")
      .getSessionUsage({ id: sessionId });
    return {
      summary: response.summary,
      rows: response.rows,
    } as TuiSessionUsage;
  }

  async getSessionUsageSummary(
    sessionId: string,
  ): Promise<TuiSessionUsageSummary> {
    return (await this.context
      .service("session.usage-summary")
      .getSessionUsageSummary({ id: sessionId })) as TuiSessionUsageSummary;
  }

  async requestCompaction(
    sessionId: string,
    agentName = this.defaultAgentName,
    customInstructions?: string,
    reason = 'ui_request',
  ): Promise<TuiCompactionResult> {
    const response = await this.context.service('session.compaction').requestCompaction({
      name: agentName,
      id: sessionId,
      reason,
      ...(customInstructions ? { customInstructions } : {}),
    });
    return {
      ...response,
      ...(response.tokensBefore !== undefined
        ? { tokensBefore: Number(response.tokensBefore) }
        : {}),
      ...(response.tokensAfter !== undefined
        ? { tokensAfter: Number(response.tokensAfter) }
        : {}),
    };
  }

  async getContextSnapshot(
    sessionId: string,
  ): Promise<TuiContextSnapshotResponse> {
    const service = this.context.service("session.context-snapshot");
    const [sessionResponse, messagesResponse, models] = await Promise.all([
      service.getSession({ id: sessionId }),
      service.getMessages({ id: sessionId, limit: 80 }),
      service.listModels({ sessionId }) as Promise<readonly TuiModel[]>,
    ]);
    const session = sessionResponse.session;
    if (!session)
      throw new Error(`Runtime did not return Session ${sessionId}.`);
    const selected = models.find((model) => model.selected === true);
    const model =
      selected &&
      (selected.providerId !== session.model?.providerId ||
        selected.modelId !== session.model?.modelId)
        ? selected
        : (session.model ?? selected);
    return projectTuiContextSnapshot({
      messages: messagesResponse.messages ?? [],
      active: session.status?.statusType === 1,
      model,
    });
  }

  async getActiveRun(sessionId: string): Promise<TuiActiveRunSnapshot> {
    const service = this.context.service("session.active-run");
    const sessionResponse = await service.getSession({ id: sessionId });
    const session = sessionResponse.session;
    if (!session)
      throw new Error(`Runtime did not return Session ${sessionId}.`);
    const started = session.status?.statusType === 1;
    const [activeTurn, permissions, questionnaire] = started
      ? await Promise.all([
          service.getActiveTurn(sessionId),
          service.listPendingPermissions({}),
          service.getPendingQuestionnaire({
            name: session.agentName ?? this.defaultAgentName,
            sessionId,
          }),
        ])
      : [undefined, { requests: [] }, {}];
    const decisionBlocked =
      started &&
      (questionnaire.request !== undefined ||
        (permissions.requests ?? []).some(
          (request) => request.sessionId === sessionId,
        ));
    const turnId = activeTurn?.turnId;
    const steerable =
      started &&
      !decisionBlocked &&
      activeTurn?.busyReason === "turn" &&
      activeTurn.locallyOwned;
    return {
      schemaVersion: 1,
      sessionId,
      state: started
        ? decisionBlocked
          ? "decision-blocked"
          : "running"
        : session.status?.statusType === 2 || session.status?.statusType === 3
          ? "terminal"
          : "idle",
      ...(turnId ? { turnId } : {}),
      actions: { steer: steerable },
      ...(started && activeTurn?.ownedByOtherRuntime ? { runningElsewhere: true as const } : {}),
    };
  }

  async listSkills(
    agentName = this.defaultAgentName,
    keyword?: string,
    workspaceDir = this.workspaceDir,
  ): Promise<TuiSkillList> {
    const service = this.context.service("skill.list");
    const result = await service.listRuntimeSkills({
      agentName,
      ...(workspaceDir ? { workspaceDir } : {}),
      includePluginSkills: true,
    });
    const normalizedKeyword = keyword?.trim().toLocaleLowerCase();
    const skills = normalizedKeyword
      ? (result.skills ?? []).filter((skill) =>
          `${skill.name} ${skill.displayName ?? ""} ${skill.description ?? ""}`
            .toLocaleLowerCase()
            .includes(normalizedKeyword),
        )
      : (result.skills ?? []);
    return { skills, hasMore: false };
  }

  inspectProjectMcp(
    sessionId: string,
  ): Promise<TuiProjectMcpPreview | undefined> {
    return this.context
      .service("mcp.project.inspect")
      .inspectProjectMcp(sessionId);
  }
  async listMcpServers(
    keyword?: string,
    sessionId?: string,
  ): Promise<TuiMcpServer[]> {
    const request = {
      ...(keyword ? { keyword } : {}),
      ...(sessionId ? { sessionId } : {}),
    };
    const result = await this.context
      .service("mcp.list")
      .listMcpServers(request);
    return result.servers as TuiMcpServer[];
  }
  async listMcpAuthStates(scope: TuiMcpAuthScope = {}): Promise<TuiMcpAuthStateView[]> {
    const result = await this.context.service('mcp.auth.list').listMcpAuthStates(scope);
    return result.states;
  }
  startMcpAuth(
    target: TuiMcpAuthTarget,
    options: { readonly force?: boolean } = {},
  ): Promise<TuiMcpAuthStartResult> {
    return this.context
      .service('mcp.auth.start')
      .startMcpAuth(target, options.force ? { force: true } : {});
  }
  cancelMcpAuth(attemptId: string): Promise<boolean> {
    return this.context.service('mcp.auth.cancel').cancelMcpAuth(attemptId);
  }
  completeMcpAuth(attemptId: string, callbackUrl: string): Promise<TuiMcpAuthOutcome> {
    return this.context.service('mcp.auth.complete').completeMcpAuth(attemptId, callbackUrl);
  }
  clearMcpAuth(target: TuiMcpAuthTarget): Promise<TuiMcpAuthClearResult> {
    return this.context.service('mcp.auth.clear').clearMcpAuth(target);
  }
  setMcpUserClientSecret(serverName: string, secret: string | undefined): Promise<boolean> {
    return this.context
      .service('mcp.auth.client-secret')
      .setMcpUserClientSecret(serverName, secret);
  }
}

function modelRequest(model: TuiModelSelection): {
  providerId: string;
  modelId: string;
  variant?: string;
  contextLimit?: number;
  thinking?: TuiModelSelection["thinking"];
} {
  const effort = model.thinking?.effort?.trim();
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(model.variant !== undefined ? { variant: model.variant } : {}),
    ...(model.contextLimit !== undefined
      ? { contextLimit: model.contextLimit }
      : {}),
    ...(effort ? { thinking: { effort } } : {}),
  };
}

/** A thinking without an effort clears the stored one (`null`); no thinking keeps it. */
function advisorRequest(selection: TuiAdvisorSelection): {
  enabled: boolean;
  providerId?: string;
  modelId?: string;
  thinking?: { effort: string } | null;
  contextLimit?: number;
} {
  const effort = selection.thinking?.effort?.trim();
  return {
    enabled: selection.enabled,
    ...(selection.providerId && selection.modelId
      ? { providerId: selection.providerId, modelId: selection.modelId }
      : {}),
    ...(selection.thinking !== undefined ? { thinking: effort ? { effort } : null } : {}),
    ...(selection.contextLimit !== undefined ? { contextLimit: selection.contextLimit } : {}),
  };
}

function projectTuiModelCatalogEntry(input: unknown): TuiModel {
  const model = input as TuiModel & {
    readonly thinkingConfig?: TuiModel["thinkingConfig"] & {
      readonly default_value?: string;
    };
  };
  const thinkingConfig = model.thinkingConfig;
  if (!thinkingConfig) return model;
  const { default_value: defaultValueSnakeCase, ...fields } = thinkingConfig;
  return {
    ...model,
    thinkingConfig: {
      ...fields,
      ...(fields.defaultValue !== undefined
        ? { defaultValue: fields.defaultValue }
        : defaultValueSnakeCase !== undefined
          ? { defaultValue: defaultValueSnakeCase }
          : {}),
    },
  };
}
