import {
  snapshotPermissionInput,
  validatePermissionExecutionPlan,
  type PermissionRuleMatcher,
} from '@mavis/permission';
import type { ChannelPermissionOrigin } from '../channels/permission-bridge.js';
import type { PluginHookPermissionUpdate } from '../permissions/plugin-hook-permission-contracts.js';
import {
  buildLocalPermissionRuleContents,
  readLocalPermissionMode,
  safeJsonStringify,
} from './host-helpers.js';
import { buildPermissionToolDescription } from './routes/permission-request-helpers.js';
import {
  requestLocalPermissionApproval,
  type LocalPermissionRouteContext,
} from './routes/permissions.js';

interface HostedAgentPermissionCapabilitiesHost {
  permissionRouteContext(): LocalPermissionRouteContext;
  supportsInteraction(capability: 'permissionPrompt'): boolean;
}

export interface HostedPermissionChannelContext {
  readonly platform: string;
  readonly chatId: string;
  readonly clientName?: string;
  readonly threadId?: string;
}

/** Adapts v1 permission policy and approval ownership for hosted v2 Agent Turns. */
export function createHostedAgentPermissionCapabilities(
  host: HostedAgentPermissionCapabilitiesHost,
) {
  return {
    executionPlans: {
      snapshotInput: snapshotPermissionInput,
      validate: validatePermissionExecutionPlan,
    },
    decisions: {
      check: async (input: {
        readonly sessionId: string;
        readonly agentName: string;
        readonly toolName: string;
        readonly toolInput: Readonly<Record<string, unknown>>;
        readonly permissionMode?: 'default' | 'auto' | 'bypassPermissions' | 'off';
        readonly trustedExactWritePaths?: readonly string[];
        readonly sessionOwnedReadablePaths?: readonly string[];
        readonly nativeDeleteSnapshot?: boolean;
      }) => {
        const ctx = host.permissionRouteContext();
        const decision = await ctx.permissionService.checkPermission({
          toolName: input.toolName,
          input: { ...input.toolInput },
          agentName: input.agentName,
          sessionId: input.sessionId,
          permissionModeOverride:
            input.permissionMode ?? readLocalPermissionMode(ctx.configGetter().permissionMode),
          trustedExactWritePaths: [...(input.trustedExactWritePaths ?? [])],
          sessionOwnedReadablePaths: [...(input.sessionOwnedReadablePaths ?? [])],
          ...(input.nativeDeleteSnapshot !== undefined
            ? { nativeDeleteSnapshot: input.nativeDeleteSnapshot }
            : {}),
        });
        if (decision.behavior === 'deny') {
          return { behavior: 'deny' as const, reason: decision.reason };
        }
        if (decision.behavior === 'allow') {
          return {
            behavior: 'allow' as const,
            reason: decision.reason,
            ...(decision.executionPlan ? { executionPlan: decision.executionPlan } : {}),
          };
        }
        const ruleMatchers = normalizeHostedPermissionRuleMatchers(decision.ruleMatchers);
        return {
          behavior: 'ask' as const,
          reason: decision.reason,
          ...(decision.ruleContents ? { ruleContents: decision.ruleContents } : {}),
          ...(ruleMatchers ? { ruleMatchers } : {}),
          ...(decision.executionPlan ? { executionPlan: decision.executionPlan } : {}),
          ...(decision.hookAutoApprovalEligible === true ? { hookAutoApprovalEligible: true } : {}),
        };
      },
    },
    approval: {
      request: (input: {
        readonly sessionId: string;
        readonly turnId: string;
        readonly agentName: string;
        readonly toolName: string;
        readonly toolInput: Readonly<Record<string, unknown>>;
        readonly reason: string;
        readonly ruleContents: readonly string[];
        readonly ruleMatchers?: readonly import('@mavis/permission').PermissionRuleMatcher[];
        /** Trusted outer run_code identity for a PTC child approval. */
        readonly parentToolCallId?: string;
        /** User-visible outer run_code description for the approval surface. */
        readonly parentToolDescription?: string;
        /** A deny ends this PTC program, never the whole Turn. */
        readonly stopPtcOnDeny?: boolean;
        readonly signal?: AbortSignal;
        readonly channelContext?: HostedPermissionChannelContext;
      }) => {
        if (!host.supportsInteraction('permissionPrompt')) {
          return Promise.reject(
            new Error(
              'HOST_CAPABILITY_UNAVAILABLE: this Runtime host cannot prompt for permission.',
            ),
          );
        }
        const origin = permissionOrigin(input.channelContext);
        return requestLocalPermissionApproval(
          host.permissionRouteContext(),
          {
            sessionId: input.sessionId,
            agentName: input.agentName,
            turnId: input.turnId,
            toolName: input.toolName,
            toolInput: safeJsonStringify(input.toolInput),
            toolDescription: buildPermissionToolDescription(input.toolInput),
            ruleContents:
              input.ruleContents.length > 0
                ? [...input.ruleContents]
                : buildLocalPermissionRuleContents(input.toolName, input.toolInput),
            ...(input.ruleMatchers ? { ruleMatchers: input.ruleMatchers } : {}),
            persistWholeToolRuleOnReply: true,
            reason: input.reason,
            ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
            ...(input.parentToolDescription
              ? { parentToolDescription: input.parentToolDescription }
              : {}),
            ...(input.stopPtcOnDeny ? { stopPtcOnDeny: true } : {}),
            ...(origin ? { origin } : {}),
          },
          input.signal,
        );
      },
    },
    mutations: {
      applyAtomic: async (input: {
        readonly sessionId: string;
        readonly cwd: string;
        readonly updates: readonly PluginHookPermissionUpdate[];
        readonly signal?: AbortSignal;
      }) => {
        if (input.signal?.aborted) throw abortPermissionMutation(input.signal.reason);
        await host.permissionRouteContext().permissionService.applyPluginHookPermissionUpdates({
          sessionId: input.sessionId,
          cwd: input.cwd,
          updates: input.updates,
        });
      },
      clearSession: async (sessionId: string) => {
        await host
          .permissionRouteContext()
          .permissionService.clearPluginHookSessionPermissions(sessionId);
      },
    },
  } as const;
}

type HostedPermissionRuleMatcher =
  | { readonly kind: 'tool' }
  | { readonly kind: 'command'; readonly pattern: string }
  | {
      readonly kind: 'path';
      readonly pattern: string;
      readonly actions: readonly ('read' | 'write' | 'delete' | 'execute' | 'network')[];
    };

function normalizeHostedPermissionRuleMatchers(
  matchers: readonly PermissionRuleMatcher[] | undefined,
): readonly HostedPermissionRuleMatcher[] | undefined {
  if (!matchers) return undefined;
  const normalized: HostedPermissionRuleMatcher[] = [];
  for (const matcher of matchers) {
    if (matcher.kind === 'tool') {
      normalized.push({ kind: 'tool' });
    } else if (matcher.kind === 'command') {
      normalized.push({ kind: 'command', pattern: matcher.pattern });
    } else {
      if (!matcher.actions?.length) return undefined;
      normalized.push({ kind: 'path', pattern: matcher.pattern, actions: [...matcher.actions] });
    }
  }
  return normalized;
}

function abortPermissionMutation(reason: unknown): Error {
  const error = new Error(
    typeof reason === 'string' && reason ? reason : 'Plugin Hook permission update was aborted.',
  );
  error.name = 'AbortError';
  return error;
}

function permissionOrigin(
  channelContext: HostedPermissionChannelContext | undefined,
): ChannelPermissionOrigin | undefined {
  if (
    !channelContext?.platform.trim() ||
    !channelContext.clientName?.trim() ||
    !channelContext.chatId.trim()
  ) {
    return undefined;
  }
  return {
    platform: channelContext.platform,
    clientName: channelContext.clientName,
    chatId: channelContext.chatId,
    ...(channelContext.threadId?.trim() ? { threadId: channelContext.threadId } : {}),
  };
}
