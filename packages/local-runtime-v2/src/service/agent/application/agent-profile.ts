import { dirname, join } from 'node:path';

import { toAgentRequestRef } from '@mavis/agent-tools/desktop/subagent-roles';
import type { PromptReadScope } from '@mavis/agent-runtime';
import { isPtcTurnEnabled } from '@mavis/config';

import {
  BuiltinAgentCatalog,
  canonicalBuiltinName,
  resolveCanonicalCapabilities,
  type BuiltinPtcRender,
  type BuiltinRenderInput,
} from '../builtin/catalog.js';
import { mergeBuiltinAgentSystemPrompt } from './config/builtin-canonical-files.js';
import { AgentServiceError } from '../errors.js';
import {
  toBuiltinProfile,
  toBuiltinRenderInput,
  type AgentProfileRenderContext,
} from './listing/index.js';
import {
  applyBuiltinSubagentTaskChildCeiling,
  resolveLocale,
  toCapabilityCeiling,
} from '../domain/validation.js';
import {
  PRIMARY_AGENT_NAME,
  normalizeRequestRef,
  parseExplicitNameOrStable,
} from '../domain/names.js';
import type {
  AgentAvatarAsset,
  AgentConfigurationSelection,
  AgentExecutionProfile,
  AgentProfileRequest,
  AgentStoreMeta,
  AgentStorePort,
  AgentView,
  BuiltinAgentDefinition,
  FrozenAgentExecutionDefinition,
} from '../contracts.js';
import { AgentConfigError, type CanonicalAgentConfig } from '../storage/canonical-agent-config.js';
import { isPerAgentReadAccessError } from '../storage/canonical-agent-patch.js';
import {
  isPromptSnapshotInvalidError,
  type PromptConfigService,
  type PromptReadContext,
} from '../../prompt-config/index.js';

const NO_AGENT_MEMORY = Object.freeze([]) as readonly string[];

export interface AgentProfileContextDependencies {
  readonly repository: AgentStorePort;
  readonly requireMeta: (name: string) => Promise<AgentStoreMeta>;
  readonly resolveExecutionTarget: (exactOwnerName: string) => Promise<string>;
  readonly definitionFor: (name: string) => Promise<BuiltinAgentDefinition | undefined>;
  readonly isBuiltin: (meta: AgentStoreMeta) => boolean;
  readonly resolveBuiltinReadAgentNames: (canonicalViewName: string) => Promise<readonly string[]>;
}

export interface AgentProfileRendererDependencies {
  readonly repository: AgentStorePort;
  readonly catalog: BuiltinAgentCatalog;
  readonly resolveContext: (input: AgentProfileRequest) => Promise<AgentProfileRenderContext>;
  /** Writes the bundled Builtin source only if it is still absent. */
  readonly reseedMissingBuiltinConfig?: (name: string) => Promise<void>;
}

export async function buildAgentGreetingReminder(
  input: {
    readonly readView: () => Promise<AgentView>;
    readonly renderProfile: (
      promptReadContext?: PromptReadContext | PromptReadScope,
    ) => Promise<AgentExecutionProfile>;
    readonly catalog: BuiltinAgentCatalog;
    readonly promptConfig?: Pick<PromptConfigService, 'capture' | 'captureBuiltin'>;
  },
  promptRead?: PromptReadScope,
): Promise<string> {
  const view = await input.readView();
  const render = async (
    promptReadContext?: PromptReadContext | PromptReadScope,
  ): Promise<string> => {
    const profile = await input.renderProfile(promptReadContext);
    const template = await input.catalog.readGreetingTemplate(
      profile.provenance.locale,
      promptReadContext,
    );
    const facts = [
      `agent_name: ${view.exactOwnerName}`,
      view.displayName ? `display_name: ${view.displayName}` : undefined,
      view.description ? `description: ${view.description}` : undefined,
      `persona_present: ${profile.persona?.trim() ? 'true' : 'false'}`,
    ].filter((value): value is string => Boolean(value));
    return [
      '<system-reminder>',
      'Reply in the user interface language when it is clear from context.',
      '',
      "## What's already set on you",
      ...facts,
      '',
      template,
      '</system-reminder>',
    ].join('\n');
  };
  if (promptRead) return render(promptRead);
  if (!input.promptConfig) return render();
  try {
    return await render(await input.promptConfig.capture());
  } catch (error) {
    if (!isPromptSnapshotInvalidError(error)) throw error;
    return render(await input.promptConfig.captureBuiltin());
  }
}

export async function resolveAgentProfileRenderContext(
  input: AgentProfileRequest,
  dependencies: AgentProfileContextDependencies,
): Promise<AgentProfileRenderContext> {
  const exactOwnerName = parseExplicitNameOrStable(input.exactOwnerName);
  const requestRef = normalizeRequestRef(input.requestRef ?? input.exactOwnerName);
  const meta = await dependencies.requireMeta(exactOwnerName);
  const resolvedAgentName = await dependencies.resolveExecutionTarget(exactOwnerName);
  const executionMeta = (await dependencies.repository.get(resolvedAgentName)) ?? meta;
  const canonicalViewName =
    resolvedAgentName !== exactOwnerName || dependencies.isBuiltin(meta)
      ? canonicalBuiltinName(resolvedAgentName)
      : exactOwnerName;
  const definition = dependencies.isBuiltin(executionMeta)
    ? await dependencies.definitionFor(canonicalViewName)
    : undefined;
  const capabilities = resolveCanonicalCapabilities(
    input.capabilities,
    definition?.capabilityOverride,
  );
  // A manual Agent may deliberately use a reserved canonical name. The
  // persisted row remains its owner and must not read the built-in prompt.
  const canonicalBuiltin = dependencies.isBuiltin(executionMeta) && Boolean(definition);
  const surface = input.surface ?? 'interactive';
  // Historic per-Agent memory remains on disk for recovery, but only the
  // Runtime-owned Mavis/main family is admitted to the prompt pipeline.
  const memoryReadAgentNames =
    canonicalBuiltin && canonicalViewName === PRIMARY_AGENT_NAME
      ? await dependencies.resolveBuiltinReadAgentNames(canonicalViewName)
      : NO_AGENT_MEMORY;
  return {
    input,
    requestRef,
    exactOwnerName,
    resolvedAgentName,
    canonicalViewName,
    meta,
    executionMeta,
    capabilities: applyBuiltinSubagentTaskChildCeiling({
      capabilities,
      canonicalBuiltin,
      canonicalViewName,
      surface,
    }),
    surface,
    memoryReadAgentNames,
    canonicalBuiltin,
  };
}

export function createAgentPromptSelection(
  options: Pick<AgentProfileRequest, 'promptMode' | 'promptVersion'>,
): (input: AgentProfileRequest) => AgentProfileRequest {
  const { promptMode, promptVersion } = options;
  if (promptMode !== undefined && !['tui', 'coding', 'work'].includes(promptMode)) {
    throw new Error(`Invalid prompt mode: ${String(promptMode)}`);
  }
  return (input) => (promptMode === undefined ? input : { ...input, promptMode, promptVersion });
}

export async function renderAgentProfile(
  dependencies: AgentProfileRendererDependencies,
  input: AgentProfileRequest,
  promptConfig?: Pick<PromptConfigService, 'capture' | 'captureBuiltin'>,
): Promise<AgentExecutionProfile> {
  if (input.promptProfile === 'desktop' && !input.promptReadContext && promptConfig) {
    const render = (promptReadContext: PromptReadContext) =>
      renderAgentProfile(dependencies, { ...input, promptReadContext });
    try {
      return await render(await promptConfig.capture());
    } catch (error) {
      if (!isPromptSnapshotInvalidError(error)) throw error;
      return render(await promptConfig.captureBuiltin());
    }
  }
  const context = await dependencies.resolveContext(input);
  return context.canonicalBuiltin
    ? renderBuiltinProfile(dependencies, context)
    : renderCustomProfile(dependencies, context);
}

function assertFrozenPromptSelection(
  input: AgentProfileRequest,
  definition: FrozenAgentExecutionDefinition,
): void {
  if (
    input.promptMode &&
    definition.promptSnapshot &&
    definition.promptSnapshot.mode !== input.promptMode
  ) {
    throw new Error(
      'The saved Task Prompt does not match --prompt-mode. Start a new Session for this benchmark.',
    );
  }
}

export async function renderFrozenAgentProfile(
  dependencies: AgentProfileRendererDependencies,
  input: AgentProfileRequest,
  definition: FrozenAgentExecutionDefinition,
): Promise<AgentExecutionProfile> {
  assertFrozenPromptSelection(input, definition);
  const exactOwnerName = parseExplicitNameOrStable(input.exactOwnerName);
  const configSelection = frozenConfigSelection(definition);
  const builtin = await frozenBuiltinDefinition(dependencies.catalog, exactOwnerName, definition);
  const canonicalViewName = builtin?.name ?? exactOwnerName;
  const agentRole = builtin?.role ?? 'worker';
  const surface = input.surface ?? 'interactive';
  const capabilities = applyBuiltinSubagentTaskChildCeiling({
    capabilities: resolveCanonicalCapabilities(input.capabilities, builtin?.capabilityOverride),
    canonicalBuiltin: Boolean(builtin),
    canonicalViewName,
    surface,
  });
  const snapshot = definition.promptSnapshot;
  // Frozen definitions belong to Task Sessions; they follow the Session mode
  // like every other profile path.
  const renderInput = await withPtcRender(
    dependencies.catalog,
    input,
    frozenProfileRenderInput(
      snapshot ? { ...input, promptMode: snapshot.mode } : input,
      canonicalViewName,
      surface,
      capabilities,
    ),
  );
  const [surfacePrompt, sharedBase] = await Promise.all([
    // Agent-private surface overrides were never part of the saved definition.
    snapshot && canonicalViewName === PRIMARY_AGENT_NAME && surface !== 'task-child'
      ? Promise.resolve('')
      : dependencies.catalog.renderSurfacePrompt(renderInput),
    dependencies.catalog.renderSharedBaseParts(renderInput, agentRole, {
      includeAllLayer:
        canonicalViewName !== PRIMARY_AGENT_NAME || definition.promptSnapshot === undefined,
    }),
  ]);
  return toFrozenAgentExecutionProfile({
    input,
    definition: renderFrozenDefinition(dependencies.catalog, renderInput, definition),
    builtin,
    exactOwnerName,
    canonicalViewName,
    agentRole,
    surface,
    capabilities,
    configSelection,
    surfacePrompt,
    sharedBasePrompt: sharedBase.core,
  });
}

function renderFrozenDefinition(
  catalog: BuiltinAgentCatalog,
  input: ReturnType<typeof toBuiltinRenderInput>,
  definition: FrozenAgentExecutionDefinition,
): FrozenAgentExecutionDefinition {
  if (!definition.promptSnapshot) return definition;
  const snapshot = catalog.renderPromptSnapshot(input, definition.promptSnapshot);
  return { ...definition, promptSnapshot: snapshot, systemPrompt: snapshot.systemPrompt };
}

async function frozenBuiltinDefinition(
  catalog: BuiltinAgentCatalog,
  exactOwnerName: string,
  definition: FrozenAgentExecutionDefinition,
): Promise<BuiltinAgentDefinition | undefined> {
  // Custom snapshots always capture an incarnation ID. Only the bundled
  // catalog may classify a snapshot without one; no mutable owner row is read.
  if (definition.ownerInstanceId || !(await catalog.hasBuiltin(exactOwnerName))) return undefined;
  return catalog.readDefinition(exactOwnerName);
}

function frozenProfileRenderInput(
  input: AgentProfileRequest,
  canonicalViewName: string,
  surface: AgentExecutionProfile['surface'],
  capabilities: ReturnType<typeof resolveCanonicalCapabilities>,
): ReturnType<typeof toBuiltinRenderInput> {
  return withPromptReadContext(
    {
      agentName: canonicalViewName,
      surface,
      ...(input.promptProfile === undefined ? {} : { promptProfile: input.promptProfile }),
      promptMode: input.promptMode,
      promptVersion: input.promptVersion,
      appMode: input.appMode ?? 'coding',
      locale: input.locale ?? resolveLocale(),
      promptChannel: input.promptChannel ?? 'online',
      capabilities,
      memoryEnabled: input.memoryEnabled,
      cronEnabled: input.cronEnabled,
      ...(input.dataDirToken === undefined ? {} : { dataDirToken: input.dataDirToken }),
    },
    input,
  );
}

function toFrozenAgentExecutionProfile(input: {
  readonly input: AgentProfileRequest;
  readonly definition: FrozenAgentExecutionDefinition;
  readonly builtin: BuiltinAgentDefinition | undefined;
  readonly exactOwnerName: string;
  readonly canonicalViewName: string;
  readonly agentRole: AgentExecutionProfile['agentRole'];
  readonly surface: AgentExecutionProfile['surface'];
  readonly capabilities: ReturnType<typeof resolveCanonicalCapabilities>;
  readonly configSelection: AgentConfigurationSelection;
  readonly surfacePrompt: string;
  readonly sharedBasePrompt: string;
}): AgentExecutionProfile {
  const {
    input: request,
    definition,
    builtin,
    exactOwnerName,
    canonicalViewName,
    agentRole,
    surface,
    capabilities,
    configSelection,
    surfacePrompt,
    sharedBasePrompt,
  } = input;
  return {
    skipAgentResolution: true,
    ...frozenAgentResourcePolicy(definition, builtin),
    requestRef: normalizeRequestRef(request.requestRef ?? request.exactOwnerName),
    resourceReadRef: exactOwnerName,
    exactOwnerName,
    canonicalViewName,
    resolvedAgentName: exactOwnerName,
    agentRole,
    creationSource: builtin ? 'builtin' : 'manual',
    surface,
    memoryReadAgentNames: frozenMemoryReadAgentNames(builtin),
    agentSystemPrompt: definition.systemPrompt,
    ...(definition.promptSnapshot ? { promptSnapshot: definition.promptSnapshot } : {}),
    corePrompt: [definition.systemPrompt.trim(), sharedBasePrompt.trim()]
      .filter(Boolean)
      .join('\n\n'),
    surfacePrompt,
    capabilityCeiling: toCapabilityCeiling(capabilities),
    configSelection,
    provenance: frozenProfileProvenance(request, builtin, canonicalViewName),
  };
}

function frozenAgentResourcePolicy(
  definition: FrozenAgentExecutionDefinition,
  builtin: BuiltinAgentDefinition | undefined,
): Pick<AgentExecutionProfile, 'expectedAgentInstanceId' | 'excludeAgentResources'> {
  if (definition.ownerInstanceId) return { expectedAgentInstanceId: definition.ownerInstanceId };
  return builtin ? {} : { excludeAgentResources: true };
}

function frozenMemoryReadAgentNames(
  builtin: BuiltinAgentDefinition | undefined,
): readonly string[] {
  return builtin?.name === PRIMARY_AGENT_NAME ? [PRIMARY_AGENT_NAME] : NO_AGENT_MEMORY;
}

function frozenProfileProvenance(
  input: AgentProfileRequest,
  builtin: BuiltinAgentDefinition | undefined,
  canonicalViewName: string,
): AgentExecutionProfile['provenance'] {
  return {
    source: builtin ? 'builtin' : 'custom',
    assetAgentName: canonicalViewName,
    locale: input.locale ?? resolveLocale(),
    appMode: input.appMode ?? 'coding',
    promptChannel: input.promptChannel ?? 'online',
  };
}

export async function readBuiltinAgentContent(
  catalog: BuiltinAgentCatalog,
  view: AgentView,
  canonicalName: string,
  definition: BuiltinAgentDefinition,
): Promise<AgentView & { readonly persona?: string; readonly systemPrompt?: string }> {
  const content = await catalog.readCanonicalContent({
    agentName: canonicalName,
    surface: 'interactive',
    appMode: 'coding',
    locale: resolveLocale(),
    promptChannel: 'online',
    capabilities: resolveCanonicalCapabilities(undefined, definition.capabilityOverride),
  });
  return {
    ...view,
    ...(content.persona === undefined ? {} : { persona: content.persona }),
    ...(content.systemPrompt === undefined ? {} : { systemPrompt: content.systemPrompt }),
  };
}

async function renderBuiltinProfile(
  dependencies: AgentProfileRendererDependencies,
  context: AgentProfileRenderContext,
): Promise<AgentExecutionProfile> {
  const baseRenderInput = withPromptReadContext(
    toBuiltinRenderInput(context, resolveLocale),
    context.input,
  );
  const renderInput = await withPtcRender(dependencies.catalog, context.input, baseRenderInput);
  const rendered = await dependencies.catalog.render(renderInput);
  const read = dependencies.repository.getBuiltinCanonicalConfig;
  if (!read) {
    return bundledBuiltinProfile(context, rendered);
  }
  const name = context.canonicalViewName;
  let managed: CanonicalAgentConfig;
  try {
    managed = await read.call(dependencies.repository, name);
  } catch (error) {
    if (!isBuiltinConfigReadFailure(error)) throw asAgentConfigServiceError(error);
    if (!isMissingBuiltinConfig(error) || !dependencies.reseedMissingBuiltinConfig) {
      throw await builtinConfigBrokenError(dependencies, name, error);
    }
    // The file can disappear while the runtime is running: old
    // `@minimax-ai/code` ACP clients share the data directory and delete
    // `.builtin/<name>/agent.md` on every launch, and startup is the only
    // other place that recreates it. Write it back exactly as startup seeds a
    // missing file (bundled template, never over existing content), then read
    // it again. Rendering from an in-memory baseline without the file on disk
    // is not allowed, so a failed write stops this Turn with an instruction.
    try {
      await dependencies.reseedMissingBuiltinConfig(name);
    } catch (reseedError) {
      throw await builtinConfigBrokenError(dependencies, name, reseedError, 'missing');
    }
    try {
      managed = await read.call(dependencies.repository, name);
    } catch (rereadError) {
      if (!isBuiltinConfigReadFailure(rereadError)) throw asAgentConfigServiceError(rereadError);
      throw await builtinConfigBrokenError(dependencies, name, rereadError);
    }
  }
  if (rendered.promptSnapshot) {
    const profile = await bundledBuiltinProfile(context, rendered);
    return { ...profile, configSelection: toConfigSelection(managed) };
  }
  const base = toBuiltinProfile(context, rendered, resolveLocale, toCapabilityCeiling);
  const withoutPersona = { ...base };
  delete (withoutPersona as { persona?: string }).persona;
  const sharedBasePrompt = await dependencies.catalog.renderSharedBasePrompt(
    renderInput,
    context.executionMeta.agentRole,
    { includeAllLayer: false },
  );
  return {
    ...withoutPersona,
    agentSystemPrompt: managed.systemPrompt,
    corePrompt: [managed.systemPrompt.trim(), sharedBasePrompt.trim()].filter(Boolean).join('\n\n'),
    // Canonical selectors are intersected with the ready inventory at Turn
    // admission; they are not static builtin MCP tool IDs.
    capabilityCeiling: toCapabilityCeiling(context.capabilities),
    configSelection: toConfigSelection(managed),
  };
}

async function bundledBuiltinProfile(
  context: AgentProfileRenderContext,
  rendered: Awaited<ReturnType<BuiltinAgentCatalog['render']>>,
): Promise<AgentExecutionProfile> {
  return {
    ...toBuiltinProfile(context, rendered, resolveLocale, toCapabilityCeiling),
    agentSystemPrompt: mergeBuiltinAgentSystemPrompt(
      rendered.persona,
      rendered.promptSnapshot?.systemPrompt ?? rendered.agentSystemPrompt,
    ),
  };
}

function isBuiltinConfigReadFailure(error: unknown): boolean {
  return error instanceof AgentConfigError || isPerAgentReadAccessError(error);
}

function isMissingBuiltinConfig(error: unknown): boolean {
  return error instanceof AgentConfigError && error.code === 'AGENT_CONFIG_NOT_FOUND';
}

/**
 * Startup already archived and rewrote every Builtin source it could, and a
 * missing file was just reseeded. A file that is still corrupted or unreadable
 * is not replaced by the bundled baseline on the hot path (that would silently
 * drop the user's edits); a file that could not be regenerated is not rendered
 * from memory either. The message itself is a copyable instruction that the
 * user can hand to another Agent to fix the file.
 */
async function builtinConfigBrokenError(
  dependencies: AgentProfileRendererDependencies,
  name: string,
  error: unknown,
  state: 'missing' | 'corrupted' = isMissingBuiltinConfig(error) ? 'missing' : 'corrupted',
): Promise<AgentServiceError> {
  const chinese = resolveLocale().toLowerCase().startsWith('zh');
  const filePath = join(builtinAgentDir(dependencies.repository, name), 'agent.md');
  const displayName = await builtinDisplayName(dependencies.catalog, name);
  const reason = builtinConfigFailureReason(error, chinese);
  const message = (state === 'missing' ? missingBuiltinConfigMessage : brokenBuiltinConfigMessage)(
    { displayName, filePath, reason },
    chinese,
  );
  return new AgentServiceError('BUILTIN_AGENT_CONFIG_BROKEN', message, undefined, {
    agentName: name,
    path: filePath,
    reason,
  });
}

interface BuiltinConfigMessageFacts {
  readonly displayName: string;
  readonly filePath: string;
  readonly reason: string;
}

function brokenBuiltinConfigMessage(facts: BuiltinConfigMessageFacts, chinese: boolean): string {
  const { displayName, filePath, reason } = facts;
  return chinese
    ? `内置 Agent「${displayName}」的配置文件已损坏，暂时无法回复。请复制下面这段内容，切换到其他 Agent 新建对话发送，让它帮你修复：\n\n` +
        `请修复 MiniMax Code 内置 Agent 的配置文件 \`${filePath}\`。错误：\`${reason}\`。请检查文件开头两行 \`---\` 之间的 YAML 格式并修正；如果无法修复，删除这个文件后重启 MiniMax Code，系统会按默认配置重新生成。`
    : `The configuration file of the built-in Agent "${displayName}" is broken, so it cannot reply right now. Copy the text below, switch to another Agent, and send it in a new conversation so that Agent can fix the file:\n\n` +
        `Please fix the MiniMax Code built-in Agent configuration file \`${filePath}\`. Error: \`${reason}\`. Check the YAML between the two \`---\` lines at the top of the file and correct it. If it cannot be fixed, delete the file and restart MiniMax Code; the default configuration will be regenerated.`;
}

function missingBuiltinConfigMessage(facts: BuiltinConfigMessageFacts, chinese: boolean): string {
  const { displayName, filePath, reason } = facts;
  return chinese
    ? `内置 Agent「${displayName}」的配置文件缺失，自动重新生成也失败了，暂时无法回复。请复制下面这段内容，切换到其他 Agent 新建对话发送，让它帮你修复：\n\n` +
        `请修复 MiniMax Code 内置 Agent 的配置文件 \`${filePath}\`：文件不存在，自动重新生成失败，错误：\`${reason}\`。请检查这个文件所在目录是否存在且可写，修好后重启 MiniMax Code，系统会按默认配置重新生成。`
    : `The configuration file of the built-in Agent "${displayName}" is missing and could not be regenerated, so it cannot reply right now. Copy the text below, switch to another Agent, and send it in a new conversation so that Agent can fix the file:\n\n` +
        `Please fix the MiniMax Code built-in Agent configuration file \`${filePath}\`: the file does not exist and regenerating it failed with \`${reason}\`. Check that its directory exists and is writable, then restart MiniMax Code; the default configuration will be regenerated.`;
}

function builtinAgentDir(repository: AgentStorePort, name: string): string {
  return join(dirname(repository.getAgentDir(name)), '.builtin', name);
}

async function builtinDisplayName(catalog: BuiltinAgentCatalog, name: string): Promise<string> {
  try {
    return (await catalog.readDefinition(name)).identity.displayName?.trim() || name;
  } catch {
    // The repair instruction must still reach the user if the roster is unreadable.
    return name;
  }
}

/** One line so the reason stays inside the copyable inline-code span. */
function builtinConfigFailureReason(error: unknown, chinese: boolean): string {
  if (error instanceof AgentConfigError && error.code === 'AGENT_CONFIG_NOT_FOUND') {
    return chinese ? '文件不存在' : 'file not found';
  }
  let detail = error instanceof Error ? error.message : String(error);
  if (error instanceof AgentConfigError) detail = `${error.field}: ${error.message}`;
  return detail.replace(/[\s`]+/gu, ' ').trim();
}

async function renderCustomProfile(
  dependencies: AgentProfileRendererDependencies,
  context: AgentProfileRenderContext,
): Promise<AgentExecutionProfile> {
  const baseRenderInput = withPromptReadContext(
    toBuiltinRenderInput(context, resolveLocale),
    context.input,
  );
  const renderInput = await withPtcRender(dependencies.catalog, context.input, baseRenderInput);
  const [canonical, surfacePrompt, sharedBasePrompt] = await Promise.all([
    readCanonicalAgentConfig(dependencies.repository, context.meta.name),
    dependencies.catalog.renderSurfacePrompt({
      agentName: context.exactOwnerName,
      surface: context.surface,
      ...(context.input.promptProfile === undefined
        ? {}
        : { promptProfile: context.input.promptProfile }),
      promptMode: context.input.promptMode,
      promptVersion: context.input.promptVersion,
      appMode: context.input.appMode ?? 'coding',
      locale: context.input.locale ?? resolveLocale(),
      promptChannel: context.input.promptChannel ?? 'online',
      capabilities: context.capabilities,
      memoryEnabled: context.input.memoryEnabled,
      cronEnabled: context.input.cronEnabled,
      dataDirToken: context.input.dataDirToken,
      agentConfigDir: dependencies.repository.getAgentDir(context.exactOwnerName),
      ...(context.input.promptReadContext === undefined
        ? {}
        : { promptReadContext: context.input.promptReadContext }),
      ...(renderInput.ptc ? { ptc: renderInput.ptc } : {}),
    }),
    dependencies.catalog.renderSharedBasePrompt(renderInput, context.executionMeta.agentRole),
  ]);
  return {
    requestRef: context.requestRef,
    resourceReadRef:
      toAgentRequestRef({
        name: context.exactOwnerName,
        creationSource: context.meta.creationSource,
      }) ?? context.exactOwnerName,
    exactOwnerName: context.exactOwnerName,
    canonicalViewName: context.canonicalViewName,
    resolvedAgentName: context.resolvedAgentName,
    agentRole: context.executionMeta.agentRole,
    creationSource: context.meta.creationSource,
    surface: context.surface,
    memoryReadAgentNames: context.memoryReadAgentNames,
    agentSystemPrompt: canonical.systemPrompt,
    corePrompt: [canonical.systemPrompt.trim(), sharedBasePrompt.trim()]
      .filter(Boolean)
      .join('\n\n'),
    surfacePrompt,
    capabilityCeiling: toCapabilityCeiling(context.capabilities),
    configSelection: toConfigSelection(canonical),
    provenance: {
      source: 'custom',
      assetAgentName: context.meta.name,
      locale: context.input.locale ?? resolveLocale(),
    },
  };
}

/**
 * Adds the rendered PTC section when the Session runs in PTC mode, the same
 * isPtcTurnEnabled decision the tool catalog makes from agentConfig.ptc_enabled.
 * A render without ptcRequested (listing, Task capture) keeps the native prompt
 * byte for byte.
 */
async function withPtcRender<T extends BuiltinRenderInput>(
  catalog: BuiltinAgentCatalog,
  request: AgentProfileRequest,
  renderInput: T,
): Promise<T> {
  if (!isPtcTurnEnabled({ requested: request.ptcRequested === true })) return renderInput;
  const ptc: BuiltinPtcRender = { section: await catalog.renderPtcSection(renderInput) };
  return { ...renderInput, ptc };
}

function withPromptReadContext(
  input: ReturnType<typeof toBuiltinRenderInput>,
  request: AgentProfileRequest,
): ReturnType<typeof toBuiltinRenderInput> {
  return request.promptReadContext === undefined
    ? input
    : { ...input, promptReadContext: request.promptReadContext };
}

export async function readCanonicalAgentConfig(
  repository: AgentStorePort,
  name: string,
): Promise<CanonicalAgentConfig> {
  if (!repository.getCanonicalConfig) {
    throw new AgentServiceError(
      'AGENT_CONFIG_NOT_FOUND',
      'Canonical Agent configuration storage is unavailable.',
    );
  }
  try {
    return await repository.getCanonicalConfig(name);
  } catch (error) {
    throw asAgentConfigServiceError(error);
  }
}

/** Safe Custom-avatar read shared by profile-facing Desktop transport only. */
export async function readCanonicalCustomAvatar(
  repository: AgentStorePort,
  name: string,
): Promise<AgentAvatarAsset | undefined> {
  if (!repository.readCustomAvatar) {
    throw new AgentServiceError(
      'CANONICAL_AGENT_NOT_AVAILABLE',
      'Canonical Custom Agent avatar storage is unavailable.',
    );
  }
  try {
    return await repository.readCustomAvatar(name);
  } catch (error) {
    throw asAgentConfigServiceError(error);
  }
}

function toConfigSelection(config: CanonicalAgentConfig): AgentConfigurationSelection {
  return {
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
    ...(config.xMavis?.contextWindow === undefined
      ? {}
      : { contextWindow: config.xMavis.contextWindow }),
    ...(config.xMavis?.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: config.xMavis.maxOutputTokens }),
    ...(config.tools === undefined ? {} : { tools: config.tools }),
    ...(config.disallowedTools === undefined ? {} : { disallowedTools: config.disallowedTools }),
    ...(config.mcpServers === undefined ? {} : { mcpServers: config.mcpServers }),
    ...(config.skills === undefined ? {} : { skills: config.skills }),
    ...(config.xMavis?.extensionSkills === undefined
      ? {}
      : { extensionSkills: config.xMavis.extensionSkills }),
  };
}

function frozenConfigSelection(
  definition: FrozenAgentExecutionDefinition,
): AgentConfigurationSelection {
  if (typeof definition.systemPrompt !== 'string') {
    throw new AgentServiceError(
      'AGENT_CONFIG_INVALID',
      'Frozen Agent definition systemPrompt must be a string.',
      undefined,
      { field: 'definition.systemPrompt', reason: 'must be a string' },
    );
  }
  const capabilities = definition.capabilities;
  if (!capabilities || typeof capabilities !== 'object') {
    throw new AgentServiceError(
      'AGENT_CONFIG_INVALID',
      'Frozen Agent definition capabilities must be an object.',
      undefined,
      { field: 'definition.capabilities', reason: 'must be an object' },
    );
  }
  return {
    ...copyFrozenSelector(capabilities, 'tools'),
    ...copyFrozenSelector(capabilities, 'disallowedTools'),
    ...copyFrozenSelector(capabilities, 'mcpServers'),
    ...copyFrozenSelector(capabilities, 'skills'),
    ...copyFrozenSelector(capabilities, 'extensionSkills'),
  };
}

function copyFrozenSelector(
  capabilities: FrozenAgentExecutionDefinition['capabilities'],
  key: keyof FrozenAgentExecutionDefinition['capabilities'],
): Partial<AgentConfigurationSelection> {
  const value = capabilities[key];
  if (value === undefined) return {};
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new AgentServiceError(
      'AGENT_CONFIG_INVALID',
      `Frozen Agent definition ${key} must be a string array.`,
      undefined,
      { field: `definition.capabilities.${key}`, reason: 'must be a string array' },
    );
  }
  return { [key]: [...value] };
}

export function asAgentConfigServiceError(error: unknown): Error {
  if (!(error instanceof AgentConfigError))
    return error instanceof Error ? error : new Error(String(error));
  return new AgentServiceError(
    error.code,
    `Agent configuration ${error.field}: ${error.message}`,
    undefined,
    { field: error.field, reason: error.message },
  );
}
