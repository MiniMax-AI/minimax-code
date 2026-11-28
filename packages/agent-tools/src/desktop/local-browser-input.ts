import { Value } from '@sinclair/typebox/value';
import type { TSchema } from '@sinclair/typebox';

import { LocalBrowserToolDef } from './builtin-browser-defs.js';
import { isRecord } from './type-guards.js';
import type { LocalBrowserToolAction } from './types.js';

// Repairs, normalizes and validates compact Browser input before a provider
// runs, and explains contract mismatches to the model.

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
    const repaired = args.action.trim().replace(/["'\\>\s]+$/u, '');
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

const BROWSER_ENVELOPE_EXAMPLE =
  '{ "action": "click", "input": { "ref": "<ref>" }, "observe": { "kind": "text", "waitForText": "Saved" } }';
/** Fields only `observe` declares; inside `input` they can only be a misplaced observe. */
const OBSERVE_ONLY_FIELDS = ['waitForText'] as const;

/**
 * Argument preparation of the compact Browser tool (`browser`, `mcp_browser`
 * and run_code's `tools.browser` all run it). Direct calls put the envelope
 * one level too deep: of 51 rejected direct calls in one evaluation run, 36
 * carried `observe` or a second `input` inside `input`. `input` declares
 * neither field, so both shapes have one reading and are repaired here:
 * - `input.input` is unwrapped when none of its keys is also a sibling;
 * - `input.observe` moves beside `input` when no top-level `observe` exists.
 * The remaining shapes have no single reading and are rejected with the call
 * layout instead of the bare "must not have additional properties":
 * colliding keys, two different `observe` values, and observe-only fields
 * such as `waitForText` written flat into `input` (no `kind` to pick).
 * Top-level `observe` is set aside around the compact repair, which would
 * otherwise move it into `input` with the other unknown top-level keys.
 * `inputSchema` is the tool's own `input` (a program Turn's allows a longer
 * `timeout`), so values are cut to the limit the call is validated with.
 */
export function prepareBrowserToolArguments(
  args: unknown,
  actions: readonly string[],
  inputSchema: unknown = BROWSER_INPUT_SCHEMA,
): unknown {
  if (!isRecord(args)) return prepareCompactBrowserArguments(args, actions);
  const hasObserve = 'observe' in args;
  const { observe: topObserve, ...rest } = args;
  const lifted = liftNestedBrowserEnvelope(rest, hasObserve ? topObserve : undefined);
  const compact = prepareCompactBrowserArguments(lifted.args, actions);
  if (!isRecord(compact)) return compact;
  const notes: string[] = [];
  let prepared: Record<string, unknown> = compact;
  if (isRecord(compact.input)) {
    const input = repairDeclaredNumbers(compact.input, inputSchema, 'input', notes);
    if (input !== compact.input) prepared = { ...prepared, input };
  }
  if (lifted.observe !== undefined) {
    prepared = {
      ...prepared,
      observe: isRecord(lifted.observe)
        ? repairDeclaredNumbers(lifted.observe, BROWSER_OBSERVE_SCHEMA, 'observe', notes)
        : lifted.observe,
    };
  }
  if (notes.length > 0) rememberArgumentAdjustments(prepared, notes);
  return prepared;
}

const BROWSER_INPUT_SCHEMA: unknown = LocalBrowserToolDef.schema.properties.input;
const BROWSER_OBSERVE_SCHEMA: unknown = LocalBrowserToolDef.schema.properties.observe;
/** Length, time and count fields; a value above their declared maximum is cut to it. */
const CLAMPED_FIELDS: Readonly<Record<string, true>> = {
  maxChars: true,
  timeout: true,
  limit: true,
  delay: true,
};
const PLAIN_DECIMAL = /^\s*\d+(?:\.\d+)?\s*$/u;

/**
 * Value repairs against the field schemas the call is validated with, at any
 * depth (`observe.maxChars`, `input.clip.x`, `input.position.y`):
 * - a plain non-negative decimal string where the schema declares a number or
 *   integer becomes that number (an integer field only takes a whole number);
 * - a length, time or count above its declared maximum (`maxChars: 60000`,
 *   `observe.timeout: 20000`) is cut to the maximum and reported in `notes`.
 * Nothing else changes: enums, minimums, other types and unknown fields are
 * left for the validator to report.
 */
function repairDeclaredNumbers(
  value: Record<string, unknown>,
  schema: unknown,
  path: string,
  notes: string[],
): Record<string, unknown> {
  const properties = isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
  let next = value;
  for (const [key, raw] of Object.entries(value)) {
    const field = properties[key];
    if (!isRecord(field)) continue;
    let repaired = raw;
    if (field.type === 'number' || field.type === 'integer') {
      if (typeof raw === 'string' && PLAIN_DECIMAL.test(raw)) {
        const parsed = Number(raw);
        if (field.type === 'number' || Number.isInteger(parsed)) repaired = parsed;
      }
      if (
        typeof repaired === 'number' &&
        typeof field.maximum === 'number' &&
        repaired > field.maximum &&
        CLAMPED_FIELDS[key] === true
      ) {
        notes.push(
          `${path}.${key} ${repaired} is above its maximum ${field.maximum}, so ${field.maximum} was used.`,
        );
        repaired = field.maximum;
      }
    } else if (field.type === 'object' && isRecord(raw)) {
      repaired = repairDeclaredNumbers(raw, field, `${path}.${key}`, notes);
    }
    if (repaired !== raw) {
      if (next === value) next = { ...value };
      next[key] = repaired;
    }
  }
  return next;
}

/**
 * Repairs made in argument preparation, for the result of the same call.
 * Preparation and execution only share the arguments, which the validator
 * copies, so they are matched by content; equal calls carry equal notes.
 */
const ARGUMENT_ADJUSTMENTS = new Map<string, readonly string[]>();
const MAX_REMEMBERED_ADJUSTMENTS = 32;

function rememberArgumentAdjustments(args: unknown, notes: readonly string[]): void {
  ARGUMENT_ADJUSTMENTS.set(JSON.stringify(args), notes);
  while (ARGUMENT_ADJUSTMENTS.size > MAX_REMEMBERED_ADJUSTMENTS) {
    const oldest = ARGUMENT_ADJUSTMENTS.keys().next().value;
    if (oldest === undefined) break;
    ARGUMENT_ADJUSTMENTS.delete(oldest);
  }
}

/** The adjustment notes argument preparation recorded for these (validated) arguments. */
export function takeBrowserArgumentAdjustments(args: unknown): readonly string[] {
  const key = JSON.stringify(args);
  const notes = ARGUMENT_ADJUSTMENTS.get(key) ?? [];
  ARGUMENT_ADJUSTMENTS.delete(key);
  return notes;
}

/** Cuts lengths, times and counts above the selected action contract's maximum. */
export function clampBrowserInputToContract(
  schema: TSchema,
  input: Record<string, unknown>,
  notes: string[],
): Record<string, unknown> {
  const variants = objectVariantsOf(schema);
  const variant =
    variants.length === 1
      ? variants[0]
      : variants.find((candidate) => literalConst(candidate.properties?.kind) === input.kind);
  return variant ? repairDeclaredNumbers(input, variant, 'input', notes) : input;
}

function liftNestedBrowserEnvelope(
  args: Record<string, unknown>,
  topObserve: unknown,
): { args: Record<string, unknown>; observe: unknown } {
  if (!isRecord(args.input)) return { args, observe: topObserve };
  let input: Record<string, unknown> = args.input;
  if (isRecord(input.input)) {
    const { input: inner, ...outer } = input;
    const collisions = Object.keys(inner).filter((key) => key in outer);
    if (collisions.length > 0) {
      throw new Error(
        `Browser arguments nest input inside input, and both levels set ${collisions.map((key) => `"${key}"`).join(', ')}, so the intended value is unclear. ` +
          `Send the action fields once, flat inside a single input, with observe beside input: ${BROWSER_ENVELOPE_EXAMPLE}.`,
      );
    }
    input = { ...outer, ...inner };
  }
  let observe = topObserve;
  if ('observe' in input) {
    const { observe: innerObserve, ...withoutObserve } = input;
    if (observe !== undefined && JSON.stringify(observe) !== JSON.stringify(innerObserve)) {
      throw new Error(
        'Browser arguments set observe twice, at the top level and inside input, with different values. ' +
          `observe belongs beside input, never inside it; send it once: ${BROWSER_ENVELOPE_EXAMPLE}.`,
      );
    }
    observe = innerObserve;
    input = withoutObserve;
  }
  const misplaced = OBSERVE_ONLY_FIELDS.filter((key) => key in input);
  if (misplaced.length > 0) {
    throw new Error(
      `Browser input does not accept ${misplaced.map((key) => `"${key}"`).join(', ')}: it is an observe field. ` +
        `Put it in observe beside input, with observe.kind "text" or "inspect": ${BROWSER_ENVELOPE_EXAMPLE}.`,
    );
  }
  return input === args.input ? { args, observe } : { args: { ...args, input }, observe };
}

/**
 * Eval 774252 lost 5 more calls to the outer validator on value encodings
 * whose meaning is certain (numbers sent as decimal strings are repaired
 * against the schema by `repairDeclaredNumbers`):
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

export function validateCompactBrowserInput(
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
export function normalizeBrowserActionInput(
  action: string,
  rawInput: unknown,
  notes: string[] = [],
): unknown {
  if (!isRecord(rawInput)) return rawInput;
  if (action === 'wait') {
    const wait = inferWaitKind(rawInput);
    if (wait !== rawInput) {
      if (rawInput.kind === undefined)
        notes.push(`wait kind "${String(wait.kind)}" was inferred from the fields sent.`);
      return wait;
    }
  }
  if (action === 'fill' && rawInput.clear === true) {
    return Object.fromEntries(Object.entries(rawInput).filter(([key]) => key !== 'clear'));
  }
  if (action === 'query') return normalizeQueryInput(rawInput);
  if (action === 'screenshot') return normalizeScreenshotInput(rawInput);
  return rawInput;
}

/** Condition fields that name one wait kind each. */
const WAIT_CONDITION_KINDS: Readonly<Record<string, string>> = {
  url: 'url',
  selector: 'selector',
  text: 'text',
};

/**
 * `wait` without `kind` (or `kind: "timeout"` with `delay`): the fields name
 * the kind when exactly one condition field is present (url, selector, text);
 * only timeout/delay means a plain timeout wait, where `delay` is the time to
 * wait. Several conditions, or fields of no wait kind, stay as sent for the
 * contract error.
 */
function inferWaitKind(rawInput: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(rawInput).filter((key) => key !== 'kind');
  const conditions = keys.filter((key) => WAIT_CONDITION_KINDS[key] !== undefined);
  const onlyTime = keys.length > 0 && keys.every((key) => key === 'timeout' || key === 'delay');
  if ((rawInput.kind === undefined || rawInput.kind === 'timeout') && onlyTime) {
    const timeout = rawInput.delay ?? rawInput.timeout;
    return typeof timeout === 'number' ? { kind: 'timeout', timeout } : rawInput;
  }
  if (rawInput.kind !== undefined || conditions.length !== 1) return rawInput;
  const [condition] = conditions;
  return condition ? { ...rawInput, kind: WAIT_CONDITION_KINDS[condition] } : rawInput;
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
  // A kind may span several variants (query text/dom with and without `all`).
  const kinds = [
    ...new Set(
      variants
        .map((variant) => literalConst(variant.properties?.kind))
        .filter((kind): kind is string => kind !== undefined),
    ),
  ];
  let candidates = variants;
  let kindLabel = '';
  if (kinds.length > 0) {
    const requestedKind = rawInput.kind;
    candidates = variants.filter(
      (variant) => literalConst(variant.properties?.kind) === requestedKind,
    );
    if (candidates.length === 0) {
      // `query { text, limit }` without kind meant a text search. A query for
      // kind "url" or "title" asks for what every query result already carries.
      const kindHint =
        action !== 'query'
          ? ''
          : typeof rawInput.selector === 'string'
            ? ' To read one element by CSS selector use kind "dom" (sanitized HTML) or kind "text" (visible text) with input.selector.'
            : typeof rawInput.text === 'string'
              ? ' To locate an element by its visible text use kind "semantic" with input.text.'
              : requestedKind === 'url' || requestedKind === 'title'
                ? ' Every query result already has the current page address and title in its url and title fields.'
                : '';
      return `${base}: kind ${JSON.stringify(requestedKind ?? null)} is not supported. Supported kinds: ${kinds.join(', ')}.${kindHint}`;
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
  if (
    (kind === 'dom' || kind === 'text') &&
    names.has('limit') &&
    rawInput.all !== true &&
    !names.has('text')
  ) {
    return ' kind "dom"/"text" reads the first element matching input.selector; bound the output with maxChars and continue it with offset, add all: true to page every match (limit/offset count matches), or use kind "semantic" (which accepts limit) to list several matches.';
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
      // String kinds plus boolean flags such as query `all: true`.
      const constValue = isRecord(property) ? property.const : undefined;
      if (typeof constValue !== 'string' && typeof constValue !== 'boolean') continue;
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
  const hasSelector = hasNonEmptyString(target.selector);
  // The executor acts on the ref and ignores the selector, so a pair that
  // names two different elements would silently act on the wrong one.
  if (hasRef && hasSelector) {
    return `Browser ${action} ${label} must use either a ref or a selector, not both: they may name different elements. Keep the one for the element you mean.`;
  }
  const hasElementTarget = hasRef || hasSelector;
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

export function hasNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
