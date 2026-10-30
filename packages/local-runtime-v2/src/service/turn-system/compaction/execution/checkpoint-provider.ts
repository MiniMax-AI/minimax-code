import { Buffer } from 'node:buffer';

import type { AgentMessage, StreamFn, ThinkingLevel } from '@earendil-works/pi-agent-core';
import { isContextOverflow, type AssistantMessage, type UserMessage } from '@earendil-works/pi-ai';
import {
  isLLMImageLimitMessage,
  isLLMRequestTooLargeMessage,
  keepsRequestImages,
  LLM_RETRY_REQUEST_SETTLED_OBSERVER,
  projectAgentMessagesForModel,
  type LLMCallOutcome,
  type LLMCallUsage,
  type LLMRequestSettledEvent,
} from '@mavis/agent-core/pi-turn-runner';
import { createDefaultTokenEstimator, withoutThinking } from '@mavis/context-manager';

import type { CheckpointSession } from '../algorithm/compact-context.js';
import type { ContextCompactionHooks, PromptSnapshotSource } from '../../agent-host/contracts.js';
import type { CheckpointGeneration } from '../algorithm/checkpoint-format.js';
import {
  CheckpointCandidateMediaRejectedError,
  CheckpointCandidateTooLargeError,
  type CheckpointRequestShape,
  type CheckpointResponseContentKind,
  type CheckpointSharedPrefixFallbackReason,
} from '../contracts.js';
import {
  buildCheckpointControl,
  buildSharedPrefixCheckpointControl,
  CHECKPOINT_SYSTEM_PROMPT,
  CHECKPOINT_SYSTEM_PROMPT_KEY,
} from './checkpoint-prompt.js';
import {
  buildSharedPrefixCheckpointContext,
  sharedPrefixToolCallFallback,
  type CheckpointSharedPrefix,
} from './checkpoint-shared-prefix.js';

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

export type CheckpointRequestProjection = (
  messages: readonly AgentMessage[],
) => readonly AgentMessage[];
type CheckpointProviderContext = Parameters<StreamFn>[1];

type CheckpointStreamOptions = NonNullable<Parameters<StreamFn>[2]> & {
  [LLM_RETRY_REQUEST_SETTLED_OBSERVER]?: (event: LLMRequestSettledEvent) => void;
};

interface CheckpointSessionOptions extends CheckpointProviderOptions {
  readonly maxOutputTokens: number;
  /** Every generated response; `shape` is set only when a shared prefix was offered. */
  readonly onGenerated?: (generation: CheckpointGeneration, shape?: CheckpointRequestShape) => void;
  /** A shared-prefix attempt was replaced by the isolated request for the same candidate. */
  readonly onSharedPrefixFallback?: (reason: CheckpointSharedPrefixFallbackReason) => void;
}

/** Forwards content-free generation facts to the Host compaction hooks. */
export function checkpointGenerationObservers(
  hooks: ContextCompactionHooks | undefined,
): Pick<CheckpointSessionOptions, 'onGenerated' | 'onSharedPrefixFallback'> {
  return {
    onGenerated: (generation, shape) =>
      hooks?.onCheckpointGenerated?.({
        responseContentKinds: generation.responseContentKinds,
        stopReason: generation.stopReason,
        outputTokens: generation.outputTokens,
        ...(shape === undefined ? {} : { requestShape: shape }),
      }),
    ...(hooks?.onCheckpointSharedPrefixFallback
      ? { onSharedPrefixFallback: hooks.onCheckpointSharedPrefixFallback }
      : {}),
  };
}

export async function createCheckpointSession(
  options: CheckpointSessionOptions,
): Promise<CheckpointSession> {
  const protocol = await readCheckpointSystemPrompt(options.promptSnapshots);
  const withBudget = (input: Omit<CheckpointProviderInput, 'maxOutputTokens'>) => ({
    ...input,
    maxOutputTokens: options.maxOutputTokens,
  });
  // Candidate selection measures the isolated request: it is always the
  // smaller shape, and generate() falls back to it whenever the shared prefix
  // does not fit.
  return {
    maxOutputTokens: options.maxOutputTokens,
    fits: (input) =>
      fitsCheckpointRequest(
        options,
        withBudget(input),
        buildIsolatedCheckpointRequest(options, withBudget(input), protocol),
      ),
    measure: (input) =>
      measureCheckpointRequest(
        buildIsolatedCheckpointRequest(options, withBudget(input), protocol),
      ),
    generate: (input) => generateCheckpoint(options, withBudget(input), protocol),
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
  /** Absent: every request uses the isolated checkpoint shape. */
  readonly sharedPrefix?: CheckpointSharedPrefix;
}

/**
 * One logical checkpoint attempt. With a shared prefix it first sends the
 * cache-sharing request; a tool call or a Provider input overflow there is a
 * property of that shape, so the same candidate is re-sent once in the
 * isolated shape. Nothing is remembered across attempts.
 */
async function generateCheckpoint(
  options: CheckpointSessionOptions,
  input: CheckpointProviderInput,
  protocol: string,
): Promise<CheckpointGeneration> {
  const prefix = options.sharedPrefix;
  if (prefix) {
    const context = buildSharedPrefixCheckpointRequest(options, prefix, input, protocol);
    if (fitsCheckpointRequest(options, input, context)) {
      const shared = await trySharedPrefixCheckpoint(options, input, context, prefix.sessionId);
      if (shared.kind === 'generated') return shared.generation;
      notifySharedPrefixFallback(options, shared.reason);
    }
  }
  const final = await requestCheckpoint(
    options,
    input,
    buildIsolatedCheckpointRequest(options, input, protocol),
  );
  return settleCheckpointResponse(options, final, prefix ? 'isolated' : undefined);
}

async function trySharedPrefixCheckpoint(
  options: CheckpointSessionOptions,
  input: CheckpointProviderInput,
  context: CheckpointProviderContext,
  sessionId: string,
): Promise<
  | { readonly kind: 'generated'; readonly generation: CheckpointGeneration }
  | { readonly kind: 'fallback'; readonly reason: CheckpointSharedPrefixFallbackReason }
> {
  let final: AssistantMessage;
  try {
    final = await requestCheckpoint(options, input, context, sessionId);
  } catch (error) {
    if (error instanceof CheckpointCandidateTooLargeError && error.reason === 'input_overflow') {
      return { kind: 'fallback', reason: 'input_overflow' };
    }
    throw error;
  }
  if (isCheckpointInputTooLarge(final, options.model.contextWindow)) {
    return { kind: 'fallback', reason: 'input_overflow' };
  }
  // Checked before output exhaustion: output spent on a tool call says
  // nothing about whether this candidate fits.
  const response = toGeneration(final);
  const toolCall = sharedPrefixToolCallFallback(response);
  if (toolCall) {
    options.onGenerated?.(response, 'shared_prefix');
    return { kind: 'fallback', reason: toolCall };
  }
  return {
    kind: 'generated',
    generation: settleCheckpointResponse(options, final, 'shared_prefix'),
  };
}

function settleCheckpointResponse(
  options: CheckpointSessionOptions,
  final: AssistantMessage,
  shape: CheckpointRequestShape | undefined,
): CheckpointGeneration {
  if (isContextOverflow(final, options.model.contextWindow)) {
    throw new CheckpointCandidateTooLargeError(final);
  }
  if (final.stopReason === 'error' && isLLMImageLimitMessage(final.errorMessage)) {
    throw new CheckpointCandidateMediaRejectedError(final);
  }
  // Gateway rewrites of a size rejection (Bedrock's bare `Input is too
  // long.`, a 413 inside a stream error) are the same shape the main-turn
  // recovery accepts; a smaller candidate may fit where this one did not.
  if (final.stopReason === 'error' && isLLMRequestTooLargeMessage(final.errorMessage)) {
    throw new CheckpointCandidateTooLargeError(final);
  }
  const generation = toGeneration(final);
  if (shape === undefined) options.onGenerated?.(generation);
  else options.onGenerated?.(generation, shape);
  if (isOutputExhaustedWithoutText(generation)) {
    throw new CheckpointCandidateTooLargeError(final, 'output_exhausted');
  }
  return generation;
}

/**
 * The shared-prefix request is the larger shape (main system prompt and
 * tools), so a size rejection there is a reason to send the isolated shape,
 * not a property of the candidate. Image-limit wording stays a media
 * rejection.
 */
function isCheckpointInputTooLarge(final: AssistantMessage, contextWindow: number): boolean {
  if (isContextOverflow(final, contextWindow)) return true;
  return (
    final.stopReason === 'error' &&
    !isLLMImageLimitMessage(final.errorMessage) &&
    isLLMRequestTooLargeMessage(final.errorMessage)
  );
}

function notifySharedPrefixFallback(
  options: CheckpointSessionOptions,
  reason: CheckpointSharedPrefixFallbackReason,
): void {
  try {
    options.onSharedPrefixFallback?.(reason);
  } catch {
    // Diagnostics cannot change which request carries the checkpoint.
  }
}

async function requestCheckpoint(
  options: CheckpointProviderOptions,
  input: CheckpointProviderInput,
  context: CheckpointProviderContext,
  sessionId?: string,
): Promise<AssistantMessage> {
  let requestSettled = false;
  const onRequestSettled = options.onRequestSettled
    ? (event: LLMRequestSettledEvent) => {
        requestSettled = true;
        options.onRequestSettled?.(event);
      }
    : undefined;
  try {
    const streamOptions = createCheckpointStreamOptions(
      options,
      input,
      onRequestSettled,
      sessionId,
    );
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
    const message = error instanceof Error ? error.message : undefined;
    if (isLLMImageLimitMessage(message)) throw new CheckpointCandidateMediaRejectedError(error);
    if (isLLMRequestTooLargeMessage(message)) throw new CheckpointCandidateTooLargeError(error);
    throw error;
  }
}

function createCheckpointStreamOptions(
  options: CheckpointProviderOptions,
  input: CheckpointProviderInput,
  onRequestSettled: ((event: LLMRequestSettledEvent) => void) | undefined,
  sessionId: string | undefined,
): CheckpointStreamOptions {
  const streamOptions = {
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.headers === undefined ? {} : { headers: { ...options.headers } }),
    reasoning:
      options.model.reasoning && options.thinkingLevel !== 'off'
        ? options.thinkingLevel
        : undefined,
    maxTokens: input.maxOutputTokens,
    // Only the shared-prefix request carries the session: Providers key their
    // prompt cache and session affinity on it, which the isolated shape cannot use.
    ...(sessionId === undefined ? {} : { sessionId }),
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

/**
 * The main request's request-only projection (shared prefix only), then the
 * same model projection as the main request.
 */
function projectCheckpointMessages(
  options: CheckpointProviderOptions,
  messages: readonly AgentMessage[],
  requestOnly?: (messages: readonly AgentMessage[]) => readonly AgentMessage[],
) {
  return projectAgentMessagesForModel(requestOnly?.(messages) ?? messages, options.model).messages;
}

function checkpointControlMessage(
  text: string,
  projected: ReturnType<typeof projectCheckpointMessages>,
): UserMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    timestamp: projected.at(-1)?.timestamp ?? 0,
  };
}

/** Checkpoint protocol as the system prompt, no tools: shares nothing with the main request. */
function buildIsolatedCheckpointRequest(
  options: CheckpointProviderOptions,
  input: Omit<CheckpointProviderInput, 'signal'>,
  protocol: string = CHECKPOINT_SYSTEM_PROMPT,
): CheckpointProviderContext {
  const outbound = projectCheckpointMessages(options, input.messages);
  // The isolated request has its own system prompt and no tools, so thinking
  // bound to the main conversation's prefix is invalid for prefix-cached models.
  // The shared-prefix request repeats that prefix and keeps its thinking.
  const projected = keepsRequestImages(options.model) ? withoutThinking(outbound) : outbound;
  return {
    systemPrompt: protocol,
    messages: [
      ...projected,
      checkpointControlMessage(buildCheckpointControl(input.instructions), projected),
    ],
  };
}

/** The main request's prefix followed by the control message that carries the protocol. */
function buildSharedPrefixCheckpointRequest(
  options: CheckpointProviderOptions,
  prefix: CheckpointSharedPrefix,
  input: Omit<CheckpointProviderInput, 'signal'>,
  protocol: string,
): CheckpointProviderContext {
  const projected = projectCheckpointMessages(options, input.messages, prefix.projectRequestMedia);
  return buildSharedPrefixCheckpointContext(
    prefix,
    projected,
    checkpointControlMessage(
      buildSharedPrefixCheckpointControl(protocol, input.instructions),
      projected,
    ),
  );
}

function fitsCheckpointRequest(
  options: CheckpointProviderOptions,
  input: Pick<CheckpointProviderInput, 'maxOutputTokens'>,
  context: CheckpointProviderContext,
): boolean {
  validateNonNegativeSafeInteger(input.maxOutputTokens, 'maxOutputTokens');
  validatePositiveSafeInteger(options.providerInputLimit, 'providerInputLimit');
  if (options.maxSerializedInputBytes !== undefined) {
    validatePositiveSafeInteger(options.maxSerializedInputBytes, 'maxSerializedInputBytes');
  }
  if (estimateCheckpointInputTokens(context) > options.providerInputLimit) return false;
  if (options.maxSerializedInputBytes === undefined) return true;
  return Buffer.byteLength(strictStringify(context), 'utf8') <= options.maxSerializedInputBytes;
}

/**
 * Failure-path diagnostics only. Unlike fits(), it always pays the full
 * serialization cost, so it must stay out of candidate-selection loops.
 */
function measureCheckpointRequest(context: CheckpointProviderContext): {
  readonly inputTokens: number;
  readonly serializedBytes: number;
} {
  return {
    inputTokens: estimateCheckpointInputTokens(context),
    serializedBytes: Buffer.byteLength(strictStringify(context), 'utf8'),
  };
}

function estimateCheckpointInputTokens(context: CheckpointProviderContext): number {
  const estimator = createDefaultTokenEstimator();
  const tools = context.tools ?? [];
  return (
    estimator.estimateTextTokens(context.systemPrompt ?? '') +
    (tools.length > 0 ? estimator.estimateTextTokens(strictStringify(tools)) : 0) +
    estimator.estimateMessages(context.messages)
  );
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
