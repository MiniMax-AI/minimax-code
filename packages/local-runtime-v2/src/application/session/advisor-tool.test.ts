import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
} from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { PiTurnRunner } from '@mavis/agent-core/pi-turn-runner';
import type { RuntimeTool } from '@mavis/agent-core/tools';
import type { LocalRuntimeToolContext } from '@mavis/agent-tools/desktop';
import { describe, expect, it, vi } from 'vitest';

import type { LocalResolvedModelConfig } from '../../service/model-system/index.js';
import type { AdvisorCallMaterial } from './advisor-capture.js';
import { createAdvisorTool, type AdvisorToolDependencies } from './advisor-tool.js';

const BINDING = {
  providerId: 'provider-advisor',
  modelId: 'advisor-large',
  contextWindow: 200_000,
  maxOutputTokens: 32_000,
};

const MATERIAL: AdvisorCallMaterial = {
  systemPrompt: 'main system prompt',
  messages: [{ role: 'user', content: 'Refactor the parser', timestamp: 1 }],
  binding: BINDING,
};

function advisorModel(
  input: readonly ('text' | 'image')[] = ['text'],
  contextWindow = 200_000,
): Model<Api> {
  return {
    id: 'advisor-large',
    name: 'advisor-large',
    api: 'anthropic-messages',
    provider: 'provider-advisor',
    baseUrl: 'https://advisor.example',
    reasoning: true,
    input: [...input],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 32_000,
  };
}

function final(
  stopReason: AssistantMessage['stopReason'],
  content: AssistantMessage['content'],
  errorMessage?: string,
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'anthropic-messages',
    provider: 'provider-advisor',
    model: 'advisor-large',
    usage: {
      input: 900,
      output: 120,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 1_120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
    timestamp: 5,
  };
}

/** A provider stream that answers every request with `message` and records its context. */
function providerStream(message: AssistantMessage | ((signal?: AbortSignal) => Promise<never>)) {
  const requests: { context: Context; options: Record<string, unknown> | undefined }[] = [];
  const streamFn: StreamFn = (async (_model, context, options) => {
    requests.push({ context, options: options as Record<string, unknown> | undefined });
    if (typeof message === 'function') return message(options?.signal);
    const stream = createAssistantMessageEventStream();
    if (message.stopReason === 'error' || message.stopReason === 'aborted') {
      stream.push({ type: 'error', reason: message.stopReason, error: message });
    } else {
      stream.push({ type: 'done', reason: message.stopReason, message });
    }
    return stream;
  }) as StreamFn;
  return { streamFn, requests };
}

function setup(input: {
  readonly response?: Parameters<typeof providerStream>[0];
  readonly resolved?: 'unavailable';
  readonly material?: AdvisorCallMaterial;
  readonly modelInput?: readonly ('text' | 'image')[];
  readonly contextWindow?: number;
  readonly timeoutMs?: number;
  readonly resolveModel?: AdvisorToolDependencies['resolveModel'];
  readonly usageRecorder?: AdvisorToolDependencies['usageRecorder'];
}) {
  const provider = providerStream(input.response ?? final('stop', [{ type: 'text', text: 'ok' }]));
  const llm: LocalResolvedModelConfig = {
    model: advisorModel(input.modelInput, input.contextWindow),
    apiKey: 'advisor-key',
    thinkingLevel: 'high',
    streamFn: provider.streamFn,
  };
  const recordUsage = vi.fn(async () => undefined);
  const resolveModel = vi.fn(
    input.resolveModel ??
      (async () => (input.resolved === 'unavailable' ? undefined : { agentConfig: {}, llm })),
  );
  const dependencies: AdvisorToolDependencies = {
    captures: { read: () => input.material ?? MATERIAL },
    resolveModel,
    buildPayloadTransform: () => undefined,
    recordUsage,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.usageRecorder ? { usageRecorder: input.usageRecorder } : {}),
    nowMs: (() => {
      let now = 1_000;
      return () => {
        now += 250;
        return now;
      };
    })(),
  };
  const ctx = {
    sessionId: 'session-main',
    turnId: 'turn-7',
    toolCallId: 'call-advisor',
  } as unknown as LocalRuntimeToolContext;
  const tool = createAdvisorTool(dependencies);
  return { tool, ctx, provider, recordUsage, resolveModel };
}

describe('advisor tool execution', () => {
  it('returns the advice and records its own usage row', async () => {
    const { tool, ctx, provider, recordUsage } = setup({
      response: final('stop', [
        { type: 'thinking', thinking: 'considering' },
        { type: 'text', text: 'Check the tokenizer callers first.' },
      ]),
    });

    const result = await tool.impl.execute(ctx, {});

    expect(result.text).toBe('Check the tokenizer callers first.');
    expect(result.isError).toBeUndefined();
    expect(result.details).toEqual({
      providerId: 'provider-advisor',
      modelId: 'advisor-large',
      durationMs: expect.any(Number),
      inputTokens: 1_000,
      outputTokens: 120,
      outcome: 'advice',
    });
    const request = provider.requests[0];
    expect(provider.requests).toHaveLength(1);
    expect(request?.context.systemPrompt).toContain('You are an advisor to a coding agent.');
    expect(request?.context.tools).toBeUndefined();
    expect(request?.context.messages).toHaveLength(1);
    expect(request?.context.messages[0]?.role).toBe('user');
    expect(JSON.stringify(request?.context.messages[0])).toContain('Refactor the parser');
    expect(request?.options).toMatchObject({ apiKey: 'advisor-key', reasoning: 'high' });
    expect(recordUsage).toHaveBeenCalledWith({
      sessionId: 'session-main',
      turnId: 'turn-7',
      model: { provider: 'provider-advisor', id: 'advisor-large' },
      messages: [expect.objectContaining({ role: 'assistant', usage: expect.any(Object) })],
    });
  });

  it('marks advice cut off at the advisor output limit', async () => {
    const { tool, ctx } = setup({
      response: final('length', [{ type: 'text', text: 'First, split the' }]),
    });

    const result = await tool.impl.execute(ctx, {});

    expect(result.text).toBe(
      "First, split the\n\n[The advice was cut off at the advisor model's output limit.]",
    );
    expect(result.isError).toBeUndefined();
    expect(result.details).toMatchObject({ outcome: 'truncated' });
  });

  it.each([
    ['Messages API', 'prompt is too long: 230000 tokens > 200000 maximum'],
    ['Zhipu', 'Prompt exceeds max length'],
  ])('reports a conversation larger than the advisor window (%s)', async (_label, errorMessage) => {
    const { tool, ctx, recordUsage } = setup({ response: final('error', [], errorMessage) });

    const result = await tool.impl.execute(ctx, {});

    expect(result.text).toBe(
      "The conversation exceeds the advisor model's context window, so no advice was returned this time. Continue with your own judgement.",
    );
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ outcome: 'context_overflow' });
    expect(recordUsage).toHaveBeenCalledOnce();
  });

  it('leaves out the oldest messages after the task to fit the advisor input limit', async () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(1_000);
    const material: AdvisorCallMaterial = {
      ...MATERIAL,
      messages: [
        { role: 'user', content: 'Refactor the parser', timestamp: 1 },
        ...Array.from(
          { length: 8 },
          (_, step): Message => ({
            role: 'user',
            content: `step ${step} ${filler}`,
            timestamp: step + 2,
          }),
        ),
        { role: 'user', content: 'latest message', timestamp: 20 },
      ],
    };
    // A 40K window admits about 21.5K input tokens, far less than the eight steps.
    const { tool, ctx, provider } = setup({ material, contextWindow: 40_000 });

    const result = await tool.impl.execute(ctx, {});

    const omitted = (result.details as { readonly omittedMessages?: number }).omittedMessages ?? 0;
    expect(omitted).toBeGreaterThan(0);
    expect(omitted).toBeLessThan(8);
    expect(result.details).toMatchObject({ outcome: 'advice', omittedMessages: omitted });
    const transcript = JSON.stringify(provider.requests[0]?.context.messages[0]);
    expect(transcript).toContain('Refactor the parser');
    expect(transcript).toContain(
      `[${omitted} earlier messages omitted to fit the advisor's context window]`,
    );
    expect(transcript).toContain('step 7 ');
    expect(transcript).not.toContain('step 0 ');
    expect(transcript).toContain('latest message');
  });

  it('reports a provider failure with a short reason', async () => {
    const { tool, ctx } = setup({
      response: final(
        'error',
        [],
        '400 invalid_request_error: messages.0: unsupported field\nrequest id abc',
      ),
    });

    const result = await tool.impl.execute(ctx, {});

    expect(result.text).toBe(
      'The advisor returned no advice (400 invalid_request_error: messages.0: unsupported field). Continue with your own judgement.',
    );
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ outcome: 'provider_error' });
  });

  it('never falls back to another model when the selected one is unavailable', async () => {
    const { tool, ctx, provider, recordUsage } = setup({ resolved: 'unavailable' });

    const result = await tool.impl.execute(ctx, {});

    expect(result.text).toBe(
      'The advisor model selected for this session is currently unavailable. Continue with your own judgement.',
    );
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({
      providerId: 'provider-advisor',
      modelId: 'advisor-large',
      outcome: 'model_unavailable',
    });
    expect(provider.requests).toHaveLength(0);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('returns Cancelled when the user stops the Turn during the request', async () => {
    const controller = new AbortController();
    const { tool, ctx } = setup({
      response: (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('Request was aborted')));
          controller.abort();
        }),
    });

    const result = await tool.impl.execute(ctx, {}, controller.signal);

    expect(result.text).toBe('Cancelled.');
    expect(result.isError).toBe(true);
    expect(result.details).toMatchObject({ outcome: 'cancelled' });
  });

  it('sends images only to an advisor model that accepts image input', async () => {
    const material: AdvisorCallMaterial = {
      ...MATERIAL,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Match this mock' },
            { type: 'image', data: 'cG5n', mimeType: 'image/png' },
          ],
          timestamp: 1,
        },
      ],
    };
    const withImages = setup({ material, modelInput: ['text', 'image'] });
    const textOnly = setup({ material, modelInput: ['text'] });

    await withImages.tool.impl.execute(withImages.ctx, {});
    await textOnly.tool.impl.execute(textOnly.ctx, {});

    const sent = (provider: ReturnType<typeof setup>['provider']) =>
      provider.requests[0]?.context.messages[0]?.content as { type: string }[];
    expect(sent(withImages.provider).map((part) => part.type)).toEqual(['text', 'image', 'text']);
    expect(sent(textOnly.provider).map((part) => part.type)).toEqual(['text']);
    expect(JSON.stringify(sent(textOnly.provider))).toContain('[image omitted]');
  });
});

/** User steering the test drives: `steer()` makes a user message pending and wakes waiters. */
describe('advisor tool review, accounting and call limit', () => {
  it("reports the request's usage to the Turn's usage recorder as an advisor request", async () => {
    const settle = vi.fn(async () => undefined);
    const usageRecorder = vi.fn(() => ({ settle }));
    const { tool, ctx } = setup({ usageRecorder });

    await tool.impl.execute(ctx, {});

    // A Goal charges it to its token budget; it is not one of the Goal's requests.
    expect(usageRecorder).toHaveBeenCalledWith({ sessionId: 'session-main', turnId: 'turn-7' });
    expect(settle).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'advisor', outcome: 'success' }),
    );
  });

  it.each([
    ['the advice it streamed', 2, [{ type: 'text' as const, text: 'blocked words' }]],
    ['the request before any advice', 4, []],
  ])(
    'withholds the advice when the gateway rejects %s, without passing on its details',
    async (_label, action, content) => {
      const body = JSON.stringify({
        type: 'error',
        error: {
          type: 'content_error',
          message: 'content unavailable',
          code: 50201,
          action,
          guide_prompt: 'GATEWAY-GUIDE',
          request_id: 'req-advisor',
        },
      });
      const { tool, ctx, provider, recordUsage } = setup({
        response: final('error', content, body),
      });

      const result = await tool.impl.execute(ctx, {});

      // 顾问请求不带重发：网关打回一次就结束，建议不交给主模型。
      expect(provider.requests).toHaveLength(1);
      expect(result.details).toMatchObject({ outcome: 'withheld' });
      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        'The advisor could not answer this request. Continue with your own judgement.',
      );
      expect(JSON.stringify(result)).not.toContain('GATEWAY-GUIDE');
      expect(JSON.stringify(result)).not.toContain('blocked words');
      expect(recordUsage).toHaveBeenCalledOnce();
    },
  );

  it('sends the Turn input to the advisor model with no local review, leaving review to the gateway', async () => {
    const { tool, ctx, provider } = setup({
      material: { ...MATERIAL, userInput: 'Refactor the parser' },
      response: final('stop', [{ type: 'text', text: 'Run the tests.' }]),
    });

    const result = await tool.impl.execute(ctx, {});

    expect(result.details).toMatchObject({ outcome: 'advice' });
    expect(result.text).toBe('Run the tests.');
    expect(provider.requests).toHaveLength(1);
    const systemPrompt = provider.requests[0]?.context.systemPrompt ?? '';
    expect(systemPrompt.startsWith('You are an advisor')).toBe(true);
    expect(
      systemPrompt.endsWith(
        'Keep the advice under 300 words unless the situation genuinely needs more.',
      ),
    ).toBe(true);
  });

  it('stops a request that outlives the call limit and lets the main model continue', async () => {
    let requestSignal: AbortSignal | undefined;
    const { tool, ctx, recordUsage } = setup({
      timeoutMs: 20,
      // The provider never answers, like the calls that hung for hours in evaluation.
      response: (signal) =>
        new Promise<never>((_resolve, reject) => {
          requestSignal = signal;
          signal?.addEventListener('abort', () => reject(new Error('Request was aborted')));
        }),
    });

    const result = await tool.impl.execute(ctx, {}, new AbortController().signal);

    expect(result.details).toMatchObject({ outcome: 'timed_out' });
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'The advisor did not answer in time, so this consultation was stopped. Continue with your own judgement.',
    );
    // The request itself is stopped, not left running in the background.
    expect(requestSignal?.aborted).toBe(true);
    expect(recordUsage).not.toHaveBeenCalled();
  });

  it('counts model resolution against the same call limit', async () => {
    const { tool, ctx, provider } = setup({
      timeoutMs: 20,
      resolveModel: () => new Promise(() => undefined),
    });

    const result = await tool.impl.execute(ctx, {});

    expect(result.details).toMatchObject({ outcome: 'timed_out' });
    expect(provider.requests).toHaveLength(0);
  });

  it('still reports Cancelled when the user stops the Turn before the limit', async () => {
    const controller = new AbortController();
    const { tool, ctx } = setup({
      timeoutMs: 60_000,
      response: (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('Request was aborted')));
          controller.abort();
        }),
    });

    const result = await tool.impl.execute(ctx, {}, controller.signal);

    expect(result.details).toMatchObject({ outcome: 'cancelled' });
  });
});

function userSteering(pendingAtStart = false) {
  let pending = pendingAtStart;
  let wake = new AbortController();
  return {
    view: { pending: () => pending, changed: () => wake.signal },
    steer: () => {
      pending = true;
      const fired = wake;
      wake = new AbortController();
      fired.abort();
    },
  };
}

/** A main-model Turn that calls `advisor` once, then answers; returns its requests and the tool result. */
async function runAdvisorTurn(
  fixture: ReturnType<typeof setup>,
  steering: ReturnType<typeof userSteering>,
) {
  const mainRequests: Context['messages'][] = [];
  const replies = [
    final('toolUse', [{ type: 'toolCall', id: 'call-advisor', name: 'advisor', arguments: {} }]),
    final('stop', [{ type: 'text', text: 'Continuing with the new message.' }]),
  ];
  const streamFn: StreamFn = (async (_model, context) => {
    mainRequests.push(structuredClone(context.messages));
    const reply = replies[mainRequests.length - 1];
    if (!reply) throw new Error(`unexpected main request ${mainRequests.length}`);
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'start', partial: reply });
    stream.push({ type: 'done', reason: reply.stopReason as 'stop', message: reply });
    return stream;
  }) as StreamFn;
  await new PiTurnRunner().runTurn({
    sessionId: 'session-main',
    turnId: 'turn-7',
    workspaceDir: '/workspace',
    systemPrompt: 'main system prompt',
    userMessage: { text: 'Refactor the parser' },
    llm: { model: advisorModel(), streamFn },
    eventWriter: { pushRuntime: () => undefined, appendEvents: () => undefined },
    toolConfig: {
      tools: [fixture.tool as unknown as RuntimeTool],
      context: { ...fixture.ctx, userSteering: steering.view },
      disableBuiltinToolFallback: true,
    },
  });
  const toolResult = mainRequests[1]?.find((message) => message.role === 'toolResult');
  return { mainRequests, toolResult };
}

describe('advisor tool interrupted by user steering', () => {
  const STEERED_TEXT =
    'The user sent a new message, so this advisor consultation was interrupted. Read the new message and decide whether to consult the advisor again.';

  it('stops the advisor request on a user steer and lets the Turn continue without re-asking', async () => {
    const steering = userSteering();
    const fixture = setup({
      response: (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('Request was aborted')));
          steering.steer();
          if (!signal?.aborted) reject(new Error('the steer left the advisor request running'));
        }),
    });

    const turn = await runAdvisorTurn(fixture, steering);

    // The Turn continued: the main model was asked again with the interrupted result.
    expect(turn.mainRequests).toHaveLength(2);
    expect(turn.toolResult).toMatchObject({
      toolName: 'advisor',
      content: [{ type: 'text', text: STEERED_TEXT }],
      isError: false,
    });
    expect(fixture.provider.requests).toHaveLength(1);
    expect((fixture.provider.requests[0]?.options?.signal as AbortSignal).aborted).toBe(true);
    expect(fixture.recordUsage).not.toHaveBeenCalled();
  });

  it('sends no advisor request when user steering is already pending at the call', async () => {
    const fixture = setup({});

    const turn = await runAdvisorTurn(fixture, userSteering(true));

    expect(turn.mainRequests).toHaveLength(2);
    expect(turn.toolResult).toMatchObject({ content: [{ type: 'text', text: STEERED_TEXT }] });
    expect(fixture.resolveModel).not.toHaveBeenCalled();
    expect(fixture.provider.requests).toHaveLength(0);
  });
});
