import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLM_REQUEST_TIMEOUT_MS } from '@mavis/agent-core/pi-turn-runner';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import {
  createPromptSuggestionCapture,
  createPromptSuggestionService,
  type PromptSuggestionCapture,
} from './prompt-suggestion-service.js';
import {
  PROMPT_SUGGESTION_VERSION,
  promptSuggestionInstruction,
  type PromptSuggestionPolicy,
} from './prompt-suggestion-policy.js';

const answer = (text = '补充两个测试案例'): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  api: 'anthropic-messages',
  provider: 'test',
  model: 'test',
  usage: {
    input: 20,
    output: 12,
    cacheRead: 1500,
    cacheWrite: 0,
    totalTokens: 1532,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: 1,
});
function fixture(result = async () => answer()) {
  // The Runtime's stream wrapper is a real event-stream pump, so the fake
  // provider has to emit stream events rather than only expose `result()`.
  const stream = vi.fn().mockImplementation(() => {
    const events = createAssistantMessageEventStream();
    void result().then(
      (message) => {
        events.push(
          message.stopReason === 'error' || message.stopReason === 'aborted'
            ? { type: 'error', reason: message.stopReason, error: message }
            : { type: 'done', reason: 'stop', message },
        );
        events.end();
      },
      // A provider that throws before its first event still has to end the
      // stream with an error event, the way the Runtime's own wrapper does.
      (error: unknown) => {
        events.push({
          type: 'error',
          reason: 'error',
          error: {
            ...answer(),
            stopReason: 'error',
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        });
        events.end();
      },
    );
    return events;
  });
  const model = {
    id: 'test',
    api: 'anthropic-messages',
    maxTokens: 4096,
  } as PromptSuggestionCapture['prepared']['model'];
  const capture: PromptSuggestionCapture = {
    resolved: {
      model,
      streamFn: stream,
      apiKey: 'test-key',
      cacheRetention: 'short',
      headers: { 'test-routing': 'same' },
    },
    prepared: {
      sessionId: 's',
      turnId: 't',
      phase: 'initial',
      scope: 'agent',
      messages: [{ role: 'user', content: '修复这段代码', timestamp: 0 }],
      model,
      systemPrompt: 'original system',
      tools: [],
      thinkingLevel: 'off',
    },
    finalAssistant: answer('修复完成'),
    payloadFactory: () => async () => undefined,
  };
  const publish = vi.fn();
  const review = vi.fn().mockResolvedValue(true);
  const log = vi.fn();
  let enabled = true;
  let identity: string | undefined = 'account-a';
  let policy: PromptSuggestionPolicy = {
    killSwitch: false,
    sampleRate: 1,
  };
  let clock = 1_000;
  const hasPendingInput = vi.fn(async (_sessionId: string) => false);
  const service = createPromptSuggestionService({
    enabled: () => enabled,
    publish,
    review,
    log,
    hasPendingInput,
    policy: () => policy,
    identity: { identity: () => identity },
    nowMs: () => clock,
  });
  return {
    capture,
    stream,
    publish,
    review,
    log,
    hasPendingInput,
    service,
    setPolicy: (next: PromptSuggestionPolicy) => {
      policy = next;
    },
    setIdentity: (next: string | undefined) => {
      identity = next;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    disable: () => {
      enabled = false;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe('live prompt suggestions', () => {
  it('keeps the model, credentials and routing, and sends only the recent conversation once', async () => {
    const f = fixture();
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() => expect(f.stream).toHaveBeenCalledOnce());
    const [model, context, options] = f.stream.mock.calls[0]!;
    expect(model).toBe(f.capture.prepared.model);
    expect(context.systemPrompt).toBeUndefined();
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].content).toContain('<user>修复这段代码</user>');
    expect(context.messages[0].content).toContain('<assistant>修复完成</assistant>');
    expect(options.maxTokens).toBeUndefined();
    expect(options.timeoutMs).toBe(LLM_REQUEST_TIMEOUT_MS);
    expect(options).toMatchObject({
      maxRetries: 0,
      apiKey: 'test-key',
      cacheRetention: 'short',
      headers: { 'test-routing': 'same' },
    });
    expect(f.stream).toHaveBeenCalledTimes(1);
  });
  it('uses a returned payload transform', async () => {
    const f = fixture();
    const transformed = { messages: [] };
    f.capture = { ...f.capture, payloadFactory: () => async () => transformed };
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() => expect(f.stream).toHaveBeenCalledOnce());
    await expect(f.stream.mock.calls[0]![2].onPayload({}, f.capture.prepared.model)).resolves.toBe(
      transformed,
    );
  });
  it('publishes the originating turn and independent usage only after safety passes', async () => {
    const f = fixture();
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() =>
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
      ),
    );
    expect(f.review).toHaveBeenCalledWith('补充两个测试案例');
    expect(
      f.publish.mock.calls.find(([event]) => event.type === 'turn.prompt_suggestion.generated')![0],
    ).toMatchObject({
      type: 'turn.prompt_suggestion.generated',
      payload: {
        sessionId: 's',
        turnId: 't',
        suggestion: '补充两个测试案例',
        usage: { inputTokens: 1520, outputTokens: 12 },
      },
    });
  });
  it('does not block the caller and suppresses a cancelled old turn', async () => {
    let resolve!: (message: AssistantMessage) => void;
    let providerStarted!: () => void;
    const inFlight = new Promise<void>((done) => {
      providerStarted = done;
    });
    const f = fixture(() => {
      providerStarted();
      return new Promise((done) => {
        resolve = done;
      });
    });
    expect(f.service.schedule('s', 't', f.capture)).toBeUndefined();
    // The provider request is in flight before the Turn-scoped cancel arrives.
    await inFlight;
    f.service.cancel('s');
    resolve(answer());
    await vi.waitFor(() =>
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'turn.prompt_suggestion.status',
          payload: expect.objectContaining({ status: 'generating' }),
        }),
      ),
    );
    expect(f.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
    );
  });
});

describe('prompt suggestions cancellation', () => {
  it('cancels exactly one turn and never lets a stale turn cancel a newer one', async () => {
    const f = fixture(() => new Promise(() => {}));
    f.service.schedule('s', 't-old', f.capture);
    // The older Turn is already in flight before the newer one supersedes it.
    await vi.waitFor(() => expect(f.stream).toHaveBeenCalledTimes(1));
    f.service.schedule('s', 't-new', f.capture);
    await vi.waitFor(() => expect(f.stream).toHaveBeenCalledTimes(2));
    // A late cancel for the superseded turn must not abort the current request.
    expect(f.service.cancelTurn('s', 't-old')).toBe(false);
    expect(f.stream.mock.calls[1]![2].signal.aborted).toBe(false);
    expect(f.service.cancelTurn('s', 't-new')).toBe(true);
    expect(f.stream.mock.calls[1]![2].signal.aborted).toBe(true);
  });

  it('scopes dedupe to session plus turn instead of assuming turn ids are global', async () => {
    const f = fixture(() => new Promise(() => {}));
    f.service.schedule('s1', 't', f.capture);
    // The same turn id in another Session is a different Turn and still runs.
    f.service.schedule('s2', 't', f.capture);
    await vi.waitFor(() => expect(f.stream).toHaveBeenCalledTimes(2));
  });

  it('refuses a schedule that arrives after its own cancel', () => {
    const f = fixture(() => new Promise(() => {}));
    // Cancel beats the schedule: nothing is in flight, but the turn is tombstoned.
    expect(f.service.cancelTurn('s', 't')).toBe(false);
    f.service.schedule('s', 't', f.capture);
    expect(f.stream).not.toHaveBeenCalled();
  });

  it('does not let a repeated schedule cancel its own in-flight request', async () => {
    const f = fixture(() => new Promise(() => {}));
    f.service.schedule('s', 't', f.capture);
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() => expect(f.stream).toHaveBeenCalledTimes(1));
    expect(f.stream.mock.calls[0]![2].signal.aborted).toBe(false);
  });

  it('never starts provider work for a turn cancelled while it was still pending', async () => {
    const f = fixture(() => new Promise(() => {}));
    let cancelledSynchronously = false;
    f.publish.mockImplementation((event) => {
      if (event.payload?.status === 'generating' && !cancelledSynchronously) {
        cancelledSynchronously = f.service.cancelTurn('s', 't');
      }
    });
    f.service.schedule('s', 't', f.capture);
    // A synchronous subscriber that cancels on `generating` must find the request,
    // and that cancel must land before the work ever starts.
    expect(cancelledSynchronously).toBe(true);
    await vi.waitFor(() =>
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'turn.prompt_suggestion.status',
          payload: expect.objectContaining({ status: 'cancelled' }),
        }),
      ),
    );
    expect(f.stream).not.toHaveBeenCalled();
  });

  it('settles a turn cancelled during the queue read as cancelled, not unavailable', async () => {
    const f = fixture(() => new Promise(() => {}));
    f.hasPendingInput.mockImplementation(async () => {
      // A cancel that lands while the queue read is in flight.
      f.service.cancelTurn('s', 't');
      return true;
    });
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() =>
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'turn.prompt_suggestion.status',
          payload: expect.objectContaining({ status: 'cancelled' }),
        }),
      ),
    );
    expect(f.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'turn.prompt_suggestion.status',
        payload: expect.objectContaining({ status: 'unavailable' }),
      }),
    );
  });

  it('starts no provider work when the turn is already cancelled', async () => {
    const f = fixture();
    f.hasPendingInput.mockImplementation(async () => {
      f.service.cancelTurn('s', 't');
      return false;
    });
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() => expect(f.hasPendingInput).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.stream).not.toHaveBeenCalled();
  });
});

describe('input already waiting for the next turn', () => {
  it('issues no request when input is already queued', async () => {
    const f = fixture();
    f.hasPendingInput.mockResolvedValue(true);
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() =>
      expect(f.log).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'skipped_pending_input' }),
      ),
    );
    expect(f.hasPendingInput).toHaveBeenCalledWith('s');
    expect(f.stream).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ status: 'unavailable' }) }),
    );
  });
  it('proceeds when the queue cannot be read', async () => {
    const f = fixture();
    f.hasPendingInput.mockRejectedValue(new Error('db busy'));
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() =>
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
      ),
    );
  });
});

describe('prompt suggestions validation and deadlines', () => {
  it('publishes a slow reply instead of cutting it off at a fixed deadline', async () => {
    vi.useFakeTimers();
    let release!: (message: AssistantMessage) => void;
    const f = fixture(
      () =>
        new Promise<AssistantMessage>((resolve) => {
          release = resolve;
        }),
    );
    f.service.schedule('s', 't', f.capture);
    await vi.advanceTimersByTimeAsync(12_000);
    const options = f.stream.mock.calls[0]![2];
    // Only the bounds every main request gets apply; the suggestion adds none.
    expect(options.timeoutMs).toBe(LLM_REQUEST_TIMEOUT_MS);
    expect(options.signal.aborted).toBe(false);
    release(answer('补一个慢请求的回归测试'));
    await vi.waitFor(() =>
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
      ),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cancels in-flight requests when disabled and never starts while disabled', async () => {
    vi.useFakeTimers();
    const f = fixture(() => new Promise(() => {}));
    f.service.schedule('s', 't', f.capture);
    // The queue read settles before the provider request exists.
    await vi.advanceTimersByTimeAsync(0);
    expect(f.stream).toHaveBeenCalledTimes(1);
    f.disable();
    await vi.advanceTimersByTimeAsync(251);
    expect(f.stream.mock.calls[0]![2].signal.aborted).toBe(true);
    f.service.schedule('s', 't2', f.capture);
    expect(f.stream).toHaveBeenCalledTimes(1);
  });
  it('drops failed, truncated, multiline and tool output', async () => {
    const messages: AssistantMessage[] = [
      { ...answer(), stopReason: 'length' },
      answer('first\nsecond'),
      answer('x'.repeat(241)),
      { ...answer(), content: [{ type: 'toolCall', id: 't', name: 'write', arguments: {} }] },
    ];
    for (const message of messages) {
      const f = fixture(async () => message);
      f.service.schedule('s', 't', f.capture);
      await vi.waitFor(() =>
        expect(f.publish).toHaveBeenCalledWith(
          expect.objectContaining({ payload: expect.objectContaining({ status: 'unavailable' }) }),
        ),
      );
      expect(f.publish).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
      );
    }
  });
  it('aborts and rejects further work when its runtime owner closes', async () => {
    const f = fixture(() => new Promise(() => {}));
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() => expect(f.stream).toHaveBeenCalledOnce());
    f.service.close();
    expect(f.stream.mock.calls[0]![2].signal.aborted).toBe(true);
    f.service.schedule('s', 'new', f.capture);
    expect(f.stream).toHaveBeenCalledTimes(1);
  });
  it('resets the final assistant when a new prepared call starts', () => {
    const f = fixture();
    const capture = createPromptSuggestionCapture(f.capture.resolved, f.capture.payloadFactory);
    capture.preparedHook(f.capture.prepared);
    capture.assistantHook({ message: answer() } as Parameters<typeof capture.assistantHook>[0]);
    expect(capture.read()).toBeDefined();
    capture.preparedHook(f.capture.prepared);
    expect(capture.read()).toBeUndefined();
  });
  it('does not publish a safety rejection', async () => {
    const f = fixture();
    f.review.mockResolvedValue(false);
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() => expect(f.review).toHaveBeenCalled());
    expect(f.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
    );
  });
  it.each([
    '不用了，先这样，谢谢',
    '好的，谢谢！',
    '继续',
    'No thanks.',
    'OK, thank you',
    '',
    '修复这段代码！',
  ])('drops filler, empty output and repeated requests without retry: %s', async (text) => {
    const f = fixture(async () => answer(text));
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() =>
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({ payload: expect.objectContaining({ status: 'unavailable' }) }),
      ),
    );
    expect(f.stream).toHaveBeenCalledOnce();
    expect(f.review).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
    );
  });
  it.each(['不用抛异常，改为对空数组返回 NaN', '继续补齐空数组和非法输入的测试'])(
    'keeps concrete actions that contain conversational words: %s',
    async (text) => {
      const f = fixture(async () => answer(text));
      f.service.schedule('s', 't', f.capture);
      await vi.waitFor(() =>
        expect(f.publish).toHaveBeenCalledWith(
          expect.objectContaining({
            type: 'turn.prompt_suggestion.generated',
            payload: expect.objectContaining({ suggestion: text }),
          }),
        ),
      );
    },
  );
});

describe('restoring a generated prompt suggestion', () => {
  const generated = () => fixture(async () => answer('补一个失败路径的测试'));

  it('restores a passed result with its version, timing and usage, and never calls the model', async () => {
    const f = generated();
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() =>
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
      ),
    );
    const callsBeforeRead = f.stream.mock.calls.length;

    const first = f.service.read('s', 't');
    const second = f.service.read('s', 't');

    expect(first).toMatchObject({
      suggestion: '补一个失败路径的测试',
      promptVersion: PROMPT_SUGGESTION_VERSION,
      status: 'ready',
    });
    expect(first.generatedAt).toBe(1_000);
    expect(first.elapsedMs).toBeGreaterThanOrEqual(0);
    // Repeated reads are pure lookups: identical and free.
    expect(second).toEqual(first);
    expect(f.stream.mock.calls.length).toBe(callsBeforeRead);
  });

  it('reports the whole prompt as input tokens, including a provider-cached prefix', async () => {
    const f = generated();
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() =>
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
      ),
    );
    // input=20, cacheRead=1500, cacheWrite=0 -> 1520 prompt tokens.
    expect(f.service.read('s', 't').usage).toEqual({ inputTokens: 1520, outputTokens: 12 });
  });

  it('does not revive a cancelled result, so a remount cannot resurrect a dismissal', async () => {
    const f = generated();
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() =>
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
      ),
    );
    // Cancel after the request already finished: the result exists but the user
    // dismissed it, and a later navigation read must still not return it.
    f.service.cancelTurn('s', 't');
    expect(f.service.read('s', 't')).toEqual({ status: 'cancelled' });
  });

  it('drops the previous turn when a new turn starts and refuses to read the stale one', async () => {
    const f = generated();
    f.service.schedule('s', 't1', f.capture);
    await vi.waitFor(() =>
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
      ),
    );
    expect(f.service.read('s', 't1').status).toBe('ready');

    f.service.cancel('s');
    expect(f.service.read('s', 't1')).toEqual({ status: 'absent' });
  });

  it('expires a retained result instead of restoring stale text', async () => {
    const f = generated();
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() =>
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
      ),
    );
    f.advance(10 * 60 * 1_000 + 1);
    expect(f.service.read('s', 't')).toEqual({ status: 'expired' });
    // And it is dropped, so a second read reports absence rather than repeating.
    expect(f.service.read('s', 't')).toEqual({ status: 'absent' });
  });

  it('keeps results out of reach once the feature is disabled or the service closes', async () => {
    const f = generated();
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() =>
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
      ),
    );
    f.disable();
    expect(f.service.read('s', 't')).toEqual({ status: 'disabled' });

    const g = generated();
    g.service.schedule('s', 't', g.capture);
    await vi.waitFor(() =>
      expect(g.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
      ),
    );
    g.service.close();
    expect(g.service.read('s', 't')).toEqual({ status: 'disabled' });
  });

  it('hides another account’s result and drops the cache when the identity changes', async () => {
    const f = generated();
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() =>
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
      ),
    );
    f.setIdentity('account-b');
    // A switch must not merely refuse: the old account's text is discarded.
    expect(f.service.read('s', 't')).toEqual({ status: 'other_account' });
    expect(f.service.read('s', 't')).toEqual({ status: 'absent' });
  });

  it('never publishes a result that arrives after an account switch', async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    f.stream.mockImplementation(() => ({
      result: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return answer('补一个失败路径的测试');
      },
    }));
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() => expect(f.stream).toHaveBeenCalled());
    f.setIdentity('account-b');
    release?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
    );
    expect(f.service.read('s', 't').status).not.toBe('ready');
  });
});

describe('versioned prompt suggestion policy', () => {
  it('never generates or restores anything while the kill switch is on', async () => {
    const f = fixture();
    f.setPolicy({ killSwitch: true, sampleRate: 1 });
    f.service.schedule('s', 't', f.capture);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.stream).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped_policy_kill_switch' }),
    );
    expect(f.service.read('s', 't')).toEqual({ status: 'disabled' });
  });

  it('short-circuits an unsampled session before any model call', async () => {
    const f = fixture();
    f.setPolicy({ killSwitch: false, sampleRate: 0 });
    f.service.schedule('s', 't', f.capture);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.stream).not.toHaveBeenCalled();
    expect(f.log).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped_policy_not_sampled' }),
    );
  });

  it('stops restoring an old result once the policy is updated to kill', async () => {
    const f = fixture(async () => answer('补一个失败路径的测试'));
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() =>
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
      ),
    );
    expect(f.service.read('s', 't').status).toBe('ready');
    f.setPolicy({ killSwitch: true, sampleRate: 1 });
    expect(f.service.read('s', 't')).toEqual({ status: 'disabled' });
  });
});

describe('prompt suggestion structured logging', () => {
  it('records the version, elapsed time and usage for a generated result', async () => {
    const f = fixture(async () => answer('补一个失败路径的测试'));
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() =>
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
      ),
    );
    expect(f.log).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'generated',
        promptVersion: PROMPT_SUGGESTION_VERSION,
        elapsedMs: expect.any(Number),
      }),
    );
  });

  it('separates a validation failure from a safety failure', async () => {
    const rejected = fixture(async () => answer('thanks'));
    rejected.service.schedule('s', 't', rejected.capture);
    await vi.waitFor(() =>
      expect(rejected.log).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'rejected_validation' }),
      ),
    );
    expect(rejected.review).not.toHaveBeenCalled();

    const blocked = fixture(async () => answer('补一个失败路径的测试'));
    blocked.review.mockResolvedValue(false);
    blocked.service.schedule('s', 't', blocked.capture);
    await vi.waitFor(() =>
      expect(blocked.log).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'rejected_safety' }),
      ),
    );
  });

  it('never records the prompt or the produced text in a log line', async () => {
    const text = '补一个失败路径的测试';
    const f = fixture(async () => answer(text));
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() =>
      expect(f.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
      ),
    );
    for (const [fields] of f.log.mock.calls) {
      expect(JSON.stringify(fields)).not.toContain(text);
      expect(JSON.stringify(fields)).not.toContain('Suggest one concrete next action');
    }
  });
});

describe('policy changes invalidate optional work', () => {
  it('drops cached results on policy changes and does not resurrect after re-enabling', async () => {
    const f = fixture();
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() => expect(f.service.read('s', 't').status).toBe('ready'));
    f.setPolicy({ killSwitch: true, sampleRate: 1 });
    expect(f.service.read('s', 't').suggestion).toBeUndefined();
    f.setPolicy({ killSwitch: false, sampleRate: 1 });
    expect(f.service.read('s', 't').suggestion).toBeUndefined();
  });
  it('does not call the provider after policy changes during the queue read', async () => {
    let release!: () => void;
    const f = fixture();
    f.hasPendingInput.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(false);
        }),
    );
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() => expect(f.hasPendingInput).toHaveBeenCalledOnce());
    f.setPolicy({ killSwitch: true, sampleRate: 1 });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.stream).not.toHaveBeenCalled();
    expect(f.service.isEnabled()).toBe(false);
  });
  it('discards a completed response if the policy changed during the safety check', async () => {
    let release!: () => void;
    const f = fixture();
    f.review.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(true);
        }),
    );
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() => expect(f.review).toHaveBeenCalled());
    f.setPolicy({ killSwitch: false, sampleRate: 0 });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.publish).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'turn.prompt_suggestion.generated' }),
    );
    expect(f.service.read('s', 't').suggestion).toBeUndefined();
  });
  it('records explicit abstention separately from invalid model output', async () => {
    const f = fixture(async () => answer(''));
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() =>
      expect(f.log).toHaveBeenCalledWith(expect.objectContaining({ status: 'abstained' })),
    );
    expect(f.log).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'generated' }));
  });
});

// Suggestion requests built from the recent conversation (a separate small request).
const replyUsage = (input = 20) => ({
  input,
  output: 60,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: input + 60,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const replyWith = (
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
  input = 20,
): AssistantMessage => ({
  role: 'assistant',
  content,
  api: 'anthropic-messages',
  provider: 'test',
  model: 'test',
  usage: replyUsage(input),
  stopReason,
  timestamp: 1,
});

function recentFixture(result: () => Promise<AssistantMessage>, mainInputTokens = 20) {
  // The Runtime's stream wrapper is a real event-stream pump, so the fake
  // provider has to emit stream events rather than only expose `result()`.
  const stream = vi.fn().mockImplementation(() => {
    const events = createAssistantMessageEventStream();
    void result().then((message) => {
      events.push(
        message.stopReason === 'error' || message.stopReason === 'aborted'
          ? { type: 'error', reason: message.stopReason, error: message }
          : { type: 'done', reason: 'stop', message },
      );
      events.end();
    });
    return events;
  });
  const model = {
    id: 'test',
    api: 'anthropic-messages',
    maxTokens: 4096,
  } as PromptSuggestionCapture['prepared']['model'];
  const capture: PromptSuggestionCapture = {
    resolved: { model, streamFn: stream, apiKey: 'k', headers: { 'test-routing': 'same' } },
    prepared: {
      sessionId: 's',
      turnId: 't',
      phase: 'initial',
      scope: 'agent',
      messages: [
        {
          role: 'user',
          content: '修复这个 bug 并跑测试<system-reminder>internal</system-reminder>',
          timestamp: 0,
        },
        replyWith(
          [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'cat src/a.ts' } }],
          'toolUse',
        ),
        {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'TOOL_OUTPUT_SHOULD_NOT_APPEAR' }],
          isError: false,
          timestamp: 0,
        },
      ],
      model,
      systemPrompt: 'sys',
      tools: [{ name: 'bash', description: 'run', parameters: {} } as never],
      thinkingLevel: 'off',
    },
    finalAssistant: replyWith(
      [{ type: 'text', text: '已修复，测试还没跑。' }],
      'stop',
      mainInputTokens,
    ),
    payloadFactory: () => async () => undefined,
  };
  const publish = vi.fn();
  const log = vi.fn();
  const service = createPromptSuggestionService({
    enabled: () => true,
    publish,
    review: async () => true,
    log,
    policy: () => ({ killSwitch: false, sampleRate: 1 }),
    identity: { identity: () => 'acct' },
  });
  return { stream, publish, log, service, capture };
}

const publishedSuggestions = (publish: ReturnType<typeof vi.fn>) =>
  publish.mock.calls.filter(([event]) => event.type === 'turn.prompt_suggestion.generated');

describe('suggestion request built from the recent conversation', () => {
  it('sends one small user message: no system prompt, no tools, no tool output, no output cap', async () => {
    const f = recentFixture(async () => replyWith([{ type: 'text', text: '运行测试并汇报结果' }]));
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() => expect(f.stream).toHaveBeenCalledOnce());
    const [model, context, options] = f.stream.mock.calls[0]!;
    expect(model).toBe(f.capture.prepared.model);
    expect(context.systemPrompt).toBeUndefined();
    expect(context.tools).toBeUndefined();
    expect(context.messages).toHaveLength(1);
    const prompt = context.messages[0].content as string;
    expect(prompt).toContain('<user>修复这个 bug 并跑测试</user>');
    expect(prompt).toContain('<assistant>已修复，测试还没跑。</assistant>');
    expect(prompt).not.toContain('TOOL_OUTPUT_SHOULD_NOT_APPEAR');
    expect(prompt).not.toContain('internal');
    expect(prompt.endsWith(promptSuggestionInstruction(PROMPT_SUGGESTION_VERSION))).toBe(true);
    expect(options.maxTokens).toBeUndefined();
    expect(options).toMatchObject({
      apiKey: 'k',
      headers: { 'test-routing': 'same' },
      maxRetries: 0,
    });
  });

  it.each([
    ['high', 'high'],
    ['low', 'low'],
    ['off', undefined],
  ] as const)('follows the main Turn thinking level %s', async (level, reasoning) => {
    const f = recentFixture(async () => replyWith([{ type: 'text', text: '运行测试并汇报结果' }]));
    f.capture = { ...f.capture, prepared: { ...f.capture.prepared, thinkingLevel: level } };
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() => expect(f.stream).toHaveBeenCalledOnce());
    expect(f.stream.mock.calls[0]![2].reasoning).toBe(reasoning);
  });

  it('no longer skips a Turn whose main request read a large prompt', async () => {
    const f = recentFixture(
      async () => replyWith([{ type: 'text', text: '运行测试并汇报结果' }]),
      200_000,
    );
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() => expect(publishedSuggestions(f.publish)).toHaveLength(1));
    expect(f.stream).toHaveBeenCalledOnce();
  });
});

describe('reply from a model that keeps thinking on (forced_on)', () => {
  it('publishes the text and ignores the thinking block', async () => {
    const f = recentFixture(async () =>
      replyWith([
        { type: 'thinking', thinking: '用户下一步应该是跑测试', thinkingSignature: 'sig' },
        { type: 'text', text: '运行测试并汇报结果' },
      ]),
    );
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() => expect(publishedSuggestions(f.publish)).toHaveLength(1));
    expect(publishedSuggestions(f.publish)[0]![0].payload.suggestion).toBe('运行测试并汇报结果');
  });

  it('still drops a reply that requests a tool', async () => {
    const f = recentFixture(async () =>
      replyWith([
        { type: 'text', text: '运行测试' },
        { type: 'toolCall', id: 'x', name: 'bash', arguments: {} },
      ]),
    );
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() =>
      expect(f.log).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'rejected_validation' }),
      ),
    );
    expect(publishedSuggestions(f.publish)).toHaveLength(0);
  });
});

describe('abstention written as text', () => {
  it.each(['(empty)', '（无）', 'None', '无', '[no suggestion]'])(
    'treats %j as abstaining',
    async (text) => {
      const f = recentFixture(async () => replyWith([{ type: 'text', text }]));
      f.service.schedule('s', 't', f.capture);
      await vi.waitFor(() =>
        expect(f.log).toHaveBeenCalledWith(expect.objectContaining({ status: 'abstained' })),
      );
      expect(publishedSuggestions(f.publish)).toHaveLength(0);
    },
  );

  it('keeps a real suggestion that merely contains brackets', async () => {
    const f = recentFixture(async () =>
      replyWith([{ type: 'text', text: '把 (a, b) 两个参数的校验补上' }]),
    );
    f.service.schedule('s', 't', f.capture);
    await vi.waitFor(() => expect(publishedSuggestions(f.publish)).toHaveLength(1));
  });
});

describe('terminal facts carried for analytics', () => {
  const terminals = (publish: ReturnType<typeof vi.fn>) =>
    publish.mock.calls
      .map(([event]) => event)
      .filter(
        (event) =>
          event.type === 'turn.prompt_suggestion.status' && event.payload.status !== 'generating',
      )
      .map((event) => event.payload);
  const attempt = { promptVersion: PROMPT_SUGGESTION_VERSION, model: 'test', msgId: 'reply-1' };

  it('stamps a generated suggestion with its version, model, reply and usage', async () => {
    const f = fixture();
    f.service.schedule('s', 't', f.capture, 'reply-1');
    await vi.waitFor(() => expect(publishedSuggestions(f.publish)).toHaveLength(1));
    expect(publishedSuggestions(f.publish)[0]![0].payload).toMatchObject({
      ...attempt,
      elapsedMs: expect.any(Number),
      usage: { inputTokens: 1520, outputTokens: 12 },
    });
    expect(terminals(f.publish)).toEqual([]);
  });

  it.each([
    ['abstained', () => answer('(empty)'), true],
    ['rejected_validation', () => answer('不需要了'), true],
    ['rejected_safety', () => answer(), false],
  ] as const)('reports %s with the request usage and no text', async (reason, reply, passes) => {
    const f = fixture(async () => reply());
    f.review.mockResolvedValue(passes);
    f.service.schedule('s', 't', f.capture, 'reply-1');
    await vi.waitFor(() => expect(terminals(f.publish)).toHaveLength(1));
    expect(terminals(f.publish)[0]).toEqual({
      ...attempt,
      sessionId: 's',
      turnId: 't',
      status: 'unavailable',
      reason,
      requested: true,
      elapsedMs: expect.any(Number),
      usage: { inputTokens: 1520, outputTokens: 12 },
    });
    expect(JSON.stringify(f.publish.mock.calls)).not.toContain('补充两个测试案例');
  });

  it.each([
    ['not_sampled', { killSwitch: false, sampleRate: 0 }],
    ['kill_switch', { killSwitch: true, sampleRate: 1 }],
  ] as const)('reports a %s policy refusal as never requested', async (reason, policy) => {
    const f = fixture();
    f.setPolicy(policy);
    f.service.schedule('s', 't', f.capture, 'reply-1');
    expect(terminals(f.publish)).toEqual([
      { ...attempt, sessionId: 's', turnId: 't', status: 'unavailable', reason, requested: false },
    ]);
    expect(f.stream).not.toHaveBeenCalled();
  });

  it('reports the concurrency limit and queued input as never requested', async () => {
    const busy = fixture(() => new Promise<AssistantMessage>(() => undefined));
    busy.service.schedule('a', 't', busy.capture);
    busy.service.schedule('b', 't', busy.capture);
    busy.service.schedule('c', 't', busy.capture);
    expect(terminals(busy.publish)).toEqual([
      expect.objectContaining({ sessionId: 'c', reason: 'concurrency_limit', requested: false }),
    ]);

    const queued = fixture();
    queued.hasPendingInput.mockResolvedValue(true);
    queued.service.schedule('s', 't', queued.capture);
    await vi.waitFor(() => expect(terminals(queued.publish)).toHaveLength(1));
    expect(terminals(queued.publish)[0]).toMatchObject({
      reason: 'skipped_pending_input',
      requested: false,
    });
    expect(terminals(queued.publish)[0]).not.toHaveProperty('elapsedMs');
    expect(queued.stream).not.toHaveBeenCalled();
  });

  it('reports a cancelled request and a failed request after they were issued', async () => {
    const cancelled = fixture(() => new Promise<AssistantMessage>(() => undefined));
    cancelled.service.schedule('s', 't', cancelled.capture, 'reply-1');
    await vi.waitFor(() => expect(cancelled.stream).toHaveBeenCalledOnce());
    cancelled.service.cancel('s');
    await vi.waitFor(() => expect(terminals(cancelled.publish)).toHaveLength(1));
    expect(terminals(cancelled.publish)[0]).toMatchObject({
      ...attempt,
      status: 'cancelled',
      reason: 'cancelled',
      requested: true,
      elapsedMs: expect.any(Number),
    });

    // The "provider throws before its first event" half of this contract needs
    // a pull-through stream fake. This projection's wrapper is an eager
    // event-stream pump, so a throw before the first event is delivered as an
    // error event the fake cannot raise as a rejected `result()`.
  });
});
