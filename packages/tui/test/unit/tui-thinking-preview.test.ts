import { stripVTControlCharacters } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as textLayout from '../../src/tui/engine/utils.js';
import { TuiTranscriptPanel } from '../../src/tui/features/transcript/panel.js';
import { formatTuiTranscriptMarkdown } from '../../src/tui/transcript/export.js';
import { createTranscriptCell } from '../../src/tui/transcript/model.js';
import { TranscriptStore } from '../../src/tui/transcript/store.js';
import { TranscriptView } from '../../src/tui/transcript/view.js';
import { MINIMAX_CODE_DARK_THEME, MINIMAX_CODE_LIGHT_THEME } from '../../src/tui/theme/palettes.js';
import { applyTuiRenderTheme, getTuiThemeSnapshot } from '../../src/tui/theme/runtime.js';

function thinkingStore(content: string, status: 'running' | 'failed' | 'succeeded' = 'running') {
  return new TranscriptStore([
    createTranscriptCell({ id: 'thinking', kind: 'thinking', status, content, createdAtMs: 1 }),
  ]);
}

describe('Thinking preview', () => {
  it.each(['assistant', 'thinking'] as const)(
    'sanitizes %s in the expanded transcript inspector',
    (kind) => {
      const control = '\x1b]52;c;U1lOVEhFVElD\x07';
      const store = new TranscriptStore([
        createTranscriptCell({
          id: 'untrusted-inspector',
          kind,
          status: 'succeeded',
          content: `${control}\x1b[8mVisible text\x1b[0m`,
          createdAtMs: 1,
        }),
      ]);
      const panel = new TuiTranscriptPanel({
        source: store,
        onCancel: () => undefined,
        requestRender: () => undefined,
      });
      panel.handleInput('\u000f');
      const rendered = panel.render(100).join('\n');
      expect(rendered).not.toContain(control);
      expect(rendered).not.toContain('\x1b[8m');
      expect(stripVTControlCharacters(rendered)).toContain('Visible text');
    },
  );
  afterEach(() => vi.restoreAllMocks());

  it('bounds colored layout work while new deltas stream into the same full cell', () => {
    const originalTheme = getTuiThemeSnapshot();
    const wrap = vi.spyOn(textLayout, 'wrapTextWithAnsi');
    const store = thinkingStore('Original reasoning\n');
    const view = new TranscriptView(store);
    let fullContent = store.get('thinking')!.content;
    applyTuiRenderTheme(MINIMAX_CODE_DARK_THEME, 2);
    try {
      for (const index of [1, 2, 3]) {
        const delta = `${'A previous reasoning line.\n'.repeat(4_000)}Latest step ${index}`;
        fullContent += delta;
        store.queueTextDelta('thinking', delta);
        store.flushTextDeltas(index + 1);
        wrap.mockClear();
        const rendered = stripVTControlCharacters(view.render(1_000).join('\n'));

        expect(rendered).toContain(`Latest step ${index}`);
        expect(rendered).toContain('… earlier content');
        expect(rendered).not.toContain('Original reasoning');
        // Assert bounded input to the real layout engine, not a timing threshold.
        const layoutChars = wrap.mock.calls.reduce(
          (total, [text]) => total + stripVTControlCharacters(text).length,
          0,
        );
        expect(layoutChars).toBeGreaterThan(0);
        expect(layoutChars).toBeLessThan(2_500);
        expect(store.length).toBe(1);
        expect(store.get('thinking')?.content).toBe(fullContent);
      }
    } finally {
      applyTuiRenderTheme(
        originalTheme.appearance === 'light' ? MINIMAX_CODE_LIGHT_THEME : MINIMAX_CODE_DARK_THEME,
        originalTheme.colorLevel,
      );
    }
  });

  it.each(['running', 'failed', 'succeeded'] as const)(
    'keeps the correct edge and omission hint for a long %s preview that fits in three rows',
    (status) => {
      const store = thinkingStore(`HEAD ${'x'.repeat(8_000)} TAIL`, status);
      const view = new TranscriptView(store, {
        displayModes: { revision: 0, resolveMainDisplayMode: () => 'preview' },
      });
      const lines = view.render(1_000).map(stripVTControlCharacters);
      const head = status === 'succeeded';
      expect(lines.join('\n')).toContain(head ? 'HEAD' : 'TAIL');
      expect(lines.join('\n')).not.toContain(head ? 'TAIL' : 'HEAD');
      expect(lines.join('\n')).toContain(head ? '… more content' : '… earlier content');
      expect(lines.join('\n')).not.toMatch(/\d+ (?:earlier|more) lines/u);
      expect(lines.length).toBeLessThanOrEqual(5);
    },
  );

  it.each(['running', 'succeeded'] as const)('keeps Unicode intact at the %s cut', (status) => {
    const content =
      status === 'running'
        ? `old content🙂${'中'.repeat(1_999)}`
        : `${'中'.repeat(1_999)}🙂new content`;
    const store = thinkingStore(content, status);
    const view = new TranscriptView(store, {
      displayModes: { revision: 0, resolveMainDisplayMode: () => 'preview' },
    });
    const wrap = vi.spyOn(textLayout, 'wrapTextWithAnsi');
    view.render(1_000);
    for (const [text] of wrap.mock.calls) {
      expect(text).not.toMatch(/[\uD800-\uDFFF]/u);
    }
    expect(store.get('thinking')?.content).toBe(content);
  });

  it('preserves full detail toggling and Transcript search/copy after previewing long thinking', async () => {
    const content = `Original reasoning\n${'intermediate step\n'.repeat(300)}Latest reasoning`;
    const store = thinkingStore(content);
    const view = new TranscriptView(store);
    const exportedBefore = formatTuiTranscriptMarkdown(store);
    expect(view.render(80).join('\n')).not.toContain('Original reasoning');
    view.toggleDetailMode();
    expect(view.render(80).join('\n')).toContain('Original reasoning');
    expect(view.render(80).join('\n')).toContain('Latest reasoning');
    view.toggleDetailMode();
    expect(view.render(80).join('\n')).not.toContain('Original reasoning');

    const writeClipboardText = vi.fn(async (_text: string) => undefined);
    const panel = new TuiTranscriptPanel({
      source: store,
      onCancel: vi.fn(),
      requestRender: vi.fn(),
      writeClipboardText,
    });
    panel.handleInput('/');
    panel.handleInput('Original reasoning');
    panel.handleInput('\r');
    expect(panel.render(80).join('\n')).toContain('1 match');
    const wrap = vi.spyOn(textLayout, 'wrapTextWithAnsi');
    panel.handleInput('\u000f'); // Ctrl+O expands all blocks in the inspector.
    panel.render(80);
    expect(
      wrap.mock.calls.some(([text]) => stripVTControlCharacters(text).includes(content)),
    ).toBe(true);
    panel.handleInput('c');
    await vi.waitFor(() => expect(writeClipboardText).toHaveBeenCalledOnce());
    expect(writeClipboardText.mock.calls[0]?.[0]).toContain(content);
    expect(store.get('thinking')?.content).toBe(content);
    // Export keeps its existing policy (thinking is not included).
    expect(formatTuiTranscriptMarkdown(store)).toBe(exportedBefore);
  });
});
