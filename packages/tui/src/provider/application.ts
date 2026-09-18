import type {
  McodeCodexOAuthStartResult,
  McodeCodexOAuthLoginOptions,
  McodeCodexOAuthStatus,
  McodeCreateProviderInput,
  McodeMiniMaxModelSource,
  McodeProviderRuntimePort,
  McodeSaveProviderCandidateInput,
  McodeSaveProviderCandidateResult,
  McodeProviderSnapshot,
  McodeProviderTestResult,
  McodeProviderView,
  McodeRuntimeProviderView,
  McodeUpdateProviderInput,
} from './contract.js';
import { isModelProviderApiFormat } from './contract.js';

export class McodeProviderApplication {
  constructor(private readonly port: McodeProviderRuntimePort) {}

  async snapshot(
    options: { readonly includeCodexOAuth?: boolean } = {},
  ): Promise<McodeProviderSnapshot> {
    const [customProviders, minimaxStatus, minimaxModelSource, codexOAuthStatus] =
      await Promise.all([
        this.port.listUserModelProviders(),
        this.port.getMiniMaxApiKeyStatus(),
        this.port.getMiniMaxModelSource(),
        options.includeCodexOAuth ? this.port.getCodexOAuthStatus() : undefined,
      ]);
    return {
      minimaxModelSource,
      providers: [
        ...(!codexOAuthStatus || codexOAuthStatus.state === 'hidden'
          ? []
          : [normalizeCodexOAuthProvider(codexOAuthStatus)]),
        {
          providerId: 'minimax_oauth',
          name: 'MiniMax OAuth',
          kind: 'minimax-oauth',
          active: minimaxModelSource === 'token_plan',
          enabled: true,
          readOnly: true,
          hasApiKey: false,
          models: [],
        },
        {
          providerId: 'minimax_api',
          name: 'MiniMax API Key',
          kind: 'minimax-api-key',
          active: minimaxModelSource === 'minimax_api_key',
          enabled: true,
          readOnly: false,
          hasApiKey: minimaxStatus.hasApiKey,
          ...(minimaxStatus.maskedApiKey ? { maskedApiKey: minimaxStatus.maskedApiKey } : {}),
          ...(minimaxStatus.cachedStatus ? { status: minimaxStatus.cachedStatus } : {}),
          models: [],
        },
        ...customProviders.map(normalizeCustomProvider),
      ],
    };
  }

  setMiniMaxSource(source: McodeMiniMaxModelSource): Promise<McodeMiniMaxModelSource> {
    return this.port.setMiniMaxModelSource(source);
  }

  connectCodexOAuth(options?: McodeCodexOAuthLoginOptions): Promise<McodeCodexOAuthStartResult> {
    return this.port.startCodexOAuthLogin(options);
  }

  getCodexOAuthStatus(): Promise<McodeCodexOAuthStatus> {
    return this.port.getCodexOAuthStatus();
  }

  cancelCodexOAuthLogin(loginId: string): Promise<McodeCodexOAuthStatus> {
    return this.port.cancelCodexOAuthLogin(loginId);
  }

  async setMiniMaxApiKey(apiKey: string, saveAndUse = true): Promise<void> {
    await this.port.upsertMiniMaxApiKey({ apiKey, saveAndUse });
  }

  async create(input: McodeCreateProviderInput): Promise<void> {
    await this.port.createUserModelProvider(input);
  }

  saveCandidate(input: McodeSaveProviderCandidateInput): Promise<McodeSaveProviderCandidateResult> {
    return this.port.saveUserModelProviderCandidate(input);
  }

  async refreshModels(provider: McodeProviderView): Promise<number> {
    if (
      provider.kind !== 'custom' ||
      provider.readOnly ||
      !provider.baseUrl ||
      !provider.configRevision
    ) {
      throw new Error('Reopen /provider and select an editable connection.');
    }
    const candidate = {
      providerId: provider.providerId,
      expectedRevision: provider.configRevision,
      baseUrl: provider.baseUrl,
    };
    const discovered = await this.port.discoverUserModelsCandidate(candidate);
    const ids = new Set(provider.models.map(({ modelId }) => modelId));
    const added = discovered
      .map(({ modelId, displayName }) => ({
        modelId: modelId.trim(),
        ...(displayName ? { displayName } : {}),
      }))
      .filter(({ modelId }) => {
        if (!modelId || ids.has(modelId)) return false;
        ids.add(modelId);
        return true;
      });
    const firstAdded = added[0];
    if (!firstAdded) return 0;
    const result = await this.port.saveUserModelProviderCandidate({
      ...candidate,
      // IDs retain every saved model field, including disabled state and limits.
      models: [
        ...provider.models.map(({ modelId }) => ({ modelId })),
        ...added.map((model) => ({ ...model, configurationSource: 'discovered' as const })),
      ],
      modelId: firstAdded.modelId,
      skipConnectionTest: true,
      saveAndUse: false,
    });
    if (!result.success)
      throw new Error(result.status?.lastErrorMessage ?? 'Could not save refreshed models.');
    return added.length;
  }

  async update(input: McodeUpdateProviderInput): Promise<void> {
    await this.port.updateUserModelProvider(input);
  }

  async remove(providerId: string): Promise<void> {
    await this.port.deleteUserModelProvider(providerId);
  }

  test(providerId: string, modelId?: string): Promise<McodeProviderTestResult> {
    return modelId
      ? this.port.testUserModel(providerId, modelId)
      : this.port.testUserModelProvider(providerId);
  }
}

function normalizeCodexOAuthProvider(status: McodeCodexOAuthStatus): McodeProviderView {
  return {
    providerId: status.providerId,
    name: 'OpenAI Codex',
    kind: 'codex-oauth',
    active: false,
    enabled: true,
    readOnly: true,
    hasApiKey: false,
    models: [],
    status: {
      state: status.state,
      ...(status.error ? { lastErrorMessage: status.error } : {}),
    },
  };
}

function normalizeCustomProvider(provider: McodeRuntimeProviderView): McodeProviderView {
  const apiFormat = isModelProviderApiFormat(provider.apiFormat) ? provider.apiFormat : undefined;
  return {
    providerId: provider.providerId,
    name: provider.name?.trim() || provider.providerId,
    kind: 'custom',
    // A disabled provider is never "in use": Runtime drops it from the model
    // roster (`enabledCustomProviders`) and BYOK resolution refuses it, so a
    // leftover `selected` model must not render as the active source.
    active: Boolean(
      provider.enabled !== false &&
      provider.models?.some((model) => 'selected' in model && model.selected),
    ),
    enabled: provider.enabled !== false,
    readOnly: provider.kind === 'oauth',
    ...(provider.configRevision ? { configRevision: provider.configRevision } : {}),
    ...(apiFormat ? { apiFormat } : {}),
    ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
    hasApiKey: Boolean(provider.hasApiKey),
    ...(provider.maskedApiKey ? { maskedApiKey: provider.maskedApiKey } : {}),
    models: (provider.models ?? []).map((model) => ({
      modelId: model.modelId,
      ...(model.displayName ? { displayName: model.displayName } : {}),
      ...(model.selected !== undefined ? { selected: model.selected } : {}),
      ...(model.contextLimit !== undefined ? { contextLimit: model.contextLimit } : {}),
      ...(model.maxOutputTokens !== undefined ? { maxOutputTokens: model.maxOutputTokens } : {}),
      ...(model.status ? { status: model.status } : {}),
    })),
    ...(provider.status ? { status: provider.status } : {}),
  };
}

export type {
  McodeCreateProviderInput,
  McodeProviderRuntimePort,
  McodeProviderSnapshot,
  McodeUpdateProviderInput,
} from './contract.js';
