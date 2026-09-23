import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BashOperations } from '@earendil-works/pi-coding-agent/tools';
import { resolveBashEnvPolicy } from '@mavis/agent-core/bash-subprocess-env';
import type { LocalSandboxInvocationIdentity } from '@mavis/agent-tools/desktop';

import { createLocalBackgroundBashExecutor } from './executor.js';

const identity: LocalSandboxInvocationIdentity = {
  operationClass: 'managed_foreground',
  invocationId: 'task-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  toolCallId: 'tool-1',
  taskId: 'task-1',
};

it('streams a single complete log while returning bounded original head and tail', async () => {
  const raw = Buffer.from(`FIRST汉${'中文'.repeat(20_000)}LAST末`);
  let persisted = '';
  let bytes = 0;
  const executor = createLocalBackgroundBashExecutor(
    {
      create: () => ({
        separatesOutputStreams: true,
        exec: async (_command, _cwd, options) => {
          for (let i = 0; i < raw.length; i += 31)
            options.onData(raw.subarray(i, i + 31), 'stdout');
          return { exitCode: 7 };
        },
      }),
    },
    { mode: 'off' },
  );
  const result = await executor.execute({
    identity,
    workspaceRoot: process.cwd(),
    command: 'test',
    signal: new AbortController().signal,
    onOutput: (text, byteLength) => {
      persisted += text;
      bytes += byteLength ?? 0;
    },
  });
  expect(persisted).toBe(raw.toString('utf8'));
  expect(bytes).toBe(raw.length);
  expect(result.text).toContain('FIRST汉');
  expect(result.text).toContain('LAST末');
  expect(result.text).not.toContain('�');
  expect(Buffer.byteLength(result.text)).toBeLessThan(24 * 1024);
  expect(result.isError).toBe(true);
  expect(result.details?.fullOutputPath).toBeUndefined();
  expect(result.details?.output).toMatchObject({ rawBytes: raw.length, persistence: 'host' });
});

describe('createLocalBackgroundBashExecutor', () => {
  const seeded: string[] = [];

  afterEach(() => {
    for (const name of seeded.splice(0)) delete process.env[name];
  });

  it('hands the running callback to the operations path instead of firing it first', async () => {
    const events: string[] = [];
    const onPreflightComplete = () => {
      events.push('preflight');
    };
    const create = vi.fn(
      (input: { onPreflightComplete?: () => void | Promise<void> }): BashOperations => ({
        separatesOutputStreams: true,
        exec: async (_command, _cwd, options) => {
          await input.onPreflightComplete?.();
          events.push('exec');
          options.onData(Buffer.from('ok'), 'stdout');
          return { exitCode: 0 };
        },
      }),
    );
    const executor = createLocalBackgroundBashExecutor({ create }, { mode: 'off' });

    const result = await executor.execute({
      identity,
      workspaceRoot: process.cwd(),
      command: 'echo ok',
      signal: new AbortController().signal,
      onPreflightComplete,
    });

    expect(create).toHaveBeenCalledWith({
      identity,
      workspaceRoot: process.cwd(),
      onPreflightComplete,
    });
    expect(events).toEqual(['preflight', 'exec']);
    expect(result.text).toContain('ok');
    expect(result.details).toMatchObject({
      execution: { status: 'succeeded', reason: 'exited', exitCode: 0 },
      processOutput: { stdout: 'ok', stderr: '', exitCode: 0 },
    });
  });

  it('returns failed execution facts and split output without losing them to an exception', async () => {
    const executor = createLocalBackgroundBashExecutor(
      {
        create: () => ({
          separatesOutputStreams: true,
          exec: async (_command, _cwd, options) => {
            options.onData(Buffer.from('out'), 'stdout');
            options.onData(Buffer.from('err'), 'stderr');
            return { exitCode: 7 };
          },
        }),
      },
      { mode: 'off' },
    );
    const result = await executor.execute({
      identity,
      workspaceRoot: process.cwd(),
      command: 'unused',
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      isError: true,
      details: {
        execution: { status: 'failed', reason: 'exited', exitCode: 7 },
        processOutput: { stdout: 'out', stderr: 'err', exitCode: 7 },
      },
    });
    expect(result.text).toContain('Command exited with code 7');
  });

  it('never marks the task running when the operations factory rejects admission', async () => {
    const onPreflightComplete = vi.fn();
    const admissionFailure = new Error('Sandbox Bash operations are unavailable');
    const executor = createLocalBackgroundBashExecutor(
      {
        create: () => {
          throw admissionFailure;
        },
      },
      { mode: 'off' },
    );

    await expect(
      executor.execute({
        identity,
        workspaceRoot: process.cwd(),
        command: 'echo ok',
        signal: new AbortController().signal,
        onPreflightComplete,
      }),
    ).rejects.toBe(admissionFailure);
    expect(onPreflightComplete).not.toHaveBeenCalled();
  });

  it('preserves a sandbox preflight error code without marking execution as started', async () => {
    const onPreflightComplete = vi.fn();
    const executor = createLocalBackgroundBashExecutor(
      {
        create: () => ({
          exec: async () => {
            throw Object.assign(new Error('Sandbox wrapping failed'), {
              code: 'SANDBOX_WRAP_FAILED',
              stage: 'pre-spawn',
            });
          },
        }),
      },
      { mode: 'off' },
    );
    const result = await executor.execute({
      identity,
      workspaceRoot: process.cwd(),
      command: 'unused',
      signal: new AbortController().signal,
      onPreflightComplete,
    });
    expect(result).toMatchObject({
      isError: true,
      text: 'Sandbox wrapping failed',
      details: {
        execution: {
          status: 'failed',
          reason: 'preflight_failed',
          exitCode: null,
          errorCode: 'SANDBOX_WRAP_FAILED',
        },
      },
    });
    expect(onPreflightComplete).not.toHaveBeenCalled();
  });

  it('keeps the shared Bash env sanitizer in the moved executor', async () => {
    process.env.MAVIS_BASH_ENV_SANITIZE = 'strict';
    process.env.MAVIS_ACCESS_TOKEN = 'background-boundary-secret';
    process.env.SANDBOX_BACKGROUND_SECRET_TOKEN = 'background-pattern-secret';
    process.env.SANDBOX_BACKGROUND_KEEP = 'background-visible';
    seeded.push(
      'MAVIS_BASH_ENV_SANITIZE',
      'MAVIS_ACCESS_TOKEN',
      'SANDBOX_BACKGROUND_SECRET_TOKEN',
      'SANDBOX_BACKGROUND_KEEP',
    );
    let childEnv: NodeJS.ProcessEnv | undefined;
    const executor = createLocalBackgroundBashExecutor(
      {
        create: () => ({
          exec: async (_command, _cwd, options) => {
            childEnv = options.env;
            return { exitCode: 0 };
          },
        }),
      },
      // The moved executor must keep honouring the shared resolution chain
      // (MAVIS_BASH_ENV_SANITIZE seeded above), now supplied by the caller.
      resolveBashEnvPolicy(),
    );

    const result = await executor.execute({
      identity: { ...identity, operationClass: 'explicit_background' },
      workspaceRoot: process.cwd(),
      command: 'true',
      signal: new AbortController().signal,
    });

    expect(childEnv?.MAVIS_ACCESS_TOKEN).toBeUndefined();
    expect(childEnv?.SANDBOX_BACKGROUND_SECRET_TOKEN).toBeUndefined();
    expect(childEnv?.SANDBOX_BACKGROUND_KEEP).toBe('background-visible');
    expect(result.details?.envSanitized).toEqual(
      expect.arrayContaining(['MAVIS_ACCESS_TOKEN', 'SANDBOX_BACKGROUND_SECRET_TOKEN']),
    );
  });
});
