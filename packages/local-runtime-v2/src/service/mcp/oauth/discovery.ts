/**
 * Discovery and validation for interactive authorization (plan §5.2). Runs on every `start`.
 * PRM comes from the SDK; authorization server metadata is fetched as raw JSON so fields the SDK
 * OIDC schema drops (`authorization_response_iss_parameter_supported`, `revocation_endpoint`)
 * are kept.
 *
 * Also owns the guarded fetch used for every OAuth request (PRM, metadata, CIMD, registration,
 * token, revocation): it never carries MCP-configured headers, enforces https (loopback http
 * excepted), blocks private / link-local / loopback destinations for project and plugin sources
 * on every redirect hop, and bounds each request with a timeout.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import {
  OAuthMetadataSchema,
  buildDiscoveryUrls,
  discoverOAuthProtectedResourceMetadata,
  type AuthorizationServerMetadata,
  type FetchLike,
} from '@mavis/mcp/oauth';
import { isLoopbackHost, isPrivateAddress, stripHostBrackets } from './canonical.js';
import { McpOAuthError, type McpOAuthBinding } from './contracts.js';

/** Validated authorization server metadata; unknown fields preserved. */
type RawAuthorizationServerMetadata = AuthorizationServerMetadata & Record<string, unknown>;

export interface DiscoveryResult {
  /** Canonical MCP server URL — always sent as `resource`. */
  resource: string;
  resourceMetadataUrl?: string;
  /** PRM `scopes_supported`. */
  resourceScopes?: string[];
  issuer: string;
  metadata: RawAuthorizationServerMetadata;
}

const MCP_PROTOCOL_VERSION = '2025-11-25';

interface DiscoveryInput {
  binding: McpOAuthBinding;
  resource: string;
  resourceMetadataUrl?: string;
  fetchFn: FetchLike;
  resolveHost?: HostResolver;
}

export async function discoverAuthorizationServer(input: DiscoveryInput): Promise<DiscoveryResult> {
  const metadataUrl = input.binding.oauth?.authServerMetadataUrl;
  return metadataUrl
    ? discoverFromMetadataUrl(input, new URL(metadataUrl))
    : discoverViaProtectedResource(input);
}

/** Configured `authServerMetadataUrl`: no PRM; resource is the canonical server URL. */
async function discoverFromMetadataUrl(
  input: DiscoveryInput,
  metadataUrl: URL,
): Promise<DiscoveryResult> {
  const metadata = await fetchMetadataDocument(metadataUrl, input.fetchFn);
  if (!metadata) throw new McpOAuthError('MCP_OAUTH_DISCOVERY_FAILED');
  // No authorization server identifier exists to compare against; the issuer must at least
  // live on the configured document's origin so confirmation shows the real host.
  if (originOf(metadata.issuer) !== metadataUrl.origin) {
    throw new McpOAuthError('MCP_OAUTH_METADATA_INVALID');
  }
  await validateMetadata(metadata, input.binding, input.resolveHost);
  return { resource: input.resource, issuer: metadata.issuer, metadata };
}

async function discoverViaProtectedResource(input: DiscoveryInput): Promise<DiscoveryResult> {
  const { binding, resource, resourceMetadataUrl, fetchFn } = input;
  let prm;
  try {
    prm = await discoverOAuthProtectedResourceMetadata(
      binding.serverUrl,
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
      },
      fetchFn,
    );
  } catch (error) {
    throw asOAuthError(error, 'MCP_OAUTH_DISCOVERY_FAILED');
  }
  const authorizationServer = prm.authorization_servers?.[0];
  if (!authorizationServer) throw new McpOAuthError('MCP_OAUTH_DISCOVERY_FAILED');
  if (!resourceCovers(prm.resource, resource)) {
    throw new McpOAuthError('MCP_OAUTH_METADATA_INVALID');
  }
  const metadata = await fetchFirstMetadata(authorizationServer, fetchFn);
  if (withoutTrailingSlash(metadata.issuer) !== withoutTrailingSlash(authorizationServer)) {
    throw new McpOAuthError('MCP_OAUTH_METADATA_INVALID');
  }
  await validateMetadata(metadata, binding, input.resolveHost);
  return {
    resource,
    ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    ...(prm.scopes_supported ? { resourceScopes: prm.scopes_supported } : {}),
    issuer: metadata.issuer,
    metadata,
  };
}

/** RFC 8414 then OIDC well-known URLs, in SDK order. */
async function fetchFirstMetadata(
  authorizationServer: string,
  fetchFn: FetchLike,
): Promise<RawAuthorizationServerMetadata> {
  for (const { url } of buildDiscoveryUrls(authorizationServer)) {
    const metadata = await fetchMetadataDocument(url, fetchFn);
    if (metadata) return metadata;
  }
  throw new McpOAuthError('MCP_OAUTH_DISCOVERY_FAILED');
}

/** Undefined on 4xx (try the next well-known URL); throws on transport errors, 5xx, bad JSON. */
async function fetchMetadataDocument(
  url: URL,
  fetchFn: FetchLike,
): Promise<RawAuthorizationServerMetadata | undefined> {
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: { Accept: 'application/json', 'MCP-Protocol-Version': MCP_PROTOCOL_VERSION },
    });
  } catch (error) {
    throw asOAuthError(error, 'MCP_OAUTH_DISCOVERY_FAILED');
  }
  if (response.status >= 400 && response.status < 500) {
    await response.body?.cancel();
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new McpOAuthError('MCP_OAUTH_DISCOVERY_FAILED');
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (error) {
    throw new McpOAuthError('MCP_OAUTH_METADATA_INVALID', { cause: error });
  }
  if (!OAuthMetadataSchema.safeParse(raw).success) {
    throw new McpOAuthError('MCP_OAUTH_METADATA_INVALID');
  }
  return raw as RawAuthorizationServerMetadata;
}

async function validateMetadata(
  metadata: RawAuthorizationServerMetadata,
  binding: McpOAuthBinding,
  resolveHost: HostResolver | undefined,
): Promise<void> {
  if (!metadata.response_types_supported.includes('code')) {
    throw new McpOAuthError('MCP_OAUTH_METADATA_INVALID');
  }
  if (!metadata.code_challenge_methods_supported?.includes('S256')) {
    throw new McpOAuthError('MCP_OAUTH_PKCE_UNSUPPORTED');
  }
  // https (loopback excepted) for every endpoint; private destinations only for user config.
  await assertEndpointAllowed(metadata.issuer, 'allow');
  await assertEndpointAllowed(metadata.authorization_endpoint, 'allow');
  for (const endpoint of [
    metadata.token_endpoint,
    metadata.registration_endpoint,
    stringField(metadata, 'revocation_endpoint'),
  ]) {
    if (endpoint) await assertEndpointAllowed(endpoint, binding.privateNetwork, resolveHost);
  }
  // Mix-up defence without RFC 9207: token and authorization endpoints share an origin.
  if (
    metadata.authorization_response_iss_parameter_supported !== true &&
    originOf(metadata.token_endpoint) !== originOf(metadata.authorization_endpoint)
  ) {
    throw new McpOAuthError('MCP_OAUTH_METADATA_INVALID');
  }
}

/** PRM `resource` must share the origin and be the same path or a path prefix. */
function resourceCovers(prmResource: string, canonical: string): boolean {
  let declared: URL;
  let actual: URL;
  try {
    declared = new URL(prmResource);
    actual = new URL(canonical);
  } catch {
    return false;
  }
  if (declared.origin !== actual.origin) return false;
  const declaredPath = withoutTrailingSlash(declared.pathname);
  const actualPath = withoutTrailingSlash(actual.pathname);
  return (
    declaredPath === '' || actualPath === declaredPath || actualPath.startsWith(`${declaredPath}/`)
  );
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function withoutTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** Keeps stable OAuth errors (e.g. private network blocks); maps everything else to `code`. */
export function asOAuthError(error: unknown, code: McpOAuthError['code']): McpOAuthError {
  return error instanceof McpOAuthError ? error : new McpOAuthError(code, { cause: error });
}

// ---------------------------------------------------------------------------
// Guarded OAuth fetch
// ---------------------------------------------------------------------------

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

type HostResolver = (hostname: string) => Promise<string[]>;

export interface GuardedFetchOptions {
  fetchImpl: typeof fetch;
  privateNetwork: 'allow' | 'deny';
  resolveHost?: HostResolver;
  timeoutMs?: number;
  /** Owner lifetime (service close) aborting every request made through this fetch. */
  signal?: AbortSignal;
  /** Observes the final HTTP status (token requests classify 5xx without reading bodies). */
  onStatus?: (status: number) => void;
}

const resolveWithDns: HostResolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address);

/**
 * Throws `MCP_OAUTH_METADATA_INVALID` for non-https non-loopback URLs and
 * `MCP_OAUTH_PRIVATE_NETWORK_BLOCKED` when `deny` and the host resolves to a private address.
 */
async function assertEndpointAllowed(
  url: string | URL,
  privateNetwork: 'allow' | 'deny',
  resolveHost: HostResolver = resolveWithDns,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new McpOAuthError('MCP_OAUTH_METADATA_INVALID', { cause: error });
  }
  const loopback = isLoopbackHost(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new McpOAuthError('MCP_OAUTH_METADATA_INVALID');
  }
  if (privateNetwork === 'allow') return;
  if (loopback) throw new McpOAuthError('MCP_OAUTH_PRIVATE_NETWORK_BLOCKED');
  const host = stripHostBrackets(parsed.hostname);
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await resolveHost(host);
    } catch {
      // Unresolvable hosts fail in fetch itself; nothing private to protect.
      return;
    }
  }
  if (addresses.some((address) => isPrivateAddress(address) !== false)) {
    throw new McpOAuthError('MCP_OAUTH_PRIVATE_NETWORK_BLOCKED');
  }
}

export function createGuardedFetch(options: GuardedFetchOptions): FetchLike {
  const resolveHost = options.resolveHost ?? resolveWithDns;
  return async (input, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const signals = [AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)];
    if (options.signal) signals.push(options.signal);
    if (init?.signal) signals.push(init.signal);
    const signal = AbortSignal.any(signals);
    let url = new URL(input);
    for (let redirects = 0; ; redirects += 1) {
      await assertEndpointAllowed(url, options.privateNetwork, resolveHost);
      const response = await options.fetchImpl(url, { ...init, signal, redirect: 'manual' });
      const location = response.headers.get('location');
      const followable =
        method === 'GET' &&
        location !== null &&
        [301, 302, 303, 307, 308].includes(response.status) &&
        redirects < MAX_REDIRECTS;
      if (!followable) {
        options.onStatus?.(response.status);
        return response;
      }
      await response.body?.cancel();
      url = new URL(location, url);
    }
  };
}
