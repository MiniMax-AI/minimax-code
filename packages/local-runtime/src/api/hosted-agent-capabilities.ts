import { join } from 'node:path';

import { AuthStorage } from '@earendil-works/pi-coding-agent/auth-storage';
import type {
  PiLLMRequestFailureHook,
  PiLLMRequestObserver,
} from '@mavis/agent-core/pi-turn-runner';
import { resolveAgentCapabilities, type AgentBuiltinSkillId } from '@mavis/config';
import type { IRuntimeEvent } from '@mavis/protocol';

import { createChildBashLifecycle } from '../background-task/child-bash-lifecycle.js';
import { isLocalChildWorkerSession } from '../sessions/session-policy.js';
import { createHostedBackgroundReminderCapabilities } from '../background-task/hosted-reminder-capabilities.js';
import type { LocalBackgroundTaskService } from '../background-task/service.js';
import type { MetricsClient } from '../common/metrics.js';
import type { LocalRuntimeConfig } from '../config/types.js';
import { HttpRemoteTokenCounter } from '../context/remote-token-counter.js';
import type { ContentSafetyChecker } from '../content-safety/api.js';
import { createHostedAgentContextUsageCapabilities } from '../context/hosted-agent-context-usage-capabilities.js';
import type { LocalHookService } from '../hooks/api.js';
import type { LocalDataCollector } from '../memory/local-data-collector.js';
import type { LocalMemoryFacade } from '../memory/local-memory-facade.js';
import { recordMemorySessionTerminal } from '../memory/local-memory-orchestration.js';
import type { LocalRuntimeAuthContext } from '../runtime/model-resolver.js';
import type { DesktopTurnCapabilityView } from '../runtime/desktop-turn-capabilities.js';
import type { LocalRuntimeRoutingContext } from '../runtime/routing-headers.js';
import { PI_TURN_RUNNER_LOGGER } from '../runtime/pi-turn-observability.js';
import type { LocalSkillService } from '../skills/skill-service.js';
import type { LocalTurnFileChangeCaptureService } from '../turns/file-changes.js';
import {
  createWebsiteDeployAfterLlmHook,
  createWebsiteDeployAfterToolCallHook,
  WebsiteDeployTurnState,
} from '../website-deploy/index.js';
import { projectWebsiteDeployRuntimeEvent } from '../website-deploy/projection-writer.js';
import { prepareDeployedSources } from '../website-management/deployed-website-source.js';
import { createHostedAttachmentCapabilities } from './hosted-agent-attachments.js';
import { toLocalSessionRecord, type HostedSessionSnapshot } from './hosted-agent-session.js';
import { createHostedTurnRuntimeFactSource } from './hosted-agent-turn-runtime-facts.js';
import { applyHostedCapabilityRestrictions } from './hosted-agent-capability-restrictions.js';
import type { LocalSystemReminderService } from './host-memory.js';
import type { BuildOwnerTurnToolSourcesInput, OwnerTurnToolSources } from './host-turn-tools.js';
import { createHostedAgentPermissionCapabilities } from './hosted-agent-permission-capabilities.js';
import type { LocalPermissionRouteContext } from './routes/permissions.js';
import type {
  HostedTurnBudgetCheckInput,
  HostedTurnBudgetCheckResult,
  HostedTurnLifecycleInput,
  HostedTurnSettlementInput,
} from './hosted-agent-turn-lifecycle.js';
import type { RuntimeConversation } from '@mavis/conversation-contract';
import type { InternalTurnPromptReadRegistry, PromptSnapshotSource } from '@mavis/agent-core';
import { HostedReviewCapability } from '../review/hosted-capability.js';
import { resolveBuiltinReviewPromptDir } from '../review/preparation.js';
import { classifyThreadGoalFailure } from '../thread-goal/failure-classification.js';
import { createHostedSkillCapabilities } from './hosted-agent-skill-capabilities.js';

export type { HostedContextUsageAttemptInput } from '../context/hosted-agent-context-usage-capabilities.js';
export type {
  HostedAttachmentInput,
  HostedRegisteredAttachment,
} from './hosted-agent-attachments.js';

export { toLocalSessionRecord, type HostedSessionSnapshot } from './hosted-agent-session.js';
export type {
  HostedTurnBudgetCheckInput,
  HostedTurnBudgetCheckResult,
  HostedTurnLifecycleInput,
  HostedTurnSettlementInput,
} from './hosted-agent-turn-lifecycle.js';

export interface HostedAgentCapabilitiesHost {
  readonly reviewPromptDir?: string;
  readonly agentName: string;
  readonly configGetter: () => LocalRuntimeConfig;
  readonly authContextGetter: (() => LocalRuntimeAuthContext | undefined) | undefined;
  readonly authContextInvalidator:
    | ((rejectedAccessToken?: string, loginEpoch?: string) => void | Promise<void>)
    | undefined;
  readonly routingContextGetter?: () => LocalRuntimeRoutingContext | undefined;
  readonly skillService: LocalSkillService;
  readonly memoryFacade: LocalMemoryFacade;
  readonly mcpService: { isBuiltinMatrixAvailable(): boolean };
  readonly localDataCollector: Pick<LocalDataCollector, 'toSessionInfo' | 'toMessage'>;
  readonly systemReminderService: Pick<LocalSystemReminderService, 'buildReminder'>;
  readonly backgroundTaskService: Pick<
    LocalBackgroundTaskService,
    | 'reminderSnapshot'
    | 'markDelivered'
    | 'captureCheckpointSnapshot'
    | 'list'
    | 'stop'
    | 'waitForTaskChange'
  >;
  readonly hookService: Pick<LocalHookService, 'beforeToolCall' | 'afterToolCall'>;
  readonly contentSafetyChecker: ContentSafetyChecker;
  readonly turnFileChanges: Pick<
    LocalTurnFileChangeCaptureService,
    'begin' | 'finalizeLatestPending' | 'markPendingFailed' | 'takeToolArtifactProgress'
  >;
  readonly metricsClient: MetricsClient | undefined;
  readonly isContextWindowUsageEnabled: () => boolean;
  readonly fetchImpl: typeof fetch | undefined;
  readonly llmRequestFailureHook?: PiLLMRequestFailureHook;
  readonly observeLLMRequest?: PiLLMRequestObserver;
  readonly runtimeConversation: RuntimeConversation | undefined;
  readonly nowMs: () => number;
  getPromptSnapshots(): PromptSnapshotSource | undefined;
  getInternalTurnPromptReads(): InternalTurnPromptReadRegistry | undefined;
  emitBusEvent(type: string, payload: Record<string, unknown>): void;
  buildOwnerTurnToolSources(input: BuildOwnerTurnToolSourcesInput): Promise<OwnerTurnToolSources>;
  permissionRouteContext(): LocalPermissionRouteContext;
  supportsInteraction(capability: 'permissionPrompt'): boolean;
  reportPiTurnFailure(sessionId: string, message: string): void;
  beginHostedTurn(input: HostedTurnLifecycleInput): void;
  checkHostedTurnBudget(input: HostedTurnBudgetCheckInput): Promise<HostedTurnBudgetCheckResult>;
  settleHostedTurn(input: HostedTurnSettlementInput): Promise<void>;
  abandonHostedTurn(input: HostedTurnLifecycleInput): void;
}

export type HostedAgentCapabilities = ReturnType<typeof createHostedAgentCapabilities>;

export interface HostedAgentCapabilityRestrictions {
  readonly disableMemory?: boolean;
  readonly disableCron?: boolean;
  readonly disableComputerUse?: boolean;
  readonly disableMavis?: boolean;
  readonly disabledBuiltinSkillNames?: readonly AgentBuiltinSkillId[];
  readonly resumeCodexAvailable?: boolean;
}

/**
 * Narrow, immutable v1 capability bundle consumed by the v2 composition root.
 * It exposes product-owned facts and adapters, never the v1 Host itself.
 */
export function createHostedAgentCapabilities(
  host: HostedAgentCapabilitiesHost,
  restrictions: HostedAgentCapabilityRestrictions = {},
) {
  const review = new HostedReviewCapability({
    reviewPromptDir: host.reviewPromptDir ?? resolveBuiltinReviewPromptDir(),
    configGetter: host.configGetter,
    ...(host.runtimeConversation ? { conversation: host.runtimeConversation } : {}),
    ...(host.metricsClient ? { metricsClient: host.metricsClient } : {}),
    remoteCounter: new HttpRemoteTokenCounter({
      timeoutMs: 3_000,
      ...(host.fetchImpl ? { fetchFn: host.fetchImpl } : {}),
    }),
    nowMs: host.nowMs,
    promptSnapshots: () => host.getPromptSnapshots(),
    internalTurnPromptReads: () => host.getInternalTurnPromptReads(),
  });
  const turnRuntimeFacts = createHostedTurnRuntimeFactSource({
    configGetter: host.configGetter,
    disableComputerUse: restrictions.disableComputerUse === true,
  });
  return {
    config: host.configGetter,
    runnerLogger: PI_TURN_RUNNER_LOGGER,
    llmRequestFailureHook: host.llmRequestFailureHook,
    observeLLMRequest: host.observeLLMRequest,
    authContextGetter: host.authContextGetter,
    authContextInvalidator: host.authContextInvalidator,
    routingContextGetter: host.routingContextGetter,
    fetchImpl: host.fetchImpl,
    providerAuthGetter: (provider: string) =>
      AuthStorage.create(join(host.configGetter().dataDir, 'codex-auth.json')).getApiKey(provider, {
        includeFallback: false,
      }),
    turnRuntimeFacts,
    skills: createHostedSkillCapabilities(host, restrictions),
    memory: host.memoryFacade,
    toolSources: {
      resolve: (input: {
        readonly session: HostedSessionSnapshot;
        readonly turnId: string;
        readonly resourceAgentName: string;
        readonly excludeAgentResources?: boolean;
        readonly expectedAgentInstanceId?: string;
        readonly skipAgentResolution?: boolean;
        readonly builtinCapabilities?: Parameters<
          HostedAgentCapabilitiesHost['buildOwnerTurnToolSources']
        >[0]['builtinCapabilities'];
        readonly toolsDisabled: boolean;
        readonly cuModeActive: boolean;
        readonly agentMemoryEnabled?: boolean;
        readonly agentMemoryReadNames?: readonly string[];
        readonly allowedSkillNames?: readonly string[];
        readonly allowedExtensionSkillNames?: readonly string[];
        readonly miniappAvailable?: boolean;
        readonly desktopCapabilities?: DesktopTurnCapabilityView;
      }) => {
        const builtinCapabilities = applyHostedCapabilityRestrictions(
          input.builtinCapabilities ?? resolveAgentCapabilities(),
          restrictions,
        );
        const memoryGloballyEnabled =
          !restrictions.disableMemory && host.configGetter().memory?.enabled !== false;
        const memoryReadEnabled =
          memoryGloballyEnabled && input.session.memoryPolicy?.recallEnabled !== false;
        const memoryWriteEnabled =
          memoryGloballyEnabled && input.session.memoryPolicy?.writeEnabled !== false;
        return host.buildOwnerTurnToolSources({
          session: toLocalSessionRecord(input.session),
          resourceAgentName: input.resourceAgentName,
          ...(input.excludeAgentResources ? { excludeAgentResources: true } : {}),
          ...(input.expectedAgentInstanceId
            ? { expectedAgentInstanceId: input.expectedAgentInstanceId }
            : {}),
          ...(input.skipAgentResolution ? { skipAgentResolution: true } : {}),
          builtinCapabilities,
          toolsDisabled: input.toolsDisabled,
          memoryEnabled: memoryGloballyEnabled,
          memoryReadEnabled,
          memoryWriteEnabled,
          ...(input.agentMemoryEnabled === undefined
            ? {}
            : { memoryAgentScopeEnabled: input.agentMemoryEnabled }),
          ...(input.agentMemoryReadNames === undefined
            ? {}
            : { memoryReadAgentNames: input.agentMemoryReadNames }),
          ...(input.allowedSkillNames === undefined
            ? {}
            : { allowedSkillNames: input.allowedSkillNames }),
          ...(input.allowedExtensionSkillNames === undefined
            ? {}
            : { allowedExtensionSkillNames: input.allowedExtensionSkillNames }),
          cronEnabled: !restrictions.disableCron,
          ...(restrictions.disabledBuiltinSkillNames
            ? { disabledBuiltinSkillNames: restrictions.disabledBuiltinSkillNames }
            : {}),
          ...(restrictions.resumeCodexAvailable === true ? { resumeCodexAvailable: true } : {}),
          cuModeActive: !restrictions.disableComputerUse && input.cuModeActive,
          ...(input.miniappAvailable === true ? { miniappAvailable: true } : {}),
          ...(input.desktopCapabilities ? { desktopCapabilities: input.desktopCapabilities } : {}),
        });
      },
    },
    review,
    websiteDeploy: {
      materializeSources: (input: {
        readonly content: string;
        readonly workspaceDir: string;
        readonly signal: AbortSignal;
      }) =>
        prepareDeployedSources(
          {
            authContextGetter: host.authContextGetter,
            routingContextGetter: host.routingContextGetter,
            fetchImpl: host.fetchImpl,
          },
          { content: input.content, signal: input.signal },
          input.workspaceDir,
        ),
      createTurnProjection: () => {
        const state = new WebsiteDeployTurnState();
        return {
          projectRuntimeEvent: (event: IRuntimeEvent) =>
            projectWebsiteDeployRuntimeEvent(event, state),
          afterToolCallHook: createWebsiteDeployAfterToolCallHook(state),
          afterLlmCallHook: createWebsiteDeployAfterLlmHook(state),
        } as const;
      },
    },
    createChildBashLifecycle: (input: {
      readonly session: Pick<
        HostedSessionSnapshot,
        'sessionId' | 'sessionKind' | 'sessionType' | 'visibility' | 'parentSessionId' | 'purpose'
      >;
      readonly turnId: string;
      readonly signal: AbortSignal;
    }) =>
      isLocalChildWorkerSession(input.session)
        ? createChildBashLifecycle(host.backgroundTaskService, {
            sessionId: input.session.sessionId,
            turnId: input.turnId,
            signal: input.signal,
          })
        : undefined,
    checkpointState: {
      captureSubagents: (input: { readonly sessionId: string }) =>
        host.backgroundTaskService.captureCheckpointSnapshot(input.sessionId),
    },
    reminders: {
      ...createHostedBackgroundReminderCapabilities(host.backgroundTaskService),
      buildSystem: async (input: {
        readonly session: HostedSessionSnapshot;
        readonly resourceAgentName: string;
        readonly promptText: string;
        readonly turnId: string;
        readonly deferTelemetry?: boolean;
        readonly model?: {
          readonly providerID: string;
          readonly modelID: string;
          readonly variant?: string;
        };
      }) => {
        const session = {
          ...toLocalSessionRecord(input.session),
          agentName: input.resourceAgentName,
        };
        const reminderSession = {
          ...host.localDataCollector.toSessionInfo(session, undefined, {
            recallEnabled: input.session.memoryPolicy?.recallEnabled !== false,
            writeEnabled: input.session.memoryPolicy?.writeEnabled !== false,
          }),
          environmentInSystemPrompt: true,
        };
        const reminderMessage = host.localDataCollector.toMessage(
          input.promptText,
          input.turnId,
          input.model,
        );
        const reminder = input.deferTelemetry
          ? await host.systemReminderService.buildReminder(reminderSession, reminderMessage, {
              deferTelemetry: true,
            })
          : await host.systemReminderService.buildReminder(reminderSession, reminderMessage);
        return {
          content: asSingleReminderBlock(reminder.text),
          ...(reminder.diagnostic !== undefined ? { diagnostic: reminder.diagnostic } : {}),
          ...(reminder.finalizeTelemetry
            ? {
                finalizeTelemetry: (final: {
                  readonly content: string;
                  readonly diagnostic?: unknown;
                }) =>
                  reminder.finalizeTelemetry?.({
                    text: final.content,
                    ...(final.diagnostic !== undefined ? { diagnostic: final.diagnostic } : {}),
                  }),
              }
            : {}),
        };
      },
    },
    attachments: createHostedAttachmentCapabilities(host),
    permissions: createHostedAgentPermissionCapabilities(host),
    hooks: {
      beforeToolCall: (...args: Parameters<LocalHookService['beforeToolCall']>) =>
        host.hookService.beforeToolCall(...args),
      afterToolCall: (...args: Parameters<LocalHookService['afterToolCall']>) =>
        host.hookService.afterToolCall(...args),
    },
    reviewContent: host.contentSafetyChecker,
    fileChanges: {
      begin: async (input: {
        readonly sessionId: string;
        readonly turnId: string;
        readonly agentName: string;
        readonly workspaceDir: string;
      }) => {
        await host.turnFileChanges.begin(
          toLocalSessionRecord({
            sessionId: input.sessionId,
            agentName: input.agentName,
            workspaceDir: input.workspaceDir,
            sessionType: 'branch',
            archived: false,
            status: 'started',
            createdAtMs: host.nowMs(),
            updatedAtMs: host.nowMs(),
          }),
          input.turnId,
        );
      },
      finalize: (input: {
        readonly sessionId: string;
        readonly turnId: string;
        readonly assistantMessageId?: string;
      }) =>
        host.turnFileChanges.finalizeLatestPending(input.sessionId, {
          turnId: input.turnId,
          ...(input.assistantMessageId ? { assistantMessageId: input.assistantMessageId } : {}),
        }),
      markFailed: (input: { readonly sessionId: string; readonly turnId: string }) =>
        host.turnFileChanges.markPendingFailed(input.sessionId, input.turnId),
      takeToolProgress: (input: {
        readonly sessionId: string;
        readonly turnId: string;
        readonly toolCallIds: readonly string[];
      }) => host.turnFileChanges.takeToolArtifactProgress(input),
    },
    turnLifecycle: {
      started: (input: HostedTurnLifecycleInput) => host.beginHostedTurn(input),
      checkBudget: (input: HostedTurnBudgetCheckInput) => host.checkHostedTurnBudget(input),
      classifyFailure: classifyThreadGoalFailure,
      settled: (input: HostedTurnSettlementInput) => host.settleHostedTurn(input),
      abandoned: (input: HostedTurnLifecycleInput) => host.abandonHostedTurn(input),
    },
    terminalMemory: {
      record: (input: {
        readonly sessionId: string;
        readonly turnId: string;
        readonly agentName: string;
        readonly status: 'finished' | 'error' | 'aborted' | 'interrupted';
        readonly errorMessage?: string;
      }) => {
        if (restrictions.disableMemory || host.configGetter().memory?.enabled === false) {
          return Promise.resolve();
        }
        return recordMemorySessionTerminal({
          ...input,
          nowMs: host.nowMs,
          memoryFacade: host.memoryFacade,
          emitBusEvent: (type, payload) => host.emitBusEvent(type, payload),
        });
      },
    },
    ...createHostedAgentContextUsageCapabilities(host),
    reportFailure: (sessionId: string, message: string) =>
      host.reportPiTurnFailure(sessionId, message),
    metricsClient: host.metricsClient,
  } as const;
}

function asSingleReminderBlock(text: string): string {
  const normalized = text
    .trim()
    .replaceAll(/<\s*system-reminder\s*>/giu, '')
    .replaceAll(/<\s*\/\s*system-reminder\s*>/giu, '')
    .trim();
  return normalized ? ['<system-reminder>', normalized, '</system-reminder>'].join('\n') : '';
}
