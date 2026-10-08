import { DeferredRuntimeConversation } from "@mavis/conversation-contract";
import {
  LocalQuestionnaireService,
  createDeferredLocalAgentRuntimePort,
  createLocalRuntimeHost as createLocalRuntimeHostV1,
  ensureCurrentLocalRuntimeDataMigratedToV2OrThrow,
  isLocalRuntimeStartupExecutionEnabled,
  resolveAgentBashEnvPolicy,
  type DeferredLocalAgentRuntimePort,
  type CreatedLocalRuntimeHost as V1CreatedLocalRuntimeHost,
} from "@mavis/local-runtime";
import { logger } from "@mavis/shared/local-runtime-logging";

import {
  createBackgroundRuntime,
  type BackgroundRuntime,
} from "./background-runtime.js";
import {
  cleanupFailedV1Startup,
  createDeferredAgentRuntimeTelemetry,
  createV1RuntimeCompatibility,
  withAgentStorageLock,
  type V1RuntimeCompatibility,
} from "./compat/v1/runtime.js";
import { createV2AgentRuntimeManagementPort } from "./local/agent-runtime-port.js";
import { DatabaseClient } from "./infra/db/client.js";
import {
  initializeDatabase,
  type DatabaseInitializationResult,
} from "./infra/db/initialize.js";
import { createCliService } from "./local/app.js";
import type {
  CreateLocalRuntimeHostOptions,
  CreatedLocalRuntimeHost,
  LocalRuntimeProductHostOptions,
} from "./local/host-contract.js";
import {
  createDeferredLocalSandboxBashOperationsFactory,
  createRuntimeAgentComposition,
  createRuntimeServices,
  prepareRuntimeServices,
  type AgentCutoverLogEvent,
  type AgentRuntimeOwner,
  type CreateRuntimeServicesOptions,
  type DeferredLocalSandboxBashOperationsFactory,
  type LegacyCustomAgentMaterializationEvent,
  type LegacyIdentityDetachEvent,
  type PreparedRuntimeServices,
  type RuntimeServices,
  type RuntimeServicesTestOverrides,
} from "./services.js";

const V2_LAYOUT_MIGRATION_RECEIPT_CARRIER = Symbol.for(
  "mavis.local-runtime.v2-layout-migration-receipt",
);

/** @internal Component-scoped overrides used by runtime tests and parity probes. */
export interface LocalRuntimeV2TestOverrides {
  readonly database?: {
    readonly sqlite3ModulePath?: string;
  };
  readonly services?: RuntimeServicesTestOverrides;
}

interface InitializedOwnerRuntime {
  readonly database: DatabaseClient;
  readonly background: BackgroundRuntime;
  readonly services: RuntimeServices;
  readonly disabledLegacyScheduleCount: number;
}

/** Creates a fully initialized local runtime. The returned compatibility `ready` is resolved. */
export function createLocalRuntimeHostV2(
  options: LocalRuntimeProductHostOptions,
): Promise<CreatedLocalRuntimeHost> {
  return createLocalRuntimeHostV2Internal(options, {});
}

/** @internal Direct-module test seam; intentionally absent from the package facade. */
export function createLocalRuntimeHostV2ForTest(
  options: LocalRuntimeProductHostOptions,
  overrides: LocalRuntimeV2TestOverrides = {},
): Promise<CreatedLocalRuntimeHost> {
  return createLocalRuntimeHostV2Internal(options, overrides);
}

function bindAskUserSuppressionProbe(
  apiHost: V1CreatedLocalRuntimeHost["apiHost"],
  turnSystem: InitializedOwnerRuntime["services"]["turnSystem"] | undefined,
): void {
  const turnInspection = turnSystem?.inspection;
  if (!turnInspection?.hasPendingUserSteering) return;
  const hasPendingUserSteering =
    turnInspection.hasPendingUserSteering.bind(turnInspection);
  apiHost.hasPendingUserSteeringProbe = (sessionId) =>
    hasPendingUserSteering(sessionId);
}

function bindV2AgentRuntimeManagementPort(
  agentRuntimePort: DeferredLocalAgentRuntimePort,
  ownerRuntime: InitializedOwnerRuntime,
  agentOwner: AgentRuntimeOwner,
): void {
  agentRuntimePort.bindManagement(
    createV2AgentRuntimeManagementPort({
      application: ownerRuntime.services.agent,
      service: agentOwner.service,
      readSessionAgentRouting: (sessionId) =>
        ownerRuntime.services.sessionSystem.sessions.records.readSessionAgentRouting(
          sessionId,
        ),
      resolveSessionProjectIdentity: (sessionId) =>
        ownerRuntime.services.sessionSystem.projects.service.resolveSessionProjectIdentity(
          sessionId,
        ),
    }),
  );
}

async function createLocalRuntimeHostV2Internal(
  options: LocalRuntimeProductHostOptions,
  overrides: LocalRuntimeV2TestOverrides,
): Promise<CreatedLocalRuntimeHost> {
  const compatibility = createV1Compatibility(isV2RuntimeOwner(options));
  let agentOwner: AgentRuntimeOwner | undefined;
  let v1: V1CreatedLocalRuntimeHost | undefined;
  let legacyClose: (() => Promise<void>) | undefined;
  let ownerRuntime: InitializedOwnerRuntime | undefined;
  const agentRuntimePort: DeferredLocalAgentRuntimePort =
    createDeferredLocalAgentRuntimePort();
  const sandboxOperationsFactory =
    createDeferredLocalSandboxBashOperationsFactory(
      () => options.configGetter?.().sandbox?.enabled ?? false,
      resolveAgentBashEnvPolicy(options.dataDir),
    );
  const agentTelemetry = createDeferredAgentRuntimeTelemetry();
  let database: DatabaseClient | undefined;
  let preparedServices: PreparedRuntimeServices | undefined;

  const startupStartedAtMs = Date.now();
  const stageTimings: Record<string, number> = {};
  const measureStage = <T>(stage: string, run: () => T): T => {
    const stageStartedAtMs = Date.now();
    try {
      return run();
    } finally {
      stageTimings[stage] = Math.max(0, Date.now() - stageStartedAtMs);
    }
  };
  const measureStageAsync = async <T>(
    stage: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    const stageStartedAtMs = Date.now();
    try {
      return await run();
    } finally {
      stageTimings[stage] = Math.max(0, Date.now() - stageStartedAtMs);
    }
  };

  try {
    // 2026-09-03: the startup generation checkpoint (whole-dataDir copy +
    // fingerprint verification for the manual `generation rollback` CLI) was
    // removed from the boot path entirely. Layout migration is additive and
    // schema migration keeps its own SQLite backup, so the extra whole-tree
    // snapshot bought nothing while costing large IO on every cold start
    // (a 17G dataDir starved the 600s bootstrap watchdog six times in a row).
    // The rootless-v2-generation module remains for the CLI, which acquires
    // its own operation fence.
    // Layout migration must complete before the authoritative V2 target is
    // opened.  The services composition below gates all legacy access on the
    // target Agent row count.
    const completedLayoutMigration = measureStage("layout_migration_ms", () =>
      ensureCurrentLocalRuntimeDataMigratedToV2OrThrow(
        () => options.dataDir,
        options.nowMs,
      ),
    );
    database = measureStage(
      "db_open_ms",
      () =>
        new DatabaseClient({
          dataDir: options.dataDir,
          ...(overrides.database?.sqlite3ModulePath
            ? { sqlite3ModulePath: overrides.database.sqlite3ModulePath }
            : {}),
        }),
    );
    const resolvedDatabase = database;
    const initialization = await measureStageAsync("db_initialize_ms", () =>
      initializeDatabase({
        database: resolvedDatabase,
        dataDir: options.dataDir,
        onMigration: options.onDatabaseMigration,
      }),
    );
    reportLegacySessionRecovery({
      recoveredLegacySessionCount: initialization.recoveredLegacySessionCount,
      degradedLegacySessionCount: initialization.degradedLegacySessionCount,
    });
    reportProjectMigrationRecovery({
      recoveredProjectPreferenceCount:
        initialization.recoveredProjectPreferenceCount,
      skippedSessionProjectRepairCount:
        initialization.skippedSessionProjectRepairCount,
    });
    agentOwner = await measureStageAsync("agent_composition_ms", () =>
      createRuntimeAgentComposition({
        db: resolvedDatabase.db,
        dataDir: options.dataDir,
        ...(options.promptMode
          ? {
              promptMode: options.promptMode,
              promptVersion: options.appVersion,
            }
          : {}),
        ...(options.nowMs ? { nowMs: options.nowMs } : {}),
        withAgentStorageLock: (operation) =>
          withAgentStorageLock(options.dataDir, operation),
        reportCutover: reportAgentCutover,
        reportIdentityDetach: reportAgentIdentityDetach,
        reportLegacyCustomMaterialization:
          reportLegacyCustomAgentMaterialization,
        facts: agentTelemetry.facts,
      }),
    );
    agentRuntimePort.bindResolver(agentOwner.service);
    preparedServices = compatibility
      ? prepareRuntimeServices({
          db: database.db,
          runtimeOwnerKind: options.runtimeOwnerKind,
        })
      : undefined;
    const configuredOptions = configureV1HostOptions(
      options,
      compatibility,
      agentRuntimePort,
      {
        sandboxOperationsFactory,
        prepared: preparedServices,
      },
    );
    Object.defineProperty(
      configuredOptions,
      V2_LAYOUT_MIGRATION_RECEIPT_CARRIER,
      {
        value: completedLayoutMigration,
        enumerable: false,
        configurable: false,
        writable: false,
      },
    );
    v1 = createLocalRuntimeHostV1(configuredOptions);
    const resolvedV1 = v1;
    agentTelemetry.bind({
      metricsClient: resolvedV1.metricsClient,
      emitBusEvent: (type, payload) =>
        resolvedV1.apiHost.emitBusEvent(type, payload),
    });
    legacyClose = v1.apiHost.close.bind(v1.apiHost);
    await measureStageAsync("v1_host_ready_ms", async () => resolvedV1.ready);

    if (compatibility) {
      if (!preparedServices)
        throw new Error("V2 owner services were not prepared");
      const resolvedPreparedServices = preparedServices;
      const resolvedAgentOwner = agentOwner;
      ownerRuntime = await measureStageAsync("owner_runtime_ms", () =>
        initializeOwnerRuntime({
          v1: resolvedV1,
          compatibility,
          agentOwner: resolvedAgentOwner,
          database: resolvedDatabase,
          sandboxOperationsFactory,
          prepared: resolvedPreparedServices,
          disabledLegacyScheduleCount:
            initialization.disabledLegacyScheduleCount,
          options,
          overrides,
        }),
      );
      ownerRuntime.background.registerMaintenance(
        "migration-backup-retention",
        async () => initialization.pruneBackups?.(),
      );
      bindV2AgentRuntimeManagementPort(
        agentRuntimePort,
        ownerRuntime,
        agentOwner,
      );
      bindV2AgentLifecycle(v1.apiHost, ownerRuntime.services.agent);
      // Decision v3: late-bind the ask_user suppression probe now that the
      // V2 Turn system exists. V1-only hosts (and partial test graphs) keep
      // the probe unset, which means never suppress.
      bindAskUserSuppressionProbe(v1.apiHost, ownerRuntime.services.turnSystem);
    }
    const cliService = ownerRuntime
      ? createCliService(ownerRuntime.services)
      : undefined;

    const close = createSharedClose({
      ownerRuntime,
      closeV1: legacyClose,
      agentOwner,
      agentTelemetry,
      v1,
      database,
    });
    const ownerCompromiseGuard = createRuntimeOwnerCompromiseGuard(
      ownerRuntime,
      close,
    );
    ownerCompromiseGuard.assertHealthy();
    v1.apiHost.close = close;

    // A fresh profile has no primary Agent row until the detached builtin recovery
    // completes. Gate owner channels on that milestone without making either
    // builtin or Channel recovery part of core Runtime readiness.
    const channelStartupStartedAtMs = Date.now();
    const channelStartup = startChannelSubsystemAfterOwnerAgentDefinitions(
      ownerRuntime,
      resolvedV1.apiHost,
      ownerRuntime
        ? () =>
            reportDetachedOwnerChannelStartupTiming(
              startupStartedAtMs,
              channelStartupStartedAtMs,
              stageTimings,
              initialization,
            )
        : undefined,
    );
    if (!ownerRuntime) {
      // Legacy/non-owner hosts retain their established fail-closed startup contract.
      try {
        await measureStageAsync("channel_startup_ms", () => channelStartup);
      } catch (error) {
        reportStartupTimings({
          totalMs: Math.max(0, Date.now() - startupStartedAtMs),
          stages: stageTimings,
          initialization,
          outcome: "failed",
        });
        throw error;
      }
      reportStartupTimings({
        totalMs: Math.max(0, Date.now() - startupStartedAtMs),
        stages: stageTimings,
        initialization,
        outcome: "ready",
      });
    }
    ownerCompromiseGuard.publish();
    ownerRuntime?.background.startMaintenance();

    return createStartedHost(v1, ownerRuntime, cliService, v1.ready);
  } catch (error) {
    compatibility?.failConversation(error);
    await cleanupFailedStartup({
      ownerRuntime,
      v1,
      closeV1: legacyClose,
      agentOwner,
      agentTelemetry,
      database,
    });
    throw error;
  }
}

function createV1Compatibility(
  ownsV2Runtime: boolean,
): V1RuntimeCompatibility | undefined {
  if (!ownsV2Runtime) return undefined;
  return createV1RuntimeCompatibility(new DeferredRuntimeConversation(), {
    createQuestionnaireService: (host) =>
      new LocalQuestionnaireService(host.apiHost.questionnaireServiceDeps()),
  });
}

async function startChannelSubsystemAfterOwnerAgentDefinitions(
  ownerRuntime: InitializedOwnerRuntime | undefined,
  apiHost: V1CreatedLocalRuntimeHost["apiHost"],
  onOwnerChannelStartupSettled?: () => void,
): Promise<void> {
  try {
    if (
      ownerRuntime &&
      !(await ownerRuntime.services.builtinAgentDefinitionsReady)
    )
      return;
    await apiHost.startChannelSubsystem();
  } catch (error) {
    if (!ownerRuntime) throw error;
    try {
      logger.error(
        {
          event: "rootless_im_startup_detached_rejected",
          error_code: runtimeOwnerErrorCode(error),
        },
        "Detached Rootless IM startup rejected after core Runtime became ready",
      );
    } catch {
      // Channel-only diagnostics cannot compromise an otherwise ready Runtime.
    }
  } finally {
    if (ownerRuntime) onOwnerChannelStartupSettled?.();
  }
}

function reportDetachedOwnerChannelStartupTiming(
  startupStartedAtMs: number,
  channelStartupStartedAtMs: number,
  stageTimings: Record<string, number>,
  initialization: DatabaseInitializationResult,
): void {
  stageTimings.channel_startup_ms = Math.max(
    0,
    Date.now() - channelStartupStartedAtMs,
  );
  reportStartupTimings({
    totalMs: Math.max(0, Date.now() - startupStartedAtMs),
    stages: stageTimings,
    initialization,
    outcome: "ready",
  });
}

function createStartedHost(
  v1: V1CreatedLocalRuntimeHost,
  ownerRuntime: InitializedOwnerRuntime | undefined,
  cliService: ReturnType<typeof createCliService> | undefined,
  ready: Promise<void>,
): CreatedLocalRuntimeHost {
  return {
    ...v1,
    ...(ownerRuntime ? { application: ownerRuntime.services.application } : {}),
    ...(cliService ? { cliService } : {}),
    apiHost: v1.apiHost,
    ready,
    ...(ownerRuntime
      ? {
          notifyAuthContextChanged: (authState) =>
            ownerRuntime.services.notifyAuthContextChanged(authState),
        }
      : {}),
  };
}

interface RuntimeOwnerCompromiseGuard {
  assertHealthy(): void;
  publish(): void;
}

function createRuntimeOwnerCompromiseGuard(
  ownerRuntime: InitializedOwnerRuntime | undefined,
  close: () => Promise<void>,
): RuntimeOwnerCompromiseGuard {
  const identity = ownerRuntime?.background.clients.runtimeOwnerIdentity;
  if (!identity)
    return { assertHealthy: () => undefined, publish: () => undefined };

  let published = false;
  let startupFailure: Error | undefined;
  let compromiseClose: Promise<void> | undefined;
  const unsubscribe = identity.onCompromised((error) => {
    if (!published) {
      startupFailure ??= error;
      return;
    }
    compromiseClose ??= closeCompromisedRuntime(
      identity.instanceId,
      error,
      close,
    );
  });
  const assertHealthy = (): void => {
    if (!startupFailure) return;
    unsubscribe();
    throw startupFailure;
  };
  return {
    assertHealthy,
    publish: () => {
      assertHealthy();
      published = true;
    },
  };
}

async function closeCompromisedRuntime(
  instanceId: string,
  error: Error,
  close: () => Promise<void>,
): Promise<void> {
  logger.error(
    {
      event: "runtime_owner_lease_compromised",
      instance_id: instanceId,
      error_code: runtimeOwnerErrorCode(error),
    },
    "V2 Runtime owner lease compromised; closing Runtime",
  );
  try {
    await close();
  } catch (closeError: unknown) {
    logger.error(
      {
        event: "runtime_owner_compromise_close_failed",
        instance_id: instanceId,
        error_code: runtimeOwnerErrorCode(closeError),
      },
      "V2 Runtime failed to close after owner lease compromise",
    );
  }
}

function runtimeOwnerErrorCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error))
    return "UNKNOWN";
  const code = error.code;
  return typeof code === "string" && code.length > 0 ? code : "UNKNOWN";
}

function isV2RuntimeOwner(options: CreateLocalRuntimeHostOptions): boolean {
  return (
    (options.runtimeOwnerKind === "electron" &&
      options.capabilities?.electronHost === true) ||
    ((options.runtimeOwnerKind === "cli" ||
      options.runtimeOwnerKind === "tui") &&
      options.capabilities?.cliEmbedded === true)
  );
}

export { createLocalRuntimeHostV2 as createLocalRuntimeHost };

/**
 * Emits one structured line accounting for every blocking startup stage.
 *
 * Restart latency after an update install is dominated by this path, and until
 * now the only local evidence was the gap between unrelated log lines. The line
 * is always emitted — including the fast no-migration case — so a slow start can
 * be compared against a normal one instead of only being visible when it hurts.
 *
 * `outcome` distinguishes a runtime that actually reached readiness from one
 * that died during channel startup, so a failed restart is never mistaken for a
 * fast one.
 */
function reportStartupTimings(input: {
  readonly totalMs: number;
  readonly stages: Readonly<Record<string, number>>;
  readonly initialization: DatabaseInitializationResult;
  readonly outcome: "ready" | "failed";
}): void {
  const { backup, pendingVersions, timings } = input.initialization;
  try {
    logger.info(
      {
        outcome: input.outcome,
        total_ms: input.totalMs,
        ...input.stages,
        ...(timings
          ? {
              db_initialize_backup_ms: timings.backupMs,
              db_initialize_migrations_ms: timings.migrationsMs,
              db_initialize_schema_check_ms: timings.schemaCheckMs,
            }
          : {}),
        pending_migration_count: pendingVersions?.length ?? 0,
        ...(pendingVersions && pendingVersions.length > 0
          ? { pending_migration_versions: pendingVersions }
          : {}),
        backup_created: backup?.created === true,
        ...(backup?.created
          ? {
              backup_copy_ms: backup.backupMs,
              backup_integrity_ms: backup.integrityMs,
              ...(backup.sizeBytes === undefined
                ? {}
                : { backup_size_bytes: backup.sizeBytes }),
            }
          : {}),
      },
      "local-runtime-v2 startup timings",
    );
  } catch {
    // Startup diagnostics are strictly observational: never let a malformed or
    // partially populated initialization result prevent the runtime from
    // starting.
  }
}

function reportLegacySessionRecovery(result: {
  readonly recoveredLegacySessionCount: number;
  readonly degradedLegacySessionCount: number;
}): void {
  if (
    result.recoveredLegacySessionCount <= 0 &&
    result.degradedLegacySessionCount <= 0
  )
    return;
  logger.warn(
    result,
    "local-runtime-v2 recovered or degraded malformed Session records before migration",
  );
}

function reportProjectMigrationRecovery(result: {
  readonly recoveredProjectPreferenceCount: number;
  readonly skippedSessionProjectRepairCount: number;
}): void {
  if (
    result.recoveredProjectPreferenceCount <= 0 &&
    result.skippedSessionProjectRepairCount <= 0
  ) {
    return;
  }
  logger.warn(
    result,
    "local-runtime-v2 skipped malformed Project migration data",
  );
}

function reportAgentCutover(event: AgentCutoverLogEvent): void {
  const fields = {
    migration_id: event.migrationId,
    ...(event.collisionMigrationId
      ? { collision_migration_id: event.collisionMigrationId }
      : {}),
    phase: event.phase,
    status: event.status,
    source_kind: event.sourceKind,
    target_kind: event.targetKind,
    conflict_count: event.conflictCount,
    mapping: event.mapping,
    reference_counts: event.referenceCounts,
    source_row_count: event.sourceRowCount,
    imported_row_count: event.importedRowCount,
    recovered_timestamp_count: event.recoveredTimestampCount,
    recoveries: event.recoveries,
    target_row_count: event.targetRowCount,
    duration_ms: event.durationMs,
    ...(event.failureStep ? { failure_step: event.failureStep } : {}),
    ...(event.secondaryFailureStep
      ? { secondary_failure_step: event.secondaryFailureStep }
      : {}),
    ...(event.skipCode ? { skip_code: event.skipCode } : {}),
    ...(event.errorCode ? { error_code: event.errorCode } : {}),
  };
  if (event.status === "failed") {
    logger.error(fields, "V2 Agent cutover failed");
    return;
  }
  logger.info(fields, "V2 Agent cutover");
}

/**
 * Startup-only detached-identity record. The fields are deliberately bounded:
 * no Persona, Prompt, Memory, credential, avatar URL, or error text reaches
 * runtime logs.
 */
function reportAgentIdentityDetach(event: LegacyIdentityDetachEvent): void {
  const fields = {
    event: "legacy_builtin_identity_detach",
    agent_name: event.agentName,
    phase: event.phase,
    outcome: event.outcome,
    ...(event.asset ? { asset: event.asset } : {}),
    ...(event.action ? { action: event.action } : {}),
    ...(event.avatarDecision ? { avatar_decision: event.avatarDecision } : {}),
  };
  if (event.outcome === "failed") {
    logger.error(fields, "V2 Agent identity detach failed");
    return;
  }
  logger.info(fields, "V2 Agent identity detach");
}

function reportLegacyCustomAgentMaterialization(
  event: LegacyCustomAgentMaterializationEvent,
): void {
  if (event.kind === "summary") {
    reportLegacyCustomAgentMaterializationSummary(event);
    return;
  }
  reportLegacyCustomAgentMaterializationAgent(event);
}

function reportLegacyCustomAgentMaterializationSummary(
  event: Extract<
    LegacyCustomAgentMaterializationEvent,
    { readonly kind: "summary" }
  >,
): void {
  const fields = {
    event: "legacy_custom_agent_materialization_summary",
    materialized: event.materialized,
    canonical_identity_reconciled: event.canonicalIdentityReconciled,
    already_canonical: event.alreadyCanonical,
    not_legacy: event.notLegacy,
    invalid: event.invalid,
    failed: event.failed,
    receipt_completed: event.receiptCompleted,
  };
  if (event.invalid > 0 || event.failed > 0) {
    logger.warn(fields, "V2 legacy Custom Agent materialization incomplete");
    return;
  }
  logger.info(fields, "V2 legacy Custom Agent materialization summary");
}

function reportLegacyCustomAgentMaterializationAgent(
  event: Extract<
    LegacyCustomAgentMaterializationEvent,
    { readonly kind: "agent" }
  >,
): void {
  const deferred = event.outcome === "invalid" || event.outcome === "failed";
  const fields = {
    event: deferred
      ? "legacy_custom_agent_materialization_deferred"
      : "legacy_custom_agent_materialization",
    agent_name: event.agentName,
    outcome: event.outcome,
    identity_source: event.identitySource,
    recovered_fields: event.recoveredFields,
    ...(event.errorCode ? { error_code: event.errorCode } : {}),
    ...(event.stage ? { stage: event.stage } : {}),
    ...(event.reason ? { reason: event.reason } : {}),
  };
  if (deferred) {
    logger.warn(fields, "V2 legacy Custom Agent materialization deferred");
    return;
  }
  logger.info(fields, "V2 legacy Custom Agent materialization");
}

function configureV1HostOptions(
  options: LocalRuntimeProductHostOptions,
  compatibility: V1RuntimeCompatibility | undefined,
  agentRuntimePort: DeferredLocalAgentRuntimePort,
  owners: {
    readonly sandboxOperationsFactory: DeferredLocalSandboxBashOperationsFactory;
    readonly prepared: PreparedRuntimeServices | undefined;
  },
): CreateLocalRuntimeHostOptions {
  const { sandboxOperationsFactory, prepared } = owners;
  const {
    browserAdapter,
    browserToolExposure,
    promptConfigKey,
    promptMode,
    systemPromptOverrides,
    ...v1Options
  } = options;
  void browserAdapter;
  void browserToolExposure;
  void promptConfigKey;
  void promptMode;
  void systemPromptOverrides;
  // V2 owns the channel startup point: the V1 shell must build stores, APIs,
  // runner and registries without restoring a single transport.
  if (compatibility) {
    if (!prepared)
      throw new Error(
        "V2 owner services were not prepared before V1 construction",
      );
    return {
      ...compatibility.configureHostOptions(
        { ...v1Options, agentRuntimePort, sandboxOperationsFactory },
        agentRuntimePort,
        prepared.v1,
      ),
      deferChannelStartup: true,
    };
  }
  return {
    ...v1Options,
    agentResolver: agentRuntimePort,
    agentRuntimePort,
    sandboxOperationsFactory,
    deferChannelStartup: true,
  };
}

function bindV2AgentLifecycle(
  apiHost: V1CreatedLocalRuntimeHost["apiHost"],
  agent: RuntimeServices["agent"],
): void {
  apiHost.ensureBuiltinAgents = async () => {
    await agent.ensureBuiltinDefinitionsForPhase2();
  };
  apiHost.retryBuiltinGreetings = () => Promise.resolve();
}

function createBrowserUseServiceOptions(
  options: CreateLocalRuntimeHostOptions,
): NonNullable<CreateRuntimeServicesOptions["browserUse"]> {
  return {
    ...(options.browserAdapter ? { adapter: options.browserAdapter } : {}),
    ...(options.browserToolExposure
      ? { toolExposure: options.browserToolExposure }
      : {}),
  };
}

async function initializeOwnerRuntime(input: {
  readonly v1: V1CreatedLocalRuntimeHost;
  readonly compatibility: V1RuntimeCompatibility;
  readonly agentOwner: AgentRuntimeOwner;
  readonly database: DatabaseClient;
  readonly prepared: PreparedRuntimeServices;
  readonly disabledLegacyScheduleCount: number;
  readonly options: CreateLocalRuntimeHostOptions;
  readonly overrides: LocalRuntimeV2TestOverrides;
  readonly sandboxOperationsFactory: DeferredLocalSandboxBashOperationsFactory;
}): Promise<InitializedOwnerRuntime> {
  const {
    v1,
    compatibility,
    agentOwner,
    database,
    prepared,
    options,
    overrides,
    sandboxOperationsFactory,
  } = input;
  let background: BackgroundRuntime | undefined;
  let services: RuntimeServices | undefined;

  try {
    const startupExecutionEnabled = isLocalRuntimeStartupExecutionEnabled(
      options.startupExecutionPolicy,
    );
    const electronOwner = options.runtimeOwnerKind === "electron";
    background = await createBackgroundRuntime({
      db: database.db,
      dataDir: v1.dataDir,
      logger,
      metrics: v1.metricsClient,
      ...(options.nowMs ? { nowMs: options.nowMs } : {}),
      restorePersistedJobExecution: startupExecutionEnabled,
      enableScheduler: electronOwner,
    });
    services = await createRuntimeServices({
      db: database.db,
      dataDir: v1.dataDir,
      logger,
      ...(background.clients.scheduler
        ? { scheduler: background.clients.scheduler }
        : {}),
      metrics: v1.metricsClient,
      eventBus: background.clients.eventBus,
      forkWorktree: background.clients.forkWorktree,
      compatibility: {
        create: () => compatibility.createServiceCompatibility(v1, options),
      },
      prepared,
      agentService: agentOwner.service,
      promptFileReader: agentOwner.promptFileReader,
      ...(options.configSource ? { configSource: options.configSource } : {}),
      ...(options.nowMs ? { nowMs: options.nowMs } : {}),
      recoverPersistedState: startupExecutionEnabled,
      greetingEnabled: electronOwner && startupExecutionEnabled,
      runtimeOwnerKind: options.runtimeOwnerKind,
      browserUse: createBrowserUseServiceOptions(options),
      ...(options.promptConfigKey
        ? { promptConfigKey: options.promptConfigKey }
        : {}),
      capabilityProfile: options.capabilityProfile,
      systemPromptOverrides: options.systemPromptOverrides,
      getRunawayGuardConfig: options.getRunawayGuardConfig,
      ...(options.getToolResultCompactionConfig
        ? {
            getToolResultCompactionConfig:
              options.getToolResultCompactionConfig,
          }
        : {}),
      runtimeOwnerIdentity: background.clients.runtimeOwnerIdentity,
      sandboxOperationsFactory,
      ...sandboxRuntimeOptions(options),
      ...(overrides.services ? { overrides: overrides.services } : {}),
    });
    const ownedServices = services;
    background.registerMaintenance("turn-diff-retention", () =>
      ownedServices.sessionSystem.runStorageMaintenance(),
    );

    await background.start();
    await services.ready();
    return {
      database,
      background,
      services,
      disabledLegacyScheduleCount: input.disabledLegacyScheduleCount,
    };
  } catch (error) {
    await closeOwnerResources(background, services, "startup cleanup");
    throw error;
  }
}

function sandboxRuntimeOptions(
  options: CreateLocalRuntimeHostOptions,
): Pick<Parameters<typeof createRuntimeServices>[0], "sandboxConfig"> {
  const sandboxConfig = options.configGetter?.().sandbox;
  return sandboxConfig ? { sandboxConfig } : {};
}

interface RuntimeResourceState {
  readonly ownerRuntime: InitializedOwnerRuntime | undefined;
  readonly closeV1: (() => Promise<void>) | undefined;
  readonly agentOwner: AgentRuntimeOwner | undefined;
  readonly agentTelemetry: { close(): void };
  readonly v1: V1CreatedLocalRuntimeHost | undefined;
  readonly database: DatabaseClient | undefined;
}

function createSharedClose(state: RuntimeResourceState): () => Promise<void> {
  let closePromise: Promise<void> | undefined;
  return () => {
    if (!closePromise) {
      state.v1?.apiHost.beginShutdown();
      closePromise = closeRuntime(state);
    }
    return closePromise;
  };
}

async function closeRuntime({
  ownerRuntime,
  closeV1,
  agentOwner,
  agentTelemetry,
  v1,
  database,
}: RuntimeResourceState): Promise<void> {
  let firstError: unknown;
  await stopV1Producers(v1, (error) => {
    firstError ??= error;
  });
  await closeOwnerResources(
    ownerRuntime?.background,
    ownerRuntime?.services,
    "close",
    (error) => {
      firstError ??= error;
    },
  );
  try {
    agentTelemetry.close();
  } catch (error) {
    firstError ??= error;
  }
  try {
    agentOwner?.close();
  } catch (error) {
    firstError ??= error;
  }
  try {
    await closeV1?.();
  } catch (error) {
    firstError ??= error;
  }
  try {
    database?.close();
  } catch (error) {
    firstError ??= error;
  }
  if (firstError !== undefined) throw firstError;
}

async function closeOwnerResources(
  background: BackgroundRuntime | undefined,
  services: RuntimeServices | undefined,
  operation: "startup cleanup" | "close",
  recordError?: (error: unknown) => void,
): Promise<void> {
  const steps: Array<[string, () => void | Promise<void>]> = [
    ["stop_background", () => background?.stop()],
    ["close_services", () => services?.close()],
    ["close_background", () => background?.close()],
  ];
  for (const [cleanupStep, step] of steps) {
    try {
      await step();
    } catch (err) {
      recordError?.(err);
      try {
        logger.warn(
          { cleanupStep, err },
          `local-runtime-v2 ${operation} failed`,
        );
      } catch {
        // Resource cleanup and the original runtime failure remain primary.
      }
    }
  }
}

async function cleanupFailedStartup({
  ownerRuntime,
  v1,
  closeV1,
  agentOwner,
  agentTelemetry,
  database,
}: RuntimeResourceState): Promise<void> {
  await stopV1Producers(v1, (error) => {
    try {
      logger.warn(
        { cleanupStep: "stop_v1_producers", err: error },
        "local-runtime-v2 startup cleanup failed",
      );
    } catch {
      // Continue cleanup.
    }
  });
  await closeOwnerResources(
    ownerRuntime?.background,
    ownerRuntime?.services,
    "startup cleanup",
  );
  try {
    agentTelemetry.close();
  } catch (error) {
    try {
      logger.warn(
        { cleanupStep: "close_agent_telemetry", err: error },
        "local-runtime-v2 startup cleanup failed",
      );
    } catch {
      // Continue cleanup.
    }
  }
  try {
    agentOwner?.close();
  } catch (error) {
    try {
      logger.warn(
        { cleanupStep: "close_agent_owner", err: error },
        "local-runtime-v2 startup cleanup failed",
      );
    } catch {
      // Keep running cleanup even when reporting the owner failure fails.
    }
  }
  await cleanupFailedV1Startup(v1, closeV1, (cleanupStep, err) => {
    try {
      logger.warn(
        { cleanupStep, err },
        "local-runtime-v2 startup cleanup failed",
      );
    } catch {
      // Continue cleanup even when reporting itself fails.
    }
  });
  try {
    database?.close();
  } catch (error) {
    try {
      logger.warn(
        { cleanupStep: "close_database", err: error },
        "local-runtime-v2 startup cleanup failed",
      );
    } catch {
      // Continue cleanup.
    }
  }
}

async function stopV1Producers(
  v1: V1CreatedLocalRuntimeHost | undefined,
  recordError: (error: unknown) => void,
): Promise<void> {
  const steps: Array<() => void | Promise<void>> = [
    () => v1?.apiHost.cronRuntime.stop(),
    () => v1?.apiHost.shutdownChannelSubsystem(),
  ];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      recordError(error);
    }
  }
}
