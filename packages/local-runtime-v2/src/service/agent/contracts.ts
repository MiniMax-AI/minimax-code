import type {
  AgentBuiltinMcpToolId,
  AgentBuiltinSkillId,
  AgentBuiltinToolId,
  AgentCapabilityConfig,
  ResolvedAgentCapabilities,
} from '@mavis/config';
import type { PromptReadScope } from '@mavis/agent-runtime';

import type {
  AgentConfigError,
  BuiltinCanonicalAgentConfigForWrite,
  CanonicalAgentConfig,
} from './storage/canonical-agent-config.js';
import type { PromptReadContext } from '../prompt-config/index.js';

export type AgentCreationSource = 'manual' | 'auto' | 'builtin';
export type AgentPromptSurface = 'interactive' | 'task-child' | 'cli';
export type AgentPromptProfile = 'desktop' | 'tui';
export type AgentPromptMode = 'tui' | 'coding' | 'work';

/** Agent-owned material; Runtime context and tool inventories remain separate. */
export interface AgentPromptSnapshot {
  readonly mode: AgentPromptMode;
  readonly version?: string;
  readonly template: string;
  readonly systemPrompt: string;
}

export type AgentPromptChannel = 'online' | 'internal';
export type AgentAppMode = 'coding' | 'work';
export type AgentNameResolutionSource =
  | 'stable_name'
  | 'display_name_compat'
  | 'canonical_name'
  | 'explicit_agent';
export type AgentNameCompatIntent = 'read' | 'write' | 'exact' | 'execution';
export type AgentNameCompatCanonicalClass = 'explore' | 'worker' | 'verifier' | 'mavis' | 'other';
export type AgentNameCompatMemberCountBucket = '1' | '2' | '3+';
export type AgentNameCompatErrorCode =
  | 'UNKNOWN_AGENT_NAME'
  | 'AGENT_NOT_FOUND'
  | 'AMBIGUOUS_AGENT_NAME'
  | 'BUILTIN_AGENT_NAME_CONFLICT'
  | 'CANONICAL_AGENT_NOT_AVAILABLE'
  | 'VALIDATION_ERROR'
  | 'PRIMARY_AGENT_IMMUTABLE'
  | 'PRIMARY_AGENT_IDENTITY_CONFLICT'
  | 'LEGACY_PRIMARY_WRITE_FORBIDDEN'
  | 'BUILTIN_AGENT_IMMUTABLE'
  | 'other';
export type AgentRoleObservationStatus = 'missing' | 'unsupported';
export type AgentRoleObservationSource = 'sqlite_decode' | 'builtin_seed';

/** Bounded Agent compatibility fact; no stable/display name leaves AgentSystem. */
export interface AgentNameCompatResolveFact {
  readonly intent: AgentNameCompatIntent;
  readonly canonicalClass: AgentNameCompatCanonicalClass;
  readonly source: AgentNameResolutionSource;
  readonly success: boolean;
  readonly memberCountBucket?: AgentNameCompatMemberCountBucket;
  readonly errorCode?: AgentNameCompatErrorCode;
}

/** Role is a domain value; the compatibility telemetry adapter bounds it before emission. */
export interface AgentRoleObservationFact {
  readonly status: AgentRoleObservationStatus;
  readonly source: AgentRoleObservationSource;
  readonly role: unknown;
}

/**
 * Why the one-time legacy primary profile overlay did or did not copy anything.
 * Every branch of the convergence emits exactly one of these: "my old display
 * name did not carry over" is otherwise only answerable by absence of a write.
 * Field NAMES only — a displayName / workspace path is user content.
 */
export type AgentPrimaryProfileOverlayOutcome =
  | 'applied'
  | 'no_op'
  | 'skipped_no_canonical_primary'
  | 'skipped_family_incomplete';

export interface AgentPrimaryProfileOverlayFact {
  readonly outcome: AgentPrimaryProfileOverlayOutcome;
  readonly adoptedFields: readonly string[];
  readonly displayNameLocked: boolean;
}

export interface AgentSystemFactCallbacks {
  readonly onNameCompatResolve?: (fact: AgentNameCompatResolveFact) => void;
  readonly onAgentRoleObservation?: (fact: AgentRoleObservationFact) => void;
  readonly onPrimaryProfileOverlay?: (fact: AgentPrimaryProfileOverlayFact) => void;
}

export interface AgentStoreMeta {
  readonly name: string;
  readonly agentRole: string;
  readonly rootSessionId?: string;
  readonly sourceProject?: string;
  readonly harnessSourceType?: string;
  readonly creationSource: AgentCreationSource;
  readonly greetingSent: boolean;
  readonly pinned?: boolean;
  readonly pinnedAtMs?: number | null;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface AgentStoreConfig {
  readonly defaultWorkspaceDir?: string;
}

export interface AgentStoreIdentity {
  readonly displayName?: string;
  readonly description?: string;
  readonly avatar?: string;
}

/**
 * A verified Custom-Agent avatar returned only by the Desktop-local storage
 * owner. The HTTP host receives bytes, never an Agent-relative path.
 */
export interface AgentAvatarAsset {
  readonly bytes: Uint8Array;
  readonly contentType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

export interface AgentStoreInsert {
  readonly name: string;
  readonly agentRole: string;
  readonly creationSource: AgentCreationSource;
  /** Complete canonical definition supplied with an atomic Custom-Agent create. */
  readonly initialDefinition?: AgentConfiguredDefinition;
  readonly rootSessionId?: string;
  readonly defaultWorkspaceDir?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly avatar?: string;
  readonly persona?: string;
  readonly systemPrompt?: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
}

export interface AgentStoreUpdate {
  readonly agentRole?: string;
  readonly mainSessionId?: string | null;
  readonly expectedMainSessionId?: string;
  readonly creationSource?: AgentCreationSource;
  readonly greetingSent?: boolean;
  readonly createdAtMs?: number;
  readonly updatedAtMs?: number;
}

export interface AgentStoreAssetsUpdate {
  readonly name: string;
  readonly displayName?: string | null;
  readonly description?: string | null;
  readonly avatar?: string | null;
  readonly persona?: string | null;
  readonly systemPrompt?: string | null;
  readonly defaultWorkspaceDir?: string | null;
  readonly updatedAtMs: number;
}

/** Raw canonical file plus its byte-level CAS revision. */
export interface AgentCanonicalDocument {
  readonly content: string;
  readonly revision: string;
  readonly config: CanonicalAgentConfig;
}

/** Structured projection of the one canonical Config API document. */
export interface AgentConfiguredDefinition {
  readonly name: string;
  readonly description: string;
  readonly model?: string;
  readonly effort?: string;
  /** Omitted inherits the runtime ceiling; [] explicitly disables it. */
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly skills?: readonly string[];
  readonly mavis?: {
    readonly displayName?: string;
    readonly avatar?: string;
    readonly contextWindow?: number;
    readonly maxOutputTokens?: number;
    readonly defaultWorkspaceDir?: string;
    readonly extensionSkills?: readonly string[];
  };
  readonly systemPrompt: string;
}

/** Runtime-owned effective preview for Sessions created after this edit. */
export interface AgentEffectiveConfigForNewSession {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly effort?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly tools?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly skills?: readonly string[];
  readonly extensionSkills?: readonly string[];
}

export interface AgentConfigDiagnostic {
  readonly code: string;
  readonly fieldPath: string;
}

/**
 * Raw canonical content plus server-owned interpretation.  The renderer must
 * not reconstruct this object: only the Desktop Runtime owns parsing/CAS.
 */
export interface AgentConfigDocument {
  readonly exactOwnerName: string;
  readonly ownerInstanceId?: string;
  readonly ownerKind: 'builtin' | 'custom';
  readonly persistence: 'launch-scoped' | 'persistent';
  readonly appliesTo: 'new-sessions-only';
  readonly revision: string;
  readonly content: string;
  readonly configured: AgentConfiguredDefinition;
  readonly effectiveForNewSession: AgentEffectiveConfigForNewSession;
  readonly diagnostics: readonly AgentConfigDiagnostic[];
  /** Bundled builtins only; callers reset through the same CAS PUT. */
  readonly baselineContent?: string;
}

export interface AgentConfigPutInput {
  readonly requestRef: string;
  readonly content: string;
  readonly expectedRevision: string;
  readonly expectedOwnerInstanceId?: string;
}

export type AgentPromptPublicationOutcome = 'published' | 'already-exists';
export type AgentPromptMaterializationAction = 'preserved' | 'published_missing' | 'repaired_blank';

/** Bounded startup diagnostics; user profile values never leave storage. */
export type LegacyCustomAgentIdentitySource = 'v2_target' | 'legacy_source' | 'none';
export type LegacyCustomAgentRecoveredField = 'display_name' | 'system_prompt';
export type LegacyCustomAgentMaterializationOutcome =
  | 'materialized'
  | 'canonical_identity_reconciled'
  | 'already_canonical'
  | 'not_legacy';

export interface LegacyCustomAgentMaterializationResult {
  readonly outcome: LegacyCustomAgentMaterializationOutcome;
  readonly identitySource: LegacyCustomAgentIdentitySource;
  readonly recoveredFields: readonly LegacyCustomAgentRecoveredField[];
}

export type LegacyCustomAgentMaterializationEvent =
  | {
      readonly kind: 'agent';
      readonly agentName: string;
      readonly outcome: LegacyCustomAgentMaterializationOutcome | 'invalid' | 'failed';
      readonly identitySource: LegacyCustomAgentIdentitySource;
      readonly recoveredFields: readonly LegacyCustomAgentRecoveredField[];
      readonly errorCode?: AgentConfigError['code'] | 'unknown';
      readonly stage?: 'builtin_name_conflict_rename' | 'materialization';
      readonly reason?: 'missing' | 'invalid' | 'unreadable';
    }
  | {
      readonly kind: 'summary';
      readonly materialized: number;
      readonly canonicalIdentityReconciled: number;
      readonly alreadyCanonical: number;
      readonly notLegacy: number;
      readonly invalid: number;
      readonly failed: number;
      readonly receiptCompleted: boolean;
    };

/**
 * Result of a startup repair of a corrupted Builtin source. `skipped` means the
 * file was valid or missing again when the repair took its lock, so nothing
 * was archived or written.
 */
export type BuiltinCorruptedConfigRepair =
  | { readonly archiveFile: string }
  | { readonly skipped: 'now_valid' | 'missing' };

/** Public Agent persistence port implemented by the V2 storage adapter. */
export interface AgentStorePort {
  /**
   * Serializes the read-check-write boundary for user-visible Agent names.
   * This is deliberately separate from a per-Agent file lock: two different
   * Agent directories can still race for the same display name.
   */
  withDisplayNameLock<T>(operation: () => Promise<T>): Promise<T>;
  /** Startup-only repair for historical rows that use a built-in primary name. */
  normalizePrimaryFamilyRows(): Promise<number>;
  insert(input: AgentStoreInsert): Promise<void>;
  get(name: string): Promise<AgentStoreMeta | undefined>;
  list(options?: { limit?: number; offset?: number; search?: string }): Promise<AgentStoreMeta[]>;
  update(name: string, fields: AgentStoreUpdate): Promise<boolean>;
  delete(name: string): Promise<boolean>;
  /** Historical entry point for frozen legacy Roots; return empty when no match exists. */
  getLegacyHistoryNotice?(name: string): Promise<string | undefined>;
  /** Import rollback fence: delete only the Custom incarnation originally created. */
  deleteIfOwnerInstanceId?(name: string, expectedOwnerInstanceId: string): Promise<boolean>;
  getConfig(name: string): Promise<AgentStoreConfig | null>;
  updateConfig(name: string, fields: Partial<AgentStoreConfig>): Promise<boolean>;
  getIdentity(name: string): Promise<AgentStoreIdentity | null>;
  updateIdentity(name: string, fields: Partial<AgentStoreIdentity>): Promise<boolean>;
  deleteIdentity(name: string): Promise<boolean>;
  getPersona(name: string): Promise<string | null>;
  updatePersona(name: string, text: string): Promise<void>;
  publishPersonaIfAbsent(name: string, text: string): Promise<AgentPromptPublicationOutcome>;
  materializePersonaForTrustedBuiltin(
    name: string,
    text: string,
  ): Promise<AgentPromptMaterializationAction>;
  deletePersona(name: string): Promise<boolean>;
  getSystemPrompt(name: string): Promise<string | null>;
  updateSystemPrompt(name: string, text: string): Promise<void>;
  publishSystemPromptIfAbsent(name: string, text: string): Promise<AgentPromptPublicationOutcome>;
  materializeSystemPromptForTrustedBuiltin(
    name: string,
    text: string,
  ): Promise<AgentPromptMaterializationAction>;
  deleteSystemPrompt(name: string): Promise<boolean>;
  updateAssets(input: AgentStoreAssetsUpdate): Promise<boolean>;
  /** Canonical Custom Agent source. Optional only for narrow legacy test doubles. */
  getCanonicalConfig?(name: string): Promise<CanonicalAgentConfig>;
  /** Full canonical bytes for Config GET/PUT; optional for narrow legacy doubles. */
  readCanonicalDocument?(name: string, builtin?: boolean): Promise<AgentCanonicalDocument>;
  /** Atomically pairs a Custom document with its durable incarnation. */
  readCustomCanonicalDocumentWithInstance?(name: string): Promise<{
    readonly document: AgentCanonicalDocument;
    readonly ownerInstanceId: string;
  }>;
  replaceCanonicalDocument?(input: {
    readonly name: string;
    readonly content: string;
    readonly expectedRevision: string;
    readonly builtin?: boolean;
    readonly expectedInstanceId?: string;
    /** Bundled Builtin baseline for a first launch-scoped write. */
    readonly missingContent?: string;
  }): Promise<AgentCanonicalDocument>;
  /** Durable Custom Agent incarnation used to fence stale Config writers. */
  getOrCreateCustomAgentInstanceId?(name: string): Promise<string>;
  /** Safe canonical Custom-Agent asset read; never falls back to legacy files. */
  readCustomAvatar?(name: string): Promise<AgentAvatarAsset | undefined>;
  writeCanonicalConfig?(
    name: string,
    config: Omit<CanonicalAgentConfig, 'diagnostics'>,
  ): Promise<void>;
  getBuiltinCanonicalConfig?(name: string): Promise<CanonicalAgentConfig>;
  /** Writes only when the file is absent; `already-exists` means nothing was written. */
  writeBuiltinCanonicalConfig?(
    name: string,
    config: BuiltinCanonicalAgentConfigForWrite,
  ): Promise<'published' | 'already-exists' | void>;
  /**
   * Startup-only: replaces a valid Builtin source with `config` when it still
   * has `expectedRevision`; identical bytes are not rewritten.
   */
  rewriteBuiltinCanonicalConfig?(
    name: string,
    config: BuiltinCanonicalAgentConfigForWrite,
    expectedRevision: string,
  ): Promise<'rewritten' | 'unchanged' | 'conflict'>;
  /**
   * Startup-only: archives a Builtin source that is still corrupted, then
   * rewrites it from `config`.
   */
  replaceCorruptedBuiltinCanonicalConfig?(
    name: string,
    config: BuiltinCanonicalAgentConfigForWrite,
  ): Promise<BuiltinCorruptedConfigRepair>;
  removeBuiltinCanonicalConfig?(name: string): Promise<boolean>;
  materializeLegacyCustomAgent?(
    name: string,
  ): Promise<'already-canonical' | 'materialized' | 'not-legacy'>;
  /** Startup-only detailed materialization/reconciliation outcome. */
  materializeLegacyCustomAgentForStartup?(
    name: string,
  ): Promise<LegacyCustomAgentMaterializationResult>;
  /** Startup-only legacy candidate enumeration; never a public Custom roster. */
  listLegacyCustomAgents?(): Promise<AgentStoreMeta[]>;
  /** Marks the completed one-shot legacy identity reconciliation round. */
  completeLegacyCustomIdentityReconciliation?(): Promise<void>;
  /** Repairs missing runtime state for an already-published Custom file. */
  reconcileCanonicalCustomAgent?(input: AgentStoreInsert): Promise<boolean>;
  /** Startup repair for file-only canonical Custom Agents. */
  reconcileCanonicalCustomAgents?(): Promise<number>;
  getAgentDir(name: string): string;
  close?(): void;
}

export interface AgentView {
  readonly name: string;
  readonly requestRef: string;
  readonly canonicalViewName: string;
  readonly exactOwnerName: string;
  readonly resolvedAgentName: string;
  readonly agentRole: string;
  readonly creationSource: AgentCreationSource;
  readonly rootSessionId?: string;
  /** Existing V1 Agent asset directory; exposed for Desktop response parity only. */
  readonly agentConfigDir?: string;
  readonly displayName: string;
  readonly description?: string;
  readonly avatar?: string;
  readonly defaultWorkspaceDir?: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly legacySourceName?: string;
}

export interface AgentListOptions {
  readonly includeAliases?: boolean;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface AgentReadScope {
  readonly requestedName: string;
  readonly canonicalName: string;
  readonly primaryName: string;
  readonly compatibleNames: readonly string[];
  readonly exact: boolean;
  readonly source: AgentNameResolutionSource;
  readonly exactOwnerName: string;
  readonly trustedBuiltin?: boolean;
}

export interface AgentCreateInput {
  readonly name?: string;
  /**
   * Final Custom-Agent definition written before the Agent becomes visible.
   * The resolved create name remains authoritative over `initialDefinition.name`.
   */
  readonly initialDefinition?: AgentConfiguredDefinition;
  readonly displayName?: string;
  readonly description?: string;
  readonly avatar?: string;
  readonly persona?: string;
  readonly systemPrompt?: string;
  readonly defaultWorkspaceDir?: string;
  readonly agentRole?: string;
  readonly rootSessionId?: string;
  readonly nowMs?: number;
}

export interface AgentUpdateInput {
  readonly requestRef: string;
  readonly displayName?: string | null;
  readonly description?: string | null;
  readonly avatar?: string | null;
  readonly persona?: string | null;
  readonly systemPrompt?: string | null;
  readonly defaultWorkspaceDir?: string | null;
  readonly nowMs?: number;
}

export interface AgentProfileRequest {
  /** Persisted Agent row selected by Turn/Application composition. */
  readonly exactOwnerName: string;
  /** Optional caller-facing alias for logs and response echo only. */
  readonly requestRef?: string;
  readonly surface?: AgentPromptSurface;
  /** Product-owned Prompt family. TUI uses only package-local assets. */
  readonly promptProfile?: AgentPromptProfile;
  readonly promptMode?: AgentPromptMode;
  readonly promptVersion?: string;
  readonly appMode?: AgentAppMode;
  readonly locale?: string;
  readonly promptChannel?: AgentPromptChannel;
  readonly capabilities?: AgentCapabilityConfig | ResolvedAgentCapabilities;
  readonly memoryEnabled?: boolean;
  readonly cronEnabled?: boolean;
  readonly dataDirToken?: string;
  /** Immutable prompt version captured before this model call starts. */
  readonly promptReadContext?: PromptReadContext | PromptReadScope;
  /**
   * The Session runs in PTC mode (`toolCallMode: 'ptc'`). The prompt gets the PTC section when
   * isPtcTurnEnabled accepts it, exactly as the tool catalog decides from the same Session mode.
   */
  readonly ptcRequested?: boolean;
}

export interface AgentCapabilityCeiling {
  readonly personaEnabled: boolean;
  readonly tools?: readonly AgentBuiltinToolId[];
  readonly builtinTools?: readonly AgentBuiltinMcpToolId[];
  readonly skills?: readonly AgentBuiltinSkillId[];
  readonly features: Readonly<{
    mavis: boolean;
    delegation: boolean;
    webSearch: boolean;
  }>;
}

/** Agent-owned selectors; runtime inventory, permission, and safety remain the ceiling. */
export interface AgentConfigurationSelection {
  readonly model?: string;
  readonly effort?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly skills?: readonly string[];
  readonly extensionSkills?: readonly string[];
}

/**
 * Durable Task snapshot supplied by Session binding storage. It intentionally
 * excludes model fields (which remain Session-derived) and all Runtime layers.
 */
export interface FrozenAgentExecutionDefinition {
  readonly promptSnapshot?: AgentPromptSnapshot;
  /** Custom incarnations are captured at Session creation; absence identifies built-ins. */
  readonly ownerInstanceId?: string;
  readonly systemPrompt: string;
  readonly capabilities: Pick<
    AgentConfigurationSelection,
    'tools' | 'disallowedTools' | 'mcpServers' | 'skills' | 'extensionSkills'
  >;
}

export interface AgentExecutionProfile {
  /** Exclude private resources when their saved owner identity cannot be verified. */
  readonly excludeAgentResources?: boolean;
  readonly skipAgentResolution?: boolean;
  readonly expectedAgentInstanceId?: string;
  /** Caller-facing request identity retained for diagnostics and response echo. */
  readonly requestRef: string;
  /**
   * Resource-read identity. Frozen profiles use the physical owner name because
   * they intentionally skip live Agent resolution.
   */
  readonly resourceReadRef: string;
  readonly exactOwnerName: string;
  readonly canonicalViewName: string;
  readonly resolvedAgentName: string;
  readonly agentRole: string;
  readonly creationSource: AgentCreationSource;
  readonly surface: AgentPromptSurface;
  /** Canonical-first durable Memory family frozen by LocalAgentService. */
  readonly memoryReadAgentNames: readonly string[];
  readonly persona?: string;
  /**
   * Canonical Agent-owned prompt only. Runtime shared/surface/safety layers
   * stay outside this value so Task capture can freeze only Agent content.
   */
  readonly agentSystemPrompt?: string;
  readonly promptSnapshot?: AgentPromptSnapshot;
  readonly corePrompt: string;
  readonly surfacePrompt: string;
  readonly capabilityCeiling: AgentCapabilityCeiling;
  /** Present for Custom and managed non-primary Builtin canonical files. */
  readonly configSelection?: AgentConfigurationSelection;
  readonly provenance: Readonly<{
    source: 'builtin' | 'custom' | 'legacy-read-through';
    assetAgentName: string;
    locale: string;
    appMode?: AgentAppMode;
    promptChannel?: AgentPromptChannel;
  }>;
}

export interface BuiltinAgentDefinition {
  readonly name: string;
  readonly role: string;
  readonly legacyNames: readonly string[];
  readonly identity: AgentStoreIdentity;
  readonly capabilityOverride?: AgentCapabilityConfig;
}
