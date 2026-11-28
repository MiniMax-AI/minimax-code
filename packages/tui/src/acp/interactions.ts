import * as acp from '@agentclientprotocol/sdk';

import type { TuiSession } from '../runtime/port.js';
import type {
  TuiPendingPermission,
  TuiQuestionnaireReplyAnswer,
  TuiQuestionnaireRequest,
  TuiQuestionnaireStep,
} from '../types/runtime-models.js';
import type { TuiRuntimeEvent } from '../types/runtime-events.js';
import { isTuiAcpAbsolutePath } from './paths.js';
import type { TuiAcpRuntime } from './runtime.js';
import { tuiAcpToolKind } from './updates.js';

const MAX_PENDING_PROJECTIONS = 64;
const MAX_ACTIVE_PROJECTIONS = 8;
const MAX_PENDING_INTERACTIONS = 64;
const MAX_ACTIVE_INTERACTIONS = 8;
const INTERACTION_CANCEL_CONCURRENCY = 8;
const INTERACTION_CANCEL_TIMEOUT_MS = 1_000;
const MAX_DETACHED_INTERACTIONS_PER_ATTACHMENT = 2;
const MAX_DETACHED_INTERACTIONS_TOTAL = 32;
const MAX_TERMINAL_TARGETS = 128;

interface ResolvedInteractionSession {
  readonly acpSessionId: string;
  readonly session: TuiSession;
  readonly attachmentSignal: AbortSignal;
  readonly isCurrent: () => boolean;
}

interface TuiAcpRuntimeInteraction {
  readonly id: string;
  readonly terminalIds: readonly string[];
  readonly key: string;
  readonly attachmentSignal: AbortSignal;
  run(signal: AbortSignal): Promise<void>;
  cancel(): Promise<void>;
  terminated(): void;
}

class RuntimeInteractionTerminated extends Error {}

export interface RunTuiAcpInteractionsOptions {
  /**
   * The one Runtime whose event stream this loop consumes. Replies go back to this Runtime, the
   * one that asked, even after another Runtime has replaced it.
   */
  readonly runtime: TuiAcpRuntime;
  readonly connection: acp.AgentConnection;
  /**
   * Ends this loop without closing the connection, for example when a region switch replaced
   * the Runtime. The loop then cancels its own pending interactions and projections.
   */
  readonly signal?: AbortSignal;
  readonly resolveSession: (runtimeSessionId: string) => ResolvedInteractionSession | undefined;
  readonly clientCapabilities: () => acp.ClientCapabilities;
  readonly onRuntimeEvent?: (event: TuiRuntimeEvent) => void;
  readonly createRuntimeEventProjections?: (
    event: TuiRuntimeEvent,
  ) => readonly TuiAcpRuntimeProjection[];
  readonly projectionTimeoutMs?: number;
  readonly onQuestionnaireSettled?: (event: {
    readonly sessionId: string;
    readonly requestId: string;
    readonly continued: boolean;
  }) => readonly TuiAcpRuntimeProjection[];
}

export interface TuiAcpRuntimeProjection {
  readonly key: string;
  readonly required?: boolean;
  onDrop?(): void;
  run(signal: AbortSignal): void | Promise<void>;
}

export async function runTuiAcpInteractions(options: RunTuiAcpInteractionsOptions): Promise<void> {
  const projections = createProjectionScheduler(
    options.connection,
    options.projectionTimeoutMs ?? 5_000,
  );
  const interactions = createInteractionScheduler(options.connection);
  const signal = options.signal
    ? AbortSignal.any([options.connection.signal, options.signal])
    : options.connection.signal;
  try {
    for await (const event of options.runtime.watchEvents(signal)) {
      if (signal.aborted) return;
      try {
        options.onRuntimeEvent?.(event);
      } catch {
        // Critical event observation is fail-open for permission/questionnaire handling.
      }
      try {
        for (const projection of options.createRuntimeEventProjections?.(event) ?? []) {
          projections.enqueue(projection);
        }
      } catch {
        // Control-plane projection creation is fail-open for later Runtime interactions.
      }
      const terminalIds = runtimeInteractionTerminalIds(event);
      if (terminalIds) interactions.terminate(terminalIds);
      const interaction = createRuntimeInteraction(options, event, projections.enqueue);
      if (interaction && !interactions.enqueue(interaction)) return;
    }
  } catch {
    // Losing the auxiliary interaction stream must not corrupt the ACP transport.
  } finally {
    projections.close();
    interactions.close();
  }
}

function createInteractionScheduler(connection: acp.AgentConnection): {
  enqueue(interaction: TuiAcpRuntimeInteraction): boolean;
  terminate(terminalIds: readonly string[]): void;
  close(): void;
} {
  const active = new Map<
    string,
    {
      readonly controller: AbortController;
      readonly interaction: TuiAcpRuntimeInteraction;
      detached: boolean;
    }
  >();
  const pending: TuiAcpRuntimeInteraction[] = [];
  const detachedByAttachment = new Map<AbortSignal, number>();
  const terminalTargets = new Map<
    string,
    Array<{
      readonly interaction: TuiAcpRuntimeInteraction;
      readonly terminalIds: readonly string[];
    }>
  >();
  let detachedCount = 0;
  let terminalTargetCount = 0;
  let closed = false;

  const releaseDetached = (attachmentSignal: AbortSignal) => {
    const remaining = (detachedByAttachment.get(attachmentSignal) ?? 1) - 1;
    if (remaining > 0) detachedByAttachment.set(attachmentSignal, remaining);
    else detachedByAttachment.delete(attachmentSignal);
    detachedCount -= 1;
  };

  const close = (
    overflow?: TuiAcpRuntimeInteraction,
    error = new Error('ACP Runtime interaction queue capacity exceeded.'),
  ) => {
    if (closed) return;
    closed = true;
    const activeInteractions = [...active.values()].map(({ interaction }) => interaction);
    for (const { controller } of active.values()) {
      controller.abort(new Error('ACP interaction stream closed.'));
    }
    terminalTargets.clear();
    terminalTargetCount = 0;
    const cancelled = [
      ...activeInteractions,
      ...pending.splice(0),
      ...(overflow ? [overflow] : []),
    ];
    void cancelInteractions(cancelled).finally(() => {
      if (overflow) connection.close(error);
    });
  };

  const detachActive = (
    key: string,
    entry: {
      readonly controller: AbortController;
      readonly interaction: TuiAcpRuntimeInteraction;
      detached: boolean;
    },
    reason: Error,
  ): boolean => {
    const { controller, interaction } = entry;
    if (
      (detachedByAttachment.get(interaction.attachmentSignal) ?? 0) >=
        MAX_DETACHED_INTERACTIONS_PER_ATTACHMENT ||
      detachedCount >= MAX_DETACHED_INTERACTIONS_TOTAL
    ) {
      controller.abort(reason);
      close();
      connection.close(new Error('Too many detached ACP Client interactions remain pending.'));
      return false;
    }
    active.delete(key);
    entry.detached = true;
    detachedByAttachment.set(
      interaction.attachmentSignal,
      (detachedByAttachment.get(interaction.attachmentSignal) ?? 0) + 1,
    );
    detachedCount += 1;
    controller.abort(reason);
    return true;
  };

  const drain = () => {
    if (closed || active.size >= MAX_ACTIVE_INTERACTIONS) return;
    for (let index = 0; index < pending.length; ) {
      if (active.size >= MAX_ACTIVE_INTERACTIONS) return;
      const interaction = pending[index];
      if (!interaction || active.has(interaction.key)) {
        index += 1;
        continue;
      }
      pending.splice(index, 1);
      const controller = new AbortController();
      const entry = { controller, interaction, detached: false };
      active.set(interaction.key, entry);
      void interaction
        .run(controller.signal)
        .catch(() => undefined)
        .finally(() => {
          if (entry.detached) releaseDetached(interaction.attachmentSignal);
          if (active.get(interaction.key)?.controller === controller) {
            active.delete(interaction.key);
          }
          drain();
        });
    }
  };

  return {
    enqueue(interaction) {
      if (closed) {
        void cancelInteractions([interaction]);
        return false;
      }
      const staleActive = active.get(interaction.key);
      if (
        staleActive &&
        staleActive.interaction.attachmentSignal !== interaction.attachmentSignal &&
        !detachActive(
          interaction.key,
          staleActive,
          new Error('ACP Session attachment was replaced.'),
        )
      ) {
        void cancelInteractions([interaction]);
        return false;
      }
      const stalePending = pending.filter(
        (candidate) =>
          candidate.key === interaction.key &&
          candidate.attachmentSignal !== interaction.attachmentSignal,
      );
      if (stalePending.length > 0) {
        for (const candidate of stalePending) pending.splice(pending.indexOf(candidate), 1);
        void cancelInteractions(stalePending);
      }
      if (pending.length >= MAX_PENDING_INTERACTIONS) {
        close(interaction);
        return false;
      }
      if (terminalTargetCount >= MAX_TERMINAL_TARGETS) {
        close(
          interaction,
          new Error('ACP Runtime interaction terminal tracking capacity exceeded.'),
        );
        return false;
      }
      const target = {
        interaction,
        terminalIds: interaction.terminalIds,
      };
      for (const terminalId of interaction.terminalIds) {
        const targets = terminalTargets.get(terminalId) ?? [];
        targets.push(target);
        terminalTargets.set(terminalId, targets);
      }
      terminalTargetCount += 1;
      pending.push(interaction);
      drain();
      return true;
    },
    terminate(terminalIds) {
      const terminalId = terminalIds.find((candidate) => terminalTargets.get(candidate)?.length);
      if (!terminalId) return;
      const target = terminalTargets.get(terminalId)?.shift();
      if (!target) return;
      terminalTargetCount -= 1;
      for (const alias of target.terminalIds) {
        const targets = terminalTargets.get(alias);
        if (!targets) continue;
        const index = targets.indexOf(target);
        if (index >= 0) targets.splice(index, 1);
        if (targets.length === 0) terminalTargets.delete(alias);
      }
      for (let index = pending.length - 1; index >= 0; index -= 1) {
        const interaction = pending[index];
        if (interaction !== target.interaction) continue;
        pending.splice(index, 1);
        interaction.terminated();
      }
      for (const [key, entry] of active) {
        const { interaction } = entry;
        if (interaction !== target.interaction) continue;
        if (!detachActive(key, entry, new RuntimeInteractionTerminated())) {
          interaction.terminated();
          return;
        }
        interaction.terminated();
      }
      drain();
    },
    close,
  };
}

async function cancelInteractions(
  interactions: readonly TuiAcpRuntimeInteraction[],
): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const interaction = interactions[next++];
      if (!interaction) return;
      await withTimeout(interaction.cancel(), INTERACTION_CANCEL_TIMEOUT_MS);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(INTERACTION_CANCEL_CONCURRENCY, interactions.length) }, worker),
  );
}

async function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createProjectionScheduler(
  connection: acp.AgentConnection,
  timeoutMs: number,
): {
  enqueue(projection: TuiAcpRuntimeProjection): void;
  close(): void;
} {
  interface PendingProjection {
    readonly projection: TuiAcpRuntimeProjection;
    readonly deadlineAt?: number;
    deadlineTimer?: ReturnType<typeof setTimeout>;
  }
  const active = new Map<string, AbortController>();
  const pending = new Map<string, PendingProjection>();
  let closed = false;

  const drain = () => {
    if (closed || active.size >= MAX_ACTIVE_PROJECTIONS) return;
    for (const [key, entry] of pending) {
      if (active.size >= MAX_ACTIVE_PROJECTIONS) return;
      if (active.has(key)) continue;
      pending.delete(key);
      if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);
      start(key, entry);
    }
  };

  function start(key: string, entry: PendingProjection): void {
    if (closed || active.has(key) || active.size >= MAX_ACTIVE_PROJECTIONS) return;
    const { projection } = entry;
    const controller = new AbortController();
    active.set(key, controller);
    const remainingMs = entry.deadlineAt
      ? Math.max(0, entry.deadlineAt - Date.now())
      : Math.max(0, timeoutMs);
    const timer = setTimeout(() => {
      const error = new Error('ACP Runtime event projection timed out.');
      controller.abort(error);
      if (projection.required) {
        closeScheduler();
        connection.close(error);
      }
    }, remainingMs);
    timer.unref();
    void Promise.resolve()
      .then(() => projection.run(controller.signal))
      .catch((error) => {
        if (!projection.required) return;
        closeScheduler();
        connection.close(
          error instanceof Error ? error : new Error('ACP required projection failed.'),
        );
      })
      .finally(() => {
        clearTimeout(timer);
        if (active.get(key) === controller) active.delete(key);
        drain();
      });
  }

  const closeScheduler = () => {
    if (closed) return;
    closed = true;
    for (const entry of pending.values()) {
      if (entry.deadlineTimer) clearTimeout(entry.deadlineTimer);
      entry.projection.onDrop?.();
    }
    pending.clear();
    for (const controller of active.values()) {
      controller.abort(new Error('ACP interaction stream closed.'));
    }
  };

  return {
    enqueue(projection) {
      if (closed) return;
      const key = projection.key;
      const existing = pending.get(key);
      if (existing?.projection.required && !projection.required) {
        projection.onDrop?.();
        return;
      }
      if (!pending.has(key) && pending.size >= MAX_PENDING_PROJECTIONS) {
        const evicted = [...pending].find(([, candidate]) => !candidate.projection.required);
        if (!evicted) {
          projection.onDrop?.();
          if (projection.required) {
            closeScheduler();
            connection.close(new Error('ACP Runtime required projection queue capacity exceeded.'));
          }
          return;
        }
        pending.delete(evicted[0]);
        if (evicted[1].deadlineTimer) clearTimeout(evicted[1].deadlineTimer);
        evicted[1].projection.onDrop?.();
      }
      if (existing?.deadlineTimer) clearTimeout(existing.deadlineTimer);
      existing?.projection.onDrop?.();
      const entry: PendingProjection = {
        projection,
        ...(projection.required
          ? {
              deadlineAt: existing?.deadlineAt ?? Date.now() + Math.max(0, timeoutMs),
            }
          : {}),
      };
      if (entry.deadlineAt !== undefined) {
        entry.deadlineTimer = setTimeout(
          () => {
            if (pending.get(key) !== entry) return;
            const error = new Error('ACP required projection timed out while pending.');
            closeScheduler();
            connection.close(error);
          },
          Math.max(0, entry.deadlineAt - Date.now()),
        );
        entry.deadlineTimer.unref();
      }
      pending.set(key, entry);
      drain();
    },
    close: closeScheduler,
  };
}

function createRuntimeInteraction(
  options: RunTuiAcpInteractionsOptions,
  event: TuiRuntimeEvent,
  enqueueProjection: (projection: TuiAcpRuntimeProjection) => void,
): TuiAcpRuntimeInteraction | undefined {
  if (event.type === 'questionnaire.ask') {
    const runtimeSessionId = event.request.requester?.sessionId ?? event.sessionId;
    const agentName = event.agentName ?? event.request.requester?.agentName;
    if (!runtimeSessionId || !agentName) return undefined;
    const resolved = options.resolveSession(runtimeSessionId);
    if (!resolved) return undefined;
    return {
      id: runtimeInteractionId('questionnaire', resolved.acpSessionId, event.request.id),
      terminalIds: runtimeInteractionTerminalAliases(
        'questionnaire',
        event.request.id,
        resolved.acpSessionId,
        runtimeSessionId,
      ),
      key: resolved.acpSessionId,
      attachmentSignal: resolved.attachmentSignal,
      run: (signal) =>
        handleQuestionnaire(options, event, resolved, agentName, signal, enqueueProjection),
      cancel: async () => {
        await options.runtime.dismissQuestionnaire(agentName, event.request.id).catch(() => false);
      },
      terminated: () => {
        for (const projection of options.onQuestionnaireSettled?.({
          sessionId: resolved.acpSessionId,
          requestId: event.request.id,
          continued: false,
        }) ?? []) {
          enqueueProjection(projection);
        }
      },
    };
  }
  if (event.type !== 'permission.ask') return undefined;
  const runtimeSessionId = event.request.sessionId ?? event.sessionId;
  const requestId = event.request.requestId;
  if (!runtimeSessionId || !requestId) return undefined;
  const resolved = options.resolveSession(runtimeSessionId);
  const agentName = event.request.agentName ?? resolved?.session.agentName;
  if (!agentName || !resolved) return undefined;
  return {
    id: runtimeInteractionId('permission', resolved.acpSessionId, requestId),
    terminalIds: runtimeInteractionTerminalAliases(
      'permission',
      requestId,
      resolved.acpSessionId,
      runtimeSessionId,
    ),
    key: resolved.acpSessionId,
    attachmentSignal: resolved.attachmentSignal,
    run: (signal) => handlePermission(options, event, resolved, agentName, requestId, signal),
    cancel: async () => {
      await options.runtime.replyPermission(agentName, requestId, 'deny');
    },
    terminated: () => undefined,
  };
}

function runtimeInteractionTerminalIds(event: TuiRuntimeEvent): readonly string[] | undefined {
  if (event.type === 'questionnaire.dismiss' || event.type === 'questionnaire.superseded') {
    return runtimeInteractionTerminalAliases('questionnaire', event.requestId, event.sessionId);
  }
  if (event.type === 'permission.resolved') {
    return runtimeInteractionTerminalAliases('permission', event.requestId, event.sessionId);
  }
  return undefined;
}

function runtimeInteractionTerminalAliases(
  kind: 'permission' | 'questionnaire',
  requestId: string,
  ...sessionIds: readonly (string | undefined)[]
): readonly string[] {
  return [
    ...new Set(
      sessionIds
        .filter((sessionId): sessionId is string => sessionId !== undefined)
        .map((sessionId) => `${kind}:${sessionId}:${requestId}`),
    ),
    `${kind}:${requestId}`,
  ];
}

function runtimeInteractionId(
  kind: 'permission' | 'questionnaire',
  runtimeSessionId: string,
  requestId: string,
): string {
  return `${kind}:${runtimeSessionId}:${requestId}`;
}

async function handlePermission(
  options: RunTuiAcpInteractionsOptions,
  event: Extract<TuiRuntimeEvent, { type: 'permission.ask' }>,
  resolved: ResolvedInteractionSession,
  agentName: string,
  requestId: string,
  schedulerSignal: AbortSignal,
): Promise<void> {
  let decision: 'allowOnce' | 'allowAlways' | 'deny' = 'deny';
  try {
    const response = await options.connection.client.request(
      acp.methods.client.session.requestPermission,
      permissionRequest(resolved.acpSessionId, requestId, event.request),
      {
        cancellationSignal: AbortSignal.any([
          options.connection.signal,
          resolved.attachmentSignal,
          schedulerSignal,
        ]),
      },
    );
    if (response.outcome.outcome === 'selected') {
      decision =
        response.outcome.optionId === 'allow-always' && event.request.allowAlwaysSupported
          ? 'allowAlways'
          : response.outcome.optionId === 'allow-once'
            ? 'allowOnce'
            : 'deny';
    }
  } catch {
    decision = 'deny';
  }
  if (schedulerSignal.reason instanceof RuntimeInteractionTerminated) return;
  if (!resolved.isCurrent()) decision = 'deny';
  await options.runtime.replyPermission(agentName, requestId, decision);
}

async function handleQuestionnaire(
  options: RunTuiAcpInteractionsOptions,
  event: Extract<TuiRuntimeEvent, { type: 'questionnaire.ask' }>,
  resolved: ResolvedInteractionSession,
  agentName: string,
  schedulerSignal: AbortSignal,
  enqueueProjection: (projection: TuiAcpRuntimeProjection) => void,
): Promise<void> {
  const request = event.request;
  const sessionId = resolved.acpSessionId;
  const requestSignal = AbortSignal.any([
    options.connection.signal,
    resolved.attachmentSignal,
    schedulerSignal,
  ]);

  let continued = false;
  try {
    if (options.clientCapabilities().elicitation?.form != null) {
      let response: acp.CreateElicitationResponse | undefined;
      try {
        response = await options.connection.client.request(
          acp.methods.client.elicitation.create,
          questionnaireElicitation(sessionId, request),
          { cancellationSignal: requestSignal },
        );
      } catch {
        if (!resolved.isCurrent()) return;
        continued = await answerSimpleQuestionnaireWithPermission(
          options,
          sessionId,
          agentName,
          request,
          requestSignal,
          resolved.isCurrent,
        );
      }
      if (response && acp.CreateElicitationResponse.isAccept(response) && resolved.isCurrent()) {
        const content = response.content ?? ({} as Record<string, acp.ElicitationContentValue>);
        continued = await options.runtime.replyQuestionnaire(
          agentName,
          request.id,
          questionnaireAnswers(request, content),
        );
      }
    } else {
      continued = await answerSimpleQuestionnaireWithPermission(
        options,
        sessionId,
        agentName,
        request,
        requestSignal,
        resolved.isCurrent,
      );
    }
  } catch {
    // The fail-closed path below dismisses the Runtime request.
  } finally {
    if (!continued && !(schedulerSignal.reason instanceof RuntimeInteractionTerminated)) {
      await options.runtime.dismissQuestionnaire(agentName, request.id).catch(() => false);
    }
    if (resolved.isCurrent()) {
      for (const projection of options.onQuestionnaireSettled?.({
        sessionId,
        requestId: request.id,
        continued,
      }) ?? []) {
        enqueueProjection(projection);
      }
    }
  }
}

async function answerSimpleQuestionnaireWithPermission(
  options: RunTuiAcpInteractionsOptions,
  sessionId: string,
  agentName: string,
  request: TuiQuestionnaireRequest,
  requestSignal: AbortSignal,
  isCurrent: () => boolean,
): Promise<boolean> {
  const [step, ...remainingSteps] = request.steps;
  if (!step || isMultiple(step) || step.allowOther || !step.options?.length) {
    return false;
  }
  const prefix = `questionnaire:${request.id}:`;
  try {
    const response = await options.connection.client.request<
      acp.RequestPermissionResponse,
      acp.RequestPermissionRequest
    >(
      acp.methods.client.session.requestPermission,
      {
        sessionId,
        toolCall: {
          toolCallId: request.id,
          title: step.question,
          kind: 'other',
          status: 'pending',
        },
        options: [
          ...step.options.map((option) => ({
            optionId: `${prefix}${option.id}`,
            name: option.label,
            kind: 'allow_once' as const,
          })),
          {
            optionId: `${prefix}cancel`,
            name: 'Cancel',
            kind: 'reject_once' as const,
          },
        ],
      },
      { cancellationSignal: requestSignal },
    );
    if (response.outcome.outcome !== 'selected') return false;
    const selectedId = response.outcome.optionId.startsWith(prefix)
      ? response.outcome.optionId.slice(prefix.length)
      : undefined;
    if (!selectedId || selectedId === 'cancel') return false;
    const selected = step.options.some((option) => option.id === selectedId);
    if (!selected) return false;
    if (!isCurrent()) return false;
    return await options.runtime.replyQuestionnaire(agentName, request.id, [
      { stepId: step.id, selectedOptionIds: [selectedId] },
      ...remainingSteps.map((remaining) => ({ stepId: remaining.id, skipped: true as const })),
    ]);
  } catch {
    return false;
  }
}

function questionnaireElicitation(
  sessionId: string,
  request: TuiQuestionnaireRequest,
): acp.CreateElicitationRequest {
  const properties: Record<string, acp.ElicitationPropertySchema> = {};
  const required: string[] = [];
  const fieldLayout = questionnaireFieldLayout(request);
  for (const step of request.steps) {
    properties[step.id] = questionnaireProperty(step);
    const otherFieldId = fieldLayout.get(step.id)?.otherFieldId;
    if (otherFieldId) {
      properties[otherFieldId] = compact({
        type: 'string' as const,
        title: `${step.question} — Other`,
        description: step.otherPlaceholder || step.description,
      });
    }
    if (step.required && !otherFieldId) required.push(step.id);
  }
  const title = request.title ?? 'MiniMax Code needs your input';
  return {
    mode: 'form',
    sessionId,
    message: title,
    requestedSchema: {
      type: 'object',
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
  };
}

function questionnaireProperty(step: TuiQuestionnaireStep): acp.ElicitationPropertySchema {
  const options = step.options ?? [];
  const description =
    step.description ??
    (options.length === 0 && step.allowOther ? step.otherPlaceholder : undefined);
  if (isMultiple(step) && options.length > 0) {
    return compact({
      type: 'array' as const,
      title: step.question,
      description,
      items: {
        anyOf: questionnaireEnumOptions(step),
      },
    });
  }
  if (options.length > 0) {
    return compact({
      type: 'string' as const,
      title: step.question,
      description,
      oneOf: questionnaireEnumOptions(step),
    });
  }
  return compact({
    type: 'string' as const,
    title: step.question,
    description,
  });
}

function questionnaireAnswers(
  request: TuiQuestionnaireRequest,
  content: Record<string, acp.ElicitationContentValue>,
): TuiQuestionnaireReplyAnswer[] {
  const fieldLayout = questionnaireFieldLayout(request);
  return request.steps.flatMap((step): TuiQuestionnaireReplyAnswer[] => {
    const value = content[step.id];
    if (isMultiple(step)) {
      const options = step.options ?? [];
      if (options.length === 0) {
        if (step.allowOther && typeof value === 'string' && value.trim().length > 0) {
          return [{ stepId: step.id, selectedOther: true, otherText: value }];
        }
        return step.required ? [] : [{ stepId: step.id, skipped: true }];
      }
      const selectedOptionIds = questionnaireOptionIds(
        step,
        Array.isArray(value) ? value : [value],
      );
      const otherFieldId = fieldLayout.get(step.id)?.otherFieldId;
      const otherText = otherFieldId ? content[otherFieldId] : undefined;
      const selectedOther = typeof otherText === 'string' && otherText.trim().length > 0;
      if (selectedOptionIds.length > 0 || selectedOther) {
        return [
          {
            stepId: step.id,
            ...(selectedOptionIds.length > 0 ? { selectedOptionIds } : {}),
            ...(selectedOther ? { selectedOther: true, otherText } : {}),
          },
        ];
      }
      return step.required ? [] : [{ stepId: step.id, skipped: true }];
    }
    const otherFieldId = fieldLayout.get(step.id)?.otherFieldId;
    const otherText = otherFieldId ? content[otherFieldId] : undefined;
    if (typeof otherText === 'string' && otherText.trim().length > 0) {
      return [{ stepId: step.id, selectedOther: true, otherText }];
    }
    if (typeof value !== 'string') {
      return step.required ? [] : [{ stepId: step.id, skipped: true }];
    }
    const [selectedOptionId] = questionnaireOptionIds(step, [value]);
    if (selectedOptionId) {
      return [{ stepId: step.id, selectedOptionIds: [selectedOptionId] }];
    }
    if (step.allowOther && !otherFieldId) {
      return [{ stepId: step.id, selectedOther: true, otherText: value }];
    }
    return step.required ? [] : [{ stepId: step.id, skipped: true }];
  });
}

function questionnaireFieldLayout(
  request: TuiQuestionnaireRequest,
): ReadonlyMap<string, { readonly otherFieldId?: string }> {
  const used = new Set(request.steps.map(({ id }) => id));
  const layout = new Map<string, { readonly otherFieldId?: string }>();
  for (const step of request.steps) {
    if (!step.allowOther || (step.options ?? []).length === 0) {
      layout.set(step.id, {});
      continue;
    }
    let otherFieldId = `${step.id}__other`;
    while (used.has(otherFieldId)) otherFieldId += '_';
    used.add(otherFieldId);
    layout.set(step.id, { otherFieldId });
  }
  return layout;
}

function questionnaireOptionIds(step: TuiQuestionnaireStep, values: readonly unknown[]): string[] {
  const selected = values.flatMap((value) => {
    if (typeof value !== 'string') return [];
    const options = step.options ?? [];
    const optionById = options.find((candidate) => candidate.id === value);
    if (optionById) return [optionById.id];
    const optionsByLabel = options.filter((candidate) => candidate.label === value);
    const [onlyLabelMatch] = optionsByLabel;
    return optionsByLabel.length === 1 && onlyLabelMatch ? [onlyLabelMatch.id] : [];
  });
  return [...new Set(selected)];
}

function questionnaireEnumOptions(step: TuiQuestionnaireStep): acp.EnumOption[] {
  return (step.options ?? []).map((option) =>
    compact({
      const: option.id,
      title: option.label,
      description: option.description,
    }),
  );
}

function isMultiple(step: TuiQuestionnaireStep): boolean {
  return step.selectionMode === 'multiple' || step.selectionMode === 1;
}

function permissionRequest(
  sessionId: string,
  requestId: string,
  request: TuiPendingPermission,
): acp.RequestPermissionRequest {
  const rawInput = parseToolInput(request.toolInput);
  const locations = permissionLocations(request, rawInput);
  return {
    sessionId,
    toolCall: compact({
      toolCallId: requestId,
      title: request.toolDescription ?? request.toolName ?? 'MiniMax Code tool',
      name: request.toolName,
      kind: tuiAcpToolKind(request.toolName ?? ''),
      status: 'pending' as const,
      rawInput,
      locations,
    }),
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      ...(request.allowAlwaysSupported
        ? [{ optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' as const }]
        : []),
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  };
}

function parseToolInput(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function permissionLocations(
  request: TuiPendingPermission,
  rawInput: unknown,
): acp.ToolCallLocation[] | undefined {
  const paths = new Set<string>();
  for (const block of request.structuredPreview?.blocks ?? []) {
    if (block.path && isTuiAcpAbsolutePath(block.path)) paths.add(block.path);
  }
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const record = rawInput as Record<string, unknown>;
    for (const key of ['path', 'filePath', 'file_path']) {
      const path = record[key];
      if (typeof path === 'string' && isTuiAcpAbsolutePath(path)) paths.add(path);
    }
  }
  return paths.size > 0 ? [...paths].map((path) => ({ path })) : undefined;
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}
