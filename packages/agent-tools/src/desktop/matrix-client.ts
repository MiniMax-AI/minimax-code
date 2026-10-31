import { Agent, fetch as undiciFetch, type Dispatcher } from 'undici';
import type { MatrixExecutor } from '../cloud/matrix-tools/index.js';
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
  /** Owner-side login generation; a change means the access token was refreshed. */
  readonly loginEpoch?: string;
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
   * Live host auth read on every request. The host swaps in a new object each
   * time it refreshes the access token, so a long Turn must not keep the
   * snapshot taken when it started.
   */
  authContextGetter?: () => DesktopMatrixAuthContext | null | undefined;
  endpoint?: DesktopMatrixEndpoint;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  dispatcherFactory?: MatrixFetchDispatcherFactory;
  /** Optional system routing headers for managed gateway POSTs only. */
  routingHeadersGetter?: () => Record<string, string>;
}

export type DesktopMatrixExecutor = MatrixExecutor;

export class DesktopGatewayHttpError extends Error {
  constructor(
    readonly pathname: string,
    readonly statusCode: number,
    readonly errorCode?: string,
    responsePreview = '',
  ) {
    // Preserve the pre-existing error text for every non-WebSearch caller.
    super(`Matrix backend ${pathname} HTTP ${statusCode}: ${responsePreview}`);
    this.name = 'DesktopGatewayHttpError';
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
    // Keep fetch and dispatcher on the same Undici implementation. Node 26's
    // built-in fetch uses Undici 8, whose dispatcher handler contract is not
    // compatible with the Undici 6 Agent used for long Matrix requests.
    this.fetchImpl = options.fetchImpl ?? (undiciFetch as unknown as typeof fetch);
    this.dispatcherFactory =
      options.dispatcherFactory ??
      ((timeouts) =>
        new Agent({ headersTimeout: timeouts.headersTimeout, bodyTimeout: timeouts.bodyTimeout }));
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
    const requestTimeoutMs = timeoutMs ?? this.timeoutMs;
    const scoped = createScopedAbortSignal(signal, requestTimeoutMs);
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: {
          ...this.buildHeaders({ 'Content-Type': 'application/json' }),
          ...(this.managedEndpoint ? (this.routingHeadersGetter?.() ?? {}) : {}),
        },
        body: JSON.stringify(body),
        signal: scoped.signal,
      };
      const dispatcher = buildLongRequestDispatcher(requestTimeoutMs, this.dispatcherFactory);
      if (dispatcher !== undefined) {
        setFetchDispatcher(init, dispatcher);
      }

      const res = await this.fetchImpl(`${this.baseUrl}${pathname}`, init);
      const text = await res.text();
      if (!res.ok) {
        throw new DesktopGatewayHttpError(
          pathname,
          res.status,
          readGatewayErrorCode(text),
          text.slice(0, 500),
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
      throw new Error(
        this.useManagedAuth
          ? 'Matrix tools require a managed-login access token.'
          : 'Matrix tools require MATRIX_TOKEN for non-managed MATRIX_BASE_URL.',
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
    const authContext = this.authContextGetter ? this.authContextGetter() : this.authContext;
    return authContext?.accessToken?.trim() || undefined;
  }
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
