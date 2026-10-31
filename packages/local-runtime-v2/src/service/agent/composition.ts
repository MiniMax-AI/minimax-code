import { count } from 'drizzle-orm';

import { logger } from '@mavis/shared/local-runtime-logging';

import type { AppDb } from '../../infra/db/client.js';
import { agents } from '../../infra/db/schema/agents.js';
import type { AgentSystemFactCallbacks } from './contracts.js';

import { createAgentRuntimeOwner, type AgentRuntimeOwner } from './initialize.js';
import { BuiltinAgentCatalog } from './builtin/catalog.js';
import type { LegacyCustomAgentMaterializationEvent } from './application/agent.service.js';
import type { LegacyIdentityDetachEvent } from './application/_migration-legacy-identity-detach.js';
import type { BuiltinAgentConfigRepairEvent } from './application/config/builtin-canonical-files.js';
import {
  importLegacyAgents,
  isLegacyAgentTargetBootstrapEligible,
  type LegacyAgentTimestampRecovery,
} from './storage/_migration-legacy-agents.js';
import { AgentFiles } from './storage/agent-files.js';
import type { AgentConfigError } from './storage/canonical-agent-config.js';
import { LegacyAgentBootstrapImportReceipt } from './storage/legacy-agent-bootstrap-receipt.js';

export type { AgentRuntimeOwner } from './initialize.js';

type LegacyCollisionInspection = {
  readonly status: 'conflict' | 'completed' | 'skipped';
  readonly sourceKind: 'legacy-agent-sqlite';
  readonly sourceRowCount: number | null;
  readonly conflictCount: number;
  readonly mappings: readonly {
    readonly from: string;
    readonly to: string;
    readonly stage: string;
  }[];
  readonly referenceCounts: AgentReferenceCounts;
  readonly migrationId?: string;
  readonly skipCode?: 'source_missing' | 'table_missing' | 'no_conflict';
};

type LegacyCollisionResult = {
  readonly status: 'prepared' | 'in_progress' | 'completed' | 'failed' | 'skipped';
  readonly migrationId?: string;
  readonly conflictCount?: number;
  readonly referenceCounts?: AgentReferenceCounts;
};

type LegacyCollisionFailureStep =
  | 'lock'
  | 'manifest_prepare'
  | 'backup'
  | 'primary_rewrite'
  | 'runtime_rewrite'
  | 'yaml_rewrite'
  | 'plan_rewrite'
  | 'failure_manifest_write';

type AgentReferenceCounts = {
  readonly primaryDatabase: number;
  readonly runtimeDatabase: number;
  readonly yamlFiles: number;
  readonly planFiles: number;
  readonly legacyUnclassified: number;
};

const EMPTY_REFERENCE_COUNTS: AgentReferenceCounts = {
  primaryDatabase: 0,
  runtimeDatabase: 0,
  yamlFiles: 0,
  planFiles: 0,
  legacyUnclassified: 0,
};

export type AgentCutoverLogEvent = {
  readonly migrationId: string;
  readonly collisionMigrationId?: string;
  readonly phase:
    | 'target_preflight'
    | 'collision_scan'
    | 'collision_rewrite'
    | 'legacy_import'
    | 'owner_create'
    | 'builtin_seed'
    | 'completed';
  readonly status: 'completed' | 'skipped' | 'failed';
  readonly sourceKind: 'legacy-agent-sqlite';
  readonly targetKind: 'v2-agent-sqlite';
  readonly conflictCount: number;
  /** Raw legacy collision mappings are source data and never leave cutover internals. */
  readonly mapping: readonly [];
  readonly referenceCounts: AgentReferenceCounts;
  readonly sourceRowCount: number | null;
  readonly importedRowCount: number | null;
  readonly recoveredTimestampCount: number;
  readonly recoveries: readonly LegacyAgentTimestampRecovery[];
  readonly targetRowCount: number;
  readonly durationMs: number;
  readonly failureStep?: LegacyCollisionFailureStep;
  readonly secondaryFailureStep?: 'failure_manifest_write';
  readonly skipCode?:
    | 'target_nonempty'
    | 'source_missing'
    | 'table_missing'
    | 'no_conflict'
    | 'bootstrap_receipt_completed';
  readonly errorCode?:
    | 'agent_cutover_target_preflight_failed'
    | 'agent_cutover_collision_failed'
    | 'agent_cutover_import_failed'
    | 'agent_cutover_builtin_seed_failed'
    | 'agent_cutover_owner_failed';
};

type AgentCutoverEventSink = (event: AgentCutoverLogEvent) => void;

/**
 * Mutable cutover record shared by the staged pipeline. Every emit reads the
 * live values, so stages must advance `phase` before the operation that can
 * throw and update counters before the matching emit.
 */
type CutoverProgress = {
  phase: AgentCutoverLogEvent['phase'];
  conflictCount: number;
  referenceCounts: AgentReferenceCounts;
  sourceRowCount: number | null;
  importedRowCount: number | null;
  recoveredTimestampCount: number;
  recoveries: readonly LegacyAgentTimestampRecovery[];
  targetRowCount: number;
  collisionMigrationId?: string;
  failureStep?: LegacyCollisionFailureStep;
  secondaryFailureStep?: 'failure_manifest_write';
};

type CutoverEmit = (
  phase: AgentCutoverLogEvent['phase'],
  status: AgentCutoverLogEvent['status'],
  extra?: Pick<AgentCutoverLogEvent, 'skipCode' | 'errorCode'>,
) => void;

export interface AgentStorageLockScope {
  /** Read-only source scan before the target-empty import. */
  readonly inspectLegacyAgentStorage: () => LegacyCollisionInspection;
  /** Performs backup and deterministic legacy rename/rewrite after a conflict scan. */
  readonly applyLegacyAgentStorage: (nowMs?: () => number) => LegacyCollisionResult;
  /** Repairs a target-side Custom/Builtin name collision while the lease is held. */
  readonly repairBuiltinAgentNameConflicts: (input: {
    readonly builtinNames: readonly string[];
    readonly nowMs: () => number;
    readonly listDirectCustomAgentNames: () => Promise<readonly string[]>;
    readonly rewriteMovedCanonicalAgent: (mapping: {
      readonly from: string;
      readonly to: string;
    }) => Promise<void>;
  }) => Promise<void>;
}

export interface RuntimeAgentCompositionOptions {
  readonly promptMode?: 'tui' | 'coding' | 'work';
  readonly promptVersion?: string;
  readonly db: AppDb;
  readonly dataDir: string;
  readonly nowMs?: () => number;
  readonly facts: AgentSystemFactCallbacks;
  /** Cross-process cutover lock shared with the legacy migration. */
  readonly withAgentStorageLock: <T>(
    operation: (scope: AgentStorageLockScope) => T | PromiseLike<T>,
  ) => Promise<T>;
  /** Runtime-owned structured cutover event sink; failure to emit is fail-open. */
  readonly reportCutover: AgentCutoverEventSink;
  /** Runtime-owned startup log sink for the one-shot Agent identity detach. */
  readonly reportIdentityDetach?: (event: LegacyIdentityDetachEvent) => void;
  /** Runtime-owned startup log sink for deferred legacy Custom materialization. */
  readonly reportLegacyCustomMaterialization?: (
    event: LegacyCustomAgentMaterializationEvent,
  ) => void;
}

/**
 * Prepare the authoritative V2 Agent target and construct its owner. A
 * Custom/automatic target never opens, validates, or mutates the legacy
 * SQLite DB; a builtin bootstrap target may catch up under this lock.
 */
export async function createRuntimeAgentComposition(
  options: RuntimeAgentCompositionOptions,
): Promise<AgentRuntimeOwner> {
  return options.withAgentStorageLock(async (scope) => {
    const nowMs = options.nowMs ?? (() => Date.now());
    const startedAtMs = nowMs();
    const migrationId = `agent-cutover-${startedAtMs}`;
    const progress: CutoverProgress = {
      phase: 'target_preflight',
      conflictCount: 0,
      referenceCounts: { ...EMPTY_REFERENCE_COUNTS },
      sourceRowCount: null,
      importedRowCount: null,
      recoveredTimestampCount: 0,
      recoveries: [],
      targetRowCount: 0,
    };
    let owner: AgentRuntimeOwner | undefined;

    const emit: CutoverEmit = (eventPhase, status, extra = {}): void => {
      reportCutover(options.reportCutover, {
        migrationId,
        ...(progress.collisionMigrationId
          ? { collisionMigrationId: progress.collisionMigrationId }
          : {}),
        phase: eventPhase,
        status,
        sourceKind: 'legacy-agent-sqlite',
        targetKind: 'v2-agent-sqlite',
        conflictCount: progress.conflictCount,
        // Legacy mapping names are source data. V2 never exposes them in
        // cutover events; conflictCount/errorCode remain the safe diagnostics.
        mapping: [],
        referenceCounts: progress.referenceCounts,
        sourceRowCount: progress.sourceRowCount,
        importedRowCount: progress.importedRowCount,
        recoveredTimestampCount: progress.recoveredTimestampCount,
        recoveries: progress.recoveries,
        targetRowCount: progress.targetRowCount,
        durationMs: durationSince(startedAtMs, nowMs()),
        ...(progress.failureStep ? { failureStep: progress.failureStep } : {}),
        ...(progress.secondaryFailureStep
          ? { secondaryFailureStep: progress.secondaryFailureStep }
          : {}),
        ...(extra.skipCode ? { skipCode: extra.skipCode } : {}),
        ...(extra.errorCode ? { errorCode: extra.errorCode } : {}),
      });
    };

    try {
      progress.phase = 'target_preflight';
      progress.targetRowCount = countAgentRows(options.db);
      const targetBootstrapEligible = isLegacyAgentTargetBootstrapEligible(options.db);
      // The in-DB gate above re-qualifies whenever the user deletes every
      // imported Custom row (a builtin-only target looks like a fresh
      // bootstrap), which used to resurrect deleted legacy Agents on every
      // startup. The dataDir-level receipt below makes the whole legacy
      // bootstrap evaluation one-shot per data directory. Read and written
      // inside withAgentStorageLock, so there is no cross-process race.
      const bootstrapReceipt = new LegacyAgentBootstrapImportReceipt(options.dataDir);
      const bootstrapReceiptCompleted = await readBootstrapReceiptFailOpen(bootstrapReceipt);
      if (!targetBootstrapEligible) {
        emit(progress.phase, 'skipped', { skipCode: 'target_nonempty' });
      } else {
        emit(progress.phase, 'completed');
      }
      await runGatedLegacyBootstrap({
        progress,
        scope,
        options,
        nowMs,
        emit,
        targetBootstrapEligible,
        receipt: bootstrapReceipt,
        receiptCompleted: bootstrapReceiptCompleted,
      });

      // A legacy import can introduce a current V2 Custom row under a
      // reserved Builtin name. Resolve it only after import and before seed.
      const builtinNames = (await new BuiltinAgentCatalog().listDefinitions()).map(
        (definition) => definition.name,
      );
      // Reuse the builtin-seed failure code for this pre-seed repair. It is a
      // target-side operation, never a legacy-import failure.
      progress.phase = 'builtin_seed';
      const files = new AgentFiles(options.dataDir);
      await scope.repairBuiltinAgentNameConflicts({
        builtinNames,
        nowMs,
        listDirectCustomAgentNames: () => files.listDirectCustomAgentNames(),
        rewriteMovedCanonicalAgent: async (mapping) => {
          const config = await files.rewriteCanonicalCustomNameAfterMove(mapping.from, mapping.to);
          if (!config.errorCode) return;
          reportBuiltinNameConflictConfigDiagnostic(
            options.reportLegacyCustomMaterialization,
            mapping.to,
            config.errorCode,
            config.reason ?? 'invalid',
          );
        },
      });

      progress.phase = 'owner_create';
      owner = createAgentRuntimeOwner({
        database: options.db,
        dataDir: options.dataDir,
        ...(options.promptMode
          ? { promptMode: options.promptMode, promptVersion: options.promptVersion }
          : {}),
        ...(options.nowMs ? { nowMs: options.nowMs } : {}),
        facts: options.facts,
        ...(options.reportIdentityDetach
          ? { reportIdentityDetach: options.reportIdentityDetach }
          : {}),
        ...(options.reportLegacyCustomMaterialization
          ? { reportLegacyCustomMaterialization: options.reportLegacyCustomMaterialization }
          : {}),
        reportBuiltinConfigRepair: reportBuiltinAgentConfigRepair,
      });
      emit(progress.phase, 'completed');
      progress.phase = 'builtin_seed';
      await owner.service.ensureBuiltinRows();
      // This is the one startup barrier for the Agent definition cutover:
      // detach proven historic builtins first, rebuild managed Builtins, then
      // materialize every legacy Custom definition before any Turn owner can
      // observe the runtime. Known per-Agent configuration failures are
      // logged and deferred; storage and unknown failures remain fail-closed.
      await owner.service.materializeLegacyCustomAgents();
      const authoritativeCount = countAgentRows(options.db);
      if (authoritativeCount === 0) {
        throw new Error('Agent authority initialization produced an empty target');
      }
      progress.targetRowCount = authoritativeCount;
      emit(progress.phase, 'completed');
      emit('completed', 'completed');
      return owner;
    } catch (error) {
      applyCollisionFailure(progress, error);
      owner?.close();
      emit(progress.phase, 'failed', { errorCode: errorCodeForPhase(progress.phase) });
      throw error;
    }
  });
}

function applyCollisionFailure(progress: CutoverProgress, error: unknown): void {
  if (!error || typeof error !== 'object') return;
  const details = error as Record<string, unknown>;
  setCollisionMigrationId(progress, details.migrationId);
  if (!isCollisionFailureStep(details.failureStep)) return;
  progress.failureStep = details.failureStep;
  progress.secondaryFailureStep =
    details.secondaryFailureStep === 'failure_manifest_write'
      ? details.secondaryFailureStep
      : undefined;
}

function isCollisionFailureStep(value: unknown): value is LegacyCollisionFailureStep {
  return (
    typeof value === 'string' &&
    [
      'lock',
      'manifest_prepare',
      'backup',
      'primary_rewrite',
      'runtime_rewrite',
      'yaml_rewrite',
      'plan_rewrite',
      'failure_manifest_write',
    ].includes(value)
  );
}

function setCollisionMigrationId(progress: CutoverProgress, value: unknown): void {
  if (typeof value === 'string' && /^agent-name-conflicts-\d+$/u.test(value)) {
    progress.collisionMigrationId = value;
  }
}

/**
 * Scans the legacy source and, only on a verified conflict, applies the
 * lock-scoped backup and deterministic rename/rewrite before importing.
 */
function runLegacyCollisionStage(
  progress: CutoverProgress,
  scope: AgentStorageLockScope,
  nowMs: () => number,
  emit: CutoverEmit,
): void {
  progress.phase = 'collision_scan';
  const inspection = scope.inspectLegacyAgentStorage();
  progress.sourceRowCount = inspection.sourceRowCount;
  progress.conflictCount = inspection.conflictCount;
  progress.referenceCounts = inspection.referenceCounts;
  setCollisionMigrationId(progress, inspection.migrationId);
  switch (inspection.status) {
    case 'skipped':
      emit(progress.phase, 'skipped', inspection.skipCode ? { skipCode: inspection.skipCode } : {});
      return;
    case 'completed':
      emit(progress.phase, 'completed');
      return;
    case 'conflict':
      break;
    default:
      throw new Error('invalid_legacy_agent_collision_inspection');
  }
  if (!Number.isSafeInteger(inspection.conflictCount) || inspection.conflictCount < 1) {
    throw new Error('invalid_legacy_agent_collision_inspection');
  }
  emit(progress.phase, 'completed');
  progress.phase = 'collision_rewrite';
  const collision = scope.applyLegacyAgentStorage(nowMs);
  if (collision.status !== 'completed') {
    throw new Error('legacy_agent_source_collision_apply_incomplete');
  }
  // Names are source data. Keep only aggregate diagnostics in V2 telemetry.
  setCollisionMigrationId(progress, collision.migrationId);
  progress.conflictCount = collision.conflictCount ?? progress.conflictCount;
  progress.referenceCounts = collision.referenceCounts ?? progress.referenceCounts;
  emit(progress.phase, 'completed');
}

/** Imports missing legacy rows and verifies the target count increment. */
function runLegacyImportStage(
  progress: CutoverProgress,
  options: RuntimeAgentCompositionOptions,
  emit: CutoverEmit,
): void {
  progress.phase = 'legacy_import';
  const targetRowCountBeforeImport = countAgentRows(options.db);
  const imported = importLegacyAgents({ db: options.db, sourceDataDir: options.dataDir });
  if (imported.status === 'imported') {
    progress.importedRowCount = imported.count;
    progress.recoveredTimestampCount = imported.recoveredTimestamps.count;
    progress.recoveries = imported.recoveredTimestamps.entries;
    if (progress.sourceRowCount === null && targetRowCountBeforeImport === 0) {
      progress.sourceRowCount = imported.count;
    }
    progress.targetRowCount = countAgentRows(options.db);
    if (progress.targetRowCount !== targetRowCountBeforeImport + imported.count) {
      throw new Error('Legacy Agent import count verification failed');
    }
  } else {
    progress.importedRowCount = 0;
    progress.recoveredTimestampCount = 0;
    progress.recoveries = [];
    progress.targetRowCount = countAgentRows(options.db);
  }
  emit(
    progress.phase,
    imported.status === 'imported' ? 'completed' : 'skipped',
    imported.status === 'skipped' ? { skipCode: normalizeImportSkipCode(imported.reason) } : {},
  );
}

/**
 * Runs the receipt-gated legacy bootstrap stages after target preflight.
 *
 * - Eligible target + completed receipt → skip both legacy stages: this data
 *   directory already concluded its one bootstrap evaluation, and re-running
 *   it is what used to resurrect user-deleted legacy Agents.
 * - Eligible target + no receipt → evaluate both stages; every non-throwing
 *   conclusion (`imported`, even count=0, and every skip reason) is a
 *   terminal determination, so complete the receipt. A throw skips the
 *   receipt on purpose: the next startup retries the evaluation.
 * - Non-eligible target (Custom/automatic rows present) → the target is
 *   authoritative and by design never imports again; that preflight verdict
 *   is just as terminal, so complete the receipt here too. Otherwise a later
 *   "delete every Custom row" would re-open the in-DB gate exactly like the
 *   bug this receipt exists to fix.
 */
async function runGatedLegacyBootstrap(input: {
  readonly progress: CutoverProgress;
  readonly scope: AgentStorageLockScope;
  readonly options: RuntimeAgentCompositionOptions;
  readonly nowMs: () => number;
  readonly emit: CutoverEmit;
  readonly targetBootstrapEligible: boolean;
  readonly receipt: LegacyAgentBootstrapImportReceipt;
  readonly receiptCompleted: boolean;
}): Promise<void> {
  if (input.targetBootstrapEligible) {
    if (input.receiptCompleted) {
      skipLegacyStagesForCompletedBootstrap(input.progress, input.receipt, input.emit);
      return;
    }
    runLegacyCollisionStage(input.progress, input.scope, input.nowMs, input.emit);
    runLegacyImportStage(input.progress, input.options, input.emit);
    await completeBootstrapReceipt(input.receipt, input.progress);
    return;
  }
  if (!input.receiptCompleted) {
    await completeBootstrapReceipt(input.receipt, input.progress);
  }
}

/**
 * Reads the one-shot bootstrap receipt. A read failure fails open — the
 * legacy bootstrap is evaluated as if no receipt existed — because an
 * unreadable marker must never block a legitimate first import; the ERROR
 * log keeps the degradation observable instead of silent.
 */
async function readBootstrapReceiptFailOpen(
  receipt: LegacyAgentBootstrapImportReceipt,
): Promise<boolean> {
  try {
    return await receipt.isCompleted();
  } catch (error) {
    logger.error(
      { receipt_path: receipt.path(), error: errorMessage(error) },
      'V2 Agent cutover bootstrap receipt read failed; treating the bootstrap as unevaluated',
    );
    return false;
  }
}

/**
 * Receipt gate hit: this data directory already concluded its one legacy
 * bootstrap evaluation, so both legacy stages are skipped wholesale. This is
 * the branch that keeps a user-deleted legacy Agent deleted across restarts.
 */
function skipLegacyStagesForCompletedBootstrap(
  progress: CutoverProgress,
  receipt: LegacyAgentBootstrapImportReceipt,
  emit: CutoverEmit,
): void {
  logger.info(
    { receipt_path: receipt.path() },
    'V2 Agent cutover bootstrap receipt already completed; skipping legacy collision scan and import',
  );
  progress.phase = 'collision_scan';
  emit(progress.phase, 'skipped', { skipCode: 'bootstrap_receipt_completed' });
  progress.phase = 'legacy_import';
  emit(progress.phase, 'skipped', { skipCode: 'bootstrap_receipt_completed' });
}

/**
 * Persists the one-shot receipt after a terminal bootstrap determination. A
 * write failure is logged and rethrown into the existing cutover failure
 * path (fail-closed for this startup, retried by the next one) — silently
 * continuing would repeat the evaluation on every startup without any trace.
 */
async function completeBootstrapReceipt(
  receipt: LegacyAgentBootstrapImportReceipt,
  progress: CutoverProgress,
): Promise<void> {
  try {
    await receipt.complete();
  } catch (error) {
    logger.error(
      { receipt_path: receipt.path(), phase: progress.phase, error: errorMessage(error) },
      'V2 Agent cutover bootstrap receipt write failed',
    );
    throw error;
  }
  logger.info(
    {
      receipt_path: receipt.path(),
      phase: progress.phase,
      source_row_count: progress.sourceRowCount,
      imported_row_count: progress.importedRowCount,
      target_row_count: progress.targetRowCount,
    },
    'V2 Agent cutover bootstrap receipt written; legacy bootstrap will not be re-evaluated for this data directory',
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Builtin source repair runs in both startup passes and is the only trace of a
 * user's archived edits; a startup reload is the only trace that non-model
 * edits were replaced by the bundled content. A use-time reseed is the only trace that another
 * process deleted a Builtin file while this runtime was running. A skipped repair
 * records that a file judged corrupted was fixed or deleted before it was archived.
 * Fields stay bounded: the archive is named by file name only, and no dataDir path or
 * prompt content reaches runtime logs.
 */
function reportBuiltinAgentConfigRepair(event: BuiltinAgentConfigRepairEvent): void {
  if (event.kind === 'reloaded') {
    logger.info(
      {
        event: 'builtin_agent_config_reloaded',
        agent_name: event.agentName,
        model_kept: event.modelKept,
      },
      'V2 Builtin Agent config reloaded to the bundled content',
    );
    return;
  }
  if (event.kind === 'reseeded') {
    logger.warn(
      {
        event: 'builtin_agent_config_reseeded',
        agent_name: event.agentName,
        trigger: event.trigger,
      },
      'V2 Builtin Agent config reseeded after it went missing',
    );
    return;
  }
  if (event.kind === 'archived') {
    logger.warn(
      {
        event: 'builtin_agent_config_archived',
        agent_name: event.agentName,
        error_code: event.errorCode,
        archive_file: event.archiveFile,
      },
      'V2 Builtin Agent config archived before repair',
    );
    return;
  }
  if (event.kind === 'repair_skipped') {
    logger.info(
      {
        event: 'builtin_agent_config_repair_skipped',
        agent_name: event.agentName,
        error_code: event.errorCode,
        reason: event.reason,
      },
      'V2 Builtin Agent config repair skipped; the file was fixed or deleted before it ran',
    );
    return;
  }
  logger.error(
    {
      event: 'builtin_agent_config_repair_failed',
      agent_name: event.agentName,
      error_code: event.errorCode,
      stage: event.stage,
    },
    'V2 Builtin Agent config repair failed',
  );
}

function reportBuiltinNameConflictConfigDiagnostic(
  report: ((event: LegacyCustomAgentMaterializationEvent) => void) | undefined,
  agentName: string,
  errorCode: AgentConfigError['code'],
  reason: 'missing' | 'invalid' | 'unreadable',
): void {
  try {
    report?.({
      kind: 'agent',
      agentName,
      outcome: 'invalid',
      identitySource: 'none',
      recoveredFields: [],
      errorCode,
      stage: 'builtin_name_conflict_rename',
      reason,
    });
  } catch {
    // Observability cannot keep the builtin roster from recovering.
  }
}

function countAgentRows(db: AppDb): number {
  return db.select({ count: count() }).from(agents).get()?.count ?? 0;
}

function durationSince(startedAtMs: number, nowMs: number): number {
  return Math.max(0, nowMs - startedAtMs);
}

function errorCodeForPhase(
  phase: AgentCutoverLogEvent['phase'],
): NonNullable<AgentCutoverLogEvent['errorCode']> {
  switch (phase) {
    case 'target_preflight':
      return 'agent_cutover_target_preflight_failed';
    case 'collision_scan':
    case 'collision_rewrite':
      return 'agent_cutover_collision_failed';
    case 'legacy_import':
      return 'agent_cutover_import_failed';
    case 'builtin_seed':
      return 'agent_cutover_builtin_seed_failed';
    default:
      return 'agent_cutover_owner_failed';
  }
}

function normalizeImportSkipCode(
  reason: 'source-missing' | 'table-missing' | 'target-nonempty',
): AgentCutoverLogEvent['skipCode'] {
  switch (reason) {
    case 'source-missing':
      return 'source_missing';
    case 'table-missing':
      return 'table_missing';
    case 'target-nonempty':
      return 'target_nonempty';
  }
}

function reportCutover(sink: AgentCutoverEventSink, event: AgentCutoverLogEvent): void {
  try {
    sink(event);
  } catch {
    // Observability cannot change the dataDir cutover outcome.
  }
}
