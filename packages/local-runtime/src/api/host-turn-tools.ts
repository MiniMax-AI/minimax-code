import type { LocalSessionRecord } from '../sessions/controller.js';
import type { AgentBuiltinSkillId, ResolvedAgentCapabilities } from '@mavis/config';
import { buildLocalBashAdapter } from '../background-task/bash-runner.js';
import type {
  LocalMavisAgentAdapter,
  LocalMavisCronAdapter,
  LocalMavisSessionAdapter,
  LocalCodeReviewAdapter,
  LocalSandboxBashExecutionPort,
} from '@mavis/agent-tools/desktop';
import { buildLocalTurnToolSources, type LocalTurnToolSources } from './local-native-tools.js';
import { buildLocalTaskAdapter } from './local-task-runner.js';
import { buildLocalTaskAppendAdapter } from './local-task-append.js';
import { shouldEnableLocalTaskTool } from './local-task-tool-policy.js';
// Type-only import: erased at runtime, so it introduces no import cycle with host.ts.
import type { LocalRuntimeApiHost } from './host.js';
import type { DesktopTurnCapabilityView } from '../runtime/desktop-turn-capabilities.js';

export type BuildOwnerTurnToolSourcesInput = {
  session: LocalSessionRecord;
  resourceAgentName: string;
  excludeAgentResources?: boolean;
  expectedAgentInstanceId?: string;
  skipAgentResolution?: boolean;
  builtinCapabilities?: ResolvedAgentCapabilities;
  toolsDisabled: boolean;
  cuModeActive: boolean;
  /** Host-owned Mini App Tool is present for this exact execution surface. */
  miniappAvailable?: boolean;
  memoryEnabled?: boolean;
  memoryReadEnabled?: boolean;
  memoryWriteEnabled?: boolean;
  /** Per-Turn Agent profile gate; user/global Memory remains available. */
  memoryAgentScopeEnabled?: boolean;
  /** Canonical-first Runtime Memory aliases from the rendered Agent profile. */
  memoryReadAgentNames?: readonly string[];
  /** Frozen canonical standalone Skill selector from Agent configSelection. */
  allowedSkillNames?: readonly string[];
  /** Frozen extension Skill selector from Agent configSelection. */
  allowedExtensionSkillNames?: readonly string[];
  cronEnabled?: boolean;
  desktopCapabilities?: DesktopTurnCapabilityView;
  codeReviewAdapter?: LocalCodeReviewAdapter;
  disabledBuiltinSkillNames?: readonly AgentBuiltinSkillId[];
  resumeCodexAvailable?: boolean;
  sandboxOperationsFactory?: LocalSandboxBashExecutionPort;
};

export type OwnerTurnToolSources = LocalTurnToolSources;

/**
 * Passes the host getter itself, not its result: the host swaps in a new auth
 * object on every token refresh, so a Turn that outlives one access token must
 * read it per request instead of the Turn-start snapshot in `authContext`.
 */
function liveAuthSources(host: LocalRuntimeApiHost) {
  return {
    ...(host.authContextGetter ? { authContextGetter: host.authContextGetter } : {}),
    ...(host.authContextInvalidator
      ? { authContextInvalidator: host.authContextInvalidator }
      : {}),
  };
}

/**
 * Exposes only raw v1 product-domain tool sources to the hosted v2 runtime.
 * Final model gates, MCP disclosure and catalog ordering stay in AgentRuntime.
 */
export async function buildLocalTurnToolSourcesForHost(
  input: BuildOwnerTurnToolSourcesInput & {
    host: LocalRuntimeApiHost;
    mavisAgentAdapter: LocalMavisAgentAdapter;
    mavisCronAdapter?: LocalMavisCronAdapter;
    mavisSessionAdapter: LocalMavisSessionAdapter;
  },
): Promise<OwnerTurnToolSources> {
  const runtimeConfig = input.host.configGetter();
  const memoryAgentScopeEnabled =
    input.excludeAgentResources || input.session.sessionKind === 'task'
      ? false
      : input.memoryAgentScopeEnabled;
  return buildLocalTurnToolSources({
    toolsDisabled: input.toolsDisabled,
    dataDir: runtimeConfig.dataDir,
    configGetter: input.host.configGetter,
    workspaceRoot: input.session.workspaceDir,
    agentName: input.resourceAgentName,
    ...(input.excludeAgentResources ? { excludeAgentResources: true } : {}),
    ...(input.expectedAgentInstanceId
      ? { expectedAgentInstanceId: input.expectedAgentInstanceId }
      : {}),
    ...(input.skipAgentResolution ? { skipAgentResolution: true } : {}),
    sessionId: input.session.sessionId,
    authContext: input.host.authContextGetter?.(),
    ...liveAuthSources(input.host),
    routingContextGetter: input.host.routingContextGetter,
    fetchImpl: input.host.fetchImpl,
    nativeWebSearchEnabled: ['electron', 'tui', 'cli'].includes(input.host.getRuntimeOwnerKind()),
    mcpService: input.host.mcpService,
    threadGoal: input.host.threadGoal,
    questionnaireContext: input.host.supportsInteraction('questionnaireReply')
      ? input.host.questionnaireServiceDeps()
      : undefined,
    emitBusEvent: (type, payload) => input.host.emitBusEvent(type, payload),
    enableTaskTool: shouldEnableLocalTaskTool(input.session),
    bashAdapter: buildLocalBashAdapter(input.host, input.session, input.sandboxOperationsFactory),
    sandboxOperationsFactory: input.sandboxOperationsFactory,
    taskAdapter: buildLocalTaskAdapter(input.host, input.session),
    taskAppendAdapter: buildLocalTaskAppendAdapter(input.host),
    taskControlAdapter: input.host.backgroundTaskService,
    memoryFacade: input.host.memoryFacade,
    memoryEnabled: input.memoryEnabled ?? runtimeConfig.memory?.enabled !== false,
    memoryReadEnabled: input.memoryReadEnabled,
    memoryWriteEnabled: input.memoryWriteEnabled,
    ...(memoryAgentScopeEnabled === undefined ? {} : { memoryAgentScopeEnabled }),
    ...(input.memoryReadAgentNames === undefined
      ? {}
      : { memoryReadAgentNames: input.memoryReadAgentNames }),
    ...(input.allowedSkillNames === undefined
      ? {}
      : { allowedSkillNames: input.allowedSkillNames }),
    ...(input.allowedExtensionSkillNames === undefined
      ? {}
      : { allowedExtensionSkillNames: input.allowedExtensionSkillNames }),
    metrics: input.host.metrics,
    mavisAgentAdapter: input.mavisAgentAdapter,
    ...(input.cronEnabled !== false && input.mavisCronAdapter
      ? { mavisCronAdapter: input.mavisCronAdapter }
      : {}),
    mavisSessionAdapter: input.mavisSessionAdapter,
    cuModeActive: input.cuModeActive,
    ...(input.miniappAvailable === true ? { miniappAvailable: true } : {}),
    ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
    ...(input.builtinCapabilities ? { builtinCapabilities: input.builtinCapabilities } : {}),
    ...(input.disabledBuiltinSkillNames
      ? { disabledBuiltinSkillNames: input.disabledBuiltinSkillNames }
      : {}),
    ...(input.resumeCodexAvailable === true ? { resumeCodexAvailable: true } : {}),
    ...(input.codeReviewAdapter ? { codeReviewAdapter: input.codeReviewAdapter } : {}),
  });
}
