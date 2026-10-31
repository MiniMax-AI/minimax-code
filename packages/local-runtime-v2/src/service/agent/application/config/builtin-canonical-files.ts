import { BuiltinAgentCatalog, resolveCanonicalCapabilities } from '../../builtin/catalog.js';
import { LEGACY_PRIMARY_AGENT_NAME } from '../../domain/names.js';
import type {
  AgentConfigurationSelection,
  AgentStorePort,
  BuiltinAgentDefinition,
  BuiltinCorruptedConfigRepair,
} from '../../contracts.js';
import type {
  BuiltinCanonicalAgentConfigForWrite,
  CanonicalAgentConfig,
  CanonicalAgentMavisConfig,
} from '../../storage/canonical-agent-config.js';
import { AgentConfigError } from '../../storage/canonical-agent-config.js';
import { BuiltinAgentConfigRepairError } from '../../storage/builtin-agent-files.js';
import { resolveLocale } from '../../domain/validation.js';

export type BuiltinModelGroup = Pick<
  AgentConfigurationSelection,
  'model' | 'effort' | 'contextWindow' | 'maxOutputTokens'
>;

/**
 * The Model System binds this only after its live catalog is ready. It owns
 * the previous -> explicit bundled -> unset fallback chain and returns one coherent
 * group, so Agent files never keep a model's limits after its model changes.
 */
export type BuiltinModelGroupResolver = (input: {
  readonly previous?: BuiltinModelGroup;
  readonly bundled?: BuiltinModelGroup;
}) => Promise<BuiltinModelGroup | undefined>;

/** Config read failures that mean the Builtin source exists but is unusable. */
type CorruptedBuiltinConfigCode = Exclude<AgentConfigError['code'], 'AGENT_CONFIG_NOT_FOUND'>;

type BuiltinAgentConfigRepairStage =
  | 'read'
  | 'template'
  | 'seed'
  | 'archive'
  | 'rewrite'
  | 'reload';

/** Builtin source repair facts; never carries paths or file content. */
export type BuiltinAgentConfigRepairEvent =
  | {
      readonly kind: 'archived';
      readonly agentName: string;
      readonly errorCode: CorruptedBuiltinConfigCode;
      readonly archiveFile: string;
    }
  | {
      readonly kind: 'repair_failed';
      readonly agentName: string;
      readonly errorCode: string;
      readonly stage: BuiltinAgentConfigRepairStage;
    }
  | {
      readonly kind: 'reseeded';
      readonly agentName: string;
      readonly trigger: 'use_time';
    }
  | {
      /**
       * The file judged corrupted was valid (`now_valid`) or missing again when
       * the repair took its lock, so nothing was archived or written. A later
       * startup pass reloads a valid file as usual; a missing one is reseeded
       * on use or at the next startup.
       */
      readonly kind: 'repair_skipped';
      readonly agentName: string;
      readonly errorCode: CorruptedBuiltinConfigCode;
      readonly reason: 'now_valid' | 'missing';
    }
  | {
      readonly kind: 'reloaded';
      readonly agentName: string;
      /**
       * False only when the previous model was replaced by a fallback. The
       * resolver may still fill in effort or limits for the kept model.
       */
      readonly modelKept: boolean;
    };

export type BuiltinAgentConfigRepairReporter = (event: BuiltinAgentConfigRepairEvent) => void;

interface BuiltinRepairProgress {
  stage: BuiltinAgentConfigRepairStage;
}

export async function rebuildBuiltinCanonicalFiles(input: {
  readonly repository: AgentStorePort;
  readonly catalog: BuiltinAgentCatalog;
  readonly definitions: readonly BuiltinAgentDefinition[];
  readonly modelGroupResolver?: BuiltinModelGroupResolver;
  readonly bundledModelGroup?: BuiltinModelGroup;
  readonly report?: BuiltinAgentConfigRepairReporter;
}): Promise<void> {
  await removeRetiredLegacyPrimaryBuiltinFile(input.repository);
  if (!input.repository.writeBuiltinCanonicalConfig) return;
  for (const definition of input.definitions) {
    // This runs inside the synchronous startup barrier. One Builtin file that
    // cannot be read, reloaded, archived or rewritten must not fail the whole
    // local runtime. A failed reload leaves the valid old file in use; an
    // unusable file reports a copyable repair instruction when the Agent is
    // used (see renderBuiltinProfile).
    const progress: BuiltinRepairProgress = { stage: 'read' };
    try {
      await rebuildBuiltinCanonicalFile(input, definition, progress);
    } catch (error) {
      emitBuiltinAgentConfigRepair(input.report, {
        kind: 'repair_failed',
        agentName: definition.name,
        errorCode: repairFailureCode(error),
        stage: progress.stage,
      });
    }
  }
}

/** `main` is only a compatibility owner; its old launch file cannot execute. */
async function removeRetiredLegacyPrimaryBuiltinFile(repository: AgentStorePort): Promise<void> {
  await repository.removeBuiltinCanonicalConfig?.(LEGACY_PRIMARY_AGENT_NAME);
}

async function rebuildBuiltinCanonicalFile(
  input: {
    readonly repository: AgentStorePort;
    readonly catalog: BuiltinAgentCatalog;
    readonly modelGroupResolver?: BuiltinModelGroupResolver;
    readonly bundledModelGroup?: BuiltinModelGroup;
    readonly report?: BuiltinAgentConfigRepairReporter;
  },
  definition: BuiltinAgentDefinition,
  progress: BuiltinRepairProgress,
): Promise<void> {
  const capabilities = resolveCanonicalCapabilities(undefined, definition.capabilityOverride);
  const existing = await inspectExistingBuiltinConfig(input.repository, definition.name);
  if (existing.kind === 'valid') {
    progress.stage = 'reload';
    await reloadBuiltinCanonicalFile(input, definition, capabilities);
    return;
  }
  // Build the bundled baseline before touching a corrupted file, so a missing
  // template never leaves an archive behind without a replacement.
  progress.stage = 'template';
  const { config } = await buildBuiltinFactoryConfig(input, definition, capabilities);
  if (existing.kind === 'missing') {
    progress.stage = 'seed';
    await input.repository.writeBuiltinCanonicalConfig?.(definition.name, config);
    return;
  }
  await repairCorruptedBuiltinCanonicalFile(
    input,
    { agentName: definition.name, corruption: existing.error, config },
    progress,
  );
}

/**
 * Use-time counterpart of the startup "seed when missing" step. Another
 * process sharing the data directory (old `@minimax-ai/code` ACP clients)
 * deletes `.builtin/<name>/agent.md` while this runtime is running, and
 * startup is the only other place that recreates it. This writes the same
 * bundled template with the same freshly resolved model group, and only when
 * the file is still absent: the `.builtin:<name>` lock plus publish-if-absent
 * keep an existing file untouched and let concurrent Turns write it once.
 */
export async function reseedMissingBuiltinCanonicalFile(input: {
  readonly repository: AgentStorePort;
  readonly catalog: BuiltinAgentCatalog;
  readonly definition: BuiltinAgentDefinition;
  readonly modelGroupResolver?: BuiltinModelGroupResolver;
  readonly bundledModelGroup?: BuiltinModelGroup;
  readonly report?: BuiltinAgentConfigRepairReporter;
}): Promise<void> {
  const { definition, repository } = input;
  if (!repository.writeBuiltinCanonicalConfig) return;
  const capabilities = resolveCanonicalCapabilities(undefined, definition.capabilityOverride);
  const { config } = await buildBuiltinFactoryConfig(input, definition, capabilities);
  const outcome = await repository.writeBuiltinCanonicalConfig(definition.name, config);
  if (outcome === 'already-exists') return;
  emitBuiltinAgentConfigRepair(input.report, {
    kind: 'reseeded',
    agentName: definition.name,
    trigger: 'use_time',
  });
}

/**
 * The current bundled content of one Builtin file: the raw V2 template plus
 * the resolved model group. A missing file passes no previous group; a reload
 * passes the existing file's group so the resolver keeps it when still usable.
 */
async function buildBuiltinFactoryConfig(
  input: {
    readonly catalog: BuiltinAgentCatalog;
    readonly modelGroupResolver?: BuiltinModelGroupResolver;
    readonly bundledModelGroup?: BuiltinModelGroup;
  },
  definition: BuiltinAgentDefinition,
  capabilities: ReturnType<typeof resolveCanonicalCapabilities>,
  previous?: BuiltinModelGroup,
): Promise<{
  readonly config: BuiltinCanonicalAgentConfigForWrite;
  readonly modelGroup: BuiltinModelGroup | undefined;
}> {
  const content = await input.catalog.readCanonicalContent({
    agentName: definition.name,
    surface: 'interactive',
    appMode: 'coding',
    locale: resolveLocale(),
    promptChannel: 'online',
    capabilities,
  });
  const modelGroup = await resolveBuiltinModelGroup({
    previous,
    resolver: input.modelGroupResolver,
    bundled: input.bundledModelGroup,
  });
  return {
    config: toBuiltinCanonicalConfig(definition, modelGroup, capabilities, content),
    modelGroup,
  };
}

/**
 * Rule for Builtin files: at runtime the local `agent.md` is the source of
 * truth (an edit applies from the next Turn), and every startup reloads it to
 * the current version's bundled content, keeping only the model group
 * (`model`, `effort`, `x-mavis.contextWindow`, `x-mavis.maxOutputTokens`).
 * The model group is the one part of a Builtin Agent the product lets users
 * change (UI `canEditConfigField` in AgentManagementPage.tsx, runtime
 * `assertBuiltinConfigModelOnlyUpdate`); everything else is bundled content
 * that must follow the installed version. The file is overwritten in place
 * without an archive, only when its bytes would change, and only if it still
 * has the revision read here.
 */
async function reloadBuiltinCanonicalFile(
  input: {
    readonly repository: AgentStorePort;
    readonly catalog: BuiltinAgentCatalog;
    readonly modelGroupResolver?: BuiltinModelGroupResolver;
    readonly bundledModelGroup?: BuiltinModelGroup;
    readonly report?: BuiltinAgentConfigRepairReporter;
  },
  definition: BuiltinAgentDefinition,
  capabilities: ReturnType<typeof resolveCanonicalCapabilities>,
): Promise<void> {
  const { repository } = input;
  if (!repository.readCanonicalDocument || !repository.rewriteBuiltinCanonicalConfig) return;
  const document = await repository.readCanonicalDocument(definition.name, true);
  const previous = modelGroupFromCanonical(document.config);
  const { config, modelGroup } = await buildBuiltinFactoryConfig(
    input,
    definition,
    capabilities,
    previous,
  );
  const outcome = await repository.rewriteBuiltinCanonicalConfig(
    definition.name,
    config,
    document.revision,
  );
  if (outcome !== 'rewritten') return;
  emitBuiltinAgentConfigRepair(input.report, {
    kind: 'reloaded',
    agentName: definition.name,
    modelKept: previous?.model === modelGroup?.model,
  });
}

/**
 * A corrupted Builtin source is archived byte-for-byte and then rewritten from
 * the bundled template. The archive keeps the user's edits recoverable, which
 * is what used to justify failing startup on an invalid file. The repository
 * re-checks the file under its lock and skips one that was fixed or deleted
 * while the template and model group were loading.
 */
async function repairCorruptedBuiltinCanonicalFile(
  input: {
    readonly repository: AgentStorePort;
    readonly report?: BuiltinAgentConfigRepairReporter;
  },
  repair: {
    readonly agentName: string;
    readonly corruption: AgentConfigError & { readonly code: CorruptedBuiltinConfigCode };
    readonly config: BuiltinCanonicalAgentConfigForWrite;
  },
  progress: BuiltinRepairProgress,
): Promise<void> {
  const { agentName, corruption, config } = repair;
  progress.stage = 'archive';
  if (!input.repository.replaceCorruptedBuiltinCanonicalConfig) throw corruption;
  let result: BuiltinCorruptedConfigRepair;
  try {
    result = await input.repository.replaceCorruptedBuiltinCanonicalConfig(agentName, config);
  } catch (error) {
    if (!(error instanceof BuiltinAgentConfigRepairError)) throw error;
    progress.stage = error.stage;
    if (error.archiveFile) {
      emitBuiltinAgentConfigRepair(input.report, {
        kind: 'archived',
        agentName,
        errorCode: corruption.code,
        archiveFile: error.archiveFile,
      });
    }
    throw error.failure;
  }
  if ('skipped' in result) {
    emitBuiltinAgentConfigRepair(input.report, {
      kind: 'repair_skipped',
      agentName,
      errorCode: corruption.code,
      reason: result.skipped,
    });
    return;
  }
  emitBuiltinAgentConfigRepair(input.report, {
    kind: 'archived',
    agentName,
    errorCode: corruption.code,
    archiveFile: result.archiveFile,
  });
}

/**
 * Generates the dynamic bundled baseline returned by Config GET. The caller
 * may pass a currently selected model group so Reset restores platform-owned
 * prompt/capabilities without discarding a user's persistent model choice.
 */
export async function buildBuiltinCanonicalBaseline(input: {
  readonly catalog: BuiltinAgentCatalog;
  readonly definition: BuiltinAgentDefinition;
  readonly modelGroup?: BuiltinModelGroup;
}): Promise<Omit<CanonicalAgentConfig, 'diagnostics'>> {
  const capabilities = resolveCanonicalCapabilities(undefined, input.definition.capabilityOverride);
  const content = await input.catalog.readCanonicalContent({
    agentName: input.definition.name,
    surface: 'interactive',
    appMode: 'coding',
    locale: resolveLocale(),
    promptChannel: 'online',
    capabilities,
  });
  return toBuiltinCanonicalConfig(input.definition, input.modelGroup, capabilities, content);
}

export function builtinModelGroupFromCanonical(
  config: CanonicalAgentConfig | undefined,
): BuiltinModelGroup | undefined {
  return modelGroupFromCanonical(config);
}

type ExistingBuiltinConfig =
  | { readonly kind: 'valid' }
  | { readonly kind: 'missing' }
  | {
      readonly kind: 'corrupted';
      readonly error: AgentConfigError & { readonly code: CorruptedBuiltinConfigCode };
    };

async function inspectExistingBuiltinConfig(
  repository: AgentStorePort,
  name: string,
): Promise<ExistingBuiltinConfig> {
  if (!repository.getBuiltinCanonicalConfig) return { kind: 'missing' };
  try {
    await repository.getBuiltinCanonicalConfig(name);
    return { kind: 'valid' };
  } catch (error) {
    if (!(error instanceof AgentConfigError)) throw error;
    if (error.code === 'AGENT_CONFIG_NOT_FOUND') return { kind: 'missing' };
    return {
      kind: 'corrupted',
      error: error as AgentConfigError & { readonly code: CorruptedBuiltinConfigCode },
    };
  }
}

function emitBuiltinAgentConfigRepair(
  report: BuiltinAgentConfigRepairReporter | undefined,
  event: BuiltinAgentConfigRepairEvent,
): void {
  try {
    report?.(event);
  } catch {
    // Observability must never change startup recovery.
  }
}

/** A stable code only: error messages may embed the user's dataDir path. */
function repairFailureCode(error: unknown): string {
  const code = (error as { readonly code?: unknown } | undefined)?.code;
  if (typeof code === 'string' && code) return code;
  if (error instanceof Error && error.name !== 'Error') return error.name;
  return 'unknown';
}

function toBuiltinCanonicalConfig(
  definition: BuiltinAgentDefinition,
  modelGroup: BuiltinModelGroup | undefined,
  capabilities: ReturnType<typeof resolveCanonicalCapabilities>,
  content: Awaited<ReturnType<BuiltinAgentCatalog['readCanonicalContent']>>,
): BuiltinCanonicalAgentConfigForWrite {
  const xMavis = builtinMavisConfig(definition, modelGroup);
  return {
    name: definition.name,
    description: definition.identity.description?.trim() || definition.name,
    ...(xMavis ? { xMavis } : {}),
    ...(modelGroup?.model ? { model: modelGroup.model } : {}),
    ...(modelGroup?.effort ? { effort: modelGroup.effort } : {}),
    ...(capabilities.tools === undefined ? {} : { tools: capabilities.tools }),
    // `builtinTools` are tool IDs, not MCP server names. Absence here inherits
    // the ready server inventory, which is the bundled default.
    ...(capabilities.skills === undefined ? {} : { skills: capabilities.skills }),
    features: { ...capabilities.features },
    systemPrompt: mergeBuiltinAgentSystemPrompt(content.persona, content.systemPrompt),
  };
}

function builtinMavisConfig(
  definition: BuiltinAgentDefinition,
  modelGroup: BuiltinModelGroup | undefined,
): CanonicalAgentMavisConfig | undefined {
  const displayName = definition.identity.displayName?.trim() || undefined;
  const contextWindow = modelGroup?.contextWindow;
  const maxOutputTokens = modelGroup?.maxOutputTokens;
  if (displayName === undefined && contextWindow === undefined && maxOutputTokens === undefined) {
    return undefined;
  }
  return {
    ...(displayName ? { displayName } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}

async function resolveBuiltinModelGroup(input: {
  readonly previous: BuiltinModelGroup | undefined;
  readonly resolver: BuiltinModelGroupResolver | undefined;
  readonly bundled: BuiltinModelGroup | undefined;
}): Promise<BuiltinModelGroup | undefined> {
  if (input.resolver) {
    return input.resolver({
      ...(input.previous ? { previous: input.previous } : {}),
      bundled: input.bundled,
    });
  }
  // The first startup pass runs before the Model System binds a resolver. Keep
  // the previous group verbatim so a crash before the second pass loses no
  // user model choice; the second pass resolves it against the live catalog.
  return input.previous;
}

function modelGroupFromCanonical(
  config: CanonicalAgentConfig | undefined,
): BuiltinModelGroup | undefined {
  if (!config) return undefined;
  const group = {
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
    ...(config.xMavis?.contextWindow === undefined
      ? {}
      : { contextWindow: config.xMavis.contextWindow }),
    ...(config.xMavis?.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: config.xMavis.maxOutputTokens }),
  };
  return Object.keys(group).length > 0 ? group : undefined;
}

export function mergeBuiltinAgentSystemPrompt(
  persona: string | undefined,
  systemPrompt: string | undefined,
): string {
  const parts = [persona?.trim() ?? '', systemPrompt?.trim() ?? ''].filter(Boolean);
  return parts.join('\n\n');
}
