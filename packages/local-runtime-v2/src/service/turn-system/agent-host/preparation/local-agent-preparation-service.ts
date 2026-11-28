import type { IAgentConfig } from '@mavis/protocol';

import type { SessionRecord } from '../../../session-system/index.js';
import {
  readAdvisorSelection,
  type LocalModelResolverLike,
  type LocalModelResolveInput,
} from '../../../model-system/index.js';
import {
  ADVISOR_TOOL_NAME,
  isLocalTurnBuiltinToolAllowed,
} from '../assembly/local-turn-tool-catalog.js';
import { readAgentProfile } from '../assembly/local-turn-tool-catalog-source.js';
import type {
  AgentExecutionSnapshot,
  ContextCompactionPreparationInput,
  ContextCompactionPreparationSource,
  LocalTurnPreparation,
  LocalTurnPreparationInput,
  LocalTurnPreparationSource,
} from './contracts.js';
import {
  LocalAgentConfigBuilder,
  type LocalAgentModelOverride,
  type TaskSessionBindingCapability,
} from './config/local-agent-config-builder.js';
import type { SessionModelRepairCapability } from './config/session-model-selection.js';

export interface LocalAgentPreparationServiceOptions {
  readonly configBuilder: LocalAgentConfigBuilder;
  readonly modelResolver: LocalModelResolverLike;
  readonly logger?: { warn(fields: Readonly<Record<string, unknown>>, message: string): void };
}

/**
 * Conversation preparation owner shared by normal turns, manual compaction,
 * archive title generation and Context Debug.
 */
export class LocalAgentPreparationService
  implements LocalTurnPreparationSource, ContextCompactionPreparationSource
{
  constructor(private readonly options: LocalAgentPreparationServiceOptions) {}

  /** Late-bound Session model repair; see `session-model-selection.ts`. */
  bindSessionModelRepair(repair: SessionModelRepairCapability): void {
    this.options.configBuilder.bindSessionModelRepair(repair);
  }

  /** Late-bound Task snapshot store. Ordinary Sessions remain live. */
  bindTaskSessionBindings(bindings: TaskSessionBindingCapability): void {
    this.options.configBuilder.bindTaskSessionBindings(bindings);
  }

  async prepare(input: LocalTurnPreparationInput): Promise<LocalTurnPreparation> {
    const model = toModelOverride(input.request.input.model);
    return this.prepareResolved({
      session: input.session,
      agent: input.agent,
      turnId: input.turnId,
      isSessionFirstTurn: input.history.messages.length === 0,
      ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
      ...(model ? { model } : {}),
      ...(input.request.clientIntent ? { clientIntent: input.request.clientIntent } : {}),
      ...(input.promptRead ? { promptRead: input.promptRead } : {}),
    });
  }

  prepareCompaction(input: ContextCompactionPreparationInput): Promise<LocalTurnPreparation> {
    return this.prepareResolved({
      session: input.session,
      agent: input.agent,
      turnId: input.turnId,
      isSessionFirstTurn: input.history.messages.length === 0,
      ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
    });
  }

  buildAgentConfig(input: {
    readonly session: SessionRecord;
    readonly agent: AgentExecutionSnapshot;
    readonly model?: LocalAgentModelOverride;
    readonly isSessionFirstTurn?: boolean;
    readonly desktopCapabilities?: LocalTurnPreparationInput['desktopCapabilities'];
    readonly clientIntent?: string;
    readonly promptRead?: LocalTurnPreparationInput['promptRead'];
  }): Promise<IAgentConfig> {
    return this.options.configBuilder.build({
      ...input,
      isSessionFirstTurn: input.isSessionFirstTurn ?? false,
    });
  }

  resolveModel(input: LocalModelResolveInput) {
    return this.options.modelResolver.resolveModel(input);
  }

  private async prepareResolved(input: {
    readonly session: SessionRecord;
    readonly agent: AgentExecutionSnapshot;
    readonly turnId: string;
    readonly model?: LocalAgentModelOverride;
    readonly isSessionFirstTurn: boolean;
    readonly desktopCapabilities?: LocalTurnPreparationInput['desktopCapabilities'];
    readonly clientIntent?: string;
    readonly promptRead?: LocalTurnPreparationInput['promptRead'];
  }): Promise<LocalTurnPreparation> {
    const built = await this.options.configBuilder.buildPrepared(input);
    const builtAgentConfig = built.agentConfig;
    const agentConfig = Object.freeze({ ...builtAgentConfig });
    const advisor = this.bindAdvisor(input, agentConfig);
    const llm = await this.resolveModel({
      sessionId: input.session.sessionId,
      turnId: input.turnId,
      agentConfig: builtAgentConfig,
    });
    return {
      agentConfig,
      llm,
      outputRevisionInstruction: built.outputRevisionInstruction,
      ...(built.retryContinuationPrompt
        ? { retryContinuationPrompt: built.retryContinuationPrompt }
        : {}),
      ...(built.promptRead ? { promptRead: built.promptRead } : {}),
      ...(advisor ? { advisor } : {}),
    };
  }

  private bindAdvisor(
    input: { readonly session: SessionRecord; readonly turnId: string },
    agentConfig: Parameters<typeof readAgentProfile>[0],
  ): ReturnType<typeof readAdvisorSelection>['advisor'] {
    const stored = input.session.advisor;
    if (!stored?.enabled) return undefined;
    if (!isLocalTurnBuiltinToolAllowed(ADVISOR_TOOL_NAME, readAgentProfile(agentConfig))) {
      return undefined;
    }
    const read = readAdvisorSelection(this.options.configBuilder.readRuntimeConfig(), stored);
    if (read.dropped.length > 0 || read.failure) {
      this.options.logger?.warn(
        {
          session_id: input.session.sessionId,
          turn_id: input.turnId,
          advisor_model: read.selection.model,
          ...(read.dropped.length > 0 ? { dropped: read.dropped } : {}),
          ...(read.failure ? { code: read.failure.code, reason: read.failure.message } : {}),
        },
        read.failure
          ? '[advisor] the stored advisor model cannot be used; this Turn runs without the advisor'
          : '[advisor] the stored advisor settings no longer apply; this Turn uses the model defaults',
      );
    }
    return read.advisor;
  }
}

function toModelOverride(
  model:
    | {
        readonly providerId?: string;
        readonly modelId?: string;
        readonly variant?: string;
        readonly reasoning?: boolean;
        readonly contextLimit?: number;
        readonly parameterSnapshot?: LocalAgentModelOverride['parameterSnapshot'];
        readonly thinking?: {
          readonly effort?: string;
        };
      }
    | undefined,
): LocalAgentModelOverride | undefined {
  if (!model) return undefined;
  const providerId = model.providerId?.trim();
  const modelId = model.modelId?.trim();
  const variant = model.variant === '' ? '' : model.variant?.trim() || undefined;
  const override: {
    provider_id?: string;
    model_id?: string;
    variant?: string;
    reasoning?: boolean;
    contextLimit?: number;
    parameterSnapshot?: LocalAgentModelOverride['parameterSnapshot'];
    thinking?: { effort?: string };
  } = preparedModelParameters(model);
  if (providerId) override.provider_id = providerId;
  if (modelId) override.model_id = modelId;
  if (variant !== undefined) override.variant = variant;
  return Object.keys(override).length > 0 ? override : undefined;
}

function preparedModelParameters(
  model: NonNullable<Parameters<typeof toModelOverride>[0]>,
): Pick<LocalAgentModelOverride, 'parameterSnapshot' | 'reasoning' | 'contextLimit' | 'thinking'> {
  const effort = model.thinking?.effort;
  return {
    ...(model.parameterSnapshot ? { parameterSnapshot: model.parameterSnapshot } : {}),
    ...(model.reasoning != null ? { reasoning: model.reasoning } : {}),
    ...(model.contextLimit != null ? { contextLimit: model.contextLimit } : {}),
    ...(model.thinking != null ? { thinking: effort != null ? { effort } : {} } : {}),
  };
}
