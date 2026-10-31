import type { RuntimeTool, RuntimeToolSource } from '@mavis/agent-core/tools';
import type { PiTurnRunnerLogger } from '@mavis/agent-core/pi-turn-runner';
import {
  createLocalBashToolDefinition,
  resolveLocalBashShell,
} from '@mavis/agent-tools/desktop';
import {
  filterCanonicalNativeToolCeiling,
  createMcpInvokeTool,
  createToolSearchTool,
  createPtcMavisTools,
  getMcpInvokeRegistries,
  getSuppressedToolNamesForModelCapabilities,
  isCanonicalBuiltinTurn,
  modelInWhitelist,
  planMcpDisclosure,
  renderMcpToolSearchHintBlock,
  withLocalBrowserObserve,
  type McpDisclosureOptions,
  type McpToolEntry,
} from '@mavis/agent-tools';
import {
  AGENT_BUILTIN_MCP_TOOL_IDS,
  AGENT_BUILTIN_TOOL_IDS,
  isPtcTurnEnabled as isSharedPtcTurnEnabled,
} from '@mavis/config';
import type { IModelCapabilities } from '@mavis/protocol';
import type { AgentHostTurnCapabilityView } from './turn-capability-lifecycle.js';
import type { HostCapabilityResolver } from './host-capability/contracts.js';
import { getBrowserHostBinding } from './host-capability/browser.js';
import { mergeAgentHostTurnCapabilities } from './local-turn-plugin-capabilities.js';
import { createPtcRunCodeTool } from '../runner/ptc/run-code-tool.js';
import { registerPtcNativeCatalog, registerPtcTurnReminder } from '../execution/ptc/catalog.js';
import type { PtcReturnArtifactWriter } from '../execution/ptc/return-spill.js';
import {
  isPtcChildTool,
  isPtcDirectMcpTarget,
  isPtcDirectTool,
} from '../runner/policy/local-turn-tool-ptc-policy.js';
import type {
  LocalAgentCapabilityCeiling,
  LocalAgentConfigurationSelection,
  LocalAgentExecutionProfile,
} from '../preparation/contracts.js';

export function prepareBashTurnTools(
  admittedTools: readonly RuntimeTool[],
  background: boolean,
  nativeDelete = false,
) {
  const hasNativeBash = admittedTools.some(
    (tool) => tool.def.name === 'bash' && (tool.source === undefined || tool.source === 'builtin'),
  );
  const bashCapabilities = {
    background,
    shell: hasNativeBash ? resolveLocalBashShell() : ('unavailable' as const),
    nativeDelete,
  };
  return admittedTools.map((tool) => {
    if (tool.def.name !== 'bash' || (tool.source !== undefined && tool.source !== 'builtin'))
      return tool;
    const definition = createLocalBashToolDefinition(bashCapabilities);
    return {
      ...tool,
      def: { ...tool.def, schema: definition.schema, description: definition.description },
    };
  });
}

export interface LocalTurnRawToolSources {
  readonly nativeTools: readonly RuntimeTool[];
  readonly mcpEntries: readonly McpToolEntry[];
  readonly threadGoalTools: readonly RuntimeTool[];
  readonly cuRuntimeAvailable: boolean;
}

export interface LocalMcpToolSearchConfig {
  readonly enabled?: boolean;
  readonly modelWhitelist?: readonly string[];
  readonly thresholdPct?: number;
  readonly minDeferCount?: number;
  readonly topKDefault?: number;
  readonly topKMax?: number;
  readonly systemHint?: boolean;
  readonly maxSchemaTextLen?: number;
}

export interface LocalTurnToolCatalog {
  readonly tools: readonly RuntimeTool[];
  readonly userPromptPrefix: string;
}

export interface LocalTurnAgentProfileFacts {
  readonly excludeAgentResources?: boolean;
  readonly skipAgentResolution?: boolean;
  readonly expectedAgentInstanceId?: string;
  readonly capabilityCeiling: LocalAgentCapabilityCeiling;
  readonly canonicalRole?: string;
  readonly trustedBuiltin: boolean;
  readonly surface: LocalAgentExecutionProfile['surface'];
  /** Explicitly false disables all agent-scoped Memory operations for this Turn. */
  readonly agentMemoryEnabled?: boolean;
  /** Canonical-first Runtime Memory aliases, valid only when agent Memory is enabled. */
  readonly agentMemoryReadNames?: readonly string[];
  /** Raw Agent selectors; every value is intersected with this Turn's inventory. */
  readonly configSelection?: Pick<
    LocalAgentConfigurationSelection,
    | 'tools'
    | 'disallowedTools'
    | 'mcpServers'
    | 'skills'
    | 'extensionSkills'
    | 'frozenSelectorVersion'
  >;
  /**
   * Whether `configSelection.tools` also limits MCP and Plugin tools
   * (`isAgentSelectorMcpToolName`). Omitted: decided from `tools`
   * (`resolveToolsAllowlistScope`). Only Task capture sets it, in memory, to
   * the scope of the list the author wrote, because Plugin alias rebinding can
   * drop the `mcp__*` names that decide it.
   */
  readonly toolsAllowlistScope?: LocalAgentToolsAllowlistScope;
}

/**
 * How `tools` treats MCP tools (`isAgentSelectorMcpToolName`). `native`: the
 * list does not limit them. `all`: the list names `mcp__*` tools, so it
 * limits every tool.
 */
export type LocalAgentToolsAllowlistScope = 'native' | 'all';

export interface BuildLocalTurnToolCatalogInput {
  readonly sessionId: string;
  /** Log correlation only. */
  readonly turnId?: string;
  /** Log correlation only. */
  readonly agentName?: string;
  readonly sources: LocalTurnRawToolSources;
  readonly llmModel: {
    readonly provider: string;
    readonly id: string;
    readonly contextWindow: number;
  };
  readonly modelCapabilities?: IModelCapabilities;
  readonly agentProfile?: LocalTurnAgentProfileFacts;
  readonly config?: LocalMcpToolSearchConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly emitDiagnostic?: (type: string, payload: Readonly<Record<string, unknown>>) => void;
  /** Structured log sink; PTC Turns record how Tool Search's long tail was made callable. */
  readonly logger?: Pick<PiTurnRunnerLogger, 'info'>;
  readonly desktopCapabilities?: AgentHostTurnCapabilityView;
  readonly hostCapabilityRegistry?: HostCapabilityResolver;
  readonly effectivePluginSkills?: readonly {
    readonly pluginName: string;
    readonly name: string;
  }[];
  readonly userText?: string;
  /** Trusted local top-level provenance and beta state, frozen before assembly. */
  readonly ptcEnabled?: boolean;
  /** Where run_code saves a return value over 64 KiB (Session tool-output artifacts). */
  readonly writePtcReturnArtifact?: PtcReturnArtifactWriter;
}

/** The already-gated inventory shared by Turn assembly and Task capture. */
export interface FilteredLocalTurnCapabilityInventory {
  readonly selector: LocalAgentCapabilitySelector;
  readonly nativeTools: readonly RuntimeTool[];
  readonly mcpEntries: readonly McpToolEntry[];
  readonly threadGoalTools: readonly RuntimeTool[];
  readonly desktopCapabilities?: AgentHostTurnCapabilityView;
  /** Present only when the Agent declares a `tools` allowlist; counts only. */
  readonly selectorSummary?: LocalAgentToolSelectorSummary;
}

/**
 * How the Agent selectors treated MCP tools (`isAgentSelectorMcpToolName`) and
 * Plugin App tools (Plugin tools without an `mcp__` name) this Turn.
 */
interface LocalAgentToolSelectorSummary {
  readonly toolsAllowlistSize: number;
  readonly toolsAllowlistScope: LocalAgentToolsAllowlistScope;
  /** The Task snapshot's `selectorVersion` (`legacy` without one); absent off a snapshot. */
  readonly frozenSelectorVersion?: 2 | 'legacy';
  readonly mcpTotal: number;
  readonly mcpKept: number;
  readonly mcpBlockedByServerSelector: number;
  readonly mcpBlockedByDisallowed: number;
  readonly mcpBlockedByToolsAllowlist: number;
  readonly pluginAppTotal: number;
  readonly pluginAppKept: number;
}

type LocalAgentMcpOutcome =
  | 'mcpKept'
  | 'mcpBlockedByServerSelector'
  | 'mcpBlockedByDisallowed'
  | 'mcpBlockedByToolsAllowlist';

/**
 * Applies only present-turn gates and Agent selectors to ready capability
 * inventories. It intentionally does not create disclosure tools, so a Task
 * capture can freeze the same allowed IDs without owning a second catalog.
 */
export function filterLocalTurnCapabilityInventory(input: {
  readonly sources: LocalTurnRawToolSources;
  readonly modelCapabilities?: IModelCapabilities;
  readonly agentProfile?: LocalTurnAgentProfileFacts;
  readonly desktopCapabilities?: AgentHostTurnCapabilityView;
  readonly hostCapabilityRegistry?: HostCapabilityResolver;
}): FilteredLocalTurnCapabilityInventory {
  const excludedNames = getSuppressedToolNamesForModelCapabilities(input.modelCapabilities);
  const profile = input.agentProfile;
  const selector = createLocalAgentCapabilitySelector(
    profile?.configSelection,
    profile?.toolsAllowlistScope,
  );
  const hasBrowserHostAlias = Boolean(
    input.hostCapabilityRegistry &&
    (profile?.surface ?? 'interactive') === 'interactive' &&
    input.desktopCapabilities?.hostBindings?.some(
      (binding) =>
        binding.hostCapability.id === 'browser.use' &&
        binding.hostCapability.version === 1 &&
        binding.allowedSurfaces.includes('interactive'),
    ),
  );
  const keep = (
    tool: RuntimeTool,
    source: RuntimeToolSource,
    options: LocalTurnToolKeepOptions = {},
  ): boolean =>
    isReadyTurnToolAllowed({
      tool,
      source,
      options,
      excludedNames,
      cuRuntimeAvailable: input.sources.cuRuntimeAvailable,
      selector,
      profile,
    });
  const nativeTools = filterCanonicalNativeToolCeiling(
    input.sources.nativeTools.filter((tool) =>
      keep(
        tool,
        'builtin',
        hasBrowserHostAlias && tool.def.name === 'browser' ? { selectorAlias: 'mcp_browser' } : {},
      ),
    ),
    profile?.canonicalRole,
    profile?.trustedBuiltin === true,
  );
  // Selected by name like every tool (`isAgentSelectorMcpToolName`), with no
  // role-specific MCP filter: explore / verifier get MCP tools on the same
  // terms as other Agents. Matrix tools (no `mcp__` prefix) are ordinary tools,
  // still limited by `tools` and the `builtinTools` / `features` ceiling.
  const mcpEntries = input.sources.mcpEntries.filter(({ tool, source, serverName }) =>
    keep(tool, source, serverName ? { serverName } : {}),
  );
  const threadGoalTools = resolveThreadGoalTools(
    profile,
    input.sources.threadGoalTools.filter((tool) => keep(tool, 'builtin')),
  );
  const desktopCapabilities = input.desktopCapabilities
    ? filterDesktopCapabilities(input.desktopCapabilities, keep)
    : undefined;
  return {
    selector,
    nativeTools,
    mcpEntries,
    threadGoalTools,
    ...(desktopCapabilities ? { desktopCapabilities } : {}),
    ...selectorSummaryFor({
      profile,
      selector,
      raw: [...input.sources.mcpEntries, ...desktopToolServers(input.desktopCapabilities)],
      kept: [...mcpEntries.map(({ tool }) => tool), ...(desktopCapabilities?.runtimeTools ?? [])],
      rawPluginTools: input.desktopCapabilities?.runtimeTools ?? [],
    }),
  };
}

interface LocalTurnToolKeepOptions {
  /** The MCP server an `mcp__*` tool belongs to, checked against `mcpServers`. */
  readonly serverName?: string;
  readonly selectorAlias?: string;
  /** A Plugin tool; see `LocalAgentCapabilitySelector.allowsTool`. */
  readonly pluginTool?: boolean;
}

interface LocalTurnToolWithServer {
  readonly tool: RuntimeTool;
  readonly serverName?: string;
}

function selectorSummaryFor(input: {
  readonly profile: LocalTurnAgentProfileFacts | undefined;
  readonly selector: LocalAgentCapabilitySelector;
  readonly raw: readonly LocalTurnToolWithServer[];
  readonly kept: readonly RuntimeTool[];
  readonly rawPluginTools: readonly RuntimeTool[];
}): { readonly selectorSummary?: LocalAgentToolSelectorSummary } {
  const allowlist = input.profile?.configSelection?.tools;
  if (allowlist === undefined) return {};
  const kept = new Set(input.kept);
  const mcpTools = input.raw.filter(({ tool }) => isAgentSelectorMcpToolName(tool.def.name));
  const counts: Record<LocalAgentMcpOutcome, number> = {
    mcpKept: 0,
    mcpBlockedByServerSelector: 0,
    mcpBlockedByDisallowed: 0,
    mcpBlockedByToolsAllowlist: 0,
  };
  for (const entry of mcpTools) {
    const outcome = kept.has(entry.tool) ? 'mcpKept' : mcpBlockReason(input.selector, entry);
    if (outcome) counts[outcome] += 1;
  }
  const pluginApps = input.rawPluginTools.filter(
    (tool) => !isAgentSelectorMcpToolName(tool.def.name),
  );
  return {
    selectorSummary: {
      toolsAllowlistSize: new Set(allowlist.map(normalizedSelectorName).filter(Boolean)).size,
      toolsAllowlistScope:
        input.profile?.toolsAllowlistScope ?? resolveToolsAllowlistScope(allowlist),
      ...(input.profile?.configSelection?.frozenSelectorVersion === undefined
        ? {}
        : { frozenSelectorVersion: input.profile.configSelection.frozenSelectorVersion }),
      mcpTotal: mcpTools.length,
      ...counts,
      pluginAppTotal: pluginApps.length,
      pluginAppKept: pluginApps.filter((tool) => kept.has(tool)).length,
    },
  };
}

/** The selector that removed an MCP tool; undefined when a model, ceiling or surface gate did. */
function mcpBlockReason(
  selector: LocalAgentCapabilitySelector,
  { tool, serverName }: LocalTurnToolWithServer,
): LocalAgentMcpOutcome | undefined {
  // `featureOwned` skips only the `tools` allowlist: this is `disallowedTools` alone.
  if (!selector.allowsTool(tool.def.name, undefined, { featureOwned: true }))
    return 'mcpBlockedByDisallowed';
  if (!selector.allowsTool(tool.def.name)) return 'mcpBlockedByToolsAllowlist';
  if (!selector.allowsMcpServer(serverName)) return 'mcpBlockedByServerSelector';
  return undefined;
}

/** Plugin tools with the MCP server only an MCP binding can prove. */
function desktopToolServers(
  capabilities: AgentHostTurnCapabilityView | undefined,
): readonly LocalTurnToolWithServer[] {
  if (!capabilities) return [];
  const bindings = new Map(
    capabilities.runtimeToolBindings.map((binding) => [binding.tool, binding]),
  );
  return capabilities.runtimeTools.map((tool) => {
    const binding = bindings.get(tool);
    return binding?.kind === 'mcp' ? { tool, serverName: binding.source } : { tool };
  });
}

/**
 * V2-owned final catalog policy used by the local AgentRuntime extension.
 * Product domains provide raw tools only; model gates, MCP disclosure and the
 * prompt hint are decided here from the frozen turn/model facts.
 */
export function buildLocalTurnToolCatalog(
  input: BuildLocalTurnToolCatalogInput,
): LocalTurnToolCatalog {
  const options = resolveLocalMcpDisclosureOptions(input.config, input.env);
  // Decided before disclosure only to pick wording: deferral itself follows the
  // same switch, whitelist and threshold with or without PTC.
  const ptc = isPtcTurnEnabled(input);
  const excludedNames = getSuppressedToolNamesForModelCapabilities(input.modelCapabilities);
  const inventory = filterLocalTurnCapabilityInventory(input);
  logAgentToolSelectorSummary(input, inventory.selectorSummary);
  const { nativeTools, mcpEntries, threadGoalTools } = inventory;
  const model = input.llmModel;
  const plan = planMcpDisclosure({ entries: mcpEntries, model, options });
  const tools = plan.deferred
    ? [
        ...nativeTools,
        ...plan.inlineTools,
        createToolSearchTool(plan.index, {
          topKDefault: options.topKDefault,
          topKMax: options.topKMax,
        }),
        createMcpInvokeTool(plan.deferredRegistry),
        ...threadGoalTools,
      ]
    : [
        ...nativeTools,
        ...plan.inlineTools,
        ...(input.hostCapabilityRegistry ? [createMcpInvokeTool(new Map())] : []),
        ...threadGoalTools,
      ];

  if (excludedNames.size > 0) {
    input.emitDiagnostic?.('mcp.tools_suppressed_by_model_capability', {
      sessionId: input.sessionId,
      suppressedToolNames: [...excludedNames],
      supportImage: input.modelCapabilities?.support_image === true,
      supportVideo: input.modelCapabilities?.support_video === true,
    });
  }
  const desktopCapabilities = inventory.desktopCapabilities;
  const effectivePluginSkills = filterExtensionSkills(
    input.effectivePluginSkills ?? [],
    inventory.selector,
  );
  const merged = mergeAgentHostTurnCapabilities({
    tools,
    plan,
    model,
    options,
    effectivePluginSkills,
    surface: input.agentProfile?.surface ?? 'interactive',
    ...(input.hostCapabilityRegistry
      ? { hostCapabilityRegistry: input.hostCapabilityRegistry }
      : {}),
    ...(input.userText !== undefined ? { userText: input.userText } : {}),
    ...(desktopCapabilities ? { capabilities: desktopCapabilities } : {}),
    ...(ptc ? { ptc: true } : {}),
  });
  input.emitDiagnostic?.('mcp.tools_deferred', {
    sessionId: input.sessionId,
    deferred: merged.plan.deferred,
    whitelisted: modelInWhitelist(model.provider, model.id, options.modelWhitelist),
    model: `${model.provider}/${model.id}`,
    ...(merged.plan.deferred ? merged.plan.stats : {}),
  });
  // When a Plugin declares an App, Attribution wraps bash (App calls go through
  // it); the wrapper runs the same native implementation, so it is the native
  // tool run_code lists and must keep its builtin evidence and data type.
  const trustedNativeTools = merged.attributed
    ? nativeTools.map((tool) => merged.attributed?.get(tool) ?? tool)
    : nativeTools;
  const catalog = resolvedTurnCatalog(merged.tools, ptc, trustedNativeTools, input);
  return {
    tools: catalog.tools,
    userPromptPrefix: renderUserPromptPrefix(
      merged.reminder,
      merged.plan.deferred,
      options.systemHint,
      ptc,
    ),
  };
}

function resolvedTurnCatalog(
  tools: readonly RuntimeTool[],
  ptc: boolean,
  trustedNativeTools: readonly RuntimeTool[],
  input: PtcCatalogInput,
): {
  readonly tools: readonly RuntimeTool[];
  readonly reminder: string;
  /** run_code's listed children on a PTC Turn; empty otherwise. */
  readonly childTools: readonly RuntimeTool[];
} {
  return ptc
    ? buildPtcCatalog(tools, trustedNativeTools, input)
    : { tools, reminder: '', childTools: [] };
}

function isPtcTurnEnabled(input: BuildLocalTurnToolCatalogInput): boolean {
  // Same function and the same Session mode as the system prompt's ptc.enabled
  // (agent-profile.ts), so the prompt never promises run_code-only tools on a
  // Turn whose catalog kept them native, or the reverse.
  return isSharedPtcTurnEnabled({ requested: input.ptcEnabled === true });
}

type PtcCatalogInput = Pick<
  BuildLocalTurnToolCatalogInput,
  'sessionId' | 'logger' | 'hostCapabilityRegistry' | 'writePtcReturnArtifact'
>;

function buildPtcCatalog(
  tools: readonly RuntimeTool[],
  trustedNativeTools: readonly RuntimeTool[],
  input: PtcCatalogInput,
): {
  readonly tools: readonly RuntimeTool[];
  readonly reminder: string;
  readonly childTools: readonly RuntimeTool[];
} {
  const onDemand = splitPtcOnDemandTools(tools, reservesInlineGateway(input));
  logPtcOnDemandTools(input, onDemand);
  const observable = withPtcBrowserObserve(
    onDemand.tools.filter(isPtcChildTool),
    trustedNativeTools,
  );
  const { childTools, directTools } = withPtcMavisTools(
    observable.childTools,
    onDemand.tools.filter(isPtcDirectTool),
    observable.trustedNativeTools,
  );
  // Name the hidden tools so the model does not spend a turn calling one directly
  // (the pilot lost three turns that way). Catalog order matches the run_code SDK.
  const childToolNames = childTools.map((tool) => tool.def.name);
  const reminder = [
    'PTC is enabled for this turn. Use run_code with await tools.<name>(args) for eligible ordinary tools and explicitly return a JSON result. Keep the visible control tools as direct calls. Do not call run_code from inside run_code.',
    ...(childToolNames.length > 0
      ? [
          `These tools are only callable inside run_code in this turn: ${childToolNames.join(', ')}.`,
        ]
      : []),
  ].join(' ');
  // The same string goes into the user prompt prefix and onto run_code, so the
  // executor can put it back verbatim after compaction drops that user message.
  // The long tail is callable but stays out of this list and the run_code SDK:
  // listing it would put back the definitions Tool Search keeps out.
  const runCode = registerPtcNativeCatalog(
    registerPtcTurnReminder(
      createPtcRunCodeTool(
        childTools,
        input.writePtcReturnArtifact ? { writeReturnArtifact: input.writePtcReturnArtifact } : {},
        observable.trustedNativeTools,
        onDemand.callable,
      ),
      reminder,
    ),
    tools,
  );
  return { tools: [runCode, ...directTools], reminder, childTools };
}

/**
 * The Desktop mavis tool on a PTC Turn: run_code lists one mavis_* tool per
 * orchestrable command (createPtcMavisTools) in place of one mavis child, so a
 * program reads each command's own arguments, and the top-level mavis keeps
 * only agent create, session send and their help. Without this the same
 * mavis was listed in both places with every command, and a call in the wrong
 * place was refused only after the model had made it. run_code still runs
 * each call as mavis({ command, args }), so permission rules and Plugin hooks
 * keep matching tool `mavis`. Only the trusted native mavis is split; a Turn
 * without it (TUI, PTC off) keeps its catalog byte for byte.
 */
function withPtcMavisTools(
  childTools: readonly RuntimeTool[],
  directTools: readonly RuntimeTool[],
  trustedNativeTools: readonly RuntimeTool[],
): { readonly childTools: readonly RuntimeTool[]; readonly directTools: readonly RuntimeTool[] } {
  const trusted = new Set(trustedNativeTools);
  const mavis = directTools.find((tool) => tool.def.name === 'mavis' && trusted.has(tool));
  if (!mavis || !childTools.includes(mavis)) return { childTools, directTools };
  const split = createPtcMavisTools(mavis);
  return {
    childTools: childTools.flatMap((tool) => (tool === mavis ? split.children : [tool])),
    directTools: directTools.map((tool) => (tool === mavis ? split.direct : tool)),
  };
}

/**
 * Inside run_code the Browser child (native `browser`, or the Plugin-bound
 * `mcp_browser`, whose definition is the same compact one renamed) is the
 * variant that declares `observe` (withLocalBrowserObserve). The run_code SDK,
 * child-call validation and a direct call of the hidden child all read this
 * catalog, so they see the same variant; a Turn without PTC lists the
 * original Browser and keeps its definition byte for byte. The variant takes
 * the original's place in the trusted native list, so its evidence source and
 * data shape stay builtin; the spread keeps the Host Binding of `mcp_browser`.
 */
function withPtcBrowserObserve(
  childTools: readonly RuntimeTool[],
  trustedNativeTools: readonly RuntimeTool[],
): {
  readonly childTools: readonly RuntimeTool[];
  readonly trustedNativeTools: readonly RuntimeTool[];
} {
  const trusted = new Set(trustedNativeTools);
  const variants = new Map<RuntimeTool, RuntimeTool>();
  const children = childTools.map((tool) => {
    const browser =
      (tool.def.name === 'browser' && trusted.has(tool)) ||
      getBrowserHostBinding(tool) !== undefined;
    const def = browser ? withLocalBrowserObserve(tool.def) : undefined;
    if (!def) return tool;
    const variant: RuntimeTool = { ...tool, def };
    variants.set(tool, variant);
    return variant;
  });
  if (variants.size === 0) return { childTools, trustedNativeTools };
  return {
    childTools: children,
    trustedNativeTools: trustedNativeTools.map((tool) => variants.get(tool) ?? tool),
  };
}

interface PtcOnDemandSplit {
  /** Final catalog with the name-routed mcp_invoke narrowed or removed. */
  readonly tools: readonly RuntimeTool[];
  /** Tool Search long tail callable inside run_code without an SDK entry. */
  readonly callable: readonly RuntimeTool[];
  /** Long-tail names already used by a listed tool; they stay behind mcp_invoke. */
  readonly nameConflicts: number;
  /** The gateway routes nothing and stays only because the Host reserved it (Desktop). */
  readonly hostReservedOnly?: boolean;
}

/**
 * Tool Search's result decides the long tail; no PTC-specific rule is added.
 * After buildToolLoadingCatalog the mcp_invoke name registry holds exactly
 * this Turn's deferred tools: MCP and App tools plus on-demand built-ins (cron_*).
 * Inside a program a name-routed gateway is a needless hop, so every target
 * that is an ordinary PTC child becomes a run_code child of its own, with its
 * own schema, permission source and hooks. mcp_invoke stays only for what it
 * still routes, unchanged: Plugin Skill `tool_ref` references and targets
 * that are not PTC children. With neither, the gateway is removed.
 *
 * Tool loading now attaches an empty gateway to every Turn. When nothing moves
 * (no deferral this Turn) that gateway has no reason on a PTC Turn either and
 * is removed, so run_code gains no `tools.mcp_invoke`. The one exception is
 * the gateway the Host reserves (`reservedByHost`, Desktop): it was on every
 * Desktop Turn before tool loading and stays a run_code child as it was.
 */
function splitPtcOnDemandTools(
  tools: readonly RuntimeTool[],
  reservedByHost: boolean,
): PtcOnDemandSplit {
  const gateway = tools.find((tool) => tool.def.name === 'mcp_invoke');
  const registries = gateway ? getMcpInvokeRegistries(gateway) : undefined;
  if (!gateway || !registries) return { tools, callable: [], nameConflicts: 0 };
  const listedNames = new Set(
    tools.filter((tool) => tool !== gateway).map((tool) => tool.def.name),
  );
  const { callable, kept, nameConflicts } = partitionGatewayTargets(
    registries.registry,
    listedNames,
  );
  const routesSomething = kept.size > 0 || registries.referenceRegistry.size > 0;
  if (callable.length === 0 && (reservedByHost || routesSomething)) {
    return {
      tools,
      callable,
      nameConflicts,
      ...(routesSomething ? {} : { hostReservedOnly: true }),
    };
  }
  const narrowed = narrowedGateway(gateway, kept, registries.referenceRegistry);
  return {
    tools: tools.flatMap((tool) => {
      if (tool !== gateway) return [tool];
      return narrowed ? [narrowed] : [];
    }),
    callable,
    nameConflicts,
  };
}

function partitionGatewayTargets(
  registry: ReadonlyMap<string, RuntimeTool>,
  listedNames: ReadonlySet<string>,
): {
  readonly callable: readonly RuntimeTool[];
  readonly kept: ReadonlyMap<string, RuntimeTool>;
  readonly nameConflicts: number;
} {
  const callable: RuntimeTool[] = [];
  const kept = new Map<string, RuntimeTool>();
  let nameConflicts = 0;
  for (const [name, target] of registry) {
    if (isPtcDirectMcpTarget(target)) {
      kept.set(name, target);
    } else if (listedNames.has(target.def.name)) {
      // run_code exposes one function per name; a second one would break the
      // guest setup, so this target keeps today's mcp_invoke route.
      kept.set(name, target);
      nameConflicts += 1;
    } else {
      callable.push(target);
    }
  }
  return { callable, kept, nameConflicts };
}

/** The gateway for what it still routes, unchanged; undefined when nothing is left. */
function narrowedGateway(
  gateway: RuntimeTool,
  kept: ReadonlyMap<string, RuntimeTool>,
  references: NonNullable<ReturnType<typeof getMcpInvokeRegistries>>['referenceRegistry'],
): RuntimeTool | undefined {
  if (kept.size === 0 && references.size === 0) return undefined;
  return {
    ...createMcpInvokeTool(kept, references),
    ...(gateway.toolCallProvenanceResolver
      ? { toolCallProvenanceResolver: gateway.toolCallProvenanceResolver }
      : {}),
  };
}

/** Counts and booleans only: no tool names, arguments or schemas. */
function logPtcOnDemandTools(
  input: Pick<BuildLocalTurnToolCatalogInput, 'sessionId' | 'logger'>,
  split: PtcOnDemandSplit,
): void {
  const gateway = split.tools.find((tool) => tool.def.name === 'mcp_invoke');
  const references = gateway ? getMcpInvokeRegistries(gateway)?.referenceRegistry : undefined;
  try {
    input.logger?.info?.(
      {
        session_id: input.sessionId,
        callable_mcp_tools: split.callable.filter((tool) => tool.source === 'configured').length,
        callable_builtin_tools: split.callable.filter((tool) => tool.source !== 'configured')
          .length,
        mcp_invoke_kept: gateway !== undefined,
        mcp_invoke_tool_ref: (references?.size ?? 0) > 0,
        mcp_invoke_direct_target: gateway ? isPtcDirectTool(gateway) : false,
        ...(split.nameConflicts > 0 ? { name_conflicts: split.nameConflicts } : {}),
        ...(split.hostReservedOnly ? { mcp_invoke_host_reserved: true } : {}),
      },
      'ptc on-demand tools resolved',
    );
  } catch {
    // Diagnostics must not affect the Turn.
  }
}

/**
 * One line per catalog build for an Agent with a `tools` allowlist, so a
 * Session can show whether its MCP tools (`isAgentSelectorMcpToolName`)
 * reached the model and which selector removed the rest. Counts only: no tool
 * names or arguments.
 */
function logAgentToolSelectorSummary(
  input: Pick<
    BuildLocalTurnToolCatalogInput,
    'sessionId' | 'turnId' | 'agentName' | 'agentProfile' | 'logger'
  >,
  summary: LocalAgentToolSelectorSummary | undefined,
): void {
  if (!summary) return;
  const profile = input.agentProfile;
  try {
    input.logger?.info?.(
      {
        event: 'agent_tool_selector_summary',
        session_id: input.sessionId,
        ...(input.turnId ? { turn_id: input.turnId } : {}),
        ...(input.agentName ? { agent_name: input.agentName } : {}),
        ...(profile?.canonicalRole ? { canonical_role: profile.canonicalRole } : {}),
        trusted_builtin: profile?.trustedBuiltin === true,
        surface: profile?.surface ?? 'interactive',
        tools_allowlist_size: summary.toolsAllowlistSize,
        tools_allowlist_scope: summary.toolsAllowlistScope,
        ...(summary.frozenSelectorVersion === undefined
          ? {}
          : { frozen_selector_version: summary.frozenSelectorVersion }),
        mcp_total: summary.mcpTotal,
        mcp_kept: summary.mcpKept,
        mcp_blocked_by_server_selector: summary.mcpBlockedByServerSelector,
        mcp_blocked_by_disallowed: summary.mcpBlockedByDisallowed,
        mcp_blocked_by_tools_allowlist: summary.mcpBlockedByToolsAllowlist,
        plugin_app_total: summary.pluginAppTotal,
        plugin_app_kept: summary.pluginAppKept,
      },
      '[local-runtime-v2] agent tool selector summary',
    );
  } catch {
    // Diagnostics must not affect the Turn.
  }
}

function createInlineHostGateway(input: BuildLocalTurnToolCatalogInput): readonly RuntimeTool[] {
  return reservesInlineGateway(input) ? [createMcpInvokeTool(new Map())] : [];
}

/** Preserve Desktop's gateway; CLI and its children add it only for real refs/deferred tools. */
function reservesInlineGateway(
  input: Pick<BuildLocalTurnToolCatalogInput, 'hostCapabilityRegistry'>,
): boolean {
  return (
    input.hostCapabilityRegistry !== undefined &&
    input.hostCapabilityRegistry.reserveInlineGateway !== false
  );
}

export interface LocalAgentCapabilitySelector {
  /**
   * `featureOwned`: a builtin Tool its Feature alone gates for this Agent
   * (`web_search` under `features.webSearch` on a trusted builtin role). Its
   * `tools` allowlist cannot name it, so only `disallowedTools` applies here.
   *
   * `pluginTool`: a Plugin (App or MCP) tool. A `native`-scope `tools` list
   * limits neither Plugin tools nor MCP tools (`isAgentSelectorMcpToolName`);
   * an MCP tool's server is checked separately by `allowsMcpServer`.
   */
  allowsTool(
    name: string,
    hostAlias?: string,
    options?: { featureOwned?: boolean; pluginTool?: boolean },
  ): boolean;
  allowsMcpServer(serverName: string | undefined): boolean;
  allowsSkill(name: string): boolean;
  allowsExtensionSkill(pluginName: string, name: string): boolean;
}

function isReadyTurnToolAllowed(input: {
  readonly tool: RuntimeTool;
  readonly source: RuntimeToolSource;
  readonly options: LocalTurnToolKeepOptions;
  readonly excludedNames: ReadonlySet<string>;
  readonly cuRuntimeAvailable: boolean;
  readonly selector: LocalAgentCapabilitySelector;
  readonly profile: LocalTurnAgentProfileFacts | undefined;
}): boolean {
  if (input.excludedNames.has(input.tool.def.name)) return false;
  if (!isDesktopToolAvailable(input.tool, input.cuRuntimeAvailable)) return false;
  if (
    !input.selector.allowsTool(input.tool.def.name, input.options.selectorAlias, {
      featureOwned: isFeatureOwnedBuiltinTool(input.profile, input.tool.def.name, input.source),
      pluginTool: input.options.pluginTool === true,
    })
  )
    return false;
  if (!isMcpServerAllowed(input.selector, input.tool.def.name, input.options.serverName))
    return false;
  if (
    (DELEGATION_TOOL_NAMES.has(input.tool.def.name) ||
      (input.source !== 'builtin' && TASK_CONTROL_TOOL_NAMES.has(input.tool.def.name))) &&
    !isAuthoritativeMainProfile(input.profile)
  ) {
    return false;
  }
  if (!input.profile) return true;
  return isProfileToolAllowed(input.profile, input.tool, input.source);
}

/**
 * Builtin `web_search` (native or Matrix) is owned by `features.webSearch` on a
 * trusted builtin role, whose `agent.md` `tools` can only name native tools.
 * Custom and Plugin Agents may name `web_search` in `tools`, so their
 * allowlist still decides it.
 */
function isFeatureOwnedBuiltinTool(
  profile: LocalTurnAgentProfileFacts | undefined,
  name: string,
  source: RuntimeToolSource,
): boolean {
  return (
    profile?.trustedBuiltin === true &&
    name === 'web_search' &&
    (source === 'builtin' || source === 'builtin-matrix')
  );
}

function isDesktopToolAvailable(tool: RuntimeTool, cuRuntimeAvailable: boolean): boolean {
  return cuRuntimeAvailable || !tool.def.name.startsWith('desktop_');
}

/** `mcpServers` applies to MCP tools only; without a server it fails closed. */
function isMcpServerAllowed(
  selector: LocalAgentCapabilitySelector,
  name: string,
  serverName: string | undefined,
): boolean {
  return !isAgentSelectorMcpToolName(name) || selector.allowsMcpServer(serverName);
}

function isProfileToolAllowed(
  profile: LocalTurnAgentProfileFacts,
  tool: RuntimeTool,
  source: RuntimeToolSource,
): boolean {
  if (profile.surface === 'task-child' && TASK_CHILD_BLOCKED_TOOL_NAMES.has(tool.def.name)) {
    return false;
  }
  if (isBuiltinSubagentTaskChild(profile) && tool.def.name === 'mavis') return false;
  return isProfileCapabilityEnabled(profile.capabilityCeiling, tool.def.name, source);
}

/**
 * Task operations are an owner-only authority. These facts are frozen from the
 * trusted Agent profile while assembling the Turn, rather than from a mutable
 * display name or a product capability flag.
 */
function isAuthoritativeMainProfile(profile: LocalTurnAgentProfileFacts | undefined): boolean {
  return (
    (profile?.surface === 'interactive' || profile?.surface === 'cli') &&
    profile.trustedBuiltin === true &&
    profile.canonicalRole === 'mavis'
  );
}

/**
 * The one rule for an Agent's `tools`, `disallowedTools` and `mcpServers`,
 * the same for builtin, Custom and Plugin Agents and for every role (README
 * "Desktop Local Agent 定义"). A tool is an MCP tool when its name starts with
 * `mcp__`, whatever its source or Agent role.
 * - `disallowedTools` removes any tool it names.
 * - An MCP tool (user MCP, Plugin MCP, a builtin server with `mcp__` names)
 *   must belong to a server named by `mcpServers` when the Agent has one.
 * - A Plugin App tool (a Plugin tool without an `mcp__` name) is not limited
 *   by `tools`: Plugin tools are outside the native allowlist.
 * - Any other tool (native, Matrix such as `web_search`, thread goal) must be
 *   named by `tools` when the Agent has one.
 * - A `tools` list that names an `mcp__*` tool limits every tool, MCP and
 *   Plugin tools included (`resolveToolsAllowlistScope`).
 * Capability ceilings, the native role ceiling and surface gates apply on top.
 */
export function isAgentSelectorMcpToolName(name: string): boolean {
  return normalizedSelectorName(name).startsWith('mcp__');
}

/**
 * A `tools` list that names no MCP tool is a native list and limits neither
 * MCP tools (`isAgentSelectorMcpToolName`) nor Plugin tools; this is how builtin worker /
 * explore / verifier `agent.md` lists read. A list that names an `mcp__*`
 * tool keeps limiting every tool: its author picked MCP tools one by one
 * (compatible Plugin Agents, Task snapshots that froze concrete MCP names),
 * and dropping that limit would widen what they chose.
 */
export function resolveToolsAllowlistScope(
  tools: readonly string[] | undefined,
): LocalAgentToolsAllowlistScope {
  return tools?.some(isAgentSelectorMcpToolName) ? 'all' : 'native';
}

export function createLocalAgentCapabilitySelector(
  selection: LocalTurnAgentProfileFacts['configSelection'] | undefined,
  toolsAllowlistScope?: LocalAgentToolsAllowlistScope,
): LocalAgentCapabilitySelector {
  const allowedTools = normalizeSelector(selection?.tools);
  const allowlistIsNative =
    (toolsAllowlistScope ?? resolveToolsAllowlistScope(selection?.tools)) === 'native';
  const skipsAllowlist = (
    name: string,
    options?: { featureOwned?: boolean; pluginTool?: boolean },
  ) =>
    options?.featureOwned === true ||
    (allowlistIsNative && (options?.pluginTool === true || isAgentSelectorMcpToolName(name)));
  const blockedTools = normalizeSelector(selection?.disallowedTools) ?? new Set<string>();
  const allowedMcpServers = normalizeSelector(selection?.mcpServers);
  const allowedSkills = normalizeSelector(selection?.skills);
  const allowedExtensionSkills = normalizeSelector(selection?.extensionSkills);
  return {
    allowsTool(name, hostAlias, options) {
      const names = [name, ...(hostAlias ? [hostAlias] : [])].map(normalizedSelectorName);
      return (
        !names.some((candidate) => blockedTools.has(candidate)) &&
        (skipsAllowlist(name, options) ||
          !allowedTools ||
          names.some((candidate) => allowedTools.has(candidate)))
      );
    },
    allowsMcpServer(serverName) {
      if (!allowedMcpServers) return true;
      return serverName ? allowedMcpServers.has(normalizedSelectorName(serverName)) : false;
    },
    allowsSkill(name) {
      return !allowedSkills || allowedSkills.has(normalizedSelectorName(name));
    },
    allowsExtensionSkill(pluginName, name) {
      if (!allowedExtensionSkills) return true;
      const normalizedName = normalizedSelectorName(name);
      return (
        allowedExtensionSkills.has(normalizedName) ||
        allowedExtensionSkills.has(`${normalizedSelectorName(pluginName)}:${normalizedName}`)
      );
    },
  };
}

function normalizeSelector(values: readonly string[] | undefined): ReadonlySet<string> | undefined {
  return values === undefined
    ? undefined
    : new Set(values.map(normalizedSelectorName).filter(Boolean));
}

function normalizedSelectorName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function filterDesktopCapabilities(
  capabilities: AgentHostTurnCapabilityView | undefined,
  keep: (
    tool: RuntimeTool,
    source: RuntimeToolSource,
    options?: LocalTurnToolKeepOptions,
  ) => boolean,
): AgentHostTurnCapabilityView | undefined {
  if (!capabilities) return undefined;
  // Plugin tools are outside a native `tools` list (`isAgentSelectorMcpToolName`):
  // App tools follow `disallowedTools` only, and `mcp__*` tools follow
  // `mcpServers` like every MCP tool, whose server only an MCP binding can prove.
  const bindings = capabilities.runtimeToolBindings.filter((binding) =>
    keep(binding.tool, 'configured', {
      pluginTool: true,
      ...(binding.kind === 'mcp' ? { serverName: binding.source } : {}),
    }),
  );
  const allowedBindingTools = new Set(bindings.map((binding) => binding.tool));
  const allBindingTools = new Set(capabilities.runtimeToolBindings.map((binding) => binding.tool));
  return {
    ...capabilities,
    runtimeToolBindings: bindings,
    runtimeTools: capabilities.runtimeTools.filter((tool) => {
      if (allBindingTools.has(tool)) return allowedBindingTools.has(tool);
      // Older/third-party capability providers can expose a direct RuntimeTool
      // without an owner binding. Keep that existing inventory under normal
      // gates. Without server provenance, an `mcp__*` tool cannot be proven to
      // belong to an allowed server, so a declared `mcpServers` fails it closed
      // (`isMcpServerAllowed`).
      return keep(tool, 'configured', { pluginTool: true });
    }),
  };
}

function filterExtensionSkills(
  skills: readonly { readonly pluginName: string; readonly name: string }[],
  selector: LocalAgentCapabilitySelector,
): readonly { readonly pluginName: string; readonly name: string }[] {
  return skills.filter((skill) => selector.allowsExtensionSkill(skill.pluginName, skill.name));
}

/**
 * SessionSend is a sub-command of the composite `mavis` Tool, so it cannot be
 * removed from the catalog on its own. A builtin SubAgent running as a task
 * child therefore loses the whole `mavis` Tool. The Agent profile resolver
 * already forces `features.mavis` off for this surface; repeating the rule on
 * the final catalog keeps it fail closed if raw sources or assembly order ever
 * change. Custom Agents and direct/root builtin Sessions are untouched.
 */
function isBuiltinSubagentTaskChild(profile: LocalTurnAgentProfileFacts): boolean {
  return (
    profile.surface === 'task-child' &&
    isCanonicalBuiltinTurn(profile.canonicalRole, profile.trustedBuiltin)
  );
}

/** Thread goal tools are withheld from task children and canonical builtin turns. */
function resolveThreadGoalTools(
  profile: LocalTurnAgentProfileFacts | undefined,
  threadGoalTools: readonly RuntimeTool[],
): readonly RuntimeTool[] {
  if (profile?.surface === 'task-child') return [];
  if (isCanonicalBuiltinTurn(profile?.canonicalRole, profile?.trustedBuiltin)) return [];
  return threadGoalTools;
}

/** Joins the plugin reminder with the MCP tool-search hint when both apply. */
function renderUserPromptPrefix(
  reminder: string | undefined,
  deferred: boolean,
  systemHint: boolean,
  ptc: boolean,
): string {
  return [reminder, deferred && systemHint ? renderMcpToolSearchHintBlock({ ptc }) : '']
    .filter(Boolean)
    .join('\n\n');
}

const TASK_CONTROL_TOOL_NAMES = new Set(['task_query', 'task_output', 'task_stop']);
const DELEGATION_TOOL_NAMES = new Set(['task', 'task_append']);
const TASK_CHILD_BLOCKED_TOOL_NAMES = new Set([...DELEGATION_TOOL_NAMES, 'todowrite', 'ask_user']);
const BUILTIN_NATIVE_TOOL_NAMES = new Set<string>(AGENT_BUILTIN_TOOL_IDS);
const BUILTIN_MCP_TOOL_NAMES = new Set<string>(AGENT_BUILTIN_MCP_TOOL_IDS);

function isProfileCapabilityEnabled(
  ceiling: LocalAgentCapabilityCeiling,
  toolName: string,
  source: RuntimeToolSource,
): boolean {
  if (!isFeatureEnabled(ceiling, toolName)) return false;
  if (source === 'builtin' && ceiling.tools && BUILTIN_NATIVE_TOOL_NAMES.has(toolName)) {
    return ceiling.tools.includes(toolName as (typeof ceiling.tools)[number]);
  }
  if (source === 'builtin-matrix' && ceiling.builtinTools && BUILTIN_MCP_TOOL_NAMES.has(toolName)) {
    return ceiling.builtinTools.includes(toolName as (typeof ceiling.builtinTools)[number]);
  }
  return true;
}

function isFeatureEnabled(ceiling: LocalAgentCapabilityCeiling, toolName: string): boolean {
  if (toolName === 'mavis') return ceiling.features.mavis;
  if (DELEGATION_TOOL_NAMES.has(toolName)) return ceiling.features.delegation;
  if (toolName === 'web_search') return ceiling.features.webSearch;
  return true;
}

export function resolveLocalMcpDisclosureOptions(
  raw: LocalMcpToolSearchConfig | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): McpDisclosureOptions {
  return {
    enabled: resolveOption(env.MAVIS_MCP_TOOL_SEARCH_ENABLED, raw?.enabled, true, parseBoolean),
    modelWhitelist: resolveModelWhitelist(env.MAVIS_MCP_TOOL_SEARCH_WHITELIST, raw),
    thresholdPct: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_THRESHOLD_PCT,
      raw?.thresholdPct,
      0.15,
      parseNumber,
    ),
    minDeferCount: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_MIN_DEFER_COUNT,
      raw?.minDeferCount,
      1,
      parseNumber,
    ),
    topKDefault: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_TOP_K_DEFAULT,
      raw?.topKDefault,
      5,
      parseNumber,
    ),
    topKMax: resolveOption(env.MAVIS_MCP_TOOL_SEARCH_TOP_K_MAX, raw?.topKMax, 20, parseNumber),
    systemHint: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_SYSTEM_HINT,
      raw?.systemHint,
      true,
      parseBoolean,
    ),
    maxSchemaTextLen: resolveOption(
      env.MAVIS_MCP_TOOL_SEARCH_MAX_SCHEMA_TEXT_LEN,
      raw?.maxSchemaTextLen,
      4_096,
      parseNumber,
    ),
  };
}

function resolveOption<T>(
  envValue: string | undefined,
  configured: T | undefined,
  fallback: T,
  parse: (value: string | undefined) => T | undefined,
): T {
  return parse(envValue) ?? configured ?? fallback;
}

function resolveModelWhitelist(
  envValue: string | undefined,
  raw: LocalMcpToolSearchConfig | undefined,
): string[] {
  const parsed = parseStringList(envValue);
  if (parsed) return parsed;
  return raw?.modelWhitelist ? [...raw.modelWhitelist] : [];
}

function parseBoolean(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return undefined;
}

function parseNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStringList(value: string | undefined): string[] | undefined {
  const entries = value
    ?.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  return entries && entries.length > 0 ? entries : undefined;
}
