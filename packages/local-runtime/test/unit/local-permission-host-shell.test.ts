import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalRuntimeApiHost } from '../../src/api/host.js';
import { resolveLocalPermissionService } from '../../src/permissions/service.js';
import { closeLocalRuntimeDb } from '../../src/persistence/db.js';

const { getShellConfig } = vi.hoisted(() => ({ getShellConfig: vi.fn() }));
vi.mock('@earendil-works/pi-coding-agent/shell', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@earendil-works/pi-coding-agent/shell')>()),
  getShellConfig,
}));

// Simulate only the OS and workspace; keep the real host -> service -> facade decisions.
// These checks never invoke a shell or execute deletion.
vi.mock('../../src/permissions/facade.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/permissions/facade.js')>();
  return {
    ...actual,
    LocalPermissionFacade: class extends actual.LocalPermissionFacade {
      constructor(deps: ConstructorParameters<typeof actual.LocalPermissionFacade>[0]) {
        super({
          ...deps,
          platform: 'win32',
          getLocalAgent: async () => ({ defaultWorkspaceDir: String.raw`C:\workspace` }),
        });
      }
    },
  };
});

const hosts: Array<{ host: LocalRuntimeApiHost; dataDir: string }> = [];
function createHost(shellFamily?: 'cmd' | 'powershell') {
  const dataDir = mkdtempSync(join(tmpdir(), 'permission-host-shell-'));
  const config = {
    dataDir,
    provider: {},
    permissionMode: 'off' as const,
    permission: { nativeDelete: true },
  };
  const host = new LocalRuntimeApiHost({
    runtimeOwnerKind: 'tui',
    configGetter: () => config,
    shellFamily,
  });
  hosts.push({ host, dataDir });
  return host;
}

afterEach(async () => {
  for (const { host, dataDir } of hosts.splice(0)) {
    await host.close();
    closeLocalRuntimeDb(dataDir);
    rmSync(dataDir, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

describe('local executor shell provenance', () => {
  it.each([
    ['powershell', 'rm ./old.txt'],
    ['powershell', 'Remove-Item ./old.txt'],
    ['pwsh', 'rm ./old.txt'],
    ['pwsh', 'Remove-Item ./old.txt'],
  ] as const)('uses the selected %s shell for native deletion: %s', async (type, command) => {
    getShellConfig.mockReturnValue({ type, shell: type, args: [] });
    const host = createHost();
    const permissions = resolveLocalPermissionService(host);
    for (const permissionModeOverride of ['off', 'default', 'bypassPermissions'] as const) {
      const result = await permissions.checkPermission({
        toolName: 'bash',
        agentName: 'mavis',
        input: { command },
        permissionModeOverride,
      });
      expect(result.behavior, result.reason).not.toBe('deny');
      expect(result.rewrittenInput).toBeUndefined();
    }
    expect(host.shellFamily).toBe('powershell');
    expect(
      await permissions.checkPermission({
        toolName: 'bash',
        agentName: 'mavis',
        input: { command: String.raw`Remove-Item C:\Windows\Temp\old.txt` },
      }),
    ).toMatchObject({ behavior: 'deny', denySource: 'safety-immune' });
  });

  it.each(['bash', 'sh'] as const)(
    'uses the selected %s fallback for POSIX rm on Windows',
    async (type) => {
      getShellConfig.mockReturnValue({ type, shell: type, args: ['-c'] });
      const host = createHost();
      const permissions = resolveLocalPermissionService(host);
      for (const permissionModeOverride of ['off', 'default', 'bypassPermissions'] as const) {
        for (const command of [
          'rm -- ./old.txt',
          'rm -rf -- ./old',
          'rm -- C:/workspace/old.txt',
          'rm -- "C:/workspace/old name.txt"',
        ]) {
          const result = await permissions.checkPermission({
            toolName: 'bash',
            agentName: 'mavis',
            input: { command },
            permissionModeOverride,
          });
          expect(result.behavior, result.reason).not.toBe('deny');
          expect(result.rewrittenInput).toBeUndefined();
        }
      }
      expect(host.shellFamily).toBe('posix');
      for (const command of [
        'rm -- C:/Windows/Temp/old.txt',
        'rm -- ../Windows/Temp/old.txt',
        'rm -rf -- C:/outside/old',
        'rm -rf -- /c/Windows/Temp/old',
        'powershell -Command "Remove-Item C:/Windows/Temp/old.txt"',
      ]) {
        expect(
          await permissions.checkPermission({ toolName: 'bash', agentName: 'mavis', input: { command } }),
          command,
        ).toMatchObject({ behavior: 'deny', denySource: 'safety-immune' });
      }
    },
  );

  it('preserves explicit executor provenance', async () => {
    getShellConfig.mockReturnValue({ type: 'powershell', shell: 'pwsh', args: [] });
    const host = createHost('cmd');
    expect(host.shellFamily).toBe('cmd');
    expect(
      await resolveLocalPermissionService(host).checkPermission({
        toolName: 'bash',
        agentName: 'mavis',
        input: { command: String.raw`del .\old.txt` },
      }),
    ).toMatchObject({ behavior: 'allow' });
  });

  it('keeps unresolved shells unknown without preventing host startup', async () => {
    getShellConfig.mockImplementation(() => {
      throw new Error('No shell available');
    });
    const host = createHost();
    expect(host.shellFamily).toBeUndefined();
    expect(
      await resolveLocalPermissionService(host).checkPermission({
        toolName: 'bash',
        agentName: 'mavis',
        input: { command: 'Remove-Item ./old.txt' },
      }),
    ).toMatchObject({ behavior: 'deny', denySource: 'safety-immune' });
  });
});
