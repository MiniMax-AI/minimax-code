import { CUSTOM_PROVIDER_ID_PREFIX, formatModelKey } from '../resolution/model-key.js';
import { resolveProviderCredential } from '@mavis/config';
import { normalizeProviderIdentityBaseUrl, isApiKeyProvider } from '../provider-identity.js';
import {
  LocalModelProviderError,
  type LocalByokConfigDraft,
  type LocalCustomProviderConfig,
  type LocalCustomProvidersConfig,
  type LocalModelConfig,
  type LocalRuntimeConfig,
  type ModelCacheStatusView,
  type ModelProviderTestOutcome,
  type SaveUserModelProviderCandidateOutcome,
  type UserModelProviderCandidateView,
} from '../contracts.js';
import type { DiscoveredModel } from '../connectivity/discover-models.js';
import { modelConfigFingerprint, type ModelCacheStatusEntry } from '../catalog/model-cache.js';
import {
  ModelProviderServiceContext,
  type ResolvedConnectionTestTarget,
  type ResolvedUserProviderCandidate,
} from './service-context.js';
import {
  modelParametersMatch,
  patchModelParameters,
  removeLegacyCustomProviderNpm,
  resetUnavailableCustomDefaultModel,
  requireCacheStatusView,
} from './service-helpers.js';
import { modelsFromInputs } from './service-input.js';
import { readApiKeys } from '../byok-keys/key-list.js';
import { byokTestKeyLabel, forgetDroppedApiKeys } from '../byok-keys/operations.js';

interface SaveCandidateInput {
  candidate: UserModelProviderCandidateView;
  modelId?: string;
  saveAndUse?: boolean;
  skipConnectionTest?: boolean;
  /** Process-local admission guard, checked inside the config transaction. */
  beforeCommit?: () => void;
  /** Import-only idempotency, checked inside the config transaction. */
  importIfExisting?: boolean;
}

interface PreparedCandidateTest {
  target?: ResolvedConnectionTestTarget;
  entry?: ModelCacheStatusEntry;
  status?: ModelCacheStatusView;
  failed: boolean;
}

interface CandidateCommitState {
  blocked?: 'config_changed' | 'cache_write_failed';
  candidateCacheWritten: boolean;
  previousCacheEntry?: ModelCacheStatusEntry;
}

interface CandidateSaveTransaction {
  resolved: ResolvedUserProviderCandidate;
  input: SaveCandidateInput;
  modelId?: string;
  test: PreparedCandidateTest;
  commit: CandidateCommitState;
  existingProviderId?: string;
}

interface UpdateModelParametersInput {
  providerId: string;
  modelId: string;
  contextLimit: number;
  maxOutputTokens: number;
  expectedContextLimit: number;
  expectedMaxOutputTokens: number;
}

interface PreparedModelParameterUpdate {
  providerKey: string;
  modelId: string;
  currentProvider: LocalCustomProviderConfig;
  normalizedPatch: LocalModelConfig;
  baselineFingerprint: string;
  target: ResolvedConnectionTestTarget;
}

interface ModelParameterCommitState {
  blocked?: 'config_changed' | 'model_missing' | 'cache_write_failed';
  candidateCacheWritten: boolean;
  previousCacheEntry?: ModelCacheStatusEntry;
}

interface ModelParameterRollback {
  target: ResolvedConnectionTestTarget;
  entry: ModelCacheStatusEntry;
  commit: ModelParameterCommitState;
  error: unknown;
}

export async function testUserModelCandidate(
  context: ModelProviderServiceContext,
  candidate: UserModelProviderCandidateView,
  modelId: string,
): Promise<ModelProviderTestOutcome> {
  const resolved = context.resolveUserProviderCandidate(candidate);
  const target = context.resolveTestTarget(resolved.providerId, modelId, {
    customProviderOverride: resolved.provider,
  });
  const result = await context.testResolvedTarget(target);
  const keyLabel = byokTestKeyLabel(resolved.provider);
  return {
    ok: result.ok,
    status: requireCacheStatusView(context.toCacheEntry(result, target.fingerprint)),
    ...(keyLabel ? { keyLabel } : {}),
  };
}

export async function discoverUserModelsCandidate(
  context: ModelProviderServiceContext,
  candidate: UserModelProviderCandidateView,
): Promise<DiscoveredModel[]> {
  const discoverer = context.deps.discoverer;
  if (!discoverer) {
    throw new LocalModelProviderError(
      503,
      'Model discovery is not configured',
      'MODEL_DISCOVERY_UNAVAILABLE',
    );
  }
  const resolved = context.resolveUserProviderCandidate(candidate);
  const result = await discoverer.discover(context.discoveryTargetForProvider(resolved.provider));
  if (!result.ok) {
    throw new LocalModelProviderError(502, result.errorMessage, result.errorCode);
  }
  return result.models;
}

export async function saveUserModelProviderCandidate(
  context: ModelProviderServiceContext,
  input: SaveCandidateInput,
): Promise<SaveUserModelProviderCandidateOutcome> {
  const resolved = context.resolveUserProviderCandidate(input.candidate);
  const modelId = input.modelId?.trim();
  const test = await prepareCandidateTest(context, resolved, input, modelId);
  if (test.failed) return { ok: false, status: requirePreparedCandidateStatus(test) };
  const commit: CandidateCommitState = {
    candidateCacheWritten: false,
  };
  const transaction: CandidateSaveTransaction = { resolved, input, modelId, test, commit };
  const keysBefore = readApiKeys(
    context.deps.configGetter().custom_provider?.[resolved.providerKey],
  );
  try {
    await persistCandidate(context, transaction);
  } catch (error) {
    await restoreCandidateAfterFailure(context, transaction, error);
  }
  throwCandidateCommitError(commit.blocked, input.skipConnectionTest === true);
  if (!transaction.existingProviderId)
    forgetDroppedApiKeys(context, resolved.providerKey, keysBefore);
  return {
    ok: true,
    ...(test.status ? { status: test.status } : {}),
    ...(input.skipConnectionTest ? { skippedTest: true } : {}),
    provider: context.requireCustomProviderView(
      transaction.existingProviderId ?? resolved.providerKey,
    ),
  };
}

async function prepareCandidateTest(
  context: ModelProviderServiceContext,
  resolved: ResolvedUserProviderCandidate,
  input: SaveCandidateInput,
  modelId: string | undefined,
): Promise<PreparedCandidateTest> {
  if (input.skipConnectionTest) return { failed: false };
  if (!modelId) {
    throw new LocalModelProviderError(
      400,
      'model_id is required when running a connection test',
      'VALIDATION_ERROR',
    );
  }
  const target = context.resolveTestTarget(resolved.providerId, modelId, {
    customProviderOverride: resolved.provider,
  });
  const result = await context.testResolvedTarget(target);
  const entry = context.toCacheEntry(result, target.fingerprint);
  return {
    target,
    entry,
    status: requireCacheStatusView(entry),
    failed: !result.ok,
  };
}

function requirePreparedCandidateStatus(test: PreparedCandidateTest): ModelCacheStatusView {
  if (test.status) return test.status;
  throw new LocalModelProviderError(
    500,
    'Failed to normalize the model connection test result',
    'TEST_STATUS_INVALID',
  );
}

async function persistCandidate(
  context: ModelProviderServiceContext,
  transaction: CandidateSaveTransaction,
): Promise<void> {
  await context.deps.updateByokConfig(async (draft, currentConfig) => {
    transaction.input.beforeCommit?.();
    const tree = (draft.custom_provider ?? {}) as LocalCustomProvidersConfig;
    if (transaction.input.importIfExisting) {
      const existingProviderId = findMatchingByokProvider(currentConfig, transaction.input.candidate);
      if (existingProviderId) {
        transaction.existingProviderId = existingProviderId;
        return;
      }
    }
    if (candidateRevisionChanged(transaction.resolved, tree, currentConfig)) {
      transaction.commit.blocked = 'config_changed';
      return;
    }
    if (!(await persistCandidateCache(context, transaction))) return;
    transaction.input.beforeCommit?.();
    tree[transaction.resolved.providerKey] = transaction.resolved.provider;
    draft.custom_provider = tree as Record<string, unknown>;
    activateSavedCandidate(draft, transaction);
    resetUnavailableCustomDefaultModel(draft, currentConfig);
  }, transaction.input.beforeCommit);
}

function findMatchingByokProvider(
  config: LocalRuntimeConfig,
  candidate: UserModelProviderCandidateView,
): string | undefined {
  const key = candidate.apiKey?.trim();
  const baseUrl = normalizeProviderIdentityBaseUrl(candidate.baseUrl);
  if (!key || !baseUrl) return undefined;
  for (const [id, provider] of Object.entries(config.custom_provider ?? {})) {
    if (!isApiKeyProvider(provider)) continue;
    let providerKey: string | undefined;
    try {
      providerKey = resolveProviderCredential({
        field: 'custom_provider options.apiKey',
        provider: id,
        value: provider.options?.apiKey,
      })?.trim();
    } catch {
      continue;
    }
    if (
      providerKey === key &&
      provider.options?.baseURL &&
      normalizeProviderIdentityBaseUrl(provider.options.baseURL) === baseUrl
    )
      return id;
  }
  return undefined;
}

function candidateRevisionChanged(
  resolved: ResolvedUserProviderCandidate,
  tree: LocalCustomProvidersConfig,
  currentConfig: LocalRuntimeConfig,
): boolean {
  // `draft` comes directly from YAML and can omit loader defaults. Compare an
  // existing provider against the normalized config while keeping the raw tree
  // as the value written back to disk.
  if (!resolved.expectedRevision) return tree[resolved.providerKey] !== undefined;
  const latest = currentConfig.custom_provider?.[resolved.providerKey];
  return !latest || modelConfigFingerprint(latest) !== resolved.expectedRevision;
}

async function persistCandidateCache(
  context: ModelProviderServiceContext,
  transaction: CandidateSaveTransaction,
): Promise<boolean> {
  const { entry, target } = transaction.test;
  if (!entry || !target) return true;
  try {
    transaction.commit.previousCacheEntry = await context.deps.cache.replaceModelStatus(
      target.cacheKey,
      entry,
    );
    transaction.commit.candidateCacheWritten = true;
    return true;
  } catch {
    transaction.commit.blocked = 'cache_write_failed';
    return false;
  }
}

function activateSavedCandidate(
  draft: LocalByokConfigDraft,
  transaction: CandidateSaveTransaction,
): void {
  if (!transaction.input.saveAndUse || transaction.input.skipConnectionTest) return;
  if (!transaction.modelId) return;
  draft.defaultModel = formatModelKey(transaction.resolved.providerId, transaction.modelId);
  draft.defaultModelVariant = undefined;
}

async function restoreCandidateAfterFailure(
  context: ModelProviderServiceContext,
  transaction: CandidateSaveTransaction,
  error: unknown,
): Promise<never> {
  const { entry, target } = transaction.test;
  if (entry && target) {
    return context.restoreCandidateCache(target.cacheKey, entry, transaction.commit, error);
  }
  throw error;
}

function throwCandidateCommitError(
  blocked: CandidateCommitState['blocked'],
  skippedConnectionTest: boolean,
): void {
  if (blocked === 'config_changed') {
    const message = skippedConnectionTest
      ? 'Provider changed while the candidate was being saved'
      : 'Provider changed while the connection test was running';
    throw new LocalModelProviderError(409, message, 'CONFIG_CHANGED');
  }
  if (blocked === 'cache_write_failed') {
    throw new LocalModelProviderError(
      500,
      'Failed to persist the successful model connection test',
      'CACHE_WRITE_FAILED',
    );
  }
}

export async function updateUserModelParameters(
  context: ModelProviderServiceContext,
  input: UpdateModelParametersInput,
): Promise<ModelProviderTestOutcome> {
  const prepared = prepareModelParameterUpdate(context, input);
  const result = await context.deps.tester.test(
    `${prepared.target.cacheKey}@${prepared.target.fingerprint}`,
    prepared.target.target,
  );
  const entry = context.toCacheEntry(result, prepared.target.fingerprint);
  if (!result.ok) return { ok: false, status: requireCacheStatusView(entry) };

  const commit: ModelParameterCommitState = { candidateCacheWritten: false };
  try {
    await persistModelParameterUpdate(context, prepared, entry, commit);
  } catch (error) {
    await restoreModelParameterCache(context, {
      target: prepared.target,
      entry,
      commit,
      error,
    });
  }
  throwModelParameterCommitError(commit.blocked);
  return { ok: true, status: requireCacheStatusView(entry) };
}

function prepareModelParameterUpdate(
  context: ModelProviderServiceContext,
  input: UpdateModelParametersInput,
): PreparedModelParameterUpdate {
  const providerKey = context.requireExistingProviderKey(input.providerId);
  const providerId = `${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`;
  const currentProvider = context.deps.configGetter().custom_provider?.[providerKey];
  if (!currentProvider) {
    throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
  }
  const modelId = input.modelId?.trim();
  const currentModel = modelId ? currentProvider?.models?.[modelId] : undefined;
  if (!modelId || !currentModel) {
    throw new LocalModelProviderError(404, 'Model not found', 'MODEL_NOT_FOUND');
  }
  if (!modelParametersMatch(currentModel, input)) {
    throw new LocalModelProviderError(
      409,
      'Model parameters changed before the update started',
      'CONFIG_CHANGED',
    );
  }
  const normalizedPatch = modelsFromInputs([
    {
      modelId,
      limit: { context: input.contextLimit, output: input.maxOutputTokens },
    },
  ])[modelId];
  if (!normalizedPatch) {
    throw new LocalModelProviderError(400, 'Model parameters are invalid', 'VALIDATION_ERROR');
  }
  const candidateModel = patchModelParameters(currentModel, normalizedPatch);
  const candidateProvider: LocalCustomProviderConfig = {
    ...currentProvider,
    models: { ...currentProvider.models, [modelId]: candidateModel },
  };
  const baselineFingerprint = modelConfigFingerprint(currentProvider);
  const target = context.resolveTestTarget(providerId, modelId, {
    customProviderOverride: candidateProvider,
  });
  return {
    providerKey,
    modelId,
    currentProvider,
    normalizedPatch,
    baselineFingerprint,
    target,
  };
}

async function persistModelParameterUpdate(
  context: ModelProviderServiceContext,
  prepared: PreparedModelParameterUpdate,
  entry: ModelCacheStatusEntry,
  commit: ModelParameterCommitState,
): Promise<void> {
  await context.deps.updateByokConfig(async (draft) => {
    const tree = (draft.custom_provider ?? {}) as LocalCustomProvidersConfig;
    const latestProvider = tree[prepared.providerKey];
    if (
      !latestProvider ||
      modelConfigFingerprint(latestProvider) !== prepared.baselineFingerprint
    ) {
      commit.blocked = 'config_changed';
      return;
    }
    const latestModel = latestProvider.models?.[prepared.modelId];
    if (!latestModel) {
      commit.blocked = 'model_missing';
      return;
    }
    if (!(await persistModelParameterCache(context, prepared.target, entry, commit))) return;
    latestProvider.models = {
      ...latestProvider.models,
      [prepared.modelId]: patchModelParameters(latestModel, prepared.normalizedPatch),
    };
    removeLegacyCustomProviderNpm(latestProvider);
    draft.custom_provider = tree as Record<string, unknown>;
  });
}

async function persistModelParameterCache(
  context: ModelProviderServiceContext,
  target: ResolvedConnectionTestTarget,
  entry: ModelCacheStatusEntry,
  commit: ModelParameterCommitState,
): Promise<boolean> {
  try {
    // Persist the successful credential while the config file lock is held.
    // A cache failure leaves the active config untouched.
    commit.previousCacheEntry = await context.deps.cache.replaceModelStatus(target.cacheKey, entry);
    commit.candidateCacheWritten = true;
    return true;
  } catch {
    commit.blocked = 'cache_write_failed';
    return false;
  }
}

async function restoreModelParameterCache(
  context: ModelProviderServiceContext,
  rollback: ModelParameterRollback,
): Promise<never> {
  if (rollback.commit.candidateCacheWritten) {
    try {
      await context.deps.cache.restoreModelStatusIfCurrent(
        rollback.target.cacheKey,
        rollback.entry,
        rollback.commit.previousCacheEntry,
      );
    } catch {
      throw new LocalModelProviderError(
        500,
        'Failed to restore model test status after the config write failed',
        'CACHE_ROLLBACK_FAILED',
      );
    }
  }
  throw rollback.error;
}

function throwModelParameterCommitError(blocked: ModelParameterCommitState['blocked']): void {
  if (blocked === 'config_changed') {
    throw new LocalModelProviderError(
      409,
      'Provider changed while the connection test was running',
      'CONFIG_CHANGED',
    );
  }
  if (blocked === 'model_missing') {
    throw new LocalModelProviderError(404, 'Model not found', 'MODEL_NOT_FOUND');
  }
  if (blocked === 'cache_write_failed') {
    throw new LocalModelProviderError(
      500,
      'Failed to persist the successful model connection test',
      'CACHE_WRITE_FAILED',
    );
  }
}
