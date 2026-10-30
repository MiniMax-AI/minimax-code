import type { TuiRuntimeEvent } from '../types/runtime-events.js';
import type { TuiPendingPermission, TuiQuestionnaireRequest } from '../types/runtime-models.js';
import { buildTuiToolPreview } from './tool-preview.js';
import { parseSessionLLMRetryEventPayload } from './llm-retry-event.js';
import type {
  CompactionTokenUsage,
  GlobalThreadGoal,
  GlobalThreadGoalStatusReason,
  GlobalThreadGoalWaitReason,
} from '@mavis/shared/global-events';

export interface RawTuiRuntimeEvent {
  type: string;
  timestamp: number;
  source: string;
  payload: unknown;
}

export function normalizeTuiRuntimeEvent(event: RawTuiRuntimeEvent): TuiRuntimeEvent {
  const payload = isRecord(event.payload) ? event.payload : {};
  const sessionId = readString(payload, ['sessionId', 'session_id']);
  const base = {
    timestampMs: event.timestamp,
    source: event.source,
    ...(sessionId ? { sessionId } : {}),
  };

  if (
    event.type === 'session.start' ||
    event.type === 'session.finish' ||
    event.type === 'session.error' ||
    event.type === 'session.abort' ||
    event.type === 'session.active_run.action'
  ) {
    return compact({
      ...base,
      type: event.type,
      turnId: readString(payload, ['turnId', 'turn_id']),
      taskId: readString(payload, ['taskId', 'task_id']),
      runSource: readString(payload, ['source']),
      queueItemIds: readStringArray(payload, ['queueItemIds', 'queue_item_ids']) ?? [],
      error: readString(payload, ['error']),
      errorCode: readNumber(payload, ['errorCode', 'error_code']),
      errorSource: readString(payload, ['errorSource', 'error_source']),
      errorDetail: readString(payload, ['errorDetail', 'error_detail']),
      errorProviderId: readString(payload, ['errorProviderId', 'error_provider_id']),
    });
  }
  if (event.type === 'session.queue.updated') {
    return compact({
      ...base,
      type: event.type,
      itemId: readString(payload, ['itemId', 'item_id']),
      status: readString(payload, ['status']),
      queuedCount: readNumber(payload, ['queuedCount', 'queued_count']),
      failedReason: readString(payload, ['failedReason', 'failed_reason']),
      reason: readString(payload, ['reason']),
      admissionReason: readString(payload, ['admissionReason', 'admission_reason']),
    });
  }
  if (event.type === 'thread_goal.updated') {
    const goal = readThreadGoal(payload.goal);
    if (goal) {
      return {
        timestampMs: event.timestamp,
        source: event.source,
        type: event.type,
        sessionId: goal.sessionId,
        goal,
      };
    }
  }
  if (event.type === 'thread_goal.cleared') {
    const goalId = readString(payload, ['goalId', 'goal_id']);
    if (sessionId && goalId) return { ...base, type: event.type, sessionId, goalId };
  }
  if (event.type === 'session.llm_retry') {
    const retry = parseSessionLLMRetryEventPayload(payload);
    if (retry) {
      return {
        timestampMs: event.timestamp,
        source: event.source,
        type: event.type,
        sessionId: retry.sessionId,
        turnId: retry.turnId,
        callId: retry.callId,
        scope: retry.scope,
        status: retry.status,
        retryAttempt: retry.retryAttempt,
        maxRetries: retry.maxRetries,
        requestAttempt: retry.requestAttempt,
        ...(retry.delayMs !== undefined ? { delayMs: retry.delayMs } : {}),
        ...(retry.nextRetryAtMs !== undefined ? { nextRetryAtMs: retry.nextRetryAtMs } : {}),
        ...(retry.error
          ? {
              error: {
                reason: retry.error.reason,
                ...(retry.error.code !== undefined ? { code: retry.error.code } : {}),
              },
            }
          : {}),
      };
    }
  }
  if (event.type === 'session.created') {
    const agentName = readString(payload, ['agentName', 'agent_name']);
    const sessionType = readString(payload, ['sessionType', 'session_type']);
    if (sessionId && agentName && (sessionType === 'root' || sessionType === 'branch')) {
      return compact({
        ...base,
        type: event.type,
        agentName,
        sessionType,
        sessionKind: readString(payload, ['sessionKind', 'session_kind']),
        visibility: readSessionVisibility(payload.visibility),
        title: readString(payload, ['title']),
        parentSessionId: readString(payload, ['parentSessionId', 'parent_session_id']),
      });
    }
  }
  if (event.type === 'session.deleted') {
    if (sessionId) {
      return compact({
        ...base,
        type: event.type,
        agentName: readString(payload, ['agentName', 'agent_name']),
      });
    }
  }
  if (event.type === 'session.title_updated') {
    const title = readString(payload, ['title']);
    if (sessionId && title !== undefined) {
      return compact({
        ...base,
        type: event.type,
        title,
        agentName: readString(payload, ['agentName', 'agent_name']),
      });
    }
  }
  if (event.type === 'session.pinned_updated') {
    const pinned = readBoolean(payload, ['pinned']);
    if (sessionId && pinned !== undefined) {
      return compact({
        ...base,
        type: event.type,
        pinned,
        agentName: readString(payload, ['agentName', 'agent_name']),
      });
    }
  }
  if (
    event.type === 'session.compaction.started' ||
    event.type === 'session.compaction.completed' ||
    event.type === 'session.compaction.failed'
  ) {
    const compactionId = readString(payload, ['compactionId', 'compaction_id']);
    if (sessionId && compactionId) {
      return compact({
        ...base,
        type: event.type,
        compactionId,
        messagesBefore: readNumber(payload, ['messagesBefore', 'messages_before']),
        messagesAfter: readNumber(payload, ['messagesAfter', 'messages_after']),
        tokensBefore: readNumber(payload, ['tokensBefore', 'tokens_before']),
        tokensAfter: readNumber(payload, ['tokensAfter', 'tokens_after']),
        tokenUsage: readCompactionTokenUsage(payload.tokenUsage ?? payload.token_usage),
      });
    }
  }
  if (event.type === 'content.retry.exceeded') {
    const variant = readString(payload, ['variant']);
    if (sessionId && (variant === 'content' || variant === 'network' || variant === 'auth')) {
      return compact({
        ...base,
        type: event.type,
        variant,
        lastUserMsgId: readString(payload, ['lastUserMsgId', 'last_user_msg_id']),
      });
    }
  }
  if (event.type === 'message.rewind') {
    if (sessionId) {
      return compact({
        ...base,
        type: event.type,
        contextReset: readBoolean(payload, ['contextReset', 'context_reset']),
      });
    }
  }
  if (event.type === 'turn.prompt_suggestion.generated') {
    const turnId = readString(payload, ['turnId', 'turn_id']);
    const suggestion = readString(payload, ['suggestion'])?.trim();
    if (sessionId && turnId && suggestion) {
      const elapsedMs = payload.elapsedMs ?? payload.elapsed_ms;
      return compact({
        ...base,
        type: event.type,
        sessionId,
        turnId,
        suggestion,
        promptVersion: readString(payload, ['promptVersion', 'prompt_version']),
        elapsedMs: isFiniteNumber(elapsedMs) ? elapsedMs : undefined,
      });
    }
  }
  if (event.type === 'rotation.completed') {
    const agentName = readString(payload, ['agentName', 'agent_name']);
    const oldSessionId = readString(payload, ['oldSessionId', 'old_session_id']);
    const newSessionId = readString(payload, ['newSessionId', 'new_session_id']);
    const reason = readString(payload, ['reason']);
    if (agentName && oldSessionId && newSessionId && reason) {
      return {
        ...base,
        type: event.type,
        agentName,
        oldSessionId,
        newSessionId,
        reason,
      };
    }
  }
  if (event.type === 'questionnaire.ask') {
    const request = normalizeTuiQuestionnaireRequest(payload.request);
    if (request) {
      return compact({
        ...base,
        type: event.type,
        request,
        agentName: readString(payload, ['agentName', 'agent_name']),
      });
    }
  }
  if (event.type === 'questionnaire.dismiss' || event.type === 'questionnaire.superseded') {
    const requestId = readString(payload, ['requestId', 'request_id']);
    if (requestId) return { ...base, type: event.type, requestId };
  }
  if (event.type === 'permission.ask') {
    const request = readPermission(payload);
    if (request) return { ...base, type: event.type, request };
  }
  if (event.type === 'permission.resolved') {
    const requestId = readString(payload, ['requestId', 'request_id']);
    if (requestId) {
      const decision = readPermissionDecision(payload.decision);
      return compact({ ...base, type: event.type, requestId, decision });
    }
  }
  return { ...base, type: 'unknown', originalType: event.type };
}

function readSessionVisibility(value: unknown): 'visible' | 'hidden' | undefined {
  return value === 'visible' || value === 'hidden' ? value : undefined;
}

function readThreadGoal(value: unknown): GlobalThreadGoal | undefined {
  if (!isRecord(value)) return undefined;
  const status = readThreadGoalStatus(value.status);
  if (
    typeof value.goalId !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.objective !== 'string' ||
    status === undefined ||
    !isFiniteNumber(value.createdAt) ||
    !isFiniteNumber(value.updatedAt) ||
    !isFiniteNumber(value.tokensUsed) ||
    !isFiniteNumber(value.timeUsedSeconds) ||
    !(value.tokenBudget === null || isFiniteNumber(value.tokenBudget)) ||
    typeof value.hasKickoffAttachments !== 'boolean'
  ) {
    return undefined;
  }
  const lastVerification = readThreadGoalLastVerification(value.lastVerification);
  const executionWait = readThreadGoalExecutionWait(value.executionWait ?? value.execution_wait);
  return {
    goalId: value.goalId,
    sessionId: value.sessionId,
    objective: value.objective,
    status,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    tokensUsed: value.tokensUsed,
    turnsUsed: isFiniteNumber(value.turnsUsed) ? value.turnsUsed : 0,
    timeUsedSeconds: value.timeUsedSeconds,
    tokenBudget: value.tokenBudget,
    statusReason: readThreadGoalStatusReason(value.statusReason),
    ...(executionWait !== undefined ? { executionWait } : {}),
    ...(lastVerification !== undefined ? { lastVerification } : {}),
    hasKickoffAttachments: value.hasKickoffAttachments,
  };
}

const THREAD_GOAL_WAIT_REASONS: ReadonlySet<GlobalThreadGoalWaitReason> = new Set([
  'questionnaire',
  'permission',
  'plan',
  'required_background',
  'automation_owner_conflict',
  'dependency_unavailable',
  'verification',
  'unknown',
]);

function readThreadGoalExecutionWait(
  value: unknown,
): GlobalThreadGoal['executionWait'] | undefined {
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  const reason = readString(value, ['reason', 'waitReason', 'wait_reason']);
  const sinceMs = readNumber(value, ['sinceMs', 'since_ms', 'waitSince', 'wait_since']);
  if (
    !reason ||
    !THREAD_GOAL_WAIT_REASONS.has(reason as GlobalThreadGoalWaitReason) ||
    typeof sinceMs !== 'number' ||
    !Number.isSafeInteger(sinceMs) ||
    sinceMs < 0
  ) {
    return undefined;
  }
  return { reason: reason as GlobalThreadGoalWaitReason, sinceMs };
}

function readThreadGoalStatus(value: unknown): GlobalThreadGoal['status'] | undefined {
  if (typeof value !== 'string') return undefined;
  if (
    value === 'active' ||
    value === 'paused' ||
    value === 'blocked' ||
    value === 'complete' ||
    value === 'budget_limited' ||
    value === 'usage_limited'
  ) {
    return value;
  }
  return 'paused';
}

const THREAD_GOAL_STATUS_REASONS: ReadonlySet<GlobalThreadGoalStatusReason> = new Set([
  'complete(worker_proposal)',
  'complete(verifier_met)',
  'complete(user_requested)',
  'paused(user_requested)',
  'paused(retracted)',
  'paused(infra_retryable)',
  'paused(accounting_unavailable)',
  'paused(verifier_unavailable)',
  'paused(route_unavailable)',
  'paused(verifier_timeout)',
  'paused(verifier_protocol)',
  'paused(verifier_runtime)',
  'paused(verifier_budget)',
  'paused(verifier_capability)',
  'paused(verifier_aborted)',
  'paused(no_progress)',
  'paused(no_progress_after_completion_claim)',
  'blocked(worker_reported)',
  'blocked(safety_policy)',
  'blocked(verifier_impossible)',
  'budget_limited(token)',
  'budget_limited(main_turn)',
  'budget_limited(active_time)',
  'usage_limited(provider_quota)',
  'usage_limited(rate_limit)',
]);

function readThreadGoalStatusReason(value: unknown): GlobalThreadGoalStatusReason | null {
  return typeof value === 'string' &&
    THREAD_GOAL_STATUS_REASONS.has(value as GlobalThreadGoalStatusReason)
    ? (value as GlobalThreadGoalStatusReason)
    : null;
}

function readThreadGoalLastVerification(
  value: unknown,
): GlobalThreadGoal['lastVerification'] | undefined {
  if (
    !isRecord(value) ||
    !(value.backend === 'evaluator' || value.backend === 'subagent') ||
    !(
      value.verdict === 'met' ||
      value.verdict === 'not_met' ||
      value.verdict === 'impossible' ||
      value.verdict === 'inconclusive'
    ) ||
    typeof value.reason !== 'string' ||
    !Array.isArray(value.missing) ||
    !value.missing.every((item) => typeof item === 'string') ||
    !isFiniteNumber(value.notMetStreak) ||
    !isFiniteNumber(value.at)
  ) {
    return undefined;
  }
  return {
    backend: value.backend,
    verdict: value.verdict,
    reason: value.reason,
    missing: value.missing,
    notMetStreak: value.notMetStreak,
    at: value.at,
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export function normalizeTuiQuestionnaireRequest(
  value: unknown,
): TuiQuestionnaireRequest | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !Array.isArray(value.steps)) {
    return undefined;
  }
  if (
    ['planReview', 'plan_review', 'featureKey', 'feature_key'].some((key) =>
      Object.hasOwn(value, key),
    )
  ) {
    return undefined;
  }
  const steps = value.steps.map((candidate) => readQuestionnaireStep(candidate));
  if (steps.some((step) => !step)) return undefined;
  const requester = readQuestionnaireRequester(value.requester);
  const tool = readQuestionnaireTool(value.tool);
  const purpose = readQuestionnairePurpose(value.purpose);
  if (Object.hasOwn(value, 'purpose') && purpose === undefined) return undefined;
  const modeProjection = readQuestionnaireMode(value);
  if (!modeProjection) return undefined;
  const strictPlanPresentation = readStrictPlanPresentation(value.presentation);
  if (
    modeProjection.mode === 'plan' &&
    (value.schemaVersion !== 2 || strictPlanPresentation === undefined)
  ) {
    return undefined;
  }
  const presentation = isRecord(value.presentation) ? value.presentation : {};
  return {
    schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : 1,
    id: value.id,
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(tool ? { tool } : {}),
    ...(requester ? { requester } : {}),
    ...(purpose ? { purpose } : {}),
    ...(modeProjection.mode ? { mode: modeProjection.mode } : {}),
    ...(modeProjection.modePayload ? { modePayload: modeProjection.modePayload } : {}),
    presentation: strictPlanPresentation ?? {
      replaceComposer:
        typeof presentation.replaceComposer === 'boolean' ? presentation.replaceComposer : true,
      showProgress:
        typeof presentation.showProgress === 'boolean' ? presentation.showProgress : true,
      allowBackNavigation:
        typeof presentation.allowBackNavigation === 'boolean'
          ? presentation.allowBackNavigation
          : true,
    },
    steps: steps as TuiQuestionnaireRequest['steps'],
    ...(value.expiresAt !== undefined ? { expiresAt: value.expiresAt as never } : {}),
    ...(typeof value.status === 'number' ? { status: value.status as never } : {}),
    ...(value.createdAt !== undefined ? { createdAt: value.createdAt as never } : {}),
  };
}

function readStrictPlanPresentation(
  value: unknown,
): TuiQuestionnaireRequest['presentation'] | undefined {
  if (!isRecord(value)) return undefined;
  const replaceComposer = value.replaceComposer ?? value.replace_composer;
  const showProgress = value.showProgress ?? value.show_progress;
  const allowBackNavigation = value.allowBackNavigation ?? value.allow_back_navigation;
  return replaceComposer === true && showProgress === true && allowBackNavigation === true
    ? { replaceComposer: true, showProgress: true, allowBackNavigation: true }
    : undefined;
}

function readQuestionnaireMode(value: Record<string, unknown>):
  | {
      readonly mode?: string;
      readonly modePayload?: TuiQuestionnaireRequest['modePayload'];
    }
  | undefined {
  const rawPayload = value.modePayload ?? value.mode_payload;
  if (rawPayload !== undefined && !isRecord(rawPayload)) return undefined;
  const payload = isRecord(rawPayload) ? rawPayload : undefined;
  const rawFeatureKey = payload?.featureKey ?? payload?.feature_key;
  const rawPlanReview = payload?.planReview ?? payload?.plan_review;

  if (value.mode === undefined) {
    return payload === undefined ? { mode: 'questionnaire' } : undefined;
  }
  if (value.mode === 'questionnaire')
    return payload === undefined ? { mode: value.mode } : undefined;
  if (value.mode === 'feature-enable') {
    if (rawPlanReview !== undefined || typeof rawFeatureKey !== 'string' || !rawFeatureKey.trim()) {
      return undefined;
    }
    return { mode: value.mode, modePayload: { featureKey: rawFeatureKey } };
  }
  if (value.mode !== 'plan' || rawFeatureKey !== undefined) return undefined;
  if (rawPlanReview === undefined) return { mode: value.mode };
  if (
    !isRecord(rawPlanReview) ||
    typeof rawPlanReview.markdown !== 'string' ||
    !rawPlanReview.markdown.trim() ||
    typeof rawPlanReview.path !== 'string' ||
    !rawPlanReview.path.trim()
  ) {
    return undefined;
  }
  return {
    mode: value.mode,
    modePayload: {
      planReview: { markdown: rawPlanReview.markdown, path: rawPlanReview.path },
    },
  };
}

function readQuestionnairePurpose(value: unknown): TuiQuestionnaireRequest['purpose'] | undefined {
  if (value === 1 || value === 'goal') return 'goal';
  if (value === 0 || value === 'general') return 'general';
  return undefined;
}

function readQuestionnaireStep(
  value: unknown,
): TuiQuestionnaireRequest['steps'][number] | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.question !== 'string') {
    return undefined;
  }
  const selectionMode = value.selectionMode;
  if (
    selectionMode !== 0 &&
    selectionMode !== 1 &&
    selectionMode !== 'single' &&
    selectionMode !== 'multiple'
  ) {
    return undefined;
  }
  if (value.options !== undefined && !Array.isArray(value.options)) return undefined;
  const options: NonNullable<TuiQuestionnaireRequest['steps'][number]['options']> = [];
  for (const candidate of value.options ?? []) {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== 'string' ||
      typeof candidate.label !== 'string'
    ) {
      return undefined;
    }
    const image = readQuestionnaireImage(candidate.image);
    options.push({
      id: candidate.id,
      label: candidate.label,
      ...(typeof candidate.description === 'string' ? { description: candidate.description } : {}),
      ...(image ? { image } : {}),
      ...(candidate.recommended === true ? { recommended: true as const } : {}),
    });
  }
  const image = readQuestionnaireImage(value.image);
  return {
    id: value.id,
    ...(typeof value.header === 'string' ? { header: value.header } : {}),
    question: value.question,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    ...(image ? { image } : {}),
    selectionMode: selectionMode as TuiQuestionnaireRequest['steps'][number]['selectionMode'],
    options,
    allowOther: typeof value.allowOther === 'boolean' ? value.allowOther : false,
    otherPlaceholder: typeof value.otherPlaceholder === 'string' ? value.otherPlaceholder : '',
    required: typeof value.required === 'boolean' ? value.required : true,
  };
}

function readQuestionnaireTool(value: unknown): TuiQuestionnaireRequest['tool'] | undefined {
  if (!isRecord(value)) return undefined;
  const messageId = readString(value, ['messageId', 'message_id']);
  const callId = readString(value, ['callId', 'call_id']);
  return messageId && callId ? { messageId, callId } : undefined;
}

function readQuestionnaireImage(
  value: unknown,
): TuiQuestionnaireRequest['steps'][number]['image'] | undefined {
  if (!isRecord(value)) return undefined;
  const src = readString(value, ['src']);
  if (!src) return undefined;
  return compact({
    src,
    alt: readString(value, ['alt']),
    caption: readString(value, ['caption']),
    width: readNumber(value, ['width']),
    height: readNumber(value, ['height']),
  });
}

function readQuestionnaireRequester(
  value: unknown,
): TuiQuestionnaireRequest['requester'] | undefined {
  if (!isRecord(value) || typeof value.sessionId !== 'string') return undefined;
  return {
    sessionId: value.sessionId,
    ...(typeof value.runId === 'string' ? { runId: value.runId } : {}),
    ...(typeof value.toolCallId === 'string' ? { toolCallId: value.toolCallId } : {}),
    ...(typeof value.agentName === 'string' ? { agentName: value.agentName } : {}),
  };
}

function readPermission(value: Record<string, unknown>): TuiPendingPermission | undefined {
  const requestId = readString(value, ['requestId', 'request_id']);
  if (!requestId) return undefined;
  const toolName = readString(value, ['toolName', 'tool_name']);
  const toolInput = readString(value, ['toolInput', 'tool_input']);
  const structuredPreview = buildTuiToolPreview({ toolName, input: toolInput });
  return compact({
    requestId,
    sessionId: readString(value, ['sessionId', 'session_id']),
    agentName: readString(value, ['agentName', 'agent_name']),
    toolName,
    toolDescription: readString(value, ['toolDescription', 'tool_description']),
    reason: readString(value, ['reason']),
    ruleContents: readStringArray(value, ['ruleContents', 'rule_contents']),
    toolInput,
    allowAlwaysSupported:
      typeof value.allowAlwaysSupported === 'boolean' ? value.allowAlwaysSupported : undefined,
    createdAt: readNumber(value, ['createdAt', 'created_at']),
    structuredPreview,
  });
}

function readPermissionDecision(value: unknown): 'allowOnce' | 'allowAlways' | 'deny' | undefined {
  return value === 'allowOnce' || value === 'allowAlways' || value === 'deny' ? value : undefined;
}

function readString(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === 'string') return value[key];
  }
  return undefined;
}

function readStringArray(
  value: Record<string, unknown>,
  keys: readonly string[],
): string[] | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (Array.isArray(candidate) && candidate.every((item) => typeof item === 'string')) {
      return candidate;
    }
  }
  return undefined;
}

function readNumber(value: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function readCompactionTokenUsage(value: unknown): CompactionTokenUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = readNumber(value, ['inputTokens', 'input_tokens']);
  const outputTokens = readNumber(value, ['outputTokens', 'output_tokens']);
  const cacheReadTokens = readNumber(value, ['cacheReadTokens', 'cache_read_tokens']);
  const cacheWriteTokens = readNumber(value, ['cacheWriteTokens', 'cache_write_tokens']);
  const totalTokens = readNumber(value, ['totalTokens', 'total_tokens']);
  const incomplete = readBoolean(value, ['incomplete']);
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined ||
    cacheWriteTokens === undefined ||
    totalTokens === undefined ||
    incomplete === undefined ||
    [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens].some(
      (tokens) => tokens < 0,
    ) ||
    totalTokens !== inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
  ) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    incomplete,
  };
}

function readBoolean(value: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'boolean') return candidate;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, candidate]) => candidate !== undefined),
  ) as T;
}
