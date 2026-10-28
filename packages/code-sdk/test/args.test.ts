import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MAX_TIMEOUT_MS, validateRunOptions } from '../src/args.js';
import { MCode, MCodeInvocationError, MCodeRunError } from '../src/index.js';
import { FAKE_MCODE, fakeClient, fixture, readRecord, tempDir } from './helpers.js';

describe('CLI argument mapping', () => {
  it('maps Thread, run and client options to exec flags, stdin and environment', async () => {
    const dir = tempDir();
    const record = `${dir}/record.json`;
    const mcode = fakeClient(
      { FAKE_MCODE_FIXTURE: fixture('success-tools'), FAKE_MCODE_RECORD: record },
      { dataDir: `${dir}/data`, configPath: `${dir}/config.yaml` },
    );
    const thread = mcode.startThread({
      cwd: dir,
      model: 'minimax/MiniMax-M3',
      effort: 'high',
      permission: 'full',
      mode: 'standard',
      promptMode: 'coding',
      systemPrompt: 'You are a release bot.',
      appendSystemPrompt: '--- keep answers short',
    });

    await thread.run('-p "quoted" $HOME `rm -rf`', {
      files: ['./ci.log', '-starts-with-dash.txt'],
      timeoutMs: 600_000,
      maxSteps: 12,
    });

    const { argv, stdin, env, promptFiles } = readRecord(record);
    expect(argv.slice(0, 4)).toEqual([
      'exec',
      '--output-format=stream-json',
      '--input=-',
      '--input-format=json',
    ]);
    expect(argv).toEqual(
      expect.arrayContaining([
        `--cwd=${resolve(dir)}`,
        '--model=minimax/MiniMax-M3',
        '--effort=high',
        '--permission=full',
        '--mode=standard',
        '--prompt-mode=coding',
        `--config=${resolve(dir, 'config.yaml')}`,
        '--file=./ci.log',
        '--file=-starts-with-dash.txt',
        '--timeout=600000ms',
        '--max-steps=12',
      ]),
    );
    // Free text never reaches argv: the prompt goes over stdin, system prompts via files.
    expect(argv.join(' ')).not.toContain('quoted');
    expect(argv.join(' ')).not.toContain('release bot');
    expect(JSON.parse(stdin)).toEqual({ prompt: '-p "quoted" $HOME `rm -rf`' });
    expect(promptFiles).toEqual({
      'system-prompt-file': 'You are a release bot.',
      'append-system-prompt-file': '--- keep answers short',
    });
    expect(env.MINIMAX_DATA_DIR).toBe(resolve(dir, 'data'));

    // Temporary prompt files are already removed when run() resolves.
    expect(existsSync(promptFileOf(record))).toBe(false);
  });

  it('removes prompt files before a failed run rejects and before a stream ends', async () => {
    const record = `${tempDir()}/record.json`;
    const failing = fakeClient({
      FAKE_MCODE_FIXTURE: fixture('failed-upstream'),
      FAKE_MCODE_EXIT: '4',
      FAKE_MCODE_RECORD: record,
    });
    await expect(failing.startThread({ systemPrompt: 'x' }).run('go')).rejects.toBeInstanceOf(
      MCodeRunError,
    );
    expect(existsSync(promptFileOf(record))).toBe(false);

    const streaming = fakeClient({
      FAKE_MCODE_FIXTURE: fixture('resumed'),
      FAKE_MCODE_RECORD: record,
    });
    const { events } = await streaming.startThread({ systemPrompt: 'y' }).runStreamed('go');
    for await (const event of events) void event;
    expect(existsSync(promptFileOf(record))).toBe(false);
  });

  it('omits optional flags and the data dir variable when not configured', async () => {
    const record = `${tempDir()}/record.json`;
    const mcode = new MCode({
      bin: FAKE_MCODE,
      env: {
        PATH: process.env.PATH,
        FAKE_MCODE_FIXTURE: fixture('success-tools'),
        FAKE_MCODE_RECORD: record,
      },
    });

    await mcode.startThread().run('hi');

    const { argv, env } = readRecord(record);
    expect(argv).toEqual([
      'exec',
      '--output-format=stream-json',
      '--input=-',
      '--input-format=json',
      `--cwd=${process.cwd()}`,
    ]);
    expect(env.MINIMAX_DATA_DIR).toBeNull();
  });

  it('rejects invalid options before starting a process', async () => {
    const record = `${tempDir()}/record.json`;
    const mcode = fakeClient({ FAKE_MCODE_RECORD: record });

    expect(() => mcode.resumeThread('mvs_1', { mode: 'lightweight' })).toThrow(
      MCodeInvocationError,
    );
    expect(() => mcode.resumeThread('  ')).toThrow(MCodeInvocationError);
    expect(() => mcode.startThread({ permission: 'ask' as unknown as 'smart' })).toThrow(
      MCodeInvocationError,
    );
    const thread = mcode.startThread();
    await expect(thread.run('x', { timeoutMs: 0 })).rejects.toBeInstanceOf(MCodeInvocationError);
    await expect(thread.run('x', { maxSteps: 1.5 })).rejects.toBeInstanceOf(MCodeInvocationError);
    expect(existsSync(record)).toBe(false);
    // A rejected Turn does not leave the Thread busy.
    await expect(thread.run('x', { timeoutMs: -1 })).rejects.toBeInstanceOf(MCodeInvocationError);
  });

  it('rejects timeoutMs values whose SDK backstop would overflow a Node timer', async () => {
    expect(() => validateRunOptions({ timeoutMs: MAX_TIMEOUT_MS })).not.toThrow();
    // 2_200_000_000 + 30s used to overflow and fire the force-kill after ~1ms.
    const record = `${tempDir()}/record.json`;
    await expect(
      fakeClient({ FAKE_MCODE_RECORD: record })
        .startThread()
        .run('x', { timeoutMs: 2_200_000_000 }),
    ).rejects.toBeInstanceOf(MCodeInvocationError);
    expect(existsSync(record)).toBe(false);
  });
});

function promptFileOf(record: string): string {
  const arg = readRecord(record).argv.find((value) => value.startsWith('--system-prompt-file='));
  if (!arg) throw new Error('no --system-prompt-file argument recorded');
  return arg.slice('--system-prompt-file='.length);
}
