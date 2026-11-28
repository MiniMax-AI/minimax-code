import { describe, expect, it, vi } from 'vitest';

import { startMcodeToolsHostIntegration } from '../../src/integration.js';

describe('mcode-tools host integration', () => {
  it('starts in validate, broker, launcher order and disposes launcher before broker', async () => {
    const calls: string[] = [];
    const integration = await startMcodeToolsHostIntegration(
      {
        dataDir: '/profile',
        resourceDir: '/embedded',
        expectedBuildEnv: 'test',
        executable: '/node',
        platform: 'darwin',
        region: 'cn',
        session: {} as never,
      },
      {
        validateResource: () => {
          calls.push('validate');
          return {
            rootDir: '/embedded',
            cliPath: '/embedded/cli.mjs',
            manifest: { packageName: '@minimax/mcode-tools-test', version: '1.0.0' },
          } as never;
        },
        startBroker: async () => {
          calls.push('broker');
          return {
            endpoint: '/profile/run/broker.sock',
            capabilityFile: '/profile/run/broker.cap',
            dispose: async () => { calls.push('dispose-broker'); },
          };
        },
        installLauncher: async () => {
          calls.push('launcher');
          return {
            launcherPath: '/profile/bin/mcode-tools',
            regionalLauncherPath: '/profile/bin/mcode-tools-cn',
            resource: {} as never,
          };
        },
        removeLaunchers: () => { calls.push('remove-launcher'); },
      },
    );

    expect(calls).toEqual(['validate', 'broker', 'launcher']);
    await integration.dispose();
    await integration.dispose();
    expect(calls).toEqual([
      'validate', 'broker', 'launcher', 'remove-launcher', 'dispose-broker',
    ]);
  });

  it('closes the broker and removes partial launchers when launcher setup fails', async () => {
    const dispose = vi.fn(async () => undefined);
    const removeLaunchers = vi.fn();
    await expect(startMcodeToolsHostIntegration(
      {
        dataDir: '/profile',
        resourceDir: '/embedded',
        expectedBuildEnv: 'test',
        executable: '/node',
        platform: 'darwin',
        region: 'cn',
        session: {} as never,
      },
      {
        validateResource: () => ({
          manifest: { packageName: '@minimax/mcode-tools-test', version: '1.0.0' },
        }) as never,
        startBroker: async () => ({
          endpoint: '/profile/run/broker.sock',
          capabilityFile: '/profile/run/broker.cap',
          dispose,
        }),
        installLauncher: async () => { throw new Error('launcher failed'); },
        removeLaunchers,
      },
    )).rejects.toThrow('launcher failed');
    expect(removeLaunchers).toHaveBeenCalledWith({
      dataDir: '/profile',
      executable: '/node',
      region: 'cn',
      platform: 'darwin',
    });
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('isolates the broker and installs and removes only the App-owned launchers', async () => {
    const startBroker = vi.fn(async () => ({
      endpoint: '/profile/run/mt-abc123/mcode-auth-lease-v1.sock',
      capabilityFile: '/profile/run/mt-abc123/mcode-auth-lease-v1.cap',
      dispose: async () => undefined,
    }));
    const installLauncher = vi.fn(async () => ({
      launcherPath: '/profile/bin/hosts/staging-0123456789abcdef/mcode-tools',
      regionalLauncherPath: '/profile/bin/hosts/staging-0123456789abcdef/mcode-tools-cn',
      resource: {} as never,
    }));
    const removeLaunchers = vi.fn();
    const integration = await startMcodeToolsHostIntegration(
      {
        dataDir: '/profile',
        resourceDir: '/embedded',
        expectedBuildEnv: 'staging',
        executable: '/Applications/MiniMax Internal Code.app/Contents/MacOS/MiniMax Internal Code',
        platform: 'darwin',
        region: 'cn',
        hostBinDir: '/profile/bin/hosts/staging-0123456789abcdef',
        isolateBrokerInstance: true,
        session: {} as never,
      },
      {
        validateResource: () =>
          ({ manifest: { packageName: '@minimax/mcode-tools-staging', version: '1.0.0' } }) as never,
        startBroker,
        installLauncher,
        removeLaunchers,
      },
    );

    expect(startBroker).toHaveBeenCalledWith(
      expect.objectContaining({ dataDir: '/profile', isolateInstance: true }),
    );
    expect(installLauncher).toHaveBeenCalledWith(
      expect.objectContaining({
        hostBinDir: '/profile/bin/hosts/staging-0123456789abcdef',
        brokerEndpoint: '/profile/run/mt-abc123/mcode-auth-lease-v1.sock',
      }),
    );
    expect(integration.launcherPath).toBe(
      '/profile/bin/hosts/staging-0123456789abcdef/mcode-tools',
    );

    await integration.dispose();
    expect(removeLaunchers).toHaveBeenCalledWith({
      dataDir: '/profile',
      executable: '/Applications/MiniMax Internal Code.app/Contents/MacOS/MiniMax Internal Code',
      region: 'cn',
      platform: 'darwin',
      hostBinDir: '/profile/bin/hosts/staging-0123456789abcdef',
    });
  });
});
