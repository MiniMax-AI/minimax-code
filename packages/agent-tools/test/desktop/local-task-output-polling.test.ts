import { describe, expect, it, vi } from 'vitest';

import type { BackgroundTask } from '@mavis/background-task';
import { PiTurnRunner } from '@mavis/agent-core/pi-turn-runner';
import type { RuntimeTool } from '@mavis/agent-core/tools';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';

import { LocalTaskOutputToolDef } from '../../src/desktop/builtin-defs.js';
import { LocalTaskOutputTool } from '../../src/desktop/local-task-control.js';
import type {
  LocalRuntimeToolContext,
  LocalTaskControlAdapter,
  LocalTaskOutputReadResult,
} from '../../src/desktop/types.js';

const context: LocalRuntimeToolContext = { sessionId: 'owner', turnId: 'turn-1' };
const replay = { task_id: 'bg_1', offset: 0, wait_ms: 30_000 };
const running: LocalTaskOutputReadResult = {
  content: 'Compiling\n',
  status: 'running',
  nextOffset: 312,
  truncated: false,
  timedOut: false,
};

function fixture() {
  const get = vi.fn<LocalTaskControlAdapter['get']>(async (ctx, taskId) => ({
    taskId,
    ownerSessionId: ctx.sessionId,
    kind: 'bash',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
  }));
  const readOutput = vi.fn<LocalTaskControlAdapter['readOutput']>(async () => ({ ...running }));
  const adapter: LocalTaskControlAdapter = {
    get,
    readOutput,
    list: async () => ({ items: [] }),
    stop: async () => undefined,
  };
  return { tool: new LocalTaskOutputTool(adapter), get, readOutput };
}

it('shows incomplete persistence even when the command itself succeeded', async () => {
  const { tool, get, readOutput } = fixture();
  get.mockResolvedValue({
    taskId: 'bg_1', ownerSessionId: 'owner', kind: 'bash', status: 'succeeded', createdAt: 1, updatedAt: 2,
    metadata: { bashDetails: { output: { persistence: 'incomplete', rawBytes: 1234 } } },
  });
  readOutput.mockResolvedValue({ content: 'saved portion', status: 'succeeded', nextOffset: 100 });
  const result = await tool.execute(context, { task_id: 'bg_1' });
  expect(result.text).toContain('Output persistence is incomplete');
  expect(result.text).toContain('saved portion');
  expect(result.details?.output).toMatchObject({ rawBytes: 1234 });
});

const piTestModel: Model<Api> = {
  id: 'test-model',
  name: 'test-model',
  api: 'anthropic-messages',
  provider: 'test-provider',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

function assistantMessage(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'],
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: piTestModel.api,
    provider: piTestModel.provider,
    model: piTestModel.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

function resultOnlyStream(message: AssistantMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: 'done', reason: message.stopReason, message };
    },
    async result() {
      return message;
    },
  } as never;
}

function piToolCallStream(
  calls: readonly { readonly id: string; readonly arguments: Record<string, unknown> }[],
): StreamFn {
  let invocation = 0;
  return (async () => {
    const message =
      invocation++ === 0
        ? assistantMessage(
            calls.map((call) => ({
              type: 'toolCall',
              id: call.id,
              name: 'task_output',
              arguments: call.arguments,
            })),
            'toolUse',
          )
        : assistantMessage([{ type: 'text', text: 'done' }], 'stop');
    return resultOnlyStream(message);
  }) as StreamFn;
}

it.each(['succeeded', 'failed', 'canceled', 'lost'] as const)(
  'successfully reads output from a %s task',
  async (status) => {
    const { tool, get, readOutput } = fixture();
    get.mockResolvedValue({
      taskId: 'bg_1',
      ownerSessionId: 'owner',
      kind: 'bash',
      status,
      createdAt: 1,
      updatedAt: 2,
    });
    readOutput.mockResolvedValue({ content: 'saved command output', status, nextOffset: 20 });
    const result = await tool.execute(context, { task_id: 'bg_1' });
    expect(result.isError).not.toBe(true);
    expect(result.details).toMatchObject({ task_id: 'bg_1', status, next_offset: 20 });
    expect(result.text).toContain('saved command output');
  },
);

describe('task_output polling guidance', () => {
  it('lets Pi validate raw task_output arguments before executing capped waits', async () => {
    const readOutput = vi.fn<LocalTaskControlAdapter['readOutput']>(async () => ({
      content: '',
      status: 'running',
      timedOut: true,
    }));
    const adapter: LocalTaskControlAdapter = {
      get: async () => ({
        taskId: 'bg_1',
        ownerSessionId: context.sessionId,
        kind: 'bash',
        status: 'running',
        createdAt: 1,
        updatedAt: 1,
      }),
      readOutput,
      list: async () => ({ items: [] }),
      stop: async () => undefined,
    };
    const rawCalls = [
      { id: 'oversized-60', arguments: { task_id: 'bg_1', wait_ms: 60_000 } },
      { id: 'oversized-120', arguments: { task_id: 'bg_1', wait_ms: 120_000 } },
      { id: 'oversized-300', arguments: { task_id: 'bg_1', wait_ms: 300_000 } },
      { id: 'negative', arguments: { task_id: 'bg_1', wait_ms: -1 } },
      { id: 'fraction', arguments: { task_id: 'bg_1', wait_ms: 0.5 } },
      { id: 'string', arguments: { task_id: 'bg_1', wait_ms: '60000' } },
      { id: 'null', arguments: { task_id: 'bg_1', wait_ms: null } },
      { id: 'infinity', arguments: { task_id: 'bg_1', wait_ms: Number.POSITIVE_INFINITY } },
      { id: 'nan', arguments: { task_id: 'bg_1', wait_ms: Number.NaN } },
    ];
    const history: unknown[] = [];
    const stepResults: unknown[] = [];
    const tool: RuntimeTool = {
      def: LocalTaskOutputToolDef,
      impl: new LocalTaskOutputTool(adapter),
      source: 'builtin',
    };

    await new PiTurnRunner().runTurn({
      sessionId: context.sessionId,
      turnId: context.turnId,
      workspaceDir: '/workspace',
      systemPrompt: '',
      userMessage: { text: 'read task output' },
      llm: { model: piTestModel, streamFn: piToolCallStream(rawCalls) },
      eventWriter: { pushRuntime: () => undefined, appendEvents: () => undefined },
      toolConfig: { tools: [tool], disableBuiltinToolFallback: true, context },
      hooks: {
        onStepEndHook: [
          ({ toolResults }) => {
            stepResults.push(...structuredClone(toolResults));
          },
        ],
        onHistoryChangedHook: [
          ({ reason, messages }) => {
            if (reason === 'messageDelta') history.push(...structuredClone(messages));
          },
        ],
      },
    });

    expect(readOutput).toHaveBeenCalledTimes(3);
    for (const [, , options] of readOutput.mock.calls) {
      expect(options).toMatchObject({ waitMs: 30_000 });
    }
    const invalidCallIds = new Set(rawCalls.slice(3).map((call) => call.id));
    const invalidResults = (
      stepResults as Array<{
        readonly toolCallId: string;
        readonly isError: boolean;
      }>
    ).filter((result) => invalidCallIds.has(result.toolCallId));
    expect(invalidResults).toHaveLength(invalidCallIds.size);
    expect(invalidResults.every((result) => result.isError)).toBe(true);
    const assistant = history.find(
      (message): message is { readonly role: 'assistant'; readonly content: readonly unknown[] } =>
        typeof message === 'object' &&
        message !== null &&
        (message as { role?: unknown }).role === 'assistant',
    );
    expect(assistant?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'oversized-60',
          arguments: { task_id: 'bg_1', wait_ms: 60_000 },
        }),
        expect.objectContaining({
          id: 'oversized-120',
          arguments: { task_id: 'bg_1', wait_ms: 120_000 },
        }),
        expect.objectContaining({
          id: 'oversized-300',
          arguments: { task_id: 'bg_1', wait_ms: 300_000 },
        }),
      ]),
    );
  });

  it('corrects repeated offset=0 reads with the returned cursor without changing replay semantics', async () => {
    const { tool, readOutput } = fixture();
    const first = await tool.execute(context, replay);
    const repeated = await tool.execute(context, replay);

    expect(first.text).not.toContain('<task_output_hint>');
    expect(repeated.text).toContain('Task status and next_offset are unchanged');
    expect(repeated.text).toContain('task_output({"task_id":"bg_1","offset":312,"wait_ms":30000})');
    expect(repeated.text).toContain('offset=0 replays existing output');
    expect(repeated.text).toContain(running.content);
    expect(repeated.details).toEqual(first.details);
    expect(repeated.content).toEqual([{ type: 'text', text: repeated.text }]);
    expect(readOutput.mock.calls.map(([, , options]) => options)).toEqual([
      { offset: 0, waitMs: 30_000 },
      { offset: 0, waitMs: 30_000 },
    ]);
    expect(replay.offset).toBe(0);
  });

  it.each([undefined, 0])('corrects unchanged empty reads with wait_ms=%s', async (waitMs) => {
    const { tool, readOutput } = fixture();
    readOutput.mockResolvedValue({ content: '', nextOffset: 312, status: 'running' });
    const input = { task_id: 'bg_1', offset: 312, ...(waitMs === undefined ? {} : { wait_ms: waitMs }) };
    await tool.execute(context, input);
    const repeated = await tool.execute(context, input);

    expect(repeated.text).toContain('"offset":312,"wait_ms":30000');
    expect(repeated.text).toContain('(no output yet)');
    expect(readOutput).toHaveBeenLastCalledWith(context, 'bg_1', {
      offset: 312,
      waitMs: waitMs ?? 0,
    });
  });

  it('preserves automatic cursor reads while providing an explicit recovery call', async () => {
    const { tool, readOutput } = fixture();
    readOutput.mockResolvedValue({ content: '', nextOffset: 312, status: 'running' });
    await tool.execute(context, { task_id: 'bg_1' });
    const repeated = await tool.execute(context, { task_id: 'bg_1' });

    expect(repeated.text).toContain('"offset":312,"wait_ms":30000');
    expect(readOutput).toHaveBeenLastCalledWith(context, 'bg_1', { waitMs: 0 });
    expect(repeated.details).toMatchObject({ effective_wait_ms: 0, wait_ms_clamped: false });
  });

  it.each([30_001, 60_000, 300_000])(
    'caps oversized wait_ms=%s while preserving the requested value for diagnostics',
    async (waitMs) => {
      const { tool, readOutput } = fixture();
      readOutput.mockResolvedValue({ ...running, content: '', timedOut: true });
      const input = { task_id: 'bg_1', offset: 312, wait_ms: waitMs };

      const result = await tool.execute(context, input);

      expect(input.wait_ms).toBe(waitMs);
      expect(readOutput).toHaveBeenCalledWith(context, 'bg_1', { offset: 312, waitMs: 30_000 });
      expect(result.text).toContain(
        '<task_output_hint>Your requested wait_ms exceeded 30000 ms and was capped at 30000 ms (30 seconds). This output read reached its wait limit; the background task was not stopped. Use wait_ms=30000 or less for future reads.</task_output_hint>',
      );
      expect(result.details).toMatchObject({
        effective_wait_ms: 30_000,
        wait_ms_clamped: true,
        timed_out: true,
      });
    },
  );

  it.each([
    { read: { ...running, timedOut: true }, waitMs: 30_000 },
    { read: { ...running, timedOut: false }, waitMs: 60_000 },
    { read: { ...running, status: 'succeeded' as const, timedOut: false }, waitMs: 60_000 },
  ])(
    'does not describe a cap timeout when the read returns early: %j',
    async ({ read, waitMs }) => {
      const { tool, readOutput } = fixture();
      readOutput.mockResolvedValue(read);

      const result = await tool.execute(context, { task_id: 'bg_1', wait_ms: waitMs });

      expect(result.text).not.toContain('Your requested wait_ms exceeded 30000 ms');
      expect(result.details).toMatchObject({
        effective_wait_ms: waitMs > 30_000 ? 30_000 : waitMs,
        wait_ms_clamped: waitMs > 30_000,
      });
    },
  );

  it('does not describe a capped wait as timed out after cancellation', async () => {
    const { tool, readOutput } = fixture();
    const controller = new AbortController();
    controller.abort();
    readOutput.mockResolvedValue({ ...running, content: '', timedOut: true });

    const result = await tool.execute(
      context,
      { task_id: 'bg_1', wait_ms: 60_000 },
      controller.signal,
    );

    expect(result.text).not.toContain('Your requested wait_ms exceeded 30000 ms');
    expect(result.details).toMatchObject({ effective_wait_ms: 30_000, wait_ms_clamped: true });
  });

  it('does not warn on a normal long-poll timeout but still detects the following immediate check', async () => {
    const { tool, readOutput } = fixture();
    readOutput.mockResolvedValue({ ...running, content: '', timedOut: true });
    await tool.execute(context, { ...replay, offset: 312 });
    const timeout = await tool.execute(context, { ...replay, offset: 312 });
    expect(timeout.text).not.toContain('<task_output_hint>');
    expect(timeout.details).toMatchObject({ timed_out: true, next_offset: 312 });

    readOutput.mockResolvedValue({ ...running, content: '', timedOut: undefined });
    const immediate = await tool.execute(context, { task_id: 'bg_1', offset: 312 });
    expect(immediate.text).toContain('<task_output_hint>');
  });

  it('resets the comparison when output advances or task status changes', async () => {
    const { tool, readOutput } = fixture();
    await tool.execute(context, replay);
    readOutput.mockResolvedValue({ ...running, nextOffset: 344 });
    expect((await tool.execute(context, replay)).text).not.toContain('<task_output_hint>');
    readOutput.mockResolvedValue({ ...running, nextOffset: 344, status: 'stopping' });
    expect((await tool.execute(context, replay)).text).not.toContain('<task_output_hint>');
    expect((await tool.execute(context, replay)).text).toContain('"offset":344');
  });

  it.each<BackgroundTask['status']>(['succeeded', 'failed', 'canceled', 'lost'])(
    'does not recommend waiting on a %s task and forgets the previous active read',
    async (status) => {
      const { tool, readOutput } = fixture();
      await tool.execute(context, replay);
      readOutput.mockResolvedValue({ ...running, status });
      expect((await tool.execute(context, replay)).text).not.toContain('<task_output_hint>');
      expect((await tool.execute(context, replay)).text).not.toContain('<task_output_hint>');
      readOutput.mockResolvedValue(running);
      expect((await tool.execute(context, replay)).text).not.toContain('<task_output_hint>');
    },
  );

  it.each([
    { ctx: { ...context, sessionId: 'other-owner' }, input: replay },
    { ctx: { ...context, turnId: 'turn-2' }, input: replay },
    { ctx: context, input: { ...replay, task_id: 'bg_2' } },
  ])('only compares consecutive reads of the same session, Turn and task: %j', async ({ ctx, input }) => {
    const { tool } = fixture();
    await tool.execute(context, replay);
    expect((await tool.execute(ctx, input)).text).not.toContain('<task_output_hint>');
    expect((await tool.execute(context, replay)).text).not.toContain('<task_output_hint>');
    expect((await tool.execute(context, replay)).text).toContain('<task_output_hint>');
  });

  it.each([undefined, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'never invents continuation arguments for an invalid cursor %s',
    async (nextOffset) => {
      const { tool, readOutput } = fixture();
      await tool.execute(context, replay);
      readOutput.mockResolvedValue({ ...running, nextOffset });
      await tool.execute(context, replay);
      expect((await tool.execute(context, replay)).text).not.toContain('<task_output_hint>');
      readOutput.mockResolvedValue(running);
      expect((await tool.execute(context, replay)).text).not.toContain('<task_output_hint>');
    },
  );

  it('clears the comparison on task-not-found without turning it into polling advice', async () => {
    const { tool, get } = fixture();
    await tool.execute(context, replay);
    get.mockResolvedValueOnce(undefined);
    const missing = await tool.execute(context, replay);
    expect(missing.isError).toBe(true);
    expect(missing.details).toMatchObject({ effective_wait_ms: 30_000, wait_ms_clamped: false });
    expect(missing.text).not.toContain('<task_output_hint>');
    expect((await tool.execute(context, replay)).text).not.toContain('<task_output_hint>');
  });

  it('does not learn a failed or canceled read and forwards cancellation unchanged', async () => {
    const { tool, readOutput } = fixture();
    readOutput.mockRejectedValueOnce(new Error('read failed'));
    await expect(tool.execute(context, replay)).rejects.toThrow('read failed');
    const controller = new AbortController();
    controller.abort();
    const canceled = await tool.execute(context, replay, controller.signal);
    expect(canceled.text).not.toContain('<task_output_hint>');
    expect(readOutput).toHaveBeenLastCalledWith(context, 'bg_1', {
      offset: 0, waitMs: 30_000, signal: controller.signal,
    });
    expect((await tool.execute(context, replay)).text).not.toContain('<task_output_hint>');
    expect((await tool.execute(context, replay)).text).toContain('<task_output_hint>');
  });

  it('preserves truncated replay output and points to the next page without claiming the task is finished', async () => {
    const { tool, readOutput } = fixture();
    readOutput.mockResolvedValue({ ...running, truncated: true });
    await tool.execute(context, replay);
    const repeated = await tool.execute(context, replay);
    expect(repeated.text).toContain(running.content);
    expect(repeated.text).toContain('"offset":312');
    expect(repeated.details).toMatchObject({ truncated: true, status: 'running', next_offset: 312 });
  });
});
