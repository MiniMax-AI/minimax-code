import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
} from '@earendil-works/pi-ai';
import { ThinkingLevel } from '@mavis/protocol';
import {
  projectAgentMessagesForModel,
  type LLMRequestSettledEvent,
} from '@mavis/agent-core/pi-turn-runner';
import { createDefaultTokenEstimator } from '@mavis/context-manager';
import type { PromptReadSnapshot } from '@mavis/agent-runtime';
import { describe, expect, it, vi } from 'vitest';

import { buildLocalRequestPayloadTransform } from '../../agent-host/assembly/local-turn-payload-transform.js';
import { validateCheckpointGeneration } from '../algorithm/checkpoint-format.js';
import { CheckpointCandidateTooLargeError } from '../contracts.js';
import { buildCheckpointControl, CHECKPOINT_SYSTEM_PROMPT } from './checkpoint-prompt.js';
import { createCheckpointSession } from './checkpoint-provider.js';

describe('checkpoint Provider thinking request', () => {
  it('omits semantic reasoning for off while the M3 wire uses the disabled variant', async () => {
    const selectedModel = { ...model(), reasoning: true };
    const wirePayloads: unknown[] = [];
    const streamFn: StreamFn = vi.fn(async (calledModel, _context, options) => {
      const payload = { messages: [], output_config: { effort: 'medium' } };
      wirePayloads.push((await options?.onPayload?.(payload, calledModel)) ?? payload);
      return completedStream(
        assistant({
          content: [{ type: 'text', text: 'off handoff' }],
          usage: usage({ output: 5 }),
        }),
      );
    });
    const signal = new AbortController().signal;
    const payloadTransform = buildLocalRequestPayloadTransform(
      {
        agentConfig: {
          model: {
            thinking_level: ThinkingLevel.HIGH,
            capabilities: {
              openplatform_thinking_variants: {
                thinking: { type: 'adaptive' },
                'none-thinking': { type: 'disabled' },
              },
            },
          },
        },
        llm: { model: selectedModel, thinkingLevel: 'off' },
        sessionId: 'session-thinking-off',
        signal,
      },
      {},
    );
    const session = await createCheckpointSession({
      model: selectedModel,
      streamFn,
      thinkingLevel: 'off',
      maxOutputTokens: 321,
      providerInputLimit: selectedModel.contextWindow,
      payloadTransform,
    });

    await expect(session.generate({ messages: [user('context', 1)], signal })).resolves.toEqual({
      text: 'off handoff',
      stopReason: 'stop',
      outputTokens: 5,
      responseContentKinds: ['text'],
    });
    expect(vi.mocked(streamFn).mock.calls[0]?.[2]?.reasoning).toBeUndefined();
    expect(wirePayloads).toEqual([{ messages: [], thinking: { type: 'disabled' } }]);
  });

  it('uses resolved M3 thinking through the production payload transform and keeps only checkpoint text', async () => {
    const selectedModel = { ...model(), reasoning: true };
    const final = assistant({
      content: [
        { type: 'thinking', thinking: 'private checkpoint reasoning' },
        { type: 'text', text: 'durable handoff' },
      ],
      usage: usage({ output: 17 }),
    });
    const wirePayloads: unknown[] = [];
    const streamFn: StreamFn = vi.fn(async (calledModel, context, options) => {
      const payload = {
        model: calledModel.id,
        messages: context.messages,
        output_config: { effort: 'medium' },
      };
      wirePayloads.push((await options?.onPayload?.(payload, calledModel)) ?? payload);
      return completedStream(final);
    });
    const signal = new AbortController().signal;
    const payloadTransform = buildLocalRequestPayloadTransform(
      {
        agentConfig: {
          model: {
            thinking_level: ThinkingLevel.OFF,
            capabilities: {
              openplatform_thinking_variants: {
                thinking: { type: 'adaptive' },
                'none-thinking': { type: 'disabled' },
              },
            },
          },
        },
        llm: { model: selectedModel, thinkingLevel: 'medium' },
        sessionId: 'session-thinking',
        signal,
      },
      {},
    );
    const session = await createCheckpointSession({
      model: selectedModel,
      streamFn,
      thinkingLevel: 'medium',
      maxOutputTokens: 321,
      providerInputLimit: selectedModel.contextWindow,
      payloadTransform,
    });

    const generation = await session.generate({
      messages: [user('context', 1)],
      signal,
    });

    expect(validateCheckpointGeneration(generation, 321)).toEqual({
      summary: 'durable handoff',
      schemaStatus: 'soft_fallback',
    });
    expect(generation).toEqual({
      text: 'durable handoff',
      stopReason: 'stop',
      outputTokens: 17,
      responseContentKinds: ['thinking', 'text'],
    });
    expect(wirePayloads).toEqual([
      {
        model: 'selected-model',
        messages: expect.any(Array),
        thinking: { type: 'adaptive' },
      },
    ]);
    expect(vi.mocked(streamFn).mock.calls[0]?.[2]?.reasoning).toBe('medium');
  });
});

describe('checkpoint Provider request', () => {
  it('reports the raw Provider usage when no retry wrapper is present', async () => {
    const settled: LLMRequestSettledEvent[] = [];
    const final = assistant({
      usage: usage({ input: 17, output: 3, cacheRead: 5, cacheWrite: 7 }),
    });
    const session = await createCheckpointSession({
      model: model(),
      streamFn: vi.fn(() => completedStream(final)),
      thinkingLevel: 'off',
      maxOutputTokens: 321,
      providerInputLimit: 128_000,
      onRequestSettled: (event) => settled.push(event),
    });

    await session.generate({ messages: [user('context', 1)] });

    expect(settled).toEqual([
      {
        requestAttempt: 1,
        outcome: 'success',
        usage: { input: 17, output: 3, cacheRead: 5, cacheWrite: 7 },
        usageComplete: true,
      },
    ]);
  });

  it('fits the complete projected checkpoint request against the explicit input limit and byte cap', async () => {
    const messages = [user('Preserve the request.', 1)];
    const instructions = 'Preserve exact identifiers.';
    const projected = projectAgentMessagesForModel(messages, model()).messages;
    const control = user(buildCheckpointControl(instructions), 1);
    const requestContext = {
      systemPrompt: CHECKPOINT_SYSTEM_PROMPT,
      messages: [...projected, control],
    };
    const estimator = createDefaultTokenEstimator();
    const estimatedTokens =
      estimator.estimateTextTokens(CHECKPOINT_SYSTEM_PROMPT) +
      estimator.estimateMessages(requestContext.messages);
    const serializedBytes = Buffer.byteLength(JSON.stringify(requestContext), 'utf8');
    const contextWindow = estimatedTokens + 1_000;
    const selectedModel = model(contextWindow);

    expect(
      (
        await createCheckpointSession({
          model: selectedModel,
          streamFn: vi.fn(),
          thinkingLevel: 'off',
          maxOutputTokens: 0,
          providerInputLimit: estimatedTokens,
          maxSerializedInputBytes: serializedBytes,
        })
      ).fits({ messages, instructions }),
    ).toBe(true);
    expect(
      (
        await createCheckpointSession({
          model: selectedModel,
          streamFn: vi.fn(),
          thinkingLevel: 'off',
          maxOutputTokens: 0,
          providerInputLimit: estimatedTokens - 1,
          maxSerializedInputBytes: serializedBytes,
        })
      ).fits({ messages, instructions }),
    ).toBe(false);
    expect(
      (
        await createCheckpointSession({
          model: selectedModel,
          streamFn: vi.fn(),
          thinkingLevel: 'off',
          maxOutputTokens: contextWindow - estimatedTokens + 1,
          providerInputLimit: estimatedTokens,
          maxSerializedInputBytes: serializedBytes,
        })
      ).fits({ messages, instructions }),
    ).toBe(true);
    expect(
      (
        await createCheckpointSession({
          model: selectedModel,
          streamFn: vi.fn(),
          thinkingLevel: 'off',
          maxOutputTokens: 0,
          providerInputLimit: estimatedTokens,
          maxSerializedInputBytes: serializedBytes - 1,
        })
      ).fits({ messages, instructions }),
    ).toBe(false);
  });
});

describe('checkpoint Provider prompt selection and delivery', () => {
  it('uses the builtin checkpoint template for the whole request after a remote read fails', async () => {
    const remote = {} as PromptReadSnapshot;
    const builtin = {} as PromptReadSnapshot;
    const streamFn: StreamFn = vi.fn(() => completedStream(assistant({ content: [] })));
    const promptSnapshots = {
      capture: vi.fn(async () => remote),
      captureBuiltin: vi.fn(async () => builtin),
      read: vi.fn(async (snapshot: PromptReadSnapshot) =>
        snapshot === remote
          ? { kind: 'invalid' as const }
          : { kind: 'found' as const, content: 'builtin checkpoint prompt' },
      ),
    };
    const session = await createCheckpointSession({
      model: model(),
      streamFn,
      thinkingLevel: 'off',
      maxOutputTokens: 321,
      providerInputLimit: 128_000,
      promptSnapshots,
    });

    await session.generate({ messages: [user('context', 1)] });

    expect(vi.mocked(streamFn).mock.calls[0]?.[1]?.systemPrompt).toBe('builtin checkpoint prompt');
    expect(promptSnapshots.capture).toHaveBeenCalledOnce();
    expect(promptSnapshots.captureBuiltin).toHaveBeenCalledOnce();
  });

  it('uses one captured managed template for both fits and generate', async () => {
    const snapshot = {} as PromptReadSnapshot;
    const systemPrompt = `${CHECKPOINT_SYSTEM_PROMPT}\nmanaged extension`;
    const messages = [user('Preserve the request.', 1)];
    const requestContext = {
      systemPrompt,
      messages: [
        ...projectAgentMessagesForModel(messages, model()).messages,
        user(buildCheckpointControl(), 1),
      ],
    };
    const streamFn: StreamFn = vi.fn(() => completedStream(assistant({ content: [] })));
    const promptSnapshots = {
      capture: vi.fn(async () => snapshot),
      captureBuiltin: vi.fn(async () => snapshot),
      read: vi.fn(async () => ({ kind: 'found' as const, content: systemPrompt })),
    };
    const session = await createCheckpointSession({
      model: model(),
      streamFn,
      thinkingLevel: 'off',
      maxOutputTokens: 0,
      providerInputLimit: 128_000,
      maxSerializedInputBytes: Buffer.byteLength(JSON.stringify(requestContext), 'utf8'),
      promptSnapshots,
    });

    expect(session.fits({ messages })).toBe(true);
    await session.generate({ messages });

    expect(vi.mocked(streamFn).mock.calls[0]?.[1]?.systemPrompt).toBe(systemPrompt);
    expect(promptSnapshots.capture).toHaveBeenCalledOnce();
    expect(promptSnapshots.read).toHaveBeenCalledOnce();
  });

  it('uses the selected model and shared target projection in an isolated request', async () => {
    const selectedModel = model();
    const controller = new AbortController();
    const final = assistant({
      content: [
        { type: 'text', text: '## Goal\none' },
        { type: 'text', text: '\n## Constraints & Preferences\ntwo' },
      ],
      usage: usage({ output: 87 }),
    });
    const streamFn: StreamFn = vi.fn(() => completedStream(final));
    const payloadTransform = vi.fn((payload: unknown) => payload);
    const session = await createCheckpointSession({
      model: selectedModel,
      streamFn,
      thinkingLevel: 'off',
      maxOutputTokens: 321,
      providerInputLimit: selectedModel.contextWindow,
      apiKey: 'provider-key',
      headers: { 'x-provider-route': 'route-a' },
      payloadTransform,
    });
    const h0 = [
      Object.assign(user('Preserve this request.', 1), {
        genuineUserQueryText: 'display-only provenance',
        canonicalTextRange: { startOffset: 0, endOffset: 8 },
      }),
      assistant({
        provider: 'source-provider',
        model: 'source-model',
        timestamp: 2,
        content: [{ type: 'thinking', thinking: 'visible old reasoning' }],
      }),
    ] as AgentMessage[];
    const originalH0 = structuredClone(h0);

    await expect(
      session.generate({
        messages: h0,
        instructions: ' Preserve identifiers. ',
        signal: controller.signal,
      }),
    ).resolves.toEqual({
      text: '## Goal\none\n## Constraints & Preferences\ntwo',
      stopReason: 'stop',
      outputTokens: 87,
      responseContentKinds: ['text'],
    });

    expect(h0).toEqual(originalH0);
    expect(streamFn).toHaveBeenCalledOnce();
    const [calledModel, context, options] = vi.mocked(streamFn).mock.calls[0] ?? [];
    expect(calledModel).toBe(selectedModel);
    expect(context).toMatchObject({
      systemPrompt: CHECKPOINT_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'Preserve this request.' }],
          timestamp: 1,
        },
        {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: '<|prior-thinking|>\nvisible old reasoning\n<|/prior-thinking|>',
            },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: buildCheckpointControl(' Preserve identifiers. ') }],
          timestamp: 2,
        },
      ],
    });
    expect(context).not.toHaveProperty('tools');
    expect(context?.messages[0]).not.toHaveProperty('genuineUserQueryText');
    expect(context?.messages[0]).not.toHaveProperty('canonicalTextRange');
    expect(options).toEqual({
      apiKey: 'provider-key',
      headers: { 'x-provider-route': 'route-a' },
      reasoning: undefined,
      maxTokens: 321,
      signal: controller.signal,
      onPayload: payloadTransform,
    });
  });

  it('returns bounded deduplicated kinds for thinking, tool-call, and unknown output', async () => {
    const final = assistant({
      stopReason: 'toolUse',
      content: [
        { type: 'thinking', thinking: 'new private reasoning' },
        { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: '/tmp' } },
        { type: 'thinking', thinking: 'more private reasoning' },
        { type: 'future-block' } as never,
        { type: 'toolCall', id: 'read-2', name: 'read', arguments: { path: '/var' } },
      ],
    });
    const session = await createCheckpointSession({
      model: model(),
      streamFn: vi.fn(() => completedStream(final)),
      thinkingLevel: 'off',
      maxOutputTokens: 321,
      providerInputLimit: 128_000,
    });

    await expect(session.generate({ messages: [user('context', 1)] })).resolves.toEqual({
      text: '',
      stopReason: 'toolUse',
      outputTokens: 0,
      responseContentKinds: ['thinking', 'toolCall', 'unknown'],
    });
  });
});

describe('checkpoint Provider overflow normalization', () => {
  it.each([
    [
      'explicit error message',
      assistant({
        stopReason: 'error',
        errorMessage:
          "Requested token count exceeds the model's maximum context length of 100 tokens",
      }),
    ],
    [
      'silent usage overflow',
      assistant({ stopReason: 'stop', usage: usage({ input: 101, totalTokens: 101 }) }),
    ],
    [
      'zero-output length overflow',
      assistant({ stopReason: 'length', usage: usage({ input: 99, output: 0, totalTokens: 99 }) }),
    ],
  ])('maps %s using the target model context window', async (_case, final) => {
    const session = await createCheckpointSession({
      model: model(100),
      streamFn: vi.fn(() => completedStream(final)),
      thinkingLevel: 'off',
      maxOutputTokens: 20,
      providerInputLimit: 100,
    });

    await expect(
      session.generate({ messages: [user('oversized context', 1)] }),
    ).rejects.toMatchObject({ name: 'CheckpointCandidateTooLargeError', reason: 'input_overflow' });
  });

  it('maps explicit thrown overflow codes and preserves auth, cancel, and ordinary errors', async () => {
    const overflows = [
      Object.assign(new Error('request rejected'), { code: 'context_length_exceeded' }),
      Object.assign(new Error('payload too large'), { status: 413 }),
      Object.assign(new Error('payload too large'), { statusCode: 413 }),
    ];
    const preserved = [
      Object.assign(new Error('invalid API key'), { code: 'invalid_api_key' }),
      Object.assign(new Error('rate limited'), { status: 429 }),
      new DOMException('cancelled', 'AbortError'),
      new Error('ordinary provider failure'),
    ];
    const input = { messages: [user('context', 1)] };

    for (const overflow of overflows) {
      await expect(
        (
          await createCheckpointSession({
            model: model(),
            thinkingLevel: 'off',
            maxOutputTokens: 20,
            providerInputLimit: 128_000,
            streamFn: vi.fn(() => {
              throw overflow;
            }),
          })
        ).generate(input),
      ).rejects.toBeInstanceOf(CheckpointCandidateTooLargeError);
    }

    for (const error of preserved) {
      await expect(
        (
          await createCheckpointSession({
            model: model(),
            thinkingLevel: 'off',
            maxOutputTokens: 20,
            providerInputLimit: 128_000,
            streamFn: vi.fn(() => {
              throw error;
            }),
          })
        ).generate(input),
      ).rejects.toBe(error);
    }
  });

  it('does not misclassify a rate-limit error that mentions tokens', async () => {
    const final = assistant({
      stopReason: 'error',
      errorMessage: 'Rate limit: too many tokens; retry later',
    });
    const session = await createCheckpointSession({
      model: model(100),
      streamFn: vi.fn(() => completedStream(final)),
      thinkingLevel: 'off',
      maxOutputTokens: 20,
      providerInputLimit: 100,
    });

    await expect(session.generate({ messages: [user('context', 1)] })).resolves.toMatchObject({
      stopReason: 'error',
    });
  });
});

describe('checkpoint Provider output exhaustion', () => {
  it.each([
    ['thinking only', [{ type: 'thinking' as const, thinking: 'private reasoning' }]],
    [
      'thinking plus blank text',
      [
        { type: 'thinking' as const, thinking: 'private reasoning' },
        { type: 'text' as const, text: ' \n\t ' },
      ],
    ],
  ])(
    'normalizes a length stop with %s to a candidate-too-large advance',
    async (_case, content) => {
      const final = assistant({
        stopReason: 'length',
        content,
        usage: usage({ input: 50, output: 20, totalTokens: 70 }),
      });
      const onGenerated = vi.fn();
      const session = await createCheckpointSession({
        model: model(),
        streamFn: vi.fn(() => completedStream(final)),
        thinkingLevel: 'off',
        maxOutputTokens: 20,
        providerInputLimit: 128_000,
        onGenerated,
      });

      const rejection = await session
        .generate({ messages: [user('context', 1)] })
        .catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(CheckpointCandidateTooLargeError);
      expect(rejection).toMatchObject({ reason: 'output_exhausted', cause: final });
      expect(onGenerated).toHaveBeenCalledWith(
        expect.objectContaining({ stopReason: 'length', outputTokens: 20 }),
      );
    },
  );

  it.each([
    [
      'length with checkpoint text',
      assistant({
        stopReason: 'length',
        content: [
          { type: 'thinking', thinking: 'private reasoning' },
          { type: 'text', text: '## Goal\npartial' },
        ],
        usage: usage({ input: 50, output: 20, totalTokens: 70 }),
      }),
    ],
    [
      'stop with thinking only',
      assistant({
        stopReason: 'stop',
        content: [{ type: 'thinking', thinking: 'private reasoning' }],
        usage: usage({ input: 50, output: 5, totalTokens: 55 }),
      }),
    ],
    ['Provider error', assistant({ stopReason: 'error', errorMessage: 'upstream unavailable' })],
  ])('returns %s unchanged for the existing validation', async (_case, final) => {
    const session = await createCheckpointSession({
      model: model(),
      streamFn: vi.fn(() => completedStream(final)),
      thinkingLevel: 'off',
      maxOutputTokens: 20,
      providerInputLimit: 128_000,
    });

    await expect(session.generate({ messages: [user('context', 1)] })).resolves.toMatchObject({
      stopReason: final.stopReason,
    });
  });
});

function model(contextWindow = 128_000): Parameters<StreamFn>[0] {
  return {
    id: 'selected-model',
    name: 'Selected Model',
    api: 'anthropic-messages',
    provider: 'test',
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 4_096,
  };
}

function user(text: string, timestamp: number): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }], timestamp };
}

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'anthropic-messages',
    provider: 'test',
    model: 'selected-model',
    usage: usage(),
    stopReason: 'stop',
    timestamp: 2,
    ...overrides,
  };
}

function usage(overrides: Partial<AssistantMessage['usage']> = {}): AssistantMessage['usage'] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...overrides,
  };
}

function completedStream(final: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'done', reason: 'stop', message: final });
  return stream;
}
