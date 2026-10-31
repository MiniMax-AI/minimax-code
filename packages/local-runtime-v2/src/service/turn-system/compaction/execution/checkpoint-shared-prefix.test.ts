import { Buffer } from 'node:buffer';
import { crc32, deflateSync } from 'node:zlib';

import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  streamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type Tool,
} from '@earendil-works/pi-ai';
import {
  projectAgentMessagesForModel,
  type PiBeforeLlmCallHookInput,
} from '@mavis/agent-core/pi-turn-runner';
import { describe, expect, it, vi } from 'vitest';

import { CHECKPOINT_SYSTEM_PROMPT } from './checkpoint-prompt.js';
import { createRequestMediaGuardHook } from '../automatic-context-compactor.js';
import { createCheckpointSession } from './checkpoint-provider.js';
import {
  resolveCheckpointSharedPrefix,
  type CheckpointSharedPrefix,
} from './checkpoint-shared-prefix.js';

const SESSION_ID = 'mvs_shared_prefix_session';
/** A Messages API model id the runtime treats as prefix-cached. */
const PREFIX_CACHED_MODEL_ID = '\x63\x6c\x61\x75\x64\x65-5-5';
const MAIN_SYSTEM_PROMPT = 'You are the main coding agent. Use tools to inspect the repository.';
const MAIN_TOOLS: Tool[] = [
  {
    name: 'read',
    description: 'Read a file from the workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    } as unknown as Tool['parameters'],
  },
  {
    name: 'bash',
    description: 'Run a shell command.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    } as unknown as Tool['parameters'],
  },
];

/** Wire key of the message array and the per-request output cap for each Provider API. */
const WIRE = {
  'anthropic-messages': { messages: 'messages', outputCap: 'max_tokens', reasoning: true },
  'openai-completions': {
    messages: 'messages',
    outputCap: 'max_completion_tokens',
    reasoning: false,
  },
  'openai-responses': { messages: 'input', outputCap: 'max_output_tokens', reasoning: false },
} as const;

describe('shared-prefix checkpoint request', () => {
  it.each(Object.keys(WIRE) as (keyof typeof WIRE)[])(
    'repeats the %s main request byte for byte before the checkpoint control',
    async (api) => {
      const selected = model(api, WIRE[api].reasoning);
      // The main request whose prefix the Provider cached; compaction then sees
      // one more settled tool round on top of it.
      const mainHistory = conversation(selected, 1);
      await expectSharedPrefixRepeatsMain({
        api,
        selected,
        mainRequestMessages: mainHistory,
        compactionHistory: [...mainHistory, ...toolRound(selected, 2, 'bash', 'pnpm test')],
        thinkingLevel: WIRE[api].reasoning ? 'medium' : 'off',
      });
    },
  );

  it.each(Object.keys(WIRE) as (keyof typeof WIRE)[])(
    'repeats the %s main request image placeholders from the request media guard',
    async (api) => {
      const selected: Model<Api> = {
        ...model(api, false),
        input: ['text', 'image'],
        maxImagesPerRequest: 4,
      } as Model<Api>;
      // Six attached screenshots against a four-image limit: the guard drops
      // the oldest three, the model projection alone would drop only two.
      const mainHistory = screenshotConversation(selected, 6);
      const guard = await createRequestMediaGuardHook()({
        sessionId: SESSION_ID,
        turnId: 'turn-media',
        phase: 'iteration',
        messages: mainHistory,
        canonicalMessages: mainHistory,
        model: selected,
        thinkingLevel: 'off',
      } satisfies PiBeforeLlmCallHookInput);
      if (guard?.type !== 'replaceRequestMessages') throw new Error('Expected the media guard.');

      await expectSharedPrefixRepeatsMain({
        api,
        selected,
        mainRequestMessages: guard.messages,
        compactionHistory: [...mainHistory, ...toolRound(selected, 20, 'bash', 'pnpm test')],
        thinkingLevel: 'off',
      });
    },
  );

  it('keeps thinking and every image in the shared request of a prefix-cached model', async () => {
    const selected: Model<Api> = {
      ...model('anthropic-messages', true),
      id: PREFIX_CACHED_MODEL_ID,
      input: ['text', 'image'],
      maxImagesPerRequest: 4,
    } as Model<Api>;
    // Six screenshots over a four-image limit: prefix-cached models keep them all
    // in the main request (guard and model projection both skip), and the main
    // history carries signed thinking.
    const mainHistory = [...thinkingConversation(selected), ...screenshotConversation(selected, 6)];
    const guard = await createRequestMediaGuardHook()({
      sessionId: SESSION_ID,
      turnId: 'turn-prefix-cached',
      phase: 'iteration',
      messages: mainHistory,
      canonicalMessages: mainHistory,
      model: selected,
      thinkingLevel: 'medium',
    } satisfies PiBeforeLlmCallHookInput);
    expect(guard).toEqual({ type: 'continue' });

    const checkpoint = await expectSharedPrefixRepeatsMain({
      api: 'anthropic-messages',
      selected,
      mainRequestMessages: mainHistory,
      compactionHistory: [...mainHistory, ...toolRound(selected, 40, 'bash', 'pnpm test')],
      thinkingLevel: 'medium',
    });
    expect(JSON.stringify(checkpoint)).toContain('"type":"thinking"');
    expect(JSON.stringify(checkpoint).match(/"type":"image"/gu)).toHaveLength(6);
  });

  it('strips thinking only from the isolated request of a prefix-cached model', async () => {
    const selected = { ...model('anthropic-messages', true), id: PREFIX_CACHED_MODEL_ID };
    const history = thinkingConversation(selected);
    const send = async (prefix: CheckpointSharedPrefix | undefined) => {
      const requests: CapturedRequest[] = [];
      const session = await createCheckpointSession({
        model: selected,
        streamFn: scriptedStream(requests, [
          assistant({ content: [{ type: 'text', text: 'handoff' }] }),
        ]),
        thinkingLevel: 'medium',
        maxOutputTokens: 8_000,
        providerInputLimit: 128_000,
        ...(prefix ? { sharedPrefix: prefix } : {}),
      });
      await session.generate({ messages: history });
      return JSON.stringify(requests[0]?.context.messages);
    };

    expect(await send(sharedPrefix(selected))).toContain('"type":"thinking"');
    expect(await send(undefined)).not.toContain('"type":"thinking"');
  });

  it('re-sends the same candidate in the isolated shape when the model calls a tool', async () => {
    const requests: CapturedRequest[] = [];
    const onGenerated = vi.fn();
    const onSharedPrefixFallback = vi.fn();
    const session = await createCheckpointSession({
      model: model('anthropic-messages', false),
      streamFn: scriptedStream(requests, [
        assistant({
          stopReason: 'toolUse',
          content: [{ type: 'toolCall', id: 'toolu_x', name: 'read', arguments: { path: 'a' } }],
        }),
        assistant({ content: [{ type: 'text', text: 'isolated handoff' }] }),
      ]),
      thinkingLevel: 'off',
      maxOutputTokens: 1_000,
      providerInputLimit: 128_000,
      sharedPrefix: sharedPrefix(model('anthropic-messages', false)),
      onGenerated,
      onSharedPrefixFallback,
    });

    await expect(session.generate({ messages: [user('context', 1)] })).resolves.toMatchObject({
      text: 'isolated handoff',
    });

    expect(requests.map(requestShape)).toEqual(['shared_prefix', 'isolated']);
    expect(requests[1]?.options?.sessionId).toBeUndefined();
    expect(onSharedPrefixFallback).toHaveBeenCalledWith('tool_call');
    expect(onGenerated.mock.calls.map(([, shape]) => shape)).toEqual(['shared_prefix', 'isolated']);
  });

  it('re-sends the same candidate in the isolated shape when the Provider rejects its size', async () => {
    const requests: CapturedRequest[] = [];
    const onSharedPrefixFallback = vi.fn();
    const session = await createCheckpointSession({
      model: model('anthropic-messages', false),
      streamFn: scriptedStream(requests, [
        Object.assign(new Error('prompt is too long'), { status: 413 }),
        assistant({ content: [{ type: 'text', text: 'isolated handoff' }] }),
      ]),
      thinkingLevel: 'off',
      maxOutputTokens: 1_000,
      providerInputLimit: 128_000,
      sharedPrefix: sharedPrefix(model('anthropic-messages', false)),
      onSharedPrefixFallback,
    });

    await expect(session.generate({ messages: [user('context', 1)] })).resolves.toMatchObject({
      text: 'isolated handoff',
    });
    expect(requests.map(requestShape)).toEqual(['shared_prefix', 'isolated']);
    expect(onSharedPrefixFallback).toHaveBeenCalledWith('input_overflow');
  });

  it('sends only the isolated shape when the shared prefix does not fit locally', async () => {
    const requests: CapturedRequest[] = [];
    const onSharedPrefixFallback = vi.fn();
    const bulkyPrefix = sharedPrefix(
      model('anthropic-messages', false),
      'main system prompt '.repeat(4_000),
    );
    const session = await createCheckpointSession({
      model: model('anthropic-messages', false),
      streamFn: scriptedStream(requests, [
        assistant({ content: [{ type: 'text', text: 'isolated handoff' }] }),
      ]),
      thinkingLevel: 'off',
      maxOutputTokens: 1_000,
      providerInputLimit: 4_000,
      sharedPrefix: bulkyPrefix,
      onSharedPrefixFallback,
    });

    expect(session.fits({ messages: [user('context', 1)] })).toBe(true);
    await expect(session.generate({ messages: [user('context', 1)] })).resolves.toMatchObject({
      text: 'isolated handoff',
    });
    expect(requests.map(requestShape)).toEqual(['isolated']);
    expect(onSharedPrefixFallback).not.toHaveBeenCalled();
  });

  it('keeps a shared-prefix checkpoint without re-sending it', async () => {
    const requests: CapturedRequest[] = [];
    const session = await createCheckpointSession({
      model: model('anthropic-messages', false),
      streamFn: scriptedStream(requests, [
        assistant({ content: [{ type: 'text', text: 'shared handoff' }] }),
      ]),
      thinkingLevel: 'off',
      maxOutputTokens: 1_000,
      providerInputLimit: 128_000,
      sharedPrefix: sharedPrefix(model('anthropic-messages', false)),
    });

    await expect(
      session.generate({ messages: [user('context', 1)], instructions: 'focus on tests' }),
    ).resolves.toMatchObject({ text: 'shared handoff' });

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.context.systemPrompt).toBe(MAIN_SYSTEM_PROMPT);
    expect(request?.context.tools).toEqual(MAIN_TOOLS);
    expect(request?.options?.sessionId).toBe(SESSION_ID);
    const control = JSON.stringify(request?.context.messages.at(-1));
    expect(control).toContain('Do NOT call any tools');
    expect(control).toContain('focus on tests');
  });
});

describe('shared-prefix checkpoint gateway size rejection', () => {
  // A gateway relaying Bedrock reports the size rejection as a stream error
  // with only `Input is too long.`, which Pi's overflow patterns miss.
  it('re-sends the isolated shape when a gateway reports the size rejection as a stream error', async () => {
    const requests: CapturedRequest[] = [];
    const onSharedPrefixFallback = vi.fn();
    const session = await createCheckpointSession({
      model: model('anthropic-messages', false),
      streamFn: scriptedStream(requests, [
        assistant({
          stopReason: 'error',
          errorMessage:
            '{"type":"error","error":{"type":"api_error","message":"received error while streaming: StatusCode: 400, ValidationException: Input is too long."}}',
        }),
        assistant({ content: [{ type: 'text', text: 'isolated handoff' }] }),
      ]),
      thinkingLevel: 'off',
      maxOutputTokens: 1_000,
      providerInputLimit: 128_000,
      sharedPrefix: sharedPrefix(model('anthropic-messages', false)),
      onSharedPrefixFallback,
    });

    await expect(session.generate({ messages: [user('context', 1)] })).resolves.toMatchObject({
      text: 'isolated handoff',
    });
    expect(requests.map(requestShape)).toEqual(['shared_prefix', 'isolated']);
    expect(onSharedPrefixFallback).toHaveBeenCalledWith('input_overflow');
  });
});

async function expectSharedPrefixRepeatsMain(input: {
  readonly api: keyof typeof WIRE;
  readonly selected: Model<Api>;
  /** What the main request sent after its request-only hooks. */
  readonly mainRequestMessages: readonly AgentMessage[];
  readonly compactionHistory: readonly AgentMessage[];
  readonly thinkingLevel: 'off' | 'medium';
}): Promise<unknown[]> {
  const { api, selected, thinkingLevel } = input;
  const mainPayload = await capturePayload((onPayload) =>
    streamSimple(
      selected,
      {
        systemPrompt: MAIN_SYSTEM_PROMPT,
        messages: projectAgentMessagesForModel(input.mainRequestMessages, selected).messages,
        tools: MAIN_TOOLS,
      },
      {
        apiKey: 'test-key',
        sessionId: SESSION_ID,
        maxTokens: 32_000,
        ...(thinkingLevel === 'off' ? {} : { reasoning: thinkingLevel }),
        onPayload,
      },
    ),
  );
  const checkpointPayloads: unknown[] = [];
  const session = await createCheckpointSession({
    model: selected,
    apiKey: 'test-key',
    streamFn: (calledModel, context, options) =>
      streamSimple(calledModel, context, {
        ...options,
        onPayload: (payload) => {
          checkpointPayloads.push(payload);
          throw new Error('payload captured');
        },
      }),
    thinkingLevel,
    maxOutputTokens: 8_000,
    providerInputLimit: selected.contextWindow,
    sharedPrefix: sharedPrefix(selected),
  });

  await session.generate({ messages: input.compactionHistory });

  expect(checkpointPayloads).toHaveLength(1);
  const main = withoutCacheMarkers(mainPayload) as Record<string, unknown>;
  const checkpoint = withoutCacheMarkers(checkpointPayloads[0]) as Record<string, unknown>;
  const { messages: messagesKey, outputCap } = WIRE[api];
  const mainMessages = main[messagesKey] as unknown[];
  const checkpointMessages = checkpoint[messagesKey] as unknown[];
  // Everything that keys the Provider cache except the growing message tail:
  // model, system, tools, thinking, cache key.
  expect(omit(checkpoint, messagesKey, outputCap)).toEqual(omit(main, messagesKey, outputCap));
  expect(checkpointMessages.slice(0, mainMessages.length)).toEqual(mainMessages);
  expect(checkpointMessages.length).toBeGreaterThan(mainMessages.length);
  expect(JSON.stringify(checkpointMessages.at(-1))).toContain('<checkpoint-protocol>');
  return checkpointMessages;
}

function sharedPrefix(
  selected: Model<Api>,
  systemPrompt = MAIN_SYSTEM_PROMPT,
): CheckpointSharedPrefix {
  const prefix = resolveCheckpointSharedPrefix({
    sessionId: SESSION_ID,
    model: selected,
    checkpointRequestShape: 'shared_prefix',
    systemPrompt,
    tools: MAIN_TOOLS,
  });
  if (!prefix) throw new Error('Expected a shared prefix.');
  return prefix;
}

interface CapturedRequest {
  readonly context: Parameters<StreamFn>[1];
  readonly options: Parameters<StreamFn>[2];
}

function requestShape(request: CapturedRequest): 'shared_prefix' | 'isolated' {
  return request.context.systemPrompt === CHECKPOINT_SYSTEM_PROMPT &&
    request.context.tools === undefined
    ? 'isolated'
    : 'shared_prefix';
}

function scriptedStream(
  requests: CapturedRequest[],
  responses: readonly (AssistantMessage | Error)[],
): StreamFn {
  let index = 0;
  return vi.fn(async (_model, context, options) => {
    requests.push({ context, options });
    const response = responses[index++];
    if (!response) throw new Error('unexpected checkpoint request');
    if (response instanceof Error) throw response;
    return completedStream(response);
  });
}

async function capturePayload(
  send: (onPayload: (payload: unknown) => never) => AssistantMessageEventStream,
): Promise<unknown> {
  let captured: unknown;
  await send((payload) => {
    captured = payload;
    throw new Error('payload captured');
  }).result();
  if (captured === undefined) throw new Error('Provider did not build a payload.');
  return captured;
}

/** Breakpoint placement moves with the tail; it is not part of the cached prefix. */
function withoutCacheMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCacheMarkers);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'cache_control')
      .map(([key, entry]) => [key, withoutCacheMarkers(entry)]),
  );
}

function omit(value: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

function conversation(selected: Model<Api>, startAt: number): AgentMessage[] {
  return [
    user('Fix the failing parser test.', startAt),
    ...toolRound(selected, startAt + 1, 'read', 'src/parser.ts'),
    assistantFor(selected, startAt + 3, [
      { type: 'text', text: 'The parser drops trailing commas.' },
    ]),
    user('Please apply the fix.', startAt + 4),
  ];
}

function toolRound(
  selected: Model<Api>,
  timestamp: number,
  name: 'read' | 'bash',
  argument: string,
): AgentMessage[] {
  const id = `toolu_${name}_${timestamp}`;
  return [
    assistantFor(selected, timestamp, [
      {
        type: 'toolCall',
        id,
        name,
        arguments: name === 'read' ? { path: argument } : { command: argument },
      },
    ]),
    {
      role: 'toolResult',
      toolCallId: id,
      toolName: name,
      content: [{ type: 'text', text: `${name} output for ${argument}` }],
      isError: false,
      timestamp: timestamp + 1,
    },
  ];
}

function assistantFor(
  selected: Model<Api>,
  timestamp: number,
  content: AssistantMessage['content'],
): AgentMessage {
  return assistant({
    api: selected.api,
    provider: selected.provider,
    model: selected.id,
    stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
    content,
    timestamp,
  });
}

function thinkingConversation(selected: Model<Api>): AgentMessage[] {
  return [
    user('Fix the failing parser test.', 1),
    assistantFor(selected, 2, [
      {
        type: 'thinking',
        thinking: 'The parser test fails on commas.',
        thinkingSignature: 'sig-1',
      },
      { type: 'toolCall', id: 'toolu_read_2', name: 'read', arguments: { path: 'src/parser.ts' } },
    ]),
    {
      role: 'toolResult',
      toolCallId: 'toolu_read_2',
      toolName: 'read',
      content: [{ type: 'text', text: 'parser source' }],
      isError: false,
      timestamp: 3,
    },
    assistantFor(selected, 4, [
      {
        type: 'thinking',
        thinking: 'Trailing comma keeps an empty item.',
        thinkingSignature: 'sig-2',
      },
      { type: 'text', text: 'The parser drops trailing commas.' },
    ]),
    user('Please apply the fix.', 5),
  ];
}

function screenshotConversation(selected: Model<Api>, count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, index) => [
    {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: `Screenshot ${index + 1} of the broken layout.` },
        { type: 'image' as const, data: greyPng(16 + index, 16), mimeType: 'image/png' },
      ],
      timestamp: index * 2 + 1,
    },
    assistantFor(selected, index * 2 + 2, [
      { type: 'text', text: `Noted screenshot ${index + 1}.` },
    ]),
  ]).flat();
}

function greyPng(width: number, height: number): string {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(typed));
    return Buffer.concat([length, typed, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x80)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

function model(api: keyof typeof WIRE, reasoning: boolean): Model<Api> {
  return {
    id: 'byok-model',
    name: 'BYOK Model',
    api,
    provider: 'custom_provider:test',
    baseUrl: 'https://example.invalid/v1',
    reasoning,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
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
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 2,
    ...overrides,
  };
}

function completedStream(final: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'done', reason: 'stop', message: final });
  return stream;
}
