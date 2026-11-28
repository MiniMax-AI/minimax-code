import {
  formatModelKey,
  formatRuntimeModelIdentity,
  type ResolvedAdvisorModel,
  type LocalResolvedModelConfig,
} from '../../service/model-system/index.js';
import type { SessionRecord } from '../../service/session-system/index.js';
import {
  buildLocalRequestPayloadTransform,
  readSessionAgentExecutionSnapshot,
  type ProductionAgentPreparation,
  type ProductionAgentProductCapabilities,
} from '../../service/turn-system/index.js';
import { AdvisorCaptureStore, createAdvisorExtension } from './advisor-capture.js';
import { createAdvisorTool, shortReason, type AdvisorRequestModel } from './advisor-tool.js';

type PayloadRuntime = Parameters<typeof buildLocalRequestPayloadTransform>[1];

export interface AdvisorAgentProductDependencies {
  /** Late-bound: the production preparation exists only after the product is composed. */
  readonly preparation: () => Pick<ProductionAgentPreparation, 'buildAgentConfig' | 'resolveModel'>;
  /** Late-bound Session reads and the Session usage projector. */
  readonly sessions: () => {
    getExecutionSnapshot(sessionId: string): Promise<SessionRecord | undefined>;
    recordUsage(input: {
      readonly sessionId: string;
      readonly turnId: string;
      readonly model?: unknown;
      readonly messages: readonly unknown[];
    }): Promise<void>;
  };
  /** The Turn executor's Files API wiring, so images reach the advisor as file references too. */
  readonly fileApi: NonNullable<PayloadRuntime['fileApi']>;
  /** Records why a call found its model unavailable; the main model is only told that it is. */
  readonly logger: { warn(fields: Record<string, unknown>, message: string): void };
  readonly nowMs?: () => number;
}

/**
 * Connects the advisor tool to Turn execution: the tool in every Turn's raw inventory (the
 * catalog offers it only when the Turn bound an advisor model), plus the one extension that
 * tells the main model when to call it and captures what the main model sees. Apply it where
 * the product is composed, not only at the AgentHost: Task capture reads the same inventory to
 * freeze an explicit `advisor` selection.
 */
export function withAdvisorAgentProduct(
  product: ProductionAgentProductCapabilities,
  dependencies: AdvisorAgentProductDependencies,
): ProductionAgentProductCapabilities {
  const captures = new AdvisorCaptureStore();
  // The runtime options the Turn executor gives its own requests' payload transform.
  const payloadRuntime: PayloadRuntime = {
    fileApi: dependencies.fileApi,
    ...(dependencies.nowMs ? { nowMs: dependencies.nowMs } : {}),
  };
  const tool = createAdvisorTool({
    captures,
    resolveModel: (input) => resolveAdvisorRequestModel(product, dependencies, input),
    buildPayloadTransform: (input) => buildLocalRequestPayloadTransform(input, payloadRuntime),
    // The advisor's cost is the Turn's: its row shares the Turn id, so rewinding the Turn removes it.
    recordUsage: (input) =>
      dependencies.sessions().recordUsage({
        sessionId: input.sessionId,
        turnId: input.turnId,
        model: input.model,
        messages: input.messages,
      }),
    // A Goal charges the advisor's tokens like its compaction: counted, never admitted.
    usageRecorder: (turn) =>
      (product as { readonly turnUsageRecorder?: (t: typeof turn) => import('@mavis/agent-core/pi-turn-runner').LLMUsageRecorder | undefined }).turnUsageRecorder?.(turn),
    ...(dependencies.nowMs ? { nowMs: dependencies.nowMs } : {}),
  });
  return {
    ...product,
    toolSources: {
      resolve: async (input) => {
        const base = await product.toolSources.resolve(input);
        return input.toolsDisabled ? base : { ...base, nativeTools: [...base.nativeTools, tool] };
      },
    },
    normalExtensions: [createAdvisorExtension(captures), ...(product.normalExtensions ?? [])],
  };
}

/**
 * Resolves the advisor's model with credentials through the same AgentConfig and model resolver
 * path as a Turn, pinned to the selection with a frozen override. A result for any other
 * provider or model counts as unavailable: the advisor never falls back to the main model.
 * Every unavailable result is logged with its cause.
 */
async function resolveAdvisorRequestModel(
  product: ProductionAgentProductCapabilities,
  dependencies: AdvisorAgentProductDependencies,
  input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly binding: ResolvedAdvisorModel;
  },
): Promise<AdvisorRequestModel | undefined> {
  const unavailable = (code: string, reason: string): undefined => {
    dependencies.logger.warn(
      {
        session_id: input.sessionId,
        turn_id: input.turnId,
        advisor_model: formatModelKey(input.binding.providerId, input.binding.modelId),
        code,
        reason,
      },
      '[advisor] the selected advisor model cannot be resolved; this call returns no advice',
    );
    return undefined;
  };
  try {
    const session = await dependencies.sessions().getExecutionSnapshot(input.sessionId);
    if (!session) return unavailable('session_missing', 'the Session no longer exists');
    const agent = await readSessionAgentExecutionSnapshot(product.agents, session);
    if (!agent) return unavailable('agent_missing', "the Session's Agent cannot be read");
    const preparation = dependencies.preparation();
    const { binding } = input;
    const agentConfig = await preparation.buildAgentConfig({
      session,
      agent,
      model: {
        provider_id: binding.providerId,
        model_id: binding.modelId,
        ...(binding.effort === undefined ? {} : { thinking: { effort: binding.effort } }),
        contextLimit: binding.contextWindow,
        frozen: true,
      },
      isSessionFirstTurn: false,
    });
    if (!isSelectedModel(agentConfig.model, binding)) {
      const resolved = formatRuntimeModelIdentity(agentConfig.model) ?? 'no model';
      return unavailable('model_mismatch', `resolved to ${resolved}`);
    }
    const llm: LocalResolvedModelConfig = await preparation.resolveModel({
      sessionId: input.sessionId,
      turnId: advisorTurnId(input.turnId),
      agentConfig,
    });
    return { agentConfig: { ...agentConfig }, llm };
  } catch (error) {
    return unavailable('resolution_failed', shortReason(error));
  }
}

function isSelectedModel(model: unknown, binding: ResolvedAdvisorModel): boolean {
  return formatRuntimeModelIdentity(model) === formatModelKey(binding.providerId, binding.modelId);
}

/** The advisor request's own identity for model resolution. */
function advisorTurnId(turnId: string): string {
  return `${turnId}:advisor`;
}
