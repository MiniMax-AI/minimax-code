import { randomUUID } from 'node:crypto';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { DEFAULT_COMPACTION_SETTINGS } from '@earendil-works/pi-coding-agent/compaction';
import type { PiBeforeLlmCallHook, PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';
import {
  boundRequestMedia,
  fitRequestMedia,
  halfRequestMediaBudget,
  isArchivableRequestImage,
  recoveryRequestMediaBudget,
  resolveCompactionTokenBudget,
  resolveRequestMediaBudget,
  selectImagesToArchive,
  selectRequestImages,
  type RequestMediaBudget,
} from '@mavis/context-manager';

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
  type ToolResultCompactionCandidate,
  type ToolResultImageArchive,
} from './algorithm/tool-result-archiver.js';
import { createCheckpointSession } from './execution/checkpoint-provider.js';
import { checkpointMaxOutputTokens } from './execution/checkpoint-prompt.js';
import { createLocalContextFootprintMeasurer } from './execution/local-context-footprint.js';
import { ContextUsageAnchorState } from './execution/usage-anchor.js';
import type { EarlierFilesResolver, SubagentCheckpointStateSource } from './contracts.js';

interface AutomaticContextCompactorDependencies {
  readonly toolResultArchiver?: ToolResultArchiver;
  readonly promptSnapshots?: PromptSnapshotSource;
  /** User `contextManagement.compactionTriggerAt`; read per call. */
  readonly getCompactionTriggerAt?: () => number | undefined;
  /** `requestMedia.recoveryDivisor`; read for every compaction. */
  readonly getRecoveryDivisor?: () => number;
  readonly resolveEarlierFiles?: EarlierFilesResolver;
}

export class AutomaticContextCompactor implements AutomaticContextCompactorPort {
  private readonly toolResultArchiver?: ToolResultArchiver;
  private readonly promptSnapshots?: PromptSnapshotSource;
  private readonly getCompactionTriggerAt?: () => number | undefined;
  private readonly getRecoveryDivisor?: () => number;
  private readonly resolveEarlierFiles?: EarlierFilesResolver;

  constructor(
    private readonly usageAnchor: ContextUsageAnchorState | undefined,
    private readonly checkpointState: SubagentCheckpointStateSource | undefined,
    private readonly logger: Pick<PiTurnRunnerLogger, 'error'> | undefined,
    dependencies: AutomaticContextCompactorDependencies,
  ) {
    this.toolResultArchiver = dependencies.toolResultArchiver;
    this.promptSnapshots = dependencies.promptSnapshots;
    this.getCompactionTriggerAt = dependencies.getCompactionTriggerAt;
    this.getRecoveryDivisor = dependencies.getRecoveryDivisor;
    this.resolveEarlierFiles = dependencies.resolveEarlierFiles;
  }

  probeBeforeLlm(input: AutomaticContextCompactionInput): AutomaticContextCompactionProbe {
    input.signal?.throwIfAborted();
    return {
      shouldStart: prepareAutomaticCompaction(
        input,
        this.usageAnchor,
        this.toolResultArchiver,
        this.readCompactionTriggerAt(),
        this.getRecoveryDivisor?.(),
      ).shouldStart,
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
      this.readCompactionTriggerAt(),
      this.getRecoveryDivisor?.(),
    );
    if (!preparation.shouldStart) {
      return { status: 'unchanged', reason: 'nothing-to-compact' };
    }
    await hooks?.onStarted();
    input.signal?.throwIfAborted();
    const toolResultCompactionCandidate = await materializeToolResultCompactionBestEffort(
      this.toolResultArchiver,
      input,
      preparation,
    );
    input.signal?.throwIfAborted();
    if (!toolResultCompactionCandidate && !preparation.normalTriggerMatched) {
      return { status: 'unchanged', reason: 'nothing-to-compact' };
    }
    const decision = await runAutomaticPolicy({
      input,
      hooks,
      preparation,
      toolResultCompactionCandidate,
      checkpointState: this.checkpointState,
      logger: this.logger,
      archiver: this.toolResultArchiver,
      promptSnapshots: this.promptSnapshots,
      resolveEarlierFiles: this.resolveEarlierFiles,
    });
    this.usageAnchor?.invalidate(input.sessionId);
    return completedAutomaticCompaction(input.messages, decision);
  }

  /** A failing config read degrades to the built-in trigger. */
  private readCompactionTriggerAt(): number | undefined {
    try {
      return this.getCompactionTriggerAt?.();
    } catch {
      return undefined;
    }
  }
}

function prepareAutomaticCompaction(
  input: AutomaticContextCompactionInput,
  usageAnchor: ContextUsageAnchorState | undefined,
  archiver: ToolResultArchiver | undefined,
  compactionTriggerAt: number | undefined,
  recoveryDivisor: number | undefined,
) {
  const measurer = createAutomaticFootprintMeasurer(input, usageAnchor);
  const footprint = measurer.measure(input.messages);
  const { providerInputLimit, automaticTriggerAt } = resolveCompactionTokenBudget({
    contextWindow: input.model.contextWindow,
    configuredMaxOutputTokens: input.maxTokens ?? input.model.maxTokens,
    compactionTriggerAt,
  });
  const toolResultCompactionPlan = archiver?.plan({
    sessionId: input.sessionId,
    messages: input.messages,
  });
  const serializedBytesExceeded =
    input.maxSerializedInputBytes !== undefined &&
    footprint.serializedBytes > input.maxSerializedInputBytes;
  const normalTriggerMatched =
    footprint.inputTokens > automaticTriggerAt || serializedBytesExceeded;
  const imageArchiveTarget = archiver
    ? resolveImageArchiveTarget(input, recoveryDivisor)
    : undefined;
  return {
    measurer,
    footprint,
    toolResultCompactionPlan,
    imageArchiveTarget,
    canReadArchivedToolResults: hasReadTool(input.tools),
    normalTriggerMatched,
    shouldStart:
      toolResultCompactionPlan !== undefined ||
      imageArchiveTarget !== undefined ||
      normalTriggerMatched,
    providerInputLimit,
  };
}

/**
 * Image budget the history is archived down to: 1/`recoveryDivisor` of what a
 * rejected request carried when repeating it, or the request guard's low
 * watermark once the guard would drop a tool result image, so tool images
 * leave the history instead of being dropped again on every request.
 * `undefined` when no tool result image falls outside it.
 */
function resolveImageArchiveTarget(
  input: AutomaticContextCompactionInput,
  recoveryDivisor: number | undefined,
): RequestMediaBudget | undefined {
  const budget = resolveRequestMediaBudget(input);
  let target: RequestMediaBudget | undefined;
  if (input.recovery) {
    target = recoveryRequestMediaBudget(input.recovery.requestMessages, budget, recoveryDivisor);
  } else if (selectRequestImages(input.messages, budget).dropped.some(isArchivableRequestImage)) {
    target = halfRequestMediaBudget(budget);
  }
  if (!target) return undefined;
  return selectImagesToArchive(input.messages, target, isArchivableRequestImage).length > 0
    ? target
    : undefined;
}

async function runAutomaticPolicy(options: {
  readonly input: AutomaticContextCompactionInput;
  readonly hooks?: ContextCompactionHooks;
  readonly preparation: ReturnType<typeof prepareAutomaticCompaction>;
  readonly toolResultCompactionCandidate: ToolResultCompactionCandidate | undefined;
  readonly checkpointState?: SubagentCheckpointStateSource;
  readonly logger?: Pick<PiTurnRunnerLogger, 'error'>;
  readonly archiver: ToolResultArchiver | undefined;
  readonly promptSnapshots?: PromptSnapshotSource;
  readonly resolveEarlierFiles?: EarlierFilesResolver;
}) {
  const { input, hooks, preparation, archiver, resolveEarlierFiles } = options;
  return compactContext({
    history: input.messages,
    ...(resolveEarlierFiles
      ? { resolveEarlierFiles: () => resolveEarlierFiles(input.sessionId) }
      : {}),
    limits: automaticLimits(input, preparation.providerInputLimit),
    measurePair: async (pair) => preparation.measurer.measurePair(pair),
    ...(options.toolResultCompactionCandidate
      ? { toolResultCompactionCandidate: options.toolResultCompactionCandidate }
      : {}),
    allowLegacyToolTrim: archiver === undefined,
    ...(archiver
      ? {
          writeImageFile: (messages, image) =>
            archiver.writeImageFile({ sessionId: input.sessionId, messages }, image),
        }
      : {}),
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
      input.model.contextWindow,
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
  input: AutomaticContextCompactionInput,
  preparation: ReturnType<typeof prepareAutomaticCompaction>,
): Promise<ToolResultCompactionCandidate | undefined> {
  if (!archiver) return undefined;
  const { sessionId } = input;
  const plan = preparation.toolResultCompactionPlan;
  try {
    let text: ToolResultCompactionCandidate | undefined;
    if (plan) {
      text = preparation.canReadArchivedToolResults
        ? await archiver.materialize({ sessionId, plan })
        : await archiver.materializeTrim({ sessionId, plan });
    }
    const images = preparation.imageArchiveTarget
      ? await archiver.archiveImages({
          sessionId,
          messages: text?.messages ?? input.messages,
          target: preparation.imageArchiveTarget,
        })
      : undefined;
    return images ? withArchivedImages(text, images) : text;
  } catch {
    return undefined;
  }
}

function withArchivedImages(
  text: ToolResultCompactionCandidate | undefined,
  images: ToolResultImageArchive,
): ToolResultCompactionCandidate {
  const actualSavingsBytes = (text?.actualSavingsBytes ?? 0) + images.savedBytes;
  if (text && 'trimmedResultCount' in text) {
    return {
      messages: images.messages,
      trimmedResultCount: text.trimmedResultCount + images.archivedImageCount,
      actualSavingsBytes,
    };
  }
  return {
    messages: images.messages,
    archivedResultCount: (text?.archivedResultCount ?? 0) + images.archivedImageCount,
    actualSavingsBytes,
  };
}

/**
 * Request-only image limit for every image, user or tool. Runs after
 * compaction, so its placeholders never reach durable history. Compaction has
 * already archived the tool result images outside the same target, so what
 * this drops is what history cannot lose: user attachments, and images kept
 * for a model with a higher limit. A repeated request is fitted to the
 * recovery target of the rejected one, cut by `getRecoveryDivisor()`.
 */
export function createRequestMediaGuardHook(
  getRecoveryDivisor?: () => number,
): PiBeforeLlmCallHook {
  return (input) => {
    const budget = resolveRequestMediaBudget(input);
    const target = input.recovery
      ? recoveryRequestMediaBudget(input.recovery.requestMessages, budget, getRecoveryDivisor?.())
      : undefined;
    const { messages, omittedCount } = target
      ? fitRequestMedia(input.messages, target)
      : boundRequestMedia(input.messages, budget);
    return omittedCount === 0
      ? { type: 'continue' }
      : { type: 'replaceRequestMessages', messages, reason: 'request-media-guard' };
  };
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
