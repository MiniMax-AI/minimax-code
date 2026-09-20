import { describe, expect, it, vi } from "vitest";
import type { EffectiveSandboxMode, SandboxMode } from "@mavis/config";

import { TuiSandboxModeFlow } from "../../src/tui/controller/interaction/sandbox-mode-flow.js";

function harness(options: {
  current?: EffectiveSandboxMode;
  setImpl?: (mode: SandboxMode) => Promise<EffectiveSandboxMode>;
}) {
  const appended: { content: string; kind?: string }[] = [];
  const hints: (string | undefined)[] = [];
  const getSandboxMode = vi.fn(async () => options.current);
  const setSandboxMode = vi.fn(async (mode: SandboxMode) =>
    options.setImpl
      ? options.setImpl(mode)
      : ({ mode, deleteGuard: false } satisfies EffectiveSandboxMode),
  );
  const flow = new TuiSandboxModeFlow({
    runtime: { getSandboxMode, setSandboxMode },
    append: (content, kind) => appended.push({ content, ...(kind ? { kind } : {}) }),
    setHint: (message) => hints.push(message),
    onChanged: () => undefined,
  });
  return { flow, appended, hints, getSandboxMode, setSandboxMode };
}

describe("TuiSandboxModeFlow", () => {
  it("reports the refreshed effective mode", async () => {
    const h = harness({
      current: { mode: "workspace-write", deleteGuard: false },
    });
    await h.flow.refresh();
    h.flow.showStatus();
    expect(h.appended[0]?.content).toContain("workspace-write");
  });

  it("reports delete guard instead of plain full access", async () => {
    const h = harness({
      current: { mode: "danger-full-access", deleteGuard: true },
    });
    await h.flow.refresh();
    h.flow.showStatus();
    expect(h.appended[0]?.content).toContain("delete guard on");
  });

  it.each(["read-only", "workspace-write", "danger-full-access"] satisfies SandboxMode[])(
    "applies %s and confirms the runtime result",
    async (mode) => {
      const h = harness({
        current: { mode: "workspace-write", deleteGuard: false },
      });
      await h.flow.set(mode);
      expect(h.setSandboxMode).toHaveBeenCalledWith(mode);
      expect(h.flow.snapshot().effective).toEqual({ mode, deleteGuard: false });
    },
  );

  it("keeps the previous mode visible when a restriction is rejected", async () => {
    const h = harness({
      current: { mode: "danger-full-access", deleteGuard: false },
      setImpl: async () => {
        throw new Error("Sandbox is not supported on this platform");
      },
    });
    await h.flow.refresh();
    await h.flow.set("read-only");
    expect(h.flow.snapshot().effective).toEqual({
      mode: "danger-full-access",
      deleteGuard: false,
    });
    expect(h.appended.at(-1)).toMatchObject({ kind: "warning" });
    expect(h.hints.at(-1)).toBe("Sandbox mode unchanged");
  });

  it("does not mutate after stop", async () => {
    const h = harness({
      current: { mode: "workspace-write", deleteGuard: false },
    });
    h.flow.stop();
    await h.flow.set("read-only");
    expect(h.setSandboxMode).not.toHaveBeenCalled();
  });
});
