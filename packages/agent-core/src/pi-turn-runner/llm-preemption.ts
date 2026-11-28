import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import {
  streamSimple,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import type { PiBeforeLlmCallAppendMessage } from './hooks.js';
import { readTurnRequestPhase, type TurnRequestPhase } from './turn-timing.js';

/**
 * Host-triggered cancellation of the provider call in flight, without ending
 * the Turn.
 *
 * - `preempted`: a provider call was streaming. It ends at once as an empty,
 *   discarded response (partial text and half-written tool arguments are
 *   dropped, nothing of it runs or is saved) and the runner resends from the
 *   same transcript with the host's pending steering plus a notice from
 *   {@link llmCallPreemptedNotice}.
 * - `not-streaming`: no provider call can be cancelled (a tool is running, the
 *   step is between calls, or this call's output already reached the user).
 *   Nothing changes; steering joins the next call as it always did.
 */
export type LLMCallPreemptionResult = 'preempted' | 'not-streaming';

export interface LLMCallPreemptionTarget {
  preempt(): LLMCallPreemptionResult;
}

/** Created by the host, handed to `RunTurnInput.llmPreemption`, bound by the runner. */
export interface LLMCallPreemption {
  /** Host side. Throws only when the runner side failed; the host then keeps its queue. */
  request(): LLMCallPreemptionResult;
  /** Runner side. Returns the unbind function. */
  bind(target: LLMCallPreemptionTarget): () => void;
  /** Host side. Removes what was already streamed of a discarded response from display. */
  readonly onResponseDiscarded?: (messageId: string) => void | Promise<void>;
  /** Host side. The resend could not be prepared; the steering joins the next call the old way. */
  readonly onResendFallback?: () => void | Promise<void>;
  /** Host side. What the Turn has been woken by so far; read as each provider call starts. */
  readonly wakeReasons?: () => readonly string[];
  /** Host side. True when starting this top-level tool call shows its content to the user. */
  readonly deliversOnToolStart?: (toolName: string, args: unknown) => boolean;
}

export function createLLMCallPreemption(
  options?: Pick<
    LLMCallPreemption,
    | 'onResponseDiscarded'
    | 'onResendFallback'
    | 'wakeReasons'
    | 'deliversOnToolStart'
  >,
): LLMCallPreemption {
  let target: LLMCallPreemptionTarget | undefined;
  return {
    ...(options?.onResponseDiscarded ? { onResponseDiscarded: options.onResponseDiscarded } : {}),
    ...(options?.onResendFallback ? { onResendFallback: options.onResendFallback } : {}),
    ...(options?.wakeReasons ? { wakeReasons: options.wakeReasons } : {}),
    ...(options?.deliversOnToolStart ? { deliversOnToolStart: options.deliversOnToolStart } : {}),
    request: () => target?.preempt() ?? 'not-streaming',
    bind(next) {
      target = next;
      return () => {
        if (target === next) target = undefined;
      };
    },
  };
}

export const LLM_CALL_PREEMPTED_CUSTOM_TYPE = 'llm_call_preempted';

export const LLM_CALL_PREEMPTED_NOTICE =
  'Your previous response was interrupted by a new user message before it finished. ' +
  'It was discarded and not saved: none of its text was delivered and none of its tool ' +
  'calls ran. Anything it was about to write or change did not happen. Tool results that ' +
  'appear earlier in this conversation did complete.';

const LLM_CALL_PREEMPTED_AFTER_DELIVERY_NOTICE =
  'Your previous response was interrupted by a new user message before it finished. ' +
  'Part of it had already been shown to the user, so do not assume the user saw nothing. ' +
  'Calls that had not started did not run. Tool results that appear earlier in this ' +
  'conversation did complete.';

const MAX_SUMMARY_BLOCK_CHARS = 800;
const MAX_SUMMARY_CHARS = 2400;

/** The work a non-user wake reason stands for; an unknown reason is shown as it is. */
const INTERRUPTED_WORK: Readonly<Record<string, string>> = {
  task_report: 'a task report',
  cron: 'a scheduled run',
  self_reminder: 'a reminder you set',
  background_task: 'a finished background task',
  peer: 'a message from another session',
};

export interface LLMCallPreemptedNoticeInput {
  readonly timestamp: number;
  /** What the discarded response was generating; see {@link summarizeDiscardedResponse}. */
  readonly discardedSummary?: string;
  /** What the Turn had been woken by when the discarded call started. */
  readonly wakeReasons?: readonly string[];
  /** Part of the discarded response had already been shown to the user. */
  readonly delivered?: boolean;
}

export function llmCallPreemptedNotice(
  input: LLMCallPreemptedNoticeInput,
): PiBeforeLlmCallAppendMessage {
  if (
    !input.delivered &&
    input.wakeReasons?.length &&
    input.wakeReasons.every((reason) => reason === 'user' || reason === 'user_answer')
  ) {
    return {
      role: 'custom',
      customType: LLM_CALL_PREEMPTED_CUSTOM_TYPE,
      content: [
        LLM_CALL_PREEMPTED_NOTICE,
        // The steered user message carries the host's own "respond first" reminder.
        'Read the new user message and continue.',
      ].join('\n\n'),
      display: false,
      timestamp: input.timestamp,
    } as PiBeforeLlmCallAppendMessage;
  }
  const draft = input.discardedSummary
    ? 'What the discarded response was generating (your own unfinished draft, not a new ' +
      `request):\n<discarded_response>\n${input.discardedSummary}\n</discarded_response>`
    : undefined;
  return {
    role: 'custom',
    customType: LLM_CALL_PREEMPTED_CUSTOM_TYPE,
    content: [
      input.delivered ? LLM_CALL_PREEMPTED_AFTER_DELIVERY_NOTICE : LLM_CALL_PREEMPTED_NOTICE,
      owedToUser(input),
      ...(draft ? [draft] : []),
    ].join('\n\n'),
    display: false,
    timestamp: input.timestamp,
  } as PiBeforeLlmCallAppendMessage;
}

/** What the model still owes the user before it answers the message that interrupted it. */
function owedToUser(input: LLMCallPreemptedNoticeInput): string {
  const work = (input.wakeReasons ?? [])
    .filter((reason) => reason !== 'user' && reason !== 'user_answer')
    .map((reason) => INTERRUPTED_WORK[reason] ?? reason);
  if (work.length > 0) {
    const state = input.delivered
      ? 'Its conclusion may have reached the user only in part.'
      : 'Its conclusion has not been told to the user yet.';
    return (
      `Before the interruption you were handling ${work.join(' and ')}. ${state} Tell the user ` +
      'what they are still missing first, then answer the new message. Skip this only if it ' +
      'holds nothing the user needs.'
    );
  }
  if (input.discardedSummary) {
    return (
      'What you were about to say may not have reached the user. If the draft below holds ' +
      'something they still need, tell them first, then answer the new message.'
    );
  }
  return 'Read the new user message and continue.';
}

/** A bounded view of a partial response: its text, its tool calls and the end of its thinking. */
export function summarizeDiscardedResponse(
  message: Pick<AssistantMessage, 'content'> | undefined,
): string | undefined {
  const parts = (message?.content ?? []).flatMap((block) => {
    if (block.type === 'text') return block.text.trim() ? [clip(block.text.trim())] : [];
    if (block.type === 'thinking') {
      const thinking = block.thinking.trim();
      return thinking ? [`[thinking] ${thinking.slice(-MAX_SUMMARY_BLOCK_CHARS)}`] : [];
    }
    return [`[tool call, did not run] ${block.name} ${clip(JSON.stringify(block.arguments))}`];
  });
  if (parts.length === 0) return undefined;
  return parts
    .join('\n')
    .slice(0, MAX_SUMMARY_CHARS)
    .replaceAll('</discarded_response>', '<\\/discarded_response>');
}

function clip(text: string): string {
  return clipTo(text, MAX_SUMMARY_BLOCK_CHARS);
}

function clipTo(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Per-Turn runner state shared by the stream wrapper and the event handlers. */
export interface LLMCallPreemptionState {
  /** The provider call currently streaming, if any. */
  active?: { preempt(): boolean };
  /** Final message object of the preempted call; discarded at its message_end. */
  discardMessage?: AgentMessage;
  /** The current call's output was shown to the user; such a call is not preempted. */
  deliveredInCall?: true;
  /** What the resend notice says about the preempted call. */
  discarded?: Omit<LLMCallPreemptedNoticeInput, 'timestamp'>;
  /** Set once that message was discarded; the next steering poll resends. */
  resumePending?: true;
  /** Turn phase of the preempted call: the resend replaces that call, so it keeps it. */
  resendPhase?: TurnRequestPhase;
}

const PREEMPTED: unique symbol = Symbol('llm-call-preempted');

/**
 * Wrap the main stream function so the host can end the call in flight.
 *
 * The inner request is aborted through a linked signal and released without
 * being awaited; the returned stream ends immediately with an empty `stop`
 * response, so Pi neither ends its loop (as it would on `aborted`) nor runs a
 * half-written tool call. The event handler discards that response by
 * identity and the next steering poll resends.
 */
export function withLLMCallPreemption(
  inner: StreamFn | undefined,
  state: LLMCallPreemptionState,
  nowMs: () => number,
  readWakeReasons?: () => readonly string[],
): StreamFn {
  const base = inner ?? streamSimple;
  return (async (model, context, options) => {
    const controller = new AbortController();
    const callerSignal = options?.signal;
    const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
    if (callerSignal?.aborted) controller.abort(callerSignal.reason);
    else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

    delete state.deliveredInCall;
    const wakeReasons = readWakeReasons?.();
    let partial: AssistantMessage | undefined;
    let finished = false;
    let preempted = false;
    let resolvePreempted!: (value: typeof PREEMPTED) => void;
    const preemptedSignal = new Promise<typeof PREEMPTED>((resolve) => {
      resolvePreempted = resolve;
    });
    const call = {
      preempt: (): boolean => {
        // Text the user already read is never retracted: steering waits for the next call.
        if (finished || preempted || controller.signal.aborted || state.deliveredInCall) {
          return false;
        }
        preempted = true;
        resolvePreempted(PREEMPTED);
        controller.abort(new LLMCallPreemptedError());
        return true;
      },
    };
    const finish = (): void => {
      if (finished) return;
      finished = true;
      callerSignal?.removeEventListener('abort', onCallerAbort);
      if (state.active === call) delete state.active;
    };
    const preemptedMessage = (): AssistantMessage => {
      const message: AssistantMessage = {
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
        stopReason: 'stop',
        timestamp: nowMs(),
      };
      state.discardMessage = message;
      const phase = readTurnRequestPhase(options);
      if (phase) state.resendPhase = phase;
      const discardedSummary = summarizeDiscardedResponse(partial);
      state.discarded = {
        ...(discardedSummary ? { discardedSummary } : {}),
        ...(wakeReasons ? { wakeReasons } : {}),
        ...(state.deliveredInCall ? { delivered: true } : {}),
      };
      return message;
    };
    const preemptedStream = (): AssistantMessageEventStream => {
      finish();
      const message = preemptedMessage();
      const done: AssistantMessageEvent = { type: 'done', reason: 'stop', message };
      let sent = false;
      return {
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (sent) return { value: undefined, done: true };
            sent = true;
            return { value: done, done: false };
          },
        }),
        result: async () => message,
      } as unknown as AssistantMessageEventStream;
    };

    state.active = call;
    let opened: AssistantMessageEventStream | typeof PREEMPTED;
    try {
      const pending = Promise.resolve(
        base(model, context, { ...(options ?? {}), signal: controller.signal }),
      );
      pending.catch(() => undefined);
      opened = await Promise.race([preemptedSignal, pending]);
      if (opened === PREEMPTED) {
        void pending.then(
          (late) => releaseIterator(late[Symbol.asyncIterator]()),
          () => undefined,
        );
      }
    } catch (error) {
      if (preempted) return preemptedStream();
      finish();
      throw error;
    }
    if (opened === PREEMPTED) return preemptedStream();
    const stream = opened;
    let message: AssistantMessage | undefined;
    async function* read(): AsyncGenerator<AssistantMessageEvent> {
      const iterator = stream[Symbol.asyncIterator]();
      let completed = false;
      try {
        for (;;) {
          const next = await Promise.race([preemptedSignal, iterator.next()]);
          if (next === PREEMPTED) {
            finish();
            message = preemptedMessage();
            yield { type: 'done', reason: 'stop', message };
            return;
          }
          if (next.done) {
            completed = true;
            return;
          }
          if ('partial' in next.value) partial = next.value.partial;
          if (next.value.type === 'done' || next.value.type === 'error') {
            completed = true;
            finish();
          }
          yield next.value;
        }
      } finally {
        finish();
        if (!completed) releaseIterator(iterator);
      }
    }
    const events = read();
    return {
      [Symbol.asyncIterator]: () => events,
      result: async () => {
        if (message) return message;
        const result = stream.result();
        result.catch(() => undefined);
        const final = await Promise.race([preemptedSignal, result]);
        if (final === PREEMPTED) {
          message ??= preemptedMessage();
          return message;
        }
        finish();
        return final;
      },
    } as unknown as AssistantMessageEventStream;
  }) as StreamFn;
}

/** True for the signal of a call this wrapper ended; its abort is not a Turn failure. */
export function isLLMCallPreempted(signal: AbortSignal | undefined): boolean {
  return signal?.reason instanceof LLMCallPreemptedError;
}

export class LLMCallPreemptedError extends Error {
  override readonly name = 'AbortError';
  constructor() {
    super('LLM call preempted by new user input');
  }
}

/** Ask the inner stream to stop without waiting on one that may never settle. */
function releaseIterator(iterator: AsyncIterator<AssistantMessageEvent>): void {
  void Promise.resolve()
    .then(() => iterator.return?.())
    .catch(() => undefined);
}
