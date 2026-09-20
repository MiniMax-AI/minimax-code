import { createHash } from "node:crypto";
import { previewAgentModelSelection } from "../../../../src/service/model-system/index.js";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  type CreateLocalRuntimeHostOptions,
  type CreatedLocalRuntimeHost,
} from "@mavis/local-runtime";
import { DeferredRuntimeConversation } from "@mavis/conversation-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDefaultAgentAvatarMarker } from "@mavis/shared/agent-avatar";
import { serializeAgentReference } from "@mavis/shared/agent-mention";

import { createV1RuntimeCompatibility } from "../../../../src/compat/v1/runtime.js";
import { DatabaseClient } from "../../../../src/infra/db/client.js";
import { initializeDatabase } from "../../../../src/infra/db/initialize.js";
import { readLegacyHistoryNoticeCutoff } from "../../../../src/infra/db/legacy-history-notice-cutoff.js";
import { AgentApplication } from "../../../../src/application/agent/agent-application.js";
import { createV2AgentExecutionSource } from "../../../../src/application/agent/execution-source.js";
import { createV2AgentProfileSource } from "../../../../src/application/agent/profile-source.js";
import { createSessionRepository } from "../../../../src/service/session-system/sessions/repo/drizzle.js";
import { SessionRecordService } from "../../../../src/service/session-system/sessions/lifecycle/record-service.js";
import { readSessionAgentExecutionSnapshot } from "../../../../src/service/turn-system/agent-host/preparation/session-agent-execution-snapshot.js";
import { AgentImportService } from "../../../../src/service/agent/application/agent-import.js";
import { LocalAgentService } from "../../../../src/service/agent/application/agent.service.js";
import { createTestAgentService } from "../../../helpers/agent-service.js";
import { AgentFiles } from "../../../../src/service/agent/storage/agent-files.js";
import { DrizzleAgentRepository } from "../../../../src/service/agent/storage/agent.repository.js";
import { encryptIdentityField } from "../../../../src/service/agent/storage/identity-codec.js";
import { projectLocalAgentReferencesForModel } from "../../../../src/service/turn-system/agent-host/preparation/agent-prompt-surface.js";
import type { AgentSystemFactCallbacks } from "../../../../src/service/agent/contracts.js";

vi.mock("../../../../src/compat/v1/cron.js", () => ({
  createV1MavisCronAdapterBridge: () => ({
    adapter: {},
    bindHandleRequest: () => undefined,
  }),
  createV1CronAgentCleanupBridge: () => ({
    bind: () => undefined,
    deleteAgentCronTasks: async () => undefined,
  }),
}));

vi.mock("../../../../src/compat/v1/agent-host.js", () => ({
  createV1AttachmentRegistration: () => ({}),
  createV1AgentHostProductCapabilities: () => ({}),
  createV1ChannelProductCapabilities: () => ({}),
}));

vi.mock("../../../../src/compat/v1/session.js", () => ({
  createV1SessionCompatibility: () => ({}),
}));

const cleanup: Array<() => Promise<void> | void> = [];
const PNG_BYTES = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString("base64")}`;

afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function createRepository(
  facts?: Pick<AgentSystemFactCallbacks, "onAgentRoleObservation">,
): Promise<{
  repository: DrizzleAgentRepository;
  database: DatabaseClient;
  dataDir: string;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "agent-repository-queries-"));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const database = new DatabaseClient({ dataDir });
  cleanup.push(() => database.close());
  await initializeDatabase({ database, dataDir });
  const repository = new DrizzleAgentRepository({
    db: database.db,
    dataDir,
    ...(facts ? { facts } : {}),
  });
  return { repository, database, dataDir };
}

function createAgentReferenceCompatibility(agentResolver: LocalAgentService) {
  return createV1RuntimeCompatibility(new DeferredRuntimeConversation(), {
    createQuestionnaireService: () => ({}) as never,
  }).createServiceCompatibility(
    {
      dataDir: "/tmp/runtime",
      apiHost: {
        agentResolver,
        configGetter: () => ({ dataDir: "/tmp/runtime", provider: {} }),
        questionnaireServiceDeps: () => ({
          store: {},
          nowMs: Date.now,
          primaryAgentName: "mavis",
          configGetter: () => ({}),
          getSessionById: vi.fn(),
          startUserMessageTurn: vi.fn(),
          emitBusEvent: vi.fn(),
          publishGlobalEvent: vi.fn(),
        }),
        threadGoal: {},
        isReadOnlyLegacySession: async () => false,
        skillService: {},
      },
      mcpService: {},
      metricsClient: {},
    } as unknown as CreatedLocalRuntimeHost,
    { dataDir: "/tmp/runtime" } as CreateLocalRuntimeHostOptions,
  );
}

function seedLegacyHistoryTarget(
  database: DatabaseClient,
  input: { readonly agentName: string; readonly sessionId: string },
): void {
  database.rawDb
    .prepare(
      `INSERT INTO local_runtime_sessions(
         session_id, record_json, updated_at_ms, columnar_version, agent_name, session_type
       ) VALUES (?, '{}', 1, 3, ?, 'root')`,
    )
    .run(input.sessionId, input.agentName);
  database.rawDb
    .prepare(
      `INSERT INTO local_runtime_message_rows(
         session_id, msg_id, role, created_at_ms, data_json
       ) VALUES (?, ?, 'user', 1, ?)`,
    )
    .run(
      input.sessionId,
      `${input.sessionId}-user`,
      JSON.stringify({ role: "user", content: "old request" }),
    );
}

async function seed(repository: DrizzleAgentRepository): Promise<void> {
  // Descending createdAt, so list() order is charlie, bravo, alpha.
  await repository.insert({
    name: "alpha",
    agentRole: "worker",
    creationSource: "builtin",
    createdAtMs: 10,
    updatedAtMs: 10,
  });
  await repository.insert({
    name: "Bravo",
    agentRole: "orchestrator",
    creationSource: "builtin",
    createdAtMs: 20,
    updatedAtMs: 20,
  });
  await repository.insert({
    name: "charlie",
    agentRole: "reviewer",
    creationSource: "auto",
    createdAtMs: 30,
    updatedAtMs: 30,
  });
}

describe("Frozen Session deletion continuity", () => {
  // This real-database create/delete/recreate sequence exceeded 5s on Windows CI.
  // Keep the larger I/O budget local to this integration case.
  it("reads the persisted definition and renders after deleting and recreating its Agent", async () => {
    const { repository, database, dataDir } = await createRepository();
    const agentService = createTestAgentService({
      repository,
      nowMs: () => 10,
    });
    await agentService.create({
      name: "snapshot-owner",
      displayName: "Original",
    });
    const original = await agentService.getConfigDocument(
      "agent:snapshot-owner",
    );
    const sessions = createSessionRepository({
      db: database.db,
      nowMs: () => 20,
    });
    const savedDefinition = {
      definitionVersion: 2 as const,
      exactOwnerName: "snapshot-owner",
      ownerInstanceId: original.ownerInstanceId,
      systemPrompt: "ORIGINAL_SESSION_PROMPT",
      capabilities: {
        tools: ["Read"],
        mcpServers: [],
        skills: [],
        extensionSkills: [],
      },
      model: { providerId: "minimax", modelId: "MiniMax-M3" },
      project: { workspaceDir: "/original-project", isDefaultWorkspace: false },
    };
    await sessions.create({
      sessionId: "frozen-task-session",
      agentName: "snapshot-owner",
      workspaceDir: "/original-project",
      runtime: "pi-agent",
      sessionType: "branch",
      sessionKind: "task",
      parentSessionId: "parent-session",
      status: "idle",
      createdAtMs: 20,
      updatedAtMs: 20,
      agentDefinition: { definition: savedDefinition },
    });
    const records = new SessionRecordService({
      sessions,
      agentBindings: sessions,
      metadata: {} as never,
      agents: {
        getDefaults: vi.fn(async () => {
          throw new Error("live defaults must not be read");
        }),
      },
      runLocation: { resolve: vi.fn(async () => undefined) },
      titlePolicy: { blocks: vi.fn(async () => false) },
      facts: { handle: vi.fn() },
    });
    const source = createV2AgentExecutionSource(
      agentService,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      records,
    );
    const profileSource = createV2AgentProfileSource(
      agentService,
      () => ({ dataDir }) as never,
      "electron",
      undefined,
    );
    const read = async () => {
      const session = await records.requireSession("frozen-task-session");
      const agent = await readSessionAgentExecutionSnapshot(source, session);
      if (!agent) throw new Error("snapshot missing");
      const binding = await records.ensureSessionAgentDefinition(
        session.sessionId,
      );
      if (!binding) throw new Error("Task binding missing");
      expect(binding.definition).toEqual(savedDefinition);
      return profileSource.render({
        session,
        agent,
        agentBinding: binding,
        isSessionFirstTurn: false,
      });
    };
    const beforeDelete = await read();
    await agentService.delete("agent:snapshot-owner");
    expect(await repository.get("snapshot-owner")).toBeUndefined();
    const afterDelete = await read();
    expect(afterDelete).toEqual(beforeDelete);
    expect(afterDelete.agentSystemPrompt).toBe("ORIGINAL_SESSION_PROMPT");
    await agentService.create({
      name: "snapshot-owner",
      displayName: "Replacement",
      initialDefinition: {
        name: "snapshot-owner",
        description: "Replacement",
        systemPrompt: "NEW_AGENT_PROMPT",
      },
    });
    expect(
      (await agentService.getConfigDocument("agent:snapshot-owner"))
        .ownerInstanceId,
    ).not.toBe(original.ownerInstanceId);
    const afterRecreate = await read();
    expect(afterRecreate).toEqual(afterDelete);
    expect(afterRecreate.corePrompt).not.toContain("NEW_AGENT_PROMPT");
  }, process.platform === "win32" ? 15_000 : 5_000);
});

describe("Local Agent reference resolver integration", () => {
  it("authorizes a freshly persisted coder for a trusted interactive Mavis turn", async () => {
    const { repository } = await createRepository();
    await repository.insert({
      name: "mavis",
      agentRole: "mavis",
      creationSource: "builtin",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await repository.insert({
      name: "coder",
      agentRole: "worker",
      creationSource: "builtin",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    const service = createTestAgentService({ repository, nowMs: () => 10 });
    const agentReferences =
      createAgentReferenceCompatibility(service).agentReferences;
    const reference = serializeAgentReference({
      requestRef: "agent:coder",
      displayName: "Coder",
    });
    if (!reference)
      throw new Error("test Agent reference serialization failed");

    await expect(
      agentReferences.resolveDelegatable("agent:coder"),
    ).resolves.toBe("authorized");
    await expect(
      projectLocalAgentReferencesForModel({
        content: `请${reference}修复登录问题`,
        agentConfig: {
          agent_profile: {
            agent_role: "orchestrator",
            canonical_view_name: "mavis",
            trusted_builtin: true,
            surface: "interactive",
          },
        },
        projection: {
          resolveAgentReference: (requestRef) =>
            agentReferences.resolveDelegatable(requestRef),
        },
      }),
    ).resolves.toBe("请通过 Task tool 调用 agent:coder Agent修复登录问题");
  });
});

describe("DrizzleAgentRepository", () => {
  registerLegacyHistoryNoticeTests();
  registerImportedDefinitionRecoveryTests();
  registerDisplayNameConflictTests();
  registerConfigDocumentPublicationTests();
});

function registerLegacyHistoryNoticeTests(): void {
  it("returns an archived, demoted frozen target after the mutable root pointer changes", async () => {
    const { repository, database } = await createRepository();
    await repository.insert({
      name: "writer",
      agentRole: "worker",
      creationSource: "builtin",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    seedLegacyHistoryTarget(database, {
      agentName: "writer",
      sessionId: "history-writer",
    });
    database.rawDb
      .prepare(
        `UPDATE local_runtime_sessions
         SET archived = 1, session_type = 'branch', parent_session_id = 'new-root'
         WHERE session_id = ?`,
      )
      .run("history-writer");
    database.rawDb
      .prepare(
        `UPDATE agents
         SET legacy_history_session_id = ?, main_session_id = ?
         WHERE agent_name = ?`,
      )
      .run("history-writer", "new-root", "writer");

    await expect(repository.getLegacyHistoryNotice("writer")).resolves.toBe(
      "history-writer",
    );
    expect(
      database.rawDb
        .prepare(
          "SELECT legacy_history_session_id FROM agents WHERE agent_name = ?",
        )
        .get("writer"),
    ).toEqual({ legacy_history_session_id: "history-writer" });
  });

  it("excludes a materialized user message that arrived after the frozen history cutoff", async () => {
    const { repository, database } = await createRepository();
    await repository.insert({
      name: "writer",
      agentRole: "worker",
      creationSource: "builtin",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    seedLegacyHistoryTarget(database, {
      agentName: "writer",
      sessionId: "history-writer",
    });
    const cutoffMs = readLegacyHistoryNoticeCutoff(database.db);
    if (cutoffMs === undefined)
      throw new Error("legacy history notice cutoff was not initialized");
    database.rawDb
      .prepare(
        "UPDATE local_runtime_message_rows SET created_at_ms = ? WHERE session_id = ?",
      )
      .run(cutoffMs + 1, "history-writer");
    database.rawDb
      .prepare(
        "UPDATE agents SET legacy_history_session_id = ? WHERE agent_name = ?",
      )
      .run("history-writer", "writer");

    await expect(
      repository.getLegacyHistoryNotice("writer"),
    ).resolves.toBeUndefined();
    expect(
      database.rawDb
        .prepare(
          "SELECT legacy_history_session_id FROM agents WHERE agent_name = ?",
        )
        .get("writer"),
    ).toEqual({ legacy_history_session_id: "history-writer" });
  });

  it("does not return a target after its frozen candidate changes during validation", async () => {
    const { repository, database } = await createRepository();
    await repository.insert({
      name: "writer",
      agentRole: "worker",
      creationSource: "builtin",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    seedLegacyHistoryTarget(database, {
      agentName: "writer",
      sessionId: "history-writer",
    });
    database.rawDb
      .prepare(
        "UPDATE agents SET legacy_history_session_id = ? WHERE agent_name = ?",
      )
      .run("history-writer", "writer");

    const notice = repository.getLegacyHistoryNotice("writer");
    database.rawDb
      .prepare(
        "UPDATE agents SET legacy_history_session_id = ? WHERE agent_name = ?",
      )
      .run("other-target", "writer");

    await expect(notice).resolves.toBeUndefined();
  });

  it("does not return a mismatched frozen target and preserves its snapshot", async () => {
    const { repository, database } = await createRepository();
    await repository.insert({
      name: "writer",
      agentRole: "worker",
      creationSource: "builtin",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await repository.insert({
      name: "other",
      agentRole: "worker",
      creationSource: "builtin",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    seedLegacyHistoryTarget(database, {
      agentName: "other",
      sessionId: "history-other",
    });
    database.rawDb
      .prepare(
        "UPDATE agents SET legacy_history_session_id = ? WHERE agent_name = ?",
      )
      .run("history-other", "writer");

    await expect(
      repository.getLegacyHistoryNotice("writer"),
    ).resolves.toBeUndefined();
    expect(
      database.rawDb
        .prepare(
          "SELECT legacy_history_session_id FROM agents WHERE agent_name = ?",
        )
        .get("writer"),
    ).toEqual({
      legacy_history_session_id: "history-other",
    });
  });
}

function registerImportedDefinitionRecoveryTests(): void {
  it("does not roll back a same-name Agent recreated after an imported owner was deleted", async () => {
    const { repository } = await createRepository();
    const service = createTestAgentService({ repository, nowMs: () => 10 });
    const application = new AgentApplication({
      service,
      root: {
        getRootSessionByAgent: vi.fn(async () => {
          throw new Error("Import definitions must not create a Root Session.");
        }),
      },
    });
    const content =
      "---\nname: imported-writer\ndescription: Imported\n---\nWrite clearly.\n";
    const preview = new AgentImportService().preview("claude-code", content);
    const originalPut = service.putConfigDocument.bind(service);
    let createdOwnerInstanceId: string | undefined;
    vi.spyOn(service, "putConfigDocument").mockImplementationOnce(
      async (input) => {
        createdOwnerInstanceId = input.expectedOwnerInstanceId;
        await service.delete("agent:imported-writer");
        await service.create({
          name: "imported-writer",
          displayName: "Replacement",
          nowMs: 20,
        });
        return originalPut(input);
      },
    );

    await expect(
      application.createImportedDefinition({
        format: "claude-code",
        content,
        expectedDigest: preview.sourceDigest,
        targetName: "imported-writer",
      }),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_INSTANCE_CONFLICT",
      status: 409,
    });

    const replacement = await service.get("agent:imported-writer");
    const replacementConfig = await service.getConfigDocument(
      "agent:imported-writer",
    );
    expect(replacement.displayName).toBe("Replacement");
    expect(createdOwnerInstanceId).toEqual(expect.any(String));
    expect(replacementConfig.ownerInstanceId).not.toBe(createdOwnerInstanceId);
  });

  it("conditionally removes the created import when Config GET fails and permits a later replacement", async () => {
    const { repository } = await createRepository();
    const service = createTestAgentService({ repository, nowMs: () => 10 });
    const application = new AgentApplication({
      service,
      root: { getRootSessionByAgent: vi.fn() },
    });
    const content =
      "---\nname: imported-reader\ndescription: Imported\n---\nRead clearly.\n";
    const preview = new AgentImportService().preview("claude-code", content);
    vi.spyOn(service, "getConfigDocument").mockRejectedValueOnce(
      new Error("Config read failed"),
    );

    await expect(
      application.createImportedDefinition({
        format: "claude-code",
        content,
        expectedDigest: preview.sourceDigest,
        targetName: "imported-reader",
      }),
    ).rejects.toThrow("Config read failed");
    await expect(service.get("agent:imported-reader")).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });

    await expect(
      service.create({
        name: "imported-reader",
        displayName: "Replacement",
        nowMs: 20,
      }),
    ).resolves.toMatchObject({ displayName: "Replacement" });
  });

  it("rejects an imported definition whose display name is already owned without leaving a target", async () => {
    const { repository } = await createRepository();
    const service = createTestAgentService({ repository, nowMs: () => 10 });
    const application = new AgentApplication({
      service,
      root: { getRootSessionByAgent: vi.fn() },
    });
    await service.create({
      name: "existing-agent",
      displayName: "imported-writer",
    });
    const content =
      "---\nname: imported-writer\ndescription: Imported\n---\nWrite clearly.\n";
    const preview = new AgentImportService().preview("claude-code", content);

    await expect(
      application.createImportedDefinition({
        format: "claude-code",
        content,
        expectedDigest: preview.sourceDigest,
        targetName: "imported-writer",
      }),
    ).rejects.toMatchObject({ code: "AGENT_NAME_CONFLICT", status: 409 });
    await expect(service.get("agent:imported-writer")).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
  });
}

function registerDisplayNameConflictTests(): void {
  it("serializes simultaneous Custom creates that request one display name", async () => {
    const { repository } = await createRepository();
    const service = createTestAgentService({ repository, nowMs: () => 10 });

    const results = await Promise.allSettled([
      service.create({
        name: "first-agent",
        displayName: "Shared display name",
      }),
      service.create({
        name: "second-agent",
        displayName: " Shared display name ",
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejection?.reason).toMatchObject({
      code: "AGENT_NAME_CONFLICT",
      status: 409,
    });
    const customAgents = (await repository.list()).filter(
      (agent) => agent.creationSource !== "builtin",
    );
    expect(customAgents).toHaveLength(1);
  });

  it("serializes simultaneous Custom renames that request one display name", async () => {
    const { repository } = await createRepository();
    const service = createTestAgentService({ repository, nowMs: () => 10 });
    await service.create({ name: "alpha", displayName: "Alpha" });
    await service.create({ name: "bravo", displayName: "Bravo" });

    const results = await Promise.allSettled([
      service.update({
        requestRef: "alpha",
        displayName: "Shared display name",
      }),
      service.update({
        requestRef: "bravo",
        displayName: " Shared display name ",
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejection = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejection?.reason).toMatchObject({
      code: "AGENT_NAME_CONFLICT",
      status: 409,
    });
    const identities = await Promise.all(
      ["alpha", "bravo"].map((name) => repository.getIdentity(name)),
    );
    expect(
      identities.filter(
        (identity) => identity?.displayName?.trim() === "Shared display name",
      ),
    ).toHaveLength(1);
  });

  it("rejects a raw Config display-name collision without replacing the canonical document", async () => {
    const { repository } = await createRepository();
    const service = createTestAgentService({ repository, nowMs: () => 10 });
    await service.create({ name: "alpha", displayName: "Alpha Agent" });
    await service.create({ name: "bravo", displayName: "Bravo Agent" });
    const before = await service.getConfigDocument("agent:bravo");
    const conflictingContent = before.content.replace(
      "displayName: Bravo Agent",
      "displayName: Alpha Agent",
    );
    expect(conflictingContent).not.toBe(before.content);

    await expect(
      service.putConfigDocument({
        requestRef: "agent:bravo",
        content: conflictingContent,
        expectedRevision: before.revision,
        expectedOwnerInstanceId: before.ownerInstanceId,
      }),
    ).rejects.toMatchObject({ code: "AGENT_NAME_CONFLICT", status: 409 });
    await expect(
      service.getConfigDocument("agent:bravo"),
    ).resolves.toMatchObject({
      content: before.content,
    });
  });

  it("allows a raw Config display name that differs only by case", async () => {
    const { repository } = await createRepository();
    const service = createTestAgentService({ repository, nowMs: () => 10 });
    await service.create({ name: "alpha", displayName: "Alpha Agent" });
    await service.create({ name: "bravo", displayName: "Bravo Agent" });
    const before = await service.getConfigDocument("agent:bravo");
    const caseDistinctContent = before.content.replace(
      "displayName: Bravo Agent",
      "displayName: alpha agent",
    );
    expect(caseDistinctContent).not.toBe(before.content);

    await expect(
      service.putConfigDocument({
        requestRef: "agent:bravo",
        content: caseDistinctContent,
        expectedRevision: before.revision,
        expectedOwnerInstanceId: before.ownerInstanceId,
      }),
    ).resolves.toMatchObject({ content: caseDistinctContent });
    await expect(service.get("agent:bravo")).resolves.toMatchObject({
      displayName: "alpha agent",
    });
  });

  it("allows a historical display-name duplicate to save a model-only Config edit", async () => {
    const { repository } = await createRepository();
    await repository.insert({
      name: "alpha",
      agentRole: "worker",
      creationSource: "manual",
      displayName: "Same name",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await repository.insert({
      name: "bravo",
      agentRole: "worker",
      creationSource: "manual",
      displayName: "Same name",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    const service = createTestAgentService({ repository, nowMs: () => 10 });
    const before = await service.getConfigDocument("agent:alpha");
    const modelOnlyContent = before.content.replace(
      "description: Same name\n",
      "description: Same name\nmodel: minimax/MiniMax-M3\n",
    );

    await expect(
      service.putConfigDocument({
        requestRef: "agent:alpha",
        content: modelOnlyContent,
        expectedRevision: before.revision,
        expectedOwnerInstanceId: before.ownerInstanceId,
      }),
    ).resolves.toMatchObject({ configured: { model: "minimax/MiniMax-M3" } });
  });
}

function registerConfigDocumentPublicationTests(): void {
  it("reads and repairs an Agent configuration after its selected model is removed", async () => {
    const { repository } = await createRepository();
    const service = createTestAgentService({ repository, nowMs: () => 10 });
    const models: Record<
      string,
      { limit: { context: number; output: number } }
    > = {
      original: { limit: { context: 128_000, output: 8_192 } },
      replacement: { limit: { context: 128_000, output: 8_192 } },
    };
    service.bindEffectiveConfigResolver(async ({ configuredModelSelection }) =>
      previewAgentModelSelection({
        config: { dataDir: "/unused", provider: { target: { models } } },
        sources: configuredModelSelection.model
          ? [
              {
                source: "agent-config-preview",
                selection: configuredModelSelection,
                requireCatalog: true,
              },
            ]
          : [],
      }),
    );
    await service.create({ name: "model-repair", nowMs: 10 });
    const initial = await service.getConfigDocument("model-repair");
    const configured = await service.putConfigDocument({
      requestRef: "model-repair",
      content:
        "---\nname: model-repair\ndescription: Repair test\nmodel: target/original\n---\nKeep this prompt.\n",
      expectedRevision: initial.revision,
      expectedOwnerInstanceId: initial.ownerInstanceId,
    });
    expect(configured.effectiveForNewSession.modelId).toBe("original");
    delete models.original;
    const afterDeletion = await service.getConfigDocument("model-repair");
    expect(afterDeletion.content).toBe(configured.content);
    expect(afterDeletion.revision).toBe(configured.revision);
    expect(afterDeletion.effectiveForNewSession.modelId).toBeUndefined();
    const repaired = await service.putConfigDocument({
      requestRef: "model-repair",
      content: afterDeletion.content.replace(
        "target/original",
        "target/replacement",
      ),
      expectedRevision: afterDeletion.revision,
      expectedOwnerInstanceId: afterDeletion.ownerInstanceId,
    });
    expect(repaired.effectiveForNewSession.modelId).toBe("replacement");
    expect(repaired.configured.systemPrompt).toBe("Keep this prompt.\n");
  });

  it("returns full Config documents and fences a stale Custom editor after same-name recreation", async () => {
    const { repository } = await createRepository();
    const service = createTestAgentService({ repository, nowMs: () => 10 });
    const resolveEffective = vi.fn(
      async ({ profile, configuredModelSelection }) => {
        if (!configuredModelSelection.model) return undefined;
        expect(profile.configSelection).toMatchObject({
          model: "minimax/MiniMax-M3",
        });
        expect(configuredModelSelection).toMatchObject({
          model: "minimax/MiniMax-M3",
        });
        return {
          providerId: "minimax",
          modelId: "MiniMax-M3",
          contextWindow: 512_000,
          maxOutputTokens: 128_000,
        };
      },
    );
    service.bindEffectiveConfigResolver(resolveEffective);
    await service.create({ name: "config-api", nowMs: 10 });
    const initial = await service.getConfigDocument("config-api");
    expect(initial).toMatchObject({
      exactOwnerName: "config-api",
      ownerKind: "custom",
      persistence: "persistent",
      appliesTo: "new-sessions-only",
      configured: { name: "config-api" },
    });
    expect(initial.ownerInstanceId).toEqual(expect.any(String));

    const changedContent =
      "---\nname: config-api\ndescription: Config API\nmodel: minimax/MiniMax-M3\n---\nChanged prompt\n";
    const updated = await service.putConfigDocument({
      requestRef: "config-api",
      content: changedContent,
      expectedRevision: initial.revision,
      expectedOwnerInstanceId: initial.ownerInstanceId,
    });
    expect(updated).toMatchObject({
      content: changedContent,
      configured: {
        model: "minimax/MiniMax-M3",
        systemPrompt: "Changed prompt\n",
      },
      effectiveForNewSession: { providerId: "minimax", modelId: "MiniMax-M3" },
    });
    expect(resolveEffective).toHaveBeenCalled();

    await expect(
      service.putConfigDocument({
        requestRef: "config-api",
        content: initial.content,
        expectedRevision: initial.revision,
        expectedOwnerInstanceId: initial.ownerInstanceId,
      }),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_REVISION_CONFLICT",
      status: 409,
    });

    await service.delete("config-api");
    await service.create({ name: "config-api", nowMs: 20 });
    await expect(
      service.putConfigDocument({
        requestRef: "config-api",
        content: initial.content,
        expectedRevision: initial.revision,
        expectedOwnerInstanceId: initial.ownerInstanceId,
      }),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_INSTANCE_CONFLICT",
      status: 409,
    });
  });

  it("publishes a Custom Agent as canonical agent.md without recreating legacy assets", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "agent-repository-"));
    cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
    const legacyPath = join(dataDir, "sqlite.db");
    await writeFile(legacyPath, "legacy-db-sentinel");
    const legacyHash = createHash("sha256")
      .update(await readFile(legacyPath))
      .digest("hex");
    const database = new DatabaseClient({ dataDir });
    cleanup.push(() => database.close());
    await initializeDatabase({ database, dataDir });
    const repository = new DrizzleAgentRepository({ db: database.db, dataDir });

    await repository.insert({
      name: "worker",
      agentRole: "worker",
      creationSource: "manual",
      displayName: "Worker",
      description: "A worker",
      persona: "Persona",
      systemPrompt: "System",
      createdAtMs: 10,
      updatedAtMs: 10,
    });
    await repository.insert({
      name: "mavis",
      agentRole: "orchestrator",
      creationSource: "builtin",
      defaultWorkspaceDir: "/workspace/mavis",
      createdAtMs: 20,
      updatedAtMs: 20,
    });

    await expect(
      readFile(join(repository.getAgentDir("worker"), "agent.md"), "utf8"),
    ).resolves.toBe(
      "---\nname: worker\ndescription: A worker\nx-mavis:\n  displayName: Worker\n---\n\nPersona\n\nSystem",
    );
    await expect(readdir(repository.getAgentDir("worker"))).resolves.toEqual([
      ".agent-instance-id",
      "agent.md",
    ]);
    await expect(
      readFile(join(repository.getAgentDir("worker"), "config.yaml"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(repository.getAgentDir("worker"), "PERSONA.md"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(repository.getIdentity("worker")).resolves.toEqual({
      displayName: "Worker",
      description: "A worker",
    });
    const storedIdentity = database.rawDb
      .prepare("SELECT enc_display_name FROM agents WHERE agent_name = ?")
      .get("worker") as { enc_display_name?: unknown };
    expect(storedIdentity.enc_display_name).toBeNull();
    await expect(repository.list()).resolves.toMatchObject([
      { name: "mavis", agentRole: "orchestrator" },
      { name: "worker", agentRole: "worker" },
    ]);

    await expect(
      repository.updateAssets({
        name: "worker",
        displayName: "Worker Updated",
        description: "Updated worker description",
        avatar: null,
        updatedAtMs: 30,
      }),
    ).resolves.toBe(true);
    await expect(repository.getIdentity("worker")).resolves.toMatchObject({
      displayName: "Worker Updated",
      description: "Updated worker description",
    });
    await expect(
      repository.update("worker", { greetingSent: true, updatedAtMs: 40 }),
    ).resolves.toBe(true);
    await expect(repository.get("worker")).resolves.toMatchObject({
      greetingSent: true,
      updatedAtMs: 40,
    });

    await expect(repository.delete("worker")).resolves.toBe(true);
    await expect(repository.get("worker")).resolves.toBeUndefined();
    expect(
      createHash("sha256")
        .update(await readFile(legacyPath))
        .digest("hex"),
    ).toBe(legacyHash);
  });
}

describe("DrizzleAgentRepository canonical publication and migration safety", () => {
  registerBuiltinCanonicalPublicationTests();
  registerCanonicalAvatarPublicationTests();
});

function registerBuiltinCanonicalPublicationTests(): void {
  it.each(["tui", "coding", "work"] as const)(
    "renders %s after canonical publication and restores its Task snapshot",
    async (promptMode) => {
      const { repository } = await createRepository();
      const service = new LocalAgentService({
        repository,
        nowMs: () => 10,
        promptMode,
        promptVersion: "0.4.1",
      });
      const modelGroup = {
        model: "provider/model",
        effort: "high",
        contextWindow: 32_000,
      };
      service.bindBuiltinModelGroupResolver(async () => modelGroup);
      await service.ensureBuiltinRows({ nowMs: 10 });
      const canonical = await repository.getBuiltinCanonicalConfig("mavis");
      expect(canonical.systemPrompt).toContain("## Media Output");
      const input = {
        exactOwnerName: "mavis",
        surface: "cli" as const,
        promptProfile: "tui" as const,
        appMode: "coding" as const,
        capabilities: {
          tools: [],
          features: { mavis: false, delegation: false, webSearch: false },
        },
        memoryEnabled: false,
        cronEnabled: false,
      };
      const profile = await service.renderProfile({
        ...input,
        memoryEnabled: true,
      });
      expect(profile.promptSnapshot).toMatchObject({
        mode: promptMode,
        version: "0.4.1",
      });
      expect(profile.corePrompt).toContain(
        promptMode === "tui"
          ? "You are a coding agent running in the MiniMax Code terminal"
          : "You run inside MiniMax Code",
      );
      expect(profile.corePrompt).toContain("# Harness");
      expect(profile.corePrompt.includes("## Media Output")).toBe(
        promptMode !== "tui",
      );
      expect(profile.configSelection).toMatchObject(modelGroup);
      const definition = {
        systemPrompt: profile.agentSystemPrompt ?? "",
        promptSnapshot: profile.promptSnapshot,
        capabilities: {},
      };
      const frozen = await service.renderFrozenProfile(
        { ...input, surface: "task-child" },
        definition,
      );
      expect(frozen.promptSnapshot?.template).toBe(
        profile.promptSnapshot?.template,
      );
      expect(frozen.corePrompt).toContain("# Harness");
      expect(profile.corePrompt).toContain("# Memory");
      expect(frozen.corePrompt).not.toContain("# Memory");
      expect(frozen.corePrompt).not.toContain(
        "user's active MiniMax Code terminal conversation",
      );
      expect(frozen.corePrompt).not.toContain("this agent's root session");
      expect(frozen.surfacePrompt).toContain("hidden TUI child Agent");
      const other = new LocalAgentService({
        repository,
        promptMode: promptMode === "work" ? "tui" : "work",
      });
      await expect(
        other.renderFrozenProfile(input, definition),
      ).rejects.toThrow("saved Task Prompt does not match");
      await expect(
        service.renderFrozenProfile(input, {
          systemPrompt: "legacy",
          capabilities: {},
        }),
      ).resolves.toMatchObject({ agentSystemPrompt: "legacy" });
      expect(await repository.getBuiltinCanonicalConfig("mavis")).toEqual(
        canonical,
      );
    },
  );

  it("rebuilds a legacy partial-policy Builtin with the resolver-provided M3 thinking group and removes stale Mavis/main files", async () => {
    const { repository, dataDir } = await createRepository();
    const mavisBuiltin = join(
      dataDir,
      "agents",
      ".builtin",
      "mavis",
      "agent.md",
    );
    const mainBuiltin = join(dataDir, "agents", ".builtin", "main", "agent.md");
    const exploreBuiltin = join(
      dataDir,
      "agents",
      ".builtin",
      "explore",
      "agent.md",
    );
    await mkdir(join(dataDir, "agents", ".builtin", "mavis"), {
      recursive: true,
    });
    await mkdir(join(dataDir, "agents", ".builtin", "main"), {
      recursive: true,
    });
    await mkdir(join(dataDir, "agents", ".builtin", "explore"), {
      recursive: true,
    });
    await writeFile(mavisBuiltin, "stale mavis config");
    await writeFile(mainBuiltin, "stale main config");
    await writeFile(
      exploreBuiltin,
      "---\nname: explore\ndescription: stale description\nmodel: provider/model\neffort: high\nx-mavis:\n  contextWindow: 32000\n  maxOutputTokens: 4096\nmcpServers:\n  - not-a-tool-id\nfeatures:\n  webSearch: true\n---\n\nstale prompt\n",
    );

    const service = createTestAgentService({ repository, nowMs: () => 10 });
    const bundled = {
      model: "bundled/default",
      effort: "low",
      contextWindow: 16_000,
      maxOutputTokens: 1_024,
    } as const;
    const resolveModelGroup = vi.fn(async (input) => {
      if (input.previous?.model === "provider/model") {
        return {
          model: "minimax/MiniMax-M3",
          effort: "on",
          contextWindow: 64_000,
          maxOutputTokens: 2_048,
        };
      }
      return bundled;
    });
    service.bindBuiltinModelGroupResolver(resolveModelGroup, bundled);
    await service.ensureBuiltinRows({ nowMs: 10 });

    await expect(readFile(mavisBuiltin, "utf8")).resolves.toContain(
      "name: mavis",
    );
    await expect(readFile(mainBuiltin, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(dataDir, "agents", "mavis", "agent.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const rebuilt = await repository.getBuiltinCanonicalConfig("explore");
    expect(rebuilt).toMatchObject({
      name: "explore",
      model: "minimax/MiniMax-M3",
      effort: "on",
      xMavis: { contextWindow: 64_000, maxOutputTokens: 2_048 },
      systemPrompt: expect.not.stringContaining("stale prompt"),
    });
    expect(rebuilt.mcpServers).toBeUndefined();
    expect(rebuilt).not.toHaveProperty("features");
    const rebuiltPolicies = Object.fromEntries(
      await Promise.all(
        ["explore", "worker", "verifier"].map(
          async (name) =>
            [
              name,
              await readFile(
                join(dataDir, "agents", ".builtin", name, "agent.md"),
                "utf8",
              ),
            ] as const,
        ),
      ),
    );
    expect(rebuiltPolicies).toMatchObject({
      explore: expect.stringContaining(
        "features:\n  mavis: false\n  delegation: false\n  webSearch: true",
      ),
      worker: expect.stringContaining(
        "features:\n  mavis: true\n  delegation: false\n  webSearch: true",
      ),
      verifier: expect.stringContaining(
        "features:\n  mavis: false\n  delegation: false\n  webSearch: true",
      ),
    });
    expect(resolveModelGroup).toHaveBeenCalledWith({
      previous: {
        model: "provider/model",
        effort: "high",
        contextWindow: 32_000,
        maxOutputTokens: 4_096,
      },
      bundled,
    });
  });

  it("persists only model-group changes through a Builtin raw Config PUT", async () => {
    const { repository, dataDir } = await createRepository();
    const service = createTestAgentService({ repository, nowMs: () => 10 });
    const initialModel = {
      model: "minimax/MiniMax-M3",
      effort: "high",
      contextWindow: 32_768,
      maxOutputTokens: 4_096,
    } as const;
    service.bindBuiltinModelGroupResolver(
      async () => initialModel,
      initialModel,
    );
    await service.ensureBuiltinRows({ nowMs: 10 });

    const initial = await service.getConfigDocument("explore");
    const modelOnlyContent = initial.content
      .replace("model: minimax/MiniMax-M3", "model: openai/gpt-6")
      .replace("effort: high", "effort: low")
      .replace("contextWindow: 32768", "contextWindow: 65536")
      .replace("maxOutputTokens: 4096", "maxOutputTokens: 8192");
    expect(modelOnlyContent).not.toBe(initial.content);

    const updated = await service.putConfigDocument({
      requestRef: "explore",
      content: modelOnlyContent,
      expectedRevision: initial.revision,
    });
    expect(updated).toMatchObject({
      ownerKind: "builtin",
      content: modelOnlyContent,
      configured: {
        model: "openai/gpt-6",
        effort: "low",
        mavis: { contextWindow: 65_536, maxOutputTokens: 8_192 },
        systemPrompt: initial.configured.systemPrompt,
      },
    });
    const agentFile = join(
      dataDir,
      "agents",
      ".builtin",
      "explore",
      "agent.md",
    );
    await expect(readFile(agentFile, "utf8")).resolves.toBe(modelOnlyContent);

    await expect(
      service.putConfigDocument({
        requestRef: "explore",
        content: modelOnlyContent.replace(
          /^description: .+$/mu,
          "description: Changed",
        ),
        expectedRevision: updated.revision,
      }),
    ).rejects.toMatchObject({ code: "BUILTIN_AGENT_IMMUTABLE", status: 403 });
    await expect(readFile(agentFile, "utf8")).resolves.toBe(modelOnlyContent);
  });
}

function registerCanonicalAvatarPublicationTests(): void {
  it("keeps an unsafe avatar out of the published config and fails with a stable error", async () => {
    const { repository } = await createRepository();

    await expect(
      repository.insert({
        name: "unsafe-avatar",
        agentRole: "worker",
        creationSource: "manual",
        avatar: "https://example.invalid/avatar.png",
        createdAtMs: 10,
        updatedAtMs: 10,
      }),
    ).rejects.toMatchObject({ code: "AGENT_CONFIG_AVATAR_INVALID" });
    await expect(repository.get("unsafe-avatar")).resolves.toBeUndefined();
  });

  it("materializes a bounded Desktop image data URL beside canonical agent.md", async () => {
    const { repository } = await createRepository();

    await repository.insert({
      name: "data-avatar",
      agentRole: "worker",
      creationSource: "manual",
      avatar: PNG_DATA_URL,
      createdAtMs: 10,
      updatedAtMs: 10,
    });

    const agentDir = repository.getAgentDir("data-avatar");
    await expect(repository.getIdentity("data-avatar")).resolves.toMatchObject({
      avatar: "./avatar.png",
    });
    await expect(readFile(join(agentDir, "avatar.png"))).resolves.toEqual(
      PNG_BYTES,
    );
    await expect(
      readFile(join(agentDir, "agent.md"), "utf8"),
    ).resolves.toContain("avatar: ./avatar.png");
  });

  it("persists a virtual default-avatar marker without materializing avatar bytes", async () => {
    const { repository } = await createRepository();
    const marker = formatDefaultAgentAvatarMarker(4);

    await repository.insert({
      name: "marker-avatar",
      agentRole: "worker",
      creationSource: "manual",
      avatar: marker,
      createdAtMs: 10,
      updatedAtMs: 10,
    });

    await expect(
      repository.getIdentity("marker-avatar"),
    ).resolves.toMatchObject({ avatar: marker });
    await expect(
      repository.readCustomAvatar("marker-avatar"),
    ).resolves.toBeUndefined();
    await expect(
      readdir(repository.getAgentDir("marker-avatar")),
    ).resolves.toEqual([".agent-instance-id", "agent.md"]);
  });

  it("serves a Custom avatar only from its verified canonical relative file", async () => {
    const { repository } = await createRepository();
    await repository.insert({
      name: "canonical-avatar",
      agentRole: "worker",
      creationSource: "manual",
      avatar: PNG_DATA_URL,
      createdAtMs: 10,
      updatedAtMs: 10,
    });
    // This legacy SQLite field is deliberately not a runtime Custom source.
    await repository.updateIdentity("canonical-avatar", {
      avatar: "./legacy-avatar.png",
    });

    await expect(
      repository.readCustomAvatar("canonical-avatar"),
    ).resolves.toEqual({
      bytes: PNG_BYTES,
      contentType: "image/png",
    });
  });

  it("never exposes a Builtin avatar through the Custom local-file reader", async () => {
    const { repository } = await createRepository();
    await repository.insert({
      name: "builtin-avatar",
      agentRole: "worker",
      creationSource: "builtin",
      avatar: "https://example.invalid/builtin.png",
      createdAtMs: 10,
      updatedAtMs: 10,
    });

    await expect(
      repository.readCustomAvatar("builtin-avatar"),
    ).resolves.toBeUndefined();
  });

  it("accepts a pre-staged regular local image and references it relatively", async () => {
    const { repository } = await createRepository();
    const agentDir = repository.getAgentDir("with-avatar");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "avatar.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );

    await repository.insert({
      name: "with-avatar",
      agentRole: "worker",
      creationSource: "manual",
      avatar: "./avatar.png",
      createdAtMs: 10,
      updatedAtMs: 10,
    });

    await expect(repository.getIdentity("with-avatar")).resolves.toMatchObject({
      avatar: "./avatar.png",
    });
  });

  it("never overwrites a pre-existing avatar while publishing a Desktop data URL", async () => {
    const { repository } = await createRepository();
    const agentDir = repository.getAgentDir("occupied-avatar");
    const existing = Buffer.concat([PNG_BYTES, Buffer.from("existing")]);
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "avatar.png"), existing);

    await expect(
      repository.insert({
        name: "occupied-avatar",
        agentRole: "worker",
        creationSource: "manual",
        avatar: PNG_DATA_URL,
        createdAtMs: 10,
        updatedAtMs: 10,
      }),
    ).rejects.toMatchObject({ code: "AGENT_CONFIG_AVATAR_INVALID" });
    await expect(repository.get("occupied-avatar")).resolves.toBeUndefined();
    await expect(readFile(join(agentDir, "avatar.png"))).resolves.toEqual(
      existing,
    );
    await expect(
      readFile(join(agentDir, "agent.md"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
}

describe("DrizzleAgentRepository Desktop Agent directory safety", () => {
  it("writes through a linked agents root to the resolved target", async () => {
    const { repository, dataDir } = await createRepository();
    const outsideDir = await mkdtemp(
      join(tmpdir(), "agent-repository-linked-agents-"),
    );
    cleanup.push(() => rm(outsideDir, { recursive: true, force: true }));
    await symlink(outsideDir, join(dataDir, "agents"));

    await expect(
      repository.insert({
        name: "linked-agents",
        agentRole: "worker",
        creationSource: "manual",
        avatar: PNG_DATA_URL,
        createdAtMs: 10,
        updatedAtMs: 10,
      }),
    ).resolves.toBeUndefined();
    await expect(
      readFile(join(outsideDir, "linked-agents", "avatar.png")),
    ).resolves.toEqual(PNG_BYTES);
    await expect(
      readFile(join(outsideDir, "linked-agents", "agent.md"), "utf8"),
    ).resolves.toContain("name: linked-agents");
  });

  it("writes through a linked Custom Agent directory to the resolved target", async () => {
    const { repository, dataDir } = await createRepository();
    const outsideDir = await mkdtemp(
      join(tmpdir(), "agent-repository-linked-agent-"),
    );
    cleanup.push(() => rm(outsideDir, { recursive: true, force: true }));
    await mkdir(join(dataDir, "agents"), { recursive: true });
    await symlink(outsideDir, join(dataDir, "agents", "linked-agent"));

    await expect(
      repository.insert({
        name: "linked-agent",
        agentRole: "worker",
        creationSource: "manual",
        avatar: PNG_DATA_URL,
        createdAtMs: 10,
        updatedAtMs: 10,
      }),
    ).resolves.toBeUndefined();
    await expect(readFile(join(outsideDir, "avatar.png"))).resolves.toEqual(
      PNG_BYTES,
    );
    await expect(
      readFile(join(outsideDir, "agent.md"), "utf8"),
    ).resolves.toContain("name: linked-agent");
  });

  it("writes through a linked .builtin directory to the resolved target", async () => {
    const { repository, dataDir } = await createRepository();
    const outsideDir = await mkdtemp(
      join(tmpdir(), "agent-repository-linked-builtin-"),
    );
    cleanup.push(() => rm(outsideDir, { recursive: true, force: true }));
    await mkdir(join(dataDir, "agents"), { recursive: true });
    await symlink(outsideDir, join(dataDir, "agents", ".builtin"));

    await expect(
      repository.writeBuiltinCanonicalConfig("explore", {
        name: "explore",
        description: "Builtin",
        features: { mavis: false, delegation: false, webSearch: true },
        systemPrompt: "Builtin prompt",
      }),
    ).resolves.toBeUndefined();
    await expect(
      readFile(join(outsideDir, "explore", "agent.md"), "utf8"),
    ).resolves.toContain("name: explore");
  });
});

describe("DrizzleAgentRepository canonical publication and runtime-state repair", () => {
  it("keeps a published Custom file when SQLite state insertion fails, then retries state only", async () => {
    const { repository, database } = await createRepository();
    const insertIndexRow = vi
      .spyOn(
        repository as unknown as { insertIndexRow(): void },
        "insertIndexRow",
      )
      .mockImplementationOnce(() => {
        throw new Error("SQLite temporarily unavailable");
      });
    const service = createTestAgentService({ repository, nowMs: () => 10 });

    await expect(
      service.create({ name: "retry-state", avatar: PNG_DATA_URL, nowMs: 1 }),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      details: { field: "runtime_state" },
    });
    const agentFile = join(repository.getAgentDir("retry-state"), "agent.md");
    const avatarFile = join(
      repository.getAgentDir("retry-state"),
      "avatar.png",
    );
    const published = await readFile(agentFile, "utf8");
    await expect(readFile(avatarFile)).resolves.toEqual(PNG_BYTES);
    expect(
      database.rawDb
        .prepare("SELECT agent_name FROM agents WHERE agent_name = ?")
        .get("retry-state"),
    ).toBeUndefined();

    await expect(
      service.create({ name: "retry-state", nowMs: 2 }),
    ).resolves.toMatchObject({
      name: "retry-state",
      creationSource: "manual",
      createdAtMs: 2,
      updatedAtMs: 2,
    });
    await expect(readFile(agentFile, "utf8")).resolves.toBe(published);
    await expect(readFile(avatarFile)).resolves.toEqual(PNG_BYTES);
    expect(
      database.rawDb
        .prepare("SELECT agent_name FROM agents WHERE agent_name = ?")
        .get("retry-state"),
    ).toEqual({ agent_name: "retry-state" });
    insertIndexRow.mockRestore();
  });

  it("adopts an existing DB-only Custom runtime row after canonical publication", async () => {
    const { repository } = await createRepository();
    await repository.insert({
      name: "legacy-row",
      agentRole: "reviewer",
      creationSource: "builtin",
      rootSessionId: "legacy-root",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await repository.update("legacy-row", {
      creationSource: "manual",
      updatedAtMs: 2,
    });

    const service = createTestAgentService({ repository, nowMs: () => 10 });
    await expect(
      service.create({
        name: "legacy-row",
        description: "New canonical definition",
        nowMs: 3,
      }),
    ).resolves.toMatchObject({
      name: "legacy-row",
      agentRole: "reviewer",
      rootSessionId: "legacy-root",
      creationSource: "manual",
    });
    await expect(
      repository.getCanonicalConfig("legacy-row"),
    ).resolves.toMatchObject({
      description: "New canonical definition",
    });
  });
});

describe("DrizzleAgentRepository atomic initial definitions", () => {
  registerAtomicDefinitionPublicationTests();
  registerAtomicDefinitionCreationTests();
  registerAtomicDefinitionFailureTests();
});

function registerAtomicDefinitionPublicationTests(): void {
  it("makes the complete canonical definition readable when agent.created is published", async () => {
    const { repository } = await createRepository();
    const service = createTestAgentService({ repository, nowMs: () => 10 });
    const observed: Promise<
      Awaited<ReturnType<typeof service.getConfigDocument>>
    >[] = [];
    const published = vi.fn(
      (event: { readonly type: string; readonly payload: unknown }) => {
        if (event.type === "agent.created") {
          observed.push(
            service.getConfigDocument(
              (event.payload as { agentName: string }).agentName,
            ),
          );
        }
      },
    );
    const application = new AgentApplication({
      service,
      root: { getRootSessionByAgent: vi.fn() },
      publish: published,
    });
    const description = "  Writes complete reviews  ";
    const systemPrompt =
      "\r\n  Keep this first line.\r\n\r\nKeep this trailing space. \r\n";

    await application.createDefinition({
      name: "atomic-writer",
      initialDefinition: {
        name: "presentation-only-name",
        description,
        model: "minimax/MiniMax-M3",
        effort: "none",
        tools: ["read", "write"],
        disallowedTools: ["shell"],
        mcpServers: ["design"],
        skills: ["review"],
        mavis: {
          displayName: "Atomic Writer",
          avatar: PNG_DATA_URL,
          contextWindow: 1_000_000,
          maxOutputTokens: 8_192,
          defaultWorkspaceDir: "/workspace/writer",
          extensionSkills: ["lint"],
        },
        systemPrompt,
      },
    });

    expect(published).toHaveBeenCalledWith({
      type: "agent.created",
      payload: { agentName: "atomic-writer" },
    });
    expect(observed).toHaveLength(1);
    const [document] = observed;
    if (!document)
      throw new Error("agent.created did not observe a Config document.");
    const observedConfig = await document;
    expect(observedConfig).toMatchObject({
      exactOwnerName: "atomic-writer",
      configured: {
        name: "atomic-writer",
        description,
        model: "minimax/MiniMax-M3",
        effort: "none",
        tools: ["read", "write"],
        disallowedTools: ["shell"],
        mcpServers: ["design"],
        skills: ["review"],
        mavis: {
          displayName: "Atomic Writer",
          avatar: "./avatar.png",
          contextWindow: 1_000_000,
          maxOutputTokens: 8_192,
          defaultWorkspaceDir: "/workspace/writer",
          extensionSkills: ["lint"],
        },
        systemPrompt,
      },
    });
    await expect(
      service.getConfigDocument("atomic-writer"),
    ).resolves.toMatchObject({
      configured: { systemPrompt },
    });
    expect(
      (
        await readFile(
          join(repository.getAgentDir("atomic-writer"), "agent.md"),
          "utf8",
        )
      ).endsWith(`\n\n${systemPrompt}`),
    ).toBe(true);
    await expect(
      readFile(join(repository.getAgentDir("atomic-writer"), "avatar.png")),
    ).resolves.toEqual(PNG_BYTES);
  });
}

function registerAtomicDefinitionCreationTests(): void {
  it("creates a UI definition without a route name using a generated durable owner", async () => {
    const { repository } = await createRepository();
    const service = createTestAgentService({ repository, nowMs: () => 10 });
    const observed: Promise<
      Awaited<ReturnType<typeof service.getConfigDocument>>
    >[] = [];
    const published = vi.fn(
      (event: { readonly type: string; readonly payload: unknown }) => {
        if (event.type === "agent.created") {
          observed.push(
            service.getConfigDocument(
              (event.payload as { agentName: string }).agentName,
            ),
          );
        }
      },
    );
    const application = new AgentApplication({
      service,
      root: { getRootSessionByAgent: vi.fn() },
      publish: published,
    });
    const systemPrompt = "第一行。\n\n保留换行。\n";

    const created = await application.createDefinition({
      displayName: "测试删除",
      initialDefinition: {
        name: "测试删除",
        description: "",
        model: "minimax/MiniMax-M3",
        mavis: { displayName: "测试删除", avatar: PNG_DATA_URL },
        systemPrompt,
      },
    });

    expect(created).toMatchObject({ displayName: "测试删除" });
    expect(created.exactOwnerName).toMatch(/^agent-[a-f0-9]{12}$/u);
    expect(published).toHaveBeenCalledWith({
      type: "agent.created",
      payload: { agentName: created.exactOwnerName },
    });
    expect(observed).toHaveLength(1);
    const [document] = observed;
    if (!document)
      throw new Error("agent.created did not observe a Config document.");
    await expect(document).resolves.toMatchObject({
      exactOwnerName: created.exactOwnerName,
      configured: {
        name: created.exactOwnerName,
        description: "测试删除",
        model: "minimax/MiniMax-M3",
        mavis: { displayName: "测试删除", avatar: "./avatar.png" },
        systemPrompt,
      },
    });
    await expect(
      readFile(
        join(repository.getAgentDir(created.exactOwnerName), "avatar.png"),
      ),
    ).resolves.toEqual(PNG_BYTES);
    await expect(
      application.createDefinition({
        displayName: "测试删除",
        initialDefinition: {
          name: "测试删除",
          description: "",
          model: "minimax/MiniMax-M3",
          mavis: { displayName: "测试删除", avatar: PNG_DATA_URL },
          systemPrompt,
        },
      }),
    ).rejects.toMatchObject({ code: "AGENT_NAME_CONFLICT", status: 409 });
  });

  it("keeps explicit route names authoritative and rejects invalid or duplicate owners", async () => {
    const { repository } = await createRepository();
    const service = createTestAgentService({ repository, nowMs: () => 10 });
    const application = new AgentApplication({
      service,
      root: { getRootSessionByAgent: vi.fn() },
    });
    const input = {
      name: "desktop-writer",
      displayName: "测试删除",
      initialDefinition: {
        name: "测试删除",
        description: "",
        model: "minimax/MiniMax-M3",
        mavis: { displayName: "测试删除" },
        systemPrompt: "Keep the route owner.",
      },
    };

    const created = await application.createDefinition(input);

    expect(created.exactOwnerName).toBe("desktop-writer");
    await expect(
      service.getConfigDocument("desktop-writer"),
    ).resolves.toMatchObject({
      configured: {
        name: "desktop-writer",
        description: "测试删除",
        model: "minimax/MiniMax-M3",
      },
    });
    await expect(application.createDefinition(input)).rejects.toMatchObject({
      code: "AGENT_NAME_CONFLICT",
      status: 409,
    });
    await expect(
      application.createDefinition({
        name: "测试删除",
        displayName: "Another display name",
        initialDefinition: {
          name: "presentation-only-name",
          description: "",
          systemPrompt: "Prompt",
        },
      }),
    ).rejects.toMatchObject({ code: "AGENT_NAME_INVALID", status: 400 });
  });
}

function registerAtomicDefinitionFailureTests(): void {
  it("keeps an Auto initial definition free of a model group", async () => {
    const { repository } = await createRepository();
    const service = createTestAgentService({ repository, nowMs: () => 10 });

    await service.create({
      name: "auto-writer",
      initialDefinition: {
        name: "auto-placeholder",
        description: "Uses the automatic model",
        systemPrompt: "Prompt",
      },
    });

    await expect(
      service.getConfigDocument("auto-writer"),
    ).resolves.toMatchObject({
      configured: {
        name: "auto-writer",
        description: "Uses the automatic model",
        systemPrompt: "Prompt",
      },
      effectiveForNewSession: {},
    });
  });

  it("removes every visible create artifact and suppresses agent.created on initial persistence failure", async () => {
    const { repository, database } = await createRepository();
    const insertIndexRow = vi
      .spyOn(
        repository as unknown as { insertIndexRow(): void },
        "insertIndexRow",
      )
      .mockImplementationOnce(() => {
        throw new Error("SQLite temporarily unavailable");
      });
    const service = createTestAgentService({ repository, nowMs: () => 10 });
    const published = vi.fn();
    const application = new AgentApplication({
      service,
      root: { getRootSessionByAgent: vi.fn() },
      publish: published,
    });
    const name = "atomic-failure";

    await expect(
      application.createDefinition({
        name,
        initialDefinition: {
          name: "placeholder",
          description: "Must not become visible",
          mavis: { avatar: PNG_DATA_URL },
          systemPrompt: "Prompt",
        },
      }),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      details: { field: "runtime_state" },
    });

    expect(published).not.toHaveBeenCalled();
    await expect(repository.get(name)).resolves.toBeUndefined();
    await expect(repository.list()).resolves.toEqual([]);
    expect(
      database.rawDb
        .prepare("SELECT agent_name FROM agents WHERE agent_name = ?")
        .get(name),
    ).toBeUndefined();
    await expect(
      readFile(join(repository.getAgentDir(name), "agent.md"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readFile(join(repository.getAgentDir(name), "avatar.png")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readdir(repository.getAgentDir(name))).resolves.toEqual([]);
    insertIndexRow.mockRestore();
  });

  it("rejects an invalid initial definition without a default or partial Agent", async () => {
    const { repository, database } = await createRepository();
    const service = createTestAgentService({ repository, nowMs: () => 10 });
    const name = "invalid-initial";
    const preparedAvatar = vi.spyOn(
      AgentFiles.prototype,
      "prepareCustomCreateAvatar",
    );

    try {
      await expect(
        service.create({
          name,
          initialDefinition: {
            name: "placeholder",
            description: "Invalid model must not persist",
            model: "not a provider/model",
            mavis: { avatar: PNG_DATA_URL },
            systemPrompt: "Prompt",
          },
        }),
      ).rejects.toMatchObject({
        code: "AGENT_CONFIG_INVALID",
        details: { field: "model" },
      });

      expect(preparedAvatar).toHaveBeenCalledWith(name, PNG_DATA_URL, true);
      await expect(repository.get(name)).resolves.toBeUndefined();
      await expect(repository.list()).resolves.toEqual([]);
      expect(
        database.rawDb
          .prepare("SELECT agent_name FROM agents WHERE agent_name = ?")
          .get(name),
      ).toBeUndefined();
      await expect(
        readFile(join(repository.getAgentDir(name), "agent.md"), "utf8"),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        readFile(join(repository.getAgentDir(name), "avatar.png")),
      ).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      preparedAvatar.mockRestore();
    }
  });
}

describe("DrizzleAgentRepository legacy canonical materialization safety", () => {
  it("fills only a missing canonical display name from the V2 target identity", async () => {
    const { repository, database } = await createRepository();
    const name = "canonical-v2-identity";
    database.rawDb
      .prepare(
        "INSERT INTO agents (agent_name, agent_role, framework_type, creation_source, enc_display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        name,
        0,
        "pi-agent",
        "manual",
        encryptIdentityField("Recovered Display"),
        1,
        1,
      );
    const agentDir = repository.getAgentDir(name);
    const agentFile = join(agentDir, "agent.md");
    const original = [
      "---",
      "# preserve this comment",
      `name: ${name}`,
      "description: Keep description",
      "unknownTopLevel: keep-top-level",
      "x-mavis:",
      "  avatar: ./avatar.png",
      "  defaultWorkspaceDir: /keep/workspace",
      "  unknownMavisField: keep-mavis-field",
      "---",
      "",
      "Keep system prompt.",
      "",
    ].join("\n");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "avatar.png"), PNG_BYTES);
    await writeFile(agentFile, original);

    await expect(
      repository.materializeLegacyCustomAgentForStartup(name),
    ).resolves.toEqual({
      outcome: "canonical_identity_reconciled",
      identitySource: "v2_target",
      recoveredFields: ["display_name"],
    });
    const reconciled = await readFile(agentFile, "utf8");
    expect(reconciled).toContain("# preserve this comment");
    expect(reconciled).toContain("description: Keep description");
    expect(reconciled).toContain("unknownTopLevel: keep-top-level");
    expect(reconciled).toContain("defaultWorkspaceDir: /keep/workspace");
    expect(reconciled).toContain("unknownMavisField: keep-mavis-field");
    expect(reconciled).toContain("Keep system prompt.");
    await expect(repository.getCanonicalConfig(name)).resolves.toMatchObject({
      description: "Keep description",
      xMavis: {
        displayName: "Recovered Display",
        avatar: "./avatar.png",
        defaultWorkspaceDir: "/keep/workspace",
      },
    });

    await repository.updateIdentity(name, { displayName: "New V2 Value" });
    await expect(
      repository.materializeLegacyCustomAgentForStartup(name),
    ).resolves.toEqual({
      outcome: "already_canonical",
      identitySource: "none",
      recoveredFields: [],
    });
    await expect(readFile(agentFile, "utf8")).resolves.toBe(reconciled);

    await repository.completeLegacyCustomIdentityReconciliation();
    await rm(agentFile);
    await expect(
      repository.materializeLegacyCustomAgentForStartup(name),
    ).resolves.toEqual({
      outcome: "materialized",
      identitySource: "v2_target",
      recoveredFields: ["display_name"],
    });
    await expect(repository.getCanonicalConfig(name)).resolves.toMatchObject({
      xMavis: { displayName: "New V2 Value" },
    });
  });

  it("discovers file-only Custom candidates without borrowing reserved or Builtin names", async () => {
    const { repository } = await createRepository();
    await repository.insert({
      name: "builtin-owned",
      agentRole: "worker",
      creationSource: "builtin",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    for (const name of ["file-only", "mavis", "builtin-owned"]) {
      const agentDir = repository.getAgentDir(name);
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "agent.md"), "legacy prompt\n");
    }

    const candidates = await repository.listLegacyCustomAgents();
    expect(candidates).toContainEqual(
      expect.objectContaining({ name: "file-only", creationSource: "manual" }),
    );
    expect(candidates.map((candidate) => candidate.name)).not.toEqual(
      expect.arrayContaining(["mavis", "builtin-owned"]),
    );
    await expect(
      repository.materializeLegacyCustomAgent("mavis"),
    ).resolves.toBe("not-legacy");
    await expect(
      repository.materializeLegacyCustomAgent("builtin-owned"),
    ).resolves.toBe("not-legacy");
  });

  it("treats a file-only reserved primary as absent without rewriting its raw prompt", async () => {
    const { repository } = await createRepository();
    const agentDir = repository.getAgentDir("main");
    const agentFile = join(agentDir, "agent.md");
    const raw = "legacy primary prompt\n";
    await mkdir(agentDir, { recursive: true });
    await writeFile(agentFile, raw);

    await expect(repository.get("main")).resolves.toBeUndefined();
    await expect(repository.getConfig("main")).resolves.toBeNull();
    await expect(readFile(agentFile, "utf8")).resolves.toBe(raw);
  });
});

describe("DrizzleAgentRepository primary family provenance recovery", () => {
  it("avoids a write transaction when primary rows are absent or already normalized", async () => {
    const { repository, database } = await createRepository();
    const transaction = vi.spyOn(database.db, "transaction");

    await expect(repository.normalizePrimaryFamilyRows()).resolves.toBe(0);
    expect(transaction).not.toHaveBeenCalled();

    await repository.insert({
      name: "main",
      agentRole: "orchestrator",
      creationSource: "builtin",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await expect(repository.normalizePrimaryFamilyRows()).resolves.toBe(0);
    expect(transaction).not.toHaveBeenCalled();

    await repository.update("main", { creationSource: "manual" });
    await expect(repository.normalizePrimaryFamilyRows()).resolves.toBe(1);
    expect(transaction).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      behavior: "immediate",
    });

    await expect(repository.normalizePrimaryFamilyRows()).resolves.toBe(0);
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("adopts a historical main row without parsing or rewriting its invalid agent.md", async () => {
    const { repository, database } = await createRepository();
    const agentDir = repository.getAgentDir("main");
    const agentFile = join(agentDir, "agent.md");
    const invalid = "---\nname: main\ndescription: Main\ntools: Read\n---\n";
    await repository.insert({
      name: "main",
      agentRole: "worker",
      creationSource: "builtin",
      rootSessionId: "main-root",
      displayName: "Historical Main",
      description: "Historical description",
      createdAtMs: 1,
      updatedAtMs: 2,
    });
    await repository.updateConfig("main", {
      defaultWorkspaceDir: "/historical/workspace",
    });
    await repository.update("main", {
      creationSource: "manual",
      greetingSent: true,
    });
    await mkdir(agentDir, { recursive: true });
    await writeFile(agentFile, invalid);
    const before = database.rawDb
      .prepare("SELECT * FROM agents WHERE agent_name = ?")
      .get("main");

    await expect(repository.normalizePrimaryFamilyRows()).resolves.toBe(1);
    await expect(repository.normalizePrimaryFamilyRows()).resolves.toBe(0);

    const after = database.rawDb
      .prepare("SELECT * FROM agents WHERE agent_name = ?")
      .get("main");
    expect(after).toEqual({
      ...(before as Record<string, unknown>),
      agent_role: 1,
      creation_source: "builtin",
    });
    await expect(repository.get("main")).resolves.toMatchObject({
      name: "main",
      agentRole: "orchestrator",
      creationSource: "builtin",
      rootSessionId: "main-root",
      greetingSent: true,
      createdAtMs: 1,
      updatedAtMs: 2,
    });
    await expect(repository.getIdentity("main")).resolves.toEqual({
      displayName: "Historical Main",
      description: "Historical description",
    });
    await expect(repository.getConfig("main")).resolves.toEqual({
      defaultWorkspaceDir: "/historical/workspace",
    });
    await expect(repository.getCanonicalConfig("main")).rejects.toMatchObject({
      code: "AGENT_CONFIG_NOT_FOUND",
    });
    await expect(readFile(agentFile, "utf8")).resolves.toBe(invalid);
  });

  it("normalizes mixed historical primary rows without adding or deleting either owner", async () => {
    const { repository, database } = await createRepository();
    for (const [name, creationSource] of [
      ["main", "manual"],
      ["mavis", "auto"],
    ] as const) {
      await repository.insert({
        name,
        agentRole: "worker",
        creationSource: "builtin",
        rootSessionId: `${name}-root`,
        createdAtMs: name === "main" ? 10 : 20,
        updatedAtMs: name === "main" ? 11 : 21,
      });
      await repository.update(name, { creationSource });
    }

    await expect(repository.normalizePrimaryFamilyRows()).resolves.toBe(2);
    await expect(repository.normalizePrimaryFamilyRows()).resolves.toBe(0);

    expect(
      database.rawDb
        .prepare(
          "SELECT agent_name, agent_role, creation_source, main_session_id, created_at, updated_at FROM agents WHERE agent_name IN ('main', 'mavis') ORDER BY agent_name",
        )
        .all(),
    ).toEqual([
      {
        agent_name: "main",
        agent_role: 1,
        creation_source: "builtin",
        main_session_id: "main-root",
        created_at: 10,
        updated_at: 11,
      },
      {
        agent_name: "mavis",
        agent_role: 1,
        creation_source: "builtin",
        main_session_id: "mavis-root",
        created_at: 20,
        updated_at: 21,
      },
    ]);
  });
});

describe("DrizzleAgentRepository legacy canonical materialization safety", () => {
  it("never overwrites an existing invalid canonical file during legacy materialization", async () => {
    const { repository } = await createRepository();
    await repository.insert({
      name: "invalid-canonical",
      agentRole: "worker",
      creationSource: "manual",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    const agentFile = join(
      repository.getAgentDir("invalid-canonical"),
      "agent.md",
    );
    const invalid = "---\nname: invalid-canonical\ndescription: desc\n";
    await writeFile(
      join(repository.getAgentDir("invalid-canonical"), "PERSONA.md"),
      "legacy persona evidence",
    );
    await writeFile(
      join(repository.getAgentDir("invalid-canonical"), "config.yaml"),
      "defaultWorkspaceDir: /legacy/workspace\n",
    );
    await writeFile(agentFile, invalid);

    await expect(
      repository.materializeLegacyCustomAgent("invalid-canonical"),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_INVALID",
    });
    await expect(
      repository.getCanonicalConfig("invalid-canonical"),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      field: "frontmatter",
    });
    await expect(readFile(agentFile, "utf8")).resolves.toBe(invalid);
  });

  it("self-heals legacy plain Markdown on its first canonical read", async () => {
    const { repository } = await createRepository();
    await repository.insert({
      name: "legacy-plain",
      agentRole: "worker",
      creationSource: "builtin",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await repository.update("legacy-plain", {
      creationSource: "manual",
      updatedAtMs: 2,
    });
    const agentDir = repository.getAgentDir("legacy-plain");
    await mkdir(agentDir, { recursive: true });
    const persona = "legacy persona";
    const legacyConfig = "defaultWorkspaceDir: /legacy/workspace\n";
    await writeFile(join(agentDir, "PERSONA.md"), persona);
    await writeFile(join(agentDir, "config.yaml"), legacyConfig);
    await writeFile(join(agentDir, "agent.md"), "legacy system prompt\n");
    await writeFile(
      join(agentDir, "old-avatar.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    await repository.updateIdentity("legacy-plain", {
      displayName: "Legacy Plain",
      description: "Legacy description",
      avatar: "./old-avatar.png",
    });

    await expect(
      repository.getCanonicalConfig("legacy-plain"),
    ).resolves.toMatchObject({
      name: "legacy-plain",
      description: "Legacy description",
      xMavis: {
        displayName: "Legacy Plain",
        avatar: "./avatar.png",
        defaultWorkspaceDir: "/legacy/workspace",
      },
      systemPrompt: expect.stringContaining("legacy system prompt"),
    });
    const materialized = await repository.getCanonicalConfig("legacy-plain");
    expect(materialized.model).toBeUndefined();
    expect(materialized.effort).toBeUndefined();
    await expect(readFile(join(agentDir, "PERSONA.md"), "utf8")).resolves.toBe(
      persona,
    );
    await expect(readFile(join(agentDir, "config.yaml"), "utf8")).resolves.toBe(
      legacyConfig,
    );
    await expect(readFile(join(agentDir, "avatar.png"))).resolves.toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
  });

  it("self-heals row-backed legacy plain Markdown through identity reads", async () => {
    const { repository } = await createRepository();
    const owner = "legacy-identity-read";
    await repository.insert({
      name: owner,
      agentRole: "worker",
      creationSource: "builtin",
      displayName: "Legacy Identity Read",
      description: "Legacy identity description",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await repository.update(owner, {
      creationSource: "manual",
      updatedAtMs: 2,
    });
    const agentDir = repository.getAgentDir(owner);
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "agent.md"), "legacy system prompt\n");

    await expect(repository.getIdentity(owner)).resolves.toEqual({
      displayName: "Legacy Identity Read",
      description: "Legacy identity description",
    });
    await expect(readFile(join(agentDir, "agent.md"), "utf8")).resolves.toMatch(
      /^---\nname: legacy-identity-read\n/u,
    );
  });
});

describe("DrizzleAgentRepository canonical source boundary", () => {
  registerCanonicalSourceOwnershipTests();
  registerCanonicalSourceRepairTests();
  registerCanonicalSourceCutoverTests();
});

function registerCanonicalSourceOwnershipTests(): void {
  it("never reconciles file-only main or mavis definitions into Custom runtime rows", async () => {
    const { repository, database } = await createRepository();
    const files = new Map([
      ["main", "---\nname: main\ndescription: Main\n---\n\nmain prompt\n"],
      ["mavis", "---\nname: mavis\ndescription: Mavis\n---\n\nmavis prompt\n"],
    ]);
    for (const [name, contents] of files) {
      const agentDir = repository.getAgentDir(name);
      await mkdir(agentDir, { recursive: true });
      await writeFile(join(agentDir, "agent.md"), contents);
    }

    await expect(repository.list()).resolves.toEqual([]);
    await expect(repository.reconcileCanonicalCustomAgents()).resolves.toBe(0);
    await expect(repository.listLegacyCustomAgents()).resolves.toEqual([]);
    expect(
      database.rawDb
        .prepare(
          "SELECT agent_name FROM agents WHERE agent_name IN ('main', 'mavis')",
        )
        .all(),
    ).toEqual([]);
    for (const [name, contents] of files) {
      await expect(
        readFile(join(repository.getAgentDir(name), "agent.md"), "utf8"),
      ).resolves.toBe(contents);
    }
  });

  it("discovers a file-only Custom Agent, then reconciles only its missing runtime state", async () => {
    const { repository, database } = await createRepository();
    await repository.writeCanonicalConfig("file-only", {
      name: "file-only",
      description: "File-owned metadata",
      xMavis: {
        displayName: "File Only",
        defaultWorkspaceDir: "/workspace/file-only",
      },
      systemPrompt: "File-owned prompt",
    });

    await expect(repository.get("file-only")).resolves.toMatchObject({
      name: "file-only",
      creationSource: "manual",
      agentRole: "worker",
    });
    await expect(repository.list()).resolves.toContainEqual(
      expect.objectContaining({ name: "file-only" }),
    );
    await expect(repository.getIdentity("file-only")).resolves.toEqual({
      displayName: "File Only",
      description: "File-owned metadata",
    });
    await expect(repository.getConfig("file-only")).resolves.toEqual({
      defaultWorkspaceDir: "/workspace/file-only",
    });
    await expect(repository.getSystemPrompt("file-only")).resolves.toBe(
      "File-owned prompt",
    );
    expect(
      database.rawDb
        .prepare("SELECT agent_name FROM agents WHERE agent_name = ?")
        .get("file-only"),
    ).toBeUndefined();

    await expect(repository.reconcileCanonicalCustomAgents()).resolves.toBe(1);
    expect(
      database.rawDb
        .prepare("SELECT agent_name FROM agents WHERE agent_name = ?")
        .get("file-only"),
    ).toEqual({ agent_name: "file-only" });
    await expect(
      repository.getCanonicalConfig("file-only"),
    ).resolves.toMatchObject({
      description: "File-owned metadata",
    });
  });

  it("keeps trusted Builtins ahead of same-named Custom root files", async () => {
    const { repository } = await createRepository();
    await repository.insert({
      name: "worker",
      agentRole: "worker",
      creationSource: "builtin",
      displayName: "Builtin Worker",
      description: "Builtin metadata",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await repository.writeCanonicalConfig("worker", {
      name: "worker",
      description: "Untrusted root file",
      xMavis: { displayName: "Untrusted Custom" },
      systemPrompt: "Untrusted custom prompt",
    });

    await expect(repository.get("worker")).resolves.toMatchObject({
      creationSource: "builtin",
    });
    await expect(repository.getIdentity("worker")).resolves.toEqual({
      displayName: "Builtin Worker",
      description: "Builtin metadata",
    });
    await expect(
      repository.readCustomAvatar("worker"),
    ).resolves.toBeUndefined();
    await expect(repository.list()).resolves.not.toContainEqual(
      expect.objectContaining({ name: "worker", creationSource: "manual" }),
    );
  });
}

function registerCanonicalSourceRepairTests(): void {
  it("maps an invalid existing Custom file to a stable create diagnostic", async () => {
    const { repository } = await createRepository();
    const owner = "invalid-create";
    await mkdir(repository.getAgentDir(owner), { recursive: true });
    await writeFile(
      join(repository.getAgentDir(owner), "agent.md"),
      "---\nname: invalid-create\ndescription: Invalid\ntools: Read\n---\n",
      "utf8",
    );

    await expect(
      createTestAgentService({ repository }).create({ name: owner }),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      details: {
        field: "tools",
        reason: "tools must be an array of non-empty strings.",
      },
    });
  });
}

function registerCanonicalSourceCutoverTests(): void {
  it.each(["\n", "\r\n"])(
    "repairs an empty canonical prompt at startup without changing its configuration (%j)",
    async (lineEnding) => {
      const { repository } = await createRepository();
      const owner = "canonical-empty-prompt";
      const agentDir = repository.getAgentDir(owner);
      await mkdir(agentDir, { recursive: true });
      const avatar = Buffer.from(PNG_DATA_URL.split(",")[1]!, "base64");
      await writeFile(join(agentDir, "avatar.png"), avatar);
      const header = [
        "---",
        `name: ${owner}`,
        "description: Original Agent intent",
        "# Preserve this comment",
        "model: minimax/MiniMax-M3",
        "x-mavis:",
        "  displayName: Custom name",
        "  contextWindow: 1000000",
        "  avatar: ./avatar.png",
        "---",
        "",
      ].join(lineEnding);
      const filePath = join(agentDir, "agent.md");
      await writeFile(filePath, `${header}  ${lineEnding}`, "utf8");
      await repository.completeLegacyCustomIdentityReconciliation();
      const report = vi.fn();
      const service = createTestAgentService({
        repository,
        reportLegacyCustomMaterialization: report,
      });
      await service.materializeLegacyCustomAgents();
      const repaired = await readFile(filePath, "utf8");
      expect(repaired).toBe(`${header}${lineEnding}Original Agent intent`);
      expect(await readFile(join(agentDir, "avatar.png"))).toEqual(avatar);
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: owner,
          outcome: "materialized",
          recoveredFields: ["system_prompt"],
        }),
      );
      await service.materializeLegacyCustomAgents();
      expect(await readFile(filePath, "utf8")).toBe(repaired);
      // Clearing again is eligible on the next startup; no receipt suppresses it.
      await writeFile(filePath, header, "utf8");
      await service.materializeLegacyCustomAgents();
      expect(await readFile(filePath, "utf8")).toBe(repaired);
      const authored = `${header}  Authored prompt with trailing spaces.  ${lineEnding}`;
      await writeFile(filePath, authored, "utf8");
      await service.materializeLegacyCustomAgents();
      expect(await readFile(filePath, "utf8")).toBe(authored);
    },
  );

  it("falls back to the description when the legacy prompt is empty", async () => {
    const { repository } = await createRepository();
    // Pure DB-row provenance: no agent.md and no PERSONA.md at all.
    await repository.insert({
      name: "legacy-desc-only",
      agentRole: "worker",
      creationSource: "builtin",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await repository.update("legacy-desc-only", {
      creationSource: "manual",
      updatedAtMs: 2,
    });
    await repository.updateIdentity("legacy-desc-only", {
      displayName: "Desc only",
      description: "  act as my trading assistant  ",
    });
    await expect(
      repository.materializeLegacyCustomAgent("legacy-desc-only"),
    ).resolves.toBe("materialized");
    await expect(repository.getSystemPrompt("legacy-desc-only")).resolves.toBe(
      "act as my trading assistant",
    );

    // A blank legacy plain agent.md yields an empty merged prompt, so the
    // migration borrows the description too.
    await repository.insert({
      name: "legacy-blank-md",
      agentRole: "worker",
      creationSource: "builtin",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await repository.update("legacy-blank-md", {
      creationSource: "manual",
      updatedAtMs: 2,
    });
    await repository.updateIdentity("legacy-blank-md", {
      displayName: "Blank md",
      description: "unused description",
    });
    const blankDir = repository.getAgentDir("legacy-blank-md");
    await mkdir(blankDir, { recursive: true });
    await writeFile(join(blankDir, "agent.md"), "\n", "utf8");
    await expect(
      repository.materializeLegacyCustomAgent("legacy-blank-md"),
    ).resolves.toBe("materialized");
    await expect(repository.getSystemPrompt("legacy-blank-md")).resolves.toBe(
      "unused description",
    );
  });

  it("stops consuming legacy Custom assets after the canonical cutover", async () => {
    const { repository } = await createRepository();
    await repository.insert({
      name: "legacy-cutover",
      agentRole: "worker",
      creationSource: "builtin",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await repository.update("legacy-cutover", {
      creationSource: "manual",
      updatedAtMs: 2,
    });
    const agentDir = repository.getAgentDir("legacy-cutover");
    await mkdir(agentDir, { recursive: true });
    await writeFile(
      join(agentDir, "config.yaml"),
      "defaultWorkspaceDir: /legacy/original\n",
    );
    await writeFile(join(agentDir, "PERSONA.md"), "legacy persona");
    await writeFile(join(agentDir, "agent.md"), "plain legacy prompt\n");
    await repository.updateIdentity("legacy-cutover", {
      displayName: "Legacy original",
      description: "Legacy original description",
    });
    await expect(
      repository.materializeLegacyCustomAgent("legacy-cutover"),
    ).resolves.toBe("materialized");

    await rm(join(agentDir, "agent.md"));
    await writeFile(
      join(agentDir, "config.yaml"),
      "defaultWorkspaceDir: /legacy/mutated\n",
    );
    await repository.updateIdentity("legacy-cutover", {
      displayName: "Legacy mutated",
      description: "Legacy mutated description",
    });

    await expect(repository.get("legacy-cutover")).resolves.toBeUndefined();
    await expect(repository.getConfig("legacy-cutover")).resolves.toBeNull();
    await expect(repository.getIdentity("legacy-cutover")).resolves.toBeNull();
    await expect(
      repository.getSystemPrompt("legacy-cutover"),
    ).resolves.toBeNull();
    await expect(repository.getPersona("legacy-cutover")).resolves.toBeNull();

    const service = createTestAgentService({ repository, nowMs: () => 10 });
    await expect(service.get("agent:legacy-cutover")).rejects.toMatchObject({
      code: "AGENT_NOT_FOUND",
    });
    await expect(
      service.renderProfile({
        exactOwnerName: "legacy-cutover",
        requestRef: "legacy-cutover",
      }),
    ).rejects.toMatchObject({ code: "AGENT_NOT_FOUND" });
    await expect(service.list()).resolves.toEqual([]);

    const newAgentDir = repository.getAgentDir("new-cutover");
    await mkdir(newAgentDir, { recursive: true });
    await writeFile(
      join(newAgentDir, "config.yaml"),
      "defaultWorkspaceDir: /legacy/new\n",
    );
    await service.create({ name: "new-cutover", nowMs: 10 });
    const newConfig = await repository.getCanonicalConfig("new-cutover");
    expect(newConfig.name).toBe("new-cutover");
    expect(newConfig.xMavis?.defaultWorkspaceDir).toBeUndefined();
  });
}

describe("DrizzleAgentRepository canonical Custom field boundary", () => {
  it.each(["on", "off"] as const)(
    "reads an unquoted MiniMax M3 thinking mode %s through repository and service config selection",
    async (effort) => {
      const { repository } = await createRepository();
      const owner = "field-owner";
      const description = "METADATA_DESCRIPTION_SENTINEL";
      const displayName = "METADATA_DISPLAY_NAME_SENTINEL";
      const systemPrompt = "EXECUTION_BODY_SENTINEL\n";
      await repository.insert({
        name: owner,
        agentRole: "worker",
        creationSource: "manual",
        createdAtMs: 1,
        updatedAtMs: 1,
      });
      const agentDir = repository.getAgentDir(owner);
      const markdown = [
        "---",
        "name: portable-declaration",
        `description: ${description}`,
        "model: minimax/MiniMax-M3",
        `effort: ${effort}`,
        "tools: [Read]",
        "disallowedTools: [Write]",
        "mcpServers: [local-mcp]",
        "skills: [research]",
        "unknownTopLevel: UNKNOWN_TOP_LEVEL_SENTINEL",
        "x-mavis:",
        `  displayName: ${displayName}`,
        "  avatar: ./avatar.png",
        "  contextWindow: 32768",
        "  maxOutputTokens: 4096",
        "  defaultWorkspaceDir: /workspace/field-owner",
        "  extensionSkills: [extension-research]",
        "  unknownMavisField: UNKNOWN_MAVIS_SENTINEL",
        "---",
        "",
        systemPrompt.trim(),
        "",
      ].join("\n");
      await writeFile(join(agentDir, "avatar.png"), PNG_BYTES);
      await writeFile(join(agentDir, "agent.md"), markdown);

      await expect(repository.getCanonicalConfig(owner)).resolves.toMatchObject(
        {
          name: "portable-declaration",
          description,
          model: "minimax/MiniMax-M3",
          effort,
          tools: ["Read"],
          disallowedTools: ["Write"],
          mcpServers: ["local-mcp"],
          skills: ["research"],
          xMavis: {
            displayName,
            avatar: "./avatar.png",
            contextWindow: 32768,
            maxOutputTokens: 4096,
            defaultWorkspaceDir: "/workspace/field-owner",
            extensionSkills: ["extension-research"],
          },
          systemPrompt,
          diagnostics: [
            { code: "agent_name_mismatch", field: "name" },
            { code: "unsupported_agent_field", field: "unknownTopLevel" },
            {
              code: "unsupported_agent_field",
              field: "x-mavis.unknownMavisField",
            },
          ],
        },
      );
      await expect(readFile(join(agentDir, "agent.md"), "utf8")).resolves.toBe(
        markdown,
      );
      await expect(repository.getIdentity(owner)).resolves.toEqual({
        displayName,
        description,
        avatar: "./avatar.png",
      });
      await expect(repository.getConfig(owner)).resolves.toEqual({
        defaultWorkspaceDir: "/workspace/field-owner",
      });
      await expect(repository.getSystemPrompt(owner)).resolves.toBe(
        systemPrompt,
      );

      const service = createTestAgentService({ repository, nowMs: () => 10 });
      await expect(
        service.get(`agent:${owner}`, { includeContent: true }),
      ).resolves.toMatchObject({
        name: owner,
        requestRef: owner,
        exactOwnerName: owner,
        canonicalViewName: owner,
        resolvedAgentName: owner,
        displayName,
        description,
        avatar: "./avatar.png",
        defaultWorkspaceDir: "/workspace/field-owner",
        systemPrompt,
      });
      await expect(service.readCustomAvatar(owner)).resolves.toEqual({
        bytes: PNG_BYTES,
        contentType: "image/png",
      });

      const live = await service.renderProfile({
        exactOwnerName: owner,
        requestRef: owner,
        surface: "interactive",
      });
      expect(live).toMatchObject({
        exactOwnerName: owner,
        requestRef: owner,
        resolvedAgentName: owner,
        agentSystemPrompt: systemPrompt,
      });
      expect(live.configSelection).toEqual({
        model: "minimax/MiniMax-M3",
        effort,
        contextWindow: 32768,
        maxOutputTokens: 4096,
        tools: ["Read"],
        disallowedTools: ["Write"],
        mcpServers: ["local-mcp"],
        skills: ["research"],
        extensionSkills: ["extension-research"],
      });
      expect(live.corePrompt).not.toContain(description);
      expect(live.corePrompt).not.toContain(displayName);
      expect(live.corePrompt).not.toContain("./avatar.png");
      expect(live.corePrompt).not.toContain("UNKNOWN_TOP_LEVEL_SENTINEL");
      expect(live.corePrompt).not.toContain("UNKNOWN_MAVIS_SENTINEL");

      const frozen = await service.renderFrozenProfile(
        { exactOwnerName: owner, requestRef: owner, surface: "task-child" },
        { systemPrompt, capabilities: {} },
      );
      expect(frozen.agentSystemPrompt).toBe(systemPrompt);
      expect(frozen.corePrompt).not.toContain(description);
      expect(frozen.corePrompt).not.toContain("UNKNOWN_TOP_LEVEL_SENTINEL");
    },
  );
});

describe("DrizzleAgentRepository canonical Custom metadata boundary", () => {
  it("omits a blank canonical workspace so new Session fallback remains eligible", async () => {
    const { repository } = await createRepository();
    const owner = "blank-workspace";
    await repository.insert({
      name: owner,
      agentRole: "worker",
      creationSource: "manual",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await writeFile(
      join(repository.getAgentDir(owner), "agent.md"),
      '---\nname: blank-workspace\ndescription: Workspace metadata\nx-mavis:\n  defaultWorkspaceDir: "   "\n---\n\nPrompt\n',
    );

    await expect(repository.getConfig(owner)).resolves.toEqual({});
    await expect(
      createTestAgentService({ repository, nowMs: () => 10 }).get(
        `agent:${owner}`,
      ),
    ).resolves.not.toHaveProperty("defaultWorkspaceDir");
  });

  it("fails closed through the repository and service for an invalid known canonical field", async () => {
    const { repository } = await createRepository();
    const owner = "invalid-field";
    await repository.insert({
      name: owner,
      agentRole: "worker",
      creationSource: "manual",
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await writeFile(
      join(repository.getAgentDir(owner), "agent.md"),
      "---\nname: invalid-field\ndescription: Invalid field\nx-mavis:\n  displayName: [not-a-string]\n---\n",
    );

    await expect(repository.getCanonicalConfig(owner)).rejects.toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      field: "displayName",
    });
    await expect(
      createTestAgentService({ repository, nowMs: () => 10 }).renderProfile({
        exactOwnerName: owner,
        requestRef: owner,
      }),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      details: {
        field: "displayName",
        reason: "displayName must be a string.",
      },
    });
  });
});

describe("DrizzleAgentRepository canonical Custom profile editing", () => {
  it("edits Custom identity metadata through the service without rewriting prompt, unknown YAML, or SQLite config", async () => {
    const { repository, database } = await createRepository();
    const owner = "editable";
    await repository.writeCanonicalConfig(owner, {
      name: owner,
      description: "Before",
      systemPrompt: "Initial body",
    });
    const agentFile = join(repository.getAgentDir(owner), "agent.md");
    const markdownBody = "\n\n## User prompt\nKeep exact bytes.\n";
    await writeFile(
      agentFile,
      [
        "---",
        "name: editable",
        "description: Before",
        "unknownTopLevel: retained",
        "x-mavis:",
        "  displayName: Before Name",
        "  unknownMavis: retained",
        "---",
        markdownBody,
      ].join("\n"),
      "utf8",
    );

    const service = createTestAgentService({ repository, nowMs: () => 10 });
    await expect(
      service.update({
        requestRef: owner,
        description: "After",
        displayName: null,
        avatar: PNG_DATA_URL,
        nowMs: 2,
      }),
    ).resolves.toMatchObject({ description: "After", displayName: owner });
    const config = await repository.getCanonicalConfig(owner);
    expect(config.description).toBe("After");
    expect(config.xMavis?.displayName).toBeUndefined();
    expect(config.xMavis?.avatar).toMatch(/^\.\/avatar-[a-f0-9]{16}\.png$/u);
    const updated = await readFile(agentFile, "utf8");
    expect(updated).toContain("unknownTopLevel: retained");
    expect(updated).toContain("unknownMavis: retained");
    expect(updated.endsWith(markdownBody)).toBe(true);
    expect(
      database.rawDb
        .prepare(
          "SELECT enc_display_name, enc_description, enc_avatar FROM agents WHERE agent_name = ?",
        )
        .get(owner),
    ).toEqual({
      enc_display_name: null,
      enc_description: null,
      enc_avatar: null,
    });

    const beforeInvalid = await readFile(agentFile, "utf8");
    await expect(
      service.update({ requestRef: owner, description: "   ", nowMs: 3 }),
    ).rejects.toMatchObject({
      code: "AGENT_CONFIG_INVALID",
      details: { field: "description" },
    });
    await expect(readFile(agentFile, "utf8")).resolves.toBe(beforeInvalid);
  });
});

describe("DrizzleAgentRepository.list", () => {
  it("returns every Agent newest-first when no window is requested", async () => {
    const { repository } = await createRepository();
    await seed(repository);

    await expect(repository.list()).resolves.toMatchObject([
      { name: "charlie" },
      { name: "Bravo" },
      { name: "alpha" },
    ]);
  });

  it("matches the search term case-insensitively on any part of the name", async () => {
    const { repository } = await createRepository();
    await seed(repository);

    await expect(repository.list({ search: "RAV" })).resolves.toMatchObject([
      { name: "Bravo" },
    ]);
    await expect(repository.list({ search: "a" })).resolves.toMatchObject([
      { name: "charlie" },
      { name: "Bravo" },
      { name: "alpha" },
    ]);
    await expect(
      repository.list({ search: "nothing-matches" }),
    ).resolves.toEqual([]);
  });

  it("treats a blank search term as no filter", async () => {
    const { repository } = await createRepository();
    await seed(repository);

    await expect(repository.list({ search: "   " })).resolves.toHaveLength(3);
  });

  it("applies offset and limit as a window over the ordered result", async () => {
    const { repository } = await createRepository();
    await seed(repository);

    await expect(repository.list({ limit: 2 })).resolves.toMatchObject([
      { name: "charlie" },
      { name: "Bravo" },
    ]);
    await expect(repository.list({ offset: 1 })).resolves.toMatchObject([
      { name: "Bravo" },
      { name: "alpha" },
    ]);
    await expect(
      repository.list({ offset: 1, limit: 1 }),
    ).resolves.toMatchObject([{ name: "Bravo" }]);
  });

  it("clamps a negative offset and limit instead of wrapping the slice", async () => {
    const { repository } = await createRepository();
    await seed(repository);

    await expect(repository.list({ offset: -5 })).resolves.toHaveLength(3);
    await expect(repository.list({ limit: -1 })).resolves.toEqual([]);
  });
});

describe("DrizzleAgentRepository.update", () => {
  it("reports no write when the patch carries no persisted field", async () => {
    const { repository } = await createRepository();
    await seed(repository);

    await expect(repository.update("alpha", {})).resolves.toBe(false);
    await expect(repository.get("alpha")).resolves.toMatchObject({
      updatedAtMs: 10,
    });
  });

  it("writes each supported field and round-trips it through get()", async () => {
    const { repository } = await createRepository();
    await seed(repository);
    await repository.writeCanonicalConfig("alpha", {
      name: "alpha",
      description: "Alpha Custom",
      systemPrompt: "Alpha prompt",
    });

    await expect(
      repository.update("alpha", {
        agentRole: "orchestrator",
        mainSessionId: "session-root",
        creationSource: "auto",
        greetingSent: true,
        createdAtMs: 11,
        updatedAtMs: 12,
      }),
    ).resolves.toBe(true);

    await expect(repository.get("alpha")).resolves.toMatchObject({
      agentRole: "orchestrator",
      rootSessionId: "session-root",
      creationSource: "auto",
      greetingSent: true,
      createdAtMs: 11,
      updatedAtMs: 12,
    });
  });

  it("clears greetingSent back to false", async () => {
    const { repository } = await createRepository();
    await seed(repository);

    await repository.update("alpha", { greetingSent: true });
    await expect(
      repository.update("alpha", { greetingSent: false }),
    ).resolves.toBe(true);
    await expect(repository.get("alpha")).resolves.toMatchObject({
      greetingSent: false,
    });
  });

  it("reports no write for an unknown Agent", async () => {
    const { repository } = await createRepository();

    await expect(
      repository.update("missing", { updatedAtMs: 1 }),
    ).resolves.toBe(false);
  });
});

describe("DrizzleAgentRepository identity", () => {
  it("returns null for an unknown Agent and for a row with no identity", async () => {
    const { repository } = await createRepository();
    await seed(repository);

    await expect(repository.getIdentity("missing")).resolves.toBeNull();
    await expect(repository.getIdentity("alpha")).resolves.toBeNull();
  });

  it("stores each identity field independently", async () => {
    const { repository } = await createRepository();
    await seed(repository);

    await expect(
      repository.updateIdentity("alpha", { displayName: "Alpha" }),
    ).resolves.toBe(true);
    await expect(repository.getIdentity("alpha")).resolves.toEqual({
      displayName: "Alpha",
    });

    await expect(
      repository.updateIdentity("alpha", { description: "Desc" }),
    ).resolves.toBe(true);
    await expect(repository.getIdentity("alpha")).resolves.toEqual({
      displayName: "Alpha",
      description: "Desc",
    });

    await expect(
      repository.updateIdentity("alpha", { avatar: "a.png" }),
    ).resolves.toBe(true);
    await expect(repository.getIdentity("alpha")).resolves.toEqual({
      displayName: "Alpha",
      description: "Desc",
      avatar: "a.png",
    });
  });

  it("clears a single field when it is explicitly set to undefined", async () => {
    const { repository } = await createRepository();
    await seed(repository);
    await repository.updateIdentity("alpha", {
      displayName: "Alpha",
      description: "Desc",
    });

    await expect(
      repository.updateIdentity("alpha", { displayName: undefined }),
    ).resolves.toBe(true);
    await expect(repository.getIdentity("alpha")).resolves.toEqual({
      description: "Desc",
    });
  });

  it("reports no write when the identity patch is empty", async () => {
    const { repository } = await createRepository();
    await seed(repository);

    await expect(repository.updateIdentity("alpha", {})).resolves.toBe(false);
  });

  it("deletes every identity field at once", async () => {
    const { repository } = await createRepository();
    await seed(repository);
    await repository.updateIdentity("alpha", {
      displayName: "Alpha",
      description: "Desc",
      avatar: "a.png",
    });

    await expect(repository.deleteIdentity("alpha")).resolves.toBe(true);
    await expect(repository.getIdentity("alpha")).resolves.toBeNull();
    await expect(repository.deleteIdentity("missing")).resolves.toBe(false);
  });
});

describe("DrizzleAgentRepository.updateAssets", () => {
  it("reports no change when the patch touches no asset", async () => {
    const { repository } = await createRepository();
    await seed(repository);

    await expect(
      repository.updateAssets({ name: "alpha", updatedAtMs: 99 }),
    ).resolves.toBe(false);
    await expect(repository.get("alpha")).resolves.toMatchObject({
      updatedAtMs: 10,
    });
  });

  it("stamps updatedAt only when an asset actually changed", async () => {
    const { repository } = await createRepository();
    await seed(repository);

    await expect(
      repository.updateAssets({
        name: "alpha",
        persona: "A persona",
        updatedAtMs: 55,
      }),
    ).resolves.toBe(true);
    await expect(repository.getPersona("alpha")).resolves.toBe("A persona");
    await expect(repository.get("alpha")).resolves.toMatchObject({
      updatedAtMs: 55,
    });
  });

  it("deletes a prompt asset when the field is explicitly null", async () => {
    const { repository } = await createRepository();
    await seed(repository);
    await repository.updateAssets({
      name: "alpha",
      persona: "A persona",
      systemPrompt: "A prompt",
      updatedAtMs: 55,
    });

    await expect(
      repository.updateAssets({
        name: "alpha",
        persona: null,
        updatedAtMs: 60,
      }),
    ).resolves.toBe(true);
    await expect(repository.getPersona("alpha")).resolves.toBeNull();
    await expect(repository.getSystemPrompt("alpha")).resolves.toBe("A prompt");

    await expect(
      repository.updateAssets({
        name: "alpha",
        systemPrompt: null,
        updatedAtMs: 61,
      }),
    ).resolves.toBe(true);
    await expect(repository.getSystemPrompt("alpha")).resolves.toBeNull();
  });

  it("clears the workspace preference when defaultWorkspaceDir is null", async () => {
    const { repository } = await createRepository();
    await seed(repository);
    await repository.updateAssets({
      name: "alpha",
      defaultWorkspaceDir: "/workspace/alpha",
      updatedAtMs: 70,
    });
    await expect(repository.getConfig("alpha")).resolves.toEqual({
      defaultWorkspaceDir: "/workspace/alpha",
    });

    await expect(
      repository.updateAssets({
        name: "alpha",
        defaultWorkspaceDir: null,
        updatedAtMs: 71,
      }),
    ).resolves.toBe(true);
    await expect(repository.getConfig("alpha")).resolves.toEqual({});
  });

  it("applies identity, prompt and workspace assets in one call", async () => {
    const { repository } = await createRepository();
    await seed(repository);

    await expect(
      repository.updateAssets({
        name: "alpha",
        description: "Desc",
        avatar: "a.png",
        persona: "P",
        systemPrompt: "S",
        defaultWorkspaceDir: "/w",
        updatedAtMs: 80,
      }),
    ).resolves.toBe(true);
    await expect(repository.getIdentity("alpha")).resolves.toEqual({
      description: "Desc",
      avatar: "a.png",
    });
    await expect(repository.getPersona("alpha")).resolves.toBe("P");
    await expect(repository.getSystemPrompt("alpha")).resolves.toBe("S");
    await expect(repository.getConfig("alpha")).resolves.toEqual({
      defaultWorkspaceDir: "/w",
    });
  });
});

describe("DrizzleAgentRepository role observation", () => {
  it("reports an unsupported stored role once per Agent and still returns the read", async () => {
    const onAgentRoleObservation = vi.fn();
    const { repository, database } = await createRepository({
      onAgentRoleObservation,
    });
    await seed(repository);
    database.rawDb
      .prepare("UPDATE agents SET agent_role = 7 WHERE agent_name = ?")
      .run("alpha");

    await expect(repository.get("alpha")).resolves.toMatchObject({
      agentRole: "7",
    });
    await expect(repository.get("alpha")).resolves.toMatchObject({
      agentRole: "7",
    });

    expect(onAgentRoleObservation).toHaveBeenCalledTimes(1);
    expect(onAgentRoleObservation).toHaveBeenCalledWith({
      status: "unsupported",
      source: "sqlite_decode",
      role: undefined,
    });
  });

  it("reports a missing stored role and falls back to worker", async () => {
    const onAgentRoleObservation = vi.fn();
    const { repository, database } = await createRepository({
      onAgentRoleObservation,
    });
    await seed(repository);
    database.rawDb
      .prepare("UPDATE agents SET agent_role = '' WHERE agent_name = ?")
      .run("alpha");

    await expect(repository.get("alpha")).resolves.toMatchObject({
      agentRole: "worker",
    });
    expect(onAgentRoleObservation).toHaveBeenCalledWith(
      expect.objectContaining({ status: "missing" }),
    );
  });

  it("never lets an observation failure break the read", async () => {
    const onAgentRoleObservation = vi.fn(() => {
      throw new Error("telemetry sink is down");
    });
    const { repository, database } = await createRepository({
      onAgentRoleObservation,
    });
    await seed(repository);
    database.rawDb
      .prepare("UPDATE agents SET agent_role = 7 WHERE agent_name = ?")
      .run("alpha");

    await expect(repository.get("alpha")).resolves.toMatchObject({
      name: "alpha",
    });
    expect(onAgentRoleObservation).toHaveBeenCalledOnce();
  });

  it("stays silent for canonical stored roles", async () => {
    const onAgentRoleObservation = vi.fn();
    const { repository } = await createRepository({ onAgentRoleObservation });
    await seed(repository);

    await expect(repository.list()).resolves.toHaveLength(3);
    expect(onAgentRoleObservation).not.toHaveBeenCalled();
  });
});

describe("DrizzleAgentRepository.get projection", () => {
  it("omits optional provenance columns that the row leaves empty", async () => {
    const { repository } = await createRepository();
    await seed(repository);

    const meta = await repository.get("alpha");
    expect(meta).not.toHaveProperty("rootSessionId");
    expect(meta).not.toHaveProperty("sourceProject");
    expect(meta).not.toHaveProperty("harnessSourceType");
    expect(meta).toMatchObject({ pinned: false, creationSource: "builtin" });
  });

  it("projects optional provenance columns when the row carries them", async () => {
    const { repository, database } = await createRepository();
    await seed(repository);
    database.rawDb
      .prepare(
        "UPDATE agents SET source_project = ?, harness_source_type = ?, main_session_id = ?, pinned = 1, pinned_at = ? WHERE agent_name = ?",
      )
      .run("/repo", "acme-code", "session-root", 4242, "alpha");

    await expect(repository.get("alpha")).resolves.toMatchObject({
      sourceProject: "/repo",
      harnessSourceType: "acme-code",
      rootSessionId: "session-root",
      pinned: true,
      pinnedAtMs: 4242,
    });
  });

  it("falls back to manual for an unrecognized creation source", async () => {
    const { repository, database } = await createRepository();
    await seed(repository);
    await repository.writeCanonicalConfig("alpha", {
      name: "alpha",
      description: "Alpha Custom",
      systemPrompt: "Alpha prompt",
    });
    database.rawDb
      .prepare("UPDATE agents SET creation_source = ? WHERE agent_name = ?")
      .run("imported", "alpha");

    await expect(repository.get("alpha")).resolves.toMatchObject({
      creationSource: "manual",
    });
  });

  it("reports no delete for an unknown Agent", async () => {
    const { repository } = await createRepository();

    await expect(repository.delete("missing")).resolves.toBe(false);
  });
});

it("conditionally clears a removed session reference without overwriting a new Main or recreating an Agent", async () => {
  const { repository } = await createRepository();
  await repository.insert({
    name: "root-owner",
    agentRole: "worker",
    creationSource: "manual",
    rootSessionId: "old",
    createdAtMs: 1,
    updatedAtMs: 1,
  });
  await expect(
    repository.update("root-owner", {
      mainSessionId: null,
      expectedMainSessionId: "old",
    }),
  ).resolves.toBe(true);
  expect((await repository.get("root-owner"))?.rootSessionId).toBeUndefined();
  await repository.update("root-owner", { mainSessionId: "new" });
  await expect(
    repository.update("root-owner", {
      mainSessionId: null,
      expectedMainSessionId: "old",
    }),
  ).resolves.toBe(false);
  expect((await repository.get("root-owner"))?.rootSessionId).toBe("new");
  await repository.delete("root-owner");
  await expect(
    repository.update("root-owner", {
      mainSessionId: null,
      expectedMainSessionId: "new",
    }),
  ).resolves.toBe(false);
  expect(await repository.get("root-owner")).toBeUndefined();
});
