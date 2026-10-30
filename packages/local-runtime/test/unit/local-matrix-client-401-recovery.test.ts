import { DesktopGatewayHttpError } from '@mavis/agent-tools/desktop';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { LocalMatrixClient } from '../../src/matrix/local-matrix-client.js';

describe('LocalMatrixClient 401 recovery', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // A managed endpoint: no override, so the runtime default base URL applies.
  function stubManagedEndpoint(): void {
    vi.stubEnv('MATRIX_BASE_URL', '');
    vi.stubEnv('MATRIX_TOKEN', '');
  }

  it('leaves the managed login alone when an explicit MATRIX_TOKEN was rejected', async () => {
    vi.stubEnv('MATRIX_BASE_URL', 'https://matrix-dev.example.test');
    vi.stubEnv('MATRIX_TOKEN', 'explicit-dev-token');
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ code: 401 }), { status: 401 }),
    );
    const authContextInvalidator = vi.fn(async () => undefined);
    const client = new LocalMatrixClient({
      authContextGetter: () => ({ accessToken: 'managed-token', loginEpoch: 'login-1' }),
      authContextInvalidator,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const request = client.postJson('/matrix/api/v1/mcp/web_search', { query: 'minimax' });

    await expect(request).rejects.toBeInstanceOf(DesktopGatewayHttpError);
    await expect(request).rejects.toMatchObject({ statusCode: 401 });
    expect(authContextInvalidator).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer explicit-dev-token');
  });

  it('reads the current token per request and retries once after a host refresh', async () => {
    stubManagedEndpoint();
    let auth = { accessToken: 'stale-token', loginEpoch: 'login-1' };
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        async () => new Response(JSON.stringify({ code: 401 }), { status: 401 }),
      )
      .mockImplementationOnce(async () => Response.json({ result: { ok: true } }));
    const authContextInvalidator = vi.fn(async () => {
      // Same login, refreshed access token: only the token changes.
      auth = { accessToken: 'fresh-token', loginEpoch: 'login-1' };
    });
    const client = new LocalMatrixClient({
      authContextGetter: () => auth,
      authContextInvalidator,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.postJson('/matrix/api/v1/mcp/web_search', { query: 'minimax' }),
    ).resolves.toMatchObject({ result: { ok: true } });

    expect(authContextInvalidator).toHaveBeenCalledWith('stale-token', 'login-1');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [, first] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const [, second] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(new Headers(first.headers).get('authorization')).toBe('Bearer stale-token');
    expect(new Headers(second.headers).get('authorization')).toBe('Bearer fresh-token');
  });

  it('returns the original 401 when the host cannot refresh the rejected token', async () => {
    stubManagedEndpoint();
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ code: 401 }), { status: 401 }),
    );
    const client = new LocalMatrixClient({
      authContextGetter: () => ({ accessToken: 'stale-token', loginEpoch: 'login-1' }),
      authContextInvalidator: vi.fn(async () => undefined),
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.postJson('/matrix/api/v1/mcp/web_search', { query: 'minimax' }),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
