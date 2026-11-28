/**
 * Builtin tool namespaces.
 *
 * A namespace groups builtin tools that manage one product area and binds that
 * group to exactly one Skill. Four consumers read this table:
 *
 * - the host gate: an on-demand namespaced tool runs only after the model has
 *   loaded its Skill (or a Skill that lists it in `sharedReads`);
 * - the `skill` tool wrapper: loading a Skill appends this namespace's tool
 *   definitions, plus its `sharedReads`, to the Skill result;
 * - `tool_search`: a hit carries its namespace and Skill, and `namespace`
 *   queries resolve through the same names;
 * - the mavis capability switch: every name in `BUILTIN_NAMESPACE_TOOL_NAMES`
 *   is a mavis-capability tool.
 *
 * Namespace names are the wire values the model sees; a name without a dot is a
 * prefix query (`sidebar` matches `sidebar.*`), a name with a dot is exact.
 * Only builtin tools carry a namespace; third-party MCP tools never do.
 */

export interface BuiltinToolNamespaceEntry {
  /** Runtime Skill name the model loads before calling this group's tools. */
  readonly skill: string;
  /**
   * One line for the tool_search description and for the deferred-tool catalog's
   * namespace line, so the model can pick a group. One sentence ending in a
   * period: the catalog line ends with it.
   */
  readonly summary: string;
  /**
   * Read-only tools from other namespaces whose definitions are appended with
   * this Skill and which this Skill's receipt also unlocks. Read tools only.
   */
  readonly sharedReads?: readonly string[];
  /**
   * A trusted coordinator's first Turn preloads this Skill, so it can call the
   * group's tools without loading anything first. Only for a group the
   * coordinator reaches for on nearly every turn.
   */
  readonly coordinatorPreload?: true;
  /**
   * Only a trusted coordinator owns this group's tools, so its Skill is offered
   * to a trusted coordinator alone. Every other Agent has no tool to run, and a
   * Skill whose tools were filtered away is a dead end the model can only retry.
   */
  readonly coordinatorOnly?: true;
  /**
   * Which capability registers this namespace's tools, and therefore the only
   * condition under which its Skill may be offered. It is checked against the
   * same adapters `buildLocalToolRegistry` reads, so a Skill never outlives its
   * tools:
   *
   * - `mavis`: the mavis executor. Every Runtime host builds it (Electron, CLI
   *   and TUI alike), so the Skill follows the mavis switch alone.
   * - `mavis-cron`: the mavis executor plus the Cron adapter, which a
   *   CLI-restricted Runtime does not get.
   * - `desktop`: an Electron-only adapter (the sidebar owner, the desktop tool
   *   owners or the UI channel). Only the desktop app registers these.
   * - `memory`: the memory tools, owned by the memory feature rather than by
   *   the mavis switch.
   */
  readonly providedBy: 'mavis' | 'mavis-cron' | 'desktop' | 'memory';
}

export const BUILTIN_TOOL_NAMESPACES = {
  'sidebar.section': {
    skill: 'sidebar-section',
    providedBy: 'desktop',
    summary:
      'Sidebar sections: list, create, rename, delete, reorder, and move chats or projects into them.',
    sharedReads: ['project_list', 'sidebar_read'],
  },
  'sidebar.project': {
    skill: 'sidebar-project',
    providedBy: 'desktop',
    coordinatorPreload: true,
    summary: "Sidebar projects: list, create, rename, remove, and archive a project's chats.",
    sharedReads: ['sidebar_read'],
  },
  'sidebar.view': {
    skill: 'sidebar-view',
    providedBy: 'desktop',
    summary:
      'The whole sidebar view: read the session tree, pin chats, projects and Agents, reorder the pinned area.',
  },
  'session.manage': {
    skill: 'session-manage',
    providedBy: 'mavis',
    coordinatorPreload: true,
    summary: 'Chats themselves: list, read, rename, fork and open conversations.',
  },
  'session.dispatch': {
    skill: 'session-dispatch',
    providedBy: 'mavis',
    summary: 'Starting, continuing, interrupting and waiting on other conversations.',
    sharedReads: ['session_list', 'session_messages'],
  },
  panel: {
    skill: 'panel-manage',
    providedBy: 'desktop',
    summary: 'The right-hand panel: open a file or the review view.',
  },
  app: {
    skill: 'app-manage',
    providedBy: 'desktop',
    summary:
      'Plugins and the app itself: usage, plugin list, enable or disable, uninstall, update check.',
  },
  agent: {
    skill: 'agent-manage',
    providedBy: 'mavis',
    summary: 'Agents: list, read, create, update and delete.',
  },
  mcp: {
    skill: 'mcp-manage',
    providedBy: 'mavis',
    summary: 'MCP servers: list, read, create, update and delete.',
  },
  cron: {
    skill: 'cron-manage',
    providedBy: 'mavis-cron',
    summary: 'Scheduled tasks: create, read, update and delete.',
  },
  memory: {
    skill: 'memory-manage',
    providedBy: 'memory',
    summary: 'Memory: search, read and add notes.',
  },
} as const satisfies Readonly<Record<string, BuiltinToolNamespaceEntry>>;

export type BuiltinToolNamespace = keyof typeof BUILTIN_TOOL_NAMESPACES;

/**
 * Every builtin tool name, grouped by the namespace that owns it. The mavis
 * capability switch, the gate and the host append all read the same rows, so
 * adding a tool is one edit here plus its `namespace` field.
 *
 * Groups still without tools list none; their Skill and search entry exist so
 * the framework is complete before the tools land.
 */
export const BUILTIN_NAMESPACE_TOOL_NAMES = {
  'sidebar.section': [
    'section_list',
    'section_create',
    'section_rename',
    'section_delete',
    'section_move_session',
    'section_move_project',
    'section_reorder',
  ],
  'sidebar.project': [
    'project_list',
    'project_archive_sessions',
    'project_create',
    'project_rename',
    'project_remove',
  ],
  'sidebar.view': [
    'sidebar_read',
    'sidebar_pin',
    'pinned_reorder',
    'session_mark_read',
    'sidebar_preferences_update',
  ],
  'session.manage': [
    'session_list',
    'session_get',
    'session_update',
    'session_messages',
    'session_open',
    'session_fork',
  ],
  'session.dispatch': ['session_create', 'session_send', 'session_interrupt', 'session_wait'],
  panel: ['panel_open_file', 'panel_open_review'],
  app: ['usage_get', 'app_update_check', 'plugin_list', 'plugin_set_enabled', 'plugin_uninstall'],
  agent: ['agent_list', 'agent_get', 'agent_create', 'agent_update', 'agent_delete'],
  mcp: [
    'mcp_server_list',
    'mcp_server_get',
    'mcp_server_create',
    'mcp_server_update',
    'mcp_server_delete',
  ],
  cron: ['cron_create', 'cron_read', 'cron_update', 'cron_delete', 'self_reminder'],
  // The memory tools carry namespace 'memory' on their definitions but are
  // listed nowhere here: this table is also the mavis capability switch, and
  // memory is owned by its own feature, not by mavis.
  memory: [],
} as const satisfies Readonly<Record<BuiltinToolNamespace, readonly string[]>>;

/** Flat list of every mavis-capability namespaced builtin tool, in namespace order. */
export const BUILTIN_NAMESPACED_TOOL_NAMES: readonly string[] = Object.values(
  BUILTIN_NAMESPACE_TOOL_NAMES,
).flat();

/**
 * Namespaced tools that load by default and are therefore not mavis-capability
 * tools: they stay in the per-turn list, the Skill gate (on-demand tools only)
 * never stands in front of them, and the mavis switch does not own them.
 *
 * Listed here only so `memory` counts as a namespace with tools — its Skill is
 * offered whenever the memory tools are, whatever the mavis switch says.
 */
export const DEFAULT_LOADED_NAMESPACE_TOOL_NAMES: Partial<
  Record<BuiltinToolNamespace, readonly string[]>
> = {
  memory: ['memory', 'memories_search', 'memories_read', 'memories_add_ad_hoc_note'],
  // Always loaded, never gated, and reached without reading the Skill first:
};

/**
 * Namespaced tools a PTC Turn keeps inline and calls at the top level, by their
 * own name: no `mcp_invoke` hop and no `run_code` program.
 *
 * `session_send` starts or continues another conversation's Turn. The v8 pilot
 * kept `task` and `task_append` inside run_code only; the evals delegated
 * clearly less and never continued a delegated Session, with no score gain, so
 * v9 put the spawn and continue calls back at the top level. This is the same
 * decision for the namespaced tool that replaced the `session send` command.
 * The rest of `session.dispatch` stays where it is: `session_create` is a spawn
 * the model still makes from a program, and `session_interrupt` and
 * `session_wait` are ordinary reads and writes of a program.
 *
 * The definitions keep `loading: 'on_demand'`, so the Skill gate, the appended
 * "Tools unlocked by this Skill" block and the deferred catalog all still treat
 * these as managed namespaced tools; only the Turn's loading plan keeps them
 * inline (`ToolLoadingCatalogOptions.inlineOnDemandToolNames`).
 */
export const PTC_TOP_LEVEL_NAMESPACED_TOOL_NAMES: readonly string[] = ['session_send'];

/** Whether a tool name is one a PTC Turn calls at the top level. */
export function isPtcTopLevelNamespacedToolName(name: string): boolean {
  return PTC_TOP_LEVEL_NAMESPACED_TOOL_NAMES.includes(name);
}

/** Whether a namespace has at least one tool that can be registered at all. */
function namespaceHasTools(namespace: BuiltinToolNamespace): boolean {
  return (
    BUILTIN_NAMESPACE_TOOL_NAMES[namespace].length > 0 ||
    (DEFAULT_LOADED_NAMESPACE_TOOL_NAMES[namespace]?.length ?? 0) > 0
  );
}

/**
 * The namespaces whose tools a Turn can actually run, and therefore the only
 * namespaces whose Skill may be offered to the model.
 *
 * The Skill gate and the tool filters must never disagree: a Skill the model can
 * load while its tools were filtered away is a dead end it can only retry. Both
 * sides read this one predicate, so adding a namespace cannot reintroduce the
 * split.
 *
 * Each namespace names the capability that registers its tools through
 * `providedBy`, and the Turn reports whether it has that capability. So the
 * answer differs per group rather than per surface: `agent`, `mcp` and the two
 * `session.*` groups are mavis-backed and exist on CLI and TUI too, `cron` also
 * needs the Cron adapter, `memory` follows the memory feature instead of the
 * mavis switch, and only the `desktop` groups need the desktop app.
 *
 * A namespace without a registered tool has nothing to run, so its Skill stays
 * out until its tools land.
 */
/** One Turn's facts about the capabilities that register namespaced tools. */
export interface BuiltinNamespaceAvailability {
  /** `features.mavis` for this Turn: the mavis switch, a CLI ceiling or a builtin SubAgent's task-child ceiling. */
  readonly mavisEnabled: boolean;
  /** An Electron-only adapter registered this Turn's desktop tools. */
  readonly desktopToolsAvailable: boolean;
  /** The Cron adapter registered this Turn's scheduled-task tools. */
  readonly cronToolsAvailable: boolean;
  /** The memory tools are registered for this Turn. */
  readonly memoryToolsAvailable: boolean;
  /** A trusted built-in coordinator runs this Turn. */
  readonly coordinator: boolean;
}

/** The Turn facts each `providedBy` capability is decided by. */
const PROVIDED_BY_AVAILABILITY: Readonly<
  Record<BuiltinToolNamespaceEntry['providedBy'], (input: BuiltinNamespaceAvailability) => boolean>
> = {
  memory: (input) => input.memoryToolsAvailable,
  desktop: (input) => input.mavisEnabled && input.desktopToolsAvailable,
  'mavis-cron': (input) => input.mavisEnabled && input.cronToolsAvailable,
  mavis: (input) => input.mavisEnabled,
};

export function availableBuiltinToolNamespaces(
  input: BuiltinNamespaceAvailability,
): readonly BuiltinToolNamespace[] {
  return (Object.keys(BUILTIN_TOOL_NAMESPACES) as BuiltinToolNamespace[]).filter((namespace) => {
    const entry = entryFor(namespace);
    if (entry === undefined) return false;
    return (
      namespaceHasTools(namespace) &&
      (entry.coordinatorOnly !== true || input.coordinator) &&
      PROVIDED_BY_AVAILABILITY[entry.providedBy](input)
    );
  });
}

const NAMESPACE_BY_TOOL_NAME: ReadonlyMap<string, BuiltinToolNamespace> = new Map(
  Object.entries(BUILTIN_NAMESPACE_TOOL_NAMES).flatMap(([namespace, names]) =>
    names.map((name) => [name, namespace as BuiltinToolNamespace] as const),
  ),
);

/** Whether a string is one of the registered namespaces; used to bound metric labels. */
export function isBuiltinToolNamespace(value: string): value is BuiltinToolNamespace {
  return Object.hasOwn(BUILTIN_TOOL_NAMESPACES, value);
}

/**
 * Metric label of a namespace: registry label values are snake_case, so a
 * dotted wire name is reported with its dot written as an underscore. The
 * registry enum is `NAMESPACE_METRIC_LABELS` in
 * @mavis/shared/local-runtime-logging/metric-registry; `satisfies` keeps this
 * map complete when a namespace is added.
 */
export const NAMESPACE_METRIC_LABELS = {
  'sidebar.section': 'sidebar_section',
  'sidebar.project': 'sidebar_project',
  'sidebar.view': 'sidebar_view',
  'session.manage': 'session_manage',
  'session.dispatch': 'session_dispatch',
  panel: 'panel',
  app: 'app',
  agent: 'agent',
  mcp: 'mcp',
  cron: 'cron',
  memory: 'memory',
} as const satisfies Record<BuiltinToolNamespace, string>;

export type NamespaceMetricLabelValue =
  | (typeof NAMESPACE_METRIC_LABELS)[BuiltinToolNamespace]
  | 'other';

/**
 * The `namespace` metric label of a wire namespace name. Every namespaced-tool
 * metric reports through this one map, so none carries a copy of its own.
 */
export function namespaceMetricLabel(namespace: string | undefined): NamespaceMetricLabelValue {
  return namespace !== undefined && isBuiltinToolNamespace(namespace)
    ? NAMESPACE_METRIC_LABELS[namespace]
    : 'other';
}

/** The namespace that owns a builtin tool name; undefined for every other name. */
export function namespaceForToolName(name: string): BuiltinToolNamespace | undefined {
  return NAMESPACE_BY_TOOL_NAME.get(name);
}

/** The Skill bound to a namespace, or undefined when the namespace is unknown. */
export function skillForNamespace(namespace: string): string | undefined {
  return entryFor(namespace)?.skill;
}

/** The read tools another namespace's Skill also unlocks; empty when none. */
export function sharedReadsForNamespace(namespace: string): readonly string[] {
  return entryFor(namespace)?.sharedReads ?? [];
}

/** The one line shown for a namespace in the tool_search description. */
export function summaryForNamespace(namespace: string): string | undefined {
  return entryFor(namespace)?.summary;
}

/** The namespace a Skill name belongs to; undefined for a Skill without one. */
export function namespaceForSkill(skill: string): BuiltinToolNamespace | undefined {
  const match = Object.entries(BUILTIN_TOOL_NAMESPACES).find(([, entry]) => entry.skill === skill);
  return match?.[0] as BuiltinToolNamespace | undefined;
}

/**
 * The on-demand namespaced tools a trusted coordinator may see and
 * call: the reads the two Skills its first Turn preloads (`coordinatorPreload`)
 * unlock. They stand for the `project list` and read-only `session` commands
 * its former mavis whitelist listed.
 *
 * This is an allowlist on purpose. Every other namespaced tool, including any
 * tool a namespace gains later, is hidden from the coordinator — its deferred
 * catalog, `tool_search`, Skill catalog, run_code `tools.*` and
 * `mcp_invoke` all lose it — and refused if it is called anyway. Most of them
 * are the user's own actions or its assignment tools' job, and the rest were
 * never the coordinator's.
 */
export const COORDINATOR_ON_DEMAND_TOOL_NAMES: readonly string[] = [
  'project_list',
  'session_list',
  'session_get',
  'session_messages',
];

/**
 * The cron group, which a coordinator loads by default as its own scheduling
 * tools (`shapeCoordinatorTools`), so the on-demand allowlist does not govern
 * it. Named one by one, so a tool the group gains later stays hidden too.
 */
const COORDINATOR_DEFAULT_LOADED_TOOL_NAMES: readonly string[] = [
  'cron_create',
  'cron_read',
  'cron_update',
  'cron_delete',
  'self_reminder',
];

const COORDINATOR_VISIBLE_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...COORDINATOR_ON_DEMAND_TOOL_NAMES,
  ...COORDINATOR_DEFAULT_LOADED_TOOL_NAMES,
]);

/**
 * Whether a trusted coordinator must not see or call a builtin tool: true for
 * every namespaced tool outside its allowlist, false for every other name. The
 * tool filter, the Skill gate and the executor guard all read this one rule.
 */
export function isCoordinatorHiddenToolName(name: string): boolean {
  return namespaceForToolName(name) !== undefined && !COORDINATOR_VISIBLE_TOOL_NAMES.has(name);
}

/**
 * The namespaces a trusted coordinator owns no tool of, in registry order: its
 * Skill would only teach tools it cannot call. A namespace that registers no
 * mavis-capability tool here (memory) is not one of them.
 */
export function coordinatorHiddenNamespaces(): readonly BuiltinToolNamespace[] {
  return (Object.keys(BUILTIN_TOOL_NAMESPACES) as BuiltinToolNamespace[]).filter((namespace) => {
    const names: readonly string[] = BUILTIN_NAMESPACE_TOOL_NAMES[namespace];
    return names.length > 0 && names.every(isCoordinatorHiddenToolName);
  });
}

/** Every namespaced tool a trusted coordinator must not see or call, in registry order. */
export function coordinatorHiddenToolNames(): readonly string[] {
  return BUILTIN_NAMESPACED_TOOL_NAMES.filter(isCoordinatorHiddenToolName);
}

/**
 * The Skills a trusted coordinator's first Turn preloads, in registry order:
 * every namespace marked `coordinatorPreload` that owns one of `toolNames`.
 *
 * The names are this Turn's own tools, so a namespace this Runtime does not
 * provide contributes nothing — which is what keeps `sidebar-project`, a
 * desktop-only group, out of a CLI coordinator's preload.
 */
export function coordinatorPreloadSkillNames(toolNames: readonly string[]): readonly string[] {
  const present = new Set(toolNames.map((name) => namespaceForToolName(name)));
  return (Object.keys(BUILTIN_TOOL_NAMESPACES) as BuiltinToolNamespace[])
    .filter((namespace) => present.has(namespace))
    .filter((namespace) => entryFor(namespace)?.coordinatorPreload === true)
    .map((namespace) => BUILTIN_TOOL_NAMESPACES[namespace].skill);
}

/**
 * The namespaces whose Skill receipt unlocks a tool: its own namespace, plus
 * every namespace that lists it in `sharedReads`.
 */
export function namespacesUnlockingToolName(name: string): readonly BuiltinToolNamespace[] {
  const own = namespaceForToolName(name);
  const shared = (Object.keys(BUILTIN_TOOL_NAMESPACES) as BuiltinToolNamespace[]).filter(
    (namespace) => entryFor(namespace)?.sharedReads?.includes(name) === true,
  );
  return [...new Set([...(own ? [own] : []), ...shared])];
}

function entryFor(namespace: string): BuiltinToolNamespaceEntry | undefined {
  return (BUILTIN_TOOL_NAMESPACES as Readonly<Record<string, BuiltinToolNamespaceEntry>>)[
    namespace
  ];
}
