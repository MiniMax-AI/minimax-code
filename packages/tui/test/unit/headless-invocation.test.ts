import { mkdtemp, mkdir, realpath, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  resolveTuiExecInvocation,
  type RawTuiExecOptions,
} from '../../src/headless/invocation.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mcode-headless-invocation-'));
  roots.push(root);
  return root;
}

describe('headless invocation', () => {
  it('resolves exec review as a fixed local-changes operation without stdin', async () => {
    const cwd = await workspace();
    const readStdin = vi.fn(async () => 'ignored');

    await expect(
      resolveTuiExecInvocation(
        undefined,
        {
          review: true,
          cwd,
          model: 'provider/model',
          permission: 'full',
          outputFormat: 'json',
        },
        readStdin,
      ),
    ).resolves.toMatchObject({
      prompt: 'Please review my uncommitted changes.',
      workspaceDir: await realpath(cwd),
      model: 'provider/model',
      permission: 'full',
      format: 'json',
      attachments: [],
      continueSession: false,
      reviewRequest: { scope: 'local_changes' },
    });
    expect(readStdin).not.toHaveBeenCalled();
  });

  it('carries a trimmed --effort for exec and exec review and rejects a blank level', async () => {
    const cwd = await workspace();
    const readStdin = vi.fn(async () => 'ignored');

    await expect(
      resolveTuiExecInvocation('prompt', { cwd, effort: ' xhigh ' }, readStdin),
    ).resolves.toMatchObject({ effort: 'xhigh' });
    await expect(
      resolveTuiExecInvocation(undefined, { review: true, cwd, effort: 'high' }, readStdin),
    ).resolves.toMatchObject({ effort: 'high', reviewRequest: { scope: 'local_changes' } });
    await expect(resolveTuiExecInvocation('prompt', { cwd }, readStdin)).resolves.not.toHaveProperty(
      'effort',
    );
    for (const options of [{ cwd, effort: '  ' }, { review: true, cwd, effort: '' }]) {
      await expect(
        resolveTuiExecInvocation('prompt', options, readStdin),
      ).rejects.toMatchObject({ kind: 'invocation', message: '--effort cannot be empty.' });
    }
  });

  it('resolves a diagnostics directory against cwd and rejects empty or file paths', async () => {
    const cwd = await workspace();
    const invocation = await resolveTuiExecInvocation('review', { cwd, diagnosticsDir: 'evidence' }, async () => '');
    expect(invocation.diagnosticsDir).toBe(join(await realpath(cwd), 'evidence'));
    await expect(resolveTuiExecInvocation('review', { cwd, diagnosticsDir: '' }, async () => '')).rejects.toThrow('--diagnostics-dir');
    await writeFile(join(cwd, 'file'), 'not a directory');
    await expect(resolveTuiExecInvocation('review', { cwd, diagnosticsDir: 'file' }, async () => '')).rejects.toThrow('--diagnostics-dir');
  });
  it('never reads stdin without explicit --input -', async () => {
    const cwd = await workspace();
    let reads = 0;

    await expect(
      resolveTuiExecInvocation('prompt', { cwd }, async () => {
        reads += 1;
        return 'ignored';
      }),
    ).resolves.toMatchObject({
      prompt: 'prompt',
      workspaceDir: await realpath(cwd),
    });
    expect(reads).toBe(0);
  });

  it('defaults to smart permissions and rejects interactive ask before reading input', async () => {
    const cwd = await workspace();
    const readStdin = vi.fn(async () => 'ignored');

    await expect(
      resolveTuiExecInvocation('prompt', { cwd }, readStdin),
    ).resolves.toMatchObject({ permission: 'smart' });
    await expect(
      resolveTuiExecInvocation(undefined, { cwd, input: '-', permission: 'ask' }, readStdin),
    ).rejects.toMatchObject({
      kind: 'invocation',
      message: expect.stringContaining('requires an interactive host'),
    });
    expect(readStdin).not.toHaveBeenCalled();
  });

  it('opts only new exec Sessions into lightweight mode', async () => {
    const cwd = await workspace();
    const readStdin = vi.fn(async () => 'ignored');

    await expect(
      resolveTuiExecInvocation('hi', { cwd, mode: 'lightweight' }, readStdin),
    ).resolves.toMatchObject({ contextMode: 'lightweight' });
    await expect(
      resolveTuiExecInvocation('hi', { cwd, mode: 'standard' }, readStdin),
    ).resolves.not.toHaveProperty('contextMode');
    for (const options of [
      { cwd, mode: 'lightweight', session: 'existing' },
      { cwd, mode: 'lightweight', continue: true },
    ]) {
      await expect(resolveTuiExecInvocation('hi', options, readStdin)).rejects.toThrow(
        'requires a new Session',
      );
    }
  });

  it('accepts JSON stdin and rejects prompt/source conflicts', async () => {
    const cwd = await workspace();
    await expect(
      resolveTuiExecInvocation(
        undefined,
        { cwd, input: '-', inputFormat: 'json' },
        async () => '{"prompt":"from json"}',
      ),
    ).resolves.toMatchObject({ prompt: 'from json' });

    await expect(
      resolveTuiExecInvocation('prompt', { cwd, input: '-' }, async () => 'from stdin'),
    ).rejects.toThrow('cannot be combined');
  });

  it('supports attachment-only input and resolves a symlinked file', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'actual.txt'), 'hello');
    await symlink(join(cwd, 'actual.txt'), join(cwd, 'alias.txt'));

    const invocation = await resolveTuiExecInvocation(
      undefined,
      { cwd, file: ['alias.txt'] },
      async () => {
        throw new Error('stdin must not be read');
      },
    );

    expect(invocation.prompt).toBe('');
    expect(invocation.attachments).toEqual([
      expect.objectContaining({
        fileName: 'actual.txt',
        mimeType: 'text/plain',
        sizeBytes: 5,
      }),
    ]);
  });

  it('preserves video MIME metadata for model capability selection', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'demo.mp4'), Buffer.from([0, 1, 2, 3]));

    await expect(
      resolveTuiExecInvocation('Review this video', { cwd, file: ['demo.mp4'] }, async () => ''),
    ).resolves.toMatchObject({
      attachments: [
        {
          type: 'file',
          fileName: 'demo.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 4,
        },
      ],
    });
  });

  it('rejects missing cwd, missing input, invalid duration, and conflicting session strategies', async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, 'file-dir'));
    const cases: RawTuiExecOptions[] = [
      { cwd: join(cwd, 'missing') },
      { cwd },
      { cwd, timeout: 'forever' },
      { cwd, session: 'session-1', continue: true },
    ];

    for (const options of cases) {
      await expect(
        resolveTuiExecInvocation(undefined, options, async () => ''),
      ).rejects.toThrow();
    }
  });

  it('cancels before reading files or stdin when the invocation signal is aborted', async () => {
    const cwd = await workspace();
    const controller = new AbortController();
    controller.abort('test');
    let reads = 0;

    await expect(
      resolveTuiExecInvocation(
        undefined,
        { cwd, input: '-' },
        async () => {
          reads += 1;
          return 'ignored';
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    expect(reads).toBe(0);
  });

  it('accepts binary files and matches the client attachment limits', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'payload.bin'), Buffer.from([0, 1, 2, 3]));
    await writeFile(join(cwd, 'large.bin'), '');
    await truncate(join(cwd, 'large.bin'), 100 * 1024 * 1024 + 1);

    await expect(
      resolveTuiExecInvocation(undefined, { cwd, file: ['payload.bin'] }, async () => ''),
    ).resolves.toMatchObject({
      attachments: [
        {
          type: 'file',
          fileName: 'payload.bin',
          mimeType: 'application/octet-stream',
          sizeBytes: 4,
        },
      ],
    });
    await expect(
      resolveTuiExecInvocation(undefined, { cwd, file: ['missing.bin'] }, async () => ''),
    ).rejects.toThrow('Cannot attach missing.bin');
    await expect(
      resolveTuiExecInvocation(undefined, { cwd, file: ['large.bin'] }, async () => ''),
    ).rejects.toThrow('100 MB limit');

    const files = Array.from({ length: 11 }, (_, index) => `file-${String(index)}.txt`);
    await Promise.all(files.map((file) => writeFile(join(cwd, file), file)));
    await expect(
      resolveTuiExecInvocation(undefined, { cwd, file: files }, async () => ''),
    ).rejects.toThrow('up to 10 files');
  });

  it('normalizes canonical output flags and parses the result schema', async () => {
    const cwd = await workspace();
    await expect(
      resolveTuiExecInvocation(
        'prompt',
        {
          cwd,
          outputFormat: 'stream-json',
          outputSchema: '{"type":"object","required":["type"]}',
        },
        async () => '',
      ),
    ).resolves.toMatchObject({
      format: 'stream-json',
      outputSchema: { type: 'object', required: ['type'] },
    });
  });

  it('loads an output schema file and resolves the last-message target without creating it', async () => {
    const cwd = await workspace();
    await writeFile(
      join(cwd, 'review.schema.json'),
      JSON.stringify({ type: 'object', required: ['findings'] }),
    );

    await expect(
      resolveTuiExecInvocation(
        'review',
        {
          cwd,
          outputSchema: 'review.schema.json',
          outputLastMessage: 'artifacts/review.json',
        },
        async () => '',
      ),
    ).rejects.toThrow('--output-last-message is invalid');

    await mkdir(join(cwd, 'artifacts'));
    await expect(
      resolveTuiExecInvocation(
        'review',
        {
          cwd,
          outputSchema: 'review.schema.json',
          outputLastMessage: 'artifacts/review.json',
        },
        async () => '',
      ),
    ).resolves.toMatchObject({
      outputSchema: { type: 'object', required: ['findings'] },
      outputLastMessagePath: join(await realpath(cwd), 'artifacts', 'review.json'),
    });
  });

  it('resolves every optional automation control and trims owner identifiers', async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, 'mcode.yaml'), 'models: {}\n');
    await writeFile(join(cwd, 'image.PNG'), Buffer.from([1, 2, 3]));

    await expect(
      resolveTuiExecInvocation(
        'prompt',
        {
          cwd,
          file: ['image.PNG'],
          model: ' provider/model#fast ',
          session: ' session-1 ',
          config: 'mcode.yaml',
          permission: 'off',
          timeout: '2h',
          maxSteps: '12',
          outputFormat: 'json',
        },
        async () => '',
      ),
    ).resolves.toMatchObject({
      prompt: 'prompt',
      attachments: [
        expect.objectContaining({
          type: 'image',
          fileName: 'image.PNG',
          mimeType: 'image/png',
        }),
      ],
      model: 'provider/model#fast',
      sessionId: 'session-1',
      configPath: await realpath(join(cwd, 'mcode.yaml')),
      permission: 'off',
      timeoutMs: 7_200_000,
      maxSteps: 12,
      format: 'json',
    });
  });

  it.each([
    [{ input: 'file' }, '--input currently accepts only'],
    [{ inputFormat: 'yaml' }, '--input-format must be one of'],
    [{ outputFormat: 'xml' }, '--output-format must be one of'],
    [{ permission: 'root' }, '--permission must be one of'],
  ] as const)('rejects invalid enum-like option %s', async (options, message) => {
    const cwd = await workspace();
    await expect(
      resolveTuiExecInvocation('prompt', { cwd, ...options }, async () => ''),
    ).rejects.toThrow(message);
  });

  it('accepts both JSON prompt shapes and rejects every other JSON input', async () => {
    const cwd = await workspace();
    await expect(
      resolveTuiExecInvocation(
        undefined,
        { cwd, input: '-', inputFormat: 'json' },
        async () => '"string prompt"',
      ),
    ).resolves.toMatchObject({ prompt: 'string prompt' });
    await expect(
      resolveTuiExecInvocation(
        undefined,
        { cwd, input: '-', inputFormat: 'json' },
        async () => '{invalid',
      ),
    ).rejects.toThrow('requires valid JSON');
    for (const input of ['[]', '{}', '{"prompt":1}', 'null']) {
      await expect(
        resolveTuiExecInvocation(
          undefined,
          { cwd, input: '-', inputFormat: 'json' },
          async () => input,
        ),
      ).rejects.toThrow('JSON string or an object with string prompt');
    }
  });

  it.each([
    ['1', 1],
    ['500ms', 500],
    ['30s', 30_000],
    ['2m', 120_000],
    ['1H', 3_600_000],
  ] as const)('parses timeout %s as %i milliseconds', async (timeout, timeoutMs) => {
    const cwd = await workspace();
    await expect(
      resolveTuiExecInvocation('prompt', { cwd, timeout }, async () => ''),
    ).resolves.toMatchObject({ timeoutMs });
  });

  it.each([
    [{ timeout: '0' }, '--timeout must resolve to a positive safe integer'],
    [{ timeout: '9007199254740992h' }, '--timeout must resolve to a positive safe integer'],
    [{ maxSteps: '0' }, '--max-steps must be a positive safe integer'],
    [{ maxSteps: '-1' }, '--max-steps must be a positive integer'],
    [{ maxSteps: '1.5' }, '--max-steps must be a positive integer'],
    [{ maxSteps: '9007199254740992' }, '--max-steps must be a positive safe integer'],
  ] as const)('rejects invalid numeric automation control %s', async (options, message) => {
    const cwd = await workspace();
    await expect(
      resolveTuiExecInvocation('prompt', { cwd, ...options }, async () => ''),
    ).rejects.toThrow(message);
  });

  it.each([
    ['null', '--output-schema requires a JSON object'],
    ['[]', '--output-schema requires a JSON object'],
    ['"text"', '--output-schema requires a JSON object'],
    ['{invalid', '--output-schema requires a JSON object'],
    ['{"type":42}', '--output-schema requires a JSON object'],
  ] as const)('rejects invalid output schema %s', async (outputSchema, message) => {
    const cwd = await workspace();
    await expect(
      resolveTuiExecInvocation('prompt', { cwd, outputSchema }, async () => ''),
    ).rejects.toThrow(message);
  });

  it('rejects non-file attachments, non-directory cwd, invalid config targets, and empty paths', async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, 'directory'));
    await writeFile(join(cwd, 'file.txt'), 'file');

    await expect(
      resolveTuiExecInvocation('prompt', { cwd, file: ['directory'] }, async () => ''),
    ).rejects.toThrow('path is not a file');
    await expect(
      resolveTuiExecInvocation('prompt', { cwd: join(cwd, 'file.txt') }, async () => ''),
    ).rejects.toThrow('--cwd must reference a directory');
    await expect(
      resolveTuiExecInvocation('prompt', { cwd, config: 'directory' }, async () => ''),
    ).rejects.toThrow('--config must reference a file');
    await expect(
      resolveTuiExecInvocation('prompt', { cwd, config: 'missing' }, async () => ''),
    ).rejects.toThrow('--config is invalid');
    await expect(
      resolveTuiExecInvocation('prompt', { cwd: ' ' }, async () => ''),
    ).rejects.toThrow('Path value cannot be empty');
  });

  it('cancels after an in-flight stdin read before resolving attachments', async () => {
    const cwd = await workspace();
    const controller = new AbortController();

    await expect(
      resolveTuiExecInvocation(
        undefined,
        { cwd, input: '-' },
        async () => {
          controller.abort('cancelled after read');
          return 'prompt';
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ kind: 'cancelled' });
  });
});

describe('Prompt mode selection', () => {
  it.each([undefined, 'tui', 'coding', 'work'])(
    'resolves %s before runtime startup',
    async (promptMode) => {
      const invocation = await resolveTuiExecInvocation('hello', { promptMode }, async () => '');
      expect(invocation.promptMode).toBe(promptMode ?? 'tui');
    },
  );
  it('rejects unknown modes', async () => {
    await expect(
      resolveTuiExecInvocation('hello', { promptMode: 'unknown' }, async () => ''),
    ).rejects.toThrow('--prompt-mode must be one of');
  });
});
