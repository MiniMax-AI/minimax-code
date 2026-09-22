import { resolveProviderCredential } from '@mavis/config';

import {
  CUSTOM_PROVIDER_ID_PREFIX,
  MINIMAX_API_PROVIDER_ID,
  formatModelKey,
  parseProviderId,
} from '../resolution/model-key.js';
import {
  LocalModelProviderError,
  type LocalCustomProviderConfig,
  type LocalModelConfig,
  type LocalModelProviderServiceDeps,
  type LocalRuntimeConfig,
  type ModelConnectionTestResult,
  type ModelConnectionTestTarget,
  type UserModelProviderCandidateView,
} from '../contracts.js';
import type { ModelDiscoveryTarget } from '../connectivity/discover-models.js';
import { modelConnectionTestFingerprint } from '../catalog/config-fingerprint.js';
import { minimaxApiBaseUrl, minimaxApiModels } from '../catalog/list-models.js';
import { modelConfigFingerprint, type ModelCacheStatusEntry } from '../catalog/model-cache.js';
import { generateProviderKey } from './provider-key.js';
import { buildCustomProviderView, type ModelProviderView } from '../catalog/provider-views.js';
import {
  mergeProviderHeaders,
  normalizeProviderBaseUrl,
} from '../connectivity/provider-request.js';
import {
  mergeModelsFromInputs,
  normalizeApiFormat,
  applyProviderCredentialUpdate,
  normalizeProviderCredentialUpdate,
  normalizeHeaderNames,
  normalizeHeaders,
  removeHeaderCaseInsensitive,
} from './service-input.js';
import { customProviderKeyFromId, removeLegacyCustomProviderNpm } from './service-helpers.js';
import {
  isMiniMaxM3ModelId,
  normalizeModelThinkingEffortOptions,
  type MiniMaxM3ThinkingMode,
} from '../resolution/model-ref.js';
import { byokEffectiveOutputLimit } from '../resolution/model-resolver-byok.js';

export interface ResolvedUserProviderCandidate {
  providerKey: string;
  providerId: string;
  provider: LocalCustomProviderConfig;
  expectedRevision?: string;
}

export interface ResolvedConnectionTestTarget {
  cacheKey: string;
  fingerprint: string;
  target: ModelConnectionTestTarget;
  effortOptions?: string[];
  minimaxM3ThinkingModes?: MiniMaxM3ThinkingMode[];
}

interface ResolveTestTargetOptions {
  apiKeyOverride?: string;
  customProviderOverride?: LocalCustomProviderConfig;
  minimaxModelOverride?: LocalModelConfig;
}

interface ResolveMinimaxTestTargetOptions {
  apiKeyOverride?: string;
  modelOverride?: LocalModelConfig;
}

interface CandidateIdentity {
  providerKey: string;
  current?: LocalCustomProviderConfig;
  expectedRevision?: string;
}

function requireCandidateBaseUrl(value: string | undefined): string {
  const baseUrl = value?.trim();
  if (!baseUrl) {
    throw new LocalModelProviderError(400, 'base_url must not be empty', 'VALIDATION_ERROR');
  }
  return baseUrl;
}

function candidateOptions(
  current: LocalCustomProviderConfig | undefined,
  input: UserModelProviderCandidateView,
  baseUrl: string,
): NonNullable<LocalCustomProviderConfig['options']> {
  const apiKeyUpdate = normalizeProviderCredentialUpdate(input);
  const options = { ...(current?.options ?? {}), baseURL: baseUrl, authMode: 'api-key' as const };
  // A new provider needs a credential it can actually use; an existing one
  // keeps whatever it already has when the request carries none. `keep` on an
  // edit is a no-op, not a missing-key error.
  if (!current && apiKeyUpdate.kind !== 'set') {
    throw new LocalModelProviderError(400, 'API key must not be empty', 'INVALID_API_KEY');
  }
  applyProviderCredentialUpdate(options, apiKeyUpdate);
  applyCandidateHeaderUpdates(options, current, input);
  return options;
}

function applyCandidateHeaderUpdates(
  options: NonNullable<LocalCustomProviderConfig['options']>,
  current: LocalCustomProviderConfig | undefined,
  input: UserModelProviderCandidateView,
): void {
  const removeHeaders = normalizeHeaderNames(input.removeHeaders);
  if (input.headers === undefined && removeHeaders.length === 0) return;
  const headers = input.headers === undefined ? undefined : normalizeHeaders(input.headers);
  const nextHeaders = { ...(current?.options?.headers ?? {}) };
  for (const name of removeHeaders) removeHeaderCaseInsensitive(nextHeaders, name);
  for (const [name, value] of Object.entries(headers ?? {})) {
    removeHeaderCaseInsensitive(nextHeaders, name);
    nextHeaders[name] = value;
  }
  if (Object.keys(nextHeaders).length > 0) options.headers = nextHeaders;
  else delete options.headers;
}

function candidateApiFormat(
  current: LocalCustomProviderConfig | undefined,
  input: UserModelProviderCandidateView,
): LocalCustomProviderConfig['api'] {
  return input.apiFormat === undefined ? current?.api : normalizeApiFormat(input.apiFormat);
}

function candidateModelFields(
  current: LocalCustomProviderConfig | undefined,
  input: UserModelProviderCandidateView,
  implicitCustomProviderThinking: boolean,
): Pick<LocalCustomProviderConfig, 'models'> | Record<string, never> {
  if (input.models !== undefined) {
    return {
      models: mergeModelsFromInputs(current?.models, input.models, implicitCustomProviderThinking),
    };
  }
  return current?.models ? { models: current.models } : {};
}

interface ConnectionTestCase {
  dedupKey: string;
  label: string;
  target: ModelConnectionTestTarget;
}

function minimaxThinkingTestCases(
  resolved: ResolvedConnectionTestTarget,
  dedupKey: string,
): ConnectionTestCase[] {
  return (resolved.minimaxM3ThinkingModes ?? []).map((mode) => ({
    dedupKey: `${dedupKey}@minimax-m3-thinking=${mode}`,
    label: `MiniMax M3 Thinking ${JSON.stringify(mode)}`,
    target: { ...resolved.target, minimaxM3ThinkingMode: mode },
  }));
}

function effortTestCases(
  resolved: ResolvedConnectionTestTarget,
  dedupKey: string,
): ConnectionTestCase[] {
  return (resolved.effortOptions ?? []).map((effort) => ({
    dedupKey: `${dedupKey}@effort=${encodeURIComponent(effort)}`,
    label: `Think Effort ${JSON.stringify(effort)}`,
    target: { ...resolved.target, effort },
  }));
}

async function runConnectionTestCases(
  tester: LocalModelProviderServiceDeps['tester'],
  cases: readonly ConnectionTestCase[],
): Promise<ModelConnectionTestResult> {
  const failures: Array<{ label: string; result: ModelConnectionTestResult }> = [];
  for (const testCase of cases) {
    const result = await tester.test(testCase.dedupKey, testCase.target);
    if (!result.ok) failures.push({ label: testCase.label, result });
  }
  const firstFailure = failures[0];
  if (!firstFailure) return { ok: true };
  return {
    ok: false,
    ...(firstFailure.result.errorCode ? { errorCode: firstFailure.result.errorCode } : {}),
    errorMessage: failures
      .map(({ label, result }) => `${label}: ${connectionTestFailureMessage(result)}`)
      .join('; ')
      .slice(0, 500),
  };
}

function connectionTestFailureMessage(result: ModelConnectionTestResult): string {
  return result.errorMessage || result.errorCode || 'Connection test failed';
}

function requireCustomProviderCredentials(
  provider: LocalCustomProviderConfig | undefined,
  apiKeyOverride: string | undefined,
  providerId: string,
): { apiKey: string; baseUrl: string } {
  // A request about to leave the machine must surface the resolver's own
  // diagnosis. The probe is the view's tool: it reports a broken reference as
  // "configured" and returns no secret, which would downgrade "environment
  // variable MAFIA_KEY is not set" to a generic missing key.
  const apiKey =
    apiKeyOverride?.trim() ||
    resolveProviderCredential({
      field: 'options.apiKey',
      provider: providerId,
      value: provider?.options?.apiKey,
    });
  if (!apiKey) {
    throw new LocalModelProviderError(400, 'Provider API key is not configured', 'NO_API_KEY');
  }
  const baseUrl = provider?.options?.baseURL?.trim();
  if (!baseUrl) {
    throw new LocalModelProviderError(400, 'Provider base_url is not configured', 'NO_BASE_URL');
  }
  return { apiKey, baseUrl };
}

function requireCustomProviderModelId(
  provider: LocalCustomProviderConfig | undefined,
  requestedModelId: string | undefined,
): string {
  const modelIds = Object.keys(provider?.models ?? {});
  const modelId = requestedModelId ?? modelIds[0];
  if (modelId && (!requestedModelId || modelIds.includes(requestedModelId))) return modelId;
  if (requestedModelId) {
    throw new LocalModelProviderError(404, 'Model not found', 'MODEL_NOT_FOUND');
  }
  throw new LocalModelProviderError(400, 'Provider has no configured models', 'NO_MODELS');
}

function requireMinimaxModelId(
  models: Record<string, LocalModelConfig>,
  requestedModelId: string | undefined,
): string {
  const modelId = requestedModelId ?? Object.keys(models)[0];
  if (modelId && (!requestedModelId || Object.hasOwn(models, requestedModelId))) return modelId;
  throw new LocalModelProviderError(404, 'Model not found', 'MODEL_NOT_FOUND');
}

function minimaxThinkingModes(modelId: string): MiniMaxM3ThinkingMode[] | undefined {
  return isMiniMaxM3ModelId(modelId) ? ['on', 'off'] : undefined;
}

function providerTestCacheKey(providerId: string, modelId: string | undefined): string {
  return modelId ? formatModelKey(providerId, modelId) : providerId;
}

export class ModelProviderServiceContext {
  constructor(readonly deps: LocalModelProviderServiceDeps) {}

  minimaxMutationKey(): string {
    return `${this.deps.configGetter().dataDir}\u0000${MINIMAX_API_PROVIDER_ID}`;
  }

  resolveUserProviderCandidate(
    input: UserModelProviderCandidateView,
  ): ResolvedUserProviderCandidate {
    const config = this.deps.configGetter();
    const identity = this.resolveCandidateIdentity(input, config);
    const baseUrl = requireCandidateBaseUrl(input.baseUrl);
    const options = candidateOptions(identity.current, input, baseUrl);
    const apiFormat = candidateApiFormat(identity.current, input);
    const provider: LocalCustomProviderConfig = {
      ...(identity.current ?? {}),
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      kind: identity.current?.kind ?? 'custom',
      enabled: identity.current?.enabled ?? true,
      ...(apiFormat ? { api: apiFormat } : {}),
      options,
      ...candidateModelFields(
        identity.current,
        input,
        this.deps.implicitCustomProviderThinking === true,
      ),
    };
    if (!apiFormat) delete provider.api;
    removeLegacyCustomProviderNpm(provider);
    return {
      providerKey: identity.providerKey,
      providerId: `${CUSTOM_PROVIDER_ID_PREFIX}${identity.providerKey}`,
      provider,
      ...(identity.expectedRevision ? { expectedRevision: identity.expectedRevision } : {}),
    };
  }

  private resolveCandidateIdentity(
    input: UserModelProviderCandidateView,
    config: LocalRuntimeConfig,
  ): CandidateIdentity {
    const requestedProviderId = input.providerId?.trim();
    if (!requestedProviderId) {
      return {
        providerKey: generateProviderKey({
          displayName: input.name?.trim(),
          existingKeys: Object.keys(config.custom_provider ?? {}),
          ...(this.deps.randomHex ? { randomHex: this.deps.randomHex } : {}),
        }),
      };
    }
    const providerKey = this.requireExistingProviderKey(requestedProviderId);
    const current = config.custom_provider?.[providerKey];
    const expectedRevision = input.expectedRevision?.trim();
    if (!current || !expectedRevision || modelConfigFingerprint(current) !== expectedRevision) {
      throw new LocalModelProviderError(409, 'Provider configuration changed', 'CONFIG_CHANGED');
    }
    return { providerKey, current, expectedRevision };
  }

  discoveryTargetForProvider(provider: LocalCustomProviderConfig): ModelDiscoveryTarget {
    // Discovery talks to the upstream, so it needs the same credential the turn
    // path uses. Reading the raw field sent a `${VAR}` literal as the key.
    const apiKey = resolveProviderCredential({
      field: 'options.apiKey',
      provider: provider.name ?? 'custom_provider',
      value: provider.options?.apiKey,
    });
    if (!apiKey) {
      throw new LocalModelProviderError(400, 'Provider API key is not configured', 'NO_API_KEY');
    }
    const baseUrl = provider.options?.baseURL?.trim();
    if (!baseUrl) {
      throw new LocalModelProviderError(400, 'Provider base_url is not configured', 'NO_BASE_URL');
    }
    return {
      api: normalizeApiFormat(provider.api) ?? 'anthropic-messages',
      baseUrl,
      apiKey,
      ...(provider.options?.headers ? { headers: provider.options.headers } : {}),
    };
  }

  async restoreCandidateCache(
    cacheKey: string,
    expectedCurrent: ModelCacheStatusEntry,
    commit: {
      candidateCacheWritten: boolean;
      previousCacheEntry?: ModelCacheStatusEntry;
    },
    originalError: unknown,
  ): Promise<never> {
    if (commit.candidateCacheWritten) {
      try {
        await this.deps.cache.restoreModelStatusIfCurrent(
          cacheKey,
          expectedCurrent,
          commit.previousCacheEntry,
        );
      } catch {
        throw new LocalModelProviderError(
          500,
          'Failed to restore model test status after the config write failed',
          'CACHE_ROLLBACK_FAILED',
        );
      }
    }
    throw originalError;
  }

  async testResolvedTarget(
    resolved: ResolvedConnectionTestTarget,
  ): Promise<ModelConnectionTestResult> {
    const dedupKey = `${resolved.cacheKey}@${resolved.fingerprint}`;
    if (resolved.minimaxM3ThinkingModes?.length) {
      return runConnectionTestCases(this.deps.tester, minimaxThinkingTestCases(resolved, dedupKey));
    }
    if (resolved.effortOptions?.length) {
      return runConnectionTestCases(this.deps.tester, effortTestCases(resolved, dedupKey));
    }
    return this.deps.tester.test(dedupKey, resolved.target);
  }

  resolveTestTarget(
    providerId: string,
    modelId: string | undefined,
    options: ResolveTestTargetOptions = {},
  ): ResolvedConnectionTestTarget {
    const config = this.deps.configGetter();
    if (parseProviderId(providerId)?.source === 'minimax_api') {
      return this.resolveMinimaxTestTarget(config, modelId, {
        ...(options.apiKeyOverride ? { apiKeyOverride: options.apiKeyOverride } : {}),
        ...(options.minimaxModelOverride ? { modelOverride: options.minimaxModelOverride } : {}),
      });
    }
    return this.resolveCustomTestTarget(config, providerId, modelId, options);
  }

  private resolveCustomTestTarget(
    config: LocalRuntimeConfig,
    providerId: string,
    modelId: string | undefined,
    options: ResolveTestTargetOptions,
  ): ResolvedConnectionTestTarget {
    const providerKey = options.customProviderOverride
      ? customProviderKeyFromId(providerId)
      : this.requireExistingProviderKey(providerId);
    const provider = options.customProviderOverride ?? config.custom_provider?.[providerKey];
    const { apiKey, baseUrl } = requireCustomProviderCredentials(
      provider,
      options.apiKeyOverride,
      `${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`,
    );
    const chosenModelId = requireCustomProviderModelId(provider, modelId);
    const fullProviderId = `${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`;
    const api = normalizeApiFormat(provider?.api) ?? 'anthropic-messages';
    const model = provider?.models?.[chosenModelId];
    const effortOptions = normalizeModelThinkingEffortOptions(model?.thinking?.effortOptions);
    const headers = mergeProviderHeaders(provider?.options?.headers, model?.headers);
    const outputLimit = byokEffectiveOutputLimit(model);
    const target: ModelConnectionTestTarget = {
      api,
      baseUrl: normalizeProviderBaseUrl(api, baseUrl),
      apiKey,
      modelId: chosenModelId,
      ...(headers ? { headers } : {}),
      outputLimit,
    };
    return {
      cacheKey: providerTestCacheKey(fullProviderId, modelId),
      fingerprint: modelConnectionTestFingerprint(target, provider?.models?.[chosenModelId]),
      target,
      ...(effortOptions ? { effortOptions } : {}),
    };
  }

  resolveMinimaxTestTarget(
    config: LocalRuntimeConfig,
    modelId: string | undefined,
    options: ResolveMinimaxTestTargetOptions = {},
  ): ResolvedConnectionTestTarget {
    const apiKey =
      options.apiKeyOverride?.trim() ||
      resolveProviderCredential({
        field: 'minimax_api.apiKey',
        provider: 'minimax_api',
        value: config.minimax_api?.apiKey,
      });
    if (!apiKey) {
      throw new LocalModelProviderError(400, 'MiniMax API key is not configured', 'NO_API_KEY');
    }
    const models = minimaxApiModels(config);
    const chosenModelId = requireMinimaxModelId(models, modelId);
    const model = options.modelOverride ?? models[chosenModelId];
    const effortOptions = normalizeModelThinkingEffortOptions(model?.thinking?.effortOptions);
    const minimaxM3ThinkingModes = minimaxThinkingModes(chosenModelId);
    const outputLimit = byokEffectiveOutputLimit(model);
    const target: ModelConnectionTestTarget = {
      api: 'anthropic-messages',
      baseUrl: normalizeProviderBaseUrl('anthropic-messages', minimaxApiBaseUrl(config)),
      apiKey,
      modelId: chosenModelId,
      outputLimit,
    };
    return {
      cacheKey: providerTestCacheKey(MINIMAX_API_PROVIDER_ID, modelId),
      fingerprint: modelConnectionTestFingerprint(target, model),
      target,
      ...(minimaxM3ThinkingModes ? { minimaxM3ThinkingModes } : {}),
      ...(effortOptions ? { effortOptions } : {}),
    };
  }

  resolveDiscoveryTarget(providerId: string): ModelDiscoveryTarget {
    const providerKey = this.requireExistingProviderKey(providerId);
    const provider = this.deps.configGetter().custom_provider?.[providerKey];
    if (!provider) {
      throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
    }
    return this.discoveryTargetForProvider(provider);
  }

  toCacheEntry(result: ModelConnectionTestResult, fingerprint: string): ModelCacheStatusEntry {
    return {
      state: result.ok ? 'available' : 'failed',
      last_tested_at: (this.deps.now ?? Date.now)(),
      config_fingerprint: fingerprint,
      ...(result.errorCode ? { last_error_code: result.errorCode } : {}),
      ...(result.errorMessage ? { last_error_message: result.errorMessage } : {}),
    };
  }

  /** Accepts `custom_provider:<key>` or a bare key; 404 when not configured. */
  requireExistingProviderKey(providerId: string): string {
    const parsed = parseProviderId(providerId);
    const providerKey =
      parsed?.source === 'custom_provider' ? parsed.providerKey : providerId?.trim();
    const exists = providerKey
      ? this.deps.configGetter().custom_provider?.[providerKey]
      : undefined;
    if (!providerKey || !exists) {
      throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
    }
    return providerKey;
  }

  requireCustomProviderView(providerKey: string): ModelProviderView {
    const config = this.deps.configGetter();
    const provider = config.custom_provider?.[providerKey];
    if (!provider) {
      throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
    }
    return buildCustomProviderView(config, this.deps.cache.load(), providerKey, provider);
  }
}
