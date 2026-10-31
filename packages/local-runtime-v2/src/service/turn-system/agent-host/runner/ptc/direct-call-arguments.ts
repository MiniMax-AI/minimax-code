import { validateToolArguments } from '@earendil-works/pi-ai';
import type { RuntimeTool } from '@mavis/agent-core/tools';
import { readPtcMavisChildTarget } from '@mavis/agent-tools';

/**
 * Argument repair for a run_code child the model calls directly on a PTC Turn.
 *
 * The model gateway types a tool call's JSON from the tool schemas declared
 * in the request. A run_code child is not declared there, so a direct call of
 * one arrives with numbers and booleans as strings and arrays as
 * `{"item": [...]}` (`{"item": {...}}` for a single element). Before the
 * normal schema validation, a value that does not have the type its own
 * subschema requires is repaired when that type is unambiguous; a value that
 * already has an allowed type is never changed. Catalog tools, run_code
 * children and PTC-off Turns do not use this.
 */
type DirectCallArgumentFix = 'item_wrapper' | 'number_string' | 'boolean_string';

const FIX_ORDER: readonly DirectCallArgumentFix[] = [
  'item_wrapper',
  'number_string',
  'boolean_string',
];
const DECIMAL = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u;

interface SchemaOption {
  readonly type: string;
  readonly schema: Readonly<Record<string, unknown>>;
}

interface NormalizedDirectCallArguments {
  readonly value: unknown;
  readonly fixes: readonly DirectCallArgumentFix[];
}

/**
 * Repairs `value` against `schema`; returns the same object when nothing needed a repair.
 * @internal Exported for focused tests.
 */
export function normalizeDirectCallArguments(
  value: unknown,
  schema: unknown,
): NormalizedDirectCallArguments {
  const fixes = new Set<DirectCallArgumentFix>();
  const normalized = normalizeValue(value, schema, fixes);
  return { value: normalized, fixes: FIX_ORDER.filter((fix) => fixes.has(fix)) };
}

export interface PreparedDirectCallArguments extends NormalizedDirectCallArguments {
  readonly valid: boolean;
  /** Validation error plus the run_code line; absent when valid or when preparation threw. */
  readonly error?: string;
}

/**
 * The tool's own argument preparation, then the repair, then the schema
 * validation Pi runs next. Throws only what the tool's own preparation throws.
 *
 * A mavis_* tool is refused here even with valid arguments. It stands for a
 * mavis command, and only run_code runs it as that mavis call; run as itself,
 * the permission gate and Plugin hooks would see `mavis_<command>` instead of
 * `mavis`, and rules written for mavis would not apply. The model gets the
 * run_code line, as for any call whose arguments stay invalid, and the
 * command was refused at the top level before it had a tool of its own.
 */
export function prepareDirectCallArguments(
  tool: RuntimeTool,
  args: unknown,
): PreparedDirectCallArguments {
  const prepared = tool.def.prepareArguments ? tool.def.prepareArguments(args) : args;
  const normalized = normalizeDirectCallArguments(prepared, tool.def.schema);
  const runCodeOnly = readPtcMavisChildTarget(tool)
    ? `${tool.def.name} runs only inside run_code in this turn.`
    : undefined;
  try {
    validateToolArguments(
      {
        name: tool.def.name,
        description: tool.def.description,
        parameters: tool.def.schema as never,
      },
      { type: 'toolCall', id: '', name: tool.def.name, arguments: normalized.value as never },
    );
    if (runCodeOnly) {
      return {
        ...normalized,
        valid: false,
        error: `${runCodeOnly}\n${runCodeHint(tool.def.name)}`,
      };
    }
    return { ...normalized, valid: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...normalized, valid: false, error: `${message}\n${runCodeHint(tool.def.name)}` };
  }
}

/**
 * The same tool with the repair in front of Pi's validation. Pi keeps one
 * resolved tool per name for a batch, so this depends on the arguments only.
 */
export function withDirectCallArguments(tool: RuntimeTool): RuntimeTool {
  return {
    ...tool,
    def: {
      ...tool.def,
      prepareArguments: (args: unknown) => {
        const prepared = prepareDirectCallArguments(tool, args);
        if (prepared.error !== undefined) throw new Error(prepared.error);
        return prepared.value as never;
      },
    },
  };
}

/** English like the other host lines the model reads; same call forms as the v10 rejection. */
function runCodeHint(toolName: string): string {
  return toolName === 'bash'
    ? 'Call it inside run_code instead: await tools.bash({ command: ... }).'
    : `Call it inside run_code instead: await tools[${JSON.stringify(toolName)}]({ ... }).`;
}

function normalizeValue(
  value: unknown,
  schema: unknown,
  fixes: Set<DirectCallArgumentFix>,
): unknown {
  const options = schemaOptions(schema);
  if (!options || options.length === 0) return value;
  const matching = options.filter((option) => hasType(value, option.type));
  // An allowed type is never changed; descend only when one option governs the value.
  if (matching.length > 0) {
    const [only] = matching;
    return matching.length === 1 && only ? normalizeChildren(value, only, fixes) : value;
  }
  const targets = options.filter((option) => option.type !== 'null');
  const [target] = targets;
  return targets.length === 1 && target ? repair(value, target, fixes) : value;
}

/** Single-type alternatives of a schema, or undefined when they cannot be told apart safely. */
function schemaOptions(schema: unknown): readonly SchemaOption[] | undefined {
  if (!isPlainObject(schema) || 'allOf' in schema || '$ref' in schema || 'not' in schema) {
    return undefined;
  }
  return schema.anyOf !== undefined || schema.oneOf !== undefined
    ? unionOptions(schema)
    : typeOptions(schema);
}

function unionOptions(schema: Readonly<Record<string, unknown>>): SchemaOption[] | undefined {
  const union = schema.anyOf ?? schema.oneOf;
  const mixed = schema.anyOf !== undefined && schema.oneOf !== undefined;
  if (mixed || schema.type !== undefined || !Array.isArray(union)) return undefined;
  const options: SchemaOption[] = [];
  for (const branch of union) {
    const nested = schemaOptions(branch);
    if (!nested) return undefined;
    options.push(...nested);
  }
  return options;
}

function typeOptions(schema: Readonly<Record<string, unknown>>): SchemaOption[] | undefined {
  const types = schema.type;
  if (typeof types === 'string') return [{ type: types, schema }];
  if (!Array.isArray(types) || !types.every((type) => typeof type === 'string')) return undefined;
  return types.map((type: string) => ({ type, schema }));
}

function repair(value: unknown, option: SchemaOption, fixes: Set<DirectCallArgumentFix>): unknown {
  if (option.type === 'array') return repairItemWrapper(value, option, fixes);
  if (option.type === 'number' || option.type === 'integer') {
    return repairNumberString(value, option.type === 'integer', fixes);
  }
  if (option.type === 'boolean') return repairBooleanString(value, fixes);
  return value;
}

function repairItemWrapper(
  value: unknown,
  option: SchemaOption,
  fixes: Set<DirectCallArgumentFix>,
): unknown {
  if (!isPlainObject(value) || Object.keys(value).length !== 1 || !('item' in value)) return value;
  fixes.add('item_wrapper');
  return normalizeChildren(Array.isArray(value.item) ? value.item : [value.item], option, fixes);
}

function repairNumberString(
  value: unknown,
  integer: boolean,
  fixes: Set<DirectCallArgumentFix>,
): unknown {
  if (typeof value !== 'string' || !DECIMAL.test(value)) return value;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (integer && !Number.isInteger(parsed))) return value;
  fixes.add('number_string');
  return parsed;
}

function repairBooleanString(value: unknown, fixes: Set<DirectCallArgumentFix>): unknown {
  if (value !== 'true' && value !== 'false') return value;
  fixes.add('boolean_string');
  return value === 'true';
}

/** Repairs object properties and array items; copies a container only when a child changed. */
function normalizeChildren(
  value: unknown,
  option: SchemaOption,
  fixes: Set<DirectCallArgumentFix>,
): unknown {
  if (option.type === 'object') return normalizeProperties(value, option.schema.properties, fixes);
  if (option.type === 'array') return normalizeItems(value, option.schema.items, fixes);
  return value;
}

function normalizeProperties(
  value: unknown,
  properties: unknown,
  fixes: Set<DirectCallArgumentFix>,
): unknown {
  if (!isPlainObject(value) || !isPlainObject(properties)) return value;
  let next: Record<string, unknown> | undefined;
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const current = value[key];
    const normalized = normalizeValue(current, propertySchema, fixes);
    if (normalized === current) continue;
    next ??= { ...value };
    next[key] = normalized;
  }
  return next ?? value;
}

/** Only one item schema for every element; tuple forms are left alone. */
function normalizeItems(
  value: unknown,
  items: unknown,
  fixes: Set<DirectCallArgumentFix>,
): unknown {
  if (!Array.isArray(value) || !isPlainObject(items)) return value;
  let next: unknown[] | undefined;
  value.forEach((item, index) => {
    const normalized = normalizeValue(item, items, fixes);
    if (normalized === item) return;
    next ??= [...value];
    next[index] = normalized;
  });
  return next ?? value;
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
      return typeof value === 'string';
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
