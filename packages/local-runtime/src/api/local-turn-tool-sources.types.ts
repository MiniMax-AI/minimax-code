import type { PiEventWriter } from '@mavis/agent-core/pi-turn-runner';
import type { RuntimeTool } from '@mavis/agent-core/tools';
import type { McpToolEntry } from '@mavis/agent-tools';
import type {
  LocalBashAdapter,
  LocalSandboxBashOperationsFactory,
  LocalCodeReviewAdapter,
  LocalMavisAgentAdapter,
  LocalMavisCronAdapter,
  LocalMavisSessionAdapter,
  LocalTaskAdapter,
  LocalTaskAppendAdapter,
  LocalTaskControlAdapter,
} from '@mavis/agent-tools/desktop';
import type { AgentBuiltinSkillId, ResolvedAgentCapabilities } from '@mavis/config';

import type { LocalRuntimeConfig } from '../config/types.js';
import type { DesktopTurnCapabilityView } from '../runtime/desktop-turn-capabilities.js';
import type { LocalRuntimeAuthContext } from '../runtime/model-resolver.js';
import type { LocalRuntimeRoutingContext } from '../runtime/routing-headers.js';
import type { ModuleMetricsReporter } from '../common/metrics.js';
import type { LocalMcpRuntimeCapability } from '../runtime/mcp-capability.js';
import type { LocalMemoryFacade } from '../memory/local-memory-facade.js';
import type { LocalQuestionnaireServiceDeps } from '../questionnaire/service.js';
import type { LocalThreadGoalIntegration } from '../thread-goal/host-integration.js';
import type { LocalRuntimeApiHostOptions } from './host-helpers.js';

export interface LocalTurnToolSourcesInput {
  toolsDisabled: boolean;
  dataDir: string;
  /** Read current policy when a new Bash child is started. */
  configGetter?: () => LocalRuntimeConfig;
  workspaceRoot: string;
  agentName: string;
  excludeAgentResources?: boolean;
  expectedAgentInstanceId?: string;
  skipAgentResolution?: boolean;
  eventWriter?: PiEventWriter;
  sessionId: string;
  authContext?: LocalRuntimeAuthContext;
  routingContextGetter?: () => LocalRuntimeRoutingContext | undefined;
  fetchImpl?: typeof fetch;
  matrixLogger?: LocalRuntimeApiHostOptions['matrixLogger'];
  /** Electron, embedded TUI and CLI use the native web_search tool. */
  nativeWebSearchEnabled?: boolean;
  mcpService: LocalMcpRuntimeCapability;
  threadGoal: LocalThreadGoalIntegration;
  questionnaireContext?: LocalQuestionnaireServiceDeps;
  emitBusEvent: (type: string, payload: Record<string, unknown>) => void;
  bashAdapter?: LocalBashAdapter;
  sandboxOperationsFactory?: LocalSandboxBashOperationsFactory;
  taskAdapter?: LocalTaskAdapter;
  taskAppendAdapter?: LocalTaskAppendAdapter;
  taskControlAdapter?: LocalTaskControlAdapter;
  enableTaskTool?: boolean;
  enableTaskControlTools?: boolean;
  /**
   * Set to `false` for subagent (task) turns: they run in hidden child
   * sessions, so their `todowrite` calls would only pollute the parent-facing
   * task list stream. Mirrors cloud-runtime `SubagentResolverFromConfig`,
   * which drops `todowrite` from every child tool catalog. Defaults to `true`
   * (regular visible turns keep the tool).
   */
  enableTodoWriteTool?: boolean;
  memoryFacade?: LocalMemoryFacade;
  mavisAgentAdapter?: LocalMavisAgentAdapter;
  mavisCronAdapter?: LocalMavisCronAdapter;
  mavisSessionAdapter?: LocalMavisSessionAdapter;
  codeReviewAdapter?: LocalCodeReviewAdapter;
  /** Optional metrics reporter injected by the host. Absent -> noop. */
  metrics?: ModuleMetricsReporter;
  /** Frozen CU active snapshot for this turn. Missing/false fails closed. */
  cuModeActive?: boolean;
  /** Host-owned Mini App Tool is present for this exact execution surface. */
  miniappAvailable?: boolean;
  desktopCapabilities?: DesktopTurnCapabilityView;
  /** Per-Agent Builtin admission resolved from agents.default + builtin agent.md. */
  builtinCapabilities?: ResolvedAgentCapabilities;
  /** Existing memory.enabled domain gate. Undefined preserves legacy enabled behavior. */
  memoryEnabled?: boolean;
  /** Session policy for read and search operations. Undefined preserves legacy enabled behavior. */
  memoryReadEnabled?: boolean;
  /** Session policy for memory mutations. Undefined preserves legacy enabled behavior. */
  memoryWriteEnabled?: boolean;
  /** Per-Turn Agent profile gate; user/global Memory remains available. */
  memoryAgentScopeEnabled?: boolean;
  /** Canonical-first Runtime Memory aliases from the rendered Agent profile. */
  memoryReadAgentNames?: readonly string[];
  /** Frozen canonical standalone Skill selector from Agent configSelection. */
  allowedSkillNames?: readonly string[];
  /** Frozen extension Skill selector from Agent configSelection. */
  allowedExtensionSkillNames?: readonly string[];
  disabledBuiltinSkillNames?: readonly AgentBuiltinSkillId[];
  resumeCodexAvailable?: boolean;
}

export interface LocalTurnToolSources {
  readonly nativeTools: readonly RuntimeTool[];
  readonly mcpEntries: readonly McpToolEntry[];
  readonly threadGoalTools: readonly RuntimeTool[];
  readonly cuRuntimeAvailable: boolean;
}
