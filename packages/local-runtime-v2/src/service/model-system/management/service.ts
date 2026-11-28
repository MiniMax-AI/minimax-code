import type { DiscoveredModel } from '../connectivity/discover-models.js';
import { enabledCustomProviders, type ModelCacheStatusView } from '../catalog/list-models.js';
import type { ModelCacheData } from '../catalog/model-cache.js';
import { MINIMAX_API_PROVIDER_ID } from '../identity.js';
import { LocalModelProviderError } from '../contracts.js';
import {
  discoverUserModelsCandidate as discoverUserModelsCandidateOperation,
  saveUserModelProviderCandidate as saveUserModelProviderCandidateOperation,
  testUserModelCandidate as testUserModelCandidateOperation,
  updateUserModelParameters as updateUserModelParametersOperation,
} from './service-candidate-operations.js';
import {
  assertModelSelectable as assertModelSelectableOperation,
  discoverModels as discoverModelsOperation,
  testModel as testModelOperation,
  testProvider as testProviderOperation,
} from './service-connection-operations.js';
import { ModelProviderServiceContext } from './service-context.js';
import {
  testUserModelApiKey as testUserModelApiKeyOperation,
  unrestUserModelApiKey as unrestUserModelApiKeyOperation,
} from '../byok-keys/operations.js';
import type { ApiKeyProbeView } from '../byok-keys/key-pool.js';
import { readApiKeys } from '../byok-keys/key-list.js';
import { customProviderViewOptions } from './service-helpers.js';
import { parseProviderId } from '../resolution/model-key.js';
import {
  createUserProvider as createUserProviderOperation,
  deleteUserProvider as deleteUserProviderOperation,
  duplicateUserProvider as duplicateUserProviderOperation,
  updateUserProvider as updateUserProviderOperation,
} from './service-custom-provider-operations.js';
import {
  deleteMinimaxApiKey as deleteMinimaxApiKeyOperation,
  getMinimaxApiKeyStatus as getMinimaxApiKeyStatusOperation,
  getMinimaxModelSource as getMinimaxModelSourceOperation,
  setMinimaxModelSource as setMinimaxModelSourceOperation,
  updateMinimaxModelContext as updateMinimaxModelContextOperation,
  upsertMinimaxApiKey as upsertMinimaxApiKeyOperation,
} from './service-minimax-operations.js';
import {
  type ApiKeyView,
  type LocalRuntimeConfig,
  type LocalCustomProviderConfig,
  type LocalModelProviderServiceDeps,
  type ModelContextUpdateOutcome,
  type ModelProviderTestOutcome,
  type SaveUserModelProviderCandidateOutcome,
  type UserModelInputView,
  type UserModelProviderCandidateView,
} from '../contracts.js';
import {
  buildBuiltinProviderView,
  buildCustomProviderView,
  type ModelProviderView,
} from '../catalog/provider-views.js';

export type { ModelProviderView } from '../catalog/provider-views.js';
export { LocalModelProviderError } from '../contracts.js';
export type {
  LocalModelProviderServiceDeps,
  ModelContextUpdateOutcome,
  ModelProviderTestOutcome,
  SaveUserModelProviderCandidateOutcome,
  UserModelInputView,
  UserModelProviderCandidateView,
} from '../contracts.js';

/** Stable public facade for local model-provider operations. */
export class LocalModelProviderService {
  private readonly context: ModelProviderServiceContext;

  constructor(deps: LocalModelProviderServiceDeps) {
    this.context = new ModelProviderServiceContext(deps);
  }

  modelCatalogConfig(): LocalRuntimeConfig {
    return this.context.deps.configGetter();
  }

  loadCacheData(): ModelCacheData {
    return this.context.deps.cache.load();
  }

  listEffectiveProviders(): ModelProviderView[] {
    const config = this.context.deps.configGetter();
    const cache = this.context.deps.cache.load();
    // minimax_api models share the builtin MiniMax catalog. Source routing is
    // resolved at inference time, so only custom providers are appended here.
    const providers: ModelProviderView[] = Object.entries(config.provider ?? {}).map(
      ([providerId, provider]) => buildBuiltinProviderView(config, cache, providerId, provider),
    );
    const viewOptions = customProviderViewOptions(this.context.deps);
    for (const [providerKey, provider] of enabledCustomProviders(config)) {
      providers.push(
        buildCustomProviderView(config, cache, { providerKey, provider }, viewOptions),
      );
    }
    return providers;
  }

  listVisibleUserProviders(): ModelProviderView[] {
    return this.listUserProviders();
  }

  listUserProviders(): ModelProviderView[] {
    const config = this.context.deps.configGetter();
    const cache = this.context.deps.cache.load();
    const viewOptions = customProviderViewOptions(this.context.deps);
    return Object.entries(config.custom_provider ?? {}).map(([providerKey, provider]) =>
      buildCustomProviderView(config, cache, { providerKey, provider }, viewOptions),
    );
  }

  revealModelProviderApiKey(input: { providerId: string; keyId?: string }): string {
    const config = this.context.deps.configGetter();
    if (input.providerId === MINIMAX_API_PROVIDER_ID) {
      const apiKey = config.minimax_api?.apiKey;
      if (!apiKey?.trim()) {
        throw new LocalModelProviderError(400, 'MiniMax API key is not configured', 'NO_API_KEY');
      }
      return apiKey;
    }
    const identity = parseProviderId(input.providerId);
    const provider =
      identity?.source === 'custom_provider'
        ? config.custom_provider?.[identity.providerKey]
        : undefined;
    if (!provider) {
      throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
    }
    assertProviderKeyRevealable(provider);
    const apiKey = input.keyId
      ? readApiKeys(provider).find((key) => key.id === input.keyId)?.key
      : provider.options?.apiKey;
    if (input.keyId && !apiKey) {
      throw new LocalModelProviderError(404, 'API key not found', 'API_KEY_NOT_FOUND');
    }
    if (!apiKey?.trim()) {
      throw new LocalModelProviderError(400, 'Provider API key is not configured', 'NO_API_KEY');
    }
    return apiKey;
  }

  getMinimaxApiKeyStatus(): {
    hasApiKey: boolean;
    maskedApiKey?: string;
    cachedStatus?: ModelCacheStatusView;
  } {
    return getMinimaxApiKeyStatusOperation(this.context);
  }

  getMinimaxModelSource(): 'token_plan' | 'minimax_api_key' {
    return getMinimaxModelSourceOperation(this.context);
  }

  async setMinimaxModelSource(source: 'token_plan' | 'minimax_api_key'): Promise<string> {
    return setMinimaxModelSourceOperation(this.context, source);
  }

  async updateMinimaxModelContext(input: {
    modelId: string;
    contextLimit: number;
    expectedContextLimit: number;
  }): Promise<ModelContextUpdateOutcome> {
    return updateMinimaxModelContextOperation(this.context, input);
  }

  async upsertMinimaxApiKey(input: {
    apiKey: string;
    saveAndUse?: boolean;
  }): Promise<ModelProviderView> {
    return upsertMinimaxApiKeyOperation(this.context, input);
  }

  async createUserProvider(input: {
    name?: string;
    baseUrl: string;
    apiKey: string;
    apiFormat?: string;
    headers?: Record<string, string>;
    models?: UserModelInputView[];
    saveAndUse?: boolean;
  }): Promise<ModelProviderView> {
    return createUserProviderOperation(this.context, input);
  }

  async updateUserProvider(input: {
    providerId: string;
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    apiFormat?: string;
    headers?: Record<string, string>;
    removeHeaders?: string[];
    enabled?: boolean;
    models?: UserModelInputView[];
    saveAndUse?: boolean;
  }): Promise<ModelProviderView> {
    return updateUserProviderOperation(this.context, input);
  }

  async duplicateUserProvider(input: {
    providerId: string;
    name?: string;
  }): Promise<ModelProviderView> {
    return duplicateUserProviderOperation(this.context, input);
  }

  async testUserModelCandidate(
    candidate: UserModelProviderCandidateView,
    modelId: string,
  ): Promise<ModelProviderTestOutcome> {
    return testUserModelCandidateOperation(this.context, candidate, modelId);
  }

  async discoverUserModelsCandidate(
    candidate: UserModelProviderCandidateView,
  ): Promise<DiscoveredModel[]> {
    return discoverUserModelsCandidateOperation(this.context, candidate);
  }

  /** One key of a draft; remembers only its latest result (no rest, no reorder). */
  async testUserModelApiKey(input: {
    candidate: UserModelProviderCandidateView;
    keyIndex: number;
    modelId?: string;
  }): Promise<ApiKeyProbeView> {
    return testUserModelApiKeyOperation(this.context, input);
  }

  unrestUserModelApiKey(input: { providerId: string; keyId: string }): ApiKeyView {
    return unrestUserModelApiKeyOperation(this.context, input);
  }

  async saveUserModelProviderCandidate(input: {
    candidate: UserModelProviderCandidateView;
    modelId?: string;
    saveAndUse?: boolean;
    skipConnectionTest?: boolean;
    /** Process-local guard; never part of the DesktopService request. */
    beforeCommit?: () => void;
    /** Import-only idempotency; never part of the DesktopService request. */
    importIfExisting?: boolean;
  }): Promise<SaveUserModelProviderCandidateOutcome> {
    return saveUserModelProviderCandidateOperation(this.context, input);
  }

  async updateUserModelParameters(input: {
    providerId: string;
    modelId: string;
    contextLimit: number;
    maxOutputTokens: number;
    expectedContextLimit: number;
    expectedMaxOutputTokens: number;
  }): Promise<ModelProviderTestOutcome> {
    return updateUserModelParametersOperation(this.context, input);
  }

  async deleteUserProvider(input: { providerId: string }): Promise<void> {
    if (input.providerId === MINIMAX_API_PROVIDER_ID) {
      return deleteMinimaxApiKeyOperation(this.context);
    }
    return deleteUserProviderOperation(this.context, input);
  }

  async testProvider(
    providerId: string,
    opts?: { apiKeyOverride?: string },
  ): Promise<ModelProviderTestOutcome> {
    return testProviderOperation(this.context, providerId, opts);
  }

  async testModel(providerId: string, modelId: string): Promise<ModelProviderTestOutcome> {
    return testModelOperation(this.context, providerId, modelId);
  }

  async discoverModels(providerId: string): Promise<DiscoveredModel[]> {
    return discoverModelsOperation(this.context, providerId);
  }

  assertModelSelectable(providerId: string, modelId: string): void {
    assertModelSelectableOperation(this.context, providerId, modelId);
  }
}

/** Only a stored BYOK key can be revealed; extension and OAuth credentials cannot. */
function assertProviderKeyRevealable(provider: LocalCustomProviderConfig): void {
  if (
    provider.kind === 'oauth' ||
    provider.options?.authMode === 'oauth' ||
    provider.api === 'openai-codex-responses'
  ) {
    throw new LocalModelProviderError(
      400,
      'OAuth credentials cannot be revealed',
      'VALIDATION_ERROR',
    );
  }
}
