import type { AskQuestionnaireReplyPayload } from '@mavis/shared/questionnaire';

import { json } from './host-helpers.js';
import { feishuClientId } from '../channels/feishu.js';
import type { FeishuPlatformAdapter } from '../channels/adapters/feishu/feishu-adapter.js';
import {
  buildQuestionnaireSubmittedCard,
  buildQuestionnaireExpiredCard,
  decodeCardAction,
  extractFormValue,
  extractQuestionnaireSubmitValue,
  mapFormValueToAnswers,
} from '../channels/adapters/feishu/feishu-card.js';
import {
  buildPermissionResolvedCard,
  extractPermissionActionValue,
} from '../channels/adapters/feishu/feishu-permission-card.js';
import type { ChannelPermissionBehavior } from '../channels/permission-bridge.js';
import type { QuestionnaireReplyOutcome } from '../questionnaire/reply-outcome.js';
import type { LocalChannelQuestionnaireBridge } from '../channels/questionnaire-bridge.js';
import type {
  FeishuPendingPermission,
  FeishuPendingQuestionnaire,
} from './host-channel-pending.js';
import type { ModuleMetricsReporter } from '../common/metrics.js';
import { logger } from '../common/logger.js';

export function createFeishuCardActionHandler(input: {
  agentName: string;
  feishuPlatformAdapter: FeishuPlatformAdapter;
  feishuPendingQuestionnaires: Map<string, FeishuPendingQuestionnaire>;
  feishuPendingPermissions: Map<string, FeishuPendingPermission>;
  questionnaireBridge: LocalChannelQuestionnaireBridge;
  submitQuestionnaireReply?: (input: {
    agentName: string;
    requestId: string;
    reply: AskQuestionnaireReplyPayload;
  }) => Promise<QuestionnaireReplyOutcome | void>;
  /**
   * Optional permission reply applier — the SAME host seam MR-1 wired for the
   * runner's Telegram inbound path (`applyPermissionReply(permissionRouteContext,
   * requestId, behavior)`). Feishu card clicks arrive on this HTTP endpoint
   * instead of `dispatchInbound`, so the permission branch calls it directly to
   * settle the pending request (persist rule + settle waiter + resume the
   * blocked tool). Unwired → permission clicks are decoded but not settled
   * (pre-MR-2 fallthrough).
   */
  applyPermissionReply?: (input: {
    requestId: string;
    behavior: ChannelPermissionBehavior;
  }) => Promise<void>;
  /** Resolve a Feishu adapter by exact clientName; no cross-agent fallback. */
  getAdapter: (clientName?: string) => FeishuPlatformAdapter | undefined;
  /** Optional metrics reporter injected by the host. Absent → noop. */
  metrics?: ModuleMetricsReporter;
}): (body: Record<string, unknown>) => Promise<Response> {
  const inFlightQuestionnaires = new Set<string>();

  return async (body) => {
    const rawBody = (body ?? {}) as Record<string, unknown>;
    const payload = (
      rawBody.action && typeof rawBody.action === 'object' ? rawBody : { action: rawBody }
    ) as {
      action?: { value?: unknown; tag?: string };
      open_chat_id?: string;
      open_message_id?: string;
      open_id?: string;
      user_id?: string;
    };
    // Dispatch on the button `value.kind` FIRST: a permission card and a
    // questionnaire card share this endpoint but carry disjoint discriminators
    // (`permission_action` vs `questionnaire_submit`), so neither branch can
    // ever eat the other's click.
    const permissionValue = extractPermissionActionValue(rawBody);
    if (permissionValue)
      return handlePermissionAction({ ...input, rawBody, payload, permissionValue });

    const submitValue = extractQuestionnaireSubmitValue(rawBody);
    if (submitValue)
      return handleFormSubmit({
        ...input,
        rawBody,
        payload,
        submitValue,
        inFlightQuestionnaires,
      });

    const decoded = decodeCardAction(payload as never);
    if (!decoded.token) return json({ ok: true, ignored: true, reason: 'no-questionnaire-token' });
    if (!input.getAdapter()) {
      return json(
        { ok: false, error: 'feishu adapter not registered', code: 'FEISHU_ADAPTER_MISSING' },
        { status: 503 },
      );
    }
    const reply = input.questionnaireBridge.buildReply({
      requestId: decoded.token.r,
      answers: [
        {
          stepId: decoded.token.s,
          selectedOptionIds: decoded.token.o === null ? [] : [decoded.token.o],
          selectedOther: decoded.token.o === null,
          ...(decoded.otherText ? { otherText: decoded.otherText } : {}),
        },
      ],
    });
    await input.questionnaireBridge.submit({
      ctx: legacyPayloadContext(payload, input.feishuPlatformAdapter.clientName),
      reply,
    });
    input.metrics?.incr('channel_ask_user_total', { channel: 'feishu', phase: 'replied' });
    return json({ ok: true, requestId: decoded.token.r });
  };
}

/**
 * Resolve a permission-card click. The button value already carries
 * `requestId` + `behavior` (decoded at dispatch), so this looks up the
 * `requestId`-keyed pending render, settles the decision through the host
 * `applyPermissionReply` seam (the SAME seam MR-1 wired for Telegram inbound),
 * then PATCHes the card into its terminal state.
 *
 * Consume-once at the Feishu layer: a missing pending → the card was already
 * clicked (or the desktop UI settled it first), so we ignore the duplicate
 * without re-settling. When a pending IS present but the route seam no-ops
 * (desktop-first race, NOT_PENDING treated as idempotent by
 * `applyPermissionReplyFromChannel`), we STILL patch the terminal card so the
 * IM surface never dangles.
 */
async function handlePermissionAction(input: {
  getAdapter: (clientName?: string) => FeishuPlatformAdapter | undefined;
  feishuPendingPermissions: Map<string, FeishuPendingPermission>;
  applyPermissionReply?: (input: {
    requestId: string;
    behavior: ChannelPermissionBehavior;
  }) => Promise<void>;
  metrics?: ModuleMetricsReporter;
  rawBody: Record<string, unknown>;
  payload: { open_chat_id?: string; open_message_id?: string; open_id?: string; user_id?: string };
  permissionValue: { requestId: string; behavior: ChannelPermissionBehavior };
}): Promise<Response> {
  const { requestId, behavior } = input.permissionValue;
  const pending = input.feishuPendingPermissions.get(requestId);
  logger.info(
    {
      requestId,
      behavior,
      pendingFound: Boolean(pending),
      pendingMsgId: pending?.messageId ?? null,
      pendingCount: input.feishuPendingPermissions.size,
    },
    'Feishu permission action received',
  );
  if (!pending) return json({ ok: true, ignored: true, reason: 'permission-not-pending' });
  const payloadChatId = nonEmptyPayloadChatId(input.payload.open_chat_id);
  if (payloadChatId && payloadChatId !== pending.chatId) {
    logger.warn(
      {
        requestId,
        pendingClientName: pending.clientName,
        pendingChatId: pending.chatId,
        payloadChatId,
        reason: 'chat_id_mismatch',
      },
      'Feishu permission action rejected for pending chat mismatch',
    );
    return json({ ok: true, ignored: true, reason: 'permission-chat-mismatch', requestId });
  }
  const adapter = input.getAdapter(pending.clientName);
  if (!adapter) {
    logger.warn(
      { requestId, pendingClientName: pending.clientName, reason: 'adapter_missing' },
      'Feishu permission action adapter missing for pending client',
    );
    return json(
      {
        ok: false,
        requestId,
        error: 'Feishu adapter is not registered for the originating client',
        code: 'FEISHU_PENDING_ADAPTER_MISSING',
      },
      { status: 503 },
    );
  }
  // Consume-once: drop the pending BEFORE any await so a rapid double-click
  // cannot both settle + double-patch.
  input.feishuPendingPermissions.delete(requestId);
  // The click IS the user decision; count it regardless of settle outcome.
  input.metrics?.incr('channel_permission_ask_total', { channel: 'feishu', phase: 'replied' });

  if (input.applyPermissionReply) {
    try {
      await input.applyPermissionReply({ requestId, behavior });
    } catch (err) {
      // Never surface a settle failure as a hard error — the click was real
      // and the card must still reach a terminal state. (The route seam
      // already folds the desktop-first NOT_PENDING race into a no-op.)
      logger.warn({ err, requestId, behavior }, 'Feishu permission applyPermissionReply failed');
    }
  }

  const resolvedCard = buildPermissionResolvedCard(
    pending.renderable,
    behavior,
    input.payload.open_id ?? input.payload.user_id,
  );
  await patchResolvedCard(
    adapter,
    pending.messageId || input.payload.open_message_id,
    resolvedCard,
    requestId,
  );
  return json({
    ok: true,
    requestId,
    toast: { type: behavior === 'deny' ? 'info' : 'success', content: '已处理' },
    card: { type: 'raw', data: resolvedCard },
  });
}

async function handleFormSubmit(input: {
  agentName: string;
  getAdapter: (clientName?: string) => FeishuPlatformAdapter | undefined;
  feishuPendingQuestionnaires: Map<string, FeishuPendingQuestionnaire>;
  questionnaireBridge: LocalChannelQuestionnaireBridge;
  submitQuestionnaireReply?: (input: {
    agentName: string;
    requestId: string;
    reply: AskQuestionnaireReplyPayload;
  }) => Promise<QuestionnaireReplyOutcome | void>;
  inFlightQuestionnaires: Set<string>;
  metrics?: ModuleMetricsReporter;
  rawBody: Record<string, unknown>;
  payload: { open_chat_id?: string; open_id?: string; user_id?: string };
  submitValue: { requestId: string };
}): Promise<Response> {
  const requestId = input.submitValue.requestId;
  const pending = input.feishuPendingQuestionnaires.get(requestId);
  logger.info(
    {
      requestId,
      pendingFound: Boolean(pending),
      pendingMsgId: pending?.messageId ?? null,
      pendingCount: input.feishuPendingQuestionnaires.size,
    },
    'Feishu questionnaire submit received',
  );
  if (!pending) return json({ ok: true, ignored: true, reason: 'questionnaire-not-pending' });
  const payloadChatId = nonEmptyPayloadChatId(input.payload.open_chat_id);
  if (payloadChatId && payloadChatId !== pending.chatId) {
    logger.warn(
      {
        requestId,
        pendingClientName: pending.clientName,
        pendingChatId: pending.chatId,
        payloadChatId,
        reason: 'chat_id_mismatch',
      },
      'Feishu questionnaire submit rejected for pending chat mismatch',
    );
    return json({ ok: true, ignored: true, reason: 'questionnaire-chat-mismatch', requestId });
  }
  const adapter = input.getAdapter(pending.clientName);
  if (!adapter) {
    logger.warn(
      { requestId, pendingClientName: pending.clientName, reason: 'adapter_missing' },
      'Feishu questionnaire submit adapter missing for pending client',
    );
    return json(
      {
        ok: false,
        requestId,
        error: 'Feishu adapter is not registered for the originating client',
        code: 'FEISHU_PENDING_ADAPTER_MISSING',
      },
      { status: 503 },
    );
  }
  if (input.inFlightQuestionnaires.has(requestId)) {
    return json({ ok: true, ignored: true, reason: 'questionnaire-in-flight', requestId });
  }
  let reply: AskQuestionnaireReplyPayload;
  try {
    reply = input.questionnaireBridge.buildReply({
      requestId,
      answers: mapFormValueToAnswers(pending.request, extractFormValue(input.rawBody)),
    });
  } catch (err) {
    logger.error(
      { err, requestId, pendingClientName: pending.clientName },
      'Feishu questionnaire reply construction failed',
    );
    return json({
      ok: false,
      requestId,
      error: 'QUESTIONNAIRE_SUBMIT_FAILED',
      toast: { type: 'error', content: '提交失败，请稍后再试' },
    });
  }
  const agentName = pending.request.requester?.agentName ?? input.agentName;
  input.inFlightQuestionnaires.add(requestId);
  // The submit IS the user reply; count it regardless of downstream outcome.
  input.metrics?.incr('channel_ask_user_total', { channel: 'feishu', phase: 'replied' });
  try {
    await input.questionnaireBridge.submit({
      ctx: legacyPayloadContext(input.payload, adapter.clientName, pending.chatId),
      reply,
    });
    let outcome: QuestionnaireReplyOutcome = { status: 'accepted' };
    if (input.submitQuestionnaireReply) {
      const resolved = await input.submitQuestionnaireReply({
        agentName,
        requestId,
        reply,
      });
      outcome = resolved ?? { status: 'accepted' };
    }
    if (outcome.status === 'retryable') {
      input.inFlightQuestionnaires.delete(requestId);
      return json({
        ok: false,
        requestId,
        error: outcome.code ?? 'QUESTIONNAIRE_REPLY_RETRYABLE',
        toast: { type: 'error', content: '提交失败，请稍后再试' },
      });
    }
    // Accepted and terminal outcomes consume the pending entry before the
    // best-effort Feishu card patch.
    input.inFlightQuestionnaires.delete(requestId);
    input.feishuPendingQuestionnaires.delete(requestId);
    const terminal = outcome.status === 'terminal';
    const terminalCode = outcome.status === 'terminal' ? outcome.code : undefined;
    const alreadyAnswered = terminalCode === 'QUESTIONNAIRE_ALREADY_ANSWERED';
    const terminalCard =
      outcome.status === 'accepted' || alreadyAnswered
        ? buildQuestionnaireSubmittedCard(pending.request)
        : buildQuestionnaireExpiredCard(pending.request);
    await patchSubmittedCard(adapter, pending.messageId, terminalCard, requestId);
    return json({
      ok: true,
      requestId,
      ...(terminal ? { terminal: true, error: terminalCode ?? 'QUESTIONNAIRE_TERMINAL' } : {}),
      toast: {
        type: terminal ? 'info' : 'success',
        content: terminal ? '该问卷已处理或已过期' : '已提交',
      },
      card: { type: 'raw', data: terminalCard },
    });
  } catch (err) {
    logger.error(
      { err, requestId, pendingClientName: pending.clientName },
      'Feishu questionnaire submission failed unexpectedly',
    );
    input.inFlightQuestionnaires.delete(requestId);
    return json({
      ok: false,
      requestId,
      error: 'QUESTIONNAIRE_SUBMIT_FAILED',
      toast: { type: 'error', content: '提交失败，请稍后再试' },
    });
  }
}

function legacyPayloadContext(
  payload: { open_chat_id?: string; open_id?: string; user_id?: string },
  clientName: string,
  fallbackChatId = '',
) {
  return {
    platform: 'feishu' as const,
    chatType: 'p2p',
    chatId: String(payload.open_chat_id ?? fallbackChatId),
    senderId: String(payload.open_id ?? payload.user_id ?? ''),
    clientName: clientName || feishuClientId('mavis'),
  };
}

function nonEmptyPayloadChatId(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

async function patchSubmittedCard(
  adapter: FeishuPlatformAdapter,
  messageId: string | undefined,
  submittedCard: object,
  requestId: string,
): Promise<void> {
  if (!messageId) {
    logger.warn(
      { requestId, reason: 'missing_pending_message_id' },
      'Feishu questionnaire submitted card patch skipped',
    );
    return;
  }
  try {
    logger.info({ messageId, requestId }, 'Feishu questionnaire submitted card patch started');
    await adapter.patchCard(messageId, submittedCard);
    logger.info({ messageId }, 'Feishu questionnaire submitted card patch completed');
  } catch (err) {
    logger.warn({ err, messageId, requestId }, 'Feishu questionnaire submitted card patch failed');
  }
}

/**
 * PATCH the permission card into its terminal (resolved) state. Best-effort —
 * a missing message id or a transport failure is logged, never thrown, so a
 * failed morph cannot turn a settled permission into an HTTP error.
 */
async function patchResolvedCard(
  adapter: FeishuPlatformAdapter,
  messageId: string | undefined,
  resolvedCard: object,
  requestId: string,
): Promise<void> {
  if (!messageId) {
    logger.warn(
      { requestId, reason: 'missing_pending_message_id' },
      'Feishu permission resolved card patch skipped',
    );
    return;
  }
  try {
    await adapter.patchCard(messageId, resolvedCard);
    logger.info({ messageId, requestId }, 'Feishu permission resolved card patch completed');
  } catch (err) {
    logger.warn({ err, messageId, requestId }, 'Feishu permission resolved card patch failed');
  }
}
