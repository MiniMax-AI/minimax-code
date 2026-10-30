import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getConfig, getConfigPath, resetConfig, resetGitDetect } from '@mavis/config';
import { resolveCompactionTokenBudget } from '@mavis/context-manager';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createCompactionTriggerApplication } from './compaction-trigger-application.js';

const CONFIG_ENV_KEYS = [
  'MAVIS_DATA_DIR',
  '__MAVIS_RUNTIME_DATA_DIR',
  '__MAVIS_RUNTIME_PROFILE',
  '__MAVIS_RUNTIME_DISABLE_GIT_AUTO_CONFIG',
] as const;

const BUILT_IN = resolveCompactionTokenBudget({
  contextWindow: 200_000,
  configuredMaxOutputTokens: 32_000,
}).automaticTriggerAt;

function application(options: { agentModel?: Record<string, unknown> } = {}) {
  const buildAgentConfig = vi.fn(async () => ({
    // An OAuth custom provider with a dotted model id: the Pi model uses the bare key.
    model: options.agentModel ?? { provider: 'custom_provider:acme', model_id: 'gpt-5.4' },
  }));
  const resolveModel = vi.fn(async () => ({
    model: { provider: 'acme', id: 'gpt-5.4', contextWindow: 200_000, maxTokens: 64_000 },
    maxTokens: 32_000,
  }));
  return createCompactionTriggerApplication({
    sessions: {
      getExecutionSnapshot: async (sessionId: string) =>
        sessionId === 'session-1'
          ? ({ sessionId, agentName: 'mavis', sessionKind: 'root' } as never)
          : undefined,
    },
    agents: { getExecutionSnapshot: async () => ({ agentName: 'mavis' }) as never },
    preparation: { buildAgentConfig, resolveModel } as never,
    config: getConfig,
  });
}

function savedModelSettings(): unknown {
  return (yaml.load(fs.readFileSync(getConfigPath(), 'utf-8')) as Record<string, unknown>)
    .modelSettings;
}

describe('compaction trigger application', () => {
  let dataDir: string;

  beforeEach(async () => {
    for (const key of CONFIG_ENV_KEYS) vi.stubEnv(key, undefined);
    dataDir = await mkdtemp(join(tmpdir(), 'compaction-trigger-application-'));
    vi.stubEnv('MAVIS_DATA_DIR', dataDir);
    resetGitDetect();
    resetConfig();
    fs.writeFileSync(
      getConfigPath(),
      yaml.dump({ contextManagement: { compactionTriggerAt: 0.5 } }),
      'utf-8',
    );
    resetConfig();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetGitDetect();
    resetConfig();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('reads the effective trigger for the Session model with the Turn output budget', async () => {
    await expect(application().getCompactionTrigger({ sessionId: 'session-1' })).resolves.toEqual({
      providerId: 'custom_provider:acme',
      modelId: 'gpt-5.4',
      contextWindow: 200_000,
      builtInTriggerTokens: BUILT_IN,
      effectiveTriggerTokens: 100_000,
      source: 'global',
    });
  });

  it('saves the value under the selection key and returns the refreshed trigger', async () => {
    const triggers = application();

    await expect(
      triggers.setCompactionTrigger({ sessionId: 'session-1', value: 'auto' }),
    ).resolves.toMatchObject({
      source: 'model-auto',
      saved: 'auto',
      effectiveTriggerTokens: BUILT_IN,
    });
    expect(savedModelSettings()).toEqual({
      'custom_provider:acme/gpt-5.4': { autoCompactWindow: 'auto' },
    });

    // Above the built-in trigger: saved as asked, but the built-in line still applies.
    await expect(
      triggers.setCompactionTrigger({ sessionId: 'session-1', value: 400_000 }),
    ).resolves.toMatchObject({ source: 'model', saved: 400_000, effectiveTriggerTokens: BUILT_IN });
    await expect(
      triggers.setCompactionTrigger({ sessionId: 'session-1', value: 50 }),
    ).resolves.toMatchObject({ source: 'model', saved: 50, effectiveTriggerTokens: 50 });
    await expect(triggers.getCompactionTrigger({ sessionId: 'session-1' })).resolves.toMatchObject({
      source: 'model',
      effectiveTriggerTokens: 50,
    });
  });

  it('rejects invalid values and Sessions without a resolved model without writing', async () => {
    const before = fs.readFileSync(getConfigPath(), 'utf-8');

    await expect(
      application().setCompactionTrigger({ sessionId: 'session-1', value: 1.5 }),
    ).rejects.toThrow('autoCompactWindow');
    await expect(
      application().setCompactionTrigger({ sessionId: 'missing', value: 'auto' }),
    ).rejects.toThrow('Session not found');
    await expect(
      application({ agentModel: {} }).setCompactionTrigger({
        sessionId: 'session-1',
        value: 'auto',
      }),
    ).rejects.toThrow('no resolved model');
    expect(fs.readFileSync(getConfigPath(), 'utf-8')).toBe(before);
  });
});
