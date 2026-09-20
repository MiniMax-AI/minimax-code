import { describe, expect, it, vi } from "vitest";

import { createTuiProgram, type CreateTuiProgramOptions } from "../../src/cli/program.js";

function program(runExec: CreateTuiProgramOptions["runExec"]) {
  return createTuiProgram({
    version: "1.2.3",
    launchTui: async () => undefined,
    runExec,
    runLogin: async () => undefined,
    runLogout: async () => undefined,
    runUpdate: async () => undefined,
  });
}

describe("CLI sandbox contract", () => {
  it("advertises --sandbox on exec and exec review, not interactive startup", () => {
    const built = program(async () => undefined);
    const exec = built.commands.find((command) => command.name() === "exec");
    const review = exec?.commands.find((command) => command.name() === "review");
    expect(exec?.helpInformation()).toContain("--sandbox <mode>");
    expect(review?.helpInformation()).toContain("--sandbox <mode>");
    expect(built.helpInformation()).not.toContain("--sandbox <mode>");
  });

  it.each(["read-only", "workspace-write", "danger-full-access"])(
    "forwards %s to exec",
    async (mode) => {
      const runExec = vi.fn(async () => undefined);
      await program(runExec).parseAsync(["exec", "--sandbox", mode, "do something"], {
        from: "user",
      });
      expect(runExec).toHaveBeenCalledWith(
        "do something",
        expect.objectContaining({ sandbox: mode }),
      );
    },
  );

  it("keeps the field absent when --sandbox is omitted", async () => {
    const runExec = vi.fn(async () => undefined);
    await program(runExec).parseAsync(["exec", "do something"], {
      from: "user",
    });
    expect(runExec.mock.calls[0]?.[1]).not.toHaveProperty("sandbox");
  });

  it("rejects invalid modes before invoking exec", async () => {
    const runExec = vi.fn(async () => undefined);
    const built = program(runExec);
    built.exitOverride();
    built.configureOutput({
      writeErr: () => undefined,
      writeOut: () => undefined,
    });
    const exec = built.commands.find((command) => command.name() === "exec");
    exec?.exitOverride();
    exec?.configureOutput({
      writeErr: () => undefined,
      writeOut: () => undefined,
    });
    await expect(
      built.parseAsync(["exec", "--sandbox", "true", "do something"], {
        from: "user",
      }),
    ).rejects.toThrow();
    expect(runExec).not.toHaveBeenCalled();
  });
});
