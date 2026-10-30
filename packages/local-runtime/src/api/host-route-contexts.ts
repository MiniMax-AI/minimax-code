/**
 * Route context builders extracted from `host.ts` to keep that file under the
 * 2000-line hook ceiling. These build the per-route plumbing objects passed
 * into local service and route adapters.
 *
 * Each builder takes a tiny structural handle over the host class so this
 * file does not import `LocalRuntimeApiHost` directly (which would create a
 * cycle). The host calls every builder with `this`; the structural typing
 * keeps the contract explicit without ballooning the surface area.
 */

import type { LocalPermissionApprovalService } from './local-permission-approval-service.js';
import type { LocalPermissionRouteContext } from './routes/permissions.js';
import type { LocalQuestionnaireServiceDeps } from '../questionnaire/service.js';
import type { QuestionnaireAutoReplyScheduler } from '../questionnaire/auto-reply-scheduler.js';
import type { MetricsClient } from '../common/metrics.js';
import { resolveLocalPermissionService } from '../permissions/service.js';
import type { LocalPermissionHostHandle as PermHostHandle } from '../permissions/service.js';
import type { GlobalEventPublisher } from '../events/global-events.js';
import type { RuntimeConversation } from '@mavis/conversation-contract';
import type { ThreadGoalState } from '@mavis/goal';
import type { LocalAgentRuntimePort } from '../agent/runtime-port.js';
// preview_train read this from the v1 agent templates module, which the Agent
// cutover deletes. `resolveLocalRuntimeLocale` is the surviving byte-identical
// implementation.
import { resolveLocalRuntimeLocale } from '../runtime/locale.js';

/**
 * Structural surface every builder reads off the host. Declared as one wide
 * type and narrowed per-builder so the host's `this` satisfies all three with
 * a single call site (no four separate casts).
 */
export interface RouteContextHostHandle {
  // ---- shared
  agentName: string;
  nowMs: () => number;
  configGetter: () => { dataDir: string } & Record<string, unknown>;
  emitBusEvent(type: string, payload: Record<string, unknown>): void;
  publishGlobalEvent: GlobalEventPublisher;
  getSessionById(sessionId: string): Promise<unknown>;

  agentRuntimePort: LocalAgentRuntimePort;

  // ---- permission
  permissionRules: unknown;
  permissionApprovalService: LocalPermissionApprovalService;
  channelPermissionBridge: unknown;
  metricsClient?: MetricsClient;

  // ---- questionnaire
  questionnaireStore: unknown;
  questionnaireAutoReplyScheduler: QuestionnaireAutoReplyScheduler;
  /**
   * Decision v3 ask_user suppression probe, late-bound by the V2 runtime once
   * its Turn system exists. True while the session's active Turn holds
   * unconsumed user steering; absent on V1-only hosts (never suppress).
   */
  hasPendingUserSteeringProbe?: (sessionId: string) => Promise<boolean> | boolean;
  threadGoal: {
    store: { getBySession(sessionId: string): Promise<ThreadGoalState | undefined> };
  };
  runtimeConversation?: RuntimeConversation;
  /**
   * Optional: deliver an ask_user questionnaire record to whatever IM
   * channel the originating session is bound to. The host owns the
   * binding lookup + adapter dispatch; this builder simply forwards the
   * hook so `LocalQuestionnaireService.begin` can fire it after persist.
   */
  deliverQuestionnaireAskToChannel?(record: unknown): void | Promise<void>;
}

export type QuestionnaireOwnedActionBindingArgs = readonly [
  ownedActionHandler: NonNullable<LocalQuestionnaireServiceDeps['ownedActionHandler']>,
  onFailure?: NonNullable<LocalQuestionnaireServiceDeps['onOwnedActionFailure']>,
];

export type QuestionnaireRequestAdmissionBindingArgs = readonly [
  requestAdmission: NonNullable<LocalQuestionnaireServiceDeps['requestAdmission']>,
];

interface QuestionnaireOwnedActionBinding {
  readonly ownedActionHandler: NonNullable<LocalQuestionnaireServiceDeps['ownedActionHandler']>;
  readonly onFailure?: NonNullable<LocalQuestionnaireServiceDeps['onOwnedActionFailure']>;
}

const questionnaireOwnedActionBindings = new WeakMap<object, QuestionnaireOwnedActionBinding>();
const questionnaireRequestAdmissionBindings = new WeakMap<
  object,
  NonNullable<LocalQuestionnaireServiceDeps['requestAdmission']>
>();

export function createQuestionnaireOwnedActionBinder(
  host: object,
): (...args: QuestionnaireOwnedActionBindingArgs) => void {
  return (...[ownedActionHandler, onFailure]) => {
    questionnaireOwnedActionBindings.set(host, {
      ownedActionHandler,
      ...(onFailure ? { onFailure } : {}),
    });
  };
}

export function createQuestionnaireRequestAdmissionBinder(
  host: object,
): (...args: QuestionnaireRequestAdmissionBindingArgs) => void {
  return (...[requestAdmission]) => {
    questionnaireRequestAdmissionBindings.set(host, requestAdmission);
  };
}

export function buildPermissionRouteContext(
  host: RouteContextHostHandle,
): LocalPermissionRouteContext {
  return {
    agentName: host.agentName,
    configGetter: host.configGetter as never,
    nowMs: host.nowMs,
    permissionRules: host.permissionRules as never,
    permissionService: resolveLocalPermissionService(host as unknown as PermHostHandle),
    approvalService: host.permissionApprovalService,
    publishGlobalEvent: (event) => host.publishGlobalEvent(event),
    channelPermissionOutbound: host.channelPermissionBridge as never,
    metricsClient: host.metricsClient,
  };
}

export function buildQuestionnaireServiceDeps(
  host: RouteContextHostHandle,
): LocalQuestionnaireServiceDeps {
  const deps: LocalQuestionnaireServiceDeps = {
    store: host.questionnaireStore as never,
    nowMs: host.nowMs,
    primaryAgentName: host.agentName,
    configGetter: host.configGetter as never,
    getSessionById: (sessionId: string) => host.getSessionById(sessionId) as never,
    ...(host.runtimeConversation ? { conversation: host.runtimeConversation } : {}),
    emitBusEvent: (type: string, payload: Record<string, unknown>) =>
      host.emitBusEvent(type, payload),
    publishGlobalEvent: (event) => host.publishGlobalEvent(event),
    resolveLocale: () => resolveLocalRuntimeLocale(),
    resolveGoal: async (sessionId) => {
      const goal = await host.threadGoal.store.getBySession(sessionId);
      return goal ? { goalId: goal.goalId, status: goal.status } : undefined;
    },
    autoReplyScheduler: host.questionnaireAutoReplyScheduler,
    hasPendingUserSteering: (sessionId: string) =>
      host.hasPendingUserSteeringProbe?.(sessionId) ?? false,
    // Drives the queue drain after a questionnaire dismiss so messages the
    // user enqueued while the ask_user card was pending get promoted instead
    // of stalling in SQLite. Dismiss injects no synthetic turn by design
    // ("close is silent"), so nothing else kicks the queue. v1 fanned this out
    // through `host.notifySessionTurnFinished`, which died with the v1 Session
    // routes — kick the surviving owner's ingress directly, the same port
    // `thread-goal/kickoff-host.ts` uses. Left undefined for headless callers
    // with no conversation wired.
    ...(host.runtimeConversation
      ? {
          notifySessionTurnFinished: (sessionId: string) => {
            void host.runtimeConversation?.ingress.dispatchQueue(sessionId).catch(() => {
              // Best-effort drain: a failed kick must never fail the dismiss.
            });
          },
        }
      : {}),
    ...(host.deliverQuestionnaireAskToChannel
      ? {
          onQuestionnaireAsk: (record) => host.deliverQuestionnaireAskToChannel!(record),
        }
      : {}),
  };
  Object.defineProperty(deps, 'requestAdmission', {
    enumerable: true,
    get: () => questionnaireRequestAdmissionBindings.get(host),
  });
  // Long-lived facades (Electron/TUI/CLI/app-server peripheral questionnaires)
  // are assembled before Plan registers its owner. Resolve both the handler and
  // its recovery hook at use time so a live reply reaches the owning workflow
  // instead of waiting for startup reconciliation.
  Object.defineProperties(deps, {
    ownedActionHandler: {
      enumerable: true,
      get: () => questionnaireOwnedActionBindings.get(host)?.ownedActionHandler,
    },
    onOwnedActionFailure: {
      enumerable: true,
      get: () => questionnaireOwnedActionBindings.get(host)?.onFailure,
    },
  });
  return deps;
}
