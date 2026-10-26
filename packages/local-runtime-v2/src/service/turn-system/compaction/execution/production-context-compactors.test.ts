import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import {
  getConfig,
  getConfigPath,
  resetConfig,
  resetGitDetect,
  updateLocalAutoCompactWindow,
} from '@mavis/config';
import yaml from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readCompactionTriggerSettings } from '../../../model-system/index.js';
import { ToolResultArchiver } from '../algorithm/tool-result-archiver.js';
import { createLocalContextFootprintMeasurer } from './local-context-footprint.js';
import { createContextCompactors, describeCompactionTrigger } from '../../production-composition.js';
import { ContextUsageAnchorState } from './usage-anchor.js';

const CONFIG_ENV_KEYS = [
  'MAVIS_DATA_DIR',
  '__MAVIS_RUNTIME_DATA_DIR',
  '__MAVIS_RUNTIME_PROFILE',
  '__MAVIS_RUNTIME_DISABLE_GIT_AUTO_CONFIG',
] as const;

// An OAuth custom provider: the Pi model carries the bare key, config uses the selection id.
const model: Model<'anthropic-messages'> = {
  id: 'gpt-5.4',
  name: 'gpt-5.4',
  api: 'anthropic-messages',
  provider: 'acme',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};
const selection = { providerId: 'custom_provider:acme', modelId: 'gpt-5.4' };
const modelKey = 'custom_provider:acme/gpt-5.4';
const messages: AgentMessage[] = [
  {
    role: 'user',
    content: [{ type: 'text', text: 'a context large enough to count more than a few tokens' }],
    timestamp: 1,
  },
];
const rawTokens = createLocalContextFootprintMeasurer({ model }).measure(messages).inputTokens;

function writeConfig(raw: Record<string, unknown>): void {
  fs.writeFileSync(getConfigPath(), yaml.dump(raw), 'utf-8');
  resetConfig();
}

function automaticCompactor(logger = { warn: vi.fn(), error: vi.fn() }) {
  const { automatic } = createContextCompactors({
    contextUsageAnchor: new ContextUsageAnchorState(),
    checkpointState: undefined,
    logger,
    toolResultArchiver: new ToolResultArchiver({ writeArtifact: vi.fn() }),
    promptSnapshots: undefined,
    trigger: readCompactionTriggerSettings(getConfig),
  });
  return (modelSelection?: typeof selection) =>
    automatic.probeBeforeLlm({
      sessionId: 'session-1',
      phase: 'initial',
      messages,
      model,
      thinkingLevel: 'off',
      ...(modelSelection ? { modelSelection } : {}),
    }).shouldStart;
}

describe('production automatic compaction trigger', () => {
  let dataDir: string;

  beforeEach(async () => {
    for (const key of CONFIG_ENV_KEYS) vi.stubEnv(key, undefined);
    dataDir = await mkdtemp(join(tmpdir(), 'production-compaction-trigger-'));
    vi.stubEnv('MAVIS_DATA_DIR', dataDir);
    resetGitDetect();
    resetConfig();
    expect(rawTokens).toBeGreaterThan(2);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    resetGitDetect();
    resetConfig();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('applies a per-model value written to config.yaml from the next probe without a restart', async () => {
    writeConfig({ contextManagement: { compactionTriggerAt: rawTokens - 1 } });
    const probe = automaticCompactor();
    expect(probe(selection)).toBe(true);

    // auto restores the built-in trigger for this model only.
    await updateLocalAutoCompactWindow({ modelKey, value: 'auto' });
    expect(probe(selection)).toBe(false);
    expect(probe({ providerId: 'minimax', modelId: 'MiniMax-M3' })).toBe(true);

    // The /autocompact read reports the exact line the probe compares against.
    const effectiveTrigger = () =>
      describeCompactionTrigger({
        compactionTriggerAt:
          readCompactionTriggerSettings(getConfig).compactionTriggerAt(selection),
        llm: { model },
      }).effectiveTriggerTokens;
    await updateLocalAutoCompactWindow({ modelKey, value: rawTokens });
    expect(effectiveTrigger()).toBe(rawTokens);
    expect(probe(selection)).toBe(false);
    await updateLocalAutoCompactWindow({ modelKey, value: rawTokens - 1 });
    expect(effectiveTrigger()).toBe(rawTokens - 1);
    expect(probe(selection)).toBe(true);
  });

  it('warns once at composition and ignores invalid per-model and global values', () => {
    writeConfig({
      contextManagement: { compactionTriggerAt: 1.5 },
      modelSettings: { [modelKey]: { autoCompactWindow: 0 } },
    });
    const logger = { warn: vi.fn(), error: vi.fn() };
    const probe = automaticCompactor(logger);

    expect(probe(selection)).toBe(false);
    expect(probe(selection)).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        event: 'context_compaction_trigger_config_ignored',
        setting: 'contextManagement.compactionTriggerAt',
        value: 1.5,
      },
      expect.any(String),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      {
        event: 'context_compaction_trigger_config_ignored',
        setting: 'modelSettings.autoCompactWindow',
        model: modelKey,
        value: 0,
      },
      expect.any(String),
    );
  });
});
