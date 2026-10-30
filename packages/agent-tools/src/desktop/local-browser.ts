import {
  defineRuntimeTool,
  type RuntimeTool,
  type ToolDefinition,
  type ToolResult,
  type ToolResultContent,
} from '@mavis/agent-core/tools';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

import {
  BROWSER_OBSERVABLE_ACTIONS,
  LOCAL_BROWSER_ACTION_INPUT_CONTRACTS,
  LOCAL_BROWSER_ACTION_NAMES,
  LocalBrowserClickToolDef,
  LocalBrowserGetDomToolDef,
  LocalBrowserHoverToolDef,
  LocalBrowserInspectEditableTargetsToolDef,
  LocalBrowserInspectToolDef,
  LocalBrowserObserveInput,
  LocalBrowserNavigateToolDef,
  LocalBrowserPasteToolDef,
  LocalBrowserPressKeyToolDef,
  LocalBrowserScreenshotToolDef,
  LocalBrowserScrollToolDef,
  LocalBrowserToolDef,
  LocalBrowserTypeToolDef,
  LocalBrowserVerifyTextToolDef,
  LocalBrowserWaitForToolDef,
} from './builtin-browser-defs.js';
import {
  observationReadFailure,
  observePage,
  type BrowserObserveRequest,
} from './local-browser-observe.js';
import type {
  LocalBrowserAdapter,
  LocalBrowserSkillSessionStore,
  LocalBrowserToolAction,
  LocalRuntimeTool,
  LocalRuntimeToolContext,
} from './types.js';

export const CONTROL_IN_APP_BROWSER_SKILL_NAME = 'control-in-app-browser';
const SCREENSHOT_DELIVERY_INSTRUCTION =
  'This screenshot is model-visible inspection evidence and is not shown to the user by default. Do not proactively claim it was sent, shared, shown, or attached, and do not emit its delivery markup unless the user explicitly asks to see or receive this screenshot. When explicitly requested, emit userDelivery.mediaMarkup exactly once if userDelivery.available is true. Never expose Base64 or a data URL, and never fabricate a path or markup when delivery is unavailable.';
const COMPACT_HOVER_SEMANTIC_SOURCES = new Set([
  'aria-label',
  'aria-labelledby',
  'title',
  'svg-title',
  'alt',
  'target-text',
  'aria-describedby',
  'hover-tooltip',
  'hover-overlay',
  'none',
]);
const COMPACT_HOVER_CONFIDENCE_LEVELS = new Set(['high', 'medium', 'low']);
// A hidden long action can spend 125s in the render queue and 125s executing.
// Keep one end-to-end tool budget for both bounded phases plus result delivery
// and cleanup. Nested deadlines consume this budget; they do not add to it.
const LOCAL_BROWSER_TOOL_TIMEOUT_MS = 275_000;
const POST_ACTION_VISUAL_TIMEOUT_MS = 5_000;
/** How long a cancelled action may take to report its own abort detail. */
const ABORT_DETAIL_GRACE_MS = 3_000;
// A post-action visual that misses its deadline is abandoned by the tool, but
// the provider keeps owning the Browser session until that screenshot (or its
// abort recovery) settles. Without waiting, the very next action raced it and
// failed with BROWSER_SESSION_BUSY (eval 761096: navigate -> inspect).
const MAX_PENDING_VISUAL_SETTLE_MS = 30_000;
const pendingPostActionVisuals = new WeakMap<LocalBrowserAdapter, Map<string, Promise<void>>>();
// Browser Core admits one action per session and rejects the rest with
// BROWSER_SESSION_BUSY. Models still emit several Browser calls in one
// assistant step (eval 761096: navigate + inspect in the same message), and the
// runtime executes them concurrently. Queue them per session in arrival order
// so the second call observes the first call's result instead of failing.
const browserSessionQueues = new WeakMap<LocalBrowserAdapter, Map<string, Promise<void>>>();
const OBSERVABLE_ACTIONS = new Set<LocalBrowserToolAction>(BROWSER_OBSERVABLE_ACTIONS);
/** Appended to the run_code Browser variant's description; the top-level definition never says it. */
const OBSERVE_DESCRIPTION_SENTENCE =
  'Page-changing actions accept observe to return the page after the action in the same call.';
const COMPACT_INSPECT_CONTINUATION_INSTRUCTION =
  'For truncated inspect results, continue with the returned continuation input; do not invent snapshot IDs or offsets.';

class BrowserOperationTimeoutError extends Error {
  readonly code = 'BROWSER_OPERATION_TIMEOUT';
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`BROWSER_OPERATION_TIMEOUT: Operation "${label}" exceeded ${timeoutMs}ms`);
    this.name = 'BrowserOperationTimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

async function executeWithDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutLabel: string,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let rejectExternalAbort: ((error: Error) => void) | undefined;
  const externalAbortPromise = new Promise<never>((_resolve, reject) => {
    rejectExternalAbort = reject;
  });
  const onExternalAbort = () => {
    const error = Object.assign(new Error('Operation aborted'), { code: 'ABORTED' });
    rejectExternalAbort?.(error);
    controller.abort(error);
  };
  if (externalSignal?.aborted) {
    onExternalAbort();
    return externalAbortPromise;
  }
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new BrowserOperationTimeoutError(timeoutLabel, timeoutMs);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
    timer.unref?.();
  });

  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  try {
    return await Promise.race([operationPromise, timeoutPromise, externalAbortPromise]);
  } catch (error) {
    // On cancellation the operation usually settles moments later with a
    // more specific error (for example run_script's warning that page code
    // may still run). Prefer it when it arrives within a short grace period;
    // otherwise keep the generic cancellation.
    if (externalSignal?.aborted) {
      let cancelGrace = (): void => undefined;
      const specific = await Promise.race<unknown>([
        (operationPromise as Promise<unknown>).then(
          () => undefined,
          (operationError: unknown) => operationError,
        ),
        new Promise<undefined>((resolve) => {
          const graceTimer = setTimeout(() => resolve(undefined), ABORT_DETAIL_GRACE_MS);
          cancelGrace = () => clearTimeout(graceTimer);
        }),
      ]);
      cancelGrace();
      if (specific instanceof Error && isRecord(specific) && specific.code === 'ABORTED') {
        throw specific;
      }
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

export type LocalBrowserToolExposure = 'compact' | 'full' | 'both';

export type LocalBrowserScreenshotPreprocessor = (
  result: unknown,
  ctx: LocalRuntimeToolContext,
  signal?: AbortSignal,
  options?: {
    purpose: 'post-action';
    action: LocalBrowserToolAction;
  },
) => Promise<unknown>;

export interface LocalBrowserRuntimeToolOptions {
  exposure?: LocalBrowserToolExposure;
  preprocessScreenshot?: LocalBrowserScreenshotPreprocessor;
  browserSkillSessionStore?: LocalBrowserSkillSessionStore;
}

interface BrowserRuntimeInternalOptions extends LocalBrowserRuntimeToolOptions {
  postActionVisualCountByTurn: Map<string, number>;
  interactiveTakeover: boolean;
  providerNavigationGuidance: string;
}

export function buildLocalBrowserRuntimeTools(
  adapter: LocalBrowserAdapter,
  options: LocalBrowserRuntimeToolOptions = {},
): LocalRuntimeTool[] {
  const capabilities = adapter.getCapabilities?.();
  const runtimeOptions: BrowserRuntimeInternalOptions = {
    ...options,
    postActionVisualCountByTurn: new Map(),
    interactiveTakeover: capabilities?.interactiveTakeover !== false,
    providerNavigationGuidance: browserProviderNavigationGuidance(capabilities?.provider),
  };
  const exposure = options.exposure ?? 'compact';
  const declaredActions = capabilities?.actions;
  const compactActions = (
    declaredActions ??
    (Object.keys(LOCAL_BROWSER_ACTION_INPUT_CONTRACTS) as LocalBrowserToolAction[])
  ).filter((action) => action in LOCAL_BROWSER_ACTION_INPUT_CONTRACTS);
  const tools: LocalRuntimeTool[] = [];
  if ((exposure === 'compact' || exposure === 'both') && compactActions.length > 0) {
    tools.push(createBrowserCompactRuntimeTool(adapter, runtimeOptions, compactActions));
  }
  if (exposure === 'full' || exposure === 'both') {
    tools.push(...buildDetailedBrowserRuntimeTools(adapter, runtimeOptions, declaredActions));
  }
  return tools;
}

/**
 * Builds the exact compact Browser input contract disclosed by a Host Binding.
 * The Host uses it only to validate a Plugin PreToolUse rewrite of the admitted
 * `mcp_browser` call; it never reaches a model request. Page-changing actions
 * accept `observe` here so a rewrite of a run_code child that carries it stays
 * valid; the model can send `observe` only where the definition declares it
 * (the PTC variant, `withLocalBrowserObserve`).
 */
export function describeLocalBrowserToolInput(target: RuntimeTool): TSchema {
  const actions: unknown = target.def.schema.properties?.action?.enum;
  const allowed = new Set(Array.isArray(actions) ? actions : []);
  return Type.Union(
    Object.entries(LOCAL_BROWSER_ACTION_INPUT_CONTRACTS)
      .filter(([action]) => allowed.has(action))
      .map(([action, contract]) =>
        Type.Object(
          {
            action: Type.Literal(action),
            input: contract.optional ? Type.Optional(contract.schema) : contract.schema,
            ...(OBSERVABLE_ACTIONS.has(action as LocalBrowserToolAction)
              ? { observe: Type.Optional(LocalBrowserObserveInput) }
              : {}),
          },
          { additionalProperties: false },
        ),
      ),
  );
}

/**
 * The compact Browser definition a PTC Turn lists inside run_code: the same
 * tool plus a declared `observe`, so a program acts and reads the result in
 * one call. Only run_code's child catalog uses it (and a direct call of that
 * hidden child); a Turn that lists Browser as a top-level tool keeps its
 * definition byte for byte. The compact argument repair moves unknown
 * top-level keys into `input`, so `observe` is set aside around it. Returns
 * undefined for any definition that is not the compact Browser shape.
 */
export function withLocalBrowserObserve(def: ToolDefinition): ToolDefinition | undefined {
  const properties: unknown = def.schema.properties;
  if (
    def.schema.type !== 'object' ||
    !isRecord(properties) ||
    !('action' in properties) ||
    !('input' in properties) ||
    'observe' in properties
  ) {
    return undefined;
  }
  const prepare = def.prepareArguments;
  return {
    ...def,
    description: `${def.description} ${OBSERVE_DESCRIPTION_SENTENCE}`,
    schema: {
      ...def.schema,
      properties: { ...properties, observe: Type.Optional(LocalBrowserObserveInput) },
    },
    prepareArguments: (args: unknown) => {
      if (!isRecord(args) || !('observe' in args)) return prepare ? prepare(args) : args;
      const { observe, ...rest } = args;
      const prepared: unknown = prepare ? prepare(rest) : rest;
      return isRecord(prepared) ? { ...prepared, observe } : prepared;
    },
  };
}

function buildDetailedBrowserRuntimeTools(
  adapter: LocalBrowserAdapter,
  options: BrowserRuntimeInternalOptions,
  availableActions?: readonly LocalBrowserToolAction[],
): LocalRuntimeTool[] {
  const tools: Array<{ action: LocalBrowserToolAction; tool: LocalRuntimeTool }> = [
    {
      action: 'inspect',
      tool: createBrowserRuntimeTool(LocalBrowserInspectToolDef, 'inspect', adapter, options),
    },
    {
      action: 'navigate',
      tool: createBrowserRuntimeTool(LocalBrowserNavigateToolDef, 'navigate', adapter, options),
    },
    {
      action: 'click',
      tool: createBrowserRuntimeTool(LocalBrowserClickToolDef, 'click', adapter, options),
    },
    {
      action: 'type',
      tool: createBrowserRuntimeTool(LocalBrowserTypeToolDef, 'type', adapter, options),
    },
    {
      action: 'press_key',
      tool: createBrowserRuntimeTool(LocalBrowserPressKeyToolDef, 'press_key', adapter, options),
    },
    {
      action: 'scroll',
      tool: createBrowserRuntimeTool(LocalBrowserScrollToolDef, 'scroll', adapter, options),
    },
    {
      action: 'hover',
      tool: createBrowserRuntimeTool(LocalBrowserHoverToolDef, 'hover', adapter, options),
    },
    {
      action: 'wait_for',
      tool: createBrowserRuntimeTool(LocalBrowserWaitForToolDef, 'wait_for', adapter, options),
    },
    {
      action: 'get_dom',
      tool: createBrowserRuntimeTool(LocalBrowserGetDomToolDef, 'get_dom', adapter, options),
    },
    {
      action: 'screenshot',
      tool: createBrowserRuntimeTool(LocalBrowserScreenshotToolDef, 'screenshot', adapter, options),
    },
    {
      action: 'paste',
      tool: createBrowserRuntimeTool(LocalBrowserPasteToolDef, 'paste', adapter, options),
    },
    {
      action: 'verify_text',
      tool: createBrowserRuntimeTool(
        LocalBrowserVerifyTextToolDef,
        'verify_text',
        adapter,
        options,
      ),
    },
    {
      action: 'inspect_editable_targets',
      tool: createBrowserRuntimeTool(
        LocalBrowserInspectEditableTargetsToolDef,
        'inspect_editable_targets',
        adapter,
        options,
      ),
    },
  ];
  const allowed = availableActions ? new Set(availableActions) : undefined;
  return tools.filter(({ action }) => !allowed || allowed.has(action)).map(({ tool }) => tool);
}

function createBrowserCompactRuntimeTool(
  adapter: LocalBrowserAdapter,
  options: BrowserRuntimeInternalOptions,
  availableActions: readonly LocalBrowserToolAction[],
): LocalRuntimeTool {
  const actions = availableActions;
  const compactActions = actions.filter((action) =>
    (LOCAL_BROWSER_ACTION_NAMES as readonly string[]).includes(action),
  );
  const actionSchema = Type.String({
    enum: compactActions,
    pattern: `^(?:${compactActions.join('|')})$`,
  });
  const def = {
    ...LocalBrowserToolDef,
    description: `${LocalBrowserToolDef.description} ${options.providerNavigationGuidance} ${COMPACT_INSPECT_CONTINUATION_INSTRUCTION} Available actions for this turn: ${actions.join(', ')}.`,
    schema: Type.Object(
      {
        action: actionSchema,
        input: LocalBrowserToolDef.schema.properties.input,
      },
      {
        additionalProperties: false,
        description: LocalBrowserToolDef.schema.description,
      },
    ),
  };
  const actionSet = new Set<LocalBrowserToolAction>(actions);
  return defineRuntimeTool<typeof def.schema, LocalRuntimeToolContext>({
    ...def,
    prepareArguments: (args) =>
      prepareCompactBrowserArguments(args, compactActions) as Static<typeof def.schema>,
    async execute(ctx, input, signal) {
      const action = input.action as LocalBrowserToolAction;
      if (!actionSet.has(action)) {
        return browserToolError(
          LocalBrowserToolDef.name,
          action,
          `Browser action "${action}" is not available from the current provider.`,
          'capability_unavailable',
        );
      }
      const contract =
        LOCAL_BROWSER_ACTION_INPUT_CONTRACTS[
          action as keyof typeof LOCAL_BROWSER_ACTION_INPUT_CONTRACTS
        ];
      if (input.input === undefined && !contract.optional) {
        return browserToolError(
          LocalBrowserToolDef.name,
          action,
          // Eval 777827: `{"action":"press_key\">"}` arrived with its fields lost.
          `Missing input for browser action "${action}". Put the action's fields inside "input", for example {"action": "${action}", "input": {...}}.`,
          'invalid_input',
        );
      }

      // Declared only by the run_code variant (withLocalBrowserObserve); the
      // top-level schema rejects it before execute, so a direct Turn never
      // gets here with it.
      const observe = (input as { readonly observe?: unknown }).observe;
      if (observe !== undefined) {
        if (!OBSERVABLE_ACTIONS.has(action)) {
          return browserToolError(
            LocalBrowserToolDef.name,
            action,
            `observe is accepted only by page-changing actions (${[...OBSERVABLE_ACTIONS].join(', ')}).`,
            'invalid_input',
          );
        }
        if (!Value.Check(LocalBrowserObserveInput, observe)) {
          return browserToolError(
            LocalBrowserToolDef.name,
            action,
            'observe must be { kind: "inspect" | "text", selector?, waitForText?, timeout?, maxChars? }.',
            'invalid_input',
          );
        }
      }

      const rawInput = normalizeBrowserActionInput(action, input.input ?? {});
      if (!Value.Check(contract.schema, rawInput)) {
        return browserToolError(
          LocalBrowserToolDef.name,
          action,
          describeBrowserContractMismatch(action, contract.schema, rawInput),
          'invalid_input',
        );
      }

      const validatedInput = rawInput as Record<string, unknown>;
      const semanticError = validateCompactBrowserInput(action, validatedInput);
      if (semanticError) {
        return browserToolError(LocalBrowserToolDef.name, action, semanticError, 'invalid_input');
      }

      return executeBrowserAction(
        LocalBrowserToolDef.name,
        action,
        adapter,
        ctx,
        validatedInput,
        signal,
        'compact',
        options.preprocessScreenshot,
        options.browserSkillSessionStore,
        options.postActionVisualCountByTurn,
        options.interactiveTakeover,
        observe as BrowserObserveRequest | undefined,
      );
    },
  });
}

function createBrowserRuntimeTool<S extends TSchema>(
  def: ToolDefinition<S>,
  action: LocalBrowserToolAction,
  adapter: LocalBrowserAdapter,
  options: BrowserRuntimeInternalOptions,
): LocalRuntimeTool {
  return defineRuntimeTool<S, LocalRuntimeToolContext>({
    ...def,
    ...(action === 'navigate'
      ? { description: `${def.description} ${options.providerNavigationGuidance}` }
      : {}),
    async execute(ctx, input, signal) {
      return executeBrowserAction(
        def.name,
        action,
        adapter,
        ctx,
        input,
        signal,
        'full',
        options.preprocessScreenshot,
        options.browserSkillSessionStore,
        options.postActionVisualCountByTurn,
        options.interactiveTakeover,
      );
    },
  });
}

function browserProviderNavigationGuidance(provider: string | undefined): string {
  if (provider === 'electron-file-panel') {
    return 'Active Browser provider: electron-file-panel. Use navigate only when the current FilePanel tab is absent or blank. A loaded FilePanel tab is user-visible, so use open_tab by default to preserve it. Use navigate with replaceCurrentTab: true only when the user explicitly asks to replace the current tab; omitting the flag on a loaded tab fails closed, and you must not add it merely to recover from choosing navigate incorrectly.';
  }
  if (provider === 'native-headless-chrome') {
    return 'Active Browser provider: native-headless-chrome. Use fully qualified absolute HTTP(S) URLs. Use navigate to replace the current headless working page by default. Use open_tab only when the user explicitly requests another tab or the task requires preserving the current page.';
  }
  return 'Follow the active Browser provider navigation policy when choosing between navigate and open_tab.';
}

type BrowserResultExposure = 'compact' | 'full';

async function executeBrowserAction(
  toolName: string,
  action: LocalBrowserToolAction,
  adapter: LocalBrowserAdapter,
  ctx: LocalRuntimeToolContext,
  input: unknown,
  signal?: AbortSignal,
  exposure: BrowserResultExposure = 'full',
  preprocessScreenshot?: LocalBrowserScreenshotPreprocessor,
  browserSkillSessionStore?: LocalBrowserSkillSessionStore,
  postActionVisualCountByTurn?: Map<string, number>,
  interactiveTakeover = true,
  observe?: BrowserObserveRequest,
): Promise<ToolResult> {
  let releaseSession: (() => void) | undefined;
  try {
    releaseSession = await acquireBrowserSessionTurn(adapter, ctx.sessionId, signal);
    return await executeWithDeadline(
      async (operationSignal) => {
        // A supplied session store is authoritative because committed history
        // replacement clears it while the current turn's loadedSkills Set survives.
        const browserSkillLoaded = browserSkillSessionStore
          ? browserSkillSessionStore.hasLoaded(ctx.sessionId)
          : !ctx.loadedSkills || ctx.loadedSkills.has(CONTROL_IN_APP_BROWSER_SKILL_NAME);
        if (!browserSkillLoaded) {
          const requiredSkillName =
            browserSkillSessionStore?.requiredSkillName ?? CONTROL_IN_APP_BROWSER_SKILL_NAME;
          return browserToolError(
            toolName,
            action,
            `Load the current complete ${requiredSkillName} skill before using Browser. Re-read it if the installed Skill has changed.`,
            'SKILL_REQUIRED',
          );
        }

        const rawInput = isRecord(input) ? input : {};
        await waitForPendingPostActionVisual(adapter, ctx.sessionId, operationSignal);
        const rawResult = await Promise.resolve(
          adapter.execute(ctx, action, rawInput, operationSignal),
        );
        const result =
          action === 'screenshot' && preprocessScreenshot
            ? await preprocessScreenshot(rawResult, ctx, operationSignal)
            : action === 'run_script' && preprocessScreenshot
              ? await preprocessScriptScreenshots(
                  rawResult,
                  ctx,
                  operationSignal,
                  preprocessScreenshot,
                )
              : rawResult;
        const postActionVisual =
          action === 'screenshot' || action === 'run_script'
            ? undefined
            : await capturePostActionVisual(
                action,
                rawInput,
                rawResult,
                adapter,
                ctx,
                operationSignal,
                preprocessScreenshot,
                postActionVisualCountByTurn,
              );
        const actionResult = browserToolResult(
          toolName,
          action,
          result,
          exposure,
          postActionVisual,
          interactiveTakeover,
        );
        // An ordinary click that navigated reports UNEXPECTED_NAVIGATION: the
        // input did run and the page moved, which is exactly when the model
        // must read the new page. Observe it instead of spending a round trip.
        const navigated = readResultCode(actionResult) === 'UNEXPECTED_NAVIGATION';
        if (
          !observe ||
          (actionResult.isError && !navigated) ||
          readRequiredNextToolMarker(actionResult)
        ) {
          return actionResult;
        }
        // Read only after the post-action screenshot has settled: the provider
        // admits one action per session and refuses a read sent alongside it.
        await waitForPendingPostActionVisual(adapter, ctx.sessionId, operationSignal);
        let observed: ToolResult;
        let waitTimedOut = false;
        try {
          const observation = await observePage(
            observe,
            adapter,
            ctx,
            operationSignal,
            MAX_PENDING_VISUAL_SETTLE_MS,
          );
          waitTimedOut = observation.waitTimedOut;
          observed = browserToolResult(
            toolName,
            observation.kind === 'inspect' ? 'inspect' : 'query',
            observation.result,
            exposure,
            undefined,
            interactiveTakeover,
          );
        } catch (error) {
          // Cancellation keeps its existing path; any other read failure is
          // observation evidence and must not turn the finished action into an error.
          if (operationSignal.aborted) throw error;
          observed = observationReadFailure(toolName, observe, error);
        }
        return withObservation(actionResult, observed, waitTimedOut);
      },
      LOCAL_BROWSER_TOOL_TIMEOUT_MS,
      'Local Browser tool',
      signal,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const errorCode =
      isRecord(error) &&
      typeof error.code === 'string' &&
      /^[A-Za-z][A-Za-z0-9_]*$/u.test(error.code)
        ? error.code
        : undefined;
    const normalizedErrorCode =
      errorCode === 'aborted'
        ? 'ABORTED'
        : errorCode === 'browser_operation_timeout' ||
            errorCode === 'background_render_operation_timeout' ||
            errorCode === 'background_render_queue_timeout'
          ? 'BROWSER_OPERATION_TIMEOUT'
          : errorCode;
    const structuredCode = normalizedErrorCode ?? /^([A-Z][A-Z0-9_]+):/u.exec(message)?.[1];
    const label =
      isRecord(error) && typeof error.label === 'string'
        ? error.label.trim().slice(0, 200)
        : undefined;
    const timeoutMs =
      isRecord(error) &&
      typeof error.timeoutMs === 'number' &&
      Number.isFinite(error.timeoutMs) &&
      error.timeoutMs > 0
        ? error.timeoutMs
        : undefined;
    const brokerCode =
      isRecord(error) &&
      typeof error.brokerCode === 'string' &&
      /^[a-z][a-z0-9_]*$/u.test(error.brokerCode)
        ? error.brokerCode
        : undefined;
    return browserToolError(toolName, action, message, structuredCode ?? 'execution_failed', {
      ...(label ? { label } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(brokerCode ? { brokerCode } : {}),
    });
  } finally {
    releaseSession?.();
  }
}

/**
 * Recovery guidance for thrown interruptions. Browser Core invalidates every
 * opaque ref after an interrupted action and the provider may recreate the
 * tab (it then reads `about:blank`), but the raw CDP message says neither.
 * Eval 769392 (0117_linkedin): after `CDP command timed out: Runtime.evaluate`
 * the model clicked pre-timeout refs twice (both STALE_ELEMENT_REF) before an
 * inspect revealed the blank tab. The text only states what happened and what
 * to read next; `details.error` stays the raw message for structured callers.
 */
const BROWSER_INTERRUPTION_RECOVERY: Readonly<Record<string, string>> = {
  BROWSER_OPERATION_TIMEOUT:
    'The page did not respond in time, so the action outcome is unknown. Refs issued before this error may no longer resolve and the tab may have been reset; inspect the current page (navigate again if it is about:blank) before retrying.',
  ACTION_TIMEOUT:
    'The action outcome is unknown. Refs issued before this error may no longer resolve; inspect the current page before retrying.',
};

function browserToolError(
  toolName: string,
  action: LocalBrowserToolAction,
  message: string,
  code: string,
  metadata: { label?: string; timeoutMs?: number; brokerCode?: string } = {},
): ToolResult {
  const recovery = BROWSER_INTERRUPTION_RECOVERY[code];
  const text = `<browser_error action="${action}" code="${code}">${message}${recovery ? ` ${recovery}` : ''}</browser_error>`;
  return {
    tool_name: toolName,
    text,
    content: [{ type: 'text', text }],
    details: { action, ok: false, code, error: message, ...metadata },
    isError: true,
  };
}

function browserToolResult(
  toolName: string,
  action: LocalBrowserToolAction,
  result: unknown,
  exposure: BrowserResultExposure,
  postActionVisual?: PostActionVisualCapture,
  interactiveTakeover = true,
): ToolResult {
  const resultIsFailure = isRecord(result) && result.success === false;
  const screenshot = screenshotContent(result);
  const postActionScreenshot = screenshotContent(postActionVisual?.result);
  const scriptScreenshots = action === 'run_script' ? scriptScreenshotContents(result) : [];
  let sanitized =
    action === 'screenshot'
      ? summarizeScreenshotResult(result, screenshot !== undefined && !resultIsFailure)
      : action === 'run_script'
        ? summarizeScriptResult(result, resultIsFailure)
        : exposure === 'compact' && action !== 'inspect' && action !== 'query'
          ? summarizeCompactActionResult(action, result)
          : exposure === 'compact'
            ? sanitizeBrowserResult(result, COMPACT_PRIVATE_RESULT_KEYS)
            : sanitizeBrowserResult(result);
  if (exposure === 'compact') sanitized = appendBrowserReadingGuidance(action, sanitized);
  sanitized = appendBrowserSafetyGuidance(action, sanitized, interactiveTakeover);
  if (
    !resultIsFailure &&
    postActionVisual &&
    (postActionScreenshot || isDeduplicatedVisual(postActionVisual.result))
  ) {
    sanitized = appendPostActionVisualSummary(action, sanitized, postActionVisual);
  }
  if (resultIsFailure && (screenshot || postActionScreenshot || scriptScreenshots.length > 0)) {
    sanitized = appendErrorVisualOmissionNote(action, sanitized);
  }
  let text = JSON.stringify({ action, result: sanitized }, null, 2);
  let resultTooLarge = false;
  if (exposure === 'compact' && Buffer.byteLength(text, 'utf8') > MAX_COMPACT_BROWSER_TEXT_BYTES) {
    // Browser Core budgets pages as compact JSON; two-space indentation alone
    // can push a fitting page past 64 KiB (eval 761096: 8 bare inspects
    // failed with BROWSER_RESULT_TOO_LARGE). Oversized results are therefore
    // serialized without indentation and, as a last resort, an inspect page
    // is shortened with an exact continuation instead of being discarded.
    sanitized = compactOversizedInspectResult(action, sanitized);
    sanitized = appendBrowserReadingGuidance(action, sanitized);
    text = JSON.stringify({ action, result: sanitized });
    if (Buffer.byteLength(text, 'utf8') > MAX_COMPACT_BROWSER_TEXT_BYTES) {
      const shortened = shortenOversizedInspectPage(action, sanitized);
      if (shortened !== sanitized) {
        sanitized = appendBrowserReadingGuidance(action, shortened);
        text = JSON.stringify({ action, result: sanitized });
      }
    }
  }
  if (exposure === 'compact' && Buffer.byteLength(text, 'utf8') > MAX_COMPACT_BROWSER_TEXT_BYTES) {
    const safety = readAuthenticationTakeoverSafety(sanitized);
    sanitized = {
      success: false,
      code: 'BROWSER_RESULT_TOO_LARGE',
      message: 'Browser result exceeded the compact 64 KiB budget. Narrow the request and retry.',
      ...(safety ? { safety } : {}),
    };
    text = JSON.stringify({ action, result: sanitized }, null, 2);
    resultTooLarge = true;
  }
  const content: ToolResultContent[] = [{ type: 'text', text }];
  const isError = resultTooLarge || (isRecord(sanitized) && sanitized.success === false);
  // Error tool results must stay text-only. Several upstream model providers
  // reject an error tool result that carries image blocks (eval 1019788: the
  // provider answers 400 ValidationException for is_error=true with
  // [text, image], the gateway retries the poisoned request and the agent dies
  // mid-task), so captured evidence is summarized in text instead of attached.
  if (!isError) {
    if (screenshot) content.push(screenshot);
    if (postActionScreenshot) content.push(postActionScreenshot);
    content.push(...scriptScreenshots);
  }

  return {
    tool_name: toolName,
    text,
    content,
    details: {
      action,
      result: sanitized,
    },
    // A run_code program reads refs, effects and URLs from data instead of
    // re-parsing the text; it carries exactly the bounded result the text
    // shows. Agent Core drops `programmatic` from model-visible results, so a
    // direct call is unchanged.
    programmatic: { data: { action, result: sanitized } },
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Compress each script screenshot through the post-action visual budget.
 * Script images are evidence for the model, not user deliverables, so they are
 * not registered as generated assets.
 */
async function preprocessScriptScreenshots(
  result: unknown,
  ctx: LocalRuntimeToolContext,
  signal: AbortSignal,
  preprocessScreenshot: LocalBrowserScreenshotPreprocessor,
): Promise<unknown> {
  if (!isRecord(result) || !Array.isArray(result.screenshots)) return result;
  const screenshots: unknown[] = [];
  for (const shot of result.screenshots) {
    if (!isRecord(shot)) continue;
    try {
      const processed = await preprocessScreenshot(shot, ctx, signal, {
        purpose: 'post-action',
        action: 'run_script',
      });
      screenshots.push(isRecord(processed) ? { ...shot, ...processed } : shot);
    } catch {
      screenshots.push({ ...shot, data: undefined, dropped: 'preprocess_failed' });
    }
  }
  return { ...result, screenshots };
}

function scriptScreenshotContents(result: unknown): ToolResultContent[] {
  if (!isRecord(result) || !Array.isArray(result.screenshots)) return [];
  return result.screenshots.flatMap((shot) => {
    const content = screenshotContent(shot);
    return content ? [content] : [];
  });
}

const SCRIPT_RESULT_KEYS = [
  'success',
  'code',
  'durationMs',
  'filename',
  'value',
  'valueTruncated',
  'logs',
  'logsTruncated',
  'error',
  'pageEvaluate',
  'input',
  'pageErrors',
  'screenshotsSkipped',
  'recovery',
] as const;

function summarizeScriptResult(result: unknown, imagesOmitted = false): unknown {
  if (!isRecord(result)) return sanitizeBrowserResult(result);
  const summary: Record<string, unknown> = {};
  for (const key of SCRIPT_RESULT_KEYS) {
    if (result[key] !== undefined) summary[key] = sanitizeBrowserResult(result[key]);
  }
  if (Array.isArray(result.screenshots)) {
    summary.screenshots = result.screenshots.filter(isRecord).map((shot, index) => ({
      image: index + 1,
      label: shot.label,
      reason: shot.reason,
      ...(typeof shot.width === 'number' ? { width: shot.width } : {}),
      ...(typeof shot.height === 'number' ? { height: shot.height } : {}),
      // Error tool results are text-only, so screenshots captured by a failed
      // script are dropped at assembly and must not be reported as attached.
      attached: !imagesOmitted && typeof shot.data === 'string' && shot.data.length > 0,
    }));
  }
  return summary;
}

function readResultCode(result: ToolResult): string | undefined {
  const details = isRecord(result.details) ? result.details : undefined;
  const inner = details && isRecord(details.result) ? details.result : undefined;
  return typeof inner?.code === 'string' ? inner.code : undefined;
}

/**
 * Nests the read under `observation` of the action result. The action keeps its
 * own effect fields; the observation is evidence the model judges. An
 * observation that itself requires user takeover keeps that marker, so the
 * Browser guard still demands ask_user next.
 *
 * A click that navigated (UNEXPECTED_NAVIGATION) fails only because it asks
 * the caller to read the new page before continuing. Once the observation has
 * read that page the request is met, so the result is no longer an error:
 * `success` becomes true, `navigation.detected` and `code` stay so the model
 * still sees that the URL changed. Without this a program checking r.isError
 * returns before it can use the observation, costing the round trip back.
 */
function withObservation(
  actionResult: ToolResult,
  observed: ToolResult,
  waitTimedOut: boolean,
): ToolResult {
  const actionDetails = isRecord(actionResult.details) ? actionResult.details : {};
  const observedDetails = isRecord(observed.details) ? observed.details : {};
  const observedResult = isRecord(observedDetails.result) ? observedDetails.result : {};
  const observation: Record<string, unknown> = {
    ...observedResult,
    ...(waitTimedOut ? { waitTimedOut: true } : {}),
    ...(observed.isError ? { observationFailed: true } : {}),
  };
  const safety = isRecord(observedResult.safety) ? observedResult.safety : undefined;
  const actionFields = isRecord(actionDetails.result) ? actionDetails.result : {};
  const navigationRead = actionFields.code === 'UNEXPECTED_NAVIGATION' && !observed.isError;
  const result = {
    ...actionFields,
    ...(navigationRead
      ? {
          success: true,
          error: undefined,
          recovery: 'The click navigated; observation is the new page. Use its refs.',
        }
      : {}),
    observation,
    ...(safety ? { safety } : {}),
  };
  const action = actionDetails.action;
  const text = JSON.stringify({ action, result });
  return {
    tool_name: actionResult.tool_name,
    text,
    content: [
      { type: 'text', text },
      ...actionResult.content.filter((block) => block.type !== 'text'),
      ...observed.content.filter((block) => block.type !== 'text'),
    ],
    details: { ...actionDetails, result },
    programmatic: { data: { action, result } },
    ...(actionResult.isError && !navigationRead ? { isError: true } : {}),
  };
}

function readRequiredNextToolMarker(result: ToolResult): string | undefined {
  const details = isRecord(result.details) ? result.details : undefined;
  const inner = details && isRecord(details.result) ? details.result : undefined;
  const safety = inner && isRecord(inner.safety) ? inner.safety : undefined;
  return typeof safety?.requiredNextTool === 'string' ? safety.requiredNextTool : undefined;
}

interface PostActionVisualRequest extends Record<string, unknown> {
  scope: 'viewport' | 'clip';
  clip?: { x: number; y: number; width: number; height: number };
  // Set only when a target-framed capture was wanted but could not be built, so
  // `scope: 'viewport'` here means "your target could not be framed" rather than
  // "this action is inherently full-viewport". Internal to the summary the model
  // reads; it is never part of the screenshot payload.
  framing?: 'target-unframeable';
  // Human-readable rejection carrying the rejected numbers and the rule; feeds
  // the instruction the model reads. Same summary-only scope as `framing`.
  framingReason?: string;
}

interface PostActionVisualCapture {
  request: PostActionVisualRequest;
  result: unknown;
}

const POST_ACTION_VISUAL_PADDING_PX = 48;
const POST_ACTION_VISUAL_MAX_CLIP_EDGE_PX = 4_096;
// Smallest clip we are willing to ask the provider for. Model gateways reject
// degenerate images outright (the production MiniMax-M3 gateway answers
// `invalid params, 410 (2013)` for a short edge of 2px), and a rejected image
// persisted into session history poisons every later request in that session.
// The rejection threshold is a server-side property that can move — measured at
// <=2px on the production gateway and <=4px on the open-platform test gateway —
// so this value deliberately sits far away from either red line rather than one
// pixel above it. 32px is affordable here because we fully control this clip and
// a sub-32px sliver carries no information for the model anyway; the safe
// fallback is a full-viewport capture, not a lost observation. The outbound
// last-resort net in agent-core uses a much tighter value for the opposite
// reason — see MIN_PROVIDER_IMAGE_EDGE_PX.
const POST_ACTION_VISUAL_MIN_CLIP_EDGE_PX = 32;
const MAX_POST_ACTION_VISUALS_PER_TURN = 4;
const MAX_TRACKED_POST_ACTION_VISUAL_TURNS = 128;

async function capturePostActionVisual(
  action: LocalBrowserToolAction,
  input: Record<string, unknown>,
  result: unknown,
  adapter: LocalBrowserAdapter,
  ctx: LocalRuntimeToolContext,
  signal: AbortSignal | undefined,
  preprocessScreenshot: LocalBrowserScreenshotPreprocessor | undefined,
  postActionVisualCountByTurn: Map<string, number> | undefined,
): Promise<PostActionVisualCapture | undefined> {
  if (!preprocessScreenshot || process.env.MAVIS_BROWSER_POST_ACTION_VISUAL_V1 === '0') {
    return undefined;
  }
  const capabilities = adapter.getCapabilities?.();
  if (capabilities && !capabilities.actions.includes('screenshot')) return undefined;
  const budgetKey = `${ctx.sessionId}:${ctx.turnId}`;
  if ((postActionVisualCountByTurn?.get(budgetKey) ?? 0) >= MAX_POST_ACTION_VISUALS_PER_TURN) {
    return undefined;
  }
  const request = resolvePostActionVisualRequest(action, input, result);
  if (!request) return undefined;

  try {
    return await executeWithDeadline(
      async (visualSignal) => {
        const screenshotCall = Promise.resolve(
          adapter.execute(ctx, 'screenshot', screenshotRequestPayload(request), visualSignal),
        );
        trackPendingPostActionVisual(adapter, ctx.sessionId, screenshotCall);
        const rawScreenshot = await screenshotCall;
        const processed = await preprocessScreenshot(rawScreenshot, ctx, visualSignal, {
          purpose: 'post-action',
          action,
        });
        if (!screenshotContent(processed)) {
          return isDeduplicatedVisual(processed) ? { request, result: processed } : undefined;
        }
        if (postActionVisualCountByTurn) {
          recordPostActionVisual(postActionVisualCountByTurn, budgetKey);
        }
        return { request, result: processed };
      },
      POST_ACTION_VISUAL_TIMEOUT_MS,
      'Browser post-action visual',
      signal,
    );
  } catch {
    // Visual evidence is supplemental. A capture/compression failure must not
    // replace the Browser action's authoritative success or failure result.
    return undefined;
  }
}

function trackPendingPostActionVisual(
  adapter: LocalBrowserAdapter,
  sessionId: string,
  call: Promise<unknown>,
): void {
  let bySession = pendingPostActionVisuals.get(adapter);
  if (!bySession) {
    bySession = new Map();
    pendingPostActionVisuals.set(adapter, bySession);
  }
  const sessions = bySession;
  const settled: Promise<void> = call.then(
    () => undefined,
    () => undefined,
  );
  sessions.set(sessionId, settled);
  void settled.then(() => {
    if (sessions.get(sessionId) === settled) sessions.delete(sessionId);
  });
}

async function acquireBrowserSessionTurn(
  adapter: LocalBrowserAdapter,
  sessionId: string,
  signal: AbortSignal | undefined,
): Promise<() => void> {
  let bySession = browserSessionQueues.get(adapter);
  if (!bySession) {
    bySession = new Map();
    browserSessionQueues.set(adapter, bySession);
  }
  const queues = bySession;
  const previous = queues.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Later callers wait for this turn even when it is abandoned before running.
  const tail = previous.then(() => current);
  queues.set(sessionId, tail);
  void tail.then(() => {
    if (queues.get(sessionId) === tail) queues.delete(sessionId);
  });
  if (signal?.aborted) {
    release();
    throw new Error('ABORTED: Browser action was cancelled');
  }
  let onAbort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      void previous.then(resolve);
      if (signal) {
        onAbort = () => reject(new Error('ABORTED: Browser action was cancelled'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  } catch (error) {
    release();
    throw error;
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
  return release;
}

async function waitForPendingPostActionVisual(
  adapter: LocalBrowserAdapter,
  sessionId: string,
  signal: AbortSignal,
): Promise<void> {
  const pending = pendingPostActionVisuals.get(adapter)?.get(sessionId);
  if (!pending) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      pending,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, MAX_PENDING_VISUAL_SETTLE_MS);
        timer.unref?.();
      }),
      new Promise<void>((resolve) => {
        onAbort = resolve;
        if (signal.aborted) resolve();
        else signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Narrow the internal request down to the fields the screenshot action accepts.
 *
 * Built as an allow-list rather than by omitting `framing`, so any future
 * summary-only field also stays out of the provider payload by default.
 */
function screenshotRequestPayload(request: PostActionVisualRequest): Record<string, unknown> {
  return request.clip === undefined
    ? { scope: request.scope }
    : { scope: request.scope, clip: request.clip };
}

function recordPostActionVisual(countByTurn: Map<string, number>, budgetKey: string): void {
  countByTurn.set(budgetKey, (countByTurn.get(budgetKey) ?? 0) + 1);
  while (countByTurn.size > MAX_TRACKED_POST_ACTION_VISUAL_TURNS) {
    const oldestKey = countByTurn.keys().next().value as string | undefined;
    if (!oldestKey) break;
    countByTurn.delete(oldestKey);
  }
}

function resolvePostActionVisualRequest(
  action: LocalBrowserToolAction,
  input: Record<string, unknown>,
  result: unknown,
): PostActionVisualRequest | undefined {
  if (!isRecord(result)) return undefined;
  // Failed actions never request a visual: error tool results are text-only
  // (provider contract, see `browserToolResult`), so a capture here would be
  // dropped at assembly after burning latency and the per-turn image budget.
  // This includes failures that detected an unexpected navigation; the model
  // is routed to inspect/screenshot the landed page instead.
  if (result.success === false) return undefined;
  const navigation = isRecord(result.navigation) ? result.navigation : {};
  if (navigation.detected === true) return { scope: 'viewport' };

  switch (action) {
    case 'navigate':
    case 'open_tab':
    case 'back':
    case 'forward':
    case 'reload':
    case 'click_and_wait_for_navigation':
    case 'drag':
    case 'upload_files':
      return { scope: 'viewport' };
    case 'click':
    case 'double_click':
    case 'triple_click':
    case 'check':
    case 'uncheck':
    case 'select_option':
      return requestForTarget(result.target);
    case 'scroll':
      return isRecord(result.effect) && result.effect.moved === true
        ? { scope: 'viewport' }
        : undefined;
    case 'hover': {
      const effect = isRecord(result.effect) ? result.effect : {};
      const semantic = isRecord(effect.semantic) ? effect.semantic : {};
      return effect.tooltipObserved === true && semantic.confidence !== 'high'
        ? requestForTarget(result.target)
        : undefined;
    }
    case 'fill':
    case 'type': {
      const target = isRecord(result.target) ? result.target : {};
      return target.virtual === true || target.contentEditable === true
        ? requestForTarget(target)
        : undefined;
    }
    case 'press_key': {
      const key = typeof input.key === 'string' ? input.key.toLowerCase() : '';
      return key === 'enter' ? { scope: 'viewport' } : undefined;
    }
    default:
      return undefined;
  }
}

function requestForTarget(value: unknown): PostActionVisualRequest {
  const target = isRecord(value) ? value : {};
  const framing = resolveVisualRect(target.rect);
  // The fallback is silent framing loss: the model asked for the area around its
  // target and gets the whole viewport, which may not contain that target at
  // all. Carry the rejected numbers and the rule so the instruction can state
  // them instead of a bare marker.
  return 'rect' in framing
    ? { scope: 'clip', clip: framing.rect }
    : { scope: 'viewport', framing: 'target-unframeable', framingReason: framing.rejected };
}

type VisualRectDecision =
  | { rect: { x: number; y: number; width: number; height: number } }
  | { rejected: string };

function resolveVisualRect(value: unknown): VisualRectDecision {
  if (!isRecord(value)) return { rejected: 'Target rect was missing, so no clip could be built.' };
  const x = finiteNumber(value.x);
  const y = finiteNumber(value.y);
  const width = finiteNumber(value.width);
  const height = finiteNumber(value.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    return { rejected: 'Target rect had non-numeric fields, so no clip could be built.' };
  }
  if (width <= 0 || height <= 0) {
    return {
      rejected: `Target rect was ${Math.round(width)}x${Math.round(height)} px (empty), so no clip could be built.`,
    };
  }
  const left = Math.max(0, Math.floor(x - POST_ACTION_VISUAL_PADDING_PX));
  const top = Math.max(0, Math.floor(y - POST_ACTION_VISUAL_PADDING_PX));
  const right = Math.ceil(x + width + POST_ACTION_VISUAL_PADDING_PX);
  const bottom = Math.ceil(y + height + POST_ACTION_VISUAL_PADDING_PX);
  // Clamping the top-left to the viewport origin without clamping the
  // bottom-right can collapse an off-screen element into a degenerate strip.
  // Check the resulting edges before constructing the rect so this function is
  // structurally incapable of returning one; a rejection routes the caller to
  // its existing full-viewport fallback.
  const clippedWidth = Math.min(POST_ACTION_VISUAL_MAX_CLIP_EDGE_PX, right - left);
  const clippedHeight = Math.min(POST_ACTION_VISUAL_MAX_CLIP_EDGE_PX, bottom - top);
  if (
    clippedWidth < POST_ACTION_VISUAL_MIN_CLIP_EDGE_PX ||
    clippedHeight < POST_ACTION_VISUAL_MIN_CLIP_EDGE_PX
  ) {
    return {
      rejected:
        `Target clip ${Math.max(0, clippedWidth)}x${Math.max(0, clippedHeight)} px was rejected: ` +
        `minimum edge is ${POST_ACTION_VISUAL_MIN_CLIP_EDGE_PX} px ` +
        `(target rect x=${Math.round(x)}, y=${Math.round(y)}).`,
    };
  }
  return { rect: { x: left, y: top, width: clippedWidth, height: clippedHeight } };
}

function unframeableInstruction(action: LocalBrowserToolAction, reason: string): string {
  return `${reason} This full-viewport image may not contain the target; trust the action fields, not the image. Next: ${unframeableNextStep(action)}, or inspect again then screenshot.`;
}

/**
 * The verification step that actually observes what this action changes.
 * Text queries cannot see a checkbox's checked state or a select's value, and
 * editable targets have a dedicated query; naming the wrong probe sends the
 * model on a detour.
 */
function unframeableNextStep(action: LocalBrowserToolAction): string {
  switch (action) {
    case 'check':
    case 'uncheck':
    case 'select_option':
      return 'inspect to read the element state';
    case 'fill':
    case 'type':
      return 'query kind "editable"';
    default:
      return 'verify_text or query kind "text"';
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function appendPostActionVisualSummary(
  action: LocalBrowserToolAction,
  result: unknown,
  capture: PostActionVisualCapture,
): unknown {
  if (!isRecord(result) || !isRecord(capture.result)) return result;
  if (isDeduplicatedVisual(capture.result)) {
    return {
      ...result,
      visualObservation: {
        available: false,
        source: 'post-action',
        action,
        scope: capture.request.scope,
        ...(capture.request.framing === undefined ? {} : { framing: capture.request.framing }),
        deduplicated: true,
        budget: { maxImagesPerTurn: MAX_POST_ACTION_VISUALS_PER_TURN },
        verificationOnly: true,
        instruction: 'The post-action image matched the previous visual and was not re-added.',
      },
    };
  }
  const width = finiteNumber(capture.result.width);
  const height = finiteNumber(capture.result.height);
  const bytes = finiteNumber(capture.result.bytes);
  const format = screenshotFormat(capture.result.format);
  const dimensionNote =
    typeof capture.result.dimensionNote === 'string' ? capture.result.dimensionNote : undefined;
  return {
    ...result,
    visualObservation: {
      available: true,
      source: 'post-action',
      action,
      scope: capture.request.scope,
      ...(capture.request.framing === undefined ? {} : { framing: capture.request.framing }),
      ...(capture.request.framingReason === undefined
        ? {}
        : { framingReason: capture.request.framingReason }),
      format,
      ...(width === undefined ? {} : { width }),
      ...(height === undefined ? {} : { height }),
      ...(bytes === undefined ? {} : { bytes }),
      ...(dimensionNote === undefined ? {} : { dimensionNote }),
      budget: {
        ...(isRecord(capture.result.visualBudget) ? capture.result.visualBudget : {}),
        maxImagesPerTurn: MAX_POST_ACTION_VISUALS_PER_TURN,
      },
      verificationOnly: true,
      instruction:
        capture.request.framing === 'target-unframeable'
          ? unframeableInstruction(
              action,
              capture.request.framingReason ?? 'The target could not be framed.',
            )
          : 'Use this image as supplemental visual evidence. It does not change the Browser action success result.',
    },
  };
}

function isDeduplicatedVisual(value: unknown): boolean {
  return isRecord(value) && value.deduplicated === true;
}

/**
 * Error tool results are text-only (see the `content` assembly in
 * `browserToolResult`), so any image captured alongside a failure is dropped.
 * This note replaces the image to keep the text honest about the omission and
 * route the model to a fresh observation instead of a phantom attachment.
 */
function appendErrorVisualOmissionNote(action: LocalBrowserToolAction, result: unknown): unknown {
  if (!isRecord(result)) return result;
  return {
    ...result,
    visualObservation: {
      available: false,
      source: 'post-action',
      action,
      omittedOnError: true,
      instruction:
        'A captured image was omitted because error tool results are text-only. ' +
        'Handle the reported failure first, then call inspect or screenshot to observe the current page state.',
    },
  };
}

const MAX_COMPACT_BROWSER_TEXT_BYTES = 64 * 1024;

function compactOversizedInspectResult(action: LocalBrowserToolAction, value: unknown): unknown {
  if (action !== 'inspect' || !isRecord(value) || typeof value.snapshotId !== 'string') {
    return value;
  }
  const envelope = { ...value };
  const rawElements = envelope.elements;
  const hadSemanticTree = Object.prototype.hasOwnProperty.call(envelope, 'semanticTree');
  const semanticTree = envelope.semanticTree;
  delete envelope.semanticTree;
  delete envelope.reading;
  delete envelope.elements;
  const compactElements = Array.isArray(rawElements)
    ? rawElements.map((item) => {
        if (!isRecord(item)) return item;
        const compact = { ...item };
        delete compact.attributes;
        delete compact.selector;
        return compact;
      })
    : rawElements;
  const compactWithSemanticTree = {
    ...envelope,
    elements: compactElements,
    ...(hadSemanticTree ? { semanticTree } : {}),
  };
  if (
    Buffer.byteLength(JSON.stringify({ action, result: compactWithSemanticTree }), 'utf8') <=
    MAX_COMPACT_BROWSER_TEXT_BYTES
  ) {
    return compactWithSemanticTree;
  }
  const withoutSemanticTree = {
    ...envelope,
    elements: rawElements,
    ...(hadSemanticTree ? { semanticTreeOmitted: { reason: 'result_budget' } } : {}),
  };
  if (
    Buffer.byteLength(JSON.stringify({ action, result: withoutSemanticTree }), 'utf8') <=
    MAX_COMPACT_BROWSER_TEXT_BYTES
  ) {
    return withoutSemanticTree;
  }
  return {
    ...envelope,
    elements: compactElements,
    ...(hadSemanticTree ? { semanticTreeOmitted: { reason: 'result_budget' } } : {}),
  };
}

function inspectPageBytes(action: LocalBrowserToolAction, page: Record<string, unknown>): number {
  return Buffer.byteLength(
    JSON.stringify({ action, result: appendBrowserReadingGuidance(action, page) }),
    'utf8',
  );
}

/**
 * Keep the longest element prefix that fits the compact budget. Browser Core
 * pages any retained snapshot from an explicit offset, so the returned
 * continuation resumes exactly after the last element the model received.
 */
function shortenOversizedInspectPage(action: LocalBrowserToolAction, value: unknown): unknown {
  if (
    action !== 'inspect' ||
    !isRecord(value) ||
    typeof value.snapshotId !== 'string' ||
    !Array.isArray(value.elements) ||
    value.elements.length <= 1
  ) {
    return value;
  }
  const elements = value.elements;
  const offset =
    typeof value.offset === 'number' && Number.isInteger(value.offset) && value.offset >= 0
      ? value.offset
      : 0;
  const { reading: _reading, ...base } = value;
  void _reading;
  const pageWith = (count: number): Record<string, unknown> => ({
    ...base,
    elements: elements.slice(0, count),
    returnedElements: count,
    truncated: true,
    nextOffset: offset + count,
    continuation: {
      action: 'inspect',
      input: { snapshotId: value.snapshotId, offset: offset + count },
    },
    resultBudget: { reason: 'compact_result_budget', omittedFromThisPage: elements.length - count },
  });
  let lower = 1;
  let upper = elements.length - 1;
  let fitting: Record<string, unknown> | undefined;
  while (lower <= upper) {
    const count = Math.floor((lower + upper) / 2);
    const candidate = pageWith(count);
    if (inspectPageBytes(action, candidate) <= MAX_COMPACT_BROWSER_TEXT_BYTES) {
      fitting = candidate;
      lower = count + 1;
    } else {
      upper = count - 1;
    }
  }
  return fitting ?? value;
}

const COMPACT_STATUS_STRING_LIMITS = {
  url: 4_096,
  title: 1_024,
  error: 4_096,
  message: 4_096,
  code: 256,
} as const;
const COMPACT_PRIVATE_RESULT_KEYS = new Set(['browserState', 'sessionId', 'tabId']);

function appendBrowserReadingGuidance(action: LocalBrowserToolAction, result: unknown): unknown {
  if (action !== 'inspect' || !isRecord(result) || !Array.isArray(result.elements)) return result;

  return typeof result.truncated === 'boolean'
    ? {
        ...result,
        reading: result.truncated
          ? {
              snapshotComplete: false,
              ifRequestedEvidencePresent: 'stop',
              requiredNextAction: 'inspect',
              requiredNextInput: isRecord(result.continuation)
                ? result.continuation.input
                : undefined,
              instruction:
                'If the requested evidence is already present, stop reading. Otherwise continue with the returned inspect continuation input; do not invent snapshot IDs or offsets.',
            }
          : {
              snapshotComplete: true,
              ifRequestedEvidencePresent: 'stop',
              instruction:
                'If the requested evidence is present in this complete snapshot, do not call query, inspect, or screenshot again; answer now.',
            },
      }
    : result;
}

const AUTHENTICATION_TAKEOVER_SAFETY = {
  classification: 'authentication_user_takeover',
  mutationAllowed: false,
  requiredNextTool: 'ask_user',
  instruction:
    'Call the actual ask_user tool call now so the user can take over this same Browser tab. Do not write <ask_user>, ask_user(...), or a prose placeholder; text does not pause the turn.',
} as const;

const CREDENTIAL_SIGN_IN_SAFETY = {
  classification: 'authentication_credential_prompt',
  mutationAllowed: true,
  instruction:
    'No takeover surface: sign in yourself with credentials the user or task supplied, or an account this sign-in page publishes for that user or task. If values are missing, request them with ask_user when available; otherwise report what is missing and continue the rest of the task. Never guess credentials or echo secrets.',
} as const;

function appendBrowserSafetyGuidance(
  action: LocalBrowserToolAction,
  result: unknown,
  interactiveTakeover: boolean,
): unknown {
  if (!isRecord(result)) return result;
  const elements =
    action === 'inspect'
      ? [result.elements]
      : action === 'query'
        ? [result.elements, result.targets]
        : action === 'inspect_editable_targets'
          ? [result.targets]
          : [];
  const containsAuthenticationSecretField =
    elements.some(
      (collection) => Array.isArray(collection) && collection.some(isAuthenticationSecretField),
    ) ||
    ((action === 'query' || action === 'get_dom') &&
      typeof result.html === 'string' &&
      containsAuthenticationSecretMarkup(result.html));
  if (!containsAuthenticationSecretField) return result;

  const redacted = redactAuthenticationSecrets(action, result);
  if (!interactiveTakeover) {
    // No takeover surface: the agent signs in itself with credentials already
    // available, asking the user only when values are missing. Secret values
    // read from the page stay redacted.
    return {
      ...redacted,
      safety: CREDENTIAL_SIGN_IN_SAFETY,
    };
  }
  return {
    ...redacted,
    safety: AUTHENTICATION_TAKEOVER_SAFETY,
  };
}

function redactAuthenticationSecrets(
  action: LocalBrowserToolAction,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const redacted = { ...result };
  const collectionKeys =
    action === 'inspect'
      ? ['elements']
      : action === 'query'
        ? ['elements', 'targets']
        : action === 'inspect_editable_targets'
          ? ['targets']
          : [];
  for (const key of collectionKeys) {
    const collection = result[key];
    if (!Array.isArray(collection)) continue;
    redacted[key] = collection.map((element) =>
      isAuthenticationSecretField(element) ? redactAuthenticationSecretField(element) : element,
    );
  }
  if ((action === 'query' || action === 'get_dom') && typeof result.html === 'string') {
    redacted.html = redactAuthenticationSecretMarkup(result.html);
  }
  return redacted;
}

function redactAuthenticationSecretField(element: unknown): unknown {
  if (!isRecord(element)) return element;
  const redacted = { ...element };
  delete redacted.value;
  delete redacted.text;
  delete redacted.innerText;
  delete redacted.textContent;
  if (isRecord(redacted.attributes)) {
    const attributes = { ...redacted.attributes };
    delete attributes.value;
    redacted.attributes = attributes;
  }
  redacted.valueRedacted = true;
  return redacted;
}

function isAuthenticationSecretField(element: unknown): boolean {
  if (!isRecord(element)) return false;
  const attributes = isRecord(element.attributes) ? element.attributes : {};
  const types = [element.type, attributes.type];
  if (
    types.some((value) => typeof value === 'string' && value.trim().toLowerCase() === 'password')
  ) {
    return true;
  }

  const autocomplete = [element.autocomplete, attributes.autocomplete]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  return /(?:^|\s)(?:current-password|new-password|one-time-code)(?:\s|$)/u.test(autocomplete);
}

function containsAuthenticationSecretMarkup(html: string): boolean {
  for (const match of html.matchAll(/<(?:input|textarea)\b[^>]*>/giu)) {
    const markup = match[0];
    if (
      isAuthenticationSecretField({
        attributes: {
          type: readHtmlAttribute(markup, 'type'),
          autocomplete: readHtmlAttribute(markup, 'autocomplete'),
        },
      })
    ) {
      return true;
    }
  }
  return false;
}

function redactAuthenticationSecretMarkup(html: string): string {
  const redactValueAttribute = (markup: string): string =>
    markup.replace(/\svalue\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/giu, ' value="[REDACTED]"');
  const inputsRedacted = html.replace(/<input\b[^>]*>/giu, (markup) =>
    isAuthenticationSecretField({
      attributes: {
        type: readHtmlAttribute(markup, 'type'),
        autocomplete: readHtmlAttribute(markup, 'autocomplete'),
      },
    })
      ? redactValueAttribute(markup)
      : markup,
  );
  return inputsRedacted.replace(
    /(<textarea\b[^>]*>)[\s\S]*?(<\/textarea>)/giu,
    (markup, opening: string, closing: string) =>
      isAuthenticationSecretField({
        attributes: {
          type: readHtmlAttribute(opening, 'type'),
          autocomplete: readHtmlAttribute(opening, 'autocomplete'),
        },
      })
        ? `${redactValueAttribute(opening)}[REDACTED]${closing}`
        : markup,
  );
}

function readHtmlAttribute(markup: string, name: 'type' | 'autocomplete'): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'iu').exec(
    markup,
  );
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function readAuthenticationTakeoverSafety(
  result: unknown,
): typeof AUTHENTICATION_TAKEOVER_SAFETY | typeof CREDENTIAL_SIGN_IN_SAFETY | undefined {
  if (!isRecord(result) || !isRecord(result.safety)) return undefined;
  if (result.safety.classification === AUTHENTICATION_TAKEOVER_SAFETY.classification) {
    return AUTHENTICATION_TAKEOVER_SAFETY;
  }
  if (result.safety.classification === CREDENTIAL_SIGN_IN_SAFETY.classification) {
    return CREDENTIAL_SIGN_IN_SAFETY;
  }
  return undefined;
}

function summarizeCompactActionResult(action: LocalBrowserToolAction, result: unknown): unknown {
  if (!isRecord(result)) return sanitizeBrowserResult(result);

  const summary: Record<string, unknown> = {};
  if (typeof result.success === 'boolean') summary.success = result.success;
  if (typeof result.openedInNewTab === 'boolean') {
    summary.openedInNewTab = result.openedInNewTab;
  }
  if (action === 'return_to_previous_tab' && typeof result.returnedToPreviousTab === 'boolean') {
    summary.returnedToPreviousTab = result.returnedToPreviousTab;
  }
  const preservedTabs = result.preservedTabs;
  if (typeof preservedTabs === 'number' && Number.isFinite(preservedTabs)) {
    summary.preservedTabs = Math.max(0, Math.floor(preservedTabs));
  }
  if (typeof result.duration === 'number' && Number.isFinite(result.duration)) {
    summary.duration = result.duration;
  }
  if (typeof result.durationMs === 'number' && Number.isFinite(result.durationMs)) {
    summary.durationMs = Math.max(0, Math.floor(result.durationMs));
  }
  for (const [key, limit] of Object.entries(COMPACT_STATUS_STRING_LIMITS)) {
    const value = result[key];
    if (typeof value === 'string') summary[key] = value.slice(0, limit);
  }
  if (action === 'drag') {
    if (result.mode === 'pointer' || result.mode === 'html5') summary.mode = result.mode;
    if (typeof result.dragStarted === 'boolean') summary.dragStarted = result.dragStarted;
    if (typeof result.dropDispatched === 'boolean') {
      summary.dropDispatched = result.dropDispatched;
    }
  }
  if (action === 'upload_files') {
    const effect = isRecord(result.effect) ? result.effect : undefined;
    const filesAttached =
      typeof result.filesAttached === 'number' && Number.isFinite(result.filesAttached)
        ? result.filesAttached
        : typeof effect?.fileCount === 'number' && Number.isFinite(effect.fileCount)
          ? effect.fileCount
          : undefined;
    if (filesAttached !== undefined) {
      summary.filesAttached = Math.max(0, Math.floor(filesAttached));
    }
    if (typeof result.chooserOpened === 'boolean') summary.chooserOpened = result.chooserOpened;
  }
  if (action === 'click' || action === 'double_click' || action === 'triple_click') {
    const download = boundedBrowserDownload(result.download);
    if (download) summary.download = download;
  }
  const target = boundedWriteTarget(result.target);
  if (target) summary.target = target;
  const effect =
    action === 'scroll'
      ? boundedScrollEffect(result.effect)
      : action === 'hover'
        ? boundedHoverEffect(result.effect)
        : boundedWriteEffect(result.effect);
  if (effect) summary.effect = effect;
  const navigation = boundedNavigation(result.navigation);
  if (navigation) summary.navigation = navigation;
  if (typeof result.retryable === 'boolean') summary.retryable = result.retryable;
  if (typeof result.recovery === 'string') summary.recovery = result.recovery.slice(0, 1_024);
  // Diagnostics Browser Core attaches to failures so the model can correct the
  // call instead of re-querying (eval 761096: SELECT_OPTION_NOT_FOUND on the
  // wrong select, selector misses on a wrong ancestor chain).
  const availableOptions = boundedSelectOptions(result.availableOptions);
  if (availableOptions) {
    summary.availableOptions = availableOptions;
    if (result.availableOptionsTruncated === true) summary.availableOptionsTruncated = true;
    if (
      typeof result.availableOptionCount === 'number' &&
      Number.isFinite(result.availableOptionCount)
    ) {
      summary.availableOptionCount = Math.max(0, Math.floor(result.availableOptionCount));
    }
  }
  const selectorTail = boundedSelectorTail(result.selectorTail);
  if (selectorTail) summary.selectorTail = selectorTail;
  return summary;
}

const MAX_COMPACT_SELECT_OPTIONS = 30;

function boundedSelectOptions(value: unknown): Array<Record<string, string>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value
    .slice(0, MAX_COMPACT_SELECT_OPTIONS)
    .filter(isRecord)
    .map((option) => ({
      value: typeof option.value === 'string' ? option.value.slice(0, 80) : '',
      label: typeof option.label === 'string' ? option.label.slice(0, 80) : '',
    }));
  return options.length > 0 ? options : undefined;
}

function boundedSelectorTail(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value) || typeof value.selector !== 'string') return undefined;
  if (typeof value.matchCount !== 'number' || !Number.isFinite(value.matchCount)) return undefined;
  return {
    selector: value.selector.slice(0, 256),
    matchCount: Math.max(0, Math.floor(value.matchCount)),
  };
}

function boundedBrowserDownload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const download: Record<string, unknown> = {};
  if (value.state === 'inProgress' || value.state === 'completed' || value.state === 'canceled') {
    download.state = value.state;
  }
  if (value.observation === 'timeout') download.observation = 'timeout';
  const suggestedFilename =
    typeof value.suggestedFilename === 'string'
      ? value.suggestedFilename
      : typeof value.fileName === 'string'
        ? value.fileName
        : '';
  if (suggestedFilename) download.suggestedFilename = suggestedFilename.slice(0, 255);
  for (const key of ['receivedBytes', 'totalBytes'] as const) {
    if (typeof value[key] === 'number' && Number.isFinite(value[key])) {
      download[key] = Math.max(0, Math.floor(value[key]));
    }
  }
  return Object.keys(download).length > 0 ? download : undefined;
}

function boundedWriteTarget(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const target: Record<string, unknown> = {};
  if (typeof value.resolved === 'boolean') target.resolved = value.resolved;
  if (typeof value.tag === 'string') target.tag = value.tag.slice(0, 80);
  if (typeof value.role === 'string') target.role = value.role.slice(0, 80);
  if (typeof value.inputType === 'string') target.inputType = value.inputType.slice(0, 40);
  if (typeof value.name === 'string') target.name = value.name.slice(0, 80);
  if (typeof value.contentEditable === 'boolean') {
    target.contentEditable = value.contentEditable;
  }
  return Object.keys(target).length > 0 ? target : undefined;
}

function boundedWriteEffect(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const effect: Record<string, unknown> = {};
  if (typeof value.dispatched === 'boolean') effect.dispatched = value.dispatched;
  if (typeof value.verified === 'boolean') effect.verified = value.verified;
  if (typeof value.verificationRequired === 'boolean') {
    effect.verificationRequired = value.verificationRequired;
  }
  if (typeof value.focused === 'boolean') effect.focused = value.focused;
  if (typeof value.textChanged === 'boolean') effect.textChanged = value.textChanged;
  if (typeof value.textLength === 'number' && Number.isFinite(value.textLength)) {
    effect.textLength = Math.max(0, Math.floor(value.textLength));
  }
  return Object.keys(effect).length > 0 ? effect : undefined;
}

function boundedHoverEffect(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const effect: Record<string, unknown> = {};
  if (typeof value.hovered === 'boolean') effect.hovered = value.hovered;
  if (typeof value.tooltipObserved === 'boolean') {
    effect.tooltipObserved = value.tooltipObserved;
  }
  if (isRecord(value.semantic)) {
    const semantic: Record<string, unknown> = {};
    if (typeof value.semantic.name === 'string') {
      semantic.name = value.semantic.name.slice(0, 256);
    }
    if (
      typeof value.semantic.source === 'string' &&
      COMPACT_HOVER_SEMANTIC_SOURCES.has(value.semantic.source)
    ) {
      semantic.source = value.semantic.source;
    }
    if (
      typeof value.semantic.confidence === 'string' &&
      COMPACT_HOVER_CONFIDENCE_LEVELS.has(value.semantic.confidence)
    ) {
      semantic.confidence = value.semantic.confidence;
    }
    if (typeof value.semantic.supportingText === 'string') {
      semantic.supportingText = value.semantic.supportingText.slice(0, 256);
    }
    if (Object.keys(semantic).length > 0) effect.semantic = semantic;
  }
  return Object.keys(effect).length > 0 ? effect : undefined;
}

function boundedScrollEffect(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const effect: Record<string, unknown> = {};
  if (typeof value.observed === 'boolean') effect.observed = value.observed;
  if (typeof value.moved === 'boolean') effect.moved = value.moved;
  const numericFields = ['actualDeltaX', 'actualDeltaY'] as const;
  for (const field of numericFields) {
    const numericValue = value[field];
    if (typeof numericValue === 'number' && Number.isFinite(numericValue)) {
      effect[field] = Math.round(numericValue);
    }
  }
  if (typeof value.atStart === 'boolean') effect.atStart = value.atStart;
  if (typeof value.atEnd === 'boolean') effect.atEnd = value.atEnd;
  return Object.keys(effect).length > 0 ? effect : undefined;
}

function boundedNavigation(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const navigation: Record<string, unknown> = {};
  if (typeof value.detected === 'boolean') navigation.detected = value.detected;
  if (typeof value.urlChanged === 'boolean') navigation.urlChanged = value.urlChanged;
  if (typeof value.loaded === 'boolean') navigation.loaded = value.loaded;
  if (typeof value.generation === 'number' && Number.isFinite(value.generation)) {
    navigation.generation = Math.max(0, Math.floor(value.generation));
  }
  if (typeof value.beforeHost === 'string') navigation.beforeHost = value.beforeHost.slice(0, 255);
  if (typeof value.afterHost === 'string') navigation.afterHost = value.afterHost.slice(0, 255);
  return Object.keys(navigation).length > 0 ? navigation : undefined;
}

const POINTER_TARGET_ACTIONS = new Set<LocalBrowserToolAction>([
  'click',
  'click_and_wait_for_navigation',
  'double_click',
  'triple_click',
  'hover',
  'fill',
  'type',
  'check',
  'uncheck',
  'select_option',
]);
const ELEMENT_TARGET_ACTIONS = new Set<LocalBrowserToolAction>(['paste']);

/**
 * Repair envelope-level slips whose intent is certain before schema
 * validation. Eval 769392 lost 8 calls to the outer validator:
 * - the action name carried a leaked markup tail (`"press_key\">"`,
 *   `"select_option\">"`); only a tail of quotes/backslashes/`>`/whitespace is
 *   stripped, and only when the remainder is an available action;
 * - action fields were sent beside `input` instead of inside it
 *   (`{ action: "inspect", limit: "100" }`, `{ action, ref }`); they are moved
 *   into `input` only when no key collides with one already there.
 * Everything else is left untouched so the validator reports it as before.
 */
export function prepareCompactBrowserArguments(args: unknown, actions: readonly string[]): unknown {
  if (!isRecord(args)) return args;
  let prepared: Record<string, unknown> = args;
  if (typeof args.action === 'string' && !actions.includes(args.action)) {
    let repaired = args.action.trim();
    // Linear trim (no backtracking regex) of stray quote/backslash/`>`/space.
    while (repaired.length > 0 && /["'\\>\s]/u.test(repaired.at(-1) ?? '')) {
      repaired = repaired.slice(0, -1);
    }
    if (actions.includes(repaired)) prepared = { ...prepared, action: repaired };
  }
  const stray = Object.keys(prepared).filter((key) => key !== 'action' && key !== 'input');
  const input = prepared.input;
  if (stray.length > 0 && (input === undefined || isRecord(input))) {
    const target = input ?? {};
    if (stray.every((key) => !(key in target))) {
      const moved: Record<string, unknown> = { ...target };
      for (const key of stray) moved[key] = prepared[key];
      prepared = { action: prepared.action, input: moved };
    }
  }
  if (isRecord(prepared.input)) {
    const coerced = coerceBrowserInputEnvelope(prepared.action, prepared.input);
    if (coerced !== prepared.input) prepared = { ...prepared, input: coerced };
  }
  return prepared;
}

const NUMERIC_BROWSER_INPUT_FIELDS = [
  'maxChars',
  'limit',
  'offset',
  'afterSequence',
  'distance',
  'timeout',
  'delay',
] as const;
const NUMERIC_STRING = /^\s*\d+(?:\.\d+)?\s*$/u;

/**
 * Eval 774252 lost 5 more calls to the outer validator on value encodings
 * whose meaning is certain:
 * - numbers sent as decimal strings (`maxChars: "5000"`, `distance: "100"`);
 *   only plain non-negative decimals are converted, range checks still apply;
 * - select_option `values` serialized through an XML-style array wrapper
 *   (`values: { item: "Task" }`) or as a bare string; only a lone `item` key
 *   holding a string or string array is unwrapped;
 * - select_option `value` (singular) when `values` is absent, since
 *   select_option has no other field it could mean.
 */
function coerceBrowserInputEnvelope(
  action: unknown,
  input: Record<string, unknown>,
): Record<string, unknown> {
  let next = input;
  const set = (key: string, value: unknown) => {
    if (next === input) next = { ...input };
    next[key] = value;
  };
  for (const key of NUMERIC_BROWSER_INPUT_FIELDS) {
    const value = input[key];
    if (typeof value === 'string' && NUMERIC_STRING.test(value)) set(key, Number(value));
  }
  if (action === 'select_option') {
    if (next.values === undefined && 'value' in next) {
      const { value, ...rest } = next;
      next = { ...rest, values: value };
    }
    const values = next.values;
    if (typeof values === 'string' && values.length > 0) set('values', [values]);
    else if (isRecord(values) && Object.keys(values).length === 1 && 'item' in values) {
      const item = values.item;
      if (typeof item === 'string') set('values', [item]);
      else if (Array.isArray(item) && item.every((entry) => typeof entry === 'string')) {
        set('values', item);
      }
    }
  }
  return next;
}

function validateCompactBrowserInput(
  action: LocalBrowserToolAction,
  input: Record<string, unknown>,
): string | undefined {
  if (action === 'drag') {
    return (
      validateBrowserTarget(action, 'source', input.source, true) ??
      validateBrowserTarget(action, 'target', input.target, true)
    );
  }
  if (POINTER_TARGET_ACTIONS.has(action)) {
    const error = validateBrowserTarget(action, 'target', input, true);
    // Eval 769392: `type { text }` after clicking a field assumed "type into
    // the focused element" (4 calls). Name the supported way instead.
    if (error && (action === 'type' || action === 'fill') && !hasAnyBrowserTarget(input)) {
      return `${error} ${action} does not write to the current focus: pass the ref of the field to write into (for example the one you just clicked), or use press_key for individual keys.`;
    }
    return error;
  }
  if (ELEMENT_TARGET_ACTIONS.has(action)) {
    return validateBrowserTarget(action, 'target', input, false);
  }
  if (action === 'upload_files') {
    if (!hasNonEmptyString(input.ref)) {
      return 'Browser upload_files target requires an opaque element ref from inspect/query.';
    }
    return validateBrowserTarget(action, 'target', input, false);
  }
  if (action === 'scroll' && hasNonEmptyString(input.frame) && !hasNonEmptyString(input.ref)) {
    return 'Browser scroll frame targeting requires an opaque element ref.';
  }
  if (action === 'run_script' && hasNonEmptyString(input.code) === hasNonEmptyString(input.path)) {
    return 'Browser run_script requires exactly one of code or path.';
  }
  // press_key and scroll target an element optionally: validate only when one is given.
  if ((action === 'press_key' || action === 'scroll') && hasAnyBrowserTarget(input)) {
    return validateBrowserTarget(action, 'target', input, action === 'scroll');
  }
  return undefined;
}

function hasAnyBrowserTarget(input: Record<string, unknown>): boolean {
  return (
    hasNonEmptyString(input.ref) ||
    hasNonEmptyString(input.selector) ||
    hasNonEmptyString(input.frame) ||
    isRecord(input.position) ||
    isRecord(input.normalized_position)
  );
}

/**
 * Accept unambiguous, harmless variants before contract validation. Eval 762809
 * rejected both shapes even though intent was certain:
 * - `wait { timeout }` without `kind` can only mean a plain timeout wait;
 * - `fill { clear: true }` restates fill's own always-clear semantics.
 * `fill { clear: false }` stays rejected: it asks for append semantics that
 * fill does not provide, and the contract error points the model at `type`.
 *
 * Eval 766011 added three more: the flat provider schema advertises union-wide
 * fields (`filter`, `includeDom`, `limit`, `maxChars`, `clip`) so every kind
 * looks like it accepts them. Redirect the shapes whose intent is certain, and
 * drop only the fields that are a no-op for the selected kind:
 * - query `kind: text|dom` with a `filter` (or a bare `text`) is a "find the
 *   element whose visible text contains X" intent, which is exactly
 *   `kind: semantic`; forwarding it there replaces 12 failed probes per run;
 * - query `kind: snapshot|editable` `maxChars` and `kind: dom` `includeDom`
 *   restate what those kinds already do, so they are dropped the way
 *   `fill { clear: true }` is.
 * Everything else still reaches the contract error, which now names the field
 * the model should have used instead.
 */
export function normalizeBrowserActionInput(action: string, rawInput: unknown): unknown {
  if (!isRecord(rawInput)) return rawInput;
  if (
    action === 'wait' &&
    rawInput.kind === undefined &&
    typeof rawInput.timeout === 'number' &&
    Object.keys(rawInput).every((key) => key === 'timeout' || key === 'kind')
  ) {
    return { kind: 'timeout', timeout: rawInput.timeout };
  }
  if (action === 'fill' && rawInput.clear === true) {
    return Object.fromEntries(Object.entries(rawInput).filter(([key]) => key !== 'clear'));
  }
  if (action === 'query') return normalizeQueryInput(rawInput);
  if (action === 'screenshot') return normalizeScreenshotInput(rawInput);
  return rawInput;
}

/**
 * A bare `text` string that is not one of query's own fields is the model's
 * semantic search term. Empty strings are not intent, so they fall through to
 * the contract error instead of silently becoming a different query.
 */
function queryTextIntent(value: unknown, spec: { allowText: boolean }): string | undefined {
  if (spec.allowText) return undefined;
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > 0 ? text : undefined;
}

function normalizeQueryInput(rawInput: Record<string, unknown>): Record<string, unknown> {
  const kind = rawInput.kind;
  if (typeof kind !== 'string') return rawInput;
  // Never rewrite a continuation: snapshotId/offset identify an existing page,
  // so a stray field there is left for the contract error to report.
  const isContinuation = rawInput.snapshotId !== undefined || rawInput.offset !== undefined;
  const searchTerm = queryTextIntent(rawInput.text, { allowText: kind === 'semantic' });
  const filterTerm =
    typeof rawInput.filter === 'string' && rawInput.filter.trim().length > 0
      ? rawInput.filter.trim()
      : undefined;
  const hasSelector = typeof rawInput.selector === 'string' && rawInput.selector.trim().length > 0;

  // "Find the element whose text contains X" — the filter/text fields only ever
  // appear on text/dom, and semantic is the kind that resolves them to refs.
  // Terms longer than semantic's 500-char cap are not identifier lookups, so
  // they keep the original kind and get the contract error instead.
  const term = searchTerm ?? (kind === 'text' ? filterTerm : undefined);
  if (
    (kind === 'text' || kind === 'dom') &&
    !isContinuation &&
    !hasSelector &&
    term !== undefined &&
    term.length <= 500
  ) {
    const semantic: Record<string, unknown> = { kind: 'semantic', text: term };
    const limit = rawInput.limit;
    if (typeof limit === 'number' && Number.isFinite(limit)) {
      semantic.limit = Math.min(Math.max(Math.trunc(limit), 1), 50);
    }
    return semantic;
  }

  // Drop only fields that are a no-op for the selected kind. Everything else —
  // a `selector` on editable/snapshot, an unknown key — is left in place so the
  // contract error names it, instead of being silently swallowed here.
  const redundant =
    kind === 'snapshot' || kind === 'editable' ? new Set(['maxChars']) : new Set<string>();
  if (kind === 'dom') redundant.add('includeDom');
  if (redundant.size === 0) return rawInput;
  const kept = Object.entries(rawInput).filter(([key]) => !redundant.has(key));
  if (kept.length === Object.keys(rawInput).length) return rawInput;
  return Object.fromEntries(kept);
}

/**
 * `scope` is already a declared screenshot field, while `clip` alone can only
 * mean a clipped capture. Filling the implied scope removes the pointless
 * round trip eval 766011 spent on `{ clip: {...} }` without letting a real
 * scope omission (no clip) through.
 */
function normalizeScreenshotInput(rawInput: Record<string, unknown>): Record<string, unknown> {
  if (rawInput.scope !== undefined || !isClipRect(rawInput.clip)) return rawInput;
  return { ...rawInput, scope: 'clip' };
}

function isClipRect(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { x, y, width, height } = value;
  return (
    typeof x === 'number' &&
    typeof y === 'number' &&
    typeof width === 'number' &&
    typeof height === 'number'
  );
}

/**
 * Explain a contract mismatch in terms the model can act on: which fields are
 * not accepted, which are missing, and which fields the action (and, for kind
 * unions such as query/wait, the selected kind) does accept. A bare "does not
 * match" message gave the model nothing to correct (eval: 43 invalid_input).
 */
export function describeBrowserContractMismatch(
  action: string,
  schema: TSchema,
  rawInput: unknown,
): string {
  const base = `Input does not match the contract for browser action "${action}"`;
  if (!isRecord(rawInput)) return `${base}: input must be an object.`;
  const variants = objectVariantsOf(schema);
  if (variants.length === 0) return `${base}.`;
  const kinds = variants
    .map((variant) => literalConst(variant.properties?.kind))
    .filter((kind): kind is string => kind !== undefined);
  let candidates = variants;
  let kindLabel = '';
  if (kinds.length > 0) {
    const requestedKind = rawInput.kind;
    candidates = variants.filter(
      (variant) => literalConst(variant.properties?.kind) === requestedKind,
    );
    if (candidates.length === 0) {
      // Eval 777827: `query { text, limit }` without kind meant a text search.
      const selectorHint =
        action !== 'query'
          ? ''
          : typeof rawInput.selector === 'string'
            ? ' To read one element by CSS selector use kind "dom" (sanitized HTML) or kind "text" (visible text) with input.selector.'
            : typeof rawInput.text === 'string'
              ? ' To locate an element by its visible text use kind "semantic" with input.text.'
              : '';
      return `${base}: kind ${JSON.stringify(requestedKind ?? null)} is not supported. Supported kinds: ${kinds.join(', ')}.${selectorHint}`;
    }
    kindLabel = ` (kind "${String(requestedKind)}")`;
  }
  const variant = selectMismatchVariant(candidates, rawInput);
  if (!variant) return `${base}.`;
  const accepted = Object.keys(variant.properties ?? {});
  const unknown = Object.keys(rawInput).filter((key) => !accepted.includes(key));
  const required = Array.isArray(variant.required) ? (variant.required as string[]) : [];
  const missing = required.filter((key) => rawInput[key] === undefined);
  const problems: string[] = [];
  if (unknown.length > 0) problems.push(`unsupported field(s): ${unknown.join(', ')}`);
  if (missing.length > 0) problems.push(`missing required field(s): ${missing.join(', ')}`);
  if (problems.length === 0) {
    const first = Value.Errors(variant as TSchema, rawInput).First();
    if (first) problems.push(`${first.path || '/'} ${first.message}`);
  }
  const detail = problems.length > 0 ? `: ${problems.join('; ')}` : '';
  const hint = contractNextStepHint(action, rawInput);
  return `${base}${kindLabel}${detail}. Accepted fields: ${accepted.join(', ') || '(none)'}.${hint}`;
}

/**
 * Name the action that already does what the rejected field was reaching for.
 * The flat provider schema advertises `filter`/`limit`/`maxChars`/`clip` at the
 * top level for every kind, so the fix is a short pointer rather than another
 * round of probing (eval 766011: the same probe was repeated 1-2 times before
 * the model found the supported spelling).
 */
function contractNextStepHint(action: string, rawInput: Record<string, unknown>): string {
  // Eval 827211: ~110 scroll calls copied drag's `{ source, target }` endpoint
  // wrapper (`scroll { target: { ref }, direction }`).
  if (action !== 'drag' && (isRecord(rawInput.target) || isRecord(rawInput.source))) {
    return ` Only drag nests its endpoints in source/target; for ${action} put ref, selector, frame, position, or normalized_position directly inside input, for example {"action": "${action}", "input": {"ref": "<opaque-ref>"${action === 'scroll' ? ', "direction": "down"' : ''}}}.`;
  }
  // Eval 769392: `inspect { selector, kind }` (3 calls) expected a scoped read.
  if (action === 'inspect' && ('selector' in rawInput || 'kind' in rawInput)) {
    return ' inspect always lists the whole page; to read one element by CSS selector use action "query" with kind "dom" or "text" and input.selector, or kind "semantic" with input.text to locate it by visible text.';
  }
  if (action !== 'query' || typeof rawInput.kind !== 'string') return '';
  const kind = rawInput.kind;
  const names = new Set(Object.keys(rawInput));
  // Eval 777827: kind "editable"/"snapshot" + selector (5 calls) and kind
  // "dom" + limit (3 calls) expected a scoped or capped read.
  if ((kind === 'snapshot' || kind === 'editable') && names.has('selector')) {
    return ` kind "${kind}" scans the whole page and takes no selector; to read one element by CSS selector use kind "dom" or "text" with input.selector.`;
  }
  if ((kind === 'dom' || kind === 'text') && names.has('limit') && !names.has('text')) {
    return ' kind "dom"/"text" reads the first element matching input.selector; bound the output with maxChars, or use kind "semantic" (which accepts limit) to list several matches.';
  }
  if (
    (kind === 'text' || kind === 'dom' || kind === 'snapshot' || kind === 'editable') &&
    (names.has('text') || names.has('filter'))
  ) {
    return ' To locate the element whose visible text matches, use kind "semantic" with input.text.';
  }
  if (kind === 'editable' && names.has('maxChars')) {
    return ' kind "editable" pages targets with limit; drop maxChars.';
  }
  if (kind === 'snapshot' && names.has('maxChars')) {
    return ' kind "snapshot" pages with limit; use action "inspect" for page reading.';
  }
  return '';
}

interface ObjectSchemaLike {
  properties?: Record<string, unknown>;
  required?: unknown;
}

/**
 * Pick the union variant the input most plausibly targets. The `kind`
 * narrowing above only helps unions discriminated by `kind`; others
 * discriminate on a different const property (screenshot uses
 * `scope: 'clip'`). Taking `candidates[0]` there reported the wrong variant's
 * fields — a clip screenshot with a bad clip was told "unsupported field(s):
 * clip". Drop variants whose const property the input explicitly contradicts,
 * then prefer the variant with the most const properties the input matches,
 * so the field hints come from the variant the model was actually using.
 */
function selectMismatchVariant(
  candidates: ObjectSchemaLike[],
  rawInput: Record<string, unknown>,
): ObjectSchemaLike | undefined {
  let best: ObjectSchemaLike | undefined;
  let bestScore = -1;
  for (const variant of candidates) {
    let score = 0;
    let contradicted = false;
    for (const [key, property] of Object.entries(variant.properties ?? {})) {
      const constValue = literalConst(property);
      if (constValue === undefined) continue;
      if (rawInput[key] === constValue) score += 1;
      else if (rawInput[key] !== undefined) contradicted = true;
    }
    if (contradicted) continue;
    if (score > bestScore) {
      best = variant;
      bestScore = score;
    }
  }
  return best ?? candidates[0];
}

function objectVariantsOf(schema: TSchema): ObjectSchemaLike[] {
  const record = schema as unknown as Record<string, unknown>;
  if (Array.isArray(record.anyOf)) {
    return (record.anyOf as TSchema[]).flatMap((entry) => objectVariantsOf(entry));
  }
  return isRecord(record.properties) ? [record as ObjectSchemaLike] : [];
}

function literalConst(schema: unknown): string | undefined {
  return isRecord(schema) && typeof schema.const === 'string' ? schema.const : undefined;
}

function validateBrowserTarget(
  action: LocalBrowserToolAction,
  label: 'source' | 'target',
  value: unknown,
  allowPosition: boolean,
): string | undefined {
  const target = isRecord(value) ? value : {};
  const hasRef = hasNonEmptyString(target.ref);
  if (hasNonEmptyString(target.frame) && !hasRef) {
    return `Browser ${action} ${label} frame requires an opaque element ref.`;
  }
  const hasElementTarget = hasRef || hasNonEmptyString(target.selector);
  const hasAbsolutePosition = allowPosition && isRecord(target.position);
  const hasNormalizedPosition = allowPosition && isRecord(target.normalized_position);
  const hasCoordinateTarget = hasAbsolutePosition || hasNormalizedPosition;
  if (hasElementTarget && hasCoordinateTarget) {
    return `Browser ${action} ${label} must use either an element ref/selector or a coordinate position, not both.`;
  }
  if (hasAbsolutePosition && hasNormalizedPosition) {
    return `Browser ${action} ${label} must use either position or normalized_position, not both.`;
  }
  if (!hasElementTarget && !hasCoordinateTarget) {
    const supported = allowPosition
      ? 'ref, selector, position, or normalized_position'
      : 'ref or selector';
    return `Browser ${action} ${label} requires at least one of ${supported}.`;
  }
  return undefined;
}

function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function summarizeScreenshotResult(result: unknown, imageAvailableToModel: boolean): unknown {
  const sanitizedMetadata = isRecord(result)
    ? (() => {
        const metadata = { ...result };
        delete metadata.data;
        return sanitizeBrowserResult(metadata);
      })()
    : {
        success: false,
        code: 'INVALID_SCREENSHOT_RESULT',
        message: 'Browser screenshot returned invalid metadata.',
      };
  const userDelivery =
    isRecord(sanitizedMetadata) && isRecord(sanitizedMetadata.userDelivery)
      ? sanitizedMetadata.userDelivery
      : {
          available: false,
          requiresExplicitUserRequest: true,
        };
  return {
    ...(isRecord(sanitizedMetadata) ? sanitizedMetadata : {}),
    imageAvailableToModel,
    imageVisibleToUser: false,
    userDelivery,
    deliveryInstruction: SCREENSHOT_DELIVERY_INSTRUCTION,
  };
}

function screenshotContent(result: unknown): ToolResultContent | undefined {
  if (!isRecord(result)) return undefined;
  if (typeof result.data !== 'string' || result.data.length === 0) return undefined;
  return {
    type: 'image',
    data: result.data,
    mimeType: `image/${screenshotFormat(result.format)}`,
  };
}

function screenshotFormat(format: unknown): 'jpeg' | 'png' | 'webp' {
  if (format === 'jpeg' || format === 'jpg') return 'jpeg';
  return format === 'webp' ? 'webp' : 'png';
}

function sanitizeBrowserResult(value: unknown, omittedKeys?: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeBrowserResult(item, omittedKeys));
  }
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (omittedKeys?.has(key)) continue;
    if (key === 'data' && typeof item === 'string' && item.length > 1024) {
      out[key] = `[base64 omitted: ${item.length} chars]`;
      continue;
    }
    out[key] = sanitizeBrowserResult(item, omittedKeys);
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
