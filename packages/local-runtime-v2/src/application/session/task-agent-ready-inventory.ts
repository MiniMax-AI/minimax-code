import type { AgentExecutionProfile } from '../../service/agent/index.js';
import type { InitializedMcpService } from '../../service/mcp/index.js';
import type { InitializedPluginService } from '../../service/plugin-system/index.js';
import type { SessionRecord } from '../../service/session-system/index.js';
import type {
  AgentHostTurnCapabilityLifecycle,
  ProductionAgentProductCapabilities,
} from '../../service/turn-system/index.js';
import {
  createTaskAgentBindingCaptureCoordinator,
  type TaskAgentBindingCaptureCoordinator,
  type TaskAgentBindingCaptureOptions,
  type TaskAgentCapabilityInventory,
} from './task-agent-binding-capture.js';

interface TaskAgentBindingCaptureSink {
  bindTaskAgentBindingCapture(capture: TaskAgentBindingCaptureCoordinator): void;
}

interface TaskAgentBindingCaptureRuntimeInput {
  readonly agentService: TaskAgentBindingCaptureOptions['agentService'];
  readonly product: ProductionAgentProductCapabilities;
  readonly turnCapabilities: AgentHostTurnCapabilityLifecycle;
  readonly sessionSystem: {
    readonly sessions: { readonly records: TaskAgentBindingCaptureSink };
  };
  readonly options: {
    readonly runtimeOwnerKind?: string;
    readonly capabilityProfile?: 'cli';
  };
}

interface TaskAgentBindingCaptureServices {
  readonly plugin: InitializedPluginService;
  readonly mcp: InitializedMcpService;
}

type TaskAgentBindingCaptureDiagnostics = NonNullable<
  TaskAgentBindingCaptureOptions['diagnostics']
>;

/** Binds the ready-inventory Task capture after plugin and MCP owners exist. */
export function bindTaskAgentBindingCapture(
  input: TaskAgentBindingCaptureRuntimeInput,
  services: TaskAgentBindingCaptureServices,
  diagnostics: TaskAgentBindingCaptureDiagnostics,
): void {
  input.sessionSystem.sessions.records.bindTaskAgentBindingCapture(
    createTaskAgentBindingCaptureCoordinator({
      agentService: input.agentService,
      config: input.product.preparation.configBuilder.config,
      inventory: createTaskAgentReadyInventory({
        product: input.product,
        turnCapabilities: input.turnCapabilities,
        plugin: services.plugin,
        mcp: services.mcp,
      }),
      diagnostics,
      ...(input.options.runtimeOwnerKind
        ? { runtimeOwnerKind: input.options.runtimeOwnerKind }
        : {}),
      ...(input.options.capabilityProfile
        ? { capabilityProfile: input.options.capabilityProfile }
        : {}),
    }),
  );
}

/** Captures the ready Desktop capability generation used to freeze a new Task. */
function createTaskAgentReadyInventory(input: {
  readonly product: ProductionAgentProductCapabilities;
  readonly turnCapabilities: AgentHostTurnCapabilityLifecycle;
  readonly plugin: InitializedPluginService;
  readonly mcp: InitializedMcpService;
}): TaskAgentCapabilityInventory {
  return {
    capture: ({ session, profile }) => capture(input, session, profile),
  };
}

async function capture(
  input: Parameters<typeof createTaskAgentReadyInventory>[0],
  session: SessionRecord,
  profile: AgentExecutionProfile,
) {
  // Historical Task recovery can create a frozen binding before the Task's
  // first real Turn. Use the same ready capability owners that Turn admission
  // leases, rather than sampling stale configuration.
  await Promise.all([input.plugin.ready(), input.mcp.ready()]);
  const turnId = `session-agent-capture:${session.sessionId}:${profile.exactOwnerName}`;
  const lease = await input.turnCapabilities.acquire({ sessionId: session.sessionId, turnId });
  try {
    const builtinCapabilities = input.product.capabilities
      ? await input.product.capabilities.resolve(profile.exactOwnerName)
      : undefined;
    const sources = await input.product.toolSources.resolve({
      session,
      turnId,
      resourceAgentName: profile.resourceReadRef,
      ...(builtinCapabilities ? { builtinCapabilities } : {}),
      toolsDisabled: process.env.MAVIS_LOCAL_RUNTIME_DISABLE_TOOLS === '1',
      cuModeActive: input.product.turnRuntimeFacts.snapshot().cuModeActive,
      ...(lease.capabilities ? { desktopCapabilities: lease.capabilities } : {}),
    });
    const runtimeSkills = await input.product.preparation.configBuilder.skills.listRuntimeSkills(
      skillReadScope(session, profile),
    );
    return {
      sources,
      ...(lease.capabilities ? { desktopCapabilities: lease.capabilities } : {}),
      skills: runtimeSkills.skills.map((skill) => ({
        name: skill.name,
        ...(skill.sourceType === undefined ? {} : { sourceType: skill.sourceType }),
      })),
    };
  } finally {
    lease.release();
  }
}

/** A frozen owner without an Agent row (Plugin Agent) must not resolve Agent resources. */
function skillReadScope(session: SessionRecord, profile: AgentExecutionProfile) {
  return {
    agentName: profile.resourceReadRef,
    workspaceDir: session.workspaceDir,
    ...(profile.excludeAgentResources ? { excludeAgentResources: true } : {}),
    ...(profile.skipAgentResolution ? { skipAgentResolution: true } : {}),
  };
}
