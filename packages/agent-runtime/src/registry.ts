/**
 * Registry: Internal state and assembly implementation for agent-runtime.
 *
 * Three phases:
 * 1. Construction: `initExtensions` runs each `ext.init(ownerApi)`, providing an owner-scoped
 *   `ExtensionAPI` facade. Every `pi.registerXxx / pi.on` verifies the registry is `initializing`
 *   and the active owner matches the facade owner. All-success transitions to `ready`; any failure
 *   permanently transitions to `failed`, preventing reentrancy, concurrent init, and leaked partial
 *   contributions.
 * 2. Assembly: `assembleTurn(ctx)` iterates `LoadedExtension` entries (skipping disabled ones) and
 *   combines tools / prompt / reminder / hook contributions into `AssemblyResult`. The registry
 *   computes raw `reminders[]` separately from prompt contributor output. Prompt contributors
 *   receive only `TurnAssemblyCtx`; they cannot read the not-yet-generated `AssemblyResult` or
 *   reminders.
 * 3. Execution: The host invokes handlers (`PiTurnRunner` / turn lifecycle); the registry is not
 *   involved.
 *
 * Concurrency semantics (v1.0):
 * - `assembleTurn` synchronously snapshots all extension enabled states before its first await.
 *   `setEnabled` during assembly affects only the next assembly, so one `AssemblyResult` never
 *   mixes old and new states.
 * - Disabling during a handler call lets that call finish; gating applies on the next invocation,
 *   outside agent-runtime's awareness.
 * - Each `assembleTurn` creates independent hook wrapper closures (including ctx), isolating
 *   concurrent calls.
 */

import type { RuntimeTool, ToolExecutionContext } from '@mavis/agent-core/tools';
import type { PiTurnHooks } from '@mavis/agent-core/pi-turn-runner';
import type { TSchema } from '@sinclair/typebox';

import type {
  AgentExtension,
  AssemblyDiagnostic,
  AssemblyResult,
  EnabledScope,
  ExtensionAPI,
  ExtensionContributionStats,
  ExtensionState,
  HandlerFor,
  HookName,
  ModelContextAssemblyCtx,
  ModelContextAssemblyResult,
  ModelContextAssemblySeed,
  ReminderEmission,
  ReminderProvider,
  RuntimeToolContribution,
  SystemPromptContributor,
  TurnAssemblyCtx,
  TurnAssemblySeed,
  TurnEndHandler,
  TurnStartHandler,
  UserPromptContributor,
} from './types.js';
import { HOOK_NAMES } from './types.js';

/**
 * Per-hook handler storage. Typed via `HandlerFor<K>` so each event's array
 * carries its actual handler type—`on(event, handler)` remains a one-liner
 * while assembly-side reads (`hookHandlers.turn_start`) stay type-safe with
 * no casts. Adding a lifecycle event = extend `HOOK_NAMES` + `HookHandlerMap`,
 * two synchronized single-line edits enforced by TS exhaustiveness.
 */
type HookHandlerStorage = { [K in HookName]: Array<HandlerFor<K>> };

interface LoadedExtension {
  readonly id: string;
  readonly description?: string;
  enabledGlobal: boolean;
  readonly tools: RuntimeToolContribution[];
  readonly systemPromptContributors: SystemPromptContributor[];
  readonly userPromptContributors: UserPromptContributor[];
  readonly reminderProviders: ReminderProvider[];
  readonly hookHandlers: HookHandlerStorage;
}

function isRuntimeToolCatalog(
  value: RuntimeTool | readonly RuntimeTool[],
): value is readonly RuntimeTool[] {
  return Array.isArray(value);
}

type RegistryLifecycleState = 'new' | 'initializing' | 'ready' | 'failed';

function createEmptyHookStorage(): HookHandlerStorage {
  const storage = {} as HookHandlerStorage;
  for (const name of HOOK_NAMES) (storage as Record<HookName, unknown[]>)[name] = [];
  return storage;
}

function createEmptyLoaded(ext: AgentExtension): LoadedExtension {
  return {
    id: ext.id,
    description: ext.description,
    enabledGlobal: true,
    tools: [],
    systemPromptContributors: [],
    userPromptContributors: [],
    reminderProviders: [],
    hookHandlers: createEmptyHookStorage(),
  };
}

function contributionStats(loaded: LoadedExtension): ExtensionContributionStats {
  const hooks: Partial<Record<HookName, number>> = {};
  for (const name of HOOK_NAMES) {
    hooks[name] = loaded.hookHandlers[name].length;
  }
  return {
    tools: loaded.tools.length,
    promptContributors:
      loaded.systemPromptContributors.length + loaded.userPromptContributors.length,
    reminderProviders: loaded.reminderProviders.length,
    hooks: hooks as Record<HookName, number>,
  };
}

/**
 * Mapping from PiTurnHooks fields (agent-core names) to SPI event names. Drives hook-array merging
 * from a table to avoid five scattered edits.
 *
 * `on_step_end` maps to `onStepEndHook`. agent-core's `newTurn` still reads the deprecated per-step
 * compatibility slot `onTurnEndHook`; agent-runtime only writes the new field with explicit step
 * semantics to avoid duplicate handler execution.
 */
const HOOK_MAPPINGS = [
  { pi: 'onLlmCallPreparedHook', event: 'on_llm_call_prepared', adapter: 'context' },
  { pi: 'beforeLlmCallHook', event: 'before_llm_call', adapter: 'context' },
  { pi: 'afterLlmCallHook', event: 'after_llm_call', adapter: 'context' },
  { pi: 'beforeToolCallHook', event: 'before_tool_call', adapter: 'tool-context' },
  { pi: 'afterToolCallHook', event: 'after_tool_call', adapter: 'tool-context' },
  { pi: 'onHistoryChangedHook', event: 'on_history_changed', adapter: 'context' },
  { pi: 'onStepEndHook', event: 'on_step_end', adapter: 'context' },
] as const satisfies readonly {
  pi: keyof PiTurnHooks;
  event: HookName;
  adapter: 'context' | 'tool-context';
}[];

export class Registry {
  private readonly extensions = new Map<string, LoadedExtension>();
  private activeLoaded: LoadedExtension | null = null;
  private lifecycleState: RegistryLifecycleState = 'new';
  private readonly sessionOverrides = new Map<string, Map<string, boolean>>();

  /**
   * Per-profile params merged from `ProfileOverlay.param`, passed once by `createAgentRuntime`.
   * Extensions read them through `pi.params` during `init` (document §4.4 line 281).
   */
  readonly params: Readonly<Record<string, unknown>>;

  constructor(params: Readonly<Record<string, unknown>> = {}) {
    this.params = params;
  }

  // ─── init & control plane ──────────────────────────────────────────

  async initExtensions(extensions: readonly AgentExtension[]): Promise<void> {
    if (this.lifecycleState !== 'new') {
      const calledTwice = this.lifecycleState === 'ready' ? '; cannot be called twice' : '';
      throw new Error(
        `Registry.initExtensions requires registry state 'new'; current state is '${this.lifecycleState}'${calledTwice}`,
      );
    }
    this.lifecycleState = 'initializing';
    try {
      for (const ext of extensions) {
        if (this.extensions.has(ext.id)) {
          throw new Error(`Duplicate extension id during init: ${ext.id}`);
        }
        const loaded = createEmptyLoaded(ext);
        this.extensions.set(ext.id, loaded);
        this.activeLoaded = loaded;
        try {
          await ext.init(this.createExtensionApi(loaded));
        } finally {
          this.activeLoaded = null;
        }
      }
      this.lifecycleState = 'ready';
    } catch (error) {
      this.lifecycleState = 'failed';
      this.extensions.clear();
      this.sessionOverrides.clear();
      throw error;
    }
  }

  setEnabled(extensionId: string, enabled: boolean, scope?: EnabledScope): void {
    this.assertReady('setEnabled');
    if (!this.extensions.has(extensionId)) {
      throw new Error(`Registry.setEnabled: unknown extension id: ${extensionId}`);
    }
    if (scope?.sessionId) {
      let sessionMap = this.sessionOverrides.get(scope.sessionId);
      if (!sessionMap) {
        sessionMap = new Map();
        this.sessionOverrides.set(scope.sessionId, sessionMap);
      }
      sessionMap.set(extensionId, enabled);
    } else {
      const loaded = this.extensions.get(extensionId);
      if (loaded) loaded.enabledGlobal = enabled;
    }
  }

  listExtensions(scope?: EnabledScope): ExtensionState[] {
    this.assertReady('listExtensions');
    const sessionMap = scope?.sessionId ? this.sessionOverrides.get(scope.sessionId) : undefined;
    const out: ExtensionState[] = [];
    for (const loaded of this.extensions.values()) {
      const sessionOverride = sessionMap?.get(loaded.id);
      const enabled = sessionOverride ?? loaded.enabledGlobal;
      out.push({
        id: loaded.id,
        description: loaded.description,
        enabled,
        contributions: contributionStats(loaded),
      });
    }
    return out;
  }

  disposeSession(sessionId: string): void {
    this.assertReady('disposeSession');
    this.sessionOverrides.delete(sessionId);
  }

  private assertReady(method: string): void {
    if (this.lifecycleState !== 'ready') {
      throw new Error(
        `Registry.${method} requires registry state 'ready'; current state is '${this.lifecycleState}'`,
      );
    }
  }

  private isEnabled(loaded: LoadedExtension, ctx?: { readonly sessionId: string }): boolean {
    if (ctx) {
      const override = this.sessionOverrides.get(ctx.sessionId)?.get(loaded.id);
      if (override !== undefined) return override;
    }
    return loaded.enabledGlobal;
  }

  // ─── Owner-scoped ExtensionAPI ─────────────────────────────────────

  private createExtensionApi(owner: LoadedExtension): ExtensionAPI {
    return {
      params: this.params,
      registerTool: <
        S extends TSchema = TSchema,
        TCtx extends ToolExecutionContext = ToolExecutionContext,
      >(
        contribution: RuntimeToolContribution<S, TCtx>,
      ): void => {
        this.registerTool(owner, contribution);
      },
      contributeSystemPrompt: (fn): void => {
        this.contributeSystemPrompt(owner, fn);
      },
      contributeUserPromptPrefix: (fn): void => {
        this.contributeUserPromptPrefix(owner, fn);
      },
      registerReminderProvider: (provider): void => {
        this.registerReminderProvider(owner, provider);
      },
      on: <K extends HookName>(event: K, handler: HandlerFor<K>): void => {
        this.registerHook(owner, event, handler);
      },
    };
  }

  private registerTool<
    S extends TSchema = TSchema,
    TCtx extends ToolExecutionContext = ToolExecutionContext,
  >(owner: LoadedExtension, contribution: RuntimeToolContribution<S, TCtx>): void {
    this.assertActiveOwner(owner, 'registerTool');
    owner.tools.push(contribution as RuntimeToolContribution);
  }

  private contributeSystemPrompt(owner: LoadedExtension, fn: SystemPromptContributor): void {
    this.assertActiveOwner(owner, 'contributeSystemPrompt');
    owner.systemPromptContributors.push(fn);
  }

  private contributeUserPromptPrefix(owner: LoadedExtension, fn: UserPromptContributor): void {
    this.assertActiveOwner(owner, 'contributeUserPromptPrefix');
    owner.userPromptContributors.push(fn);
  }

  private registerReminderProvider(owner: LoadedExtension, provider: ReminderProvider): void {
    this.assertActiveOwner(owner, 'registerReminderProvider');
    owner.reminderProviders.push(provider);
  }

  private registerHook<K extends HookName>(
    owner: LoadedExtension,
    event: K,
    handler: HandlerFor<K>,
  ): void {
    this.assertActiveOwner(owner, `on(${event})`);
    // Per-event typed push; adding a new event = extend HOOK_NAMES + HookHandlerMap,
    // no code change here.
    owner.hookHandlers[event].push(handler);
  }

  private assertActiveOwner(owner: LoadedExtension, method: string): void {
    if (this.lifecycleState !== 'initializing') {
      throw new Error(
        `Registry.${method} can only be called during extension init(). ` +
          `Current registry state is '${this.lifecycleState}'. ` +
          'Storing the pi reference for later use is forbidden.',
      );
    }
    if (this.activeLoaded !== owner) {
      const activeOwner = this.activeLoaded?.id;
      const activeOwnerDetail = activeOwner ? `; active owner is '${activeOwner}'.` : '.';
      throw new Error(
        `Registry.${method}: ExtensionAPI owner '${owner.id}' is outside its init window${activeOwnerDetail}`,
      );
    }
  }

  // ─── Assembly ───────────────────────────────────────────────────────

  async assembleModelContext(
    ctx: ModelContextAssemblyCtx,
    seed?: ModelContextAssemblySeed,
  ): Promise<ModelContextAssemblyResult> {
    this.assertReady('assembleModelContext');
    const tools: RuntimeTool[] = [...(seed?.tools ?? [])];
    const systemPrefixes: string[] = [];
    const toolNames = collectSeedToolNames(tools);

    for (const { loaded, enabled } of this.snapshotExtensions(ctx)) {
      if (!enabled) continue;
      if (loaded.tools.length > 0 || loaded.systemPromptContributors.length > 0) {
        await this.appendModelContextContributions(loaded, ctx, tools, systemPrefixes, toolNames);
      }
    }

    return { systemPromptPrefix: systemPrefixes.join('\n\n'), tools };
  }

  async assembleTurn(ctx: TurnAssemblyCtx, seed?: TurnAssemblySeed): Promise<AssemblyResult> {
    this.assertReady('assembleTurn');
    const tools: RuntimeTool[] = [...(seed?.tools ?? [])];
    const systemPrefixes: string[] = [];
    const userPrefixes: string[] = seed?.userPromptPrefix ? [seed.userPromptPrefix] : [];
    const reminders: ReminderEmission[] = [];

    const hooks: PiTurnHooks = {
      beforeLlmCallHook: [],
      afterLlmCallHook: [],
      beforeToolCallHook: [],
      afterToolCallHook: [],
      onHistoryChangedHook: [],
      // Use `onStepEndHook` with explicit step semantics. During this migration window, agent-core's `newTurn`
      // still reads legacy `onTurnEndHook`; agent-runtime only writes the new field.
      onStepEndHook: [],
    };
    const turnStartHandlers: TurnStartHandler[] = [];
    const turnEndHandlers: TurnEndHandler[] = [];

    const extensionSnapshots = this.snapshotExtensions(ctx);
    const loadedExtensions = extensionSnapshots.map(({ loaded }) => loaded);
    const enabledIds: string[] = [];
    const disabledIds: string[] = [];
    const toolNames = collectSeedToolNames(tools);

    for (const { loaded, enabled } of extensionSnapshots) {
      if (!enabled) {
        disabledIds.push(loaded.id);
        continue;
      }
      enabledIds.push(loaded.id);

      if (loaded.tools.length > 0 || loaded.systemPromptContributors.length > 0) {
        await this.appendModelContextContributions(loaded, ctx, tools, systemPrefixes, toolNames);
      }
      for (const fn of loaded.userPromptContributors) {
        const s = await fn(ctx);
        if (s) userPrefixes.push(s);
      }

      for (const provider of loaded.reminderProviders) {
        const emission = await provider.compute(ctx);
        if (emission) {
          reminders.push({ providerName: provider.name, reminder: emission });
        }
      }

      // Merge pi step-level hooks via a table to avoid five scattered edits (review Standards S-4).
      // PiTurnHooks fields have different types whose intersection is never; narrow through a helper.
      for (const mapping of HOOK_MAPPINGS) {
        const source = loaded.hookHandlers[mapping.event];
        if (source.length === 0) continue;
        const wrapped = source.map((handler) =>
          mapping.adapter === 'tool-context'
            ? wrapToolWithCtx(handler as HandlerWithSignalAndCtx, ctx)
            : wrapWithCtx(handler as HandlerWithCtx, ctx),
        );
        appendHooks(hooks, mapping.pi, wrapped);
      }

      turnStartHandlers.push(...loaded.hookHandlers.turn_start);
      turnEndHandlers.push(...loaded.hookHandlers.turn_end);
    }

    // Sort reminders by descending priority, then insertion order (Array.prototype.sort
    // is stable in ES2019+). The registry only provides independent emissions; prompt
    // contributors cannot read this list. The host decides how to render / inject it.
    reminders.sort((a, b) => (b.reminder.priority ?? 0) - (a.reminder.priority ?? 0));

    const userPromptPrefix = userPrefixes.join('\n\n');

    const diagnostic: AssemblyDiagnostic = {
      loadedExtensions: loadedExtensions.map((l) => l.id),
      enabledExtensions: enabledIds,
      disabledExtensions: disabledIds,
      toolCount: tools.length,
      reminderCount: reminders.length,
    };

    return {
      systemPromptPrefix: systemPrefixes.join('\n\n'),
      userPromptPrefix,
      tools,
      hooks,
      reminders,
      turnStartHandlers,
      turnEndHandlers,
      diagnostic,
    };
  }

  private snapshotExtensions(ctx: ModelContextAssemblyCtx): readonly {
    readonly loaded: LoadedExtension;
    readonly enabled: boolean;
  }[] {
    // Snapshot all enablement before the first contribution can yield.
    return [...this.extensions.values()].map((loaded) => ({
      loaded,
      enabled: this.isEnabled(loaded, ctx),
    }));
  }

  private async appendModelContextContributions(
    loaded: LoadedExtension,
    ctx: ModelContextAssemblyCtx,
    tools: RuntimeTool[],
    systemPrefixes: string[],
    toolNames: Set<string>,
  ): Promise<void> {
    for (const contribution of loaded.tools) {
      const resolved = typeof contribution === 'function' ? await contribution(ctx) : contribution;
      if (!resolved) continue;
      const catalog = isRuntimeToolCatalog(resolved) ? resolved : [resolved];
      for (const tool of catalog) {
        const name = tool.def.name;
        if (toolNames.has(name)) {
          throw new Error(
            `Duplicate tool name '${name}' contributed by extension '${loaded.id}' (already registered by an earlier extension).`,
          );
        }
        toolNames.add(name);
        tools.push(tool);
      }
    }

    for (const fn of loaded.systemPromptContributors) {
      const prefix = await fn(ctx);
      if (prefix) systemPrefixes.push(prefix);
    }
  }
}

function collectSeedToolNames(tools: readonly RuntimeTool[]): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    const name = tool.def.name;
    if (names.has(name)) throw new Error(`Duplicate tool name '${name}' in assembly seed.`);
    names.add(name);
  }
  return names;
}

// ─── Hook wrappers ────────────────────────────────────────────────────
//
// PiTurnRunner's hook signature (input) contains only pi payloads, without TurnAssemblyCtx.
// SPI handlers take (event, ctx); capture ctx during assembly to restore pi's single-argument signature.
// `wrapWithCtx` is the only adapter. Forward return values too, preserving `undefined` for
// `before_llm_call` short-circuit semantics.

type HandlerWithCtx<E = unknown, R = unknown> = (event: E, ctx: TurnAssemblyCtx) => R | Promise<R>;

type HandlerWithSignalAndCtx<E = unknown, R = unknown> = (
  event: E,
  signal: AbortSignal | undefined,
  ctx: TurnAssemblyCtx,
) => R | Promise<R>;

function wrapWithCtx<E, R>(
  handler: HandlerWithCtx<E, R>,
  ctx: TurnAssemblyCtx,
): (event: E) => Promise<R | undefined> {
  return async (event: E) => {
    const result = await handler(event, ctx);
    return result ?? undefined;
  };
}

function wrapToolWithCtx<E, R>(
  handler: HandlerWithSignalAndCtx<E, R>,
  ctx: TurnAssemblyCtx,
): (event: E, signal?: AbortSignal) => Promise<R | undefined> {
  return async (event: E, signal?: AbortSignal) => {
    const result = await handler(event, signal, ctx);
    return result ?? undefined;
  };
}

/**
 * Append handlers into a `PiTurnHooks` field via a narrowed helper. `PiTurnHooks`'s
 * fields have different function signatures, so writing `hooks[key] = [...]` widens
 * to `never` on intersection. Casting inside a helper keeps the unsafe write in one
 * place and lets callers stay type-driven via `HOOK_MAPPINGS`.
 */
function appendHooks(hooks: PiTurnHooks, key: keyof PiTurnHooks, values: readonly unknown[]): void {
  const existing = (hooks[key] ?? []) as readonly unknown[];
  (hooks as Record<keyof PiTurnHooks, readonly unknown[]>)[key] = [...existing, ...values];
}
