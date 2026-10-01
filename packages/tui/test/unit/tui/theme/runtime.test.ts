import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import {
  MINIMAX_CODE_DARK_THEME,
  MINIMAX_CODE_LIGHT_THEME,
} from '../../../../src/tui/theme/palettes.js';
import {
  MINIMAX_CODE_THEME_CONTRAST_POLICY,
  contrastRatio,
} from '../../../helpers/theme-contrast.js';
import {
  appearanceFromRgb,
  parseColorFgBgAppearance,
  resolveEnvironmentAppearance,
} from '../../../../src/tui/theme/detection.js';
import { TuiThemeController, type TuiThemeUi } from '../../../../src/tui/theme/controller.js';
import { bindThemeRendering } from '../../../../src/tui/theme/render-binding.js';
import type { TUI } from '../../../../src/tui/engine/public.js';
import {
  applyTuiRenderTheme,
  createTuiMarkdownTheme,
  getTuiThemeSnapshot,
  renderTuiActionHint,
  tuiChalk,
  tuiColors,
  tuiStreamingMarkdownTheme,
} from '../../../../src/tui/theme/runtime.js';

describe('MCode terminal theme palettes', () => {
  it.each([MINIMAX_CODE_DARK_THEME, MINIMAX_CODE_LIGHT_THEME])(
    'enforces readable semantic colors for the $appearance palette',
    (palette) => {
      const background = MINIMAX_CODE_THEME_CONTRAST_POLICY.backgrounds[palette.appearance];

      for (const role of MINIMAX_CODE_THEME_CONTRAST_POLICY.normalText.roles) {
        const exception = MINIMAX_CODE_THEME_CONTRAST_POLICY.normalText.exceptions.find(
          (candidate) => candidate.appearance === palette.appearance && candidate.role === role,
        );
        expect(
          contrastRatio(palette.colors[role], background),
          `${palette.appearance}.${role} must remain readable against ${background}`,
        ).toBeGreaterThanOrEqual(
          exception?.minimum ?? MINIMAX_CODE_THEME_CONTRAST_POLICY.normalText.minimum,
        );
      }
      for (const role of MINIMAX_CODE_THEME_CONTRAST_POLICY.nonText.roles) {
        expect(
          contrastRatio(palette.colors[role], background),
          `${palette.appearance}.${role} must remain distinguishable against ${background}`,
        ).toBeGreaterThanOrEqual(MINIMAX_CODE_THEME_CONTRAST_POLICY.nonText.minimum);
      }
    },
  );

  it('uses explicit ANSI16 semantics instead of nearest-RGB collisions', () => {
    const original = getTuiThemeSnapshot();
    const originalPalette =
      original.appearance === 'light' ? MINIMAX_CODE_LIGHT_THEME : MINIMAX_CODE_DARK_THEME;

    try {
      applyTuiRenderTheme(MINIMAX_CODE_DARK_THEME, 1);
      expect(tuiChalk.hex(tuiColors.text)('text')).toBe('text');
      expect(tuiChalk.bold.hex(tuiColors.text)('strong')).toContain('\u001B[1m');
      expect(tuiChalk.hex(tuiColors.muted)('muted')).toContain('\u001B[2m');
      expect(tuiChalk.hex(tuiColors.brand)('brand')).toContain('\u001B[36m');
      expect(tuiChalk.hex(tuiColors.signal)('signal')).toContain('\u001B[36m');
      expect(tuiChalk.hex(tuiColors.accent)('accent')).toContain('\u001B[36m');
      expect(tuiChalk.hex(tuiColors.line)('line')).toContain('\u001B[90m');
      expect(tuiChalk.hex(tuiColors.warning)('warning')).toContain('\u001B[93m');
      expect(tuiChalk.hex(tuiColors.error)('error')).toContain('\u001B[91m');
      expect(tuiChalk.bgHex(tuiColors.userMessageBg)('message')).toBe('message');
      expect(tuiChalk.bgHex(tuiColors.diffAddedBg)('addition')).toBe('addition');
      expect(tuiChalk.bgHex(tuiColors.diffRemovedBg)('deletion')).toBe('deletion');

      applyTuiRenderTheme(MINIMAX_CODE_DARK_THEME, 2);
      expect(tuiChalk.hex(tuiColors.text)('text')).toContain('\u001B[38;5;');
      expect(tuiChalk.hex(tuiColors.signal)('signal')).toContain('\u001B[38;5;');

      applyTuiRenderTheme(MINIMAX_CODE_DARK_THEME, 3);
      expect(tuiChalk.hex(tuiColors.text)('text')).toContain('\u001B[38;2;');
      expect(tuiChalk.hex(tuiColors.signal)('signal')).toContain('\u001B[38;2;');

      applyTuiRenderTheme(MINIMAX_CODE_LIGHT_THEME, 1);
      expect(tuiChalk.bold.hex(tuiColors.signal)('signal')).toContain('\u001B[94m');
      expect(tuiChalk.hex(tuiColors.line)('line')).toContain('\u001B[90m');
      expect(tuiChalk.hex(tuiColors.warning)('warning')).toContain('\u001B[33m');
      expect(tuiChalk.hex(tuiColors.error)('error')).toContain('\u001B[31m');
      expect(tuiChalk.bgHex(tuiColors.userMessageBg)('message')).toBe('message');
      expect(tuiChalk.bgHex(tuiColors.diffAddedBg)('addition')).toBe('addition');
      expect(tuiChalk.bgHex(tuiColors.diffRemovedBg)('deletion')).toBe('deletion');

      applyTuiRenderTheme(MINIMAX_CODE_LIGHT_THEME, 2);
      expect(tuiChalk.hex(tuiColors.signal)('signal')).toContain('\u001B[38;5;');
      expect(tuiChalk.bgHex(tuiColors.userMessageBg)('message')).toContain('\u001B[48;5;');
      expect(tuiChalk.bgHex(tuiColors.diffAddedBg)('addition')).toContain('\u001B[48;5;');
    } finally {
      applyTuiRenderTheme(originalPalette, original.colorLevel);
    }
  });

  it('keeps action guidance readable and makes keyboard controls prominent', () => {
    const original = getTuiThemeSnapshot();
    const originalPalette =
      original.appearance === 'light' ? MINIMAX_CODE_LIGHT_THEME : MINIMAX_CODE_DARK_THEME;

    try {
      applyTuiRenderTheme(MINIMAX_CODE_DARK_THEME, 3);
      const rendered = renderTuiActionHint(
        '↑↓ select · 1-9 choose · Enter confirm · d details · Ctrl+C stop · Option+M mode · /status refresh · Esc cancel',
      );

      expect(stripVTControlCharacters(rendered)).toBe(
        '↑↓ select · 1-9 choose · Enter confirm · d details · Ctrl+C stop · Option+M mode · /status refresh · Esc cancel',
      );
      for (const key of ['↑', '↓', '1-9', 'Enter', 'd', 'Ctrl+C', 'Option+M', '/status', 'Esc']) {
        expect(rendered).toContain(tuiChalk.bold.hex(tuiColors.text)(key));
      }
    } finally {
      applyTuiRenderTheme(originalPalette, original.colorLevel);
    }
  });

  it('uses adaptive Catppuccin syntax colors for settled and streaming code', () => {
    const original = getTuiThemeSnapshot();
    const originalPalette =
      original.appearance === 'light' ? MINIMAX_CODE_LIGHT_THEME : MINIMAX_CODE_DARK_THEME;
    const code = "const retries = 3; // keep streaming\nreturn 'ready';";

    try {
      applyTuiRenderTheme(MINIMAX_CODE_DARK_THEME, 3);
      const settled = createTuiMarkdownTheme().highlightCode?.(code, 'ts').join('\n');
      const streaming = tuiStreamingMarkdownTheme.highlightCode?.(code, 'ts').join('\n');

      expect(settled).toContain('\u001B[38;2;');
      expect(settled).not.toContain('\u001B[3m');
      expect(settled).not.toContain('\u001B[4m');
      expect(stripVTControlCharacters(settled ?? '')).toBe(code);
      expect(streaming).toBe(settled);

      applyTuiRenderTheme(MINIMAX_CODE_LIGHT_THEME, 3);
      const light = createTuiMarkdownTheme().highlightCode?.(code, 'ts').join('\n');

      expect(light).toContain('\u001B[38;2;');
      expect(light).not.toBe(settled);
      expect(stripVTControlCharacters(light ?? '')).toBe(code);
    } finally {
      applyTuiRenderTheme(originalPalette, original.colorLevel);
    }
  });
});

describe('MCode terminal appearance detection', () => {
  it('uses the final COLORFGBG component, including the ANSI 256 grayscale ramp', () => {
    expect(parseColorFgBgAppearance('15;0')).toBe('dark');
    expect(parseColorFgBgAppearance('0;15')).toBe('light');
    expect(parseColorFgBgAppearance('7;232')).toBe('dark');
    expect(parseColorFgBgAppearance('0;255')).toBe('light');
    expect(parseColorFgBgAppearance('broken')).toBeUndefined();
  });

  it('computes appearance from relative luminance', () => {
    expect(appearanceFromRgb({ r: 23, g: 23, b: 23 })).toBe('dark');
    expect(appearanceFromRgb({ r: 250, g: 250, b: 250 })).toBe('light');
  });

  it('falls back without treating the operating-system theme as terminal evidence', () => {
    expect(resolveEnvironmentAppearance({ COLORFGBG: '15;0' })).toMatchObject({
      appearance: 'dark',
      source: 'colorfgbg',
    });
    expect(resolveEnvironmentAppearance({})).toEqual({
      appearance: 'dark',
      source: 'fallback',
      detail: 'no terminal background hint',
    });
  });
});

describe('TuiThemeController', () => {
  it('uses Pi scheduled rendering when a theme change invalidates the component tree', async () => {
    const ui = new ThemeUi();
    ui.nextBackground = { r: 255, g: 255, b: 255 };
    const controller = new TuiThemeController({
      ui,
      colorLevel: 3,
      env: { COLORFGBG: '15;0' },
    });
    const invalidate = vi.fn();
    const requestRender = vi.fn();
    const rendering = bindThemeRendering(
      controller,
      { invalidate, requestRender } as unknown as TUI,
      () => true,
    );

    rendering.start();
    await vi.waitFor(() => expect(requestRender).toHaveBeenCalledOnce());

    expect(invalidate).toHaveBeenCalledOnce();
    expect(requestRender).toHaveBeenCalledWith();
    controller.dispose();
  });

  it('applies passive auto detection immediately through live theme bindings', () => {
    const ui = new ThemeUi();
    const controller = new TuiThemeController({
      ui,
      colorLevel: 3,
      env: { COLORFGBG: '0;15' },
    });

    expect(controller.snapshot()).toMatchObject({ appearance: 'light', source: 'colorfgbg' });
    expect(getTuiThemeSnapshot()).toMatchObject({ appearance: 'light' });
    expect(tuiColors.text).toBe(MINIMAX_CODE_LIGHT_THEME.colors.text);
    expect(tuiChalk.hex(tuiColors.text)('body')).toContain('38;2;48;48;48');
    controller.dispose();
  });

  it('uses passive evidence immediately and upgrades to terminal evidence asynchronously', async () => {
    const ui = new ThemeUi();
    ui.nextBackground = { r: 255, g: 255, b: 255 };
    const onChange = vi.fn();
    const controller = new TuiThemeController({
      ui,
      colorLevel: 3,
      env: { COLORFGBG: '15;0' },
    });
    controller.onChange(onChange);

    expect(controller.snapshot()).toMatchObject({ appearance: 'dark', source: 'colorfgbg' });
    await controller.start();

    expect(controller.snapshot()).toMatchObject({ appearance: 'light', source: 'osc11' });
    expect(onChange).toHaveBeenCalled();
  });

  it('uses the actual OSC 11 background when a terminal reports a conflicting appearance', async () => {
    const ui = new ThemeUi();
    ui.nextBackground = { r: 40, g: 44, b: 52 };
    const queryBackground = vi.spyOn(ui, 'queryTerminalBackgroundColor');
    const controller = new TuiThemeController({
      ui,
      colorLevel: 3,
      env: { COLORFGBG: '0;15' },
    });

    await controller.start();
    ui.emit('light');
    await vi.waitFor(() => expect(queryBackground).toHaveBeenCalledTimes(2));

    expect(controller.snapshot()).toMatchObject({ appearance: 'dark', source: 'osc11' });
    controller.dispose();
  });

  it('does not request a redraw when only the detection source changes', async () => {
    const ui = new ThemeUi();
    ui.nextBackground = { r: 0, g: 0, b: 0 };
    const onChange = vi.fn();
    const onDetection = vi.fn();
    const controller = new TuiThemeController({
      ui,
      colorLevel: 3,
      env: { COLORFGBG: '15;0' },
      onDetection,
    });
    controller.onChange(onChange);

    await controller.start();

    expect(controller.snapshot()).toMatchObject({ appearance: 'dark', source: 'osc11' });
    expect(onChange).not.toHaveBeenCalled();
    expect(onDetection).toHaveBeenLastCalledWith(
      expect.objectContaining({ appearance: 'dark', source: 'osc11' }),
    );
    controller.dispose();
  });

  it('falls back to environment evidence when later terminal queries time out', async () => {
    const ui = new ThemeUi();
    ui.nextBackground = { r: 255, g: 255, b: 255 };
    const controller = new TuiThemeController({
      ui,
      colorLevel: 3,
      env: { COLORFGBG: '15;0' },
    });

    await controller.start();
    expect(controller.snapshot()).toMatchObject({ appearance: 'light', source: 'osc11' });

    ui.nextBackground = undefined;
    await controller.start();

    expect(controller.snapshot()).toMatchObject({ appearance: 'dark', source: 'colorfgbg' });
    controller.dispose();
  });

  it('always tracks supported terminal appearance changes', async () => {
    const ui = new ThemeUi();
    const controller = new TuiThemeController({ ui, colorLevel: 3, env: {} });
    await controller.start();

    ui.nextBackground = { r: 255, g: 255, b: 255 };
    ui.emit('light');
    await vi.waitFor(() => expect(controller.snapshot().appearance).toBe('light'));
    controller.dispose();
  });

  it('follows a reported appearance change when the background query stops answering', async () => {
    const ui = new ThemeUi();
    ui.nextBackground = { r: 255, g: 255, b: 255 };
    const onChange = vi.fn();
    const controller = new TuiThemeController({
      ui,
      colorLevel: 3,
      env: { COLORFGBG: '0;15' },
    });
    controller.onChange(onChange);

    await controller.start();
    expect(controller.snapshot()).toMatchObject({ appearance: 'light', source: 'osc11' });

    ui.nextBackground = undefined;
    ui.emit('dark');

    await vi.waitFor(() =>
      expect(controller.snapshot()).toMatchObject({
        appearance: 'dark',
        source: 'terminal-report',
      }),
    );
    expect(onChange).toHaveBeenCalled();
    controller.dispose();
  });

  it('never lets the process-start COLORFGBG snapshot override a later terminal report', async () => {
    const ui = new ThemeUi();
    const controller = new TuiThemeController({
      ui,
      colorLevel: 3,
      env: { COLORFGBG: '0;15' },
    });

    await controller.start();
    ui.emit('dark');
    await vi.waitFor(() => expect(controller.snapshot().appearance).toBe('dark'));

    // A renderer rebind re-queries without a fresh report; the stale light COLORFGBG must not win.
    controller.rebindUi();
    await vi.waitFor(() => expect(controller.snapshot().source).toBe('terminal-report'));
    expect(controller.snapshot().appearance).toBe('dark');
    controller.dispose();
  });

  it('invalidates an in-flight terminal query when the active Pi renderer changes', async () => {
    const ui = new ThemeUi();
    let resolveOldQuery: ((value: { r: number; g: number; b: number }) => void) | undefined;
    const oldQuery = new Promise<{ r: number; g: number; b: number }>((resolve) => {
      resolveOldQuery = resolve;
    });
    const queryBackground = vi
      .spyOn(ui, 'queryTerminalBackgroundColor')
      .mockImplementationOnce(() => oldQuery)
      .mockResolvedValue({ r: 0, g: 0, b: 0 });
    const controller = new TuiThemeController({
      ui,
      colorLevel: 3,
      env: { COLORFGBG: '0;15' },
    });

    const starting = controller.start();
    await vi.waitFor(() => expect(queryBackground).toHaveBeenCalledOnce());
    controller.rebindUi();
    await vi.waitFor(() => expect(queryBackground).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(controller.snapshot()).toMatchObject({ appearance: 'dark', source: 'osc11' }),
    );

    resolveOldQuery?.({ r: 255, g: 255, b: 255 });
    await starting;
    expect(controller.snapshot()).toMatchObject({ appearance: 'dark', source: 'osc11' });
    controller.dispose();
  });
});

class ThemeUi implements TuiThemeUi {
  nextBackground: { r: number; g: number; b: number } | undefined;
  notificationsEnabled = false;
  private listener: ((scheme: 'light' | 'dark') => void) | undefined;

  async queryTerminalBackgroundColor() {
    return this.nextBackground;
  }

  setTerminalColorSchemeNotifications(enabled: boolean): void {
    this.notificationsEnabled = enabled;
  }

  onTerminalColorSchemeChange(listener: NonNullable<ThemeUi['listener']>): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = undefined;
    };
  }

  emit(scheme: Parameters<NonNullable<ThemeUi['listener']>>[0]): void {
    this.listener?.(scheme);
  }
}

describe('TuiThemeController theme selection', () => {
  const restoreTheme = () => {
    const snapshot = getTuiThemeSnapshot();
    applyTuiRenderTheme(
      snapshot.appearance === 'light' ? MINIMAX_CODE_LIGHT_THEME : MINIMAX_CODE_DARK_THEME,
      snapshot.colorLevel,
    );
  };

  it('applies the saved theme selection at construction', () => {
    const ui = new ThemeUi();
    const controller = new TuiThemeController({
      ui,
      colorLevel: 3,
      env: { COLORFGBG: '15;0' },
      theme: 'aurora',
    });

    expect(controller.selectedThemeId()).toBe('aurora');
    expect(controller.snapshot().themeId).toBe('aurora');
    expect(getTuiThemeSnapshot()).toMatchObject({ name: 'aurora', appearance: 'dark' });
    expect(tuiColors.brand).toBe('#5CC8E8');
    controller.dispose();
    restoreTheme();
  });

  it('falls back to the default theme when the saved theme is unknown', () => {
    const ui = new ThemeUi();
    const controller = new TuiThemeController({
      ui,
      colorLevel: 3,
      env: { COLORFGBG: '15;0' },
      theme: 'not-a-real-theme',
    });

    expect(controller.selectedThemeId()).toBe('minimax');
    controller.dispose();
    restoreTheme();
  });

  it('switches the live palette and notifies listeners on setTheme', () => {
    const ui = new ThemeUi();
    const controller = new TuiThemeController({ ui, colorLevel: 3, env: { COLORFGBG: '15;0' } });
    const onChange = vi.fn();
    controller.onChange(onChange);
    const before = tuiColors.brand;

    const applied = controller.setTheme('midnight');

    expect(applied?.id).toBe('midnight');
    expect(controller.selectedThemeId()).toBe('midnight');
    expect(tuiColors.brand).not.toBe(before);
    expect(tuiColors.brand).toBe('#5AB9FF');
    expect(onChange).toHaveBeenCalled();
    controller.dispose();
    restoreTheme();
  });

  it('keeps the current theme when an unknown id is requested', () => {
    const ui = new ThemeUi();
    const controller = new TuiThemeController({ ui, colorLevel: 3, env: { COLORFGBG: '15;0' } });
    controller.setTheme('graphite');
    const brand = tuiColors.brand;

    expect(controller.setTheme('nope')).toBeUndefined();

    expect(controller.selectedThemeId()).toBe('graphite');
    expect(tuiColors.brand).toBe(brand);
    controller.dispose();
    restoreTheme();
  });

  it('previews a theme without losing the previous selection on restore', () => {
    const ui = new ThemeUi();
    const controller = new TuiThemeController({ ui, colorLevel: 3, env: { COLORFGBG: '15;0' } });
    const original = tuiColors.brand;

    controller.previewTheme('aurora');
    expect(getTuiThemeSnapshot().name).toBe('aurora');

    controller.previewTheme('minimax');
    expect(tuiColors.brand).toBe(original);
    controller.dispose();
    restoreTheme();
  });

  it('repaints code blocks with the active theme syntax tones', () => {
    const ui = new ThemeUi();
    const controller = new TuiThemeController({ ui, colorLevel: 3, env: { COLORFGBG: '15;0' } });
    const code = "const retries = 3; // keep streaming\nreturn 'ready';";
    const minimaxCode = createTuiMarkdownTheme().highlightCode?.(code, 'ts').join('\n');

    controller.setTheme('midnight');
    const midnightCode = createTuiMarkdownTheme().highlightCode?.(code, 'ts').join('\n');

    expect(midnightCode).not.toBe(minimaxCode);
    expect(stripVTControlCharacters(midnightCode ?? '')).toBe(code);
    controller.dispose();
    restoreTheme();
  });

  it('pins the appearance so terminal evidence cannot override it', async () => {
    const ui = new ThemeUi();
    ui.nextBackground = { r: 0, g: 0, b: 0 };
    const controller = new TuiThemeController({ ui, colorLevel: 3, env: { COLORFGBG: '15;0' } });

    controller.setAppearanceOverride('light');
    await controller.start();
    ui.emit('dark');
    await vi.waitFor(() => expect(controller.snapshot().source).toBe('osc11'));

    expect(controller.snapshot().appearance).toBe('light');
    expect(getTuiThemeSnapshot().appearance).toBe('light');
    controller.dispose();
    restoreTheme();
  });

  it('restores terminal-driven appearance when the pin is cleared', async () => {
    const ui = new ThemeUi();
    ui.nextBackground = { r: 255, g: 255, b: 255 };
    const controller = new TuiThemeController({ ui, colorLevel: 3, env: { COLORFGBG: '15;0' } });
    await controller.start();

    controller.setAppearanceOverride('dark');
    expect(controller.snapshot().appearance).toBe('dark');

    // No extra query: clearing the pin must restore the last terminal verdict
    // immediately, which is what /theme's Esc and the auto cycle actually do.
    controller.setAppearanceOverride(undefined);

    expect(controller.appearanceOverrideValue()).toBeUndefined();
    expect(controller.snapshot().appearance).toBe('light');
    expect(getTuiThemeSnapshot().appearance).toBe('light');
    expect(tuiColors.text).toBe(MINIMAX_CODE_LIGHT_THEME.colors.text);
    controller.dispose();
    restoreTheme();
  });

  it('restores a dark terminal verdict when clearing a light pin', async () => {
    const ui = new ThemeUi();
    ui.nextBackground = { r: 0, g: 0, b: 0 };
    const controller = new TuiThemeController({ ui, colorLevel: 3, env: { COLORFGBG: '15;0' } });
    await controller.start();
    expect(controller.snapshot().appearance).toBe('dark');

    controller.setAppearanceOverride('light');
    expect(controller.snapshot().appearance).toBe('light');

    controller.setAppearanceOverride(undefined);

    expect(controller.snapshot().appearance).toBe('dark');
    expect(tuiColors.text).toBe(MINIMAX_CODE_DARK_THEME.colors.text);
    controller.dispose();
    restoreTheme();
  });

  it('repaints live colors when a custom theme file changes in place', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dataDir = await mkdtemp(join(tmpdir(), 'mcode-theme-reload-'));
    let controller: TuiThemeController | undefined;
    try {
      const themesDir = join(dataDir, 'tui', 'themes');
      await mkdir(themesDir, { recursive: true });
      const file = join(themesDir, 'mine.json');
      const write = (brand: string) =>
        writeFile(file, JSON.stringify({ name: 'mine', appearance: 'dark', colors: { brand } }));

      await write('#112233');
      const ui = new ThemeUi();
      controller = new TuiThemeController({
        ui,
        colorLevel: 3,
        env: { COLORFGBG: '15;0' },
        dataDir,
      });
      expect(controller.setTheme('mine')).toBeDefined();
      expect(tuiColors.brand).toBe('#112233');
      const onChange = vi.fn();
      controller.onChange(onChange);

      // Same id, same appearance — only the color values move.
      await write('#AABBCC');
      await vi.waitFor(() => expect(tuiColors.brand).toBe('#AABBCC'), { timeout: 4000 });

      expect(controller.selectedThemeId()).toBe('mine');
      expect(onChange).toHaveBeenCalled();
    } finally {
      controller?.dispose();
      await rm(dataDir, { recursive: true, force: true });
      restoreTheme();
    }
  });

  it('does not repaint when a custom theme reload changes nothing', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dataDir = await mkdtemp(join(tmpdir(), 'mcode-theme-noop-'));
    let controller: TuiThemeController | undefined;
    try {
      const themesDir = join(dataDir, 'tui', 'themes');
      await mkdir(themesDir, { recursive: true });
      const file = join(themesDir, 'mine.json');
      const body = JSON.stringify({
        name: 'mine',
        appearance: 'dark',
        colors: { brand: '#112233' },
      });
      await writeFile(file, body);

      const ui = new ThemeUi();
      const onThemesChanged = vi.fn();
      controller = new TuiThemeController({
        ui,
        colorLevel: 3,
        env: { COLORFGBG: '15;0' },
        dataDir,
        onThemesChanged,
      });
      controller.setTheme('mine');
      const onChange = vi.fn();
      controller.onChange(onChange);
      // Let the constructor load and startup reconciliation finish before the
      // no-op edit, so this assertion still requires a native watcher event.
      await vi.waitFor(() => expect(onThemesChanged.mock.calls.length).toBeGreaterThanOrEqual(2), {
        timeout: 4000,
      });
      onThemesChanged.mockClear();

      await writeFile(file, body);
      // Wait for the reload to actually land. A bare sleep would also pass when
      // the watcher never fired, which is exactly what this test must rule out.
      await vi.waitFor(() => expect(onThemesChanged).toHaveBeenCalled(), { timeout: 4000 });

      expect(tuiColors.brand).toBe('#112233');
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      controller?.dispose();
      await rm(dataDir, { recursive: true, force: true });
      restoreTheme();
    }
  });

  it('applies a pinned appearance from the saved selection', () => {
    const ui = new ThemeUi();
    ui.nextBackground = { r: 0, g: 0, b: 0 };
    const controller = new TuiThemeController({
      ui,
      colorLevel: 3,
      env: { COLORFGBG: '15;0' },
      theme: 'aurora/light',
    });

    expect(controller.selectedThemeId()).toBe('aurora');
    expect(controller.appearanceOverrideValue()).toBe('light');
    expect(controller.snapshot().appearance).toBe('light');
    expect(tuiColors.text).toBe('#1E2B31');
    controller.dispose();
    restoreTheme();
  });

  it('lists built-in themes and surfaces custom load problems', async () => {
    const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dataDir = await mkdtemp(join(tmpdir(), 'mcode-theme-controller-'));
    try {
      await mkdir(join(dataDir, 'tui', 'themes'), { recursive: true });
      await writeFile(
        join(dataDir, 'tui', 'themes', 'broken.json'),
        JSON.stringify({ name: 'broken' }),
      );
      const ui = new ThemeUi();
      const controller = new TuiThemeController({
        ui,
        colorLevel: 3,
        env: { COLORFGBG: '15;0' },
        dataDir,
      });

      expect(controller.listThemes().map((theme) => theme.id)).toContain('minimax');
      expect(controller.themeIssues()).toHaveLength(1);
      controller.dispose();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
      restoreTheme();
    }
  });
});
