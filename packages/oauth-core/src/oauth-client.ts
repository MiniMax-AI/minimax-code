import { createHash, randomBytes } from 'node:crypto';

import { MCODE_OAUTH_AUDIENCE, MCODE_OAUTH_CLIENT_ID, MCODE_OAUTH_SCOPES } from './contracts.js';

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

export interface DeviceAuthorization {
  deviceCode: string;
  codeVerifier: string;
  tokenPollingParameter?: 'user_code';
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSec: number;
  intervalSec: number;
}

export interface OAuthTokenGrant {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  scopes: string[];
  audience: string;
  expiresInSec: number;
  subject?: string;
  accountId?: string;
}

export interface OAuthClient {
  startDeviceAuthorization(options?: OAuthRequestOptions): Promise<DeviceAuthorization>;
  pollDeviceToken(
    authorization: DeviceAuthorization,
    options?: OAuthRequestOptions,
  ): Promise<OAuthTokenGrant>;
  refreshToken(refreshToken: string): Promise<OAuthTokenGrant>;
  revokeToken(refreshToken: string): Promise<void>;
}

export interface OAuthRequestOptions {
  signal?: AbortSignal;
}

export interface HttpOAuthClientOptions {
  deviceAuthorizationEndpoint: string;
  deviceAuthorizationHeaders?: Record<string, string>;
  tokenEndpoint: string;
  revocationEndpoint: string;
  fetchImpl?: typeof fetch;
  sleep?: (durationMs: number) => Promise<void>;
  now?: () => number;
  /**
   * Per-request limit for interactive login requests (device authorization and
   * token polling), covering connect, response headers and body. Unset keeps
   * them unbounded. Refresh and revocation requests are never limited here.
   */
  loginRequestTimeoutMs?: number;
}

/** A login request got no complete response in time; `name` matches the DOM TimeoutError. */
export class OAuthRequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`The OAuth request did not complete within ${timeoutMs} ms.`);
    this.name = 'TimeoutError';
  }
}

export class OAuthProtocolError extends Error {
  constructor(
    readonly code: string,
    message?: string,
    readonly httpStatus?: number,
  ) {
    super(
      message ??
        `The OAuth server rejected the request (${code}${httpStatus ? `, HTTP ${httpStatus}` : ''}).`,
    );
    this.name = 'OAuthProtocolError';
  }
}

export class HttpOAuthClient implements OAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (durationMs: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: HttpOAuthClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep =
      options.sleep ?? ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
    this.now = options.now ?? Date.now;
  }

  async startDeviceAuthorization(options: OAuthRequestOptions = {}): Promise<DeviceAuthorization> {
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
    const body = await this.postForm(
      this.options.deviceAuthorizationEndpoint,
      {
        client_id: MCODE_OAUTH_CLIENT_ID,
        scope: MCODE_OAUTH_SCOPES.join(' '),
        audience: MCODE_OAUTH_AUDIENCE,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      },
      {
        headers: this.options.deviceAuthorizationHeaders,
        signal: options.signal,
        timeoutMs: this.options.loginRequestTimeoutMs,
      },
    );
    const userCode = readString(body, 'user_code');
    const standardDeviceCode = readString(body, 'device_code');
    const accountExpiredAtMs = readPositiveNumber(body, 'expired_in');
    const usesAccountUserCodePolling =
      !standardDeviceCode && Boolean(userCode) && accountExpiredAtMs !== undefined;
    const deviceCode = standardDeviceCode ?? (usesAccountUserCodePolling ? userCode : undefined);
    const verificationUri =
      readString(body, 'verification_uri') ?? readString(body, 'verification_url');
    const expiresInSec =
      readPositiveNumber(body, 'expires_in') ??
      normalizeAccountExpirySeconds(accountExpiredAtMs, this.now());
    const rawInterval = readPositiveNumber(body, 'interval');
    const intervalSec =
      usesAccountUserCodePolling && rawInterval !== undefined
        ? rawInterval / 1_000
        : (rawInterval ?? 5);
    if (!deviceCode || !userCode || !verificationUri || !expiresInSec) {
      throw new OAuthProtocolError('invalid_device_authorization_response');
    }
    return {
      deviceCode,
      codeVerifier,
      ...(usesAccountUserCodePolling ? { tokenPollingParameter: 'user_code' as const } : {}),
      userCode,
      verificationUri,
      ...(readString(body, 'verification_uri_complete') || usesAccountUserCodePolling
        ? {
            verificationUriComplete:
              readString(body, 'verification_uri_complete') ?? verificationUri,
          }
        : {}),
      expiresInSec,
      intervalSec,
    };
  }

  async pollDeviceToken(
    authorization: DeviceAuthorization,
    options: OAuthRequestOptions = {},
  ): Promise<OAuthTokenGrant> {
    const deadline = this.now() + authorization.expiresInSec * 1_000;
    let intervalMs = authorization.intervalSec * 1_000;
    while (this.now() < deadline) {
      options.signal?.throwIfAborted();
      const pollingCode: Record<string, string> =
        authorization.tokenPollingParameter === 'user_code'
          ? { user_code: authorization.userCode }
          : { device_code: authorization.deviceCode };
      const response = await this.postFormAllowOAuthError(
        this.options.tokenEndpoint,
        {
          grant_type: DEVICE_GRANT_TYPE,
          ...pollingCode,
          client_id: MCODE_OAUTH_CLIENT_ID,
          code_verifier: authorization.codeVerifier,
        },
        { signal: options.signal, timeoutMs: this.options.loginRequestTimeoutMs },
      );
      const pollingStatus = readString(response.body, 'status');
      if (response.ok && pollingStatus === 'pending') {
        await sleepWithSignal(this.sleep, intervalMs, options.signal);
        continue;
      }
      if (response.ok && pollingStatus === 'slow_down') {
        intervalMs += 5_000;
        await sleepWithSignal(this.sleep, intervalMs, options.signal);
        continue;
      }
      if (response.ok && (pollingStatus === 'denied' || pollingStatus === 'access_denied')) {
        throw new OAuthProtocolError('access_denied');
      }
      if (response.ok && (pollingStatus === 'expired' || pollingStatus === 'expired_token')) {
        throw new OAuthProtocolError('expired_token');
      }
      if (response.ok) return parseTokenGrant(response.body);
      if (response.error === 'authorization_pending') {
        await sleepWithSignal(this.sleep, intervalMs, options.signal);
        continue;
      }
      if (response.error === 'slow_down') {
        intervalMs += 5_000;
        await sleepWithSignal(this.sleep, intervalMs, options.signal);
        continue;
      }
      throw new OAuthProtocolError(
        response.error ?? 'device_authorization_failed',
        undefined,
        response.status,
      );
    }
    throw new OAuthProtocolError('expired_token', 'The OAuth device authorization expired.');
  }

  async refreshToken(refreshToken: string): Promise<OAuthTokenGrant> {
    const body = await this.postForm(this.options.tokenEndpoint, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: MCODE_OAUTH_CLIENT_ID,
      scope: MCODE_OAUTH_SCOPES.join(' '),
      audience: MCODE_OAUTH_AUDIENCE,
    });
    return parseTokenGrant(body, refreshToken);
  }

  async revokeToken(refreshToken: string): Promise<void> {
    const response = await this.postFormAllowOAuthError(
      this.options.revocationEndpoint,
      {
        token: refreshToken,
        token_type_hint: 'refresh_token',
        client_id: MCODE_OAUTH_CLIENT_ID,
      },
      { allowEmptySuccess: true },
    );
    if (!response.ok)
      throw new OAuthProtocolError(
        response.error ?? 'oauth_request_failed',
        undefined,
        response.status,
      );
  }

  private async postForm(
    endpoint: string,
    values: Record<string, string>,
    options: OAuthHttpRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.postFormAllowOAuthError(endpoint, values, options);
    if (!response.ok)
      throw new OAuthProtocolError(
        response.error ?? 'oauth_request_failed',
        undefined,
        response.status,
      );
    return response.body;
  }

  private postFormAllowOAuthError(
    endpoint: string,
    values: Record<string, string>,
    options: OAuthHttpRequestOptions = {},
  ): Promise<OAuthFormResponse> {
    return withRequestTimeout(options.timeoutMs, options.signal, (signal) =>
      this.sendForm(endpoint, values, { ...options, signal }),
    );
  }

  private async sendForm(
    endpoint: string,
    values: Record<string, string>,
    options: OAuthHttpRequestOptions,
  ): Promise<OAuthFormResponse> {
    const response = await this.fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...options.headers,
      },
      body: new URLSearchParams(values),
      signal: options.signal,
    });
    const body = asRecord(await response.json().catch(() => undefined));
    if (!body && response.ok && options.allowEmptySuccess)
      return { ok: true, status: response.status, body: {} };
    if (!body) throw new OAuthProtocolError('invalid_json_response', undefined, response.status);
    const error = readString(body, 'error');
    return {
      ok: response.ok && !error,
      status: response.status,
      body,
      ...(error ? { error } : {}),
    };
  }
}

interface OAuthHttpRequestOptions extends OAuthRequestOptions {
  headers?: Record<string, string>;
  allowEmptySuccess?: boolean;
  timeoutMs?: number;
}

interface OAuthFormResponse {
  ok: boolean;
  status: number;
  body: Record<string, unknown>;
  error?: string;
}

/**
 * Bounds one request, body read included, without changing cancellation: an
 * external abort still rejects with its own reason. The race settles before the
 * transport is aborted, so a transport that rejects with a generic AbortError
 * cannot mask the timeout. AbortSignal.any is avoided because it needs Node 20.3.
 */
async function withRequestTimeout<T>(
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<T> {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return run(signal);
  }
  signal?.throwIfAborted();
  const controller = new AbortController();
  let rejectInterrupted!: (reason: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectInterrupted = reject;
  });
  const interrupt = (reason: unknown) => {
    rejectInterrupted(reason);
    controller.abort(reason);
  };
  const onAbort = () => interrupt(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => interrupt(new OAuthRequestTimeoutError(timeoutMs)), timeoutMs);
  try {
    return await Promise.race([run(controller.signal), interrupted]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function sleepWithSignal(
  sleep: (durationMs: number) => Promise<void>,
  durationMs: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    await sleep(durationMs);
    return;
  }
  signal.throwIfAborted();
  let rejectAbort!: (reason?: unknown) => void;
  const onAbort = () => rejectAbort(signal.reason);
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([sleep(durationMs), aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function parseTokenGrant(
  body: Record<string, unknown>,
  previousRefreshToken?: string,
): OAuthTokenGrant {
  const accessToken = readString(body, 'access_token');
  const refreshToken = readString(body, 'refresh_token') ?? previousRefreshToken;
  const tokenType = readString(body, 'token_type');
  const expiresInSec = readPositiveNumber(body, 'expires_in');
  const claims = accessToken ? decodeJwtPayload(accessToken) : undefined;
  const scopes = parseScopes(body.scope ?? claims?.scope ?? claims?.scp);
  if (
    !accessToken ||
    !refreshToken ||
    tokenType?.toLowerCase() !== 'bearer' ||
    !expiresInSec ||
    !scopes.includes(MCODE_OAUTH_SCOPES[0])
  ) {
    throw new OAuthProtocolError('invalid_token_response');
  }
  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    scopes,
    audience: MCODE_OAUTH_AUDIENCE,
    expiresInSec,
    ...(readString(claims, 'sub') ? { subject: readString(claims, 'sub') } : {}),
    ...(readString(claims, 'account_id') ? { accountId: readString(claims, 'account_id') } : {}),
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const segments = token.split('.');
  if (segments.length !== 3 || !segments[1]) return undefined;
  try {
    return asRecord(JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8')));
  } catch {
    return undefined;
  }
}

function parseScopes(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/\s+/u).filter(Boolean);
  if (Array.isArray(value) && value.every((scope) => typeof scope === 'string')) return value;
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const record = asRecord(value);
  const candidate = record?.[key];
  return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : undefined;
}

function readPositiveNumber(value: unknown, key: string): number | undefined {
  const record = asRecord(value);
  const candidate = record?.[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0
    ? candidate
    : undefined;
}

function normalizeAccountExpirySeconds(
  expiredIn: number | undefined,
  nowMs: number,
): number | undefined {
  if (expiredIn === undefined) return undefined;
  if (expiredIn < 1_000_000_000_000) return expiredIn;
  const remainingMs = expiredIn - nowMs;
  return remainingMs > 0 ? Math.ceil(remainingMs / 1_000) : undefined;
}
