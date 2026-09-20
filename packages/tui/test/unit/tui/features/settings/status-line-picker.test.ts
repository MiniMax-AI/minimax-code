import { describe, expect, it, vi } from 'vitest';
import { TuiStatusLinePicker, type TuiStatusLinePickerOptions } from '../../../../../src/tui/features/settings/status-line-picker.js';
import { TuiStatusLine } from '../../../../../src/tui/shell/chrome.js';
import { visibleWidth } from '../../../../../src/tui/rendering/text.js';
import { CURSOR_MARKER } from '../../../../../src/tui/rendering/component.js';

function fixture(overrides: Partial<TuiStatusLinePickerOptions> = {}) {
  const options = {
    items: ['model', 'current-dir'] as const,
    preview: (items, width, height) => ({
      lines: new TuiStatusLine({ version: '0.1', workspace: '/repo', runtimeStatus: 'ready', model: 'MiniMax', statusLineItems: items }).renderViewport(width, height),
      unavailable: [],
    }),
    save: vi.fn(async () => undefined),
    onClose: vi.fn(), requestRender: vi.fn(), locale: 'en',
    ...overrides,
  } satisfies TuiStatusLinePickerOptions;
  return { picker: new TuiStatusLinePicker(options), options };
}

describe('status line picker', () => {
  it('lets an existing custom layout enable the context window capacity', async () => {
    const { picker, options } = fixture();
    picker.handleInput('context-window');
    expect(picker.render(100).join('\n')).toContain('Context window capacity');
    picker.handleInput(' ');
    picker.handleInput('\r');
    await vi.waitFor(() => expect(options.onClose).toHaveBeenCalledOnce());
    expect(options.save).toHaveBeenCalledWith(['model', 'current-dir', 'context-window']);
  });

  it('anchors the search cursor and accepts bracketed pasted text without selecting items', () => {
    const { picker, options } = fixture();
    picker.focused = true;
    picker.handleInput('\x1b[200~current-dir\x1b[201~');
    const lines = picker.render(80);
    expect(lines.some((line) => line.includes('current-dir') && line.includes(CURSOR_MARKER))).toBe(true);
    expect(lines.join('\n')).toContain('[x] current-dir');
    expect(options.save).not.toHaveBeenCalled();
    picker.focused = false;
    expect(picker.render(80).join('\n')).not.toContain(CURSOR_MARKER);
  });
  it('previews reordering and toggles locally, persisting the selected order only on Enter', async () => {
    const { picker, options } = fixture();
    picker.handleInput('\x1b[C');
    expect(picker.render(100).join('\n')).toMatch(/\/repo.*MiniMax/);
    expect(options.save).not.toHaveBeenCalled();
    picker.handleInput('\r');
    await vi.waitFor(() => expect(options.onClose).toHaveBeenCalledOnce());
    expect(options.save).toHaveBeenCalledWith(['current-dir', 'model']);
  });

  it('cancels the local draft and skips writing when the original selection is unchanged', () => {
    const first = fixture();
    first.picker.handleInput(' ');
    first.picker.handleInput('\x1b');
    expect(first.options.save).not.toHaveBeenCalled();
    expect(first.options.onClose).toHaveBeenCalledOnce();
    const second = fixture();
    second.picker.handleInput('\r');
    expect(second.options.save).not.toHaveBeenCalled();
    expect(second.options.onClose).toHaveBeenCalledOnce();
  });

  it('preserves an explicit empty selection and restores defaults separately', async () => {
    const first = fixture({ items: ['model'] });
    first.picker.handleInput(' ');
    expect(first.picker.render(80).join('\n')).toContain('Status line hidden');
    first.picker.handleInput('\r');
    await vi.waitFor(() => expect(first.options.onClose).toHaveBeenCalledOnce());
    expect(first.options.save).toHaveBeenCalledWith([]);
    const second = fixture({ items: [] });
    second.picker.handleInput('\x12');
    second.picker.handleInput('\r');
    await vi.waitFor(() => expect(second.options.onClose).toHaveBeenCalledOnce());
    expect(second.options.save).toHaveBeenCalledWith(undefined);
  });

  it('filters without letting arrows reorder a filtered list', async () => {
    const { picker, options } = fixture();
    picker.handleInput('current-dir');
    picker.handleInput('\x1b[D');
    picker.handleInput(' ');
    picker.handleInput('\r');
    await vi.waitFor(() => expect(options.onClose).toHaveBeenCalledOnce());
    expect(options.save).toHaveBeenCalledWith(['model']);
  });

  it('keeps the draft open after a save failure and allows retry', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('private detail')).mockResolvedValue(undefined);
    const { picker, options } = fixture({ save });
    picker.handleInput(' ');
    picker.handleInput('\r');
    await vi.waitFor(() => expect(picker.render(120).join('\n')).toContain('Could not save'));
    expect(options.onClose).not.toHaveBeenCalled();
    expect(picker.render(120).join('\n')).not.toContain('private detail');
    picker.handleInput('\r');
    await vi.waitFor(() => expect(options.onClose).toHaveBeenCalledOnce());
    expect(save).toHaveBeenCalledTimes(2);
  });

  it('does not duplicate a pending save or close a replaced panel when it finishes', async () => {
    let finish!: () => void;
    const save = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { picker, options } = fixture({ save });
    picker.handleInput(' ');
    picker.handleInput('\r');
    picker.handleInput('\r');
    picker.handleInput('\x1b');
    expect(save).toHaveBeenCalledOnce();
    expect(options.onClose).not.toHaveBeenCalled();
    picker.dispose();
    finish();
    await Promise.resolve();
    expect(options.onClose).not.toHaveBeenCalled();
  });

  it('keeps machine mode read-only and out of the ordinary item list', () => {
    const normal = fixture();
    expect(normal.picker.render(120).join('\n')).not.toContain('build-mode');
    const locked = fixture({ items: ['build-mode', 'custom-command'] });
    locked.picker.handleInput(' ');
    locked.picker.handleInput('\x12');
    expect(locked.picker.render(120).join('\n')).toContain('startup-only');
    locked.picker.handleInput('\r');
    expect(locked.options.save).not.toHaveBeenCalled();
  });

  it.each(['en', 'zh-Hans'])('keeps selection and controls usable in a small viewport (%s)', (locale) => {
    const { picker } = fixture({ locale });
    for (let index = 0; index < 12; index += 1) picker.handleInput('\x1b[B');
    const lines = picker.renderViewport(36, 10);
    expect(lines.length).toBeLessThanOrEqual(10);
    expect(lines.every((line) => visibleWidth(line) <= 36)).toBe(true);
    expect(lines.join('\n')).toContain('›');
    expect(lines.join('\n')).toContain('Esc');
  });

  it('explains missing data without substituting fabricated metrics', () => {
    const { picker } = fixture({
      items: ['cache-read-ratio'],
      preview: () => ({ lines: [], unavailable: ['cache-read-ratio'] }),
    });
    expect(picker.render(120).join('\n')).toContain('No current data');
    expect(picker.render(120).join('\n')).not.toContain('0%');
  });
});


describe('context meter settings', () => {
  it.each([
    ['en', 'Remaining context gauge'],
    ['zh-Hans', '剩余上下文刻度条'],
  ])('describes and saves the opt-in item in %s', async (locale, description) => {
    const { picker, options } = fixture({ locale });
    picker.handleInput('context-meter');
    expect(picker.render(100).join('\n')).toContain(description);
    expect(picker.render(100).join('\n')).toContain('[ ] context-meter');
    picker.handleInput(' ');
    picker.handleInput('\r');
    await vi.waitFor(() => expect(options.onClose).toHaveBeenCalledOnce());
    expect(options.save).toHaveBeenCalledWith(['model', 'current-dir', 'context-meter']);
  });
});
