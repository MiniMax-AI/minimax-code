import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { BashExecutionError, createBashTool, createLocalBashOperations } from "../src/core/tools/bash.js";

describe("local Bash process observations", () => {
  it.skipIf(process.platform === "win32")("preserves a real terminating signal and rejects the interrupted command", async () => {
    const result = await createLocalBashOperations().exec("kill -TERM $$", tmpdir(), { onData: () => {} });
    expect(result).toEqual({ exitCode: null, signal: "SIGTERM" });
    const failed = createBashTool(tmpdir()).execute("signal-exit", {
      command: "printf 'partial-output'; kill -TERM $$", timeout: 3,
    });
    await expect(failed).rejects.toBeInstanceOf(BashExecutionError);
    await expect(failed).rejects.toMatchObject({
      message: "partial-output\n\nCommand terminated by signal SIGTERM",
      details: {
        execution: { status: "failed", reason: "signaled", exitCode: null, signal: "SIGTERM" },
        processOutput: { stdout: "partial-output", stderr: "", exitCode: null },
      },
    });
  });
  it("keeps separate streams and the exit code on failed commands", async () => {
    const tool = createBashTool(tmpdir(), { operations: {
      separatesOutputStreams: true,
      exec: async (_command, _cwd, options) => {
        options.onData(Buffer.from("out"), "stdout");
        options.onData(Buffer.from("err"), "stderr");
        return { exitCode: 7 };
      },
    } });
    await expect(tool.execute("failed", { command: "unused" })).rejects.toMatchObject({
      details: {
        execution: { status: "failed", reason: "exited", exitCode: 7 },
        processOutput: { stdout: "out", stderr: "err", exitCode: 7, interrupted: false },
      },
    });
  });
  it("rejects an unknown exit while retaining output from custom operations", async () => {
    const tool = createBashTool(tmpdir(), {
      operations: { exec: async (_command, _cwd, options) => {
        options.onData(Buffer.from("partial-output"));
        return { exitCode: null };
      } },
    });
    await expect(tool.execute("unknown-exit", { command: "unused" })).rejects.toThrow(
      "partial-output\n\nCommand terminated without an exit code",
    );
  });
  it("preserves a spawn failure code without inventing an exit code", async () => {
    const tool = createBashTool(tmpdir(), {
      operations: {
        exec: async (_command, _cwd, options) => {
          options.onProcessEvent?.({ type: "spawn_failed", processRole: "shell" });
          throw Object.assign(new Error("spawn failed"), { code: "ENOENT" });
        },
      },
    });
    await expect(tool.execute("spawn-error", { command: "unused" })).rejects.toMatchObject({
      code: "ENOENT",
      details: {
        execution: { status: "failed", reason: "spawn_failed", exitCode: null, errorCode: "ENOENT" },
      },
    });
  });
  it("observes a real shell spawn without changing a nonzero exit", async () => {
    const onProcessEvent = vi.fn();
    const result = await createLocalBashOperations().exec("exit 7", tmpdir(), { onData: () => {}, onProcessEvent });
    expect(result.exitCode).toBe(7);
    expect(onProcessEvent).toHaveBeenCalledWith({ type: "spawned", processRole: "shell" });
  });
  it("does not fabricate a spawn before cancellation or cwd validation", async () => {
    const onProcessEvent = vi.fn();
    await expect(createLocalBashOperations().exec("exit 0", tmpdir(), {
      onData: () => {}, signal: AbortSignal.abort(), onProcessEvent,
    })).rejects.toThrow("aborted");
    expect(onProcessEvent).not.toHaveBeenCalled();
  });
  it("reports timeout from the timer and ignores throwing observers", async () => {
    const onProcessEvent = vi.fn(() => { throw new Error("observer failed"); });
    const command = process.platform === "win32" ? "Start-Sleep -Seconds 3" : "sleep 3";
    await expect(createLocalBashOperations().exec(command, tmpdir(), {
      onData: () => {}, timeout: 0.05, onProcessEvent,
    })).rejects.toThrow("timeout:");
    expect(onProcessEvent).toHaveBeenCalledWith({ type: "timer_started", processRole: "shell", atMs: expect.any(Number) });
    expect(onProcessEvent).toHaveBeenCalledWith({ type: "timeout", processRole: "shell" });
  });
});
