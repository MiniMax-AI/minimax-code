import { stripAnsi, visibleWidth } from "../../src/tui/rendering/text.js";
import { describe, expect, it, vi } from "vitest";
import { TuiModelPicker } from "../../src/tui/features/model/picker.js";

describe("TuiModelPicker", () => {
  it("selects each declared Kimi K3 effort without inventing a medium level", () => {
    const onSelect = vi.fn();
    const model = {
      providerId: "custom_provider:moonshotai",
      modelId: "kimi-k3",
      selected: true,
      effortOptions: ["low", "high", "max"],
    };
    const picker = new TuiModelPicker([model], onSelect, vi.fn());
    expect(stripAnsi(picker.render(80).join("\n"))).toContain("[ high ]");
    for (const [key, effort] of [
      ["\u001b[D", "low"],
      ["\u001b[C", "high"],
      ["\u001b[C", "max"],
    ] as const) {
      picker.handleInput(key);
      expect(stripAnsi(picker.render(80).join("\n"))).toContain(`[ ${effort} ]`);
      picker.handleInput("\r");
      expect(onSelect).toHaveBeenLastCalledWith(model, effort);
    }
  });

  it("switches M3 context independently of thinking and restores the saved choice", () => {
    const model = {
      providerId: "minimax",
      modelId: "MiniMax-M3",
      selected: true,
      contextLimit: 512_000,
      contextWindowOptions: [512_000, 1_000_000],
      contextWindowOptionHints: { "1000000": "higher_usage" as const },
      thinkingConfig: { mode: "switchable", defaultValue: "true" },
    };
    const onSelect = vi.fn();
    const picker = new TuiModelPicker([model], onSelect, vi.fn());
    expect(stripAnsi(picker.render(100).join("\n"))).toContain("[ 512K ]");
    picker.handleInput("\t");
    picker.handleInput("\x1b[C");
    const rendered = stripAnsi(picker.render(100).join("\n"));
    expect(rendered).toContain("[ 1M ]");
    expect(rendered).toContain("Higher usage with this context window.");
    expect(rendered).toContain("[ Off ]");
    expect(onSelect).not.toHaveBeenCalled();
    expect(model.contextLimit).toBe(512_000);
    picker.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ contextLimit: 1_000_000, variant: "" }),
    );
    const reopened = new TuiModelPicker(
      [{ ...model, contextLimit: 1_000_000 }],
      onSelect,
      vi.fn(),
    );
    expect(stripAnsi(reopened.render(100).join("\n"))).toContain("[ 1M ]");
    reopened.handleInput("\x1b[Z");
    expect(stripAnsi(reopened.render(100).join("\n"))).toContain("[ 512K ]");
  });

  it("keeps context drafts while filtering, preserves effort and discards cancelled changes", () => {
    const model = {
      providerId: "minimax",
      modelId: "MiniMax-M3",
      contextLimit: 512_000,
      contextWindowOptions: [512_000, 1_000_000],
      effortOptions: ["low", "high"],
    };
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const picker = new TuiModelPicker([model], onSelect, onCancel);
    picker.handleInput("M3");
    picker.handleInput("\t");
    expect(stripAnsi(picker.render(100).join("\n"))).toContain("Search: M3");
    picker.handleInput("\x7f");
    picker.handleInput("\x7f");
    picker.handleInput("\x1b[C");
    picker.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ contextLimit: 1_000_000 }),
      "high",
    );
    const cancelled = new TuiModelPicker([model], onSelect, onCancel);
    cancelled.handleInput("\t");
    cancelled.handleInput("\x1b");
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledOnce();
    expect(model.contextLimit).toBe(512_000);
  });

  it("does not invent context choices and keeps the control usable in short viewports", () => {
    const onSelect = vi.fn();
    const fixed = {
      providerId: "work",
      modelId: "fixed",
      contextLimit: 200_000,
    };
    const picker = new TuiModelPicker([fixed], onSelect, vi.fn());
    picker.handleInput("\t");
    picker.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith(fixed);
    expect(stripAnsi(picker.render(100).join("\n"))).not.toContain(
      "tab context",
    );
    const switchable = new TuiModelPicker(
      [{ ...fixed, contextWindowOptions: [200_000, 1_000_000] }],
      vi.fn(),
      vi.fn(),
    );
    switchable.handleInput("\t");
    for (const height of [6, 8, 12]) {
      const lines = switchable.renderViewport(60, height);
      expect(lines.length).toBeLessThanOrEqual(height);
      expect(lines.every((line) => visibleWidth(line) <= 60)).toBe(true);
      expect(stripAnsi(lines.join("\n"))).toContain(
        height === 6 ? "1M ctx" : "[ 1M ]",
      );
    }
  });

  it("keeps model focus ahead of helper text in a short viewport", () => {
    const picker = new TuiModelPicker(
      [
        {
          providerId: "minimax",
          modelId: "MiniMax-M3",
          displayName: "MiniMax-M3",
        },
      ],
      vi.fn(),
      vi.fn(),
      { unavailableHint: "Sign in to use this model" },
    );
    for (const height of [6, 8]) {
      const visible = stripAnsi(picker.renderViewport(40, height).join("\n"));
      expect(visible).toContain("›");
      expect(visible).toContain("MiniMax-M3");
      expect(visible.toLowerCase()).toContain("esc");
    }
  });

  it("keeps third-party provider onboarding available when the model roster is empty", () => {
    const onAddProvider = vi.fn();
    const picker = new TuiModelPicker([], vi.fn(), vi.fn(), { onAddProvider });

    expect(stripAnsi(picker.render(90).join("\n"))).toContain(
      "Add 3rd-party provider",
    );
    expect(stripAnsi(picker.render(90).join("\n"))).toContain(
      "No matching models",
    );
    picker.handleInput("\r");

    expect(onAddProvider).toHaveBeenCalledOnce();
  });

  it("groups models by provider and filters the grouped list while typing", () => {
    const onSelect = vi.fn();
    const picker = new TuiModelPicker(
      [
        {
          providerId: "minimax",
          providerName: "MiniMax",
          modelId: "MiniMax-M3",
          displayName: "MiniMax-M3",
        },
        {
          providerId: "minimax",
          providerName: "MiniMax",
          modelId: "MiniMax-M2.7",
          displayName: "MiniMax-M2.7",
        },
        {
          providerId: "deepseek",
          providerName: "DeepSeek",
          modelId: "deepseek-v4-pro",
          displayName: "deepseek-v4-pro",
        },
      ],
      onSelect,
      vi.fn(),
    );

    const initial = stripAnsi(picker.render(90).join("\n"));
    expect(initial).toContain("MiniMax · 2");
    expect(initial).toContain("DeepSeek · 1");

    picker.handleInput("deepseek");
    const filtered = stripAnsi(picker.render(90).join("\n"));
    expect(filtered).toContain("Search: deepseek");
    expect(filtered).toContain("DeepSeek · 1");
    expect(filtered).toContain("deepseek-v4-pro");
    expect(filtered).not.toContain("MiniMax-M3");

    picker.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "deepseek",
        modelId: "deepseek-v4-pro",
      }),
    );
  });

  it("confirms before deleting the focused custom provider and keeps plain d for search", async () => {
    const onDeleteProvider = vi.fn(async () => undefined);
    const onSelect = vi.fn();
    const picker = new TuiModelPicker(
      [
        {
          providerId: "custom_provider:openai",
          providerName: "OpenAI",
          providerSource: "custom_provider",
          providerKind: "custom",
          modelId: "gpt-4o",
          displayName: "GPT-4o",
        },
        {
          providerId: "custom_provider:openai",
          providerName: "OpenAI",
          providerSource: "custom_provider",
          providerKind: "custom",
          modelId: "gpt-4o-mini",
          displayName: "GPT-4o mini",
        },
      ],
      onSelect,
      vi.fn(),
      { onDeleteProvider, requestRender: vi.fn() },
    );

    expect(stripAnsi(picker.render(90).join("\n"))).toContain(
      "ctrl+d delete provider",
    );
    picker.handleInput("d");
    expect(stripAnsi(picker.render(90).join("\n"))).toContain("Search: d");
    expect(onDeleteProvider).not.toHaveBeenCalled();

    picker.handleInput("\x7f");
    picker.handleInput("\x04");
    const confirmation = stripAnsi(picker.render(90).join("\n"));
    expect(confirmation).toContain("Delete provider?");
    expect(confirmation).toContain("OpenAI");
    expect(confirmation).toContain("all 2 configured models");
    expect(onDeleteProvider).not.toHaveBeenCalled();

    picker.handleInput("\x1b");
    expect(stripAnsi(picker.render(90).join("\n"))).toContain("GPT-4o");
    picker.handleInput("\x04");
    picker.handleInput("\r");

    await vi.waitFor(() =>
      expect(onDeleteProvider).toHaveBeenCalledWith("custom_provider:openai"),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("does not offer provider deletion for built-in models", () => {
    const onDeleteProvider = vi.fn(async () => undefined);
    const picker = new TuiModelPicker(
      [
        {
          providerId: "minimax",
          providerName: "MiniMax",
          providerSource: "provider",
          providerKind: "minimax-managed",
          modelId: "MiniMax-M3",
          displayName: "MiniMax-M3",
        },
      ],
      vi.fn(),
      vi.fn(),
      { onDeleteProvider, requestRender: vi.fn() },
    );

    expect(stripAnsi(picker.render(90).join("\n"))).not.toContain(
      "delete provider",
    );
    picker.handleInput("\x04");

    expect(stripAnsi(picker.render(90).join("\n"))).not.toContain(
      "Delete provider?",
    );
    expect(onDeleteProvider).not.toHaveBeenCalled();
  });

  it("keeps the provider and confirmation available when deletion fails", async () => {
    const picker = new TuiModelPicker(
      [
        {
          providerId: "custom_provider:openai",
          providerName: "OpenAI",
          providerSource: "custom_provider",
          providerKind: "custom",
          modelId: "gpt-4o",
          displayName: "GPT-4o",
        },
      ],
      vi.fn(),
      vi.fn(),
      {
        onDeleteProvider: vi.fn(async () => {
          throw new Error("storage unavailable");
        }),
        requestRender: vi.fn(),
      },
    );

    picker.handleInput("\x04");
    picker.handleInput("\r");

    await vi.waitFor(() =>
      expect(stripAnsi(picker.render(180).join("\n"))).toContain(
        "Couldn't delete provider",
      ),
    );
    expect(stripAnsi(picker.render(180).join("\n"))).toContain(
      "The provider and its models are unchanged.",
    );
    picker.handleInput("\x1b");
    expect(stripAnsi(picker.render(90).join("\n"))).toContain("GPT-4o");
  });

  it("searches Provider display names and restores the grouped list after an empty result", () => {
    const picker = new TuiModelPicker(
      [
        {
          providerId: "gateway-east",
          providerName: "Team Gateway",
          modelId: "model-a",
          displayName: "Model A",
        },
        {
          providerId: "gateway-west",
          providerName: "Other Gateway",
          modelId: "model-b",
          displayName: "Model B",
        },
      ],
      vi.fn(),
      vi.fn(),
    );

    picker.handleInput("team");
    let rendered = stripAnsi(picker.render(90).join("\n"));
    expect(rendered).toContain("Team Gateway · 1");
    expect(rendered).toContain("Model A");
    expect(rendered).not.toContain("Model B");

    picker.handleInput("x");
    rendered = stripAnsi(picker.render(90).join("\n"));
    expect(rendered).toContain("No matching models");
    expect(rendered).not.toContain("Model A");

    picker.handleInput("\x7f");
    rendered = stripAnsi(picker.render(90).join("\n"));
    expect(rendered).toContain("Team Gateway · 1");
    expect(rendered).toContain("Model A");
  });

  it("restores the Runtime-selected model after clearing a filter that hid it", () => {
    const onSelect = vi.fn();
    const picker = new TuiModelPicker(
      [
        {
          providerId: "minimax",
          modelId: "MiniMax-M3",
          displayName: "MiniMax-M3",
          selected: true,
        },
        {
          providerId: "deepseek",
          modelId: "deepseek-v4-pro",
          displayName: "deepseek-v4-pro",
        },
      ],
      onSelect,
      vi.fn(),
    );

    picker.handleInput("deepseek");
    for (let index = 0; index < "deepseek".length; index += 1)
      picker.handleInput("\x7f");
    picker.handleInput("\r");

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "minimax", modelId: "MiniMax-M3" }),
    );
  });

  it("keeps Think effort unchanged while left and right move the search cursor", () => {
    const onSelect = vi.fn();
    const picker = new TuiModelPicker(
      [
        {
          providerId: "provider",
          modelId: "model-a",
          displayName: "Model A",
          selected: true,
          effortOptions: ["low", "medium", "high"],
        },
      ],
      onSelect,
      vi.fn(),
      {},
      "low",
    );

    picker.handleInput("model");
    expect(stripAnsi(picker.render(90).join("\n"))).toContain("[ low ]");
    picker.handleInput("\u001b[C");
    expect(stripAnsi(picker.render(90).join("\n"))).toContain("[ low ]");

    picker.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "model-a" }),
      "low",
    );
  });

  it("renders Desktop-owned models and returns the selected model", () => {
    const onSelect = vi.fn();
    const picker = new TuiModelPicker(
      [
        {
          providerId: "minimax",
          modelId: "MiniMax-M2.7",
          displayName: "MiniMax M2.7",
          selected: true,
          contextLimit: 204800,
        },
        {
          providerId: "provider-b",
          modelId: "model-b",
          displayName: "Model B",
        },
      ],
      onSelect,
      vi.fn(),
    );

    expect(picker.render(90).join("\n")).toContain("Models");
    expect(picker.render(90).join("\n")).toContain("MiniMax M2.7");
    expect(picker.render(90).join("\n")).toContain("Available models");
    picker.handleInput("\r");

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "minimax",
        modelId: "MiniMax-M2.7",
      }),
    );
  });

  it("focuses the Runtime-selected model when reopening the picker", () => {
    const onSelect = vi.fn();
    const picker = new TuiModelPicker(
      [
        {
          providerId: "minimax",
          modelId: "MiniMax-M3",
          displayName: "MiniMax-M3",
          selected: false,
        },
        {
          providerId: "custom_provider:innerTest",
          modelId: "MiniMax-M3",
          displayName: "m3.05",
          selected: true,
        },
      ],
      onSelect,
      vi.fn(),
    );

    picker.handleInput("\r");

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "custom_provider:innerTest",
        displayName: "m3.05",
      }),
    );
  });

  it.each(["\u001B", "\x03"])(
    "supports a prefiltered model list and Pi cancel input %j without inventing fallback models",
    (input) => {
      const onCancel = vi.fn();
      const picker = new TuiModelPicker([], vi.fn(), onCancel);

      expect(picker.render(70).join("\n")).toContain("No matching models");
      picker.handleInput(input);
      expect(onCancel).toHaveBeenCalledOnce();
    },
  );

  it("keeps managed models visible but rejects them when login is required", () => {
    const onSelect = vi.fn();
    const onUnavailable = vi.fn();
    const picker = new TuiModelPicker(
      [
        {
          providerId: "minimax",
          modelId: "MiniMax-M2.7",
          displayName: "MiniMax M2.7",
          providerKind: "minimax-managed",
        },
      ],
      onSelect,
      vi.fn(),
      {
        isUnavailable: () => true,
        onUnavailable,
      },
    );

    expect(picker.render(90).join("\n")).toContain("Login required");
    picker.handleInput("\r");

    expect(onUnavailable).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps switchable Thinking as a draft until Enter applies the model selection", () => {
    // Regression caught: treating Thinking as a model-name suffix or persisting arrow keys immediately.
    const onSelect = vi.fn();
    const picker = new TuiModelPicker(
      [
        {
          providerId: "minimax",
          modelId: "MiniMax-M3",
          displayName: "MiniMax-M3",
          selected: true,
          variant: "thinking",
          thinkingConfig: { mode: "switchable", defaultValue: "true" },
        },
      ],
      onSelect,
      vi.fn(),
    );

    expect(stripAnsi(picker.render(80).join("\n"))).toContain("Thinking");
    expect(stripAnsi(picker.render(80).join("\n"))).toContain("[ On ]");

    picker.handleInput("\u001b[D");

    expect(onSelect).not.toHaveBeenCalled();
    expect(stripAnsi(picker.render(80).join("\n"))).toContain("[ Off ]");

    picker.handleInput("\r");

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "minimax",
        modelId: "MiniMax-M3",
        variant: "",
      }),
    );
  });

  it("uses each highlighted model Thinking state without leaking the previous draft", () => {
    // Regression caught: carrying one model's unsaved Thinking choice into the next highlighted model.
    const onSelect = vi.fn();
    const picker = new TuiModelPicker(
      [
        {
          providerId: "minimax",
          modelId: "MiniMax-M3",
          displayName: "MiniMax-M3",
          variant: "thinking",
          thinkingConfig: { mode: "switchable", defaultValue: "true" },
        },
        {
          providerId: "provider-b",
          modelId: "model-b",
          displayName: "Model B",
          variant: "",
          thinkingConfig: { mode: "switchable", defaultValue: "false" },
        },
      ],
      onSelect,
      vi.fn(),
    );

    picker.handleInput("\u001b[D");
    picker.handleInput("\u001b[B");

    expect(stripAnsi(picker.render(80).join("\n"))).toContain("[ Off ]");
    picker.handleInput("\u001b[D");
    picker.handleInput("\u001b[A");
    expect(stripAnsi(picker.render(80).join("\n"))).toContain("[ Off ]");
  });

  it("keeps a stable panel height when highlighted models expose different controls", () => {
    const picker = new TuiModelPicker(
      [
        {
          providerId: "minimax",
          modelId: "MiniMax-M3",
          displayName: "MiniMax-M3",
          selected: true,
          variant: "thinking",
          thinkingConfig: { mode: "switchable", defaultValue: "true" },
        },
        {
          providerId: "minimax",
          modelId: "MiniMax-M2.7-highspeed",
          displayName: "MiniMax-M2.7-highspeed",
          thinkingConfig: { mode: "hidden" },
        },
      ],
      vi.fn(),
      vi.fn(),
    );

    const thinkingRows = picker.render(90);
    expect(stripAnsi(thinkingRows.join("\n"))).toContain("Thinking");

    picker.handleInput("\u001b[B");

    const plainRows = picker.render(90);
    expect(stripAnsi(plainRows.join("\n"))).not.toContain("Thinking");
    expect(plainRows).toHaveLength(thinkingRows.length);
  });

  it("renders forced Thinking as read only and hides undisclosed Thinking configuration", () => {
    // Regression caught: exposing a switch for forced or hidden provider policy.
    const onSelect = vi.fn();
    const forced = new TuiModelPicker(
      [
        {
          providerId: "minimax",
          modelId: "MiniMax-M3",
          displayName: "MiniMax-M3",
          variant: "thinking",
          thinkingConfig: { mode: "forced_on" },
        },
      ],
      onSelect,
      vi.fn(),
    );
    const hidden = new TuiModelPicker(
      [
        {
          providerId: "provider-b",
          modelId: "model-b",
          displayName: "Model B",
          thinkingConfig: { mode: "hidden" },
        },
      ],
      vi.fn(),
      vi.fn(),
    );

    expect(stripAnsi(forced.render(80).join("\n"))).toContain("Thinking On");
    expect(stripAnsi(forced.render(80).join("\n"))).not.toContain("←/→");
    forced.handleInput("\u001b[D");
    forced.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "thinking" }),
    );
    expect(stripAnsi(hidden.render(80).join("\n"))).not.toContain("Thinking");
  });

  it("keeps catalog, empty, and footer states inside a narrow interaction card", () => {
    const picker = new TuiModelPicker(
      [
        {
          providerId: "provider-with-a-long-name",
          modelId: "model-with-a-deliberately-long-name",
          displayName: "A deliberately long Desktop model display name",
        },
      ],
      vi.fn(),
      vi.fn(),
    );
    const empty = new TuiModelPicker([], vi.fn(), vi.fn());

    expect(picker.render(24).every((line) => visibleWidth(line) <= 24)).toBe(
      true,
    );
    expect(empty.render(24).every((line) => visibleWidth(line) <= 24)).toBe(
      true,
    );
  });

  it("keeps provider deletion confirmation inside a narrow interaction card", () => {
    const picker = new TuiModelPicker(
      [
        {
          providerId: "custom_provider:provider-with-a-long-name",
          providerName: "Provider with a deliberately long display name",
          providerSource: "custom_provider",
          providerKind: "custom",
          modelId: "model-a",
          displayName: "Model A",
        },
      ],
      vi.fn(),
      vi.fn(),
      {
        onDeleteProvider: vi.fn(async () => undefined),
        requestRender: vi.fn(),
      },
    );

    picker.handleInput("\x04");

    expect(picker.render(24).every((line) => visibleWidth(line) <= 24)).toBe(
      true,
    );
  });

  it("keeps think effort as a draft until Enter applies it", () => {
    const onSelect = vi.fn();
    const picker = new TuiModelPicker(
      [
        {
          providerId: "custom_provider:byok",
          modelId: "byok-large-5",
          displayName: "byok-large-5",
          selected: true,
          effortOptions: ["low", "medium", "high", "xhigh", "max"],
        },
      ],
      onSelect,
      vi.fn(),
    );

    // Middle level mirrors what Runtime applies without an explicit choice.
    expect(stripAnsi(picker.render(80).join("\n"))).toContain("Think effort");
    expect(stripAnsi(picker.render(80).join("\n"))).toContain("[ high ]");

    picker.handleInput("\u001b[C");

    expect(onSelect).not.toHaveBeenCalled();
    expect(stripAnsi(picker.render(80).join("\n"))).toContain("[ xhigh ]");

    picker.handleInput("\r");

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "byok-large-5" }),
      "xhigh",
    );
  });

  it("starts the selected row from the Session effort and clamps at the ends", () => {
    const onSelect = vi.fn();
    const picker = new TuiModelPicker(
      [
        {
          providerId: "custom_provider:byok",
          modelId: "byok-large-5",
          displayName: "byok-large-5",
          selected: true,
          effortOptions: ["low", "medium", "high"],
        },
      ],
      onSelect,
      vi.fn(),
      {},
      "low",
    );

    expect(stripAnsi(picker.render(80).join("\n"))).toContain("[ low ]");
    picker.handleInput("\u001b[D");
    expect(stripAnsi(picker.render(80).join("\n"))).toContain("[ low ]");

    picker.handleInput("\r");

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "byok-large-5" }),
      "low",
    );
  });

  it("uses effort as the only control when legacy metadata also exposes Thinking", () => {
    const onSelect = vi.fn();
    const picker = new TuiModelPicker(
      [
        {
          providerId: "custom_provider:byok",
          modelId: "byok-large-5",
          displayName: "byok-large-5",
          selected: true,
          variant: "",
          thinkingConfig: { mode: "switchable", defaultValue: "false" },
          effortOptions: ["low", "medium", "high"],
        },
      ],
      onSelect,
      vi.fn(),
    );

    const rendered = stripAnsi(picker.render(90).join("\n"));
    expect(rendered).toContain("←/→ effort");
    expect(rendered).not.toContain("t thinking");
    expect(rendered).not.toContain("Thinking (");
    expect(rendered).not.toContain("[ Off ]");

    picker.handleInput("\u001b[D");
    expect(stripAnsi(picker.render(90).join("\n"))).toContain("[ low ]");

    picker.handleInput("\r");

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "byok-large-5", variant: "" }),
      "low",
    );
  });

  it("applies the configured effort when a thinking-on model is confirmed without touching effort", () => {
    const onSelect = vi.fn();
    const picker = new TuiModelPicker(
      [
        {
          providerId: "minimax",
          modelId: "deep-reasoner-1",
          displayName: "deep-reasoner-1",
          variant: "thinking",
          thinkingConfig: { mode: "switchable", defaultValue: "true" },
          effortOptions: ["xhigh"],
        },
      ],
      onSelect,
      vi.fn(),
    );

    picker.handleInput("\r");

    // Thinking is already on, so the Run must carry the configured level. Sending
    // the model without an effort lets the provider fall back to its own default.
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "deep-reasoner-1" }),
      "xhigh",
    );
  });

  it("applies the configured effort when a forced-on model is confirmed", () => {
    const onSelect = vi.fn();
    const picker = new TuiModelPicker(
      [
        {
          providerId: "minimax",
          modelId: "deep-reasoner-1",
          displayName: "deep-reasoner-1",
          variant: "thinking",
          thinkingConfig: { mode: "forced_on" },
          effortOptions: ["xhigh"],
        },
      ],
      onSelect,
      vi.fn(),
    );

    picker.handleInput("\r");

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "deep-reasoner-1" }),
      "xhigh",
    );
  });

  it("keeps an explicit legacy variant when Enter is pressed without choosing effort", () => {
    const onSelect = vi.fn();
    const picker = new TuiModelPicker(
      [
        {
          providerId: "custom_provider:byok",
          modelId: "byok-large-5",
          displayName: "byok-large-5",
          selected: true,
          variant: "",
          thinkingConfig: { mode: "switchable", defaultValue: "false" },
          effortOptions: ["low", "medium", "high"],
        },
      ],
      onSelect,
      vi.fn(),
    );

    const rendered = stripAnsi(picker.render(90).join("\n"));
    expect(rendered).not.toMatch(/\[\s*(?:low|medium|high)\s*\]/u);

    picker.handleInput("\r");

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: "byok-large-5", variant: "" }),
    );
  });

  it("shows a fixed catalog effort without offering editable levels", () => {
    const onSelect = vi.fn();
    const model = {
      providerId: "minimax",
      modelId: "fixed",
      defaultEffort: "max",
      thinkingConfig: { mode: "forced_on" },
    };
    const picker = new TuiModelPicker([model], onSelect, vi.fn());
    const rendered = stripAnsi(picker.render(100).join("\n"));
    expect(rendered).toContain("Effort max (fixed)");
    expect(rendered).not.toContain("Thinking On");
    expect(rendered).not.toContain("←/→ effort");
    picker.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith(model, "max");
  });

  it("keeps the thinking switch usable alongside a fixed default effort", () => {
    const onSelect = vi.fn();
    const model = {
      providerId: "minimax",
      modelId: "fixed-switchable",
      defaultEffort: "max",
      thinkingConfig: { mode: "switchable", defaultValue: "true" },
    };
    const picker = new TuiModelPicker([model], onSelect, vi.fn());
    expect(stripAnsi(picker.render(100).join("\n"))).toContain(
      "Effort max (fixed)",
    );
    picker.handleInput("\x1b[C");
    expect(stripAnsi(picker.render(100).join("\n"))).not.toContain(
      "Effort max",
    );
    picker.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith({ ...model, variant: "" });

    const offModel = { ...model, variant: "" };
    const enable = new TuiModelPicker([offModel], onSelect, vi.fn());
    enable.handleInput("\x1b[C");
    expect(stripAnsi(enable.render(100).join("\n"))).toContain(
      "Effort max (fixed)",
    );
    enable.handleInput("\r");
    expect(onSelect).toHaveBeenLastCalledWith(
      { ...model, variant: "thinking" },
      "max",
    );
  });

  it("leaves models without effort levels untouched", () => {
    const onSelect = vi.fn();
    const picker = new TuiModelPicker(
      [
        {
          providerId: "minimax",
          modelId: "MiniMax-M3",
          displayName: "MiniMax-M3",
          selected: true,
          variant: "thinking",
          thinkingConfig: { mode: "switchable", defaultValue: "true" },
        },
      ],
      onSelect,
      vi.fn(),
      {},
      "high",
    );

    const rendered = stripAnsi(picker.render(80).join("\n"));
    expect(rendered).not.toContain("Think effort");
    expect(rendered).toContain("←/→ thinking");

    picker.handleInput("\u001b[D");
    picker.handleInput("\r");

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "" }),
    );
  });
});

describe("TuiModelPicker favorites", () => {
  const CTRL_S = "\x13";
  const DOWN = "\x1b[B";
  const catalog = () => [
    { providerId: "minimax", providerName: "MiniMax", modelId: "MiniMax-M3" },
    { providerId: "minimax", providerName: "MiniMax", modelId: "MiniMax-M2.7" },
    {
      providerId: "deepseek",
      providerName: "DeepSeek",
      modelId: "deepseek-v4-pro",
      favorite: true,
      favoriteOrder: 1,
    },
    {
      providerId: "kimi",
      providerName: "Kimi",
      modelId: "kimi-k3",
      favorite: true,
      favoriteOrder: 0,
      selected: true,
    },
  ];
  const lines = (picker: TuiModelPicker) =>
    stripAnsi(picker.render(110).join("\n")).split("\n");
  const indexOf = (rendered: string[], text: string) =>
    rendered.findIndex((line) => line.includes(text));

  it("lists favorites first in added order and keeps a star on their provider rows", () => {
    const onSelect = vi.fn();
    const picker = new TuiModelPicker(catalog(), onSelect, vi.fn(), {
      onToggleFavorite: vi.fn(async () => true),
    });
    const rendered = lines(picker);
    const favorites = indexOf(rendered, "★ Favorites · 2");
    expect(favorites).toBeGreaterThanOrEqual(0);
    expect(favorites).toBeLessThan(indexOf(rendered, "MiniMax · 2"));
    const kimi = indexOf(rendered, "● kimi-k3");
    const deepseek = indexOf(rendered, "deepseek-v4-pro");
    expect(kimi).toBeGreaterThan(favorites);
    expect(deepseek).toBeGreaterThan(kimi);
    expect(rendered.join("\n")).toContain("● ★ kimi-k3");
    expect(rendered.join("\n")).toContain("★ deepseek-v4-pro");
    expect(rendered.join("\n")).toContain("ctrl+s unfavorite");

    // The selected model is focused on its Favorites row and applies as itself.
    const focused = rendered.findIndex((line) => line.includes("› "));
    expect(focused).toBe(kimi);
    expect(focused).toBeLessThan(indexOf(rendered, "MiniMax · 2"));
    picker.handleInput("\r");
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "kimi", modelId: "kimi-k3" }),
    );
  });

  it("appends a new favorite last and unstars from the group without losing focus", async () => {
    const onToggleFavorite = vi.fn(async () => true);
    const onSelect = vi.fn();
    const picker = new TuiModelPicker(catalog(), onSelect, vi.fn(), { onToggleFavorite });

    picker.handleInput("M2.7");
    expect(lines(picker).join("\n")).toContain("ctrl+s favorite");
    picker.handleInput(CTRL_S);
    expect(onToggleFavorite).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelId: "MiniMax-M2.7" }),
      true,
    );
    expect(lines(picker).join("\n")).toContain("Search: M2.7");
    for (let index = 0; index < 4; index += 1) picker.handleInput("\x7f");

    let rendered = lines(picker);
    expect(rendered.join("\n")).toContain("★ Favorites · 3");
    const group = rendered.slice(indexOf(rendered, "★ Favorites · 3"), indexOf(rendered, "MiniMax · 2"));
    expect(group.findIndex((line) => line.includes("MiniMax-M2.7"))).toBeGreaterThan(
      group.findIndex((line) => line.includes("deepseek-v4-pro")),
    );

    // Focus starts on the selected model's Favorites row; move to deepseek and unstar.
    picker.handleInput(DOWN);
    picker.handleInput(CTRL_S);
    await Promise.resolve();
    expect(onToggleFavorite).toHaveBeenLastCalledWith(
      expect.objectContaining({ modelId: "deepseek-v4-pro" }),
      false,
    );
    rendered = lines(picker);
    expect(rendered.join("\n")).toContain("★ Favorites · 2");
    expect(rendered.join("\n")).not.toContain("★ deepseek-v4-pro");
    picker.handleInput("\r");
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerId: "deepseek", modelId: "deepseek-v4-pro" }),
    );
  });

  it("filters the Favorites group with the search query", () => {
    const picker = new TuiModelPicker(catalog(), vi.fn(), vi.fn(), {
      onToggleFavorite: vi.fn(),
    });
    picker.handleInput("deepseek");
    const rendered = lines(picker).join("\n");
    expect(rendered).toContain("★ Favorites · 1");
    expect(rendered).not.toContain("kimi-k3");
  });

  it("rolls back and explains a failed save without throwing", async () => {
    const requestRender = vi.fn();
    const outcomes: Array<() => Promise<boolean>> = [
      async () => false,
      async () => {
        throw new Error("disk full");
      },
    ];
    const onToggleFavorite = vi.fn(() => outcomes.shift()!());
    const picker = new TuiModelPicker(catalog(), vi.fn(), vi.fn(), {
      onToggleFavorite,
      requestRender,
    });

    picker.handleInput(CTRL_S); // unstar kimi → resolves false
    await new Promise((resolve) => setTimeout(resolve, 0));
    let rendered = lines(picker).join("\n");
    expect(rendered).toContain("★ Favorites · 2");
    expect(rendered).toContain("Couldn't update favorites.");

    picker.handleInput("M3");
    picker.handleInput(CTRL_S); // star MiniMax-M3 → rejects
    await new Promise((resolve) => setTimeout(resolve, 0));
    rendered = lines(picker).join("\n");
    expect(rendered).not.toContain("★ MiniMax-M3");
    expect(rendered).toContain("Couldn't update favorites.");
    for (let index = 0; index < 2; index += 1) picker.handleInput("\x7f");
    // The rolled-back unstar keeps kimi first, ahead of deepseek.
    rendered = lines(picker).join("\n");
    expect(rendered.indexOf("kimi-k3")).toBeLessThan(rendered.indexOf("deepseek-v4-pro"));
  });

  it("hides the toggle when favorites are unavailable and keeps ctrl+s out of search", () => {
    const picker = new TuiModelPicker(catalog(), vi.fn(), vi.fn());
    picker.handleInput(CTRL_S);
    const rendered = lines(picker).join("\n");
    expect(rendered).not.toContain("ctrl+s");
    expect(rendered).toContain("★ Favorites · 2");
    expect(rendered).not.toMatch(/Search: \S/u);
  });
});
