import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runTuiExec } from '../../src/headless/runner.js';
import type { TuiMessage, TuiStreamEvent } from '../../src/runtime/stream-events.js';

const successEvents: readonly TuiStreamEvent[] = [
  { type: 'message', message: { id: 'assistant-1', role: 'assistant', content: 'fixed' } },
  { type: 'session-status', status: 'finished' },
];

const reviewXml = `<annotation-result version="2" source="code-review" review-run-id="review_1" trigger="slash" mode="inline" verdict="needs-changes"><summary>Found one issue.</summary><annotations><annotation id="annotation_1" kind="code-review" priority="P1"><target type="file" uri="src/demo.ts"><selector type="line-range" side="new" start-line="10" end-line="10" anchor-revision="sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" context-before="1" context-after="1" /></target><title>Guard the value</title><content>This value can be undefined.</content></annotation></annotations></annotation-result>`;

function accountReady() {
  return Promise.resolve({
    status: 'ready' as const,
    managedTokenPresent: true,
    warnings: [],
  });
}

function runtimeWith(events: readonly TuiStreamEvent[] = successEvents) {
  return {
    getAccountStatus: vi.fn(accountReady),
    listModels: vi.fn(async () => [
      {
        providerId: 'default-provider',
        modelId: 'default-model',
        variant: 'balanced',
        selected: true,
      },
    ]),
    setPermissionMode: vi.fn(async (mode) => mode),
    createSession: vi.fn(async () => ({
      sessionId: 'session-1',
      workspaceDir: '/tmp/workspace',
    })),
    getSession: vi.fn(async () => ({
      sessionId: 'session-1',
      workspaceDir: '/tmp/workspace',
      archived: false,
    })),
    listSessionPage: vi.fn(async () => ({ sessions: [], hasMore: false })),
    getPendingQuestionnaire: vi.fn(async () => undefined),
    listPendingPermissions: vi.fn(async () => []),
    getSessionUsage: vi.fn(async () => ({ rows: [] })),
    listMessagePage: vi.fn(async () => ({ messages: [], hasMore: false })),
    getActiveRun: vi.fn(async () => ({
      schemaVersion: 1 as const,
      sessionId: 'session-1',
      state: 'running' as const,
      turnId: 'turn-1',
      actions: { steer: true },
    })),
    sendMessage: vi.fn(async function* () {
      for (const event of events) yield event;
    }),
    watchSessionTurn: vi.fn(async function* () {
      yield { type: 'session-status' as const, status: 'finished' as const };
    }),
    abortSession: vi.fn(async () => true),
    steer: vi.fn(async () => ({ queueItemId: 'queue-1' })),
  };
}

describe('runTuiExec response usage', () => {
  const completed: TuiMessage = { id: 'first', turnId: 'turn-1', role: 'assistant', kind: 'final', content: 'fixed', usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 50, reasoningTokens: 2, totalTokens: 64 } };

  function usageRuntime(messages: TuiMessage[], terminal: TuiStreamEvent = { type: 'session-status', status: 'finished' }) {
    const runtime = runtimeWith([...messages.map((message) => ({ type: 'message' as const, message })), terminal]);
    runtime.listMessagePage.mockResolvedValue({ messages, hasMore: false } as never);
    return runtime;
  }

  async function resultFor(runtime: ReturnType<typeof runtimeWith>, format: 'json' | 'stream-json' = 'json') {
    const stdout = vi.fn();
    await runTuiExec(
      { prompt: 'Fix it', workspaceDir: '/tmp/workspace', version: '0.1.0', format },
      { runtime, stdout, stderr: vi.fn(), shutdown: async () => undefined, createTurnId: () => 'turn-1' },
    );
    const records = stdout.mock.calls.map(([line]) => JSON.parse(line));
    return format === 'json' ? records[0] : records;
  }

  it('keeps both completed responses when the analytics projection only contains the first', async () => {
    const messages = [
      { id: 'first', turnId: 'turn-1', role: 'assistant' as const, toolCalls: [{ id: 'tool-1', name: 'read', arguments: '{}' }], usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 50, totalTokens: 62 } },
      { id: 'second', turnId: 'turn-1', role: 'assistant' as const, content: 'fixed', usage: { inputTokens: 20, outputTokens: 3, totalTokens: 23 } },
    ];
    const runtime = runtimeWith([
      ...messages.map((message) => ({ type: 'message' as const, message })),
      { type: 'session-status', status: 'finished' },
    ]);
    runtime.listMessagePage.mockResolvedValue({ messages, hasMore: false } as never);
    runtime.getSessionUsage.mockResolvedValue({ rows: [{ id: 1, turnId: 'turn-1', inputTokens: 10, outputTokens: 2, cacheReadTokens: 50 }] } as never);
    const stdout = vi.fn();

    await expect(runTuiExec(
      { prompt: 'Fix it', workspaceDir: '/tmp/workspace', version: '0.1.0', format: 'json' },
      { runtime, stdout, stderr: vi.fn(), shutdown: async () => undefined, createTurnId: () => 'turn-1' },
    )).resolves.toBe(0);

    expect(JSON.parse(stdout.mock.calls[0]?.[0] ?? '')).toMatchObject({
      usage: { inputTokens: 30, outputTokens: 5, cacheReadTokens: 50, totalTokens: 35 },
      usageSource: 'completed_responses',
      usageIncomplete: false,
    });
  });

  it('merges corrected saved usage by response ID without erasing earlier buckets', async () => {
    const runtime = usageRuntime([completed, completed]);
    runtime.listMessagePage.mockResolvedValue({ messages: [{ ...completed, usage: { inputTokens: 6 } }], hasMore: false } as never);

    expect(await resultFor(runtime)).toMatchObject({
      usage: { inputTokens: 6, outputTokens: 4, reasoningTokens: 2, cacheReadTokens: 50, totalTokens: 10 },
      usageSource: 'completed_responses', usageIncomplete: false,
    });
  });

  it.each(['inputTokens', 'outputTokens'] as const)(
    'marks a response missing %s incomplete even when other responses supply that bucket',
    async (missingField) => {
      const partial = {
        ...completed,
        id: 'partial',
        usage: missingField === 'inputTokens' ? { outputTokens: 0 } : { inputTokens: 0 },
      };

      expect(await resultFor(usageRuntime([completed, partial]))).toMatchObject({
        status: 'succeeded',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        usageSource: 'completed_responses',
        usageIncomplete: true,
      });
    },
  );

  it('treats explicit zero input and output as known complete usage', async () => {
    const response = { ...completed, usage: { inputTokens: 0, outputTokens: 0 } };

    expect(await resultFor(usageRuntime([response]))).toMatchObject({
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      usageSource: 'completed_responses',
      usageIncomplete: false,
    });
  });

  it('includes saved responses absent from the live stream and reads every history page', async () => {
    const second = { ...completed, id: 'second', usage: { inputTokens: 20, outputTokens: 3 } };
    const runtime = usageRuntime([second]);
    runtime.listMessagePage.mockResolvedValueOnce({ messages: [second], hasMore: true, nextCursor: 'older' } as never)
      .mockResolvedValueOnce({ messages: [completed, { ...completed, id: 'old-turn', turnId: 'turn-old' }], hasMore: false } as never);
    expect(await resultFor(runtime)).toMatchObject({ usage: { inputTokens: 30, outputTokens: 7, cacheReadTokens: 50, totalTokens: 37 }, usageIncomplete: false });
    expect(runtime.listMessagePage).toHaveBeenCalledTimes(2);
    expect(runtime.listMessagePage).toHaveBeenLastCalledWith('session-1', { limit: 200, before: 'older' });
  });

  it('reports complete response coverage after terminal history recovery', async () => {
    const runtime = usageRuntime([]);
    runtime.sendMessage.mockImplementation(async function* () { yield* []; });
    runtime.getActiveRun.mockResolvedValue({ schemaVersion: 1, sessionId: 'session-1', state: 'idle', actions: {} } as never);
    runtime.getSession.mockResolvedValue({ sessionId: 'session-1', workspaceDir: '/tmp/workspace', status: 'idle' } as never);
    runtime.listMessagePage.mockResolvedValue({ messages: [completed], hasMore: false } as never);
    expect(await resultFor(runtime)).toMatchObject({ usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }, usageIncomplete: false });
  });

  it.each([
    { name: 'missing usage', message: { ...completed, id: 'missing', usage: undefined } },
    { name: 'missing identity', message: { ...completed, id: undefined, usage: { inputTokens: 3 } } },
    { name: 'invalid usage', message: { ...completed, id: 'invalid', usage: { inputTokens: -1, outputTokens: 1 } } },
  ])('preserves known usage but marks $name incomplete', async ({ message }) => {
    const result = await resultFor(usageRuntime([completed, message]));
    expect(result).toMatchObject({ usageSource: 'completed_responses', usageIncomplete: true });
    expect(result.usage.inputTokens).toBeGreaterThanOrEqual(10);
    expect(result.usage.cacheReadTokens).toBe(50);
  });

  it.each(['aborted', 'error'] as const)('keeps completed usage after an %s terminal without claiming complete billing', async (status) => {
    expect(await resultFor(usageRuntime([completed], { type: 'session-status', status }))).toMatchObject({
      status: status === 'aborted' ? 'cancelled' : 'failed',
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      usageSource: 'completed_responses', usageIncomplete: true,
    });
  });

  it('keeps known stream usage when final history inspection fails', async () => {
    const runtime = usageRuntime([completed]);
    runtime.listMessagePage.mockRejectedValue(new Error('inspection unavailable'));
    expect(await resultFor(runtime)).toMatchObject({ usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }, usageSource: 'completed_responses', usageIncomplete: true });
  });

  it('bounds final inspection time and does not let stalled analytics hide stream usage', async () => {
    vi.useFakeTimers();
    try {
      const runtime = usageRuntime([completed]);
      let finishPage: (page: unknown) => void = () => undefined;
      runtime.listMessagePage.mockImplementation(() => new Promise((resolve) => { finishPage = resolve as (page: unknown) => void; }));
      runtime.getSessionUsage.mockImplementation(() => new Promise(() => undefined));
      const result = resultFor(runtime);
      await vi.advanceTimersByTimeAsync(1_001);
      expect(await result).toMatchObject({ status: 'succeeded', usage: { totalTokens: 14 }, usageSource: 'completed_responses', usageIncomplete: true });
      finishPage({ messages: [completed], hasMore: true, nextCursor: 'late-page' });
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.listMessagePage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not claim completeness when history pagination stalls', async () => {
    const runtime = usageRuntime([completed]);
    runtime.listMessagePage.mockResolvedValue({ messages: [completed], hasMore: true, nextCursor: 'same' } as never);
    expect(await resultFor(runtime)).toMatchObject({ usage: { totalTokens: 14 }, usageIncomplete: true });
    expect(runtime.listMessagePage).toHaveBeenCalledTimes(2);
  });

  it('marks incomplete history with a missing cursor or exhausted page limit', async () => {
    for (const mode of ['missing-cursor', 'page-limit']) {
      const runtime = usageRuntime([completed]);
      let page = 0;
      runtime.listMessagePage.mockImplementation(async () => ({ messages: [completed], hasMore: true, ...(mode === 'page-limit' ? { nextCursor: String(++page) } : {}) }) as never);
      expect(await resultFor(runtime)).toMatchObject({ usage: { totalTokens: 14 }, usageIncomplete: true });
      expect(runtime.listMessagePage).toHaveBeenCalledTimes(mode === 'page-limit' ? 100 : 1);
    }
  });

  it.each(['bucket', 'total'])('omits a non-finite %s sum and marks usage incomplete', async (kind) => {
    const messages = kind === 'bucket'
      ? [{ ...completed, usage: { inputTokens: Number.MAX_VALUE, outputTokens: 2 } }, { ...completed, id: 'second', usage: { inputTokens: Number.MAX_VALUE, outputTokens: 2 } }]
      : [{ ...completed, usage: { inputTokens: Number.MAX_VALUE, outputTokens: Number.MAX_VALUE } }];
    const result = await resultFor(usageRuntime(messages));
    expect(result).toMatchObject({ usageSource: 'completed_responses', usageIncomplete: true });
    expect(Object.values(result.usage).every((value) => typeof value === 'number' && Number.isFinite(value))).toBe(true);
    expect(result.usage).not.toHaveProperty(kind === 'bucket' ? 'inputTokens' : 'totalTokens');
  });

  it('labels deduplicated analytics-only usage as a partial fallback and leaves missing fields absent', async () => {
    const runtime = runtimeWith();
    const row = { id: 1, turnId: 'turn-1', inputTokens: 8 };
    runtime.getSessionUsage.mockResolvedValue({ rows: [row, row, { ...row, turnId: 'other', id: 2 }] } as never);
    const result = await resultFor(runtime);
    expect(result).toMatchObject({ usage: { inputTokens: 8, totalTokens: 8 }, usageSource: 'analytics_fallback', usageIncomplete: true });
    expect(result.usage).not.toHaveProperty('outputTokens');
  });

  it('leaves unavailable usage absent instead of fabricating zero', async () => {
    const result = await resultFor(runtimeWith());
    expect(result).toMatchObject({ usageSource: 'unavailable', usageIncomplete: true });
    expect(result).not.toHaveProperty('usage');
  });

  it('preserves usage completeness metadata in both JSONL terminal records', async () => {
    const records = await resultFor(usageRuntime([completed]), 'stream-json');
    expect(records.find((record: { type: string }) => record.type === 'turn.completed')).toMatchObject({ usage: { totalTokens: 14 }, usageSource: 'completed_responses', usageIncomplete: false });
    expect(records.at(-1).result).toMatchObject({ usage: { totalTokens: 14 }, usageSource: 'completed_responses', usageIncomplete: false });
  });

  it.each(['stream', 'history'] as const)('marks compaction usage unavailable through %s without changing response totals', async (source) => {
    const marker: TuiMessage = { id: 'compaction-attempt', turnId: 'turn-1', role: 'assistant', kind: 'compaction' };
    const runtime = usageRuntime(source === 'stream' ? [marker, completed] : [completed]);
    runtime.listMessagePage.mockResolvedValue({ messages: source === 'history' ? [marker, completed] : [completed], hasMore: false } as never);

    const result = await resultFor(runtime);
    expect(result).toMatchObject({ status: 'succeeded', usageSource: 'completed_responses', usageIncomplete: true });
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 50, reasoningTokens: 2, totalTokens: 14 });
  });
});

describe('runTuiExec', () => {
  it('sends a structured Review request and returns a pass result', async () => {
    const stdout = vi.fn();
    const runtime = runtimeWith([
      {
        type: 'message',
        message: {
          id: 'review-pass',
          role: 'assistant',
          content: 'No reportable issues were found.',
          origin: { reviewOutcome: 'pass' },
        },
      },
      { type: 'session-status', status: 'finished' },
    ]);

    await expect(
      runTuiExec(
        {
          prompt: 'Please review my uncommitted changes.',
          workspaceDir: '/tmp/workspace',
          version: '0.1.0',
          format: 'json',
          reviewRequest: { scope: 'local_changes' },
        },
        {
          runtime,
          stdout,
          stderr: vi.fn(),
          shutdown: async () => undefined,
          createTurnId: () => 'turn-1',
        },
      ),
    ).resolves.toBe(0);

    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ reviewRequest: { scope: 'local_changes' } }),
      expect.any(AbortSignal),
    );
    expect(JSON.parse(stdout.mock.calls[0]?.[0] ?? '')).toMatchObject({
      status: 'succeeded',
      output: {
        schemaVersion: 1,
        type: 'review.result',
        scope: 'local_changes',
        verdict: 'pass',
        summary: 'No reportable issues were found.',
        findings: [],
      },
    });
  });

  it('renders validated findings as comments and keeps exit code zero', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcode-exec-review-'));
    try {
      const stdout = vi.fn();
      const runtime = runtimeWith([
        {
          type: 'message',
          message: {
            id: 'review-findings',
            role: 'assistant',
            content: reviewXml,
            origin: { reviewOutcome: 'needs_changes' },
          },
        },
        { type: 'session-status', status: 'finished' },
      ]);
      const lastMessage = join(root, 'review.txt');

      await expect(
        runTuiExec(
          {
            prompt: 'Please review my uncommitted changes.',
            workspaceDir: '/tmp/workspace',
            version: '0.1.0',
            format: 'text',
            outputLastMessagePath: lastMessage,
            reviewRequest: { scope: 'local_changes' },
          },
          { runtime, stdout, stderr: vi.fn(), shutdown: async () => undefined },
        ),
      ).resolves.toBe(0);

      expect(stdout).toHaveBeenCalledWith(expect.stringContaining('[P1] Guard the value'));
      expect(stdout).toHaveBeenCalledWith(expect.stringContaining('src/demo.ts:10 (new)'));
      expect(stdout).not.toHaveBeenCalledWith(expect.stringContaining('<annotation-result'));
      expect(await readFile(lastMessage, 'utf8')).toContain('[P1] Guard the value');
      expect(await readFile(lastMessage, 'utf8')).not.toContain('<annotation-result');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('retains invalid JSON and its selected message without polluting stdout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcode-runner-diagnostics-'));
    try {
      const stdout = vi.fn();
      const runtime = runtimeWith();
      const code = await runTuiExec({
        prompt: 'Review', workspaceDir: '/tmp/workspace', version: 'test',
        format: 'json', outputSchema: { type: 'object' }, diagnosticsDir: root,
        outputLastMessagePath: join(root, 'success.txt'),
      }, { runtime, stdout, stderr: vi.fn(), shutdown: async () => false });
      expect(code).not.toBe(0);
      const result = JSON.parse(stdout.mock.calls.map(([chunk]) => chunk).join(''));
      expect(result).toMatchObject({ status: 'failed', error: { code: 'STRUCTURED_OUTPUT_INVALID' } });
      expect(await readFile(join(root, 'failure-answer.txt'), 'utf8')).toBe('fixed');
      expect(JSON.parse(await readFile(join(root, 'failure.json'), 'utf8'))).toMatchObject({
        validationKind: 'invalid_json', answerSource: 'completed_message', messageId: 'assistant-1',
      });
      await expect(readFile(join(root, 'success.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('streams rendered Review comments without exposing annotation XML', async () => {
    const stdout: string[] = [];
    const runtime = runtimeWith([
      {
        type: 'message',
        message: {
          id: 'review-findings',
          role: 'assistant',
          content: reviewXml,
          origin: { reviewOutcome: 'needs_changes' },
        },
      },
      { type: 'session-status', status: 'finished' },
    ]);

    await expect(
      runTuiExec(
        {
          prompt: 'Please review my uncommitted changes.',
          workspaceDir: '/tmp/workspace',
          version: '0.1.0',
          format: 'stream-json',
          reviewRequest: { scope: 'local_changes' },
        },
        {
          runtime,
          stdout: (value) => stdout.push(value),
          stderr: vi.fn(),
          shutdown: async () => undefined,
          createTurnId: () => 'turn-1',
        },
      ),
    ).resolves.toBe(0);

    const records = stdout
      .join('')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records).toContainEqual(
      expect.objectContaining({
        type: 'item.completed',
        item: expect.objectContaining({
          type: 'agent_message',
          content: expect.stringContaining('[P1] Guard the value'),
        }),
      }),
    );
    expect(stdout.join('')).not.toContain('<annotation-result');
    expect(records.at(-1)).toMatchObject({
      type: 'exec.completed',
      result: {
        status: 'succeeded',
        output: { type: 'review.result', verdict: 'needs_changes' },
      },
    });
  });

  it('fails when Runtime marks the Review result invalid', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const runtime = runtimeWith([
      {
        type: 'message',
        message: {
          id: 'review-invalid',
          role: 'assistant',
          content: 'The model returned an invalid review result.',
          origin: { reviewOutcome: 'failed' },
        },
      },
      { type: 'session-status', status: 'finished' },
    ]);

    await expect(
      runTuiExec(
        {
          prompt: 'Please review my uncommitted changes.',
          workspaceDir: '/tmp/workspace',
          version: '0.1.0',
          format: 'json',
          reviewRequest: { scope: 'local_changes' },
        },
        { runtime, stdout, stderr, shutdown: async () => undefined },
      ),
    ).resolves.toBe(4);

    expect(JSON.parse(stdout.mock.calls[0]?.[0] ?? '')).toMatchObject({
      status: 'failed',
      error: { code: 'REVIEW_RESULT_INVALID' },
    });
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('mcode exec failed'));
  });

  it('writes the raw final message and reports durable per-Turn model and usage facts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcode-exec-result-'));
    try {
      const stdout = vi.fn();
      const runtime = runtimeWith();
      runtime.getSessionUsage.mockResolvedValue({
        rows: [
          {
            turnId: 'turn-1',
            model: 'custom_provider:review/gpt',
            inputTokens: 10,
            outputTokens: 4,
            reasoningTokens: 2,
            cacheReadTokens: 3,
          },
        ],
      });
      runtime.listModels.mockResolvedValue([
        {
          providerId: 'custom_provider:review',
          modelId: 'gpt',
          selected: true,
          providerSource: 'custom_provider',
          providerKind: 'custom',
          apiFormat: 'openai-responses',
        },
      ]);
      const lastMessage = join(root, 'last-message.txt');

      await expect(
        runTuiExec(
          {
            prompt: 'Fix it',
            workspaceDir: '/tmp/workspace',
            version: '0.1.0',
            format: 'json',
            outputLastMessagePath: lastMessage,
          },
          {
            runtime,
            stdout,
            stderr: vi.fn(),
            shutdown: async () => undefined,
            createTurnId: () => 'turn-1',
          },
        ),
      ).resolves.toBe(0);

      expect(await readFile(lastMessage, 'utf8')).toBe('fixed');
      expect(JSON.parse(stdout.mock.calls[0]?.[0] ?? '')).toMatchObject({
        model: {
          providerId: 'custom_provider:review',
          modelId: 'gpt',
          providerSource: 'custom_provider',
          providerKind: 'custom',
          protocol: 'openai-responses',
        },
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          reasoningTokens: 2,
          cacheReadTokens: 3,
          totalTokens: 14,
        },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('publishes shutdown failure as the terminal result before writing the final message', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcode-exec-shutdown-'));
    try {
      const stdout = vi.fn();
      const lastMessage = join(root, 'last-message.txt');

      await expect(
        runTuiExec(
          {
            prompt: 'Fix it',
            workspaceDir: '/tmp/workspace',
            version: '0.1.0',
            format: 'json',
            outputLastMessagePath: lastMessage,
          },
          {
            runtime: runtimeWith(),
            stdout,
            stderr: vi.fn(),
            shutdown: async () => true,
            createTurnId: () => 'turn-1',
          },
        ),
      ).resolves.toBe(70);

      expect(JSON.parse(stdout.mock.calls[0]?.[0] ?? '')).toMatchObject({
        status: 'failed',
        error: { category: 'internal', code: 'RUNTIME_SHUTDOWN_FAILED' },
      });
      await expect(readFile(lastMessage, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails authentication before creating a Session or sending a message', async () => {
    const stderr = vi.fn();
    const runtime = runtimeWith();
    runtime.getAccountStatus.mockResolvedValue({
      status: 'needs-login',
      authMode: 'managed-login',
      modelSource: 'token-plan',
      managedTokenPresent: false,
      warnings: [],
    } as never);

    await expect(
      runTuiExec(
        { prompt: 'Fix it', workspaceDir: '/tmp/workspace', version: '0.1.0' },
        { runtime, stdout: vi.fn(), stderr, shutdown: async () => undefined },
      ),
    ).resolves.toBe(3);

    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      'mcode exec failed: Sign in to MiniMax to use Agent features. Run `mcode login`, then retry.\n',
    );
  });

  it('uses the process-local conversation request and assembles the public ExecResult', async () => {
    const stdout = vi.fn();
    const runtime = runtimeWith([
      {
        type: 'message',
        message: { id: 'assistant-1', role: 'assistant', content: '{"status":"fixed"}' },
      },
      { type: 'session-status', status: 'finished' },
    ]);
    runtime.listModels.mockResolvedValue([
      {
        providerId: 'provider',
        modelId: 'model',
        variant: 'fast',
        selected: true,
        providerSource: 'custom_provider',
        providerKind: 'custom',
        apiFormat: 'openai-responses',
      },
    ]);
    const outputSchema = {
      type: 'object',
      properties: { status: { const: 'fixed' } },
      required: ['status'],
      additionalProperties: false,
    };

    await expect(
      runTuiExec(
        {
          prompt: 'Fix it',
          workspaceDir: '/tmp/workspace',
          version: '0.1.0',
          model: 'provider/model#fast',
          permission: 'full',
          timeoutMs: 1_000,
          maxSteps: 3,
          format: 'json',
          outputSchema,
        },
        {
          runtime,
          stdout,
          stderr: vi.fn(),
          shutdown: async () => undefined,
          createTurnId: () => 'turn-1',
        },
      ),
    ).resolves.toBe(0);

    expect(runtime.setPermissionMode).not.toHaveBeenCalled();
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      {
        id: 'session-1',
        turnId: 'turn-1',
        content: 'Fix it',
        model: { providerId: 'provider', modelId: 'model', variant: 'fast' },
        outputSchema,
        executionDeadlineAtMs: expect.any(Number),
      },
      expect.any(AbortSignal),
    );
    expect(JSON.parse(stdout.mock.calls[0]?.[0] ?? '')).toMatchObject({
      schemaVersion: 1,
      type: 'exec.result',
      runId: 'exec_turn-1',
      sessionId: 'session-1',
      turnId: 'turn-1',
      status: 'succeeded',
      output: { status: 'fixed' },
      model: {
        providerId: 'provider',
        modelId: 'model',
        variant: 'fast',
        providerSource: 'custom_provider',
        providerKind: 'custom',
        protocol: 'openai-responses',
        structuredOutputMode: 'native_strict',
      },
    });
  });

  it('sends an explicit --effort as a per-Turn thinking selection', async () => {
    const stdout = vi.fn();
    const runtime = runtimeWith();
    runtime.listModels.mockResolvedValue([
      {
        providerId: 'custom_provider:work',
        modelId: 'deep-reasoner-1',
        selected: true,
        effortOptions: ['low', 'medium', 'high', 'xhigh'],
      },
    ]);

    await expect(
      runTuiExec(
        {
          prompt: 'Fix it',
          workspaceDir: '/tmp/workspace',
          version: '0.1.0',
          model: 'custom_provider:work/deep-reasoner-1',
          effort: 'xhigh',
          format: 'json',
        },
        {
          runtime,
          stdout,
          stderr: vi.fn(),
          shutdown: async () => undefined,
          createTurnId: () => 'turn-1',
        },
      ),
    ).resolves.toBe(0);

    expect(runtime.sendMessage).toHaveBeenCalledWith(
      {
        id: 'session-1',
        turnId: 'turn-1',
        content: 'Fix it',
        model: {
          providerId: 'custom_provider:work',
          modelId: 'deep-reasoner-1',
          thinking: { effort: 'xhigh' },
        },
      },
      expect.any(AbortSignal),
    );
    // The applied effort is Runtime-resolved and is not echoed back on any
    // headless channel, so the public result must not claim one.
    expect(JSON.parse(stdout.mock.calls[0]?.[0] ?? '').model).not.toHaveProperty('effort');
  });

  it('applies --effort to the Session model when --model is omitted', async () => {
    const runtime = runtimeWith();
    runtime.listModels.mockResolvedValue([
      {
        providerId: 'default-provider',
        modelId: 'default-model',
        selected: true,
        effortOptions: ['low', 'high'],
      },
    ]);

    await expect(
      runTuiExec(
        { prompt: 'Fix it', workspaceDir: '/tmp/workspace', version: '0.1.0', effort: 'high' },
        {
          runtime,
          stdout: vi.fn(),
          stderr: vi.fn(),
          shutdown: async () => undefined,
          createTurnId: () => 'turn-1',
        },
      ),
    ).resolves.toBe(0);

    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: {
          providerId: 'default-provider',
          modelId: 'default-model',
          thinking: { effort: 'high' },
        },
      }),
      expect.any(AbortSignal),
    );
  });

  /**
   * Legacy compatibility. `--model p/m#xhigh` predates `--effort`; Runtime reads
   * the suffix as a model variant and quietly applies its own strength. Callers
   * already depend on that Run starting, so it keeps running as a variant.
   */
  it('still runs a legacy effort-shaped #variant as a variant', async () => {
    const stderr = vi.fn();
    const runtime = runtimeWith();
    runtime.listModels.mockResolvedValue([
      {
        providerId: 'provider',
        modelId: 'model',
        selected: true,
        effortOptions: ['medium', 'xhigh'],
      },
    ]);

    await expect(
      runTuiExec(
        {
          prompt: 'Fix it',
          workspaceDir: '/tmp/workspace',
          version: '0.1.0',
          model: 'provider/model#xhigh',
        },
        { runtime, stdout: vi.fn(), stderr, shutdown: async () => undefined },
      ),
    ).resolves.toBe(0);

    expect(stderr).not.toHaveBeenCalled();
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { providerId: 'provider', modelId: 'model', variant: 'xhigh' },
      }),
      expect.any(AbortSignal),
    );
  });

  it('refuses --effort on a model whose thinking default is off before starting the Turn', async () => {
    const stderr = vi.fn();
    const runtime = runtimeWith();
    runtime.listModels.mockResolvedValue([
      {
        providerId: 'minimax',
        modelId: 'Official-M4',
        selected: true,
        variant: '',
        thinkingConfig: { mode: 'switchable', defaultValue: 'false' },
        effortOptions: ['low', 'high'],
      },
    ]);

    await expect(
      runTuiExec(
        {
          prompt: 'Fix it',
          workspaceDir: '/tmp/workspace',
          version: '0.1.0',
          model: 'minimax/Official-M4',
          effort: 'high',
        },
        { runtime, stdout: vi.fn(), stderr, shutdown: async () => undefined },
      ),
    ).resolves.toBe(2);

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('runs with thinking off by default'),
    );
  });

  it('rejects an unsupported effort level before starting the Turn', async () => {
    const stderr = vi.fn();
    const runtime = runtimeWith();
    runtime.listModels.mockResolvedValue([
      { providerId: 'provider', modelId: 'model', selected: true, effortOptions: ['low', 'high'] },
    ]);

    await expect(
      runTuiExec(
        {
          prompt: 'Fix it',
          workspaceDir: '/tmp/workspace',
          version: '0.1.0',
          model: 'provider/model',
          effort: 'xhigh',
        },
        { runtime, stdout: vi.fn(), stderr, shutdown: async () => undefined },
      ),
    ).resolves.toBe(2);

    expect(runtime.sendMessage).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('Available levels: low, high'));
  });

  it('streams only the versioned ExecEvent contract with one terminal result', async () => {
    const stdout: string[] = [];
    const runtime = runtimeWith();

    await expect(
      runTuiExec(
        {
          prompt: 'Fix it',
          workspaceDir: '/tmp/workspace',
          version: '0.1.0',
          format: 'stream-json',
        },
        {
          runtime,
          stdout: (value) => stdout.push(value),
          stderr: vi.fn(),
          shutdown: async () => undefined,
          createTurnId: () => 'turn-1',
        },
      ),
    ).resolves.toBe(0);

    const records = stdout.join('').trim().split('\n').map((line) => JSON.parse(line));
    expect(records.map((record) => record.type)).toEqual([
      'exec.started',
      'session.started',
      'turn.started',
      'item.completed',
      'turn.completed',
      'exec.completed',
    ]);
    expect(records.at(-1)).toMatchObject({
      type: 'exec.completed',
      result: {
        status: 'succeeded',
        model: {
          providerId: 'default-provider',
          modelId: 'default-model',
          variant: 'balanced',
        },
      },
    });
    expect(runtime.sendMessage).toHaveBeenCalledWith(
      {
        id: 'session-1',
        turnId: 'turn-1',
        content: 'Fix it',
      },
      expect.any(AbortSignal),
    );
  });

  it('preserves an empty selected-model variant in machine output', async () => {
    const stdout = vi.fn();
    const runtime = runtimeWith();
    runtime.listModels.mockResolvedValue([
      {
        providerId: 'default-provider',
        modelId: 'default-model',
        variant: '',
        selected: true,
      },
    ]);

    await expect(
      runTuiExec(
        {
          prompt: 'Fix it',
          workspaceDir: '/tmp/workspace',
          version: '0.1.0',
          format: 'json',
        },
        { runtime, stdout, stderr: vi.fn(), shutdown: async () => undefined },
      ),
    ).resolves.toBe(0);

    expect(JSON.parse(stdout.mock.calls[0]?.[0] ?? '')).toMatchObject({
      model: {
        providerId: 'default-provider',
        modelId: 'default-model',
        variant: '',
      },
    });
  });

  it('keeps execution successful when selected-model inspection is unavailable', async () => {
    const stdout = vi.fn();
    const runtime = runtimeWith();
    runtime.listModels.mockRejectedValue(new Error('model catalog unavailable'));

    await expect(
      runTuiExec(
        {
          prompt: 'Fix it',
          workspaceDir: '/tmp/workspace',
          version: '0.1.0',
          format: 'json',
        },
        { runtime, stdout, stderr: vi.fn(), shutdown: async () => undefined },
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(stdout.mock.calls[0]?.[0] ?? '')).not.toHaveProperty('model');
  });

  it('fails without aborting when Runtime bypasses the non-interactive Host gate', async () => {
    const stderr = vi.fn();
    const runtime = runtimeWith([
      { type: 'generic', eventType: 'runtime.action-required', data: { kind: 'questionnaire' } },
    ]);

    await expect(
      runTuiExec(
        { prompt: 'Fix it', workspaceDir: '/tmp/workspace', version: '0.1.0' },
        { runtime, stdout: vi.fn(), stderr, shutdown: async () => undefined },
      ),
    ).resolves.toBe(4);

    expect(runtime.abortSession).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining('requested user interaction from a non-interactive Exec host'),
    );
  });

  it('maps Runtime failure and cancellation outcomes to stable exit codes', async () => {
    const cases: Array<[readonly TuiStreamEvent[], number]> = [
      [[{ type: 'error', message: 'failed' }], 4],
      [[{ type: 'session-status', status: 'aborted' }], 130],
    ];
    for (const [events, exitCode] of cases) {
      const runtime = runtimeWith(events);
      await expect(
        runTuiExec(
          { prompt: 'Fix it', workspaceDir: '/tmp/workspace', version: '0.1.0' },
          { runtime, stdout: vi.fn(), stderr: vi.fn(), shutdown: async () => undefined },
        ),
      ).resolves.toBe(exitCode);
    }
  });

  it('aborts the exact Turn when stream-json stdout closes', async () => {
    const runtime = runtimeWith();
    runtime.sendMessage.mockImplementation(async function* (_request, signal?: AbortSignal) {
      yield { type: 'heartbeat', turnId: 'turn-1', cursor: 'c1' };
      if (!signal?.aborted) {
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
    });
    const stdout = vi.fn(async () => {
      throw Object.assign(new Error('closed'), { code: 'EPIPE' });
    });

    await expect(
      runTuiExec(
        {
          prompt: 'Fix it',
          workspaceDir: '/tmp/workspace',
          version: '0.1.0',
          format: 'stream-json',
        },
        {
          runtime,
          stdout,
          stderr: vi.fn(),
          shutdown: async () => undefined,
          createTurnId: () => 'turn-1',
        },
      ),
    ).resolves.toBe(141);
    expect(runtime.abortSession).toHaveBeenCalledWith({
      id: 'session-1',
      turnId: 'turn-1',
      reason: 'user_stop',
    });
  });

  it('aborts the Runtime conversation when the process receives SIGINT', async () => {
    const processRef = new EventEmitter();
    const started = vi.fn();
    const runtime = runtimeWith();
    runtime.sendMessage.mockImplementation(async function* pendingMessage(
      _req,
      signal?: AbortSignal,
    ) {
      yield* [];
      started();
      await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
    });

    const executing = runTuiExec(
      { prompt: 'Fix it', workspaceDir: '/tmp/workspace', version: '0.1.0' },
      {
        runtime,
        processRef: processRef as unknown as Pick<NodeJS.Process, 'once' | 'off'>,
        stderr: vi.fn(),
        shutdown: async () => undefined,
      },
    );
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    processRef.emit('SIGINT');

    await expect(executing).resolves.toBe(130);
    expect(runtime.abortSession).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1', reason: 'user_stop' }),
    );
  });

  describe('when the stdout reader stops reading', () => {
    function streamingUntilAbort() {
      const runtime = runtimeWith();
      runtime.sendMessage.mockImplementation(async function* (_req, signal?: AbortSignal) {
        yield { type: 'delta', role: 'assistant', content: 'partial answer' };
        if (!signal?.aborted) {
          await new Promise<void>((resolve) =>
            signal?.addEventListener('abort', () => resolve(), { once: true }),
          );
        }
      });
      return runtime;
    }

    // Every write stays pending, like a pipe whose reader never reads again.
    const blockedStdout = () => vi.fn(() => new Promise<void>(() => undefined));

    it('still returns after SIGTERM instead of waiting for the reader', async () => {
      const processRef = new EventEmitter();
      const runtime = streamingUntilAbort();
      const stdout = blockedStdout();

      const executing = runTuiExec(
        { prompt: 'Fix it', workspaceDir: '/tmp/workspace', version: '0.1.0', format: 'stream-json' },
        {
          runtime,
          stdout,
          stderr: vi.fn(),
          shutdown: async () => undefined,
          processRef: processRef as unknown as Pick<NodeJS.Process, 'once' | 'off'>,
          createTurnId: () => 'turn-1',
          stopOutputGraceMs: 10,
        },
      );
      await vi.waitFor(() => expect(stdout).toHaveBeenCalled());
      processRef.emit('SIGTERM');

      await expect(executing).resolves.toBe(130);
      expect(runtime.abortSession).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'session-1', turnId: 'turn-1', reason: 'user_stop' }),
      );
      expect(processRef.listenerCount('SIGTERM')).toBe(0);
    });

    it('still honors --timeout and returns the timeout code', async () => {
      const runtime = streamingUntilAbort();

      await expect(
        runTuiExec(
          {
            prompt: 'Fix it',
            workspaceDir: '/tmp/workspace',
            version: '0.1.0',
            format: 'stream-json',
            timeoutMs: 30,
          },
          {
            runtime,
            stdout: blockedStdout(),
            stderr: vi.fn(),
            shutdown: async () => undefined,
            createTurnId: () => 'turn-1',
            stopOutputGraceMs: 10,
          },
        ),
      ).resolves.toBe(6);
      expect(runtime.abortSession).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'timeout' }),
      );
    });
  });

  it('keeps the terminal result last when a cancelled run can still drain slow output', async () => {
    const processRef = new EventEmitter();
    const started = vi.fn();
    const runtime = runtimeWith();
    runtime.sendMessage.mockImplementation(async function* (_req, signal?: AbortSignal) {
      yield { type: 'delta', role: 'assistant', content: 'partial answer' };
      started();
      if (!signal?.aborted) {
        await new Promise<void>((resolve) =>
          signal?.addEventListener('abort', () => resolve(), { once: true }),
        );
      }
    });
    const lines: string[] = [];
    // A slow but live reader: each line drains a little later.
    const stdout = vi.fn(
      (line: string) =>
        new Promise<void>((resolve) =>
          setTimeout(() => {
            lines.push(line);
            resolve();
          }, 5),
        ),
    );
    const executing = runTuiExec(
      { prompt: 'Fix it', workspaceDir: '/tmp/workspace', version: '0.1.0', format: 'stream-json' },
      {
        runtime,
        stdout,
        stderr: vi.fn(),
        shutdown: async () => undefined,
        processRef: processRef as unknown as Pick<NodeJS.Process, 'once' | 'off'>,
        createTurnId: () => 'turn-1',
      },
    );
    await vi.waitFor(() => expect(started).toHaveBeenCalledOnce());
    processRef.emit('SIGINT');

    await expect(executing).resolves.toBe(130);
    const records = lines.map((line) => JSON.parse(line));
    expect(records.at(-1)).toMatchObject({ type: 'exec.completed', result: { status: 'cancelled' } });
    expect(records.filter((record) => record.type === 'exec.completed')).toHaveLength(1);
  });

  it('reuses a valid Session and continues the latest workspace Session', async () => {
    const direct = runtimeWith();
    await runTuiExec(
      {
        prompt: 'Continue',
        workspaceDir: '/tmp/workspace',
        version: '0.1.0',
        sessionId: 'session-1',
      },
      { runtime: direct, stdout: vi.fn(), stderr: vi.fn(), shutdown: async () => undefined },
    );
    expect(direct.createSession).not.toHaveBeenCalled();

    const continued = runtimeWith();
    continued.listSessionPage
      .mockResolvedValueOnce({
        sessions: [{ sessionId: 'other', workspaceDir: '/tmp/other' }],
        hasMore: true,
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        sessions: [{ sessionId: 'session-1', workspaceDir: '/tmp/workspace' }],
        hasMore: false,
      });
    await runTuiExec(
      {
        prompt: 'Continue',
        workspaceDir: '/tmp/workspace',
        version: '0.1.0',
        continueSession: true,
      },
      { runtime: continued, stdout: vi.fn(), stderr: vi.fn(), shutdown: async () => undefined },
    );
    expect(continued.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'session-1' }),
      expect.any(AbortSignal),
    );
  });

  it.each([
    ['questionnaire', { questionnaire: true, permission: false }],
    ['permission', { questionnaire: false, permission: true }],
  ] as const)(
    'refuses a resumed Session with a pending %s without mutating it',
    async (_interaction, pending) => {
      const stderr = vi.fn();
      const runtime = runtimeWith();
      if (pending.questionnaire) {
        runtime.getPendingQuestionnaire.mockResolvedValue({
          requestId: 'question-1',
          sessionId: 'session-1',
        } as never);
      }
      if (pending.permission) {
        runtime.listPendingPermissions.mockResolvedValue([
          { requestId: 'permission-1', sessionId: 'session-1' },
        ]);
      }

      await expect(
        runTuiExec(
          {
            prompt: 'Continue',
            workspaceDir: '/tmp/workspace',
            version: '0.1.0',
            sessionId: 'session-1',
          },
          { runtime, stdout: vi.fn(), stderr, shutdown: async () => undefined },
        ),
      ).resolves.toBe(4);

      expect(runtime.sendMessage).not.toHaveBeenCalled();
      expect(runtime.abortSession).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('requires an interactive host'),
      );
    },
  );

  it('rejects archived, cross-workspace, and internal Sessions before send', async () => {
    for (const session of [
      { sessionId: 'session-1', workspaceDir: '/tmp/workspace', archived: true },
      { sessionId: 'session-1', workspaceDir: '/tmp/other', archived: false },
      {
        sessionId: 'session-1',
        agentName: 'explore',
        sessionType: 'root' as const,
        workspaceDir: '/tmp/workspace',
      },
    ]) {
      const runtime = runtimeWith();
      runtime.getSession.mockResolvedValue(session);
      const code = await runTuiExec(
        {
          prompt: 'Continue',
          workspaceDir: '/tmp/workspace',
          version: '0.1.0',
          sessionId: 'session-1',
        },
        { runtime, stdout: vi.fn(), stderr: vi.fn(), shutdown: async () => undefined },
      );
      expect(code).not.toBe(0);
      expect(runtime.sendMessage).not.toHaveBeenCalled();
    }
  });

  it('does not replace a missing explicit session with a new or recent session', async () => {
    const runtime = runtimeWith();
    runtime.getSession.mockRejectedValue(new Error('Session does not exist'));
    const code = await runTuiExec({
      prompt: 'Summarize', workspaceDir: '/tmp/workspace', version: 'test', sessionId: 'missing',
    }, { runtime, stdout: vi.fn(), stderr: vi.fn(), shutdown: async () => undefined });
    expect(code).not.toBe(0);
    expect(runtime.createSession).not.toHaveBeenCalled();
    expect(runtime.listSessionPage).not.toHaveBeenCalled();
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });
});
