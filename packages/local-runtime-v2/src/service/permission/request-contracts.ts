import type { PermissionRuleMatcher } from '@mavis/permission';
import type { GlobalEventPayloadMap } from '@mavis/shared/global-events';

// ─── Permission enums + request types ──────────────────────────────────
export type LocalPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'auto' | 'off';

export type LocalPermissionDecision = 'allowAlways' | 'allowOnce' | 'deny';

export interface LocalPermissionRequest {
  requestId: string;
  sessionId: string;
  turnId: string;
  agentName: string;
  toolName: string;
  ruleContents: string[];
  ruleMatchers?: readonly PermissionRuleMatcher[];
  persistWholeToolRuleOnReply?: boolean;
  toolInput?: string;
  toolDescription?: string;
  parentToolCallId?: string;
  parentToolDescription?: string;
  stopPtcOnDeny?: boolean;
  reason: string;
  createdAt: number;
  /**
   * In-process waiters sharing this pending request (fingerprint dedupe). A
   * reply settles all of them at once; a single waiter's abort settles only
   * that waiter.
   */
  waiters: Set<LocalPermissionRequestWaiter>;
  /** Set once `permission.ask` was actually emitted — an already-aborted
   * signal removes the record before announce, and such never-shown asks
   * must not contribute `permission_ask_wait_ms` samples. */
  announced?: boolean;
  resolve(decision: LocalPermissionDecision): void;
  cleanup(): void;
}

export interface LocalPermissionRequestWaiter {
  settle(decision: LocalPermissionDecision): void;
  detach(): void;
}

export function readPermissionDecision(
  data: Record<string, unknown>,
): LocalPermissionDecision | undefined {
  const value = data.decision;
  if (typeof value !== 'string') return undefined;
  const aliases: Record<string, LocalPermissionDecision> = {
    allow: 'allowOnce',
    'allow-always': 'allowAlways',
    'allow-for-agent': 'allowOnce',
    allowForAgent: 'allowOnce',
    allowAlways: 'allowAlways',
    allowOnce: 'allowOnce',
    deny: 'deny',
  };
  return aliases[value];
}

export function readLocalPermissionMode(value: unknown): LocalPermissionMode {
  return value === 'default' ||
    value === 'acceptEdits' ||
    value === 'bypassPermissions' ||
    value === 'auto' ||
    value === 'off'
    ? value
    : 'auto';
}

export function serializePermissionRequest(
  item: LocalPermissionRequest,
): GlobalEventPayloadMap['permission.ask'] {
  return {
    requestId: item.requestId,
    sessionId: item.sessionId,
    turnId: item.turnId,
    agentName: item.agentName,
    toolName: item.toolName,
    ruleContents: item.ruleContents,
    ...(item.toolInput ? { toolInput: item.toolInput } : {}),
    ...(permissionToolDescription(item)
      ? { toolDescription: permissionToolDescription(item) }
      : {}),
    ...(item.parentToolCallId ? { parentToolCallId: item.parentToolCallId } : {}),
    ...(item.parentToolDescription ? { parentToolDescription: item.parentToolDescription } : {}),
    ...(item.stopPtcOnDeny ? { stopPtcOnDeny: true } : {}),
    reason: permissionReason(item),
    allowAlwaysSupported: item.ruleContents.length > 0 || item.persistWholeToolRuleOnReply === true,
    createdAt: item.createdAt,
  };
}

function permissionToolDescription(item: LocalPermissionRequest): string | undefined {
  return item.parentToolDescription ? `PTC: ${item.parentToolDescription}` : item.toolDescription;
}

function permissionReason(item: LocalPermissionRequest): string {
  return item.parentToolCallId ? `来自 PTC：${item.reason}` : item.reason;
}

/** Permission request protocol consumed by Channel delivery. */
/**
 * Outbound hook invoked synchronously when a `permission.ask` is recorded.
 * Permissions facade / routes call this through the `LocalPermissionRouteContext`.
 */
export interface ChannelPermissionOutboundPort {
  onPermissionAsk(event: ChannelPermissionAskEvent): Promise<void>;
}

/** @internal Exported only for focused tests. */
export interface ChannelPermissionAskEvent {
  requestId: string;
  sessionId: string;
  agentName: string | null;
  request: ChannelPermissionRequestSnapshot;
  /**
   * The IM conversation whose inbound message started the current turn.
   * Absent for desktop/UI-initiated turns — those must never fan the card
   * out to IM bindings (the desktop `permission.ask` Global Event covers them).
   */
  origin?: ChannelPermissionOrigin;
}

/**
 * Identifies the originating IM conversation of a turn. Matches the channel
 * context coordinates; compared exactly against bindings so a WeChat-initiated
 * ask never renders to a Feishu binding bound to the same session.
 */
export interface ChannelPermissionOrigin {
  platform: string;
  clientName: string;
  chatId: string;
  /**
   * Thread/topic the originating inbound message lived in (Telegram forum
   * topic / Feishu thread). Delivery metadata ONLY — binding matching stays
   * on `platform + clientName + chatId`; when present it overrides the
   * binding's own threadId so the card renders inside the originating thread.
   */
  threadId?: string;
}

/**
 * Trimmed view of a `LocalPermissionRequest` carried into the bridge. We do
 * not import `LocalPermissionRequest` to avoid pulling the route-layer type
 * into the channel contract.
 */
interface ChannelPermissionRequestSnapshot {
  requestId: string;
  sessionId: string;
  agentName: string;
  toolName: string;
  toolDescription?: string;
  toolInput?: string;
  reason: string;
  ruleContents: string[];
  createdAt: number;
}

export type ChannelPermissionBehavior = 'allow' | 'deny' | 'always';
