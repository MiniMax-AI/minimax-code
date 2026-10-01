import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ScrollView,
  TuiAltScreen,
  type Component,
  type TuiMouseEvent,
  visibleWidth,
} from "../../src/tui/engine/public.js";
import { TuiChatLayout } from "../../src/tui/shell/chat-layout.js";
import { VirtualTerminal } from "../pi-084-upstream/virtual-terminal.js";

const COLUMNS = 20;
const ROWS = 10;
const CONTENT_LINES = 60;
const screens: TuiAltScreen[] = [];
afterEach(() => {
  for (const tui of screens.splice(0)) tui.stop();
});

class ScrollableLines implements Component {
  private readonly lines: string[] = [];

  constructor(count: number) {
    for (let index = 0; index < count; index++) {
      this.lines.push(`line-${String(index).padStart(2, "0")}`);
    }
  }

  render(): string[] {
    return [...this.lines];
  }

  appendLine(line: string): void {
    this.lines.push(line);
  }

  invalidate(): void {}
}

function viewportText(terminal: VirtualTerminal): string {
  return stripVTControlCharacters(terminal.getViewport().join("\n"));
}

function sgrPress(x: number, y: number): string {
  return `\x1b[<0;${x + 1};${y + 1}M`;
}

function sgrMotion(x: number, y: number): string {
  return `\x1b[<32;${x + 1};${y + 1}M`;
}

function sgrRelease(x: number, y: number): string {
  return `\x1b[<0;${x + 1};${y + 1}m`;
}

async function createScrollbarScreen(
  options: {
    columns?: number;
    gutter?: number;
    content?: Component;
    copySelection?: (text: string) => Promise<boolean>;
  } = {},
): Promise<{
  terminal: VirtualTerminal;
  tui: TuiAltScreen;
  scrollView: ScrollView;
}> {
  const terminal = new VirtualTerminal(options.columns ?? COLUMNS, ROWS);
  const content = options.content ?? new ScrollableLines(CONTENT_LINES);
  const scrollView = new ScrollView(content, {
    primary: true,
    overscroll: "contain",
    scrollbar: "always",
    scrollbarGutter: options.gutter ?? 3,
  });
  const tui = new TuiAltScreen(terminal, false, undefined, {
    copySelection: options.copySelection,
  });
  screens.push(tui);
  tui.setLayoutRoot(scrollView);
  tui.start();
  await terminal.waitForRender();
  return { terminal, tui, scrollView };
}

describe("Fullscreen scrollbar interaction", () => {
  it("shows the top of the content before any interaction", async () => {
    const { terminal } = await createScrollbarScreen();
    expect(viewportText(terminal)).toContain("line-00");
    expect(viewportText(terminal)).not.toContain("line-59");
  });

  it("jumps the thumb to a track press and keeps dragging from there", async () => {
    const { terminal } = await createScrollbarScreen();
    // Press the empty track at the bottom of the right-edge scrollbar.
    terminal.sendInput(sgrPress(COLUMNS - 1, ROWS - 1));
    await terminal.waitForRender();
    expect(viewportText(terminal)).toContain("line-59");
    expect(viewportText(terminal)).not.toContain("line-00");
    terminal.sendInput(sgrRelease(COLUMNS - 1, ROWS - 1));
    await terminal.waitForRender();
  });

  it("grabs near-miss clicks within the widened hit span", async () => {
    const { terminal } = await createScrollbarScreen();
    // Press two columns left of the painted one-column bar.
    terminal.sendInput(sgrPress(COLUMNS - 3, ROWS - 1));
    await terminal.waitForRender();
    expect(viewportText(terminal)).toContain("line-59");
    expect(viewportText(terminal)).not.toContain("line-00");
    terminal.sendInput(sgrRelease(COLUMNS - 3, ROWS - 1));
    await terminal.waitForRender();
  });

  it("keeps an on-thumb press in place and drags proportionally", async () => {
    const { terminal } = await createScrollbarScreen();
    // Jump to the end first via a track press at the bottom, then release.
    terminal.sendInput(sgrPress(COLUMNS - 1, ROWS - 1));
    await terminal.waitForRender();
    terminal.sendInput(sgrRelease(COLUMNS - 1, ROWS - 1));
    await terminal.waitForRender();
    // The thumb now spans the bottom rows; press it directly.
    terminal.sendInput(sgrPress(COLUMNS - 1, ROWS - 2));
    await terminal.waitForRender();
    // An on-thumb press must not move content on its own.
    expect(viewportText(terminal)).toContain("line-59");
    // Drag the thumb up the track.
    terminal.sendInput(sgrMotion(COLUMNS - 1, Math.floor(ROWS / 2)));
    await terminal.waitForRender();
    const text = viewportText(terminal);
    expect(text).not.toContain("line-59");
    expect(text).not.toContain("line-00");
    terminal.sendInput(sgrRelease(COLUMNS - 1, Math.floor(ROWS / 2)));
    await terminal.waitForRender();
  });

  it("ignores presses outside the hit span", async () => {
    const { terminal } = await createScrollbarScreen();
    // Jump to the end via a track press, then release.
    terminal.sendInput(sgrPress(COLUMNS - 1, ROWS - 1));
    await terminal.waitForRender();
    terminal.sendInput(sgrRelease(COLUMNS - 1, ROWS - 1));
    await terminal.waitForRender();
    // Press three columns left of the bar, outside the hit span.
    terminal.sendInput(sgrPress(COLUMNS - 4, 0));
    await terminal.waitForRender();
    terminal.sendInput(sgrRelease(COLUMNS - 4, 0));
    await terminal.waitForRender();
    expect(viewportText(terminal)).toContain("line-59");
  });
});

describe("Scrollbar interaction boundaries", () => {
  it.each([1, 3])(
    "routes the last content columns with a %i-column gutter to content",
    async (gutter) => {
      const handleMouse = vi.fn((_event: TuiMouseEvent) => true);
      const content = {
        render: (width: number) =>
          Array.from({ length: CONTENT_LINES }, () => "x".repeat(width)),
        invalidate() {},
        handleMouse,
      };
      const { terminal, scrollView } = await createScrollbarScreen({
        gutter,
        content,
      });
      for (const x of [COLUMNS - gutter - 2, COLUMNS - gutter - 1]) {
        terminal.sendInput(sgrPress(x, ROWS - 1));
        terminal.sendInput(sgrRelease(x, ROWS - 1));
        await terminal.waitForRender();
        expect(handleMouse).toHaveBeenCalledWith(
          expect.objectContaining({ action: "press", x }),
        );
        expect(scrollView.scrollTop).toBe(0);
      }
    },
  );

  it.each([1, 3])(
    "keeps text selection next to a %i-column gutter",
    async (gutter) => {
      const copySelection = vi.fn(async (_text: string) => true);
      const content = {
        render: (width: number) =>
          Array.from(
            { length: CONTENT_LINES },
            () => `${"x".repeat(width - 2)}YZ`,
          ),
        invalidate() {},
      };
      const { terminal, scrollView } = await createScrollbarScreen({
        gutter,
        content,
        copySelection,
      });
      terminal.sendInput(sgrPress(COLUMNS - gutter - 2, 4));
      terminal.sendInput(sgrMotion(COLUMNS - gutter - 1, 4));
      terminal.sendInput(sgrRelease(COLUMNS - gutter - 1, 4));
      await terminal.waitForRender();
      expect(copySelection).toHaveBeenCalledWith("YZ");
      expect(scrollView.scrollTop).toBe(0);
    },
  );

  it.each([1, 2, 3, 4, 8])(
    "preserves content and bounded mouse targets at width %i",
    async (columns) => {
      const widths: number[] = [];
      const handleMouse = vi.fn(() => true);
      const content = {
        render: (width: number) => {
          widths.push(width);
          return Array.from({ length: CONTENT_LINES }, () => "x".repeat(width));
        },
        invalidate() {},
        handleMouse,
      };
      const { terminal, scrollView } = await createScrollbarScreen({
        columns,
        content,
      });
      expect(widths.every((width) => width === Math.max(1, columns - 3))).toBe(
        true,
      );
      expect(
        terminal.getViewport().every((line) => visibleWidth(line) <= columns),
      ).toBe(true);
      terminal.sendInput(sgrPress(0, ROWS - 1));
      terminal.sendInput(sgrRelease(0, ROWS - 1));
      await terminal.waitForRender();
      expect(handleMouse).toHaveBeenCalled();
      expect(scrollView.scrollTop).toBe(0);
      if (columns > 1) {
        terminal.sendInput(sgrPress(columns - 1, ROWS - 1));
        await terminal.waitForRender();
        expect(scrollView.scrollTop).toBe(CONTENT_LINES - ROWS);
      }
    },
  );

  it("does not capture a track press while an overlay is visible", async () => {
    const { terminal, tui, scrollView } = await createScrollbarScreen();
    tui.showOverlay(new ScrollableLines(2), { width: 10 });
    await terminal.waitForRender();
    terminal.sendInput(sgrPress(COLUMNS - 1, ROWS - 1));
    terminal.sendInput(sgrRelease(COLUMNS - 1, ROWS - 1));
    await terminal.waitForRender();
    expect(scrollView.scrollTop).toBe(0);
  });

  it("cancels a drag when an overlay opens and does not resume it after dismissal", async () => {
    const { terminal, tui, scrollView } = await createScrollbarScreen();
    terminal.sendInput(sgrPress(COLUMNS - 1, 0));
    const overlay = tui.showOverlay(new ScrollableLines(2), { width: 10 });
    await terminal.waitForRender();
    terminal.sendInput(sgrMotion(COLUMNS - 1, ROWS - 1));
    await terminal.waitForRender();
    expect(scrollView.scrollTop).toBe(0);
    overlay.hide();
    await terminal.waitForRender();
    terminal.sendInput(sgrMotion(COLUMNS - 1, ROWS - 1));
    terminal.sendInput(sgrRelease(COLUMNS - 1, ROWS - 1));
    await terminal.waitForRender();
    expect(scrollView.scrollTop).toBe(0);
  });

  it("routes wheel events normally and ends dragging on release", async () => {
    const { terminal, scrollView } = await createScrollbarScreen();
    terminal.sendInput(`\x1b[<65;${COLUMNS};5M`);
    await terminal.waitForRender();
    expect(scrollView.scrollTop).toBeGreaterThan(0);
    terminal.sendInput(sgrPress(COLUMNS - 1, ROWS - 1));
    terminal.sendInput(sgrRelease(COLUMNS - 1, ROWS - 1));
    await terminal.waitForRender();
    terminal.sendInput(sgrMotion(COLUMNS - 1, 0));
    await terminal.waitForRender();
    expect(scrollView.scrollTop).toBe(CONTENT_LINES - ROWS);
  });

  it("enables a reserved gutter in the actual fullscreen chat layout", async () => {
    const terminal = new VirtualTerminal(40, 15);
    const empty = { render: () => [], invalidate() {} };
    const layout = new TuiChatLayout(terminal, {
      surface: () => "conversation",
      transcript: new ScrollableLines(CONTENT_LINES),
      welcome: empty,
      interaction: { ...empty, isActive: () => false },
      activity: empty,
      followUp: empty,
      composer: { render: () => ["composer"], invalidate() {} },
      status: empty,
    });
    const tui = new TuiAltScreen(terminal);
    screens.push(tui);
    tui.setLayoutRoot(layout.fullscreenLayoutRoot);
    tui.start();
    await terminal.waitForRender();
    expect(viewportText(terminal)).toContain("line-59");
    terminal.sendInput(sgrPress(37, 0));
    terminal.sendInput(sgrRelease(37, 0));
    await terminal.waitForRender();
    expect(viewportText(terminal)).toContain("line-00");
    expect(viewportText(terminal)).not.toContain("line-59");
    expect(viewportText(terminal)).toContain("composer");
  });

  it.each(["footer shrink", "content shrink", "all content fitting"] as const)(
    "keeps streaming detached after %s clamps the viewport to the end",
    async (change) => {
      const terminal = new VirtualTerminal(40, 15);
      const empty = { render: () => [], invalidate() {} };
      let lines = Array.from({ length: 60 }, (_, index) => `answer-${index}`);
      let footerRows = 4;
      const layout = new TuiChatLayout(terminal, {
        surface: () => "conversation",
        transcript: { ...empty, render: () => [...lines] },
        welcome: empty,
        interaction: { ...empty, isActive: () => false },
        activity: { ...empty, render: () => Array(footerRows).fill("activity") },
        followUp: empty,
        composer: { ...empty, render: () => ["composer"] },
        status: empty,
      });
      const tui = new TuiAltScreen(terminal);
      screens.push(tui);
      tui.setLayoutRoot(layout.fullscreenLayoutRoot);
      tui.start();
      await terminal.waitForRender();
      terminal.sendInput("\x1b[<64;10;4M");
      await terminal.waitForRender();
      expect(tui.isFollowingOutput).toBe(false);

      if (change === "footer shrink") footerRows = 0;
      else lines = lines.slice(0, change === "content shrink" ? 50 : 0);
      tui.renderNow();
      await terminal.flush();
      const anchor = tui.viewportTop;
      expect(tui.isFollowingOutput).toBe(false);

      for (let chunk = 0; chunk < 20; chunk++) {
        lines.push(`streamed-${chunk}`);
        layout.followBottom();
        tui.renderNow();
        await terminal.flush();
        expect(tui.viewportTop).toBe(anchor);
        expect(tui.isFollowingOutput).toBe(false);
      }
      terminal.sendInput("\x1b[F");
      await terminal.waitForRender();
      expect(tui.isFollowingOutput).toBe(true);
      expect(viewportText(terminal)).toContain("streamed-19");
      lines.push("resumed-stream");
      layout.followBottom();
      tui.renderNow();
      await terminal.flush();
      expect(viewportText(terminal)).toContain("resumed-stream");
    },
  );

  it("preserves a detached transcript position until follow-tail is explicitly re-armed", async () => {
    const terminal = new VirtualTerminal(40, 15);
    const empty = { render: () => [], invalidate() {} };
    const content = new ScrollableLines(CONTENT_LINES);
    const layout = new TuiChatLayout(terminal, {
      surface: () => "conversation",
      transcript: content,
      welcome: empty,
      interaction: { ...empty, isActive: () => false },
      activity: empty,
      followUp: empty,
      composer: { render: () => ["composer"], invalidate() {} },
      status: empty,
    });
    const tui = new TuiAltScreen(terminal);
    screens.push(tui);
    tui.setLayoutRoot(layout.fullscreenLayoutRoot);
    tui.start();
    await terminal.waitForRender();

    expect(viewportText(terminal)).toContain("line-59");

    terminal.sendInput(sgrPress(37, 0));
    terminal.sendInput(sgrRelease(37, 0));
    await terminal.waitForRender();
    expect(viewportText(terminal)).toContain("line-00");

    content.appendLine("line-60");
    layout.followBottom();
    tui.requestRender();
    await terminal.waitForRender();
    expect(viewportText(terminal)).toContain("line-00");
    expect(viewportText(terminal)).not.toContain("line-60");

    terminal.sendInput("\x1b[F");
    await terminal.waitForRender();
    expect(viewportText(terminal)).toContain("line-60");

    terminal.sendInput("\x1b[<64;10;4M");
    await terminal.waitForRender();
    expect(tui.isFollowingOutput).toBe(false);

    terminal.resize(40, 45);
    await terminal.waitForRender();
    const resizedTop = tui.viewportTop;
    expect(tui.isFollowingOutput).toBe(false);

    content.appendLine("line-61");
    layout.followBottom();
    tui.requestRender();
    await terminal.waitForRender();
    expect(tui.viewportTop).toBe(resizedTop);

    terminal.sendInput("\x1b[F");
    await terminal.waitForRender();
    expect(viewportText(terminal)).toContain("line-61");

    content.appendLine("line-62");
    layout.followBottom();
    tui.requestRender();
    await terminal.waitForRender();
    expect(viewportText(terminal)).toContain("line-62");
  });
});
