// Local skill domain application service. Single business entry point for skill
// capabilities consumed by both the DesktopService thrift adapter and runtime
// callers (turn agent config, native skill tool). It accepts runtime/domain
// DTOs — never thrift-gen request/response envelopes — and signals failures with
// sentinels (`undefined` / `'protected'`) or the hub's own
// `LocalSkillHubInstallError`; it never throws HTTP/contract errors. Contract
// DTO conversion and HTTP error mapping stay in the thrift adapter
// (`http/desktop-skill-service.ts`); see
// `.harness/docs/adr/desktop-service-ownership.md`.
//
// The skill domain owns its registry provider; callers supply config + optional roots.
// DesktopService pulls it through the process-scoped `getSkillService()` accessor.
import type { SkillSourceRoot } from '@mavis/skills';
import type { SkillFileInfo, SkillInfo } from '@mavis/protocol/local';

import type { LocalRuntimeConfig } from '../config/types.js';
import type { MetricsClient } from '../common/metrics.js';
import type { SubagentTelemetryHost } from '../agent/subagent-telemetry.js';
import { type ContentSafetyChecker } from '../content-safety/api.js';
import { configReviewBlocks } from '../content-safety/config-fields.js';
import { createLocalSkill, type LocalSkillCreateResult } from './api.js';
import type { LocalSkillsCatalogEntry } from './catalog.js';
import type {
  LocalSkillHubListItem,
  LocalSkillHubStore,
  LocalSkillPreviewResp,
} from './hub-api.js';
import {
  createLocalSkillRegistryProvider,
  type LocalRegistrySkillReadResult,
  type LocalSkillFileRequestInput,
  type LocalSkillListInput,
  type LocalSkillRequestInput,
  type LocalSkillRegistryDiagnosticSink,
  type LocalSkillEnabledStatePort,
} from './registry.js';
import { toNormalizedSkillSelectorSet } from './registry-family.js';
import {
  createCatalogDiagnostics,
  createRuntimeSkillBetaFlags,
  requireSkillHub,
} from './skill-service-support.js';

export interface LocalSkillServiceDeps {
  configGetter: () => LocalRuntimeConfig;
  /** Optional fixed registry roots; when omitted, roots derive from config. */
  skillRegistryRoots?: SkillSourceRoot[];
  /** Agent read-through is resolved by the owning Agent runtime port. */
  resolveAgentReadScope?: (requestedName: string) => Promise<{
    canonicalName: string;
    compatibleNames?: readonly string[];
  }>;
  /** New skill writes always use the canonical stable agent key. */
  resolveAgentWriteTarget?: (requestedName: string) => Promise<string>;
  skillHubStore?: LocalSkillHubStore;
  /**
   * Content-safety gate for user-authored skill writes (name / description /
   * content). When present, createSkill reviews each field at
   * `SAFETY_SCENE.ConfigField` before persisting. Optional: omitted in
   * dev / tests short-circuits to a no-op, matching the agent config gate.
   */
  reviewContent?: ContentSafetyChecker;
  /** Optional sink for `skill_load_total`; absent = noop. */
  metricsClient?: MetricsClient;
  /** Bounded local-runtime telemetry for legacy resource ambiguity. */
  resourceAmbiguityTelemetry?: SubagentTelemetryHost;
  /** Low-volume, fail-open registry LRU-close diagnostics. */
  registryDiagnostics?: LocalSkillRegistryDiagnosticSink;
  readMcpServerNames?: () => Promise<Set<string>>;
  /** Owner-injected persisted enabled state; V1 discovery never sees a preference key. */
  enabledState?: LocalSkillEnabledStatePort;
}

/** Resolved runtime skill scope. Session → scope resolution stays in the
 *  DesktopService boundary; the skill domain never sees session records. */
export interface LocalRuntimeSkillScope {
  /** Exclude private roots when the frozen owner incarnation cannot be verified. */
  excludeAgentResources?: boolean;
  expectedAgentInstanceId?: string;
  /** Frozen configuration is authoritative even while optional same-instance resources exist. */
  skipAgentResolution?: boolean;
  agentName?: string;
  workspaceDir?: string;
  /** Undefined keeps every Builtin Skill; [] selects none. Extension skills are unaffected. */
  builtinSkillNames?: readonly string[];
  /** Agent canonical selector for every discovered standalone Skill; undefined inherits, [] closes it. */
  allowedSkillNames?: readonly string[];
  /** Agent canonical selector for extension standalone Skills. */
  allowedExtensionSkillNames?: readonly string[];
  /** Turn snapshot; when present, overrides the configured CU availability flag. */
  cuModeActive?: boolean;
}

export interface LocalSkillCatalogScope extends LocalRuntimeSkillScope {
  firstTurnSessionId?: string;
  contextWindowTokens?: number;
  additionalSkills?: readonly LocalSkillsCatalogEntry[];
}

export interface LocalSkillCreateInput {
  name: string;
  description: string;
  content: string;
  agentName?: string;
}

export interface LocalSkillHubListInput {
  keyword?: string;
  limit?: number;
  cursor?: string;
  sourceType?: number | string;
  sortType?: number | string;
}

export interface LocalSkillInstallInput {
  url?: string;
  agentName?: string;
  isFromGit?: boolean;
  displayName?: string;
  creatorInfo?: unknown;
  publisherSourceType?: number;
}

interface LocalSkillReadScope {
  canonicalName: string;
  compatibleNames: readonly string[];
}

export interface LocalSkillService {
  listSkills(input: LocalSkillListInput): Promise<{
    skills: SkillInfo[];
    hasMore: boolean;
    nextCursor?: string;
  }>;
  listRuntimeSkills(scope?: LocalRuntimeSkillScope): Promise<{
    skills: SkillInfo[];
    refreshedAt: number;
  }>;
  renderCatalog(scope?: LocalSkillCatalogScope): Promise<string>;
  readSkillByName(
    name: string,
    scope?: LocalRuntimeSkillScope,
  ): Promise<LocalRegistrySkillReadResult | undefined>;
  getSkill(
    input: LocalSkillRequestInput,
    options?: { includeBody?: boolean },
  ): Promise<{ skill: SkillInfo; content?: string } | undefined>;
  listSkillFiles(input: LocalSkillRequestInput): Promise<SkillFileInfo[] | undefined>;
  readSkillFile(input: LocalSkillFileRequestInput): Promise<string | undefined>;
  createSkill(input: LocalSkillCreateInput): Promise<LocalSkillCreateResult>;
  deleteSkill(
    input: LocalSkillRequestInput,
  ): Promise<{ ok: true; name: string } | 'protected' | undefined>;
  setSkillEnabled(
    input: LocalSkillRequestInput,
    enabled: boolean,
  ): Promise<{ ok: true; name: string; enabled: boolean } | undefined>;
  listSkillHub(input: LocalSkillHubListInput): Promise<{
    skills: LocalSkillHubListItem[];
    hasMore: boolean;
    nextCursor: string;
  }>;
  installSkill(input: LocalSkillInstallInput): Promise<{ ok: unknown; skill: unknown }>;
  previewSkill(input: { url: string; ref?: string }): Promise<LocalSkillPreviewResp>;
  /**
   * Registers a synchronous invalidation listener for consumers that derive
   * turn capability reservations from the standalone Skill registry.
   */
  onDidChangeRuntimeSkills?(listener: () => void): () => void;
}

function createLocalSkillService(deps: LocalSkillServiceDeps): LocalSkillService {
  const runtimeSkillChangeListeners = new Set<() => void>();
  const notifyRuntimeSkillsChanged = () => {
    for (const listener of runtimeSkillChangeListeners) listener();
  };
  const registryProvider = createLocalSkillRegistryProvider(
    deps.configGetter,
    deps.skillRegistryRoots === undefined ? undefined : () => deps.skillRegistryRoots ?? [],
    deps.registryDiagnostics,
    deps.enabledState,
    deps.readMcpServerNames,
  );
  const resolveReadScope = async (
    requestedName: string | undefined,
    skipAgentResolution = false,
  ): Promise<LocalSkillReadScope> => {
    const requested = normalizeAgentName(requestedName);
    if (skipAgentResolution || !deps.resolveAgentReadScope) {
      return { canonicalName: requested, compatibleNames: [requested] };
    }
    const resolved = await deps.resolveAgentReadScope(requested);
    const canonicalName = resolved.canonicalName.trim() || requested;
    const compatibleNames = [canonicalName, ...(resolved.compatibleNames ?? [])].filter(
      (name, index, names): name is string =>
        name.trim().length > 0 &&
        names.findIndex((candidate) => candidate.trim() === name.trim()) === index,
    );
    return { canonicalName, compatibleNames };
  };
  const resolveWriteTarget = async (
    requestedName: string | undefined,
  ): Promise<string | undefined> => {
    if (!requestedName) return undefined;
    const requested = normalizeAgentName(requestedName);
    return (await deps.resolveAgentWriteTarget?.(requested))?.trim() || requested;
  };
  const resolveRequestScope = async <T extends LocalSkillRequestInput>(input: T): Promise<T> => {
    // A physical location is already an exact identity. Do not infer an agent
    // from it (or reassign it to the default agent) when the caller omitted one.
    if (input.locationUri && !input.agentName) {
      return {
        ...input,
        ...(deps.resourceAmbiguityTelemetry
          ? { resourceAmbiguityTelemetry: deps.resourceAmbiguityTelemetry }
          : {}),
      };
    }
    const readScope = await resolveReadScope(
      input.agentName,
      input.excludeAgentResources || Boolean(input.expectedAgentInstanceId),
    );
    return {
      ...input,
      agentName: readScope.canonicalName,
      ...(deps.resolveAgentReadScope ? { compatibleAgentNames: readScope.compatibleNames } : {}),
      ...(deps.resourceAmbiguityTelemetry
        ? { resourceAmbiguityTelemetry: deps.resourceAmbiguityTelemetry }
        : {}),
    };
  };
  const betaFlags = createRuntimeSkillBetaFlags(deps.configGetter);
  const requireHub = () => requireSkillHub(deps.skillHubStore);
  const { reportCatalogOverflowOnce, reportCatalogDescriptionCapOnce } = createCatalogDiagnostics(
    deps.metricsClient,
  );
  return {
    async listSkills(input) {
      const scope = await resolveReadScope(
        input.agentName,
        input.excludeAgentResources || Boolean(input.expectedAgentInstanceId),
      );
      const installedHubMetadataByLocationUri =
        await deps.skillHubStore?.getInstalledGlobalMetadataByLocation();
      return registryProvider.listSkills(
        {
          ...input,
          agentName: scope.canonicalName,
          ...(deps.resolveAgentReadScope ? { compatibleAgentNames: scope.compatibleNames } : {}),
          betaFlags: betaFlags(),
        },
        installedHubMetadataByLocationUri,
      );
    },
    async listRuntimeSkills(scope = {}) {
      const readScope = await resolveReadScope(
        scope.agentName,
        scope.excludeAgentResources ||
          scope.skipAgentResolution ||
          Boolean(scope.expectedAgentInstanceId),
      );
      return registryProvider.listRuntimeSkills({
        agentName: readScope.canonicalName,
        ...(deps.resolveAgentReadScope ? { compatibleAgentNames: readScope.compatibleNames } : {}),
        ...(scope.excludeAgentResources ? { excludeAgentResources: true } : {}),
        ...(scope.expectedAgentInstanceId
          ? { expectedAgentInstanceId: scope.expectedAgentInstanceId }
          : {}),
        workspaceDir: scope.workspaceDir,
        betaFlags: betaFlags(scope.cuModeActive),
        ...resolveRuntimeSkillSelectors(scope),
      });
    },
    async renderCatalog(scope = {}) {
      const readScope = await resolveReadScope(
        scope.agentName,
        scope.excludeAgentResources ||
          scope.skipAgentResolution ||
          Boolean(scope.expectedAgentInstanceId),
      );
      const result = await registryProvider.renderCatalog({
        agentName: readScope.canonicalName,
        ...(deps.resolveAgentReadScope ? { compatibleAgentNames: readScope.compatibleNames } : {}),
        ...(scope.excludeAgentResources ? { excludeAgentResources: true } : {}),
        ...(scope.expectedAgentInstanceId
          ? { expectedAgentInstanceId: scope.expectedAgentInstanceId }
          : {}),
        workspaceDir: scope.workspaceDir,
        betaFlags: betaFlags(scope.cuModeActive),
        contextWindowTokens: scope.contextWindowTokens,
        additionalSkills: scope.additionalSkills,
        ...resolveRuntimeSkillSelectors(scope),
      });
      if (result.hardOverflow) {
        reportCatalogOverflowOnce(scope.firstTurnSessionId, 'hard');
      } else if (result.softOverflow) {
        reportCatalogOverflowOnce(scope.firstTurnSessionId, 'soft');
      }
      if (result.descriptionCapTruncated) {
        reportCatalogDescriptionCapOnce(scope.firstTurnSessionId);
      }
      return result.catalog;
    },
    async readSkillByName(name, scope = {}) {
      // No skillName label: user-defined names are unbounded cardinality.
      try {
        const readScope = await resolveReadScope(
          scope.agentName,
          scope.excludeAgentResources ||
            scope.skipAgentResolution ||
            Boolean(scope.expectedAgentInstanceId),
        );
        const result = await registryProvider.readSkillByName(name, {
          agentName: readScope.canonicalName,
          ...(deps.resolveAgentReadScope
            ? { compatibleAgentNames: readScope.compatibleNames }
            : {}),
          ...(scope.excludeAgentResources ? { excludeAgentResources: true } : {}),
          ...(scope.expectedAgentInstanceId
            ? { expectedAgentInstanceId: scope.expectedAgentInstanceId }
            : {}),
          workspaceDir: scope.workspaceDir,
          ...(deps.resourceAmbiguityTelemetry
            ? { resourceAmbiguityTelemetry: deps.resourceAmbiguityTelemetry }
            : {}),
          betaFlags: betaFlags(scope.cuModeActive),
          ...resolveRuntimeSkillSelectors(scope),
        });
        deps.metricsClient?.counter('skill_load_total', 1, {
          status: result ? 'ok' : 'not_found',
        });
        return result;
      } catch (err) {
        deps.metricsClient?.counter('skill_load_total', 1, { status: 'error' });
        throw err;
      }
    },
    async getSkill(input, options = {}) {
      const resolved = await resolveRequestScope(input);
      return registryProvider.getSkillDetail(resolved, options);
    },
    async listSkillFiles(input) {
      return registryProvider.listSkillFiles(await resolveRequestScope(input));
    },
    async readSkillFile(input) {
      return registryProvider.readSkillFile(await resolveRequestScope(input));
    },
    async createSkill(input) {
      const dataDir = deps.configGetter().dataDir;
      if (!dataDir) {
        return {
          ok: false,
          status: 503,
          code: 'SKILL_UNAVAILABLE',
          message: 'Desktop skill dataDir is not configured',
        };
      }
      // Gate user-authored skill text before persisting. Same fail policy as the
      // agent config gate (configReviewBlocks): rejected / local_error block,
      // api_error degrade-passes. The 422 stays generic so no review detail leaks.
      if (
        await configReviewBlocks(deps.reviewContent, [input.name, input.description, input.content])
      ) {
        return {
          ok: false,
          status: 422,
          code: 'CONTENT_POLICY_VIOLATION',
          message: 'Content validation failed',
        };
      }
      const agentName = await resolveWriteTarget(input.agentName);
      const result = await createLocalSkill({
        dataDir,
        ...input,
        ...(agentName ? { agentName } : {}),
      });
      if (result.ok) {
        await registryProvider.refresh({ agentName });
        notifyRuntimeSkillsChanged();
      }
      return result;
    },
    async deleteSkill(input) {
      // The Desktop adapter always includes the optional `agentName` field,
      // even when the request is a global name-only delete. Preserve that
      // ingress shape so the registry can address global skills directly;
      // direct domain callers without the field still resolve through the
      // default agent scope and retain the exact-delete contract.
      const transportGlobalDelete =
        Object.hasOwn(input, 'agentName') && !input.agentName && !input.locationUri;
      const deleted = await registryProvider.deleteSkill(
        transportGlobalDelete ? input : await resolveRequestScope(input),
      );
      if (deleted === 'protected') return 'protected';
      if (!deleted) {
        const uninstalled = transportGlobalDelete
          ? await deps.skillHubStore?.uninstall(input.skillName)
          : false;
        if (uninstalled) {
          notifyRuntimeSkillsChanged();
          return { ok: true, name: input.skillName };
        }
        return undefined;
      }
      // Clear the hub `installed` record for any global (non-agent) skill delete
      // so the market "added" badge resets — even when the caller passed a
      // locationUri. Key by the actually-deleted entry's name, which matches the
      // identity install stores under.
      if (!input.agentName) await deps.skillHubStore?.uninstall(deleted.name);
      notifyRuntimeSkillsChanged();
      return deleted;
    },
    async setSkillEnabled(input, enabled) {
      const result = await registryProvider.setSkillEnabled(input, enabled);
      if (result) notifyRuntimeSkillsChanged();
      return result;
    },
    async listSkillHub(input) {
      const resp = await requireHub().list({
        keyword: input.keyword,
        limit: input.limit,
        nextToken: input.cursor,
        sourceType: input.sourceType,
        sortType: input.sortType,
      });
      return {
        skills: resp.skill_list,
        hasMore: resp.has_more,
        nextCursor: resp.next_token,
      };
    },
    async installSkill(input) {
      const agentName = await resolveWriteTarget(input.agentName);
      const resp = await requireHub().install({
        url: input.url,
        agent_name: agentName,
        is_from_git: input.isFromGit,
        display_name: input.displayName,
        creator_info: input.creatorInfo,
        publisher_source_type: input.publisherSourceType,
      });
      await registryProvider.refresh({ agentName });
      notifyRuntimeSkillsChanged();
      return { ok: resp.ok, skill: resp.skill };
    },
    previewSkill(input) {
      return requireHub().preview(input);
    },
    onDidChangeRuntimeSkills(listener) {
      runtimeSkillChangeListeners.add(listener);
      return () => runtimeSkillChangeListeners.delete(listener);
    },
  };
}

function resolveRuntimeSkillSelectors(scope: LocalRuntimeSkillScope) {
  return {
    injectableBuiltinSkillNames:
      scope.builtinSkillNames === undefined ? undefined : new Set(scope.builtinSkillNames),
    allowedSkillNames: toNormalizedSkillSelectorSet(scope.allowedSkillNames),
    allowedExtensionSkillNames: toNormalizedSkillSelectorSet(scope.allowedExtensionSkillNames),
  };
}

function normalizeAgentName(agentName: string | undefined): string {
  const trimmed = agentName?.trim();
  return trimmed || 'mavis';
}

// ─── process-scoped domain accessor ──────────────────────────────────────────
// The local runtime runs one host per process (CLI / Electron each build a
// single host). The host installs its skill service via `initSkillService()` at
// construction; the DesktopService thrift adapter and turn callers pull it
// through `getSkillService()` instead of receiving it by injection, matching the
// ADR's domain-facade model. `getSkillService()` fails closed before a host has
// installed one. Unit tests drive the domain by mocking `./registry.js` and
// calling `initSkillService()`.
let currentSkillService: LocalSkillService | undefined;

/**
 * Build the host's skill service and install it as the process-scoped domain in
 * one step. The single production entry point for populating `getSkillService()`.
 */
export function initSkillService(deps: LocalSkillServiceDeps): LocalSkillService {
  const service = createLocalSkillService(deps);
  currentSkillService = service;
  return service;
}

export function getSkillService(): LocalSkillService {
  if (!currentSkillService) {
    throw new Error('Local skill service is not initialized');
  }
  return currentSkillService;
}
