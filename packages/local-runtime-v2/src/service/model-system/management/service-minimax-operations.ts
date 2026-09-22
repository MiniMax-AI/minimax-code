import { probeProviderCredential } from '@mavis/config';
import { maskSecret } from '../secret.js';
import { MANAGED_MINIMAX_PROVIDER_ID, MINIMAX_API_PROVIDER_ID } from '../identity.js';
import type { LocalModelConfig, ModelContextUpdateOutcome } from '../contracts.js';
import {
  cacheStatusView,
  minimaxApiModels,
  type ModelCacheStatusView,
} from '../catalog/list-models.js';
import { modelCacheStatusFor, type ModelCacheStatusEntry } from '../catalog/model-cache.js';
import { buildMinimaxProviderView, type ModelProviderView } from '../catalog/provider-views.js';
import { ModelProviderServiceContext } from './service-context.js';
import { LocalModelProviderError } from '../contracts.js';
import {
  asLocalModelProviderError,
  contextChangedError,
  enqueueProviderMutation,
  minimaxContextBaselineFingerprint,
  requireCacheStatusView,
} from './service-helpers.js';
import { assertValidRawApiKey } from './service-input.js';

interface MinimaxContextUpdateInput {
  modelId: string;
  contextLimit: number;
  expectedContextLimit: number;
}

interface PreparedMinimaxContextUpdate {
  modelId: string;
  currentModel: LocalModelConfig;
  baselineFingerprint: string;
  source: 'token_plan' | 'minimax_api_key';
  compareAndSet: NonNullable<ModelProviderServiceContext['deps']['compareAndSetModelContext']>;
}

export function getMinimaxApiKeyStatus(context: ModelProviderServiceContext): {
  hasApiKey: boolean;
  maskedApiKey?: string;
  cachedStatus?: ModelCacheStatusView;
} {
  const apiKey = probeProviderCredential({
    field: 'minimax_api.apiKey',
    provider: 'minimax_api',
    value: context.deps.configGetter().minimax_api?.apiKey,
  }).secret;
  if (!apiKey) return { hasApiKey: false };
  const cache = context.deps.cache.load();
  const target = context.resolveTestTarget(MINIMAX_API_PROVIDER_ID, undefined);
  return {
    hasApiKey: true,
    maskedApiKey: maskSecret(apiKey),
    cachedStatus: cacheStatusView(
      modelCacheStatusFor(
        cache,
        MINIMAX_API_PROVIDER_ID,
        target.target.modelId,
        target.fingerprint,
      ),
    ),
  };
}

export function getMinimaxModelSource(
  context: ModelProviderServiceContext,
): 'token_plan' | 'minimax_api_key' {
  return context.deps.configGetter().minimaxModelSource ?? 'token_plan';
}

export async function setMinimaxModelSource(
  context: ModelProviderServiceContext,
  source: 'token_plan' | 'minimax_api_key',
): Promise<string> {
  if (source !== 'token_plan' && source !== 'minimax_api_key') {
    throw new LocalModelProviderError(400, 'Invalid MiniMax model source', 'VALIDATION_ERROR');
  }
  let blocked: LocalModelProviderError | undefined;
  await context.deps.updateByokConfig((draft, currentConfig) => {
    if (source === 'minimax_api_key') {
      try {
        context.resolveMinimaxTestTarget(currentConfig, undefined);
      } catch (error) {
        blocked = asLocalModelProviderError(error);
        return;
      }
    }
    draft.minimaxModelSource = source;
  });
  if (blocked) throw blocked;
  return source;
}

export async function updateMinimaxModelContext(
  context: ModelProviderServiceContext,
  input: MinimaxContextUpdateInput,
): Promise<ModelContextUpdateOutcome> {
  return enqueueProviderMutation(context.minimaxMutationKey(), () =>
    updateMinimaxModelContextTransaction(context, input),
  );
}

async function updateMinimaxModelContextTransaction(
  context: ModelProviderServiceContext,
  input: MinimaxContextUpdateInput,
): Promise<ModelContextUpdateOutcome> {
  const prepared = prepareMinimaxContextUpdate(context, input);
  if (prepared.source === 'token_plan') {
    return updateTokenPlanModelContext(prepared, input);
  }
  return updateMinimaxApiModelContext(context, prepared, input);
}

function prepareMinimaxContextUpdate(
  context: ModelProviderServiceContext,
  input: MinimaxContextUpdateInput,
): PreparedMinimaxContextUpdate {
  const modelId = requireMinimaxContextSelection(input);
  const compareAndSet = context.deps.compareAndSetModelContext;
  if (!compareAndSet) {
    throw new LocalModelProviderError(
      503,
      'Model context selection is unavailable',
      'MODEL_CONTEXT_UNAVAILABLE',
    );
  }
  const baselineConfig = context.deps.configGetter();
  const source = baselineConfig.minimaxModelSource ?? 'token_plan';
  const currentModel =
    source === 'token_plan'
      ? baselineConfig.provider?.minimax?.models?.[modelId]
      : minimaxApiModels(baselineConfig)[modelId];
  if (!currentModel) {
    throw new LocalModelProviderError(404, 'Model not found', 'MODEL_NOT_FOUND');
  }
  if (!currentModel.contextWindowOptions?.includes(input.contextLimit)) {
    throw new LocalModelProviderError(
      400,
      'Invalid MiniMax model context selection',
      'INVALID_CONTEXT_LIMIT',
    );
  }
  if ((currentModel.limit?.context ?? 0) !== input.expectedContextLimit) {
    throw new LocalModelProviderError(
      409,
      'Model context changed before the update started',
      'CONFIG_CHANGED',
    );
  }

  const baselineFingerprint = minimaxContextBaselineFingerprint(baselineConfig, modelId);
  return { modelId, currentModel, baselineFingerprint, source, compareAndSet };
}

function requireMinimaxContextSelection(input: MinimaxContextUpdateInput): string {
  const modelId = input.modelId?.trim();
  if (!modelId || !Number.isSafeInteger(input.contextLimit) || input.contextLimit <= 0) {
    throw new LocalModelProviderError(
      400,
      'Invalid MiniMax model context selection',
      'INVALID_CONTEXT_LIMIT',
    );
  }
  if (!Number.isSafeInteger(input.expectedContextLimit) || input.expectedContextLimit <= 0) {
    throw new LocalModelProviderError(
      400,
      'expected_context_limit must be a positive integer',
      'VALIDATION_ERROR',
    );
  }
  return modelId;
}

async function updateTokenPlanModelContext(
  prepared: PreparedMinimaxContextUpdate,
  input: MinimaxContextUpdateInput,
): Promise<ModelContextUpdateOutcome> {
  const updated = await prepared.compareAndSet(
    minimaxContextUpdateSelection(prepared.source, prepared.modelId, input),
    async (latestConfig) =>
      minimaxContextBaselineFingerprint(latestConfig, prepared.modelId) ===
      prepared.baselineFingerprint,
  );
  if (!updated) throw contextChangedError();
  return { ok: true };
}

async function updateMinimaxApiModelContext(
  context: ModelProviderServiceContext,
  prepared: PreparedMinimaxContextUpdate,
  input: MinimaxContextUpdateInput,
): Promise<ModelContextUpdateOutcome> {
  const candidateModel: LocalModelConfig = {
    ...prepared.currentModel,
    limit: { ...prepared.currentModel.limit, context: input.contextLimit },
  };
  const target = context.resolveTestTarget(MINIMAX_API_PROVIDER_ID, prepared.modelId, {
    minimaxModelOverride: candidateModel,
  });
  const result = await context.deps.tester.test(
    `${target.cacheKey}@${target.fingerprint}`,
    target.target,
  );
  const entry = context.toCacheEntry(result, target.fingerprint);
  const status = requireCacheStatusView(entry);
  if (!result.ok) return { ok: false, status };

  let previousCacheEntry: ModelCacheStatusEntry | undefined;
  let candidateCacheWritten = false;
  try {
    const updated = await prepared.compareAndSet(
      minimaxContextUpdateSelection(prepared.source, prepared.modelId, input),
      async (latestConfig) => {
        const latestFingerprint = minimaxContextBaselineFingerprint(latestConfig, prepared.modelId);
        if (latestFingerprint !== prepared.baselineFingerprint) return false;
        previousCacheEntry = await context.deps.cache.replaceModelStatus(target.cacheKey, entry);
        candidateCacheWritten = true;
        return true;
      },
    );
    if (!updated) throw contextChangedError();
  } catch (error) {
    if (candidateCacheWritten) {
      try {
        await context.deps.cache.restoreModelStatusIfCurrent(
          target.cacheKey,
          entry,
          previousCacheEntry,
        );
      } catch {
        throw new LocalModelProviderError(
          500,
          'Failed to restore model test status after the config write failed',
          'CACHE_ROLLBACK_FAILED',
        );
      }
    }
    throw error;
  }
  return { ok: true, status };
}

function minimaxContextUpdateSelection(
  source: PreparedMinimaxContextUpdate['source'],
  modelId: string,
  input: MinimaxContextUpdateInput,
): {
  providerId: string;
  modelId: string;
  expectedContextLimit: number;
  contextLimit: number;
} {
  return {
    providerId: source === 'token_plan' ? MANAGED_MINIMAX_PROVIDER_ID : MINIMAX_API_PROVIDER_ID,
    modelId,
    expectedContextLimit: input.expectedContextLimit,
    contextLimit: input.contextLimit,
  };
}

export async function upsertMinimaxApiKey(
  context: ModelProviderServiceContext,
  input: { apiKey: string; saveAndUse?: boolean },
): Promise<ModelProviderView> {
  const apiKey = assertValidRawApiKey(input.apiKey);
  await context.deps.updateByokConfig((draft) => {
    draft.minimax_api = { ...(draft.minimax_api ?? {}), apiKey };
    if (input.saveAndUse) draft.minimaxModelSource = 'minimax_api_key';
  });
  return buildMinimaxProviderView(context.deps.configGetter(), context.deps.cache.load());
}
