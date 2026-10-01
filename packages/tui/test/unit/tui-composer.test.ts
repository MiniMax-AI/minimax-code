import type { Component } from "../../src/tui/rendering/component.js";
import { stripAnsi, visibleWidth } from "../../src/tui/rendering/text.js";
import { describe, expect, it } from "vitest";
import {
  TuiComposer,
  resolveTuiComposerBorderColor,
  resolveTuiComposerColor,
  type TuiComposerState,
} from "../../src/tui/shell/composer.js";
import type { TuiComposerInputIntent } from "../../src/tui/commands/input-intent.js";
import { tuiColors, tuiEditorTheme } from "../../src/tui/theme/runtime.js";
import { Editor } from "../../src/tui/widgets/editor/editor.js";
import { formatTuiShortcut } from "../../src/tui/shell/shortcut-labels.js";
import { buildTuiTips } from "../../src/tui/shell/tips.js";
import {
  createDefaultTuiKeybindingRegistry,
  createTuiHostKeybindings,
} from "../../src/tui/shell/keybindings.js";

function editor(lines: string[]): Component {
  return {
    render: () => lines,
    invalidate: () => undefined,
  };
}

describe("TuiComposer", () => {
  const queueShortcut = formatTuiShortcut("alt+enter");

  it("uses warning emphasis for a missing side conversation while preserving the draft", () => {
    const state: TuiComposerState = {
      mode: "message",
      surface: "conversation",
      hint: "No side conversation is open. Run /btw first; this shortcut only switches conversations.",
      hintTone: "warning",
    };
    const composer = new TuiComposer(editor(["draft"]), state);
    expect(resolveTuiComposerColor(state)).toBe(tuiColors.warning);
    const rendered = stripAnsi(composer.render(80).join("\n"));
    expect(rendered).toContain("No side conversation is open. Run /btw first;");
    expect(rendered).toContain("draft");
  });

  it("turns the editor into a clear primary input with truthful key hints", () => {
    const composer = new TuiComposer(editor(["──────", "draft", "──────"]), {
      mode: "message",
      surface: "conversation",
    });

    const lines = composer.render(64);
    const rendered = lines.join("\n");

    expect(rendered).toContain("Message");
    expect(rendered).toContain("Enter send");
    expect(rendered).toContain("Ctrl+J newline");
    expect(rendered).not.toContain("Shift+Enter");
    expect(rendered).not.toContain("Shift+Tab");
    expect(rendered).toContain("› draft");
    expect(lines.filter((line) => line.includes("─"))).toHaveLength(2);
    expect(
      lines.some((line) => line.includes("Message") && line.includes("─")),
    ).toBe(false);
  });

  it("renders the side-mode placeholder inside an empty editor and a stable context label below it", () => {
    const input = new Editor(
      { terminal: { rows: 24 }, requestRender: () => undefined },
      tuiEditorTheme,
    );
    const composer = new TuiComposer(input, {
      mode: "message",
      surface: "conversation",
      draftCharacterCount: 0,
      placeholder: "Ask a side question…",
      contextLabel: "Side from main session · Ctrl+/ to main · Ctrl+C to close",
    });

    const rendered = composer.render(80).map(stripAnsi).join("\n");

    expect(rendered).toContain("Ask a side question…");
    expect(rendered).toContain(
      "Side from main session · Ctrl+/ to main · Ctrl+C to close",
    );
  });

  it("hides the placeholder as soon as the draft has content", () => {
    const input = new Editor(
      { terminal: { rows: 24 }, requestRender: () => undefined },
      tuiEditorTheme,
    );
    input.setText("draft");
    const composer = new TuiComposer(input, {
      mode: "message",
      surface: "conversation",
      draftCharacterCount: 5,
      placeholder: "Ask a side question…",
    });

    const rendered = composer.render(80).map(stripAnsi).join("\n");

    expect(rendered).not.toContain("Ask a side question…");
    expect(rendered).toContain("› draft");
  });

  it.each([
    {
      input: "Explain this repository",
      intent: { kind: "prompt" },
      header: "Prompt · Enter send · Ctrl+J newline",
      color: tuiColors.signal,
    },
    {
      input: "!pwd",
      intent: { kind: "bash" },
      header: "Shell · Enter run",
      color: tuiColors.warning,
    },
    {
      input: "/context",
      intent: { kind: "command", token: "/context" },
      header: "Command · Enter run",
      color: tuiColors.accent,
    },
    {
      input: "/compact preserve evidence",
      intent: { kind: "command-arguments", token: "/compact" },
      header: "Command · arguments · Enter run",
      color: tuiColors.accent,
    },
    {
      input: "/docs",
      intent: { kind: "skill", token: "/docs" },
      header: "Skill · Enter invoke",
      color: tuiColors.orbit,
    },
    {
      input: "/docs summarize this repository",
      intent: { kind: "skill-instructions", token: "/docs" },
      header: "Skill · instructions · Enter invoke",
      color: tuiColors.orbit,
    },
  ] satisfies Array<{
    input: string;
    intent: TuiComposerInputIntent;
    header: string;
    color: string;
  }>)(
    "shows $intent.kind intent without changing the submitted text",
    ({ input, intent, header, color }) => {
      const state: TuiComposerState = {
        mode: "message",
        surface: "conversation",
        draftCharacterCount: input.length,
        inputIntent: intent,
      };
      const composer = new TuiComposer(
        editor(["────────", ` ${input} `, "────────"]),
        state,
      );
      const rendered = composer.render(80);

      expect(stripAnsi(rendered[0] ?? "").trim()).toBe(header);
      expect(stripAnsi(rendered.join("\n"))).toContain(input);
      expect(resolveTuiComposerColor(state)).toBe(color);
      expect(resolveTuiComposerBorderColor(state)).toBe(color);
    },
  );

  it("keeps empty Composer chrome neutral until the input has a resolved intent", () => {
    const state: TuiComposerState = {
      mode: "message",
      surface: "conversation",
      inputIntent: { kind: "empty" },
    };
    const composer = new TuiComposer(
      editor(["────────", " ", "────────"]),
      state,
      {
        showTips: false,
      },
    );

    expect(stripAnsi(composer.render(80)[0] ?? "").trim()).toBe(
      "Message · Enter send · Ctrl+J newline",
    );
    expect(resolveTuiComposerBorderColor(state)).toBe(tuiColors.line);
  });

  it.each([
    [{ kind: "prompt" }, `Prompt · Enter steer · ${queueShortcut} queue`],
    [{ kind: "command", token: "/context" }, "Command · Enter run"],
    [
      { kind: "skill-instructions", token: "/docs" },
      `Skill · instructions · Enter steer · ${queueShortcut} queue`,
    ],
  ] satisfies Array<[TuiComposerInputIntent, string]>)(
    "keeps intent-specific Enter guidance accurate while a Turn is active",
    (inputIntent, expected) => {
      const composer = new TuiComposer(
        editor(["────────", " /context ", "────────"]),
        {
          mode: "follow-up",
          surface: "conversation",
          inputIntent,
        },
      );

      expect(stripAnsi(composer.render(80).join("\n"))).toContain(expected);
    },
  );

  it("preserves intent borders, prefix, and token hierarchy while the Editor is scrolled", () => {
    const composer = new TuiComposer(
      editor(["─── ↑ 2 more ─────", " /docs summarize ", "─── ↓ 1 more ─────"]),
      {
        mode: "message",
        surface: "conversation",
        inputIntent: { kind: "skill-instructions", token: "/docs" },
      },
    );
    const rendered = composer.render(80).slice(1).map(stripAnsi);

    expect(rendered[0]).toMatch(/^ {2}─── ↑ 2 more/u);
    expect(rendered[1]).toContain("›  /docs summarize");
    expect(rendered[2]).toMatch(/^ {2}─── ↓ 1 more/u);
  });

  it("keeps permission controls out of the idle input header", () => {
    const composer = new TuiComposer(editor(["──────", "", "──────"]), {
      mode: "message",
      surface: "conversation",
    });

    const header = stripAnsi(composer.render(80)[0] ?? "");

    expect(header.trimStart()).toMatch(
      /^Message · Enter send · Ctrl\+J newline/u,
    );
    expect(header).not.toContain("Shift+Tab");
    expect(visibleWidth(header)).toBeLessThanOrEqual(80);
  });

  it("uses spare idle header width for a right-aligned Tip", () => {
    const tip = buildTuiTips()[0];
    const composer = new TuiComposer(
      editor(["──────", "", "──────"]),
      {
        mode: "message",
        surface: "conversation",
        draftCharacterCount: 0,
      },
      { now: () => 0, tips: tip ? [tip] : [] },
    );

    const header = stripAnsi(composer.render(120)[0] ?? "");

    expect(header).toContain("Message · Enter send · Ctrl+J newline");
    expect(
      header
        .trimEnd()
        .endsWith("Tip: /goal keeps multi-step work focused on a finish line"),
    ).toBe(true);
    expect(visibleWidth(header)).toBe(120);

    const compactHeader = stripAnsi(composer.render(80)[0] ?? "");
    expect(compactHeader).toContain("Tip: /goal tracks multi-step work");
    expect(compactHeader).not.toContain("focused on a finish line");

    expect(stripAnsi(composer.render(64)[0] ?? "")).not.toContain("Tip:");
  });

  it("keeps the idle header stable when Tips are disabled", () => {
    const tip = buildTuiTips()[0];
    const composer = new TuiComposer(
      editor(["──────", "", "──────"]),
      {
        mode: "message",
        surface: "conversation",
        draftCharacterCount: 0,
        contextualTip: {
          id: "codex-handoff",
          command: "resume-codex",
          text: "Tip: Ctrl+U resumes your recent Codex session",
          shortText: "Tip: Ctrl+U resumes Codex",
        },
      },
      { showTips: false, now: () => 0, tips: tip ? [tip] : [] },
    );

    const header = stripAnsi(composer.render(120)[0] ?? "");

    expect(header.trim()).toBe("Message · Enter send · Ctrl+J newline");
  });

  it("rotates a contextual Welcome Tip with ordinary Tips instead of replacing the main hint", () => {
    const ordinaryTip = buildTuiTips()[0];
    const contextualTip = {
      id: "codex-handoff",
      command: "resume-codex",
      text: "Tip: Ctrl+U resumes your recent Codex session",
      shortText: "Tip: Ctrl+U resumes Codex",
    };
    const composer = new TuiComposer(
      editor(["──────", "", "──────"]),
      {
        mode: "message",
        surface: "welcome",
        draftCharacterCount: 0,
        contextualTip,
      },
      { now: () => 0, tips: ordinaryTip ? [ordinaryTip] : [] },
    );

    const firstHeader = stripAnsi(composer.render(120)[0] ?? "");
    expect(firstHeader).toContain("Start · @ file or Plugin · / autocomplete");
    expect(firstHeader).toContain(
      "Tip: /goal keeps multi-step work focused on a finish line",
    );
    expect(firstHeader).not.toContain("Ctrl+U resumes");

    const nextComposer = new TuiComposer(
      editor(["──────", "", "──────"]),
      {
        mode: "message",
        surface: "welcome",
        draftCharacterCount: 0,
        contextualTip,
      },
      { now: () => 30_000, tips: ordinaryTip ? [ordinaryTip] : [] },
    );
    const nextHeader = stripAnsi(nextComposer.render(120)[0] ?? "");
    expect(nextHeader).toContain("Start · @ file or Plugin · / autocomplete");
    expect(nextHeader).toContain(
      "Tip: Ctrl+U resumes your recent Codex session",
    );
  });

  it.each([
    {
      name: "Welcome",
      state: { mode: "message", surface: "welcome", draftCharacterCount: 0 },
    },
    {
      name: "a non-empty Draft",
      state: {
        mode: "message",
        surface: "conversation",
        draftCharacterCount: 1,
      },
    },
    {
      name: "an attachment",
      state: { mode: "message", surface: "conversation", attachmentCount: 1 },
    },
    {
      name: "Follow-up mode",
      state: {
        mode: "follow-up",
        surface: "conversation",
        draftCharacterCount: 0,
      },
    },
    {
      name: "a transient hint",
      state: {
        mode: "message",
        surface: "conversation",
        draftCharacterCount: 0,
        hint: "Press Ctrl+C again to exit",
      },
    },
  ] satisfies Array<{ name: string; state: TuiComposerState }>)(
    "yields to $name",
    ({ state }) => {
      const composer = new TuiComposer(
        editor(["──────", "", "──────"]),
        state,
        { now: () => 0 },
      );

      expect(stripAnsi(composer.render(120)[0] ?? "")).not.toContain("Tip:");
    },
  );

  it("updates input hints from live bindings while preserving terminal-specific defaults", () => {
    const { registry, manager, hostOverrides } = createTuiHostKeybindings({
      platform: "linux",
      suspendSupported: true,
    });
    let supportsShiftEnter = false;
    const composer = new TuiComposer(
      editor(["──────", "", "──────"]),
      {
        mode: "message",
        surface: "conversation",
      },
      {
        supportsShiftEnter: () => supportsShiftEnter,
        keybindings: registry,
        showTips: false,
      },
    );

    expect(stripAnsi(composer.render(80)[0] ?? "")).toContain("Ctrl+J newline");

    supportsShiftEnter = true;
    const header = stripAnsi(composer.render(80)[0] ?? "");
    expect(header).toContain("Shift+Enter newline");
    expect(header).not.toContain("Ctrl+J");

    manager.setUserBindings({
      ...hostOverrides,
      "tui.input.submit": ["ctrl+s", "ctrl+q"],
      "tui.input.newLine": ["ctrl+n", "ctrl+j"],
    });
    for (const enhanced of [false, true]) {
      supportsShiftEnter = enhanced;
      expect(stripAnsi(composer.render(100)[0] ?? "").trim()).toBe(
        "Message · Ctrl+S / Ctrl+Q send · Ctrl+N / Ctrl+J newline",
      );
    }

    manager.setUserBindings({
      ...hostOverrides,
      "tui.input.submit": [],
      "tui.input.newLine": [],
    });
    expect(stripAnsi(composer.render(80)[0] ?? "").trim()).toBe(
      "Message · Unbound send · Unbound newline",
    );

    manager.setUserBindings(hostOverrides);
    expect(stripAnsi(composer.render(80)[0] ?? "").trim()).toBe(
      "Message · Enter send · Shift+Enter newline",
    );
  });

  it("uses the idle header for a short actionable hint instead of the status rail", () => {
    const composer = new TuiComposer(editor(["──────", "", "──────"]), {
      mode: "message",
      surface: "conversation",
      hint: "Press Ctrl+C again to exit",
    });

    const rendered = composer.render(64).join("\n");
    expect(rendered).toContain("Press Ctrl+C again to exit");
    expect(rendered).not.toContain("Message · Enter send");
  });

  it.each([
    [{ mode: "working", surface: "conversation" }, "Working"],
    [
      { mode: "follow-up", surface: "conversation" },
      `Message · Enter steer · ${queueShortcut} queue`,
    ],
    [
      { mode: "blocked", surface: "conversation" },
      "Reply required · choose an action",
    ],
    [
      { mode: "message", surface: "welcome" },
      "Start · @ file or Plugin · / autocomplete",
    ],
  ] satisfies Array<[TuiComposerState, string]>)(
    "explains the %s submission mode before the user presses Enter",
    (state, expected) => {
      const composer = new TuiComposer(editor(["──────", "", "──────"]), state);

      expect(composer.render(64).join("\n")).toContain(expected);
    },
  );

  it("keeps the editor and mode label inside a narrow terminal", () => {
    const composer = new TuiComposer(
      editor([
        "──────────────────────",
        "a deliberately long draft",
        "──────────────────────",
      ]),
      {
        mode: "follow-up",
        surface: "conversation",
      },
    );

    expect(composer.render(24).every((line) => visibleWidth(line) <= 24)).toBe(
      true,
    );
    expect(composer.render(24).join("\n")).toContain(`${queueShortcut} queue`);
    expect(composer.render(24).join("\n")).not.toContain("Follow-up");
    expect(composer.render(24).join("\n")).not.toContain("Shift+Tab");
  });

  it.each([
    [80, `Message · Enter steer · ${queueShortcut} queue`],
    [40, `Enter steer · ${queueShortcut} queue`],
    [28, `${queueShortcut} queue`],
    [18, process.platform === "darwin" ? "Message" : `${queueShortcut} queue`],
    [16, "Message"],
  ] as const)(
    "keeps the most useful follow-up actions at %s columns",
    (width, expected) => {
      const composer = new TuiComposer(editor(["──────", "", "──────"]), {
        mode: "follow-up",
        surface: "conversation",
      });

      const rendered = composer.render(width).join("\n");
      expect(rendered).toContain(expected);
      expect(
        rendered.split("\n").every((line) => visibleWidth(line) <= width),
      ).toBe(true);
    },
  );

  it("retains configured queue hints for narrow prompts and skills without relabeling commands", () => {
    const keybindings = createDefaultTuiKeybindingRegistry().withOverrides({
      "run.queue-draft": "ctrl+q",
    });
    for (const inputIntent of [
      { kind: "prompt" },
      { kind: "skill", token: "/docs" },
    ] satisfies TuiComposerInputIntent[]) {
      const composer = new TuiComposer(
        editor(["────", "draft", "────"]),
        {
          mode: "follow-up",
          surface: "conversation",
          inputIntent,
          attachmentCount: 2,
        },
        { keybindings },
      );
      expect(stripAnsi(composer.render(24).join("\n"))).toContain(
        "Ctrl+Q queue",
      );
    }
    const command = new TuiComposer(
      editor(["────", "/context", "────"]),
      {
        mode: "follow-up",
        surface: "conversation",
        inputIntent: { kind: "command", token: "/context" },
      },
      { keybindings },
    );
    expect(stripAnsi(command.render(24).join("\n"))).toContain("Enter run");
    expect(stripAnsi(command.render(24).join("\n"))).not.toContain("queue");
  });

  it("explains Enter steering and Tab queueing without duplicating interrupt controls", () => {
    const composer = new TuiComposer(editor(["──────", "", "──────"]), {
      mode: "follow-up",
      surface: "conversation",
    });

    const rendered = composer.render(80).join("\n");
    expect(rendered).not.toContain("interrupt");
    expect(rendered).toContain("Enter steer");
    expect(rendered).toContain(`${queueShortcut} queue`);
  });

  it("explains steering and queueing when a running Draft has attachments", () => {
    const composer = new TuiComposer(editor(["──────", "", "──────"]), {
      mode: "follow-up",
      surface: "conversation",
      attachmentCount: 1,
    });

    const rendered = composer.render(80).join("\n");
    expect(rendered).toContain(
      `1 attachment · Enter steer · ${queueShortcut} queue`,
    );
  });

  it("keeps only the attachment count in the header because images live inline in the editor", () => {
    const composer = new TuiComposer(editor(["──────", "", "──────"]), {
      mode: "message",
      surface: "conversation",
      attachmentCount: 2,
    });

    const rendered = composer.render(64).join("\n");
    expect(rendered).toContain("2 attachments · Enter send");
    expect(rendered).not.toContain("image-123.png");
    expect(rendered).not.toContain("Delete remove");
    expect(rendered).toContain("› ");
    expect(
      rendered
        .split("\n")
        .some((line) => line.includes("2 attachments") && line.includes("─")),
    ).toBe(false);
  });

  it("keeps the inline-attachment header inside a narrow terminal", () => {
    const composer = new TuiComposer(editor(["──────", "", "──────"]), {
      mode: "message",
      surface: "conversation",
      attachmentCount: 5,
    });

    const rendered = composer.render(32);
    expect(rendered.every((line) => visibleWidth(line) <= 32)).toBe(true);
    expect(rendered.join("\n")).toContain("5 attachments");
  });

  it("renders the external-editor hint from the active host keybinding registry", () => {
    const keybindings = createDefaultTuiKeybindingRegistry().withOverrides({
      "composer.external-editor": "ctrl+y",
    });
    const composer = new TuiComposer(
      editor(["──────", "draft", "──────"]),
      {
        mode: "message",
        surface: "conversation",
        draftCharacterCount: 1_001,
      },
      { keybindings },
    );

    expect(stripAnsi(composer.render(80)[0] ?? "")).toContain("Ctrl+Y edit");
  });

  it("uses blue for Ask User and follow-ups, reserving gold for permission confirmation", () => {
    expect(
      resolveTuiComposerColor({
        mode: "blocked",
        surface: "conversation",
        attention: "question",
      }),
    ).toBe(tuiColors.signal);
    expect(
      resolveTuiComposerColor({
        mode: "follow-up",
        surface: "conversation",
      }),
    ).toBe(tuiColors.signal);
    expect(
      resolveTuiComposerColor({
        mode: "blocked",
        surface: "conversation",
        attention: "permission",
      }),
    ).toBe(tuiColors.warning);
  });

  it("uses the danger color for a stopping-response hint", () => {
    expect(
      resolveTuiComposerColor({
        mode: "follow-up",
        surface: "conversation",
        hint: "Stopping · draft preserved",
        hintTone: "danger",
      }),
    ).toBe(tuiColors.error);
  });
});
