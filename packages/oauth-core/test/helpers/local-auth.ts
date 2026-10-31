import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuthDiagnosticObserver } from '../../src/diagnostics.js';
import { MCodeOAuthCore } from '../../src/auth-core.js';
import { FileStore } from '../../src/credential-store/file-store.js';
import { createAuthNamespace } from '../../src/namespace.js';
import { HttpOAuthClient } from '../../src/oauth-client.js';
import { createAuthManager } from '../../src/token-provider.js';

/** Real Core, file store and lock; only Account HTTP responses are simulated. */
export async function createLocalAuthFixture(
  options: {
    onDiagnostic?: AuthDiagnosticObserver;
    beforeDeviceTokenResponse?: () => Promise<void>;
    beforeRefreshTokenResponse?: () => Promise<void>;
  } = {},
) {
  const dataDir = await mkdtemp(join(tmpdir(), 'mcode-auth-recovery-'));
  const namespace = createAuthNamespace({ dataDir, buildEnv: 'test', region: 'cn' });
  let now = 1_800_000_000_000;
  let serial = 0;
  let refreshFailure:
    | 'offline'
    | 'unavailable'
    | 'invalid_grant'
    | 'invalid_client'
    | 'unauthorized_client'
    | 'invalid_grant_503'
    | undefined;
  const calls = { device: 0, refresh: 0 };
  const createCore = () =>
    new MCodeOAuthCore({
      namespace,
      onDiagnostic: options.onDiagnostic,
      credentialStore: new FileStore({ authHome: namespace.namespaceHome }),
      now: () => now,
      oauthClient: new HttpOAuthClient({
        deviceAuthorizationEndpoint: 'https://account.example.test/device',
        tokenEndpoint: 'https://account.example.test/token',
        revocationEndpoint: 'https://account.example.test/revoke',
        now: () => now,
        fetchImpl: async (url, init) => {
          if (String(url).endsWith('/device')) {
            calls.device += 1;
            return Response.json({
              user_code: 'TEST-CODE',
              verification_uri: 'https://account.example.test/verify',
              expired_in: now + 300_000,
              interval: 5_000,
            });
          }
          if (String(url).endsWith('/revoke')) return new Response(null, { status: 200 });
          if ((init?.body as URLSearchParams).get('grant_type') === 'refresh_token') {
            calls.refresh += 1;
            await options.beforeRefreshTokenResponse?.();
            if (refreshFailure === 'offline') throw new TypeError('fetch failed');
            if (refreshFailure) {
              return Response.json(
                {
                  error:
                    refreshFailure === 'unavailable'
                      ? 'temporarily_unavailable'
                      : refreshFailure === 'invalid_grant_503'
                        ? 'invalid_grant'
                        : refreshFailure,
                },
                {
                  status:
                    refreshFailure === 'unavailable' || refreshFailure === 'invalid_grant_503'
                      ? 503
                      : 400,
                },
              );
            }
          } else {
            await options.beforeDeviceTokenResponse?.();
          }
          serial += 1;
          return Response.json({
            access_token: `test-access-${serial}`,
            refresh_token: `test-refresh-${serial}`,
            token_type: 'Bearer',
            scope: 'agent.default',
            expires_in: 3_600,
          });
        },
      }),
    });
  return {
    dataDir,
    namespace,
    calls,
    createCore,
    createManager: () => createAuthManager(createCore()),
    setRefreshFailure: (failure: typeof refreshFailure) => {
      refreshFailure = failure;
    },
    advanceTime: (ms: number) => {
      now += ms;
    },
    cleanup: () => rm(dataDir, { recursive: true, force: true }),
  };
}
