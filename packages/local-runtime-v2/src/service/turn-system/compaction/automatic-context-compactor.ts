import { randomUUID } from 'node:crypto';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-coding-agent/compaction';
import type { PiBeforeLlmCallHook, PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';
import { resolveCompactionTokenBudget } from '@mavis/context-manager';

import type {
  AutomaticContextCompactionInput,
  AutomaticContextCompactionProbe,
  AutomaticContextCompactor as AutomaticContextCompactorPort,
  ContextCompactionHooks,
  ContextCompactionResult,
  PromptSnapshotSource,
} from '../agent-host/contracts.js';
import {
  compactContext,
  type CheckpointSession,
  type CompactContextDecision,
  type CompactContextInput,
} from './algorithm/compact-context.js';
import {
  ToolResultArchiver,
  type ToolResultArchivePlan,
  type ToolResultCompactionCandidate,
} from './algorithm/tool-result-archiver.js';
import { createCheckpointSession } from './execution/checkpoint-provider.js';
import { checkpointMaxOutputTokens } from './execution/checkpoint-prompt.js';
import { createLocalContextFootprintMeasurer } from './execution/local-context-footprint.js';
import { ContextUsageAnchorState } from './execution/usage-anchor.js';
import type { SubagentCheckpointStateSource } from './contracts.js';

interface AutomaticContextCompactorDependencies {
  readonly toolResultArchiver?: ToolResultArchiver;
  readonly promptSnapshots?: PromptSnapshotSource;
}

export class AutomaticContextCompactor implements AutomaticContextCompactorPort {
  private readonly toolResultArchiver?: ToolResultArchiver;
  private readonly promptSnapshots?: PromptSnapshotSource;

  constructor(
    private readonly usageAnchor: ContextUsageAnchorState | undefined,
    private readonly checkpointState: SubagentCheckpointStateSource | undefined,
    private readonly logger: Pick<PiTurnRunnerLogger, 'error'> | undefined,
    dependencies: AutomaticContextCompactorDependencies,
  ) {
    this.toolResultArchiver = dependencies.toolResultArchiver;
    this.promptSnapshots = dependencies.promptSnapshots;
  }

  probeBeforeLlm(input: AutomaticContextCompactionInput): AutomaticContextCompactionProbe {
    input.signal?.throwIfAborted();
    return {
      shouldStart: prepareAutomaticCompaction(input, this.usageAnchor, this.toolResultArchiver)
        .shouldStart,
    };
  }

  async compactBeforeLlm(
    input: AutomaticContextCompactionInput,
    hooks?: ContextCompactionHooks,
  ): Promise<ContextCompactionResult> {
    input.signal?.throwIfAborted();
    const preparation = prepareAutomaticCompaction(
      input,
      this.usageAnchor,
      this.toolResultArchiver,
    );
    if (!preparation.shouldStart) {
      return { status: 'unchanged', reason: 'nothing-to-compact' };
    }
    await hooks?.onStarted();
    input.signal?.throwIfAborted();
    const toolResultCompactionCandidate = await materializeToolResultCompactionBestEffort(
      this.toolResultArchiver,
      input.sessionId,
      preparation.toolResultCompactionPlan,
      preparation.canReadArchivedToolResults,
    );
    input.signal?.throwIfAborted();
    if (
      preparation.toolResultCompactionPlan &&
      !toolResultCompactionCandidate &&
      !preparation.normalTriggerMatched
    ) {
      return { status: 'unchanged', reason: 'nothing-to-compact' };
    }
    const decision = await runAutomaticPolicy({
      input,
      hooks,
      preparation,
      toolResultCompactionCandidate,
      checkpointState: this.checkpointState,
      logger: this.logger,
      legacyToolTrim: this.toolResultArchiver === undefined,
      promptSnapshots: this.promptSnapshots,
    });
    this.usageAnchor?.invalidate(input.sessionId);
    return completedAutomaticCompaction(input.messages, decision);
  }
}

function prepareAutomaticCompaction(
  input: AutomaticContextCompactionInput,
  usageAnchor: ContextUsageAnchorState | undefined,
  archiver: ToolResultArchiver | undefined,
) {
  const measurer = createAutomaticFootprintMeasurer(input, usageAnchor);
  const footprint = measurer.measure(input.messages);
  const { providerInputLimit, automaticTriggerAt } = resolveCompactionTokenBudget({
    contextWindow: input.model.contextWindow,
    configuredMaxOutputTokens: input.maxTokens ?? input.model.maxTokens,
  });
  const toolResultCompactionPlan = archiver?.plan({
    sessionId: input.sessionId,
    messages: input.messages,
  });
  const normalTriggerMatched =
    footprint.inputTokens > automaticTriggerAt ||
    (input.maxSerializedInputBytes !== undefined &&
      footprint.serializedBytes > input.maxSerializedInputBytes);
  return {
    measurer,
    footprint,
    toolResultCompactionPlan,
    canReadArchivedToolResults: hasReadTool(input.tools),
    normalTriggerMatched,
    shouldStart: toolResultCompactionPlan !== undefined || normalTriggerMatched,
    providerInputLimit,
  };
}

async function runAutomaticPolicy(options: {
  readonly input: AutomaticContextCompactionInput;
  readonly hooks?: ContextCompactionHooks;
  readonly preparation: ReturnType<typeof prepareAutomaticCompaction>;
  readonly toolResultCompactionCandidate: ToolResultCompactionCandidate | undefined;
  readonly checkpointState?: SubagentCheckpointStateSource;
  readonly logger?: Pick<PiTurnRunnerLogger, 'error'>;
  readonly legacyToolTrim: boolean;
  readonly promptSnapshots?: PromptSnapshotSource;
}) {
  const { input, hooks, preparation } = options;
  return compactContext({
    history: input.messages,
    limits: automaticLimits(input, preparation.providerInputLimit),
    measurePair: async (pair) => preparation.measurer.measurePair(pair),
    ...(options.toolResultCompactionCandidate
      ? { toolResultCompactionCandidate: options.toolResultCompactionCandidate }
      : {}),
    allowLegacyToolTrim: options.legacyToolTrim,
    checkpoint: automaticCheckpoint({
      input,
      hooks,
      tokensBefore: preparation.footprint.inputTokens,
      providerInputLimit: preparation.providerInputLimit,
      promptSnapshots: options.promptSnapshots,
    }),
    ...automaticSubagentCapture(input.sessionId, options.checkpointState, options.logger),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

function automaticLimits(
  input: AutomaticContextCompactionInput,
  providerInputLimit: number,
): CompactContextInput['limits'] {
  return {
    providerInputLimit,
    ...(input.maxSerializedInputBytes === undefined
      ? {}
      : { maxSerializedInputBytes: input.maxSerializedInputBytes }),
  };
}

function automaticCheckpoint({
  input,
  hooks,
  tokensBefore,
  providerInputLimit,
  promptSnapshots,
}: {
  readonly input: AutomaticContextCompactionInput;
  readonly hooks: ContextCompactionHooks | undefined;
  readonly tokensBefore: number;
  readonly providerInputLimit: number;
  readonly promptSnapshots: PromptSnapshotSource | undefined;
}): CompactContextInput['checkpoint'] {
  return {
    tokensBefore,
    timestamp: Date.now(),
    ...(hooks?.onCheckpointAttemptSettled
      ? { onAttemptSettled: hooks.onCheckpointAttemptSettled }
      : {}),
    ...(hooks?.getProviderTokenUsage ? { getTokenUsage: hooks.getProviderTokenUsage } : {}),
    open: () => openAutomaticCheckpoint(input, hooks, providerInputLimit, promptSnapshots),
  };
}

async function openAutomaticCheckpoint(
  input: AutomaticContextCompactionInput,
  hooks: ContextCompactionHooks | undefined,
  providerInputLimit: number,
  promptSnapshots: PromptSnapshotSource | undefined,
): Promise<CheckpointSession> {
  if (!input.streamFn) {
    throw new TypeError('Automatic context compaction requires streamFn.');
  }
  const session = await createCheckpointSession({
    model: input.model,
    streamFn: input.streamFn,
    thinkingLevel: input.thinkingLevel,
    providerInputLimit,
    maxOutputTokens: checkpointMaxOutputTokens(
      DEFAULT_COMPACTION_SETTINGS.reserveTokens,
      input.maxTokens ?? input.model.maxTokens,
    ),
    ...(input.maxSerializedInputBytes === undefined
      ? {}
      : { maxSerializedInputBytes: input.maxSerializedInputBytes }),
    ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    ...(input.payloadTransform === undefined ? {} : { payloadTransform: input.payloadTransform }),
    ...(hooks?.onProviderRequestSettled
      ? { onRequestSettled: hooks.onProviderRequestSettled }
      : {}),
    onGenerated: (generation) =>
      hooks?.onCheckpointGenerated?.({
        responseContentKinds: generation.responseContentKinds,
        stopReason: generation.stopReason,
        outputTokens: generation.outputTokens,
      }),
    ...(promptSnapshots ? { promptSnapshots } : {}),
  });
  const measure = session.measure;
  return {
    ...session,
    fits: (request) =>
      session.fits({
        ...request,
        messages: projectAutomaticContextRequestMessages(request.messages),
      }),
    ...(measure === undefined
      ? {}
      : {
          measure: (request: Parameters<NonNullable<CheckpointSession['measure']>>[0]) =>
            measure({
              ...request,
              messages: projectAutomaticContextRequestMessages(request.messages),
            }),
        }),
    generate: async (request) =>
      await session.generate({
        ...request,
        messages: projectAutomaticContextRequestMessages(request.messages),
      }),
  };
}

function automaticSubagentCapture(
  sessionId: string,
  checkpointState: SubagentCheckpointStateSource | undefined,
  logger: Pick<PiTurnRunnerLogger, 'error'> | undefined,
): Pick<CompactContextInput, 'captureSubagents' | 'onSubagentCaptureFailure'> {
  if (!checkpointState) return {};
  return {
    captureSubagents: () => checkpointState.captureSubagents({ sessionId }),
    onSubagentCaptureFailure: () =>
      logger?.error?.(
        {
          event: 'context_compaction_subagent_checkpoint_capture_failed',
          session_id: sessionId,
        },
        '[local-runtime-v2] subagent checkpoint state capture failed',
      ),
  };
}

function completedAutomaticCompaction(
  messages: readonly AgentMessage[],
  decision: CompactContextDecision,
): ContextCompactionResult {
  const completed = {
    status: 'completed' as const,
    compactionId: `ctx_${randomUUID()}`,
    strategyVersion: 'local-context-compaction-v3',
    method: decision.method,
    replacementMessages: [...decision.replacementMessages],
    messagesBefore: messages.length,
    messagesAfter: decision.replacementMessages.length,
    tokensBefore: decision.measurement.before.inputTokens,
    tokensAfter: decision.measurement.after.inputTokens,
    serializedBytesBefore: decision.measurement.before.serializedBytes,
    serializedBytesAfter: decision.measurement.after.serializedBytes,
    ...hmidRecoveryMetadata(decision),
    ...(decision.method === 'llm_checkpoint' && decision.tokenUsage !== undefined
      ? { tokenUsage: decision.tokenUsage }
      : {}),
  };
  return decision.method === 'llm_checkpoint'
    ? { ...completed, method: decision.method, summary: decision.summary }
    : {
        ...completed,
        method: decision.method,
        replacementSourceIndexes: messages.map((_message, index) => index),
      };
}

function hmidRecoveryMetadata(decision: CompactContextDecision): {
  readonly hmidOverflowRecovered?: true;
} {
  return decision.method === 'llm_checkpoint' && decision.hmidOverflowRecovered
    ? { hmidOverflowRecovered: true }
    : {};
}
function hasReadTool(tools: AutomaticContextCompactionInput['tools']): boolean {
  return tools?.some((tool) => tool.name === 'read') === true;
}

async function materializeToolResultCompactionBestEffort(
  archiver: ToolResultArchiver | undefined,
  sessionId: string,
  plan: ToolResultArchivePlan | undefined,
  canReadArchivedToolResults: boolean,
): Promise<ToolResultCompactionCandidate | undefined> {
  if (!archiver || !plan) return undefined;
  try {
    return canReadArchivedToolResults
      ? await archiver.materialize({ sessionId, plan })
      : await archiver.materializeTrim({ sessionId, plan });
  } catch {
    return undefined;
  }
}

export function createAutomaticContextRequestFilterHook(): PiBeforeLlmCallHook {
  return (input) => {
    const messages = projectAutomaticContextRequestMessages(input.messages);
    return messages === input.messages
      ? { type: 'continue' }
      : {
          type: 'replaceRequestMessages',
          messages: [...messages],
          reason: 'internal-context-filter',
        };
  };
}

function projectAutomaticContextRequestMessages(messages: readonly AgentMessage[]) {
  return messages;
}

export function createAutomaticFootprintMeasurer(
  input: AutomaticContextCompactionInput,
  usageAnchor: ContextUsageAnchorState | undefined,
) {
  return createLocalContextFootprintMeasurer({
    model: input.model,
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
    ...(usageAnchor
      ? {
          usageAnchor: usageAnchor.bind({
            scope: input.sessionId,
            provider: input.model.provider,
            api: input.model.api,
            model: input.model.id,
            ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
            ...(input.tools === undefined ? {} : { tools: input.tools }),
          }),
        }
      : {}),
  });
}
