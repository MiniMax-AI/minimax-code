import { createAgentRuntime, type AgentExtension, type AgentRuntime } from '@mavis/agent-runtime';
import { getLocalBashEnvironment } from '@mavis/agent-tools';
import type { ResolvedAgentCapabilities } from '@mavis/config';

import type {
  LocalModelResolverLike,
  LocalModelResolverOptions,
} from '../../model-system/index.js';
import {
  buildLocalTurnToolCatalog,
  type LocalMcpToolSearchConfig,
  type LocalTurnRawToolSources,
} from './assembly/local-turn-tool-catalog.js';
import {
  createLocalTurnToolCatalogInput,
  type LocalTurnToolCatalogBuildInput,
  type LocalTurnToolCatalogSource,
} from './assembly/local-turn-tool-catalog-source.js';
import { NativeLocalTurnExecutionPreparationSource } from './assembly/local-turn-execution-preparation.js';
import {
  LocalTurnInputPreparer,
  type LocalTurnInputPreparerOptions,
} from './assembly/local-turn-input-preparation.js';
import type { AgentExecutionSnapshot, AgentHostDependencies } from './contracts.js';
import type { AgentHostTurnCapabilityView } from './assembly/turn-capability-lifecycle.js';
import type { HostCapabilityResolver } from './assembly/host-capability/contracts.js';
import {
  type LocalRuntimeTurnExecutorOptions,
  type LocalRuntimeTurnToolContext,
} from './execution/executor.js';
import type { LocalTurnToolPolicyGuard } from './runner/contracts.js';
import {
  LocalAgentConfigBuilder,
  LocalAgentPreparationService,
  type LocalAgentConfigBuilderOptions,
} from './preparation/index.js';
import { observeAgentTurnSetupStage } from './preparation/turn-preflight.js';
import {
  createAgentHostProductionDependencies,
  type AgentHostProductionDependenciesOptions,
} from './production-dependencies.js';
import {
  LocalAgentTurnRunner,
  LocalTurnPermissionGate,
  type LocalAgentTurnRunnerOptions,
  type LocalTurnPermissionGateOptions,
  type LocalTurnPermissionMutationOwner,
} from './runner/index.js';

export interface NativeLocalTurnToolCatalogOptions {
  readonly resolveSources: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly agentName: string;
    readonly resourceAgentName: string;
    readonly builtinCapabilities?: ResolvedAgentCapabilities;
    readonly cuModeActive: boolean;
    readonly workspaceDir: string;
    readonly excludeAgentResources?: boolean;
    readonly skipAgentResolution?: boolean;
    readonly expectedAgentInstanceId?: string;
    readonly agentMemoryEnabled?: boolean;
    readonly agentMemoryReadNames?: readonly string[];
    readonly allowedSkillNames?: readonly string[];
    readonly allowedExtensionSkillNames?: readonly string[];
    readonly desktopCapabilities?: AgentHostTurnCapabilityView;
  }) => Promise<LocalTurnRawToolSources>;
  readonly config?: LocalMcpToolSearchConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly emitDiagnostic?: (type: string, payload: Readonly<Record<string, unknown>>) => void;
  readonly hostCapabilityRegistry?: HostCapabilityResolver;
}

export interface NativeAgentPreparationOptions {
  readonly configBuilder: LocalAgentConfigBuilderOptions;
  readonly modelResolver: LocalModelResolverOptions;
}

export interface NativeLocalAgentPreparationOptions {
  readonly configBuilder: LocalAgentConfigBuilderOptions;
  readonly modelResolver: LocalModelResolverLike;
}

export interface NativeAgentHostProductionDependenciesOptions<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> extends Omit<
  AgentHostProductionDependenciesOptions<TAgent, LocalRuntimeTurnToolContext>,
  'agentRuntimes' | 'preparation' | 'executor'
> {
  readonly preparation: AgentHostProductionDependenciesOptions<
    TAgent,
    LocalRuntimeTurnToolContext
  >['preparation'];
  readonly toolCatalog: NativeLocalTurnToolCatalogOptions;
  readonly inputPreparation: LocalTurnInputPreparerOptions;
  readonly permission: LocalTurnPermissionGateOptions;
  readonly runner: LocalAgentTurnRunnerOptions;
  readonly toolPolicyGuard?: LocalTurnToolPolicyGuard;
  readonly executor: Omit<
    LocalRuntimeTurnExecutorOptions<TAgent, LocalRuntimeTurnToolContext>,
    'runtime' | 'executionPreparation' | 'toolPolicyGuard'
  >;
  /**
   * Explicitly configured normal-turn extensions. The seven built-in
   * `@mavis/agent-extension` adapters are not enabled by this factory.
   */
  readonly normalExtensions?: readonly AgentExtension[];
}

export interface AgentHostRuntimeLifecycle {
  /** Clears Session-scoped extension state in the Agent Turn runtime. */
  disposeSession(sessionId: string): Promise<void>;
}

export type NativeAgentHostProductionDependencies<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
> = AgentHostDependencies<TAgent> & {
  readonly lifecycle: AgentHostRuntimeLifecycle;
};

/**
 * Composes the v2-owned conversation core without attaching it to
 * `services.ts`, Dispatcher, HTTP, or v1 compatibility.
 */
export async function createNativeAgentHostProductionDependencies<
  TAgent extends AgentExecutionSnapshot = AgentExecutionSnapshot,
>(
  options: NativeAgentHostProductionDependenciesOptions<TAgent>,
): Promise<NativeAgentHostProductionDependencies<TAgent>> {
  const toolCatalog = createToolCatalogSource(options.toolCatalog);
  const normalRuntime = await createAgentRuntime({
    base: configuredNormalExtensions(options.normalExtensions),
  });
  const normal: AgentHostDependencies['agentRuntimes']['normal'] = {
    async assembleModelContext(context, desktopCapabilities) {
      const seed = await toolCatalog.build(
        createLocalTurnToolCatalogInput(context, desktopCapabilities),
      );
      return normalRuntime.assembleModelContext(context, seed);
    },
    async assembleTurn(context, desktopCapabilities) {
      const logContext = { sessionId: context.sessionId, turnId: context.turnId };
      const seed = await observeAgentTurnSetupStage(
        options.runner.logger,
        logContext,
        'tool_catalog_build',
        () => toolCatalog.build(createLocalTurnToolCatalogInput(context, desktopCapabilities)),
      );
      return observeAgentTurnSetupStage(
        options.runner.logger,
        logContext,
        'agent_runtime_assembly',
        () => normalRuntime.assembleTurn(context, seed),
      );
    },
  };
  const runtime = new LocalAgentTurnRunner(options.runner);
  const executionPreparation = new NativeLocalTurnExecutionPreparationSource<TAgent>(
    new LocalTurnInputPreparer(options.inputPreparation),
    new LocalTurnPermissionGate(createPermissionGateOptions(options)),
  );
  const dependencies = createNativeAgentHostDependencies(
    options,
    normal,
    runtime,
    executionPreparation,
  );
  return {
    ...dependencies,
    backgroundTaskReads: {
      confirm: async (input) =>
        await options.inputPreparation.reminders.confirmBackgroundTaskReads(input),
    },
    lifecycle: createAgentHostRuntimeLifecycle(normalRuntime, options.permission.mutations),
  };
}

function createNativeAgentHostDependencies<TAgent extends AgentExecutionSnapshot>(
  options: NativeAgentHostProductionDependenciesOptions<TAgent>,
  normal: AgentHostDependencies['agentRuntimes']['normal'],
  runtime: LocalAgentTurnRunner,
  executionPreparation: NativeLocalTurnExecutionPreparationSource<TAgent>,
): AgentHostDependencies<TAgent> {
  const permissionMutations = options.permission.mutations;
  return createAgentHostProductionDependencies({
    sessions: options.sessions,
    ...(options.planDocuments ? { planDocuments: options.planDocuments } : {}),
    agentRuntimes: { normal },
    agents: options.agents,
    promptSnapshots: options.promptSnapshots,
    ...(options.internalTurnPromptReads
      ? { internalTurnPromptReads: options.internalTurnPromptReads }
      : {}),
    ...withTurnRuntimeFacts(options.turnRuntimeFacts),
    preparation: options.preparation,
    compaction: options.compaction,
    turnControl: options.turnControl,
    ...(options.turnCapabilities ? { turnCapabilities: options.turnCapabilities } : {}),
    ...(options.assemblyObserver ? { assemblyObserver: options.assemblyObserver } : {}),
    canonicalHistory: options.canonicalHistory,
    ...(options.runner.logger ? { logger: options.runner.logger } : {}),
    ...(options.usage ? { usage: options.usage } : {}),
    events: options.events,
    executor: {
      ...options.executor,
      runtime,
      executionPreparation,
      ...(permissionMutations
        ? {
            clearPluginHookSessionPermissions: (sessionId: string) =>
              permissionMutations.clearSession(sessionId),
          }
        : {}),
      ...(options.toolPolicyGuard ? { toolPolicyGuard: options.toolPolicyGuard } : {}),
    },
    ...(options.isRuntimeErrorRetryable
      ? { isRuntimeErrorRetryable: options.isRuntimeErrorRetryable }
      : {}),
  });
}

function createPermissionGateOptions<TAgent extends AgentExecutionSnapshot>(
  options: NativeAgentHostProductionDependenciesOptions<TAgent>,
): LocalTurnPermissionGateOptions {
  const logger = options.permission.logger ?? options.runner.logger;
  return {
    ...options.permission,
    ...(logger ? { logger } : {}),
    enforceBuiltinTools:
      options.executor.cliProductPolicy === true && options.executor.tuiProductPolicy !== true,
  };
}

/** Builds the shared native config/model preparation used by AgentHost and title calls. */
export function createNativeLocalAgentPreparation(
  options: NativeLocalAgentPreparationOptions,
): LocalAgentPreparationService {
  return new LocalAgentPreparationService({
    configBuilder: new LocalAgentConfigBuilder({
      ...options.configBuilder,
      environment: options.configBuilder.environment ?? getLocalBashEnvironment,
    }),
    modelResolver: options.modelResolver,
  });
}

export function createAgentHostRuntimeLifecycle(
  runtime: Pick<AgentRuntime, 'disposeSession'>,
  mutations?: Pick<LocalTurnPermissionMutationOwner, 'clearSession'>,
): AgentHostRuntimeLifecycle {
  return {
    async disposeSession(sessionId) {
      await Promise.all([
        disposeRuntimeSession(runtime, sessionId),
        mutations?.clearSession(sessionId) ?? Promise.resolve(),
      ]);
    },
  };
}

function configuredNormalExtensions(
  extensions: readonly AgentExtension[] | undefined,
): readonly AgentExtension[] {
  return extensions ?? [];
}

async function disposeRuntimeSession(
  runtime: Pick<AgentRuntime, 'disposeSession'>,
  sessionId: string,
): Promise<void> {
  runtime.disposeSession(sessionId);
}

function withTurnRuntimeFacts<TAgent extends AgentExecutionSnapshot>(
  turnRuntimeFacts: AgentHostDependencies<TAgent>['turnRuntimeFacts'],
): Pick<AgentHostDependencies<TAgent>, 'turnRuntimeFacts'> {
  return turnRuntimeFacts ? { turnRuntimeFacts } : {};
}

function createToolCatalogSource(
  options: NativeLocalTurnToolCatalogOptions,
): LocalTurnToolCatalogSource {
  return {
    build: (input) => buildToolCatalog(options, input),
  };
}

async function buildToolCatalog(
  options: NativeLocalTurnToolCatalogOptions,
  input: LocalTurnToolCatalogBuildInput,
) {
  return buildLocalTurnToolCatalog({
    sessionId: input.sessionId,
    sources: await options.resolveSources(toolCatalogSourceInput(input)),
    llmModel: input.llmModel,
    effectivePluginSkills: input.effectivePluginSkills,
    userText: input.userText,
    ...toolCatalogBuildOptions(options, input),
  });
}

function toolCatalogSourceInput(
  input: LocalTurnToolCatalogBuildInput,
): Parameters<NativeLocalTurnToolCatalogOptions['resolveSources']>[0] {
  return {
    ...input,
    ...agentProfileSourceOptions(input.agentProfile),
    ...runtimeSkillSelectorFacts(input.agentProfile),
  };
}

function agentProfileSourceOptions(
  profile: LocalTurnToolCatalogBuildInput['agentProfile'],
): Pick<
  Parameters<NativeLocalTurnToolCatalogOptions['resolveSources']>[0],
  | 'excludeAgentResources'
  | 'skipAgentResolution'
  | 'expectedAgentInstanceId'
  | 'agentMemoryEnabled'
  | 'agentMemoryReadNames'
> {
  return {
    ...(profile?.excludeAgentResources ? { excludeAgentResources: true } : {}),
    ...(profile?.skipAgentResolution ? { skipAgentResolution: true } : {}),
    ...(profile?.expectedAgentInstanceId
      ? { expectedAgentInstanceId: profile.expectedAgentInstanceId }
      : {}),
    ...(profile?.agentMemoryEnabled === undefined
      ? {}
      : { agentMemoryEnabled: profile.agentMemoryEnabled }),
    ...(profile?.agentMemoryReadNames === undefined
      ? {}
      : { agentMemoryReadNames: profile.agentMemoryReadNames }),
  };
}

function toolCatalogBuildOptions(
  options: NativeLocalTurnToolCatalogOptions,
  input: LocalTurnToolCatalogBuildInput,
) {
  return {
    ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
    ...(input.modelCapabilities ? { modelCapabilities: input.modelCapabilities } : {}),
    ...(input.agentProfile ? { agentProfile: input.agentProfile } : {}),
    ...(input.withheldToolNames ? { withheldToolNames: input.withheldToolNames } : {}),
    ...(options.config ? { config: options.config } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.emitDiagnostic ? { emitDiagnostic: options.emitDiagnostic } : {}),
    ...(options.hostCapabilityRegistry
      ? { hostCapabilityRegistry: options.hostCapabilityRegistry }
      : {}),
  };
}

function runtimeSkillSelectorFacts(
  profile: LocalTurnToolCatalogBuildInput['agentProfile'],
): Pick<
  Parameters<NativeLocalTurnToolCatalogOptions['resolveSources']>[0],
  'allowedSkillNames' | 'allowedExtensionSkillNames'
> {
  const selection = profile?.configSelection;
  return {
    ...(selection?.skills === undefined ? {} : { allowedSkillNames: selection.skills }),
    ...(selection?.extensionSkills === undefined
      ? {}
      : { allowedExtensionSkillNames: selection.extensionSkills }),
  };
}
