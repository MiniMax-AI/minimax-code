import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { visibleWidth } from '../../../../../src/tui/rendering/text.js';
import {
  applyTuiRenderTheme,
  getTuiThemeSnapshot,
  tuiChalk,
  tuiColors,
} from '../../../../../src/tui/theme/runtime.js';
import {
  MINIMAX_CODE_DARK_THEME,
  MINIMAX_CODE_LIGHT_THEME,
} from '../../../../../src/tui/theme/palettes.js';
import { wrapLiteralUserText } from '../../../../../src/tui/transcript/presentation/literal-text.js';

const plain = (lines: string[]): string[] => lines.map((line) => stripVTControlCharacters(line));

describe('wrapLiteralUserText', () => {
  const originalTheme = getTuiThemeSnapshot();
  const palette =
    originalTheme.appearance === 'light' ? MINIMAX_CODE_LIGHT_THEME : MINIMAX_CODE_DARK_THEME;

  beforeEach(() => {
    // Real color output, so styling assertions cannot pass vacuously.
    applyTuiRenderTheme(palette, 3);
  });

  afterEach(() => {
    applyTuiRenderTheme(palette, originalTheme.colorLevel);
  });

  it('keeps Markdown markers as typed', () => {
    const lines = wrapLiteralUserText(
      [
        'rm -rf __pycache__ && echo 2 * 3',
        '> not a quote',
        '# not a heading',
        '- [x] not a task',
      ].join('\n'),
      80,
    );

    expect(plain(lines)).toEqual([
      'rm -rf __pycache__ && echo 2 * 3',
      '> not a quote',
      '# not a heading',
      '- [x] not a task',
    ]);
  });

  it('colors every non-empty row with the theme text color and adds no emphasis', () => {
    const textColor = tuiChalk.hex(tuiColors.text)('x');
    const foreground = textColor.slice(0, textColor.indexOf('x'));
    const [first = '', blank, last = ''] = wrapLiteralUserText('**bold?** _italic?_\n\nsecond', 80);

    // Guard against a vacuous `startsWith('')` if color output were disabled.
    expect(foreground).not.toBe('');
    expect(first.startsWith(foreground)).toBe(true);
    expect(first).toContain('**bold?** _italic?_');
    expect(first).not.toContain('\x1b[1m');
    expect(first).not.toContain('\x1b[3m');
    // A blank row stays empty rather than carrying a dangling color pair.
    expect(blank).toBe('');
    expect(last.startsWith(foreground)).toBe(true);
    expect(stripVTControlCharacters(last)).toBe('second');
  });

  it('drops only trailing line breaks and keeps interior blank lines', () => {
    expect(plain(wrapLiteralUserText('one\n\n\ntwo\r\n\n\n', 80))).toEqual(['one', '', '', 'two']);
  });

  it('keeps leading indentation of pasted code', () => {
    expect(plain(wrapLiteralUserText('def f():\n    return 1', 80))).toEqual([
      'def f():',
      '    return 1',
    ]);
  });

  it('expands tabs so every row fits the requested width', () => {
    const lines = wrapLiteralUserText('\tindented\twith\ttabs and more words to wrap', 16);

    expect(lines.some((line) => line.includes('\t'))).toBe(false);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(16);
  });

  it('wraps CJK text and unbroken paths within the width', () => {
    const cjk = wrapLiteralUserText('删掉所有的缓存目录然后重新运行一遍测试看看结果是否正确', 12);
    const path = wrapLiteralUserText(
      '/very/long/unbroken/path/to/__pycache__/module.cpython-312.pyc',
      20,
    );

    for (const line of [...cjk, ...path]) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
    expect(plain(cjk).join('')).toBe('删掉所有的缓存目录然后重新运行一遍测试看看结果是否正确');
    expect(plain(path).join('')).toBe(
      '/very/long/unbroken/path/to/__pycache__/module.cpython-312.pyc',
    );
  });

  it('strips terminal control strings from the prompt', () => {
    const lines = wrapLiteralUserText('safe\x1b]52;c;U0VDUkVU\x07 \x1b[8mhidden?\x1b[0m', 80);

    expect(plain(lines)).toEqual(['safe hidden?']);
    expect(lines.join('')).not.toContain('U0VDUkVU');
    expect(lines.join('')).not.toContain('\x1b[8m');
  });

  it('returns no rows when nothing printable remains', () => {
    expect(wrapLiteralUserText('', 80)).toEqual([]);
    expect(wrapLiteralUserText('\n\n', 80)).toEqual([]);
    expect(wrapLiteralUserText('\x1b[31m\x1b[0m', 80)).toEqual([]);
  });
});
