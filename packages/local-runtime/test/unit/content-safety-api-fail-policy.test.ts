// Standalone client fail-policy tests; the desktop HTTP route is outside this distribution.
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  callSafetyApi,
  createContentSafetyChecker,
  reviewBlocks,
  SAFETY_SCENE,
} from '../../src/content-safety/api.js';
import { logger } from '../../src/common/logger.js';

const region = () => 'cn' as const;
const buildEnv = () => 'test' as const;
const originalBuildEnv = process.env.MAVIS_BUILD_ENV;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalBuildEnv === undefined) delete process.env.MAVIS_BUILD_ENV;
  else process.env.MAVIS_BUILD_ENV = originalBuildEnv;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('callSafetyApi fail-policy classification', () => {
  it('returns local_error when fetch throws (offline / DNS / refused)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    const result = await callSafetyApi({
      content: 'hello',
      scene: SAFETY_SCENE.UserInput,
      fetchImpl,
      region,
      buildEnv,
    });

    expect(result.pass).toBe(false);
    expect(result.errorKind).toBe('local_error');
  });

  it('returns api_error when the gateway responds with a 5xx', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'upstream exploded' }, 502),
    ) as unknown as typeof fetch;

    const result = await callSafetyApi({
      content: 'hello',
      scene: SAFETY_SCENE.UserInput,
      fetchImpl,
      region,
      buildEnv,
    });

    expect(result.pass).toBe(false);
    expect(result.errorKind).toBe('api_error');
  });

  it('distinguishes expired auth from other fail-closed 4xx responses', async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn(async () =>
        jsonResponse({ error: 'unauthorized' }, status),
      ) as unknown as typeof fetch;

      const result = await callSafetyApi({
        content: 'hello',
        scene: SAFETY_SCENE.UserInput,
        fetchImpl,
        region,
        buildEnv,
      });

      // A missing / expired token (401/403) or a bad request (4xx) is NOT a
      // gateway degradation: there is no valid verdict on our side, so we fail
      // closed. Classifying it as api_error would let an unauthenticated user
      // bypass every content gate.
      expect(result.pass).toBe(false);
      expect(result.errorKind).toBe('auth_error');
    }

    const badRequest = await callSafetyApi({
      content: 'hello',
      scene: SAFETY_SCENE.UserInput,
      fetchImpl: vi.fn(async () => jsonResponse({ error: 'bad request' }, 400)) as unknown as typeof fetch,
      region,
      buildEnv,
    });
    expect(badRequest.errorKind).toBe('local_error');
  });

  it('returns local_error when the gateway returns a non-JSON 2xx body', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('not json at all', { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await callSafetyApi({
      content: 'hello',
      scene: SAFETY_SCENE.UserInput,
      fetchImpl,
      region,
      buildEnv,
    });

    expect(result.pass).toBe(false);
    expect(result.errorKind).toBe('local_error');
  });

  it('returns local_error when the 2xx JSON has no boolean pass/safe field', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ reason: 'weird shape' }),
    ) as unknown as typeof fetch;

    const result = await callSafetyApi({
      content: 'hello',
      scene: SAFETY_SCENE.UserInput,
      fetchImpl,
      region,
      buildEnv,
    });

    expect(result.pass).toBe(false);
    expect(result.errorKind).toBe('local_error');
  });

  it('returns api_error when the gateway explicitly reports service-unavailable (50200)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ pass: false, errorCode: 50200 }),
    ) as unknown as typeof fetch;

    const result = await callSafetyApi({
      content: 'hello',
      scene: SAFETY_SCENE.UserInput,
      fetchImpl,
      region,
      buildEnv,
    });

    expect(result.pass).toBe(false);
    expect(result.errorKind).toBe('api_error');
  });

  it('returns rejected when the gateway reviews and rejects the content', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ pass: false, reason: 'blocked by policy' }),
    ) as unknown as typeof fetch;

    const result = await callSafetyApi({
      content: 'bad stuff',
      scene: SAFETY_SCENE.UserInput,
      fetchImpl,
      region,
      buildEnv,
    });

    expect(result.pass).toBe(false);
    expect(result.errorKind).toBe('rejected');
  });

  it('passes through a clean approval with no errorKind', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pass: true })) as unknown as typeof fetch;

    const result = await callSafetyApi({
      content: 'hello',
      scene: SAFETY_SCENE.UserInput,
      fetchImpl,
      region,
      buildEnv,
    });

    expect(result.pass).toBe(true);
    expect(result.errorKind).toBeUndefined();
  });

  it('sends a private object key without a client URL', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pass: true })) as unknown as typeof fetch;

    await callSafetyApi({
      content: '',
      scene: SAFETY_SCENE.UserInput,
      attachments: [
        {
          objectKey: '11111111-2222-3333-4444-555555555555',
          fileName: 'screen.png',
        },
      ],
      fetchImpl,
      region,
      buildEnv,
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://matrix-test.example.invalid/mavis/api/v1/content?require_auth=true',
      expect.anything(),
    );
    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      files: [
        {
          object_key: '11111111-2222-3333-4444-555555555555',
          file_name: 'screen.png',
        },
      ],
    });
  });

  it.each([
    undefined,
    [{ fileUrl: 'https://cdn.hailuoai.com/legacy.png', fileName: 'legacy.png' }],
  ])('preserves the auth policy for legacy text and URL requests: %j', async (attachments) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pass: true }));
    await callSafetyApi({
      content: 'hello',
      scene: SAFETY_SCENE.UserInput,
      attachments,
      fetchImpl,
      region,
      buildEnv,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://matrix-test.example.invalid/mavis/api/v1/content',
      expect.anything(),
    );
  });

  it('sends the managed lane only for non-prod content-safety calls', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pass: true })) as unknown as typeof fetch;
    await callSafetyApi({
      content: 'hello',
      scene: SAFETY_SCENE.UserInput,
      authContext: { accessToken: 'jwt-token' },
      routingContext: { bedrockLane: 'lane-a' },
      fetchImpl,
      region,
      buildEnv,
    });
    const requestInit = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[
      1
    ] as RequestInit;
    expect(new Headers(requestInit.headers).get('bedrock-lane')).toBe('lane-a');

    const prodFetch = vi.fn(async () => jsonResponse({ pass: true })) as unknown as typeof fetch;
    await callSafetyApi({
      content: 'hello',
      scene: SAFETY_SCENE.UserInput,
      routingContext: { bedrockLane: 'lane-a' },
      fetchImpl: prodFetch,
      region,
      buildEnv: () => 'prod',
    });
    const prodInit = (prodFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(prodInit.headers).get('bedrock-lane')).toBeNull();
  });

  it('sends Shared OAuth access tokens as a Bearer credential', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pass: true })) as unknown as typeof fetch;

    await callSafetyApi({
      content: 'hello',
      scene: SAFETY_SCENE.UserInput,
      authContext: { accessToken: 'shared-oauth-token' },
      fetchImpl,
      region,
      buildEnv,
    });

    const requestInit = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[
      1
    ] as RequestInit;
    const headers = new Headers(requestInit.headers);
    expect(headers.get('Authorization')).toBe('Bearer shared-oauth-token');
    expect(headers.get('Token')).toBeNull();
  });

  it.each([
    ['auth', () => jsonResponse({ error: 'private-response' }, 401), 401],
    ['http', () => jsonResponse({ error: 'private-response' }, 503), 503],
    ['response', () => new Response('private-response'), 200],
    ['response', () => jsonResponse(null), 200],
    ['response', () => jsonResponse({ secret: 'private-response' }), 200],
    [
      'transport',
      () => {
        throw new TypeError('private-error https://secret.invalid/?token=private-token', {
          cause: { code: 'ENOTFOUND' },
        });
      },
      undefined,
    ],
    [
      'transport',
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException('private-error', 'TimeoutError'));
            },
          }),
        ),
      200,
    ],
  ] as const)(
    'logs redacted %s failures in production',
    async (failureKind, response, statusCode) => {
      const log = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const result = await callSafetyApi({
        content: 'private-content',
        scene: SAFETY_SCENE.UserInput,
        authContext: { accessToken: 'private-token' },
        attachments: [{ fileUrl: 'https://secret.invalid/private-file', fileName: 'private-name' }],
        fetchImpl: async () => response(),
        region,
        buildEnv: () => 'prod',
      });
      expect(result.pass).toBe(false);
      expect(reviewBlocks(result)).toBe(failureKind !== 'http');
      expect(log).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          reviewId: expect.any(String),
          endpointHost: 'agent.minimax.cn',
          apiVersion: 'v1',
          scene: SAFETY_SCENE.UserInput,
          durationMs: expect.any(Number),
          failureKind,
          ...(statusCode === undefined ? { transportKind: 'dns' } : { statusCode }),
        }),
        '[content-safety] review failed',
      );
      const serialized = JSON.stringify(log.mock.calls);
      expect(serialized).not.toContain('private-');
      expect(serialized).not.toContain('secret.invalid');
      expect(serialized).not.toContain('https://');
    },
  );

  it('does not log successful reviews in production', async () => {
    const log = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await callSafetyApi({
      content: 'hello',
      scene: SAFETY_SCENE.UserInput,
      authContext: { accessToken: 'shared-oauth-token' },
      fetchImpl: vi.fn(async () => jsonResponse({ pass: true })) as unknown as typeof fetch,
      region,
      buildEnv: () => 'prod',
    });

    expect(log).not.toHaveBeenCalled();
  });

  it('uses a loopback test endpoint only for test builds', async () => {
    const testFetch = vi.fn(async () => jsonResponse({ pass: true })) as unknown as typeof fetch;
    await callSafetyApi({
      content: 'hello',
      scene: SAFETY_SCENE.UserInput,
      fetchImpl: testFetch,
      region,
      buildEnv,
      testBaseURL: 'http://127.0.0.1:43123/',
    });
    expect(testFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:43123/mavis/api/v1/content',
      expect.any(Object),
    );

    const prodFetch = vi.fn(async () => jsonResponse({ pass: true })) as unknown as typeof fetch;
    await callSafetyApi({
      content: 'hello',
      scene: SAFETY_SCENE.UserInput,
      fetchImpl: prodFetch,
      region,
      buildEnv: () => 'prod',
      testBaseURL: 'http://127.0.0.1:43123',
    });
    expect(prodFetch).toHaveBeenCalledWith(
      'https://agent.minimax.cn/mavis/api/v1/content',
      expect.any(Object),
    );
  });

  it('ignores non-loopback test endpoint overrides', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ pass: true })) as unknown as typeof fetch;
    await callSafetyApi({
      content: 'hello',
      scene: SAFETY_SCENE.UserInput,
      fetchImpl,
      region,
      buildEnv,
      testBaseURL: 'https://example.com',
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://matrix-test.example.invalid/mavis/api/v1/content',
      expect.any(Object),
    );
  });
});

describe('reviewBlocks shared fail-policy predicate', () => {
  it('blocks rejected + local_error, degrade-passes api_error, allows a clean pass', () => {
    expect(reviewBlocks({ pass: false, errorKind: 'rejected' })).toBe(true);
    expect(reviewBlocks({ pass: false, errorKind: 'local_error' })).toBe(true);
    expect(reviewBlocks({ pass: false, errorKind: 'auth_error' })).toBe(true);
    expect(reviewBlocks({ pass: false, errorKind: 'api_error' })).toBe(false);
    expect(reviewBlocks({ pass: true })).toBe(false);
  });
});

describe('createContentSafetyChecker airtight contract', () => {
  it.each([401, 403])(
    'recovers HTTP %i once with a new token and preserves the review payload',
    async (status) => {
      let accessToken = 'old-token';
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(new Response('{}', { status }))
        .mockResolvedValueOnce(jsonResponse({ pass: true }));
      const authContextInvalidator = vi.fn(async (rejected?: string) => {
        expect(rejected).toBe('old-token');
        accessToken = 'new-token';
      });
      const check = createContentSafetyChecker({
        authContextGetter: () => ({ accessToken }),
        authContextInvalidator,
        fetchImpl,
        region,
        buildEnv,
      });
      expect(await check('review this', SAFETY_SCENE.UserInput)).toMatchObject({ pass: true });
      expect(authContextInvalidator).toHaveBeenCalledOnce();
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(new Headers(fetchImpl.mock.calls[0]?.[1]?.headers).get('Authorization')).toBe(
        'Bearer old-token',
      );
      expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get('Authorization')).toBe(
        'Bearer new-token',
      );
      expect(fetchImpl.mock.calls[1]?.[1]?.body).toBe(fetchImpl.mock.calls[0]?.[1]?.body);
    },
  );

  it.each(['unchanged', 'logged-out', 'throws'] as const)(
    'keeps auth failures closed when recovery is %s',
    async (mode) => {
      let accessToken: string | undefined = 'old-token';
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('{}', { status: 401 }));
      const check = createContentSafetyChecker({
        authContextGetter: () => (accessToken ? { accessToken } : undefined),
        authContextInvalidator: async () => {
          if (mode === 'logged-out') accessToken = undefined;
          if (mode === 'throws') throw new Error('refresh unavailable');
        },
        fetchImpl,
        region,
        buildEnv,
      });
      const result = await check('review this', SAFETY_SCENE.UserInput);
      expect(result).toMatchObject({ pass: false, errorKind: 'auth_error' });
      expect(reviewBlocks(result)).toBe(true);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it('does not loop when the new token is also rejected', async () => {
    let accessToken = 'old-token';
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('{}', { status: 401 }));
    const authContextInvalidator = vi.fn(async () => {
      accessToken = 'new-token';
    });
    const check = createContentSafetyChecker({
      authContextGetter: () => ({ accessToken }),
      authContextInvalidator,
      fetchImpl,
      region,
      buildEnv,
    });
    expect(await check('review this', SAFETY_SCENE.UserInput)).toMatchObject({
      pass: false,
      errorKind: 'auth_error',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(authContextInvalidator).toHaveBeenCalledOnce();
  });

  it('does not refresh anonymous or non-auth review failures', async () => {
    const authContextInvalidator = vi.fn();
    for (const [token, status] of [
      [undefined, 401],
      ['token', 400],
      ['token', 500],
      ['token', 200],
    ] as const) {
      const check = createContentSafetyChecker({
        authContextGetter: () => (token ? { accessToken: token } : undefined),
        authContextInvalidator,
        fetchImpl: async () => new Response(JSON.stringify({ pass: false }), { status }),
        region,
        buildEnv,
      });
      await check('review this', SAFETY_SCENE.UserInput);
    }
    expect(authContextInvalidator).not.toHaveBeenCalled();
  });

  it('resolves to a local_error result instead of throwing when the auth getter throws', async () => {
    const checker = createContentSafetyChecker({
      authContextGetter: () => {
        throw new Error('auth resolution blew up');
      },
      fetchImpl: (async () => jsonResponse({ pass: true })) as unknown as typeof fetch,
      region,
      buildEnv,
    });

    const result = await checker('hello', SAFETY_SCENE.ConfigField);

    // The checker never rejects: callers can trust `errorKind` + `reviewBlocks`
    // and never need their own try/catch.
    expect(result.pass).toBe(false);
    expect(result.errorKind).toBe('local_error');
    expect(reviewBlocks(result)).toBe(true);
  });
});

