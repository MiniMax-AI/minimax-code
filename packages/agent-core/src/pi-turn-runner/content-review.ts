/**
 * 服务端内容审核（biz-gateway 模型代理）的 `content_error` 处理。
 *
 * 网关审核不通过时，在 SSE 里发 `event: error`，data 为
 * `{"type":"error","error":{"type":"content_error","message":"content unavailable","code":50201,"action":4,"guide_prompt":"...","request_id":"..."}}`；
 * 也可能在上游开始返回之前就打回（HTTP 200、第一帧就是这个 error，没有任何内容帧）。
 *
 * 本模块负责：
 * - 从各种形态的 provider 失败里解析出 content_error（pi-ai 抛出的普通 Error、SDK 的 APIError、
 *   `400 {json}` 文本、assistant 的 errorMessage）；
 * - 在 provider 最内层把带引导词的错误文本换成网关给的中性文案（`message`），结构化信息只登记在
 *   内存里，外层的重试、指标、事件、历史都看不到引导词；
 * - 给 runner 提供决策和重发请求的改写（引导词、重发请求头）。
 *
 * 引导词只给模型看：不会出现在 errorMessage、事件、历史或给调用方的通知里。
 */
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
  streamSimple,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from '@earendil-works/pi-ai';

/** action=4 时同一次模型调用默认最多重发几次（沿用 outputSafetyMaxRegenerations）。 */
export const DEFAULT_CONTENT_REVIEW_MAX_REGENERATIONS = 3;
/** 重发请求头：被打回那次请求的 request_id。 */
export const CONTENT_REVIEW_REGENERATE_OF_HEADER = 'X-Mavis-Regenerate-Of';
/** 重发请求头：第几次重发（1..N）。 */
export const CONTENT_REVIEW_REGENERATE_ATTEMPT_HEADER = 'X-Mavis-Regenerate-Attempt';

const ACTION_REPLACE = 3;
const ACTION_REGENERATE = 4;

/** 从网关 content_error 解析出的结构化信息。 */
export interface ContentReviewError {
  /** 网关给的中性文案，替换 errorMessage 用；不含引导词。 */
  readonly message?: string;
  /** 50201 内容命中。 */
  readonly code?: number;
  /** 2 撤回整轮；3 固答；4 带引导词重新生成这一条。 */
  readonly action?: number;
  /** 仅 action=4。只给模型看，不得展示、不得写进历史或事件。 */
  readonly guidePrompt?: string;
  /** 仅 action=3：固答文本。 */
  readonly suggestion?: string;
  /** 本次模型请求的 request_id，重发时放进 `X-Mavis-Regenerate-Of`。 */
  readonly requestId?: string;
}

/**
 * runner 对一次被打回的回复的处理：
 * - `regenerate`：撤回这一条，带引导词重发同一次模型调用；
 * - `recall`：action=2（或无法识别的 action），整轮撤回；
 * - `replace`：action=3，撤回这一条，写固答，结束本轮；
 * - `exhausted`：action=4 但重发次数已用完（或本轮没开重发、已中止），整轮撤回。
 */
export type ContentReviewKind = 'regenerate' | 'recall' | 'replace' | 'exhausted';

/** 每次有回复被打回时交给调用方的通知；不含引导词。 */
export interface ContentReviewRejection {
  readonly kind: ContentReviewKind;
  /**
   * 被打回那条 assistant 消息的 id：就是 messageIdAllocator 为这次调用分配、流式事件里用的同一个 id。
   * 网关在上游返回前就打回时这条消息没有任何内容帧，id 不会出现在任何事件里，撤回时要容忍找不到。
   * 分配失败时缺省。
   */
  readonly assistantMessageId?: string;
  readonly requestId?: string;
  readonly code?: number;
  readonly action?: number;
  /** 仅 `replace`：固答文本（网关没给时缺省）。 */
  readonly suggestion?: string;
  /** 这次模型调用在被打回前已经重发过几次；`regenerate` 时即将发出的是第 `regenerations + 1` 次。 */
  readonly regenerations: number;
}

/** 本轮因 content_error 结束时的结构化结果，runTurn 结束后从返回值读到。 */
export type ContentReviewOutcome = ContentReviewRejection & {
  readonly kind: Exclude<ContentReviewKind, 'regenerate'>;
};

/** 调用方为一轮开启的服务端审核处理。 */
export interface ContentReviewTurnOptions {
  /** action=4 时同一次模型调用最多重发几次；缺省 3，必须是非负整数，0 表示不重发。 */
  readonly maxRegenerations?: number;
  /** 网关没给引导词时用的修正指令；必须非空。 */
  readonly defaultGuidePrompt: string;
  /** 每次有回复被打回时调用（重发前、结束本轮前都会调）；抛错只记日志，不改变处理。 */
  readonly onRejected?: (rejection: ContentReviewRejection) => void | Promise<void>;
}

export interface ContentReviewRegeneration {
  /** 第几次重发（1..N）。 */
  readonly attempt: number;
  readonly requestId?: string;
  /** 这次重发临时拼在最后一条 user 消息末尾的引导词。 */
  readonly guidePrompt: string;
}

/** runner 内部的单轮状态。 */
export interface ContentReviewTurnState {
  readonly options?: ContentReviewTurnOptions & { readonly maxRegenerations: number };
  /** 当前这次模型调用已经重发过几次；拿到正常回复时清零。 */
  regenerations: number;
  /** 被打回、等 runner 重发的那次调用。 */
  pending?: ContentReviewRegeneration;
  /** 交给下一次真实 provider 调用的重发参数。 */
  active?: ContentReviewRegeneration;
  /** 本轮因 content_error 结束时的结果。 */
  outcome?: ContentReviewOutcome;
  /** 本轮因 content_error 结束时的失败文案，取自网关的 `message`。 */
  message?: string;
}

/** 解析结果登记表：中性化后的消息和错误对象 → 结构化信息。 */
const registered = new WeakMap<object, ContentReviewError>();
/** 原始错误 → 中性错误，同一个原始错误只换一次。 */
const neutralErrors = new WeakMap<object, Error>();

/**
 * 从 provider 失败里解析 content_error；不是 content_error 时返回 undefined。
 * 接受：本模块中性化过的消息/错误、普通 Error（message 是 SSE data）、SDK APIError（`.error` 是 body）、
 * `400 {json}` 之类的文本、assistant 消息（读 errorMessage）、body 对象本身。
 */
export function parseContentReviewError(source: unknown): ContentReviewError | undefined {
  if (typeof source === 'string') return parseText(source);
  if (source === null || typeof source !== 'object') return undefined;
  const known = registered.get(source);
  if (known) return known;
  const record = source as Record<string, unknown>;
  return (
    fromBody(record.error) ??
    fromBody(record) ??
    (typeof record.message === 'string' ? parseText(record.message) : undefined) ??
    (typeof record.errorMessage === 'string' ? parseText(record.errorMessage) : undefined)
  );
}

/**
 * 包在 provider StreamFn 最内层：识别 content_error，把 errorMessage 原地换成中性文案并登记结构化信息；
 * onProviderError 收到的原始错误换成同样登记过的中性 Error；streamFn 抛出的 content_error
 * 转成流里的 error 事件（StreamFn 约定失败编码在流里），runner 才能按同一条路径处理。
 * 其他失败原样透传。
 */
export function withContentReviewErrorShield(inner: StreamFn | undefined): StreamFn {
  return (async (model, context, options) => {
    const base = inner ?? streamSimple;
    const callerOnProviderError = options?.onProviderError;
    const shieldedOptions = callerOnProviderError
      ? {
          ...options,
          onProviderError: (error: unknown, errorModel: typeof model) =>
            callerOnProviderError(neutralError(error), errorModel),
        }
      : options;
    let stream: AssistantMessageEventStream;
    try {
      stream = await base(model, context, shieldedOptions);
    } catch (thrown) {
      const error = parseContentReviewError(thrown);
      if (!error) throw thrown;
      return finishedStream(contentErrorMessage(model, error));
    }
    return shieldStream(model, stream);
  }) as StreamFn;
}

/** 按网关结果、重发预算决定这次被打回的回复怎么处理。 */
export function decideContentReview(
  error: ContentReviewError,
  input: {
    readonly regenerations: number;
    readonly maxRegenerations: number;
    readonly aborted: boolean;
  },
): ContentReviewKind {
  if (error.action === ACTION_REGENERATE) {
    return !input.aborted && input.regenerations < input.maxRegenerations
      ? 'regenerate'
      : 'exhausted';
  }
  if (error.action === ACTION_REPLACE) return 'replace';
  return 'recall';
}

/** 校验调用方配置并建立单轮状态；配置给错直接抛错，不做兜底。 */
export function newContentReviewTurnState(
  options: ContentReviewTurnOptions | undefined,
): ContentReviewTurnState {
  if (!options) return { regenerations: 0 };
  const maxRegenerations = options.maxRegenerations ?? DEFAULT_CONTENT_REVIEW_MAX_REGENERATIONS;
  if (!Number.isInteger(maxRegenerations) || maxRegenerations < 0) {
    throw new Error(
      `content_review_max_regenerations_invalid: ${String(options.maxRegenerations)}`,
    );
  }
  if (typeof options.defaultGuidePrompt !== 'string' || options.defaultGuidePrompt.trim() === '') {
    throw new Error('content_review_default_guide_prompt_missing');
  }
  return { options: { ...options, maxRegenerations }, regenerations: 0 };
}

/**
 * 包在主调用 StreamFn 外层（llm-retry 之外、只对真实 provider 调用），只改写重发的那次请求：
 * 加 `X-Mavis-Regenerate-Of` / `X-Mavis-Regenerate-Attempt`，引导词包在 `<system-reminder>` 里作为新的
 * text 块追加到最后一条 user 消息末尾；不改系统提示词、不碰 transcript。其余调用原样透传。
 * 改写挂在宿主 onPayload 之后，llm-retry 的物理重试复用同一份 options，所以同一次重发被重试时还会再带。
 */
export function withContentReviewRequests(
  inner: StreamFn,
  state: ContentReviewTurnState,
): StreamFn {
  if (!state.options) return inner;
  return ((model, context, options) => {
    const regeneration = state.active;
    delete state.active;
    if (!regeneration) return inner(model, context, options);
    const callerOnPayload = options?.onPayload;
    return inner(model, context, {
      ...(options ?? {}),
      headers: { ...(options?.headers ?? {}), ...regenerationHeaders(regeneration) },
      onPayload: async (payload, payloadModel) => {
        const shaped = (await callerOnPayload?.(payload, payloadModel)) ?? payload;
        return withTextAppendedToLastUserMessage(shaped, guideReminder(regeneration.guidePrompt));
      },
    });
  }) as StreamFn;
}

function regenerationHeaders(regeneration: ContentReviewRegeneration): Record<string, string> {
  return {
    ...(regeneration.requestId
      ? { [CONTENT_REVIEW_REGENERATE_OF_HEADER]: regeneration.requestId }
      : {}),
    [CONTENT_REVIEW_REGENERATE_ATTEMPT_HEADER]: String(regeneration.attempt),
  };
}

/**
 * 引导词包在 system-reminder 里：网关做输入审核时会剥掉这类块，不会把引导词当成用户的话再审一遍。
 */
function guideReminder(guidePrompt: string): string {
  return `<system-reminder>\n${guidePrompt}\n</system-reminder>`;
}

/**
 * 把文字作为新的 text 块追加到请求体最后一条 role=user 消息（tool_result 也是 user 消息）末尾。
 * 复制数组和消息对象，不改动 provider 可能与 transcript 共用的原数组；
 * 追加在原有块之后，原来最后一块上的缓存断点不动，长上下文缓存照常命中。
 */
function withTextAppendedToLastUserMessage(payload: unknown, text: string): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) return payload;
  const messages: unknown[] = payload.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== 'user') continue;
    const block = { type: 'text', text };
    let content: unknown[];
    if (typeof message.content === 'string') {
      // 空串 content 不能留下空 text 块，provider 会拒绝。
      content = message.content ? [{ type: 'text', text: message.content }, block] : [block];
    } else if (Array.isArray(message.content)) {
      content = [...message.content, block];
    } else {
      return payload;
    }
    const nextMessages = [...messages];
    nextMessages[index] = { ...message, content };
    return { ...payload, messages: nextMessages };
  }
  return payload;
}

function shieldStream(
  model: Parameters<StreamFn>[0],
  stream: AssistantMessageEventStream,
): AssistantMessageEventStream {
  let lastPartial: AssistantMessage | undefined;
  /** 迭代中抛出的 content_error 转成的结尾消息，result() 返回同一个对象。 */
  let converted: AssistantMessage | undefined;
  const convert = (error: ContentReviewError): AssistantMessage => {
    converted ??= contentErrorMessage(model, error, lastPartial);
    return converted;
  };
  return {
    [Symbol.asyncIterator]() {
      const iterator = stream[Symbol.asyncIterator]();
      let finished = false;
      const shielded: AsyncIterator<AssistantMessageEvent> = {
        async next() {
          if (finished) return { done: true, value: undefined };
          let next: IteratorResult<AssistantMessageEvent>;
          try {
            next = await iterator.next();
          } catch (thrown) {
            const error = parseContentReviewError(thrown);
            if (!error) throw thrown;
            finished = true;
            return {
              done: false,
              value: { type: 'error', reason: 'error', error: convert(error) },
            };
          }
          if (next.done) return next;
          const event = next.value;
          if ('partial' in event) lastPartial = event.partial;
          if (event.type === 'error') neutralizeMessage(event.error);
          return next;
        },
      };
      if (iterator.return) shielded.return = iterator.return.bind(iterator);
      if (iterator.throw) shielded.throw = iterator.throw.bind(iterator);
      return shielded;
    },
    async result() {
      try {
        return neutralizeMessage(await stream.result());
      } catch (thrown) {
        if (converted) return converted;
        const error = parseContentReviewError(thrown);
        if (!error) throw thrown;
        return convert(error);
      }
    },
  } as unknown as AssistantMessageEventStream;
}

/**
 * 原地把 content_error 的 errorMessage 换成网关给的中性文案并登记；网关没给时留空，不保留原始错误
 * （里面有引导词）。幂等，其他消息不动。
 */
function neutralizeMessage(message: AssistantMessage): AssistantMessage {
  if (!isRecord(message) || registered.has(message) || typeof message.errorMessage !== 'string') {
    return message;
  }
  const error = parseText(message.errorMessage);
  if (!error) return message;
  registered.set(message, error);
  message.errorMessage = error.message ?? '';
  return message;
}

function neutralError(error: unknown): unknown {
  if (error === null || typeof error !== 'object') {
    const parsed = typeof error === 'string' ? parseText(error) : undefined;
    return parsed ? registeredError(parsed) : error;
  }
  if (registered.has(error)) return error;
  const cached = neutralErrors.get(error);
  if (cached) return cached;
  const parsed = parseContentReviewError(error);
  if (!parsed) return error;
  const neutral = registeredError(parsed);
  neutralErrors.set(error, neutral);
  return neutral;
}

function registeredError(error: ContentReviewError): Error {
  const neutral = new Error(error.message ?? '');
  registered.set(neutral, error);
  return neutral;
}

function contentErrorMessage(
  model: Parameters<StreamFn>[0],
  error: ContentReviewError,
  partial?: AssistantMessage,
): AssistantMessage {
  const message: AssistantMessage = partial
    ? {
        ...partial,
        content: [...partial.content],
        stopReason: 'error',
        errorMessage: error.message ?? '',
      }
    : {
        role: 'assistant',
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'error',
        errorMessage: error.message ?? '',
        timestamp: Date.now(),
      };
  registered.set(message, error);
  return message;
}

/** 只有 start + error 两帧的流，对应网关第一帧就打回、没有内容帧。 */
function finishedStream(message: AssistantMessage): AssistantMessageEventStream {
  const events: AssistantMessageEvent[] = [
    { type: 'start', partial: message },
    { type: 'error', reason: 'error', error: message },
  ];
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          const value = events[index];
          index += 1;
          return value ? { done: false, value } : { done: true, value: undefined };
        },
      };
    },
    async result() {
      return message;
    },
  } as unknown as AssistantMessageEventStream;
}

function parseText(text: string): ContentReviewError | undefined {
  if (!text.includes('content_error')) return undefined;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return fromBody(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return undefined;
  }
}

function fromBody(value: unknown): ContentReviewError | undefined {
  if (!isRecord(value)) return undefined;
  const inner =
    value.type === 'content_error'
      ? value
      : isRecord(value.error) && value.error.type === 'content_error'
        ? value.error
        : undefined;
  if (!inner) return undefined;
  const message = readText(inner.message);
  const code = readInteger(inner.code);
  const action = readInteger(inner.action);
  const guidePrompt = readText(inner.guide_prompt);
  const suggestion = readText(inner.suggestion);
  const requestId = readText(inner.request_id);
  return {
    ...(message === undefined ? {} : { message }),
    ...(code === undefined ? {} : { code }),
    ...(action === undefined ? {} : { action }),
    ...(guidePrompt === undefined ? {} : { guidePrompt }),
    ...(suggestion === undefined ? {} : { suggestion }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

function readInteger(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

function readText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
