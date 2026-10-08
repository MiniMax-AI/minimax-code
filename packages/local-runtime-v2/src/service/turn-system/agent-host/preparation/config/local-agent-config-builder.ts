import type { IAgentConfig, ISkillRef } from '@mavis/protocol';
import {
  isPromptSnapshotInvalidError,
  PromptSnapshotInvalidError,
  type PromptReadScope,
  type PromptSnapshotSource,
} from '@mavis/agent-runtime';
import {
  DEFAULT_RETRY_CONTINUATION_PROMPT,
  DEFAULT_OUTPUT_REVISION_INSTRUCTION,
  OUTPUT_REVISION_PROMPT_KEY,
  RETRY_CONTINUATION_PROMPT_KEY,
} from './prompt-templates.js';
import { resolveAgentCapabilities, type ResolvedAgentCapabilities } from '@mavis/config';
import type { SessionRecord, TaskSessionBinding } from '../../../../session-system/index.js';
import type {
  AgentExecutionSnapshot,
  ContextUsagePromptRange,
  LocalAgentExecutionProfile,
  LocalAgentProfileSource,
} from '../contracts.js';
import type { AgentHostTurnCapabilityView } from '../../assembly/turn-capability-lifecycle.js';
import {
  isLegacyMinimaxProvider,
  modelConfigForRef,
  modelRefForModel,
  savedSessionModel,
  type LocalConversationRuntimeConfig,
} from '../../../../model-system/index.js';
import { INSTRUCTIONS_CONTEXT_PREAMBLE } from '../prompt-blocks.js';
import {
  createLocalStaticPromptReader,
  type LocalStaticPromptReader,
} from '../static-prompt-reader.js';
import {
  resolveTurnModelSelection,
  turnModelParameters,
  type LocalAgentModelOverride,
  type SessionModelRepairCapability,
  type SessionModelRepairLogger,
  type TurnModelSelection,
} from './session-model-selection.js';
import {
  readLocalAgentCustomConfig,
  type LocalAgentCustomConfigLogger,
  type LocalAgentCustomConfigResult,
} from './agent-custom-config.js';
import { getLocalConversationBuildProfile, isLocalVelaBuild } from './build-profile.js';
import { addRuntimeRules } from './runtime-prompt-rules.js';
import {
  environmentContextBlock,
  type LocalPromptEnvironment,
} from './environment-prompt-composer.js';
import {
  collectMemoryBlocks,
  toMemoryPromptSources,
  type LocalPromptMemoryReader,
} from './memory-prompt-composer.js';

export type { LocalAgentModelOverride } from './session-model-selection.js';
export type { LocalPromptMemoryReader } from './memory-prompt-composer.js';

export interface LocalPromptSkillReader {
  listRuntimeSkills(scope: LocalPromptSkillScope): Promise<{
    readonly skills: readonly LocalPromptSkill[];
  }>;
  renderCatalog(scope: LocalPromptSkillCatalogScope): Promise<string>;
}

interface LocalPromptSkillScope {
  readonly excludeAgentResources?: boolean;
  readonly skipAgentResolution?: boolean;
  readonly expectedAgentInstanceId?: string;
  readonly agentName: string;
  readonly workspaceDir: string;
  readonly builtinSkillNames?: readonly string[];
  /** Agent `skills` selector for every standalone Skill. */
  readonly allowedSkillNames?: readonly string[];
  /** Agent `extensionSkills` selector for non-bundled standalone Skills. */
  readonly allowedExtensionSkillNames?: readonly string[];
  readonly cuModeActive?: boolean;
  /** Host-owned MiniApp Tool availability for this exact execution surface. */
  readonly miniappAvailable?: boolean;
  /** Supplied by the V2 Agent owner; gates the catalog by the rendered ceiling. */
  readonly agentPolicy?: {
    readonly canonicalRole: string;
    readonly builtinAgent: boolean;
    readonly capabilities: ResolvedAgentCapabilities;
  };
}

interface LocalPromptSkillCatalogScope extends LocalPromptSkillScope {
  readonly firstTurnSessionId?: string;
  readonly contextWindowTokens?: number;
  readonly additionalSkills?: readonly {
    readonly name: string;
    readonly description: string;
    readonly builtin: boolean;
  }[];
}

export interface LocalPromptSkill {
  readonly name: string;
  readonly description?: string;
  readonly sourceType?: number;
  /** Availability is already decided by a capability owner, outside standalone Skill selectors. */
  readonly selectionScope?: 'capability-owned';
}

/**
 * Launch-scoped main-Agent prompt overrides held only in process memory.
 * `customPrompt` replaces the identity prompt; `appendSystemPrompt` follows it.
 */
export interface SystemPromptOverrides {
  readonly customPrompt?: string;
  readonly appendSystemPrompt?: string;
}

export interface LocalAgentConfigBuilderOptions {
  readonly config: () => LocalConversationRuntimeConfig;
  readonly environment?: () => LocalPromptEnvironment;
  readonly isGitRepository?: (workspaceDir: string) => Promise<boolean>;
  readonly memory?: LocalPromptMemoryReader;
  readonly skills: LocalPromptSkillReader;
  readonly staticPrompts?: LocalStaticPromptReader;
  readonly profile?: LocalAgentProfileSource;
  /** Captures the single prompt snapshot used by profile and extension assembly. */
  readonly promptSnapshots?: PromptSnapshotSource;
  readonly buildProfile?: string;
  readonly customConfigReader?: (input: {
    readonly dataDir: string;
    readonly logger?: LocalAgentCustomConfigLogger;
  }) => Promise<LocalAgentCustomConfigResult>;
  /** Applied to every surface except hidden task children; never persisted. */
  readonly systemPromptOverrides?: SystemPromptOverrides;
  readonly logger?: LocalAgentCustomConfigLogger;
  /** Narrow Session persistence for stale-model repair; bound after SessionSystem ready. */
  readonly sessionModelRepair?: SessionModelRepairCapability;
  /** Narrow Task snapshot port; supplied after SessionSystem ownership is ready. */
  readonly taskSessionBindings?: TaskSessionBindingCapability;
  readonly modelRepairLogger?: SessionModelRepairLogger;
  readonly nowMs?: () => number;
  /** Enables metadata-free custom-provider thinking only for the new TUI product. */
  readonly implicitCustomProviderThinking?: boolean;
  readonly tuiProductPolicy?: boolean;
  /** Host-owned availability synchronized with the MiniApp RuntimeTool. */
  readonly miniappAvailable?: boolean;
}

/** Builds one AgentConfig solely from validated Agent/Session facts and narrow capabilities. */
export class LocalAgentConfigBuilder {
  private readonly staticPrompts: LocalStaticPromptReader;
  private readonly nowMs: () => number;
  private sessionModelRepair: SessionModelRepairCapability | undefined;
  private taskSessionBindings: TaskSessionBindingCapability | undefined;

  constructor(private readonly options: LocalAgentConfigBuilderOptions) {
    this.staticPrompts =
      options.staticPrompts ?? createLocalStaticPromptReader({ logger: options.logger });
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.sessionModelRepair = options.sessionModelRepair;
    this.taskSessionBindings = options.taskSessionBindings;
  }

  /**
   * Composition binds Session model repair once the SessionSystem exists — the
   * builder is constructed earlier and must not reach for a repository itself.
   */
  bindSessionModelRepair(repair: SessionModelRepairCapability): void {
    this.sessionModelRepair = repair;
  }

  bindTaskSessionBindings(bindings: TaskSessionBindingCapability): void {
    this.taskSessionBindings = bindings;
  }

  async build(input: AgentConfigBuildInput): Promise<IAgentConfig> {
    return (await this.buildPrepared(input)).agentConfig;
  }

  async buildPrepared(input: AgentConfigBuildInput): Promise<{
    readonly agentConfig: IAgentConfig;
    readonly outputRevisionInstruction: string;
    readonly retryContinuationPrompt?: string;
    readonly promptRead?: PromptReadScope;
  }> {
    const source = this.options.promptSnapshots;
    const promptRead =
      input.promptRead ?? (source ? { source, snapshot: await source.capture() } : undefined);
    try {
      const outputRevisionInstruction = await readOutputRevisionInstruction(promptRead);
      const retryContinuationPrompt = await readRetryContinuationPrompt(promptRead, input);
      await validateWorkflowPromptScope(promptRead);
      return {
        agentConfig: await this.buildForPromptScope(input, promptRead),
        outputRevisionInstruction,
        ...(retryContinuationPrompt ? { retryContinuationPrompt } : {}),
        ...(promptRead ? { promptRead } : {}),
      };
    } catch (error) {
      if (!source || !promptRead || !isPromptSnapshotInvalidError(error)) throw error;
      const builtinPromptRead = { source, snapshot: await source.captureBuiltin() };
      const outputRevisionInstruction = await readOutputRevisionInstruction(builtinPromptRead);
      const retryContinuationPrompt = await readRetryContinuationPrompt(builtinPromptRead, input);
      await validateWorkflowPromptScope(builtinPromptRead);
      return {
        agentConfig: await this.buildForPromptScope(input, builtinPromptRead),
        outputRevisionInstruction,
        ...(retryContinuationPrompt ? { retryContinuationPrompt } : {}),
        promptRead: builtinPromptRead,
      };
    }
  }

  private async buildForPromptScope(
    input: AgentConfigBuildInput,
    promptRead?: PromptReadScope,
  ): Promise<IAgentConfig> {
    const config = this.options.config();
    const runtimeFacts = resolveAgentRuntimeFacts(input.agent, config);
    const profileAndBinding = await this.renderProfileForTurn({
      ...input,
      ...(promptRead ? { promptRead } : {}),
    });
    const profile = profileAndBinding.profile;
    const turnInput = input;
    const frozenModel = await this.readSavedModel(turnInput, profileAndBinding.binding);
    const frozenSession = sessionWithFrozenModel(turnInput.session, frozenModel);
    // Resolved once per Turn, gated against the current call route, and then
    // reused: no later stage may re-select a model or reach the upstream with
    // one this route rejects.
    // Only a managed legacy alias may repair a frozen binding. Other frozen
    // selections retain their fail-closed behavior when the catalog changes.
    const model = await this.resolveTurnModel(config, turnInput, frozenModel, frozenSession);
    const layers = await loadPromptLayers({
      input: turnInput,
      config,
      runtimeFacts,
      options: this.options,
      staticPrompts: this.staticPrompts,
      nowMs: this.nowMs,
      ...(model.context_window === undefined ? {} : { modelContextWindow: model.context_window }),
      profile,
    });
    const displayName = turnInput.agent.displayName?.trim() || turnInput.agent.agentName;
    const customConfig = await loadCustomConfig(config, this.options);
    let isGitRepository: boolean | undefined;
    try {
      isGitRepository = await this.options.isGitRepository?.(turnInput.session.workspaceDir);
    } catch {
      isGitRepository = undefined;
    }
    const systemPrompt = buildSystemPrompt({
      config,
      environment: this.options.environment?.(),
      isGitRepository,
      modelId: model.model_id,
      agent: turnInput.agent,
      workspaceDir: turnInput.session.workspaceDir,
      sessionType: turnInput.session.sessionType,
      layers,
      customConfig,
      overrides: this.options.systemPromptOverrides,
      profile,
    });
    return createAgentConfig({
      input: turnInput,
      model,
      layers,
      displayName,
      systemPrompt: systemPrompt.text,
      contextUsagePromptRanges: systemPrompt.ranges,
      customConfig,
      runtimeFacts,
      profile,
    });
  }

  private async resolveTurnModel(
    config: LocalConversationRuntimeConfig,
    turnInput: AgentConfigBuildInput,
    frozenModel: ReturnType<typeof savedSessionModel>,
    frozenSession: SessionRecord,
  ): Promise<IAgentConfig['model']> {
    const canRepair =
      turnInput.session.sessionKind !== 'task' ||
      !frozenModel ||
      isLegacyMinimaxProvider(config, frozenModel.providerId);
    let selection = await resolveTurnModelSelection({
      config,
      tuiProductPolicy: this.options.tuiProductPolicy,
      session: frozenSession,
      ...(turnInput.model ? { requested: turnInput.model } : {}),
      ...(!canRepair || !this.sessionModelRepair ? {} : { repair: this.sessionModelRepair }),
      ...(this.options.modelRepairLogger ? { logger: this.options.modelRepairLogger } : {}),
    });
    const acceptedModel =
      frozenModel?.providerId === selection.providerId && frozenModel.modelId === selection.modelId
        ? frozenModel
        : undefined;
    selection = withFrozenParameters(selection, turnInput.model, acceptedModel);
    return withFrozenSessionModelLimits(
      modelRefForSelection(
        config,
        selection,
        this.options.implicitCustomProviderThinking === true,
        usesLegacyFrozenSelection(turnInput.model, acceptedModel),
      ),
      frozenSession,
      selection,
      frozenModel !== undefined && usesSavedModelLimits(turnInput, config, selection.providerId),
    );
  }

  private async readSavedModel(
    input: AgentConfigBuildInput,
    binding: TaskSessionBinding | undefined,
  ): Promise<ReturnType<typeof savedSessionModel>> {
    if (binding?.definition.definitionVersion === 2) return binding.definition.model;
    if (input.session.sessionKind === 'task' || input.model || !input.session.effectiveModel)
      return undefined;
    const historical = await this.taskSessionBindings?.readSessionAgentRouting?.(
      input.session.sessionId,
    );
    const definition = historical?.definition?.definition;
    return savedSessionModel(
      input.session,
      definition?.definitionVersion === 2 ? definition.model : undefined,
    );
  }

  private async renderProfileForTurn(input: {
    readonly session: SessionRecord;
    readonly agent: AgentExecutionSnapshot;
    readonly isSessionFirstTurn: boolean;
    readonly promptRead?: PromptReadScope;
  }): Promise<{
    readonly profile?: LocalAgentExecutionProfile;
    readonly binding?: TaskSessionBinding;
  }> {
    const source = this.options.profile;
    if (!source) return {};
    const binding = await this.readOrBackfillTaskBinding(input.session);
    const profile = await source.render({
      ...input,
      ...(binding ? { agentBinding: binding } : {}),
    });
    return {
      profile,
      ...(binding ? { binding } : {}),
    };
  }

  private async readOrBackfillTaskBinding(
    session: SessionRecord,
  ): Promise<TaskSessionBinding | undefined> {
    if (session.sessionKind !== 'task') return undefined;
    return this.taskSessionBindings?.ensureSessionAgentDefinition(session.sessionId);
  }
}

function usesSavedModelLimits(
  input: AgentConfigBuildInput,
  config: LocalConversationRuntimeConfig,
  providerId: string,
): boolean {
  if (!input.model) return true;
  return (
    input.session.sessionKind === 'task' &&
    (providerId !== 'minimax' || config.minimaxModelSource === 'minimax_api_key')
  );
}

/** The Turn owner reads/captures one immutable Session snapshot, never a repository. */
export interface TaskSessionBindingCapability {
  ensureSessionAgentDefinition(sessionId: string): Promise<TaskSessionBinding | undefined>;
  /** Historical model compatibility only; never captures or supplies the ordinary Agent profile. */
  readSessionAgentRouting?(sessionId: string): Promise<
    | {
        readonly definition?: TaskSessionBinding;
      }
    | undefined
  >;
}

type AgentConfigBuildInput = {
  readonly session: SessionRecord;
  readonly agent: AgentExecutionSnapshot;
  readonly model?: LocalAgentModelOverride;
  readonly isSessionFirstTurn: boolean;
  readonly desktopCapabilities?: AgentHostTurnCapabilityView;
  readonly clientIntent?: string;
  /** Internal Greeting scope captured before its content was rendered. */
  readonly promptRead?: PromptReadScope;
};

const PLAN_MODE_WORKFLOW_PROMPT_KEYS = ['workflow/plan-mode/agent-entry.md'] as const;

async function validateWorkflowPromptScope(scope: PromptReadScope | undefined): Promise<void> {
  if (!scope) return;
  for (const key of PLAN_MODE_WORKFLOW_PROMPT_KEYS) {
    const result = await scope.source.read(scope.snapshot, key);
    if (result.kind === 'invalid') {
      throw new PromptSnapshotInvalidError(`Workflow prompt cannot be read: ${key}`);
    }
  }
}

async function readOutputRevisionInstruction(scope: PromptReadScope | undefined): Promise<string> {
  if (!scope) return DEFAULT_OUTPUT_REVISION_INSTRUCTION;
  const result = await scope.source.read(scope.snapshot, OUTPUT_REVISION_PROMPT_KEY);
  if (result.kind === 'found') return result.content;
  if (result.kind === 'missing') return DEFAULT_OUTPUT_REVISION_INSTRUCTION;
  throw new PromptSnapshotInvalidError(
    `Workflow prompt cannot be read: ${OUTPUT_REVISION_PROMPT_KEY}`,
  );
}

async function readRetryContinuationPrompt(
  scope: PromptReadScope | undefined,
  input: AgentConfigBuildInput,
): Promise<string | undefined> {
  if (input.clientIntent !== 'retry-continuation') return undefined;
  if (!scope) return DEFAULT_RETRY_CONTINUATION_PROMPT;
  const result = await scope.source.read(scope.snapshot, RETRY_CONTINUATION_PROMPT_KEY);
  if (result.kind === 'found') return result.content;
  if (result.kind === 'missing') return DEFAULT_RETRY_CONTINUATION_PROMPT;
  throw new PromptSnapshotInvalidError(
    `Desktop task prompt cannot be read: ${RETRY_CONTINUATION_PROMPT_KEY}`,
  );
}

interface AgentRuntimeFacts {
  readonly resourceAgentName: string;
  readonly builtinCapabilities: ResolvedAgentCapabilities;
  readonly builtinSkillNames?: readonly string[];
  readonly cuModeActive: boolean;
  readonly exposeCuModeActive: boolean;
}

interface LoadedPromptLayers {
  readonly basePrompt: string;
  readonly sessionPrompt: string;
  readonly projectInstructions: string;
  readonly globalInstructions: string;
  readonly memoryBlocks: readonly string[];
  readonly skills: Awaited<ReturnType<LocalPromptSkillReader['listRuntimeSkills']>>;
  readonly catalog: string;
  readonly desktopPluginSkills: readonly { readonly pluginName: string; readonly name: string }[];
}

interface PromptPart {
  readonly text: string;
  readonly kind?: ContextUsagePromptRange['kind'];
  readonly ranges?: readonly ContextUsagePromptRange[];
}

interface ComposedPrompt {
  readonly text: string;
  readonly ranges: readonly ContextUsagePromptRange[];
}

async function loadPromptLayers(parameters: {
  readonly input: {
    readonly session: SessionRecord;
    readonly agent: AgentExecutionSnapshot;
    readonly isSessionFirstTurn: boolean;
    readonly desktopCapabilities?: AgentHostTurnCapabilityView;
  };
  readonly config: LocalConversationRuntimeConfig;
  readonly runtimeFacts: AgentRuntimeFacts;
  readonly options: LocalAgentConfigBuilderOptions;
  readonly staticPrompts: LocalStaticPromptReader;
  readonly nowMs: () => number;
  readonly modelContextWindow?: number;
  /** Rendered by the V2 Agent owner; replaces the static identity layers. */
  readonly profile?: LocalAgentExecutionProfile;
}): Promise<LoadedPromptLayers> {
  const {
    input,
    config,
    runtimeFacts,
    options,
    staticPrompts,
    nowMs,
    modelContextWindow,
    profile,
  } = parameters;
  const executionScope = createExecutionScope(
    input.session,
    runtimeFacts,
    profile,
    options.miniappAvailable === true,
  );
  const capabilityOptions = createPromptCapabilityOptions(input.agent, runtimeFacts, profile);
  const memoryBlocks = loadMemoryBlocks({
    session: input.session,
    config,
    options,
    runtimeFacts,
    nowMs,
    profile,
  });
  // The Agent owner already rendered core/surface prompts for this turn, so the
  // static asset layers only run for hosts without an injected profile source.
  const staticIdentity = profile
    ? Promise.resolve({ basePrompt: '', sessionPrompt: '' })
    : readStaticIdentity(input, runtimeFacts, staticPrompts, capabilityOptions);
  const loaded = await Promise.all([
    staticIdentity,
    staticPrompts.readProjectInstructions(input.session.workspaceDir),
    staticPrompts.readGlobalInstructions?.(config.dataDir) ?? Promise.resolve(''),
    memoryBlocks,
    options.skills.listRuntimeSkills(executionScope),
  ]);
  const [{ basePrompt, sessionPrompt }, projectInstructions, globalInstructions, memory, skills] =
    loaded;
  const filteredRuntimeSkills = skills.skills.filter((skill) =>
    isRuntimeSkillSelected(profile?.configSelection, skill),
  );
  const standaloneNames = new Set(
    filteredRuntimeSkills.map((skill) => normalizedSkillName(skill.name)),
  );
  const hideCodeReviewSkill = suppressesCodeReviewSkill(input.session);
  const allowedExtensionSkills = profile?.configSelection?.extensionSkills;
  const desktopSkills = (input.desktopCapabilities?.skills ?? []).filter((skill) => {
    const name = normalizedSkillName(skill.name);
    return (
      !(hideCodeReviewSkill && name === CODE_REVIEW_SKILL_NAME) &&
      !standaloneNames.has(name) &&
      isExtensionSkillSelected(allowedExtensionSkills, skill.pluginName, skill.name)
    );
  });
  const catalog = await options.skills.renderCatalog({
    ...executionScope,
    ...(modelContextWindow === undefined ? {} : { contextWindowTokens: modelContextWindow }),
    additionalSkills: desktopSkills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      builtin: false,
    })),
    ...(input.isSessionFirstTurn ? { firstTurnSessionId: input.session.sessionId } : {}),
  });
  return {
    basePrompt,
    sessionPrompt,
    projectInstructions,
    globalInstructions,
    memoryBlocks: memory,
    skills: { ...skills, skills: filteredRuntimeSkills },
    catalog,
    desktopPluginSkills: desktopSkills.map((skill) => ({
      pluginName: skill.pluginName,
      name: skill.name,
    })),
  };
}

function createExecutionScope(
  session: SessionRecord,
  runtimeFacts: AgentRuntimeFacts,
  profile: LocalAgentExecutionProfile | undefined,
  miniappAvailable: boolean,
): LocalPromptSkillCatalogScope {
  return {
    agentName: profile?.resourceReadRef ?? runtimeFacts.resourceAgentName,
    ...profileResourceScope(profile),
    workspaceDir: session.workspaceDir,
    ...builtinSkillScope(session, runtimeFacts),
    ...profileSelectionScope(profile),
    ...runtimeFeatureScope(runtimeFacts, profile, miniappAvailable),
  };
}

function profileResourceScope(profile: LocalAgentExecutionProfile | undefined) {
  return {
    ...(profile?.excludeAgentResources ? { excludeAgentResources: true } : {}),
    ...(profile?.skipAgentResolution ? { skipAgentResolution: true } : {}),
    ...(profile?.expectedAgentInstanceId
      ? { expectedAgentInstanceId: profile.expectedAgentInstanceId }
      : {}),
  };
}

function builtinSkillScope(session: SessionRecord, runtimeFacts: AgentRuntimeFacts) {
  const builtinSkillNames = builtinSkillNamesFor(session, runtimeFacts);
  return builtinSkillNames ? { builtinSkillNames } : {};
}

function builtinSkillNamesFor(
  session: SessionRecord,
  runtimeFacts: AgentRuntimeFacts,
): readonly string[] | undefined {
  if (!suppressesCodeReviewSkill(session)) return runtimeFacts.builtinSkillNames;
  return runtimeFacts.builtinSkillNames?.filter(
    (name) => normalizedSkillName(name) !== CODE_REVIEW_SKILL_NAME,
  );
}

function profileSelectionScope(profile: LocalAgentExecutionProfile | undefined) {
  return {
    ...(profile?.configSelection?.skills === undefined
      ? {}
      : { allowedSkillNames: profile.configSelection.skills }),
    ...(profile?.configSelection?.extensionSkills === undefined
      ? {}
      : { allowedExtensionSkillNames: profile.configSelection.extensionSkills }),
    ...(profile
      ? {
          agentPolicy: {
            canonicalRole: profile.canonicalViewName,
            builtinAgent: profile.provenance.source !== 'custom',
            capabilities: toResolvedAgentCapabilities(profile.capabilityCeiling),
          },
        }
      : {}),
  };
}

function runtimeFeatureScope(
  runtimeFacts: AgentRuntimeFacts,
  profile: LocalAgentExecutionProfile | undefined,
  miniappAvailable: boolean,
) {
  return {
    ...(runtimeFacts.exposeCuModeActive ? { cuModeActive: runtimeFacts.cuModeActive } : {}),
    ...(miniappAvailable && profile?.surface === 'interactive' ? { miniappAvailable: true } : {}),
  };
}

function createPromptCapabilityOptions(
  agent: AgentExecutionSnapshot,
  runtimeFacts: AgentRuntimeFacts,
  profile: LocalAgentExecutionProfile | undefined,
): { readonly builtinCapabilities?: ResolvedAgentCapabilities } {
  if (profile) {
    return { builtinCapabilities: toResolvedAgentCapabilities(profile.capabilityCeiling) };
  }
  return agent.builtinCapabilities ? { builtinCapabilities: runtimeFacts.builtinCapabilities } : {};
}

/**
 * A structured Review turn already runs the review workflow, so re-listing the
 * general-purpose `code-review` Skill only invites it to recurse into itself.
 * v1 derived this from `session.purpose` in `buildTurnAgentConfig`; the Agent
 * owner cutover moved turn config here, so the same rule lives here now.
 */
const CODE_REVIEW_SKILL_NAME = 'code-review';

function suppressesCodeReviewSkill(session: SessionRecord): boolean {
  return session.purpose?.startsWith('code-review:') === true;
}

function toResolvedAgentCapabilities(
  ceiling: LocalAgentExecutionProfile['capabilityCeiling'],
): ResolvedAgentCapabilities {
  return {
    persona: { enabled: ceiling.personaEnabled },
    tools: ceiling.tools ? [...ceiling.tools] : undefined,
    builtinTools: ceiling.builtinTools ? [...ceiling.builtinTools] : undefined,
    skills: ceiling.skills ? [...ceiling.skills] : undefined,
    features: { ...ceiling.features },
  };
}

async function readStaticIdentity(
  input: {
    readonly session: SessionRecord;
    readonly agent: AgentExecutionSnapshot;
  },
  runtimeFacts: AgentRuntimeFacts,
  staticPrompts: LocalStaticPromptReader,
  capabilityOptions: { readonly builtinCapabilities?: ResolvedAgentCapabilities },
): Promise<{ readonly basePrompt: string; readonly sessionPrompt: string }> {
  const [basePrompt, sessionPrompt] = await Promise.all([
    staticPrompts.readBasePrompt(input.agent.agentRole, {
      includeAllLayer: input.agent.systemPromptIncludesBase !== true,
      ...capabilityOptions,
    }),
    staticPrompts.readSessionPrompt({
      sessionType: input.session.sessionType ?? 'root',
      agentName: runtimeFacts.resourceAgentName,
      ...(input.agent.agentConfigDir ? { agentConfigDir: input.agent.agentConfigDir } : {}),
      ...capabilityOptions,
    }),
  ]);
  return { basePrompt, sessionPrompt };
}

function loadMemoryBlocks(input: {
  readonly session: SessionRecord;
  readonly config: LocalConversationRuntimeConfig;
  readonly options: LocalAgentConfigBuilderOptions;
  readonly runtimeFacts: AgentRuntimeFacts;
  readonly nowMs: () => number;
  readonly profile: LocalAgentExecutionProfile | undefined;
}): Promise<readonly string[]> {
  const { session, config, options, runtimeFacts, nowMs, profile } = input;
  const recallEnabled = session.memoryPolicy?.recallEnabled !== false;
  const writeEnabled = session.memoryPolicy?.writeEnabled !== false;
  if (!options.memory) {
    return Promise.resolve([]);
  }
  // A migrated owner also reads its retired alias directories; the canonical
  // source stays first so USER.md and the tail budget keep one provenance.
  const sources = toMemoryPromptSources(
    profile ? profile.memoryReadAgentNames : [runtimeFacts.resourceAgentName],
  );
  return collectMemoryBlocks(options.memory, sources, nowMs, {
    includeAgentMemory: config.memory?.enabled !== false && recallEnabled && sources.length > 0,
    prompt: {
      includeWriteGuidance:
        config.memory?.enabled !== false && writeEnabled && profile?.surface !== 'task-child',
    },
  });
}

async function loadCustomConfig(
  config: LocalConversationRuntimeConfig,
  options: LocalAgentConfigBuilderOptions,
): Promise<LocalAgentCustomConfigResult | undefined> {
  const buildProfile = options.buildProfile ?? getLocalConversationBuildProfile();
  if (!isLocalVelaBuild(buildProfile)) return undefined;
  const reader = options.customConfigReader ?? readLocalAgentCustomConfig;
  return reader({
    dataDir: config.dataDir,
    ...(options.logger ? { logger: options.logger } : {}),
  });
}

function buildSystemPrompt(scope: {
  readonly config: LocalConversationRuntimeConfig;
  readonly environment: LocalPromptEnvironment | undefined;
  readonly isGitRepository: boolean | undefined;
  readonly modelId: string;
  readonly agent: AgentExecutionSnapshot;
  readonly workspaceDir: string;
  readonly sessionType: SessionRecord['sessionType'];
  readonly layers: LoadedPromptLayers;
  readonly customConfig: LocalAgentCustomConfigResult | undefined;
  readonly overrides: SystemPromptOverrides | undefined;
  readonly profile: LocalAgentExecutionProfile | undefined;
}): ComposedPrompt {
  const { agent, sessionType, layers, customConfig, overrides, profile } = scope;
  const interactiveSurface =
    profile?.surface === undefined
      ? (sessionType ?? 'root') === 'root'
      : profile.surface !== 'task-child';
  const customPrompt = customConfig?.systemPrompt;
  const contentPrompt =
    customPrompt !== undefined
      ? { text: addRuntimeRules(customPrompt, false) }
      : buildIdentityPrompt({
          agent,
          layers,
          profile,
          interactiveSurface,
          overrides: interactiveSurface ? overrides : undefined,
        });
  return composePromptParts([
    contentPrompt,
    { text: environmentContextBlock(scope) },
    ...(customPrompt === undefined && !interactiveSurface
      ? [
          { text: '# Session Context' },
          { text: profile?.surfacePrompt.trim() ?? '' },
          { text: layers.sessionPrompt.trim() },
        ]
      : []),
    ...layers.memoryBlocks.map((text) => ({ text, kind: 'MEMORY' as const })),
    { text: layers.catalog.trim(), kind: 'SKILLS' },
  ]);
}

function buildIdentityPrompt(scope: {
  readonly agent: AgentExecutionSnapshot;
  readonly layers: LoadedPromptLayers;
  readonly profile: LocalAgentExecutionProfile | undefined;
  readonly interactiveSurface: boolean;
  readonly overrides: SystemPromptOverrides | undefined;
}): ComposedPrompt {
  const { agent, layers, profile, interactiveSurface, overrides } = scope;
  const customPrompt = overrides?.customPrompt?.trim();
  const appendPrompt = overrides?.appendSystemPrompt?.trim() ?? '';
  const persona = (profile?.persona ?? agent.persona)?.trim();
  const globalInstructions = layers.globalInstructions.trim();
  const projectInstructions = layers.projectInstructions.trim();
  // The preamble only renders when at least one instruction layer is present, so
  // an empty workspace never claims that context follows.
  const instructionsPreamble =
    globalInstructions || projectInstructions ? INSTRUCTIONS_CONTEXT_PREAMBLE : '';
  const corePrompt = (profile?.corePrompt ?? agent.systemPrompt).trim();
  const hasIdentity = [
    persona,
    corePrompt,
    profile?.surfacePrompt,
    layers.basePrompt,
    layers.sessionPrompt,
    globalInstructions,
    projectInstructions,
  ].some((part) => part?.trim());
  const rootSessionPrompt = [profile?.surfacePrompt, layers.sessionPrompt]
    .filter(Boolean)
    .join('\n\n');
  const identity: readonly PromptPart[] = customPrompt
    ? [{ text: addRuntimeRules(customPrompt, interactiveSurface, rootSessionPrompt) }]
    : [
        { text: persona ?? '' },
        {
          text: addRuntimeRules(
            hasIdentity
              ? corePrompt
              : "You are a local coding assistant running in the user's workspace.",
            interactiveSurface,
            rootSessionPrompt,
          ),
        },
        { text: layers.basePrompt.trim() },
      ];
  return composePromptParts([
    ...identity,
    { text: appendPrompt },
    { text: instructionsPreamble },
    { text: globalInstructions, kind: 'OTHER' },
    { text: projectInstructions, kind: 'OTHER' },
  ]);
}

function composePromptParts(parts: readonly PromptPart[]): ComposedPrompt {
  return parts
    .filter((part) => part.text)
    .reduce<ComposedPrompt>(
      (composed, part, index, contentParts) => {
        const followsHeading = /^#{1,6} [^\n]+$/u.test(contentParts[index - 1]?.text ?? '');
        const boundary = followsHeading ? '\n' : '\n\n';
        const separator = composed.text ? boundary : '';
        const startOffset = composed.text.length + separator.length;
        const text = `${composed.text}${separator}${part.text}`;
        const ownRange = part.kind
          ? [{ kind: part.kind, startOffset, endOffset: text.length }]
          : [];
        const nestedRanges = (part.ranges ?? []).map((range) => ({
          kind: range.kind,
          startOffset: startOffset + range.startOffset,
          endOffset: startOffset + range.endOffset,
        }));
        return { text, ranges: [...composed.ranges, ...ownRange, ...nestedRanges] };
      },
      { text: '', ranges: [] },
    );
}

function profilePromptMetadata(profile: LocalAgentExecutionProfile | undefined) {
  if (!profile?.promptMetadata) return {};
  return {
    prompt_metadata: {
      ...profile.promptMetadata,
      agent_name: profile.canonicalViewName,
      surface: profile.surface,
      capability_ceiling: profile.capabilityCeiling,
    },
  };
}

function createAgentConfig(scope: {
  readonly input: {
    readonly session: SessionRecord;
    readonly agent: AgentExecutionSnapshot;
    readonly model?: LocalAgentModelOverride;
    readonly desktopCapabilities?: AgentHostTurnCapabilityView;
  };
  readonly model: IAgentConfig['model'];
  readonly layers: LoadedPromptLayers;
  readonly displayName: string;
  readonly systemPrompt: string;
  readonly contextUsagePromptRanges: readonly ContextUsagePromptRange[];
  readonly customConfig: LocalAgentCustomConfigResult | undefined;
  readonly runtimeFacts: AgentRuntimeFacts;
  readonly profile?: LocalAgentExecutionProfile;
}): IAgentConfig {
  const {
    input,
    model,
    layers,
    displayName,
    systemPrompt,
    contextUsagePromptRanges,
    customConfig,
    runtimeFacts,
    profile,
  } = scope;
  const agentConfig: IAgentConfig & {
    customConfig?: LocalAgentCustomConfigResult['evidence'];
    contextUsagePromptRanges: readonly ContextUsagePromptRange[];
    resourceAgentName: string;
    builtinCapabilities: ResolvedAgentCapabilities;
    cuModeActive: boolean;
    desktopPluginSkills: readonly { readonly pluginName: string; readonly name: string }[];
    capability_ceiling?: LocalAgentExecutionProfile['capabilityCeiling'];
    prompt_metadata?: Readonly<Record<string, unknown>>;
    agent_profile?: {
      readonly exclude_agent_resources?: boolean;
      readonly skip_agent_resolution?: boolean;
      readonly expected_agent_instance_id?: string;
      readonly exact_owner_name: string;
      readonly canonical_view_name: string;
      readonly agent_role: string;
      readonly creation_source: LocalAgentExecutionProfile['creationSource'];
      readonly surface: LocalAgentExecutionProfile['surface'];
      readonly task_execution_mode?: LocalAgentExecutionProfile['taskExecutionMode'];
      readonly provenance_source: LocalAgentExecutionProfile['provenance']['source'];
      readonly app_mode?: LocalAgentExecutionProfile['provenance']['appMode'];
      readonly trusted_builtin: boolean;
      readonly memory_agent_scope_enabled: boolean;
      readonly memory_read_agent_names: readonly string[];
      readonly config_selection?: LocalAgentExecutionProfile['configSelection'];
    };
  } = {
    system_prompt: systemPrompt,
    ...profilePromptMetadata(profile),
    contextUsagePromptRanges,
    model,
    tools: [],
    skills: [
      ...toSkillRefs(layers.skills.skills),
      ...toPluginSkillRefs(input.desktopCapabilities?.skills ?? [], layers.desktopPluginSkills),
    ],
    title: input.agent.agentName,
    display_name: displayName,
    resourceAgentName: runtimeFacts.resourceAgentName,
    builtinCapabilities: runtimeFacts.builtinCapabilities,
    cuModeActive: runtimeFacts.cuModeActive,
    desktopPluginSkills: layers.desktopPluginSkills,
    ...(typeof input.agent.metadata?.id === 'string' ? { agent_id: input.agent.metadata.id } : {}),
    ...(profile
      ? {
          capability_ceiling: profile.capabilityCeiling,
          agent_profile: {
            ...(profile.excludeAgentResources ? { exclude_agent_resources: true } : {}),
            ...(profile.skipAgentResolution ? { skip_agent_resolution: true } : {}),
            ...(profile.expectedAgentInstanceId
              ? { expected_agent_instance_id: profile.expectedAgentInstanceId }
              : {}),
            exact_owner_name: profile.exactOwnerName,
            canonical_view_name: profile.canonicalViewName,
            agent_role: profile.agentRole,
            creation_source: profile.creationSource,
            surface: profile.surface,
            ...(profile.taskExecutionMode
              ? { task_execution_mode: profile.taskExecutionMode }
              : {}),
            provenance_source: profile.provenance.source,
            ...(profile.provenance.appMode ? { app_mode: profile.provenance.appMode } : {}),
            trusted_builtin: profile.creationSource === 'builtin',
            memory_agent_scope_enabled: profile.memoryReadAgentNames.length > 0,
            memory_read_agent_names: profile.memoryReadAgentNames,
            ...(profile.configSelection ? { config_selection: profile.configSelection } : {}),
          },
        }
      : {}),
  };
  attachCustomConfigEvidence(agentConfig, customConfig);
  return agentConfig;
}

function attachCustomConfigEvidence(
  agentConfig: IAgentConfig & { customConfig?: LocalAgentCustomConfigResult['evidence'] },
  customConfig: LocalAgentCustomConfigResult | undefined,
): void {
  if (customConfig?.evidence.present) agentConfig.customConfig = customConfig.evidence;
}

function resolveAgentRuntimeFacts(
  agent: AgentExecutionSnapshot,
  config: LocalConversationRuntimeConfig,
): AgentRuntimeFacts {
  return {
    resourceAgentName: agent.resourceAgentName?.trim() || agent.agentName,
    builtinCapabilities:
      agent.builtinCapabilities ?? resolveAgentCapabilities(config.agents?.default),
    ...(agent.builtinSkillNames ? { builtinSkillNames: agent.builtinSkillNames } : {}),
    cuModeActive: agent.cuModeActive === true,
    exposeCuModeActive: agent.cuModeActive !== undefined,
  };
}

export function modelRefFromConfig(
  config: LocalConversationRuntimeConfig,
  override?: LocalAgentModelOverride,
  options: { implicitCustomProviderThinking?: boolean } = {},
): IAgentConfig['model'] {
  const overrideProvider = override?.provider_id?.trim();
  const overrideModelId = override?.model_id?.trim();
  const base = overrideProvider && overrideModelId ? undefined : parseModelKey(config.defaultModel);
  const provider = overrideProvider || base?.provider;
  const modelId = overrideModelId || base?.modelId;
  if (!provider || !modelId) throw new Error('Model selection is incomplete.');
  const selection: LocalAgentModelOverride = override ?? {
    variant: config.defaultModelVariant,
    thinking: config.defaultModelThinking,
    contextLimit: config.defaultModelContextWindow,
  };
  return modelRefForSelection(
    config,
    {
      providerId: provider,
      modelId,
      ...turnModelParameters(selection),
    },
    options.implicitCustomProviderThinking === true,
  );
}

/** Builds the ModelRef for an already gated selection; performs no re-selection. */
function modelRefForSelection(
  config: LocalConversationRuntimeConfig,
  selection: Pick<
    TurnModelSelection,
    | 'providerId'
    | 'modelId'
    | 'variant'
    | 'thinking'
    | 'reasoning'
    | 'contextLimit'
    | 'parameterSnapshot'
  >,
  implicitCustomProviderThinking = false,
  legacyFrozenSelection = false,
): IAgentConfig['model'] {
  const model = modelRefForModel(
    selection.providerId,
    selection.modelId,
    modelConfigForRef(config, selection.providerId, selection.modelId),
    {
      managed:
        !legacyFrozenSelection &&
        selection.providerId === 'minimax' &&
        config.minimaxModelSource !== 'minimax_api_key',
      ...(selection.variant !== undefined ? { variant: selection.variant } : {}),
      ...(selection.parameterSnapshot ? { parameterSnapshot: selection.parameterSnapshot } : {}),
      ...(selection.reasoning !== undefined ? { reasoning: selection.reasoning } : {}),
      ...(selection.contextLimit !== undefined ? { contextLimit: selection.contextLimit } : {}),
      ...(implicitCustomProviderThinking ? { implicitCustomProviderThinking: true } : {}),
      ...(selection.thinking ? { thinking: selection.thinking } : {}),
    },
  );
  return selection.contextLimit !== undefined
    ? { ...model, context_window: selection.contextLimit }
    : model;
}

function usesLegacyFrozenSelection(
  requested: LocalAgentModelOverride | undefined,
  frozen: ReturnType<typeof savedSessionModel>,
): boolean {
  return !requested && frozen !== undefined && !frozen.parameterSnapshot;
}

function withFrozenParameters(
  selection: TurnModelSelection,
  requested: LocalAgentModelOverride | undefined,
  frozen: ReturnType<typeof savedSessionModel>,
): TurnModelSelection {
  if (!requested && frozen?.parameterSnapshot)
    return { ...selection, parameterSnapshot: frozen.parameterSnapshot };
  return selection;
}

function withFrozenSessionModelLimits(
  model: IAgentConfig['model'],
  session: SessionRecord,
  selection: Pick<TurnModelSelection, 'providerId' | 'modelId'>,
  isTask: boolean,
): IAgentConfig['model'] {
  if (!isTask || session.effectiveModel !== `${selection.providerId}/${selection.modelId}`) {
    return model;
  }
  const contextWindow = positiveSessionLimit(session.effectiveModelContextWindow);
  const maxTokens = positiveSessionLimit(session.effectiveModelMaxOutputTokens);
  if (contextWindow === undefined && maxTokens === undefined) return model;
  return {
    ...model,
    ...(contextWindow === undefined ? {} : { context_window: contextWindow }),
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
  };
}

function sessionWithFrozenModel(
  session: SessionRecord,
  model: ReturnType<typeof savedSessionModel>,
): SessionRecord {
  if (!model) return session;
  return {
    ...session,
    effectiveModel: `${model.providerId}/${model.modelId}`,
    ...(model.variant === undefined
      ? { effectiveModelVariant: null }
      : { effectiveModelVariant: model.variant }),
    ...(model.thinking === undefined
      ? { effectiveModelThinking: null }
      : {
          effectiveModelThinking: {
            ...model.thinking,
            ...(model.thinking.budgets ? { budgets: { ...model.thinking.budgets } } : {}),
          },
        }),
    ...(model.contextWindow === undefined
      ? { effectiveModelContextWindow: null }
      : { effectiveModelContextWindow: model.contextWindow }),
    ...(model.maxOutputTokens === undefined
      ? { effectiveModelMaxOutputTokens: null }
      : { effectiveModelMaxOutputTokens: model.maxOutputTokens }),
  };
}

function positiveSessionLimit(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parseModelKey(value: string | undefined): {
  readonly provider: string;
  readonly modelId: string;
} {
  const raw = value?.trim();
  const slash = raw?.indexOf('/') ?? -1;
  if (!raw || slash <= 0 || slash === raw.length - 1) {
    throw new Error(
      raw
        ? `Invalid model key "${raw}". Expected provider/model.`
        : 'defaultModel is not configured',
    );
  }
  return { provider: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
}

const MINIMAX_OFFICIAL_SKILL_SOURCE = 1;

function toSkillRefs(skills: readonly LocalPromptSkill[]): ISkillRef[] {
  return skills.map((skill) => ({
    name: skill.name,
    ...(skill.description ? { description: skill.description } : {}),
    global: skill.sourceType === MINIMAX_OFFICIAL_SKILL_SOURCE,
    mutable: skill.sourceType !== MINIMAX_OFFICIAL_SKILL_SOURCE,
  }));
}

function toPluginSkillRefs(
  skills: AgentHostTurnCapabilityView['skills'],
  effective: readonly { readonly pluginName: string; readonly name: string }[],
): ISkillRef[] {
  const included = new Set(
    effective.map(
      (skill) => `${normalizedSkillName(skill.pluginName)}\0${normalizedSkillName(skill.name)}`,
    ),
  );
  return skills.flatMap((skill) =>
    included.has(`${normalizedSkillName(skill.pluginName)}\0${normalizedSkillName(skill.name)}`)
      ? [
          {
            name: skill.name,
            ...(skill.description ? { description: skill.description } : {}),
            global: false,
            mutable: false,
          },
        ]
      : [],
  );
}

function normalizedSkillName(name: string): string {
  return name.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function isExtensionSkillSelected(
  selected: readonly string[] | undefined,
  pluginName: string,
  skillName: string,
): boolean {
  if (selected === undefined) return true;
  const name = normalizedSkillName(skillName);
  const qualified = `${normalizedSkillName(pluginName)}:${name}`;
  return selected.some((candidate) => {
    const normalized = normalizedSkillName(candidate);
    return normalized === name || normalized === qualified;
  });
}

function isRuntimeSkillSelected(
  selection: LocalAgentExecutionProfile['configSelection'] | undefined,
  skill: LocalPromptSkill,
): boolean {
  if (skill.selectionScope === 'capability-owned') return true;
  const selected = selection?.skills;
  if (
    selected &&
    !selected.some((name) => normalizedSkillName(name) === normalizedSkillName(skill.name))
  ) {
    return false;
  }
  return (
    skill.sourceType === MINIMAX_OFFICIAL_SKILL_SOURCE ||
    isExtensionSkillSelected(selection?.extensionSkills, '', skill.name)
  );
}
