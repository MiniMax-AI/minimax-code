import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadTuiRuntimeConfig } from '../../src/headless/config.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('explicit headless config', () => {
  it('loads an explicit config source without changing the active dataDir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcode-headless-config-'));
    roots.push(root);
    const configPath = join(root, 'run.yaml');
    await writeFile(
      configPath,
      [
        'defaultModel: provider/model',
        'permissionMode: auto',
        'provider:',
        '  provider:',
        '    options:',
        '      apiKey: sk-test',
        'runawayGuard:',
        '  enabled: false',
        'toolResultCompaction:',
        '  enabled: false',
        '  maxInlineKiB: 48',
        '  mcpDetailsMaxInlineKiB: 40',
        '  watermarkKiB: 384',
        '  minSavingsKiB: 192',
        '  minCandidateKiB: 3',
        '  keepRecentRounds: 2',
        'telemetry:',
        '  enabled: true',
      ].join('\n'),
    );

    await expect(
      loadTuiRuntimeConfig(configPath, { dataDir: '/desktop/data' }),
    ).resolves.toMatchObject({
      dataDir: '/desktop/data',
      defaultModel: 'provider/model',
      permissionMode: 'auto',
      provider: { provider: { options: { apiKey: 'sk-test' } } },
      runawayGuard: { enabled: false },
      toolResultCompaction: {
        enabled: false,
        maxInlineKiB: 48,
        mcpDetailsMaxInlineKiB: 40,
        watermarkKiB: 384,
        minSavingsKiB: 192,
        minCandidateKiB: 3,
        keepRecentRounds: 2,
      },
      telemetry: { enabled: true, metrics: false, diagnostics: false },
    });
  });

  it('classifies invalid YAML as a config error and shares canonical field fallback semantics', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mcode-headless-config-invalid-'));
    roots.push(root);
    const malformed = join(root, 'malformed.yaml');
    const invalidMode = join(root, 'mode.yaml');
    await writeFile(malformed, 'provider: [');
    await writeFile(invalidMode, 'permissionMode: maybe\n');
    const base = { dataDir: '/desktop/data' };

    await expect(loadTuiRuntimeConfig(malformed, base)).rejects.toMatchObject({
      kind: 'config',
    });
    await expect(loadTuiRuntimeConfig(invalidMode, base)).resolves.toMatchObject({
      dataDir: '/desktop/data',
      permissionMode: 'auto',
      runawayGuard: { enabled: true },
      toolResultCompaction: {
        enabled: true,
        maxInlineKiB: 64,
        mcpDetailsMaxInlineKiB: 32,
        watermarkKiB: 256,
        minSavingsKiB: 256,
        minCandidateKiB: 2,
        keepRecentRounds: 5,
      },
      telemetry: { enabled: false, metrics: false, diagnostics: false },
    });
  });
});
