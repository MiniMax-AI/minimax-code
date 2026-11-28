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
  boundedJsDialogIdentity,
  sanitizeBrowserResult,
  summarizeCompactActionResult,
} from './local-browser-compact-result.js';
import {
  compactBrowserPageText,
  isJsDialogPage,
  withCompactBrowserPage,
} from './local-browser-compact-inspect.js';
import {
  describeBrowserContractMismatch,
  normalizeBrowserActionInput,
  clampBrowserInputToContract,
  takeBrowserArgumentAdjustments,
  prepareBrowserToolArguments,
  validateCompactBrowserInput,
  hasNonEmptyString,
} from './local-browser-input.js';
import { BROWSER_SHORT_DESCRIPTION } from './local-browser-short-description.js';
import {
  observationReadFailure,
  observePage,
  type BrowserObserveRequest,
} from './local-browser-observe.js';
import {
  BROWSER_PROGRAM_OP_ACTION,
  browserProgramDescription,
  browserProgramInputSchema,
  readBrowserProgramInput,
  type BrowserProgramOpOutcome,
  type BrowserProgramRunner,
} from './local-browser-program.js';
import { isPtcChildCall, PTC_CHILD_FULL_OUTPUT_MAX_BYTES } from './output-limit.js';
import { isRecord } from './type-guards.js';
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

/**
 * The compact Browser is on demand: the deferred-tool catalog shows the first
 * line of its description, cut at 120 characters, so that line is only the
 * summary of what the tool does.
 */
const COMPACT_BROWSER_SUMMARY =
  "Session Browser: open, navigate, inspect, click, type and read web pages or Mini Apps in this chat's Browser.\n";

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

/**
 * Runs `operation` under a deadline and the caller's abort. An operation that
 * calls `dispatched()` has handed its work to the provider: a later abort is
 * passed on through its signal but no longer pre-empts it, so the provider's
 * own answer (Browser Core reports a write the abort interrupted as outcome
 * unknown) is the result, still bounded by the deadline.
 */
async function executeWithDeadline<T>(
  operation: (signal: AbortSignal, dispatched: () => void) => Promise<T>,
  timeoutMs: number,
  timeoutLabel: string,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let handedOff = false;
  let rejectExternalAbort: ((error: Error) => void) | undefined;
  const externalAbortPromise = new Promise<never>((_resolve, reject) => {
    rejectExternalAbort = reject;
  });
  const onExternalAbort = () => {
    const error = Object.assign(new Error('Operation aborted'), { code: 'ABORTED' });
    if (!handedOff) rejectExternalAbort?.(error);
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

  const operationPromise = Promise.resolve().then(() =>
    operation(controller.signal, () => {
      handedOff = true;
    }),
  );
  try {
    return await Promise.race([operationPromise, timeoutPromise, externalAbortPromise]);
  } catch (error) {
    // On cancellation the operation usually settles moments later with a
    // more specific error (for example run_script's warning that page code
    // may still run). Prefer it when it arrives within a short grace period;
    // otherwise keep the generic cancellation.
    if (externalSignal?.aborted) {
      let cancelGrace = (): void => undefined;
      const specific = await Promise.race([
        operationPromise.then(
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
  /** Receives metric observations; never changes what an action returns. */
  observer?: LocalBrowserObserver;
  /**
   * Whether a Browser call inside a run_code program gets the automatic
   * post-action screenshot (`browser.screenshot.ptcAuto`); read per call.
   * Omitted: it does.
   */
  postActionVisualInPtc?: () => boolean;
  /**
   * `browser.compactInspect`: the model reads inspect and semantic query
   * pages as one line per element. Read per call. Omitted: full records (the
   * product default is decided by the config, `resolveBrowserCompactInspect`).
   */
  compactInspect?: () => boolean;
  /**
   * `browser.compactInspect` for the Browser description, fixed for the
   * tool's Turn: the short description, with the same contract. Omitted: the
   * full one.
   */
  shortDescription?: boolean;
  /**
   * Browser programs (PTC Turns only): with a provider that declares
   * `programOps`, run_script runs its code through this runner as a page
   * program (run_code calls it as tools.browser). Omitted: run_script is the
   * provider's page script, unchanged.
   */
  programRunner?: BrowserProgramRunner;
}

/** One provider call made for a Browser action the model requested. */
export interface LocalBrowserActionObservation {
  readonly sessionId: string;
  readonly turnId: LocalRuntimeToolContext['turnId'];
  readonly action: LocalBrowserToolAction;
  /** Raw provider result; absent when the provider threw. */
  readonly result?: unknown;
  /** Structured code of a provider throw. */
  readonly errorCode?: string;
}

export type LocalBrowserPostActionVisualOutcome =
  | 'attached'
  | 'deduplicated'
  | 'empty'
  | 'failed'
  | 'timeout';

/** Provider-measured split of a screenshot call (`captureTiming` on the raw result). */
export interface LocalBrowserScreenshotCaptureTiming {
  readonly queueMs?: number;
  readonly captureMs?: number;
  readonly encodeMs?: number;
}

/**
 * One automatic post-action screenshot, timed from the end of the action.
 * `requestMs + providerMs + compressMs` adds up to `waitMs` for a returned
 * capture; a capture that missed its deadline reports only `waitMs`.
 */
export interface LocalBrowserPostActionVisualObservation {
  readonly sessionId: string;
  readonly turnId: LocalRuntimeToolContext['turnId'];
  readonly action: LocalBrowserToolAction;
  readonly outcome: LocalBrowserPostActionVisualOutcome;
  /** Action end until the visual is ready or abandoned, including every queue. */
  readonly waitMs: number;
  /** Action end until the screenshot request left the tool. */
  readonly requestMs: number;
  /** Screenshot request to provider response. */
  readonly providerMs?: number;
  readonly providerTiming?: LocalBrowserScreenshotCaptureTiming;
  /** Runtime decode, resize and compression of the returned image. */
  readonly compressMs?: number;
}

export interface LocalBrowserObserver {
  actionExecuted(observation: LocalBrowserActionObservation): void;
  postActionVisualSettled(observation: LocalBrowserPostActionVisualObservation): void;
}

interface BrowserRuntimeInternalOptions extends LocalBrowserRuntimeToolOptions {
  postActionVisualCountByTurn: Map<string, number>;
  interactiveTakeover: boolean;
  providerNavigationGuidance: string;
}

interface CompactBrowserToolContract {
  readonly description: string;
  readonly input: TSchema;
  readonly programRunner?: BrowserProgramRunner;
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
    const programRunner =
      options.programRunner && capabilities?.programOps === true
        ? options.programRunner
        : undefined;
    // A program Turn's run_script is the program itself, run through
    // `program_op`: a provider without page scripts still gets it, and the
    // provider's own run_script is never called.
    const surfaceActions =
      programRunner && !compactActions.includes('run_script')
        ? [...compactActions, 'run_script' as const]
        : compactActions;
    const description = options.shortDescription
      ? BROWSER_SHORT_DESCRIPTION
      : LocalBrowserToolDef.description;
    const contract: CompactBrowserToolContract = programRunner
      ? {
          description: browserProgramDescription(description),
          input: browserProgramInputSchema(),
          programRunner,
        }
      : {
          description,
          input: LocalBrowserToolDef.schema.properties.input,
        };
    tools.push(createBrowserCompactRuntimeTool(adapter, runtimeOptions, surfaceActions, contract));
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
 * accept `observe` here, as the Browser definition does.
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
  surface: CompactBrowserToolContract,
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
    loading: 'on_demand' as const,
    description: `${COMPACT_BROWSER_SUMMARY}${surface.description} ${options.providerNavigationGuidance}`,
    schema: Type.Object(
      {
        action: actionSchema,
        input: surface.input,
        observe: LocalBrowserToolDef.schema.properties.observe,
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
      prepareBrowserToolArguments(args, compactActions, surface.input) as Static<typeof def.schema>,
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
      if (action === 'run_script' && surface.programRunner) {
        const adjustments = takeBrowserArgumentAdjustments(input);
        return withArgumentAdjustments(
          await runBrowserProgram(
            adapter,
            options,
            surface.programRunner,
            ctx,
            input.input,
            signal,
          ),
          adjustments,
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

      // Only page-changing actions take observe; the flat schema cannot say which.
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

      const adjustments = [...takeBrowserArgumentAdjustments(input)];
      const normalized = normalizeBrowserActionInput(action, input.input ?? {}, adjustments);
      const rawInput = isRecord(normalized)
        ? clampBrowserInputToContract(contract.schema, normalized, adjustments)
        : normalized;
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

      const compactLines = options.compactInspect?.() === true;
      const result = await runBrowserAction(
        LocalBrowserToolDef.name,
        action,
        adapter,
        ctx,
        validatedInput,
        signal,
        compactLines ? 'compact-lines' : 'compact',
        options.preprocessScreenshot,
        options.browserSkillSessionStore,
        options.postActionVisualCountByTurn,
        options.interactiveTakeover,
        observe as BrowserObserveRequest | undefined,
        options.observer,
        options.postActionVisualInPtc,
      );
      const adjusted = withArgumentAdjustments(result, adjustments);
      return compactLines ? withCompactBrowserPage(adjusted) : adjusted;
    },
  });
}

/**
 * Says which values of the call were adjusted (a length or timeout cut to
 * its maximum, an inferred wait kind) in the result the model reads.
 */
function withArgumentAdjustments(result: ToolResult, adjustments: readonly string[]): ToolResult {
  if (adjustments.length === 0) return result;
  const details = isRecord(result.details) ? result.details : {};
  if (isRecord(details.result)) {
    const adjusted = { ...details.result, argumentsAdjusted: [...adjustments] };
    const text = JSON.stringify({ action: details.action, result: adjusted }, null, 2);
    return {
      ...result,
      text,
      content: [{ type: 'text', text }, ...result.content.slice(1)],
      details: { ...details, result: adjusted },
      ...(result.programmatic
        ? { programmatic: { data: { action: details.action, result: adjusted } } }
        : {}),
    };
  }
  if (/<\/browser_error>$/u.test(result.text)) {
    const text = result.text.replace(
      /<\/browser_error>$/u,
      ` Adjusted arguments: ${adjustments.join(' ')}</browser_error>`,
    );
    return { ...result, text, content: [{ type: 'text', text }] };
  }
  // A program's report: the note leads its text, and run_code reads it in data.
  const text = `Adjusted arguments: ${adjustments.join(' ')}\n${result.text}`;
  const data = result.programmatic?.data;
  return {
    ...result,
    text,
    content: [{ type: 'text', text }, ...result.content.slice(1)],
    details: { ...details, argumentsAdjusted: [...adjustments] },
    ...(result.programmatic && data
      ? {
          programmatic: {
            ...result.programmatic,
            data: { ...data, argumentsAdjusted: [...adjustments] },
          },
        }
      : {}),
  };
}

/**
 * One run_script program. Ops bypass the Browser action input contracts
 * (Browser Core validates each op) but not the rest of this path: the Skill
 * receipt, the per-session queue shared with every Browser call, waiting for
 * a pending post-action visual, and a deadline per op.
 */
async function runBrowserProgram(
  adapter: LocalBrowserAdapter,
  options: BrowserRuntimeInternalOptions,
  runner: BrowserProgramRunner,
  ctx: LocalRuntimeToolContext,
  rawInput: unknown,
  signal?: AbortSignal,
): Promise<ToolResult> {
  if (!isBrowserSkillLoaded(options.browserSkillSessionStore, ctx)) {
    return browserSkillRequiredError(
      LocalBrowserToolDef.name,
      'run_script',
      options.browserSkillSessionStore,
    );
  }
  const request = readBrowserProgramInput(rawInput);
  if ('error' in request) {
    return browserToolError(LocalBrowserToolDef.name, 'run_script', request.error, 'invalid_input');
  }
  const lifecycle = { sessionId: ctx.sessionId, turnId: ctx.turnId };
  adapter.notifyLifecycle?.({ type: 'program_start', ...lifecycle });
  try {
    return await runner.run({
      ctx,
      code: request.code,
      timeoutMs: request.timeoutMs,
      ...(signal ? { signal } : {}),
      runOp: (op, opSignal) => runBrowserProgramOp(adapter, options, ctx, op, opSignal),
    });
  } finally {
    adapter.notifyLifecycle?.({ type: 'program_end', ...lifecycle });
  }
}

/**
 * The Skill receipt. A supplied session store is authoritative because committed
 * history replacement clears it while the current turn's loadedSkills Set survives.
 */
function isBrowserSkillLoaded(
  store: LocalBrowserSkillSessionStore | undefined,
  ctx: LocalRuntimeToolContext,
): boolean {
  return store
    ? store.hasLoaded(ctx.sessionId)
    : !ctx.loadedSkills || ctx.loadedSkills.has(CONTROL_IN_APP_BROWSER_SKILL_NAME);
}

/** Nothing ran: the Skill loads by a top-level skill call, which run_code cannot make. */
function browserSkillRequiredError(
  toolName: string,
  action: LocalBrowserToolAction,
  store: LocalBrowserSkillSessionStore | undefined,
): ToolResult {
  const skill = store?.requiredSkillName ?? CONTROL_IN_APP_BROWSER_SKILL_NAME;
  return browserToolError(
    toolName,
    action,
    `Nothing ran on the page: the ${skill} skill is not loaded in this session. Next step: call the skill tool directly (a top-level call, never inside run_code) with { "name": "${skill}" } as the only tool call of that step, wait for its complete result, then repeat this Browser call. Re-read the skill the same way if the installed Skill has changed.`,
    'SKILL_REQUIRED',
  );
}

async function runBrowserProgramOp(
  adapter: LocalBrowserAdapter,
  options: BrowserRuntimeInternalOptions,
  ctx: LocalRuntimeToolContext,
  op: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
): Promise<BrowserProgramOpOutcome> {
  const name = typeof op.op === 'string' ? op.op : 'unknown';
  let release: (() => void) | undefined;
  let dispatched = false;
  try {
    release = await acquireBrowserSessionTurn(adapter, ctx.sessionId, signal);
    return await executeWithDeadline(
      async (operationSignal, handOff) => {
        await waitForPendingPostActionVisual(adapter, ctx.sessionId, operationSignal);
        dispatched = true;
        handOff();
        const raw = await adapter.execute(
          ctx,
          BROWSER_PROGRAM_OP_ACTION,
          { ...op },
          operationSignal,
        );
        if (!isRecord(raw)) {
          const mayHaveWritten = PROGRAM_WRITE_OPS[name] === true;
          return programOpRefusal(name, 'BROWSER_OP_FAILED', 'No result.', mayHaveWritten);
        }
        if (name !== 'screenshot' || raw.ok !== true) return { result: raw };
        const shot = options.preprocessScreenshot
          ? await options.preprocessScreenshot(raw.value, ctx, operationSignal)
          : raw.value;
        const image = screenshotContent(shot);
        return {
          result: { ...raw, value: { attached: image !== undefined } },
          ...(image ? { media: [image] } : {}),
        };
      },
      LOCAL_BROWSER_TOOL_TIMEOUT_MS,
      'Browser program op',
      signal,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = thrownBrowserErrorCode(error) ?? 'BROWSER_OP_FAILED';
    return programOpRefusal(name, code, message, dispatched && PROGRAM_WRITE_OPS[name] === true);
  } finally {
    release?.();
  }
}

/**
 * Program ops that can change the page: Browser Core's write ops and page
 * JavaScript, the same list as PAGE_WRITE_OPS in local-runtime-v2's
 * program-result.ts (this package does not depend on either).
 */
const PROGRAM_WRITE_OPS: Readonly<Record<string, true>> = {
  click: true,
  dblclick: true,
  mouseClick: true,
  check: true,
  uncheck: true,
  fill: true,
  type: true,
  press: true,
  selectOption: true,
  evaluate: true,
};

/**
 * An op that ended without Browser Core's own result. One that may have
 * reached the page (a write handed to the provider) is outcome unknown, so the
 * program reads before repeating it and the run_script result lists it as
 * such instead of "No page writes ran.".
 */
function programOpRefusal(
  op: string,
  code: string,
  message: string,
  mayHaveWritten = false,
): BrowserProgramOpOutcome {
  const text = message.startsWith(`${code}:`) ? message : `${code}: ${message}`;
  return {
    result: {
      ok: false,
      error: {
        code,
        message: mayHaveWritten
          ? `${text} The ${op} may already have taken effect: read the page before repeating it.`
          : text,
        retryable: false,
        ...(mayHaveWritten ? { writeOutcomeUnknown: true } : {}),
      },
      step: {
        op,
        write: mayHaveWritten,
        durationMs: 0,
        code,
        ...(mayHaveWritten ? { outcome: 'uncertain' } : {}),
      },
    },
  };
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
      return runBrowserAction(
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
        undefined,
        options.observer,
        options.postActionVisualInPtc,
      );
    },
  });
}

function browserProviderNavigationGuidance(provider: string | undefined): string {
  if (provider === 'electron-file-panel') {
    return 'Active Browser provider: electron-file-panel. Agent control: you write to exactly one controlled tab per turn. A new turn starts with no controlled tab; page-changing actions return TAB_NOT_CONTROLLED until you open_tab (new tab, becomes controlled) or select_tab an existing tab. select_tab never changes the page the user is viewing. Reads (inspect, query, screenshot) use the controlled tab, or the user\'s current tab when none is controlled. Tab reuse: the <in-app-browser-context> block lists this chat\'s tabs as the turn starts (list_tabs gives the current ones); when this turn has no such tab list, call list_tabs before open_tab. Before open_tab, when a tab already shows the site you need, select_tab it and work inside it (type in its search box, follow its links) instead of opening a duplicate (do not navigate a tab already at the target URL); with no tab on that site, open_tab. navigate replaces only the page of a tab you control; on the user\'s tab or the page the user is viewing, navigate to another URL only when the user asked to change that page. Browser work stays in the background and the Browser panel does not open by itself; list_tabs reports panelVisible (whether the user can see this chat\'s Browser) and visibleTabId. Show a page (show_tab { tabId } or open_tab { url, show: true }) only when the request is mainly to put that page in front of the user or let them watch (for example "show me X", "打开给我", "给我看看"); do not show it when the page is only a means to answer a question or verify something. A page the user asked to look at themselves stays theirs after this turn: mark it deliverable too. Opening a page to read or check something in it ("用内置浏览器打开 X 看一下标题") is a lookup: neither show nor keep it. When the user must act in a page themselves (sign in, verification), show_tab it, then release_tab so their input is not blocked (release_tab keeps an Agent page for the next turn), then ask_user; afterwards select_tab it and inspect it before writing again. ask_user alone does not hand the page over: while you control it the user\'s input stays blocked. Pages you open are temporary and close when the turn ends unless the user used them or you mark them. mark_tab { tabId, retention: "deliverable" } only when the live page itself is the user-facing result: a page the user asked to look at themselves, something you created or edited (a document, a draft, a filled cart or checkout), a submitted form\'s result, or a page the user asked to keep open; it becomes the user\'s page. mark_tab { tabId, retention: "carryover" } only when your work must continue from this live page in a later turn (waiting for the user\'s reply or go-ahead, sign-in, approval, payment, an unfinished flow); it lasts one turn: in the next turn the page is listed as temporary again (expected, not a lost mark) and closes at that turn\'s end unless you mark it again, before asking the user anything. A request to keep a page for the next turn is carryover. Do not mark research, search, source, intermediate, duplicate, blank, error or routine pages: once you have what you need, cite the URL in your reply and let turn-end cleanup close them. A link the controlled tab opens in a new tab becomes the controlled tab; the result reports openedTab and previousTabId. To leave such a tab and continue on the page it came from, close_tab it, then select_tab previousTabId. close_tab closes any tab of this session; close only your own pages you no longer need, and close the user\'s pages only when asked. To open a Mini App, use open_tab input { miniAppId: "<plugin ID>" }; it reuses this session\'s page of that app and shows it to the user. Call open_tab without observe, wait for its result, then call inspect separately. close_tab on a running Mini App stops the app and closes its pages in every session; do it only when the user asks to close the app. A Browser program follows the same rules in its own calls: a write on a page you opened takes control of it, a write on the user\'s page needs page.bringToFront() (select_tab) first, browser.newPage(url) opens a page like open_tab and page.keep() is mark_tab. If any Browser call returns BROWSER_USER_TAKEOVER, the user took over the Browser: stop Browser calls for this turn, say in plain words which step you stopped at and what the user can do next, then end the turn without calling ask_user (an ask_user answer does not return control); control returns after the user sends a new message.';
  }
  if (provider === 'native-headless-chrome') {
    return 'Active Browser provider: native-headless-chrome. Use fully qualified absolute HTTP(S) URLs. Agent control: you write to exactly one controlled tab per turn. A new turn starts with no controlled tab; page-changing actions return TAB_NOT_CONTROLLED until you open_tab (new tab, becomes controlled) or select_tab a tab from list_tabs. When the session has no tab, the first action opens a blank tab you control. Use navigate to replace the controlled tab\'s page by default; use open_tab only when the user explicitly requests another tab or the task requires preserving the current page. Reads (inspect, query, screenshot) use the controlled tab, or the tab you controlled last when none is. A link the controlled tab opens in a new tab becomes the controlled tab (the result reports openedTab and previousTabId); when that tab closes itself, control returns to the tab that opened it (leaseReturnedTo). To leave such a tab and continue on the page it came from, close_tab it, then select_tab previousTabId. close_tab { tabId } closes a tab; closing the controlled tab releases control. Pages you open are temporary and close when the turn ends. mark_tab { tabId, retention: "deliverable" } only when the live page itself is the result (a page the user asked to look at themselves, something you created or edited, a submitted form\'s result, a page the user asked to keep open); mark_tab { tabId, retention: "carryover" } only when your work must continue from this page in a later turn (one turn: in the next turn it is listed as temporary again and closes at that turn\'s end unless you mark it again). Do not mark research, search, source or intermediate pages. A Browser program follows the same rules in its own calls: a write on a page you opened takes control of it, page.bringToFront() selects a tab like select_tab, browser.newPage(url) opens one like open_tab and page.keep() is mark_tab.';
  }
  return 'Follow the active Browser provider navigation policy when choosing between navigate and open_tab. Page-changing actions need the one tab you control this turn (TAB_NOT_CONTROLLED until you open_tab or select_tab); pages you open close at turn end unless mark_tab keeps them.';
}

/**
 * `compact` is the short result of the compact tool; `compact-lines` is that
 * result when `browser.compactInspect` turns its pages into element lines.
 */
type BrowserResultExposure = 'compact' | 'compact-lines' | 'full';

async function runBrowserAction(
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
  observer?: LocalBrowserObserver,
  postActionVisualInPtc?: () => boolean,
): Promise<ToolResult> {
  let releaseSession: (() => void) | undefined;
  try {
    releaseSession = await acquireBrowserSessionTurn(adapter, ctx.sessionId, signal);
    return await executeWithDeadline(
      async (operationSignal) => {
        if (!isBrowserSkillLoaded(browserSkillSessionStore, ctx)) {
          return browserSkillRequiredError(toolName, action, browserSkillSessionStore);
        }

        const rawInput = isRecord(input) ? input : {};
        await waitForPendingPostActionVisual(adapter, ctx.sessionId, operationSignal);
        const rawResult = await executeObservedProviderAction(
          adapter,
          ctx,
          action,
          rawInput,
          operationSignal,
          observer,
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
                observer,
                postActionVisualInPtc,
              );
        const actionResult = browserToolResult(
          toolName,
          action,
          result,
          exposure,
          postActionVisual,
          interactiveTakeover,
          isPtcChildCall(ctx),
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
            isPtcChildCall(ctx),
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
    const structuredCode = thrownBrowserErrorCode(error);
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
    'The page did not respond in time. Refs issued before this error may no longer resolve and the tab may have been reset; inspect the current page (navigate again if it is about:blank) before retrying.',
  ACTION_TIMEOUT:
    'Refs issued before this error may no longer resolve; inspect the current page before retrying.',
};

/**
 * Page writes: Browser Core's BROWSER_WRITE_ACTIONS (this package does not
 * depend on Browser Core) plus run_script, whose page JavaScript can send a
 * write like any of them. Desktop eval: timed-out submits had reached the
 * server and were submitted again, so an interrupted write says its outcome is
 * unknown; a read never does.
 */
const BROWSER_WRITE_ACTIONS: Readonly<Record<string, true>> = {
  click: true,
  click_and_wait_for_navigation: true,
  double_click: true,
  triple_click: true,
  drag: true,
  fill: true,
  type: true,
  paste: true,
  press_key: true,
  check: true,
  uncheck: true,
  select_option: true,
  upload_files: true,
  run_script: true,
};

function browserToolError(
  toolName: string,
  action: LocalBrowserToolAction,
  message: string,
  code: string,
  metadata: { label?: string; timeoutMs?: number; brokerCode?: string } = {},
): ToolResult {
  const interruption = BROWSER_INTERRUPTION_RECOVERY[code];
  // Browser Core already ends an uncertain write's message with this advice
  // when the deadline was its own; a provider deadline does not.
  const uncertainWrite =
    interruption !== undefined &&
    BROWSER_WRITE_ACTIONS[action] === true &&
    !message.includes('may already have taken effect');
  const recovery = [
    ...(uncertainWrite
      ? [
          `The ${action} outcome is unknown and it may already have taken effect: check its result on the page or site before repeating it.`,
        ]
      : []),
    ...(interruption ? [interruption] : []),
  ].join(' ');
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
  ptcChild = false,
): ToolResult {
  const resultIsFailure = isRecord(result) && result.success === false;
  const screenshot = screenshotContent(result);
  const postActionScreenshot = screenshotContent(postActionVisual?.result);
  const scriptScreenshots = action === 'run_script' ? scriptScreenshotContents(result) : [];
  const shortTexts = exposure !== 'full';
  let sanitized =
    action === 'screenshot'
      ? summarizeScreenshotResult(result, screenshot !== undefined && !resultIsFailure)
      : action === 'run_script'
        ? summarizeScriptResult(result, resultIsFailure)
        : shortTexts && action !== 'inspect' && action !== 'query'
          ? summarizeCompactActionResult(action, result)
          : shortTexts
            ? sanitizeBrowserReadResult(action, result, COMPACT_PRIVATE_RESULT_KEYS)
            : sanitizeBrowserReadResult(action, result);
  if (shortTexts) sanitized = appendBrowserReadingGuidance(action, sanitized);
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
  // With compact lines the model reads the lines withCompactBrowserPage makes
  // of this result, so the budget measures those, and a page that fits keeps
  // its records whole: their attributes give the lines names, types and link
  // addresses. Measuring the indented JSON instead sends most inspect pages to
  // the fallback below, which drops every attribute the lines are made from.
  const shownBytes = (): number =>
    Buffer.byteLength(
      (exposure === 'compact-lines' ? compactBrowserPageText(action, sanitized) : undefined) ??
        text,
      'utf8',
    );
  // Inside run_code only the program's return value reaches the model, and
  // the program needs the whole records to pick a target (session
  // mvs_6d7eb2b6: two textareas with one box, told apart only by the id and
  // name this budget dropped). A child result is therefore measured by the
  // records the program receives, against PTC_BROWSER_RESULT_MAX_BYTES, and
  // only past that takes the same compaction steps.
  const overBudget = (): boolean =>
    ptcChild
      ? Buffer.byteLength(JSON.stringify({ action, result: sanitized }), 'utf8') >
        PTC_BROWSER_RESULT_MAX_BYTES
      : shownBytes() > MAX_COMPACT_BROWSER_TEXT_BYTES;
  if (shortTexts && overBudget()) {
    // Browser Core budgets pages as compact JSON; two-space indentation alone
    // can push a fitting page past 64 KiB (eval 761096: 8 bare inspects
    // failed with BROWSER_RESULT_TOO_LARGE). Oversized results are therefore
    // serialized without indentation and, as a last resort, an inspect page
    // is shortened with an exact continuation instead of being discarded.
    sanitized = compactOversizedInspectResult(action, sanitized);
    sanitized = appendBrowserReadingGuidance(action, sanitized);
    text = JSON.stringify({ action, result: sanitized });
    if (overBudget()) {
      const shortened = shortenOversizedInspectPage(action, sanitized);
      if (shortened !== sanitized) {
        sanitized = appendBrowserReadingGuidance(action, shortened);
        text = JSON.stringify({ action, result: sanitized });
      }
    }
  }
  if (shortTexts && overBudget()) {
    const safety = readAuthenticationTakeoverSafety(sanitized);
    sanitized = {
      success: false,
      code: 'BROWSER_RESULT_TOO_LARGE',
      message: ptcChild
        ? `Browser result exceeded the ${PTC_BROWSER_RESULT_MAX_BYTES / 1024 / 1024} MiB run_code result budget. Narrow the request and retry.`
        : 'Browser result exceeded the compact 64 KiB budget. Narrow the request and retry.',
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

  const deliveryRefs = isError ? [] : screenshotDeliveryRefs(action, sanitized);
  return {
    tool_name: toolName,
    text,
    content,
    details: {
      action,
      result: sanitized,
      // The saved file of a deliverable screenshot. Inside run_code the
      // screenshot text stays with the program, so the host lists these refs
      // next to the attached image; without them the model has no real path.
      ...(deliveryRefs.length > 0 ? { refs: deliveryRefs } : {}),
    },
    // A run_code program reads refs, effects and URLs from data instead of
    // re-parsing the text; it carries exactly the bounded result the text
    // shows. Agent Core drops `programmatic` from model-visible results, so a
    // direct call is unchanged.
    programmatic: { data: { action, result: sanitized } },
    ...(isError ? { isError: true } : {}),
  };
}

function screenshotDeliveryRefs(
  action: LocalBrowserToolAction,
  result: unknown,
): { readonly uri: string; readonly mimeType?: string }[] {
  if (action !== 'screenshot' || !isRecord(result) || !isRecord(result.userDelivery)) return [];
  const delivery = result.userDelivery;
  if (delivery.available !== true || !hasNonEmptyString(delivery.filePath)) return [];
  return [
    {
      uri: delivery.filePath,
      ...(hasNonEmptyString(delivery.mimeType) ? { mimeType: delivery.mimeType } : {}),
    },
  ];
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
  // Page JavaScript's code and effects; a page write makes the next write wait for a read.
  'pageScript',
  'uncertainWrite',
] as const;

function summarizeScriptResult(result: unknown, imagesOmitted = false): unknown {
  if (!isRecord(result)) return sanitizeBrowserResult(result);
  const summary: Record<string, unknown> = {};
  for (const key of SCRIPT_RESULT_KEYS) {
    if (result[key] !== undefined) summary[key] = sanitizeBrowserResult(result[key]);
  }
  const jsDialog = boundedJsDialogIdentity(result.dialog);
  if (jsDialog !== undefined) summary.dialog = jsDialog;
  if (typeof result.trigger === 'string') summary.trigger = result.trigger.slice(0, 64);
  if (result.awaitingUser === true) summary.awaitingUser = true;
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
 * model is still told to call ask_user next.
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
  observer?: LocalBrowserObserver,
  postActionVisualInPtc?: () => boolean,
): Promise<PostActionVisualCapture | undefined> {
  // Called synchronously after the provider returned the action result.
  const actionEndedAt = Date.now();
  if (!preprocessScreenshot || process.env.MAVIS_BROWSER_POST_ACTION_VISUAL_V1 === '0') {
    return undefined;
  }
  // 6a: inside a run_code program the next Browser call reads what it needs.
  if (postActionVisualInPtc && isPtcChildCall(ctx) && !postActionVisualInPtc()) return undefined;
  const capabilities = adapter.getCapabilities?.();
  if (capabilities && !capabilities.actions.includes('screenshot')) return undefined;
  const budgetKey = `${ctx.sessionId}:${ctx.turnId}`;
  if ((postActionVisualCountByTurn?.get(budgetKey) ?? 0) >= MAX_POST_ACTION_VISUALS_PER_TURN) {
    return undefined;
  }
  const request = resolvePostActionVisualRequest(action, input, result);
  if (!request) return undefined;

  const marks: {
    requestedAt?: number;
    respondedAt?: number;
    processedAt?: number;
    providerTiming?: LocalBrowserScreenshotCaptureTiming;
  } = {};
  let outcome: LocalBrowserPostActionVisualOutcome = 'failed';
  try {
    return await executeWithDeadline(
      async (visualSignal) => {
        marks.requestedAt = Date.now();
        const screenshotCall = Promise.resolve(
          adapter.execute(ctx, 'screenshot', screenshotRequestPayload(request), visualSignal),
        );
        trackPendingPostActionVisual(adapter, ctx.sessionId, screenshotCall);
        const screenshot = takeScreenshotCaptureTiming(await screenshotCall);
        marks.respondedAt = Date.now();
        if (screenshot.timing) marks.providerTiming = screenshot.timing;
        const processed = await preprocessScreenshot(screenshot.result, ctx, visualSignal, {
          purpose: 'post-action',
          action,
        });
        marks.processedAt = Date.now();
        if (!screenshotContent(processed)) {
          if (!isDeduplicatedVisual(processed)) {
            outcome = 'empty';
            return undefined;
          }
          outcome = 'deduplicated';
          return { request, result: processed };
        }
        if (postActionVisualCountByTurn) {
          recordPostActionVisual(postActionVisualCountByTurn, budgetKey);
        }
        outcome = 'attached';
        return { request, result: processed };
      },
      POST_ACTION_VISUAL_TIMEOUT_MS,
      'Browser post-action visual',
      signal,
    );
  } catch (error) {
    // Visual evidence is supplemental. A capture/compression failure must not
    // replace the Browser action's authoritative success or failure result.
    outcome = error instanceof BrowserOperationTimeoutError ? 'timeout' : 'failed';
    return undefined;
  } finally {
    const { requestedAt, respondedAt, processedAt, providerTiming } = marks;
    notifyObserver(() =>
      observer?.postActionVisualSettled({
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        action,
        outcome,
        waitMs: (processedAt ?? Date.now()) - actionEndedAt,
        requestMs: (requestedAt ?? actionEndedAt) - actionEndedAt,
        ...(requestedAt !== undefined && respondedAt !== undefined
          ? { providerMs: respondedAt - requestedAt }
          : {}),
        ...(providerTiming ? { providerTiming } : {}),
        ...(respondedAt !== undefined && processedAt !== undefined
          ? { compressMs: processedAt - respondedAt }
          : {}),
      }),
    );
  }
}

/**
 * The provider call behind one requested Browser action. Reports the raw
 * result (or the throw) to the observer and drops the provider's screenshot
 * timing so it never reaches a model-visible result.
 */
async function executeObservedProviderAction(
  adapter: LocalBrowserAdapter,
  ctx: LocalRuntimeToolContext,
  action: LocalBrowserToolAction,
  input: Record<string, unknown>,
  signal: AbortSignal,
  observer: LocalBrowserObserver | undefined,
): Promise<unknown> {
  let result: unknown;
  try {
    result = await Promise.resolve(adapter.execute(ctx, action, input, signal));
  } catch (error) {
    const errorCode = thrownBrowserErrorCode(error);
    notifyObserver(() =>
      observer?.actionExecuted({
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        action,
        ...(errorCode ? { errorCode } : {}),
      }),
    );
    throw error;
  }
  notifyObserver(() =>
    observer?.actionExecuted({ sessionId: ctx.sessionId, turnId: ctx.turnId, action, result }),
  );
  return action === 'screenshot' ? takeScreenshotCaptureTiming(result).result : result;
}

function takeScreenshotCaptureTiming(result: unknown): {
  result: unknown;
  timing?: LocalBrowserScreenshotCaptureTiming;
} {
  if (!isRecord(result) || !('captureTiming' in result)) return { result };
  const { captureTiming, ...rest } = result;
  if (!isRecord(captureTiming)) return { result: rest };
  const timing: { queueMs?: number; captureMs?: number; encodeMs?: number } = {};
  for (const key of ['queueMs', 'captureMs', 'encodeMs'] as const) {
    const value = captureTiming[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) timing[key] = value;
  }
  return { result: rest, timing };
}

/** Provider codes as the model and metrics see them, the same on every path. */
const NORMALIZED_PROVIDER_CODES: Readonly<Record<string, string>> = {
  aborted: 'ABORTED',
  browser_operation_timeout: 'BROWSER_OPERATION_TIMEOUT',
  background_render_operation_timeout: 'BROWSER_OPERATION_TIMEOUT',
  background_render_queue_timeout: 'BROWSER_OPERATION_TIMEOUT',
};

/**
 * The structured code of an error a provider threw: its `code` (provider
 * spellings normalized), else a `CODE:` prefix of its message.
 */
function thrownBrowserErrorCode(error: unknown): string | undefined {
  if (isRecord(error) && typeof error.code === 'string' && /^[A-Za-z]\w*$/u.test(error.code)) {
    return NORMALIZED_PROVIDER_CODES[error.code] ?? error.code;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /^([A-Z][A-Z0-9_]+):/u.exec(message)?.[1];
}

/** Observers feed metrics; a throwing observer must not change the action. */
function notifyObserver(notify: () => void): void {
  try {
    notify();
  } catch {
    // Metrics are best effort.
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
 * `__postActionVisual` tells Browser Core this capture is not a read the model
 * chose: it does not verify an earlier uncertain write it does not frame.
 */
function screenshotRequestPayload(request: PostActionVisualRequest): Record<string, unknown> {
  return {
    scope: request.scope,
    ...(request.clip === undefined ? {} : { clip: request.clip }),
    __postActionVisual: true,
  };
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
  // An uncertain write (a page load it started still pending) must be checked
  // by a read the model chooses; an automatic capture of the old page would
  // count as that read in Browser Core's write record.
  if (isRecord(result.uncertainWrite)) return undefined;
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
/**
 * Bound on the records a run_code child receives (`{ action, result }` as
 * JSON). The bridge carries them as `data` next to `output` (the text, never
 * larger) and fails results past 16 MiB; a quarter of the child output cap
 * (output-limit.ts) leaves room for both, for escaping, and for an action
 * result merged with an observation that is itself within this bound.
 */
const PTC_BROWSER_RESULT_MAX_BYTES = PTC_CHILD_FULL_OUTPUT_MAX_BYTES / 4;

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

const COMPACT_PRIVATE_RESULT_KEYS = new Set(['browserState', 'sessionId', 'tabId']);

/** Elements of the snapshot after this page, when the page says where it ends. */
function remainingSnapshotElements(page: Record<string, unknown>): number | undefined {
  const { totalElements, offset, returnedElements } = page;
  if (typeof totalElements !== 'number' || typeof returnedElements !== 'number') return undefined;
  const start = typeof offset === 'number' ? offset : 0;
  const remaining = Math.floor(totalElements - start - returnedElements);
  return Number.isFinite(remaining) && remaining > 0 ? remaining : undefined;
}

/**
 * A cut inspect page is rarely continued; the reading block says how many
 * elements are left. Prose urging the model to continue before taking a
 * screenshot did not make it continue more often, so only the number stays.
 */
function appendBrowserReadingGuidance(action: LocalBrowserToolAction, result: unknown): unknown {
  if (action !== 'inspect' || !isRecord(result) || !Array.isArray(result.elements)) return result;
  if (typeof result.truncated !== 'boolean') return result;
  // The model has to handle a held dialog; "answer now" would tell it not to.
  if (isJsDialogPage(result)) return result;
  if (!result.truncated) {
    return {
      ...result,
      reading: {
        snapshotComplete: true,
        ifRequestedEvidencePresent: 'stop',
        instruction:
          'If the requested evidence is present in this complete snapshot, do not call query, inspect, or screenshot again; answer now.',
      },
    };
  }
  const remaining = remainingSnapshotElements(result);
  return {
    ...result,
    reading: {
      snapshotComplete: false,
      ...(remaining === undefined ? {} : { remainingElements: remaining }),
      ifRequestedEvidencePresent: 'stop',
      requiredNextAction: 'inspect',
      requiredNextInput: isRecord(result.continuation) ? result.continuation.input : undefined,
      instruction:
        'If the requested evidence is already present, stop reading. Otherwise continue with the returned inspect continuation input; do not invent snapshot IDs or offsets.',
    },
  };
}

const AUTHENTICATION_TAKEOVER_SAFETY = {
  classification: 'authentication_user_takeover',
  mutationAllowed: false,
  requiredNextTool: 'ask_user',
  instruction:
    "If you have not already asked about this sign-in, call the actual ask_user tool now as a question that waits for the user's answer, so the user can sign in on this same Browser tab. Do not write <ask_user>, ask_user(...), or a prose placeholder; text does not pause the turn. Inspect this tab again only after the user answers that they signed in.",
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
      queryHtmlFragments(result).some(containsAuthenticationSecretMarkup));
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
  // query kind "dom" with all: true carries one sanitized fragment per match.
  if (action === 'query' && Array.isArray(result.matches)) {
    redacted.matches = result.matches.map((match) =>
      isRecord(match) && typeof match.html === 'string'
        ? { ...match, html: redactAuthenticationSecretMarkup(match.html) }
        : match,
    );
  }
  return redacted;
}

function queryHtmlFragments(result: Record<string, unknown>): string[] {
  const fragments = typeof result.html === 'string' ? [result.html] : [];
  if (Array.isArray(result.matches)) {
    for (const match of result.matches) {
      if (isRecord(match) && typeof match.html === 'string') fragments.push(match.html);
    }
  }
  return fragments;
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

/**
 * query kind "rows" cells are page data keyed by field names the model chose
 * (a grid may well have "sessionId" or "data" columns), so the key-based
 * sanitizer must neither drop nor rewrite them. Core already bounds every cell.
 */
function sanitizeBrowserReadResult(
  action: LocalBrowserToolAction,
  result: unknown,
  omittedKeys?: ReadonlySet<string>,
): unknown {
  if (action !== 'query' || !isRecord(result) || !Array.isArray(result.rows)) {
    return sanitizeBrowserResult(result, omittedKeys);
  }
  const { rows, ...rest } = result;
  const sanitized = sanitizeBrowserResult(rest, omittedKeys);
  return isRecord(sanitized) ? { ...sanitized, rows } : sanitized;
}
