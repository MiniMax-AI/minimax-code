import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DatabaseClient } from "../../infra/db/client.js";
import { initializeDatabase } from "../../infra/db/initialize.js";
import {
  ContentSafetyService,
  type SafetyCheckResult,
} from "../../service/content-safety/index.js";
import type { LocalRuntimeConfig } from "../../service/model-system/index.js";
import { createSessionRepository } from "../../service/session-system/sessions/repo/drizzle.js";
import { SessionRecordService } from "../../service/session-system/sessions/lifecycle/record-service.js";
import type {
  SessionAgentDefinition,
  SessionRecord,
} from "../../service/session-system/index.js";
import { createSessionTitlePolicy } from "./session-title-policy.js";

const session: SessionRecord = {
  sessionId: "rename-test",
  agentName: "test-agent",
  workspaceDir: "/synthetic",
  runtime: "pi-agent",
  sessionType: "branch",
  sessionKind: "conversation",
  status: "idle",
  archived: false,
  createdAtMs: 1,
  updatedAtMs: 1,
  title: "Original",
  effectiveModel: "custom_provider:byok/test-model",
};
const config: LocalRuntimeConfig = {
  dataDir: "/synthetic",
  defaultModel: "minimax/MiniMax-M3",
  provider: { minimax: { options: { authMode: "managed-login" } } },
  custom_provider: { byok: { options: { baseURL: "https://example.com/v1" } } },
};
function fixture(
  options: {
    runtimeOwnerKind?: string;
    config?: LocalRuntimeConfig;
    definition?: SessionAgentDefinition;
  } = {},
) {
  // Signed-out managed gateway. The BYOK path must never send the title here.
  const review = vi.fn(async (): Promise<SafetyCheckResult> => ({
    pass: false,
    errorKind: "auth_error",
  }));
  const readDefinition = vi.fn(async () => options.definition);
  const policy = createSessionTitlePolicy({
    runtimeOwnerKind: options.runtimeOwnerKind ?? "tui",
    config: () => options.config ?? config,
    safety: new ContentSafetyService({ review }),
    readDefinition,
  });
  return { policy, review, readDefinition };
}

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

describe("CLI session title review", () => {
  it("persists a signed-out BYOK rename through the real record service and SQLite", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "session-title-review-"));
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    const database = new DatabaseClient({ dataDir });
    cleanup.push(() => database.close());
    await initializeDatabase({ database, dataDir });
    const sessions = createSessionRepository({
      db: database.db,
      nowMs: () => 2,
    });
    await sessions.create(session);
    const { policy, review } = fixture();
    const records = new SessionRecordService({
      sessions,
      metadata: sessions,
      agents: { getDefaults: async () => undefined },
      runLocation: { resolve: async () => undefined },
      titlePolicy: policy,
      facts: { handle: vi.fn() },
    });
    await records.mutateSession(session.sessionId, {
      title: "Renamed locally",
    });
    expect((await sessions.get(session.sessionId))?.title).toBe(
      "Renamed locally",
    );
    expect(review).not.toHaveBeenCalled();

    await sessions.update(session.sessionId, {
      effectiveModel: "minimax/MiniMax-M3",
    });
    await expect(
      records.mutateSession(session.sessionId, { title: "Must not persist" }),
    ).rejects.toMatchObject({ reason: "content-policy-rejected" });
    expect((await sessions.get(session.sessionId))?.title).toBe(
      "Renamed locally",
    );
    expect(review).toHaveBeenCalledWith("Must not persist", 205);
  });

  it.each(["tui", "cli"])(
    "uses the Session selection ahead of the runtime default in %s",
    async (runtimeOwnerKind) => {
      const { policy, review } = fixture({ runtimeOwnerKind });
      await expect(policy.blocks("BYOK title", session)).resolves.toBe(false);
      expect(review).not.toHaveBeenCalled();
      await expect(
        policy.blocks("Managed title", {
          ...session,
          effectiveModel: "minimax/MiniMax-M3",
        }),
      ).resolves.toBe(true);
    },
  );

  it("reads the current default for an unselected Session without caching the route", async () => {
    const current = {
      ...config,
      defaultModel: "custom_provider:byok/test-model",
    };
    const { policy, review } = fixture({ config: current });
    await expect(
      policy.blocks("Local", { ...session, effectiveModel: null }),
    ).resolves.toBe(false);
    current.defaultModel = "minimax/MiniMax-M3";
    await expect(
      policy.blocks("Managed", { ...session, effectiveModel: null }),
    ).resolves.toBe(true);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it.each([
    { pass: true },
    { pass: false, errorKind: "rejected" },
    { pass: false, errorKind: "auth_error" },
    { pass: false, errorKind: "local_error" },
    { pass: false, errorKind: "api_error" },
    { pass: false },
  ] satisfies SafetyCheckResult[])(
    "preserves managed verdict semantics for %j",
    async (verdict) => {
      const { policy, review } = fixture();
      review.mockResolvedValue(verdict);
      await expect(
        policy.blocks("Managed title", {
          ...session,
          effectiveModel: "minimax/MiniMax-M3",
        }),
      ).resolves.toBe(
        !verdict.pass &&
          ("errorKind" in verdict ? verdict.errorKind !== "api_error" : true),
      );
      expect(review).toHaveBeenCalledWith("Managed title", 205);
    },
  );

  it("blocks unexpected review exceptions for managed providers", async () => {
    const { policy, review } = fixture();
    review.mockRejectedValue(new Error("local checker failure"));
    await expect(
      policy.blocks("Managed title", {
        ...session,
        effectiveModel: "minimax/MiniMax-M3",
      }),
    ).resolves.toBe(true);
    await expect(policy.blocks("Local title", session)).resolves.toBe(false);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it.each([
    "minimax_api/test-model",
    "minimax/test-model",
    "external/test-model",
  ])("allows non-managed credentials on %s", async (effectiveModel) => {
    const { policy, review } = fixture({
      config: {
        ...config,
        minimaxModelSource: "minimax_api_key",
        provider: {
          ...config.provider,
          external: { options: { authMode: "oauth" } },
        },
      },
    });
    await expect(
      policy.blocks("Local title", { ...session, effectiveModel }),
    ).resolves.toBe(false);
    expect(review).not.toHaveBeenCalled();
  });

  it.each([
    "missing/test",
    "custom_provider:missing/test",
    "custom_provider:minimax-legacy/test",
    "malformed",
  ])(
    "retains review for unknown or legacy context %s",
    async (effectiveModel) => {
      const { policy } = fixture();
      await expect(
        policy.blocks("Title", { ...session, effectiveModel }),
      ).resolves.toBe(true);
    },
  );

  it("retains review for configured managed aliases and inferred managed URLs", async () => {
    const { policy } = fixture({
      config: {
        ...config,
        provider: {
          alias: { options: { authMode: "managed-login" } },
          inferred: { options: { baseURL: "https://agent.minimax.cn/v1" } },
        },
      },
    });
    for (const provider of ["alias", "inferred"]) {
      await expect(
        policy.blocks("Title", {
          ...session,
          effectiveModel: `${provider}/test`,
        }),
      ).resolves.toBe(true);
    }
  });

  it.each(["minimax", "custom_provider:byok"])(
    "uses the frozen Task provider %s",
    async (providerId) => {
      const { policy, review } = fixture({
        definition: {
          sessionId: session.sessionId,
          definition: {
            definitionVersion: 2,
            exactOwnerName: "test-agent",
            systemPrompt: "",
            capabilities: {
              tools: [],
              mcpServers: [],
              skills: [],
              extensionSkills: [],
            },
            model: { providerId, modelId: "test-model" },
            project: { workspaceDir: "/synthetic", isDefaultWorkspace: false },
          },
        },
      });
      await expect(
        policy.blocks("Task title", {
          ...session,
          sessionKind: "task",
          effectiveModel: "minimax/MiniMax-M3",
        }),
      ).resolves.toBe(providerId === "minimax");
      expect(review).toHaveBeenCalledTimes(providerId === "minimax" ? 1 : 0);
    },
  );

  it("retains review when a Task definition is missing and propagates storage errors", async () => {
    const { policy, readDefinition } = fixture();
    const task = { ...session, sessionKind: "task" as const };
    await expect(policy.blocks("Task title", task)).resolves.toBe(true);
    readDefinition.mockRejectedValue(new Error("storage unavailable"));
    await expect(policy.blocks("Task title", task)).rejects.toThrow(
      "storage unavailable",
    );
  });

  it("preserves non-CLI policy and skips blank titles before any lookup", async () => {
    const { policy, review, readDefinition } = fixture({
      runtimeOwnerKind: "electron",
    });
    await expect(policy.blocks("Local title", session)).resolves.toBe(true);
    review.mockClear();
    await expect(
      policy.blocks("   ", { ...session, sessionKind: "task" }),
    ).resolves.toBe(false);
    expect(review).not.toHaveBeenCalled();
    expect(readDefinition).not.toHaveBeenCalled();
  });
});
