import type { RuntimeTool } from '@mavis/agent-core/tools';
import type { AgentHostPluginHookHandler } from '../plugin-hook-contracts.js';

export interface AgentHostTurnSkillCapability {
  readonly pluginName: string;
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly location: string;
  readonly sourceKind: string;
}

export interface AgentHostTurnPluginCapability {
  readonly name: string;
  readonly version?: string;
  readonly source: 'official' | 'local';
  readonly iconUrl?: string;
  readonly darkIconUrl?: string;
  readonly displayName?: string;
  readonly iconPath?: string;
  readonly appProviders: readonly string[];
}

export interface AgentHostTurnHostBinding {
  readonly pluginName: string;
  readonly packageDigest: string;
  readonly bindingId: string;
  readonly logicalToolName: string;
  readonly hostCapability: {
    readonly id: string;
    readonly version: number;
  };
  readonly toolRef: string;
  readonly requiredSkillRuntimeNames: readonly string[];
  readonly allowedSurfaces: readonly ['interactive'];
}

/**
 * Plugin subagent definition (official or LOCAL package) frozen with this
 * generation. Selectors use the Custom Agent encoding: `undefined` inherits,
 * `[]` explicitly disables.
 */
export interface AgentHostTurnPluginAgent {
  /** Task target `<plugin>:<agent>`. */
  readonly scopedName: string;
  readonly pluginName: string;
  readonly agentName: string;
  readonly sourceFormat: 'minimax' | '\u0063\u006c\u0061\u0075\u0064\u0065';
  /** Whether the owning package came from the official Marketplace or a LOCAL import. */
  readonly origin: 'official' | 'local';
  readonly packageDigest: string;
  readonly pluginRoot: string;
  readonly description: string;
  readonly displayName?: string;
  /** Unsubstituted Markdown body. */
  readonly systemPrompt: string;
  readonly model?: string;
  readonly effort?: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly skills?: readonly string[];
  readonly extensionSkills?: readonly string[];
  /** MCP server names this Plugin package declares, whether or not they published tools. */
  readonly declaredMcpServers?: readonly string[];
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
}

export interface AgentHostTurnPluginAgentRoster {
  list(): readonly AgentHostTurnPluginAgent[];
  /** Case-insensitive `<plugin>:<agent>` lookup within this Turn lease. */
  resolve(scopedName: string): AgentHostTurnPluginAgent | undefined;
}

export function createPluginAgentRoster(
  agents: readonly AgentHostTurnPluginAgent[],
): AgentHostTurnPluginAgentRoster {
  const byName = new Map(agents.map((agent) => [pluginAgentKey(agent.scopedName), agent]));
  return Object.freeze({
    list: () => agents,
    resolve: (scopedName: string) => byName.get(pluginAgentKey(scopedName)),
  });
}

function pluginAgentKey(name: string): string {
  return name.trim().normalize('NFKC').toLowerCase();
}

export type AgentHostTurnToolMode = 'omit' | 'inline' | 'tool_search';

export interface AgentHostTurnRuntimeToolBinding {
  readonly kind: 'app' | 'mcp';
  readonly source: string;
  readonly pluginName?: string;
  readonly toolMode?: AgentHostTurnToolMode;
  readonly tool: RuntimeTool;
}

/** Immutable Plugin/App/MCP projection captured for exactly one v2 execution. */
export interface AgentHostTurnCapabilityView {
  readonly revision: string;
  readonly plugins: readonly AgentHostTurnPluginCapability[];
  readonly skills: readonly AgentHostTurnSkillCapability[];
  readonly runtimeTools: readonly RuntimeTool[];
  readonly runtimeToolBindings: readonly AgentHostTurnRuntimeToolBinding[];
  readonly hostBindings?: readonly AgentHostTurnHostBinding[];
  readonly hooks?: readonly AgentHostPluginHookHandler[];
  readonly agents?: readonly AgentHostTurnPluginAgent[];
}

export interface AgentHostTurnCapabilityPreparation {
  readonly runtimeTools: readonly RuntimeTool[];
  readonly runtimeToolBindings: readonly AgentHostTurnRuntimeToolBinding[];
}

export interface AgentHostTurnCapabilityProvider {
  waitUntilReady(options?: { readonly allowPendingPublication: boolean }): Promise<void>;
  prepareTurnCapabilities?(signal?: AbortSignal): Promise<AgentHostTurnCapabilityPreparation>;
  captureTurnCapabilities(
    preparation?: AgentHostTurnCapabilityPreparation,
  ): AgentHostTurnCapabilityView;
  retainTurnCapabilities?(capabilities: AgentHostTurnCapabilityView): void;
  releaseTurnCapabilities?(capabilities: AgentHostTurnCapabilityView): void;
  onHostIdle(): void;
}

export interface AgentHostTurnPublicationPort {
  readonly activeTurnCount: number;
  tryPublish(publish: () => Promise<void>): Promise<void> | undefined;
}

export interface AgentHostTurnCapabilityLease {
  readonly capabilities?: AgentHostTurnCapabilityView;
  release(): boolean;
}

interface PublicationGate {
  readonly token: object;
  readonly promise: Promise<void>;
}

interface InFlightTurn {
  readonly sessionId: string;
  readonly turnId: string;
  readonly capabilities?: AgentHostTurnCapabilityView;
}

/**
 * Owns the v2 execution/publication boundary. TurnSystem remains the authority
 * for session admission; this lifecycle leases the capability generation
 * captured by every accepted execution while allowing a newer generation to
 * publish atomically for subsequently admitted turns.
 */
export class AgentHostTurnCapabilityLifecycle {
  private provider: AgentHostTurnCapabilityProvider | undefined;
  private publicationGate: PublicationGate | undefined;
  private readonly inFlight = new Map<object, InFlightTurn>();

  attach(provider: AgentHostTurnCapabilityProvider): AgentHostTurnPublicationPort {
    if (this.provider) throw new Error('AgentHost turn capability provider is already attached');
    this.provider = provider;
    const activeTurnCount = () => this.inFlight.size;
    return {
      get activeTurnCount() {
        return activeTurnCount();
      },
      tryPublish: (publish) => this.tryPublish(publish),
    };
  }

  async acquire(input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly captureCapabilities?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<AgentHostTurnCapabilityLease> {
    const provider = this.provider;
    const allowPendingPublication = [...this.inFlight.values()].some(
      (turn) => turn.sessionId === input.sessionId,
    );
    if (provider) await provider.waitUntilReady({ allowPendingPublication });
    const preparation =
      provider && input.captureCapabilities !== false
        ? await provider.prepareTurnCapabilities?.(input.signal)
        : undefined;
    await this.waitForPublication();

    // No await below this point: capture + registration is one JS critical section.
    const capabilities =
      provider && input.captureCapabilities !== false
        ? provider.captureTurnCapabilities(preparation)
        : undefined;
    if (capabilities) provider?.retainTurnCapabilities?.(capabilities);
    const token = {};
    const turn = {
      sessionId: input.sessionId,
      turnId: input.turnId,
      ...(capabilities ? { capabilities } : {}),
    };
    this.inFlight.set(token, turn);
    return {
      ...(capabilities ? { capabilities } : {}),
      release: () => this.release(token, turn),
    };
  }

  private release(token: object, turn: InFlightTurn): boolean {
    if (this.inFlight.get(token) !== turn) return false;
    this.inFlight.delete(token);
    if (turn.capabilities) this.provider?.releaseTurnCapabilities?.(turn.capabilities);
    if (this.inFlight.size === 0) this.provider?.onHostIdle();
    return true;
  }

  private async waitForPublication(): Promise<void> {
    for (;;) {
      const gate = this.publicationGate;
      if (!gate) return;
      await gate.promise;
    }
  }

  private tryPublish(publish: () => Promise<void>): Promise<void> | undefined {
    if (this.publicationGate) return undefined;
    const token = {};
    const startSignal = createDeferredSignal();
    const completion = runPublication(startSignal.promise, publish);
    const gate = this.settlePublication(token, completion);
    this.publicationGate = { token, promise: gate };
    startSignal.resolve();
    return completion;
  }

  private async settlePublication(token: object, completion: Promise<void>): Promise<void> {
    try {
      await completion;
    } catch {
      // The caller observes publication failure; execution admission only waits for settlement.
    } finally {
      if (this.publicationGate?.token === token) {
        this.publicationGate = undefined;
        if (this.inFlight.size === 0) this.provider?.onHostIdle();
      }
    }
  }
}

async function runPublication(
  startSignal: Promise<void>,
  publish: () => Promise<void>,
): Promise<void> {
  await startSignal;
  await publish();
}

function createDeferredSignal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
