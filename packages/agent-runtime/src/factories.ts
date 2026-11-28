/**
 * Extension factory helpers let hosts wrap plain objects as `AgentExtension` in one call, avoiding
 * repeated `{ id, description, init(pi) { pi.registerXxx(...) } }` boilerplate.
 *
 * The design document §4.3 table lists eight extensions (`permission / context-manager / memory /
 * system-reminder / mcp-disclosure / desktop-tools / skills / internal-tool-handlers`).
 * Module-to-SPI adapters for `context-manager / system-reminder / permission / skills` are exported
 * centrally by `@mavis/agent-extension`. Thin wrappers for host-only behavior such as
 * `mcp-disclosure / desktop-tools / internal-tool-handlers / memory / output-review-preface` can
 * use these generic factories around existing host helpers such as `hookService.beforeToolCall` /
 * `mcpDisclosureOptions`, without a separate module-level factory for each host-only module.
 *
 * Example (local-runtime host assembly):
 *
 *   const userHooksExtension = createHookExtension({
 *     id: 'internal-tool-handlers',
 *     description: 'Product-internal tool handlers (before/after tool)',
 *     handlers: {
 *       before_tool_call: (toolContext) => hookService.beforeToolCall({ toolContext }),
 *       after_tool_call: (toolContext) => hookService.afterToolCall({ toolContext }),
 *     },
 *   });
 *
 *   const mcpDisclosureExtension = createToolExtension({
 *     id: 'mcp-disclosure',
 *     description: 'Per-turn dynamic MCP tool exposure via progressive disclosure',
 *     tools: [(ctx) => resolveMcpDisclosureTool(ctx, mcpDisclosureOptions)],
 *   });
 *
 * All factories are pure; the host manages the lifecycle of captured host state.
 */

import type {
  AgentExtension,
  ExtensionAPI,
  HandlerFor,
  HookName,
  ModelContextAssemblyCtx,
  PromptContributor,
  ReminderProvider,
  RuntimeToolContribution,
  SystemPromptContributor,
  TurnAssemblyCtx,
  UserPromptContributor,
} from './types.js';
import { HOOK_NAMES } from './types.js';

/**
 * Shared handler-bucket shape used by both `createHookExtension` and the
 * composite `createExtension`. Derived from `HookHandlerMap` in `types.ts` so
 * `HOOK_NAMES` + `HookHandlerMap` are the single sources of truth—adding a
 * new SPI event never requires editing this file. Each field accepts a single
 * handler or an array (host convenience).
 */
export type HookHandlers = {
  readonly [K in HookName]?: HandlerFor<K> | readonly HandlerFor<K>[];
};

/**
 * `createToolExtension`: Expose a host's static tools or per-turn tool factories as an extension.
 * Equivalent to calling `pi.registerTool(...)` for each tool.
 */
export interface CreateToolExtensionOptions {
  readonly id: string;
  readonly description?: string;
  readonly tools: readonly RuntimeToolContribution[];
  /** Optional pre-init hook for host-side setup (metrics, warmup) at extension load. */
  readonly onInit?: (pi: ExtensionAPI) => void | Promise<void>;
}

export function createToolExtension(options: CreateToolExtensionOptions): AgentExtension {
  const { id, description, tools, onInit } = options;
  return {
    id,
    description,
    async init(pi) {
      if (onInit) await onInit(pi);
      for (const tool of tools) {
        pi.registerTool(tool);
      }
    },
  };
}

/**
 * `createHookExtension`: Expose a host's lifecycle hooks (e.g. external coding-agent
 * internal-tool-handlers) as an extension. All lifecycle events are optional.
 */
export interface CreateHookExtensionOptions {
  readonly id: string;
  readonly description?: string;
  readonly handlers?: HookHandlers;
}

/**
 * Wire every non-empty handler bucket onto `pi.on(event, handler)`. Iterates
 * `HOOK_NAMES` so adding a new SPI event only requires extending that array
 * plus `HookHandlerMap` in `types.ts`—no per-factory shotgun edit. Uses the
 * generic `ExtensionAPI.on<K>` overload so the per-event handler type stays
 * type-safe at every call site.
 */
function wireHandlers(pi: ExtensionAPI, handlers: HookHandlers): void {
  for (const name of HOOK_NAMES) {
    const bucket = handlers[name] as
      | HandlerFor<typeof name>
      | readonly HandlerFor<typeof name>[]
      | undefined;
    if (bucket === undefined) continue;
    const list = Array.isArray(bucket) ? bucket : [bucket];
    for (const h of list) pi.on(name, h);
  }
}

export function createHookExtension(options: CreateHookExtensionOptions): AgentExtension {
  const { id, description, handlers } = options;
  return {
    id,
    description,
    init(pi) {
      if (handlers) wireHandlers(pi, handlers);
    },
  };
}

/**
 * `createPromptExtension`: Wrap static host system/user prompt prefixes as an extension. Equivalent
 * to `pi.contributeSystemPrompt(fn) + pi.contributeUserPromptPrefix(fn)`. Primarily wraps
 * `output-review-preface` constants such as `Read the last review carefully before your next
 * assistant turn.`
 */
export interface CreatePromptExtensionOptions {
  readonly id: string;
  readonly description?: string;
  readonly systemPrompt?: SystemPromptContributor | string;
  readonly userPromptPrefix?: UserPromptContributor | string;
}

function toContributor<TContext extends ModelContextAssemblyCtx>(
  v: PromptContributor<TContext> | string | undefined,
): PromptContributor<TContext> | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'string' ? () => v : v;
}

export function createPromptExtension(options: CreatePromptExtensionOptions): AgentExtension {
  const { id, description, systemPrompt, userPromptPrefix } = options;
  const systemFn = toContributor<ModelContextAssemblyCtx>(systemPrompt);
  const userFn = toContributor<TurnAssemblyCtx>(userPromptPrefix);
  return {
    id,
    description,
    init(pi) {
      if (systemFn) pi.contributeSystemPrompt(systemFn);
      if (userFn) pi.contributeUserPromptPrefix(userFn);
    },
  };
}

/**
 * `createReminderExtension`: Wrap a host's reminder providers as an extension (`memory`, custom
 * host reminder packs, etc.).
 */
export interface CreateReminderExtensionOptions {
  readonly id: string;
  readonly description?: string;
  readonly providers: readonly ReminderProvider[];
}

export function createReminderExtension(options: CreateReminderExtensionOptions): AgentExtension {
  const { id, description, providers } = options;
  return {
    id,
    description,
    init(pi) {
      for (const provider of providers) {
        pi.registerReminderProvider(provider);
      }
    },
  };
}

/**
 * `createExtension` —— composite catch-all when an extension mixes contributions
 * across categories. Design doc §4.3 has a natural composite:
 *   - `mcp-disclosure` → `registerTool` (per-turn factory) + `contributeUserPromptPrefix`
 * Hand-rolling `{ id, init }` works but this catch-all keeps everything in one
 * option bag so hosts don't have to spread across multiple extensions (which
 * would leak internal ids like `mcp-disclosure-tool` / `-prompt` into the
 * `listExtensions` / `setEnabled` UX).
 */
export interface CreateExtensionOptions {
  readonly id: string;
  readonly description?: string;
  readonly tools?: readonly RuntimeToolContribution[];
  readonly systemPrompt?: SystemPromptContributor | string;
  readonly userPromptPrefix?: UserPromptContributor | string;
  readonly reminderProviders?: readonly ReminderProvider[];
  readonly handlers?: HookHandlers;
  /** Pre-init hook — runs before any pi.registerXxx / pi.on call. */
  readonly onInit?: (pi: ExtensionAPI) => void | Promise<void>;
}

export function createExtension(options: CreateExtensionOptions): AgentExtension {
  const {
    id,
    description,
    tools = [],
    systemPrompt,
    userPromptPrefix,
    reminderProviders = [],
    handlers,
    onInit,
  } = options;
  const systemFn = toContributor<ModelContextAssemblyCtx>(systemPrompt);
  const userFn = toContributor<TurnAssemblyCtx>(userPromptPrefix);
  return {
    id,
    description,
    async init(pi) {
      if (onInit) await onInit(pi);
      for (const tool of tools) pi.registerTool(tool);
      if (systemFn) pi.contributeSystemPrompt(systemFn);
      if (userFn) pi.contributeUserPromptPrefix(userFn);
      for (const provider of reminderProviders) pi.registerReminderProvider(provider);
      if (handlers) wireHandlers(pi, handlers);
    },
  };
}
