import { describe, expect, it } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import { formatTuiToolSummary } from '../../src/tui/transcript/presentation/tool-summary.js';
import { TranscriptView } from '../../src/tui/transcript/view.js';
import { createTranscriptCell } from '../../src/tui/transcript/model.js';

describe('tool operation summaries', () => {
  it.each([
    [{ pattern: 'watchStream', path: 'src' }, 'watchStream in src'],
    [{ query: 'watchStream', file_path: 'src/app.ts' }, 'watchStream in src/app.ts'],
    [{ command: 'pnpm test', cwd: 'packages/tui' }, 'pnpm test · in packages/tui'],
    [{ command: 'pnpm test', description: '验证 Bash 回归' }, '验证 Bash 回归'],
    [{ path: 'src/app.ts' }, 'src/app.ts'],
    [{ pattern: '\x1b[31m中文\x1b[0m\nsecond', path: 'src' }, '中文 in src'],
  ])('shows the operation and its scope: %j', (input, expected) => {
    expect(formatTuiToolSummary(JSON.stringify(input))).toBe(expected);
  });

  it('retains an earlier failed attempt when the same read later succeeds', () => {
    const cells = ['failed', 'succeeded'].map((status, index) => createTranscriptCell({
      id: `read-${index}`, kind: 'tool', title: 'read',
      status: status === 'failed' ? 'failed' : 'succeeded',
      content: JSON.stringify({ path: 'src/app.ts' }),
      detail: index === 0 ? 'Permission denied' : 'Read succeeded',
      turnId: 'turn', createdAtMs: index,
    }));
    const view = new TranscriptView(() => cells);
    const compact = stripVTControlCharacters(view.render(80).join('\n'));
    expect(compact).toContain('Read 1 file');
    expect(compact).toContain('1 failed');
    expect(compact).toContain('2 calls');
    view.toggleDetailMode();
    const detailed = stripVTControlCharacters(view.render(80).join('\n'));
    expect(detailed).toContain('Permission denied');
    expect(detailed).toContain('Read succeeded');
  });

  it('keeps different queries and tools on the same path distinct', () => {
    const cells = [
      { title: 'read', input: { path: 'src' } },
      { title: 'grep', input: { path: 'src', pattern: 'first' } },
      { title: 'grep', input: { path: 'src', pattern: 'second' } },
    ].map(({ title, input }, index) => createTranscriptCell({
      id: `tool-${index}`, kind: 'tool', title, status: 'succeeded',
      content: JSON.stringify(input), turnId: 'turn', createdAtMs: index,
    }));
    const view = new TranscriptView(() => cells);
    expect(stripVTControlCharacters(view.render(80).join('\n'))).toContain('Explored 3 operations');
    view.toggleDetailMode();
    const detailed = stripVTControlCharacters(view.render(80).join('\n'));
    expect(detailed).toContain('first in src');
    expect(detailed).toContain('second in src');
  });
});
