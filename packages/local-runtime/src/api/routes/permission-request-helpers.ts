import type { LocalPermissionRequest } from '../host-helpers.js';
import type { ChannelPermissionOrigin } from '../../channels/permission-bridge.js';
import type { PermissionRuleMatcher } from '@mavis/permission';

export interface LocalPermissionRequestInput {
  sessionId: string;
  agentName: string;
  turnId: string;
  toolName: string;
  toolInput?: string;
  /**
   * Human-readable description for the permission card. Mirrors v1
   * `service.ts:431` — read from `input.description` when present, undefined
   * otherwise. Falls back to `toolName` only when the caller passes nothing,
   * so the Global Event / GET /permission/requests payload keeps v1 wire shape.
   */
  toolDescription?: string;
  /** PTC parent metadata for modern Desktop permission presentation. */
  parentToolCallId?: string;
  parentToolDescription?: string;
  /** A user denial stops this PTC program only. */
  stopPtcOnDeny?: boolean;
  ruleContents: string[];
  /** Structured matchers aligned 1:1 with ruleContents for v2 persistence. */
  ruleMatchers?: readonly PermissionRuleMatcher[];
  persistWholeToolRuleOnReply?: boolean;
  reason: string;
  /** Exact IM conversation that initiated the hosted Turn, when applicable. */
  origin?: ChannelPermissionOrigin;
}

export function findPendingLocalPermissionRequest(
  pendingPermissionRequests: Map<string, LocalPermissionRequest>,
  input: LocalPermissionRequestInput,
): LocalPermissionRequest | undefined {
  const fingerprint = localPermissionRuleContentsFingerprint(
    input.ruleContents,
    input.ruleMatchers,
  );
  for (const item of pendingPermissionRequests.values()) {
    if (
      item.sessionId === input.sessionId &&
      item.toolName === input.toolName &&
      item.agentName === input.agentName &&
      item.parentToolCallId === input.parentToolCallId &&
      localPermissionRuleContentsFingerprint(item.ruleContents, item.ruleMatchers) === fingerprint
    ) {
      return item;
    }
  }
  return undefined;
}

function localPermissionRuleContentsFingerprint(
  ruleContents: readonly string[],
  ruleMatchers?: readonly PermissionRuleMatcher[],
): string {
  const candidates = ruleContents.map((ruleContent, index) =>
    JSON.stringify({ ruleContent, matcher: ruleMatchers?.[index] }),
  );
  return JSON.stringify(candidates.sort());
}

/**
 * Derive the v1-style `toolDescription` from a tool call's input record.
 * Mirrors `agent-core` v1 `service.ts:431`:
 *   `typeof input.description === 'string' ? input.description : undefined`.
 *
 * Returning undefined lets the registration site decide how to render the
 * card subtitle (currently `input.toolDescription ?? input.toolName`).
 */
export function buildPermissionToolDescription(input: Record<string, unknown>): string | undefined {
  const desc = input.description;
  return typeof desc === 'string' ? desc : undefined;
}
