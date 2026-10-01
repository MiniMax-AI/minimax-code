import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProcessTerminal,
  TuiMainScreen,
  CURSOR_MARKER,
} from "../../src/tui/engine/public.js";
import { createObservedTerminal } from "../../src/tui/platform/observed-terminal.js";
import { TuiExternalEditorFlow } from "../../src/tui/controller/interaction/external-editor-flow.js";
import { VirtualTerminal } from "../pi-084-upstream/virtual-terminal.js";

type WriteCallback = (
  error: NodeJS.ErrnoException | null,
  bytes: number,
) => void;
const { write } = vi.hoisted(() => ({
  write:
    vi.fn<
      (
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: null,
        callback: WriteCallback,
      ) => void
    >(),
}));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  write,
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  write.mockReset();
});

function outputHarness() {
  const stdout = Object.assign(new PassThrough(), {
    isTTY: true,
    fd: 1,
    columns: 80,
    rows: 24,
  });
  const synchronousWrite = vi.spyOn(stdout, "write").mockReturnValue(true);
  vi.spyOn(process, "stdout", "get").mockReturnValue(
    stdout as typeof process.stdout,
  );
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  const pending: {
    buffer: Buffer;
    offset: number;
    length: number;
    callback: WriteCallback;
  }[] = [];
  const delivered: Buffer[] = [];
  write.mockImplementation(
    (_fd, buffer, offset, length, _position, callback) => {
      pending.push({ buffer, offset, length, callback });
    },
  );
  const complete = (limit = Infinity) => {
    const next = pending.shift();
    if (!next) throw new Error("No pending write");
    const length = Math.min(limit, next.length);
    delivered.push(next.buffer.subarray(next.offset, next.offset + length));
    next.callback(null, length);
  };
  return { stdout, synchronousWrite, pending, delivered, complete };
}

describe("terminal output backpressure", () => {
  it("keeps input responsive and orders control output behind a partially written replay", async () => {
    const h = outputHarness();
    const stdin = Object.assign(new PassThrough(), {
      isRaw: false,
      setRawMode: vi.fn(),
    });
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      stdin as typeof process.stdin,
    );
    vi.spyOn(process, "kill").mockReturnValue(true);
    vi.stubEnv("TERM_PROGRAM", "");
    const terminal = new ProcessTerminal();
    const input = vi.fn();
    terminal.start(input, () => {});
    while (h.pending.length) h.complete();
    h.delivered.length = 0;
    h.synchronousWrite.mockClear();
    const frame = `\x1b[?2026h${"中文😀\r\n".repeat(10000)}INPUT_READY\x1b[?2026l`;
    try {
      terminal.write(frame);
      expect(h.synchronousWrite.mock.calls.length).toBe(0);
      expect(terminal.outputPending).toBe(true);
      stdin.emit("data", "x");
      expect(input).toHaveBeenCalledWith("x");
      terminal.setTitle("after frame");
      terminal.stop();
      let drained = false;
      const done = terminal.drainOutput().then(() => {
        drained = true;
      });
      h.complete(7); // Split a UTF-8 code point across OS writes.
      expect(drained).toBe(false);
      expect(h.pending).toHaveLength(1);
      while (h.pending.length) h.complete();
      await done;
      const wire = Buffer.concat(h.delivered).toString("utf8");
      expect(wire.startsWith(frame)).toBe(true);
      expect(wire.slice(frame.length)).toContain("\x1b]0;after frame\x07");
      expect(wire.endsWith("\x1b[<u")).toBe(true);
      expect(terminal.outputPending).toBe(false);
      expect(h.synchronousWrite.mock.calls.length).toBe(0);
    } finally {
      terminal.stop();
      while (h.pending.length) h.complete();
    }
  });

  it("reports async terminal failures and releases drain waiters without retrying a dead fd", async () => {
    const h = outputHarness();
    const onError = vi.fn();
    h.stdout.on("error", onError);
    const terminal = new ProcessTerminal();
    terminal.write("x".repeat(100000));
    expect(h.pending).toHaveLength(1);
    const error = Object.assign(new Error("closed"), { code: "EPIPE" });
    const failed = expect(terminal.drainOutput()).rejects.toBe(error);
    h.pending.shift()!.callback(error, 0);
    await failed;
    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(terminal.outputPending).toBe(false);
    expect(() => terminal.write("later")).not.toThrow();
    expect(h.pending).toHaveLength(0);
  });

  it("retries a transient write failure at the same byte offset", async () => {
    const h = outputHarness();
    const terminal = new ProcessTerminal();
    terminal.write("中文 and ordered output");
    const first = h.pending.shift()!;
    first.callback(
      Object.assign(new Error("interrupted"), { code: "EINTR" }),
      0,
    );
    await vi.waitFor(() => expect(h.pending).toHaveLength(1));
    expect(h.pending[0]!.offset).toBe(0);
    h.complete(1);
    expect(h.pending[0]!.offset).toBe(1);
    while (h.pending.length) h.complete();
    await terminal.drainOutput();
    expect(Buffer.concat(h.delivered).toString()).toBe(
      "中文 and ordered output",
    );
  });

  it("waits for terminal output before starting the external editor", async () => {
    let release: () => void = () => {};
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const editDraft = vi.fn(async () => "edited draft");
    const start = vi.fn();
    const editor = { getExpandedText: () => "draft", setText: vi.fn() };
    const flow = new TuiExternalEditorFlow({
      editor,
      tui: { stop: () => stopped, start, requestRender: vi.fn() },
      workspaceDir: "/workspace",
      configuredCommand: "editor",
      editDraft,
      isAppStopped: () => false,
      append: vi.fn(),
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });
    const opened = flow.open();
    await Promise.resolve();
    expect(editDraft).not.toHaveBeenCalled();
    release();
    await opened;
    expect(editDraft).toHaveBeenCalledOnce();
    expect(editor.setText).toHaveBeenCalledWith("edited draft");
    expect(start).toHaveBeenCalledOnce();
  });

  it("does not launch an editor if shutdown occurs during the output drain", async () => {
    let release!: () => void;
    const drained = new Promise<void>((resolve) => {
      release = resolve;
    });
    let appStopped = false;
    const editDraft = vi.fn(async () => "edited");
    const start = vi.fn();
    const flow = new TuiExternalEditorFlow({
      editor: { getExpandedText: () => "draft", setText: vi.fn() },
      tui: { stop: () => drained, start, requestRender: vi.fn() },
      workspaceDir: "/workspace",
      configuredCommand: "editor",
      editDraft,
      isAppStopped: () => appStopped,
      append: vi.fn(),
      setHint: vi.fn(),
      onChanged: vi.fn(),
    });
    const opened = flow.open();
    appStopped = true;
    release();
    await opened;
    expect(editDraft).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it.each([
    { deferred: true, preserveScreen: false },
    { deferred: false, preserveScreen: false },
    { deferred: true, preserveScreen: true },
    { deferred: false, preserveScreen: true },
  ])(
    "preserves final output without changing mode-switch snapshots: %j",
    async ({ deferred, preserveScreen }) => {
      class HeldTerminal extends VirtualTerminal {
        outputPending = false;
        writes: string[] = [];
        release: (() => void) | undefined;
        drainOutput() {
          return new Promise<void>((resolve) => {
            this.release = resolve;
          });
        }
        override write(data: string) {
          this.writes.push(data);
          super.write(data);
        }
      }
      const terminal = new HeldTerminal(80, 24);
      const tui = new TuiMainScreen(terminal);
      let response = "initial response";
      tui.addChild({
        render: () => [response, `input${CURSOR_MARKER}`],
        invalidate() {},
      });
      tui.start();
      tui.renderNow();
      await terminal.flush();
      terminal.writes = [];
      terminal.outputPending = true;
      response = "FINAL_RESPONSE";
      if (deferred) tui.renderNow();
      else tui.requestImmediateRender();
      const captured = tui.captureRenderState();
      tui.stop({ preserveScreen });
      terminal.outputPending = false;
      terminal.release?.();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await terminal.flush();
      expect(terminal.writes.join("").includes(response)).toBe(!preserveScreen);
      if (preserveScreen) expect(tui.captureRenderState()).toEqual(captured);
      else expect(terminal.getScrollBuffer().join("\n")).toContain(response);
    },
  );

  it("waits for keyboard-disable output before starting the input drain idle window", async () => {
    vi.useFakeTimers();
    const h = outputHarness();
    const stdin = Object.assign(new PassThrough(), {
      isRaw: false,
      setRawMode: vi.fn(),
    });
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      stdin as typeof process.stdin,
    );
    vi.spyOn(process, "kill").mockReturnValue(true);
    vi.stubEnv("TERM_PROGRAM", "");
    const terminal = new ProcessTerminal();
    const input = vi.fn();
    terminal.start(input, () => {});
    while (h.pending.length) h.complete();
    terminal.write("held replay");
    let drained = false;
    const done = terminal.drainInput(1000, 50).then(() => {
      drained = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(drained).toBe(false);
      stdin.emit("data", "x");
      expect(input).not.toHaveBeenCalled();
      while (h.pending.length) h.complete();
      await vi.advanceTimersByTimeAsync(25);
      expect(drained).toBe(false);
      stdin.emit("data", "y");
      await vi.advanceTimersByTimeAsync(75);
      await done;
      expect(input).not.toHaveBeenCalled();
      stdin.emit("data", "z");
      expect(input).toHaveBeenCalledExactlyOnceWith("z");
    } finally {
      while (h.pending.length) h.complete();
      await vi.advanceTimersByTimeAsync(1000);
      await done;
      terminal.stop();
      while (h.pending.length) h.complete();
    }
  });

  it("coalesces frames through the observed terminal while retaining the latest input and history", async () => {
    class BackpressuredTerminal extends VirtualTerminal {
      outputPending = false;
      writes: string[] = [];
      release: (() => void) | undefined;
      drainOutput(): Promise<void> {
        return new Promise((resolve) => {
          this.release = resolve;
        });
      }
      override write(data: string): void {
        this.writes.push(data);
        super.write(data);
      }
    }
    const terminal = new BackpressuredTerminal(80, 24);
    const tui = new TuiMainScreen(createObservedTerminal(terminal, vi.fn()));
    let tail = "first";
    const history = Array.from({ length: 80 }, (_, i) => `History ${i}`);
    tui.addChild({
      render: () => [...history, `${tail}${CURSOR_MARKER}`, "status"],
      invalidate() {},
    });
    tui.renderNow();
    await terminal.flush();
    terminal.writes = [];
    terminal.outputPending = true;
    for (const value of ["stale 1", "stale 2", "latest input"]) {
      tail = value;
      tui.renderNow();
    }
    expect(terminal.writes).toEqual([]);
    terminal.outputPending = false;
    terminal.release?.();
    await vi.waitFor(() =>
      expect(terminal.writes.join("")).toContain("latest input"),
    );
    await terminal.flush();
    terminal.scrollLines(10000);
    expect(terminal.getViewport().slice(-2)).toEqual([
      "latest input",
      "status",
    ]);
    expect(
      terminal.getScrollBuffer().filter((line) => line.startsWith("History ")),
    ).toEqual(history);
    expect(terminal.writes.join("")).not.toContain("stale");
    tui.stop();
  });
});
