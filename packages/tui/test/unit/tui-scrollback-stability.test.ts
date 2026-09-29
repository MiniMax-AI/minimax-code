import { describe, expect, it } from "vitest";
import {
  CURSOR_MARKER,
  TuiMainScreen,
  type Component,
} from "../../src/tui/engine/public.js";
import { TuiChatLayout } from "../../src/tui/shell/chat-layout.js";
import { TuiTaskPanel } from "../../src/tui/shell/task-panel.js";
import { createTranscriptCell } from "../../src/tui/transcript/model.js";
import { TranscriptStore } from "../../src/tui/transcript/store.js";
import { TranscriptVisibilityProjection } from "../../src/tui/transcript/presentation/visibility.js";
import { TranscriptView } from "../../src/tui/transcript/view.js";
import { VirtualTerminal } from "../pi-084-upstream/virtual-terminal.js";

class RecordingTerminal extends VirtualTerminal {
  private writes: string[] = [];
  override write(data: string): void {
    this.writes.push(data);
    super.write(data);
  }
  takeWrites(): string {
    const result = this.writes.join("");
    this.writes = [];
    return result;
  }
}

class ClearToScrollbackTerminal extends RecordingTerminal {
  override write(data: string): void {
    super.write(
      data.replaceAll(
        "\x1b[2J",
        `\x1b[${this.rows};1H${"\r\n".repeat(this.rows)}\x1b[2J`,
      ),
    );
  }
}

class Lines implements Component {
  constructor(public lines: string[] = []) {}
  render(): string[] {
    return [...this.lines];
  }
  invalidate(): void {}
}

function fixture(
  terminal: RecordingTerminal,
  options: ConstructorParameters<typeof TranscriptView>[1] = {},
) {
  const store = new TranscriptStore();
  const view = new TranscriptView(
    new TranscriptVisibilityProjection(store),
    options,
  );
  const tasks = new TuiTaskPanel();
  const activity = new Lines(["Running"]);
  const tui = new TuiMainScreen(terminal);
  const empty = new Lines();
  const layout = new TuiChatLayout(terminal, {
    surface: () => "conversation",
    welcome: new Lines(["WELCOME"]),
    transcript: view,
    interaction: empty,
    activity,
    tasks,
    followUp: empty,
    composer: new Lines([`composer${CURSOR_MARKER}`]),
    status: new Lines(["status"]),
  });
  tui.addChild(layout);
  const render = async () => {
    tui.renderNow();
    await terminal.flush();
    return terminal.takeWrites();
  };
  return { terminal, store, view, tasks, activity, tui, layout, render };
}

function step(index: number, title = "Bash", turnId = "long-turn") {
  return createTranscriptCell({
    id: `step-${index}`,
    turnId,
    kind: "tool",
    title,
    content:
      title === "Read"
        ? `src/STEP_${String(index).padStart(3, "0")}.ts`
        : `echo STEP_${String(index).padStart(3, "0")}`,
    status: "succeeded",
    createdAtMs: index,
    displayMode: "expanded",
  });
}

function expectNoReplay(output: string): void {
  expect(output).not.toContain("\x1b[3J");
  expect(output).not.toContain("\x1b[2J");
  expect(output).not.toContain("WELCOME");
  expect(output).not.toContain("Transcript refreshed");
}

async function seedShell(terminal: RecordingTerminal): Promise<void> {
  terminal.write(`SHELL_HISTORY_SENTINEL\r\n${"shell line\r\n".repeat(50)}`);
  await terminal.flush();
  terminal.takeWrites();
}

describe.each([
  ["xterm", RecordingTerminal],
  ["clear-to-scrollback host", ClearToScrollbackTerminal],
] as const)("%s regular scrollback stability", (_name, Terminal) => {
  it.each(["Bash", "Read"])(
    "retains every emitted %s step while the live projection rolls",
    async (title) => {
      const f = fixture(new Terminal(100, 24));
      if (title === "Read") f.view.toggleDetailMode();
      await seedShell(f.terminal);
      for (let i = 0; i < 120; i++) f.store.upsert(step(i, title));
      await f.render();
      f.terminal.scrollLines(-15);
      const before = f.terminal.getScrollPosition().viewport;
      for (let i = 120; i < 145; i++) {
        f.store.upsert(step(i, title));
        expectNoReplay(await f.render());
        expect(f.terminal.getScrollPosition().viewport).toBe(before);
        expect(
          f.view.getPerformanceSnapshot().projectedCells,
        ).toBeLessThanOrEqual(121);
        expect(
          f.tui.captureRenderState().previousLines.length,
        ).toBeLessThanOrEqual(f.layout.render(100).length + 24);
      }
      const history = f.terminal.getScrollBuffer();
      expect(history).toContain("SHELL_HISTORY_SENTINEL");
      for (let i = 0; i < 145; i++) {
        const token = `STEP_${String(i).padStart(3, "0")}`;
        expect(
          history.filter((line) => line.includes(token)),
          token,
        ).toHaveLength(1);
      }
      f.terminal.scrollLines(10000);
      expect(
        f.terminal
          .getViewport()
          .slice(-3)
          .map((line) => line.trim()),
      ).toEqual(["Running", "composer", "status"]);
      expect(f.terminal.getCursorPosition().y).toBe(22);
      expectNoReplay(await f.render());
    },
  );

  it("preserves emitted turns when the bounded turn window evicts its prefix", async () => {
    const f = fixture(new Terminal(100, 12), {
      maxInitialTurns: 2,
      maxProjectedTurns: 4,
    });
    for (let i = 0; i < 40; i++) {
      for (let j = 0; j < 12; j++)
        f.store.upsert(step(i * 12 + j, "Bash", `turn-${i}`));
      const output = await f.render();
      if (i > 0) expectNoReplay(output);
      expect(
        f.view.getPerformanceSnapshot().projectedCells,
      ).toBeLessThanOrEqual(48);
    }
    const history = f.terminal.getScrollBuffer();
    for (let i = 0; i < 480; i++) {
      const token = `STEP_${String(i).padStart(3, "0")}`;
      expect(
        history.filter((line) => line.includes(token)),
        token,
      ).toHaveLength(1);
    }
  });

  it.each([18, 44])(
    "keeps shell history and cursor stable when expanded Todo finishes in %i rows",
    async (rows) => {
      const f = fixture(new Terminal(100, rows));
      await seedShell(f.terminal);
      for (let i = 0; i < 100; i++) f.store.upsert(step(i));
      const items = Array.from({ length: 11 }, (_, i) => ({
        content: `Task ${i}`,
        status: "in_progress" as const,
      }));
      f.tasks.setItems(items);
      f.tasks.toggleExpanded();
      await f.render();
      f.terminal.scrollLines(-10);
      const before = f.terminal.getScrollPosition().viewport;
      f.tasks.setItems(items.map((item) => ({ ...item, status: "completed" })));
      expectNoReplay(await f.render());
      expect(f.terminal.getScrollPosition().viewport).toBe(before);
      expect(f.terminal.getScrollBuffer()).toContain("SHELL_HISTORY_SENTINEL");
      f.terminal.scrollLines(10000);
      expect(
        f.terminal
          .getViewport()
          .slice(-3)
          .map((line) => line.trim()),
      ).toEqual(["Running", "composer", "status"]);
      expect(f.terminal.getCursorPosition().y).toBe(rows - 2);
      for (let i = 100; i < 120; i++) {
        f.store.upsert(step(i));
        expectNoReplay(await f.render());
      }
      const history = f.terminal.getScrollBuffer();
      for (let i = 0; i < 120; i++) {
        expect(
          history.filter((line) =>
            line.includes(`STEP_${String(i).padStart(3, "0")}`),
          ),
        ).toHaveLength(1);
      }
    },
  );

  it("retains anchors when regular render state is restored after a mode switch", async () => {
    const terminal = new Terminal(100, 24);
    const f = fixture(terminal);
    for (let i = 0; i < 120; i++) f.store.upsert(step(i));
    await f.render();
    const state = f.tui.captureRenderState();
    const restored = new TuiMainScreen(terminal);
    restored.addChild(f.layout);
    restored.restoreRenderState(state);
    f.store.upsert(step(120));
    restored.renderNow();
    await terminal.flush();
    expectNoReplay(terminal.takeWrites());
    for (let i = 0; i <= 120; i++) {
      expect(
        terminal
          .getScrollBuffer()
          .filter((line) =>
            line.includes(`STEP_${String(i).padStart(3, "0")}`),
          ),
      ).toHaveLength(1);
    }
  });
});

describe("regular renderer boundary regressions", () => {
  it("idle render with footer taller than screen produces no output growth", async () => {
    const f = fixture(new RecordingTerminal(100, 8));
    for (let i = 0; i < 100; i++) f.store.upsert(step(i));
    f.tasks.setItems(
      Array.from({ length: 11 }, (_, i) => ({
        content: `Task ${i}`,
        status: "in_progress" as const,
      })),
    );
    f.tasks.toggleExpanded();
    await f.render();
    const before = f.terminal.getScrollBuffer();
    const output = await f.render();
    const after = f.terminal.getScrollBuffer();
    expect(after).toEqual(before);
  });
  it.each([false, true])(
    "preserves output arriving during resize (live resize callback: %s)",
    async (started) => {
      const f = fixture(new RecordingTerminal(100, 24));
      for (let i = 0; i < 40; i++) f.store.upsert(step(i));
      if (started) f.tui.start();
      await f.render();
      f.terminal.resize(90, 12);
      for (let i = 40; i < 80; i++) f.store.upsert(step(i));
      await f.render();
      const history = f.terminal.getScrollBuffer();
      for (let i = 0; i < 80; i++)
        expect(
          history.filter((line) =>
            line.includes(`STEP_${String(i).padStart(3, "0")}`),
          ),
          `step ${i}`,
        ).toHaveLength(1);
      if (started) f.tui.stop();
    },
  );

  it("preserves retained native-history image resources across resize", async () => {
    const terminal = new RecordingTerminal(100, 24);
    const tui = new TuiMainScreen(terminal);
    const image = "\x1b_Ga=T,f=100,i=42,r=1;PNGDATA\x1b\\";
    const component = new Lines([
      image,
      ...Array.from({ length: 50 }, (_, i) => `Line ${i}`),
      `composer${CURSOR_MARKER}`,
    ]);
    tui.addChild(component);
    tui.renderNow();
    await terminal.flush();
    terminal.takeWrites();
    terminal.resize(90, 24);
    tui.renderNow();
    await terminal.flush();
    const output = terminal.takeWrites();
    expect(output).not.toContain("d=I,i=42");
  });

  it.each([12, 50])(
    "preserves old visible body when new turn evicts all anchors in %i rows",
    async (rows) => {
      const f = fixture(new RecordingTerminal(100, rows), {
        maxInitialTurns: 1,
        maxProjectedTurns: 1,
      });
      for (let i = 0; i < 12; i++) f.store.upsert(step(i, "Bash", "turn-1"));
      await f.render();
      for (let i = 12; i < 24; i++) f.store.upsert(step(i, "Bash", "turn-2"));
      await f.render();
      const history = f.terminal.getScrollBuffer();
      for (let i = 0; i < 24; i++)
        expect(
          history.some((line) =>
            line.includes(`STEP_${String(i).padStart(3, "0")}`),
          ),
          `step ${i}`,
        ).toBe(true);
    },
  );

  it("keeps step output across changing oversized footers", async () => {
    const f = fixture(new RecordingTerminal(100, 24));
    for (let i = 0; i < 80; i++) f.store.upsert(step(i));
    f.tasks.toggleExpanded();
    await f.render();
    let total = 80;
    for (const count of [30, 5, 35, 0, 24, 10, 45, 1, 30]) {
      f.tasks.setItems(
        Array.from({ length: count }, (_, i) => ({
          content: `Task ${i}`,
          status: "in_progress" as const,
        })),
      );
      await f.render();
      f.store.upsert(step(total++));
      await f.render();
      const history = f.terminal.getScrollBuffer();
      for (let i = 0; i < total; i++)
        expect(
          history.filter((line) =>
            line.includes(`STEP_${String(i).padStart(3, "0")}`),
          ),
          `count ${count} step ${i}`,
        ).toHaveLength(1);
    }
  });
});

describe("explicit redraw", () => {
  it("refreshes the active screen without re-emitting its existing transcript", async () => {
    const f = fixture(new RecordingTerminal(100, 24));
    for (let i = 0; i < 120; i++) f.store.upsert(step(i));
    await f.render();
    const before = f.terminal.getScrollBuffer();
    f.tui.renderNow(true);
    await f.terminal.flush();
    expectNoReplay(f.terminal.takeWrites());
    expect(f.terminal.getScrollBuffer()).toEqual(before);
    f.store.upsert(step(120));
    expectNoReplay(await f.render());
    expect(
      f.terminal.getScrollBuffer().filter((line) => line.includes("STEP_120")),
    ).toHaveLength(1);
  });
});

describe("projection gaps and retained images", () => {
  it("does not mistake the pinned first cell for continuity across a large rolling burst", async () => {
    const f = fixture(new RecordingTerminal(100, 24));
    for (let i = 0; i < 120; i++) f.store.upsert(step(i));
    await f.render();
    for (let i = 120; i < 230; i++) f.store.upsert(step(i));
    await f.render();
    const history = f.terminal.getScrollBuffer();
    for (let i = 0; i < 230; i++)
      expect(
        history.some((line) =>
          line.includes(`STEP_${String(i).padStart(3, "0")}`),
        ),
        `step ${i}`,
      ).toBe(true);
  });

  it("does not mistake the pinned user for continuity across a large rolling burst", async () => {
    const f = fixture(new RecordingTerminal(100, 24));
    f.store.upsert(
      createTranscriptCell({
        id: "user",
        turnId: "long-turn",
        kind: "user",
        content: "Start task",
        status: "succeeded",
        createdAtMs: 0,
      }),
    );
    for (let i = 0; i < 119; i++) f.store.upsert(step(i));
    await f.render();
    for (let i = 119; i < 229; i++) f.store.upsert(step(i));
    await f.render();
    const history = f.terminal.getScrollBuffer();
    for (let i = 0; i < 229; i++)
      expect(
        history.some((line) =>
          line.includes(`STEP_${String(i).padStart(3, "0")}`),
        ),
        `step ${i}`,
      ).toBe(true);
  });

  it("does not replay historical images when only text footer collapses", async () => {
    const terminal = new RecordingTerminal(100, 24);
    const tui = new TuiMainScreen(terminal);
    const body = [
      "\x1b_Ga=T,f=100,i=42,r=1;PNGDATA\x1b\\",
      ...Array.from({ length: 60 }, (_, i) => `Body ${i}`),
    ];
    let footer = [
      ...Array.from({ length: 10 }, (_, i) => `Activity ${i}`),
      `composer${CURSOR_MARKER}`,
      "status",
    ];
    const component = {
      render: () => [...body, ...footer],
      invalidate: () => {},
      getScrollbackLayout: () => ({
        bodyEnd: body.length,
        anchors: body.map((_, row) => ({ id: `body-${row}`, row })),
      }),
    };
    tui.addChild(component);
    tui.renderNow();
    await terminal.flush();
    terminal.takeWrites();
    footer = [`composer${CURSOR_MARKER}`, "status"];
    tui.renderNow();
    await terminal.flush();
    const output = terminal.takeWrites();
    expect(output).not.toContain("Transcript refreshed");
    expect(
      terminal.getScrollBuffer().filter((line) => line === "Body 0"),
    ).toHaveLength(1);
  });
});

describe("settled thinking", () => {
  it("does not replay history when a retained thinking preview collapses across the viewport boundary", async () => {
    const f = fixture(new RecordingTerminal(100, 18));
    for (let i = 0; i < 50; i++)
      f.store.upsert(
        createTranscriptCell({
          id: `history-${i}`,
          turnId: "turn",
          kind: "assistant",
          status: "succeeded",
          content: `History ${i}`,
          createdAtMs: i,
        }),
      );
    const thinking = createTranscriptCell({
      id: "thinking",
      turnId: "turn",
      kind: "thinking",
      status: "running",
      content: "First thought\nSecond thought\nThird thought\nFourth thought",
      createdAtMs: 51,
    });
    f.store.upsert(thinking);
    f.tasks.setItems(
      Array.from({ length: 11 }, (_, i) => ({
        content: `Task ${i}`,
        status: "in_progress" as const,
      })),
    );
    f.tasks.toggleExpanded();
    await f.render();
    f.store.upsert({
      ...thinking,
      status: "succeeded",
      updatedAtMs: 1001,
      durationMs: 1000,
    });
    expectNoReplay(await f.render());
    for (let i = 0; i < 50; i++)
      expect(
        f.terminal
          .getScrollBuffer()
          .filter((line) => line.trim() === `● History ${i}`),
      ).toHaveLength(1);
  });
});

describe("transient transcript cleanup", () => {
  it("does not replay history when the previous turn duration is removed", async () => {
    const f = fixture(new RecordingTerminal(100, 24));
    for (let i = 0; i < 80; i++) f.store.upsert(step(i));
    f.store.upsert(
      createTranscriptCell({
        id: "turn-duration:long-turn",
        turnId: "long-turn",
        kind: "turn-duration",
        ephemeral: true,
        status: "succeeded",
        durationMs: 1000,
        content: "",
        createdAtMs: 90,
      }),
    );
    await f.render();
    f.store.remove("turn-duration:long-turn");
    f.store.upsert(
      createTranscriptCell({
        id: "new-request",
        turnId: "new-turn",
        kind: "user",
        status: "succeeded",
        content: "Next request",
        createdAtMs: 91,
      }),
    );
    const output = await f.render();
    expectNoReplay(output);
  });
});

describe("projection reads between physical frames", () => {
  it("compares eviction to the last emitted frame after offscreen projection reads", async () => {
    const f = fixture(new RecordingTerminal(100, 24));
    f.store.upsert(
      createTranscriptCell({
        id: "user",
        turnId: "long-turn",
        kind: "user",
        content: "Start task",
        status: "succeeded",
        createdAtMs: 0,
      }),
    );
    for (let i = 0; i < 119; i++) f.store.upsert(step(i));
    await f.render();
    for (let i = 119; i < 269; i++) f.store.upsert(step(i));
    // Fullscreen/inspection can render projections without updating the saved
    // regular-mode screen. Eviction must be relative to that physical screen.
    f.layout.render(100);
    f.store.upsert(step(269));
    await f.render();
    const history = f.terminal.getScrollBuffer();
    for (let i = 0; i < 119; i++)
      expect(
        history.some((line) =>
          line.includes(`STEP_${String(i).padStart(3, "0")}`),
        ),
        `previously emitted ${i}`,
      ).toBe(true);
    expect(history.some((line) => line.includes("STEP_269"))).toBe(true);
  });
});

describe("isolated regular overlays", () => {
  it("does not treat a forced first overlay frame as a width reflow", async () => {
    const f = fixture(new RecordingTerminal(100, 24));
    for (let i = 0; i < 60; i++) f.store.upsert(step(i));
    await f.render();
    const before = f.terminal.getScrollBuffer();
    const overlay = f.tui.showOverlay(new Lines(["TRANSIENT_PANEL"]));
    f.tui.renderNow(true);
    await f.terminal.flush();
    f.terminal.takeWrites();
    overlay.hide();
    expectNoReplay(await f.render());
    expect(f.terminal.getScrollBuffer()).toEqual(before);
  });

  it("returns the main buffer on stop with a pending render and does not re-enter after stop", async () => {
    const f = fixture(new RecordingTerminal(100, 24));
    for (let i = 0; i < 30; i++) f.store.upsert(step(i));
    await f.render();
    f.tui.showOverlay(new Lines(["TRANSIENT_PANEL"]), {
      width: "100%",
      maxHeight: "100%",
      row: 0,
    });
    await f.render();
    f.store.upsert(step(30));
    f.tui.requestRender();
    f.tui.stop();
    await f.terminal.flush();
    const output = f.terminal.takeWrites();
    expect(output).toContain("\x1b[?1049l");
    expect(output).not.toContain("\x1b[?1049h");
    expect(f.terminal.getScrollBuffer().join("\n")).not.toContain(
      "TRANSIENT_PANEL",
    );
    expect(
      f.terminal.getScrollBuffer().filter((line) => line.includes("STEP_030")),
    ).toHaveLength(1);
    f.tui.renderNow();
    expect(f.terminal.takeWrites()).toBe("");
  });

  it("tracks shrink and grow events even when no overlay frame is rendered between them", async () => {
    const f = fixture(new RecordingTerminal(100, 24));
    for (let i = 0; i < 60; i++) f.store.upsert(step(i));
    f.tui.start();
    try {
      await f.render();
      const overlay = f.tui.showOverlay(new Lines(["TRANSIENT_PANEL"]), {
        width: "100%",
        maxHeight: "100%",
        row: 0,
      });
      await f.render();
      f.terminal.resize(100, 8);
      f.terminal.resize(100, 24);
      overlay.hide();
      await f.render();
      const history = f.terminal.getScrollBuffer();
      expect(history.join("\n")).not.toContain("TRANSIENT_PANEL");
      expect(history.join("\n")).not.toContain("Transcript refreshed");
      for (let i = 0; i < 60; i++) {
        expect(
          history.filter((line) =>
            line.includes(`STEP_${String(i).padStart(3, "0")}`),
          ),
        ).toHaveLength(1);
      }
      expect(f.terminal.getViewport().at(-1)?.trim()).toBe("status");
    } finally {
      f.tui.stop();
    }
  });
});

describe("isolated overlay width reflow", () => {
  it.each([12, 40])(
    "preserves wrapping main text through overlay width roundtrip with %i body rows",
    async (count) => {
      const terminal = new RecordingTerminal(100, 24);
      const tui = new TuiMainScreen(terminal);
      const body = Array.from(
        { length: count },
        (_, i) => `WIDE_TOKEN_${String(i).padStart(3, "0")} ${"x".repeat(70)}`,
      );
      const component = new Lines([
        ...body,
        `composer${CURSOR_MARKER}`,
        "status",
      ]);
      tui.addChild(component);
      tui.start();
      try {
        tui.renderNow();
        await terminal.flush();
        terminal.takeWrites();
        const overlay = tui.showOverlay(new Lines(["TRANSIENT_OVERLAY"]), {
          width: "100%",
          maxHeight: "100%",
          row: 0,
          col: 0,
        });
        tui.renderNow();
        await terminal.flush();
        terminal.resize(30, 24);
        tui.renderNow();
        await terminal.flush();
        terminal.resize(100, 24);
        tui.renderNow();
        await terminal.flush();
        overlay.hide();
        tui.renderNow();
        await terminal.flush();
        const history = terminal.getScrollBuffer();
        expect(history.join("\n")).not.toContain("TRANSIENT_OVERLAY");
        for (let i = 0; i < count; i++)
          expect(
            history.some((line) =>
              line.includes(`WIDE_TOKEN_${String(i).padStart(3, "0")}`),
            ),
            `old row ${i}`,
          ).toBe(true);
        const boundary = history.findLastIndex((line) =>
          line.startsWith("── Transcript refreshed"),
        );
        expect(boundary).toBeGreaterThanOrEqual(0);
        expect(history.slice(boundary + 1).filter(Boolean)).toEqual([
          ...body,
          "composer",
          "status",
        ]);
      } finally {
        tui.stop();
      }
    },
  );

  it.each([12, 40])(
    "archives old wrapping text before changed document resumes after overlay width roundtrip (%i)",
    async (count) => {
      const terminal = new RecordingTerminal(100, 24);
      const tui = new TuiMainScreen(terminal);
      const body = Array.from(
        { length: count },
        (_, i) => `WIDE_TOKEN_${String(i).padStart(3, "0")} ${"x".repeat(70)}`,
      );
      const component = new Lines([
        ...body,
        `composer${CURSOR_MARKER}`,
        "status",
      ]);
      tui.addChild(component);
      tui.start();
      try {
        tui.renderNow();
        await terminal.flush();
        terminal.takeWrites();
        const overlay = tui.showOverlay(new Lines(["TRANSIENT_OVERLAY"]), {
          width: "100%",
          maxHeight: "100%",
          row: 0,
          col: 0,
        });
        tui.renderNow();
        await terminal.flush();
        terminal.resize(30, 24);
        tui.renderNow();
        await terminal.flush();
        terminal.resize(100, 24);
        tui.renderNow();
        await terminal.flush();
        component.lines = ["NEW_BODY", `composer${CURSOR_MARKER}`, "status"];
        overlay.hide();
        tui.renderNow();
        await terminal.flush();
        const history = terminal.getScrollBuffer();
        expect(history.join("\n")).not.toContain("TRANSIENT_OVERLAY");
        for (let i = 0; i < count; i++)
          expect(
            history.some((line) =>
              line.includes(`WIDE_TOKEN_${String(i).padStart(3, "0")}`),
            ),
            `old row ${i}`,
          ).toBe(true);
        const boundary = history.findLastIndex((line) =>
          line.startsWith("── Transcript refreshed"),
        );
        expect(boundary).toBeGreaterThanOrEqual(0);
        expect(history.slice(boundary + 1).filter(Boolean)).toEqual([
          "NEW_BODY",
          "composer",
          "status",
        ]);
      } finally {
        tui.stop();
      }
    },
  );
});
