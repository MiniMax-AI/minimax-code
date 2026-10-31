import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfigFromFile } from '@mavis/config';
import { LocalRuntimeApiHost } from '../../src/api/host.js';
import { resolveLocalPermissionService } from '../../src/permissions/service.js';
import { closeLocalRuntimeDb } from '../../src/persistence/db.js';

describe('Windows hard-safety host configuration', () => {
  it.each([
    ['tui', true, true],
    ['tui', false, false],
    ['tui', undefined, false],
    ['electron', true, false],
    [undefined, true, false],
  ] as const)(
    'only opts in for a TUI owner: %s / %s',
    async (runtimeOwnerKind, configured, enabled) => {
      const dataDir = mkdtempSync(join(tmpdir(), 'windows-safety-host-'));
      const configPath = join(dataDir, 'config.yaml');
      writeFileSync(
        configPath,
        'permissionMode: off\n' +
          (configured === undefined ? '' : `skipWindowsHardSafetyChecks: ${configured}\n`),
      );
      const config = loadConfigFromFile(configPath, { dataDir });
      const host = new LocalRuntimeApiHost({
        runtimeOwnerKind,
        configGetter: () => config,
      });
      try {
        expect(host.skipWindowsHardSafetyChecks).toBe(enabled);
        config.skipWindowsHardSafetyChecks = !configured;
        expect(host.skipWindowsHardSafetyChecks).toBe(enabled);
        // Real host -> service -> facade wiring. No tool executor runs here.
        if (process.platform === 'win32') {
          const result = await resolveLocalPermissionService(host).checkPermission({
            toolName: 'bash',
            input: { command: String.raw`Set-Content C:\Windows\Temp\example.txt example` },
          });
          expect(result.behavior).toBe(enabled ? 'allow' : 'deny');
        }
      } finally {
        await host.close();
        closeLocalRuntimeDb(dataDir);
        rmSync(dataDir, { recursive: true, force: true });
      }
    },
  );
});
