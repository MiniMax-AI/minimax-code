import { afterEach, describe, expect, it, vi } from "vitest";
import { McodeInteractiveRenderer } from "../../src/tui/renderer/interactive-renderer.js";
import { TuiComposer } from "../../src/tui/shell/composer.js";
import { Editor } from "../../src/tui/widgets/editor/editor.js";
import { type Component } from "../../src/tui/engine/public.js";
import { VirtualTerminal } from "../pi-084-upstream/virtual-terminal.js";

const platformDescriptor = Object.getOwnPropertyDescriptor(
  process,
  "platform",
)!;
const identity = (text: string) => text;
const theme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

class RecordingTerminal extends VirtualTerminal {
  writes: string[] = [];
  override write(data: string): void {
    this.writes.push(data);
    super.write(data);
  }
  override hideCursor(): void {
    this.write("\x1b[?25l");
  }
  override showCursor(): void {
    this.write("\x1b[?25h");
  }
}

function setup(
  mode: "regular" | "fullscreen",
  showHardwareCursor?: boolean,
  columns = 40,
) {
  const terminal = new RecordingTerminal(columns, 16);
  const renderer = new McodeInteractiveRenderer({
    terminal,
    initialMode: mode,
    showHardwareCursor,
  });
  const editor = new Editor(renderer.ui, theme, { paddingX: 1 });
  const composer = new TuiComposer(
    editor,
    {
      mode: "message",
      surface: "conversation",
      placeholder: "Ask a side question…",
    },
    { showTips: false },
  );
  const trailing: Component & { lines: string[] } = {
    lines: ["status", "extra"],
    render() {
      return this.lines;
    },
    invalidate() {},
  };
  renderer.ui.addChild(composer);
  renderer.ui.addChild(trailing);
  renderer.ui.setFocus(editor);
  return { terminal, renderer, editor, trailing };
}

afterEach(() => {
  Object.defineProperty(process, "platform", platformDescriptor);
  vi.unstubAllEnvs();
});

describe("IME cursor through the product renderer", () => {
  it.each([
    ["regular", 8],
    ["regular", 40],
    ["regular", 80],
    ["fullscreen", 8],
    ["fullscreen", 40],
    ["fullscreen", 80],
  ] as const)(
    "publishes a visible Windows input cursor in %s mode at width %s and after switching",
    async (mode, columns) => {
      Object.defineProperty(process, "platform", { value: "win32" });
      vi.stubEnv("PI_HARDWARE_CURSOR", undefined);
      const { terminal, renderer, editor } = setup(mode, undefined, columns);
      try {
        renderer.start();
        await terminal.waitForRender();
        expect(renderer.ui.getShowHardwareCursor()).toBe(true);
        expect(terminal.writes.join("")).toContain("\x1b[?25h");
        expect(terminal.getCursorPosition()).toEqual({ x: 3, y: 2 });
        editor.setText("中文abc");
        renderer.ui.renderNow();
        await terminal.flush();
        expect(terminal.getCursorPosition()).toEqual(
          columns === 8 ? { x: 6, y: 3 } : { x: 10, y: 2 },
        );
        renderer.switchMode(mode === "regular" ? "fullscreen" : "regular");
        renderer.ui.renderNow();
        await terminal.flush();
        expect(renderer.ui.getShowHardwareCursor()).toBe(true);
        expect(terminal.getCursorPosition()).toEqual(
          columns === 8 ? { x: 6, y: 3 } : { x: 10, y: 2 },
        );
        renderer.ui.setFocus(null);
        terminal.writes = [];
        renderer.ui.renderNow();
        await terminal.flush();
        expect(terminal.writes.join("")).toContain("\x1b[?25l");
        expect(terminal.writes.join("")).not.toContain("\x1b[?25h");
      } finally {
        renderer.dispose();
      }
    },
  );

  it.each([
    ["win32", undefined, undefined, true],
    ["win32", "0", undefined, false],
    ["win32", "1", undefined, true],
    ["win32", undefined, false, false],
    ["darwin", undefined, undefined, false],
    ["linux", undefined, undefined, false],
    ["linux", "1", undefined, true],
    ["linux", "0", true, true],
  ] as const)(
    "respects cursor policy on %s, env=%s, option=%s",
    (platform, env, option, expected) => {
      Object.defineProperty(process, "platform", { value: platform });
      vi.stubEnv("PI_HARDWARE_CURSOR", env);
      const { renderer } = setup("regular", option);
      try {
        expect(renderer.ui.getShowHardwareCursor()).toBe(expected);
      } finally {
        renderer.dispose();
      }
    },
  );

  it.each([false, true])(
    "settles the cursor before each regular-mode frame is presented (visible=%s)",
    async (visible) => {
      const { terminal, renderer, editor, trailing } = setup(
        "regular",
        visible,
      );
      const replay = new VirtualTerminal(40, 16);
      let cursorVisible = false;
      const assertFrame = async (expected: { x: number; y: number }) => {
        renderer.ui.renderNow();
        await terminal.flush();
        const output = terminal.writes.splice(0).join("");
        let boundaries = 0;
        // Replay at synchronized-output boundaries, not just after the final write:
        // the latter would miss the old frame presenting the last painted column.
        for (const part of output.split(/(\x1b\[\?2026l)/u)) {
          replay.write(part);
          for (const match of part.matchAll(/\x1b\[\?25([hl])/gu))
            cursorVisible = match[1] === "h";
          if (part === "\x1b[?2026l") {
            await replay.flush();
            expect(replay.getCursorPosition()).toEqual(expected);
            expect(cursorVisible).toBe(visible);
            boundaries++;
          }
        }
        await replay.flush();
        expect(replay.getCursorPosition()).toEqual(expected);
        return boundaries;
      };
      try {
        renderer.start();
        expect(await assertFrame({ x: 3, y: 2 })).toBeGreaterThan(0);
        editor.setText("中文abc");
        expect(await assertFrame({ x: 10, y: 2 })).toBeGreaterThan(0);
        editor.handleInput("\x1b[D");
        await assertFrame({ x: 9, y: 2 });
        trailing.lines = ["status"]; // deleted-lines-only branch
        expect(await assertFrame({ x: 9, y: 2 })).toBeGreaterThan(0);
        editor.setText("中文\nabc");
        expect(await assertFrame({ x: 6, y: 3 })).toBeGreaterThan(0);
        editor.setText(""); // differential shrink and placeholder restoration
        expect(await assertFrame({ x: 3, y: 2 })).toBeGreaterThan(0);
        await assertFrame({ x: 3, y: 2 }); // unchanged frame
        terminal.resize(32, 16);
        replay.resize(32, 16);
        expect(await assertFrame({ x: 3, y: 2 })).toBeGreaterThan(0);
        renderer.ui.requestRender(true); // forced full repaint
        expect(await assertFrame({ x: 3, y: 2 })).toBeGreaterThan(0);
      } finally {
        renderer.dispose();
      }
    },
  );
});
