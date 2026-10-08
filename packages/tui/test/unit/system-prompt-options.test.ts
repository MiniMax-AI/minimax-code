import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  resolveSystemPromptOverrides,
  systemPromptRestartArguments,
} from '../../src/cli/system-prompt-options.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcode-system-prompt-options-'));
  roots.push(root);
  return root;
}

describe('resolveSystemPromptOverrides', () => {
  it('returns undefined when no prompt flag is present', () => {
    expect(resolveSystemPromptOverrides({})).toBeUndefined();
  });

  it('keeps inline replace and append text unchanged', () => {
    expect(
      resolveSystemPromptOverrides({
        systemPrompt: 'custom identity\n',
        appendSystemPrompt: 'extra rules',
      }),
    ).toEqual({ customPrompt: 'custom identity\n', appendSystemPrompt: 'extra rules' });
  });

  it('reads prompt files relative to the given directory', () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'replace.md'), '# Identity\nfrom file\n');
    writeFileSync(join(cwd, 'append.md'), 'appended from file');

    expect(
      resolveSystemPromptOverrides(
        { systemPromptFile: 'replace.md', appendSystemPromptFile: join(cwd, 'append.md') },
        cwd,
      ),
    ).toEqual({
      customPrompt: '# Identity\nfrom file\n',
      appendSystemPrompt: 'appended from file',
    });
  });

  it.each([
    [{ systemPrompt: 'a', systemPromptFile: 'b' }, '--system-prompt and --system-prompt-file'],
    [
      { appendSystemPrompt: 'a', appendSystemPromptFile: 'b' },
      '--append-system-prompt and --append-system-prompt-file',
    ],
    [{ systemPrompt: '  ' }, '--system-prompt cannot be empty.'],
    [{ appendSystemPrompt: '' }, '--append-system-prompt cannot be empty.'],
    [{ systemPromptFile: ' ' }, '--system-prompt-file requires a path.'],
  ])('rejects invalid input %j', (options, message) => {
    expect(() => resolveSystemPromptOverrides(options)).toThrow(message);
  });

  it('rejects missing and empty prompt files', () => {
    const cwd = workspace();
    writeFileSync(join(cwd, 'empty.md'), ' \n');

    expect(() => resolveSystemPromptOverrides({ systemPromptFile: 'missing.md' }, cwd)).toThrow(
      'Failed to read --system-prompt-file missing.md',
    );
    expect(() =>
      resolveSystemPromptOverrides({ appendSystemPromptFile: 'empty.md' }, cwd),
    ).toThrow('--append-system-prompt-file empty.md is empty.');
  });
});

describe('systemPromptRestartArguments', () => {
  it('keeps separated and inline prompt flags and drops unrelated arguments', () => {
    expect(
      systemPromptRestartArguments([
        '--model',
        'provider/model',
        '--system-prompt',
        'custom identity',
        '--append-system-prompt-file=./append.md',
        'initial prompt',
      ]),
    ).toEqual(['--system-prompt', 'custom identity', '--append-system-prompt-file=./append.md']);
  });

  it('does not treat a prompt value as another flag', () => {
    expect(
      systemPromptRestartArguments(['--append-system-prompt', '--system-prompt', 'tail']),
    ).toEqual(['--append-system-prompt', '--system-prompt']);
  });

  it('stops at the option terminator and at a dangling flag', () => {
    expect(systemPromptRestartArguments(['--', '--system-prompt', 'x'])).toEqual([]);
    expect(systemPromptRestartArguments(['--system-prompt'])).toEqual([]);
  });
});
