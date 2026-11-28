/**
 * Credential identity (plan §6.3) and URL / address classification helpers.
 * Pure functions — no I/O.
 */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { McpOAuthBinding } from './contracts.js';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Scheme/host lowercased, default port and fragment dropped, trailing `/` removed. */
export function canonicalResourceUrl(url: string): string {
  const parsed = new URL(url);
  parsed.hash = '';
  const href = parsed.href;
  if (parsed.search) return href;
  return href.endsWith('/') ? href.slice(0, -1) : href;
}

export interface PreRegisteredRedirect {
  host: string;
  /** Undefined → ephemeral listen port. */
  port?: number;
  path: string;
  /** Codex compat: explicit callbackUrl kept verbatim (with the port inserted when absent). */
  template?: URL;
}

/**
 * Pre-registered redirect_uri shape by source format (plan §5.5.1). 'unsupported' when a Codex
 * package declares a client without `callbackUrl` (its callback id derivation is not public);
 * 'invalid' when that callbackUrl is not a loopback http URL.
 */
export function preRegisteredRedirect(
  binding: McpOAuthBinding,
): PreRegisteredRedirect | 'unsupported' | 'invalid' {
  const port = binding.oauth?.callbackPort;
  const withPort = port ? { port } : {};
  switch (binding.redirectFormat) {
    case 'localhost-callback':
      return { host: 'localhost', ...withPort, path: '/callback' };
    case 'codex':
      return codexRedirect(binding.codexCallbackUrl, port);
    case 'default':
      return { host: binding.oauth?.callbackHost ?? 'localhost', ...withPort, path: '/callback' };
  }
}

/**
 * Codex `callbackUrl`: http on `localhost` / `127.0.0.1` only (the hosts the callback listener
 * accepts), used verbatim; listen port = callbackPort ?? URL port.
 */
function codexRedirect(
  callbackUrl: string | undefined,
  callbackPort: number | undefined,
): PreRegisteredRedirect | 'unsupported' | 'invalid' {
  if (!callbackUrl) return 'unsupported';
  let template: URL;
  try {
    template = new URL(callbackUrl);
  } catch {
    return 'invalid';
  }
  const acceptedHost = template.hostname === 'localhost' || template.hostname === '127.0.0.1';
  if (template.protocol !== 'http:' || !acceptedHost) return 'invalid';
  const listenPort = codexListenPort(template, callbackPort);
  if (listenPort === 'invalid') return 'invalid';
  return {
    host: template.hostname,
    ...(listenPort ? { port: listenPort } : {}),
    path: template.pathname,
    template,
  };
}

/** The listener must serve the exact port the browser is redirected to. */
function codexListenPort(
  template: URL,
  callbackPort: number | undefined,
): number | undefined | 'invalid' {
  const urlPort = template.port ? Number(template.port) : undefined;
  if (urlPort !== undefined && callbackPort !== undefined && urlPort !== callbackPort) {
    return 'invalid';
  }
  return callbackPort ?? urlPort;
}

/** clientId, pre-registered redirect host/port/path, fixed scopes, authServerMetadataUrl. */
export function clientFingerprint(binding: McpOAuthBinding): string {
  const oauth = binding.oauth;
  const redirect = oauth?.clientId ? preRegisteredRedirect(binding) : undefined;
  const redirectIdentity =
    redirect && typeof redirect === 'object'
      ? [redirect.host, redirect.port ?? null, redirect.path, redirect.template?.href ?? null]
      : (redirect ?? null);
  return sha256Hex(
    JSON.stringify([
      oauth?.clientId ?? null,
      redirectIdentity,
      oauth?.scopes ? [...oauth.scopes] : null,
      oauth?.authServerMetadataUrl ?? null,
    ]),
  );
}

export function credentialKeyFor(binding: McpOAuthBinding): string {
  return sha256Hex(
    JSON.stringify([
      binding.namespace,
      canonicalResourceUrl(binding.serverUrl),
      clientFingerprint(binding),
    ]),
  );
}

/**
 * Digest of what a connection sends (URL + resolved headers, names case-insensitive). Only the
 * hash is kept, so header secrets never reach memory-held observations or logs.
 */
export function mcpConnectionFingerprint(input: {
  url: string;
  headers?: Readonly<Record<string, string>>;
}): string {
  const headers = Object.entries(input.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => a.localeCompare(b, 'en-US'));
  return sha256Hex(JSON.stringify([input.url, headers]));
}

/** Short issuer digest used in the DCR redirect path. */
export function issuerHash(issuer: string): string {
  return sha256Hex(issuer).slice(0, 16);
}

export function isLoopbackHost(hostname: string): boolean {
  const host = stripHostBrackets(hostname).toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return isIP(host) !== 0 && isPrivateAddress(host) === 'loopback';
}

/** `[::1]` → `::1`; URL.hostname keeps IPv6 brackets. */
export function stripHostBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
 * Classifies an IP literal: 'loopback', 'private' (RFC 1918 / ULA / link-local / CGNAT /
 * unspecified / multicast) or false for public addresses. IPv6 forms that embed an IPv4
 * address (mapped `::ffff:0:0/96`, NAT64 `64:ff9b::/96`, compatible `::/96`) are classified by
 * the embedded address, whatever their textual notation.
 */
export function isPrivateAddress(address: string): 'loopback' | 'private' | false {
  const ip = stripHostBrackets(address).toLowerCase();
  const version = isIP(ip);
  if (version === 4) return classifyIpv4(ip);
  return version === 6 ? classifyIpv6(expandIpv6(ip)) : false;
}

/** [first-hextet value, mask]: fc00::/7 ULA, fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast. */
const IPV6_NON_PUBLIC_PREFIXES: ReadonlyArray<readonly [number, number]> = [
  [0xfc00, 0xfe00],
  [0xfe80, 0xffc0],
  [0xfec0, 0xffc0],
  [0xff00, 0xff00],
];

function classifyIpv6(h: readonly number[]): 'loopback' | 'private' | false {
  const last = h[7] ?? 0;
  if (h.slice(0, 7).every((hextet) => hextet === 0) && last <= 1) {
    return last === 1 ? 'loopback' : 'private';
  }
  const embedded = embeddedIpv4(h);
  if (embedded) return classifyIpv4(embedded);
  const first = h[0] ?? 0;
  return IPV6_NON_PUBLIC_PREFIXES.some(([value, mask]) => (first & mask) === value)
    ? 'private'
    : false;
}

/** IPv4 carried by mapped `::ffff:0:0/96`, compatible `::/96` or NAT64 `64:ff9b::/96`. */
function embeddedIpv4(h: readonly number[]): string | undefined {
  const zero = (from: number, to: number) => h.slice(from, to).every((hextet) => hextet === 0);
  const mappedOrCompatible = zero(0, 5) && (h[5] === 0xffff || h[5] === 0);
  const nat64 = h[0] === 0x64 && h[1] === 0xff9b && zero(2, 6);
  if (!mappedOrCompatible && !nat64) return undefined;
  const [high = 0, low = 0] = [h[6], h[7]];
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/** Eight numeric hextets for a valid IPv6 literal (handles `::` and a dotted IPv4 tail). */
function expandIpv6(ip: string): number[] {
  let text = ip.split('%')[0] ?? ip;
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = '', tail] = text.split('::');
  const parse = (part: string) =>
    part ? part.split(':').map((hex) => Number.parseInt(hex, 16)) : [];
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}

/** [network, prefix length, classification] for non-public IPv4 ranges. */
const IPV4_RANGES: ReadonlyArray<readonly [string, number, 'loopback' | 'private']> = [
  ['127.0.0.0', 8, 'loopback'],
  ['0.0.0.0', 8, 'private'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'private'],
  ['169.254.0.0', 16, 'private'],
  ['172.16.0.0', 12, 'private'],
  ['192.168.0.0', 16, 'private'],
  ['224.0.0.0', 3, 'private'],
];

function ipv4ToInt(ip: string): number {
  return ip.split('.').reduce((value, octet) => (value << 8) + Number(octet), 0) >>> 0;
}

function classifyIpv4(ip: string): 'loopback' | 'private' | false {
  const address = ipv4ToInt(ip);
  for (const [network, prefix, kind] of IPV4_RANGES) {
    const mask = (0xffffffff << (32 - prefix)) >>> 0;
    if ((address & mask) >>> 0 === ipv4ToInt(network)) return kind;
  }
  return false;
}

/** Space-separated scope union preserving first-seen order. */
export function unionScopes(
  ...scopes: ReadonlyArray<string | readonly string[] | undefined>
): string | undefined {
  const seen = new Set<string>();
  for (const entry of scopes) {
    if (!entry) continue;
    const parts = typeof entry === 'string' ? entry.split(/\s+/) : entry;
    for (const part of parts) if (part) seen.add(part);
  }
  return seen.size > 0 ? [...seen].join(' ') : undefined;
}
