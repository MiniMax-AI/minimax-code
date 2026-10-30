import type { ModelThinkingLevel, SimpleStreamOptions, Tool } from '@earendil-works/pi-ai';

import type { SessionRecord } from '../repo/contract.js';

export interface TitleResolvedModel<TModel> {
  readonly model: TModel;
  readonly apiKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly thinkingLevel?: ModelThinkingLevel;
  readonly stream?: TitleModelStream<TModel>;
  /** Only an explicit `false` skips title review (a BYOK model does not); omitted reviews as before. */
  readonly contentReviewRequired?: boolean;
}

export interface TitleModelResponse {
  readonly stopReason: string;
  readonly errorMessage?: string;
  readonly content: ReadonlyArray<{
    readonly type: string;
    readonly text?: string;
    readonly thinking?: string;
    readonly id?: string;
    readonly name?: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
  }>;
}

export type TitleModelStream<TModel> = (
  model: TModel,
  context: {
    readonly systemPrompt: string;
    readonly messages: ReadonlyArray<{
      readonly role: 'user';
      readonly content: string;
      readonly timestamp: number;
    }>;
    readonly tools?: readonly Tool[];
  },
  options: {
    readonly apiKey?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly reasoning?: SimpleStreamOptions['reasoning'];
    readonly maxTokens: number;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  },
) => { result(): Promise<TitleModelResponse> } | Promise<{ result(): Promise<TitleModelResponse> }>;

export interface CompleteTitleModelOptions<TAgentConfig, TModel> {
  readonly buildAgentConfig: (session: SessionRecord) => Promise<TAgentConfig>;
  readonly resolveModel: (input: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly agentConfig: TAgentConfig;
  }) => Promise<TitleResolvedModel<TModel>>;
  readonly stream: TitleModelStream<TModel>;
  readonly nowMs: () => number;
}

export class TitleModelCompletionError extends Error {
  override readonly name = 'TitleModelCompletionError';
}

export async function completeTitleModel<TAgentConfig, TModel>(
  options: CompleteTitleModelOptions<TAgentConfig, TModel>,
  input: {
    readonly session: SessionRecord;
    readonly turnId: string;
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly maxTokens: number;
    readonly timeoutMs: number;
  },
): Promise<string> {
  const result = await completeTitleModelResponse(options, input);
  return result.content
    .flatMap((part) => (part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
    .join('')
    .trim();
}

export async function completeTitleModelResponse<TAgentConfig, TModel>(
  options: CompleteTitleModelOptions<TAgentConfig, TModel>,
  input: {
    readonly session: SessionRecord;
    readonly turnId: string;
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly maxTokens: number;
    readonly timeoutMs: number;
    readonly tools?: readonly Tool[];
  },
): Promise<TitleModelResponse> {
  const agentConfig = await options.buildAgentConfig(input.session);
  const resolved = await options.resolveModel({
    sessionId: input.session.sessionId,
    turnId: input.turnId,
    agentConfig,
  });
  const response = await (resolved.stream ?? options.stream)(
    resolved.model,
    {
      systemPrompt: input.systemPrompt,
      messages: [{ role: 'user', content: input.userPrompt, timestamp: options.nowMs() }],
      ...(input.tools ? { tools: input.tools } : {}),
    },
    {
      ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
      ...(resolved.headers ? { headers: resolved.headers } : {}),
      ...(resolved.thinkingLevel && resolved.thinkingLevel !== 'off'
        ? { reasoning: resolved.thinkingLevel }
        : {}),
      maxTokens: input.maxTokens,
      timeoutMs: input.timeoutMs,
      signal: AbortSignal.timeout(input.timeoutMs),
    },
  );
  const result = await response.result();
  if (result.stopReason === 'error' || result.stopReason === 'aborted') {
    throw new TitleModelCompletionError(result.errorMessage ?? `title LLM ${result.stopReason}`);
  }
  return result;
}
