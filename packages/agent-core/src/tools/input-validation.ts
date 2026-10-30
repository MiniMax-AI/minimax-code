import { Kind } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { validateToolArguments } from '@earendil-works/pi-ai';

import type { RuntimeTool } from './types.js';

/**
 * Applies the numeric subset of the coercion top-level Pi tool calls receive
 * (e.g. "2" -> 2 for an integer field) to a nested payload. The input is never
 * mutated and the coerced copy is returned only when it satisfies the schema,
 * so valid inputs and unrecoverable values are passed through unchanged for
 * strict validation to report.
 */
export function coerceRuntimeToolInput(schema: unknown, value: unknown): unknown {
  if (!isSchemaObject(schema) || !isPlainRecord(value)) return value;
  const typebox = Kind in schema;
  if (typebox && Value.Check(schema as never, value)) return value;
  let candidate: unknown;
  try {
    // Pi's JSON Schema coercion only converts losslessly ("2.5" stays a string for
    // an integer field). TypeBox schemas are projected to plain JSON Schema first
    // because Pi skips that path for anything carrying TypeBox metadata.
    candidate = validateToolArguments(
      nestedTool(plainJsonSchema(schema)),
      nestedToolCall(value),
    ) as unknown;
  } catch {
    return value;
  }
  if (!onlyStringifiedNumbersChanged(value, candidate)) return value;
  if (typebox) return Value.Check(schema as never, candidate) ? candidate : value;
  // Pi validates after coercing, so a plain-JSON-Schema candidate is already valid.
  return sameJson(value, candidate) ? value : candidate;
}

/**
 * Narrows Pi's bidirectional coercion to the model-side encoding slip we accept
 * for nested payloads: a JSON string carrying a canonical number ("2"). Boolean
 * strings stay rejected (side-effecting switches such as cron enabled must be
 * explicit), as does any other rewrite (number -> string, null -> 0, wrapping).
 */
function onlyStringifiedNumbersChanged(before: unknown, after: unknown): boolean {
  if (Object.is(before, after)) return true;
  if (typeof before === 'string') {
    return typeof after === 'number' && Number.isFinite(after) && String(after) === before.trim();
  }
  if (Array.isArray(before)) {
    return (
      Array.isArray(after) &&
      after.length === before.length &&
      before.every((item, index) => onlyStringifiedNumbersChanged(item, after[index]))
    );
  }
  if (isPlainRecord(before)) {
    if (!isPlainRecord(after)) return false;
    const keys = Object.keys(before);
    if (keys.length !== Object.keys(after).length) return false;
    return keys.every(
      (key) => Object.hasOwn(after, key) && onlyStringifiedNumbersChanged(before[key], after[key]),
    );
  }
  return false;
}

const plainSchemas = new WeakMap<object, unknown>();

function isSchemaObject(schema: unknown): schema is Record<string, unknown> {
  return isPlainRecord(schema);
}

function sameJson(before: unknown, after: unknown): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

function nestedTool(parameters: unknown) {
  return { name: 'nested', description: '', parameters: parameters as never };
}

function nestedToolCall(args: Record<string, unknown>) {
  return { type: 'toolCall', id: 'nested', name: 'nested', arguments: args } as never;
}

function plainJsonSchema(schema: Record<string, unknown>): unknown {
  if (!(Kind in schema)) return schema;
  let plain = plainSchemas.get(schema);
  if (plain === undefined) {
    plain = JSON.parse(JSON.stringify(schema)) as unknown;
    plainSchemas.set(schema, plain);
  }
  return plain;
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
  return Boolean(tool && Value.Check(tool.def.schema, value));
}
