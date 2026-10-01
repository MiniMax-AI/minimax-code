import { watch as watchFs, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  customThemesDirectory,
  loadCustomThemes,
  watchCustomThemes,
} from '../../../../src/tui/theme/custom-themes.js';
import { TuiThemeRegistry } from '../../../../src/tui/theme/registry.js';
import type { TuiThemeDefinition } from '../../../../src/tui/theme/contracts.js';
import {
  DEFAULT_THEME_ID,
  MINIMAX_CODE_DARK_THEME,
  MINIMAX_CODE_LIGHT_THEME,
} from '../../../../src/tui/theme/palettes.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, watch: vi.fn(actual.watch) };
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function themesDataDir(files: Readonly<Record<string, unknown>>): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), 'mcode-tui-themes-'));
  temporaryDirectories.push(dataDir);
  const directory = customThemesDirectory(dataDir);
  await mkdir(directory, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(directory, name), JSON.stringify(content, null, 2));
  }
  return dataDir;
}

/** Fail loudly instead of reaching for a non-null assertion on a test subject. */
function onlyTheme(themes: readonly TuiThemeDefinition[]): TuiThemeDefinition {
  expect(themes).toHaveLength(1);
  const [theme] = themes;
  if (!theme) throw new Error('expected exactly one loaded theme');
  return theme;
}

describe('custom TUI theme files', () => {
  it('reconciles edits missed during watcher startup and continues to reload later events', async () => {
    const dataDir = await themesDataDir({
      'mine.json': { name: 'mine', appearance: 'dark', colors: { brand: '#112233' } },
    });
    const file = join(customThemesDirectory(dataDir), 'mine.json');
    expect(onlyTheme(loadCustomThemes(dataDir).themes).dark.colors.brand).toBe('#112233');
    const close = vi.fn();
    vi.mocked(watchFs).mockReturnValueOnce({ on: vi.fn(), close } as never);
    vi.useFakeTimers();
    const onChange = vi.fn();
    const stop = watchCustomThemes(dataDir, onChange);
    try {
      // Model macOS dropping the first edit before native watching is ready.
      writeFileSync(
        file,
        JSON.stringify({ name: 'mine', appearance: 'dark', colors: { brand: '#AABBCC' } }),
      );
      await vi.advanceTimersByTimeAsync(150);
      expect(onChange).toHaveBeenCalledTimes(1);
      expect(onlyTheme(onChange.mock.calls[0]![0].themes).dark.colors.brand).toBe('#AABBCC');

      writeFileSync(
        file,
        JSON.stringify({ name: 'mine', appearance: 'dark', colors: { brand: '#DDEEFF' } }),
      );
      const fire = vi.mocked(watchFs).mock.calls.at(-1)![2]!;
      fire('change', 'mine.json');
      await vi.advanceTimersByTimeAsync(150);
      expect(onChange).toHaveBeenCalledTimes(2);
      expect(onlyTheme(onChange.mock.calls[1]![0].themes).dark.colors.brand).toBe('#DDEEFF');
    } finally {
      stop();
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it('cancels the startup reconciliation when disposed', async () => {
    const dataDir = await themesDataDir({});
    const close = vi.fn();
    vi.mocked(watchFs).mockReturnValueOnce({ on: vi.fn(), close } as never);
    vi.useFakeTimers();
    const onChange = vi.fn();
    const stop = watchCustomThemes(dataDir, onChange);
    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onChange).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('returns no themes when the directory is absent', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'mcode-tui-themes-empty-'));
    temporaryDirectories.push(dataDir);

    expect(loadCustomThemes(dataDir)).toEqual({ themes: [], issues: [] });
  });

  it('loads a partial file on top of the default palette', async () => {
    const dataDir = await themesDataDir({
      'mine.json': { name: 'mine', appearance: 'dark', colors: { brand: '#112233' } },
    });

    const { themes, issues } = loadCustomThemes(dataDir);

    expect(issues).toEqual([]);
    const theme = onlyTheme(themes);
    expect(theme.id).toBe('mine');
    expect(theme.source).toBe('custom');
    expect(theme.label).toBe('mine');
    expect(theme.dark.colors.brand).toBe('#112233');
    // Untouched roles keep the default palette so the theme is usable immediately.
    expect(theme.dark.colors.error).toBe(MINIMAX_CODE_DARK_THEME.colors.error);
  });

  it('resolves vars references and normalizes case', async () => {
    const dataDir = await themesDataDir({
      'vars.json': {
        name: 'vars',
        appearance: 'dark',
        vars: { brand: '#aabbcc' },
        colors: { brand: 'brand', accent: 'brand' },
      },
    });

    const { themes, issues } = loadCustomThemes(dataDir);

    expect(issues).toEqual([]);
    const theme = onlyTheme(themes);
    expect(theme.dark.colors.brand).toBe('#AABBCC');
    expect(theme.dark.colors.accent).toBe('#AABBCC');
  });

  it('pairs a dark and a light file into one selectable theme', async () => {
    const dataDir = await themesDataDir({
      'dual.json': { name: 'dual', appearance: 'dark', colors: { brand: '#010101' } },
      'dual-light.json': { name: 'dual', appearance: 'light', colors: { brand: '#fefefe' } },
    });

    const { themes } = loadCustomThemes(dataDir);

    const theme = onlyTheme(themes);
    expect(theme.dark.colors.brand).toBe('#010101');
    expect(theme.light.colors.brand).toBe('#FEFEFE');
  });

  it('falls back to the default palette for an appearance the files do not supply', async () => {
    const dataDir = await themesDataDir({
      'dark-only.json': { name: 'dark-only', appearance: 'dark', colors: { brand: '#010101' } },
    });

    const { themes } = loadCustomThemes(dataDir);

    const theme = onlyTheme(themes);
    expect(theme.dark.colors.brand).toBe('#010101');
    // The light variant is a complete, usable palette borrowed from the default
    // light theme — not a blank object and not the dark value.
    expect(theme.light.colors.brand).toBe(MINIMAX_CODE_LIGHT_THEME.colors.brand);
    expect(theme.light.colors.text).toBe(MINIMAX_CODE_LIGHT_THEME.colors.text);
    expect(theme.light.id).toBe('dark-only');
  });

  it('reports a malformed file without dropping valid themes', async () => {
    const dataDir = await themesDataDir({
      'good.json': { name: 'good', appearance: 'dark', colors: { brand: '#010101' } },
      'bad.json': { name: 'bad' },
      'badvar.json': {
        name: 'badvar',
        appearance: 'dark',
        colors: { brand: 'nope' },
      },
    });

    const { themes, issues } = loadCustomThemes(dataDir);

    expect(themes.map((theme) => theme.id)).toEqual(['good']);
    expect(issues).toHaveLength(2);
    expect(issues.map((issue) => issue.message).join(' ')).toMatch(/brand|appearance/u);
  });

  it('rejects a nested vars reference during validation', async () => {
    const dataDir = await themesDataDir({
      'nested.json': {
        name: 'nested',
        appearance: 'dark',
        // vars must hold literal colors; an identifier here would otherwise
        // pass validation and fail later with a misleading message.
        vars: { outer: 'inner', inner: '#112233' },
        colors: { brand: 'outer' },
      },
    });

    const { themes, issues } = loadCustomThemes(dataDir);

    expect(themes).toEqual([]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toMatch(/vars\/outer/u);
  });

  it('refuses to shadow a built-in theme id', async () => {
    const dataDir = await themesDataDir({
      'minimax.json': { name: 'minimax', appearance: 'dark', colors: { brand: '#010101' } },
    });

    const { themes, issues } = loadCustomThemes(dataDir);

    expect(themes).toEqual([]);
    expect(issues[0]?.message).toMatch(/built-in/u);
  });

  it('rejects ids that could escape the themes directory', async () => {
    const dataDir = await themesDataDir({
      'escape.json': { name: '../escape', appearance: 'dark', colors: { brand: '#010101' } },
    });

    const { themes, issues } = loadCustomThemes(dataDir);

    expect(themes).toEqual([]);
    expect(issues).toHaveLength(1);
  });
});

describe('TuiThemeRegistry', () => {
  it('lists built-ins first and layers custom themes after them', async () => {
    const dataDir = await themesDataDir({
      'mine.json': { name: 'mine', appearance: 'dark', colors: { brand: '#010101' } },
    });
    const registry = new TuiThemeRegistry();

    registry.applyLoadResult(loadCustomThemes(dataDir));

    const ids = registry.list().map((theme) => theme.id);
    expect(ids[0]).toBe(DEFAULT_THEME_ID);
    expect(ids).toContain('mine');
    expect(ids.filter((id) => id === 'minimax')).toHaveLength(1);
  });

  it('keeps a valid selection when unrelated custom themes reload', async () => {
    const dataDir = await themesDataDir({
      'mine.json': { name: 'mine', appearance: 'dark', colors: { brand: '#010101' } },
    });
    const registry = new TuiThemeRegistry();
    registry.applyLoadResult(loadCustomThemes(dataDir));
    registry.select('mine');

    registry.applyLoadResult(loadCustomThemes(dataDir));

    expect(registry.selectedIdValue()).toBe('mine');
  });

  it('falls back to the default theme when the selected theme disappears', async () => {
    const dataDir = await themesDataDir({
      'mine.json': { name: 'mine', appearance: 'dark', colors: { brand: '#010101' } },
    });
    const registry = new TuiThemeRegistry();
    registry.applyLoadResult(loadCustomThemes(dataDir));
    registry.select('mine');

    registry.applyLoadResult({ themes: [], issues: [] });

    expect(registry.selectedIdValue()).toBe(DEFAULT_THEME_ID);
  });

  it('rejects an unknown selection instead of clearing the current theme', async () => {
    const registry = new TuiThemeRegistry();
    registry.select('midnight');

    expect(registry.select('does-not-exist')).toBeUndefined();
    expect(registry.selectedIdValue()).toBe('midnight');
  });

  it('resolves a pinned light/dark selection against the current theme', () => {
    const registry = new TuiThemeRegistry();

    expect(registry.resolveSelection('aurora/dark')).toEqual({
      themeId: 'aurora',
      appearanceOverride: 'dark',
    });
    expect(registry.resolveSelection('AURORA/LIGHT')).toEqual({
      themeId: 'aurora',
      appearanceOverride: 'light',
    });
    // A pinned appearance for an unknown theme still resolves to the default.
    expect(registry.resolveSelection('nope/dark')).toEqual({ themeId: DEFAULT_THEME_ID });
    expect(registry.resolveSelection(undefined)).toEqual({ themeId: DEFAULT_THEME_ID });
  });

  it('picks the palette matching the requested appearance', () => {
    const registry = new TuiThemeRegistry();
    registry.select('midnight');

    expect(registry.paletteFor('dark').id).toBe('midnight');
    expect(registry.paletteFor('light').id).toBe('midnight');
    expect(registry.paletteFor('dark').colors.brand).not.toBe(
      registry.paletteFor('light').colors.brand,
    );
  });
});

describe('custom theme documentation', () => {
  const docPath = new URL('../../../../docs/theme-config.md', import.meta.url);

  it('ships a JSON example the loader actually accepts', async () => {
    const doc = await readFile(docPath, 'utf8');
    // The guide also shows tui-settings.json; only theme files carry `appearance`.
    const blocks = [...doc.matchAll(/```json\n([\s\S]*?)```/gu)]
      .map((match) => match[1] ?? '')
      .filter((block) => block.includes('"appearance"'));
    expect(blocks.length).toBeGreaterThan(0);

    const dataDir = await themesDataDir(
      Object.fromEntries(blocks.map((block, index) => [`doc-${index}.json`, JSON.parse(block)])),
    );

    const { themes, issues } = loadCustomThemes(dataDir);

    // A documented example that the schema rejects is worse than no example:
    // users copy it verbatim and the theme silently disappears from /theme.
    expect(issues).toEqual([]);
    expect(themes.length).toBe(blocks.length);
  });
});
