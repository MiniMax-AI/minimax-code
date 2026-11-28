import { Kind, type TSchema } from '@sinclair/typebox';
import { Value, ValueErrorType } from '@sinclair/typebox/value';
import { Compile, type Validator } from 'typebox/compile';
import type { TLocalizedValidationError } from 'typebox/error';
import * as Schema from 'typebox/schema';

import type { RuntimeTool } from './types.js';

export type RuntimeToolInputValidation =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason: 'invalid' | 'unsupported';
      readonly issues: readonly string[];
      /**
       * Per-issue JSON pointer to the offending value (same order as `issues`),
       * present for `invalid` results. `undefined` when no received value is at
       * fault (an unexpected key, or missing required properties).
       */
      readonly paths?: readonly (string | undefined)[];
    };

export interface RuntimeToolInputRepair {
  /** Repaired copy, or the original reference when nothing was repaired. */
  readonly value: unknown;
  /** Validation of `value` against the schema. */
  readonly validation: RuntimeToolInputValidation;
}

const validators = new WeakMap<object, Validator>();
const JSON_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const KEYWORD_GUARDS: Readonly<Record<string, (schema: Schema.XSchemaObject) => boolean>> = {
  type: Schema.IsType,
  required: Schema.IsRequired,
  $ref: Schema.IsRef,
  $defs: Schema.IsDefs,
  $id: Schema.IsId,
  $anchor: Schema.IsAnchor,
  $dynamicRef: Schema.IsDynamicRef,
  $dynamicAnchor: Schema.IsDynamicAnchor,
  $recursiveRef: Schema.IsRecursiveRef,
  $recursiveAnchor: Schema.IsRecursiveAnchor,
  properties: Schema.IsProperties,
  patternProperties: Schema.IsPatternProperties,
  additionalProperties: Schema.IsAdditionalProperties,
  propertyNames: Schema.IsPropertyNames,
  dependencies: Schema.IsDependencies,
  dependentRequired: Schema.IsDependentRequired,
  dependentSchemas: Schema.IsDependentSchemas,
  additionalItems: Schema.IsAdditionalItems,
  items: Schema.IsItems,
  prefixItems: Schema.IsPrefixItems,
  contains: Schema.IsContains,
  allOf: Schema.IsAllOf,
  anyOf: Schema.IsAnyOf,
  oneOf: Schema.IsOneOf,
  not: Schema.IsNot,
  if: Schema.IsIf,
  then: Schema.IsThen,
  else: Schema.IsElse,
  unevaluatedItems: Schema.IsUnevaluatedItems,
  unevaluatedProperties: Schema.IsUnevaluatedProperties,
  enum: Schema.IsEnum,
  const: Schema.IsConst,
  minimum: Schema.IsMinimum,
  maximum: Schema.IsMaximum,
  exclusiveMinimum: Schema.IsExclusiveMinimum,
  exclusiveMaximum: Schema.IsExclusiveMaximum,
  multipleOf: Schema.IsMultipleOf,
  minLength: Schema.IsMinLength,
  maxLength: Schema.IsMaxLength,
  minItems: Schema.IsMinItems,
  maxItems: Schema.IsMaxItems,
  minContains: Schema.IsMinContains,
  maxContains: Schema.IsMaxContains,
  minProperties: Schema.IsMinProperties,
  maxProperties: Schema.IsMaxProperties,
  uniqueItems: Schema.IsUniqueItems,
  pattern: Schema.IsPattern,
  format: Schema.IsFormat,
};
const SCHEMA_MAPS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);
const SCHEMA_ARRAYS = new Set(['allOf', 'anyOf', 'oneOf', 'prefixItems']);
const SCHEMA_VALUES = new Set([
  'additionalProperties',
  'propertyNames',
  'additionalItems',
  'items',
  'contains',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedItems',
  'unevaluatedProperties',
]);

/** Checks the exact execution value; validation never coerces values or applies defaults. */
export function validateRuntimeToolInput(
  schema: unknown,
  value: unknown,
): RuntimeToolInputValidation {
  const verdict = checkRuntimeToolInput(schema, value);
  if (verdict === 'valid') return { valid: true };
  if (verdict === 'unsupported') return unsupported();
  try {
    if (issueListingTooCostly(schema, value)) {
      return {
        valid: false,
        reason: 'invalid',
        issues: [': issues are not listed for recursive or very large schemas or values'],
        paths: [undefined],
      };
    }
    if (Schema.IsSchemaObject(schema) && Kind in schema) {
      const errors = [...Value.Errors(schema as TSchema, value)].slice(0, 8);
      return {
        valid: false,
        reason: 'invalid',
        issues: errors.map((issue) => `${issue.path}: ${issue.message}`),
        paths: errors.map((issue) =>
          issue.type === ValueErrorType.ObjectAdditionalProperties ||
          issue.type === ValueErrorType.ObjectRequiredProperty
            ? undefined
            : issue.path,
        ),
      };
    }
    const validator = compiledValidator(schema);
    if (!validator) return unsupported();
    const errors = validator.Errors(value).slice(0, 8);
    return {
      valid: false,
      reason: 'invalid',
      issues: errors.map((issue) => `${issuePath(issue)}: ${issue.message}`),
      paths: errors.map(issueValuePath),
    };
  } catch {
    return unsupported();
  }
}

/**
 * Enumerating issues explores every failed branch, which on recursive or
 * heavily overlapping schemas grows exponentially while the plain check stays
 * linear. Issues are listed only when the schema tree, with every reference
 * expanded in place, is finite and has at most this many nodes. Real MCP tool
 * schemas are never recursive and stay far below it (largest seen: 50).
 */
const MAX_LISTABLE_SCHEMA_NODES = 1_000;
/**
 * Bounds the enumeration work: value nodes times expanded schema nodes, with
 * `contains` subtrees weighted by {@link CONTAINS_WORK_FACTOR} per nesting
 * level because the issue walk re-applies them per item for `contains`,
 * `minContains` and `maxContains`. Each application of a non-pointer `$ref`
 * also costs one walk of the whole raw schema (see {@link chargeReferenceWalks}).
 */
const MAX_ISSUE_LISTING_WORK = 200_000;
const CONTAINS_WORK_FACTOR = 3;
/**
 * Listing `uniqueItems` issues hashes every item but copies the list of
 * duplicate indexes once per duplicate, which is quadratic, so it is skipped
 * when any array in the value is longer than this.
 */
const MAX_UNIQUE_ITEMS_LISTED = 256;
/** Subschema maps keyed by property name or pattern; the keys are never keywords. */
const APPLIED_SCHEMA_MAPS = ['properties', 'patternProperties', 'dependentSchemas'] as const;
export interface ExpandedSchemaCost {
  readonly size: number;
  /** Issue-listing work per value node: `size` plus the raw-schema walks of `$ref` resolution. */
  readonly work: number;
  readonly uniqueItems: boolean;
}
const expandedSchemaCosts = new WeakMap<object, ExpandedSchemaCost>();

function issueListingTooCostly(schema: unknown, value: unknown): boolean {
  // Boolean schemas report one issue at the root.
  if (schema === null || typeof schema !== 'object') return false;
  let cost = expandedSchemaCosts.get(schema);
  if (cost === undefined) {
    cost = expandedSchemaCost(schema);
    expandedSchemaCosts.set(schema, cost);
  }
  if (cost.size > MAX_LISTABLE_SCHEMA_NODES) return true;
  return valueTooLarge(
    value,
    Math.floor(MAX_ISSUE_LISTING_WORK / cost.work),
    cost.uniqueItems ? MAX_UNIQUE_ITEMS_LISTED : Infinity,
  );
}

/**
 * Weighted nodes of the schema tree with every `$ref` expanded in place,
 * counted when queued so at most one past {@link MAX_LISTABLE_SCHEMA_NODES}
 * nodes are ever pending. A reference cycle makes the tree infinite, so it
 * always ends past the limit. References are resolved like the compiler does
 * (`#` pointers against the innermost `$id` on the path, others against the
 * root); unresolvable `$ref`s and the scope-dependent
 * `$dynamicRef`/`$recursiveRef` count as past the limit. Only applicator
 * keywords are walked: `$defs` matter only through references, and data such
 * as `default`, `examples`, `enum` or `const` is never a schema. Non-pointer
 * references also charge the raw schema size per application, and end past
 * the limit once those walks alone exceed {@link MAX_ISSUE_LISTING_WORK}.
 *
 * @internal Exported for tests.
 */
export function expandedSchemaCost(root: object): ExpandedSchemaCost {
  const pastLimit = {
    size: MAX_LISTABLE_SCHEMA_NODES + 1,
    work: MAX_LISTABLE_SCHEMA_NODES + 1,
    uniqueItems: false,
  };
  type Entry = { readonly schema: unknown; readonly base: object; readonly weight: number };
  const pending: Entry[] = [{ schema: root, base: root, weight: 1 }];
  const walks: ReferenceWalks = { applications: 0, rawNodes: undefined };
  let count = 1;
  let uniqueItems = false;
  for (let entry = pending.pop(); entry; entry = pending.pop()) {
    if (!isPlainRecord(entry.schema)) continue;
    const node = entry.schema;
    const base = typeof node.$id === 'string' ? node : entry.base;
    if (node.$dynamicRef !== undefined || node.$recursiveRef !== undefined) return pastLimit;
    if (node.uniqueItems === true) uniqueItems = true;
    let overflow = false;
    const push = (child: unknown, factor = 1) => {
      const weight = entry.weight * factor;
      count += weight;
      if (count > MAX_LISTABLE_SCHEMA_NODES) overflow = true;
      else pending.push({ schema: child, base, weight });
    };
    if (node.$ref !== undefined) {
      if (!chargeReferenceWalks(root, node.$ref, entry.weight, walks)) return pastLimit;
      const target = resolveReference(root, base, node.$ref);
      if (target === undefined) return pastLimit;
      push(target);
    }
    forEachAppliedSchema(node, push);
    if (overflow) return pastLimit;
  }
  return { size: count, work: count + walks.applications * (walks.rawNodes ?? 0), uniqueItems };
}

interface ReferenceWalks {
  /** Weighted applications of non-pointer references. */
  applications: number;
  /** JSON nodes of the root schema, counted on the first non-pointer reference. */
  rawNodes: number | undefined;
}

/**
 * TypeBox resolves `#` and `#/` pointers at the starting schema; any other
 * reference (an `$anchor` or `$id`) walks every node of the root schema,
 * `$defs` and data such as `enum` included, on each application. Charges one
 * such walk per weighted application; false once the walks exceed the work bound.
 */
function chargeReferenceWalks(
  root: object,
  reference: unknown,
  weight: number,
  walks: ReferenceWalks,
): boolean {
  if (typeof reference === 'string' && (reference === '#' || reference.startsWith('#/'))) {
    return true;
  }
  walks.applications += weight;
  walks.rawNodes ??= jsonNodeCount(root, MAX_ISSUE_LISTING_WORK);
  return walks.applications * walks.rawNodes <= MAX_ISSUE_LISTING_WORK;
}

/** Nodes of a JSON value, counting stopped one past `limit`. */
function jsonNodeCount(value: unknown, limit: number): number {
  const pending: unknown[] = [value];
  let count = 0;
  while (pending.length > 0 && count <= limit) {
    const current = pending.pop();
    count += 1;
    if (current === null || typeof current !== 'object') continue;
    for (const child of Object.values(current)) pending.push(child);
  }
  return count;
}

function forEachAppliedSchema(
  node: Record<string, unknown>,
  push: (child: unknown, factor?: number) => void,
): void {
  for (const keyword of APPLIED_SCHEMA_MAPS) {
    const map = node[keyword];
    if (isPlainRecord(map)) for (const child of Object.values(map)) push(child);
  }
  if (isPlainRecord(node.dependencies)) {
    // Array-valued entries list required properties, not schemas.
    for (const child of Object.values(node.dependencies)) if (!Array.isArray(child)) push(child);
  }
  for (const keyword of SCHEMA_ARRAYS) {
    const branches = node[keyword];
    if (Array.isArray(branches)) for (const child of branches) push(child);
  }
  for (const keyword of SCHEMA_VALUES) {
    const child = node[keyword];
    if (child === undefined) continue;
    // Draft-07 tuple `items`; other keywords hold a single schema.
    if (!Array.isArray(child)) push(child, keyword === 'contains' ? CONTAINS_WORK_FACTOR : 1);
    else if (keyword === 'items') for (const item of child) push(item);
  }
}

function resolveReference(root: object, base: object, reference: unknown): unknown {
  if (typeof reference !== 'string') return undefined;
  try {
    const target: unknown = Schema.Resolve.Ref(
      (reference.startsWith('#') ? base : root) as Schema.XSchemaObject,
      reference,
    );
    return target ?? undefined;
  } catch {
    return undefined;
  }
}

function valueTooLarge(value: unknown, nodeLimit: number, arrayLengthLimit: number): boolean {
  const pending: unknown[] = [value];
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    count += 1;
    if (count > nodeLimit) return true;
    if (current === null || typeof current !== 'object') continue;
    if (Array.isArray(current) && current.length > arrayLengthLimit) return true;
    for (const child of Object.values(current)) pending.push(child);
  }
  return false;
}

type InputVerdict = 'valid' | 'invalid' | 'unsupported';

/**
 * Same verdict as {@link validateRuntimeToolInput} without enumerating issues,
 * which can be exponential for recursive unions.
 */
function checkRuntimeToolInput(schema: unknown, value: unknown): InputVerdict {
  try {
    if (Schema.IsSchemaObject(schema) && Kind in schema) {
      return Value.Check(schema as TSchema, value) ? 'valid' : 'invalid';
    }
    const validator = compiledValidator(schema);
    if (!validator) return 'unsupported';
    return validator.Check(value) ? 'valid' : 'invalid';
  } catch {
    return 'unsupported';
  }
}

/** Cached compiled validator for a plain JSON Schema; undefined when unsupported. */
function compiledValidator(schema: unknown): Validator | undefined {
  if (!Schema.IsSchema(schema)) return undefined;
  let validator = typeof schema === 'object' ? validators.get(schema) : undefined;
  if (!validator) {
    // The compiler ignores malformed keywords. Validate their shapes before compiling.
    if (!isCompilableSchema(schema)) return undefined;
    validator = Compile(schema);
    if (typeof schema === 'object') validators.set(schema, validator);
  }
  return validator;
}

/** Points property-set issues at the single property involved, when there is one. */
function issuePath(issue: TLocalizedValidationError): string {
  const properties =
    issue.keyword === 'required'
      ? issue.params.requiredProperties
      : issue.keyword === 'additionalProperties'
        ? issue.params.additionalProperties
        : [];
  if (properties.length !== 1) return issue.instancePath;
  return `${issue.instancePath}/${properties[0]!.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

/** The value at fault; none for unexpected keys (the key is wrong) or missing ones. */
function issueValuePath(issue: TLocalizedValidationError): string | undefined {
  if (issue.keyword === 'additionalProperties' || issue.keyword === 'required') return undefined;
  return issuePath(issue);
}

/**
 * Undoes lossless transport artifacts of free-form nested payloads (an XML ->
 * JSON tool-call conversion without type information) by walking the value
 * together with its schema. The input is never mutated. Only values whose JSON
 * type the schema rejects at that location are touched:
 * - array expected (object not allowed): `{"item": X}` -> X when X is an array,
 *   else [X]; a string holding a JSON array -> that array;
 * - object expected (string not allowed): a string holding a JSON object;
 *   embedded JSON text is used only when all its number literals are exact
 *   by the rule below;
 * - integer/number expected (string not allowed): a JSON number literal of at
 *   most 400 chars that the parsed double prints back as, so the value sent on
 *   is the number the caller wrote ("25.7840" -> 25.784, "1e3" -> 1000,
 *   "25.771371841430664" -> 25.771371841430664, a coordinate copied from an
 *   earlier result); integer fields also need a safe integer ("2.0" -> 2,
 *   "2.5" stays a string). Leading and trailing whitespace is trimmed first;
 *   literals the double cannot reproduce ("12345678901234567890"), inner
 *   whitespace, "+", hex, "Infinity" and "NaN" stay rejected;
 * - boolean expected (string not allowed): exactly "true" or "false". These two
 *   literals are the JSON spelling of the value, so mapping them is lossless and
 *   cannot flip a side-effecting switch; any other spelling ("True", "yes",
 *   "1") stays rejected so the caller must state it explicitly.
 * `$ref` (into the root schema), `allOf`, `anyOf`/`oneOf`, `properties`,
 * `patternProperties`, schema-valued `additionalProperties`, `items`,
 * `prefixItems` and tuple `items` are followed.
 *
 * A union keeps the value when a branch accepts it. Otherwise it takes the
 * most lossless repair some branch accepts, so a string the caller spelled
 * out stays a string whenever a branch takes it: the union value's own JSON
 * text parsed as written, else JSON text and `{"item": X}` wrappers undone
 * throughout, else scalar literals mapped too. At the last two levels the
 * first repair a branch accepts is used only when no later branch rejects it
 * yet accepts a repair of its own; such a disagreement leaves the union value
 * unchanged. A `oneOf` repair must satisfy exactly one branch. When a union
 * preferred a lossless repair or gave up and its location (the root, an item
 * or a property) is left invalid by a sibling keyword, an enclosing `allOf` or
 * `oneOf`, the location is repaired again with every union candidate also
 * required to satisfy the whole location schema.
 * Repair work is bounded and memoized per call (equal JSON text is parsed
 * once); past the budget the value is returned unrepaired.
 *
 * The result carries the validation of the returned value so callers report
 * only the issues that remain after repair. Execution must use the repaired
 * value only when that validation is valid.
 */
export function repairRuntimeToolInput(schema: unknown, value: unknown): RuntimeToolInputRepair {
  // Issues are enumerated once, for the returned value only: enumeration can be
  // exponential on recursive unions while the check itself is linear.
  const verdict = checkRuntimeToolInput(schema, value);
  if (verdict === 'valid') return { value, validation: { valid: true } };
  if (verdict === 'unsupported' || !Schema.IsSchemaObject(schema)) {
    return { value, validation: validateRuntimeToolInput(schema, value) };
  }
  let repaired: unknown;
  try {
    // TypeBox schemas are projected to plain JSON Schema so `$ref` pointers and
    // branch validation see the same keywords as plain MCP schemas.
    const root = plainJsonSchema(schema);
    if (Schema.IsSchemaObject(root)) {
      const context: RepairContext = {
        root,
        work: 0,
        contested: false,
        repaired: { structure: new WeakMap(), full: new WeakMap() },
        locatedRepairs: new WeakMap(),
        located: new WeakMap(),
        verdicts: new WeakMap(),
        texts: new Map(),
        artifacts: new WeakMap(),
        refs: new Map(),
        keyConstraints: new WeakMap(),
        patterns: new Map(),
        itemOwners: new WeakMap(),
      };
      repaired = repairLocation(context, root, value, 0, 'full');
      // Equal JSON texts parse to one shared object; a copy gives every place of
      // the arguments its own, so a tool that edits its input cannot alias them.
      if (repaired !== value && context.texts.size > 0) repaired = copyJsonTree(repaired);
    } else {
      repaired = value;
    }
  } catch {
    // Includes an exhausted work budget: report the original value instead.
    repaired = value;
  }
  return { value: repaired, validation: validateRuntimeToolInput(schema, repaired) };
}

const MAX_REPAIR_DEPTH = 128;
/**
 * Work a single repair may spend: each fresh container or combinator repair,
 * fresh branch validation, and {@link JSON_TEXT_CHARS_PER_WORK} chars of
 * fresh JSON text count one; memo hits are free. Twice the single-pass budget:
 * a union also checks its agreed repair against every later branch, so the
 * inputs a first-accepted-branch repair could afford still fit.
 */
const MAX_REPAIR_WORK = 200_000;
const JSON_TEXT_CHARS_PER_WORK = 1024;
const MAX_REPAIR_JSON_TEXT_LENGTH = 256 * 1024;
const JSON_TEXT_START = /^\s*[[{]/;

/** `structure` undoes only JSON text and `{"item": X}` wrappers; `full` also maps scalar literals. */
type RepairPass = 'structure' | 'full';
/** Per-call memo keyed by (schema node, value). */
type Memo<T> = WeakMap<object, Map<unknown, T>>;
interface RepairEntry {
  readonly value: unknown;
  /** A union at the same location preferred a lossless repair or gave up. */
  readonly contested: boolean;
}
type PassMemos = Readonly<Record<RepairPass, Memo<RepairEntry>>>;
/** A key a branch requires (no allowed set) or whose string value it constrains. */
type KeyConstraint = readonly [key: string, allowed: ReadonlySet<string> | undefined];

interface RepairContext {
  readonly root: Schema.XSchemaObject;
  work: number;
  /** Whether a union at the current location preferred a lossless repair or gave up. */
  contested: boolean;
  /** Repairs per pass; recursive unions stay linear. */
  readonly repaired: PassMemos;
  /** Repairs per pass whose union candidates must also satisfy the keyed location schema. */
  readonly locatedRepairs: WeakMap<object, PassMemos>;
  /** Final repairs of a contested location, fallback included (see {@link repairLocation}). */
  readonly located: Memo<unknown>;
  readonly verdicts: Memo<InputVerdict>;
  /** Parsed JSON text by source: equal text yields one object, so the memos recognize it. */
  readonly texts: Map<string, unknown>;
  /** Whether a value holds JSON text or `{"item": X}`, the only things `structure` changes. */
  readonly artifacts: WeakMap<object, boolean>;
  /** `$ref` targets by pointer; resolving one parses a URL. */
  readonly refs: Map<string, unknown>;
  /** Per union branch (see {@link excludesRepairs}). */
  readonly keyConstraints: WeakMap<object, readonly KeyConstraint[]>;
  readonly patterns: Map<string, RegExp | undefined>;
  /** Whether a union's branches declare `item` (independent of the value). */
  readonly itemOwners: WeakMap<readonly unknown[], boolean>;
}

function spendRepairWork(context: RepairContext, amount = 1): void {
  context.work += amount;
  if (context.work > MAX_REPAIR_WORK) throw new Error('Repair work budget exhausted.');
}

/**
 * Runs `compute` once per (schema, value). A re-entry while it runs, a
 * `$ref`/`allOf` cycle at one location, gets `reentry`.
 */
function memoized<T>(
  cache: Memo<T>,
  schema: object,
  value: unknown,
  reentry: T,
  compute: () => T,
): T {
  let byValue = cache.get(schema);
  if (!byValue) {
    byValue = new Map();
    cache.set(schema, byValue);
  }
  if (byValue.has(value)) return byValue.get(value) as T;
  byValue.set(value, reentry);
  const result = compute();
  byValue.set(value, result);
  return result;
}

/**
 * Repairs the value at one location of the input (the root, an item or a
 * property). Unions there prefer their most lossless repair; when one did so
 * (or gave up on disagreeing branches) and the location is left invalid, it
 * is repaired again with union candidates checked against the whole location
 * schema too, and that result is kept if valid.
 */
function repairLocation(
  context: RepairContext,
  schema: unknown,
  value: unknown,
  depth: number,
  pass: RepairPass,
): unknown {
  // Each location answers for its own unions only.
  const outer = context.contested;
  context.contested = false;
  let repaired = repairNode(context, schema, value, depth, pass, undefined);
  if (context.contested && pass === 'full') {
    const location = schema as object;
    const preferred = repaired;
    repaired = memoized(context.located, location, value, preferred, () => {
      if (branchVerdict(context, location, preferred) !== 'invalid') return preferred;
      const fallback = repairNode(context, location, value, depth, pass, location);
      return fallback !== preferred && branchVerdict(context, location, fallback) === 'valid'
        ? fallback
        : preferred;
    });
  }
  context.contested = outer;
  return repaired;
}

function repairNode(
  context: RepairContext,
  schema: unknown,
  value: unknown,
  depth: number,
  pass: RepairPass,
  location: object | undefined,
): unknown {
  // Every schema hop and value level counts, so `$ref`/`allOf` cycles terminate.
  if (depth > MAX_REPAIR_DEPTH || !Schema.IsSchemaObject(schema)) return value;
  if (pass === 'structure' && !hasArtifacts(context, value, MAX_REPAIR_DEPTH - depth)) {
    return value;
  }
  let memos = context.repaired;
  if (location !== undefined) {
    memos = context.locatedRepairs.get(location) ?? {
      structure: new WeakMap(),
      full: new WeakMap(),
    };
    context.locatedRepairs.set(location, memos);
  }
  const outer = context.contested;
  context.contested = false;
  const node = schema as Record<string, unknown>;
  if (
    (value === null || typeof value !== 'object') &&
    node.$ref === undefined &&
    node.allOf === undefined &&
    node.anyOf === undefined &&
    node.oneOf === undefined
  ) {
    // A scalar at a plain node is O(1) to repair and cannot recurse: memoizing
    // it would only grow with every distinct scalar the input holds.
    const repaired = repairSchemaNode(context, node, value, depth, pass, location);
    context.contested = outer || context.contested;
    return repaired;
  }
  const entry = memoized(memos[pass], schema, value, { value, contested: false }, () => ({
    value: repairSchemaNode(
      context,
      schema as Record<string, unknown>,
      value,
      depth,
      pass,
      location,
    ),
    contested: context.contested,
  }));
  context.contested = outer || entry.contested;
  return entry.value;
}

function repairSchemaNode(
  context: RepairContext,
  node: Record<string, unknown>,
  value: unknown,
  depth: number,
  pass: RepairPass,
  location: object | undefined,
): unknown {
  // Containers and combinators are what recursive schemas multiply; plain
  // scalar leaves cost O(1) and are bounded by the input.
  if (
    (value !== null && typeof value === 'object') ||
    node.$ref !== undefined ||
    node.allOf !== undefined ||
    node.anyOf !== undefined ||
    node.oneOf !== undefined
  ) {
    spendRepairWork(context);
  }
  let current = value;
  if (typeof node.$ref === 'string') {
    const target = resolveRef(context, node.$ref);
    if (target !== undefined) {
      current = repairNode(context, target, current, depth + 1, pass, location);
    }
  }
  if (Array.isArray(node.allOf)) {
    for (const branch of node.allOf) {
      current = repairNode(context, branch, current, depth + 1, pass, location);
    }
  }
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches = node[keyword];
    if (Array.isArray(branches)) {
      const union = { branches, exclusive: keyword === 'oneOf', location };
      current = repairBranches(context, union, current, depth + 1, pass);
    }
  }
  current = repairShape(context, node.type, current, pass);
  if (Array.isArray(current)) return repairItems(context, node, current, depth + 1, pass);
  if (isPlainRecord(current)) return repairProperties(context, node, current, depth + 1, pass);
  return current;
}

function resolveRef(context: RepairContext, ref: string): unknown {
  if (!context.refs.has(ref)) context.refs.set(ref, Schema.Resolve.Ref(context.root, ref));
  return context.refs.get(ref);
}

function repairItems(
  context: RepairContext,
  node: Record<string, unknown>,
  array: readonly unknown[],
  depth: number,
  pass: RepairPass,
): readonly unknown[] {
  // 2020-12 `prefixItems` + `items`, or draft-07 tuple `items` + `additionalItems`.
  const prefix = Array.isArray(node.prefixItems)
    ? node.prefixItems
    : Array.isArray(node.items)
      ? node.items
      : [];
  const rest = Array.isArray(node.items) ? node.additionalItems : node.items;
  let copy: unknown[] | undefined;
  for (let index = 0; index < array.length; index += 1) {
    const itemSchema: unknown = index < prefix.length ? prefix[index] : rest;
    const item = array[index];
    const repaired = repairLocation(context, itemSchema, item, depth, pass);
    if (repaired === item) continue;
    copy ??= [...array];
    copy[index] = repaired;
  }
  return copy ?? array;
}

function repairProperties(
  context: RepairContext,
  node: Record<string, unknown>,
  record: Record<string, unknown>,
  depth: number,
  pass: RepairPass,
): Record<string, unknown> {
  const properties = isPlainRecord(node.properties) ? node.properties : undefined;
  const patterns = isPlainRecord(node.patternProperties)
    ? Object.entries(node.patternProperties)
    : [];
  const additional = node.additionalProperties;
  let copy: Record<string, unknown> | undefined;
  for (const [key, child] of Object.entries(record)) {
    const schemas: unknown[] = [];
    const declared = properties !== undefined && Object.hasOwn(properties, key);
    if (declared) schemas.push(properties[key]);
    let matchedPattern = false;
    let unknownPattern = false;
    for (const [pattern, patternSchema] of patterns) {
      const regex = patternRegex(context, pattern);
      if (!regex) unknownPattern = true;
      else if (regex.test(key)) {
        matchedPattern = true;
        schemas.push(patternSchema);
      }
    }
    // A pattern we cannot evaluate might own this key; leave it untouched.
    if (unknownPattern) continue;
    if (!declared && !matchedPattern) schemas.push(additional);
    let repaired = child;
    for (const childSchema of schemas) {
      repaired = repairLocation(context, childSchema, repaired, depth, pass);
    }
    if (repaired === child) continue;
    copy ??= { ...record };
    // defineProperty keeps a literal "__proto__" key an own data property.
    Object.defineProperty(copy, key, {
      value: repaired,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return copy ?? record;
}

function patternRegex(context: RepairContext, pattern: string): RegExp | undefined {
  if (!context.patterns.has(pattern)) {
    let regex: RegExp | undefined;
    try {
      regex = new RegExp(pattern, 'u');
    } catch {
      regex = undefined;
    }
    context.patterns.set(pattern, regex);
  }
  return context.patterns.get(pattern);
}

interface Union {
  readonly branches: readonly unknown[];
  /** `oneOf`: a repair must satisfy exactly one branch. */
  readonly exclusive: boolean;
  /** Location schema a repair must also satisfy, in the fallback of {@link repairLocation}. */
  readonly location: object | undefined;
}

const NO_REPAIR = Symbol('no repair');

function repairBranches(
  context: RepairContext,
  union: Union,
  value: unknown,
  depth: number,
  pass: RepairPass,
): unknown {
  for (const branch of union.branches) {
    // Already accepted, or not decidable: keep the value as sent.
    const verdict = branchVerdict(context, branch, value);
    if (verdict === 'unsupported') return value;
    if (verdict === 'valid' && satisfiesLocation(context, union, value)) return value;
  }
  const literal =
    typeof value === 'string' && JSON_TEXT_START.test(value)
      ? parseJsonText(context, value.trim())
      : undefined;
  if (
    literal !== undefined &&
    union.branches.some((branch) => unionAccepts(context, union, branch, literal))
  ) {
    context.contested = true;
    return literal;
  }
  // The value as written; JSON text is parsed but nothing in it is changed.
  const shape = literal ?? value;
  // `{item: X}` is the value itself when a sibling object branch declares `item`;
  // an array candidate can only come from unwrapping it.
  const keepsItem =
    isPlainRecord(shape) &&
    Object.keys(shape).length === 1 &&
    Object.hasOwn(shape, 'item') &&
    unionDeclaresItem(context, union.branches);
  const structural = hasArtifacts(context, value, MAX_REPAIR_DEPTH)
    ? agreedRepair(context, union, value, shape, depth, 'structure', keepsItem)
    : NO_REPAIR;
  if (structural !== NO_REPAIR) {
    context.contested = true;
    return structural;
  }
  if (pass === 'structure') return value;
  const full = agreedRepair(context, union, value, shape, depth, 'full', keepsItem);
  if (full === value) context.contested = true;
  return full === NO_REPAIR ? value : full;
}

/**
 * The first repair in `pass` the union accepts, unless a later branch rejects
 * it yet accepts a repair of its own, which therefore differs: then `value`,
 * as branches typing the same text differently would make the mapping a
 * guess. {@link NO_REPAIR} when no repair is accepted.
 */
function agreedRepair(
  context: RepairContext,
  union: Union,
  value: unknown,
  shape: unknown,
  depth: number,
  pass: RepairPass,
  keepsItem: boolean,
): unknown {
  let agreed: unknown = NO_REPAIR;
  for (const branch of union.branches) {
    if (excludesRepairs(context, branch, shape)) continue;
    // Checking the agreed repair is cheaper than repairing for this branch.
    if (agreed !== NO_REPAIR && branchVerdict(context, branch, agreed) === 'valid') continue;
    const candidate = repairNode(context, branch, value, depth, pass, union.location);
    if (candidate === value || (keepsItem && Array.isArray(candidate))) continue;
    if (!unionAccepts(context, union, branch, candidate)) continue;
    if (agreed !== NO_REPAIR) return value;
    agreed = candidate;
  }
  return agreed;
}

/**
 * A branch requiring a key `value` lacks, or other string constants at a
 * property `value` holds as a string, rejects the value and every repair of
 * it: repairs keep the keys of an object other than `{"item": X}` and turn
 * strings into other types, never into other strings. Skipping such branches
 * keeps discriminated unions as cheap as stopping at the first accepted branch.
 */
function excludesRepairs(context: RepairContext, branch: unknown, value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (Object.hasOwn(value, 'item') && Object.keys(value).length === 1) return false;
  return keyConstraints(context, branch).some(([key, allowed]) => {
    if (!Object.hasOwn(value, key)) return allowed === undefined;
    const property = value[key];
    return allowed !== undefined && typeof property === 'string' && !allowed.has(property);
  });
}

/**
 * Required keys (no allowed set) and `const`/all-string `enum` properties of
 * a branch and its `$ref` targets.
 */
function keyConstraints(context: RepairContext, branch: unknown): readonly KeyConstraint[] {
  if (!isPlainRecord(branch)) return [];
  let constraints = context.keyConstraints.get(branch);
  if (constraints === undefined) {
    const found: KeyConstraint[] = [];
    const visited = new Set<unknown>();
    for (let node: unknown = branch; isPlainRecord(node) && !visited.has(node); ) {
      visited.add(node);
      if (Array.isArray(node.required)) {
        for (const key of node.required) if (typeof key === 'string') found.push([key, undefined]);
      }
      if (isPlainRecord(node.properties)) {
        for (const [key, property] of Object.entries(node.properties)) {
          if (!isPlainRecord(property)) continue;
          const values = Object.hasOwn(property, 'const') ? [property.const] : property.enum;
          if (Array.isArray(values) && values.every((entry) => typeof entry === 'string')) {
            found.push([key, new Set(values)]);
          }
        }
      }
      node = typeof node.$ref === 'string' ? resolveRef(context, node.$ref) : undefined;
    }
    constraints = found;
    context.keyConstraints.set(branch, constraints);
  }
  return constraints;
}

function unionAccepts(
  context: RepairContext,
  union: Union,
  branch: unknown,
  candidate: unknown,
): boolean {
  return (
    branchVerdict(context, branch, candidate) === 'valid' &&
    (!union.exclusive || acceptedByOneBranch(context, union.branches, candidate)) &&
    satisfiesLocation(context, union, candidate)
  );
}

function satisfiesLocation(context: RepairContext, union: Union, value: unknown): boolean {
  return union.location === undefined || branchVerdict(context, union.location, value) === 'valid';
}

function acceptedByOneBranch(
  context: RepairContext,
  branches: readonly unknown[],
  value: unknown,
): boolean {
  let accepting = 0;
  for (const branch of branches) {
    if (branchVerdict(context, branch, value) !== 'invalid') accepting += 1;
    if (accepting > 1) return false;
  }
  return accepting === 1;
}

/**
 * Conservatively true for values nested deeper than `levels`, which repair
 * never reaches anyway; the walk stays bounded on deep values.
 */
function hasArtifacts(context: RepairContext, value: unknown, levels: number): boolean {
  if (typeof value === 'string') return JSON_TEXT_START.test(value);
  if (value === null || typeof value !== 'object') return false;
  if (levels === 0) return true;
  let found = context.artifacts.get(value);
  if (found === undefined) {
    found = isPlainRecord(value) && Object.keys(value).length === 1 && Object.hasOwn(value, 'item');
    for (const child of Object.values(value)) {
      if (found) break;
      found = hasArtifacts(context, child, levels - 1);
    }
    context.artifacts.set(value, found);
  }
  return found;
}

/** Computed once per union and call, with one `visited` set shared by all branches. */
function unionDeclaresItem(context: RepairContext, branches: readonly unknown[]): boolean {
  let owns = context.itemOwners.get(branches);
  if (owns === undefined) {
    const visited = new Set<unknown>();
    owns = branches.some((branch) => declaresItemProperty(context.root, branch, visited));
    context.itemOwners.set(branches, owns);
  }
  return owns;
}

/**
 * The branch accepts an object declaring `item`, through `$ref`s and nested
 * `allOf`/`anyOf`/`oneOf`; `visited` stops `$ref` cycles and repeated walks.
 */
function declaresItemProperty(
  root: Schema.XSchemaObject,
  branch: unknown,
  visited = new Set<unknown>(),
): boolean {
  if (!isPlainRecord(branch) || visited.has(branch)) return false;
  visited.add(branch);
  if (ownsItemProperty(branch)) return true;
  if (
    typeof branch.$ref === 'string' &&
    declaresItemProperty(root, Schema.Resolve.Ref(root, branch.$ref), visited)
  ) {
    return true;
  }
  return (['allOf', 'anyOf', 'oneOf'] as const).some((keyword) => {
    const branches = branch[keyword];
    return (
      Array.isArray(branches) &&
      branches.some((nested) => declaresItemProperty(root, nested, visited))
    );
  });
}

function ownsItemProperty(node: Record<string, unknown>): boolean {
  if (!isPlainRecord(node.properties) || !Object.hasOwn(node.properties, 'item')) return false;
  const types: unknown[] = Array.isArray(node.type) ? node.type : [node.type];
  return node.type === undefined || types.includes('object');
}

function branchVerdict(context: RepairContext, branch: unknown, value: unknown): InputVerdict {
  // Boolean schemas need no compile.
  if (!Schema.IsSchemaObject(branch)) return checkRuntimeToolInput(branch, value);
  // Spares compiling the branches of a discriminated union that do not match.
  if (excludesRepairs(context, branch, value)) return 'invalid';
  return memoized(context.verdicts, branch, value, 'unsupported', () => {
    spendRepairWork(context);
    return checkRuntimeToolInput(scopedBranch(context.root, branch), value);
  });
}

const SCOPE_ROOT = 'mavisRepairRoot';
const SCOPE_BRANCH = 'mavisRepairBranch';
const scopes = new WeakMap<
  object,
  { rebasedRoot?: unknown; readonly branches: WeakMap<object, unknown> }
>();

/**
 * Makes a union branch checkable on its own. Branches whose `$ref`s stay inside
 * `$defs`/`definitions` get the definitions they use in scope; the others stay
 * out, as a compile costs every definition it is given. Other refs (`#`,
 * `#/properties/...`, `$id` URIs) need the whole tool schema: root and branch
 * move under `$defs` with their pointers rebased, which costs a compile of the
 * root per such branch, so only those branches are wrapped.
 */
function scopedBranch(root: Schema.XSchemaObject, branch: unknown): unknown {
  if (!Schema.IsSchemaObject(branch)) return branch;
  let scope = scopes.get(root);
  if (!scope) {
    scope = { branches: new WeakMap() };
    scopes.set(root, scope);
  }
  let scoped = scope.branches.get(branch);
  if (scoped === undefined) {
    const definitions = usedDefinitions(root, branch);
    if (definitions === undefined) {
      scope.rebasedRoot ??= rebaseRefs(root);
      scoped = {
        $defs: { [SCOPE_ROOT]: scope.rebasedRoot, [SCOPE_BRANCH]: rebaseRefs(branch) },
        $ref: `#/$defs/${SCOPE_BRANCH}`,
      };
    } else {
      scoped = Object.keys(definitions).length > 0 ? { ...definitions, ...branch } : branch;
    }
    scope.branches.set(branch, scoped);
  }
  return scoped;
}

/**
 * The root `$defs`/`definitions` entries the branch uses, following their
 * targets; a whole map when an entry name cannot be read from the pointer.
 * Undefined when the branch refers outside them: a `#` inside a definition it
 * uses refers to the root, so such a branch needs the root in scope too.
 */
function usedDefinitions(
  root: Schema.XSchemaObject,
  branch: Schema.XSchemaObject,
): Record<string, Record<string, unknown>> | undefined {
  const used: Record<string, Record<string, unknown>> = {};
  const whole = new Set<string>();
  const visited = new Set<unknown>();
  const pending: unknown[] = [branch];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
    } else if (isPlainRecord(current)) {
      const ref = current.$ref;
      if (typeof ref === 'string') {
        const keyword = definitionsKeyword(ref);
        if (keyword === undefined) return undefined;
        // Unwrapped, the branch's own definitions map wins over the root's.
        const owner = Object.hasOwn(branch, keyword) ? branch : root;
        const map = (root as Record<string, unknown>)[keyword];
        if (owner === root && isPlainRecord(map) && !whole.has(keyword)) {
          const name = definitionName(ref, keyword);
          // What comes into scope is walked too: a pointer into a definition
          // brings the whole definition, whose other `$ref`s must resolve as well.
          if (name !== undefined && Object.hasOwn(map, name)) {
            (used[keyword] ??= {})[name] = map[name];
            pending.push(map[name]);
          } else {
            whole.add(keyword);
            used[keyword] = map;
            pending.push(map);
          }
        }
        pending.push(Schema.Resolve.Ref(owner, ref));
      }
      for (const child of Object.values(current)) pending.push(child);
    }
  }
  return used;
}

function definitionName(ref: string, keyword: '$defs' | 'definitions'): string | undefined {
  const segment = ref.slice(keyword.length + 3).split('/')[0]!;
  try {
    return decodeURIComponent(segment).replaceAll('~1', '/').replaceAll('~0', '~');
  } catch {
    return undefined;
  }
}

function definitionsKeyword(ref: string): '$defs' | 'definitions' | undefined {
  if (ref.startsWith('#/$defs/')) return '$defs';
  return ref.startsWith('#/definitions/') ? 'definitions' : undefined;
}

function rebaseRefs(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(rebaseRefs);
  if (!isPlainRecord(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema).map(([key, child]) => [
      key,
      key === '$ref' && typeof child === 'string' && (child === '#' || child.startsWith('#/'))
        ? `#/$defs/${SCOPE_ROOT}${child.slice(1)}`
        : rebaseRefs(child),
    ]),
  );
}

function repairShape(
  context: RepairContext,
  type: unknown,
  value: unknown,
  pass: RepairPass,
): unknown {
  const types = new Set(
    (Array.isArray(type) ? type : [type]).filter((entry) => typeof entry === 'string'),
  );
  if (types.size === 0) return value;
  if (typeof value === 'string') {
    if (types.has('string')) return value;
    const text = value.trim();
    if (types.has('array') && text.startsWith('[')) {
      const parsed = parseJsonText(context, text);
      if (Array.isArray(parsed)) return parsed;
    }
    if (types.has('object') && text.startsWith('{')) {
      const parsed = parseJsonText(context, text);
      if (isPlainRecord(parsed)) return parsed;
    }
    if (pass === 'structure') return value;
    if (types.has('integer') || types.has('number')) {
      const parsed = jsonNumberLiteral(text, types.has('number'));
      if (parsed !== undefined) return parsed;
    }
    if (types.has('boolean') && (value === 'true' || value === 'false')) return value === 'true';
    return value;
  }
  if (isPlainRecord(value) && types.has('array') && !types.has('object')) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'item') {
      return Array.isArray(value.item) ? value.item : [value.item];
    }
  }
  return value;
}

const JSON_NUMBER_LITERAL = /^-?(0|[1-9]\d*)(?:\.(\d+))?([eE][+-]?\d+)?$/;
/** Every finite normal double written out in full (at most ~330 chars) fits. */
const MAX_JSON_NUMBER_LITERAL_LENGTH = 400;

/** Significant digits and decimal exponent of a JSON number literal match; "" for zero. */
function decimalValue(match: RegExpExecArray): string {
  const integer = match[1]!;
  const fraction = match[2] ?? '';
  let digits = `${integer}${fraction}`;
  let point = integer.length + Number(match[3]?.slice(1) ?? 0);
  const leading = digits.length - digits.replace(/^0+/, '').length;
  digits = digits.slice(leading).replace(/0+$/, '');
  point -= leading;
  return digits === '' ? '' : `${match[0].startsWith('-') ? '-' : ''}${digits}e${point}`;
}

function jsonNumberLiteral(text: string, allowFraction: boolean): number | undefined {
  if (text.length > MAX_JSON_NUMBER_LITERAL_LENGTH) return undefined;
  const match = JSON_NUMBER_LITERAL.exec(text);
  if (!match) return undefined;
  const parsed = Number(text);
  // Exact when the double prints back as the written number: the value sent on
  // serializes to the caller's literal. Overflow, underflow and digits beyond
  // the double's precision all print differently.
  const printed = JSON_NUMBER_LITERAL.exec(String(parsed));
  if (!printed || decimalValue(printed) !== decimalValue(match)) return undefined;
  return allowFraction || Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Parses embedded JSON text once per call, charging its length; rejects
 * oversized text, `__proto__` keys and number literals whose double is not
 * exact by the same rule as bare number strings. The reviver sees each
 * literal's source text (Node >= 21); without it numbers cannot be verified
 * and the text is rejected.
 */
function parseJsonText(context: RepairContext, text: string): unknown {
  if (text.length > MAX_REPAIR_JSON_TEXT_LENGTH) return undefined;
  if (context.texts.has(text)) return context.texts.get(text);
  spendRepairWork(context, 1 + Math.floor(text.length / JSON_TEXT_CHARS_PER_WORK));
  const parsed = decodeJsonText(text);
  context.texts.set(text, parsed);
  return parsed;
}

function decodeJsonText(text: string): unknown {
  let rejected = false;
  const reviver = function (
    this: unknown,
    key: string,
    value: unknown,
    context?: { readonly source?: unknown },
  ): unknown {
    if (key === '__proto__' && isPlainRecord(this)) rejected = true;
    else if (typeof value === 'number') {
      const source = context?.source;
      if (typeof source !== 'string' || jsonNumberLiteral(source, true) === undefined) {
        rejected = true;
      }
    }
    return value;
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, reviver) as unknown;
  } catch {
    return undefined;
  }
  return rejected ? undefined : parsed;
}

const plainSchemas = new WeakMap<object, unknown>();

function plainJsonSchema(schema: object): unknown {
  if (!(Kind in schema)) return schema;
  let plain = plainSchemas.get(schema);
  if (plain === undefined) {
    plain = JSON.parse(JSON.stringify(schema)) as unknown;
    plainSchemas.set(schema, plain);
  }
  return plain;
}

/**
 * Deep copy of a JSON value that, unlike `structuredClone`, gives every place its
 * own object even where the source shares one. Iterative, so depth is no limit.
 */
function copyJsonTree(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const copyOf = (child: unknown, pending: [object, object][]): unknown => {
    if (child === null || typeof child !== 'object') return child;
    const copied = Array.isArray(child) ? [] : {};
    pending.push([child, copied]);
    return copied;
  };
  const pending: [object, object][] = [];
  const root = copyOf(value, pending);
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [source, target] = next;
    if (Array.isArray(source)) {
      // Index pushes keep a large array fast; JSON arrays have no holes.
      for (const child of source) (target as unknown[]).push(copyOf(child, pending));
      continue;
    }
    for (const key of Object.keys(source)) {
      // defineProperty keeps a literal "__proto__" key an own data property.
      Object.defineProperty(target, key, {
        value: copyOf((source as Record<string, unknown>)[key], pending),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return root;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Revalidates a Hook-rewritten input against the authoritative runtime tool schema. */
export function isRuntimeToolInputValid(
  tools: readonly RuntimeTool[],
  toolName: string,
  value: Readonly<Record<string, unknown>>,
): boolean {
  const tool = tools.find((candidate) => candidate.def.name === toolName);
  return Boolean(tool && checkRuntimeToolInput(tool.def.schema, value) === 'valid');
}

function unsupported(): RuntimeToolInputValidation {
  return { valid: false, reason: 'unsupported', issues: [] };
}

function isCompilableSchema(root: Schema.XSchema): boolean {
  const visited = new WeakSet<object>();
  const visit = (schema: unknown, base: Schema.XSchema): boolean => {
    if (!Schema.IsSchema(schema)) return false;
    if (typeof schema === 'boolean') return true;
    if (visited.has(schema)) return true;
    visited.add(schema);
    const resolutionBase = Schema.IsId(schema) ? schema : base;
    for (const [keyword, value] of Object.entries(schema)) {
      const guard = Object.hasOwn(KEYWORD_GUARDS, keyword) ? KEYWORD_GUARDS[keyword] : undefined;
      if (guard && !guard(schema)) return false;
      if (keyword === 'type') {
        const types = Array.isArray(value) ? value : [value];
        if (types.length === 0 || !types.every((type) => JSON_TYPES.has(type))) return false;
      } else if (SCHEMA_MAPS.has(keyword)) {
        if (
          !Schema.IsSchemaObject(value) ||
          !Object.values(value).every((child) => visit(child, resolutionBase))
        )
          return false;
      } else if (SCHEMA_ARRAYS.has(keyword) || (keyword === 'items' && Array.isArray(value))) {
        if (!Array.isArray(value) || !value.every((child) => visit(child, resolutionBase)))
          return false;
      } else if (SCHEMA_VALUES.has(keyword)) {
        if (!visit(value, resolutionBase)) return false;
      } else if (keyword === 'dependencies') {
        if (
          !Object.values(value).every(
            (child) => Array.isArray(child) || visit(child, resolutionBase),
          )
        )
          return false;
      } else if (keyword === '$ref' || keyword === '$dynamicRef' || keyword === '$recursiveRef') {
        const target = Schema.IsSchemaObject(resolutionBase)
          ? Schema.Resolve.Ref(resolutionBase, value)
          : undefined;
        const resolved =
          target ?? (Schema.IsSchemaObject(root) ? Schema.Resolve.Ref(root, value) : undefined);
        if (!Schema.IsSchema(resolved) || !visit(resolved, resolutionBase)) return false;
      }
    }
    return true;
  };
  return visit(root, root);
}
