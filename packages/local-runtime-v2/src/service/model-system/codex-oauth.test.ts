import { join } from "node:path";
import { AuthStorage } from '@earendil-works/pi-coding-agent/auth-storage';
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  LocalByokConfigDraft,
  LocalCustomProviderConfig,
  LocalRuntimeConfig,
} from "./contracts.js";
import { CodexOAuthManager, CodexOAuthError } from "./codex-oauth.js";

function createConfig(enabled: boolean): LocalRuntimeConfig {
  return {
    dataDir: "/tmp/model-system-codex-oauth-test",
    provider: {},
    beta: { codexOAuth: enabled },
  };
}

function createUpdater(target: LocalRuntimeConfig) {
  return vi.fn(
    async (
      mutate: (
        draft: LocalByokConfigDraft,
        currentConfig: LocalRuntimeConfig,
      ) => void | Promise<void>,
    ) => {
      const draft: LocalByokConfigDraft = {
        custom_provider: target.custom_provider
          ? structuredClone(target.custom_provider)
          : undefined,
        defaultModel: target.defaultModel,
      };
      await mutate(draft, target);
      target.custom_provider =
        draft.custom_provider as LocalRuntimeConfig["custom_provider"];
      target.defaultModel = draft.defaultModel;
      return { config: target };
    },
  );
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("CodexOAuthManager", () => {
  it("keeps the capability hidden and rejects login while disabled", async () => {
    const config = createConfig(false);
    const login = vi.fn();
    const manager = new CodexOAuthManager({
      configGetter: () => config,
      authStorageFactory: () => ({
        getCredentials: async () => undefined,
        hasOAuth: () => false,
        removeOAuth: vi.fn(),
        login,
      }),
      catalogGetter: async () => codexCatalog(),
    });

    expect(manager.getStatus()).toEqual({
      state: "hidden",
      providerId: "openai-codex",
    });
    await expect(manager.startLogin()).rejects.toMatchObject({
      status: 404,
      code: "FEATURE_DISABLED",
    } satisfies Partial<CodexOAuthError>);
    expect(login).not.toHaveBeenCalled();
  });

  it("projects existing OAuth credentials into Provider management state", async () => {
    const config = createConfig(true);
    const update = createUpdater(config);
    const login = vi.fn();
    const manager = new CodexOAuthManager({
      configGetter: () => config,
      updateByokConfig: update,
      authStorageFactory: () => ({
        getCredentials: async () => undefined,
        hasOAuth: () => true,
        removeOAuth: vi.fn(),
        login,
      }),
      catalogGetter: async () => codexCatalog(),
    });

    await expect(manager.startLogin()).resolves.toMatchObject({
      state: "connected",
    });
    expect(login).not.toHaveBeenCalled();
    expect(config.custom_provider?.["openai-codex"]).toMatchObject({
      api: "openai-codex-responses",
      kind: "oauth",
      options: {
        authMode: "oauth",
        baseURL: "https://chatgpt.com/backend-api",
      },
      models: { "gpt-test": { name: "GPT Test" } },
    });
  });

  it("does not recreate a deleted OAuth configuration group from stored credentials", async () => {
    const config = createConfig(true);
    const update = createUpdater(config);
    const manager = new CodexOAuthManager({
      configGetter: () => config,
      updateByokConfig: update,
      authStorageFactory: () => ({
        getCredentials: async () => undefined,
        hasOAuth: () => true,
        removeOAuth: vi.fn(),
        login: vi.fn(),
      }),
      catalogGetter: async () => codexCatalog(),
    });

    await expect(manager.refreshModels()).rejects.toMatchObject({
      code: "OAUTH_NOT_CONNECTED",
    });

    expect(update).not.toHaveBeenCalled();
    expect(config.custom_provider).toBeUndefined();
    expect(manager.getStatus()).toEqual({
      state: "disconnected",
      providerId: "openai-codex",
    });
  });

  it("requires the typed config capability before migrating a legacy OAuth provider", async () => {
    const config = createConfig(true);
    config.provider["openai-codex"] = {
      options: { authMode: "oauth" },
      models: { "gpt-test": {} },
    };
    const update = createUpdater(config);
    const manager = new CodexOAuthManager({
      configGetter: () => config,
      updateByokConfig: update,
      authStorageFactory: () => ({
        getCredentials: async () => undefined,
        hasOAuth: () => true,
        removeOAuth: vi.fn(),
        login: vi.fn(),
      }),
      catalogGetter: async () => codexCatalog(),
    });

    await expect(manager.refreshModels()).rejects.toMatchObject({
      status: 503,
      code: "PROVIDER_CONFIG_UNAVAILABLE",
    } satisfies Partial<CodexOAuthError>);
    expect(update).not.toHaveBeenCalled();
  });

  it("returns the browser URL before the background login finishes", async () => {
    const config = createConfig(true);
    const completion = deferred();
    let connected = false;
    let loginCallbacks: Parameters<AuthStorage["login"]>[1] | undefined;
    const fetchImpl = vi.fn<typeof fetch>();
    const login = vi.fn(
      async (
        _provider: string,
        callbacks: Parameters<AuthStorage["login"]>[1],
      ) => {
        loginCallbacks = callbacks;
        callbacks.onAuth({ url: "https://auth.openai.test/authorize" });
        await completion.promise;
        connected = true;
      },
    );
    const manager = new CodexOAuthManager({
      configGetter: () => config,
      fetchImpl,
      updateByokConfig: createUpdater(config),
      authStorageFactory: () => ({
        getCredentials: async () => undefined,
        hasOAuth: () => connected,
        removeOAuth: vi.fn(),
        login,
      }),
      catalogGetter: async () => codexCatalog(),
    });

    await expect(manager.startLogin()).resolves.toEqual({
      state: "pending",
      providerId: "openai-codex",
      authUrl: "https://auth.openai.test/authorize",
      loginId: expect.any(String),
      method: "browser",
    });
    expect(manager.getStatus()).toMatchObject({ state: "pending" });
    await loginCallbacks?.fetch?.("https://auth.openai.test/probe");
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://auth.openai.test/probe",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    await expect(
      loginCallbacks?.onSelect({ message: "", options: [] }),
    ).resolves.toBe("browser");

    completion.resolve();
    await vi.waitFor(() =>
      expect(manager.getStatus()).toMatchObject({ state: "connected" }),
    );
    expect(config.custom_provider?.["openai-codex"]?.kind).toBe("oauth");
  });
});

describe("CodexOAuthManager login edge cases", () => {
  it("deduplicates concurrent login starts", async () => {
    const config = createConfig(true);
    const completion = deferred();
    let callbacks: Parameters<AuthStorage["login"]>[1] | undefined;
    let connected = false;
    const login = vi.fn(
      async (
        _provider: string,
        nextCallbacks: Parameters<AuthStorage["login"]>[1],
      ) => {
        callbacks = nextCallbacks;
        await completion.promise;
        connected = true;
      },
    );
    const manager = new CodexOAuthManager({
      configGetter: () => config,
      updateByokConfig: createUpdater(config),
      authStorageFactory: () => ({
        getCredentials: async () => undefined,
        hasOAuth: () => connected,
        removeOAuth: vi.fn(),
        login,
      }),
      catalogGetter: async () => codexCatalog(),
    });

    const first = manager.startLogin();
    await vi.waitFor(() => expect(callbacks).toBeDefined());
    const second = manager.startLogin();
    callbacks?.onAuth({ url: " https://auth.openai.test/authorize " });
    callbacks?.onAuth({ url: "https://auth.openai.test/ignored" });

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        state: "pending",
        providerId: "openai-codex",
        authUrl: "https://auth.openai.test/authorize",
        loginId: expect.any(String),
        method: "browser",
      },
      {
        state: "pending",
        providerId: "openai-codex",
        authUrl: "https://auth.openai.test/authorize",
        loginId: expect.any(String),
        method: "browser",
      },
    ]);
    expect(login).toHaveBeenCalledTimes(1);

    completion.resolve();
    await vi.waitFor(() =>
      expect(manager.getStatus()).toMatchObject({ state: "connected" }),
    );
  });

  it.each([
    ["empty authorization URL", "auth", "OAUTH_START_FAILED"],
    ["invalid device-code details", "device", "OAUTH_START_FAILED"],
  ])("rejects an unsupported %s", async (_name, callbackKind, code) => {
    const config = createConfig(true);
    const login = vi.fn(
      async (
        _provider: string,
        callbacks: Parameters<AuthStorage["login"]>[1],
      ) => {
        if (callbackKind === "auth") callbacks.onAuth({ url: "   " });
        else
          callbacks.onDeviceCode?.({
            verificationUri: "https://auth.openai.test/device",
            userCode: "",
          });
      },
    );
    const manager = new CodexOAuthManager({
      configGetter: () => config,
      updateByokConfig: createUpdater(config),
      authStorageFactory: () => ({
        getCredentials: async () => undefined,
        hasOAuth: () => false,
        removeOAuth: vi.fn(),
        login,
      }),
      catalogGetter: async () => codexCatalog(),
    });

    await expect(manager.startLogin()).rejects.toMatchObject({ code });
  });

  it.each([
    ["EADDRINUSE", "Codex OAuth callback port 1455 is already in use."],
    ["Login cancelled", "Codex OAuth login was cancelled."],
    [
      "Codex OAuth browser callback expired. Start login again.",
      "Codex OAuth browser callback expired. Start login again.",
    ],
    ["socket closed", "Codex OAuth login failed."],
  ])("sanitizes login failure %s", async (message, expected) => {
    const config = createConfig(true);
    const manager = new CodexOAuthManager({
      configGetter: () => config,
      updateByokConfig: createUpdater(config),
      authStorageFactory: () => ({
        getCredentials: async () => undefined,
        hasOAuth: () => false,
        removeOAuth: vi.fn(),
        login: vi.fn(async () => Promise.reject(new Error(message))),
      }),
      catalogGetter: async () => codexCatalog(),
    });

    await expect(manager.startLogin()).rejects.toMatchObject({
      code: "OAUTH_LOGIN_FAILED",
      message: expected,
    });
    expect(manager.getStatus()).toEqual({
      state: "failed",
      providerId: "openai-codex",
      error: expected,
    });
  });
});

describe("CodexOAuthManager reconciliation and credentials", () => {
  it("reports explicit refresh failures and keeps legacy credentials usable", async () => {
    const config = createConfig(true);
    config.provider["openai-codex"] = { models: { legacy: {} } };
    const manager = new CodexOAuthManager({
      configGetter: () => config,
      updateByokConfig: vi.fn(async () =>
        Promise.reject(new Error("EADDRINUSE")),
      ),
      removeLegacyProvider: vi.fn(),
      authStorageFactory: () => ({
        getCredentials: async () => undefined,
        hasOAuth: () => true,
        removeOAuth: vi.fn(),
        login: vi.fn(),
      }),
      catalogGetter: async () => codexCatalog(),
    });

    await expect(manager.refreshModels()).rejects.toMatchObject({
      code: "MODEL_DISCOVERY_FAILED",
    });
    expect(manager.getStatus()).toEqual({
      state: "connected",
      providerId: "openai-codex",
      error: "Codex OAuth callback port 1455 is already in use.",
    });
  });

  it("migrates legacy and existing custom provider state", async () => {
    const config = createConfig(true);
    config.provider["openai-codex"] = { models: { legacy: {} } };
    config.custom_provider = {
      "openai-codex": {
        api: "openai-responses",
        name: "Existing Codex",
        enabled: false,
        options: {
          apiKey: "must-be-removed",
          baseURL: "https://existing.example/v1",
          tenant: "tenant-a",
        },
        models: { existing: { name: "Existing model" } },
      },
    };
    config.defaultModel = "openai-codex/existing";
    const removeLegacyProvider = vi.fn(async () => {
      delete config.provider["openai-codex"];
    });
    const manager = new CodexOAuthManager({
      configGetter: () => config,
      updateByokConfig: createUpdater(config),
      removeLegacyProvider,
      authStorageFactory: () => ({
        getCredentials: async () => undefined,
        hasOAuth: () => true,
        removeOAuth: vi.fn(),
        login: vi.fn(),
      }),
      catalogGetter: async () => codexCatalog(),
    });

    await expect(manager.refreshModels()).resolves.toMatchObject({
      state: "connected",
    });
    expect(removeLegacyProvider).toHaveBeenCalledWith("openai-codex");
    expect(config.custom_provider?.["openai-codex"]).toMatchObject({
      api: "openai-responses",
      name: "Existing Codex",
      kind: "oauth",
      enabled: false,
      options: {
        authMode: "oauth",
        baseURL: "https://existing.example/v1",
        tenant: "tenant-a",
      },
      models: { existing: { name: "Existing model" } },
    });
    expect(
      config.custom_provider?.["openai-codex"]?.options,
    ).not.toHaveProperty("apiKey");
    expect(config.defaultModel).toBe("custom_provider:openai-codex/existing");
  });

  it("removes only supported credentials", () => {
    const config = createConfig(true);
    const removeOAuth = vi.fn();
    const manager = new CodexOAuthManager({
      configGetter: () => config,
      authStorageFactory: () => ({
        getCredentials: async () => undefined,
        hasOAuth: () => false,
        removeOAuth,
        login: vi.fn(),
      }),
      catalogGetter: async () => codexCatalog(),
    });

    expect(() => manager.removeCredentials("other")).toThrowError(
      expect.objectContaining({ code: "PROVIDER_AUTH_UNAVAILABLE" }),
    );
    manager.removeCredentials("openai-codex");
    expect(removeOAuth).toHaveBeenCalledWith("openai-codex");
  });
});

function codexCatalog(): LocalCustomProviderConfig & {
  models: NonNullable<LocalCustomProviderConfig["models"]>;
} {
  return {
    api: "openai-codex-responses",
    name: "OpenAI Codex",
    kind: "oauth",
    enabled: true,
    options: { authMode: "oauth", baseURL: "https://chatgpt.com/backend-api" },
    models: {
      "gpt-test": {
        name: "GPT Test",
        reasoning: true,
        limit: { context: 272_000 },
        thinking: { effortOptions: ["low", "high", "ultra"] },
        modalities: { input: ["text", "image"], output: ["text"] },
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function connectedManager(
  config: LocalRuntimeConfig,
  catalogGetter = vi.fn(async () => codexCatalog()),
) {
  const manager = new CodexOAuthManager({
    configGetter: () => config,
    updateByokConfig: createUpdater(config),
    authStorageFactory: () => ({
      getCredentials: async () => undefined,
      hasOAuth: () => true,
      removeOAuth: vi.fn(),
      login: vi.fn(),
    }),
    catalogGetter,
  });
  return { manager, catalogGetter };
}

describe("Codex OAuth catalog refresh", () => {
  it("adds discovered models while keeping user overrides, partial limits, false, arrays and ordering", async () => {
    const config = createConfig(true);
    config.custom_provider = {
      "openai-codex": {
        ...codexCatalog(),
        enabled: false,
        models: {
          custom: { name: "Manual", limit: { context: 100_000 } },
          "gpt-test": {
            name: "My model",
            enabled: false,
            reasoning: false,
            limit: { context: 800_000, output: 50_000 },
            thinking: { effortOptions: ["high"] },
            modalities: { input: ["text"] },
          },
        },
      },
    };
    config.defaultModel = "custom_provider:openai-codex/gpt-test";
    const catalog = codexCatalog();
    catalog.models["gpt-6-astra"] = {
      limit: { context: 272_000 },
      thinking: { effortOptions: ["ultra"] },
    };
    const { manager } = connectedManager(
      config,
      vi.fn(async () => catalog),
    );
    await manager.refreshModels();
    const provider = config.custom_provider["openai-codex"];
    if (!provider) throw new Error("Expected a persisted OAuth provider");
    expect(provider.enabled).toBe(false);
    expect(Object.keys(provider.models ?? {})).toEqual([
      "custom",
      "gpt-test",
      "gpt-6-astra",
    ]);
    expect(provider.models?.["gpt-test"]).toMatchObject({
      name: "My model",
      enabled: false,
      reasoning: false,
      limit: { context: 800_000, output: 50_000 },
      thinking: { effortOptions: ["high"] },
      modalities: { input: ["text"], output: ["text"] },
    });
    expect(provider.models?.["gpt-6-astra"]).toEqual(
      catalog.models["gpt-6-astra"],
    );
    expect(config.defaultModel).toBe("custom_provider:openai-codex/gpt-test");
  });

  it("fills missing nested fields using the latest config when the network request finishes", async () => {
    const config = createConfig(true);
    config.custom_provider = {
      "openai-codex": { models: { "gpt-test": { limit: { context: 1 } } } },
    };
    const completion = deferred();
    const { manager } = connectedManager(
      config,
      vi.fn(async () => {
        await completion.promise;
        return codexCatalog();
      }),
    );
    const refresh = manager.refreshModels();
    config.custom_provider["openai-codex"] = {
      models: {
        "gpt-test": {
          limit: { output: 60_000 },
          thinking: { effortOptions: [] },
        },
      },
    };
    completion.resolve();
    await refresh;
    expect(
      config.custom_provider["openai-codex"]?.models?.["gpt-test"],
    ).toMatchObject({
      limit: { context: 272_000, output: 60_000 },
      thinking: { effortOptions: [] },
    });
  });

  it("only fetches on explicit requests and deduplicates concurrent requests", async () => {
    const config = createConfig(true);
    config.custom_provider = { "openai-codex": codexCatalog() };
    const { manager, catalogGetter } = connectedManager(config);
    manager.getStatus();
    await manager.startLogin();
    manager.getStatus();
    expect(catalogGetter).not.toHaveBeenCalled();
    await Promise.all([manager.refreshModels(), manager.refreshModels()]);
    expect(catalogGetter).toHaveBeenCalledTimes(1);
    await manager.refreshModels();
    expect(catalogGetter).toHaveBeenCalledTimes(2);
  });

  it("rejects model fetching when OAuth is disabled", async () => {
    const { manager, catalogGetter } = connectedManager(createConfig(false));
    await expect(manager.refreshModels()).rejects.toMatchObject({
      code: "FEATURE_DISABLED",
    });
    expect(catalogGetter).not.toHaveBeenCalled();
  });

  it("keeps persisted models on refresh failure and allows an explicit retry", async () => {
    const config = createConfig(true);
    config.custom_provider = { "openai-codex": codexCatalog() };
    const before = structuredClone(config.custom_provider);
    const { manager, catalogGetter } = connectedManager(
      config,
      vi.fn(async () => {
        throw new Error("secret-token");
      }),
    );
    await expect(manager.refreshModels()).rejects.toMatchObject({
      code: "MODEL_DISCOVERY_FAILED",
    });
    expect(config.custom_provider).toEqual(before);
    expect(manager.getStatus()).toMatchObject({
      state: "connected",
      error: expect.stringContaining("model discovery failed"),
    });
    expect(JSON.stringify(manager.getStatus())).not.toContain("secret-token");
    manager.getStatus();
    expect(catalogGetter).toHaveBeenCalledTimes(1);
    catalogGetter.mockResolvedValue(codexCatalog());
    await manager.refreshModels();
    expect(manager.getStatus()).toEqual({
      state: "connected",
      providerId: "openai-codex",
    });
  });

  it("keeps a provider deleted while a manual refresh was in flight", async () => {
    const config = createConfig(true);
    config.custom_provider = { "openai-codex": codexCatalog() };
    const completion = deferred();
    const { manager } = connectedManager(
      config,
      vi.fn(async () => {
        await completion.promise;
        return codexCatalog();
      }),
    );
    const refresh = manager.refreshModels();
    delete config.custom_provider["openai-codex"];
    completion.resolve();
    await refresh;
    expect(config.custom_provider).toEqual({});
  });
});

describe("Codex OAuth catalog credential lifecycle", () => {
  it.each([false, true])(
    "isolates reconnect from an old catalog request (failure: %s)",
    async (fails) => {
      const config = createConfig(true);
      config.custom_provider = { "openai-codex": codexCatalog() };
      const oldRequest = deferred();
      const newRequest = deferred();
      const catalogGetter = vi
        .fn()
        .mockImplementationOnce(async () => {
          await oldRequest.promise;
          if (fails) throw new Error("old account failed");
          return codexCatalog();
        })
        .mockImplementationOnce(async () => {
          await newRequest.promise;
          return { ...codexCatalog(), models: { "new-account-model": {} } };
        });
      const { manager } = connectedManager(config, catalogGetter);
      const oldRefresh = manager.refreshModels().catch(() => undefined);
      manager.removeCredentials("openai-codex");
      delete config.custom_provider["openai-codex"];
      const reconnect = manager.startLogin();
      expect(catalogGetter).toHaveBeenCalledTimes(2);
      oldRequest.resolve();
      await oldRefresh;
      const concurrentReconnect = manager.startLogin();
      expect(catalogGetter).toHaveBeenCalledTimes(2);
      expect(manager.getStatus().error).toBeUndefined();
      newRequest.resolve();
      await Promise.all([reconnect, concurrentReconnect]);
      expect(manager.getStatus()).toEqual({
        state: "connected",
        providerId: "openai-codex",
      });
      expect(
        Object.keys(config.custom_provider["openai-codex"]?.models ?? {}),
      ).toEqual(["new-account-model"]);
    },
  );

  it("discards discovery after credentials are removed", async () => {
    const config = createConfig(true);
    const completion = deferred();
    const { manager } = connectedManager(
      config,
      vi.fn(async () => {
        await completion.promise;
        return codexCatalog();
      }),
    );
    const start = manager.startLogin();
    manager.removeCredentials("openai-codex");
    completion.resolve();
    await expect(start).resolves.toMatchObject({ state: "disconnected" });
    expect(config.custom_provider?.["openai-codex"]).toBeUndefined();
  });

  it("deduplicates catalog requests during explicit reconnects", async () => {
    const config = createConfig(true);
    const completion = deferred();
    const { manager, catalogGetter } = connectedManager(
      config,
      vi.fn(async () => {
        await completion.promise;
        return codexCatalog();
      }),
    );
    const first = manager.startLogin();
    const second = manager.startLogin();
    completion.resolve();
    await Promise.all([first, second]);
    expect(catalogGetter).toHaveBeenCalledTimes(1);
  });

  it("keeps credentials after first discovery fails and connects on retry", async () => {
    const config = createConfig(true);
    const { manager, catalogGetter } = connectedManager(
      config,
      vi.fn(async () => {
        throw new Error("failed");
      }),
    );
    await expect(manager.startLogin()).rejects.toMatchObject({
      code: "MODEL_DISCOVERY_FAILED",
    });
    expect(config.custom_provider).toBeUndefined();
    catalogGetter.mockResolvedValue(codexCatalog());
    await expect(manager.startLogin()).resolves.toMatchObject({
      state: "connected",
    });
  });
});

describe("Codex OAuth profile credentials", () => {
  it("uses the current profile auth storage with refresh and host fetch before model discovery", async () => {
    const config = createConfig(true);
    const storage = AuthStorage.inMemory({
      "openai-codex": {
        type: "oauth",
        access: "old",
        refresh: "refresh",
        expires: 0,
        accountId: "account-old",
      },
    });
    const createStorage = vi
      .spyOn(AuthStorage, "create")
      .mockReturnValue(storage);
    const getKey = vi
      .spyOn(storage, "getApiKey")
      .mockImplementation(async () => {
        storage.set("openai-codex", {
          type: "oauth",
          access: "fresh",
          refresh: "refresh",
          expires: Date.now() + 60_000,
          accountId: "account-new",
        });
        return "fresh";
      });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            {
              slug: "gpt-6-astra",
              display_name: "GPT-6 Astra",
              visibility: "list",
              context_window: 272_000,
              max_context_window: 872_000,
              supported_reasoning_levels: [{ effort: "ultra" }],
            },
          ],
        }),
      ),
    );
    const manager = new CodexOAuthManager({
      configGetter: () => config,
      fetchImpl,
      updateByokConfig: createUpdater(config),
    });
    await manager.startLogin();
    expect(createStorage).toHaveBeenCalledWith(
      join(config.dataDir, "codex-auth.json"),
    );
    expect(getKey).toHaveBeenCalledWith("openai-codex", {
      includeFallback: false,
      fetch: fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      expect.stringContaining("/codex/models?"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer fresh",
          "ChatGPT-Account-ID": "account-new",
        }),
      }),
    );
    expect(
      config.custom_provider?.["openai-codex"]?.models?.["gpt-6-astra"],
    ).toMatchObject({
      limit: { context: 272_000 },
      thinking: { effortOptions: ["ultra"] },
    });
    expect(JSON.stringify(config)).not.toContain("fresh");
  });

  it("does not use an API key or fallback when OAuth credentials cannot be refreshed", async () => {
    const config = createConfig(true);
    const storage = AuthStorage.inMemory({
      "openai-codex": {
        type: "oauth",
        access: "old",
        refresh: "refresh",
        expires: 0,
        accountId: "account",
      },
    });
    vi.spyOn(AuthStorage, "create").mockReturnValue(storage);
    vi.spyOn(storage, "getApiKey").mockResolvedValue(undefined);
    const fetchImpl = vi.fn<typeof fetch>();
    const manager = new CodexOAuthManager({
      configGetter: () => config,
      fetchImpl,
      updateByokConfig: createUpdater(config),
    });
    await expect(manager.startLogin()).rejects.toMatchObject({
      code: "OAUTH_CREDENTIALS_UNAVAILABLE",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("Codex device-code login", () => {
  function deviceHarness() {
    const config = createConfig(true);
    const storage = AuthStorage.inMemory();
    vi.spyOn(AuthStorage, "create").mockReturnValue(storage);
    let authorize!: (response: Response) => void;
    const authorization = new Promise<Response>((resolve) => {
      authorize = resolve;
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith("/deviceauth/usercode")) {
        return Response.json({
          device_auth_id: "device-1",
          user_code: "ABCD-EFGH",
          interval: "0",
        });
      }
      if (url.endsWith("/deviceauth/token")) return authorization;
      if (url.endsWith("/oauth/token")) {
        const payload = Buffer.from(
          JSON.stringify({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "account-test",
            },
          }),
        ).toString("base64url");
        return Response.json({
          access_token: `test.${payload}.test`,
          refresh_token: "test-refresh",
          expires_in: 3600,
        });
      }
      throw new Error("Unexpected OAuth endpoint");
    });
    const manager = new CodexOAuthManager({
      configGetter: () => config,
      fetchImpl,
      updateByokConfig: createUpdater(config),
      catalogGetter: async () => codexCatalog(),
    });
    return { manager, config, storage, fetchImpl, authorize };
  }

  it("uses Pi device auth with the host fetch, saves credentials and configures models after approval", async () => {
    const h = deviceHarness();
    const start = await h.manager.startLogin({ method: "device_code" });
    expect(start).toMatchObject({
      state: "pending",
      method: "device_code",
      loginId: expect.any(String),
      deviceCode: {
        userCode: "ABCD-EFGH",
        verificationUri: "https://auth.openai.com/codex/device",
        expiresAt: expect.any(Number),
      },
    });
    expect(h.manager.getStatus()).toEqual(start);
    await expect(
      h.manager.startLogin({ method: "device_code" }),
    ).resolves.toEqual(start);
    expect(h.storage.getAll()["openai-codex"]).toBeUndefined();
    expect(
      h.fetchImpl.mock.calls.filter(([url]) =>
        String(url).endsWith("/usercode"),
      ),
    ).toHaveLength(1);
    h.authorize(
      Response.json({
        authorization_code: "test-code",
        code_verifier: "test-verifier",
      }),
    );
    await vi.waitFor(() =>
      expect(h.manager.getStatus().state).toBe("connected"),
    );
    expect(h.storage.getAll()["openai-codex"]).toMatchObject({
      type: "oauth",
      accountId: "account-test",
    });
    expect(h.config.custom_provider?.["openai-codex"]?.models).toHaveProperty(
      "gpt-test",
    );
    const exchange = h.fetchImpl.mock.calls.find(([url]) =>
      String(url).endsWith("/oauth/token"),
    )!;
    expect(exchange[1]?.body).toBeInstanceOf(URLSearchParams);
    expect(String(exchange[1]?.body)).toContain(
      "grant_type=authorization_code",
    );
    expect(String(exchange[1]?.body)).toContain(
      "redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback",
    );
    expect(
      h.fetchImpl.mock.calls.every(
        ([, init]) => init?.signal instanceof AbortSignal,
      ),
    ).toBe(true);
    expect(JSON.stringify(h.manager.getStatus())).not.toContain("test-refresh");
  });

  it("cancels a pending request and prevents a late response from persisting credentials or configuring models", async () => {
    const h = deviceHarness();
    const piLogin = vi.spyOn(AuthStorage.prototype, "login");
    const start = await h.manager.startLogin({ method: "device_code" });
    await vi.waitFor(() => expect(h.fetchImpl).toHaveBeenCalledTimes(2));
    const pollSignal = h.fetchImpl.mock.calls[1]![1]?.signal;
    expect(h.manager.cancelLogin(start.loginId!)).toMatchObject({
      state: "disconnected",
    });
    expect(pollSignal?.aborted).toBe(true);
    h.authorize(
      Response.json({
        authorization_code: "late-code",
        code_verifier: "late-verifier",
      }),
    );
    await piLogin.mock.results[0]!.value;
    await Promise.resolve();
    expect(h.storage.getAll()["openai-codex"]).toBeUndefined();
    expect(h.config.custom_provider).toBeUndefined();
    expect(h.manager.getStatus()).toEqual({
      state: "disconnected",
      providerId: "openai-codex",
    });
  });

  it("does not let a stale cancel stop a newer attempt and requires cancellation before switching methods", async () => {
    const h = deviceHarness();
    const first = await h.manager.startLogin({ method: "device_code" });
    h.manager.cancelLogin(first.loginId!);
    const second = await h.manager.startLogin({ method: "device_code" });
    expect(second.loginId).not.toEqual(first.loginId);
    expect(h.manager.cancelLogin(first.loginId!)).toEqual(second);
    await expect(
      h.manager.startLogin({ method: "browser" }),
    ).rejects.toMatchObject({
      code: "OAUTH_LOGIN_PENDING",
    });
    h.manager.cancelLogin(second.loginId!);
  });

  it("aborts expired device codes, clears pending details and allows retry", async () => {
    vi.useFakeTimers();
    const config = createConfig(true);
    const login = vi.fn(
      async (
        _provider: string,
        callbacks: Parameters<AuthStorage["login"]>[1],
      ) => {
        callbacks.onDeviceCode({
          userCode: "ABCD-EFGH",
          verificationUri: "https://auth.openai.com/codex/device",
          expiresInSeconds: 1,
        });
        await new Promise((_resolve, reject) =>
          callbacks.signal!.addEventListener(
            "abort",
            () => reject(callbacks.signal!.reason),
            {
              once: true,
            },
          ),
        );
      },
    );
    const manager = new CodexOAuthManager({
      configGetter: () => config,
      authStorageFactory: () => ({
        getCredentials: async () => undefined,
        hasOAuth: () => false,
        removeOAuth: vi.fn(),
        login,
      }),
    });
    await manager.startLogin({ method: "device_code" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(manager.getStatus()).toMatchObject({
      state: "failed",
      error: "Codex sign-in timed out. Start login again.",
    });
    expect(manager.getStatus().deviceCode).toBeUndefined();
    const retry = await manager.startLogin({ method: "device_code" });
    manager.cancelLogin(retry.loginId!);
    vi.useRealTimers();
  });
});
