import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { SANDBOX_MODES, type SandboxMode } from "@mavis/config";

import { resolveTuiExecInvocation, type RawTuiExecOptions } from "../../src/headless/invocation.js";
import { exitCodeForExecError, TuiExecError } from "../../src/headless/exit-policy.js";
import { runTuiExecCommand } from "../../src/cli/run-exec-command.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mcode-headless-sandbox-"));
  roots.push(root);
  return root;
}

async function resolve(options: Partial<RawTuiExecOptions>) {
  return resolveTuiExecInvocation(
    "do something",
    { cwd: await workspace(), ...options } as RawTuiExecOptions,
    vi.fn(async () => ""),
  );
}

describe("headless exec --sandbox", () => {
  it.each(SANDBOX_MODES)("accepts %s", async (mode) => {
    await expect(resolve({ sandbox: mode })).resolves.toMatchObject({
      sandboxMode: mode,
    });
  });

  it("does not override configured sandbox when omitted", async () => {
    const invocation = await resolve({});
    expect(invocation.sandboxMode).toBeUndefined();
    expect("sandboxMode" in invocation).toBe(false);
  });

  it.each(["true", "false", "full", "read_only", "", "danger_full_access"])(
    "rejects invalid value %s with a nonzero invocation failure",
    async (value) => {
      const failure = await resolve({ sandbox: value }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TuiExecError);
      expect((failure as TuiExecError).message).toContain("--sandbox is invalid");
      expect(exitCodeForExecError(failure as TuiExecError)).toBeGreaterThan(0);
    },
  );

  it("uses the same modes for exec review", async () => {
    const cwd = await workspace();
    for (const mode of SANDBOX_MODES satisfies readonly SandboxMode[]) {
      await expect(
        resolveTuiExecInvocation(
          undefined,
          { review: true, cwd, sandbox: mode },
          vi.fn(async () => ""),
        ),
      ).resolves.toMatchObject({
        sandboxMode: mode,
        reviewRequest: { scope: "local_changes" },
      });
    }
  });

  it("keeps sandbox independent from permission policy", async () => {
    await expect(resolve({ sandbox: "read-only", permission: "full" })).resolves.toMatchObject({
      sandboxMode: "read-only",
      permission: "full",
    });
  });

  it("passes an explicit mode through command preparation into runtime creation", async () => {
    const createRuntime = vi.fn(async () => ({ adapter: {} }) as never);
    const processRef = new EventEmitter() as EventEmitter & {
      exitCode?: number | string;
    };
    await runTuiExecCommand("do something", { sandbox: "read-only" }, "test", {
      processRef,
      resolveInvocation: vi.fn(async () => ({
        prompt: "do something",
        workspaceDir: process.cwd(),
        attachments: [],
        continueSession: false,
        permission: "smart" as const,
        sandboxMode: "read-only" as const,
        format: "text" as const,
      })) as never,
      resolveDataDir: async () => "/tmp/mcode-test",
      createRuntime,
      runExec: vi.fn(async () => 0),
      shutdownRuntime: vi.fn(async () => false),
    });

    expect(createRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        sandboxMode: "read-only",
        surface: "headless",
      }),
      {},
    );
    expect(processRef.exitCode).toBe(0);
  });
});
