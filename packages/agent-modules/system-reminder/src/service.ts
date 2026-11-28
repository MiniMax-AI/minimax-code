/**
 * SystemReminderService — framework-aware system-reminder injection.
 *
 * Called by SessionBridge.sendMessage() before dispatching to any adapter.
 * Uses a SystemReminderRegistry (chain-of-responsibility) to run registered
 * providers and assemble their outputs into a <system-reminder> block.
 *
 * Different AgentFrameworkType can have different provider chains — the
 * registry resolves which providers to run based on the session's framework.
 */

import { performance } from 'node:perf_hooks';
import type { SystemReminderRegistry } from './registry.js';
import type { MemoryDirSnapshot, SessionInfo, MessageRequest } from './types.js';
import type {
  DataCollector,
  ModelSelector,
  Logger,
  LogContext,
  ReminderConfig,
  SystemReminderDiagnostic,
  ProviderDiagnostic,
} from './dependencies.js';
import { getEvolutionReminder, boundMap } from './evolution.js';
import type { EvolutionState } from './evolution.js';
import { touchTodoStateTurn } from './todo-state.js';
import { stripProviderSuffix } from './providers.js';
import { wrapSystemReminderBlocks } from './envelope.js';

export class SystemReminderService implements EvolutionState {
  // ── Turn tracking ──
  private readonly turnCounts = new Map<string, number>();

  // ── Evolution state (used exclusively by getEvolutionReminder) ──
  readonly memorySnapshots = new Map<string, MemoryDirSnapshot>();
  readonly lastSkillReminderAt = new Map<string, number>();
  readonly nextMemoryReminderAt = new Map<string, number>();
  readonly memoryReminderGap = new Map<string, number>();
  readonly nextSkillReminderAt = new Map<string, number>();
  readonly skillReminderGap = new Map<string, number>();

  constructor(
    private readonly collector: DataCollector,
    private readonly registry: SystemReminderRegistry,
    private readonly dataDir: string,
    /**
     * Host logging surface, injected so this package never imports a runtime
     * logger.
     */
    private readonly logger: Logger,
    /**
     * Factory for the per-call log context (trace id etc.). Invoked for each
     * log line so each emission carries a fresh context.
     */
    private readonly logCtx: () => LogContext,
    /**
     * Config slice read by the service — currently only the model-prefix
     * disable list that gates the skill-evolve model preview.
     */
    private readonly config: ReminderConfig,
    /**
     * Models for which the per-message `<system-reminder>` block is fully
     * suppressed. When the resolved model matches one of these
     * `"providerID/modelID"` keys, `buildReminder` returns undefined without
     * collecting data or running providers.
     *
     * Configured via `contextManagement.disableSystemReminderModels` in
     * config.yaml. Empty by default.
     */
    private readonly disableSrModels: ReadonlySet<string> = new Set(),
    /**
     * Optional reference to the model selector for previewing the resolved
     * model (dryRun) before SR injection. Required when `disableSrModels` is
     * non-empty so we can dispatch on the SAME model that the bridge will
     * eventually commit, regardless of whether the caller passed `msg.model`
     * explicitly.
     */
    private readonly modelSelectionService?: ModelSelector,
  ) {}

  /**
   * Build the full <system-reminder> block for a message being sent to a session.
   * Returns undefined if no reminders are needed.
   *
   * When diagnostics are explicitly requested via `options.withDiagnostic`,
   * also returns a SystemReminderDiagnostic via the second element of the
   * returned tuple.
   */
  async buildReminder(
    session: SessionInfo,
    msg: MessageRequest,
    options?: { withDiagnostic?: boolean },
  ): Promise<{ text: string | undefined; diagnostic?: SystemReminderDiagnostic }> {
    const diagEnabled = options?.withDiagnostic === true;
    const totalStart = diagEnabled ? performance.now() : 0;
    let criticalOnly = false;
    let disabledModelKey: string | undefined;
    let resolvedModelID: string | undefined;

    // Resolve model once — used for both SR disable check and skill-evolve model gating.
    const disableModelPrefixes = this.config.disableModelPrefixes;
    const needsModelPreview =
      (this.disableSrModels.size > 0 || disableModelPrefixes.length > 0) &&
      this.modelSelectionService;

    if (needsModelPreview) {
      try {
        const final = await this.modelSelectionService!.resolveForSend({
          sessionId: session.sessionId,
          agentName: session.agentName,
          requestModel: msg.model,
          dryRun: true,
        });
        resolvedModelID = final.modelID;
        const modelKey = `${final.providerID}/${final.modelID}`;
        if (this.disableSrModels.has(modelKey)) {
          criticalOnly = true;
          disabledModelKey = modelKey;
        }
      } catch (err) {
        this.logger.warn(
          this.logCtx(),
          `Failed to preview model for SR disable check — running normal pipeline sessionId=${session.sessionId} err=${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    try {
      // 1. Increment turn counter
      const turnCount = this.incrementTurn(session.sessionId);

      // 2. Collect all dynamic data from stores/filesystem
      const collectStart = diagEnabled ? performance.now() : 0;
      const data = await this.collector.collect(session, msg, turnCount);
      const collectDurationMs = diagEnabled ? performance.now() - collectStart : 0;

      // 2b. Per-model skill-evolve gating
      if (data.skillEvolveEnabled && resolvedModelID && disableModelPrefixes.length > 0) {
        if (disableModelPrefixes.some((p) => resolvedModelID!.startsWith(p))) {
          data.skillEvolveEnabled = false;
          // Proposal trigger requires skill-evolve as parent gate; cascade.
          data.skillProposalEnabled = false;
        }
      }

      if (data.activeTodoState) {
        touchTodoStateTurn(session.sessionId, turnCount);
        data.activeTodoState.lastUpdatedTurn = turnCount;
      }

      // 3. Compute evolution reminder
      data.evolutionReminder = getEvolutionReminder(
        data.agentMemorySnapshot,
        session.sessionId,
        session.agentName,
        turnCount,
        this,
      );

      // 4. Run providers — with optional diagnostic capture.
      //
      // Per-turn allowlist gate (cloud-runtime path):
      //   `data.systemReminders` is sourced from `AgentConfig.system_reminders`
      //   (IDL field 19). When undefined (daemon / legacy callers), every
      //   registered provider runs — preserves existing behaviour. When an
      //   empty array or non-empty array is supplied (cloud-runtime always
      //   supplies one), we filter the registry chain so only providers whose
      //   stripped name matches an entry are executed. `critical` providers
      //   are NOT bypassed; they go through the same gate per the design
      //   `system-reminders-from-agent-config.md` Q2.
      const baseProviders = criticalOnly
        ? this.registry.resolveCritical(session.frameworkType)
        : this.registry.resolve(session.frameworkType);
      const allowlist = data.systemReminders;
      const allowedNames = allowlist ? new Set(allowlist.map((e) => e.name)) : null;
      const sessionAllowlist = session.reminderAllowlist;
      const namedProviders = baseProviders.filter((np) => {
        const name = stripProviderSuffix(np.name);
        if (allowedNames && !allowedNames.has(name)) return false;
        return !sessionAllowlist || sessionAllowlist.has(name);
      });

      const blocks: string[] = [];
      const providerDiagnostics: ProviderDiagnostic[] = [];

      for (const np of namedProviders) {
        const pStart = diagEnabled ? performance.now() : 0;
        const result = await np.fn(data);
        const pDuration = diagEnabled ? performance.now() - pStart : 0;
        const trimmed = result?.trim() || undefined;

        if (trimmed) {
          blocks.push(trimmed);
        }

        if (diagEnabled) {
          providerDiagnostics.push({
            name: np.name,
            fired: !!trimmed,
            output: trimmed,
            durationMs: Math.round(pDuration * 100) / 100,
            critical: np.critical,
          });
        }
      }

      if (criticalOnly) {
        this.logger.info(
          this.logCtx(),
          `SR injection limited to critical providers sessionId=${session.sessionId} modelKey=${disabledModelKey ?? 'unknown'} providers=${namedProviders.length} blocks=${blocks.length}`,
        );
      }

      const fullText = blocks.length === 0 ? null : wrapSystemReminderBlocks(blocks);

      const diagnostic: SystemReminderDiagnostic | undefined = diagEnabled
        ? {
            fullText,
            criticalOnly,
            providers: providerDiagnostics,
            collectDurationMs: Math.round(collectDurationMs * 100) / 100,
            totalDurationMs: Math.round((performance.now() - totalStart) * 100) / 100,
          }
        : undefined;

      return { text: fullText ?? undefined, diagnostic };
    } catch (err) {
      this.logger.error(
        this.logCtx(),
        `Failed to build system reminder sessionId=${session.sessionId} err=${err instanceof Error ? err.message : String(err)}`,
      );
      return { text: undefined };
    }
  }

  /** Get the current turn count for a session (used by debug store). */
  getTurnCount(sessionId: string): number {
    return this.turnCounts.get(sessionId) ?? 0;
  }

  /** Clean up state when a session is removed. */
  onSessionRemoved(sessionId: string): void {
    this.turnCounts.delete(sessionId);
    this.memorySnapshots.delete(sessionId);
    this.lastSkillReminderAt.delete(sessionId);
    this.nextMemoryReminderAt.delete(sessionId);
    this.memoryReminderGap.delete(sessionId);
    this.nextSkillReminderAt.delete(sessionId);
    this.skillReminderGap.delete(sessionId);
    this.collector.onSessionRemoved(sessionId);
  }

  // ── Private helpers ──

  private incrementTurn(sessionId: string): number {
    const count = (this.turnCounts.get(sessionId) ?? 0) + 1;
    this.turnCounts.set(sessionId, count);
    boundMap(this.turnCounts);
    return count;
  }
}
