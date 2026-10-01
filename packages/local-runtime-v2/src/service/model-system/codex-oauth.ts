import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { AuthStorage } from '@earendil-works/pi-coding-agent/auth-storage';

import type {
  LocalByokConfigDraft,
  LocalCustomProviderConfig,
  LocalCustomProvidersConfig,
  LocalModelConfig,
  LocalRuntimeConfig,
} from './contracts.js';
import {
  CodexModelDiscoveryClient,
  type CodexModelCredentials,
} from './connectivity/codex-model-discovery.js';
import { OPENAI_CODEX_PROVIDER_ID } from './identity.js';

export { OPENAI_CODEX_PROVIDER_ID } from './identity.js';

export type CodexOAuthState = 'hidden' | 'disconnected' | 'pending' | 'connected' | 'failed';

export type CodexOAuthLoginMethod = 'browser' | 'device_code';

export interface CodexOAuthLoginOptions {
  method?: CodexOAuthLoginMethod;
}

export interface CodexOAuthDeviceCode {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

export interface CodexOAuthStatus {
  state: CodexOAuthState;
  providerId: typeof OPENAI_CODEX_PROVIDER_ID;
  error?: string;
  loginId?: string;
  method?: CodexOAuthLoginMethod;
  authUrl?: string;
  deviceCode?: CodexOAuthDeviceCode;
}

export type CodexOAuthStartResult = CodexOAuthStatus;

type LoginAttempt = {
  id: string;
  method: CodexOAuthLoginMethod;
  controller: AbortController;
  start: Promise<CodexOAuthStartResult>;
  resolve: (result: CodexOAuthStartResult) => void;
  reject: (error: Error) => void;
  result?: CodexOAuthStartResult;
  timeout?: ReturnType<typeof setTimeout>;
};

interface CodexAuthStorage {
  getCredentials(): Promise<CodexModelCredentials | undefined>;
  hasOAuth(provider: typeof OPENAI_CODEX_PROVIDER_ID): boolean;
  removeOAuth(provider: typeof OPENAI_CODEX_PROVIDER_ID): void;
  login(
    provider: typeof OPENAI_CODEX_PROVIDER_ID,
    callbacks: Parameters<AuthStorage['login']>[1],
  ): Promise<void>;
}

export interface CodexOAuthManagerDeps {
  configGetter: () => LocalRuntimeConfig;
  fetchImpl?: typeof fetch;
  updateByokConfig?: (
    mutate: (
      draft: LocalByokConfigDraft,
      currentConfig: LocalRuntimeConfig,
    ) => void | Promise<void>,
  ) => Promise<unknown>;
  removeLegacyProvider?: (providerId: typeof OPENAI_CODEX_PROVIDER_ID) => Promise<unknown>;
  authStorageFactory?: (authPath: string) => CodexAuthStorage;
  catalogGetter?: () => Promise<LocalCustomProviderConfig>;
}

export class CodexOAuthError extends Error {
  override name = 'CodexOAuthError';

  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Owns provider login, pending authorization details and credential persistence. */
export class CodexOAuthManager {
  private readonly authStorageFactory: (authPath: string) => CodexAuthStorage;
  private readonly catalogGetter: () => Promise<LocalCustomProviderConfig>;
  private pendingCatalog: Promise<void> | undefined;
  private credentialGeneration = 0;
  private login: LoginAttempt | undefined;
  private lastError: string | undefined;

  constructor(private readonly deps: CodexOAuthManagerDeps) {
    this.authStorageFactory =
      deps.authStorageFactory ??
      ((authPath) => {
        const storage = AuthStorage.create(authPath);
        return {
          getCredentials: async () => {
            if (storage.getAll()[OPENAI_CODEX_PROVIDER_ID]?.type !== 'oauth') return undefined;
            const access = await storage.getApiKey(OPENAI_CODEX_PROVIDER_ID, {
              includeFallback: false,
              fetch: deps.fetchImpl,
            });
            const credentials = storage.getAll()[OPENAI_CODEX_PROVIDER_ID];
            const accountId = credentials?.type === 'oauth' ? credentials.accountId : undefined;
            return access && typeof accountId === 'string' && accountId
              ? { access, accountId }
              : undefined;
          },
          hasOAuth: (provider) => storage.getAll()[provider]?.type === 'oauth',
          removeOAuth: (provider) => {
            storage.logout(provider);
            const [error] = storage.drainErrors();
            if (error) throw error;
          },
          login: async (provider, callbacks) => {
            // Keep late token responses from a cancelled attempt out of profile storage.
            const pending = AuthStorage.inMemory();
            await pending.login(provider, callbacks);
            callbacks.signal?.throwIfAborted();
            const credentials = pending.getAll()[provider];
            if (!credentials) throw new Error('Codex OAuth credentials are unavailable.');
            storage.set(provider, credentials);
            const [error] = storage.drainErrors();
            if (error) throw error;
          },
        };
      });
    this.catalogGetter =
      deps.catalogGetter ??
      (async () => {
        const credentials = await this.authStorage().getCredentials();
        if (!credentials)
          throw new CodexOAuthError(
            401,
            'Codex OAuth credentials are unavailable. Reconnect to retry.',
            'OAUTH_CREDENTIALS_UNAVAILABLE',
          );
        return new CodexModelDiscoveryClient(deps.fetchImpl).discover(credentials);
      });
  }

  getStatus(): CodexOAuthStatus {
    if (!this.enabled()) return this.status('hidden');
    if (this.login) return this.loginStatus(this.login);

    const authStorage = this.authStorage();
    if (authStorage.hasOAuth(OPENAI_CODEX_PROVIDER_ID) && this.hasConfiguredProvider()) {
      return this.status('connected', this.lastError);
    }
    if (this.lastError) return this.status('failed', this.lastError);
    return this.status('disconnected');
  }

  async refreshModels(): Promise<CodexOAuthStatus> {
    if (!this.enabled()) {
      throw new CodexOAuthError(404, 'Codex OAuth is not enabled.', 'FEATURE_DISABLED');
    }
    if (
      this.login ||
      !this.authStorage().hasOAuth(OPENAI_CODEX_PROVIDER_ID) ||
      !this.hasConfiguredProvider()
    ) {
      throw new CodexOAuthError(
        409,
        'Connect Codex OAuth before fetching models.',
        'OAUTH_NOT_CONNECTED',
      );
    }
    const generation = this.credentialGeneration;
    try {
      await this.ensureProviderConfigured(false);
      if (generation === this.credentialGeneration) this.lastError = undefined;
      return this.getStatus();
    } catch (error) {
      const message = codexOAuthErrorMessage(error);
      if (generation === this.credentialGeneration) this.lastError = message;
      if (error instanceof CodexOAuthError) throw error;
      throw new CodexOAuthError(502, message, 'MODEL_DISCOVERY_FAILED');
    }
  }

  async startLogin(options: CodexOAuthLoginOptions = {}): Promise<CodexOAuthStartResult> {
    if (!this.enabled()) {
      throw new CodexOAuthError(404, 'Codex OAuth is not enabled.', 'FEATURE_DISABLED');
    }
    const method = options.method ?? 'browser';
    if (method !== 'browser' && method !== 'device_code') {
      throw new CodexOAuthError(400, 'Unknown Codex login method.', 'OAUTH_INVALID_METHOD');
    }
    if (this.login) {
      if (this.login.method !== method) {
        throw new CodexOAuthError(
          409,
          'Cancel the current Codex login before changing methods.',
          'OAUTH_LOGIN_PENDING',
        );
      }
      return this.login.start;
    }
    const authStorage = this.authStorage();
    if (authStorage.hasOAuth(OPENAI_CODEX_PROVIDER_ID)) {
      if (!this.hasConfiguredProvider()) await this.ensureProviderConfigured();
      this.lastError = undefined;
      return this.getStatus();
    }
    this.lastError = undefined;
    const attempt = this.createLoginAttempt(method);
    this.login = attempt;
    this.setLoginTimeout(attempt, 15 * 60 * 1000);
    const completion = this.finishLogin(authStorage, attempt);
    return Promise.race([attempt.start, completion]);
  }

  cancelLogin(loginId: string): CodexOAuthStatus {
    const attempt = this.login;
    if (!attempt || attempt.id !== loginId) return this.getStatus();
    this.login = undefined;
    this.credentialGeneration += 1;
    this.pendingCatalog = undefined;
    this.lastError = undefined;
    clearTimeout(attempt.timeout);
    const error = new CodexOAuthError(
      409,
      'Codex OAuth login was cancelled.',
      'OAUTH_LOGIN_CANCELLED',
    );
    attempt.controller.abort(error);
    attempt.reject(error);
    return this.getStatus();
  }

  private createLoginAttempt(method: CodexOAuthLoginMethod): LoginAttempt {
    let resolve!: LoginAttempt['resolve'];
    let reject!: LoginAttempt['reject'];
    const start = new Promise<CodexOAuthStartResult>((resolveStart, rejectStart) => {
      resolve = resolveStart;
      reject = rejectStart;
    });
    return { id: randomUUID(), method, controller: new AbortController(), start, resolve, reject };
  }

  private loginStatus(attempt: LoginAttempt): CodexOAuthStartResult {
    return (
      attempt.result ?? {
        ...this.status('pending'),
        loginId: attempt.id,
        method: attempt.method,
      }
    );
  }

  private setLoginTimeout(attempt: LoginAttempt, timeoutMs: number): void {
    clearTimeout(attempt.timeout);
    attempt.timeout = setTimeout(() => {
      const error = new CodexOAuthError(
        408,
        'Codex sign-in timed out. Start login again.',
        'OAUTH_LOGIN_EXPIRED',
      );
      if (this.login !== attempt) return;
      this.login = undefined;
      this.credentialGeneration += 1;
      this.pendingCatalog = undefined;
      this.lastError = error.message;
      attempt.controller.abort(error);
      attempt.reject(error);
    }, timeoutMs);
    attempt.timeout.unref?.();
  }

  private loginCallbacks(attempt: LoginAttempt): Parameters<CodexAuthStorage['login']>[1] {
    const { signal } = attempt.controller;
    const settle = (details: Partial<CodexOAuthStartResult>) => {
      signal.throwIfAborted();
      if (attempt.result) return;
      attempt.result = { ...this.loginStatus(attempt), ...details };
      attempt.resolve(attempt.result);
    };
    return {
      onAuth: ({ url }) => {
        if (!url.trim())
          throw new CodexOAuthError(502, 'Codex OAuth returned no URL.', 'OAUTH_START_FAILED');
        settle({ authUrl: url.trim() });
      },
      onDeviceCode: ({ userCode, verificationUri, expiresInSeconds = 900 }) => {
        if (
          !userCode ||
          !verificationUri ||
          !Number.isFinite(expiresInSeconds) ||
          expiresInSeconds <= 0
        ) {
          throw new CodexOAuthError(
            502,
            'Codex OAuth returned invalid device-code details.',
            'OAUTH_START_FAILED',
          );
        }
        this.setLoginTimeout(attempt, expiresInSeconds * 1000);
        settle({
          deviceCode: {
            userCode,
            verificationUri,
            expiresAt: Date.now() + expiresInSeconds * 1000,
          },
        });
      },
      onPrompt: async () => {
        throw new Error('Codex OAuth browser callback expired. Start login again.');
      },
      onSelect: async () => attempt.method,
      ...(attempt.method === 'browser'
        ? {
            onManualCodeInput: () =>
              new Promise<string>((_resolve, reject) => {
                if (signal.aborted) reject(signal.reason);
                else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
              }),
          }
        : {}),
      signal,
      fetch: async (input, init) => {
        const requestSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(30_000),
          ...(init?.signal ? [init.signal] : []),
        ]);
        return (this.deps.fetchImpl ?? globalThis.fetch)(input, { ...init, signal: requestSignal });
      },
    };
  }

  removeCredentials(providerId: string): void {
    if (providerId !== OPENAI_CODEX_PROVIDER_ID) {
      throw new CodexOAuthError(
        404,
        `OAuth credential storage does not support provider ${providerId}.`,
        'PROVIDER_AUTH_UNAVAILABLE',
      );
    }
    if (this.login) this.cancelLogin(this.login.id);
    this.authStorage().removeOAuth(OPENAI_CODEX_PROVIDER_ID);
    this.credentialGeneration += 1;
    this.pendingCatalog = undefined;
    this.lastError = undefined;
  }

  private async finishLogin(
    authStorage: CodexAuthStorage,
    attempt: LoginAttempt,
  ): Promise<CodexOAuthStartResult> {
    try {
      await authStorage.login(OPENAI_CODEX_PROVIDER_ID, this.loginCallbacks(attempt));
      attempt.controller.signal.throwIfAborted();
      await this.ensureProviderConfigured();
      attempt.controller.signal.throwIfAborted();
      if (this.login !== attempt) return this.getStatus();
      this.lastError = undefined;
      this.login = undefined;
      const connected = this.getStatus();
      attempt.resolve(connected);
      return connected;
    } catch (error) {
      if (this.login !== attempt) return this.getStatus();
      const cause: unknown = attempt.controller.signal.reason ?? error;
      this.lastError = codexOAuthErrorMessage(cause);
      this.login = undefined;
      const failure =
        cause instanceof CodexOAuthError
          ? cause
          : new CodexOAuthError(502, this.lastError, 'OAUTH_LOGIN_FAILED');
      attempt.reject(failure);
      throw failure;
    } finally {
      clearTimeout(attempt.timeout);
    }
  }

  private enabled(): boolean {
    return this.deps.configGetter().beta?.codexOAuth === true;
  }

  private authStorage(): CodexAuthStorage {
    return this.authStorageFactory(join(this.deps.configGetter().dataDir, 'codex-auth.json'));
  }

  private hasConfiguredProvider(): boolean {
    return (
      Object.keys(
        this.deps.configGetter().custom_provider?.[OPENAI_CODEX_PROVIDER_ID]?.models ??
          this.deps.configGetter().provider?.[OPENAI_CODEX_PROVIDER_ID]?.models ??
          {},
      ).length > 0
    );
  }

  private async ensureProviderConfigured(createIfMissing = true): Promise<void> {
    if (this.pendingCatalog) return this.pendingCatalog;
    const operation = this.refreshProviderCatalog(createIfMissing);
    this.pendingCatalog = operation;
    try {
      await operation;
    } finally {
      if (this.pendingCatalog === operation) this.pendingCatalog = undefined;
    }
  }

  private async refreshProviderCatalog(createIfMissing: boolean): Promise<void> {
    const updater = this.deps.updateByokConfig;
    if (!updater) {
      throw new CodexOAuthError(
        503,
        'Codex OAuth provider configuration is unavailable.',
        'PROVIDER_CONFIG_UNAVAILABLE',
      );
    }
    const initialConfig = this.deps.configGetter();
    const hasLegacyProvider = Boolean(initialConfig.provider?.[OPENAI_CODEX_PROVIDER_ID]);
    const canCreate =
      createIfMissing &&
      !hasLegacyProvider &&
      !initialConfig.custom_provider?.[OPENAI_CODEX_PROVIDER_ID];
    if (hasLegacyProvider && !this.deps.removeLegacyProvider) {
      throw new CodexOAuthError(
        503,
        'Codex OAuth legacy provider removal is unavailable.',
        'PROVIDER_CONFIG_UNAVAILABLE',
      );
    }
    const generation = this.credentialGeneration;
    let catalog: LocalCustomProviderConfig;
    try {
      catalog = await this.catalogGetter();
    } catch (error) {
      if (error instanceof CodexOAuthError) throw error;
      throw new CodexOAuthError(
        502,
        'Codex model discovery failed. Retry fetching models from model settings.',
        'MODEL_DISCOVERY_FAILED',
      );
    }
    let configured = false;
    await updater((draft, currentConfig) => {
      if (generation !== this.credentialGeneration) return;
      const exists =
        currentConfig.custom_provider?.[OPENAI_CODEX_PROVIDER_ID] ??
        currentConfig.provider?.[OPENAI_CODEX_PROVIDER_ID];
      if (!exists && !canCreate) return;
      configureCodexOAuthProvider(draft, currentConfig, catalog);
      configured = true;
    });
    if (configured && hasLegacyProvider) {
      await this.deps.removeLegacyProvider?.(OPENAI_CODEX_PROVIDER_ID);
    }
  }

  private status(state: CodexOAuthState, error?: string): CodexOAuthStatus {
    return {
      state,
      providerId: OPENAI_CODEX_PROVIDER_ID,
      ...(error ? { error } : {}),
    };
  }
}

function configureCodexOAuthProvider(
  draft: LocalByokConfigDraft,
  currentConfig: LocalRuntimeConfig,
  catalog: LocalCustomProviderConfig,
): void {
  const tree = (draft.custom_provider ?? {}) as LocalCustomProvidersConfig;
  const current =
    currentConfig.custom_provider?.[OPENAI_CODEX_PROVIDER_ID] ??
    currentConfig.provider?.[OPENAI_CODEX_PROVIDER_ID];
  tree[OPENAI_CODEX_PROVIDER_ID] = mergeCodexOAuthProvider(current, catalog);
  draft.custom_provider = tree as Record<string, unknown>;
  if (draft.defaultModel?.startsWith(`${OPENAI_CODEX_PROVIDER_ID}/`)) {
    draft.defaultModel = `custom_provider:${draft.defaultModel}`;
  }
}

function mergeCodexOAuthProvider(
  current: LocalCustomProviderConfig | undefined,
  catalog: LocalCustomProviderConfig,
): LocalCustomProviderConfig {
  const currentOptions = { ...(current?.options ?? {}) };
  delete currentOptions.apiKey;
  const currentModels = current?.models ?? {};
  return {
    ...current,
    api: current?.api ?? catalog.api,
    name: current?.name ?? catalog.name,
    kind: 'oauth',
    enabled: current?.enabled ?? true,
    options: {
      ...currentOptions,
      baseURL: current?.options?.baseURL ?? catalog.options?.baseURL,
      authMode: 'oauth',
    },
    models: mergeCodexModels(currentModels, catalog.models ?? {}),
  };
}

function mergeCodexModels(
  current: Record<string, LocalModelConfig>,
  discovered: Record<string, LocalModelConfig>,
): Record<string, LocalModelConfig> {
  // Stored fields are authoritative, including old catalog values whose edit history is unknown.
  const models = new Map(Object.entries(current));
  for (const [id, model] of Object.entries(discovered)) {
    const existing = models.get(id);
    models.set(id, {
      ...model,
      ...existing,
      ...(model.limit || existing?.limit ? { limit: { ...model.limit, ...existing?.limit } } : {}),
      ...(model.modalities || existing?.modalities
        ? { modalities: { ...model.modalities, ...existing?.modalities } }
        : {}),
      ...(model.thinking || existing?.thinking
        ? { thinking: { ...model.thinking, ...existing?.thinking } }
        : {}),
    });
  }
  return Object.fromEntries(models);
}

function codexOAuthErrorMessage(error: unknown): string {
  if (error instanceof CodexOAuthError) return error.message;
  const message = error instanceof Error ? error.message : '';
  if (message.includes('callback expired')) return message;
  if (message.includes('EADDRINUSE')) {
    return 'Codex OAuth callback port 1455 is already in use.';
  }
  if (message.startsWith('Device flow timed out')) return 'Device code expired. Start login again.';
  if (message.includes('device code login is not enabled')) {
    return 'Enable device code login in ChatGPT security settings or workspace permissions, then retry.';
  }
  if (message === 'Login cancelled') return 'Codex OAuth login was cancelled.';
  return 'Codex OAuth login failed.';
}
