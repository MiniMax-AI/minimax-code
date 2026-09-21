import type {
  McodeProviderTemplate,
  McodeProviderView,
} from "../../src/provider/contract.js";
import { stripAnsi, visibleWidth } from "../../src/tui/rendering/text.js";
import { describe, expect, it, vi } from "vitest";

import { TuiProviderOnboarding } from "../../src/tui/features/provider/onboarding.js";

const knownTemplate: McodeProviderTemplate = {
  providerId: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com/v1",
  apiFormat: "openai-completions",
  models: [
    {
      modelId: "deepseek-chat",
      displayName: "DeepSeek Chat",
      configurationSource: "discovered",
      attachment: true,
      reasoning: false,
      toolCall: true,
      temperature: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 128_000, output: 8_192 },
    },
    {
      modelId: "deepseek-reasoner",
      displayName: "DeepSeek Reasoner",
      configurationSource: "discovered",
      reasoning: true,
      toolCall: true,
    },
  ],
};

describe("TuiProviderOnboarding", () => {
  it("moves from the first model to API Key with Up and shows the setup shortcut inline", () => {
    const onboarding = new TuiProviderOnboarding({
      templates: [knownTemplate],
      onSave: vi.fn(),
      onComplete: vi.fn(),
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });

    onboarding.handleInput("\r");
    expect(stripAnsi(onboarding.render(90).join("\n"))).toContain(
      "API Key: Not configured · Tab to configure",
    );

    onboarding.handleInput("\u001b[A");
    expect(stripAnsi(onboarding.render(90).join("\n"))).toContain(
      "→ API Key: Not configured · Enter to configure",
    );

    onboarding.handleInput("\r");
    onboarding.handleInput("key-entered-from-up");
    expect(stripAnsi(onboarding.render(90).join("\n"))).not.toContain(
      "key-entered-from-up",
    );
  });

  it("moves down from API Key to models and keeps the key entered before moving down", async () => {
    const onSave = vi.fn(async () => ({ success: true }));
    const onboarding = new TuiProviderOnboarding({
      templates: [knownTemplate],
      onSave,
      onComplete: vi.fn(),
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });

    onboarding.handleInput("\r");
    onboarding.handleInput("\u001b[A");
    onboarding.handleInput("\u001b[B");
    expect(stripAnsi(onboarding.render(90).join("\n"))).toContain(
      "API Key: Not configured · Tab to configure",
    );

    onboarding.handleInput("\u001b[A");
    onboarding.handleInput("\r");
    onboarding.handleInput("key-kept-with-down");
    onboarding.handleInput("\u001b[B");
    const modelView = stripAnsi(onboarding.render(90).join("\n"));
    expect(modelView).toContain("API Key: Ready for test · Tab to edit");
    expect(modelView).not.toContain("Edit:");
    expect(modelView).not.toContain("key-kept-with-down");

    onboarding.handleInput("\r");
    onboarding.handleInput("\r");
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "key-kept-with-down" }),
    );
  });

  it("browses model details and only saves on the second Enter with a configured key", async () => {
    const onSave = vi.fn(async () => ({
      success: true,
      provider: { providerId: "custom_provider:deepseek" },
    }));
    const onComplete = vi.fn(async () => undefined);
    const onboarding = new TuiProviderOnboarding({
      templates: [knownTemplate],
      onSave,
      onComplete,
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });

    onboarding.handleInput("\r");
    expect(stripAnsi(onboarding.render(90).join("\n"))).toContain(
      "API Key: Not configured",
    );
    onboarding.handleInput("\t");
    onboarding.handleInput("\r");
    onboarding.handleInput("sk-super-secret");
    const maskedLines = onboarding.render(40);
    const masked = stripAnsi(maskedLines.join("\n"));
    expect(masked).toContain("API Key");
    expect(masked).not.toContain("sk-super-secret");
    expect(maskedLines.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
    onboarding.handleInput("\r");
    expect(stripAnsi(onboarding.render(90).join("\n"))).toContain(
      "API Key: Ready for test",
    );
    expect(onSave).not.toHaveBeenCalled();

    onboarding.handleInput("\r");
    const details = stripAnsi(onboarding.render(90).join("\n"));
    expect(details).toContain("Model ID: deepseek-chat");
    expect(details).toContain("Limits: context 128,000 · output 8,192");
    expect(details).toContain("Modalities: input text, image · output text");
    expect(details).toContain("Capabilities: attachments, tools, temperature");
    expect(onSave).not.toHaveBeenCalled();
    onboarding.handleInput("\r");

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenCalledWith({
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "sk-super-secret",
      apiFormat: "openai-completions",
      models: knownTemplate.models,
      modelId: "deepseek-chat",
      saveAndUse: true,
    });
    expect(onComplete).toHaveBeenCalledWith({
      providerId: "custom_provider:deepseek",
      providerName: "DeepSeek",
      modelId: "deepseek-chat",
    });
  });

  it("opens masked API Key editing on the second Enter when no key is configured", () => {
    const onSave = vi.fn();
    const onboarding = new TuiProviderOnboarding({
      templates: [knownTemplate],
      onSave,
      onComplete: vi.fn(),
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });

    onboarding.handleInput("\r");
    onboarding.handleInput("reasoner");
    expect(stripAnsi(onboarding.render(90).join("\n"))).toContain(
      "DeepSeek Reasoner",
    );
    onboarding.handleInput("\r");
    expect(stripAnsi(onboarding.render(90).join("\n"))).toContain(
      "Model ID: deepseek-reasoner",
    );
    onboarding.handleInput("\r");

    onboarding.handleInput("key-from-model-details");
    const narrow = onboarding.render(40);
    const editing = stripAnsi(narrow.join("\n"));
    expect(editing).toContain("→ API Key: Not configured · Enter to");
    expect(editing).toContain("Edit:");
    expect(editing).toContain("Model ID: deepseek-reasoner");
    expect(editing).not.toContain("key-from-model-details");
    expect(editing).not.toContain("Configure an API Key with Tab");
    expect(narrow.every((line) => visibleWidth(line) <= 40)).toBe(true);
    expect(onSave).not.toHaveBeenCalled();

    onboarding.handleInput("\u001b");
    onboarding.handleInput("\u001b");
    expect(stripAnsi(onboarding.render(90).join("\n"))).toContain(
      "Model ID: deepseek-reasoner",
    );
    onboarding.handleInput("\u001b");
    expect(stripAnsi(onboarding.render(90).join("\n"))).not.toContain(
      "Model ID:",
    );
    onboarding.handleInput("\r");
    onboarding.handleInput("\u001b[B");
    expect(stripAnsi(onboarding.render(90).join("\n"))).not.toContain(
      "Model ID:",
    );
    onboarding.handleInput("\u001b");
    expect(stripAnsi(onboarding.render(90).join("\n"))).toContain(
      "Choose a known provider or enter a custom endpoint",
    );
  });

  it("cancels key editing without replacing the previous draft", async () => {
    const onSave = vi.fn(async () => ({ success: true }));
    const onboarding = new TuiProviderOnboarding({
      templates: [knownTemplate],
      onSave,
      onComplete: vi.fn(),
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });

    onboarding.handleInput("\r");
    onboarding.handleInput("\t");
    onboarding.handleInput("\r");
    onboarding.handleInput("kept-key");
    onboarding.handleInput("\r");
    onboarding.handleInput("\t");
    onboarding.handleInput("\r");
    onboarding.handleInput("discarded-key");
    onboarding.handleInput("\u001b");
    onboarding.handleInput("\u001b");
    onboarding.handleInput("\r");
    onboarding.handleInput("\r");

    await vi.waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "kept-key" }),
    );
    await vi.waitFor(() =>
      expect(stripAnsi(onboarding.render(90).join("\n"))).toContain(
        "API Key: Not configured",
      ),
    );
  });

  it("keeps known-provider details and key draft after a failed connection test", async () => {
    const onSave = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        status: { state: "failed", lastErrorMessage: "401 unauthorized" },
      })
      .mockResolvedValueOnce({ success: true });
    const onComplete = vi.fn();
    const onboarding = new TuiProviderOnboarding({
      templates: [knownTemplate],
      onSave,
      onComplete,
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });

    onboarding.handleInput("\r");
    onboarding.handleInput("\t");
    onboarding.handleInput("\r");
    onboarding.handleInput("bad-key");
    onboarding.handleInput("\r");
    onboarding.handleInput("\r");
    onboarding.handleInput("\r");

    await vi.waitFor(() =>
      expect(stripAnsi(onboarding.render(90).join("\n"))).toContain(
        "401 unauthorized",
      ),
    );
    const failed = stripAnsi(onboarding.render(90).join("\n"));
    expect(failed).toContain("Model ID: deepseek-chat");
    expect(failed).toContain("API Key: Ready for test");
    expect(failed).not.toContain("bad-key");

    onboarding.handleInput("\t");
    onboarding.handleInput("\r");
    onboarding.handleInput("good-key");
    onboarding.handleInput("\r");
    onboarding.handleInput("\r");

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenLastCalledWith(
      expect.objectContaining({ apiKey: "good-key" }),
    );
  });

  it("collects the minimum custom provider fields without the remote catalog", async () => {
    const onSave = vi.fn(async () => ({
      success: true,
      provider: { providerId: "custom_provider:team-gateway" },
    }));
    const onComplete = vi.fn(async () => undefined);
    const onboarding = new TuiProviderOnboarding({
      templates: [],
      catalogWarning: "Known providers unavailable; Custom remains available.",
      onSave,
      onComplete,
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });

    expect(stripAnsi(onboarding.render(90).join("\n"))).toContain(
      "Custom provider",
    );
    onboarding.handleInput("\r");
    onboarding.handleInput("Team Gateway");
    onboarding.handleInput("\r");
    onboarding.handleInput("https://gateway.example/v1");
    onboarding.handleInput("\r");
    onboarding.handleInput("\r");
    onboarding.handleInput("model-a");
    onboarding.handleInput("\r");
    onboarding.handleInput("secret");
    onboarding.handleInput("\r");

    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenCalledWith({
      name: "Team Gateway",
      baseUrl: "https://gateway.example/v1",
      apiKey: "secret",
      apiFormat: "openai-completions",
      models: [
        {
          modelId: "model-a",
          displayName: "model-a",
          configurationSource: "manual",
          toolCall: true,
        },
      ],
      modelId: "model-a",
      saveAndUse: true,
    });
  });

  it("keeps the form open when Runtime rejects the connection test", async () => {
    const onComplete = vi.fn();
    const onboarding = new TuiProviderOnboarding({
      templates: [],
      onSave: vi.fn(async () => ({
        success: false,
        status: { state: "failed", lastErrorMessage: "401 unauthorized" },
      })),
      onComplete,
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });

    onboarding.handleInput("\r");
    onboarding.handleInput("Gateway");
    onboarding.handleInput("\r");
    onboarding.handleInput("https://gateway.example/v1");
    onboarding.handleInput("\r");
    onboarding.handleInput("\r");
    onboarding.handleInput("model-a");
    onboarding.handleInput("\r");
    onboarding.handleInput("bad-key");
    onboarding.handleInput("\r");

    await vi.waitFor(() =>
      expect(stripAnsi(onboarding.render(90).join("\n"))).toContain(
        "401 unauthorized",
      ),
    );
    expect(onComplete).not.toHaveBeenCalled();
  });
});

const savedConnection: McodeProviderView = {
  providerId: "custom_provider:work",
  name: "DeepSeek Work",
  kind: "custom",
  active: true,
  enabled: true,
  readOnly: false,
  hasApiKey: true,
  configRevision: "rev-1",
  baseUrl: knownTemplate.baseUrl,
  apiFormat: knownTemplate.apiFormat,
  models: [{ modelId: "deepseek-chat" }, { modelId: "private-model" }],
};

describe("existing connection onboarding", () => {
  it("defaults to the existing connection and saves with its ID, revision and saved Key", async () => {
    const onSave = vi.fn(async () => ({ success: true }));
    const onComplete = vi.fn();
    const onboarding = new TuiProviderOnboarding({
      templates: [knownTemplate],
      providers: [savedConnection],
      onSave,
      onComplete,
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });
    onboarding.handleInput("\r");
    const choice = stripAnsi(onboarding.render(150).join("\n"));
    expect(choice).toContain("Use existing connection: DeepSeek Work");
    expect(choice).toContain("Add another account");
    onboarding.handleInput("\r");
    expect(stripAnsi(onboarding.render(110).join("\n"))).toContain(
      "Saved key (unchanged)",
    );
    onboarding.handleInput("\r");
    onboarding.handleInput("\r");
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenCalledWith({
      providerId: savedConnection.providerId,
      expectedRevision: "rev-1",
      name: savedConnection.name,
      baseUrl: savedConnection.baseUrl,
      apiFormat: knownTemplate.apiFormat,
      saveAndUse: true,
      modelId: "deepseek-chat",
      models: [
        { modelId: "deepseek-chat" },
        { modelId: "private-model" },
        knownTemplate.models[1],
      ],
    });
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ reused: true }),
    );
  });

  it("creates a separate account only after an explicit choice and alias", async () => {
    const onSave = vi.fn(async () => ({ success: true }));
    const onboarding = new TuiProviderOnboarding({
      templates: [knownTemplate],
      providers: [savedConnection],
      onSave,
      onComplete: vi.fn(),
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });
    onboarding.handleInput("\r");
    onboarding.handleInput("\u001b[B");
    onboarding.handleInput("\r");
    expect(stripAnsi(onboarding.render(120).join("\n"))).toContain(
      "Account alias",
    );
    onboarding.handleInput("DeepSeek Personal");
    onboarding.handleInput("\r");
    onboarding.handleInput("\r");
    onboarding.handleInput("\r");
    onboarding.handleInput("second-account-key");
    onboarding.handleInput("\r");
    onboarding.handleInput("\r");
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledOnce());
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "DeepSeek Personal",
        apiKey: "second-account-key",
      }),
    );
    expect(onSave).not.toHaveBeenCalledWith(
      expect.objectContaining({ providerId: expect.any(String) }),
    );
  });

  it("does not match a provider with a different protocol or endpoint", () => {
    for (const provider of [
      { ...savedConnection, baseUrl: "https://different.example" },
      { ...savedConnection, apiFormat: "openai-responses" as const },
    ]) {
      const onboarding = new TuiProviderOnboarding({
        templates: [knownTemplate],
        providers: [provider],
        onSave: vi.fn(),
        onComplete: vi.fn(),
        onCancel: vi.fn(),
        requestRender: vi.fn(),
      });
      onboarding.handleInput("\r");
      expect(stripAnsi(onboarding.render(100).join("\n"))).toContain(
        "API Key: Not configured",
      );
    }
  });
});

describe("preset endpoint editing", () => {
  const template: McodeProviderTemplate = {
    providerId: "zai",
    name: "Z.AI API",
    baseUrl: "https://api.z.ai/api/paas/v4",
    apiFormat: "openai-completions",
    models: [{ modelId: "glm-5.3", toolCall: true }],
  };

  it("keeps the key and model after failure and tests only an explicitly confirmed endpoint", async () => {
    const onSave = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        status: { lastErrorMessage: "429 insufficient balance synthetic-key" },
      })
      .mockResolvedValueOnce({ success: true });
    const onComplete = vi.fn();
    const onboarding = new TuiProviderOnboarding({
      templates: [template],
      onSave,
      onComplete,
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });
    onboarding.handleInput("\r");
    expect(stripAnsi(onboarding.render(140).join("\n"))).toContain(
      template.baseUrl,
    );
    onboarding.handleInput("\r");
    onboarding.handleInput("\r");
    onboarding.handleInput("synthetic-key");
    onboarding.handleInput("\r");
    onboarding.handleInput("\r");
    await vi.waitFor(() =>
      expect(stripAnsi(onboarding.render(180).join("\n"))).toContain(
        "Changes were not saved",
      ),
    );
    expect(onComplete).not.toHaveBeenCalled();
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(stripAnsi(onboarding.render(180).join("\n"))).not.toContain(
      "synthetic-key",
    );

    onboarding.handleInput("\u0005");
    onboarding.handleInput("\u0001");
    onboarding.handleInput("\u000b");
    onboarding.handleInput("ftp://invalid");
    onboarding.handleInput("\r");
    expect(stripAnsi(onboarding.render(140).join("\n"))).toContain(
      "Base URL must use http or https",
    );
    onboarding.handleInput("\u0001");
    onboarding.handleInput("\u000b");
    const codingUrl = "https://api.z.ai/api/coding/paas/v4";
    onboarding.handleInput(codingUrl);
    onboarding.handleInput("\r");
    expect(onSave).toHaveBeenCalledTimes(1);
    const view = stripAnsi(onboarding.render(140).join("\n"));
    expect(view).toContain(codingUrl);
    expect(view).toContain("Model ID: glm-5.3");
    expect(view).toContain("API Key: Ready for test");
    onboarding.handleInput("\r");
    await vi.waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(onSave.mock.calls.map(([input]) => input.baseUrl)).toEqual([
      template.baseUrl,
      codingUrl,
    ]);
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      apiKey: "synthetic-key",
      modelId: "glm-5.3",
      models: template.models,
      saveAndUse: true,
    });
  });

  it("cancels endpoint editing and clears the override when another preset is selected", async () => {
    const onSave = vi.fn(async () => ({ success: true }));
    const onboarding = new TuiProviderOnboarding({
      templates: [template, knownTemplate],
      onSave,
      onComplete: vi.fn(),
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });
    onboarding.handleInput("\r");
    onboarding.handleInput("\u0005");
    onboarding.handleInput("discarded");
    onboarding.handleInput("\u001b");
    expect(stripAnsi(onboarding.render(140).join("\n"))).not.toContain(
      "discarded",
    );
    onboarding.handleInput("\u0005");
    onboarding.handleInput("\u0001");
    onboarding.handleInput("\u000b");
    onboarding.handleInput("https://explicit.example/v1");
    onboarding.handleInput("\r");
    onboarding.handleInput("\u001b");
    onboarding.handleInput("\u001b[B");
    onboarding.handleInput("\r");
    expect(stripAnsi(onboarding.render(140).join("\n"))).toContain(
      knownTemplate.baseUrl,
    );
    expect(stripAnsi(onboarding.render(140).join("\n"))).not.toContain(
      "explicit.example",
    );
    expect(onSave).not.toHaveBeenCalled();
  });
});
