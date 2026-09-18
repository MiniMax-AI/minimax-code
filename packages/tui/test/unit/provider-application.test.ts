import { describe, expect, it, vi } from 'vitest';
import type { McodeProviderModel, McodeProviderView } from '../../src/provider/contract.js';
import { McodeProviderApplication } from '../../src/provider/application.js';

function createPort() {
  return {
    discoverUserModelsCandidate: vi.fn(async (): Promise<readonly McodeProviderModel[]> => []),
    listProviderPresets: vi.fn(async () => []),
    getCodexOAuthStatus: vi.fn(async () => ({
      state: 'disconnected' as const,
      providerId: 'openai-codex' as const,
    })),
    cancelCodexOAuthLogin: vi.fn(async () => ({ state: 'disconnected' as const, providerId: 'openai-codex' as const })),
    startCodexOAuthLogin: vi.fn(async () => ({
      state: 'pending' as const,
      providerId: 'openai-codex' as const,
      authUrl: 'https://auth.openai.example/authorize',
    })),
    listUserModelProviders: vi.fn(async () => [
      {
        providerId: 'custom_provider:openai',
        name: 'OpenAI',
        kind: 'custom' as const,
        enabled: true,
        apiFormat: 'openai-completions' as const,
        baseUrl: 'https://api.openai.com/v1',
        hasApiKey: true,
        configRevision: 'rev-1',
        maskedApiKey: 'sk-****1234',
        rawApiKey: 'must-never-cross-the-cli-boundary',
        models: [{ modelId: 'gpt-4.1', displayName: 'GPT-4.1', contextLimit: 32768, maxOutputTokens: 4096 }],
      },
    ]),
    getMiniMaxApiKeyStatus: vi.fn(async () => ({
      hasApiKey: true,
      maskedApiKey: 'sk-****5678',
      rawApiKey: 'must-never-cross-the-cli-boundary',
    })),
    getMiniMaxModelSource: vi.fn(async () => 'minimax_api_key' as const),
    setMiniMaxModelSource: vi.fn(async (source: 'token_plan' | 'minimax_api_key') => source),
    upsertMiniMaxApiKey: vi.fn(async () => undefined),
    createUserModelProvider: vi.fn(async () => undefined),
    saveUserModelProviderCandidate: vi.fn(async () => ({
      success: true,
      provider: { providerId: 'custom_provider:openai' },
    })),
    updateUserModelProvider: vi.fn(async () => undefined),
    deleteUserModelProvider: vi.fn(async () => undefined),
    testUserModelProvider: vi.fn(async () => ({
      success: true,
      status: { state: 'available' },
    })),
    testUserModel: vi.fn(async () => ({
      success: true,
      status: { state: 'available' },
    })),
  };
}

describe('McodeProviderApplication', () => {
  it('exposes a disconnected Codex OAuth row when Runtime makes it visible', async () => {
    const application = new McodeProviderApplication(createPort());

    const snapshot = await application.snapshot({ includeCodexOAuth: true });

    expect(snapshot.providers[0]).toMatchObject({
      providerId: 'openai-codex',
      name: 'OpenAI Codex',
      kind: 'codex-oauth',
      active: false,
      enabled: true,
      readOnly: true,
      hasApiKey: false,
      status: { state: 'disconnected' },
    });
  });

  it('omits the Codex OAuth row when Runtime marks it hidden', async () => {
    const port = createPort();
    port.getCodexOAuthStatus.mockResolvedValueOnce({
      state: 'hidden',
      providerId: 'openai-codex',
    });
    const application = new McodeProviderApplication(port);

    const snapshot = await application.snapshot({ includeCodexOAuth: true });

    expect(snapshot.providers).not.toContainEqual(
      expect.objectContaining({ providerId: 'openai-codex' }),
    );
  });

  it('builds a CLI-owned snapshot without exposing raw API keys', async () => {
    const port = createPort();
    const application = new McodeProviderApplication(port);

    const snapshot = await application.snapshot();

    expect(snapshot.providers.map((provider) => provider.providerId)).toEqual([
      'minimax_oauth',
      'minimax_api',
      'custom_provider:openai',
    ]);
    expect(snapshot.providers[0]).toMatchObject({
      providerId: 'minimax_oauth',
      name: 'MiniMax OAuth',
      kind: 'minimax-oauth',
      active: false,
      enabled: true,
      readOnly: true,
      hasApiKey: false,
    });
    expect(snapshot.providers[1]).toMatchObject({
      kind: 'minimax-api-key',
      active: true,
      hasApiKey: true,
    });
    expect(JSON.stringify(snapshot)).toContain('MiniMax OAuth');
    expect(JSON.stringify(snapshot)).not.toContain('must-never-cross-the-cli-boundary');
    expect(snapshot.providers[2]).not.toHaveProperty('rawApiKey');
    expect(snapshot.providers[2]?.models[0]).toMatchObject({
      contextLimit: 32768,
      maxOutputTokens: 4096,
    });
    expect(port.getCodexOAuthStatus).not.toHaveBeenCalled();
  });

  it('marks OAuth active when the MiniMax source is Token Plan', async () => {
    const port = createPort();
    port.getMiniMaxModelSource.mockResolvedValueOnce('token_plan');
    const application = new McodeProviderApplication(port);

    const snapshot = await application.snapshot();

    expect(snapshot.minimaxModelSource).toBe('token_plan');
    expect(snapshot.providers[0]).toMatchObject({ kind: 'minimax-oauth', active: true });
    expect(snapshot.providers[1]).toMatchObject({ kind: 'minimax-api-key', active: false });
  });

  it('forwards MiniMax source changes through the CLI port', async () => {
    const port = createPort();
    const application = new McodeProviderApplication(port);

    await expect(application.setMiniMaxSource('token_plan')).resolves.toBe('token_plan');

    expect(port.setMiniMaxModelSource).toHaveBeenCalledWith('token_plan');
  });

  it('forwards custom provider creation through the CLI port', async () => {
    const port = createPort();
    const application = new McodeProviderApplication(port);

    await application.create({
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-live',
      apiFormat: 'openai-completions',
      models: [{ modelId: 'gpt-4.1' }],
      saveAndUse: true,
    });

    expect(port.createUserModelProvider).toHaveBeenCalledWith({
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-live',
      apiFormat: 'openai-completions',
      models: [{ modelId: 'gpt-4.1' }],
      saveAndUse: true,
    });
  });

  it('saves a tested provider candidate and selects its chosen model atomically', async () => {
    const port = createPort();
    const application = new McodeProviderApplication(port);

    const result = await application.saveCandidate({
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-live',
      apiFormat: 'openai-responses',
      models: [{ modelId: 'gpt-5.6' }],
      modelId: 'gpt-5.6',
      saveAndUse: true,
    });

    expect(result).toMatchObject({ success: true });
    expect(port.saveUserModelProviderCandidate).toHaveBeenCalledWith({
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-live',
      apiFormat: 'openai-responses',
      models: [{ modelId: 'gpt-5.6' }],
      modelId: 'gpt-5.6',
      saveAndUse: true,
    });
  });

  it('preserves the Runtime-supported OpenAI Responses protocol', async () => {
    const port = createPort();
    port.listUserModelProviders.mockResolvedValueOnce([
      {
        providerId: 'custom_provider:responses',
        name: 'OpenAI Responses',
        kind: 'custom',
        enabled: true,
        apiFormat: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        hasApiKey: true,
        models: [{ modelId: 'gpt-5.6' }],
      },
    ]);
    const application = new McodeProviderApplication(port);

    const snapshot = await application.snapshot();

    expect(
      snapshot.providers.find((provider) => provider.providerId === 'custom_provider:responses'),
    ).toMatchObject({ apiFormat: 'openai-responses' });
  });

  it('uses provider and model-specific connectivity tests', async () => {
    const port = createPort();
    const application = new McodeProviderApplication(port);

    await application.test('custom_provider:openai');
    await application.test('custom_provider:openai', 'gpt-4.1');

    expect(port.testUserModelProvider).toHaveBeenCalledWith('custom_provider:openai');
    expect(port.testUserModel).toHaveBeenCalledWith('custom_provider:openai', 'gpt-4.1');
  });

  it('keeps a disabled provider inactive even when a model is still selected', async () => {
    const port = createPort();
    port.listUserModelProviders.mockResolvedValueOnce([
      {
        providerId: 'custom_provider:byok',
        name: 'BYOK Vendor',
        kind: 'custom' as const,
        enabled: false,
        apiFormat: 'openai-completions' as const,
        baseUrl: 'https://api.byok.example/v1',
        hasApiKey: true,
        maskedApiKey: 'sk-****9999',
        rawApiKey: 'must-never-cross-the-cli-boundary',
        models: [{ modelId: 'byok-large-5', selected: true }],
      },
    ]);
    const application = new McodeProviderApplication(port);

    const snapshot = await application.snapshot();

    // Runtime drops disabled providers from the roster, so rendering the row
    // as active would contradict the "Disabled" label on the same line.
    expect(snapshot.providers[2]).toMatchObject({
      providerId: 'custom_provider:byok',
      enabled: false,
      active: false,
    });
  });

  it('keeps an enabled provider active while a model is selected', async () => {
    const port = createPort();
    port.listUserModelProviders.mockResolvedValueOnce([
      {
        providerId: 'custom_provider:byok',
        name: 'BYOK Vendor',
        kind: 'custom' as const,
        enabled: true,
        apiFormat: 'openai-completions' as const,
        baseUrl: 'https://api.byok.example/v1',
        hasApiKey: true,
        models: [{ modelId: 'byok-large-5', selected: true }],
      },
    ]);
    const application = new McodeProviderApplication(port);

    const snapshot = await application.snapshot();

    expect(snapshot.providers[2]).toMatchObject({ enabled: true, active: true });
  });
});


describe('saved provider model refresh', () => {
  const provider: McodeProviderView = {
    providerId: 'custom_provider:work', name: 'Work', kind: 'custom',
    enabled: true, readOnly: false, active: true, hasApiKey: true,
    configRevision: 'rev-1', baseUrl: 'https://models.example/v1',
    models: [{ modelId: 'old-model', selected: true }],
  };

  it('discovers with saved credentials and adds only new IDs without switching models', async () => {
    const port = createPort();
    port.discoverUserModelsCandidate.mockResolvedValue([
      { modelId: 'old-model', displayName: 'Do not overwrite saved settings' },
      { modelId: 'new-model', displayName: 'New model' }, { modelId: ' new-model ' }, { modelId: ' old-model ' },
    ]);
    await expect(new McodeProviderApplication(port).refreshModels(provider)).resolves.toBe(1);
    const identity = { providerId: provider.providerId, expectedRevision: 'rev-1', baseUrl: provider.baseUrl };
    expect(port.discoverUserModelsCandidate).toHaveBeenCalledWith(identity);
    expect(port.saveUserModelProviderCandidate).toHaveBeenCalledWith({
      ...identity, models: [{ modelId: 'old-model' }, { modelId: 'new-model', displayName: 'New model', configurationSource: 'discovered' }],
      modelId: 'new-model', skipConnectionTest: true, saveAndUse: false,
    });
    expect(port.createUserModelProvider).not.toHaveBeenCalled();
    expect(port.setMiniMaxModelSource).not.toHaveBeenCalled();
    expect(provider.models).toEqual([{ modelId: 'old-model', selected: true }]);
  });

  it.each([{ models: [] }, { models: [{ modelId: 'old-model' }] }])('does not save an empty or unchanged discovery result', async ({ models }) => {
    const port = createPort();
    port.discoverUserModelsCandidate.mockResolvedValue(models);
    await expect(new McodeProviderApplication(port).refreshModels(provider)).resolves.toBe(0);
    expect(port.saveUserModelProviderCandidate).not.toHaveBeenCalled();
  });

  it('keeps the saved configuration when discovery fails', async () => {
    const port = createPort();
    port.discoverUserModelsCandidate.mockRejectedValue(new Error('Authentication failed'));
    await expect(new McodeProviderApplication(port).refreshModels(provider)).rejects.toThrow('Authentication failed');
    expect(port.saveUserModelProviderCandidate).not.toHaveBeenCalled();
  });

  it('surfaces a revision conflict without retrying or creating a new account', async () => {
    const port = createPort();
    port.discoverUserModelsCandidate.mockResolvedValue([{ modelId: 'new-model' }]);
    port.saveUserModelProviderCandidate.mockRejectedValue(new Error('Configuration changed'));
    await expect(new McodeProviderApplication(port).refreshModels(provider)).rejects.toThrow('Configuration changed');
    expect(port.saveUserModelProviderCandidate).toHaveBeenCalledOnce();
    expect(port.createUserModelProvider).not.toHaveBeenCalled();
  });

  it('rejects a missing revision before making any request', async () => {
    const port = createPort();
    await expect(new McodeProviderApplication(port).refreshModels({ ...provider, configRevision: undefined })).rejects.toThrow('Reopen /provider');
    expect(port.discoverUserModelsCandidate).not.toHaveBeenCalled();
  });
});
