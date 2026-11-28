/**
 * CloudGatewayClient — daemon-side abstraction over the existing managed
 * permission classify endpoint.
 *
 * Wire contract is pixel-aligned to the production endpoint already in use:
 *
 *   POST {region-routed-host}/mavis/api/v1/permission/check
 *   Authorization: Bearer <managed-auth-token>
 *
 *   Request:
 *     {
 *       "tool_name":         string,
 *       "input":             string,         // serialized tool input
 *       "platform":          string,
 *       "home_dir":          string,
 *       "workspace_root":    string,
 *       "mode":              "auto",
 *       "conversation_context": string,      // pre-rendered by daemon
 *       "agent_id":          string?,
 *       "session_id":        string?
 *     }
 *
 *   Response:
 *     {
 *       "base_resp": { "status_code": number, "status_msg": string },
 *       "verdict":   "allow" | "confirm" | "block",
 *       "reason":    string
 *     }
 *
 * The cloud side is intentionally untouched. Prompt assembly stays in the
 * local runtime (`packages/local-runtime-v2/assets/prompts/llm-gate-classifier.md`),
 * conversation context is rendered runtime-side (see `conversation-renderer.ts`),
 * and the cloud endpoint remains a thin wrapper around gemini-flash with the
 * same prompt baked in.
 *
 * Future-compatibility hooks:
 *   - `daemonPromptVersion` is sent so the cloud side can log/route by
 *     prompt revision when it adopts a registry. Unknown today, ignored
 *     server-side.
 *   - `suggestedRule` is reserved in the verdict shape so a future cloud
 *     response can carry a persistence recommendation without a wire bump.
 *     Today: cloud never returns it, the daemon never persists from a gateway
 *     verdict.
 */

import type { ProposedRule } from './ask-policy.js';

/**
 * What the daemon hands to the gateway. All fields except the new
 * `daemonPromptVersion` map 1:1 to the existing payload.
 */
export interface CloudClassifyRequest {
  toolName: string;
  /** Serialized tool input (string), matching the `input` field. */
  input: string;
  platform: string;
  homeDir: string;
  workspaceRoot: string;
  /** Reserved for future modes; today always 'auto'. */
  mode: 'auto';
  /**
   * Daemon-rendered conversation context. Contains "## Recent User
   * Instructions" + "## Recent Conversation" sections built by the
   * conversation renderer. Cloud forwards it into the prompt as-is.
   */
  conversationContext: string;
  agentId?: string;
  sessionId?: string;

  /**
   * Daemon's prompt revision identifier (hash of llm-gate-classifier.md).
   * Cloud may log this but does not consume it today. Always send.
   */
  daemonPromptVersion?: string;
}

/**
 * What the gateway hands back. Verdict is mapped from the cloud
 * `verdict: 'allow' | 'confirm' | 'block'` plus a synthesized `timeout`
 * variant the HTTP client emits on network/timeout failure (fail-safe to
 * ask-user).
 */
/**
 * Why the HTTP client synthesized a `timeout` verdict. A bounded enum for
 * telemetry only: routing is identical for every value (fail closed to ask).
 */
export type CloudClassifyFailureReason =
  | 'no_url'
  | 'timeout'
  | 'network'
  | 'http_401'
  | 'http_403'
  | 'http_4xx'
  | 'http_5xx'
  | 'non_json'
  | 'biz_error'
  | 'invalid_verdict';

export interface CloudClassifyVerdict {
  kind: 'allow' | 'confirm' | 'block' | 'timeout';
  /** Localized rationale from the cloud, or a daemon-local fallback on timeout. */
  reasonLocalized: string;
  /** Set only on a synthesized `timeout`; see {@link CloudClassifyFailureReason}. */
  failureReason?: CloudClassifyFailureReason;

  /**
   * Forward-compatible: when the cloud endpoint adds a `suggested_rule`
   * field, the HTTP client surfaces it here. Today always undefined — the
   * cloud never returns it and the daemon never persists from a gateway
   * verdict.
   */
  suggestedRule?: ProposedRule;

  /** Telemetry — server-side request id, response time. Optional. */
  serverRequestId?: string;
  durationMs?: number;

  /**
   * Telemetry — model identifier reported by the gateway (e.g.
   * `cloud:gemini-flash`) or `cloud:unavailable` when the client falls back
   * to timeout. The cloud-classify wire always returned this; the field is
   * optional so daemons that log it can keep doing so without a wire
   * renegotiation.
   */
  model?: string;
}

/**
 * The injection seam. local-runtime provides `HttpCloudGatewayClient`; tests
 * provide `InMemoryCloudGatewayClient`; offline / BYO-key daemons can inject a
 * no-op that always returns `{ kind: 'timeout', ... }` to force the ask-user
 * path.
 */
export interface CloudGatewayClient {
  classify(req: CloudClassifyRequest): Promise<CloudClassifyVerdict>;
}
