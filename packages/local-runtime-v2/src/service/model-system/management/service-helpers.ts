import { DEFAULT_MODEL_PRESETS, getRuntimePresetKey } from '@mavis/config';

import { parseProviderId, parseSourceQualifiedModelKey } from '../resolution/model-key.js';
import type {
  LocalByokConfigDraft,
  LocalCustomProviderConfig,
  LocalCustomProvidersConfig,
  LocalModelConfig,
  LocalRuntimeConfig,
} from '../contracts.js';
import {
  cacheStatusView,
  minimaxApiModels,
  type ModelCacheStatusView,
} from '../catalog/list-models.js';
import { modelConfigFingerprint, type ModelCacheStatusEntry } from '../catalog/model-cache.js';
import { LocalModelProviderError } from '../contracts.js';

const providerMutationTails = new Map<string, Promise<void>>();

export function patchModelParameters(
  model: LocalModelConfig,
  normalizedPatch: LocalModelConfig,
): LocalModelConfig {
  return {
    ...model,
    limit: { ...model.limit, ...normalizedPatch.limit },
  };
}

export function removeLegacyCustomProviderNpm(provider: LocalCustomProviderConfig): void {
  delete provider.npm;
}

/** Keep the global default callable after a custom Provider/model mutation. */
export function resetUnavailableCustomDefaultModel(draft: LocalByokConfigDraft): boolean {
  const selected = parseSourceQualifiedModelKey(draft.defaultModel);
  if (selected?.source !== 'custom_provider') return false;
  const provider = (draft.custom_provider as LocalCustomProvidersConfig | undefined)?.[
    selected.providerKey
  ];
  const model = provider?.models?.[selected.modelId];
  if (provider?.enabled !== false && model && model.enabled !== false) return false;

  draft.defaultModel = DEFAULT_MODEL_PRESETS[getRuntimePresetKey()].defaultModel;
  draft.defaultModelVariant = undefined;
  return true;
}

export function nextDuplicateProviderName(input: {
  requestedName?: string;
  sourceName?: string;
  sourceProviderKey: string;
  providers: LocalCustomProvidersConfig;
}): string {
  const sourceDisplayName = input.sourceName?.trim() || input.sourceProviderKey;
  const baseName = input.requestedName?.trim() || `${sourceDisplayName} Copy`;
  const existingNames = new Set(
    Object.entries(input.providers).map(
      // A retired provider can survive in config as a null entry (e.g.
      // `oaii-oauth: null`); it still occupies its key as a display name.
      ([providerKey, provider]) => provider?.name?.trim() || providerKey,
    ),
  );
  if (!existingNames.has(baseName)) return baseName;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseName} ${suffix}`;
    if (!existingNames.has(candidate)) return candidate;
  }
}

export function modelParametersMatch(
  model: LocalModelConfig,
  expected: {
    expectedContextLimit: number;
    expectedMaxOutputTokens: number;
  },
): boolean {
  return (
    (model.limit?.context ?? 0) === expected.expectedContextLimit &&
    (model.limit?.output ?? 0) === expected.expectedMaxOutputTokens
  );
}

export function requireCacheStatusView(entry: ModelCacheStatusEntry): ModelCacheStatusView {
  const status = cacheStatusView(entry);
  if (!status) throw new Error('Model cache status entry is invalid');
  return status;
}

export function customProviderKeyFromId(providerId: string): string {
  const parsed = parseProviderId(providerId);
  const providerKey =
    parsed?.source === 'custom_provider' ? parsed.providerKey : providerId?.trim();
  if (!providerKey) {
    throw new LocalModelProviderError(400, 'Invalid model provider id', 'VALIDATION_ERROR');
  }
  return providerKey;
}

export function contextChangedError(): LocalModelProviderError {
  return new LocalModelProviderError(
    409,
    'Model context changed while the connection test was running',
    'CONFIG_CHANGED',
  );
}

export function asLocalModelProviderError(error: unknown): LocalModelProviderError {
  if (error instanceof LocalModelProviderError) return error;
  return new LocalModelProviderError(
    500,
    error instanceof Error ? error.message : String(error),
    'MODEL_PROVIDER_INTERNAL_ERROR',
  );
}

export function minimaxContextBaselineFingerprint(
  config: LocalRuntimeConfig,
  modelId: string,
): string {
  const source = config.minimaxModelSource ?? 'token_plan';
  return modelConfigFingerprint({
    source,
    minimaxApi: config.minimax_api,
    model:
      source === 'token_plan'
        ? config.provider?.minimax?.models?.[modelId]
        : minimaxApiModels(config)[modelId],
  });
}

export async function enqueueProviderMutation<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = providerMutationTails.get(key) ?? Promise.resolve();
  const current = runQueuedMutation(previous, operation);
  const tail = ignoreMutationOutcome(current);
  providerMutationTails.set(key, tail);
  try {
    return await current;
  } finally {
    if (providerMutationTails.get(key) === tail) providerMutationTails.delete(key);
  }
}

async function runQueuedMutation<T>(
  previous: Promise<void>,
  operation: () => Promise<T>,
): Promise<T> {
  await ignoreMutationOutcome(previous);
  return operation();
}

async function ignoreMutationOutcome(value: Promise<unknown>): Promise<void> {
  try {
    await value;
  } catch {
    // A failed mutation releases the queue for the next caller.
  }
}
