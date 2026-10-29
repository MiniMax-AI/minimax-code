/**
 * Contract between the SDK's self-held types and the mcode CLI source.
 *
 * Imports the CLI's exit-code policy, its real JSONL projector and its exec argument parser from
 * `packages/tui` and checks that the SDK parses, normalizes and maps them as documented. Excluded
 * from `tsc` because the CLI sources type-check only inside their package.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { applyExecCliContract } from '../../tui/src/cli/contract.js';
import { ExecEventProjector } from '../../tui/src/headless/events.js';
import {
  exitCodeForExecResult,
  MINIMAX_CODE_EXEC_EXIT_CODES,
} from '../../tui/src/headless/exit-policy.js';
import {
  resolveTuiExecInvocation,
  type RawTuiExecOptions,
} from '../../tui/src/headless/invocation.js';
import { buildExecArgs } from '../src/args.js';
import { errorForExit, errorForResult, MCODE_EXEC_EXIT_CODES } from '../src/errors.js';
import { MCodeAbortError, MCodeRunError } from '../src/index.js';
import { ItemAccumulator } from '../src/items.js';
import { parseEventLine } from '../src/protocol.js';
import type { ExecResult } from '../src/types.js';
import { MIN_CLI_VERSION, parseVersion, satisfiesMinimum } from '../src/version.js';
import { tempDir } from './helpers.js';

const { Command } = createRequire(new URL('../../tui/package.json', import.meta.url))(
  'commander',
) as {
  Command: new () => {
    name(name: string): void;
    exitOverride(): void;
    command(name: string): object;
    parseAsync(argv: readonly string[], options: { from: 'node' }): Promise<void>;
  };
};

async function parseWithCli(args: readonly string[], stdin: string) {
  const program = new Command();
  program.name('mcode');
  program.exitOverride();
  program.configureOutput({ writeOut: () => undefined, writeErr: () => undefined });
  let captured: { prompt: string | undefined; options: RawTuiExecOptions } | undefined;
  const exec = program.command('exec');
  applyExecCliContract(exec as never).action(
    (prompt: string | undefined, options: RawTuiExecOptions) => {
      captured = { prompt, options };
    },
  );
  await program.parseAsync(['node', 'mcode', ...args], { from: 'node' });
  if (!captured) throw new Error('the CLI exec action did not run');
  return resolveTuiExecInvocation(captured.prompt, captured.options, async () => stdin);
}

const ids = { runId: 'exec_turn_1', sessionId: 'mvs_contract', turnId: 'turn_1' };

function result(overrides: Partial<ExecResult>): ExecResult {
  return {
    schemaVersion: 1,
    type: 'exec.result',
    ...ids,
    status: 'succeeded',
    durationMs: 5,
    ...overrides,
  };
}

describe('mcode exec contract', () => {
  it('uses the CLI exit codes', () => {
    expect(MCODE_EXEC_EXIT_CODES).toEqual(MINIMAX_CODE_EXEC_EXIT_CODES);
  });

  it.each([
    result({ status: 'failed', error: { category: 'config', message: 'bad config' } }),
    result({
      status: 'failed',
      error: { category: 'runtime', message: 'upstream', retryable: true },
    }),
    result({ status: 'failed', error: { category: 'internal', message: 'bug' } }),
    result({ status: 'timeout' }),
    result({ status: 'limit_exceeded' }),
    result({ status: 'cancelled' }),
  ])(
    'maps CLI result $status/$error.category and its exit code to the same SDK error',
    (cliResult) => {
      const fromResult = errorForResult(cliResult, [], {});
      const fromExit = errorForExit({ exitCode: exitCodeForExecResult(cliResult as never) });

      expect(fromExit.constructor).toBe(fromResult.constructor);
      if (fromResult instanceof MCodeRunError && fromExit instanceof MCodeRunError) {
        expect(fromExit.status).toBe(fromResult.status);
        expect(fromExit.category).toBe(fromResult.category);
      } else {
        expect(fromResult).toBeInstanceOf(MCodeAbortError);
      }
    },
  );

  it('parses and normalizes the events produced by the CLI projector', () => {
    const projector = new ExecEventProjector({ ...ids, resumed: false, nowMs: () => 1 });
    const toolStart = { id: 'call_1', name: 'bash', status: 1, input: { command: 'ls' } };
    const toolDone = { ...toolStart, status: 2, output: { content: [] } };
    const internal = [
      { type: 'delta', role: 'assistant', messageId: 'm1', thinking: 'plan', content: 'Hel' },
      { type: 'delta', role: 'assistant', messageId: 'm1', content: 'lo', toolCalls: [toolStart] },
      {
        type: 'message',
        message: {
          role: 'assistant',
          id: 'm1',
          thinking: 'plan',
          content: 'Hello',
          toolCalls: [toolDone],
        },
      },
    ];
    const finalResult = result({ status: 'succeeded', output: 'Hello', usage: { totalTokens: 3 } });
    const projected = [
      ...internal.flatMap((event) => projector.project(event as never)),
      ...projector.complete(finalResult as never),
    ];

    const items = new ItemAccumulator();
    const parsed = projected.map((event) => parseEventLine(JSON.stringify(event)));
    for (const event of parsed) if (event) items.apply(event);

    expect(parsed.map((event) => event?.type)).toEqual([
      'exec.started',
      'session.started',
      'turn.started',
      'item.started',
      'item.started',
      'item.updated',
      'item.started',
      'item.completed',
      'item.completed',
      'item.completed',
      'turn.completed',
      'exec.completed',
    ]);
    expect(items.items()).toEqual([
      { id: 'm1:reasoning', type: 'reasoning', text: 'plan' },
      { id: 'm1:message', type: 'agent_message', text: 'Hello' },
      { id: 'call_1', type: 'tool_call', toolCall: toolDone },
    ]);
    const completed = parsed.at(-1);
    expect(completed?.type === 'exec.completed' && completed.result).toEqual(finalResult);
  });

  it('accepts the CLI in this repository under the SDK minimum', () => {
    const repo = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../tui/package.json', import.meta.url)), 'utf8'),
    ) as { version: string };
    const repoVersion = parseVersion(repo.version);
    const minimum = parseVersion(MIN_CLI_VERSION);
    if (!repoVersion || !minimum) throw new Error('unparseable CLI version');
    expect(satisfiesMinimum(repoVersion, minimum)).toBe(true);
  });

  it('parses buildExecArgs and the stdin payload with the CLI parser', async () => {
    const dir = tempDir();
    const promptFile = join(dir, 'system-prompt.txt');
    const appendFile = join(dir, 'append-system-prompt.txt');
    const configFile = join(dir, 'config.yaml');
    const attachment = join(dir, 'ci.log');
    writeFileSync(promptFile, 'You are a release bot.\n');
    writeFileSync(appendFile, 'Keep answers short.\n');
    writeFileSync(configFile, 'model: test\n');
    writeFileSync(attachment, 'log\n');
    mkdirSync(join(dir, 'workspace'));

    const stdin = JSON.stringify({ prompt: 'Diagnose the failing job' });
    const args = buildExecArgs({
      configPath: configFile,
      thread: {
        cwd: join(dir, 'workspace'),
        model: 'minimax/MiniMax-M3',
        effort: 'high',
        permission: 'full',
        mode: 'lightweight',
        promptMode: 'coding',
      },
      sessionId: null,
      run: { files: [attachment], timeoutMs: 600_000, maxSteps: 12 },
      systemPromptFile: promptFile,
      appendSystemPromptFile: appendFile,
    });

    const invocation = await parseWithCli(args, stdin);

    expect(invocation.prompt).toBe('Diagnose the failing job');
    expect(invocation.format).toBe('stream-json');
    expect(invocation.permission).toBe('full');
    expect(invocation.promptMode).toBe('coding');
    expect(invocation.contextMode).toBe('lightweight');
    expect(invocation.model).toBe('minimax/MiniMax-M3');
    expect(invocation.effort).toBe('high');
    expect(invocation.timeoutMs).toBe(600_000);
    expect(invocation.maxSteps).toBe(12);
    expect(invocation.systemPromptOverrides).toEqual({
      customPrompt: 'You are a release bot.\n',
      appendSystemPrompt: 'Keep answers short.\n',
    });
    expect(invocation.attachments.map((file) => file.fileName)).toEqual(['ci.log']);

    const resumed = buildExecArgs({
      thread: { cwd: join(dir, 'workspace') },
      sessionId: 'mvs_contract',
      run: {},
    });
    expect((await parseWithCli(resumed, JSON.stringify({ prompt: 'continue' }))).sessionId).toBe(
      'mvs_contract',
    );

    await expect(parseWithCli([...args, '--no-such-flag'], stdin)).rejects.toThrow(/no-such-flag/u);
    await expect(
      parseWithCli(
        args.map((arg) => (arg.startsWith('--permission=') ? '--permission=bogus' : arg)),
        stdin,
      ),
    ).rejects.toThrow(/permission/u);
    await expect(
      parseWithCli(
        args.map((arg) => (arg.startsWith('--timeout=') ? '--timeout=garbage' : arg)),
        stdin,
      ),
    ).rejects.toThrow(/timeout/u);
    await expect(parseWithCli(args, '{')).rejects.toThrow(/json/iu);
  });
});
