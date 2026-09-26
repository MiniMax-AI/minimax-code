import { randomUUID } from 'node:crypto';

import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-coding-agent/compaction';
import type { PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';
import { resolveCompactionTokenBudget } from '@mavis/context-manager';

import type {
  ContextCompactionHooks,
  ContextCompactionResult,
  ContextCompactor,
  ManualContextCompactionInput,
  PromptSnapshotSource,
} from '../agent-host/contracts.js';
import {
  compactContext,
  type CompactContextDecision,
  type CompactContextInput,
} from './algorithm/compact-context.js';
import { createCheckpointSession } from './execution/checkpoint-provider.js';
import { checkpointMaxOutputTokens } from './execution/checkpoint-prompt.js';
import { createLocalContextFootprintMeasurer } from './execution/local-context-footprint.js';
import type { SubagentCheckpointStateSource } from './contracts.js';

/** Manual caller: bypasses the automatic trigger and transient filters. */
export class LocalContextCompactor implements ContextCompactor {
  constructor(
    private readonly checkpointState?: SubagentCheckpointStateSource,
    private readonly logger?: Pick<PiTurnRunnerLogger, 'warn' | 'error'>,
    private readonly promptSnapshots?: PromptSnapshotSource,
  ) {}

  async compactManual(
    input: ManualContextCompactionInput,
    hooks?: ContextCompactionHooks,
  ): Promise<ContextCompactionResult> {
    input.signal?.throwIfAborted();
    const preparation = prepareManualCompaction(input);
    await hooks?.onStarted();
    input.signal?.throwIfAborted();
    const decision = await runManualPolicy({
      input,
      hooks,
      preparation,
      checkpointState: this.checkpointState,
      logger: this.logger,
      promptSnapshots: this.promptSnapshots,
    });
    logManualReplacementGrowthBestEffort(this.logger, input.sessionId, decision, {
      providerInputLimit: preparation.providerInputLimit,
    });
    return completedManualCompaction(preparation.history, decision);
  }
}

function prepareManualCompaction(input: ManualContextCompactionInput) {
  const history = [...input.messages];
  const measurer = createLocalContextFootprintMeasurer({
    model: input.model,
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }),
    ...(input.tools === undefined ? {} : { tools: input.tools }),
  });
  const before = measurer.measure(history);
  return {
    history,
    measurer,
    before,
    providerInputLimit: resolveCompactionTokenBudget({
      contextWindow: input.model.contextWindow,
      configuredMaxOutputTokens: input.maxTokens ?? input.model.maxTokens,
    }).providerInputLimit,
  };
}

async function runManualPolicy(options: {
  readonly input: ManualContextCompactionInput;
  readonly hooks?: ContextCompactionHooks;
  readonly preparation: ReturnType<typeof prepareManualCompaction>;
  readonly checkpointState?: SubagentCheckpointStateSource;
  readonly logger?: Pick<PiTurnRunnerLogger, 'warn' | 'error'>;
  readonly promptSnapshots?: PromptSnapshotSource;
}) {
  const { input, hooks, preparation } = options;
  return compactContext({
    history: preparation.history,
    ...(input.customInstructions === undefined ? {} : { instructions: input.customInstructions }),
    limits: manualLimits(input, preparation.providerInputLimit),
    measurePair: async (pair) => preparation.measurer.measurePair(pair),
    allowLegacyToolTrim: false,
    // An explicit user request always commits a validly generated checkpoint.
    // Growth is possible on short histories (checkpoint output cap plus host
    // appendix) and stays bounded; it is observed below, never intercepted.
    finalAdmission: 'bypass',
    checkpoint: manualCheckpoint({
      input,
      hooks,
      tokensBefore: preparation.before.inputTokens,
      providerInputLimit: preparation.providerInputLimit,
      promptSnapshots: options.promptSnapshots,
    }),
    ...manualSubagentCapture(input.sessionId, options.checkpointState, options.logger),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
}

function manualLimits(
  input: ManualContextCompactionInput,
  providerInputLimit: number,
): CompactContextInput['limits'] {
  return {
    providerInputLimit,
    ...(input.maxSerializedInputBytes === undefined
      ? {}
      : { maxSerializedInputBytes: input.maxSerializedInputBytes }),
  };
}

function manualCheckpoint({
  input,
  hooks,
  tokensBefore,
  providerInputLimit,
  promptSnapshots,
}: {
  readonly input: ManualContextCompactionInput;
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
    open: async () => {
      if (!input.streamFn) {
        throw new TypeError('Manual context compaction requires streamFn for checkpoint.');
      }
      return createCheckpointSession({
        model: input.model,
        streamFn: input.streamFn,
        thinkingLevel: input.thinkingLevel,
        providerInputLimit,
        maxOutputTokens: checkpointMaxOutputTokens(
          DEFAULT_COMPACTION_SETTINGS.reserveTokens,
          input.maxTokens ?? input.model.maxTokens,
          input.model.contextWindow,
        ),
        ...(input.maxSerializedInputBytes === undefined
          ? {}
          : { maxSerializedInputBytes: input.maxSerializedInputBytes }),
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        ...(input.headers === undefined ? {} : { headers: input.headers }),
        ...(input.payloadTransform === undefined
          ? {}
          : { payloadTransform: input.payloadTransform }),
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
    },
  };
}

function manualSubagentCapture(
  sessionId: string,
  checkpointState: SubagentCheckpointStateSource | undefined,
  logger: Pick<PiTurnRunnerLogger, 'warn' | 'error'> | undefined,
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

/**
 * Manual compaction commits without the final admission gate, so a replacement
 * larger than the original history is possible on short histories. The commit
 * stands (explicit user request); growth only leaves a content-free trace.
 */
function logManualReplacementGrowthBestEffort(
  logger: Pick<PiTurnRunnerLogger, 'warn' | 'error'> | undefined,
  sessionId: string,
  decision: CompactContextDecision,
  limits: { readonly providerInputLimit: number },
): void {
  try {
    const { before, after } = decision.measurement;
    if (
      after.inputTokens <= before.inputTokens &&
      after.serializedBytes <= before.serializedBytes
    ) {
      return;
    }
    logger?.warn?.(
      {
        event: 'manual_compaction_replacement_grew',
        session_id: sessionId,
        method: decision.method,
        provider_input_limit: limits.providerInputLimit,
        before_input_tokens: before.inputTokens,
        before_serialized_bytes: before.serializedBytes,
        after_input_tokens: after.inputTokens,
        after_serialized_bytes: after.serializedBytes,
      },
      '[local-runtime-v2] manual compaction replacement grew',
    );
  } catch {
    // Observability must never change the compaction outcome.
  }
}

function completedManualCompaction(
  history: ManualContextCompactionInput['messages'],
  decision: CompactContextDecision,
): ContextCompactionResult {
  const completed = {
    status: 'completed' as const,
    compactionId: `ctx_${randomUUID()}`,
    strategyVersion: 'local-context-compaction-v3',
    method: decision.method,
    replacementMessages: [...decision.replacementMessages],
    messagesBefore: history.length,
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
        replacementSourceIndexes: history.map((_message, index) => index),
      };
}

function hmidRecoveryMetadata(decision: CompactContextDecision): {
  readonly hmidOverflowRecovered?: true;
} {
  return decision.method === 'llm_checkpoint' && decision.hmidOverflowRecovered
    ? { hmidOverflowRecovered: true }
    : {};
}
