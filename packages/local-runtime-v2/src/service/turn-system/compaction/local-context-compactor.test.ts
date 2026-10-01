import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core';
import {
  createAssistantMessageEventStream,
  streamSimple,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
} from '@earendil-works/pi-ai';
import { wrapInternalContext } from '@mavis/goal';
import { describe, expect, it, vi } from 'vitest';

import { buildLocalRequestPayloadTransform } from '../agent-host/assembly/local-turn-payload-transform.js';
import { buildCheckpointMessage } from './algorithm/checkpoint-format.js';
import { readCompactionCompatibility } from './compat.js';
import { buildCheckpointControl } from './execution/checkpoint-prompt.js';
import { createLocalContextFootprintMeasurer } from './execution/local-context-footprint.js';
import { LocalContextCompactor } from './local-context-compactor.js';

type LocalCompactorConstructorArgs = ConstructorParameters<typeof LocalContextCompactor>;

function localCompactor(
  checkpointState: LocalCompactorConstructorArgs[0] = undefined,
  logger: LocalCompactorConstructorArgs[1] = undefined,
  promptSnapshots: LocalCompactorConstructorArgs[2] = undefined,
) {
  return new LocalContextCompactor(checkpointState, logger, promptSnapshots);
}

describe('LocalContextCompactor', () => {
  it('bypasses trigger and filtering, then checkpoints full H0 with instructions', async () => {
    const messages: AgentMessage[] = [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: wrapInternalContext('goal', 'past internal context '.repeat(400)),
          },
        ],
        timestamp: 1,
      },
      { role: 'user', content: [{ type: 'text', text: 'preserve this request' }], timestamp: 2 },
      {
        role: 'user',
        content: [{ type: 'text', text: wrapInternalContext('goal', 'current internal context') }],
        timestamp: 3,
      },
    ];
    const model = testModel({ provider: 'selected-provider', reasoning: true });
    const headers = { 'x-provider-route': 'selected-route' };
    const summary = validCheckpointSummary();
    const privateThinking = 'private manual checkpoint reasoning';
    const streamFn: StreamFn = vi.fn(() =>
      completedStream(checkpointMessage(model, summary, privateThinking)),
    );
    const onStarted = vi.fn();
    const onCheckpointGenerated = vi.fn();
    const captureSubagents = vi.fn(async () => ({
      capturedAtMs: 5,
      total: 1,
      counts: {
        queued: 0,
        running: 1,
        stopping: 0,
        succeeded: 0,
        failed: 0,
        canceled: 0,
        lost: 0,
      },
      omitted: 0,
      textFieldsAreUntrusted: true as const,
      detailsHint:
        'Call task_query for the live task list, then task_output(task_id) for progress or results.' as const,
      items: [
        {
          taskId: 'bg-manual',
          status: 'running' as const,
          updatedAtMs: 4,
          delivered: false,
        },
      ],
    }));
    const onCheckpointAttemptSettled = vi.fn();

    const result = await localCompactor({ captureSubagents }).compactManual(
      {
        sessionId: 'session-manual',
        messages,
        model,
        thinkingLevel: 'medium',
        streamFn,
        apiKey: 'selected-provider-key',
        headers,
        customInstructions: 'Preserve exact paths.',
      },
      {
        onStarted,
        onCheckpointGenerated,
        onCheckpointAttemptSettled,
      },
    );

    expect(result).toMatchObject({ status: 'completed', method: 'llm_checkpoint', summary });
    if (result.status !== 'completed') throw new Error('Expected completed checkpoint.');
    expect(
      readCompactionCompatibility(result.replacementMessages[0] as AgentMessage | undefined)
        ?.subagents,
    ).toMatchObject({
      capturedAtMs: 5,
      items: [{ taskId: 'bg-manual' }],
    });
    expect(captureSubagents).toHaveBeenCalledWith({ sessionId: 'session-manual' });
    expect(JSON.stringify(result)).not.toContain(privateThinking);
    expect(onStarted).toHaveBeenCalledOnce();
    expect(onCheckpointGenerated).toHaveBeenCalledWith({
      responseContentKinds: ['thinking', 'text'],
      stopReason: 'stop',
      outputTokens: 100,
    });
    expect(onCheckpointAttemptSettled).toHaveBeenCalledWith(
      expect.objectContaining({ candidate: 'h0', attemptNumber: 1, outcome: 'generated' }),
    );
    const [calledModel, context, options] = vi.mocked(streamFn).mock.calls[0] ?? [];
    if (!context) throw new Error('Expected checkpoint context.');
    expect(calledModel).toBe(model);
    expect(context.messages).toEqual([
      ...messages,
      {
        role: 'user',
        content: [{ type: 'text', text: buildCheckpointControl('Preserve exact paths.') }],
        timestamp: 3,
      },
    ]);
    expect(JSON.stringify(context)).toContain('past internal context');
    expect(options).toMatchObject({
      apiKey: 'selected-provider-key',
      headers,
      reasoning: 'medium',
    });
  });

  it('sends blank-instructions manual compaction directly to the checkpoint Provider', async () => {
    const messages = twoToolRounds();
    const snapshot = structuredClone(messages);
    const onStarted = vi.fn();
    const summary = validCheckpointSummary();
    const model = testModel({ contextWindow: 1_000_000 });
    const streamFn: StreamFn = vi.fn(() => completedStream(checkpointMessage(model, summary)));

    const result = await localCompactor().compactManual(
      {
        sessionId: 'session-manual',
        messages,
        model,
        thinkingLevel: 'off',
        customInstructions: ' \n\t ',
        streamFn,
      },
      { onStarted },
    );

    expect(result).toMatchObject({ status: 'completed', method: 'llm_checkpoint', summary });
    expect(streamFn).toHaveBeenCalledOnce();
    expect(vi.mocked(streamFn).mock.calls[0]?.[1].messages.slice(0, -1)).toEqual(messages);
    expect(onStarted).toHaveBeenCalledOnce();
    expect(messages).toEqual(snapshot);

    await expect(
      localCompactor().compactManual({
        sessionId: 'session-manual',
        messages,
        model: testModel({ contextWindow: 1_000_000 }),
        thinkingLevel: 'off',
        maxSerializedInputBytes: 1,
      }),
    ).rejects.toThrow(/streamFn/i);
  });

  it('uses an LLM checkpoint for large ToolResults even when read is unavailable', async () => {
    const messages = Array.from({ length: 5 }, (_, index) =>
      toolRound(`manual-trim-${index}`, 'x'.repeat(64 * 1_024), index * 2 + 1, 'bash'),
    ).flat();
    const summary = validCheckpointSummary();
    const model = testModel({ contextWindow: 1_000_000 });
    const streamFn: StreamFn = vi.fn(() => completedStream(checkpointMessage(model, summary)));

    const result = await localCompactor().compactManual({
      sessionId: 'session-manual-no-read',
      messages,
      model,
      thinkingLevel: 'off',
      tools: [{ name: 'bash', description: 'Bash', parameters: { type: 'object' } }],
      streamFn,
    });

    expect(result).toMatchObject({ status: 'completed', method: 'llm_checkpoint', summary });
    expect(streamFn).toHaveBeenCalledOnce();
    expect(vi.mocked(streamFn).mock.calls[0]?.[1].messages.slice(0, -1)).toEqual(messages);
  });
});

describe('LocalContextCompactor admission', () => {
  it('admits a low-pressure single-message Spark checkpoint with no deletion candidate', async () => {
    const messages: AgentMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'single message context '.repeat(1_000) }],
        timestamp: 1,
      },
    ];
    const model = testModel({
      id: 'gpt-5.3-codex-spark',
      name: 'GPT-5.3 Codex Spark',
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      reasoning: true,
      contextWindow: 128_000,
      maxTokens: 128_000,
    });
    const summary = validCheckpointSummary();
    const streamFn: StreamFn = vi.fn(() => completedStream(checkpointMessage(model, summary)));

    await expect(
      localCompactor().compactManual({
        sessionId: 'session-manual-short-spark',
        messages,
        model,
        thinkingLevel: 'off',
        streamFn,
      }),
    ).resolves.toMatchObject({ status: 'completed', method: 'llm_checkpoint', summary });
    expect(streamFn).toHaveBeenCalledOnce();
  });

  it('admits a valid Spark manual checkpoint when configured output equals context', async () => {
    const messages = twoToolRounds();
    const model = testModel({
      id: 'gpt-5.3-codex-spark',
      name: 'GPT-5.3 Codex Spark',
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      reasoning: true,
      contextWindow: 128_000,
      maxTokens: 128_000,
    });
    const summary = validCheckpointSummary();
    const streamFn: StreamFn = vi.fn(() => completedStream(checkpointMessage(model, summary)));

    await expect(
      localCompactor().compactManual({
        sessionId: 'session-manual-spark',
        messages,
        model,
        thinkingLevel: 'off',
        streamFn,
      }),
    ).resolves.toMatchObject({ status: 'completed', method: 'llm_checkpoint', summary });
    expect(streamFn).toHaveBeenCalledOnce();
  });

  it('commits a manual checkpoint even when the replacement cannot reserve the next response', async () => {
    // The generated replacement leaves less than the reserved next-response
    // budget. Automatic compaction rejects this as POST_ADMISSION_FAILED; the
    // manual path bypasses that final gate because an explicit user request
    // always commits the generated checkpoint.
    const messages: AgentMessage[] = [
      {
        role: 'user',
        content: [{ type: 'text', text: 'original request '.repeat(100) }],
        timestamp: 1,
      },
    ];
    const summary = validCheckpointSummary().repeat(40);
    const baseModel = testModel({ contextWindow: 0 });
    const checkpoint = checkpointMessage(baseModel, summary);
    const replacementTokens = createLocalContextFootprintMeasurer({ model: baseModel }).measure([
      buildCheckpointMessage(messages, summary, 1, { timestamp: 2 }),
    ]).inputTokens;
    const model = testModel({ contextWindow: replacementTokens + 16_383 });
    const streamFn: StreamFn = vi.fn(() => completedStream({ ...checkpoint, model: model.id }));

    await expect(
      localCompactor().compactManual({
        sessionId: 'session-manual',
        messages,
        model,
        thinkingLevel: 'off',
        streamFn,
        customInstructions: 'checkpoint now',
      }),
    ).resolves.toMatchObject({ status: 'completed', method: 'llm_checkpoint', summary });
    expect(streamFn).toHaveBeenCalledOnce();
    expect(messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'original request '.repeat(100) }],
      timestamp: 1,
    });
  });

  it('logs a content-free growth trace only when the manual replacement outgrows the history', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };
    const model = testModel({ contextWindow: 1_000_000 });

    const shrinkSummary = validCheckpointSummary();
    await expect(
      localCompactor(undefined, logger).compactManual({
        sessionId: 'session-growth-shrink',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'original request '.repeat(500) }],
            timestamp: 1,
          },
        ],
        model,
        thinkingLevel: 'off',
        streamFn: vi.fn(() => completedStream(checkpointMessage(model, shrinkSummary))),
      }),
    ).resolves.toMatchObject({ status: 'completed' });
    expect(logger.warn).not.toHaveBeenCalled();

    const growthSummary = validCheckpointSummary().repeat(40);
    await expect(
      localCompactor(undefined, logger).compactManual({
        sessionId: 'session-growth',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }], timestamp: 1 }],
        model,
        thinkingLevel: 'off',
        streamFn: vi.fn(() => completedStream(checkpointMessage(model, growthSummary))),
      }),
    ).resolves.toMatchObject({ status: 'completed', method: 'llm_checkpoint' });
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      {
        event: 'manual_compaction_replacement_grew',
        session_id: 'session-growth',
        method: 'llm_checkpoint',
        provider_input_limit: expect.any(Number),
        before_input_tokens: expect.any(Number),
        before_serialized_bytes: expect.any(Number),
        after_input_tokens: expect.any(Number),
        after_serialized_bytes: expect.any(Number),
      },
      '[local-runtime-v2] manual compaction replacement grew',
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('## Goal');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('uses the same conservative input limit for manual checkpoint fit', async () => {
    const streamFn = vi.fn<StreamFn>();

    await expect(
      localCompactor().compactManual({
        sessionId: 'session-manual',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'x'.repeat(20_000) }],
            timestamp: 1,
          },
        ],
        model: testModel({ contextWindow: 20_000 }),
        thinkingLevel: 'off',
        streamFn,
      }),
    ).rejects.toMatchObject({ code: 'COMPACTION_INPUT_TOO_LARGE' });
    expect(streamFn).not.toHaveBeenCalled();
  });
});

describe('LocalContextCompactor checkpoint output budget on the wire', () => {
  it('sends the window-scaled cap with the inherited effort and advances past a reasoning-exhausted H0', async () => {
    // Adaptive-thinking BYOK route: reasoning and text share max_tokens, and the
    // BYOK thinking patch re-applies the selected effort after Pi builds the payload.
    const model = testModel({
      id: 'byok-adaptive-model',
      reasoning: true,
      thinkingLevelMap: { max: 'max' },
      compat: { forceAdaptiveThinking: true },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    const payloadTransform = buildLocalRequestPayloadTransform(
      {
        agentConfig: { model: {} },
        llm: {
          model,
          apiKey: 'fake-key',
          thinkingLevel: 'max',
          thinkingRequestPatch: {
            thinking: { type: 'adaptive' },
            output_config: { effort: 'max' },
          },
        },
        sessionId: 'session-manual-wire',
        signal: new AbortController().signal,
      },
      {},
    );
    const summary = validCheckpointSummary();
    const wireBodies: Array<Record<string, unknown>> = [];
    const responses = [
      () => messagesSse(thinkingOnlyEvents('reasoning spent the budget', 125_000)),
      () => messagesSse(textEvents(summary)),
    ];
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      wireBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const next = responses.shift();
      if (!next) throw new Error('Unexpected extra checkpoint request.');
      return next();
    });
    const streamFn: StreamFn = (calledModel, context, options) =>
      streamSimple(calledModel, context, { ...options, fetch });
    const onCheckpointAttemptSettled = vi.fn();
    const onCheckpointGenerated = vi.fn();

    const result = await localCompactor().compactManual(
      {
        sessionId: 'session-manual-wire',
        messages: twoToolRounds(),
        model,
        thinkingLevel: 'max',
        streamFn,
        apiKey: 'fake-key',
        payloadTransform,
        customInstructions: 'Preserve exact paths.',
      },
      { onStarted: vi.fn(), onCheckpointAttemptSettled, onCheckpointGenerated },
    );

    expect(result).toMatchObject({ status: 'completed', method: 'llm_checkpoint', summary });
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const body of wireBodies) {
      expect(body).toMatchObject({
        max_tokens: 125_000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'max' },
      });
    }
    expect(JSON.stringify(wireBodies[0])).toContain('x'.repeat(20_000));
    expect(JSON.stringify(wireBodies[1])).not.toContain('x'.repeat(20_000));
    // The ladder shape after H0 is owned by compactContext; only assert that
    // H0 is not re-sent and the next smaller candidate succeeds.
    const attempts = onCheckpointAttemptSettled.mock.calls.map(([attempt]) => attempt);
    expect(attempts).toEqual([
      expect.objectContaining({ candidate: 'h0', attemptNumber: 1, outcome: 'output_exhausted' }),
      expect.objectContaining({ attemptNumber: 2, outcome: 'generated' }),
    ]);
    expect(attempts[1]?.candidate).not.toBe('h0');
    expect(onCheckpointGenerated).toHaveBeenNthCalledWith(1, {
      responseContentKinds: ['thinking'],
      stopReason: 'length',
      outputTokens: 125_000,
    });
  });
});

describe('LocalContextCompactor Provider usage', () => {
  it('carries Provider token usage through a manual checkpoint', async () => {
    const model = testModel({ contextWindow: 1_000_000 });
    const summary = validCheckpointSummary();
    const tokenUsage = {
      inputTokens: 17,
      outputTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: 7,
      totalTokens: 32,
      incomplete: false,
    } as const;
    const onProviderRequestSettled = vi.fn();
    const result = await localCompactor().compactManual(
      {
        sessionId: 'session-manual-usage',
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'context '.repeat(2_000) }],
            timestamp: 1,
          },
        ],
        model,
        thinkingLevel: 'off',
        streamFn: vi.fn(() => completedStream(checkpointMessage(model, summary))),
      },
      {
        onStarted: vi.fn(),
        onProviderRequestSettled,
        getProviderTokenUsage: () => tokenUsage,
      },
    );

    expect(result).toMatchObject({ status: 'completed', method: 'llm_checkpoint', tokenUsage });
    expect(onProviderRequestSettled).toHaveBeenCalledWith(
      expect.objectContaining({
        requestAttempt: 1,
        outcome: 'success',
        usage: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0 },
        usageComplete: true,
      }),
    );
  });
});

function testModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return { ...testModelBase(), ...overrides };
}

function testModelBase(): Model<Api> {
  return {
    id: 'model-1',
    name: 'Model 1',
    api: 'anthropic-messages' as const,
    provider: 'test',
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 4_096,
  };
}

function checkpointMessage(
  model: ReturnType<typeof testModel>,
  text: string,
  thinking?: string,
): AssistantMessage {
  return {
    role: 'assistant',
    content: [
      ...(thinking === undefined ? [] : [{ type: 'thinking' as const, thinking }]),
      { type: 'text', text },
    ],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 100,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 4,
  };
}

function validCheckpointSummary(): string {
  return `## Goal
Preserve the request.

## Constraints & Preferences
Keep exact paths.

## Completed Work
(none)

## Current State
Manual checkpoint requested.

## Blockers
(none)

## Key Decisions
Use the selected model.

## Pending User Asks
Continue.

## Critical Context & Relevant Files
(none)`;
}

function twoToolRounds(): AgentMessage[] {
  return [toolRound('old', 'x'.repeat(20_000), 1), toolRound('recent', 'keep', 3)].flat();
}

function toolRound(
  id: string,
  output: string,
  timestamp: number,
  toolName = 'read',
): AgentMessage[] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id, name: toolName, arguments: { path: `/${id}` } }],
      timestamp,
      provider: 'test',
      api: 'anthropic-messages',
      model: 'model-1',
      stopReason: 'toolUse',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    {
      role: 'toolResult',
      toolCallId: id,
      toolName,
      content: [{ type: 'text', text: output }],
      isError: false,
      timestamp: timestamp + 1,
    },
  ];
}

function completedStream(final: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: 'done', reason: 'stop', message: final });
  return stream;
}

function sseEvent(data: Record<string, unknown>): string {
  return `event: ${String(data.type)}\ndata: ${JSON.stringify(data)}\n\n`;
}

function messagesSse(events: readonly Record<string, unknown>[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(sseEvent(event)));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function messageStart(): Record<string, unknown> {
  return {
    type: 'message_start',
    message: {
      id: 'msg-checkpoint',
      type: 'message',
      role: 'assistant',
      model: 'byok-adaptive-model',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  };
}

function thinkingOnlyEvents(thinking: string, outputTokens: number): Record<string, unknown>[] {
  return [
    messageStart(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '', signature: '' },
    },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens', stop_sequence: null },
      usage: { output_tokens: outputTokens },
    },
    { type: 'message_stop' },
  ];
}

function textEvents(text: string): Record<string, unknown>[] {
  return [
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 100 },
    },
    { type: 'message_stop' },
  ];
}
