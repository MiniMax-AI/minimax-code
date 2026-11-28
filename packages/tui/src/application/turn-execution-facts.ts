import type { TuiConfigurationPort, TuiInspectionPort, TuiSessionPort } from '../runtime/port.js';
import type { TuiMessage } from '../runtime/stream-events.js';
import type { TuiModel, TuiSessionUsageRow } from '../types/runtime-models.js';
import {
  isTurnCompactionMessage,
  responseUsageFromMessage,
  sumResponseUsage,
  upsertResponseUsage,
} from './response-usage.js';
import type { ExecAdvisorSummary } from './advisor-calls.js';
import type {
  TuiModelReplacement,
  TuiTurnRunModel,
  TuiTurnRunOutcome,
  TuiTurnRunUsage,
} from './turn-run-outcome.js';

/** Model that actually served a Turn, enriched from the Runtime model catalog. */
export interface TuiTurnModelIdentity {
  readonly providerId: string;
  readonly modelId: string;
  readonly variant?: string;
  readonly providerSource?: string;
  readonly providerKind?: string;
  readonly protocol?: string;
}

export type TuiTurnUsageSource = 'completed_responses' | 'analytics_fallback' | 'unavailable';

/** Surface-neutral per-Turn facts shared by Headless results and ACP Prompt responses. */
export interface TuiTurnExecutionFacts {
  readonly model?: TuiTurnModelIdentity;
  readonly requestedModel?: TuiTurnModelIdentity;
  readonly modelReplacement?: TuiModelReplacement;
  readonly usage?: TuiTurnRunUsage;
  readonly usageSource: TuiTurnUsageSource;
  readonly usageIncomplete: boolean;
}

export type TuiTurnExecutionFactsRuntime = Pick<TuiSessionPort, 'listMessagePage'> &
  Pick<TuiInspectionPort, 'getSessionUsage'> &
  Pick<TuiConfigurationPort, 'listModels'>;

/**
 * Model facts only. Replacement detection does not need the usage reconciliation,
 * so it reads the analytics rows and the model catalog alone. The history scan
 * stays out of it, which keeps the interactive Turn path down to two reads.
 */
export type TuiTurnModelFactsRuntime = Pick<TuiInspectionPort, 'getSessionUsage'> &
  Pick<TuiConfigurationPort, 'listModels'>;

/** Model facts of one Turn, without the usage reconciliation. */
export interface TuiTurnModelFacts {
  readonly requestedModel?: TuiTurnModelIdentity;
  readonly modelReplacement?: TuiModelReplacement;
}

const EXECUTION_FACTS_DEADLINE_MS = 1_000;

export async function resolveTurnExecutionFacts(
  runtime: TuiTurnExecutionFactsRuntime,
  sessionId: string,
  turnId: string,
  outcome: TuiTurnRunOutcome,
  requestedModel?: TuiTurnRunModel,
): Promise<TuiTurnExecutionFacts> {
  // Result assembly must not hold the terminal response open when an inspection RPC stalls.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXECUTION_FACTS_DEADLINE_MS);
  const [usage, models, history] = await Promise.all([
    readExecutionFact(() => runtime.getSessionUsage(sessionId), undefined, controller.signal),
    readExecutionFact(() => runtime.listModels(sessionId), [], controller.signal),
    readExecutionFact(
      () => loadTurnHistory(runtime, sessionId, turnId, controller.signal),
      undefined,
      controller.signal,
    ),
  ]).finally(() => clearTimeout(timer));
  const rows = mainModelUsageRows(usage?.rows, turnId, outcome.advisor);
  const model = resolveTurnModelIdentity(rows, models, outcome);
  const requested = requestedModel
    ? resolveModelIdentity(
        `${requestedModel.providerId}/${requestedModel.modelId}`,
        models,
        requestedModel.variant,
      )
    : undefined;
  const modelReplacement =
    requested && model
      ? detectModelReplacement(requestedModel, requested, model, models)
      : undefined;
  const responses = [...(outcome.usageResponses ?? [])];
  const historyIds = new Set<string>();
  for (const message of history?.messages ?? []) {
    const response = responseUsageFromMessage(message, turnId);
    if (!response) continue;
    if (response.messageId) historyIds.add(response.messageId);
    // Unidentified history cannot be reconciled against stream delivery safely.
    if (response.messageId) upsertResponseUsage(responses, response);
  }
  const responseSummary = sumResponseUsage(responses);
  const responseUsage = normalizeTurnUsage(responseSummary.usage ?? outcome.usage);
  const tokenUsage = responseUsage ?? sumUsageRows(rows);
  const usageIncomplete =
    outcome.status !== 'succeeded' ||
    outcome.usageIncomplete === true ||
    !history?.complete ||
    history.messages.some((message) => isTurnCompactionMessage(message, turnId)) ||
    responseSummary.usageIncomplete ||
    (responseUsage !== undefined && responseUsage.totalTokens === undefined) ||
    responses.length === 0 ||
    responses.some(
      (response) =>
        !response.messageId ||
        !historyIds.has(response.messageId) ||
        !normalizeTurnUsage(response.usage) ||
        response.usageIncomplete,
    ) ||
    (history?.messages.some((message) => {
      const response = responseUsageFromMessage(message, turnId);
      return response !== undefined && !response.messageId;
    }) ??
      false);
  return {
    ...(model ? { model } : {}),
    ...(requested ? { requestedModel: requested } : {}),
    ...(modelReplacement ? { modelReplacement } : {}),
    ...(tokenUsage ? { usage: tokenUsage } : {}),
    usageSource: responseUsage
      ? 'completed_responses'
      : tokenUsage
        ? 'analytics_fallback'
        : 'unavailable',
    usageIncomplete: !responseUsage || usageIncomplete,
  };
}

/**
 * Model facts of one Turn, resolved without the usage reconciliation.
 *
 * The actual model comes from the analytics rows of this Turn; the requested model
 * is the explicit request the caller made. Without a requested model there is
 * nothing to compare, so this returns nothing at all.
 */
export async function resolveTurnModelFacts(
  runtime: TuiTurnModelFactsRuntime,
  sessionId: string,
  turnId: string,
  outcome: TuiTurnRunOutcome,
  requestedModel?: TuiTurnRunModel,
): Promise<TuiTurnModelFacts> {
  if (!requestedModel) return {};
  // Result assembly must not hold the terminal response open when an inspection RPC stalls.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXECUTION_FACTS_DEADLINE_MS);
  const [usage, models] = await Promise.all([
    readExecutionFact(() => runtime.getSessionUsage(sessionId), undefined, controller.signal),
    readExecutionFact(() => runtime.listModels(sessionId), [], controller.signal),
  ]).finally(() => clearTimeout(timer));
  const rows = mainModelUsageRows(usage?.rows, turnId, outcome.advisor);
  const model = resolveTurnModelIdentity(rows, models, outcome);
  const requested = resolveModelIdentity(
    `${requestedModel.providerId}/${requestedModel.modelId}`,
    models,
    requestedModel.variant,
  );
  if (!model || !requested) return { requestedModel: requested };
  const modelReplacement = detectModelReplacement(requestedModel, requested, model, models);
  return {
    requestedModel: requested,
    ...(modelReplacement ? { modelReplacement } : {}),
  };
}

/**
 * This Turn's usage rows of the main model. An advisor call records its usage on the Turn as well,
 * since its cost is the Turn's, so the rows of this Turn's advisor models are left out here. When
 * the advisor is the main model, its rows go too and the Turn's own model identity is used.
 */
function mainModelUsageRows(
  rows: readonly TuiSessionUsageRow[] | undefined,
  turnId: string,
  advisor: ExecAdvisorSummary | undefined,
): TuiSessionUsageRow[] {
  const advisorModels = new Set(
    (advisor?.calls ?? []).flatMap((call) =>
      call.providerId && call.modelId ? [`${call.providerId}/${call.modelId}`] : [],
    ),
  );
  return (rows ?? []).filter(
    (row) => row.turnId === turnId && !advisorModels.has(row.model?.trim() ?? ''),
  );
}

export async function loadTurnHistory(
  runtime: Pick<TuiSessionPort, 'listMessagePage'>,
  sessionId: string,
  turnId: string,
  signal?: AbortSignal,
): Promise<{ messages: TuiMessage[]; complete: boolean }> {
  const pages: TuiMessage[][] = [];
  const seenCursors = new Set<string>();
  let before: string | undefined;
  let turnSeen = false;
  for (let pageCount = 0; pageCount < 100; pageCount += 1) {
    signal?.throwIfAborted();
    const page = await runtime.listMessagePage(sessionId, {
      limit: 200,
      ...(before ? { before } : {}),
    });
    signal?.throwIfAborted();
    const turnMessages = page.messages.filter((message) => message.turnId === turnId);
    pages.unshift(turnMessages);
    if (!page.hasMore) return { messages: pages.flat(), complete: true };
    // Pages are chronological and a Session runs one Turn at a time. Once a message that
    // belongs to another Turn precedes this Turn's earliest message, older pages cannot hold
    // it. Messages without a Turn id prove nothing and never end the scan early.
    turnSeen ||= turnMessages.length > 0;
    const firstTurnIndex = page.messages.findIndex((message) => message.turnId === turnId);
    const olderMessages =
      firstTurnIndex === -1 ? page.messages : page.messages.slice(0, firstTurnIndex);
    if (turnSeen && olderMessages.some((message) => message.turnId && message.turnId !== turnId)) {
      return { messages: pages.flat(), complete: true };
    }
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) break;
    seenCursors.add(page.nextCursor);
    before = page.nextCursor;
  }
  return { messages: pages.flat(), complete: false };
}

/**
 * Recomputes totalTokens as the sum of all token types, matching the Runtime's provider total:
 * input (cache misses) + output + cache read + cache write. Reasoning is not added because
 * providers report it within output.
 */
export function normalizeTurnUsage(
  value: TuiTurnRunUsage | undefined,
): TuiTurnRunUsage | undefined {
  if (!value) return undefined;
  const usage = { ...value };
  delete usage.totalTokens;
  const input = usage.inputTokens;
  const output = usage.outputTokens;
  const total =
    (input ?? 0) + (output ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return Object.keys(usage).length === 0
    ? undefined
    : {
        ...usage,
        ...((input !== undefined || output !== undefined) && Number.isFinite(total)
          ? { totalTokens: total }
          : {}),
      };
}

function readExecutionFact<T>(
  read: () => Promise<T>,
  fallback: T,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolveFact) => {
    const finish = (value: T) => {
      signal.removeEventListener('abort', abort);
      resolveFact(value);
    };
    const abort = () => finish(fallback);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) return abort();
    void Promise.resolve()
      .then(read)
      .then(finish, () => finish(fallback));
  });
}

/**
 * The model that actually served the Turn. The analytics rows of this Turn are the
 * proof; the Turn's own model echo and the Session's selected model are the
 * fallbacks when the analytics table has nothing to say yet.
 */
function resolveTurnModelIdentity(
  rows: readonly TuiSessionUsageRow[],
  models: readonly TuiModel[],
  outcome: TuiTurnRunOutcome,
): TuiTurnModelIdentity | undefined {
  const actualModel = [...rows]
    .reverse()
    .find((row) => row.model?.trim())
    ?.model?.trim();
  const fallbackModel = outcome.model
    ? `${outcome.model.providerId}/${outcome.model.modelId}`
    : undefined;
  const selectedModel = models.find((candidate) => candidate.selected === true);
  const selectedReference = selectedModel
    ? `${selectedModel.providerId}/${selectedModel.modelId}`
    : undefined;
  return resolveModelIdentity(
    actualModel ?? fallbackModel ?? selectedReference,
    models,
    outcome.model?.variant,
  );
}

function resolveModelIdentity(
  reference: string | undefined,
  models: readonly TuiModel[],
  requestedVariant: string | undefined,
): TuiTurnModelIdentity | undefined {
  const separator = reference?.indexOf('/') ?? -1;
  if (!reference || separator <= 0 || separator === reference.length - 1) return undefined;
  const providerId = reference.slice(0, separator);
  const modelId = reference.slice(separator + 1);
  const catalog = models.find(
    (candidate) => candidate.providerId === providerId && candidate.modelId === modelId,
  );
  return {
    providerId,
    modelId,
    ...(catalog?.variant !== undefined
      ? { variant: catalog.variant }
      : requestedVariant !== undefined
        ? { variant: requestedVariant }
        : {}),
    ...(catalog?.providerSource ? { providerSource: catalog.providerSource } : {}),
    ...(catalog?.providerKind ? { providerKind: catalog.providerKind } : {}),
    ...(catalog?.apiFormat ? { protocol: catalog.apiFormat } : {}),
  };
}

function detectModelReplacement(
  requestedInput: TuiTurnRunModel | undefined,
  requested: TuiTurnModelIdentity,
  actual: TuiTurnModelIdentity,
  models: readonly TuiModel[],
): TuiModelReplacement | undefined {
  if (
    !requestedInput ||
    (requested.providerId === actual.providerId && requested.modelId === actual.modelId)
  ) {
    return undefined;
  }
  const requestedInCatalog = models.some(
    (candidate) =>
      candidate.providerId === requested.providerId && candidate.modelId === requested.modelId,
  );
  return {
    requestedModel: requestedInput,
    actualModel: actual,
    tier: requestedInCatalog ? 'runtime_selection' : 'runtime_fallback',
    reason: requestedInCatalog
      ? 'runtime_selected_different_effective_model'
      : 'requested_model_not_in_runtime_catalog',
  };
}

function sumUsageRows(rows: readonly TuiSessionUsageRow[]): TuiTurnRunUsage | undefined {
  // Analytics has row identity, not response identity: it is only a partial fallback.
  const identified = new Map<number, TuiSessionUsageRow>();
  const anonymous: TuiSessionUsageRow[] = [];
  for (const row of rows) {
    if (row.id === undefined) anonymous.push(row);
    else identified.set(row.id, row);
  }
  const uniqueRows = [...identified.values(), ...anonymous];
  const usage = {
    ...sumUsageField(uniqueRows, 'inputTokens'),
    ...sumUsageField(uniqueRows, 'outputTokens'),
    ...sumUsageField(uniqueRows, 'reasoningTokens'),
    ...sumUsageField(uniqueRows, 'cacheReadTokens'),
    ...sumUsageField(uniqueRows, 'cacheWriteTokens'),
  };
  return normalizeTurnUsage(usage);
}

function sumUsageField(
  rows: readonly TuiSessionUsageRow[],
  key: keyof TuiTurnRunUsage,
): Partial<TuiTurnRunUsage> {
  const values = rows
    .map((row) => row[key as keyof TuiSessionUsageRow])
    .filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0,
    );
  const sum = values.reduce((accumulated, value) => accumulated + value, 0);
  return values.length > 0 && Number.isFinite(sum) ? { [key]: sum } : {};
}
