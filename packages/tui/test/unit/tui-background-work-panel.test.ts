import { stripVTControlCharacters } from "node:util";
import { describe, expect, it, vi } from "vitest";

import { TuiBackgroundWorkPanel } from "../../src/tui/background-work/panel.js";
import type { TuiBackgroundTask } from "../../src/runtime/port.js";
import type { TuiAgentTeamSnapshot } from "../../src/tui/agent-team/model.js";
import { TuiMainScreen } from '../../src/tui/engine/tui-main-screen.js';
import { TuiOverlayRegularFeaturePresenter } from '../../src/tui/shell/regular-feature-presenter.js';
import { TuiAltScreen } from "../../src/tui/engine/tui-alt-screen.js";
import { VirtualTerminal } from "../pi-084-upstream/virtual-terminal.js";
import { visibleWidth } from "../../src/tui/rendering/text.js";

function teamSnapshot(): TuiAgentTeamSnapshot {
  return {
    rootSessionId: "root",
    capturedAtMs: 10_000,
    summary: {
      total: 1,
      running: 1,
      waiting: 0,
      queued: 0,
      done: 0,
      failed: 0,
      stopped: 0,
    },
    members: [
      {
        sessionId: "reviewer",
        parentSessionId: "root",
        agentName: "reviewer",
        task: "Review the implementation",
        status: "running",
        phase: "tool",
        activity: "Reading task-panel.ts",
        toolCount: 2,
        turnId: "turn-reviewer",
        startedAtMs: 1_000,
        updatedAtMs: 9_000,
      },
    ],
  };
}

function backgroundTasks(): readonly TuiBackgroundTask[] {
  return [
    {
      taskId: "bg-running",
      kind: "bash",
      status: "running",
      ownerSessionId: "root",
      description: "pnpm typecheck",
      createdAtMs: 2_000,
      updatedAtMs: 9_000,
      startedAtMs: 3_000,
    },
    {
      taskId: "bg-failed",
      kind: "bash",
      status: "failed",
      ownerSessionId: "root",
      description: "build docs",
      createdAtMs: 1_000,
      updatedAtMs: 8_000,
      startedAtMs: 2_000,
      endedAtMs: 8_000,
      lastError: "exit code 1\n\u001B]8;;https://example.com\u0007unsafe",
    },
    {
      taskId: "bg-delivered",
      kind: "bash",
      status: "succeeded",
      ownerSessionId: "root",
      description: "completed validation",
      createdAtMs: 500,
      updatedAtMs: 7_000,
      startedAtMs: 600,
      endedAtMs: 6_000,
      deliveredAtMs: 7_000,
    },
  ];
}

describe("TuiBackgroundWorkPanel", () => {
  it("renders one unified list for Agent Team and Runtime background tasks", () => {
    const agentTeam = vi.fn(teamSnapshot);
    const panel = new TuiBackgroundWorkPanel({
      agentTeam,
      backgroundTasks,
      activeSessionId: () => "root",
      onOpenAgent: vi.fn(),
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });

    const rendered = stripVTControlCharacters(panel.render(100).join("\n"));

    expect(rendered).toContain("Tasks");
    expect(rendered).toContain("4 total · 2 active · 1 failed");
    expect(rendered).toContain("[Agent] reviewer");
    expect(rendered).toContain("Reading task-panel.ts");
    expect(rendered).toContain("[Bash] pnpm typecheck");
    expect(rendered).toContain("[Bash] build docs");
    expect(rendered).toContain("[Bash] completed validation");
    expect(rendered).toContain("Enter open transcript");
    expect(agentTeam).toHaveBeenCalledOnce();
  });

  it("opens Agent transcripts and inspects Runtime task details without mutating them", () => {
    const onOpenAgent = vi.fn();
    const requestRender = vi.fn();
    const panel = new TuiBackgroundWorkPanel({
      agentTeam: teamSnapshot,
      backgroundTasks,
      activeSessionId: () => "root",
      onOpenAgent,
      onCancel: vi.fn(),
      requestRender,
    });

    panel.handleInput("\r");
    expect(onOpenAgent).toHaveBeenCalledWith("reviewer");

    panel.handleInput("\u001B[B");
    panel.handleInput("\r");
    let rendered = stripVTControlCharacters(panel.render(80).join("\n"));
    expect(rendered).toContain("Background task · Running");
    expect(rendered).toContain("pnpm typecheck");
    expect(rendered).toContain("bg-running");

    panel.handleInput("\u001B");
    rendered = stripVTControlCharacters(panel.render(80).join("\n"));
    expect(rendered).toContain("[Agent] reviewer");
    expect(rendered).toContain("[Bash] pnpm typecheck");
    expect(requestRender).toHaveBeenCalled();

    panel.handleInput("\u001B[B");
    panel.handleInput("\r");
    rendered = stripVTControlCharacters(panel.render(80).join("\n"));
    expect(rendered).toContain("Background task · Failed");
    expect(rendered).toContain("exit code 1");
    expect(rendered).toContain("unsafe");
    expect(rendered).not.toContain("https://example.com");
  });

  it("keeps the full multiline command, task ID and failure reason readable at narrow widths", () => {
    const command = `printf "开始"\n${"x".repeat(140)}\n\n  echo "command-end"`;
    const task = {
      ...backgroundTasks()[1]!,
      taskId: `bg-${"a".repeat(50)}`,
      description: "short summary...",
      command: `${command}\u001B]52;c;Y2xpcGJvYXJk\u0007`,
      lastError: `exit code 1\n${"e".repeat(130)}\nPermission denied at error-end`,
    };
    const panel = new TuiBackgroundWorkPanel({
      agentTeam: teamSnapshot,
      backgroundTasks: () => [task],
      activeSessionId: () => "root",
      onOpenAgent: vi.fn(),
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });
    panel.handleInput("\u001B[B");
    expect(stripVTControlCharacters(panel.render(60).join("\n"))).toContain(
      "short summary...",
    );
    panel.handleInput("\r");
    for (const width of [16, 24, 40, 80, 120]) {
      const lines = panel.render(width);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      const body = lines.map((line) =>
        stripVTControlCharacters(line)
          .replace(/^│ | │$/gu, "")
          .trimEnd(),
      );
      const text = body.join("\n");
      expect(text).not.toContain("short summary...");
      expect(text).not.toContain("Y2xpcGJvYXJk");
      expect(text).not.toContain("…");
      expect(text.replace(/\s/gu, "")).toContain(
        task.lastError.replace(/\s/gu, ""),
      );
      expect(text.replace(/\s/gu, "")).toContain(command.replace(/\s/gu, ""));
      expect(text.replace(/\s/gu, "")).toContain(task.taskId);
    }
    const wide = stripVTControlCharacters(panel.render(120).join("\n"));
    expect(wide).toContain('  echo "command-end"');
    expect(wide.indexOf("Error")).toBeLessThan(wide.indexOf("Command"));
    panel.handleInput("\u001B");
    expect(stripVTControlCharacters(panel.render(60).join("\n"))).toContain(
      "short summary...",
    );
  });

  it("pages through long details and returns to the selected task after resize", async () => {
    const terminal = new VirtualTerminal(60, 16);
    const tui = new TuiAltScreen(terminal);
    const task = {
      ...backgroundTasks()[1]!,
      command: `${Array.from({ length: 50 }, (_, i) => `echo line-${i}`).join("\n")}\necho command-end`,
    };
    const panel = new TuiBackgroundWorkPanel({
      agentTeam: teamSnapshot,
      backgroundTasks: () => [task],
      activeSessionId: () => "root",
      onOpenAgent: vi.fn(),
      onCancel: vi.fn(),
      requestRender: () => tui.requestRender(),
    });
    tui.setLayoutRoot(panel.layoutRoot);
    tui.setFocus(panel);
    tui.start();
    try {
      await terminal.waitForRender();
      terminal.sendInput("\u001B[B");
      terminal.sendInput("\r");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("exit code 1");
      for (let i = 0; i < 15; i++) {
        terminal.sendInput("\u001B[6~");
        await terminal.waitForRender();
      }
      expect(terminal.getViewport().join("\n")).toContain("command-end");
      terminal.resize(40, 12);
      await terminal.waitForRender();
      for (let i = 0; i < 15; i++) {
        terminal.sendInput("\u001B[6~");
        await terminal.waitForRender();
      }
      expect(terminal.getViewport().join("\n")).toContain("command-end");
      terminal.sendInput("\u001B[5~");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).not.toContain("command-end");
      terminal.sendInput("\u001B");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("[Bash] build docs");
      terminal.sendInput("\r");
      await terminal.waitForRender();
      expect(terminal.getViewport().join("\n")).toContain("exit code 1");
    } finally {
      tui.stop();
    }
  });

  it("labels legacy tasks without a full command as descriptions", () => {
    const panel = new TuiBackgroundWorkPanel({
      agentTeam: teamSnapshot,
      backgroundTasks,
      activeSessionId: () => "root",
      onOpenAgent: vi.fn(),
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });
    panel.handleInput("\u001B[B");
    panel.handleInput("\r");
    const text = stripVTControlCharacters(panel.render(80).join("\n"));
    expect(text).toContain("Description");
    expect(text).toContain("pnpm typecheck");
    expect(text).not.toContain("Command");
  });

  it("closes from the list, keeps detail escape local, and respects narrow widths", () => {
    const onCancel = vi.fn();
    const panel = new TuiBackgroundWorkPanel({
      agentTeam: teamSnapshot,
      backgroundTasks,
      activeSessionId: () => "root",
      onOpenAgent: vi.fn(),
      onCancel,
      requestRender: vi.fn(),
    });

    for (const width of [1, 8, 24, 40]) {
      expect(
        panel.render(width).every((line) => visibleWidth(line) <= width),
      ).toBe(true);
    }

    panel.handleInput("\u001B[B");
    panel.handleInput("\r");
    panel.handleInput("\u001B");
    expect(onCancel).not.toHaveBeenCalled();
    panel.handleInput("\u001B");
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("keeps a selected task visible and stable when Agent rows are inserted ahead of it", () => {
    let snapshot = teamSnapshot();
    const panel = new TuiBackgroundWorkPanel({
      agentTeam: () => snapshot,
      backgroundTasks,
      activeSessionId: () => "root",
      onOpenAgent: vi.fn(),
      onCancel: vi.fn(),
      requestRender: vi.fn(),
    });
    const viewport = (
      panel as unknown as {
        bodyViewport: {
          readonly scrollTop: number;
          updateLayout(
            contentHeight: number,
            viewportHeight: number,
            requestRender: () => void,
          ): void;
        };
      }
    ).bodyViewport;

    panel.render(80);
    panel.handleInput("\u001B[B");
    panel.handleInput("\u001B[B");
    viewport.updateLayout(3, 1, vi.fn());
    expect(viewport.scrollTop).toBe(2);

    snapshot = {
      ...snapshot,
      summary: { ...snapshot.summary, total: 4, running: 4 },
      members: [
        ...snapshot.members,
        ...["planner", "builder", "verifier"].map((sessionId) => ({
          ...snapshot.members[0]!,
          sessionId,
          agentName: sessionId,
        })),
      ],
    };
    panel.render(80);
    viewport.updateLayout(6, 1, vi.fn());

    expect(viewport.scrollTop).toBe(5);
    panel.handleInput("\r");
    expect(stripVTControlCharacters(panel.render(80).join("\n"))).toContain(
      "Background task · Failed",
    );
  });
});

describe('Tasks in the regular terminal viewport', () => {
  it.each([1, 8, 15])(
    'keeps tasks reachable after shrinking by %i rows without leaking duplicate tasks into scrollback',
    async (shrinkRows) => {
      const terminal = new VirtualTerminal(80, 16);
      const tui = new TuiMainScreen(terminal);
      const chatLines = Array.from({ length: 40 }, (_, index) => `chat-line-${index}`);
      tui.addChild({
        render: () => [...chatLines, 'COMPOSER', 'STATUS'],
        // This fixture settles background content while the transient footer stays fixed.
        getViewportLayoutKey: () => 'composer:1,status:1',
        invalidate() {},
      });
      const tasks = Array.from({ length: 30 }, (_, index) => ({
        ...backgroundTasks()[0]!,
        taskId: `task-${index}`,
        description: `task-row-${String(index).padStart(2, '0')}`,
      }));
      const panel = new TuiBackgroundWorkPanel({
        agentTeam: () => ({ ...teamSnapshot(), members: [] }),
        backgroundTasks: () => tasks,
        activeSessionId: () => 'root',
        onOpenAgent: vi.fn(),
        onCancel: vi.fn(),
        requestRender: () => tui.requestRender(),
      });
      tui.start();
      try {
        await terminal.waitForRender();
        chatLines.splice(-shrinkRows);
        tui.renderNow();
        await terminal.flush();
        // Visible shrink preserves native history with temporary screen space.
        // The 15-row case also removes historical text and still reconstructs.
        const afterShrink = shrinkRows === 15
          ? [...chatLines, 'COMPOSER', 'STATUS'].slice(-terminal.rows)
          : [...Array<string>(shrinkRows).fill(''), ...chatLines.slice(26), 'COMPOSER', 'STATUS'];
        expect(terminal.getViewport()).toEqual(
          afterShrink,
        );
        const presenter = new TuiOverlayRegularFeaturePresenter(terminal, tui, () =>
          tui.requestRender(),
        );
        let handle = presenter.show(panel, panel);
        tui.setFocus(handle.focus);
        tui.renderNow();
        await terminal.flush();
        expect(terminal.getViewport().join('\n')).toContain('Tasks');
        expect(terminal.getViewport().join('\n')).toContain('task-row-00');
        handle.close();
        tui.renderNow();
        await terminal.flush();
        expect(terminal.getViewport()).toEqual(
          [...chatLines, 'COMPOSER', 'STATUS'].slice(-terminal.rows),
        );
        expect(terminal.getScrollBuffer()).toEqual([...chatLines, 'COMPOSER', 'STATUS']);
        handle = presenter.show(panel, panel);
        tui.setFocus(handle.focus);
        tui.renderNow();
        await terminal.flush();
        const seen = new Set<string>();
        for (let index = 0; index < 30; index++) {
          chatLines.push(`live-chat-${index}`);
          tui.renderNow();
          await terminal.flush();
          const viewport = terminal.getViewport().join('\n');
          for (const match of viewport.matchAll(/task-row-\d+/g)) seen.add(match[0]);
          expect(viewport).toContain(`task-row-${String(index).padStart(2, '0')}`);
          expect(terminal.getScrollBuffer().slice(0, -terminal.rows).join('\n')).not.toContain(
            'task-row-',
          );
          terminal.sendInput('\u001B[B');
        }
        expect(seen.size).toBe(30);
        terminal.sendInput('\u001B[6~');
        tui.renderNow();
        await terminal.flush();
        terminal.sendInput('\u001B[5~');
        tui.renderNow();
        await terminal.flush();
        terminal.resize(60, 12);
        await terminal.waitForRender();
        terminal.sendInput('\u001B[B');
        tui.renderNow();
        await terminal.flush();
        expect(terminal.getViewport().join('\n')).toContain('Tasks');
        handle.close();
        tui.renderNow();
        await terminal.flush();
        await vi.waitFor(async () => {
          await terminal.flush();
          expect(terminal.getScrollBuffer().join('\n')).not.toContain('task-row-');
        });
        for (const line of chatLines)
          expect(terminal.getScrollBuffer().filter((row) => row === line)).toHaveLength(1);
        expect(terminal.getViewport().join('\n')).toContain('STATUS');
      } finally {
        tui.stop();
      }
    },
  );
});
