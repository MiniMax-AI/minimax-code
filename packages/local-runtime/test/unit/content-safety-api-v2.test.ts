import { logger } from '../../src/common/logger.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SAFETY_CHECK_V2_SCENE } from '@mavis/shared/safety-check-v2';
import { callLocalSafetyCheckV2 } from '../../src/content-safety/api-v2.js';
import { callSafetyApi, SAFETY_SCENE } from '../../src/content-safety/api.js';

const defaults = {
  request: {
    content_text: 'hello',
    scene: 100 as const,
    sessionId: 'session-1',
  },
  region: () => 'cn' as const,
  buildEnv: () => 'test' as const,
};
const fetchResponse = (body: unknown) =>
  vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('local biz-gateway SafetyCheckV2 client', () => {
  it('uses the V2 endpoint and scene with the current Bearer/routing headers', async () => {
    const fetchImpl = fetchResponse({ action: 1 });
    await expect(
      callLocalSafetyCheckV2({
        ...defaults,
        fetchImpl,
        authContext: { accessToken: ' oauth-token ' },
        routingContext: { bedrockLane: 'lane-a' },
      }),
    ).resolves.toEqual({ action: 'allow' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://matrix-test.example.invalid/mavis/api/v2/content?require_auth=true');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer oauth-token');
    expect(headers.get('Token')).toBeNull();
    expect(headers.get('bedrock-lane')).toBe('lane-a');
    expect(JSON.parse(String(init?.body))).toEqual({
      content_text: 'hello',
      scene: 100,
      sessionId: 'session-1',
    });
  });

  it.each([
    ...([
      ['DesktopAssistantReply', 11],
      ['DesktopAssistantThinking', 13],
      ['AppAssistantReply', 21],
      ['AppAssistantThinking', 23],
      ['WebAssistantReply', 31],
      ['WebAssistantThinking', 33],
      ['DesktopUserQuery', 110],
      ['AppUserQuery', 120],
      ['WebUserQuery', 130],
    ] as const).map(([name, wireScene]) => ({
      scene: SAFETY_CHECK_V2_SCENE[name],
      wireScene,
      payload: { content_text: 'platform text' },
    })),
    {
      scene: SAFETY_CHECK_V2_SCENE.AssistantReply,
      wireScene: 1,
      payload: { content_text: 'reply' },
    },
    {
      scene: SAFETY_CHECK_V2_SCENE.GeneratedImage,
      wireScene: 2,
      payload: { image_url: 'https://cdn.example.test/generated.png' },
    },
    {
      scene: SAFETY_CHECK_V2_SCENE.AssistantThinking,
      wireScene: 3,
      payload: { content_text: 'thinking' },
    },
    {
      scene: SAFETY_CHECK_V2_SCENE.UserQuery,
      wireScene: 100,
      payload: { content_text: 'query' },
    },
    {
      scene: SAFETY_CHECK_V2_SCENE.UserUploadImage,
      wireScene: 101,
      payload: { image_url: 'https://cdn.example.test/upload.png' },
    },
    {
      scene: SAFETY_CHECK_V2_SCENE.UserUploadFile,
      wireScene: 102,
      payload: { files: [{ file_url: 'https://cdn.example.test/file.pdf', file_name: 'file.pdf' }] },
    },
    {
      scene: SAFETY_CHECK_V2_SCENE.UserAvatar,
      wireScene: 200,
      payload: { image_url: 'https://cdn.example.test/avatar.png' },
    },
    {
      scene: SAFETY_CHECK_V2_SCENE.InterfaceImage,
      wireScene: 201,
      payload: { image_url: 'https://cdn.example.test/interface.png' },
    },
  ])('preserves scene $scene and its payload at the HTTP boundary', async ({ scene, wireScene, payload }) => {
    const fetchImpl = fetchResponse({ action: 1 });
    const sessionId = 'session-1';
    await callLocalSafetyCheckV2({ ...defaults, fetchImpl, request: { scene, ...payload, sessionId } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://matrix-test.example.invalid/mavis/api/v2/content?require_auth=true');
    expect(JSON.parse(String(init?.body))).toEqual({ scene: wireScene, ...payload, sessionId });
  });

  it.each([
    [{ action: 1 }, { action: 'allow' }],
    [{ action: 1, errorCode: 0 }, { action: 'allow' }],
    [{ action: 2, errorCode: 50201 }, { action: 'reject' }],
    [
      { action: 3, errorCode: 50201, suggestion: ' safe reply ' },
      { action: 'replace', replacementText: ' safe reply ' },
    ],
    [
      { action: 4, errorCode: 50201, guide_prompt: ' private ', error: 'request rejected' },
      { action: 'guide', guidePrompt: ' private ' },
    ],
    [{ action: 4, errorCode: 50201 }, { action: 'guide' }],
    [{ action: 4, errorCode: 50201, guide_prompt: '' }, { action: 'guide' }],
    [{ action: 4, errorCode: 50201, guide_prompt: '  ' }, { action: 'guide' }],
  ])('maps the HTTP action to the runtime verdict: %j', async (body, expected) => {
    expect(await callLocalSafetyCheckV2({ ...defaults, fetchImpl: fetchResponse(body) })).toEqual(
      expected,
    );
  });

  it.each([
    [
      { action: 1, pass: false, decision: 'block', suggestion: 'ignored', guide_prompt: 'ignored' },
      { action: 'allow' },
    ],
    [
      { action: 2, errorCode: 50201, pass: true, decision: 'review', suggestion: 'ignored', guide_prompt: 'ignored' },
      { action: 'reject' },
    ],
    [
      { action: 3, errorCode: 50201, decision: 'block', suggestion: 'fixed', guide_prompt: 'ignored' },
      { action: 'replace', replacementText: 'fixed' },
    ],
    [
      { action: 4, errorCode: 50201, suggestion: 'ignored' },
      { action: 'guide' },
    ],
  ])('uses action as the sole verdict despite irrelevant fields: %j', async (body, expected) => {
    expect(await callLocalSafetyCheckV2({ ...defaults, fetchImpl: fetchResponse(body) })).toEqual(
      expected,
    );
  });

  it.each([
    {},
    { action: null },
    { action: 0 },
    { action: -1 },
    { action: 5 },
    { action: 1.5 },
    { action: '1' },
    { action: true },
    { action: 1, errorCode: 50201 },
    { action: 2 },
    { action: 3, suggestion: 'fixed' },
    { action: 4 },
    { action: 2, errorCode: 0 },
    { action: 3, errorCode: 0, suggestion: 'fixed' },
    { action: 4, errorCode: 0 },
    { action: 4, errorCode: '50201' },
    { action: 4, errorCode: 50201.5 },
    { action: 4, errorCode: null },
    { action: 4, errorCode: 50201, guide_prompt: 123 },
    { action: 4, errorCode: 50201, guide_prompt: null },
    { action: 3, errorCode: 50201 },
    { action: 3, errorCode: 50201, suggestion: '' },
    { action: 3, errorCode: 50201, suggestion: '   ' },
    { action: 3, errorCode: 50201, suggestion: 123 },
    { action: 3, errorCode: 50201, suggestion: null },
    { pass: true, decision: 'pass' },
    { pass: false, errorCode: 50201, decision: 'block' },
    { decision: 'pass', action: 'allow' },
    { decision: 'review', action: 'guide', guide_prompt: 'old contract' },
  ])('rejects invalid actions and incompatible response contracts: %j', async (body) => {
    await expect(
      callLocalSafetyCheckV2({ ...defaults, fetchImpl: fetchResponse(body) }),
    ).rejects.toMatchObject({ kind: 'response' });
  });

  it.each([
    { errorCode: 50200, error: 'request failed' },
    { action: 1, errorCode: 50200 },
    { action: 4, errorCode: 50202 },
  ])('classifies upstream errors before reading action: %j', async (body) => {
    await expect(
      callLocalSafetyCheckV2({ ...defaults, fetchImpl: fetchResponse(body) }),
    ).rejects.toMatchObject({ kind: 'upstream', statusCode: body.errorCode });
  });

  it('keeps region/build routing and limits endpoint overrides to test loopback', async () => {
    const fetchImpl = fetchResponse({ action: 1 });
    await callLocalSafetyCheckV2({
      ...defaults,
      fetchImpl,
      testBaseURL: 'http://127.0.0.1:45678/',
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe('http://127.0.0.1:45678/mavis/api/v2/content?require_auth=true');
    await callLocalSafetyCheckV2({
      ...defaults,
      fetchImpl,
      testBaseURL: 'https://untrusted.example.test',
    });
    expect(fetchImpl.mock.calls[1]![0]).toBe(
      'https://matrix-test.example.invalid/mavis/api/v2/content?require_auth=true',
    );
    await callLocalSafetyCheckV2({
      ...defaults,
      fetchImpl,
      region: () => 'en',
      buildEnv: () => 'prod',
      testBaseURL: 'http://127.0.0.1:45678',
    });
    expect(fetchImpl.mock.calls[2]![0]).toBe(
      'https://agent.minimax.io/mavis/api/v2/content?require_auth=true',
    );
  });

  it('does not send a credential when there is no active token', async () => {
    vi.stubEnv('MAVIS_ACCESS_TOKEN', '');
    const fetchImpl = fetchResponse({ action: 1 });
    await callLocalSafetyCheckV2({ ...defaults, fetchImpl });
    expect(new Headers(fetchImpl.mock.calls[0]![1]?.headers).has('Authorization')).toBe(false);
  });

  it('leaves the existing V1 client endpoint and request unchanged', async () => {
    const fetchImpl = fetchResponse({ pass: true });
    await callSafetyApi({
      content: 'hello',
      scene: SAFETY_SCENE.UserInput,
      fetchImpl,
      region: defaults.region,
      buildEnv: defaults.buildEnv,
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      'https://matrix-test.example.invalid/mavis/api/v1/content',
    );
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual({
      content_text: 'hello',
      scene: 300,
    });
  });
});

describe('V2 production failure diagnostics', () => {
  it.each([
    [{ cause: { code: 'ENOTFOUND' } }, 'dns'],
    [{ cause: { code: 'ECONNREFUSED' } }, 'connect'],
    [{ cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' } }, 'tls'],
    [{ name: 'TimeoutError' }, 'timeout'],
    [{ cause: { code: 'UND_ERR_BODY_TIMEOUT' } }, 'timeout'],
    [{ name: 'AbortError' }, 'aborted'],
    [{ cause: { code: 'private-code' } }, 'unknown'],
  ] as const)('retains only the transport category %j', async (details, transportKind) => {
    const log = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const error = Object.assign(
      new Error('private-error https://secret.invalid/?token=private-token'),
      details,
    );
    await expect(
      callLocalSafetyCheckV2({
        ...defaults,
        buildEnv: () => 'prod',
        authContext: { accessToken: 'private-token' },
        request: { scene: 100, content_text: 'private-content', sessionId: 'private-session' },
        fetchImpl: async () => {
          throw error;
        },
      }),
    ).rejects.toMatchObject({ kind: 'transport', transportKind });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({
        reviewId: expect.any(String),
        endpointHost: 'agent.minimax.cn',
        apiVersion: 'v2',
        scene: 100,
        durationMs: expect.any(Number),
        failureKind: 'transport',
        transportKind,
      }),
      '[content-safety] review failed',
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-');
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret.invalid');
  });

  it.each([
    ['auth', () => new Response('private-body', { status: 401 })],
    ['http', () => new Response('private-body', { status: 503 })],
    ['response', () => new Response('private-body')],
    ['response', () => Response.json({ unexpected: 'private-body' })],
    ['upstream', () => Response.json({ errorCode: 50200, error: 'private-body' })],
    [
      'transport',
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new DOMException('private-body', 'TimeoutError'));
            },
          }),
        ),
    ],
  ] as const)('logs failed %s reviews without response data', async (kind, response) => {
    const log = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    await expect(
      callLocalSafetyCheckV2({
        ...defaults,
        buildEnv: () => 'prod',
        fetchImpl: async () => response(),
      }),
    ).rejects.toMatchObject({ kind });
    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ failureKind: kind }),
      '[content-safety] review failed',
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain('private-body');
  });
});
