import { describe, expect, it, vi } from 'vitest';
import {
  CredentialRecordCorruptError,
  CredentialStorePermissionError,
  type LogoutResult,
} from '@mavis/oauth-core';

import { createLocalAuthFixture } from '../../../oauth-core/test/helpers/local-auth.js';

import type { McodeBusinessEvent } from '../../src/analytics/business-telemetry.js';
import { McodeAuthApplication } from '../../src/auth/application.js';

function sharedCore(status: 'anonymous' | 'authenticated' | 'logout_pending' = 'anonymous') {
  return {
    getStatus: vi.fn(async () => ({
      status,
      generation: status === 'authenticated' ? 1 : 0,
      scopes: status === 'authenticated' ? ['agent.default'] : [],
    })),
    // Mirrors the real core: an authenticated session only refreshes, while
    // any other state starts a Device Flow and fires the prompt callback.
    login: vi.fn(async ({ onDeviceAuthorization } = {}) => {
      if (status !== 'authenticated') {
        onDeviceAuthorization?.({
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://account.example.test/device',
          expiresInSec: 300,
        });
      }
      return { status: 'authenticated' as const, generation: 1 };
    }),
    logout: vi.fn(async (): Promise<LogoutResult> => ({ status: 'anonymous', generation: 2 })),
  };
}

describe('McodeAuthApplication', () => {
  it('uses Shared OAuth Device Flow as its only login path', async () => {
    const core = sharedCore();
    const onProgress = vi.fn();
    const application = new McodeAuthApplication({
      dataDir: '/data',
      region: 'cn',
      buildEnv: 'test',
      sharedAuthCore: core,
    });

    await expect(application.login(onProgress)).resolves.toEqual({
      state: 'authenticated',
      message: 'Signed in with MiniMax.',
    });
    expect(core.login).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenCalledWith({
      state: 'device-authorization',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://account.example.test/device',
      expiresInSec: 300,
    });
  });

  it('lets Core reuse an authenticated session without forcing a refresh', async () => {
    const core = sharedCore('authenticated');
    const application = new McodeAuthApplication({ dataDir: '/data', sharedAuthCore: core });

    await expect(application.login()).resolves.toEqual({
      state: 'already-authenticated',
      message: 'Already signed in with MiniMax.',
    });
    expect(core.login).toHaveBeenCalledOnce();
    expect(core.login).toHaveBeenCalledWith({ onDeviceAuthorization: expect.any(Function) });
  });

  it.each(['offline', 'unavailable'] as const)(
    'reuses a healthy session without contacting Account when it is %s',
    async (failure) => {
      const fixture = await createLocalAuthFixture();
      try {
        const core = fixture.createManager();
        const application = new McodeAuthApplication({
          dataDir: fixture.dataDir, sharedAuthCore: core, region: 'cn', buildEnv: 'test',
        });
        await application.login();
        const lease = await core.getAccessToken({ minValidityMs: 30_000 });
        fixture.setRefreshFailure(failure);

        await expect(application.login()).resolves.toMatchObject({ state: 'already-authenticated' });
        await expect(core.getAccessToken({ minValidityMs: 30_000 })).resolves.toEqual(lease);
        expect(fixture.calls).toEqual({ device: 1, refresh: 0, revoke: 0 });
      } finally {
        await fixture.cleanup();
      }
    },
  );

  it('logs in to another region without replacing the authenticated current region', async () => {
    const chinaCore = sharedCore('authenticated');
    const globalCore = sharedCore();
    const resolveSharedAuthCore = vi.fn(() => globalCore);
    const application = new McodeAuthApplication({
      dataDir: '/data',
      region: 'cn',
      buildEnv: 'test',
      sharedAuthCore: chinaCore,
      resolveSharedAuthCore,
    });

    await expect(application.login(undefined, 'en')).resolves.toEqual({
      state: 'authenticated',
      message: 'Signed in with MiniMax Global.',
      restartRequired: true,
    });
    expect(resolveSharedAuthCore).toHaveBeenCalledWith('en');
    expect(chinaCore.login).not.toHaveBeenCalled();
    expect(globalCore.login).toHaveBeenCalledOnce();
  });

  it('persists only the non-sensitive selected region after login succeeds', async () => {
    const core = sharedCore();
    const writeRegionPreference = vi.fn();
    const application = new McodeAuthApplication({
      dataDir: '/data',
      region: 'cn',
      buildEnv: 'test',
      sharedAuthCore: core,
      writeRegionPreference,
    });

    await application.login(undefined, 'cn');

    expect(writeRegionPreference).toHaveBeenCalledWith('/data', {
      region: 'cn',
      buildEnv: 'test',
    });
  });

  it('reuses an authenticated selected region without starting Device Flow', async () => {
    const chinaCore = sharedCore();
    const globalCore = sharedCore('authenticated');
    const resolveSharedAuthCore = vi.fn(() => globalCore);
    const application = new McodeAuthApplication({
      dataDir: '/data',
      region: 'cn',
      buildEnv: 'test',
      sharedAuthCore: chinaCore,
      resolveSharedAuthCore,
    });

    await expect(application.login(undefined, 'en')).resolves.toEqual({
      state: 'already-authenticated',
      message: 'Already signed in with MiniMax Global.',
      restartRequired: true,
    });
    expect(resolveSharedAuthCore).toHaveBeenCalledWith('en');
    expect(chinaCore.login).not.toHaveBeenCalled();
    expect(globalCore.login).toHaveBeenCalledOnce();
    expect(globalCore.login).toHaveBeenCalledWith({ onDeviceAuthorization: expect.any(Function) });
  });

  it.each([
    ['cn', 'dev', 'https://matrix-test.example.invalid'],
    ['cn', 'test', 'https://matrix-test.example.invalid'],
    ['cn', 'staging', 'https://matrix-pre.example.invalid'],
    ['cn', 'prod', 'https://agent.minimax.cn'],
    ['en', 'dev', 'https://matrix-overseas-test.example.invalid'],
    ['en', 'test', 'https://matrix-overseas-test.example.invalid'],
    ['en', 'staging', 'https://matrix-overseas-pre.example.invalid'],
    ['en', 'prod', 'https://agent.minimax.io'],
  ] as const)(
    'logs out %s/%s with the matching browser logout page',
    async (region, buildEnv, origin) => {
      const core = sharedCore('authenticated');
      const application = new McodeAuthApplication({
        dataDir: '/data',
        region,
        buildEnv,
        sharedAuthCore: core,
      });

      await expect(application.logout()).resolves.toEqual({
        state: 'signed-out',
        message: `Signed out of MiniMax ${region === 'cn' ? 'China' : 'Global'} on Desktop, CLI/TUI, and embedded mcode-tools.`,
        logoutUrl: `${origin}/auth/logout?logout_redirect_uri=${encodeURIComponent(origin)}`,
      });
      expect(core.logout).toHaveBeenCalledWith({ revoke: true });
    },
  );

  it('treats logout of an already anonymous shared domain as a safe no-op', async () => {
    const core = sharedCore();
    const application = new McodeAuthApplication({
      dataDir: '/data',
      sharedAuthCore: core,
      region: 'cn',
      buildEnv: 'prod',
    });

    await expect(application.logout()).resolves.toEqual({
      state: 'already-signed-out',
      message: 'Already signed out of MiniMax.',
      logoutUrl:
        'https://agent.minimax.cn/auth/logout?logout_redirect_uri=https%3A%2F%2Fagent.minimax.cn',
    });
    expect(core.logout).toHaveBeenCalledWith({ revoke: true });
  });

  it('provides browser logout while server revocation is pending', async () => {
    const core = sharedCore('authenticated');
    core.logout.mockResolvedValue({ status: 'logout_pending', generation: 2 });
    const application = new McodeAuthApplication({
      dataDir: '/data',
      sharedAuthCore: core,
      region: 'en',
      buildEnv: 'prod',
    });

    await expect(application.logout()).resolves.toMatchObject({
      state: 'signed-out',
      message: expect.stringContaining('Server revocation is pending'),
      logoutUrl:
        'https://agent.minimax.io/auth/logout?logout_redirect_uri=https%3A%2F%2Fagent.minimax.io',
    });
  });

  // Core 的 logout 遇到这两类错误会改为本地重置，真实文件场景见 oauth-core auth-core.test.ts。
  it.each([
    ['corrupt', () => new CredentialRecordCorruptError()],
    ['unrepairable', () => new CredentialStorePermissionError()],
  ])('still runs the shared logout when auth.json is %s', async (_label, failure) => {
    const core = sharedCore('authenticated');
    core.getStatus.mockRejectedValueOnce(failure());
    const application = new McodeAuthApplication({
      dataDir: '/data',
      sharedAuthCore: core,
      region: 'cn',
      buildEnv: 'test',
    });

    await expect(application.logout()).resolves.toMatchObject({ state: 'signed-out' });
    expect(core.logout).toHaveBeenCalledWith({ revoke: true });
  });

  it('does not start logout when the status fails for another reason', async () => {
    const core = sharedCore('authenticated');
    core.getStatus.mockRejectedValueOnce(new Error('state store offline'));
    const application = new McodeAuthApplication({ dataDir: '/data', sharedAuthCore: core });

    await expect(application.logout()).rejects.toThrow('state store offline');
    expect(core.logout).not.toHaveBeenCalled();
  });

  it('reports OAuth telemetry and preserves login failures', async () => {
    const events: McodeBusinessEvent[] = [];
    const core = sharedCore();
    core.login.mockRejectedValueOnce(new Error('OAuth authorization failed.'));
    const application = new McodeAuthApplication({
      dataDir: '/data',
      sharedAuthCore: core,
      telemetry: {
        track: (event, properties) => events.push({ event, properties } as McodeBusinessEvent),
        flush: async () => undefined,
      },
      telemetrySource: 'mcode_tui',
    });

    await expect(application.login()).rejects.toThrow('OAuth authorization failed.');
    expect(events.at(-1)).toEqual({
      event: 'login_result',
      properties: {
        source: 'mcode_tui',
        result_type: '2',
        fail_reason: '5',
        login_type: 'minimax_oauth',
      },
    });
  });
});
