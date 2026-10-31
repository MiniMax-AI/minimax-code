import { describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../src/tui/rendering/text.js";
import { TuiProviderManager } from "../../src/tui/features/provider/manager.js";
import type { McodeProviderSnapshot } from "../../src/provider/contract.js";

const snapshot: McodeProviderSnapshot = {
  minimaxModelSource: "token_plan",
  providers: [
    {
      providerId: "minimax_oauth",
      name: "MiniMax OAuth",
      kind: "minimax-oauth",
      active: true,
      enabled: true,
      readOnly: true,
      hasApiKey: false,
      models: [],
    },
    {
      providerId: "minimax_api",
      name: "MiniMax API Key",
      kind: "minimax-api-key",
      active: false,
      enabled: true,
      readOnly: false,
      hasApiKey: false,
      models: [],
    },
    {
      providerId: "custom_provider:openai",
      name: "OpenAI",
      configRevision: "rev-1",
      kind: "custom",
      active: false,
      enabled: true,
      readOnly: false,
      apiFormat: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      hasApiKey: true,
      maskedApiKey: "sk-****1234",
      models: [{ modelId: "gpt-4.1", displayName: "GPT-4.1" }],
    },
  ],
};

const snapshotWithCodex: McodeProviderSnapshot = {
  ...snapshot,
  providers: [
    {
      providerId: "openai-codex",
      name: "OpenAI Codex",
      kind: "codex-oauth",
      active: false,
      enabled: true,
      readOnly: true,
      hasApiKey: false,
      status: { state: "disconnected" },
      models: [],
    },
    ...snapshot.providers,
  ],
};

function withSource(
  source: "token_plan" | "minimax_api_key",
): McodeProviderSnapshot {
  return {
    ...snapshot,
    minimaxModelSource: source,
    providers: snapshot.providers.map((provider) =>
      provider.providerId === "minimax_oauth"
        ? { ...provider, active: source === "token_plan" }
        : provider.providerId === "minimax_api"
          ? {
              ...provider,
              active: source === "minimax_api_key",
              hasApiKey: true,
            }
          : provider,
    ),
  };
}

function createManager(
  overrides: Partial<ConstructorParameters<typeof TuiProviderManager>[0]> = {},
) {
  return new TuiProviderManager({
    snapshot,
    onRefresh: vi.fn(async () => snapshot),
    onTest: vi.fn(async () => ({
      success: true,
      status: { state: "available" },
    })),
    onSetMiniMaxApiKey: vi.fn(async () => undefined),
    onSetMiniMaxSource: vi.fn(async () => undefined),
    onCancel: vi.fn(),
    requestRender: vi.fn(),
    ...overrides,
  });
}

describe("TuiProviderManager", () => {
  it("starts the independent Codex OAuth flow from its provider row", async () => {
    const onConnectCodex = vi.fn(async () => ({
      state: "pending" as const,
      providerId: "openai-codex" as const,
      authUrl: "https://auth.openai.example/authorize",
    }));
    const manager = createManager({
      snapshot: snapshotWithCodex,
      onConnectCodex,
    });

    manager.handleInput("\u001b[A");
    expect(stripAnsi(manager.render(90).join("\n"))).toContain(
      "Not connected · Enter or Space to connect",
    );
    manager.handleInput("\r");

    await vi.waitFor(() => expect(onConnectCodex).toHaveBeenCalledOnce());
  });

  it("resumes the Codex login panel while sign-in is pending", async () => {
    const onConnectCodex = vi.fn(async () => ({
      state: "pending" as const,
      providerId: "openai-codex" as const,
      authUrl: "https://auth.openai.example/authorize",
    }));
    const pendingSnapshot: McodeProviderSnapshot = {
      ...snapshotWithCodex,
      providers: snapshotWithCodex.providers.map((provider) =>
        provider.kind === "codex-oauth"
          ? { ...provider, status: { state: "pending" } }
          : provider,
      ),
    };
    const manager = createManager({
      snapshot: pendingSnapshot,
      onConnectCodex,
    });

    manager.handleInput("\u001b[A");
    manager.handleInput("\r");

    await vi.waitFor(() => expect(onConnectCodex).toHaveBeenCalledOnce());
  });

  it("uses the Pi cancel binding to close the provider list", () => {
    const onCancel = vi.fn();
    const manager = createManager({ onCancel });

    manager.handleInput("\x03");

    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("renders the sources and the refresh action without an add row", () => {
    const rendered = stripAnsi(createManager().render(84).join("\n"));

    expect(rendered).toContain("Providers");
    expect(rendered).toContain("MiniMax OAuth");
    expect(rendered).toContain("Active · Token Plan");
    expect(rendered).toContain("MiniMax API Key");
    expect(rendered).toContain("OpenAI");
    expect(rendered).toContain(
      "Sign-in managed by /login · Space to use · e to sign in again",
    );
    expect(rendered).toContain("r refresh models");
    expect(rendered).not.toContain("Add custom provider");
    expect(rendered).not.toContain("a add");
  });

  it("switches from MiniMax API Key back to MiniMax OAuth with space", async () => {
    const onSetMiniMaxSource = vi.fn(async () => undefined);
    const onRefresh = vi.fn(async () => withSource("token_plan"));
    const manager = createManager({
      snapshot: withSource("minimax_api_key"),
      onRefresh,
      onSetMiniMaxSource,
    });

    manager.handleInput("\u001b[A");
    manager.handleInput(" ");

    await vi.waitFor(() =>
      expect(onSetMiniMaxSource).toHaveBeenCalledWith("token_plan"),
    );
    await vi.waitFor(() => {
      const rendered = stripAnsi(manager.render(84).join("\n"));
      expect(rendered).toContain("Using MiniMax Token Plan.");
      expect(rendered).toContain("Active · Token Plan");
    });
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("selects OAuth with enter and never sends it to the test API", async () => {
    const onSetMiniMaxSource = vi.fn(async () => undefined);
    const onTest = vi.fn(async () => ({
      success: true,
      status: { state: "available" },
    }));
    const manager = createManager({ onSetMiniMaxSource, onTest });

    manager.handleInput("\r");

    await vi.waitFor(() =>
      expect(stripAnsi(manager.render(84).join("\n"))).toContain(
        "Using MiniMax Token Plan.",
      ),
    );
    expect(onSetMiniMaxSource).toHaveBeenCalledWith("token_plan");
    expect(stripAnsi(manager.render(84).join("\n"))).not.toContain(
      "Configure MiniMax API Key",
    );

    manager.handleInput("t");
    expect(onTest).not.toHaveBeenCalled();
    expect(stripAnsi(manager.render(84).join("\n"))).toContain(
      "MiniMax OAuth sign-in and connectivity are managed by /login.",
    );
  });

  it("captures the MiniMax API key when the row has none yet", async () => {
    const onSetMiniMaxApiKey = vi.fn(async () => undefined);
    const onRefresh = vi.fn(async () => withSource("minimax_api_key"));
    const manager = createManager({ onSetMiniMaxApiKey, onRefresh });

    manager.handleInput("\u001b[B");
    manager.handleInput(" ");
    expect(stripAnsi(manager.render(84).join("\n"))).toContain(
      "Configure MiniMax API Key",
    );

    manager.handleInput("sk-live-key");
    expect(stripAnsi(manager.render(84).join("\n"))).not.toContain(
      "sk-live-key",
    );
    manager.handleInput("\r");

    await vi.waitFor(() =>
      expect(onSetMiniMaxApiKey).toHaveBeenCalledWith("sk-live-key"),
    );
    await vi.waitFor(() =>
      expect(stripAnsi(manager.render(84).join("\n"))).toContain(
        "MiniMax API Key saved and selected.",
      ),
    );
  });

  it("ignores the removed add shortcut and refuses to delete MiniMax sources", () => {
    const onRefresh = vi.fn(async () => snapshot);
    const onDelete = vi.fn(async () => undefined);
    const manager = createManager({ onRefresh, onDelete });

    manager.handleInput("a");
    manager.handleInput("d");
    manager.handleInput("y");

    const rendered = stripAnsi(manager.render(84).join("\n"));
    expect(rendered).toContain("Only custom connections can be deleted.");
    expect(rendered).not.toContain("Add provider");
    expect(onDelete).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("deletes a custom connection only after y and cancels on any other key", async () => {
    const onDelete = vi.fn(async () => undefined);
    const remaining: McodeProviderSnapshot = {
      ...snapshot,
      providers: snapshot.providers.filter(
        (provider) => provider.kind !== "custom",
      ),
    };
    const onRefresh = vi.fn(async () => remaining);
    const manager = createManager({ onDelete, onRefresh });

    manager.handleInput("\u001b[B");
    manager.handleInput("\u001b[B");
    manager.handleInput("d");
    const confirmation = stripAnsi(manager.render(90).join("\n"));
    expect(confirmation).toContain("Delete OpenAI?");
    expect(confirmation).toContain("all 1 configured model.");
    expect(confirmation).toContain("y delete · any other key cancel");

    manager.handleInput("\r");
    expect(stripAnsi(manager.render(90).join("\n"))).toContain("Providers");
    manager.handleInput("d");
    manager.handleInput("n");
    expect(onDelete).not.toHaveBeenCalled();

    manager.handleInput("d");
    manager.handleInput("Y");
    await vi.waitFor(() =>
      expect(stripAnsi(manager.render(90).join("\n"))).toContain(
        "Deleted OpenAI and its 1 model.",
      ),
    );
    expect(onDelete).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledWith("custom_provider:openai");
    const rows = stripAnsi(manager.render(90).join("\n"));
    expect(rows).not.toContain("Enabled · 1 model");
    expect(rows).toContain("› ○ MiniMax API Key");
  });

  it("reports a stale list instead of a failed deletion when only the reload fails", async () => {
    const onDelete = vi.fn(async () => undefined);
    const onRefresh = vi.fn(async () => {
      throw new Error("runtime unavailable");
    });
    const manager = createManager({ onDelete, onRefresh });

    manager.handleInput("\u001b[B");
    manager.handleInput("\u001b[B");
    manager.handleInput("d");
    manager.handleInput("y");

    await vi.waitFor(() =>
      expect(stripAnsi(manager.render(180).join("\n"))).toContain(
        "Deleted OpenAI, but the list could not refresh",
      ),
    );
    const rendered = stripAnsi(manager.render(180).join("\n"));
    expect(rendered).not.toContain("Couldn't delete OpenAI");
    expect(rendered).not.toContain("unchanged");
  });

  it("keeps the connection listed when deletion fails", async () => {
    const onDelete = vi.fn(async () => {
      throw new Error("Switch to another model before deleting this provider");
    });
    const onRefresh = vi.fn(async () => snapshot);
    const manager = createManager({ onDelete, onRefresh });

    manager.handleInput("\u001b[B");
    manager.handleInput("\u001b[B");
    manager.handleInput("d");
    manager.handleInput("y");

    await vi.waitFor(() =>
      expect(stripAnsi(manager.render(180).join("\n"))).toContain(
        "Switch to another model before deleting this provider",
      ),
    );
    expect(stripAnsi(manager.render(180).join("\n"))).toContain(
      "Enabled · 1 model",
    );
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("replaces a saved MiniMax API key with e", async () => {
    const onSetMiniMaxApiKey = vi.fn(async () => undefined);
    const onRefresh = vi.fn(async () => withSource("minimax_api_key"));
    const manager = createManager({
      snapshot: withSource("minimax_api_key"),
      onSetMiniMaxApiKey,
      onRefresh,
    });

    // The API Key row is already the active source, so the constructor parks
    // the cursor there; `e` must still open the input instead of falling
    // through to the "already configured" source switch.
    manager.handleInput("e");

    const prompt = stripAnsi(manager.render(84).join("\n"));
    expect(prompt).toContain("Replace MiniMax API Key");
    expect(prompt).toContain("The saved key is overwritten once you submit.");

    manager.handleInput("sk-rotated");
    expect(stripAnsi(manager.render(84).join("\n"))).not.toContain(
      "sk-rotated",
    );
    manager.handleInput("\r");

    await vi.waitFor(() =>
      expect(onSetMiniMaxApiKey).toHaveBeenCalledWith("sk-rotated"),
    );
    await vi.waitFor(() =>
      expect(stripAnsi(manager.render(84).join("\n"))).toContain(
        "MiniMax API Key replaced and selected.",
      ),
    );
  });

  it("starts a fresh sign-in from the OAuth row with e", () => {
    const onReLogin = vi.fn();
    const onSetMiniMaxSource = vi.fn(async () => undefined);
    const manager = createManager({ onReLogin, onSetMiniMaxSource });

    manager.handleInput("e");

    expect(onReLogin).toHaveBeenCalledOnce();
    // Sign-in is not a source switch; the panel must not write the source too.
    expect(onSetMiniMaxSource).not.toHaveBeenCalled();
  });

  it("reports a host without auth instead of silently dropping e", () => {
    const manager = createManager();

    manager.handleInput("e");

    expect(stripAnsi(manager.render(84).join("\n"))).toContain(
      "MiniMax sign-in is unavailable in this host.",
    );
  });

  it("explains when a host does not support editing a custom row", () => {
    const onReLogin = vi.fn();
    const onSetMiniMaxApiKey = vi.fn(async () => undefined);
    const manager = createManager({ onReLogin, onSetMiniMaxApiKey });

    manager.handleInput("\u001b[B");
    manager.handleInput("\u001b[B");
    manager.handleInput("e");

    expect(onReLogin).not.toHaveBeenCalled();
    expect(onSetMiniMaxApiKey).not.toHaveBeenCalled();
    expect(stripAnsi(manager.render(84).join("\n"))).toContain(
      "This connection cannot be edited in this host.",
    );
  });

  it("never marks a custom provider as the in-use source", () => {
    // Regression caught in review: `active` means "current MiniMax credential
    // source" for MiniMax rows but "owns the selected model" for custom rows.
    // Rendering both as ● made two rows look selected at once.
    const withSelectedCustomModel: McodeProviderSnapshot = {
      ...withSource("minimax_api_key"),
      providers: withSource("minimax_api_key").providers.map((provider) =>
        provider.providerId === "custom_provider:openai"
          ? { ...provider, active: true }
          : provider,
      ),
    };
    const manager = createManager({ snapshot: withSelectedCustomModel });

    const lines = stripAnsi(manager.render(90).join("\n")).split("\n");
    const customRow = lines.find((line) => line.includes("OpenAI"));
    const apiKeyRow = lines.find((line) => line.includes("MiniMax API Key"));

    expect(apiKeyRow).toContain("●");
    expect(customRow).not.toContain("●");
    expect(customRow).toContain("○");
    expect(lines.filter((line) => line.includes("●"))).toHaveLength(1);
  });

  it("shows the base URL and models so a custom row stays inspectable", () => {
    const manager = createManager();

    manager.handleInput("\u001b[B");
    manager.handleInput("\u001b[B");

    const rendered = stripAnsi(manager.render(90).join("\n"));
    expect(rendered).toContain("https://api.openai.com/v1");
    expect(rendered).toContain("GPT-4.1");
    expect(rendered).toContain("openai-completions");
    expect(rendered).toContain("sk-****1234");
  });

  it("redacts credentials and URL parameters from a custom provider", () => {
    const credentialed: McodeProviderSnapshot = {
      ...snapshot,
      providers: snapshot.providers.map((provider) =>
        provider.providerId === "custom_provider:openai"
          ? {
              ...provider,
              baseUrl:
                "https://user:password@host.example.test/v1?token=query-secret#fragment-secret",
            }
          : provider,
      ),
    };
    const manager = createManager({ snapshot: credentialed });

    manager.handleInput("\u001b[B");
    manager.handleInput("\u001b[B");

    const rendered = stripAnsi(manager.render(120).join("\n"));
    expect(rendered).toContain("https://host.example.test/v1");
    expect(rendered).not.toContain("user:password");
    expect(rendered).not.toContain("query-secret");
    expect(rendered).not.toContain("fragment-secret");
  });

  it("keeps custom rows informational instead of toggling them", async () => {
    const onRefresh = vi.fn(async () => snapshot);
    const manager = createManager({ onRefresh });

    manager.handleInput("\u001b[B");
    manager.handleInput("\u001b[B");
    manager.handleInput(" ");

    await vi.waitFor(() =>
      expect(stripAnsi(manager.render(84).join("\n"))).toContain(
        "This connection cannot be edited in this host.",
      ),
    );
    expect(onRefresh).not.toHaveBeenCalled();
  });

  it("still runs a connectivity test for a custom provider", async () => {
    const onTest = vi.fn(async () => ({
      success: true,
      status: { state: "available" },
    }));
    const manager = createManager({ onTest });

    manager.handleInput("\u001b[B");
    manager.handleInput("\u001b[B");
    manager.handleInput("t");

    await vi.waitFor(() =>
      expect(onTest).toHaveBeenCalledWith("custom_provider:openai"),
    );
  });

  it("renders a disabled custom provider without the in-use marker", () => {
    // Regression caught: a leftover selected model rendered `● … Disabled`,
    // claiming a provider Runtime no longer resolves is the active source.
    const disabled: McodeProviderSnapshot = {
      ...snapshot,
      providers: snapshot.providers.map((provider) =>
        provider.providerId === "custom_provider:openai"
          ? { ...provider, enabled: false, active: false }
          : provider,
      ),
    };
    const manager = createManager({ snapshot: disabled });

    const row = stripAnsi(manager.render(90).join("\n"))
      .split("\n")
      .find((line) => line.includes("OpenAI"));

    expect(row).toBeDefined();
    expect(row).toContain("Disabled");
    expect(row).toContain("–");
    expect(row).not.toContain("●");
  });

  it("does not refresh or render after the manager is disposed mid-operation", async () => {
    let resolveSource: (() => void) | undefined;
    const sourceChange = new Promise<void>((resolve) => {
      resolveSource = resolve;
    });
    const requestRender = vi.fn();
    const onRefresh = vi.fn(async () => withSource("token_plan"));
    const manager = createManager({
      snapshot: withSource("minimax_api_key"),
      onSetMiniMaxSource: vi.fn(() => sourceChange),
      onRefresh,
      requestRender,
    });
    manager.handleInput("\u001b[A");
    manager.handleInput(" ");
    const rendersBeforeDispose = requestRender.mock.calls.length;

    manager.dispose();
    resolveSource?.();
    await sourceChange;
    await Promise.resolve();

    expect(onRefresh).not.toHaveBeenCalled();
    expect(requestRender).toHaveBeenCalledTimes(rendersBeforeDispose);
  });
});

it("opens the custom editor and keeps the provider ID and revision when replacing a Key", async () => {
  const onSaveCustom = vi.fn(async () => ({ success: true }));
  const manager = createManager({ onSaveCustom });
  manager.handleInput("\u001b[B");
  manager.handleInput("\u001b[B");
  manager.handleInput("e");
  expect(stripAnsi(manager.render(100).join("\n"))).toContain("Edit OpenAI");
  manager.handleInput("\r");
  manager.handleInput("replacement-secret");
  manager.handleInput("\r");
  expect(stripAnsi(manager.render(100).join("\n"))).not.toContain(
    "replacement-secret",
  );
  for (let i = 0; i < 4; i++) manager.handleInput("\u001b[B");
  manager.handleInput("\r");
  await vi.waitFor(() => expect(onSaveCustom).toHaveBeenCalledOnce());
  expect(onSaveCustom).toHaveBeenCalledWith(
    expect.objectContaining({
      providerId: "custom_provider:openai",
      expectedRevision: "rev-1",
      apiKey: "replacement-secret",
      saveAndUse: false,
    }),
  );
  await vi.waitFor(() =>
    expect(stripAnsi(manager.render(110).join("\n"))).toContain(
      "All its models now use the new API Key.",
    ),
  );
});

it("refreshes the selected provider once and reports new models", async () => {
  const onRefreshModels = vi.fn(async () => 2);
  const manager = createManager({ onRefreshModels });
  manager.handleInput("\u001b[B");
  manager.handleInput("\u001b[B");
  manager.handleInput("r");
  manager.handleInput("r");
  await vi.waitFor(() =>
    expect(stripAnsi(manager.render(110).join("\n"))).toContain(
      "Added 2 new model(s)",
    ),
  );
  expect(onRefreshModels).toHaveBeenCalledOnce();
  expect(onRefreshModels).toHaveBeenCalledWith(snapshot.providers[2]);
});

it("shows discovery failures and allows a retry", async () => {
  const onRefreshModels = vi
    .fn()
    .mockRejectedValueOnce(new Error("HTTP 401"))
    .mockResolvedValueOnce(0);
  const manager = createManager({ onRefreshModels });
  manager.handleInput("\u001b[B");
  manager.handleInput("\u001b[B");
  manager.handleInput("r");
  await vi.waitFor(() =>
    expect(stripAnsi(manager.render(180).join("\n"))).toContain("HTTP 401"),
  );
  manager.handleInput("r");
  await vi.waitFor(() =>
    expect(stripAnsi(manager.render(110).join("\n"))).toContain(
      "Models are already up to date.",
    ),
  );
});
