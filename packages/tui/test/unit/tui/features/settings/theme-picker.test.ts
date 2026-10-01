import { describe, expect, it, vi } from 'vitest';

import { TuiThemePicker } from '../../../../../src/tui/features/settings/theme-picker.js';
import { stripAnsi } from '../../../../../src/tui/rendering/text.js';
import { BUILT_IN_THEMES } from '../../../../../src/tui/theme/palettes.js';
import type { TuiThemeDefinition } from '../../../../../src/tui/theme/contracts.js';

const CUSTOM: TuiThemeDefinition = {
  id: 'mine',
  label: 'Mine',
  description: 'Loaded from disk',
  source: 'custom',
  dark: BUILT_IN_THEMES[0]!.dark,
  light: BUILT_IN_THEMES[0]!.light,
};

const THEMES = [...BUILT_IN_THEMES, CUSTOM];

function build(overrides: Partial<ConstructorParameters<typeof TuiThemePicker>[0]> = {}) {
  const preview = vi.fn();
  const setAppearance = vi.fn();
  const save = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  const requestRender = vi.fn();
  const picker = new TuiThemePicker({
    themes: THEMES,
    currentThemeId: 'minimax',
    currentAppearance: 'dark',
    appearanceOverride: undefined,
    preview,
    setAppearance,
    save,
    onClose,
    requestRender,
    ...overrides,
  });
  return { picker, preview, setAppearance, save, onClose, requestRender };
}

describe('TuiThemePicker', () => {
  it('focuses the current theme and shows each theme with a color swatch', () => {
    const { picker } = build();

    const rendered = stripAnsi(picker.render(100).join('\n'));

    expect(rendered).toContain('Theme');
    expect(rendered).toContain('MCode');
    expect(rendered).toContain('Midnight');
    expect(rendered).toContain('Aurora');
    expect(rendered).toContain('Mine');
    expect(rendered).toContain('current');
    // The cursor starts on the theme that is already active.
    expect(rendered).toContain('› MCode');
  });

  it('previews the focused theme while navigating', () => {
    const { picker, preview, requestRender } = build();

    picker.handleInput('\u001b[B');
    expect(preview).toHaveBeenLastCalledWith(BUILT_IN_THEMES[1]!.id);
    expect(requestRender).toHaveBeenCalled();

    picker.handleInput('\u001b[A');
    expect(preview).toHaveBeenLastCalledWith('minimax');
  });

  it('wraps around at both ends of the list', () => {
    const { picker, preview } = build();

    picker.handleInput('\u001b[A');
    expect(preview).toHaveBeenLastCalledWith(CUSTOM.id);

    picker.handleInput('\u001b[B');
    expect(preview).toHaveBeenLastCalledWith('minimax');
  });

  it('selects light, auto, and dark with the left and right arrows', () => {
    const { picker, setAppearance } = build();

    picker.handleInput('\u001b[D');
    expect(setAppearance).toHaveBeenLastCalledWith('light');
    picker.handleInput('\u001b[D');
    expect(setAppearance).toHaveBeenCalledTimes(1);

    picker.handleInput('\u001b[C');
    expect(setAppearance).toHaveBeenLastCalledWith('auto');
    picker.handleInput('\u001b[C');
    expect(setAppearance).toHaveBeenLastCalledWith('dark');
    picker.handleInput('\u001b[C');
    expect(setAppearance).toHaveBeenCalledTimes(3);
  });

  it('ignores a as an appearance shortcut', () => {
    const { picker, preview, setAppearance, requestRender } = build();

    picker.handleInput('a');

    expect(setAppearance).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
  });

  it('saves the focused theme and closes', async () => {
    const { picker, save, onClose } = build();

    picker.handleInput('\u001b[B');
    picker.handleInput('\r');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(save).toHaveBeenCalledWith(BUILT_IN_THEMES[1]!.id, 'auto');
  });

  it('saves a pinned appearance alongside the theme', async () => {
    const { picker, save, onClose } = build();

    picker.handleInput('\u001b[B');
    picker.handleInput('\u001b[D');
    picker.handleInput('\r');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(save).toHaveBeenCalledWith(BUILT_IN_THEMES[1]!.id, 'light');
  });

  it('closes without saving when nothing changed', async () => {
    const { picker, save, onClose } = build();

    picker.handleInput('\r');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalled());

    expect(save).not.toHaveBeenCalled();
  });

  it('restores the original theme and appearance on cancel', () => {
    const { picker, preview, setAppearance, save, onClose } = build();

    picker.handleInput('\u001b[B');
    picker.handleInput('\u001b[D');
    preview.mockClear();
    picker.handleInput('\u001b');

    expect(preview).toHaveBeenCalledWith('minimax');
    expect(setAppearance).toHaveBeenLastCalledWith('auto');
    expect(save).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the picker open and reports a failed save', async () => {
    const save = vi.fn().mockRejectedValue(new Error('read-only'));
    const { picker, onClose, requestRender } = build({ save });

    picker.handleInput('\u001b[B');
    picker.handleInput('\r');
    await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());

    expect(onClose).not.toHaveBeenCalled();
    expect(stripAnsi(picker.render(100).join('\n'))).toContain(
      'Could not save the theme selection.',
    );
  });

  it('renders without a theme list', () => {
    const { picker } = build({ themes: [] });

    expect(stripAnsi(picker.render(80).join('\n'))).toContain('No themes available.');
  });

  it('fits a narrow terminal without overflowing', () => {
    const { picker } = build();

    for (const width of [40, 60, 100, 160]) {
      for (const line of picker.render(width)) {
        expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
      }
    }
  });
});
