import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readTuiModeSetting,
  readTuiThemeSetting,
  writeTuiModeSetting,
  writeTuiThemeSetting,
} from '../../src/host/tui-settings.js';
import { readTuiPresentationConfig } from '../../src/tui/shell/status-line-config.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function temporaryDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'mcode-tui-settings-'));
  directories.push(directory);
  return directory;
}

describe('terminal presentation configuration', () => {
  it.each(['null', '[]', '[session-name, status]'])(
    'preserves terminalTitle %s through the config loader',
    async (title) => {
      const dataDir = await temporaryDataDir();
      await writeFile(
        join(dataDir, 'config.yaml'),
        `tui:\n  terminalTitle: ${title}\n  notifications:\n    when: unfocused\n    method: bel\n    events: [permission-required, turn-failed]\n`,
        'utf8',
      );
      const settings = await readTuiPresentationConfig(dataDir);
      expect(settings.terminalTitle).toEqual(
        title === 'null' ? null : title === '[]' ? [] : ['session-name', 'status'],
      );
      expect(settings.notifications).toEqual({
        when: 'unfocused',
        method: 'bel',
        events: ['permission-required', 'turn-failed'],
      });
    },
  );
});

describe('TUI mode settings', () => {
  it('uses regular mode when no valid explicit setting exists', async () => {
    const dataDir = await temporaryDataDir();

    expect(readTuiModeSetting(dataDir)).toBe('regular');
    await mkdir(join(dataDir, 'tui'), { recursive: true });
    await writeFile(join(dataDir, 'tui', 'tui-settings.json'), '{broken', 'utf8');
    expect(readTuiModeSetting(dataDir)).toBe('regular');
    await writeFile(join(dataDir, 'tui', 'tui-settings.json'), '{"tuiMode":"other"}', 'utf8');
    expect(readTuiModeSetting(dataDir)).toBe('regular');
  });

  it('persists the selected fullscreen mode in the MCode data directory', async () => {
    const dataDir = await temporaryDataDir();

    writeTuiModeSetting(dataDir, 'fullscreen');

    expect(readTuiModeSetting(dataDir)).toBe('fullscreen');
    expect(JSON.parse(await readFile(join(dataDir, 'tui', 'tui-settings.json'), 'utf8'))).toEqual({
      tuiMode: 'fullscreen',
    });
  });

  it('accepts a UTF-8 BOM written by Windows editors', async () => {
    const dataDir = await temporaryDataDir();
    await mkdir(join(dataDir, 'tui'), { recursive: true });
    await writeFile(
      join(dataDir, 'tui', 'tui-settings.json'),
      '\uFEFF{"tuiMode":"fullscreen"}',
      'utf8',
    );

    expect(readTuiModeSetting(dataDir)).toBe('fullscreen');
  });

  it('reads the legacy root file without writing back to the root', async () => {
    const dataDir = await temporaryDataDir();
    await writeFile(join(dataDir, 'tui-settings.json'), '{"tuiMode":"fullscreen"}', 'utf8');

    expect(readTuiModeSetting(dataDir)).toBe('fullscreen');
    writeTuiModeSetting(dataDir, 'regular');
    expect(JSON.parse(await readFile(join(dataDir, 'tui', 'tui-settings.json'), 'utf8'))).toEqual({
      tuiMode: 'regular',
    });
  });
});

describe('TUI theme settings', () => {
  it('uses no theme override when nothing is saved', async () => {
    const dataDir = await temporaryDataDir();

    expect(readTuiThemeSetting(dataDir)).toBeUndefined();
  });

  it('round-trips a theme and a pinned appearance', async () => {
    const dataDir = await temporaryDataDir();

    writeTuiThemeSetting(dataDir, 'aurora');
    expect(readTuiThemeSetting(dataDir)).toBe('aurora');

    writeTuiThemeSetting(dataDir, 'aurora/dark');
    expect(readTuiThemeSetting(dataDir)).toBe('aurora/dark');
  });

  it('does not drop the theme when the TUI mode is written afterwards', async () => {
    const dataDir = await temporaryDataDir();

    writeTuiThemeSetting(dataDir, 'midnight');
    writeTuiModeSetting(dataDir, 'fullscreen');

    expect(readTuiThemeSetting(dataDir)).toBe('midnight');
    expect(readTuiModeSetting(dataDir)).toBe('fullscreen');
  });

  it('does not drop the TUI mode when the theme is written afterwards', async () => {
    const dataDir = await temporaryDataDir();

    writeTuiModeSetting(dataDir, 'fullscreen');
    writeTuiThemeSetting(dataDir, 'graphite');

    expect(readTuiModeSetting(dataDir)).toBe('fullscreen');
    expect(readTuiThemeSetting(dataDir)).toBe('graphite');
  });

  it('rejects a theme id that is not a safe identifier', async () => {
    const dataDir = await temporaryDataDir();

    expect(() => writeTuiThemeSetting(dataDir, '../escape')).toThrow();
    expect(() => writeTuiThemeSetting(dataDir, 'a/b/c')).toThrow();
  });

  it('ignores a malformed saved theme instead of failing startup', async () => {
    const dataDir = await temporaryDataDir();
    await mkdir(join(dataDir, 'tui'), { recursive: true });
    await writeFile(
      join(dataDir, 'tui', 'tui-settings.json'),
      JSON.stringify({ theme: { nested: true } }),
      'utf8',
    );

    expect(readTuiThemeSetting(dataDir)).toBeUndefined();
    expect(readTuiModeSetting(dataDir)).toBe('regular');
  });

  it('ignores a saved theme that tries to traverse a path', async () => {
    const dataDir = await temporaryDataDir();
    await mkdir(join(dataDir, 'tui'), { recursive: true });
    await writeFile(
      join(dataDir, 'tui', 'tui-settings.json'),
      JSON.stringify({ theme: '../../etc/passwd' }),
      'utf8',
    );

    expect(readTuiThemeSetting(dataDir)).toBeUndefined();
  });

  it('keeps unknown settings keys when rewriting a known one', async () => {
    const dataDir = await temporaryDataDir();
    await mkdir(join(dataDir, 'tui'), { recursive: true });
    await writeFile(
      join(dataDir, 'tui', 'tui-settings.json'),
      JSON.stringify({ futureSetting: 'keep-me' }),
      'utf8',
    );

    writeTuiThemeSetting(dataDir, 'aurora');

    const document = JSON.parse(
      await readFile(join(dataDir, 'tui', 'tui-settings.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(document.futureSetting).toBe('keep-me');
    expect(document.theme).toBe('aurora');
  });
});
