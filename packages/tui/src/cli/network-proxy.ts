import * as undici from 'undici';
import { Agent, buildConnector, Dispatcher, ProxyAgent, Socks5ProxyAgent } from 'undici';

const LOOPBACK_NO_PROXY_ENTRIES = ['localhost', '127.0.0.1', '::1'] as const;
const HTTP_PROXY_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);
// undici's Socks5ProxyAgent accepts `socks5:` and its alias `socks:`. It always sends
// host names to the proxy for resolution, which is what `socks5h:` requests, so that
// scheme is accepted too and rewritten before the agent is constructed.
const SOCKS5_PROXY_PROTOCOLS: ReadonlySet<string> = new Set(['socks5:', 'socks5h:', 'socks:']);
const SUPPORTED_PROXY_SCHEMES = 'http://, https://, socks5://, or socks5h://';
const SOCKS5_EXPERIMENTAL_WARNING_MESSAGE =
  'SOCKS5 proxy support is experimental and subject to change';
const SOCKS5_EXPERIMENTAL_WARNING_TYPE = 'ExperimentalWarning';
// Matches undici's default SOCKS5 connect timeout, which a custom connector replaces.
const SOCKS5_PROXY_CONNECT_TIMEOUT_MS = 5_000;
const IGNORED_ALL_PROXY_ADVICE =
  "Set HTTPS_PROXY and HTTP_PROXY to your proxy app's http:// port, or set ALL_PROXY to a socks5:// or socks5h:// URL.";

interface ProxyValue {
  readonly name: string;
  readonly value: string;
}

type ProxyValueClassification =
  | { readonly kind: 'http' | 'socks5' }
  | {
      readonly kind: 'unsupported';
      readonly reason: 'invalid-url' | 'protocol' | 'credentials';
      readonly protocol?: string;
      readonly redacted?: string;
    };

interface ProxyCredentials {
  readonly username: string;
  readonly password: string;
}

export type TuiProxyConfiguration =
  | { readonly mode: 'direct' }
  | {
      readonly mode: 'proxy';
      readonly httpProxy: string;
      readonly httpsProxy: string;
      readonly noProxy: string;
    };

export interface ResolveTuiProxyConfigurationOptions {
  /** Receives one line per ignored proxy setting. Omit to discard warnings. */
  readonly writeWarning?: (message: string) => void;
}

export interface ConfigureTuiNetworkProxyOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly createProxyDispatcher?: (options: {
    httpProxy: string;
    httpsProxy: string;
    noProxy: string;
  }) => Dispatcher;
  readonly setGlobalDispatcher?: (dispatcher: Dispatcher) => void;
  readonly installFetch?: () => void;
  /** Defaults to writing a line to process.stderr. */
  readonly writeWarning?: (message: string) => void;
}

interface EmitWarningTarget {
  emitWarning: typeof process.emitWarning;
}

export function resolveTuiProxyConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
  options: ResolveTuiProxyConfigurationOptions = {},
): TuiProxyConfiguration {
  const allProxy = usableAllProxyValue(
    firstProxyValue(environment, 'ALL_PROXY', 'all_proxy'),
    options.writeWarning,
  );
  const httpProxy = firstProxyValue(environment, 'HTTP_PROXY', 'http_proxy') ?? allProxy;
  const httpsProxy =
    firstProxyValue(environment, 'HTTPS_PROXY', 'https_proxy') ?? allProxy ?? httpProxy;

  if (!httpProxy && !httpsProxy) return { mode: 'direct' };
  validateProxyValue(httpProxy);
  validateProxyValue(httpsProxy);

  return {
    mode: 'proxy',
    httpProxy: httpProxy?.value ?? '',
    httpsProxy: httpsProxy?.value ?? '',
    noProxy: withLoopbackNoProxy(firstProxyValue(environment, 'NO_PROXY', 'no_proxy')?.value),
  };
}

export function configureTuiNetworkProxy(
  options: ConfigureTuiNetworkProxyOptions = {},
): TuiProxyConfiguration {
  const configuration = resolveTuiProxyConfiguration(options.environment, {
    writeWarning: options.writeWarning ?? writeStderrWarning,
  });
  if (configuration.mode === 'direct') return configuration;

  const createProxyDispatcher =
    options.createProxyDispatcher ?? ((proxyOptions) => new TuiProxyDispatcher(proxyOptions));
  const dispatcher = createProxyDispatcher({
    httpProxy: configuration.httpProxy,
    httpsProxy: configuration.httpsProxy,
    noProxy: configuration.noProxy,
  });
  (options.setGlobalDispatcher ?? undici.setGlobalDispatcher)(dispatcher);
  (options.installFetch ?? installUndiciFetch)();
  return configuration;
}

export function createTuiNetworkDispatcher(
  environment: NodeJS.ProcessEnv = process.env,
): Dispatcher {
  // Ignored ALL_PROXY values were already reported once at CLI startup by
  // configureTuiNetworkProxy; repeating the warning here would interleave with the TUI.
  const configuration = resolveTuiProxyConfiguration(environment);
  return configuration.mode === 'proxy'
    ? new TuiProxyDispatcher(configuration)
    : new Agent({ allowH2: false });
}

/**
 * Masks the user name and password of a proxy URL so it can appear in
 * diagnostics. Returns undefined when the value is not a parseable URL with a host,
 * because an unparseable value cannot be redacted reliably.
 */
export function redactProxyUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (!url.host) return undefined;
  const credentials = url.username || url.password ? `${url.password ? '***:***' : '***'}@` : '';
  return `${url.protocol}//${credentials}${url.host}`;
}

/**
 * Runs `create` while dropping only undici's one-time SOCKS5 experimental
 * warning. Every other warning, including other ExperimentalWarnings, is
 * forwarded unchanged, and the original emitter is restored afterwards.
 */
export function withoutSocks5ExperimentalWarning<T>(
  create: () => T,
  target: EmitWarningTarget = process,
): T {
  const original = target.emitWarning;
  const filtered = function emitWarning(this: unknown, ...args: unknown[]): void {
    if (isSocks5ExperimentalWarning(args)) return;
    Reflect.apply(original, this, args);
  };
  target.emitWarning = filtered as typeof process.emitWarning;
  try {
    return create();
  } finally {
    target.emitWarning = original;
  }
}

function isSocks5ExperimentalWarning(args: readonly unknown[]): boolean {
  const [warning, typeOrOptions] = args;
  const message =
    typeof warning === 'string' ? warning : warning instanceof Error ? warning.message : undefined;
  if (message !== SOCKS5_EXPERIMENTAL_WARNING_MESSAGE) return false;
  const type =
    typeof typeOrOptions === 'string'
      ? typeOrOptions
      : typeof typeOrOptions === 'object' && typeOrOptions !== null
        ? (typeOrOptions as { type?: unknown }).type
        : warning instanceof Error
          ? warning.name
          : undefined;
  return type === SOCKS5_EXPERIMENTAL_WARNING_TYPE;
}

function writeStderrWarning(message: string): void {
  process.stderr.write(`${message}\n`);
}

function firstProxyValue(
  environment: NodeJS.ProcessEnv,
  ...names: readonly string[]
): ProxyValue | undefined {
  for (const name of names) {
    const value = environment[name]?.trim();
    if (value) return { name, value };
  }
  return undefined;
}

function classifyProxyValue(value: string): ProxyValueClassification {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { kind: 'unsupported', reason: 'invalid-url' };
  }
  // Values such as `localhost:7890` parse with `localhost:` as the scheme.
  if (!url.hostname) return { kind: 'unsupported', reason: 'invalid-url' };
  const kind = HTTP_PROXY_PROTOCOLS.has(url.protocol)
    ? 'http'
    : SOCKS5_PROXY_PROTOCOLS.has(url.protocol)
      ? 'socks5'
      : undefined;
  if (!kind) {
    return {
      kind: 'unsupported',
      reason: 'protocol',
      protocol: url.protocol,
      redacted: redactProxyUrl(value),
    };
  }
  // Both undici proxy agents percent-decode URL credentials while being
  // constructed; a stray `%` would otherwise throw URIError at startup.
  if (!decodeProxyCredentials(url)) {
    return { kind: 'unsupported', reason: 'credentials', redacted: redactProxyUrl(value) };
  }
  return { kind };
}

function decodeProxyCredentials(url: URL): ProxyCredentials | undefined {
  try {
    return {
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  } catch {
    return undefined;
  }
}

/**
 * ALL_PROXY is only a fallback, and SOCKS tools commonly export it next to an
 * explicit HTTP(S)_PROXY. A value this client cannot use must not prevent
 * startup, so it is reported and skipped instead of rejected.
 */
function usableAllProxyValue(
  proxy: ProxyValue | undefined,
  writeWarning: ((message: string) => void) | undefined,
): ProxyValue | undefined {
  if (!proxy) return undefined;
  const classification = classifyProxyValue(proxy.value);
  if (classification.kind !== 'unsupported') return proxy;
  writeWarning?.(
    `Warning: ignoring ${describeProxySetting(proxy.name, classification)} because ${describeUnsupportedReason(classification)}; it will not be used. ${IGNORED_ALL_PROXY_ADVICE}`,
  );
  return undefined;
}

function validateProxyValue(proxy: ProxyValue | undefined): void {
  if (!proxy) return;
  const classification = classifyProxyValue(proxy.value);
  if (classification.kind !== 'unsupported') return;
  if (classification.reason === 'credentials') {
    throw new Error(
      `${describeProxySetting(proxy.name, classification)} has a user name or password that is not valid percent-encoding. Encode reserved characters, for example % as %25.`,
    );
  }
  throw new Error(`${proxy.name} must be an ${SUPPORTED_PROXY_SCHEMES} URL.`);
}

function describeProxySetting(
  name: string,
  classification: { readonly redacted?: string },
): string {
  return classification.redacted ? `${name}=${classification.redacted}` : name;
}

function describeUnsupportedReason(classification: {
  readonly reason: 'invalid-url' | 'protocol' | 'credentials';
  readonly protocol?: string;
}): string {
  if (classification.reason === 'credentials') {
    return 'its user name or password is not valid percent-encoding (encode % as %25)';
  }
  if (!classification.protocol) return 'it is not a valid proxy URL';
  return `${classification.protocol}// proxies are not supported (use ${SUPPORTED_PROXY_SCHEMES})`;
}

function withLoopbackNoProxy(existing: string | undefined): string {
  const entries: string[] = [];
  for (const raw of (existing ?? '').split(',')) {
    const entry = raw.trim();
    if (entry && !entries.includes(entry)) entries.push(entry);
  }
  for (const entry of LOOPBACK_NO_PROXY_ENTRIES) {
    if (!entries.includes(entry)) entries.push(entry);
  }
  return entries.join(',');
}

function installUndiciFetch(): void {
  (undici as typeof undici & { install?: () => void }).install?.();
}

function createTuiProxyAgent(uri: string): Dispatcher {
  const url = new URL(uri);
  if (SOCKS5_PROXY_PROTOCOLS.has(url.protocol)) return createTuiSocks5ProxyAgent(url);
  // Preserve HTTP/1.1 on both TLS hops and CONNECT for plain HTTP targets.
  return new ProxyAgent({
    uri,
    allowH2: false,
    proxyTls: { allowH2: false },
    proxyTunnel: true,
  });
}

function createTuiSocks5ProxyAgent(url: URL): Dispatcher {
  const credentials = decodeProxyCredentials(url);
  if (!credentials) throw new Error('Proxy user name or password is not valid percent-encoding.');
  // Pass decoded credentials as options and drop them from the URL so undici
  // never decodes them again. An empty password stays unset, as with undici.
  const proxyUrl = new URL(url.href);
  proxyUrl.username = '';
  proxyUrl.password = '';
  // Socks5ProxyAgent rejects `socks5h:` although it already resolves names remotely.
  if (proxyUrl.protocol === 'socks5h:') proxyUrl.protocol = 'socks5:';
  const options: Socks5ProxyAgent.Options = {
    connectTimeout: SOCKS5_PROXY_CONNECT_TIMEOUT_MS,
    connect: withUnbracketedProxyHost(buildConnector({ timeout: SOCKS5_PROXY_CONNECT_TIMEOUT_MS })),
    ...(credentials.username ? { username: credentials.username } : {}),
    ...(credentials.password ? { password: credentials.password } : {}),
  };
  return withoutSocks5ExperimentalWarning(() => new Socks5ProxyAgent(proxyUrl, options));
}

/**
 * Socks5ProxyAgent dials `URL.hostname`, which keeps the brackets of an IPv6
 * literal (`[::1]`) and makes the socket connect fail with ENOTFOUND.
 */
function withUnbracketedProxyHost(connector: buildConnector.connector): buildConnector.connector {
  return (options, callback) =>
    connector(
      {
        ...options,
        hostname: stripIpv6Brackets(options.hostname),
        ...(options.host === undefined ? {} : { host: stripIpv6Brackets(options.host) }),
      },
      callback,
    );
}

function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

class TuiProxyDispatcher extends Dispatcher {
  readonly #directDispatcher = new Agent({ allowH2: false });
  readonly #httpDispatcher: Dispatcher;
  readonly #httpsDispatcher: Dispatcher;
  readonly #dispatchers: readonly Dispatcher[];
  readonly #noProxy: string;

  constructor(options: { httpProxy: string; httpsProxy: string; noProxy: string }) {
    super();
    this.#httpDispatcher = options.httpProxy
      ? createTuiProxyAgent(options.httpProxy)
      : this.#directDispatcher;
    this.#httpsDispatcher = options.httpsProxy
      ? options.httpsProxy === options.httpProxy
        ? this.#httpDispatcher
        : createTuiProxyAgent(options.httpsProxy)
      : this.#directDispatcher;
    this.#dispatchers = [
      ...new Set([this.#directDispatcher, this.#httpDispatcher, this.#httpsDispatcher]),
    ];
    this.#noProxy = options.noProxy;
  }

  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const url = new URL(options.origin ?? '');
    if (shouldBypassTuiProxy(url, this.#noProxy)) {
      return this.#directDispatcher.dispatch(options, handler);
    }
    const dispatcher = url.protocol === 'https:' ? this.#httpsDispatcher : this.#httpDispatcher;
    return dispatcher.dispatch(options, handler);
  }

  override close(): Promise<void>;
  override close(callback: () => void): void;
  override close(callback?: () => void): Promise<void> | void {
    const operation = Promise.all(this.#dispatchers.map((dispatcher) => dispatcher.close())).then(
      () => undefined,
    );
    if (!callback) return operation;
    void operation.then(callback, callback);
  }

  override destroy(): Promise<void>;
  override destroy(error: Error | null): Promise<void>;
  override destroy(callback: () => void): void;
  override destroy(error: Error | null, callback: () => void): void;
  override destroy(
    errorOrCallback?: Error | null | (() => void),
    callback?: () => void,
  ): Promise<void> | void {
    const error = typeof errorOrCallback === 'function' ? null : (errorOrCallback ?? null);
    const completion = typeof errorOrCallback === 'function' ? errorOrCallback : callback;
    const operation = Promise.all(
      this.#dispatchers.map((dispatcher) => dispatcher.destroy(error)),
    ).then(() => undefined);
    if (!completion) return operation;
    void operation.then(completion, completion);
  }
}

export function shouldBypassTuiProxy(url: URL, noProxy: string): boolean {
  const hostname = normalizeHostname(url.hostname);
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  for (const rawEntry of noProxy.split(/[\s,]+/u)) {
    const entry = parseNoProxyEntry(rawEntry);
    if (!entry) continue;
    if (entry.hostname === '*') return true;
    if (entry.port !== undefined && entry.port !== port) continue;
    if (hostname === entry.hostname) return true;
    if (entry.includeSubdomains && hostname.endsWith(`.${entry.hostname}`)) return true;
  }
  return false;
}

function parseNoProxyEntry(
  rawEntry: string,
): { hostname: string; port?: number; includeSubdomains: boolean } | undefined {
  let value = rawEntry.trim().toLowerCase();
  if (!value) return undefined;
  if (value === '*') return { hostname: '*', includeSubdomains: true };

  let port: number | undefined;
  if (value.startsWith('[')) {
    const bracket = value.indexOf(']');
    if (bracket > 0) {
      const suffix = value.slice(bracket + 1);
      if (/^:\d+$/u.test(suffix)) port = Number(suffix.slice(1));
      value = value.slice(1, bracket);
    }
  } else if (value.split(':').length === 2) {
    const [hostname, rawPort] = value.split(':');
    if (hostname && /^\d+$/u.test(rawPort ?? '')) {
      value = hostname;
      port = Number(rawPort);
    }
  }

  const includeSubdomains = value.startsWith('.') || value.startsWith('*');
  value = value.replace(/^\*?\./u, '');
  const hostname = normalizeHostname(value);
  return hostname ? { hostname, port, includeSubdomains } : undefined;
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, '');
}
