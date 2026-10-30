import { describe, expect, it } from "vitest";
import {
  TuiKeybindingRegistry,
  createDefaultTuiKeybindingRegistry,
  createTuiHostKeybindings,
  resolveTuiKeybinding,
  formatTuiKeybinding,
} from "../../src/tui/shell/keybindings.js";
import { MINIMAX_CODE_COMMANDS } from "../../src/tui/commands/catalog.js";

describe("TUI shell keybindings", () => {
  it("maps terminal sequences to semantic shell actions", () => {
    const context = {
      interactionActive: false,
      hasLiveRun: true,
      hasWaitingMessage: true,
    };

    expect(resolveTuiKeybinding("\x16", context)).toBe("paste-image");
    expect(resolveTuiKeybinding("\u001bv", context)).toBe("paste-image");
    expect(resolveTuiKeybinding("\u001b[118;3u", context)).toBe("paste-image");
    expect(resolveTuiKeybinding("\u001b[118;9u", context)).toBe("paste-image");
    expect(resolveTuiKeybinding("\u001b[118;9:3u", context)).toBeUndefined();
    expect(resolveTuiKeybinding("\x07", context)).toBe("open-external-editor");
    expect(resolveTuiKeybinding("\x12", context)).toBe("search-history");
    expect(resolveTuiKeybinding("\x1b\r", context)).toBe("queue-draft");
    expect(resolveTuiKeybinding("\x13", context)).toBeUndefined();
    expect(resolveTuiKeybinding("\r", context)).toBe("submit-guidance");
    expect(resolveTuiKeybinding("\t", context)).toBeUndefined();
    expect(resolveTuiKeybinding("\x18", context)).toBeUndefined();
    expect(resolveTuiKeybinding("\x1b[1;3A", context)).toBe("restore-waiting");
    expect(resolveTuiKeybinding("\x1b[1;2D", context)).toBe("restore-waiting");
    expect(resolveTuiKeybinding("\x1bp", context)).toBe("restore-waiting");
    expect(resolveTuiKeybinding("\x14", context)).toBe("toggle-tasks");
    expect(resolveTuiKeybinding("\u001B[Z", context)).toBe("toggle-plan");
    expect(resolveTuiKeybinding("\u001bm", context)).toBe("cycle-permission");
    expect(resolveTuiKeybinding("\u001B[5~", context)).toBeUndefined();
    expect(resolveTuiKeybinding("\u001B[6~", context)).toBeUndefined();
    expect(resolveTuiKeybinding("\u001B[F", context)).toBeUndefined();
    expect(resolveTuiKeybinding("\x0f", context)).toBe("toggle-details");
    expect(resolveTuiKeybinding("\x03", context)).toBe("clear");
    expect(resolveTuiKeybinding("\u001B", context)).toBe("interrupt");
    expect(resolveTuiKeybinding("\x04", context)).toBe("exit");
    expect(resolveTuiKeybinding("\x1a", context)).toBe("suspend");
    expect(resolveTuiKeybinding("\x15", context)).toBeUndefined();
    expect(resolveTuiKeybinding("\u001B[99;5:3u", context)).toBeUndefined();
  });

  it("toggles the side conversation on Ctrl+/ across CSI-u, modifyOtherKeys and Dvorak reports", () => {
    const context = { interactionActive: false, hasLiveRun: true };

    expect(resolveTuiKeybinding("\u001B[47;5u", context)).toBe(
      "toggle-side-session",
    );
    expect(resolveTuiKeybinding("\u001B[27;5;47~", context)).toBe(
      "toggle-side-session",
    );
    expect(resolveTuiKeybinding("\u001B[47::91;5u", context)).toBe(
      "toggle-side-session",
    );
    // Legacy terminals (Terminal.app, iTerm without kitty protocol) report
    // Ctrl+/ as the bare 0x1F control byte, identical to Ctrl+_.
    expect(resolveTuiKeybinding("\x1f", context)).toBe("toggle-side-session");
    // Application scope: the toggle stays reachable while an interaction is active.
    expect(
      resolveTuiKeybinding("\u001B[47;5u", {
        interactionActive: true,
        hasLiveRun: false,
      }),
    ).toBe("toggle-side-session");
    expect(formatTuiKeybinding("app.toggle-side-session")).toContain("/");
  });

  it("reserves Ctrl+U for launch handoff only while the shell is idle", () => {
    expect(
      resolveTuiKeybinding("\x15", {
        interactionActive: false,
        hasLiveRun: false,
      }),
    ).toBe("resume-codex");
    expect(
      resolveTuiKeybinding("\x15", {
        interactionActive: false,
        hasLiveRun: true,
      }),
    ).toBeUndefined();
    expect(
      resolveTuiKeybinding("\x15", {
        interactionActive: true,
        hasLiveRun: false,
      }),
    ).toBeUndefined();
  });

  it("reserves product shortcuts for the composer while keeping application shortcuts global", () => {
    expect(
      resolveTuiKeybinding("\x16", {
        interactionActive: true,
        hasLiveRun: true,
      }),
    ).toBeUndefined();
    expect(
      resolveTuiKeybinding("\x07", {
        interactionActive: true,
        hasLiveRun: true,
      }),
    ).toBeUndefined();
    expect(
      resolveTuiKeybinding("\x1b[1;3A", {
        interactionActive: false,
        hasLiveRun: true,
        hasWaitingMessage: true,
      }),
    ).toBe("restore-waiting");
    expect(
      resolveTuiKeybinding("\x1bp", {
        interactionActive: false,
        hasLiveRun: true,
        hasWaitingMessage: true,
      }),
    ).toBe("restore-waiting");
    expect(
      resolveTuiKeybinding("\x03", {
        interactionActive: true,
        hasLiveRun: false,
      }),
    ).toBeUndefined();
    expect(
      resolveTuiKeybinding("\u001B", {
        interactionActive: true,
        hasLiveRun: true,
      }),
    ).toBeUndefined();
    expect(
      resolveTuiKeybinding("\x1a", {
        interactionActive: true,
        hasLiveRun: true,
      }),
    ).toBe("suspend");
    expect(
      resolveTuiKeybinding("\u001B[5~", {
        interactionActive: true,
        hasLiveRun: false,
      }),
    ).toBe("scroll-up");
    expect(
      resolveTuiKeybinding("\u001B[6~", {
        interactionActive: true,
        hasLiveRun: false,
      }),
    ).toBe("scroll-down");
  });

  it("rejects ambiguous bindings in the same context instead of relying on array order", () => {
    const registry = new TuiKeybindingRegistry();
    registry.register({
      id: "composer.paste",
      key: "ctrl+v",
      action: "paste-image",
      when: "composer",
    });

    expect(() =>
      registry.register({
        id: "composer.tasks",
        key: "ctrl+v",
        action: "toggle-tasks",
        when: "composer",
      }),
    ).toThrow(
      "Keybinding conflict: ctrl+v is already registered for composer.paste",
    );
  });

  it("treats application bindings as overlapping every focused surface", () => {
    const registry = new TuiKeybindingRegistry();
    registry.register({
      id: "app.search",
      key: "ctrl+r",
      action: "search-history",
      when: "application",
    });

    expect(() =>
      registry.register({
        id: "interaction.search",
        key: "ctrl+r",
        action: "search-history",
        when: "interaction",
      }),
    ).toThrow(
      "Keybinding conflict: ctrl+r is already registered for app.search",
    );
  });

  it("allows the same key to have different meanings in disjoint interaction contexts", () => {
    const registry = new TuiKeybindingRegistry();
    registry.register({
      id: "idle.search",
      key: "ctrl+r",
      action: "search-history",
      when: "idle",
    });
    registry.register({
      id: "running.tasks",
      key: "ctrl+r",
      action: "toggle-tasks",
      when: "live-run",
    });

    expect(
      registry.resolve("\x12", { interactionActive: false, hasLiveRun: false }),
    ).toBe("search-history");
    expect(
      registry.resolve("\x12", { interactionActive: false, hasLiveRun: true }),
    ).toBe("toggle-tasks");
  });

  it("applies validated user overrides without mutating the default registry", () => {
    const defaults = createDefaultTuiKeybindingRegistry();
    const overridden = defaults.withOverrides({
      "composer.toggle-tasks": "ctrl+k",
    });
    const context = { interactionActive: false, hasLiveRun: true };

    expect(overridden.resolve("\x0b", context)).toBe("toggle-tasks");
    expect(overridden.resolve("\x14", context)).toBeUndefined();
    expect(defaults.resolve("\x14", context)).toBe("toggle-tasks");
    expect(() =>
      defaults.withOverrides({ "composer.missing": "ctrl+k" }),
    ).toThrow("Unknown keybinding id: composer.missing");
    expect(formatTuiKeybinding("composer.toggle-tasks", overridden)).toBe(
      "Ctrl+K",
    );
    expect(
      overridden
        .help()
        .find((binding) => binding.id === "composer.toggle-tasks")?.description,
    ).toContain("Todo list");
  });

  it("binds Ctrl+O to the full Plan view only while an interaction is active", () => {
    const registry = createDefaultTuiKeybindingRegistry();

    expect(registry.resolve("\x0f", { interactionActive: true, hasLiveRun: false })).toBe(
      "view-plan",
    );
    expect(registry.resolve("\x0f", { interactionActive: false, hasLiveRun: false })).toBe(
      "toggle-details",
    );
    expect(registry.findConflicts({})).toEqual([]);
    expect(registry.helpRows()).toContainEqual({
      ids: ["interaction.view-plan"],
      keys: formatTuiKeybinding("interaction.view-plan", registry),
      description: "Show or hide the full Plan during Plan Review",
    });
  });

  it("derives compact Help rows from the same registry definitions", () => {
    const registry = createDefaultTuiKeybindingRegistry();
    const rows = registry.helpRows();

    expect(rows).toContainEqual({
      ids: ["composer.search-history", "composer.external-editor"],
      keys: `${formatTuiKeybinding("composer.search-history", registry)} / ${formatTuiKeybinding("composer.external-editor", registry)}`,
      description: "Search prompt history / edit in an external editor",
    });
    expect(
      rows.find((row) => row.ids.includes("interaction.scroll-up"))?.ids,
    ).toEqual(["interaction.scroll-up", "interaction.scroll-down"]);
    expect(
      MINIMAX_CODE_COMMANDS.find((command) => command.name === "transcript")
        ?.shortcut,
    ).toBeUndefined();
    expect(rows).toContainEqual({
      ids: ["composer.toggle-tasks"],
      keys: formatTuiKeybinding("composer.toggle-tasks", registry),
      description: "Show or hide the full Todo list",
    });
    expect(rows).toContainEqual({
      ids: ["composer.toggle-details"],
      keys: formatTuiKeybinding("composer.toggle-details", registry),
      description: "Show or hide Thinking, Tool output, and diffs",
    });
    expect(rows).toContainEqual({
      ids: ["run.restore-waiting-option", "run.restore-waiting-shift-left"],
      keys: `${formatTuiKeybinding("run.restore-waiting-option", registry)} / ${formatTuiKeybinding("run.restore-waiting-shift-left", registry)}`,
      description: "Move the latest queued message back to the Composer",
    });
  });

  it("advertises only shortcuts supported by the current host", () => {
    const windows = createTuiHostKeybindings({
      platform: "win32",
      suspendSupported: false,
    }).registry;
    const windowsRows = windows.helpRows();
    const paste = windowsRows.find((row) =>
      row.ids.includes("composer.paste-image"),
    );

    expect(windows.get("app.suspend")).toBeUndefined();
    expect(windows.get("composer.paste-image-macos")).toBeUndefined();
    expect(paste).toMatchObject({
      ids: ["composer.paste-image", "composer.paste-image-windows"],
      keys: "Alt+V / Ctrl+V",
    });
    expect(windows.get("composer.restore-draft")?.key).toBe("ctrl+z");

    const linux = createTuiHostKeybindings({
      platform: "linux",
      suspendSupported: true,
    }).registry;
    expect(linux.get("app.suspend")).toBeDefined();
    expect(linux.get("composer.paste-image-windows")).toBeUndefined();
    expect(linux.get("composer.paste-image-macos")).toBeUndefined();

    const wsl = createTuiHostKeybindings({
      platform: "linux",
      suspendSupported: true,
      windowsClipboardInterop: true,
    }).registry;
    expect(
      wsl.helpRows().find((row) => row.ids.includes("composer.paste-image")),
    ).toMatchObject({
      ids: ["composer.paste-image", "composer.paste-image-windows"],
      keys: "Alt+V / Ctrl+V",
    });
    expect(wsl.get("app.suspend")).toBeDefined();
    expect(wsl.get("composer.restore-draft")?.key).toBe("ctrl+-");

    const macos = createTuiHostKeybindings({
      platform: "darwin",
      suspendSupported: true,
    }).registry;
    expect(
      macos.helpRows().find((row) => row.ids.includes("composer.paste-image")),
    ).toMatchObject({
      ids: ["composer.paste-image", "composer.paste-image-macos"],
      keys: "Ctrl+V / Command+V",
    });
    expect(
      macos
        .helpRows()
        .find((row) => row.ids.includes("run.restore-waiting-option")),
    ).toMatchObject({
      keys: "Option+Up / Shift+Left",
    });
  });

  it("uses Windows Terminal-safe Editor and semantic prompt aliases without changing other hosts", () => {
    const windows = createTuiHostKeybindings({
      platform: "win32",
      suspendSupported: false,
    }).manager;
    const linux = createTuiHostKeybindings({
      platform: "linux",
      suspendSupported: true,
    }).manager;

    expect(windows.getKeys("tui.editor.undo")).toEqual(["ctrl+-", "ctrl+z"]);
    expect(windows.getKeys("tui.altScreen.previousPrompt")).toEqual([
      "ctrl+shift+up",
      "ctrl+up",
    ]);
    expect(windows.getKeys("tui.altScreen.nextPrompt")).toEqual([
      "ctrl+shift+down",
      "ctrl+down",
    ]);
    expect(windows.matches("\x1a", "tui.editor.undo")).toBe(true);
    expect(linux.getKeys("tui.editor.undo")).toEqual(["ctrl+-"]);
    expect(linux.getKeys("tui.altScreen.previousPrompt")).toEqual([
      "ctrl+shift+up",
      "ctrl+up",
    ]);
    expect(linux.getKeys("tui.altScreen.nextPrompt")).toEqual([
      "ctrl+shift+down",
      "ctrl+down",
    ]);
    expect(linux.matches("\x1a", "tui.editor.undo")).toBe(false);
  });

  it("shares one resolved keybinding manager between Engine widgets and product routing", () => {
    const keybindings = createTuiHostKeybindings({
      platform: "linux",
      suspendSupported: true,
    });
    keybindings.manager.setUserBindings({
      ...keybindings.manager.getUserBindings(),
      "composer.toggle-tasks": "ctrl+q",
    });

    expect(
      keybindings.registry.resolve("\x11", {
        interactionActive: false,
        hasLiveRun: true,
      }),
    ).toBe("toggle-tasks");
    expect(
      keybindings.registry.resolve("\x14", {
        interactionActive: false,
        hasLiveRun: true,
      }),
    ).toBeUndefined();
    expect(keybindings.registry.get("composer.toggle-tasks")?.key).toBe(
      "ctrl+q",
    );

    keybindings.manager.setUserBindings({ "composer.toggle-tasks": [] });
    expect(
      formatTuiKeybinding("composer.toggle-tasks", keybindings.registry),
    ).toBe("Unbound");
    for (const data of ["\x11", "\x14"]) {
      expect(
        keybindings.registry.resolve(data, {
          interactionActive: false,
          hasLiveRun: true,
        }),
      ).toBeUndefined();
    }

    keybindings.manager.setUserBindings({});
    expect(
      keybindings.registry.resolve("\x14", {
        interactionActive: false,
        hasLiveRun: true,
      }),
    ).toBe("toggle-tasks");
  });

  it("checks reload candidates against host defaults instead of stale user bindings", () => {
    const keybindings = createTuiHostKeybindings({
      platform: "linux",
      suspendSupported: true,
      userOverrides: { "composer.toggle-details": "ctrl+k" },
    });

    expect(
      keybindings.registry.findConflicts({ "composer.toggle-plan": "ctrl+k" }),
    ).toEqual([]);
    expect(
      keybindings.registry.findConflicts({
        "composer.toggle-details": "ctrl+k",
        "composer.toggle-plan": "ctrl+k",
      }),
    ).toHaveLength(1);
    expect(keybindings.registry.findConflicts({})).toEqual([]);
  });
});
