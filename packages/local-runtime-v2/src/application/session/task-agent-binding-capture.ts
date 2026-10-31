import { getRuntimePresetKey, resolveModelAvailability } from '@mavis/config';
import {
  hasConversationTaskModelSelection,
  type ConversationModelThinkingSelection,
  type ConversationModelSelection,
  type ConversationPluginAgentDefinition,
  type ConversationTaskModelSelection,
} from '@mavis/conversation-contract';
import {
  bindPluginAgentMcpSelectors,
  pluginAgentSource,
  renderPluginAgentProfile,
  type CapturedPluginAgentSource,
} from './plugin-agent-capture.js';
import {
  FROZEN_MCP_SERVERS_NONE,
  FROZEN_SELECTOR_VERSION,
  FROZEN_TOOLS_ALL_SCOPE_MARKER,
  type AgentExecutionProfile,
  type LocalAgentService,
} from '../../service/agent/index.js';
import {
  resolveEffectiveAgentModelSelection,
  modelConfigForRef,
  modelRefForModel,
  savedSessionModel,
  parseSourceQualifiedModelKey,
  type AgentModelSelectionInput,
  type AgentModelSelectionSource,
  type LocalConversationRuntimeConfig,
  type ResolvedAgentModelSelection,
} from '../../service/model-system/index.js';
import { toLegacyTaskSessionBinding } from '../../service/session-system/index.js';
import type {
  CapturedTaskAgentBinding,
  FrozenAgentExecutionDefinition,
  LegacyFrozenAgentExecutionDefinition,
  SessionRecord,
  SessionAgentDefinitionBackfill,
  SessionTaskAgentBindingBackfill,
} from '../../service/session-system/index.js';
import {
  filterLocalTurnCapabilityInventory,
  isAgentSelectorMcpToolName,
  resolveToolsAllowlistScope,
  resolveAgentPromptSurface,
  type AgentHostTurnCapabilityView,
  type LocalTurnAgentProfileFacts,
  type LocalTurnRawToolSources,
} from '../../service/turn-system/index.js';

/** One atomic-create payload for every Task Session, owned by Session record creation. */
export interface TaskAgentBindingCaptureCoordinator {
  capture(input: TaskAgentBindingCaptureInput): Promise<CapturedTaskAgentBinding>;
  captureSessionDefinition(
    input: TaskAgentBindingCaptureInput,
  ): Promise<SessionAgentDefinitionBackfill>;
  captureFrozenDefinition(
    input: TaskAgentBindingCaptureInput,
  ): Promise<SessionTaskAgentBindingBackfill>;
}

interface TaskAgentBindingCaptureInput {
  readonly agentName: string;
  /** The Session being frozen. V1 callers may provide only `parent`. */
  readonly session?: SessionRecord;
  readonly parent?: SessionRecord;
  readonly appMode?: SessionRecord['appMode'];
  readonly taskModelSelection?: ConversationTaskModelSelection;
  readonly requestedModel?: ConversationModelSelection;
  readonly parentModel?: FrozenAgentExecutionDefinition['model'];
  /** A V1 mirror whose prompt and capability snapshot is authoritative. */
  readonly legacyDefinition?: LegacyFrozenAgentExecutionDefinition;
  /** Trusted Plugin Agent from the parent Turn lease; replaces Agent row lookup. */
  readonly pluginAgent?: ConversationPluginAgentDefinition;
}

export interface TaskAgentBindingCaptureOptions {
  readonly agentService: LocalAgentService;
  readonly config: () => LocalConversationRuntimeConfig;
  /** Ready Desktop inventories captured at creation, never re-derived from a later Turn. */
  readonly inventory: TaskAgentCapabilityInventory;
  /** Bounded catalog-limit facts; no Agent file body or credentials are emitted. */
  readonly diagnostics?: {
    info?(fields: Readonly<Record<string, unknown>>, message?: string): void;
  };
  readonly runtimeOwnerKind?: string;
  readonly capabilityProfile?: 'cli';
}

export interface TaskAgentCapabilityInventory {
  capture(input: {
    readonly session: SessionRecord;
    readonly profile: AgentExecutionProfile;
  }): Promise<TaskAgentReadyCapabilityInventory>;
}

interface TaskAgentReadyCapabilityInventory {
  readonly sources: LocalTurnRawToolSources;
  readonly desktopCapabilities?: AgentHostTurnCapabilityView;
  readonly skills: readonly { readonly name: string; readonly sourceType?: number }[];
}

/** Captures an immutable V2 Agent definition before the Session row is inserted. */
export function createTaskAgentBindingCaptureCoordinator(
  options: TaskAgentBindingCaptureOptions,
): TaskAgentBindingCaptureCoordinator {
  return {
    capture: async (input) => {
      const captured = await captureDefinition(options, input, false);
      return {
        agentDefinition: captured.agentDefinition,
        taskAgentBinding: captured.legacyTaskBinding,
        effectiveModel: captured.effectiveModel,
        ...(captured.effectiveModelVariant !== undefined
          ? { effectiveModelVariant: captured.effectiveModelVariant }
          : {}),
        ...(captured.effectiveModelThinking
          ? { effectiveModelThinking: captured.effectiveModelThinking }
          : {}),
        ...(captured.effectiveModelContextWindow === undefined
          ? {}
          : { effectiveModelContextWindow: captured.effectiveModelContextWindow }),
        ...(captured.effectiveModelMaxOutputTokens === undefined
          ? {}
          : { effectiveModelMaxOutputTokens: captured.effectiveModelMaxOutputTokens }),
      };
    },
    captureSessionDefinition: async (input) => {
      const captured = await captureDefinition(options, input, true);
      return { agentDefinition: captured.agentDefinition };
    },
    captureFrozenDefinition: async (input) => captureLegacyTaskBinding(options, input),
  };
}

async function captureDefinition(
  options: TaskAgentBindingCaptureOptions,
  input: TaskAgentBindingCaptureInput,
  historical: boolean,
) {
  const session = input.session ?? input.parent;
  if (!session) throw new Error('Session Agent definition capture requires a Session.');
  const config = options.config();
  const profile = await renderCaptureProfile({ options, config, session, input, historical });
  const frozenSurface = input.legacyDefinition ?? {
    systemPrompt: profile.agentSystemPrompt ?? '',
    ...(profile.promptSnapshot ? { promptSnapshot: profile.promptSnapshot } : {}),
    capabilities: await freezeCapturedCapabilities(options, session, profile, input.pluginAgent),
  };
  const selection = resolveCapturedModel({
    config,
    profile,
    session,
    input,
    historical,
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
  });
  logTaskModelDiagnostics(options.diagnostics, selection.diagnostics);
  const effectiveModel = `${selection.providerId}/${selection.modelId}`;
  const variant = resolvedModelVariant({ selection, session, parent: input.parent });
  const thinking = resolvedThinkingSelection({ selection, session, parent: input.parent });
  return buildCapturedDefinition({
    profile,
    frozenSurface,
    session,
    selection,
    effectiveModel,
    variant,
    thinking,
    ...(await captureOwnerFields(options, profile, input.pluginAgent)),
  });
}

async function freezeCapturedCapabilities(
  options: TaskAgentBindingCaptureOptions,
  session: SessionRecord,
  profile: AgentExecutionProfile,
  pluginAgent: ConversationPluginAgentDefinition | undefined,
) {
  const ready = await options.inventory.capture({ session, profile });
  const bindings = ready.desktopCapabilities?.runtimeToolBindings ?? [];
  const inventoryToolNames = [
    ...ready.sources.nativeTools,
    ...ready.sources.mcpEntries.map(({ tool }) => tool),
    ...ready.sources.threadGoalTools,
    ...(ready.desktopCapabilities?.runtimeTools ?? []),
  ].map((tool) => tool.def.name);
  return freezeSelectorCapabilities(
    bindPluginAgentMcpSelectors(profile, pluginAgent, bindings, inventoryToolNames),
    ready,
    // Decided from the list the author wrote: rebinding may replace a Plugin's
    // `mcp__*` selectors with nothing, which must not turn it into a native list.
    resolveToolsAllowlistScope(profile.configSelection?.tools),
  );
}

async function renderCaptureProfile(input: {
  readonly options: TaskAgentBindingCaptureOptions;
  readonly config: LocalConversationRuntimeConfig;
  readonly session: SessionRecord;
  readonly input: TaskAgentBindingCaptureInput;
  readonly historical: boolean;
}): Promise<AgentExecutionProfile> {
  const { options, config, session } = input;
  const pluginAgent = input.input.pluginAgent;
  if (!pluginAgent) {
    return renderSessionProfile({
      options,
      config,
      agentName: input.input.agentName,
      session,
      appMode: input.input.appMode,
      legacyTaskSurface: input.input.session === undefined,
    });
  }
  if (input.historical || input.input.session?.sessionKind !== 'task' || !input.input.parent) {
    throw new Error('Plugin Agent definitions are captured only for new Task Sessions.');
  }
  return renderPluginAgentProfile({
    agentService: options.agentService,
    agent: pluginAgent,
    request: profileRequest(options, config, session, input.input.appMode),
  });
}

/** Plugin Agents have no Agent row, so they carry their source instead of an instance id. */
async function captureOwnerFields(
  options: TaskAgentBindingCaptureOptions,
  profile: AgentExecutionProfile,
  pluginAgent: TaskAgentBindingCaptureInput['pluginAgent'],
): Promise<{ ownerInstanceId?: string; pluginSource?: CapturedPluginAgentSource }> {
  if (pluginAgent) return { pluginSource: pluginAgentSource(pluginAgent) };
  const ownerInstanceId = await captureOwnerInstanceId(options.agentService, profile);
  return ownerInstanceId ? { ownerInstanceId } : {};
}

function resolveCapturedModel(input: {
  readonly config: LocalConversationRuntimeConfig;
  readonly profile: AgentExecutionProfile;
  readonly session: SessionRecord;
  readonly input: TaskAgentBindingCaptureInput;
  readonly historical: boolean;
  readonly diagnostics?: TaskAgentBindingCaptureOptions['diagnostics'];
}): ResolvedAgentModelSelection {
  const historical = input.historical ? historicalModelSelection(input.session) : undefined;
  const requested = input.input.requestedModel;
  if (
    requested?.providerId === 'minimax' &&
    requested.modelId &&
    input.config.minimaxModelSource !== 'minimax_api_key'
  ) {
    // Validate public effort before the Agent's legacy on/off conversion can consume it.
    modelRefForModel(
      requested.providerId,
      requested.modelId,
      modelConfigForRef(input.config, requested.providerId, requested.modelId),
      {
        managed: true,
        variant: requested.variant,
        reasoning: requested.reasoning,
        contextLimit: requested.contextLimit,
        thinking: requested.thinking,
      },
    );
  }
  const resolved =
    historical ??
    resolveEffectiveAgentModelSelection({
      config: input.config,
      sources: modelSources({
        profile: input.profile,
        session: input.session,
        parent: input.input.parent,
        taskModelSelection: input.input.taskModelSelection,
        parentModel: input.input.parentModel,
        requestedModel:
          input.config.minimaxModelSource !== 'minimax_api_key'
            ? input.input.requestedModel
            : undefined,
        legacyTaskCapture: input.input.session === undefined,
        ignoreSessionModel: input.historical,
      }),
    });
  if (!resolved) throw new Error('No runtime or Agent model is configured.');
  // `historical` marks a *describing* capture, not a running one: it completes
  // or upgrades the frozen definition of an already-existing Session, always
  // via `captureSessionDefinition` -> `ensureSessionAgentDefinition`. That runs
  // whenever a Task Session's definition is absent or still V1 legacy, which is
  // reached from several places — the startup backfill sweep
  // (`backfillSessionAgentDefinitionForStartup`), on-demand backfill during
  // execution preparation (`execution-source.ts`,
  // `local-agent-config-builder.readOrBackfillTaskBinding`) and fork copying
  // (`fork/data-capability.ts`). So this branch is NOT startup-only.
  //
  // It stays exempt because describing a historical Session must succeed even
  // when the model it recorded has since been retired: the alternative is that
  // one removed model makes an old Session permanently unopenable, and the
  // startup sweep unable to finish. Availability is an *execution* concern and
  // belongs after a frozen definition is read for a turn, not here.
  //
  // The branch below is the live path (`capture`), where the Session's saved
  // model flows through `modelSources` and an unusable model is rejected during
  // preparation, before any provider request is made.
  if (!historical) {
    const availability = resolveModelAvailability({
      config: input.config,
      providerId: resolved.providerId,
      modelId: resolved.modelId,
      preset: getRuntimePresetKey(),
      source: 'config_default',
    });
    if (!availability.available) {
      input.diagnostics?.info?.(
        {
          event: 'task_agent_captured_model_unavailable',
          agent_name: input.profile.exactOwnerName,
          provider_id: resolved.providerId,
          model_id: resolved.modelId,
        },
        'Agent execution preparation rejected: captured model is not available',
      );
      throw new Error(availability.message);
    }
  }
  return resolved;
}

function buildCapturedDefinition(input: {
  readonly profile: AgentExecutionProfile;
  readonly frozenSurface: Pick<
    LegacyFrozenAgentExecutionDefinition,
    'systemPrompt' | 'capabilities' | 'promptSnapshot'
  >;
  readonly session: SessionRecord;
  readonly selection: ResolvedAgentModelSelection;
  readonly effectiveModel: string;
  readonly variant?: string;
  readonly thinking?: ConversationModelThinkingSelection;
  readonly ownerInstanceId?: string;
  readonly pluginSource?: CapturedPluginAgentSource;
}) {
  const agentDefinition = buildAgentDefinition(input);
  return {
    agentDefinition,
    legacyTaskBinding: toLegacyTaskSessionBinding(agentDefinition),
    effectiveModel: input.effectiveModel,
    ...(input.variant === undefined ? {} : { effectiveModelVariant: input.variant }),
    ...(input.thinking ? { effectiveModelThinking: input.thinking } : {}),
    ...(input.selection.contextWindow === undefined
      ? {}
      : { effectiveModelContextWindow: input.selection.contextWindow }),
    ...(input.selection.maxOutputTokens === undefined
      ? {}
      : { effectiveModelMaxOutputTokens: input.selection.maxOutputTokens }),
  };
}

function buildAgentDefinition(input: {
  readonly profile: AgentExecutionProfile;
  readonly frozenSurface: Pick<
    LegacyFrozenAgentExecutionDefinition,
    'systemPrompt' | 'capabilities' | 'promptSnapshot'
  >;
  readonly session: SessionRecord;
  readonly selection: ResolvedAgentModelSelection;
  readonly variant?: string;
  readonly thinking?: ConversationModelThinkingSelection;
  readonly ownerInstanceId?: string;
  readonly pluginSource?: CapturedPluginAgentSource;
}) {
  return {
    definition: {
      definitionVersion: 2 as const,
      exactOwnerName: input.profile.exactOwnerName,
      ...(input.ownerInstanceId ? { ownerInstanceId: input.ownerInstanceId } : {}),
      ...(input.pluginSource ? { pluginSource: input.pluginSource } : {}),
      systemPrompt: input.frozenSurface.systemPrompt,
      ...(input.frozenSurface.promptSnapshot
        ? { promptSnapshot: input.frozenSurface.promptSnapshot }
        : {}),
      capabilities: input.frozenSurface.capabilities,
      model: {
        providerId: input.selection.providerId,
        modelId: input.selection.modelId,
        ...(input.selection.parameterSnapshot
          ? { parameterSnapshot: input.selection.parameterSnapshot }
          : {}),
        ...(input.variant === undefined ? {} : { variant: input.variant }),
        ...(input.thinking ? { thinking: input.thinking } : {}),
        ...(input.selection.contextWindow === undefined
          ? {}
          : { contextWindow: input.selection.contextWindow }),
        ...(input.selection.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: input.selection.maxOutputTokens }),
      },
      project: {
        workspaceDir: input.session.workspaceDir,
        isDefaultWorkspace: input.session.isDefaultWorkspace === true,
      },
    },
  };
}

async function renderSessionProfile(input: {
  readonly options: TaskAgentBindingCaptureOptions;
  readonly config: LocalConversationRuntimeConfig;
  readonly agentName: string;
  readonly session: SessionRecord;
  readonly appMode?: SessionRecord['appMode'];
  readonly legacyTaskSurface: boolean;
}): Promise<AgentExecutionProfile> {
  return input.options.agentService.renderProfile({
    exactOwnerName: input.agentName,
    surface: input.legacyTaskSurface
      ? 'task-child'
      : resolveAgentPromptSurface(input.session, input.options.runtimeOwnerKind),
    ...profileRequest(input.options, input.config, input.session, input.appMode),
  });
}

function profileRequest(
  options: TaskAgentBindingCaptureOptions,
  config: LocalConversationRuntimeConfig,
  session: SessionRecord,
  appMode: SessionRecord['appMode'] | undefined,
) {
  const configuredCapabilities = config.agents?.default;
  const capabilities =
    options.capabilityProfile === 'cli'
      ? {
          ...configuredCapabilities,
          features: { ...configuredCapabilities?.features, mavis: false },
        }
      : configuredCapabilities;
  return {
    promptProfile: options.runtimeOwnerKind === 'tui' ? ('tui' as const) : ('desktop' as const),
    appMode: appMode ?? session.appMode ?? 'coding',
    capabilities,
    memoryEnabled:
      !isCommandLineRuntimeOwner(options.runtimeOwnerKind) && config.memory?.enabled,
    cronEnabled: !isCommandLineRuntimeOwner(options.runtimeOwnerKind),
    dataDirToken: config.dataDir,
  };
}

/** V1 compatibility: historical Task prompt/capability recovery never reselects a model. */
async function captureLegacyTaskBinding(
  options: TaskAgentBindingCaptureOptions,
  input: TaskAgentBindingCaptureInput,
): Promise<SessionTaskAgentBindingBackfill> {
  const session = input.parent ?? input.session;
  if (!session) throw new Error('Historical Task Agent capture requires a parent Session.');
  const profile = await renderSessionProfile({
    options,
    config: options.config(),
    agentName: input.agentName,
    session,
    appMode: input.appMode,
    legacyTaskSurface: true,
  });
  const inventory = await options.inventory.capture({ session, profile });
  return {
    taskAgentBinding: {
      definition: {
        definitionVersion: 1,
        systemPrompt: profile.agentSystemPrompt ?? '',
        ...(profile.promptSnapshot ? { promptSnapshot: profile.promptSnapshot } : {}),
        capabilities: freezeSelectorCapabilities(profile, inventory),
      },
    },
  };
}

function logTaskModelDiagnostics(
  diagnostics: TaskAgentBindingCaptureOptions['diagnostics'],
  entries: readonly {
    readonly code: string;
    readonly source: string;
    readonly requested: number;
    readonly effective: number;
    readonly physicalLimit: number;
  }[],
): void {
  for (const entry of entries) {
    diagnostics?.info?.(
      {
        code: entry.code,
        source: entry.source,
        requested: entry.requested,
        effective: entry.effective,
        physical_limit: entry.physicalLimit,
      },
      'task_agent_model_selection_clamped',
    );
  }
}

interface ModelSourcesInput {
  readonly profile: AgentExecutionProfile;
  readonly session: SessionRecord;
  readonly parent?: SessionRecord;
  readonly taskModelSelection?: ConversationTaskModelSelection;
  readonly requestedModel?: ConversationModelSelection;
  readonly parentModel?: FrozenAgentExecutionDefinition['model'];
  readonly legacyTaskCapture: boolean;
  readonly ignoreSessionModel?: boolean;
}

function modelSources(input: ModelSourcesInput): readonly AgentModelSelectionSource[] {
  if (input.requestedModel?.providerId === 'minimax' && input.requestedModel.modelId) {
    const model = input.requestedModel;
    return [
      {
        source: 'session-requested-model',
        requireCatalog: true,
        selection: {
          model: `${model.providerId}/${model.modelId}`,
          variant: model.variant,
          reasoning: model.reasoning,
          effort: model.thinking?.effort,
          contextWindow: model.contextLimit,
        },
      },
    ];
  }
  const target = taskTargetModelSelection(input.profile);
  const parent = parentModelSelection(input);
  const session = input.ignoreSessionModel ? undefined : sessionModelSelection(input.session);
  const targetSource: AgentModelSelectionSource | undefined = target
    ? {
        source: 'session-target-agent',
        selection: target,
        requireCatalog: true,
        allowCustomProviderPrefixFallback: true,
        defaultMissingEffortOff: true,
      }
    : undefined;
  const sources: AgentModelSelectionSource[] = [];
  if (input.legacyTaskCapture || input.session.sessionKind === 'task') {
    return taskModelSources(input, targetSource, parent);
  }
  if (session) {
    sources.push({ source: 'session-requested-model', selection: session, requireCatalog: false });
  }
  if (targetSource) sources.push(targetSource);
  if (parent) {
    sources.push({
      source: 'session-parent-model',
      selection: parent,
      requireCatalog: false,
      parameterSnapshot: parentModelSnapshot(input),
    });
  }
  return sources;
}

function taskModelSources(
  input: ModelSourcesInput,
  targetSource: AgentModelSelectionSource | undefined,
  parent: AgentModelSelectionInput | undefined,
): readonly AgentModelSelectionSource[] {
  const sources: AgentModelSelectionSource[] = [];
  if (hasConversationTaskModelSelection(input.taskModelSelection)) {
    sources.push({
      source: 'task-model-override',
      selection: input.taskModelSelection,
      requireCatalog: true,
      allowCustomProviderPrefixFallback: true,
      defaultMissingEffortOff: true,
    });
  }
  if (targetSource) sources.push({ ...targetSource, source: 'task-target-agent' });
  if (parent)
    sources.push({
      source: 'task-parent-session',
      selection: parent,
      requireCatalog: false,
      parameterSnapshot: parentModelSnapshot(input),
    });
  return sources;
}

function parentModelSnapshot(input: ModelSourcesInput) {
  return (
    input.parentModel?.parameterSnapshot ?? savedSessionModel(input.parent ?? {})?.parameterSnapshot
  );
}

function parentModelSelection(input: {
  readonly session: SessionRecord;
  readonly parent?: SessionRecord;
  readonly legacyTaskCapture: boolean;
  readonly parentModel?: FrozenAgentExecutionDefinition['model'];
}): AgentModelSelectionInput | undefined {
  if (!input.parent) return undefined;
  if (!input.legacyTaskCapture && input.parent.sessionId === input.session.sessionId) {
    return undefined;
  }
  if (input.parentModel?.parameterSnapshot) {
    const model = input.parentModel;
    return {
      model: `${model.providerId}/${model.modelId}`,
      variant: model.variant,
      effort: model.thinking?.effort,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
    };
  }
  return sessionModelSelection(input.parent);
}

async function captureOwnerInstanceId(
  agentService: LocalAgentService,
  profile: AgentExecutionProfile,
): Promise<string | undefined> {
  if (profile.creationSource === 'builtin') return undefined;
  const document = await agentService.getConfigDocument(profile.requestRef);
  if (document.ownerKind !== 'custom' || document.exactOwnerName !== profile.exactOwnerName) {
    throw new Error(
      `Agent definition owner changed while Session was being created: ${profile.exactOwnerName}`,
    );
  }
  if (!document.ownerInstanceId?.trim()) {
    throw new Error(`Custom Agent instance is unavailable: ${profile.exactOwnerName}`);
  }
  return document.ownerInstanceId;
}

function sessionModelSelection(session: SessionRecord): AgentModelSelectionInput | undefined {
  const model = session.effectiveModel?.trim();
  if (!model) return undefined;
  return {
    model,
    ...(session.effectiveModelVariant == null ? {} : { variant: session.effectiveModelVariant }),
    ...(session.effectiveModelThinking?.effort
      ? { effort: session.effectiveModelThinking.effort }
      : {}),
    ...(session.effectiveModelContextWindow !== undefined &&
    session.effectiveModelContextWindow !== null
      ? { contextWindow: session.effectiveModelContextWindow }
      : {}),
    ...(session.effectiveModelMaxOutputTokens !== undefined &&
    session.effectiveModelMaxOutputTokens !== null
      ? { maxOutputTokens: session.effectiveModelMaxOutputTokens }
      : {}),
  };
}

function modelVariant(value: string | null | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function resolvedModelVariant(input: {
  readonly selection: { readonly source: string; readonly reasoning?: boolean };
  readonly session: SessionRecord;
  readonly parent?: SessionRecord;
}): string | undefined {
  if (input.selection.reasoning !== undefined) return input.selection.reasoning ? 'thinking' : '';
  if (
    input.selection.source === 'session-historical-model' ||
    input.selection.source === 'session-requested-model'
  ) {
    return modelVariant(input.session.effectiveModelVariant);
  }
  if (
    input.selection.source === 'task-parent-session' ||
    input.selection.source === 'session-parent-model'
  ) {
    return modelVariant(input.parent?.effectiveModelVariant);
  }
  return undefined;
}

function historicalModelSelection(session: SessionRecord): ResolvedAgentModelSelection | undefined {
  if (session.effectiveModel === undefined || session.effectiveModel === null) return undefined;
  const parsed = parseSourceQualifiedModelKey(session.effectiveModel);
  if (!parsed) return undefined;
  return {
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    source: 'session-historical-model',
    ...(session.effectiveModelContextWindow === undefined ||
    session.effectiveModelContextWindow === null
      ? {}
      : { contextWindow: session.effectiveModelContextWindow }),
    ...(session.effectiveModelMaxOutputTokens === undefined ||
    session.effectiveModelMaxOutputTokens === null
      ? {}
      : { maxOutputTokens: session.effectiveModelMaxOutputTokens }),
    diagnostics: [],
  };
}

function resolvedThinkingSelection(input: {
  readonly selection: {
    readonly source: string;
    readonly effort?: string;
    readonly reasoning?: boolean;
  };
  readonly session: SessionRecord;
  readonly parent?: SessionRecord;
}): ConversationModelThinkingSelection | undefined {
  if (input.selection.reasoning !== undefined) {
    return input.selection.reasoning && input.selection.effort
      ? { effort: input.selection.effort }
      : undefined;
  }
  const base = baseThinkingSelection(input);
  const thinking = {
    ...(base ?? {}),
    ...(input.selection.effort === undefined ? {} : { effort: input.selection.effort }),
    ...(base?.budgets ? { budgets: { ...base.budgets } } : {}),
  } satisfies ConversationModelThinkingSelection;
  return Object.keys(thinking).length > 0 ? thinking : undefined;
}

function baseThinkingSelection(input: {
  readonly selection: { readonly source: string };
  readonly session: SessionRecord;
  readonly parent?: SessionRecord;
}): ConversationModelThinkingSelection | null | undefined {
  if (
    input.selection.source === 'session-historical-model' ||
    input.selection.source === 'session-requested-model'
  ) {
    return input.session.effectiveModelThinking;
  }
  if (
    input.selection.source === 'task-parent-session' ||
    input.selection.source === 'session-parent-model'
  ) {
    return input.parent?.effectiveModelThinking;
  }
  return undefined;
}

function taskTargetModelSelection(
  profile: AgentExecutionProfile,
): AgentModelSelectionInput | undefined {
  return profile.configSelection?.model ? profile.configSelection : undefined;
}

function freezeSelectorCapabilities(
  profile: AgentExecutionProfile,
  ready: TaskAgentReadyCapabilityInventory,
  authorToolsAllowlistScope?: LocalTurnAgentProfileFacts['toolsAllowlistScope'],
) {
  const facts = toTurnProfileFacts(profile);
  const toolsAllowlistScope =
    authorToolsAllowlistScope ?? resolveToolsAllowlistScope(profile.configSelection?.tools);
  const filtered = filterLocalTurnCapabilityInventory({
    sources: ready.sources,
    agentProfile: { ...facts, toolsAllowlistScope },
    ...(ready.desktopCapabilities ? { desktopCapabilities: ready.desktopCapabilities } : {}),
  });
  // This projection does not ship Computer Use, so no deferred native ceiling
  // is captured here; the Agent's own selectors still apply on every Turn.
  const tools = frozenToolNames(
    filtered,
    [],
    toolsAllowlistScope,
    profile.configSelection?.tools,
  );
  // The Skill reader checks both allowlists for Desktop Plugin Skills, so a
  // frozen Plugin Skill must be named in `skills` as well as `extensionSkills`.
  const desktopSkills = (filtered.desktopCapabilities?.skills ?? [])
    .filter((skill) => filtered.selector.allowsExtensionSkill(skill.pluginName, skill.name))
    .map((skill) => ({ ...skill, runtimeName: `${skill.pluginName}:${skill.name}` }));
  const skills = uniqueNames([
    ...ready.skills
      .filter((skill) => filtered.selector.allowsSkill(skill.name))
      .map((skill) => skill.name),
    ...desktopSkills
      .filter(
        (skill) =>
          filtered.selector.allowsSkill(skill.name) ||
          filtered.selector.allowsSkill(skill.runtimeName),
      )
      .map((skill) => skill.runtimeName),
  ]);
  const extensionSkills = uniqueNames([
    ...ready.skills
      .filter((skill) => !isBuiltinRuntimeSkill(skill))
      .filter((skill) => filtered.selector.allowsSkill(skill.name))
      .filter((skill) => filtered.selector.allowsExtensionSkill('', skill.name))
      .map((skill) => skill.name),
    ...desktopSkills.map((skill) => skill.runtimeName),
  ]);
  const disallowedTools = profile.configSelection?.disallowedTools ?? [];
  return {
    // The snapshot is an upper bound for internal tools and Skills only:
    // undefined selectors resolve to the ready inventory at Task creation, and
    // later installs can only be removed by current runtime gates. MCP and
    // Plugin tools are not bounded by it; they follow the Agent's `mcpServers`
    // and `disallowedTools` on every Turn.
    tools,
    disallowedTools: [...disallowedTools],
    // The Agent's own selector, not the servers ready now, so a server configured
    // or recovered after capture stays reachable by the running Task.
    mcpServers: frozenMcpServerSelector(profile.configSelection?.mcpServers),
    skills,
    extensionSkills,
    selectorVersion: FROZEN_SELECTOR_VERSION,
  };
}

/**
 * Version 2 encoding of the Agent's `mcpServers` in a field releases up to
 * v3.1.4 require: unset → `[]` (unrestricted), `[]` → `[":none"]` (no MCP),
 * server names as written.
 */
function frozenMcpServerSelector(selection: readonly string[] | undefined): readonly string[] {
  if (selection === undefined) return [];
  const names = uniqueNames(selection);
  return names.length > 0 ? names : [FROZEN_MCP_SERVERS_NONE];
}

/**
 * A `native` list bounds internal tools only, so the snapshot names no MCP or
 * Plugin tool. An `all` list (one that names `mcp__*` tools) keeps every
 * admitted name plus the `mcp__*` selectors themselves, even for tools not
 * ready at capture, so later Turns still read it as `all` from its content.
 * `selected` is the list after Plugin alias rebinding. When rebinding left no
 * `mcp__*` name, those tools are unavailable: the author's names could match a
 * same-named configured server, so only `FROZEN_TOOLS_ALL_SCOPE_MARKER` is
 * added, which matches no tool and keeps the list read as `all`.
 */
function frozenToolNames(
  filtered: ReturnType<typeof filterLocalTurnCapabilityInventory>,
  deferredComputerTools: readonly string[],
  scope: NonNullable<LocalTurnAgentProfileFacts['toolsAllowlistScope']>,
  selected: readonly string[] | undefined,
): readonly string[] {
  const all = scope === 'all';
  const admitted = uniqueNames([
    ...deferredComputerTools,
    ...filtered.nativeTools.map((tool) => tool.def.name),
    ...filtered.mcpEntries
      .map(({ tool }) => tool.def.name)
      .filter((name) => all || !isAgentSelectorMcpToolName(name)),
    ...filtered.threadGoalTools.map((tool) => tool.def.name),
    ...(all ? (filtered.desktopCapabilities?.runtimeTools.map((tool) => tool.def.name) ?? []) : []),
  ]);
  if (!all) return admitted;
  const named = uniqueNames([...admitted, ...(selected ?? []).filter(isAgentSelectorMcpToolName)]);
  return named.some(isAgentSelectorMcpToolName) ? named : [...named, FROZEN_TOOLS_ALL_SCOPE_MARKER];
}

function isBuiltinRuntimeSkill(
  skill: TaskAgentReadyCapabilityInventory['skills'][number],
): boolean {
  return skill.sourceType === 1;
}

function toTurnProfileFacts(profile: AgentExecutionProfile): LocalTurnAgentProfileFacts {
  return {
    capabilityCeiling: profile.capabilityCeiling,
    ...(profile.creationSource === 'builtin' ? { canonicalRole: profile.canonicalViewName } : {}),
    trustedBuiltin: profile.creationSource === 'builtin' && profile.provenance.source !== 'custom',
    surface: profile.surface,
    ...(profile.configSelection ? { configSelection: profile.configSelection } : {}),
  };
}

function uniqueNames(values: readonly string[]): readonly string[] {
  const normalized = new Map<string, string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.normalize('NFKC').toLocaleLowerCase('en-US');
    if (!normalized.has(key)) normalized.set(key, trimmed);
  }
  return [...normalized.values()];
}

function isCommandLineRuntimeOwner(runtimeOwnerKind: string | undefined): boolean {
  return runtimeOwnerKind === 'cli' || runtimeOwnerKind === 'tui';
}
