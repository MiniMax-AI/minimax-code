import type { RuntimeTool } from '@mavis/agent-core/tools';

import type { AgentHostTurnHostBinding } from '../turn-capability-lifecycle.js';

export type HostCapabilitySurface = 'interactive' | 'task-child' | 'cli';

export interface HostCapabilityAdapter {
  readonly capability: {
    readonly id: string;
    readonly version: number;
  };
  selectTarget(tools: readonly RuntimeTool[]): RuntimeTool | undefined;
  /** Exact input contract when a compact target validates more than its outer schema. */
  describeInput?(target: RuntimeTool): RuntimeTool['def']['schema'];
  /** Host-owned public tool factory, called only after Binding admission; omitted means gateway. */
  exposeTool?(binding: HostCapabilityReferenceTarget): RuntimeTool;
}

export interface HostCapabilityReferenceTarget {
  readonly tool: RuntimeTool;
  readonly pluginName: string;
  readonly requiredSkillRuntimeNames: readonly string[];
  readonly inputSchema: RuntimeTool['def']['schema'];
}

export interface HostCapabilityPrepareInput {
  readonly tools: readonly RuntimeTool[];
  readonly bindings: readonly AgentHostTurnHostBinding[];
  readonly surface: HostCapabilitySurface;
  readonly availableSkillRuntimeNames: ReadonlySet<string>;
}

export interface PreparedHostCapabilities {
  readonly publicTools: readonly RuntimeTool[];
  readonly referenceRegistry: ReadonlyMap<string, HostCapabilityReferenceTarget>;
}

export interface HostCapabilityResolver {
  /** Desktop keeps its gateway; CLI and its children add it only for real refs/deferred tools. */
  readonly reserveInlineGateway?: boolean;
  prepare(input: HostCapabilityPrepareInput): PreparedHostCapabilities;
}
