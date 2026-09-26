import { Buffer } from 'node:buffer';

import type { AgentMessage, StreamFn, ThinkingLevel } from '@earendil-works/pi-agent-core';
import { isContextOverflow, type AssistantMessage, type UserMessage } from '@earendil-works/pi-ai';
import {
  LLM_RETRY_REQUEST_SETTLED_OBSERVER,
  projectAgentMessagesForModel,
  type LLMCallOutcome,
  type LLMCallUsage,
  type LLMRequestSettledEvent,
} from '@mavis/agent-core/pi-turn-runner';
import { createDefaultTokenEstimator } from '@mavis/context-manager';

import type { CheckpointSession } from '../algorithm/compact-context.js';
import type { PromptSnapshotSource } from '../../agent-host/contracts.js';
import type { CheckpointGeneration } from '../algorithm/checkpoint-format.js';
import {
  CheckpointCandidateTooLargeError,
  type CheckpointResponseContentKind,
} from '../contracts.js';
import {
  buildCheckpointControl,
  CHECKPOINT_SYSTEM_PROMPT,
  CHECKPOINT_SYSTEM_PROMPT_KEY,
} from './checkpoint-prompt.js';

const EXPLICIT_INPUT_TOO_LARGE_CODES = new Set([
  'context_length_exceeded',
  'context_window_exceeded',
  'input_too_large',
  'model_context_window_exceeded',
  'request_too_large',
]);

interface CheckpointProviderInput {
  readonly messages: readonly AgentMessage[];
  readonly maxOutputTokens: number;
  readonly instructions?: string;
  readonly signal?: AbortSignal;
}

type CheckpointStreamOptions = NonNullable<Parameters<StreamFn>[2]> & {
  [LLM_RETRY_REQUEST_SETTLED_OBSERVER]?: (event: LLMRequestSettledEvent) => void;
};

export async function createCheckpointSession(
  options: CheckpointProviderOptions & {
    readonly maxOutputTokens: number;
    readonly onGenerated?: (generation: CheckpointGeneration) => void;
  },
): Promise<CheckpointSession> {
  const systemPrompt = await readCheckpointSystemPrompt(options.promptSnapshots);
  return {
    maxOutputTokens: options.maxOutputTokens,
    fits: (input) =>
      fitsCheckpointRequest(
        options,
        {
          ...input,
          maxOutputTokens: options.maxOutputTokens,
        },
        systemPrompt,
      ),
    measure: (input) =>
      measureCheckpointRequest(
        options,
        {
          ...input,
          maxOutputTokens: options.maxOutputTokens,
        },
        systemPrompt,
      ),
    generate: async (input) => {
      const final = await requestCheckpoint(
        options,
        {
          ...input,
          maxOutputTokens: options.maxOutputTokens,
        },
        systemPrompt,
      );
      if (isContextOverflow(final, options.model.contextWindow)) {
        throw new CheckpointCandidateTooLargeError(final);
      }
      const generation = toGeneration(final);
      options.onGenerated?.(generation);
      if (isOutputExhaustedWithoutText(generation)) {
        throw new CheckpointCandidateTooLargeError(final, 'output_exhausted');
      }
      return generation;
    },
  };
}

interface CheckpointProviderOptions {
  readonly model: Parameters<StreamFn>[0];
  readonly providerInputLimit: number;
  /** Already bound to Provider routing, transport retry, and scoped metrics. */
  readonly streamFn: StreamFn;
  readonly thinkingLevel: ThinkingLevel;
  readonly maxSerializedInputBytes?: number;
  readonly apiKey?: NonNullable<Parameters<StreamFn>[2]>['apiKey'];
  readonly headers?: Readonly<Record<string, string>>;
  readonly payloadTransform?: NonNullable<Parameters<StreamFn>[2]>['onPayload'];
  readonly promptSnapshots?: PromptSnapshotSource;
  readonly onRequestSettled?: (event: LLMRequestSettledEvent) => void;
}

async function requestCheckpoint(
  options: CheckpointProviderOptions,
  input: CheckpointProviderInput,
  systemPrompt: string,
): Promise<AssistantMessage> {
  let requestSettled = false;
  const onRequestSettled = options.onRequestSettled
    ? (event: LLMRequestSettledEvent) => {
        requestSettled = true;
        options.onRequestSettled?.(event);
      }
    : undefined;
  try {
    const context = buildCheckpointRequest(options, input, systemPrompt);
    const streamOptions = createCheckpointStreamOptions(options, input, onRequestSettled);
    const stream = await options.streamFn(options.model, context, streamOptions);
    // Pi providers drive the stream producer; result() does not require draining the iterator.
    const final = await stream.result();
    reportUnobservedCheckpointSettlement(
      onRequestSettled,
      requestSettled,
      checkpointRequestSettledEvent(final, 1),
    );
    return final;
  } catch (error) {
    // A raw StreamFn may not implement the retry observer. Keep the compact
    // aggregate honest for that one physical request as well.
    reportUnobservedCheckpointSettlement(options.onRequestSettled, requestSettled, {
      requestAttempt: 1,
      outcome: input.signal?.aborted ? 'abort' : 'error',
      usageComplete: false,
    });
    if (isExplicitInputTooLargeError(error)) throw new CheckpointCandidateTooLargeError(error);
    throw error;
  }
}

function createCheckpointStreamOptions(
  options: CheckpointProviderOptions,
  input: CheckpointProviderInput,
  onRequestSettled: ((event: LLMRequestSettledEvent) => void) | undefined,
): CheckpointStreamOptions {
  const streamOptions = {
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.headers === undefined ? {} : { headers: { ...options.headers } }),
    reasoning:
      options.model.reasoning && options.thinkingLevel !== 'off'
        ? options.thinkingLevel
        : undefined,
    maxTokens: input.maxOutputTokens,
    ...(options.payloadTransform === undefined ? {} : { onPayload: options.payloadTransform }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  } as CheckpointStreamOptions;
  if (onRequestSettled) {
    Object.defineProperty(streamOptions, LLM_RETRY_REQUEST_SETTLED_OBSERVER, {
      value: onRequestSettled,
      enumerable: true,
    });
  }
  return streamOptions;
}

function reportUnobservedCheckpointSettlement(
  onRequestSettled: ((event: LLMRequestSettledEvent) => void) | undefined,
  requestSettled: boolean,
  event: LLMRequestSettledEvent,
): void {
  if (!onRequestSettled || requestSettled) return;
  onRequestSettled(event);
}

function buildCheckpointRequest(
  options: CheckpointProviderOptions,
  input: Omit<CheckpointProviderInput, 'signal'>,
  systemPrompt: string = CHECKPOINT_SYSTEM_PROMPT,
): Parameters<StreamFn>[1] {
  const projected = projectAgentMessagesForModel(input.messages, options.model).messages;
  const control: UserMessage = {
    role: 'user',
    content: [{ type: 'text', text: buildCheckpointControl(input.instructions) }],
    timestamp: projected.at(-1)?.timestamp ?? 0,
  };
  return {
    systemPrompt,
    messages: [...projected, control],
  };
}

function fitsCheckpointRequest(
  options: CheckpointProviderOptions,
  input: Omit<CheckpointProviderInput, 'signal'>,
  systemPrompt: string,
): boolean {
  validateNonNegativeSafeInteger(input.maxOutputTokens, 'maxOutputTokens');
  validatePositiveSafeInteger(options.providerInputLimit, 'providerInputLimit');
  if (options.maxSerializedInputBytes !== undefined) {
    validatePositiveSafeInteger(options.maxSerializedInputBytes, 'maxSerializedInputBytes');
  }
  const context = buildCheckpointRequest(options, input, systemPrompt);
  const estimator = createDefaultTokenEstimator();
  const inputTokens =
    estimator.estimateTextTokens(context.systemPrompt ?? '') +
    estimator.estimateMessages(context.messages);
  if (inputTokens > options.providerInputLimit) return false;
  if (options.maxSerializedInputBytes === undefined) return true;
  return Buffer.byteLength(strictStringify(context), 'utf8') <= options.maxSerializedInputBytes;
}

/**
 * Failure-path diagnostics only. Unlike fits(), it always pays the full
 * serialization cost, so it must stay out of candidate-selection loops.
 */
function measureCheckpointRequest(
  options: CheckpointProviderOptions,
  input: Omit<CheckpointProviderInput, 'signal'>,
  systemPrompt: string,
): { readonly inputTokens: number; readonly serializedBytes: number } {
  const context = buildCheckpointRequest(options, input, systemPrompt);
  const estimator = createDefaultTokenEstimator();
  return {
    inputTokens:
      estimator.estimateTextTokens(context.systemPrompt ?? '') +
      estimator.estimateMessages(context.messages),
    serializedBytes: Buffer.byteLength(strictStringify(context), 'utf8'),
  };
}

function strictStringify(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('value is undefined');
    return serialized;
  } catch (cause) {
    throw new TypeError('Checkpoint request must be JSON serializable.', { cause });
  }
}

function validateNonNegativeSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Checkpoint ${field} must be a non-negative safe integer.`);
  }
}

function validatePositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Checkpoint ${field} must be a positive safe integer.`);
  }
}

async function readCheckpointSystemPrompt(source?: PromptSnapshotSource): Promise<string> {
  if (!source) return CHECKPOINT_SYSTEM_PROMPT;
  const snapshot = await source.capture();
  const current = await source.read(snapshot, CHECKPOINT_SYSTEM_PROMPT_KEY);
  if (current.kind === 'found') return current.content;
  if (current.kind === 'missing') return CHECKPOINT_SYSTEM_PROMPT;

  const builtinSnapshot = await source.captureBuiltin();
  const fallback = await source.read(builtinSnapshot, CHECKPOINT_SYSTEM_PROMPT_KEY);
  return fallback.kind === 'found' ? fallback.content : CHECKPOINT_SYSTEM_PROMPT;
}

/**
 * A `length` stop with no checkpoint text means the shared output budget was
 * spent before the summary began (typically on reasoning). Retrying the same
 * candidate repeats the same spend, so it is normalized like overflow and the
 * candidate ladder moves on. Truncated responses that carry text are unchanged.
 */
function isOutputExhaustedWithoutText(generation: CheckpointGeneration): boolean {
  return generation.stopReason === 'length' && generation.text.trim() === '';
}

function toGeneration(final: AssistantMessage): CheckpointGeneration {
  const outputTokens = final.usage?.output;
  return {
    text: final.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join(''),
    stopReason: final.stopReason,
    outputTokens:
      typeof outputTokens === 'number' && Number.isFinite(outputTokens) && outputTokens >= 0
        ? outputTokens
        : 0,
    responseContentKinds: [...new Set(final.content.map(readResponseContentKind))],
  };
}

function checkpointRequestSettledEvent(
  final: AssistantMessage,
  requestAttempt: number,
): LLMRequestSettledEvent {
  const usage = readCheckpointUsage(final);
  return {
    requestAttempt,
    outcome: checkpointOutcome(final),
    ...(usage.usage ? { usage: usage.usage } : {}),
    usageComplete: usage.complete,
  };
}

function checkpointOutcome(final: AssistantMessage): LLMCallOutcome {
  if (final.stopReason === 'aborted') return 'abort';
  if (final.stopReason === 'error') return 'error';
  return 'success';
}

function readCheckpointUsage(final: AssistantMessage): {
  usage?: LLMCallUsage;
  complete: boolean;
} {
  try {
    const usage = final.usage;
    if (!usage) return { complete: false };
    const input = readTokenBucket(usage.input);
    const output = readTokenBucket(usage.output);
    const cacheRead = readTokenBucket(usage.cacheRead);
    const cacheWrite = readTokenBucket(usage.cacheWrite);
    return {
      usage: {
        input: input.value,
        output: output.value,
        cacheRead: cacheRead.value,
        cacheWrite: cacheWrite.value,
      },
      complete: input.valid && output.valid && cacheRead.valid && cacheWrite.valid,
    };
  } catch {
    return { complete: false };
  }
}

function readTokenBucket(value: unknown): { value: number; valid: boolean } {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? { value, valid: true }
    : { value: 0, valid: false };
}

function readResponseContentKind(
  block: AssistantMessage['content'][number],
): CheckpointResponseContentKind {
  if (block.type === 'text' || block.type === 'thinking' || block.type === 'toolCall') {
    return block.type;
  }
  return 'unknown';
}

function isExplicitInputTooLargeError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = Reflect.get(error, 'code');
  if (typeof code === 'string' && EXPLICIT_INPUT_TOO_LARGE_CODES.has(code.trim().toLowerCase())) {
    return true;
  }
  return [Reflect.get(error, 'status'), Reflect.get(error, 'statusCode')].some(
    (status) => status === 413 || (typeof status === 'string' && status.trim() === '413'),
  );
}
