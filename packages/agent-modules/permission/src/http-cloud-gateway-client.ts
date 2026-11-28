/**
 * HttpCloudGatewayClient — production cloud-gateway implementation.
 *
 * Wire-aligned to the existing managed endpoint
 *   POST {region-routed-host}/mavis/api/v1/permission/check
 * which `cloud-classify-client.ts` already targets. The cloud side is
 * intentionally untouched — this client re-uses the exact same
 * request/response format and host routing, returning verdicts in the
 * {@link CloudClassifyVerdict} vocabulary.
 *
 * Fail-closed policy:
 *   - HTTP non-2xx / non-JSON / verdict missing / network error / abort
 *     → resolves to { kind: 'timeout', reasonLocalized: ... }
 *
 * The daemon then surfaces an ask-user card so the user is never silently
 * bypassed when the gateway is unavailable.
 *
 * Region / buildEnv routing is delegated to the `getPermissionCheckApiUrl()`
 * helper so a single PERMISSION_API_BASE table stays the source of truth.
 */

import { getPermissionCheckApiUrl } from './classifier/cloud-classify-client.js';
import { logger, backgroundCtx, getPermissionManagedAuthToken } from './host-utils.js';
import type {
  CloudGatewayClient,
  CloudClassifyFailureReason,
  CloudClassifyRequest,
  CloudClassifyVerdict,
} from './cloud-gateway.js';

export interface HttpCloudGatewayClientOptions {
  /** Per-call HTTP timeout (ms). Default 60_000 (matches legacy classifier). */
  timeoutMs?: number;
  /**
   * Optional URL override — primarily for tests pointing at a local
   * fixture server. Production always uses `getPermissionCheckApiUrl()`.
   */
  endpointOverride?: string;
  /**
   * Optional Bearer token override — primarily for tests. Production
   * pulls from `getPermissionManagedAuthToken()`.
   */
  authTokenProvider?: () => string | undefined;
}

export class HttpCloudGatewayClient implements CloudGatewayClient {
  private readonly timeoutMs: number;
  private readonly endpointOverride?: string;
  private readonly authTokenProvider: () => string | undefined;

  constructor(opts: HttpCloudGatewayClientOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.endpointOverride = opts.endpointOverride;
    this.authTokenProvider = opts.authTokenProvider ?? getPermissionManagedAuthToken;
  }

  async classify(req: CloudClassifyRequest): Promise<CloudClassifyVerdict> {
    const startedAtMs = Date.now();
    const url = this.endpointOverride ?? this.resolveUrl();
    if (!url) {
      return fallbackTimeout('cloud gateway URL not configured', 'no_url');
    }

    const body = {
      tool_name: req.toolName,
      input: req.input,
      platform: req.platform,
      home_dir: req.homeDir,
      workspace_root: req.workspaceRoot,
      mode: req.mode,
      ...(req.conversationContext ? { conversation_context: req.conversationContext } : {}),
      ...(req.agentId ? { agent_id: req.agentId } : {}),
      ...(req.sessionId ? { session_id: req.sessionId } : {}),
      ...(req.daemonPromptVersion ? { daemon_prompt_version: req.daemonPromptVersion } : {}),
    };

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'User-Agent': 'MiniMaxAgent',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.authTokenProvider() ?? ''}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      const respText = await resp.text();
      const durationMs = Date.now() - startedAtMs;

      if (!resp.ok) {
        logger.warn(
          backgroundCtx(),
          `[cloud-gateway-v2] non-2xx: status=${resp.status} body=${respText.slice(0, 200)}`,
        );
        return fallbackTimeout(
          `permission/check returned ${resp.status}`,
          httpFailureReason(resp.status),
          durationMs,
        );
      }

      let data: {
        verdict?: unknown;
        reason?: unknown;
        model?: unknown;
        base_resp?: { status_code?: unknown; status_msg?: unknown };
      };
      try {
        data = JSON.parse(respText) as typeof data;
      } catch {
        logger.warn(backgroundCtx(), `[cloud-gateway-v2] non-JSON body=${respText.slice(0, 200)}`);
        return fallbackTimeout('permission/check returned non-JSON', 'non_json', durationMs);
      }

      const statusCode = data.base_resp?.status_code;
      if (typeof statusCode === 'number' && statusCode !== 0) {
        const msg =
          typeof data.base_resp?.status_msg === 'string'
            ? data.base_resp.status_msg
            : `status_code=${statusCode}`;
        logger.warn(backgroundCtx(), `[cloud-gateway-v2] biz error: ${msg}`);
        return fallbackTimeout(`permission/check biz error: ${msg}`, 'biz_error', durationMs);
      }

      const verdict = data.verdict;
      if (verdict !== 'allow' && verdict !== 'confirm' && verdict !== 'block') {
        logger.warn(
          backgroundCtx(),
          `[cloud-gateway-v2] invalid verdict=${String(verdict)} body=${respText.slice(0, 200)}`,
        );
        return fallbackTimeout(
          'permission/check returned invalid verdict',
          'invalid_verdict',
          durationMs,
        );
      }

      const reason =
        typeof data.reason === 'string' && data.reason.length > 0
          ? data.reason
          : 'No reason provided by server';
      const model = typeof data.model === 'string' ? data.model : 'cloud:gemini-flash';
      return { kind: verdict, reasonLocalized: reason, durationMs, model };
    } catch (err) {
      const durationMs = Date.now() - startedAtMs;
      // Distinguish a real AbortSignal.timeout() trigger from any other
      // throw (network reset, DNS failure, TLS error). The facade keeps the
      // same `kind: 'timeout'` verdict for both — fail-closed routing is
      // identical — but the reasonLocalized prefix lets the daemon log /
      // permission card surface the underlying class of failure rather
      // than always saying "timed out".
      const isAbort =
        err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
      const reason = isAbort
        ? `timed out after ${this.timeoutMs}ms`
        : `network error: ${err instanceof Error ? err.message : String(err)}`;
      logger.warn(backgroundCtx(), `[cloud-gateway-v2] call failed: ${String(err)}`);
      return fallbackTimeout(reason, isAbort ? 'timeout' : 'network', durationMs);
    }
  }

  private resolveUrl(): string | undefined {
    try {
      return getPermissionCheckApiUrl();
    } catch (err) {
      logger.warn(backgroundCtx(), `[cloud-gateway-v2] URL resolution failed: ${String(err)}`);
      return undefined;
    }
  }
}

function httpFailureReason(status: number): CloudClassifyFailureReason {
  if (status === 401) return 'http_401';
  if (status === 403) return 'http_403';
  return status >= 500 ? 'http_5xx' : 'http_4xx';
}

function fallbackTimeout(
  reason: string,
  failureReason: CloudClassifyFailureReason,
  durationMs?: number,
): CloudClassifyVerdict {
  return {
    kind: 'timeout',
    reasonLocalized: reason,
    failureReason,
    model: 'cloud:unavailable',
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}
