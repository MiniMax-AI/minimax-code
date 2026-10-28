import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';

import {
  MCodeAbortError,
  MCodeInvocationError,
  MCodeProtocolError,
  MCodeRunError,
} from '../src/index.js';
import { processTimings } from '../src/exec-process.js';
import { fakeClient, fixture, tempDir } from './helpers.js';

const posixOnly = process.platform === 'win32' ? it.skip : it;

async function failureFor(
  exitCode: number,
  stderr = 'mcode exec failed: details',
): Promise<unknown> {
  const mcode = fakeClient({ FAKE_MCODE_EXIT: String(exitCode), FAKE_MCODE_STDERR: stderr });
  return mcode
    .startThread()
    .run('x')
    .catch((error: unknown) => error);
}

describe('exit code mapping without exec.completed', () => {
  it('maps exit 2 to MCodeInvocationError with the CLI message', async () => {
    const error = await failureFor(2, 'error: --effort must be one of low, medium, high');
    expect(error).toBeInstanceOf(MCodeInvocationError);
    expect((error as MCodeInvocationError).message).toContain('--effort must be one of');
    expect((error as MCodeInvocationError).exitCode).toBe(2);
  });

  it.each([
    [3, 'failed', 'config'],
    [4, 'failed', 'runtime'],
    [6, 'timeout', undefined],
    [7, 'limit_exceeded', undefined],
    [70, 'failed', 'internal'],
  ] as const)('maps exit %i to MCodeRunError(status=%s)', async (code, status, category) => {
    const error = await failureFor(code);
    expect(error).toBeInstanceOf(MCodeRunError);
    expect((error as MCodeRunError).status).toBe(status);
    expect((error as MCodeRunError).category).toBe(category);
    expect((error as MCodeRunError).result).toBeUndefined();
    expect((error as MCodeRunError).stderr).toContain('details');
  });

  it('maps exit 130 to MCodeAbortError', async () => {
    const error = await failureFor(130);
    expect(error).toBeInstanceOf(MCodeAbortError);
    expect((error as Error).name).toBe('AbortError');
  });

  it.each([141, 0])('maps exit %i to MCodeProtocolError', async (code) => {
    expect(await failureFor(code)).toBeInstanceOf(MCodeProtocolError);
  });
});

describe('failures before exec.completed keep the observed Session', () => {
  it('reports the sessionId from exec.started when the CLI exits 4 without a result', async () => {
    const path = `${tempDir()}/started-only.jsonl`;
    const lines = readFileSync(fixture('failed-upstream'), 'utf8').split('\n').slice(0, 3);
    writeFileSync(path, `${lines.join('\n')}\n`);

    const error = await fakeClient({ FAKE_MCODE_FIXTURE: path, FAKE_MCODE_EXIT: '4' })
      .startThread()
      .run('x')
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MCodeRunError);
    expect((error as MCodeRunError).result).toBeUndefined();
    expect((error as MCodeRunError).sessionId).toBe('mvs_8d8ee44bc4994c1cacd3af0aa64d7a0a');
  });

  it('falls back to the resumed Session id when the CLI emitted no event', async () => {
    const error = await fakeClient({ FAKE_MCODE_EXIT: '3' })
      .resumeThread('mvs_resumed')
      .run('x')
      .catch((caught: unknown) => caught);
    expect((error as MCodeRunError).sessionId).toBe('mvs_resumed');
  });
});

describe('process exit with inherited pipes', () => {
  const grandchildren: number[] = [];
  afterEach(() => {
    for (const pid of grandchildren.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  });

  it('settles shortly after the CLI exits even if a grandchild keeps stdout open', async () => {
    const pidFile = `${tempDir()}/grandchild.pid`;
    const mcode = fakeClient({
      FAKE_MCODE_FIXTURE: fixture('resumed'),
      FAKE_MCODE_GRANDCHILD_PID: pidFile,
    });
    const started = Date.now();

    const turn = await mcode.startThread().run('go', { timeoutMs: 1_000 });

    if (existsSync(pidFile)) grandchildren.push(Number(readFileSync(pidFile, 'utf8')));
    // The grandchild lives for 30s; the SDK drains for at most processTimings.exitDrainMs (2s).
    expect(Date.now() - started).toBeLessThan(processTimings.exitDrainMs + 3_000);
    // All lines written before exit are still delivered, including exec.completed.
    expect(turn.finalResponse).toMatch(/^I wrote exactly/u);
    expect(grandchildren).toHaveLength(1);
  });
});

describe('cancellation escalation and timeout backstop', () => {
  posixOnly('escalates SIGINT to SIGTERM and SIGKILL when the CLI ignores signals', async () => {
    const original = { ...processTimings };
    Object.assign(processTimings, { interruptGraceMs: 50, terminateGraceMs: 50 });
    try {
      const mcode = fakeClient({
        FAKE_MCODE_FIXTURE: fixture('cancelled'),
        FAKE_MCODE_MODE: 'ignore-signals',
        FAKE_MCODE_SPLIT: '5',
      });
      const thread = mcode.startThread();
      const controller = new AbortController();
      const pending = thread
        .run('x', { signal: controller.signal })
        .catch((error: unknown) => error);
      while (thread.id === null) await new Promise((resolve) => setTimeout(resolve, 10));
      controller.abort();

      const error = await pending;
      expect(error).toBeInstanceOf(MCodeAbortError);
      expect((error as MCodeAbortError).signal).toBe('SIGKILL');
      expect((error as MCodeAbortError).sessionId).toBe('mvs_78b922a823a345728486967e33c95770');
      // Items seen before the kill are kept for diagnosis even without a result.
      expect((error as MCodeAbortError).items).toEqual([
        expect.objectContaining({ type: 'agent_message', incomplete: true }),
      ]);
    } finally {
      Object.assign(processTimings, original);
    }
  });

  posixOnly('force-stops a CLI that outlives timeoutMs and reports status timeout', async () => {
    const original = { ...processTimings };
    Object.assign(processTimings, { backstopExtraMs: 50 });
    try {
      const mcode = fakeClient({
        FAKE_MCODE_FIXTURE: fixture('cancelled'),
        FAKE_MCODE_MODE: 'hang',
      });
      const error = await mcode
        .startThread()
        .run('x', { timeoutMs: 100 })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MCodeRunError);
      expect((error as MCodeRunError).status).toBe('timeout');
      expect((error as MCodeRunError).signal).toBe('SIGKILL');
    } finally {
      Object.assign(processTimings, original);
    }
  });
});
