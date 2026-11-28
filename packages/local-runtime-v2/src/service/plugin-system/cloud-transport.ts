import { open } from 'node:fs/promises';

import { getRuntimeRegion } from '@mavis/config';

import { writeFileChunkFully } from './file-chunk-writer.js';
import { PLUGIN_PACKAGE_V1_LIMITS } from './plugin/package/package-contract.js';

// Client attribution constants for the `yy` / `x-timestamp` / `x-signature` headers.
//
// These tag a request as coming from a first-party MiniMax client. They are shared
// across clients and are not credentials or a security boundary: request
// authorization is the bearer token sent alongside them.
//
// Changing either value requires a coordinated server-side rollout, so treat them as
// wire-protocol constants.
const SIGNATURE_SALT = 'I*7Cf%WZ#S&%1RlZJ&C2';
const YY_SUFFIX = 'ooui';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 120_000;

interface PluginSystemCloudAuthContext {
  readonly accessToken?: string;
  readonly realUserID?: string;
  readonly loginEpoch?: string;
}

export interface PluginSystemCloudTransportOptions {
  readonly baseUrl: string;
  readonly fetchImpl: typeof fetch;
  readonly authContextGetter: () => PluginSystemCloudAuthContext | undefined;
  readonly authContextInvalidator?: (
    rejectedAccessToken?: string,
    loginEpoch?: string,
  ) => void | Promise<void>;
  readonly appVersion?: string;
  readonly previewSecret?: string;
  readonly lane?: string;
  /** Read on every request; wins over `lane`. Lets a lane switch apply without a restart. */
  readonly laneGetter?: () => string | undefined;
  readonly nowMs?: () => number;
  readonly timeoutMs?: number;
  readonly downloadTimeoutMs?: number;
}

export interface PluginSystemCloudRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly auth: 'none' | 'optional' | 'required';
  /** Immutable host-owned credential captured by an admission gate. */
  readonly authContext?: PluginSystemCloudAuthContext;
  readonly onDispatch?: () => void;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export class PluginSystemCloudTransportError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    /** archon_biz `base_resp` rejection detail, present only for `BUSINESS_ERROR`. */
    readonly business?: { readonly statusCode: number; readonly statusMessage?: string },
  ) {
    super(message);
    this.name = 'PluginSystemCloudTransportError';
  }
}

/** Signed archon_biz transport owned by the Desktop utility runtime. */
export class PluginSystemCloudTransport {
  private readonly nowMs: () => number;
  private readonly timeoutMs: number;
  private readonly downloadTimeoutMs: number;

  constructor(private readonly options: PluginSystemCloudTransportOptions) {
    const baseUrl = options.baseUrl.trim();
    if (!/^https?:\/\//u.test(baseUrl)) {
      throw new PluginSystemCloudTransportError(
        'BASE_URL_INVALID',
        'Plugin System Cloud base URL is invalid',
      );
    }
    this.nowMs = options.nowMs ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.downloadTimeoutMs = options.downloadTimeoutMs ?? DEFAULT_DOWNLOAD_TIMEOUT_MS;
  }

  private currentLane(): string | undefined {
    return this.options.laneGetter ? this.options.laneGetter() : this.options.lane;
  }

  private appVersionOf(): string | undefined {
    return this.options.appVersion;
  }

  async request(request: PluginSystemCloudRequest): Promise<unknown> {
    const rawAuthContext = resolveAuthContext(request, this.options.authContextGetter);
    const loginEpoch = rawAuthContext?.loginEpoch;
    const auth = readAuth(rawAuthContext, request.auth);
    const dispatchOnce = async (
      currentAuth: ReturnType<typeof readAuth>,
      notifyDispatch: boolean,
    ) => {
      const now = this.nowMs();
      const route = buildRoute(request.path, request.query);
      const publicParams = buildPublicParams({
        now,
        appVersion: this.appVersionOf(),
        userId: currentAuth?.realUserID,
      });
      const signedPath = appendQuery(route, publicParams);
      const body =
        request.method === 'POST'
          ? {
              ...(request.body ?? {}),
              ...(currentAuth ? { common_param: { user_id: currentAuth.realUserID } } : {}),
            }
          : undefined;
      const bodyText = body ? JSON.stringify(body) : '';
      const signal = composeSignal(request.signal, request.timeoutMs ?? this.timeoutMs);
      const responsePromise = this.options.fetchImpl(joinUrl(this.options.baseUrl, signedPath), {
        method: request.method,
        headers: buildHeaders({
          auth: currentAuth,
          body,
          bodyText,
          now,
          signedPath,
          previewSecret: this.options.previewSecret,
          lane: this.currentLane(),
        }),
        ...(bodyText ? { body: bodyText } : {}),
        signal,
      });
      if (notifyDispatch) request.onDispatch?.();
      return responsePromise;
    };
    let response: Response;
    try {
      response = await dispatchOnce(auth, true);
      if (response.status === 401) {
        const refreshedAuth = await this.refreshAuth(request, auth, loginEpoch);
        if (refreshedAuth) response = await dispatchOnce(refreshedAuth, false);
      }
    } catch (error) {
      throw transportFailure(error);
    }
    if (!response.ok) {
      throw new PluginSystemCloudTransportError(
        'HTTP_ERROR',
        `Plugin Cloud request failed with HTTP ${response.status}`,
        response.status,
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new PluginSystemCloudTransportError(
        'RESPONSE_INVALID',
        'Plugin System Cloud response is not JSON',
      );
    }
    assertBusinessSuccess(payload);
    return payload;
  }

  private async refreshAuth(
    request: PluginSystemCloudRequest,
    previousAuth: ReturnType<typeof readAuth>,
    loginEpoch: string | undefined,
  ): Promise<ReturnType<typeof readAuth>> {
    if (
      request.authContext !== undefined ||
      !previousAuth?.accessToken ||
      !this.options.authContextInvalidator ||
      this.options.authContextGetter()?.loginEpoch !== loginEpoch
    ) {
      return undefined;
    }

    await this.options.authContextInvalidator(previousAuth.accessToken, loginEpoch);
    const currentContext = this.options.authContextGetter();
    if (currentContext?.loginEpoch !== loginEpoch) return undefined;
    const currentAuth = readAuth(currentContext, request.auth);
    return currentAuth?.accessToken === previousAuth.accessToken ? undefined : currentAuth;
  }

  /**
   * Streams a download into a new file. `maxBytes` bounds it and defaults to the package contract
   * archive limit; a caller whose archives may be larger passes its own bound.
   */
  async downloadToFile(
    url: string,
    targetPath: string,
    signal?: AbortSignal,
    maxBytes: number = PLUGIN_PACKAGE_V1_LIMITS.maxArchiveBytes,
  ): Promise<void> {
    const parsed = parseDownloadUrl(url);
    const deadline = new DownloadDeadline(this.downloadTimeoutMs, signal);
    try {
      let response: Response;
      try {
        response = await this.options.fetchImpl(parsed, { method: 'GET', signal: deadline.signal });
      } catch (error) {
        throw transportFailure(error);
      }
      if (!response.ok || !response.body) {
        throw new PluginSystemCloudTransportError(
          'DOWNLOAD_HTTP_ERROR',
          `Plugin package download failed with HTTP ${response.status}`,
          response.status,
        );
      }
      const announced = Number(response.headers.get('content-length'));
      deadline.allowFor(Number.isFinite(announced) && announced > 0 ? announced : maxBytes);
      await writeBoundedBody(response, targetPath, maxBytes);
    } finally {
      deadline.clear();
    }
  }
}

function resolveAuthContext(
  request: PluginSystemCloudRequest,
  getter: () => PluginSystemCloudAuthContext | undefined,
): PluginSystemCloudAuthContext | undefined {
  return request.authContext === undefined ? getter() : request.authContext;
}

function buildPublicParams(input: {
  now: number;
  appVersion?: string;
  userId?: string;
}): Record<string, string | number> {
  const region = getRuntimeRegion();
  return {
    device_platform: 'web',
    biz_id: 3,
    app_id: '3001',
    version_code: '22201',
    unix: input.now,
    timezone_offset: new Date(input.now).getTimezoneOffset() * -60,
    sys_language: region === 'en' ? 'en' : 'zh',
    lang: region === 'en' ? 'en' : 'zh',
    device_id: 0,
    ...(input.userId ? { user_id: input.userId } : {}),
    client: 'desktop',
    region,
    is_desktop: 1,
    ...(input.appVersion ? { desktop_version: input.appVersion } : {}),
  };
}

function buildHeaders(input: {
  auth: Required<Pick<PluginSystemCloudAuthContext, 'accessToken' | 'realUserID'>> | undefined;
  body: Record<string, unknown> | undefined;
  bodyText: string;
  now: number;
  signedPath: string;
  previewSecret?: string;
  lane?: string;
}): Record<string, string> {
  const second = Math.floor(input.now / 1000);
  const yyBody = input.body ? JSON.stringify(input.body) : '{}';
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    yy: md5(
      `${encodeURIComponent(input.signedPath)}_${yyBody}${md5(String(input.now))}${YY_SUFFIX}`,
    ),
    'x-timestamp': String(second),
    'x-signature': md5(`${second}${SIGNATURE_SALT}${input.bodyText}`),
  };
  if (input.auth) headers.Authorization = `Bearer ${input.auth.accessToken}`;
  if (input.previewSecret?.trim()) {
    headers['X-Minimax-Agent-Preview-Secret'] = input.previewSecret.trim();
  }
  if (input.lane?.trim()) {
    headers.lane = input.lane.trim();
    headers.bedrock_lane = input.lane.trim();
    headers['bedrock-lane'] = input.lane.trim();
  }
  return headers;
}

function readAuth(
  context: PluginSystemCloudAuthContext | undefined,
  mode: PluginSystemCloudRequest['auth'],
): Required<Pick<PluginSystemCloudAuthContext, 'accessToken' | 'realUserID'>> | undefined {
  if (mode === 'none') return undefined;
  const accessToken = context?.accessToken?.trim();
  const realUserID = context?.realUserID?.trim();
  if (accessToken && realUserID) return { accessToken, realUserID };
  if (mode === 'required') {
    throw new PluginSystemCloudTransportError(
      'AUTH_REQUIRED',
      'Plugin System Cloud request requires login',
    );
  }
  return undefined;
}

function buildRoute(path: string, query: PluginSystemCloudRequest['query']): string {
  if (!path.startsWith('/') || path.includes('://')) {
    throw new PluginSystemCloudTransportError(
      'PATH_INVALID',
      'Plugin System Cloud request path is invalid',
    );
  }
  return appendQuery(path, query ?? {});
}

function appendQuery(
  value: string,
  query: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  const [pathname, existing = ''] = value.split('?', 2);
  const params = new URLSearchParams(existing);
  for (const [key, item] of Object.entries(query)) {
    if (item !== undefined) params.set(key, String(item));
  }
  const suffix = params.toString();
  return suffix ? `${pathname}?${suffix}` : (pathname ?? value);
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, '')}${path}`;
}

function parseDownloadUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new PluginSystemCloudTransportError(
      'DOWNLOAD_URL_INVALID',
      'Plugin download URL is invalid',
    );
  }
  if (
    parsed.protocol !== 'https:' &&
    parsed.hostname !== '127.0.0.1' &&
    parsed.hostname !== 'localhost'
  ) {
    throw new PluginSystemCloudTransportError(
      'DOWNLOAD_URL_INVALID',
      'Plugin download URL must use HTTPS',
    );
  }
  return parsed.toString();
}

/**
 * How long one download may take. It starts as the transport's download timeout, which is the
 * budget for an archive within the package contract limit. Once the response tells that more
 * bytes are coming (its announced size, or the caller's bound when it announces none), the budget
 * grows in proportion: a larger archive is held to the same minimum transfer rate, not to the
 * same time. A download within the contract limit keeps exactly the timeout it always had.
 */
class DownloadDeadline {
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly startedAtMs = Date.now();
  private timer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly timeoutMs: number,
    signal: AbortSignal | undefined,
  ) {
    this.timer = this.arm(timeoutMs);
    this.signal = signal
      ? AbortSignal.any([signal, this.controller.signal])
      : this.controller.signal;
  }

  allowFor(expectedBytes: number): void {
    const scale = expectedBytes / PLUGIN_PACKAGE_V1_LIMITS.maxArchiveBytes;
    if (!(scale > 1)) return;
    clearTimeout(this.timer);
    this.timer = this.arm(Math.ceil(this.timeoutMs * scale) - (Date.now() - this.startedAtMs));
  }

  clear(): void {
    clearTimeout(this.timer);
  }

  private arm(delayMs: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(
      () => this.controller.abort(new DOMException('The download timed out', 'TimeoutError')),
      Math.max(0, delayMs),
    );
    timer.unref?.();
    return timer;
  }
}

function composeSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function assertBusinessSuccess(payload: unknown): void {
  if (!isRecord(payload)) {
    throw new PluginSystemCloudTransportError(
      'RESPONSE_INVALID',
      'Plugin System Cloud response is invalid',
    );
  }
  const base = readRecord(payload, 'base_resp', 'baseResp');
  if (!base) return;
  const status = readNumber(base, 'status_code', 'statusCode');
  if (status !== undefined && status !== 0) {
    const statusMessage = base.status_message ?? base.statusMessage;
    throw new PluginSystemCloudTransportError(
      'BUSINESS_ERROR',
      'Plugin System Cloud request was rejected',
      undefined,
      {
        statusCode: status,
        ...(typeof statusMessage === 'string' ? { statusMessage } : {}),
      },
    );
  }
}

async function writeBoundedBody(
  response: Response,
  targetPath: string,
  maxBytes: number,
): Promise<void> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new PluginSystemCloudTransportError(
      'DOWNLOAD_TOO_LARGE',
      'Plugin package exceeds the byte limit',
    );
  }
  const reader = response.body?.getReader();
  if (!reader)
    throw new PluginSystemCloudTransportError('DOWNLOAD_EMPTY', 'Plugin package body is empty');
  const handle = await open(targetPath, 'wx', 0o600);
  let total = 0;
  let done = false;
  try {
    while (!done) {
      const result = await reader.read();
      if (result.done) {
        done = true;
        continue;
      }
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new PluginSystemCloudTransportError(
          'DOWNLOAD_TOO_LARGE',
          'Plugin package exceeds the byte limit',
        );
      }
      await writeFileChunkFully(
        handle,
        result.value,
        () =>
          new PluginSystemCloudTransportError(
            'DOWNLOAD_WRITE_FAILED',
            'Plugin package download could not be written completely',
          ),
      );
    }
  } finally {
    await handle.close();
  }
}

function transportFailure(error: unknown): PluginSystemCloudTransportError {
  if (error instanceof PluginSystemCloudTransportError) return error;
  const aborted = error instanceof Error && error.name === 'AbortError';
  const timedOut = error instanceof Error && error.name === 'TimeoutError';
  if (aborted) {
    return new PluginSystemCloudTransportError(
      'REQUEST_ABORTED',
      'Plugin System Cloud request was aborted',
    );
  }
  if (timedOut) {
    return new PluginSystemCloudTransportError(
      'REQUEST_TIMEOUT',
      'Plugin System Cloud request timed out',
    );
  }
  return new PluginSystemCloudTransportError('NETWORK_ERROR', 'Plugin System Cloud request failed');
}

const MD5_SHIFTS = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
  14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_TABLE = Array.from({ length: 64 }, (_, i) =>
  Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000),
);

function md5(value: string): string {
  const input = Buffer.from(value, 'utf8');
  const bitLen = input.length * 8;
  const padLen = ((56 - ((input.length + 1) % 64) + 64) % 64) + 1;
  const buf = Buffer.alloc(input.length + padLen + 8);
  input.copy(buf, 0);
  buf[input.length] = 0x80;
  buf.writeUInt32LE(bitLen >>> 0, buf.length - 8);
  buf.writeUInt32LE(Math.floor(bitLen / 0x100000000) >>> 0, buf.length - 4);
  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const words = new Uint32Array(16);
  for (let offset = 0; offset < buf.length; offset += 64) {
    for (let j = 0; j < 16; j += 1) words[j] = buf.readUInt32LE(offset + j * 4);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f = 0;
      let g = 0;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const sum = (a + f + MD5_TABLE[i]! + words[g]!) | 0;
      const shift = MD5_SHIFTS[i]!;
      const rotated = (sum << shift) | (sum >>> (32 - shift));
      a = d;
      d = c;
      c = b;
      b = (b + rotated) | 0;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  const digest = Buffer.alloc(16);
  digest.writeInt32LE(a0, 0);
  digest.writeInt32LE(b0, 4);
  digest.writeInt32LE(c0, 8);
  digest.writeInt32LE(d0, 12);
  return digest.toString('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRecord(
  value: Record<string, unknown>,
  snake: string,
  camel: string,
): Record<string, unknown> | undefined {
  const field = value[snake] ?? value[camel];
  return isRecord(field) ? field : undefined;
}

function readNumber(
  value: Record<string, unknown>,
  snake: string,
  camel: string,
): number | undefined {
  const field = value[snake] ?? value[camel];
  return typeof field === 'number' ? field : undefined;
}
