import { CUSTOM_PROVIDER_ID_PREFIX, formatModelKey } from '../resolution/model-key.js';
import {
  LocalModelProviderError,
  type LocalByokConfigDraft,
  type LocalCustomProviderConfig,
  type LocalCustomProvidersConfig,
  type UserModelInputView,
} from '../contracts.js';
import { generateProviderKey } from './provider-key.js';
import { type ModelProviderView } from '../catalog/provider-views.js';
import { ModelProviderServiceContext } from './service-context.js';
import {
  nextDuplicateProviderName,
  removeLegacyCustomProviderNpm,
  resetUnavailableCustomDefaultModel,
} from './service-helpers.js';
import {
  assertValidRawApiKey,
  mergeModelsFromInputs,
  modelsFromInputs,
  normalizeApiFormat,
  normalizeProviderCredentialUpdate,
  normalizeHeaderNames,
  normalizeHeaders,
  removeHeaderCaseInsensitive,
} from './service-input.js';

interface UserProviderUpdateInput {
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
}

interface PreparedUserProviderUpdate {
  apiKeyUpdate: ReturnType<typeof normalizeProviderCredentialUpdate>;
  baseUrl?: string;
  apiFormat?: ReturnType<typeof normalizeApiFormat>;
  headers?: Record<string, string>;
  removeHeaders: string[];
  implicitCustomProviderThinking: boolean;
}

export async function createUserProvider(
  context: ModelProviderServiceContext,
  input: {
    name?: string;
    baseUrl: string;
    apiKey: string;
    apiFormat?: string;
    headers?: Record<string, string>;
    models?: UserModelInputView[];
    saveAndUse?: boolean;
  },
): Promise<ModelProviderView> {
  if (input.saveAndUse) {
    throw new LocalModelProviderError(
      409,
      'Test the saved provider configuration before activating it',
      'TEST_REQUIRED',
    );
  }
  const apiKey = assertValidRawApiKey(input.apiKey);
  const baseUrl = input.baseUrl?.trim();
  if (!baseUrl) {
    throw new LocalModelProviderError(400, 'base_url must not be empty', 'VALIDATION_ERROR');
  }
  const apiFormat = normalizeApiFormat(input.apiFormat);
  const headers = normalizeHeaders(input.headers);
  const name = input.name?.trim();
  let providerKey = '';
  await context.deps.updateByokConfig((draft) => {
    const tree = (draft.custom_provider ?? {}) as LocalCustomProvidersConfig;
    providerKey = generateProviderKey({
      displayName: name,
      existingKeys: Object.keys(tree),
      ...(context.deps.randomHex ? { randomHex: context.deps.randomHex } : {}),
    });
    tree[providerKey] = {
      ...(name ? { name } : {}),
      kind: 'custom',
      enabled: true,
      ...(apiFormat ? { api: apiFormat } : {}),
      options: {
        apiKey,
        baseURL: baseUrl,
        authMode: 'api-key',
        ...(headers ? { headers } : {}),
      },
      ...(input.models
        ? {
            models: modelsFromInputs(
              input.models,
              undefined,
              context.deps.implicitCustomProviderThinking === true,
            ),
          }
        : {}),
    };
    draft.custom_provider = tree as Record<string, unknown>;
  });
  return context.requireCustomProviderView(providerKey);
}

export async function updateUserProvider(
  context: ModelProviderServiceContext,
  input: UserProviderUpdateInput,
): Promise<ModelProviderView> {
  const providerKey = context.requireExistingProviderKey(input.providerId);
  // Tri-state api_key: absent keeps the stored key, empty string clears it,
  // masked placeholders are rejected so a sanitized read can't be written back.
  const apiKeyUpdate = normalizeProviderCredentialUpdate({ apiKey: input.apiKey });
  const baseUrl = input.baseUrl?.trim();
  if (input.baseUrl !== undefined && !baseUrl) {
    throw new LocalModelProviderError(400, 'base_url must not be empty', 'VALIDATION_ERROR');
  }
  const apiFormat = input.apiFormat !== undefined ? normalizeApiFormat(input.apiFormat) : undefined;
  const headers = input.headers !== undefined ? normalizeHeaders(input.headers) : undefined;
  const removeHeaders = normalizeHeaderNames(input.removeHeaders);
  const prepared: PreparedUserProviderUpdate = {
    apiKeyUpdate,
    ...(baseUrl ? { baseUrl } : {}),
    ...(apiFormat ? { apiFormat } : {}),
    ...(headers ? { headers } : {}),
    removeHeaders,
    implicitCustomProviderThinking: context.deps.implicitCustomProviderThinking === true,
  };
  await context.deps.updateByokConfig((draft) => {
    applyUserProviderUpdate(draft, providerKey, input, prepared);
    resetUnavailableCustomDefaultModel(draft);
  });
  await activateUpdatedProvider(context, providerKey, input.saveAndUse === true);
  return context.requireCustomProviderView(providerKey);
}

async function activateUpdatedProvider(
  context: ModelProviderServiceContext,
  providerKey: string,
  saveAndUse: boolean,
): Promise<void> {
  if (!saveAndUse) return;
  const provider = context.deps.configGetter().custom_provider?.[providerKey];
  const firstModelId = Object.keys(provider?.models ?? {})[0];
  if (!firstModelId) return;
  const providerId = `${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`;
  context.resolveTestTarget(providerId, firstModelId);
  await context.deps.selectModel(formatModelKey(providerId, firstModelId));
}

function applyUserProviderUpdate(
  draft: LocalByokConfigDraft,
  providerKey: string,
  input: UserProviderUpdateInput,
  prepared: PreparedUserProviderUpdate,
): void {
  const tree = (draft.custom_provider ?? {}) as LocalCustomProvidersConfig;
  const provider = tree[providerKey];
  if (!provider) return;
  removeLegacyCustomProviderNpm(provider);
  applyProviderFields(provider, input, prepared.apiFormat, prepared.implicitCustomProviderThinking);
  provider.options = updatedProviderOptions(provider, input, prepared);
  draft.custom_provider = tree as Record<string, unknown>;
}

function applyProviderFields(
  provider: LocalCustomProviderConfig,
  input: UserProviderUpdateInput,
  apiFormat: PreparedUserProviderUpdate['apiFormat'],
  implicitCustomProviderThinking: boolean,
): void {
  // provider_key is immutable: renames only change the display name.
  if (input.name !== undefined) provider.name = input.name.trim();
  if (input.enabled !== undefined) provider.enabled = input.enabled;
  if (apiFormat !== undefined) provider.api = apiFormat;
  if (input.models !== undefined) {
    provider.models = mergeModelsFromInputs(
      provider.models,
      input.models,
      implicitCustomProviderThinking,
    );
  }
}

function updatedProviderOptions(
  provider: LocalCustomProviderConfig,
  input: UserProviderUpdateInput,
  prepared: PreparedUserProviderUpdate,
): NonNullable<LocalCustomProviderConfig['options']> {
  const options = { ...(provider.options ?? {}) };
  if (prepared.baseUrl !== undefined) options.baseURL = prepared.baseUrl;
  if (prepared.apiKeyUpdate.kind === 'set') options.apiKey = prepared.apiKeyUpdate.apiKey;
  if (prepared.apiKeyUpdate.kind === 'clear') delete options.apiKey;
  applyProviderHeaderUpdate(options, input, prepared);
  return options;
}

function applyProviderHeaderUpdate(
  options: NonNullable<LocalCustomProviderConfig['options']>,
  input: UserProviderUpdateInput,
  prepared: PreparedUserProviderUpdate,
): void {
  if (input.headers === undefined && prepared.removeHeaders.length === 0) return;
  const nextHeaders = { ...(options.headers ?? {}) };
  for (const name of prepared.removeHeaders) removeHeaderCaseInsensitive(nextHeaders, name);
  for (const [name, value] of Object.entries(prepared.headers ?? {})) {
    removeHeaderCaseInsensitive(nextHeaders, name);
    nextHeaders[name] = value;
  }
  if (Object.keys(nextHeaders).length > 0) options.headers = nextHeaders;
  else delete options.headers;
}

export async function duplicateUserProvider(
  context: ModelProviderServiceContext,
  input: { providerId: string; name?: string },
): Promise<ModelProviderView> {
  const sourceProviderKey = context.requireExistingProviderKey(input.providerId);
  let duplicateProviderKey = '';
  await context.deps.updateByokConfig((draft) => {
    const tree = (draft.custom_provider ?? {}) as LocalCustomProvidersConfig;
    const source = tree[sourceProviderKey];
    if (!source) {
      throw new LocalModelProviderError(404, 'Model provider not found', 'PROVIDER_NOT_FOUND');
    }
    const duplicateName = nextDuplicateProviderName({
      requestedName: input.name,
      sourceName: source.name,
      sourceProviderKey,
      providers: tree,
    });
    duplicateProviderKey = generateProviderKey({
      displayName: duplicateName,
      existingKeys: Object.keys(tree),
      ...(context.deps.randomHex ? { randomHex: context.deps.randomHex } : {}),
    });
    const duplicate = structuredClone(source);
    removeLegacyCustomProviderNpm(duplicate);
    tree[duplicateProviderKey] = { ...duplicate, name: duplicateName };
    draft.custom_provider = tree as Record<string, unknown>;
  });
  return context.requireCustomProviderView(duplicateProviderKey);
}

export async function deleteUserProvider(
  context: ModelProviderServiceContext,
  input: { providerId: string },
): Promise<void> {
  const providerKey = context.requireExistingProviderKey(input.providerId);
  await context.deps.updateByokConfig(async (draft) => {
    const tree = (draft.custom_provider ?? {}) as LocalCustomProvidersConfig;
    const provider = tree[providerKey];
    if (provider?.kind === 'oauth') {
      const removeCredentials = context.deps.removeProviderCredentials;
      if (!removeCredentials) {
        throw new LocalModelProviderError(
          503,
          'OAuth credential removal is unavailable',
          'PROVIDER_AUTH_UNAVAILABLE',
        );
      }
      try {
        await removeCredentials(providerKey);
      } catch {
        throw new LocalModelProviderError(
          500,
          'Failed to delete OAuth credentials',
          'PROVIDER_CREDENTIAL_DELETE_FAILED',
        );
      }
    }
    delete tree[providerKey];
    draft.custom_provider =
      Object.keys(tree).length > 0 ? (tree as Record<string, unknown>) : undefined;
    resetUnavailableCustomDefaultModel(draft);
  });
  await context.deps.cache.removeProvider(`${CUSTOM_PROVIDER_ID_PREFIX}${providerKey}`);
}
