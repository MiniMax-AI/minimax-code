import { Type } from '@sinclair/typebox';
import type { RuntimeTool, ToolDefinition } from '@mavis/agent-core/tools';
import { buildOrReuseIndex, mcpServerOfToolName, serverOfToolEntry } from './search-index.js';
import { noticeDue } from './window-notice.js';
import type {
  McpAutoDeferDecision,
  McpDisclosureOptions,
  McpDisclosurePlan,
  McpDisclosureStats,
  McpModelIdentity,
  McpToolEntry,
} from './types.js';

/**
 * Prefix window: from the start of a Session, or from a committed compaction, up
 * to the next compaction. The first Turn of a window freezes which Tool Search
 * candidates (configured MCP and Plugin tools, `on_demand` tools) are declared
 * inline and which the deferred-tool catalog lists; every later Turn of the window
 * declares exactly the same, so the `tools` array, the PTC run_code SDK and the
 * catalog stay byte-identical and the prompt cache keeps hitting. Changes in
 * between are stated in the next user message instead (append-only); each such
 * notice states the complete deviation and replaces the earlier ones:
 * - a new tool is deferred: searchable with `tool_search`, callable through
 *   `mcp_invoke` or inside run_code, never added to the declarations;
 * - a removed tool keeps its declaration (or catalog line, or the place a notice
 *   gave it), and every call to it fails with "not available in this session
 *   right now" (servers can come back within the window);
 * - a deferred tool whose definition changed keeps its catalog line, and the
 *   model is told to load the current definition before calling it;
 * - an inline tool whose definition changed ends the window (one cache miss):
 *   keeping the old declaration while executing against a new schema would make
 *   the model build arguments for parameters that no longer exist.
 * Native and builtin tools are not candidates: they are listed as the Turn
 * finds them, and a change to them still changes the declarations.
 */
export interface ToolSearchWindow {
  /** Disclosure options, PTC mode and model the window was planned for. */
  readonly fingerprint: string;
  readonly autoDecision?: McpAutoDeferDecision;
  /** Names of every inline tool at the window start, in declaration order. */
  readonly inlineOrder: readonly string[];
  /** Candidates declared inline, with the definitions declared then. */
  readonly inline: ReadonlyMap<string, FrozenToolSearchEntry>;
  /** Candidates the catalog lists, in catalog order. */
  readonly deferred: ReadonlyMap<string, FrozenToolSearchEntry>;
  /** `tool_search` and `mcp_invoke` are declared. */
  readonly gateways: boolean;
}

export interface FrozenToolSearchEntry extends McpToolEntry {
  readonly signature: string;
}

/** How a tool differs from what the tool list and the catalog show; tools as shown have none. */
export type ToolSearchWindowStatus = 'added' | 'removed' | 'changed';

/** One tool's difference. The signature (its current definition) tells a second change apart. */
export interface ToolSearchDeviation {
  readonly status: ToolSearchWindowStatus;
  /** Absent for removed tools. */
  readonly signature?: string;
  /** The tool's server, when known; a removed tool keeps the one it was announced with. */
  readonly server?: string;
}

/** Every tool that differs from what the tool list and the catalog show, by name. */
export type ToolSearchDeviations = ReadonlyMap<string, ToolSearchDeviation>;

/** What the tool-availability notices left in the history tell the model. */
export interface ToolSearchToldState {
  /**
   * The deviation the newest sent notice stated. Undefined: unknown, because
   * that notice may have left the history (rewind, retract, compaction) or an
   * earlier process sent it; the next Turn then states the full deviation again.
   */
  readonly snapshot: ToolSearchDeviations | undefined;
  /** A notice was sent in this Session (or found in its history) at some point. */
  readonly everTold: boolean;
  /** The text of the newest sent notice, while `snapshot` is known. */
  readonly text?: string;
}

/** What a catalog build reads of the Session: its window and what the model was told. */
export interface ToolSearchWindowInput {
  readonly current?: ToolSearchWindow;
  readonly told: ToolSearchToldState;
  /** Tools a sent notice announced as added in the current window, with their servers. */
  readonly addedInWindow: ReadonlyMap<string, string | undefined>;
  /** Tools a sent notice announced as changed in the current window. */
  readonly changedInWindow: ReadonlySet<string>;
}

export type ToolSearchWindowResetReason =
  | 'options or model changed'
  | 'inline definition changed'
  | 'loading changed'
  | 'tool_search gateway needed';

export interface ToolSearchWindowOutcome {
  readonly window: ToolSearchWindow;
  readonly event: 'started' | 'continued' | 'reset';
  readonly reset?: { readonly reason: ToolSearchWindowResetReason; readonly tools: string[] };
  /** Every tool that differs from the declarations and the catalog now. */
  readonly deviation: ToolSearchDeviations;
}

/**
 * What a Turn's user message announces (`<tool-availability-update>`): the
 * complete current deviation, replacing every earlier notice, so a notice that
 * later leaves the history or goes unsent never leaves a stale one in charge.
 */
export interface ToolAvailabilityNotice {
  readonly deviation: ToolSearchDeviations;
  /** Present tools outside the window (listed like catalog lines). */
  readonly added: readonly McpToolEntry[];
  readonly unavailable: readonly string[];
  /** Servers with no tool left this Turn and several unavailable: their `unavailable` names. */
  readonly unavailableServers: ReadonlyMap<string, readonly string[]>;
  /** Parameters differ from what the catalog or an earlier notice showed. */
  readonly changed: readonly string[];
  /**
   * Removed in the last told state, present and shown as they are now; when the
   * window restarted, also those told as changed (the new window shows them as they are).
   */
  readonly availableAgain: readonly string[];
  /**
   * Announced as changed in this window and back to their catalog definition
   * since the last told state: a definition the model loaded after the change no
   * longer applies.
   */
  readonly reverted: readonly string[];
}

const NO_DEVIATION: ToolSearchDeviations = new Map();

/** What a declaration depends on; any difference is a changed definition. */
export function toolDefinitionSignature(def: ToolDefinition): string {
  return JSON.stringify([def.description, def.schema, def.loading ?? null]);
}

export function toolSearchWindowFingerprint(
  options: McpDisclosureOptions,
  model: McpModelIdentity,
  ptc: boolean,
): string {
  // `estimateTokens` is a function and drops out; every other option shapes the plan.
  // The context window does not, though it caps the fixed budget when known: the window
  // keeps the deferral it started with, and switching 512k to 1M on the same model must
  // not restart it.
  return JSON.stringify({ options, model: { provider: model.provider, id: model.id }, ptc });
}

interface WindowPlanInput {
  readonly entries: readonly McpToolEntry[];
  readonly isCandidate: (entry: McpToolEntry) => boolean;
  /** Gateways are declared whether or not anything is deferred. */
  readonly gatewaysExposed: boolean;
  readonly maxSchemaTextLen: number;
  readonly stats: (deferred: readonly McpToolEntry[]) => McpDisclosureStats;
}

/**
 * The window of a freshly planned Turn: the start of a Session's window, or a
 * new one after `reset`. Nothing differs from a window that just started.
 */
export function startToolSearchWindow(
  plan: McpDisclosurePlan,
  input: Pick<WindowPlanInput, 'entries' | 'isCandidate' | 'gatewaysExposed'> & {
    readonly fingerprint: string;
    readonly reset?: ToolSearchWindowOutcome['reset'];
  },
): ToolSearchWindowOutcome {
  const byTool = new Map(input.entries.map((entry) => [entry.tool, entry]));
  const freeze = (entry: McpToolEntry): [string, FrozenToolSearchEntry] => [
    entry.tool.def.name,
    { ...entry, signature: toolDefinitionSignature(entry.tool.def) },
  ];
  const inline = plan.inlineTools.flatMap((tool) => {
    const entry = byTool.get(tool);
    return entry && input.isCandidate(entry) ? [freeze(entry)] : [];
  });
  const window: ToolSearchWindow = {
    fingerprint: input.fingerprint,
    ...(plan.autoDecision ? { autoDecision: plan.autoDecision } : {}),
    inlineOrder: plan.inlineTools.map((tool) => tool.def.name),
    inline: new Map(inline),
    deferred: new Map(plan.deferred ? plan.deferredEntries.map(freeze) : []),
    gateways: input.gatewaysExposed || plan.deferred,
  };
  return {
    window,
    event: input.reset ? 'reset' : 'started',
    ...(input.reset ? { reset: input.reset } : {}),
    deviation: NO_DEVIATION,
  };
}

/**
 * The notice this Turn's user message carries, if any: when the deviation
 * differs from the last told one, or when what was told is unknown and there is
 * a deviation to state or an earlier notice to supersede. `changedInWindow` is
 * given only when the window continues; without it the window restarted (or
 * Tool Search is off), so nothing can revert to a catalog the model never saw.
 */
export function toolAvailabilityNotice(
  told: ToolSearchToldState,
  deviation: ToolSearchDeviations,
  outside: readonly McpToolEntry[],
  entries: readonly McpToolEntry[],
  changedInWindow?: ReadonlySet<string>,
): ToolAvailabilityNotice | undefined {
  if (!noticeDue(told, deviation)) return undefined;
  const last = told.snapshot;
  const named = (status: ToolSearchWindowStatus) =>
    [...deviation].flatMap(([name, entry]) => (entry.status === status ? [name] : [])).sort();
  const present = new Set(entries.map((entry) => entry.tool.def.name));
  const unavailable = named('removed');
  const asShown = (name: string) => !deviation.has(name) && present.has(name);
  const back = (statuses: readonly ToolSearchWindowStatus[]) =>
    [...(last ?? [])]
      .flatMap(([name, entry]) => (statuses.includes(entry.status) && asShown(name) ? [name] : []))
      .sort();
  return {
    deviation,
    added: outside,
    unavailable,
    unavailableServers: wholeServersGone(unavailable, deviation, entries),
    changed: named('changed'),
    availableAgain: back(changedInWindow ? ['removed'] : ['removed', 'changed']),
    // Announced as changed in this window and as shown now, unless the last known
    // notice already said so (it did not list them).
    reverted: [...(changedInWindow ?? [])]
      .filter((name) => asShown(name) && (last === undefined || last.has(name)))
      .sort(),
  };
}

/**
 * The servers none of whose tools is present, each with its unavailable tools (two or more).
 * A live tool counts under its server and its name prefix, so a server known by
 * either never reads as wholly gone while one of its tools is present.
 */
function wholeServersGone(
  unavailable: readonly string[],
  deviation: ToolSearchDeviations,
  entries: readonly McpToolEntry[],
): ReadonlyMap<string, readonly string[]> {
  const live = new Set(
    entries.flatMap((entry) => [
      serverOfToolEntry(entry),
      mcpServerOfToolName(entry.tool.def.name),
    ]),
  );
  const gone = new Map<string, string[]>();
  for (const name of unavailable) {
    const server = deviation.get(name)?.server;
    if (server === undefined || live.has(server)) continue;
    gone.set(server, [...(gone.get(server) ?? []), name]);
  }
  return new Map([...gone].filter(([, names]) => names.length > 1));
}

/**
 * A present tool outside the window: added, or changed when the last told
 * notice listed it with another definition (and stays changed while that holds).
 */
function outsideStatus(
  last: ToolSearchDeviation | undefined,
  signature: string,
): ToolSearchWindowStatus {
  if (!last || last.status === 'removed') return 'added';
  return last.status === 'changed' || last.signature !== signature ? 'changed' : 'added';
}

/**
 * The deviation of a tool that disappeared. Its server is the frozen entry's, or
 * the one a notice announced it with; the name prefix only when neither is known.
 */
function removedDeviation(
  name: string,
  frozen: McpToolEntry | undefined,
  announcedServer: string | undefined,
): ToolSearchDeviation {
  const server = frozen
    ? serverOfToolEntry(frozen)
    : (announcedServer ?? mcpServerOfToolName(name));
  return { status: 'removed', ...(server === undefined ? {} : { server }) };
}

function withServer(entry: McpToolEntry): Pick<ToolSearchDeviation, 'server'> {
  const server = serverOfToolEntry(entry);
  return server === undefined ? {} : { server };
}

/**
 * Plans a later Turn of `window` against the current inventory, or says why the
 * window cannot continue.
 */
export function continueToolSearchWindow(
  window: ToolSearchWindow,
  session: ToolSearchWindowInput,
  input: WindowPlanInput,
):
  | { readonly plan: McpDisclosurePlan }
  | { readonly reset: NonNullable<ToolSearchWindowOutcome['reset']> } {
  const inline: RuntimeTool[] = [];
  const deferred: McpToolEntry[] = [];
  const deviation = new Map<string, ToolSearchDeviation>();
  const outside: McpToolEntry[] = [];
  const present = new Set<string>();
  const changedInline: string[] = [];
  const reloaded: string[] = [];
  for (const entry of input.entries) {
    const name = entry.tool.def.name;
    present.add(name);
    const declared = window.inline.get(name);
    const frozen = declared ?? window.deferred.get(name);
    if (!input.isCandidate(entry)) {
      if (frozen) reloaded.push(name);
      inline.push(entry.tool);
    } else if (declared) {
      if (declared.signature !== toolDefinitionSignature(entry.tool.def)) changedInline.push(name);
      inline.push(entry.tool);
    } else {
      deferred.push(entry);
      const signature = toolDefinitionSignature(entry.tool.def);
      if (!frozen) {
        outside.push(entry);
        const status = outsideStatus(session.told.snapshot?.get(name), signature);
        deviation.set(name, { status, signature, ...withServer(entry) });
      } else if (frozen.signature !== signature) {
        deviation.set(name, { status: 'changed', signature, ...withServer(entry) });
      }
    }
  }
  if (reloaded.length > 0) return { reset: { reason: 'loading changed', tools: reloaded } };
  if (changedInline.length > 0) {
    return { reset: { reason: 'inline definition changed', tools: changedInline } };
  }

  // Every tool the model knows of in this window and cannot reach any more.
  const registry = new Map<string, RuntimeTool>(
    deferred.map((entry) => [entry.tool.def.name, entry.tool]),
  );
  // Tools the window declared keep its order even when the inventory lists them
  // differently; tools it did not declare keep their places.
  const rank = new Map(window.inlineOrder.map((name, index) => [name, index]));
  const slots = inline.flatMap((tool, index) => (rank.has(tool.def.name) ? [index] : []));
  const declaredInOrder = slots
    .flatMap((index) => inline.slice(index, index + 1))
    .sort((a, b) => (rank.get(a.def.name) ?? 0) - (rank.get(b.def.name) ?? 0));
  declaredInOrder.forEach((tool, at) => inline.splice(slots[at] ?? at, 1, tool));
  for (const name of window.inlineOrder) {
    const declared = window.inline.get(name);
    if (!declared || present.has(name)) continue;
    deviation.set(name, removedDeviation(name, declared, undefined));
    insertAtDeclaredSlot(inline, unavailableTool(declared.tool, name, true), window.inlineOrder);
  }
  // Catalog tools and tools a sent notice added: the model knows of them.
  for (const name of new Set([...window.deferred.keys(), ...session.addedInWindow.keys()])) {
    if (present.has(name) || window.inline.has(name)) continue;
    const announced = session.told.snapshot?.get(name)?.server ?? session.addedInWindow.get(name);
    deviation.set(name, removedDeviation(name, window.deferred.get(name), announced));
    registry.set(name, unavailableTool(window.deferred.get(name)?.tool, name, false));
  }
  if (registry.size > 0 && !input.gatewaysExposed && !window.gateways) {
    return { reset: { reason: 'tool_search gateway needed', tools: [...registry.keys()] } };
  }

  const outcome: ToolSearchWindowOutcome = { window, event: 'continued', deviation };
  const notice = toolAvailabilityNotice(
    session.told,
    deviation,
    outside,
    input.entries,
    session.changedInWindow,
  );
  const extras = {
    ...(window.autoDecision ? { autoDecision: window.autoDecision } : {}),
    window: outcome,
    ...(notice ? { availability: notice } : {}),
  };
  if (registry.size === 0) {
    return { plan: { deferred: false, inlineTools: inline, ...extras } };
  }
  const index = buildOrReuseIndex(deferred, { maxSchemaTextLen: input.maxSchemaTextLen });
  return {
    plan: {
      deferred: true,
      inlineTools: inline,
      // Removed tools stay here so a call names them as gone; the index omits them.
      deferredRegistry: registry,
      index,
      deferredEntries: deferred,
      stats: input.stats(deferred),
      ...extras,
    },
  };
}

/**
 * Puts a stand-in where the window declared its tool: right after the nearest
 * tool declared before it that is still listed, so an otherwise unchanged list
 * keeps its order.
 */
function insertAtDeclaredSlot(
  tools: RuntimeTool[],
  stub: RuntimeTool,
  order: readonly string[],
): void {
  const before = new Set(order.slice(0, order.indexOf(stub.def.name)));
  let at = 0;
  tools.forEach((tool, index) => {
    if (before.has(tool.def.name)) at = index + 1;
  });
  tools.splice(at, 0, stub);
}

/**
 * Stands in for a tool that disappeared within the window. A declared one keeps
 * its frozen definition (the declaration must not change); a deferred one accepts
 * any arguments, so the call reaches this error rather than a validation error.
 */
function unavailableTool(
  frozen: RuntimeTool | undefined,
  name: string,
  declared: boolean,
): RuntimeTool {
  const text = `${name} is not available in this session right now (disconnected, disabled or not permitted). It may come back; do not call it unless a later update says it is available again.`;
  const def: ToolDefinition =
    declared && frozen
      ? frozen.def
      : { name, description: frozen?.def.description ?? '', schema: Type.Object({}) };
  return {
    ...(frozen ?? {}),
    source: frozen?.source ?? 'configured',
    def,
    impl: {
      execute: async () => ({
        tool_name: name,
        text,
        content: [{ type: 'text' as const, text }],
        isError: true,
      }),
    },
  };
}
