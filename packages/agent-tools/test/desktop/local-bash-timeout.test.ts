import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';

import { LocalBashToolDef } from '../../src/desktop/builtin-defs.js';
import { createLocalBashToolDefinition } from '../../src/desktop/local-bash-contract.js';
import {
  DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS,
  DEFAULT_FOREGROUND_BASH_SOFT_YIELD_MS,
  LocalBashTool,
  MAX_FOREGROUND_BASH_TIMEOUT_SECONDS,
  resolveForegroundTimeout,
} from '../../src/desktop/local-pi-tools.js';
import type {
  LocalBashAdapter,
  LocalBashBackgroundStartResult,
  LocalRuntimeToolContext,
  LocalSandboxBashOperationsFactory,
} from '../../src/desktop/types.js';

const SESSION_CTX = {
  sessionId: 'sess-test',
  turnId: 'turn-test',
} satisfies LocalRuntimeToolContext;

function timeoutDescription(): string {
  const props = (LocalBashToolDef.schema as { properties: Record<string, { description?: string }> })
    .properties;
  return props.timeout?.description ?? '';
}

describe('resolveForegroundTimeout (bounded foreground helper)', () => {
  // TS-1 (P0): omitted timeout → 120s default.
  it('defaults to 120 seconds when timeout is omitted', () => {
    expect(resolveForegroundTimeout({})).toBe(120);
    expect(resolveForegroundTimeout({})).toBe(DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS);
    expect(DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS).toBe(120);
  });

  it('defaults to 120 seconds when timeout is explicitly undefined', () => {
    expect(resolveForegroundTimeout({ timeout: undefined })).toBe(120);
  });

  it('honors a positive timeout up to the 300-second foreground cap', () => {
    expect(resolveForegroundTimeout({ timeout: 5 })).toBe(5);
    expect(resolveForegroundTimeout({ timeout: 100000 })).toBe(300);
    expect(MAX_FOREGROUND_BASH_TIMEOUT_SECONDS).toBe(300);
  });

  it.each([0, -5, NaN, Infinity, 2_147_484])('rejects an invalid timeout %s before execution', (timeout) => {
    expect(() => resolveForegroundTimeout({ timeout })).toThrow('finite positive');
  });

  it('preserves fractional seconds', () => {
    expect(resolveForegroundTimeout({ timeout: 0.125 })).toBe(0.125);
  });
});

it('requires a positive timeout in the shared schema', () => {
  expect(Value.Check(LocalBashToolDef.schema, { description: '运行测试命令', command: 'echo ok', timeout: 0.5 })).toBe(true);
  expect(Value.Check(LocalBashToolDef.schema, { description: '运行测试命令', command: 'echo ok', timeout: 0 })).toBe(false);
});

describe('LocalBashTool input timing contract', () => {
  it.each([null, 42, false])('rejects non-string description %j before dispatch', async (description) => {
    const startBackground = vi.fn();
    const runManagedForeground = vi.fn();
    const tool = new LocalBashTool('/tmp/workspace', { startBackground, runManagedForeground }, { mode: 'off' });
    const input = { command: 'echo ok', description };
    expect(Value.Check(LocalBashToolDef.schema, input)).toBe(false);
    const result = await tool.execute({ ...SESSION_CTX, canConsumeBackgroundBashOutput: true }, input as never);
    expect(result).toMatchObject({ isError: true, details: { error_code: 'BASH_INVALID_INPUT' } });
    expect(startBackground).not.toHaveBeenCalled();
    expect(runManagedForeground).not.toHaveBeenCalled();
  });

  it.each([undefined, ''])('uses the command when description is %j', async (description) => {
    const startBackground = vi.fn(async () => ({ status: 'started' as const, taskId: 'task-description' }));
    const tool = new LocalBashTool('/tmp/workspace', { startBackground }, { mode: 'off' });
    const result = await tool.execute({ ...SESSION_CTX, canConsumeBackgroundBashOutput: true }, {
      command: 'echo exact', description, run_in_background: true,
    });
    expect(startBackground.mock.calls[0]?.[1]).toMatchObject({ command: 'echo exact', description: 'echo exact' });
    expect(result.details?.description).toBe('echo exact');
  });

  it('keeps the purpose separate from the executable command', async () => {
    const startBackground = vi.fn(async () => ({ status: 'started' as const, taskId: 'task-description' }));
    const tool = new LocalBashTool('/tmp/workspace', { startBackground }, { mode: 'off' });
    const result = await tool.execute({ ...SESSION_CTX, canConsumeBackgroundBashOutput: true }, {
      command: ' echo exact ', description: '检查工作区状态', run_in_background: true,
    });
    expect(startBackground.mock.calls[0]?.[1]).toMatchObject({ command: ' echo exact ', description: '检查工作区状态' });
    expect(result.text).toContain('Purpose: 检查工作区状态');
    expect(result.details?.description).toBe('检查工作区状态');
  });

  it.each([false, true])('rejects invalid parameters without dispatching (background=%s)', async (background) => {
    const startBackground = vi.fn();
    const runManagedForeground = vi.fn();
    const tool = new LocalBashTool('/tmp/workspace', { startBackground, runManagedForeground }, { mode: 'off' });
    for (const input of [{ description: '运行测试命令', command: 'echo ok', timeout: 0 }, { description: '运行测试命令', command: 'echo ok', timeout: Infinity }, { description: '运行测试命令', command: '   ' }]) {
      const result = await tool.execute({ ...SESSION_CTX, canConsumeBackgroundBashOutput: true }, { ...input, run_in_background: background });
      expect(result).toMatchObject({ isError: true, details: { error_code: 'BASH_INVALID_INPUT' } });
    }
    expect(startBackground).not.toHaveBeenCalled();
    expect(runManagedForeground).not.toHaveBeenCalled();
  });

  it('reports a capped foreground timeout while preserving the command text', async () => {
    const tool = new LocalBashTool('/tmp/workspace', undefined, { mode: 'off' });
    const execute = vi.spyOn((tool as unknown as { tool: { execute: unknown } }).tool, 'execute')
      .mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], details: {} } as never);
    const result = await tool.execute(SESSION_CTX, { description: '运行测试命令', command: ' echo ok ', timeout: 600 });
    expect(execute.mock.calls[0]?.[1]).toEqual({ description: '运行测试命令', command: ' echo ok ', timeout: 300 });
    expect(result.details).toMatchObject({ timing: { requestedTimeoutSeconds: 600, commandTimeoutSeconds: 300 } });
    expect(result.text).toContain('requested 600s; effective 300s');
  });
});

describe('LocalBashTool.execute — background path', () => {
  // TS-3 (P0): run_in_background:true (no timeout) → 120 default NOT applied;
  // dispatches to the background adapter with the input untouched.
  it('dispatches to the background adapter without injecting the 120s default', async () => {
    const started: LocalBashBackgroundStartResult = {
      status: 'started',
      taskId: 'task-1',
      details: { envSanitized: ['MAVIS_ACCESS_TOKEN'] },
    };
    const startBackground = vi.fn(
      async (): Promise<LocalBashBackgroundStartResult> => started,
    );
    const adapter: LocalBashAdapter = { startBackground };
    const tool = new LocalBashTool('/tmp/does-not-matter', adapter, { mode: 'off' });

    const result = await tool.execute({ ...SESSION_CTX, canConsumeBackgroundBashOutput: true }, {
      description: '运行测试命令',
      command: 'echo hi',
      run_in_background: true,
    });

    expect(startBackground).toHaveBeenCalledTimes(1);
    const forwarded = startBackground.mock.calls[0]?.[1];
    // Background path must receive the input verbatim — no 120 injected.
    expect(forwarded).toEqual({ description: '运行测试命令', command: 'echo hi', run_in_background: true });
    expect((forwarded as { timeout?: number }).timeout).toBeUndefined();
    expect(result.details).toMatchObject({
      status: 'started',
      task_id: 'task-1',
      envSanitized: ['MAVIS_ACCESS_TOKEN'],
    });
  });
});

describe('LocalBashTool.execute — foreground path forwarding (TS-4)', () => {
  // TS-4 (P1): forwarded foreground input carries resolved timeout and NO
  // run_in_background key. We spy on the inner pi tool to capture the forward.
  it('forwards resolved timeout and strips run_in_background', async () => {
    const tool = new LocalBashTool('/tmp/does-not-matter', undefined, { mode: 'off' });
    const innerExecute = vi
      .spyOn((tool as unknown as { tool: { execute: unknown } }).tool, 'execute')
      .mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], details: {} } as never);

    await tool.execute(SESSION_CTX, { description: '运行测试命令', command: 'echo hi', run_in_background: false });

    expect(innerExecute).toHaveBeenCalledTimes(1);
    const forwarded = (innerExecute.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(forwarded).toEqual({ description: '运行测试命令', command: 'echo hi', timeout: 120 });
    expect(forwarded).not.toHaveProperty('run_in_background');
  });

  it('forwards an explicit timeout unchanged and strips run_in_background', async () => {
    const tool = new LocalBashTool('/tmp/does-not-matter', undefined, { mode: 'off' });
    const innerExecute = vi
      .spyOn((tool as unknown as { tool: { execute: unknown } }).tool, 'execute')
      .mockResolvedValue({ content: [{ type: 'text', text: 'ok' }], details: {} } as never);

    await tool.execute(SESSION_CTX, { description: '运行测试命令', command: 'echo hi', timeout: 7 });

    const forwarded = (innerExecute.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(forwarded).toEqual({ description: '运行测试命令', command: 'echo hi', timeout: 7 });
    expect(forwarded).not.toHaveProperty('run_in_background');
  });

  it('carries the trusted Explore read-only restriction through direct foreground identity', async () => {
    const create = vi.fn<LocalSandboxBashOperationsFactory['create']>(() => ({
      exec: async () => ({ exitCode: 0 }),
    }));
    const tool = new LocalBashTool(
      '/tmp/does-not-matter',
      undefined,
      { mode: 'off' },
      undefined,
      { create },
    );
    const ctx = {
      ...SESSION_CTX,
      toolCallId: 'call-direct',
      forceReadOnlyFilesystem: true,
    };

    await tool.execute(ctx, { description: '运行测试命令', command: 'true' });

    expect(create).toHaveBeenCalledWith({
      identity: {
        operationClass: 'direct_foreground',
        invocationId: 'call-direct',
        sessionId: 'sess-test',
        turnId: 'turn-test',
        toolCallId: 'call-direct',
        forceReadOnlyFilesystem: true,
      },
      workspaceRoot: '/tmp/does-not-matter',
    });
  });

  it('uses a unique runtime id without leaking command text when old callers omit toolCallId', async () => {
    const create = vi.fn<LocalSandboxBashOperationsFactory['create']>(() => ({
      exec: async () => ({ exitCode: 0 }),
    }));
    const tool = new LocalBashTool(
      '/tmp/does-not-matter',
      undefined,
      { mode: 'off' },
      undefined,
      { create },
    );

    await tool.execute(SESSION_CTX, { description: '运行测试命令', command: 'secret-command-one' });
    await tool.execute(SESSION_CTX, { description: '运行测试命令', command: 'secret-command-two' });

    const identities = create.mock.calls.map(([input]) => input.identity);
    expect(identities).toHaveLength(2);
    expect(identities[0]).toMatchObject({
      operationClass: 'direct_foreground',
      sessionId: 'sess-test',
      turnId: 'turn-test',
    });
    expect(identities[0]?.invocationId).toMatch(/^runtime_[0-9a-f-]{36}$/);
    expect(identities[1]?.invocationId).not.toBe(identities[0]?.invocationId);
    expect(JSON.stringify(identities)).not.toContain('secret-command');
  });
});

describe('LocalBashTool.execute — managed foreground soft yield', () => {
  it.each([0, 7])('returns direct output and exit code %i when native output is absent', async (exitCode) => {
    const runManagedForeground = vi.fn();
    const tool = new LocalBashTool('/tmp/workspace', { startBackground: vi.fn(), runManagedForeground }, { mode: 'off' }, undefined, {
      create: () => ({ exec: async (_command, _cwd, opts) => {
        opts.onData(Buffer.from('direct stdout and stderr'));
        return { exitCode };
      } }),
    });
    const result = await tool.execute({ ...SESSION_CTX, allowBashAutoPromotion: true }, { description: '运行测试命令', command: 'controlled command' });
    expect(runManagedForeground).not.toHaveBeenCalled();
    expect(result.text).toContain('direct stdout and stderr');
    expect(Boolean(result.isError)).toBe(exitCode !== 0);
    expect(result.details?.task_id).toBeUndefined();
  });

  it('forwards cancellation to foreground operations when promotion is disabled', async () => {
    const controller = new AbortController();
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const runManagedForeground = vi.fn();
    const tool = new LocalBashTool('/tmp/workspace', { startBackground: vi.fn(), runManagedForeground }, { mode: 'off' }, undefined, {
      create: () => ({ exec: async (_command, _cwd, opts) => {
        expect(opts.signal).toBe(controller.signal);
        return new Promise<never>((_, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
          started();
        });
      } }),
    });
    const pending = tool.execute({ ...SESSION_CTX, allowBashAutoPromotion: false }, { description: '运行测试命令', command: 'controlled command' }, controller.signal);
    const rejection = expect(pending).rejects.toThrow(/abort/i);
    await ready;
    controller.abort();
    await rejection;
    expect(runManagedForeground).not.toHaveBeenCalled();
  });

  it('refuses explicit background Bash before starting a task when native output is unavailable', async () => {
    const startBackground = vi.fn(async () => ({ status: 'started' as const, taskId: 'unexpected' }));
    const tool = new LocalBashTool(
      '/tmp/workspace',
      { startBackground, runManagedForeground: vi.fn() },
      { mode: 'off' },
    );

    const result = await tool.execute(
      { ...SESSION_CTX, canConsumeBackgroundBashOutput: false },
      { description: '运行测试命令', command: 'controlled command', run_in_background: true },
    );

    expect(result).toMatchObject({
      isError: true,
      details: {
        status: 'background_output_unavailable',
        error_code: 'BASH_BACKGROUND_OUTPUT_UNAVAILABLE',
      },
    });
    expect(result.text).toContain('missing task_output');
    expect(result.text).toContain('foreground instead');
    expect(startBackground).not.toHaveBeenCalled();
  });

  it('allows explicit background execution when native output is admitted', async () => {
    const startBackground = vi.fn(async () => ({ status: 'started' as const, taskId: 'explicit-task' }));
    const tool = new LocalBashTool('/tmp/workspace', { startBackground, runManagedForeground: vi.fn() }, { mode: 'off' });
    const result = await tool.execute(
      {
        ...SESSION_CTX,
        allowBashAutoPromotion: false,
        canConsumeBackgroundBashOutput: true,
      },
      { description: '运行测试命令', command: 'controlled command', run_in_background: true },
    );
    expect(startBackground).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({ status: 'started', task_id: 'explicit-task' });
  });

  it('fails closed for explicit background execution when the catalog fact is absent', async () => {
    const startBackground = vi.fn(async () => ({ status: 'started' as const, taskId: 'explicit-task' }));
    const tool = new LocalBashTool('/tmp/workspace', { startBackground, runManagedForeground: vi.fn() }, { mode: 'off' });
    const result = await tool.execute(
      { ...SESSION_CTX, allowBashAutoPromotion: false },
      { description: '运行测试命令', command: 'controlled command', run_in_background: true },
    );

    expect(result).toMatchObject({
      isError: true,
      details: {
        status: 'background_output_unavailable',
        error_code: 'BASH_BACKGROUND_OUTPUT_UNAVAILABLE',
      },
    });
    expect(startBackground).not.toHaveBeenCalled();
  });

  it('returns a completed managed command inline', async () => {
    const runManagedForeground = vi.fn(async () => ({
      status: 'completed' as const,
      taskId: 'task-fast',
      text: 'ok',
    }));
    const tool = new LocalBashTool('/tmp/does-not-matter', {
      startBackground: vi.fn(),
      runManagedForeground,
    }, { mode: 'off' });

    const result = await tool.execute({ ...SESSION_CTX, canConsumeBackgroundBashOutput: true }, { description: '运行测试命令', command: 'echo ok' });

    expect(runManagedForeground).toHaveBeenCalledWith(
      { ...SESSION_CTX, canConsumeBackgroundBashOutput: true },
      { description: '运行测试命令', command: 'echo ok' },
      DEFAULT_FOREGROUND_BASH_SOFT_YIELD_MS,
      undefined,
    );
    expect(result).toMatchObject({ text: 'ok', details: { status: 'completed', task_id: 'task-fast' } });
  });

  it('reports managed env sanitization once per tool instance', async () => {
    const runManagedForeground = vi.fn(async () => ({
      status: 'completed' as const,
      taskId: 'task-fast',
      text: 'ok',
      details: { envSanitized: ['MAVIS_ACCESS_TOKEN'] },
    }));
    const tool = new LocalBashTool('/tmp/does-not-matter', {
      startBackground: vi.fn(),
      runManagedForeground,
    }, { mode: 'off' });

    const first = await tool.execute({ ...SESSION_CTX, canConsumeBackgroundBashOutput: true }, { description: '运行测试命令', command: 'echo first' });
    const second = await tool.execute({ ...SESSION_CTX, canConsumeBackgroundBashOutput: true }, { description: '运行测试命令', command: 'echo second' });

    expect(first.details?.envSanitized).toEqual(['MAVIS_ACCESS_TOKEN']);
    expect(second.details?.envSanitized).toBeUndefined();
  });

  it('returns the same task handle when a slow command is auto-promoted', async () => {
    const tool = new LocalBashTool('/tmp/does-not-matter', {
      startBackground: vi.fn(),
      runManagedForeground: vi.fn(async () => ({
        status: 'auto_promoted' as const,
        taskId: 'task-slow',
        details: { envSanitized: ['MAVIS_ACCESS_TOKEN'] },
      })),
    }, { mode: 'off' });

    const result = await tool.execute({ ...SESSION_CTX, canConsumeBackgroundBashOutput: true }, { description: '运行测试命令', command: 'sleep 30' });

    expect(result.details).toEqual({
      description: '运行测试命令',
      status: 'auto_promoted',
      task_id: 'task-slow',
      timing: {
        commandTimeoutSeconds: 600,
      },
      envSanitized: ['MAVIS_ACCESS_TOKEN'],
    });
    expect(result.text).toContain('without restarting it');
    expect(result.text).toContain('Command limit: 600s total; yielding does not reset it.');
  });
});

describe('LocalBashTool.execute — real foreground ops', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'local-bash-'));
  });
  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('returns real output after the 60 second yield window when the Turn has no native task_output', async () => {
    const runManagedForeground = vi.fn(async () => ({ status: 'auto_promoted' as const, taskId: 'unexpected-task' }));
    const tool = new LocalBashTool(workspace, { startBackground: vi.fn(), runManagedForeground }, { mode: 'off' });
    const startedAt = Date.now();
    const result = await tool.execute({ ...SESSION_CTX, allowBashAutoPromotion: false }, {
      description: '运行测试命令',
      command: `node -e "setTimeout(() => { console.log('foreground-after-threshold'); console.error('stderr-after-threshold'); }, 61000)"`,
      timeout: 90,
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(60_000);
    expect(runManagedForeground).not.toHaveBeenCalled();
    expect(result.text).toContain('foreground-after-threshold');
    expect(result.text).toContain('stderr-after-threshold');
    expect(result.isError).toBeFalsy();
    expect(result.details?.task_id).toBeUndefined();
  }, 90_000);

  // TS-5 (P1): fast foreground command with no timeout completes normally.
  it('runs a fast foreground command with no timeout and returns real output', async () => {
    const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
    const result = await tool.execute(SESSION_CTX, { description: '运行测试命令', command: 'echo hi' });
    expect(result.tool_name).toBe('bash');
    expect(result.text).toContain('hi');
    expect(result.isError).toBeFalsy();
  });

  // TS-6 (P1): timeout-hit surfaces the vendored error text. Driven with a very
  // short explicit timeout against a sleep to stay fast and non-flaky.
  it('surfaces the vendored "Command timed out after N seconds" text', async () => {
    const tool = new LocalBashTool(workspace, undefined, { mode: 'off' });
    const result = await tool.execute(SESSION_CTX, { description: '运行测试命令', command: 'sleep 5', timeout: 1 });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Command timed out after 1 seconds/);
  });
});

describe('LocalBashToolDef timeout description (TS-7)', () => {
  it('documents seconds, foreground limits, and background yielding', () => {
    const desc = timeoutDescription();
    expect(desc).not.toContain('host-defined');
    expect(desc).toContain('seconds');
    expect(desc).toContain('120');
    expect(desc).toContain('300');
    expect(desc).toContain('600');
    expect(desc).toContain('including foreground time');
    expect(desc.toLowerCase()).toContain('foreground');
    const backgroundDesc = createLocalBashToolDefinition({ background: true, shell: 'bash' }).description;
    expect(backgroundDesc).toContain('return a task_id if unfinished');
    expect(backgroundDesc).toContain('60s');
  });

});

describe('per-Turn Bash contract', () => {
  it('keeps definitions isolated while hiding background parameters without native output', () => {
    const original = JSON.stringify(LocalBashToolDef);
    const enabled = createLocalBashToolDefinition({ background: true, shell: 'bash' });
    const disabled = createLocalBashToolDefinition({ background: false, shell: 'bash' });
    expect(enabled.schema.properties).toHaveProperty('run_in_background');
    expect(disabled.schema.properties).not.toHaveProperty('run_in_background');
    expect(JSON.stringify(disabled.schema)).not.toContain('run_in_background');
    expect(enabled.description).toContain('Backgrounding and reading output do not reset the command timeout.');
    expect(disabled.description).toContain('foreground execution only');
    expect(disabled.schema.required).toEqual(['command']);
    expect(enabled.schema.properties.timeout.description).toContain('default/max 600s');
    expect(enabled.schema.properties.timeout.description).toContain('including foreground time');
    expect(disabled.schema.properties.timeout.description).toContain('default 120s; values above 300s are capped');
    expect(JSON.stringify(LocalBashToolDef)).toBe(original);
    expect(enabled.schema.properties.timeout).not.toBe(LocalBashToolDef.schema.properties.timeout);
    expect(disabled.description).toContain('report the failure instead of falling back to permanent deletion');
    expect(disabled.description).toContain('dedicated `read`, `write`, `edit`, `grep`, and `glob`');
  });

  it.each([
    ['bash', 'Selected shell: Bash', 'PowerShell 5.1'],
    ['sh', 'Selected shell: POSIX sh', 'Selected shell: Bash'],
    ['powershell', 'The && and || operators are unsupported', 'operators && and || are supported'],
    ['pwsh', 'operators && and || are supported', 'operators are unsupported'],
    ['unavailable', 'No local shell was resolved', 'Selected shell: Bash'],
  ] as const)('describes the selected %s shell capabilities', (shell, expected, excluded) => {
    const tool = createLocalBashToolDefinition({ background: true, shell });
    expect(tool.description).toContain(expected);
    expect(tool.description).not.toContain(excluded);
    expect(tool.description).toContain('Backgrounding and reading output do not reset the command timeout.');
  });
});
