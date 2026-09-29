import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  getSandboxConfigDefaults,
  type SandboxFilesystemPolicy,
} from "@mavis/config";

import { compileSandboxEffectivePolicy } from "../effective-policy.js";
import { resolveSandboxInvocationContext } from "../invocation-context.js";
import { SandboxObservability } from "../observability/sandbox-observability.js";
import {
  __getSrtCommandTextMapSizeForTest,
  __probeSrtCommandTextRegistrationForTest,
  createSrtMacosBackend,
} from "./srt-macos.js";
import type {
  SandboxBackendHooks,
  SandboxEffectivePolicy,
  SandboxWrapInput,
} from "./types.js";

type SrtMacosManagerPort = NonNullable<
  Parameters<typeof createSrtMacosBackend>[0]
>;
type SandboxInvocationFilesystemPolicy = SandboxWrapInput["filesystem"];

describe("srt-macos backend version pin", () => {
  it("reports the exact pinned SRT version by default without reading runtime files", () => {
    // Regression: the published TUI bundle does not ship the dependency's
    // package.json, so the default version must be a build-time constant that
    // stays in lockstep with the exact pin in packages/local-runtime-v2/package.json.
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../../../package.json", import.meta.url),
        "utf8",
      ),
    ) as { dependencies?: Record<string, string> };
    const pinned = manifest.dependencies?.["@minimax/mcode-sandbox-runtime"];
    expect(pinned).toBe("workspace:*");

    const backend = createSrtMacosBackend(fakeManager());
    expect(backend.describeVersions().backendVersion).toBe("0.0.74-mcode.2");

    const installed = createRequire(import.meta.url)(
      "@minimax/mcode-sandbox-runtime/package.json",
    ) as { version?: string };
    expect(installed.version).toBe(backend.describeVersions().backendVersion);
  });
});

describe("srt-macos backend", () => {
  it("preserves sandbox enforcement without an ask callback or idle log monitor", async () => {
    const manager = fakeManager();
    const backend = createSrtMacosBackend(manager, "0.0.74-mcode.rc.0");
    const policy = effectivePolicy("open", "allow_all");

    await backend.validatePolicy(policy);
    await backend.initialize(policy, hooks());

    expect(manager.initialize).toHaveBeenCalledTimes(1);
    const [config, askCallback, enableLogMonitor] =
      firstInitializeCall(manager);
    expect(askCallback).toBeUndefined();
    expect(enableLogMonitor).toBe(false);
    expect(config).toMatchObject({
      network: {
        allowedDomains: [],
        deniedDomains: [],
        strictAllowlist: true,
        allowAll: true,
        allowAllUnixSockets: true,
        allowLocalBinding: true,
      },
      filesystem: {
        disabled: false,
        allowWrite: [],
        unlinkAllowOnly: [],
        // Always allowed by product policy; the config toggle was retired.
        allowGitConfig: true,
      },
      enableWeakerNetworkIsolation: true,
      allowAppleEvents: true,
      allowSecurityServer: true,
      allowPty: true,
    });
    expect(backend.capabilities).toMatchObject({
      operationScopedDelete: "source-unlink",
      cleanupGranularity: "process-wide",
      credentialFileMask: "deny-only",
    });
  });

  it("compiles restricted local access to explicit closed fields", async () => {
    const manager = fakeManager();
    const backend = createSrtMacosBackend(manager, "test");
    const policy = effectivePolicy("restricted", "deny");

    await backend.validatePolicy(policy);
    await backend.initialize(policy, hooks());

    const [config] = firstInitializeCall(manager);
    expect(config.network).toMatchObject({
      allowedDomains: [],
      strictAllowlist: true,
      // Network is normalized to unrestricted even for a legacy deny config;
      // only the non-network localAccess effects stay restricted.
      allowAll: true,
      allowUnixSockets: [],
      allowAllUnixSockets: false,
      allowLocalBinding: false,
      allowMachLookup: [],
    });
    expect(config).toMatchObject({
      enableWeakerNetworkIsolation: false,
      allowAppleEvents: false,
      allowSecurityServer: false,
      allowPty: false,
    });
  });

  it("uses wrapWithSandbox with per-invocation filesystem and sanitized env", async () => {
    const manager = fakeManager();
    const backend = createSrtMacosBackend(manager, "test");
    const abortController = new AbortController();
    const baseEnv = { PATH: "/usr/bin", SECRET: undefined };

    const baseWrapInput = {
      command: "printf hello",
      cwd: "/workspace",
      baseEnv,
      sandboxTempDir: "/tmp/session-1",
      abortSignal: abortController.signal,
      commandId: "invocation-1",
      commandText: "printf hello",
      gitSafeDirectories: ["/workspace", "/workspace/.git"],
      filesystem: {
        allowRead: ["/workspace"],
        allowWrite: ["/workspace"],
        unlinkAllowOnly: ["/workspace"],
        denyRead: ["/runtime-data"],
        denyWrite: ["/workspace/.git/hooks"],
      },
    };
    const result = await backend.wrap(baseWrapInput);

    expect(manager.wrapWithSandbox).toHaveBeenCalledWith(
      "printf hello",
      undefined,
      {
        filesystem: {
          disabled: false,
          allowRead: ["/workspace"],
          allowWrite: ["/workspace"],
          unlinkAllowOnly: ["/workspace"],
          denyRead: ["/runtime-data"],
          denyWrite: ["/workspace/.git/hooks"],
          allowGitConfig: true,
        },
        git: { safeDirectories: ["/workspace", "/workspace/.git"] },
      },
      abortController.signal,
      {
        commandId: "invocation-1",
        commandText: "printf hello",
        baseEnv,
        sandboxTempDir: "/tmp/session-1",
      },
    );
    expect(result).toMatchObject({
      observation: {
        sampling: "wrap_requested",
        allow_git_config: true,
        network_decision_generation: null,
      },
      command: "wrapped command",
      // Recoverable deletion must stay inside the cage: without this flag
      // mavis-trash would hand the unlink to Finder, which runs unsandboxed
      // and would bypass unlinkAllowOnly entirely. GIT_TEMPLATE_DIR points at
      // an empty dir under sandboxTempDir so git init/clone skip hook-template
      // copies (an empty env value no longer skips on git >= 2.53).
      env: {
        GIT_TEMPLATE_DIR: "/tmp/session-1/git-templates-empty",
        ...baseEnv,
        MAVIS_TRASH_FORCE_MV: "1",
      },
      handle: { backendId: "srt-macos", invocationId: "invocation-1" },
    });

    const overridden = await backend.wrap({
      ...baseWrapInput,
      commandId: "invocation-2",
      baseEnv: { ...baseEnv, GIT_TEMPLATE_DIR: "/custom/templates" },
    });
    // A caller-provided template dir wins over the backend's skip default.
    expect(overridden.env.GIT_TEMPLATE_DIR).toBe("/custom/templates");
  });

  it("keeps invocation cleanup empty and reserves SRT cleanup for process retirement", async () => {
    const manager = fakeManager();
    const backend = createSrtMacosBackend(manager, "test");

    await backend.onInvocationEnd({
      backendId: "srt-macos",
      invocationId: "invocation-1",
    });
    expect(manager.cleanupAfterCommand).not.toHaveBeenCalled();

    await backend.onProcessCleanup();
    expect(manager.cleanupAfterCommand).toHaveBeenCalledTimes(1);
  });

  it("prepares network schema before publishing the live matcher", async () => {
    const manager = fakeManager();
    const backend = createSrtMacosBackend(manager, "test");
    const policy = effectivePolicy("open", "allow_all");
    await backend.validatePolicy(policy);
    await backend.initialize(policy, hooks());

    const prepared = await backend.prepareNetworkPolicy({
      mode: "deny",
      enforce: false,
      allowedDomains: [],
      deniedDomains: ["*"],
      strictAllowlist: true,
      allowAll: false,
    });
    backend.publishNetworkPolicy(prepared);

    expect(manager.updateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        network: expect.objectContaining({
          allowedDomains: [],
          deniedDomains: ["*"],
          strictAllowlist: true,
          allowAll: false,
        }),
      }),
    );
  });

  it("preserves a simultaneous local-access tightening across network publish", async () => {
    const manager = fakeManager();
    const backend = createSrtMacosBackend(manager, "test");
    const initial = effectivePolicy("open", "allow_all");
    await backend.validatePolicy(initial);
    await backend.initialize(initial, hooks());
    const restricted = effectivePolicy("restricted", "deny");

    await backend.validatePolicy(restricted);
    const prepared = await backend.prepareNetworkPolicy(restricted.network);
    backend.updateConfig(restricted);
    backend.publishNetworkPolicy(prepared);

    expect(manager.updateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        network: expect.objectContaining({
          allowUnixSockets: [],
          allowAllUnixSockets: false,
          allowLocalBinding: false,
          allowMachLookup: [],
        }),
        allowAppleEvents: false,
        allowSecurityServer: false,
        enableWeakerNetworkIsolation: false,
        allowPty: false,
      }),
    );
  });
});

describe("srt-macos backend failure and lifecycle edges", () => {
  it("supports direct initialization and update without a prior validation cache", async () => {
    const manager = fakeManager();
    const backend = createSrtMacosBackend(manager, "test");
    const initial = effectivePolicy("open", "allow_all");

    await backend.initialize(initial, hooks());
    await backend.initialize(initial, hooks());
    backend.updateConfig(effectivePolicy("restricted", "deny"));

    expect(manager.initialize).toHaveBeenCalledTimes(2);
    // The direct-update path skips the installed SRT schema, so it proves the
    // backend emits `network.disabled: true` for the unrestricted IR (the
    // 0.0.74-mcode.1 schema still strips the key on the validated paths).
    expect(manager.updateConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({
        allowSecurityServer: false,
        network: expect.objectContaining({
          allowAll: true,
          deniedDomains: [],
          disabled: true,
        }),
      }),
    );
  });

  it("unsubscribes and rethrows when SRT initialization fails", async () => {
    const unsubscribe = vi.fn();
    const manager = fakeManager();
    manager.getSandboxViolationStore = vi.fn(() => ({
      getTotalCount: () => 0,
      subscribe: () => unsubscribe,
    }));
    vi.mocked(manager.initialize).mockRejectedValueOnce(
      new Error("native init failed"),
    );
    const backend = createSrtMacosBackend(manager, "test");

    await expect(
      backend.initialize(effectivePolicy("open", "allow_all"), hooks()),
    ).rejects.toThrow("native init failed");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    await backend.reset();
  });

  it.each([
    [new Error("native wrap failed"), "native wrap failed"],
    ["opaque failure", "SRT failed to wrap command"],
  ])(
    "normalizes SRT wrap failures without retrying: %s",
    async (failure, message) => {
      const manager = fakeManager();
      vi.mocked(manager.wrapWithSandbox).mockRejectedValueOnce(failure);
      const backend = createSrtMacosBackend(manager, "test");

      await expect(backend.wrap(wrapInput())).rejects.toMatchObject({
        code: "SANDBOX_WRAP_FAILED",
        stage: "pre-spawn",
        message,
      });
    },
  );

  it("does not replay the retained history on subscription, unchanged count or reset", async () => {
    let total = 1;
    const history = [
      {
        line: "bash(123) deny(1) file-read-data /private",
        timestamp: new Date(1),
      },
    ];
    let listener: (items: typeof history) => void = () => undefined;
    const manager = fakeManager();
    manager.getSandboxViolationStore = vi.fn(() => ({
      getTotalCount: () => total,
      subscribe: (next: (items: typeof history) => void) => {
        listener = next;
        next(history);
        return () => undefined;
      },
    }));
    const reportViolation = vi.fn();
    const backend = createSrtMacosBackend(manager, "test");
    await backend.initialize(effectivePolicy("open", "allow_all"), {
      reportViolation,
    });
    listener(history);
    total = 0;
    listener(history);
    expect(reportViolation).not.toHaveBeenCalled();
    total = 1;
    listener(history);
    expect(reportViolation).toHaveBeenCalledTimes(1);
    await backend.reset();
  });

  it("forwards only new violations with optional opaque command attribution", async () => {
    let total = 0;
    let listener: (
      violations: Array<{ line: string; command?: string; timestamp: Date }>,
    ) => void = () => undefined;
    const unsubscribe = vi.fn();
    const manager = fakeManager();
    manager.getSandboxViolationStore = vi.fn(() => ({
      getTotalCount: () => total,
      subscribe: (
        next: Parameters<
          ReturnType<
            SrtMacosManagerPort["getSandboxViolationStore"]
          >["subscribe"]
        >[0],
      ) => {
        listener = next;
        return unsubscribe;
      },
    }));
    const reportViolation = vi.fn();
    const backend = createSrtMacosBackend(manager, "test");
    await backend.initialize(effectivePolicy("open", "allow_all"), {
      reportViolation,
    });

    total = 2;
    listener([
      {
        line: "bash(1234) deny(1) file-read-data /docs/a.txt",
        timestamp: new Date(10),
      },
      {
        line: "bash(1234) deny(1) file-write-create /docs/a.txt",
        command: "opaque-command",
        timestamp: new Date(20),
      },
    ]);

    expect(reportViolation).toHaveBeenCalledTimes(2);
    expect(reportViolation).toHaveBeenNthCalledWith(1, {
      category: "seatbelt-file",
      operation: "file-read-data",
      timestampMs: 10,
    });
    expect(reportViolation).toHaveBeenNthCalledWith(2, {
      category: "seatbelt-file",
      operation: "file-write-create",
      commandId: "opaque-command",
      timestampMs: 20,
    });
    await backend.reset();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe("srt-macos violation line classification", () => {
  it.each([
    [
      "bash(1234) deny(1) file-write-create /docs/a.txt",
      {
        operation: "write_denied",
        source: "profile",
        target: "filesystem-other",
      },
    ],
    [
      "bash(1234) deny(1) file-write-unlink /docs/a.txt",
      {
        operation: "delete_denied",
        source: "profile",
        target: "filesystem-other",
      },
    ],
    [
      // The tail names a delete, the kernel denied a read: the tail must not win.
      "bash(1234) deny(1) file-read-data /docs/delete-me.txt",
      {
        operation: "read_denied",
        source: "profile",
        target: "filesystem-other",
      },
    ],
    [
      "bash(1234) deny(1) network-outbound /private/var/run/mDNSResponder",
      { operation: "network_denied", source: "profile", target: "network" },
    ],
    [
      "bash(1234) deny(1) mach-lookup com.apple.example",
      {
        operation: "local_access_denied",
        source: "profile",
        target: "local-service",
      },
    ],
    [
      "deny http-request GET https://example.test/ (domain denied)",
      { operation: "network_denied", source: "proxy", target: "network" },
    ],
    [
      // A URL path may name any control-plane or filesystem word.
      "deny http-request POST https://example.test/seatbelt/workspace/delete (denied)",
      { operation: "network_denied", source: "proxy", target: "network" },
    ],
    [
      "deny network-outbound example.test:443 (domain denied)",
      { operation: "network_denied", source: "proxy", target: "network" },
    ],
    [
      // Unrecognized head: stable unknown bucket rather than a claimed category.
      "kernel sandbox violation on /workspace/git/network/temp",
      { operation: "unknown", source: "backend", target: "unknown" },
    ],
    [
      "bash(1234) deny(1) sysctl-read kern.boottime",
      { operation: "unknown", source: "backend", target: "unknown" },
    ],
  ] as const)(
    "classifies %s from its anchored head only",
    async (line, expected) => {
      const observability = new SandboxObservability();
      const { backend, emit } = await subscribedBackend(
        observability.backendHooks(),
      );

      emit([{ line, timestamp: new Date(1) }]);

      expect(observability.listViolations()).toEqual([
        expect.objectContaining(expected),
      ]);
      await backend.reset();
    },
  );
});

/** Drives the real store subscription so classification is covered end to end. */
async function subscribedBackend(backendHooks: SandboxBackendHooks): Promise<{
  backend: ReturnType<typeof createSrtMacosBackend>;
  emit: (
    violations: Array<{ line: string; command?: string; timestamp: Date }>,
  ) => void;
}> {
  let total = 0;
  let listener: (
    violations: Array<{ line: string; command?: string; timestamp: Date }>,
  ) => void = () => undefined;
  const manager = fakeManager();
  manager.getSandboxViolationStore = vi.fn(() => ({
    getTotalCount: () => total,
    subscribe: (
      next: Parameters<
        ReturnType<SrtMacosManagerPort["getSandboxViolationStore"]>["subscribe"]
      >[0],
    ) => {
      listener = next;
      return vi.fn();
    },
  }));
  const backend = createSrtMacosBackend(manager, "test");
  await backend.initialize(effectivePolicy("open", "allow_all"), backendHooks);
  return {
    backend,
    emit: (violations) => {
      total += violations.length;
      listener(violations);
    },
  };
}

describe("srt-macos command text retention", () => {
  it("retains no command text when both SRT fields use the opaque id", async () => {
    const opaqueId = `sbx_${"a".repeat(64)}`;
    expect(__getSrtCommandTextMapSizeForTest()).toBe(0);

    await __probeSrtCommandTextRegistrationForTest({
      commandId: opaqueId,
      commandText: opaqueId,
    });

    expect(__getSrtCommandTextMapSizeForTest()).toBe(0);
  });

  it("proves the zero-map assertion fails when commandText is accidentally omitted", async () => {
    await __probeSrtCommandTextRegistrationForTest({
      commandId: `sbx_${"b".repeat(64)}`,
    });
    const retained = __getSrtCommandTextMapSizeForTest();

    expect(retained).toBeGreaterThan(0);
    expect(() => expect(retained).toBe(0)).toThrow();
  });
});

const canRunRealSandbox =
  process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
const probeBackend = createSrtMacosBackend();
let commandSequence = 0;

describe.runIf(canRunRealSandbox)(
  "srt-macos initialization without log collection",
  () => {
    it("enforces filesystem restrictions after initializing without the log collector", async () => {
      const fixture = createProbeFixture();
      try {
        await probeBackend.initialize(
          effectivePolicy("restricted", "deny"),
          hooks(),
        );
        const policy = probeFilesystemPolicy("workspace_write", fixture);
        await expectProbeResult(
          `printf allowed > ${shellQuote(join(fixture.workspace, "allowed.txt"))}`,
          policy,
          fixture,
          true,
        );
        const deniedPath = join(fixture.outside, "denied.txt");
        await expectProbeResult(
          `printf denied > ${shellQuote(deniedPath)}`,
          policy,
          fixture,
          false,
        );
        expect(existsSync(deniedPath)).toBe(false);
      } finally {
        await probeBackend.reset();
        fixture.cleanup();
      }
    }, 30_000);
  },
);

describe.runIf(canRunRealSandbox)("srt-macos real sandbox-exec probes", () => {
  afterAll(async () => {
    await probeBackend.reset();
  });

  it.each([
    ["read_only", false, false, false, false],
    ["workspace_write", true, false, true, false],
    ["delete_guard", true, true, true, false],
    ["full_access", true, true, true, true],
  ] as const)(
    "enforces the %s inside/outside read-write-delete matrix",
    async (mode, writeInside, writeOutside, deleteInside, deleteOutside) => {
      const fixture = createProbeFixture();
      try {
        const policy = probeFilesystemPolicy(mode, fixture);
        const insideRead = join(fixture.workspace, "inside-read.txt");
        const outsideRead = join(fixture.outside, "outside-read.txt");
        writeFileSync(insideRead, "inside");
        writeFileSync(outsideRead, "outside");

        await expectProbeResult(
          `cat ${shellQuote(insideRead)}`,
          policy,
          fixture,
          true,
        );
        await expectProbeResult(
          `cat ${shellQuote(outsideRead)}`,
          policy,
          fixture,
          true,
        );
        await expectProbeResult(
          `printf inside > ${shellQuote(join(fixture.workspace, "inside-write.txt"))}`,
          policy,
          fixture,
          writeInside,
        );
        await expectProbeResult(
          `printf outside > ${shellQuote(join(fixture.outside, "outside-write.txt"))}`,
          policy,
          fixture,
          writeOutside,
        );
        await expectProbeResult(
          `printf temp > ${shellQuote(join(fixture.sessionTemp, "session-write.txt"))}`,
          policy,
          fixture,
          true,
        );

        const insideDelete = join(fixture.workspace, "inside-delete.txt");
        const outsideDelete = join(fixture.outside, "outside-delete.txt");
        writeFileSync(insideDelete, "inside");
        writeFileSync(outsideDelete, "outside");
        await expectProbeResult(
          `rm ${shellQuote(insideDelete)}`,
          policy,
          fixture,
          deleteInside,
        );
        await expectProbeResult(
          `rm ${shellQuote(outsideDelete)}`,
          policy,
          fixture,
          deleteOutside,
        );
        expect(existsSync(insideDelete)).toBe(!deleteInside);
        expect(existsSync(outsideDelete)).toBe(!deleteOutside);
      } finally {
        fixture.cleanup();
      }
    },
    30_000,
  );

  it.each(["workspace_write", "delete_guard"] as const)(
    "keeps every outside directory tree intact for %s delete and rename attempts",
    async (mode) => {
      const fixture = createProbeFixture();
      try {
        const policy = probeFilesystemPolicy(mode, fixture);
        const rmTree = populatedTree(fixture.outside, "rm-tree");
        const rmdirTarget = join(fixture.outside, "rmdir-target");
        const findTree = populatedTree(fixture.outside, "find-tree");
        const moveSource = populatedTree(fixture.outside, "move-source");
        mkdirSync(rmdirTarget);

        await expectProbeResult(
          `rm -rf ${shellQuote(rmTree)}`,
          policy,
          fixture,
          false,
        );
        await expectProbeResult(
          `rmdir ${shellQuote(rmdirTarget)}`,
          policy,
          fixture,
          false,
        );
        const findResult = await runProbe(
          `find ${shellQuote(findTree)} -delete`,
          policy,
          fixture,
        );
        expect(findResult.stderr).toContain("Operation not permitted");
        await expectProbeResult(
          `mv ${shellQuote(moveSource)} ${shellQuote(join(fixture.outside, "move-target"))}`,
          policy,
          fixture,
          false,
        );

        expect(treeFiles(rmTree)).toEqual(["root.txt", "sub/nested.txt"]);
        expect(existsSync(rmdirTarget)).toBe(true);
        expect(treeFiles(findTree)).toEqual(["root.txt", "sub/nested.txt"]);
        expect(treeFiles(moveSource)).toEqual(["root.txt", "sub/nested.txt"]);
        expect(existsSync(join(fixture.outside, "move-target"))).toBe(false);
      } finally {
        fixture.cleanup();
      }
    },
    30_000,
  );

  it("lets a workspace file move into the trash root without widening the unlink surface", async () => {
    const fixture = createProbeFixture();
    try {
      const policy = probeFilesystemPolicy("workspace_write", fixture);
      const insideFile = join(fixture.workspace, "recoverable.txt");
      const outsideFile = join(fixture.outside, "protected.txt");
      writeFileSync(insideFile, "inside");
      writeFileSync(outsideFile, "outside");

      // The in-cage recoverable delete: unlink the source (workspace surface,
      // in unlinkAllowOnly) and create at the destination (trash root, in
      // allowWrite). This is what makes "every delete is recoverable" hold
      // without handing the operation to an out-of-cage desktop service.
      await expectProbeResult(
        `mv ${shellQuote(insideFile)} ${shellQuote(join(fixture.trash, "recoverable.txt"))}`,
        policy,
        fixture,
        true,
      );
      expect(existsSync(insideFile)).toBe(false);
      expect(existsSync(join(fixture.trash, "recoverable.txt"))).toBe(true);

      // Opening the trash for WRITING must not open anything for UNLINKING:
      // an outside file still cannot be moved away, because the kernel checks
      // file-write-unlink against the source path.
      await expectProbeResult(
        `mv ${shellQuote(outsideFile)} ${shellQuote(join(fixture.trash, "protected.txt"))}`,
        policy,
        fixture,
        false,
      );
      expect(existsSync(outsideFile)).toBe(true);
      expect(existsSync(join(fixture.trash, "protected.txt"))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  }, 30_000);

  it.each(["workspace_write", "delete_guard", "full_access"] as const)(
    "treats git control paths as ordinary paths in %s under unrelated cwd anchoring",
    async (mode) => {
      const fixture = createProbeFixture();
      try {
        const policy = probeFilesystemPolicy(mode, fixture);
        const hook = join(fixture.gitDir, "hooks", "pre-commit");
        const thirdParty = join(fixture.workspace, "node_modules", "pkg");
        mkdirSync(join(thirdParty, ".vscode"), { recursive: true });
        writeFileSync(hook, "#!/bin/sh");
        writeFileSync(join(thirdParty, ".mcp.json"), "{}");
        writeFileSync(join(thirdParty, ".vscode", "settings.json"), "{}");
        const cwd = fixture.unrelatedCwd;

        await expectProbeResult(
          `rm ${shellQuote(hook)}`,
          policy,
          fixture,
          true,
          cwd,
        );
        await expectProbeResult(
          `rm -rf ${shellQuote(join(fixture.workspace, "node_modules"))}`,
          policy,
          fixture,
          true,
          cwd,
        );
        // With the runtime cwd unrelated to the fixture, this layer adds no
        // fixed baseline re-denying git control paths, so writing a hook is an
        // ordinary workspace write. Deferred-execution protection is
        // deliberately not this layer's job. (Under production anchoring SRT's
        // own mandatory deny still rejects hook writes — see the mandatory
        // deny probe.)
        const hookWrite = `printf injected > ${shellQuote(hook)}`;
        await expectProbeResult(hookWrite, policy, fixture, true, cwd);

        // Importing a hook from outside now turns purely on whether the mode
        // allows unlinking the *source*; the destination is unremarkable.
        const importAllowed = mode === "full_access";
        const preparedHook = populatedTree(fixture.outside, "prepared-hook");
        await expectProbeResult(
          `mv ${shellQuote(preparedHook)} ${shellQuote(join(fixture.gitDir, "hooks", "imported"))}`,
          policy,
          fixture,
          importAllowed,
          cwd,
        );
        expect(existsSync(preparedHook)).toBe(!importAllowed);
      } finally {
        fixture.cleanup();
      }
    },
    30_000,
  );

  it.each(["delete_guard", "full_access"] as const)(
    "surfaces SRT mandatory denies in %s when the runtime cwd is a workspace ancestor",
    (mode) => expectMandatoryDenySurface(mode),
    30_000,
  );

  it.each(["workspace_write", "delete_guard", "full_access"] as const)(
    "applies no write protection beyond the mode scope in %s under unrelated cwd anchoring",
    (mode) => expectModeScopeIsTheOnlyWriteRule(mode),
    120_000,
  );

  it("blocks workspace-write symlink escape and Node/Python descendant deletes", async () => {
    const fixture = createProbeFixture();
    try {
      const workspacePolicy = probeFilesystemPolicy("workspace_write", fixture);
      symlinkSync(fixture.outside, join(fixture.workspace, "outside-link"));
      const escaped = join(fixture.workspace, "outside-link", "escaped.txt");
      await expectProbeResult(
        `printf escaped > ${shellQuote(escaped)}`,
        workspacePolicy,
        fixture,
        false,
      );
      expect(existsSync(join(fixture.outside, "escaped.txt"))).toBe(false);

      const deletePolicy = probeFilesystemPolicy("delete_guard", fixture);
      const nodeTarget = join(fixture.outside, "node-delete.txt");
      const pythonTarget = join(fixture.outside, "python-delete.txt");
      writeFileSync(nodeTarget, "node");
      writeFileSync(pythonTarget, "python");
      await expectProbeResult(
        `node -e "require('node:fs').unlinkSync('${nodeTarget}')"`,
        deletePolicy,
        fixture,
        false,
      );
      await expectProbeResult(
        `python3 -c "import os; os.unlink('${pythonTarget}')"`,
        deletePolicy,
        fixture,
        false,
      );
      expect(existsSync(nodeTarget)).toBe(true);
      expect(existsSync(pythonTarget)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  }, 30_000);
});

const canRunRealGit =
  canRunRealSandbox &&
  spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;

/**
 * Real `git` through the real product authorization chain: the effective
 * policy is compiled from product config, the per-invocation surface comes
 * from `resolveSandboxInvocationContext`, and every command runs under real
 * `sandbox-exec` with the runtime cwd pinned to a fixture ancestor — the
 * production Desktop anchoring under which the field failures happened.
 */
describe.runIf(canRunRealGit)("srt-macos real git end-to-end probes", () => {
  it("completes init, add, commit, branch merge, clone, fetch and worktree add inside the workspace under delete_guard", async () => {
    const fixture = createGitProbeFixture();
    try {
      const context = await resolveGitContext(fixture, "delete_guard");
      const repo = join(fixture.workspace, "repo");

      await expectGitProbe(
        fixture,
        context,
        "git -c init.defaultBranch=main init repo",
        true,
      );
      await expectGitProbe(
        fixture,
        context,
        "printf one > repo/file.txt && git -C repo add file.txt && git -C repo commit -m one",
        true,
      );
      await expectGitProbe(
        fixture,
        context,
        "git -C repo checkout -b side && printf two > repo/side.txt && git -C repo add side.txt && git -C repo commit -m two && git -C repo checkout main && git -C repo merge side",
        true,
      );
      await expectGitProbe(
        fixture,
        context,
        'git clone "$PWD/repo" clone1',
        true,
      );
      await expectGitProbe(
        fixture,
        context,
        "printf three >> repo/file.txt && git -C repo commit -am three && git -C clone1 fetch origin",
        true,
      );
      // CX-002: `git worktree add` itself must run inside the sandbox — it
      // creates the linked metadata under `repo/.git/worktrees/<name>` and
      // checks out the new tree, both via lock-rename-unlink sequences that
      // delete_guard's workspace surface has to authorize. The follow-up
      // commit proves the linked worktree is fully functional in-cage.
      await expectGitProbe(
        fixture,
        context,
        "git -C repo worktree add ../wt -b wt-branch && printf four > wt/wt.txt && git -C wt add wt.txt && git -C wt commit -m four",
        true,
      );

      // The empty GIT_TEMPLATE_DIR skipped the hook templates, and no lock files
      // survived any of the lock-rename-unlink sequences above.
      expect(existsSync(join(repo, ".git", "hooks", "pre-commit.sample"))).toBe(
        false,
      );
      expect(existsSync(join(repo, ".git", "index.lock"))).toBe(false);
      expect(
        existsSync(join(fixture.workspace, "clone1", ".git", "index.lock")),
      ).toBe(false);
      expect(existsSync(join(fixture.workspace, "wt", "wt.txt"))).toBe(true);
      expect(
        existsSync(join(repo, ".git", "worktrees", "wt", "index.lock")),
      ).toBe(false);
    } finally {
      fixture.cleanup();
    }
  }, 120_000);

  it("commits and fetches in a nested linked worktree whose git metadata lives outside the workspace", async () => {
    const fixture = createGitProbeFixture();
    try {
      // Field shape: the session workspace contains a linked worktree whose
      // gitdir/commondir live in an external repository.
      const mainRepo = join(fixture.external, "main-repo");
      setupGit(fixture, ["-c", "init.defaultBranch=main", "init", mainRepo]);
      writeFileSync(join(mainRepo, "base.txt"), "base");
      setupGit(fixture, ["-C", mainRepo, "add", "base.txt"]);
      setupGit(fixture, ["-C", mainRepo, "commit", "-m", "base"]);
      const remoteRepo = join(fixture.external, "remote-repo");
      setupGit(fixture, ["clone", mainRepo, remoteRepo]);
      writeFileSync(join(remoteRepo, "more.txt"), "more");
      setupGit(fixture, ["-C", remoteRepo, "add", "more.txt"]);
      setupGit(fixture, ["-C", remoteRepo, "commit", "-m", "more"]);
      const worktreeRoot = join(fixture.workspace, "worktrees", "wt");
      mkdirSync(join(fixture.workspace, "worktrees"), { recursive: true });
      setupGit(fixture, [
        "-C",
        mainRepo,
        "worktree",
        "add",
        worktreeRoot,
        "-b",
        "wt-branch",
      ]);
      setupGit(fixture, [
        "-C",
        worktreeRoot,
        "remote",
        "add",
        "origin",
        remoteRepo,
      ]);

      const context = await resolveGitContext(fixture, "delete_guard");
      const linkedGitDir = join(mainRepo, ".git", "worktrees", "wt");
      expect(context.filesystem.unlinkAllowOnly).toEqual(
        expect.arrayContaining([linkedGitDir, join(mainRepo, ".git")]),
      );

      await expectGitProbe(
        fixture,
        context,
        "printf change > worktrees/wt/change.txt && git -C worktrees/wt add change.txt && git -C worktrees/wt commit -m change",
        true,
      );
      await expectGitProbe(
        fixture,
        context,
        "git -C worktrees/wt fetch origin",
        true,
      );

      // The index/ref lock-rename-unlink sequences completed without leftovers
      // in the external metadata directories.
      expect(existsSync(join(linkedGitDir, "index.lock"))).toBe(false);
      expect(existsSync(join(mainRepo, ".git", "maintenance.lock"))).toBe(
        false,
      );
    } finally {
      fixture.cleanup();
    }
  }, 120_000);

  it("keeps delete guard, explicit denyWrite and read_only boundaries intact around git", async () => {
    const fixture = createGitProbeFixture();
    try {
      // An unrelated external repository: it has `.git`-shaped paths, but it
      // is not referenced by any worktree in the workspace, so discovery must
      // not authorize it.
      const unrelatedRepo = join(fixture.external, "unrelated-repo");
      setupGit(fixture, [
        "-c",
        "init.defaultBranch=main",
        "init",
        unrelatedRepo,
      ]);
      writeFileSync(join(unrelatedRepo, "kept.txt"), "kept");
      setupGit(fixture, ["-C", unrelatedRepo, "add", "kept.txt"]);
      setupGit(fixture, ["-C", unrelatedRepo, "commit", "-m", "kept"]);
      const outsidePlain = join(fixture.external, "plain.txt");
      writeFileSync(outsidePlain, "outside");

      const guarded = await resolveGitContext(fixture, "delete_guard");
      await expectGitProbe(
        fixture,
        guarded,
        `rm ${shellQuote(outsidePlain)}`,
        false,
      );
      await expectGitProbe(
        fixture,
        guarded,
        `rm ${shellQuote(join(unrelatedRepo, ".git", "config"))}`,
        false,
      );
      expect(existsSync(outsidePlain)).toBe(true);
      expect(existsSync(join(unrelatedRepo, ".git", "config"))).toBe(true);

      // An explicit user denyWrite still beats the mode scope.
      const protectedDir = join(fixture.workspace, "protected");
      mkdirSync(protectedDir, { recursive: true });
      const denying = await resolveGitContext(fixture, "delete_guard", {
        denyWrite: [protectedDir],
      });
      await expectGitProbe(
        fixture,
        denying,
        `printf x > ${shellQuote(join(protectedDir, "file.txt"))}`,
        false,
      );

      // read_only still rejects a commit outright.
      setupGit(fixture, [
        "-c",
        "init.defaultBranch=main",
        "init",
        join(fixture.workspace, "ro"),
      ]);
      const readOnly = await resolveGitContext(fixture, "read_only");
      await expectGitProbe(
        fixture,
        readOnly,
        "git -C ro commit --allow-empty -m nope",
        false,
      );
    } finally {
      fixture.cleanup();
    }
  }, 120_000);
});

const canInspectProfile = process.platform === "darwin";
const profileBackend = createSrtMacosBackend();
const profileFixture = canInspectProfile
  ? realpathSync(
      mkdtempSync(join(realpathSync(tmpdir()), "mcode-srt-profile-")),
    )
  : "/tmp/mcode-srt-profile-skipped";

describe.runIf(canInspectProfile)("srt-macos SBPL profile contract", () => {
  afterAll(async () => {
    await profileBackend.reset();
    rmSync(profileFixture, { recursive: true, force: true });
  });

  it("orders read allow, move blocking, global unlink deny, carved roots and read re-deny", async () => {
    const workspace = join(profileFixture, "workspace");
    const denyWrite = join(workspace, "protected");
    const denyRead = join(workspace, "secret");
    const wrapped = await wrapProfile({
      allowRead: [workspace],
      allowWrite: [workspace],
      unlinkAllowOnly: [workspace],
      denyRead: [denyRead],
      denyWrite: [denyWrite],
    });

    const readWriteRootAllow = wrapped.indexOf(
      "(allow file-write-unlink file-write-create",
    );
    const writeSection = wrapped.indexOf("; File write");
    const moveBlocking = wrapped.indexOf(
      "(deny file-write-unlink file-write-create",
      writeSection,
    );
    const globalUnlinkDeny = wrapped.indexOf(
      '(deny file-write-unlink\n  (subpath "/")',
    );
    const carvedRootAllow = wrapped.indexOf(
      `(allow file-write-unlink\n  (require-all (subpath "${workspace}") (require-not (subpath "${denyWrite}")))`,
    );
    const trailingReadDeny = wrapped.indexOf(
      "; File read: keep read-denied paths inside write roots in place",
    );

    const positions = [
      readWriteRootAllow,
      writeSection,
      moveBlocking,
      globalUnlinkDeny,
      carvedRootAllow,
      trailingReadDeny,
    ];
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual(
      [...positions].sort((left, right) => left - right),
    );
    expect(
      substringCount(wrapped, '(deny file-write-unlink\n  (subpath "/")'),
    ).toBe(1);
    expect(
      substringCount(wrapped, `(require-all (subpath "${workspace}")`),
    ).toBe(1);
    expect(wrapped.slice(carvedRootAllow, trailingReadDeny)).not.toContain(
      "file-write-create",
    );
    expect(wrapped.slice(moveBlocking, globalUnlinkDeny)).toContain(
      ".git/hooks",
    );
    expect(wrapped.slice(trailingReadDeny)).toContain(denyRead);
  });

  it("restores host-root unlink only after emitting the full-access global deny", async () => {
    const wrapped = await wrapProfile({
      allowRead: [profileFixture],
      allowWrite: ["/"],
      unlinkAllowOnly: ["/"],
      denyRead: [],
      denyWrite: [],
    });
    const globalDeny = wrapped.indexOf(
      '(deny file-write-unlink\n  (subpath "/")',
    );
    const hostRootAllow = wrapped.indexOf(
      '(allow file-write-unlink\n  (subpath "/")',
    );

    expect(globalDeny).toBeGreaterThan(-1);
    expect(hostRootAllow).toBeGreaterThan(globalDeny);
    expect(
      substringCount(wrapped, '(allow file-write-unlink\n  (subpath "/")'),
    ).toBe(1);
  });
});

function effectivePolicy(
  localAccess: "open" | "restricted",
  networkMode: "deny" | "allow_all",
): SandboxEffectivePolicy {
  return compileSandboxEffectivePolicy({
    enabled: true,
    filesystem: {
      policy: { mode: "workspace_write" },
      denyRead: [],
      denyWrite: [],
    },
    network: {
      policy: { mode: networkMode },
      deniedDomains: ["169.254.169.254"],
    },
    localAccess,
  });
}

function hooks(): SandboxBackendHooks {
  return { reportViolation: vi.fn() };
}

function wrapInput(): SandboxWrapInput {
  return {
    command: "printf hello",
    cwd: "/workspace",
    baseEnv: { PATH: "/usr/bin" },
    sandboxTempDir: "/tmp/session-1",
    commandId: "opaque-command",
    commandText: "opaque-command",
    gitSafeDirectories: ["/workspace"],
    filesystem: {
      allowRead: ["/workspace"],
      allowWrite: ["/workspace"],
      unlinkAllowOnly: ["/workspace"],
      denyRead: [],
      denyWrite: [],
    },
  };
}

function firstInitializeCall(
  manager: SrtMacosManagerPort,
): Parameters<SrtMacosManagerPort["initialize"]> {
  const call = vi.mocked(manager.initialize).mock.calls[0];
  if (!call) throw new Error("Expected SRT initialize call");
  return call;
}

function fakeManager(): SrtMacosManagerPort {
  let config: Parameters<SrtMacosManagerPort["initialize"]>[0] | undefined;
  return {
    initialize: vi.fn(async (next) => {
      config = next;
    }),
    getConfig: vi.fn(() => config),
    updateConfig: vi.fn((next) => {
      config = next;
    }),
    wrapWithSandbox: vi.fn(async () => "wrapped command"),
    getSandboxViolationStore: vi.fn(() => ({
      getTotalCount: () => 0,
      subscribe: (
        listener: Parameters<
          ReturnType<
            SrtMacosManagerPort["getSandboxViolationStore"]
          >["subscribe"]
        >[0],
      ) => {
        listener([]);
        return vi.fn();
      },
    })),
    cleanupAfterCommand: vi.fn(),
    reset: vi.fn(async () => {
      config = undefined;
    }),
  };
}

interface ProbeFixture {
  readonly root: string;
  readonly workspace: string;
  readonly gitDir: string;
  readonly outside: string;
  readonly dataDir: string;
  readonly sandboxTempRoot: string;
  readonly sessionTemp: string;
  /** Stand-in for the platform trash root (`~/.Trash` in production). */
  readonly trash: string;
  /**
   * A directory with no ancestor relationship to `workspace`. SRT's mandatory
   * deny patterns anchor their `**` globs on the host runtime's
   * `process.cwd()` at wrap time, so probes that assert "the four modes are
   * the whole policy" must pin the runtime cwd here explicitly instead of
   * relying on where the vitest worker happens to run.
   */
  readonly unrelatedCwd: string;
  cleanup(): void;
}

function createProbeFixture(): ProbeFixture {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "mcode-srt-probe-")),
  );
  const workspace = join(root, "workspace");
  const gitDir = join(workspace, ".git");
  const outside = join(root, "outside");
  const dataDir = join(root, "runtime-data");
  const sandboxTempRoot = join(root, "sandbox-temp");
  const sessionTemp = join(sandboxTempRoot, "session-current");
  const trash = join(root, "trash");
  const unrelatedCwd = join(root, "unrelated-cwd");
  for (const directory of [
    join(gitDir, "hooks"),
    outside,
    dataDir,
    sessionTemp,
    trash,
    unrelatedCwd,
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  return {
    root,
    workspace,
    gitDir,
    outside,
    dataDir,
    sandboxTempRoot,
    sessionTemp,
    trash,
    unrelatedCwd,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function probeFilesystemPolicy(
  mode: SandboxFilesystemPolicy["mode"],
  fixture: ProbeFixture,
): SandboxInvocationFilesystemPolicy {
  const workspaceSurface = [
    fixture.workspace,
    fixture.gitDir,
    fixture.sessionTemp,
  ];
  // Mirrors compileSandboxEffectivePolicy: workspace_write also opens the trash
  // destination for writing, so an in-cage recoverable delete can complete.
  const allowWrite =
    mode === "read_only"
      ? [fixture.sessionTemp]
      : mode === "workspace_write"
        ? [...workspaceSurface, fixture.trash]
        : ["/"];
  const unlinkAllowOnly =
    mode === "read_only"
      ? [fixture.sessionTemp]
      : mode === "full_access"
        ? ["/"]
        : workspaceSurface;
  return {
    allowRead: workspaceSurface,
    allowWrite,
    unlinkAllowOnly,
    denyRead: [fixture.dataDir, fixture.sandboxTempRoot],
    denyWrite: [],
  };
}

/**
 * Every target below sits on SRT's own built-in mandatory-deny list:
 * `DANGEROUS_FILES`, `getDangerousDirectories()`, `.git/hooks` (documented
 * upstream as "always blocked for security"), and `.git/config` (exempt from
 * that surface because the product hardcodes `allowGitConfig: true`).
 *
 * `macGetMandatoryDenyPatterns()` resolves those patterns against the *host*
 * runtime's `process.cwd()` at wrap time, so whether they bite depends
 * entirely on where the runtime process happens to run. This probe pins the
 * runtime cwd to a directory with no ancestor relationship to the fixture,
 * making its precondition explicit: under that anchoring — and only under
 * it — the four modes are the complete filesystem policy. The production
 * Desktop shape (runtime cwd an ancestor of the workspace) is covered by the
 * companion "surfaces SRT mandatory denies" probe below.
 */
async function expectModeScopeIsTheOnlyWriteRule(
  mode: "workspace_write" | "delete_guard" | "full_access",
): Promise<void> {
  const fixture = createProbeFixture();
  try {
    const policy = probeFilesystemPolicy(mode, fixture);
    mkdirSync(join(fixture.workspace, ".vscode"), { recursive: true });
    mkdirSync(join(fixture.workspace, ".idea"), { recursive: true });
    mkdirSync(join(fixture.workspace, ".mcode", "commands"), {
      recursive: true,
    });
    mkdirSync(join(fixture.gitDir, "hooks"), { recursive: true });

    for (const target of [
      join(fixture.workspace, "plain.txt"),
      join(fixture.workspace, ".zshrc"),
      join(fixture.workspace, ".gitconfig"),
      join(fixture.workspace, ".mcp.json"),
      join(fixture.workspace, ".vscode", "settings.json"),
      join(fixture.workspace, ".idea", "x.xml"),
      join(fixture.workspace, ".mcode", "commands", "c.md"),
      join(fixture.gitDir, "hooks", "pre-commit"),
      join(fixture.gitDir, "config"),
    ]) {
      await expectProbeResult(
        `printf x > ${shellQuote(target)}`,
        policy,
        fixture,
        true,
        fixture.unrelatedCwd,
      );
    }

    // The mode's own scope is the only thing that decides a write.
    const outsideAllowed = mode !== "workspace_write";
    for (const target of [
      join(fixture.outside, "plain.txt"),
      join(fixture.outside, ".zshrc"),
    ]) {
      await expectProbeResult(
        `printf x > ${shellQuote(target)}`,
        policy,
        fixture,
        outsideAllowed,
        fixture.unrelatedCwd,
      );
    }
  } finally {
    fixture.cleanup();
  }
}

/**
 * Production Desktop shape: the runtime host process cwd is an ancestor of the
 * user's paths, so SRT's cwd-anchored mandatory-deny globs really cover them.
 * This is the environment where the field failure (clone/init rejected on
 * hooks and `.git/config`) occurred.
 *
 * `.git/config` is why the allowGitConfig toggle was retired: SRT reads that
 * switch from the session-global manager config (published via
 * initialize/updateConfig), NOT from the per-invocation filesystem policy,
 * and the product now always publishes `true`. This probe publishes the
 * compiled defaults exactly the way the product does and expects the
 * `.git/config` write to pass.
 */
async function expectMandatoryDenySurface(
  mode: "delete_guard" | "full_access",
): Promise<void> {
  const fixture = createProbeFixture();
  try {
    const anchor = fixture.root;
    const policy = probeFilesystemPolicy(mode, fixture);

    await expectProbeResult(
      `printf x > ${shellQuote(join(fixture.workspace, "plain.txt"))}`,
      policy,
      fixture,
      true,
      anchor,
    );
    // `.git/hooks` is unconditionally denied by SRT, in every mode.
    await expectProbeResult(
      `printf x > ${shellQuote(join(fixture.gitDir, "hooks", "pre-commit"))}`,
      policy,
      fixture,
      false,
      anchor,
    );
    const publishDefaults = () => {
      const config = getSandboxConfigDefaults("darwin");
      config.filesystem.policy = { mode };
      probeBackend.updateConfig(compileSandboxEffectivePolicy(config));
    };
    publishDefaults();
    // `.git/config` writes are always allowed: the retired allowGitConfig
    // toggle is hardcoded to true in the published session-global config.
    await expectProbeResult(
      `printf x > ${shellQuote(join(fixture.gitDir, "config"))}`,
      policy,
      fixture,
      true,
      anchor,
    );
    // Dangerous dotfiles stay denied by SRT even in full_access.
    await expectProbeResult(
      `printf x > ${shellQuote(join(fixture.workspace, ".zshrc"))}`,
      policy,
      fixture,
      false,
      anchor,
    );
  } finally {
    fixture.cleanup();
  }
}

/**
 * Probes must measure the sandbox, not the caller's shell. Every probe spawns a
 * real process and resolves its command through `PATH`, so inheriting the
 * ambient one lets a wrapper ahead of `/bin` decide what `rm` means — for
 * example the recoverable-delete shim MCode installs into agent shells, whose
 * trash move the sandbox then denies, turning a correct allow-probe into a
 * reported sandbox regression. Pin the probes to the system binaries they
 * actually use (`cat`, `rm`, `rmdir`, `find`, `mv`, `printf`, `git`, `true`).
 */
const PROBE_PATH = "/usr/bin:/bin";

async function expectProbeResult(
  command: string,
  filesystem: SandboxInvocationFilesystemPolicy,
  fixture: ProbeFixture,
  allowed: boolean,
  runtimeCwd?: string,
): Promise<void> {
  const result = await runProbe(command, filesystem, fixture, runtimeCwd);
  const evidence = `${allowed ? "allow" : "deny"} probe: ${command}\n${result.stderr}`;
  if (allowed) expect(result.status, evidence).toBe(0);
  else expect(result.status, evidence).not.toBe(0);
}

/**
 * SRT resolves its mandatory-deny globs against the host process cwd at wrap
 * time, so `runtimeCwd` pins that anchoring per probe: pass a directory with
 * no ancestor relationship to the target to keep the hidden blacklist out of
 * scope, or a fixture ancestor to reproduce the production Desktop shape.
 */
async function runProbe(
  command: string,
  filesystem: SandboxInvocationFilesystemPolicy,
  fixture: ProbeFixture,
  runtimeCwd?: string,
) {
  commandSequence += 1;
  const commandId = `sbx_${commandSequence.toString(16).padStart(64, "0")}`;
  const wrapped = await withRuntimeCwd(runtimeCwd, () =>
    probeBackend.wrap({
      command,
      cwd: fixture.workspace,
      baseEnv: {
        HOME: process.env.HOME ?? "/var/empty",
        PATH: PROBE_PATH,
      },
      sandboxTempDir: fixture.sessionTemp,
      commandId,
      commandText: commandId,
      gitSafeDirectories: [fixture.workspace],
      filesystem,
    }),
  );
  return spawnSync(wrapped.command, {
    cwd: fixture.workspace,
    encoding: "utf8",
    env: wrapped.env,
    shell: "/bin/bash",
    timeout: 10_000,
  });
}

async function withRuntimeCwd<T>(
  dir: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!dir) return fn();
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

interface GitProbeFixture {
  readonly root: string;
  readonly workspace: string;
  /** Isolated HOME so git never reads or writes the developer's real config. */
  readonly home: string;
  /** Holds repositories whose metadata lives outside the workspace. */
  readonly external: string;
  readonly sandboxTempRoot: string;
  readonly instanceDir: string;
  readonly sessionTemp: string;
  cleanup(): void;
}

function createGitProbeFixture(): GitProbeFixture {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), "mcode-srt-git-")),
  );
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const external = join(root, "external");
  const sandboxTempRoot = join(root, "sandbox-temp");
  const instanceDir = join(sandboxTempRoot, "runtime-instance");
  const sessionTemp = join(instanceDir, "session-current");
  for (const directory of [workspace, home, external, sessionTemp]) {
    mkdirSync(directory, { recursive: true });
  }
  return {
    root,
    workspace,
    home,
    external,
    sandboxTempRoot,
    instanceDir,
    sessionTemp,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function gitProbeEnv(fixture: GitProbeFixture): Record<string, string> {
  return {
    HOME: fixture.home,
    PATH: PROBE_PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "probe",
    GIT_AUTHOR_EMAIL: "probe@example.invalid",
    GIT_COMMITTER_NAME: "probe",
    GIT_COMMITTER_EMAIL: "probe@example.invalid",
  };
}

/** Unsandboxed fixture preparation; probe assertions never go through this. */
function setupGit(fixture: GitProbeFixture, args: string[]): void {
  const result = spawnSync("git", args, {
    cwd: fixture.root,
    encoding: "utf8",
    env: gitProbeEnv(fixture),
    timeout: 30_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `git setup failed: git ${args.join(" ")}\n${result.stderr}`,
    );
  }
}

type ResolvedGitContext = Awaited<
  ReturnType<typeof resolveSandboxInvocationContext>
>;

/** The real product authorization chain: shipped defaults -> policy -> per-invocation surface. */
async function resolveGitContext(
  fixture: GitProbeFixture,
  mode: SandboxFilesystemPolicy["mode"],
  overrides: { denyWrite?: string[] } = {},
): Promise<ResolvedGitContext> {
  const config = getSandboxConfigDefaults("darwin");
  config.filesystem.policy = { mode };
  config.filesystem.denyWrite = overrides.denyWrite ?? [];
  const policy = compileSandboxEffectivePolicy(config);
  // Production publishes the policy to the backend (initialize/updateConfig)
  // before wrapping; SRT reads session-global switches (such as the retired,
  // now always-true allowGitConfig) from that published config, not from the
  // per-invocation surface.
  probeBackend.updateConfig(policy);
  return resolveSandboxInvocationContext({
    workspaceRoot: fixture.workspace,
    cwd: fixture.workspace,
    sessionTempDir: fixture.sessionTemp,
    runtimeTempInstanceDir: fixture.instanceDir,
    sandboxTempRoot: fixture.sandboxTempRoot,
    policy,
  });
}

async function expectGitProbe(
  fixture: GitProbeFixture,
  context: ResolvedGitContext,
  command: string,
  allowed: boolean,
): Promise<void> {
  commandSequence += 1;
  const commandId = `sbx_${commandSequence.toString(16).padStart(64, "0")}`;
  // Production anchoring: the runtime cwd is an ancestor of the workspace, so
  // SRT's mandatory-deny globs genuinely cover every fixture path.
  const wrapped = await withRuntimeCwd(fixture.root, () =>
    probeBackend.wrap({
      command,
      cwd: fixture.workspace,
      baseEnv: gitProbeEnv(fixture),
      sandboxTempDir: context.sandboxTempDir,
      commandId,
      commandText: commandId,
      gitSafeDirectories: [...context.git.safeDirectories],
      filesystem: {
        allowRead: [...context.filesystem.allowRead],
        allowWrite: [...context.filesystem.allowWrite],
        unlinkAllowOnly: [...context.filesystem.unlinkAllowOnly],
        denyRead: [...context.filesystem.denyRead],
        denyWrite: [...context.filesystem.denyWrite],
      },
    }),
  );
  const result = spawnSync(wrapped.command, {
    cwd: fixture.workspace,
    encoding: "utf8",
    env: wrapped.env,
    shell: "/bin/bash",
    timeout: 30_000,
  });
  const evidence = `${allowed ? "allow" : "deny"} git probe: ${command}\n${result.stdout}\n${result.stderr}`;
  if (allowed) expect(result.status, evidence).toBe(0);
  else expect(result.status, evidence).not.toBe(0);
}

function populatedTree(parent: string, name: string): string {
  const root = join(parent, name);
  mkdirSync(join(root, "sub"), { recursive: true });
  writeFileSync(join(root, "root.txt"), "root");
  writeFileSync(join(root, "sub", "nested.txt"), "nested");
  return root;
}

function treeFiles(root: string): string[] {
  return ["root.txt", "sub/nested.txt"].filter((path) =>
    existsSync(join(root, path)),
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function wrapProfile(
  filesystem: SandboxInvocationFilesystemPolicy,
): Promise<string> {
  const opaqueId = `sbx_${"d".repeat(64)}`;
  return (
    await profileBackend.wrap({
      command: "true",
      cwd: profileFixture,
      baseEnv: { PATH: PROBE_PATH },
      sandboxTempDir: profileFixture,
      commandId: opaqueId,
      commandText: opaqueId,
      gitSafeDirectories: [],
      filesystem,
    })
  ).command;
}

function substringCount(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
