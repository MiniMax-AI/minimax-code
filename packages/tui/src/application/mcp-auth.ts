import { sanitizeTerminalText } from '../terminal-text.js';
import type {
  TuiMcpAuthAttemptOutcome,
  TuiMcpAuthConfirmation,
  TuiMcpAuthOutcome,
  TuiMcpAuthState,
  TuiMcpAuthStateView,
} from '../types/runtime-models.js';

/** Wire-compatible target shape; `mcp.auth_*` events carry plugin/project fields as optional. */
export interface McpAuthTargetLike {
  readonly kind: string;
  readonly serverName: string;
  readonly pluginName?: string;
  readonly pluginMarketplace?: string;
  readonly workspaceRoot?: string;
}

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  MCP_AUTH_REQUIRED: 'Authorization is required.',
  MCP_OAUTH_DISCOVERY_FAILED: "Couldn't discover this server's authorization settings.",
  MCP_OAUTH_METADATA_INVALID: 'The authorization server returned invalid or unsafe metadata.',
  MCP_OAUTH_PKCE_UNSUPPORTED: "The authorization server doesn't support PKCE (S256).",
  MCP_OAUTH_REGISTRATION_FAILED: "Couldn't register MiniMax Code with the authorization server.",
  MCP_OAUTH_CALLBACK_PORT_IN_USE:
    'The configured callback port is in use. Free the port or change oauth.callbackPort.',
  MCP_OAUTH_ISSUER_MISMATCH: 'The authorization response came from an unexpected issuer.',
  MCP_OAUTH_ACCESS_DENIED: 'Authorization was denied.',
  MCP_OAUTH_TOKEN_EXCHANGE_FAILED: "Couldn't exchange the authorization code for a token.",
  MCP_OAUTH_CLIENT_REJECTED: 'The authorization server rejected the configured client.',
  MCP_OAUTH_ATTEMPT_NOT_FOUND: 'This authorization attempt expired or was replaced. Start again.',
  MCP_OAUTH_STATIC_AUTHORIZATION:
    'This server uses a configured Authorization header, so OAuth is not used.',
  MCP_OAUTH_TRANSPORT_UNSUPPORTED: 'Only remote HTTP and SSE servers support OAuth.',
  MCP_OAUTH_PRIVATE_NETWORK_BLOCKED:
    'Authorization endpoints on private networks are blocked for this source.',
  MCP_OAUTH_TARGET_NOT_FOUND: 'MCP server not found.',
  MCP_OAUTH_UNSUPPORTED: "This server's OAuth configuration isn't supported.",
};

const LOOPBACK_HOSTS: Readonly<Record<string, true>> = {
  localhost: true,
  '127.0.0.1': true,
  '[::1]': true,
};

export function describeMcpAuthError(code: string | undefined): string {
  if (!code) return 'Authorization failed.';
  const known = ERROR_MESSAGES[code];
  if (known) return known;
  return /^[A-Z][A-Z0-9_]{0,63}$/u.test(code)
    ? `Authorization failed (${code}).`
    : 'Authorization failed.';
}

/** Runtime error code carried by a thrown error (e.g. `McpAuthTargetError`), if any. */
export function mcpAuthErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' && /^MCP_[A-Z0-9_]+$/u.test(code) ? code : undefined;
}

export function sameMcpAuthTarget(left: McpAuthTargetLike, right: McpAuthTargetLike): boolean {
  if (left.kind !== right.kind || left.serverName !== right.serverName) return false;
  if (left.kind === 'plugin') {
    return (
      left.pluginName === right.pluginName && left.pluginMarketplace === right.pluginMarketplace
    );
  }
  if (left.kind === 'project' && left.workspaceRoot && right.workspaceRoot) {
    return left.workspaceRoot === right.workspaceRoot;
  }
  return true;
}

export function describeMcpAuthTarget(target: McpAuthTargetLike): string {
  const name = sanitizeTerminalText(target.serverName);
  if (target.kind === 'project') return `${name} (project)`;
  if (target.kind === 'plugin' && target.pluginName) {
    const plugin = target.pluginMarketplace
      ? `${target.pluginName}@${target.pluginMarketplace}`
      : target.pluginName;
    return `${name} (${sanitizeTerminalText(plugin)})`;
  }
  return name;
}

export function mcpAuthNeedsAttention(state: TuiMcpAuthState): boolean {
  return state === 'needs_auth' || state === 'needs_reauth';
}

export function mcpAuthStateLabel(view: Pick<TuiMcpAuthStateView, 'authState' | 'reason'>): string {
  switch (view.authState) {
    case 'authorized':
      return 'Authorized';
    case 'authorizing':
      return 'Authorizing…';
    case 'needs_auth':
      return 'Needs authorization';
    case 'needs_reauth':
      return view.reason === 'insufficient_scope'
        ? 'Needs more permissions'
        : 'Authorization expired';
    case 'failed':
      return 'Authorization failed';
    case 'static':
      return 'Configured credentials';
    case 'not_required':
      return 'No authorization required';
    default:
      return 'Not checked';
  }
}

/** Why a state needs attention beyond its label, never credential material. */
export function mcpAuthProblemDetail(view: TuiMcpAuthStateView): string | undefined {
  if (view.authState === 'failed') return describeMcpAuthError(view.reason);
  if (view.authState === 'needs_reauth' && view.missingScopes?.length) {
    return `Missing scopes: ${sanitizeTerminalText(view.missingScopes.join(' '))}`;
  }
  return undefined;
}

export type McpAuthAttemptResolution =
  | { readonly status: 'pending' }
  | { readonly status: 'authorized' }
  | { readonly status: 'failed'; readonly errorCode?: string }
  /** Cancelled, expired, or gone without a recorded outcome. */
  | { readonly status: 'incomplete' };

export function mcpAuthAttemptResolution(
  outcome: TuiMcpAuthAttemptOutcome,
  errorCode?: string,
): McpAuthAttemptResolution {
  if (outcome === 'authorized' && !errorCode) return { status: 'authorized' };
  if (outcome === 'failed' || errorCode) {
    return errorCode ? { status: 'failed', errorCode } : { status: 'failed' };
  }
  return { status: 'incomplete' };
}

/**
 * Result of attempt `attemptId` as seen in a state view. Only that attempt's own outcome settles
 * it: a failed or expired reauthorization keeps the previous token, so the view still reads
 * `authorized`.
 */
export function resolveMcpAuthAttempt(
  view: TuiMcpAuthStateView,
  attemptId: string,
): McpAuthAttemptResolution {
  if (view.lastAttemptId === attemptId && view.lastAttemptOutcome) {
    return mcpAuthAttemptResolution(view.lastAttemptOutcome, view.lastAttemptErrorCode);
  }
  if (view.attemptId === attemptId || view.authState === 'authorizing')
    return { status: 'pending' };
  // Neither running nor recorded, e.g. replaced by another attempt or a Runtime restart.
  return { status: 'incomplete' };
}

/** `completeMcpAuth` answers for its own attempt; `authorizing` means the paste was rejected. */
export function resolveMcpAuthCompletion(outcome: TuiMcpAuthOutcome): McpAuthAttemptResolution {
  const { state, errorCode } = outcome;
  if (state.authState === 'authorizing') return { status: 'pending' };
  if (errorCode) return { status: 'failed', errorCode };
  if (state.authState === 'authorized') return { status: 'authorized' };
  if (state.authState === 'failed') {
    return state.reason ? { status: 'failed', errorCode: state.reason } : { status: 'failed' };
  }
  return { status: 'incomplete' };
}

/** Why a pasted redirect was not accepted while the attempt is still waiting. */
export function describeRejectedMcpAuthRedirect(errorCode: string | undefined): string {
  return errorCode === 'MCP_OAUTH_ATTEMPT_NOT_FOUND' || !errorCode
    ? "The redirect address doesn't match this authorization. Paste it again."
    : `${describeMcpAuthError(errorCode)} Paste the full address again.`;
}

/** Only stored credentials can be disconnected; clearing other states would block reconnects. */
export function mcpAuthCanDisconnect(state: TuiMcpAuthState): boolean {
  return state === 'authorized' || state === 'needs_reauth' || state === 'failed';
}

/** Only HTTPS, or HTTP on a loopback host, may be opened (same rule as Desktop). */
export function isSafeMcpAuthorizationUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && Object.hasOwn(LOOPBACK_HOSTS, url.hostname);
}

export function mcpAuthConfirmationLines(confirmation: TuiMcpAuthConfirmation): string[] {
  return [
    `Source: ${sanitizeTerminalText(confirmation.sourceLabel)}`,
    `MCP server: ${sanitizeTerminalText(confirmation.serverOrigin)}`,
    `Authorization server: ${sanitizeTerminalText(confirmation.issuer)}`,
    ...(confirmation.authorizationHost
      ? [`Sign-in page host: ${sanitizeTerminalText(confirmation.authorizationHost)}`]
      : []),
    `Client ID: ${sanitizeTerminalText(confirmation.clientId)}`,
  ];
}

/** One-line hint for servers the Runtime already knows need (re)authorization. */
export function formatMcpAuthAttentionNotice(
  states: readonly TuiMcpAuthStateView[],
): string | undefined {
  const pending = states.filter((state) => mcpAuthNeedsAttention(state.authState));
  if (pending.length === 0) return undefined;
  const shown = pending.slice(0, 3).map((state) => describeMcpAuthTarget(state.target));
  const more = pending.length > shown.length ? `, +${pending.length - shown.length} more` : '';
  const subject =
    pending.length === 1 ? 'An MCP server needs' : `${pending.length} MCP servers need`;
  return `${subject} authorization: ${shown.join(', ')}${more}. Run /mcp to authorize.`;
}
