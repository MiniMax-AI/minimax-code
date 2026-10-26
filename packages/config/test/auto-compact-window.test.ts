import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';

import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getConfig,
  getConfigPath,
  parseAutoCompactWindowInput,
  resetConfig,
  resetGitDetect,
  selectCompactionTriggerSetting,
  updateLocalAutoCompactWindow,
} from '../src/index.js';
import { resolveConfigFromRaw } from '../src/config.js';

describe('parseAutoCompactWindowInput', () => {
  it.each([
    ['200000', 200_000],
    ['500k', 500_000],
    ['500K', 500_000],
    ['1M', 1_000_000],
    ['1m', 1_000_000],
    ['1.5M', 1_500_000],
    ['1.1k', 1_100],
    // A bare number from 100 to 1000 means thousands, like Claude Code.
    ['100', 100_000],
    ['200', 200_000],
    ['1000', 1_000_000],
    // No lower bound or upper clamp: the built-in trigger already caps it.
    ['50', 50],
    ['99', 99],
    ['1001', 1_001],
    ['5M', 5_000_000],
  ])('reads %s as %d tokens', (text, tokens) => {
    expect(parseAutoCompactWindowInput(text)).toEqual({ kind: 'tokens', tokens });
  });

  it.each(['auto', 'AUTO', ' Auto '])('reads %j as auto', (text) => {
    expect(parseAutoCompactWindowInput(text)).toEqual({ kind: 'auto' });
  });

  it.each([
    '',
    '0',
    '0k',
    '-5',
    '0.8',
    '80%',
    '1.5',
    '200.0',
    '1.2345k',
    '1',
    '12x',
    'k',
    '1e6',
    'automatic',
    '99999999999999999999',
  ])('rejects %j', (text) => {
    expect(parseAutoCompactWindowInput(text)).toEqual({ kind: 'invalid' });
  });
});

describe('modelSettings parsing', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(join(os.tmpdir(), 'mcode-model-settings-'));
    vi.stubEnv('MINIMAX_DATA_DIR', dataDir);
    vi.stubEnv('__MAVIS_RUNTIME_DATA_DIR', dataDir);
    vi.stubEnv('__MAVIS_RUNTIME_DISABLE_GIT_AUTO_CONFIG', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('keeps numbers for runtime validation and only the exact string auto', () => {
    const config = resolveConfigFromRaw(
      {
        modelSettings: {
          'minimax/MiniMax-M3': { autoCompactWindow: 400_000 },
          'openai/gpt-5.4': { autoCompactWindow: 'auto' },
          'custom_provider:acme/model.v2': { autoCompactWindow: 1.5 },
          'other/a': { autoCompactWindow: 'AUTO' },
          'other/b': { autoCompactWindow: '400k' },
          'other/c': 'not an entry',
        },
      },
      dataDir,
    );

    expect(config.modelSettings).toEqual({
      'minimax/MiniMax-M3': { autoCompactWindow: 400_000 },
      'openai/gpt-5.4': { autoCompactWindow: 'auto' },
      'custom_provider:acme/model.v2': { autoCompactWindow: 1.5 },
    });
  });

  it('is absent when unset or not a mapping', () => {
    expect(resolveConfigFromRaw({}, dataDir).modelSettings).toBeUndefined();
    expect(resolveConfigFromRaw({ modelSettings: ['x'] }, dataDir).modelSettings).toBeUndefined();
  });
});

describe('selectCompactionTriggerSetting', () => {
  const key = 'minimax/MiniMax-M3';

  it('prefers a valid per-model value, then the global value, then the built-in trigger', () => {
    expect(
      selectCompactionTriggerSetting(
        {
          modelSettings: { [key]: { autoCompactWindow: 300_000 } },
          contextManagement: { compactionTriggerAt: 0.5 },
        },
        key,
      ),
    ).toEqual({ source: 'model', value: 300_000 });
    expect(
      selectCompactionTriggerSetting({ contextManagement: { compactionTriggerAt: 0.5 } }, key),
    ).toEqual({ source: 'global', value: 0.5 });
    expect(selectCompactionTriggerSetting({}, key)).toEqual({ source: 'built-in' });
  });

  it('lets auto override the global value for that model only', () => {
    const config = {
      modelSettings: { [key]: { autoCompactWindow: 'auto' as const } },
      contextManagement: { compactionTriggerAt: 0.5 },
    };
    expect(selectCompactionTriggerSetting(config, key)).toEqual({ source: 'model-auto' });
    expect(selectCompactionTriggerSetting(config, 'minimax/MiniMax-M2.7')).toEqual({
      source: 'global',
      value: 0.5,
    });
  });

  it.each([0, -1, 1, 1.5, Number.NaN])(
    'ignores the invalid per-model value %s and falls through to the global value',
    (value) => {
      expect(
        selectCompactionTriggerSetting(
          {
            modelSettings: { [key]: { autoCompactWindow: value } },
            contextManagement: { compactionTriggerAt: 0.5 },
          },
          key,
        ),
      ).toEqual({ source: 'global', value: 0.5 });
    },
  );

  it('does not match inherited object keys', () => {
    expect(selectCompactionTriggerSetting({ modelSettings: {} }, 'constructor')).toEqual({
      source: 'built-in',
    });
  });
});

describe('updateLocalAutoCompactWindow', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'auto-compact-window-write-'));
    vi.spyOn(os, 'homedir').mockReturnValue(dataDir);
    vi.stubEnv('MINIMAX_DATA_DIR', '');
    vi.stubEnv('MAVIS_DATA_DIR', dataDir);
    vi.stubEnv('__MAVIS_RUNTIME_MANAGED', '1');
    vi.stubEnv('__MAVIS_RUNTIME_DISABLE_GIT_AUTO_CONFIG', '1');
    resetGitDetect();
    resetConfig();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    resetGitDetect();
    resetConfig();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('writes one model entry under a dotted model id, keeps siblings, and refreshes config', async () => {
    fs.writeFileSync(
      getConfigPath(),
      [
        '# keep this comment',
        'contextManagement:',
        '  compactionTriggerAt: 0.5',
        'modelSettings:',
        '  minimax/MiniMax-M3:',
        '    autoCompactWindow: 400000',
        '',
      ].join('\n'),
      'utf-8',
    );
    resetConfig();
    expect(getConfig().modelSettings?.['openai/gpt-5.4']).toBeUndefined();

    const { config } = await updateLocalAutoCompactWindow({
      modelKey: 'openai/gpt-5.4',
      value: 'auto',
    });
    await updateLocalAutoCompactWindow({ modelKey: 'minimax/MiniMax-M3', value: 250_000 });

    const text = fs.readFileSync(getConfigPath(), 'utf-8');
    expect(yaml.load(text)).toEqual({
      contextManagement: { compactionTriggerAt: 0.5 },
      modelSettings: {
        'minimax/MiniMax-M3': { autoCompactWindow: 250_000 },
        'openai/gpt-5.4': { autoCompactWindow: 'auto' },
      },
    });
    expect(config.modelSettings?.['openai/gpt-5.4']).toEqual({ autoCompactWindow: 'auto' });
    // The cached config is reset, so the next reader sees the write.
    expect(getConfig().modelSettings?.['minimax/MiniMax-M3']).toEqual({
      autoCompactWindow: 250_000,
    });
  });

  it.each([
    { modelKey: 'minimax/MiniMax-M3', value: 0 },
    { modelKey: 'minimax/MiniMax-M3', value: 1.5 },
    { modelKey: 'minimax/MiniMax-M3', value: 'AUTO' },
    { modelKey: 'no-slash', value: 1_000 },
    { modelKey: '/model', value: 1_000 },
    { modelKey: '__proto__', value: 1_000 },
  ])('rejects $modelKey = $value without touching the file', async (input) => {
    fs.writeFileSync(getConfigPath(), 'logLevel: info\n', 'utf-8');
    await expect(
      updateLocalAutoCompactWindow(input as Parameters<typeof updateLocalAutoCompactWindow>[0]),
    ).rejects.toThrow();
    expect(fs.readFileSync(getConfigPath(), 'utf-8')).toBe('logLevel: info\n');
  });
});
