import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getTuiDataDirPath,
  prepareTuiDataDir,
  resolveDefaultTuiDataDir,
} from '../../src/runtime/data-dir.js';

const originalPlatform = process.platform;
let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tui-data-dir-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.stubEnv('XDG_DATA_HOME', '');
});
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
});
function defaultPath(profile?: string): string {
  return process.platform === 'linux'
    ? join(home, '.local', 'share', profile ? `minimax-${profile}` : 'minimax')
    : join(home, profile ? `.minimax-${profile}` : '.minimax');
}

describe('TUI data directory', () => {
  it.each(['dev', 'test', 'staging', 'prod'] as const)(
    'uses the shared user directory for %s builds',
    (buildEnv) => {
      expect(resolveDefaultTuiDataDir(buildEnv, undefined, () => null)).toBe(
        defaultPath(),
      );
    },
  );

  it('keeps the shared profile suffix', () => {
    expect(resolveDefaultTuiDataDir('prod', undefined, () => 'smoke')).toBe(
      defaultPath('smoke'),
    );
  });

  it('passes existing Linux data through startup without switching to XDG', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const existing = join(home, '.minimax');
    fs.mkdirSync(existing);
    fs.writeFileSync(join(existing, 'config.yaml'), 'synthetic: true');
    const configureRuntimeEnvironment = vi.fn();
    await expect(prepareTuiDataDir({
      environment: {},
      getDefaultDataDir: () => resolveDefaultTuiDataDir('prod', undefined, () => null),
      configureRuntimeEnvironment,
    })).resolves.toBe(existing);
    expect(configureRuntimeEnvironment).toHaveBeenCalledWith({ dataDir: existing });
    expect(fs.readFileSync(join(existing, 'config.yaml'), 'utf8')).toBe('synthetic: true');
  });

  it('runs legacy migration before exporting the data directory override', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const legacy = join(home, '.mavis');
    fs.mkdirSync(legacy);
    fs.writeFileSync(join(legacy, 'config.yaml'), 'synthetic: true');
    const configureRuntimeEnvironment = vi.fn(({ dataDir }) => {
      expect(fs.readFileSync(join(dataDir, 'config.yaml'), 'utf8')).toBe('synthetic: true');
    });
    await expect(prepareTuiDataDir({
      environment: {},
      getDefaultDataDir: () => resolveDefaultTuiDataDir('prod', undefined, () => null),
      configureRuntimeEnvironment,
    })).resolves.toBe(join(home, '.minimax'));
    expect(configureRuntimeEnvironment).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{}, '/default'],
    [{ MINIMAX_DATA_DIR: '  ', MAVIS_DATA_DIR: ' ' }, '/default'],
    [{ MINIMAX_DATA_DIR: ' /public ', MAVIS_DATA_DIR: '/legacy' }, '/public'],
    [{ MINIMAX_DATA_DIR: ' ', MAVIS_DATA_DIR: ' /legacy ' }, '/legacy'],
  ])('preserves override precedence for %j', (environment, expected) => {
    expect(getTuiDataDirPath(environment, () => '/default')).toBe(expected);
  });

  it('passes the selected directory to runtime initialization', async () => {
    const configureRuntimeEnvironment = vi.fn();
    await expect(prepareTuiDataDir({
      environment: { MINIMAX_DATA_DIR: ' /selected ' },
      getBuildEnv: () => 'prod',
      configureRuntimeEnvironment,
    })).resolves.toBe('/selected');
    expect(configureRuntimeEnvironment).toHaveBeenCalledWith({ dataDir: '/selected' });
  });
});
