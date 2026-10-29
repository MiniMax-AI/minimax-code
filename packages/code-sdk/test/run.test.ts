import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MCodeAbortError, MCodeRunError, ThreadBusyError, type ThreadItem } from '../src/index.js';
import { ExecProcess } from '../src/exec-process.js';
import { FAKE_MCODE, fakeClient, fixture, readRecord, tempDir } from './helpers.js';

const SUCCESS_SESSION = 'mvs_2bab54bd1f17409e968db62f8ed2784a';
const posixOnly = process.platform === 'win32' ? it.skip : it;

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('thread.run', () => {
  it('resolves a successful Turn with items merged by id', async () => {
    const mcode = fakeClient({ FAKE_MCODE_FIXTURE: fixture('success-tools') });
    const thread = mcode.startThread({ cwd: tempDir() });
    expect(thread.id).toBeNull();

    const turn = await thread.run('Read note.txt and write its uppercase content to out.txt.');

    expect(thread.id).toBe(SUCCESS_SESSION);
    expect(turn.status).toBe('succeeded');
    expect(turn.sessionId).toBe(SUCCESS_SESSION);
    expect(turn.turnId).toBe('turn_mvri9x2c_ffy2ij');
    expect(turn.finalResponse).toMatch(
      /^Created `out.txt` with the uppercase content "HELLO SDK"/u,
    );
    expect(turn.usage).toEqual({
      inputTokens: 25815,
      outputTokens: 157,
      cacheReadTokens: 52166,
      totalTokens: 25972,
    });
    expect(turn.model?.modelId).toBe('MiniMax-M3');
    expect(turn.result.status).toBe('succeeded');

    // The first message completes after both tool calls started; order is first appearance.
    expect(turn.items.map(summary)).toEqual([
      'agent_message:49aa967a-62c0-46ca-9577-5934d3f2a572:message',
      'tool_call:call_function_0429v80y2s4q_1:read',
      'tool_call:call_function_0429v80y2s4q_2:bash',
      'tool_call:call_function_wkdubj76wqb4_1:write',
      'agent_message:d645b561-b951-4ccb-b2bb-767c2f75925b:message',
    ]);
    expect(turn.items.some((item) => item.incomplete)).toBe(false);
    const [firstMessage, read] = turn.items;
    expect(firstMessage).toMatchObject({ text: "I'll check the workspace and note file first." });
    expect(read).toMatchObject({ toolCall: { status: 2, input: { path: 'note.txt' } } });
  });

  it('rejects with MCodeRunError carrying the full result when the run fails (exit 4)', async () => {
    const mcode = fakeClient({
      FAKE_MCODE_FIXTURE: fixture('failed-upstream'),
      FAKE_MCODE_EXIT: '4',
      FAKE_MCODE_STDERR: 'mcode exec failed: The run failed: upstream error: 429',
    });
    const thread = mcode.startThread();

    const error = await thread.run('hello').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MCodeRunError);
    const runError = error as MCodeRunError;
    expect(runError.status).toBe('failed');
    expect(runError.category).toBe('runtime');
    expect(runError.retryable).toBe(true);
    expect(runError.exitCode).toBe(4);
    expect(runError.stderr).toContain('429');
    expect(runError.message).toContain('429');
    expect(runError.result?.status).toBe('failed');
    expect(runError.sessionId).toBe('mvs_8d8ee44bc4994c1cacd3af0aa64d7a0a');
    // A failed first Turn still yields a Session the caller can resume.
    expect(thread.id).toBe('mvs_8d8ee44bc4994c1cacd3af0aa64d7a0a');
  });

  it('continues an existing Session with --session', async () => {
    const record = `${tempDir()}/record.json`;
    const mcode = fakeClient({ FAKE_MCODE_FIXTURE: fixture('resumed'), FAKE_MCODE_RECORD: record });
    const thread = mcode.resumeThread(SUCCESS_SESSION, { model: 'minimax/MiniMax-M3' });

    const turn = await thread.run('What exactly did you write?');

    expect(thread.id).toBe(SUCCESS_SESSION);
    expect(turn.turnId).toBe('turn_mvrib48y_693m74');
    expect(turn.finalResponse).toMatch(/^I wrote exactly:/u);
    const { argv } = readRecord(record);
    expect(argv).toContain(`--session=${SUCCESS_SESSION}`);
    expect(argv).toContain('--model=minimax/MiniMax-M3');
  });

  it('continues its own Session on the next Turn and keeps the creation-only mode off it', async () => {
    const record = `${tempDir()}/record.json`;
    const mcode = fakeClient({
      FAKE_MCODE_FIXTURE: fixture('success-tools'),
      FAKE_MCODE_RECORD: record,
    });
    const thread = mcode.startThread({ mode: 'lightweight' });

    await thread.run('first');
    const first = readRecord(record).argv;
    expect(first).toContain('--mode=lightweight');
    expect(first.some((arg) => arg.startsWith('--session'))).toBe(false);

    await thread.run('second');
    const second = readRecord(record).argv;
    expect(second).toContain(`--session=${SUCCESS_SESSION}`);
    expect(second.some((arg) => arg.startsWith('--mode'))).toBe(false);
  });

  posixOnly('cancels with SIGTERM and rejects with an AbortError', async () => {
    const signalLog = `${tempDir()}/signal.txt`;
    const mcode = fakeClient({
      FAKE_MCODE_FIXTURE: fixture('cancelled'),
      FAKE_MCODE_MODE: 'wait-sigint',
      FAKE_MCODE_SPLIT: '9',
      FAKE_MCODE_SIGNAL_LOG: signalLog,
    });
    const thread = mcode.startThread();
    const controller = new AbortController();

    const pending = thread.run('sleep 60', { signal: controller.signal });
    await waitFor(() => thread.id !== null);
    controller.abort();
    const error = await pending.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MCodeAbortError);
    const abort = error as MCodeAbortError;
    expect(abort.name).toBe('AbortError');
    expect(abort.exitCode).toBe(130);
    expect(abort.result?.status).toBe('cancelled');
    expect(readFileSync(signalLog, 'utf8')).toBe('SIGTERM');
    expect(abort.sessionId).toBe('mvs_78b922a823a345728486967e33c95770');
    // Neither the message nor the tool call received item.completed before cancellation.
    expect(abort.items.map((item) => [item.type, item.incomplete])).toEqual([
      ['agent_message', true],
      ['tool_call', true],
    ]);
  });

  it('honors an abort that fires while prompt files are being prepared', async () => {
    const record = `${tempDir()}/record.json`;
    const mcode = fakeClient({ FAKE_MCODE_FIXTURE: fixture('resumed'), FAKE_MCODE_RECORD: record });
    await mcode.startThread().run('warm up the cached CLI check');

    const controller = new AbortController();
    const pending = mcode
      .startThread({ appendSystemPrompt: 'x' })
      .run('go', { signal: controller.signal });
    setImmediate(() => controller.abort());

    await expect(pending).rejects.toBeInstanceOf(MCodeAbortError);
  });

  posixOnly('interrupts a process started with an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const exec = new ExecProcess({
      command: { command: process.execPath, args: [FAKE_MCODE, 'exec'] },
      env: {
        PATH: process.env.PATH,
        FAKE_MCODE_FIXTURE: fixture('cancelled'),
        FAKE_MCODE_MODE: 'hang',
      },
      prompt: 'x',
      signal: controller.signal,
    });

    const consume = async (): Promise<void> => {
      for await (const event of exec.events()) void event;
    };
    await expect(consume()).rejects.toBeInstanceOf(MCodeAbortError);
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const record = `${tempDir()}/record.json`;
    const mcode = fakeClient({ FAKE_MCODE_RECORD: record });
    const controller = new AbortController();
    controller.abort();

    await expect(
      mcode.startThread().run('never', { signal: controller.signal }),
    ).rejects.toBeInstanceOf(MCodeAbortError);
  });

  posixOnly('rejects a concurrent Turn on the same Thread with ThreadBusyError', async () => {
    const mcode = fakeClient({
      FAKE_MCODE_FIXTURE: fixture('cancelled'),
      FAKE_MCODE_MODE: 'wait-sigint',
      FAKE_MCODE_SPLIT: '4',
    });
    const thread = mcode.startThread();
    const controller = new AbortController();
    const first = thread.run('one', { signal: controller.signal }).catch((error: unknown) => error);
    await waitFor(() => thread.id !== null);

    await expect(thread.run('two')).rejects.toBeInstanceOf(ThreadBusyError);
    await expect(thread.runStreamed('three')).rejects.toBeInstanceOf(ThreadBusyError);

    controller.abort();
    expect(await first).toBeInstanceOf(MCodeAbortError);
    // The Thread accepts a new Turn once the previous process has exited.
    await waitFor(() => (thread as unknown as { busy: boolean }).busy === false);
  });
});

function summary(item: ThreadItem): string {
  return item.type === 'tool_call'
    ? `${item.type}:${item.id}:${String(item.toolCall.name)}`
    : `${item.type}:${item.id}`;
}
