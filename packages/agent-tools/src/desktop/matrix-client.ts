import { getGlobalDispatcher, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { MatrixExecutor } from '../cloud/matrix-tools/index.js';
import {
  MatrixAuthRequiredError,
  type MatrixAuthRequiredReason,
  type MatrixGatewayBackend,
} from '../cloud/matrix-tools/types.js';
import {
  getDesktopMatrixEndpoint,
  isManagedMatrixBaseUrl,
  normalizeMatrixBaseUrl,
  type DesktopMatrixEndpoint,
} from './matrix-env.js';

const MATRIX_USER_AGENT = 'MiniMaxAgent';
const DEFAULT_TIMEOUT_MS = 120_000;
const UNDICI_DEFAULT_TIMEOUT_MS = 300_000;
const LONG_REQUEST_THRESHOLD_MS = UNDICI_DEFAULT_TIMEOUT_MS - 20_000;
const LONG_REQUEST_TIMEOUT_BUFFER_MS = 15_000;
const MATRIX_PROXY_PREFIX = '/matrix/api/v1/mcp/';
const LOCAL_GATEWAY_PREFIX = '/mavis/api/v1/mcp/';

export interface DesktopMatrixAuthContext {
  readonly accessToken?: string;
}

interface MatrixFetchDispatcherOptions {
  readonly headersTimeout: number;
  readonly bodyTimeout: number;
}

type MatrixFetchDispatcherFactory = (options: MatrixFetchDispatcherOptions) => Dispatcher;

export interface DesktopMatrixClientOptions {
  baseUrl?: string;
  accessToken?: string;
  /** Static managed-login snapshot; ignored when `authContextGetter` is provided. */
  authContext?: DesktopMatrixAuthContext;
  /**
   * Live managed-login source, read on every gateway request and preferred over
   * `authContext`. The host refreshes access tokens by swapping in a new auth
   * object, so a client that outlives one token (for example a website deploy
   * created at Turn start) must read the current one instead of a snapshot.
   */
  authContextGetter?: () => DesktopMatrixAuthContext | null | undefined;
  endpoint?: DesktopMatrixEndpoint;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  dispatcherFactory?: MatrixFetchDispatcherFactory;
  /**
   * Optional system routing headers for the managed gateway. postGatewayJson sends them on POSTs;
   * requestGatewayJson sends them for every method.
   */
  routingHeadersGetter?: () => Record<string, string>;
}

export type DesktopGatewayQuery = Record<string, string | number | boolean | undefined>;

export interface DesktopGatewayRequest {
  method: 'GET' | 'POST' | 'DELETE';
  /** Route path without query string. */
  pathname: string;
  /** Query parameters; undefined values are omitted. */
  query?: DesktopGatewayQuery;
  /** JSON body, sent only when present. */
  body?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type DesktopMatrixExecutor = MatrixExecutor;

export class DesktopGatewayHttpError extends Error {
  constructor(
    readonly pathname: string,
    readonly statusCode: number,
    readonly errorCode?: string,
    /** First 500 characters of the response body. */
    readonly responsePreview = '',
    /** Whose credential the request carried, so a 401 names the right one. */
    readonly backend?: MatrixGatewayBackend,
  ) {
    // Preserve the pre-existing error text for every non-WebSearch caller.
    super(`Matrix backend ${pathname} HTTP ${statusCode}: ${responsePreview}`);
    this.name = 'DesktopGatewayHttpError';
  }
}

/**
 * No access token is available for the gateway (signed out, or MATRIX_TOKEN missing). Still a
 * MatrixAuthRequiredError, so generic Matrix callers keep their auth-required handling.
 */
export class DesktopMatrixAuthError extends MatrixAuthRequiredError {
  constructor(message: string, reason: MatrixAuthRequiredReason = 'managed_login') {
    // Keeps the MatrixAuthRequiredError name so separately bundled readers still match it.
    super(reason, message);
  }
}

export class DesktopMatrixClient implements MatrixExecutor {
  private readonly baseUrl: string;
  private readonly explicitAccessToken: string | undefined;
  private readonly managedEndpoint: boolean;
  /** True when requests carry the managed-login token rather than an explicit one. */
  protected readonly useManagedAuth: boolean;
  private readonly authContext: DesktopMatrixAuthContext | undefined;
  private readonly authContextGetter:
    | (() => DesktopMatrixAuthContext | null | undefined)
    | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly dispatcherFactory: MatrixFetchDispatcherFactory;
  private readonly routingHeadersGetter: (() => Record<string, string>) | undefined;

  constructor(options: DesktopMatrixClientOptions = {}) {
    const endpoint = resolveEndpoint(options);
    const explicitAccessToken = options.accessToken?.trim() || endpoint.explicitToken;
    this.baseUrl = endpoint.baseUrl;
    this.explicitAccessToken = explicitAccessToken;
    this.managedEndpoint = endpoint.managed;
    this.useManagedAuth = endpoint.managed && !explicitAccessToken;
    this.authContext = options.authContext;
    this.authContextGetter = options.authContextGetter;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Keep Matrix on this package's fetch when Node bundles a different Undici version.
    this.fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
    this.dispatcherFactory =
      options.dispatcherFactory ??
      ((timeouts) =>
        getGlobalDispatcher().compose(
          (dispatch) => (dispatchOptions, handler) =>
            dispatch({ ...dispatchOptions, ...timeouts }, handler),
        ));
    this.routingHeadersGetter = options.routingHeadersGetter;
  }

  async postJson(
    pathname: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    options?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    const response = await this.postGatewayJson(
      toLocalGatewayPath(pathname),
      body,
      signal,
      options?.timeoutMs,
    );
    return normalizeMatrixToolResponse(response);
  }

  async postGatewayJson(
    pathname: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    return this.requestGatewayJson({ method: 'POST', pathname, body, signal, timeoutMs });
  }

  /** Reads a JSON document from the same backend, e.g. an archon_biz config endpoint. */
  async getGatewayJson(
    pathname: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    return this.requestGatewayJson({ method: 'GET', pathname, signal, timeoutMs });
  }

  /**
   * One JSON request to the gateway with any method. A non-2xx answer throws
   * DesktopGatewayHttpError and `base_resp` is left to the caller.
   */
  async requestGatewayJson(request: DesktopGatewayRequest): Promise<Record<string, unknown>> {
    const { method, pathname, query, body, signal, timeoutMs } = request;
    const requestTimeoutMs = timeoutMs ?? this.timeoutMs;
    const scoped = createScopedAbortSignal(signal, requestTimeoutMs);
    try {
      const init: RequestInit = {
        method,
        headers: {
          ...this.buildHeaders(body ? { 'Content-Type': 'application/json' } : {}),
          ...(this.managedEndpoint ? (this.routingHeadersGetter?.() ?? {}) : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: scoped.signal,
      };
      const dispatcher = buildLongRequestDispatcher(requestTimeoutMs, this.dispatcherFactory);
      if (dispatcher !== undefined) {
        setFetchDispatcher(init, dispatcher);
      }

      const res = await this.fetchImpl(
        `${this.baseUrl}${pathname}${buildQueryString(query)}`,
        init,
      );
      const text = await res.text();
      if (!res.ok) {
        throw new DesktopGatewayHttpError(
          pathname,
          res.status,
          readGatewayErrorCode(text),
          text.slice(0, 500),
          this.managedEndpoint ? 'managed' : 'custom',
        );
      }
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } finally {
      scoped.dispose();
    }
  }

  async putBytes(
    url: string,
    body: RequestInit['body'],
    headers: Record<string, string>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<void> {
    const scoped = createScopedAbortSignal(signal, timeoutMs ?? this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'PUT',
        body,
        headers,
        signal: scoped.signal,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Matrix upload PUT HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
    } finally {
      scoped.dispose();
    }
  }

  async getStream(
    url: string,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<{ body: ReadableStream<Uint8Array>; contentLength?: number; dispose(): void }> {
    const scoped = createScopedAbortSignal(signal, timeoutMs ?? this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        signal: scoped.signal,
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        throw new Error(`Matrix download HTTP ${res.status}: ${text.slice(0, 500)}`);
      }
      const contentLengthRaw = res.headers.get('content-length');
      const contentLength = contentLengthRaw ? Number.parseInt(contentLengthRaw, 10) : undefined;
      return {
        body: res.body as ReadableStream<Uint8Array>,
        dispose: scoped.dispose,
        ...(Number.isFinite(contentLength) && contentLength !== undefined ? { contentLength } : {}),
      };
    } catch (err) {
      scoped.dispose();
      throw err;
    }
  }

  buildHeaders(extraHeaders: Record<string, string> = {}): Record<string, string> {
    const token = this.explicitAccessToken ?? this.getManagedAccessToken();
    if (!token) {
      throw this.useManagedAuth
        ? new DesktopMatrixAuthError('Matrix tools require a managed-login access token.')
        : new DesktopMatrixAuthError(
            'Matrix tools require MATRIX_TOKEN for non-managed MATRIX_BASE_URL.',
            'matrix_token',
          );
    }
    return {
      'User-Agent': MATRIX_USER_AGENT,
      Authorization: `Bearer ${token}`,
      ...extraHeaders,
    };
  }

  private getManagedAccessToken(): string | undefined {
    if (!this.useManagedAuth) return undefined;
    // With a live getter, never fall back to the static snapshot: its token may
    // already be replaced, or belong to a login the host has since signed out.
    const authContext = this.authContextGetter ? this.authContextGetter() : this.authContext;
    return authContext?.accessToken?.trim() || undefined;
  }
}

function buildQueryString(query: DesktopGatewayQuery | undefined): string {
  if (!query) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const serialized = search.toString();
  return serialized ? `?${serialized}` : '';
}

function readGatewayErrorCode(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const parsed = JSON.parse(text) as { error_code?: unknown };
    return typeof parsed.error_code === 'string' ? parsed.error_code : undefined;
  } catch {
    return undefined;
  }
}

export function toLocalGatewayPath(pathname: string): string {
  if (pathname.startsWith(MATRIX_PROXY_PREFIX)) {
    return `${LOCAL_GATEWAY_PREFIX}${pathname.slice(MATRIX_PROXY_PREFIX.length)}`;
  }
  if (pathname.startsWith(LOCAL_GATEWAY_PREFIX)) return pathname;
  throw new Error(`Unsupported Matrix tool path: ${pathname}`);
}

function resolveEndpoint(options: DesktopMatrixClientOptions): DesktopMatrixEndpoint {
  if (options.baseUrl) {
    return {
      baseUrl: normalizeMatrixBaseUrl(options.baseUrl),
      managed: isManagedMatrixBaseUrl(options.baseUrl),
    };
  }
  return options.endpoint ?? getDesktopMatrixEndpoint();
}

function normalizeMatrixToolResponse(response: Record<string, unknown>): Record<string, unknown> {
  if (response.base_resp !== undefined) return response;
  const code = response.code;
  if (typeof code !== 'number') return response;
  const { code: _code, message, ...payload } = response;
  return {
    base_resp: {
      status_code: code,
      ...(typeof message === 'string' ? { status_msg: message } : {}),
    },
    ...payload,
  };
}

function createScopedAbortSignal(
  upstream: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (upstream?.aborted) abort();
  upstream?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      upstream?.removeEventListener('abort', abort);
    },
  };
}

function buildLongRequestDispatcher(
  timeoutMs: number,
  dispatcherFactory: MatrixFetchDispatcherFactory,
): Dispatcher | undefined {
  if (!Number.isFinite(timeoutMs) || timeoutMs < LONG_REQUEST_THRESHOLD_MS) return undefined;
  const relaxedTimeoutMs = timeoutMs + LONG_REQUEST_TIMEOUT_BUFFER_MS;
  return dispatcherFactory({
    headersTimeout: relaxedTimeoutMs,
    bodyTimeout: relaxedTimeoutMs,
  });
}

function setFetchDispatcher(init: RequestInit, dispatcher: Dispatcher): void {
  Object.assign(init, { dispatcher });
}
