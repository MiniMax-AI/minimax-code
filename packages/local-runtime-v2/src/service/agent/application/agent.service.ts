import { clearRootSessionReference, setRootSessionReference } from './root-reference.js';
import {
  isTrustedBuiltinCreationSource,
  resolveCanonicalSubagentRole,
  toAgentRequestRef,
} from '@mavis/agent-tools/desktop/subagent-roles';
import type { PromptReadScope } from '@mavis/agent-runtime';

import {
  BuiltinAgentCatalog,
  canonicalBuiltinName,
  type BuiltinCatalogOptions,
} from '../builtin/catalog.js';
import { AgentServiceError } from '../errors.js';
import {
  collectAgentListCandidates,
  paginateSettledViews,
  readAgentViewReferences,
  toAgentView,
} from './listing/index.js';
import { readFrozenTaskOwner } from './frozen-task-owner.js';
import {
  asAgentConfigServiceError,
  createAgentPromptSelection,
  buildAgentGreetingReminder,
  readCanonicalAgentConfig,
  readCanonicalCustomAvatar,
  readBuiltinAgentContent,
  renderAgentProfile,
  renderFrozenAgentProfile,
  resolveAgentProfileRenderContext,
} from './agent-profile.js';
import {
  parseCanonicalAgentMarkdown,
  type CanonicalAgentConfig,
} from '../storage/canonical-agent-config.js';
import {
  rebuildBuiltinCanonicalFiles,
  reseedMissingBuiltinCanonicalFile,
  type BuiltinAgentConfigRepairReporter,
  type BuiltinModelGroup,
  type BuiltinModelGroupResolver,
} from './config/builtin-canonical-files.js';
import { AgentConfigDocuments } from './config/agent-config-documents.js';
import { toConfiguredModelSelection } from './config/config-document.js';
import {
  detachLegacyBuiltinIdentities,
  type LegacyIdentityDetachEvent,
} from './_migration-legacy-identity-detach.js';
import {
  inferNameResolutionSource,
  resolutionSourceFromError,
  resolveLocale,
  stableTelemetryValue,
  toCanonicalClass,
  toMemberCountBucket,
  toTelemetryErrorCode,
  withResolutionSource,
} from '../domain/validation.js';
import {
  LEGACY_PRIMARY_AGENT_NAME,
  PRIMARY_AGENT_NAME,
  buildAgentReadScope,
  builtinNameConflictError,
  canonicalAgentNotAvailableError,
  displayNameOrAgentName,
  isHarnessAgent,
  isReservedName,
  normalizeReservedDisplayName,
  normalizeRequestRef,
  notFound,
  parseExplicitName,
  parseExplicitNameOrStable,
  resolveActivePrimaryName,
  resolveCreatedAgentName,
  sameDisplayName,
  toAgentAssetsUpdate,
  toAgentInsert,
  validateCreateInput,
  validateLookupName,
  validateUpdateAgainstMeta,
  validateUpdateInput,
} from '../domain/names.js';
import {
  assertTrustedPrimaryFamily,
  isPrimaryFamilyName,
  legacyPrimaryWriteForbiddenError,
  planLegacyProfileOverlay,
  resolvePrimaryExecutionIdentity as resolvePrimaryExecutionIdentityPlan,
  toPrimaryFamilyMembers,
  type PrimaryExecutionIdentity,
} from '../domain/primary-identity.js';
import type {
  AgentConfigDocument,
  AgentConfigPutInput,
  AgentCreateInput,
  AgentExecutionProfile,
  AgentListOptions,
  AgentNameCompatIntent,
  AgentPrimaryProfileOverlayOutcome,
  AgentProfileRequest,
  AgentPromptMode,
  AgentReadScope,
  AgentStoreMeta,
  AgentStorePort,
  AgentUpdateInput,
  AgentView,
  BuiltinAgentDefinition,
  AgentSystemFactCallbacks,
  FrozenAgentExecutionDefinition,
} from '../contracts.js';
import {
  type LegacyCustomAgentMaterializationReporter,
  materializeLegacyCustomAgentRows,
} from './legacy-custom-materialization.js';
import { markAgentGreetingSent, readAgentGreetingState } from './greeting-state.js';
import { type PromptConfigService } from '../../prompt-config/index.js';

export type { LegacyCustomAgentMaterializationEvent } from './legacy-custom-materialization.js';
export interface LocalAgentServiceOptions extends BuiltinCatalogOptions {
  readonly promptMode?: AgentPromptMode;
  readonly promptVersion?: string;
  readonly repository: AgentStorePort;
  readonly nowMs?: () => number;
  readonly primaryAgentName?: string;
  readonly primaryDisplayName?: string;
  readonly facts?: AgentSystemFactCallbacks;
  /** Startup identity-detach sink; the runtime binds it to its own logger. */
  readonly reportIdentityDetach?: (event: LegacyIdentityDetachEvent) => void;
  /** Startup migration sink; failures are deferred without exposing profile content. */
  readonly reportLegacyCustomMaterialization?: LegacyCustomAgentMaterializationReporter;
  /** Startup Builtin source repair sink; the Agent composition binds it to the runtime logger. */
  readonly reportBuiltinConfigRepair?: BuiltinAgentConfigRepairReporter;
  readonly promptConfig?: PromptContextSource;
}

export type PromptContextSource = Pick<PromptConfigService, 'capture' | 'captureBuiltin'>;
export class LocalAgentService extends AgentConfigDocuments {
  private readonly nowMs: () => number;
  private readonly primaryAgentName: string;
  private readonly primaryDisplayName: string | undefined;
  protected readonly catalog: BuiltinAgentCatalog;
  private promptConfig: PromptContextSource | undefined;
  private readonly selectPrompt: (input: AgentProfileRequest) => AgentProfileRequest;
  private readonly roleObservationKeys = new Set<string>();
  private legacyIdentityDetachPromise: Promise<void> | undefined;
  private builtinModelGroupResolver: BuiltinModelGroupResolver | undefined;
  private bundledBuiltinModelGroup: BuiltinModelGroup | undefined;

  constructor(protected readonly options: LocalAgentServiceOptions) {
    super();
    this.nowMs = options.nowMs ?? Date.now;
    this.primaryAgentName = options.primaryAgentName?.trim() || PRIMARY_AGENT_NAME;
    this.primaryDisplayName = options.primaryDisplayName?.trim() || undefined;
    this.selectPrompt = createAgentPromptSelection(options);
    this.catalog = new BuiltinAgentCatalog({
      ...options,
      freezeLocalPrompts: options.promptMode !== undefined || options.freezeLocalPrompts,
    });
    this.promptConfig = options.promptConfig;
  }

  protected override withConfigDocumentWriteLock<T>(
    meta: AgentStoreMeta,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.isBuiltin(meta) ? operation() : this.withDisplayNameLock(operation);
  }

  protected override async validateConfigDocumentWrite(input: {
    readonly meta: AgentStoreMeta;
    readonly current: AgentConfigDocument;
    readonly request: AgentConfigPutInput;
  }): Promise<void> {
    // Parse once, before any early return. The model gate below applies to
    // Builtin Agents too (a Builtin Config PUT is *only* allowed to change the
    // model, so it is the one thing that must be validated), and it must also
    // run when the display name is unchanged — both used to `return` first.
    let candidate: CanonicalAgentConfig;
    try {
      candidate = parseCanonicalAgentMarkdown(input.request.content, input.meta.name);
    } catch (error) {
      throw asAgentConfigServiceError(error);
    }
    await this.assertCandidateModelIsUsable({
      exactOwnerName: input.meta.name,
      configuredModelSelection: toConfiguredModelSelection(candidate),
    });
    if (this.isBuiltin(input.meta)) return;
    const nextDisplayName = candidate.xMavis?.displayName ?? input.meta.name;
    const currentDisplayName = input.current.configured.mavis?.displayName ?? input.meta.name;
    if (sameDisplayName(currentDisplayName, nextDisplayName)) return;
    await this.assertDisplayNameIsAvailable(nextDisplayName, input.meta.name);
  }

  bindPromptConfig(promptConfig: PromptContextSource): void {
    this.promptConfig = promptConfig;
  }

  /** Binds the ready Desktop Model System for the next Builtin rebuild. */
  bindBuiltinModelGroupResolver(
    resolver: BuiltinModelGroupResolver,
    bundled?: BuiltinModelGroup,
  ): void {
    this.builtinModelGroupResolver = resolver;
    this.bundledBuiltinModelGroup = bundled;
  }

  async list(options: AgentListOptions = {}): Promise<readonly AgentView[]> {
    // Apply pagination after canonical/legacy collapsing. Passing offset/limit
    // to the storage adapter first could hide the canonical owner behind an
    // alias and make the V2 list unstable across the migration boundary.
    const metas = (
      await this.options.repository.list(
        options.search === undefined ? undefined : { search: options.search },
      )
    ).filter((meta) => !isHarnessAgent(meta));
    const candidates = collectAgentListCandidates(
      await this.listBuiltinDefinitions(),
      metas,
      options,
    );

    const limit = options.limit === undefined ? undefined : Math.max(0, options.limit);
    if (limit === 0) return [];

    const details = await Promise.allSettled(
      candidates.map((candidate) =>
        this.toView(
          candidate.meta,
          candidate.canonicalViewName,
          candidate.exactOwnerName,
          candidate.definition,
        ),
      ),
    );
    return paginateSettledViews(details, options.offset, limit);
  }

  async get(
    requestRef: string,
    options: { readonly includeContent?: boolean } = {},
  ): Promise<AgentView & { readonly persona?: string; readonly systemPrompt?: string }> {
    const scope = await this.resolveAgentReadScope(requestRef);
    const executionTarget = await this.resolveAgentExecutionTargetRaw(scope.exactOwnerName);
    const ownerMeta = await this.requireMeta(scope.exactOwnerName);
    // Bare canonical/legacy reads project onto the canonical persisted row.
    // Explicit `agent:<name>` keeps the exact custom owner, even when its name
    // resembles a retired alias.
    const canonicalMeta =
      scope.exactOwnerName !== scope.canonicalName
        ? await this.options.repository.get(scope.canonicalName)
        : ownerMeta;
    const meta = canonicalMeta ?? ownerMeta;
    const executionMeta = (await this.options.repository.get(executionTarget)) ?? meta;
    const definition = this.isBuiltin(executionMeta)
      ? await this.definitionFor(scope.canonicalName)
      : undefined;
    const view = await this.toView(meta, scope.canonicalName, scope.exactOwnerName, definition);
    if (!options.includeContent) return view;
    if (definition) {
      return readBuiltinAgentContent(this.catalog, view, scope.canonicalName, definition);
    }
    const canonical = await readCanonicalAgentConfig(this.options.repository, meta.name);
    return {
      ...view,
      ...(canonical.systemPrompt.length > 0 ? { systemPrompt: canonical.systemPrompt } : {}),
    };
  }

  async readCustomAvatar(requestRef: string) {
    const scope = await this.resolveAgentReadScope(requestRef);
    const meta = await this.requireMeta(scope.exactOwnerName);
    if (this.isBuiltin(meta)) return undefined;
    return readCanonicalCustomAvatar(this.options.repository, meta.name);
  }

  async create(input: AgentCreateInput): Promise<AgentView> {
    // The route-level name identifies the new owner. A complete definition may
    // carry a presentation name, but never chooses a different durable owner.
    const name = resolveCreatedAgentName(input.name);
    validateCreateInput(input, name);
    const now = input.nowMs ?? this.nowMs();
    const insert = toAgentInsert(input, name, now);
    try {
      await this.withDisplayNameLock(async () => {
        const existing = await this.options.repository.get(name);
        if (existing) {
          if (await this.options.repository.reconcileCanonicalCustomAgent?.(insert)) return;
          throw new AgentServiceError('AGENT_NAME_CONFLICT', `Agent name "${name}" already exists`);
        }
        await this.assertDisplayNameIsAvailable(insert.displayName ?? name);
        await this.options.repository.insert(insert);
      });
    } catch (error) {
      throw asAgentConfigServiceError(error);
    }
    return this.get(name);
  }

  async update(input: AgentUpdateInput): Promise<AgentView> {
    validateUpdateInput(input);
    const requestRef = normalizeRequestRef(input.requestRef);
    const exactOwnerName =
      parseExplicitName(requestRef) === undefined && this.isBarePrimaryAlias(requestRef)
        ? await this.resolveAgentWriteTarget(requestRef)
        : await this.requireExactAgentKey(requestRef);
    await this.assertLegacyPrimaryWriteAllowed(exactOwnerName);
    const meta = await this.requireMeta(exactOwnerName);
    validateUpdateAgainstMeta(input, {
      builtin: this.isBuiltin(meta),
      primary: this.isPrimary(meta),
      primaryDisplayName: this.primaryDisplayName,
    });
    // An identity patch is still an Agent write, so the "a persisted Agent is
    // runnable" invariant applies here too: without this, renaming through the
    // API bypasses the Config PUT model gate.
    //
    // Builtin is exempt on purpose, and not for convenience: a Builtin
    // identity update cannot change the model (a Builtin Config PUT is the only
    // way, and that path is gated), and its canonical source is the managed
    // `.builtin` mirror, which `getCanonicalConfig` does not read — calling it
    // for a Builtin would fail with AGENT_CONFIG_NOT_FOUND rather than validate
    // anything.
    if (!this.isBuiltin(meta)) {
      await this.assertPersistedModelIsUsable(exactOwnerName);
    }
    const now = input.nowMs ?? this.nowMs();
    try {
      const write = async () => {
        await this.options.repository.updateAssets(toAgentAssetsUpdate(input, meta.name, now));
        await this.options.repository.update(meta.name, { updatedAtMs: now });
      };
      if (input.displayName !== undefined && !this.isBuiltin(meta)) {
        await this.withDisplayNameLock(async () => {
          await this.assertDisplayNameUpdateIsAvailable(meta, input.displayName ?? null);
          await write();
        });
      } else {
        await write();
      }
    } catch (error) {
      throw asAgentConfigServiceError(error);
    }
    return this.get(toAgentRequestRef({ name: exactOwnerName }) ?? exactOwnerName);
  }

  async delete(requestRef: string): Promise<void> {
    const exactOwnerName = await this.requireExactAgentKey(requestRef);
    const meta = await this.requireMeta(exactOwnerName);
    if (this.isBuiltin(meta)) {
      throw new AgentServiceError(
        'BUILTIN_AGENT_DELETE_FORBIDDEN',
        'Built-in Agents cannot be deleted.',
      );
    }
    await this.options.repository.delete(meta.name);
  }

  async getLegacyHistoryNotice(requestRef: string): Promise<string | undefined> {
    const exactOwnerName = await this.requireExactAgentKey(requestRef);
    return this.options.repository.getLegacyHistoryNotice?.(exactOwnerName);
  }

  async setRootSession(requestRef: string, sessionId: string): Promise<boolean> {
    if (!sessionId.trim()) {
      throw new AgentServiceError('AGENT_REQUEST_REF_INVALID', 'Session id is required.');
    }
    const normalized = normalizeRequestRef(requestRef);
    const exactOwnerName =
      parseExplicitName(normalized) === undefined && this.isBarePrimaryAlias(normalized)
        ? await this.resolveAgentWriteTarget(normalized)
        : await this.requireExactAgentKey(normalized);
    return this.setRootSessionByExactOwner(exactOwnerName, sessionId);
  }

  private isBarePrimaryAlias(requestRef: string): boolean {
    return isPrimaryFamilyName(requestRef.toLowerCase(), this.primaryAgentName);
  }

  async listLegacyPinnedAgentRefs(): Promise<readonly { id: string; pinnedAt: number | null }[]> {
    const metas = await this.options.repository.list({});
    return metas
      .filter(
        (meta) => meta.pinned === true && canonicalBuiltinName(meta.name) !== this.primaryAgentName,
      )
      .map((meta) => ({ id: meta.name, pinnedAt: meta.pinnedAtMs ?? null }))
      .sort(
        (left, right) =>
          (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0) || left.id.localeCompare(right.id),
      );
  }

  async getPersistedOwner(exactOwnerName: string): Promise<AgentView | undefined> {
    const exact = validateLookupName(exactOwnerName);
    const meta = await this.options.repository.get(exact);
    if (!meta) return undefined;
    const canonicalViewName = canonicalBuiltinName(meta.name);
    const definition = this.isBuiltin(meta)
      ? await this.definitionFor(canonicalViewName)
      : undefined;
    return this.toView(meta, canonicalViewName, meta.name, definition);
  }

  async getPersistedOwnerForFrozenTask(exactOwnerName: string): Promise<AgentView | undefined> {
    return readFrozenTaskOwner(this.options.repository, exactOwnerName, async (meta, canonical) =>
      this.toView(meta, canonical, meta.name, await this.definitionFor(canonical)),
    );
  }

  /** Resolves only the persisted primary-family execution owner. */
  async resolvePrimaryExecutionIdentity(
    storageOwnerName: string,
  ): Promise<PrimaryExecutionIdentity | undefined> {
    const exact = parseExplicitNameOrStable(storageOwnerName);
    if (!isPrimaryFamilyName(exact, this.primaryAgentName)) return undefined;
    const metas = await this.options.repository.list();
    return resolvePrimaryExecutionIdentityPlan({
      storageOwnerName: exact,
      primaryAgentName: this.primaryAgentName,
      members: this.primaryFamilyMembers(metas),
    });
  }

  private primaryFamilyMembers(metas: readonly AgentStoreMeta[]) {
    return toPrimaryFamilyMembers(metas, this.primaryAgentName, (meta) => this.isBuiltin(meta));
  }

  /**
   * Read-only configured default (primary) Agent name. Exposed so callers that
   * must reach the product default — e.g. the deleted-Agent conversation
   * fallback — start from the same configured value instead of a compile-time
   * constant, and can then still resolve it through
   * `resolvePrimaryExecutionIdentity` for alias and conflict handling.
   */
  get defaultExecutionAgentName(): string {
    return this.primaryAgentName;
  }

  /**
   * `agent:main` stays available for internal recovery reads and exact channel
   * unbind, but must never create a second editable behaviour profile.
   */
  private async assertLegacyPrimaryWriteAllowed(exactName: string): Promise<void> {
    if (
      exactName === this.primaryAgentName ||
      !isPrimaryFamilyName(exactName, this.primaryAgentName)
    ) {
      return;
    }
    const members = this.primaryFamilyMembers(await this.options.repository.list());
    assertTrustedPrimaryFamily(members);
    if (!members.some((member) => member.name === this.primaryAgentName)) return;
    throw legacyPrimaryWriteForbiddenError(exactName, this.primaryAgentName);
  }

  async clearRootSessionByExactOwner(agentName: string, sessionId: string): Promise<boolean> {
    return clearRootSessionReference(this.options.repository, agentName, sessionId, this.nowMs());
  }

  async setRootSessionByExactOwner(agentName: string, sessionId: string): Promise<boolean> {
    return setRootSessionReference(this.options.repository, agentName, sessionId, this.nowMs());
  }

  async resolveAgentReadScope(requestRef: string): Promise<AgentReadScope> {
    try {
      const scope = await this.resolveAgentReadScopeRaw(requestRef);
      this.observeNameCompatResolve('read', requestRef, scope);
      return scope;
    } catch (error) {
      this.observeNameCompatResolve('read', requestRef, undefined, error);
      throw error;
    }
  }

  private async resolveAgentReadScopeRaw(requestRef: string): Promise<AgentReadScope> {
    const requested = normalizeRequestRef(requestRef);
    const metas = await this.options.repository.list();
    const explicitName = parseExplicitName(requested);
    if (explicitName !== undefined)
      return this.resolveExplicitReadScope(requested, explicitName, metas);

    const stableRequested = validateLookupName(requested);
    const primaryScope = this.resolvePrimaryReadScope(requested, stableRequested, metas);
    if (primaryScope) return primaryScope;

    const role = resolveCanonicalSubagentRole(stableRequested);
    if (role) return this.resolveRoleReadScope(stableRequested, role, metas);

    const exact = metas.find((meta) => meta.name === stableRequested);
    if (exact) return this.resolveExactReadScope(stableRequested, exact);

    const normalized = stableRequested.toLowerCase();
    const caseInsensitive = this.resolveCaseInsensitiveScope(stableRequested, normalized, metas);
    if (caseInsensitive) return caseInsensitive;
    return this.resolveDisplayNameScope(stableRequested, normalized, metas);
  }

  private resolveExplicitReadScope(
    requested: string,
    explicitName: string,
    metas: readonly AgentStoreMeta[],
  ): AgentReadScope {
    const exact = metas.find((meta) => meta.name === explicitName);
    if (!exact) throw notFound(explicitName);
    return buildAgentReadScope(this.primaryAgentName, {
      requestedName: requested,
      exactOwnerName: exact.name,
      canonicalName: exact.name,
      source: 'explicit_agent',
      exact: true,
      compatibleNames: [exact.name],
      ownerMeta: exact,
    });
  }

  private resolvePrimaryReadScope(
    requested: string,
    stableRequested: string,
    metas: readonly AgentStoreMeta[],
  ): AgentReadScope | undefined {
    if (
      stableRequested !== this.primaryAgentName &&
      stableRequested !== LEGACY_PRIMARY_AGENT_NAME
    ) {
      return undefined;
    }
    const active = resolveActivePrimaryName(metas, this.primaryAgentName);
    const activeMeta = metas.find((meta) => meta.name === active);
    // A reserved primary name held by a manual Agent is never projected onto
    // the family; the install fails closed instead of borrowing an identity.
    assertTrustedPrimaryFamily(this.primaryFamilyMembers(metas));
    // Once all persisted reserved rows have passed the trusted-family check,
    // both logical aliases stay readable. A historical channel/session record
    // may still be stored under `main` after V2 seeded only `mavis`; filtering
    // aliases by current Agent metadata makes that exact physical record
    // invisible to recovery and exact-unbind flows.
    const compatibleNames = [active, this.primaryAgentName, LEGACY_PRIMARY_AGENT_NAME].filter(
      (name, index, all) => all.indexOf(name) === index,
    );
    return buildAgentReadScope(this.primaryAgentName, {
      requestedName: requested,
      exactOwnerName: active,
      canonicalName: this.primaryAgentName,
      source: 'stable_name',
      exact: active === requested,
      compatibleNames,
      ownerMeta: activeMeta,
    });
  }

  private resolveRoleReadScope(
    stableRequested: string,
    role: string,
    metas: readonly AgentStoreMeta[],
  ): AgentReadScope {
    const canonicalMeta = metas.find((meta) => meta.name === role);
    if (canonicalMeta && !this.isBuiltin(canonicalMeta)) {
      throw builtinNameConflictError(stableRequested, role, canonicalMeta);
    }
    if (!canonicalMeta) throw notFound(stableRequested);
    return buildAgentReadScope(this.primaryAgentName, {
      requestedName: stableRequested,
      exactOwnerName: canonicalMeta.name,
      canonicalName: role,
      source: 'canonical_name',
      exact: stableRequested === role,
      compatibleNames: [canonicalMeta.name],
      ownerMeta: canonicalMeta,
    });
  }

  private resolveExactReadScope(stableRequested: string, exact: AgentStoreMeta): AgentReadScope {
    if (isReservedName(stableRequested) && !this.isBuiltin(exact)) {
      throw builtinNameConflictError(stableRequested, stableRequested, exact);
    }
    return buildAgentReadScope(this.primaryAgentName, {
      requestedName: stableRequested,
      exactOwnerName: exact.name,
      canonicalName: canonicalBuiltinName(exact.name),
      source: 'stable_name',
      exact: true,
      compatibleNames: [exact.name],
      ownerMeta: exact,
    });
  }

  private resolveCaseInsensitiveScope(
    stableRequested: string,
    normalized: string,
    metas: readonly AgentStoreMeta[],
  ): AgentReadScope | undefined {
    const candidates = metas.filter((meta) => meta.name.toLowerCase() === normalized);
    if (candidates.length > 1) {
      throw withResolutionSource(
        new AgentServiceError(
          'AMBIGUOUS_AGENT_NAME',
          `Agent name "${stableRequested}" is ambiguous; candidates: ${candidates
            .map((meta) => meta.name)
            .sort()
            .join(', ')}`,
          undefined,
          { candidates: candidates.map((meta) => meta.name).sort() },
        ),
        'stable_name',
      );
    }
    const candidate = candidates[0];
    return candidate
      ? buildAgentReadScope(this.primaryAgentName, {
          requestedName: stableRequested,
          exactOwnerName: candidate.name,
          canonicalName: canonicalBuiltinName(candidate.name),
          source: 'stable_name',
          exact: false,
          compatibleNames: [candidate.name],
          ownerMeta: candidate,
        })
      : undefined;
  }

  private async resolveDisplayNameScope(
    stableRequested: string,
    normalized: string,
    metas: readonly AgentStoreMeta[],
  ): Promise<AgentReadScope> {
    const matches: AgentStoreMeta[] = [];
    for (const meta of metas) {
      const displayName =
        meta.name === this.primaryAgentName
          ? this.primaryDisplayName
          : (await this.options.repository.getIdentity(meta.name))?.displayName;
      if (displayName === stableRequested || displayName?.toLowerCase() === normalized) {
        matches.push(meta);
      }
    }
    if (matches.length > 1) {
      throw withResolutionSource(
        new AgentServiceError(
          'AMBIGUOUS_AGENT_NAME',
          `Agent name "${stableRequested}" is ambiguous`,
          undefined,
          { candidates: matches.map((meta) => meta.name).sort() },
        ),
        'display_name_compat',
      );
    }
    const candidate = matches[0];
    if (!candidate) throw notFound(stableRequested);
    return buildAgentReadScope(this.primaryAgentName, {
      requestedName: stableRequested,
      exactOwnerName: candidate.name,
      canonicalName: canonicalBuiltinName(candidate.name),
      source: 'display_name_compat',
      exact: false,
      compatibleNames: [candidate.name],
      ownerMeta: candidate,
    });
  }

  async resolveAgentWriteTarget(requestRef: string): Promise<string> {
    let scope: AgentReadScope | undefined;
    try {
      const requested = normalizeRequestRef(requestRef);
      const explicitName = parseExplicitName(requested);
      if (explicitName !== undefined) await this.assertLegacyPrimaryWriteAllowed(explicitName);
      const stableRequested =
        explicitName === undefined ? validateLookupName(requested) : explicitName;
      const role =
        explicitName === undefined ? resolveCanonicalSubagentRole(stableRequested) : undefined;
      if (role) {
        const canonical = await this.options.repository.get(role);
        if (!canonical) throw canonicalAgentNotAvailableError(stableRequested, role);
        if (!this.isBuiltin(canonical)) {
          throw builtinNameConflictError(stableRequested, role, canonical);
        }
      }
      scope = await this.resolveAgentReadScopeRaw(requested);
      // A canonical Mavis view can still be backed by the pre-Session-V2
      // Main row. Only this trusted primary-family split writes to the winner;
      // every other resolver path preserves its established canonical target.
      const target =
        role ??
        (isPrimaryFamilyName(scope.canonicalName, this.primaryAgentName)
          ? scope.exactOwnerName
          : scope.canonicalName);
      this.observeNameCompatResolve('write', requestRef, scope);
      return target;
    } catch (error) {
      this.observeNameCompatResolve('write', requestRef, scope, error);
      throw error;
    }
  }

  async requireExactAgentKey(requestRef: string): Promise<string> {
    try {
      const exact = await this.requireExactAgentKeyRaw(requestRef);
      const meta = await this.options.repository.get(exact);
      this.observeNameCompatResolve(
        'exact',
        requestRef,
        buildAgentReadScope(this.primaryAgentName, {
          requestedName: requestRef,
          exactOwnerName: exact,
          canonicalName: exact,
          source: requestRef.trim().toLowerCase().startsWith('agent:')
            ? 'explicit_agent'
            : 'stable_name',
          exact: true,
          compatibleNames: [exact],
          ownerMeta: meta,
        }),
      );
      return exact;
    } catch (error) {
      this.observeNameCompatResolve('exact', requestRef, undefined, error);
      throw error;
    }
  }

  private async requireExactAgentKeyRaw(requestRef: string): Promise<string> {
    const exact = parseExplicitNameOrStable(requestRef);
    if (!(await this.options.repository.get(exact))) throw notFound(exact);
    return exact;
  }

  async resolveAgentExecutionTarget(exactOwnerName: string): Promise<string> {
    try {
      const exact = parseExplicitNameOrStable(exactOwnerName);
      const ownerMeta = await this.options.repository.get(exact);
      const resolvedAgentName = await this.resolveAgentExecutionTargetRaw(exact);
      this.observeNameCompatResolve(
        'execution',
        exactOwnerName,
        buildAgentReadScope(this.primaryAgentName, {
          requestedName: exactOwnerName,
          exactOwnerName: exact,
          canonicalName: resolvedAgentName,
          source: 'stable_name',
          exact: true,
          compatibleNames: [exact],
          ownerMeta,
        }),
      );
      return resolvedAgentName;
    } catch (error) {
      this.observeNameCompatResolve('execution', exactOwnerName, undefined, error);
      throw error;
    }
  }

  /**
   * Every persisted owner executes as itself. The guard only keeps an absent
   * owner whose name canonicalizes onto a reserved role from silently
   * executing a manual Agent that occupies that role name.
   */
  private async resolveAgentExecutionTargetRaw(exactOwnerName: string): Promise<string> {
    const exact = parseExplicitNameOrStable(exactOwnerName);
    const canonical = resolveCanonicalSubagentRole(exact) ?? exact;
    if (canonical === exact) return exact;
    if (await this.options.repository.get(exact)) return exact;
    const canonicalMeta = await this.options.repository.get(canonical);
    if (canonicalMeta && !this.isBuiltin(canonicalMeta)) {
      throw builtinNameConflictError(exact, canonical, canonicalMeta);
    }
    return exact;
  }

  frozenPromptSource() {
    return this.catalog.frozenPromptSource();
  }

  async renderProfile(input: AgentProfileRequest): Promise<AgentExecutionProfile> {
    return renderAgentProfile(
      this.profileRendererDependencies(),
      this.selectPrompt(input),
      this.promptConfig,
    );
  }

  private async resolveProfileRenderContext(input: AgentProfileRequest) {
    return resolveAgentProfileRenderContext(input, {
      repository: this.options.repository,
      requireMeta: (name) => this.requireMeta(name),
      resolveExecutionTarget: (name) => this.resolveAgentExecutionTargetRaw(name),
      definitionFor: (name) => this.definitionFor(name),
      isBuiltin: (meta) => this.isBuiltin(meta),
      resolveBuiltinReadAgentNames: (name) => this.resolveBuiltinReadAgentNames(name),
    });
  }

  /** Renders a Task snapshot without consulting the current Agent file. */
  async renderFrozenProfile(
    input: AgentProfileRequest,
    definition: FrozenAgentExecutionDefinition,
  ): Promise<AgentExecutionProfile> {
    return renderFrozenAgentProfile(
      this.profileRendererDependencies(),
      this.selectPrompt(input),
      definition,
    );
  }

  private profileRendererDependencies() {
    return {
      repository: this.options.repository,
      catalog: this.catalog,
      resolveContext: (input: AgentProfileRequest) => this.resolveProfileRenderContext(input),
      reseedMissingBuiltinConfig: (name: string) => this.reseedMissingBuiltinConfig(name),
    };
  }

  /** Same template and model group as the startup seed; see renderBuiltinProfile. */
  private async reseedMissingBuiltinConfig(name: string): Promise<void> {
    const definition = await this.definitionFor(name);
    if (!definition) return;
    await reseedMissingBuiltinCanonicalFile({ ...this.builtinSeedInput(), definition });
  }

  listBuiltinDefinitions(): Promise<readonly BuiltinAgentDefinition[]> {
    return this.catalog.listDefinitions();
  }

  async materializeLegacyCustomAgents(): Promise<{
    readonly materialized: number;
    readonly alreadyCanonical: number;
    readonly notLegacy: number;
    readonly invalid: number;
  }> {
    return materializeLegacyCustomAgentRows({
      repository: this.options.repository,
      report: this.options.reportLegacyCustomMaterialization,
      isBuiltin: (meta) => this.isBuiltin(meta),
    });
  }
  private withDisplayNameLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.options.repository.withDisplayNameLock(operation);
  }

  private async assertDisplayNameUpdateIsAvailable(
    meta: AgentStoreMeta,
    requestedDisplayName: string | null,
  ): Promise<void> {
    const currentIdentity = await this.options.repository.getIdentity(meta.name);
    const currentDisplayName = this.displayNameForMeta(meta, currentIdentity?.displayName);
    const nextDisplayName = displayNameOrAgentName(requestedDisplayName ?? undefined, meta.name);
    if (sameDisplayName(currentDisplayName, nextDisplayName)) return;
    await this.assertDisplayNameIsAvailable(nextDisplayName, meta.name);
  }

  private async assertDisplayNameIsAvailable(
    displayName: string,
    excludingAgentName?: string,
  ): Promise<void> {
    const normalizedReservedDisplayName = normalizeReservedDisplayName(displayName);
    const reservedDisplayNames = new Set(
      [
        PRIMARY_AGENT_NAME,
        LEGACY_PRIMARY_AGENT_NAME,
        this.primaryDisplayName,
        ...(await this.listBuiltinDefinitions()).flatMap((definition) => [
          definition.name,
          definition.identity.displayName,
        ]),
      ].flatMap((name) => (name === undefined ? [] : [normalizeReservedDisplayName(name)])),
    );
    if (reservedDisplayNames.has(normalizedReservedDisplayName)) {
      throw new AgentServiceError(
        'AGENT_ROLE_CONFLICT',
        `Agent display name "${displayName}" is reserved; use a different display name.`,
        409,
      );
    }

    const metas = await this.options.repository.list();
    for (const meta of metas) {
      if (meta.name === excludingAgentName || isHarnessAgent(meta)) continue;
      const identity = await this.options.repository.getIdentity(meta.name);
      const existingDisplayName = this.displayNameForMeta(meta, identity?.displayName);
      if (!sameDisplayName(existingDisplayName, displayName)) continue;
      throw new AgentServiceError(
        'AGENT_NAME_CONFLICT',
        `Agent display name "${displayName}" already exists.`,
      );
    }
  }

  async ensureBuiltinRows(
    options: { readonly nowMs?: number } = {},
  ): Promise<readonly AgentView[]> {
    await this.options.repository.normalizePrimaryFamilyRows();
    this.assertPrimaryFamilyTrusted(await this.options.repository.list());
    await this.detachLegacyBuiltinIdentities();
    const now = options.nowMs ?? this.nowMs();
    const definitions = await this.listBuiltinDefinitions();
    const metas = await this.options.repository.list();
    this.assertPrimaryFamilyTrusted(metas);
    const keepLegacyPrimaryPhysicalOwner = this.shouldKeepLegacyPrimaryPhysicalOwner(metas);
    for (const definition of definitions) {
      if (keepLegacyPrimaryPhysicalOwner && definition.name === this.primaryAgentName) continue;
      const direct = metas.find((meta) => meta.name === definition.name);
      if (direct && !this.isBuiltin(direct)) {
        throw builtinNameConflictError(definition.name, definition.name, direct);
      }
      if (direct) {
        if (direct.agentRole !== definition.role) {
          this.observeAgentRoleMismatch(direct.name, direct.agentRole, definition.role);
        }
        await this.options.repository.update(direct.name, {
          agentRole: definition.role,
          creationSource: 'builtin',
          updatedAtMs: now,
        });
        continue;
      }
      await this.insertBuiltinDefinition(definition, now);
    }
    await this.convergeLegacyPrimaryProfile(definitions, now);
    await this.rebuildBuiltinDefinitions(definitions);
    return this.list();
  }

  private rebuildBuiltinDefinitions(definitions: readonly BuiltinAgentDefinition[]): Promise<void> {
    return rebuildBuiltinCanonicalFiles({ ...this.builtinSeedInput(), definitions });
  }

  private builtinSeedInput() {
    return {
      repository: this.options.repository,
      catalog: this.catalog,
      ...(this.builtinModelGroupResolver
        ? { modelGroupResolver: this.builtinModelGroupResolver }
        : {}),
      ...(this.bundledBuiltinModelGroup
        ? { bundledModelGroup: this.bundledBuiltinModelGroup }
        : {}),
      ...(this.options.reportBuiltinConfigRepair
        ? { report: this.options.reportBuiltinConfigRepair }
        : {}),
    };
  }

  private async insertBuiltinDefinition(
    definition: BuiltinAgentDefinition,
    now: number,
  ): Promise<void> {
    // Detached historic Agents keep their own rows, Sessions and definitions.
    // Any row seeded here starts independently, with no Session.
    await this.options.repository.insert({
      name: definition.name,
      agentRole: definition.role,
      creationSource: 'builtin',
      displayName: definition.identity.displayName ?? definition.name,
      ...(definition.identity.description ? { description: definition.identity.description } : {}),
      ...(definition.identity.avatar ? { avatar: definition.identity.avatar } : {}),
      createdAtMs: now,
      updatedAtMs: now,
    });
  }

  private assertPrimaryFamilyTrusted(metas: readonly AgentStoreMeta[]): void {
    assertTrustedPrimaryFamily(this.primaryFamilyMembers(metas));
  }

  private shouldKeepLegacyPrimaryPhysicalOwner(metas: readonly AgentStoreMeta[]): boolean {
    if (this.primaryAgentName === LEGACY_PRIMARY_AGENT_NAME) return false;
    const members = this.primaryFamilyMembers(metas);
    return (
      !members.some((member) => member.name === this.primaryAgentName) &&
      members.some((member) => member.name === LEGACY_PRIMARY_AGENT_NAME)
    );
  }

  private detachLegacyBuiltinIdentities(): Promise<void> {
    this.legacyIdentityDetachPromise ??= detachLegacyBuiltinIdentities({
      repository: this.options.repository,
      catalog: this.catalog,
      locale: resolveLocale(),
      ...(this.options.reportIdentityDetach ? { report: this.options.reportIdentityDetach } : {}),
    });
    return this.legacyIdentityDetachPromise;
  }

  /**
   * Single idempotent overlay pass, run right after the canonical seed and
   * before `mavis` first becomes execution owner. Persona / system prompt keep
   * using the Mavis builtin package and Owner / ACL are out of scope.
   */
  private async convergeLegacyPrimaryProfile(
    definitions: readonly BuiltinAgentDefinition[],
    nowMs: number,
  ): Promise<void> {
    const displayNameLocked = this.primaryDisplayName !== undefined;
    // Standalone V1 compatibility: `main` IS the primary, so there is no
    // canonical row to overlay onto and the legacy row keeps its own profile.
    if (this.primaryAgentName === LEGACY_PRIMARY_AGENT_NAME) {
      this.reportPrimaryProfileOverlay('skipped_no_canonical_primary', [], displayNameLocked);
      return;
    }
    const members = this.primaryFamilyMembers(await this.options.repository.list());
    assertTrustedPrimaryFamily(members);
    const present = new Set(members.map((member) => member.name));
    // A fresh install (no `main`) or a pre-seed call (no `mavis`) has nothing
    // to converge. Reported so it is distinguishable from "converged to zero
    // fields" below.
    if (!present.has(this.primaryAgentName) || !present.has(LEGACY_PRIMARY_AGENT_NAME)) {
      this.reportPrimaryProfileOverlay('skipped_family_incomplete', [], displayNameLocked);
      return;
    }
    const [canonicalIdentity, canonicalConfig, legacyIdentity, legacyConfig] = await Promise.all([
      this.options.repository.getIdentity(this.primaryAgentName),
      this.options.repository.getConfig(this.primaryAgentName),
      this.options.repository.getIdentity(LEGACY_PRIMARY_AGENT_NAME),
      this.options.repository.getConfig(LEGACY_PRIMARY_AGENT_NAME),
    ]);
    const plan = planLegacyProfileOverlay({
      canonicalIdentity,
      canonicalConfig,
      legacyIdentity,
      legacyConfig,
      seedIdentity:
        definitions.find((definition) => definition.name === this.primaryAgentName)?.identity ?? {},
      primaryDisplayNameLocked: displayNameLocked,
    });
    // Expected on every boot after the first: the canonical row already won,
    // or the legacy row never had a non-default value worth adopting.
    if (!plan) {
      this.reportPrimaryProfileOverlay('no_op', [], displayNameLocked);
      return;
    }
    await this.options.repository.updateAssets({
      name: this.primaryAgentName,
      ...plan,
      updatedAtMs: nowMs,
    });
    this.reportPrimaryProfileOverlay('applied', Object.keys(plan), displayNameLocked);
  }

  /** Bounded overlay fact: outcome + adopted field names, never field values. */
  private reportPrimaryProfileOverlay(
    outcome: AgentPrimaryProfileOverlayOutcome,
    adoptedFields: readonly string[],
    displayNameLocked: boolean,
  ): void {
    this.options.facts?.onPrimaryProfileOverlay?.({
      outcome,
      adoptedFields,
      displayNameLocked,
    });
  }

  async getGreetingState(
    exactOwnerName: string,
  ): Promise<{ readonly greetingSent: boolean; readonly rootSessionId?: string } | undefined> {
    return readAgentGreetingState(this.options.repository, exactOwnerName);
  }

  async markGreetingSent(exactOwnerName: string): Promise<boolean> {
    return markAgentGreetingSent(this.options.repository, exactOwnerName, this.nowMs());
  }

  async buildGreetingReminder(
    exactOwnerName: string,
    promptRead?: PromptReadScope,
  ): Promise<string> {
    return buildAgentGreetingReminder(
      {
        readView: () =>
          this.get(`agent:${validateLookupName(exactOwnerName)}`, { includeContent: true }),
        renderProfile: (promptReadContext) =>
          this.renderProfile({
            exactOwnerName,
            surface: 'interactive',
            appMode: 'coding',
            promptChannel: 'online',
            ...(promptReadContext === undefined ? {} : { promptReadContext }),
          }),
        catalog: this.catalog,
        ...(this.promptConfig ? { promptConfig: this.promptConfig } : {}),
      },
      promptRead,
    );
  }

  close(): void {
    this.options.repository.close?.();
  }

  protected async definitionFor(name: string): Promise<BuiltinAgentDefinition | undefined> {
    const definitions = await this.listBuiltinDefinitions();
    return definitions.find((definition) => definition.name === canonicalBuiltinName(name));
  }

  private async resolveBuiltinReadAgentNames(
    canonicalViewName: string,
  ): Promise<readonly string[]> {
    const scope = await this.resolveAgentReadScopeRaw(canonicalViewName);
    return Object.freeze(
      [canonicalViewName, ...scope.compatibleNames].filter(
        (name, index, names) => name.length > 0 && names.indexOf(name) === index,
      ),
    );
  }

  protected async requireMeta(name: string): Promise<AgentStoreMeta> {
    let meta: AgentStoreMeta | undefined;
    try {
      meta = await this.options.repository.get(name);
    } catch (error) {
      throw asAgentConfigServiceError(error);
    }
    if (!meta) throw notFound(name);
    return meta;
  }

  private observeNameCompatResolve(
    intent: AgentNameCompatIntent,
    requestedName: string,
    scope?: Pick<AgentReadScope, 'canonicalName' | 'compatibleNames' | 'source' | 'trustedBuiltin'>,
    error?: unknown,
  ): void {
    const callback = this.options.facts?.onNameCompatResolve;
    if (!callback) return;
    const source =
      scope?.source ??
      resolutionSourceFromError(error) ??
      inferNameResolutionSource(requestedName, scope?.canonicalName);
    const memberCountBucket = toMemberCountBucket(scope?.compatibleNames.length);
    const errorCode = toTelemetryErrorCode(error);
    try {
      callback({
        intent,
        canonicalClass: toCanonicalClass(
          scope?.canonicalName ?? requestedName,
          source,
          scope?.trustedBuiltin,
        ),
        source,
        success: error === undefined,
        ...(memberCountBucket ? { memberCountBucket } : {}),
        ...(errorCode ? { errorCode } : {}),
      });
    } catch {
      // Observability must never change an Agent resolution result.
    }
  }

  private observeAgentRoleMismatch(
    agentName: string,
    actualRole: unknown,
    expectedRole: string,
  ): void {
    const callback = this.options.facts?.onAgentRoleObservation;
    if (!callback) return;
    const key = `${agentName}:${stableTelemetryValue(actualRole)}`;
    if (this.roleObservationKeys.has(key)) return;
    this.roleObservationKeys.add(key);
    try {
      callback({
        status: 'unsupported',
        source: 'builtin_seed',
        role: expectedRole,
      });
    } catch {
      // Observability must never change built-in repair/seeding behavior.
    }
  }

  private async toView(
    meta: AgentStoreMeta,
    canonicalViewName: string,
    exactOwnerName: string,
    definition?: BuiltinAgentDefinition,
  ): Promise<AgentView> {
    const canonical = this.isBuiltin(meta)
      ? canonicalBuiltinName(canonicalViewName)
      : canonicalViewName;
    const { identity, config, canonicalOwner } = await readAgentViewReferences(
      this.options.repository,
      meta,
      canonical,
      exactOwnerName,
    );
    const resolvedAgentName =
      canonicalOwner && this.isBuiltin(canonicalOwner) ? canonical : exactOwnerName;
    return toAgentView({
      meta,
      canonical,
      exactOwnerName,
      resolvedAgentName,
      identity,
      config,
      definition,
      builtin: this.isBuiltin(meta),
      primary: this.isPrimary(meta),
      primaryDisplayName: this.primaryDisplayName,
      agentConfigDir: this.options.repository.getAgentDir(meta.name),
    });
  }

  protected isBuiltin(meta: AgentStoreMeta): boolean {
    return isTrustedBuiltinCreationSource(meta.creationSource);
  }

  private isPrimary(meta: AgentStoreMeta): boolean {
    return this.isBuiltin(meta) && canonicalBuiltinName(meta.name) === this.primaryAgentName;
  }

  private displayNameForMeta(meta: AgentStoreMeta, displayName: string | undefined): string {
    return this.isPrimary(meta) && this.primaryDisplayName
      ? this.primaryDisplayName
      : displayNameOrAgentName(displayName, meta.name);
  }
}
