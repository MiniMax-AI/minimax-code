import { validateToolArguments } from '@earendil-works/pi-ai';
import { Kind, Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import { defineRuntimeTool } from '../../../src/tools/define.js';
import {
  expandedSchemaCost,
  isRuntimeToolInputValid,
  repairRuntimeToolInput,
  validateRuntimeToolInput,
} from '../../../src/tools/input-validation.js';

const schema = {
  type: 'object',
  properties: {
    query: { type: 'string' },
    options: {
      type: 'object',
      properties: { count: { type: 'integer', minimum: 1 }, enabled: { type: 'boolean' } },
      required: ['count', 'enabled'],
      additionalProperties: false,
    },
  },
  required: ['query', 'options'],
  additionalProperties: false,
};
const valid = { query: 'search', options: { count: 2, enabled: false } };

describe('validateRuntimeToolInput', () => {
  it('accepts plain JSON Schema without coercion or mutation', () => {
    const value = structuredClone(valid);
    expect(validateRuntimeToolInput(schema, value)).toEqual({ valid: true });
    expect(value).toEqual(valid);
    expect(validateRuntimeToolInput(schema, value)).toEqual({ valid: true });
  });

  it.each([
    {},
    { ...valid, query: 2 },
    { ...valid, options: { count: '2', enabled: false } },
    { ...valid, options: { count: 2, enabled: 'false' } },
    { ...valid, options: { count: 0, enabled: false } },
    { ...valid, options: { count: 1.2, enabled: false } },
    { ...valid, extra: 'secret-value' },
  ])('rejects the actual invalid value without converting it: %j', (value) => {
    const original = structuredClone(value);
    const result = validateRuntimeToolInput(schema, value);
    expect(result).toMatchObject({ valid: false, reason: 'invalid' });
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(value).toEqual(original);
  });

  it('validates nested arrays and local references using the provider schema', () => {
    const referenced = {
      $defs: {
        item: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
      type: 'object',
      properties: { items: { type: 'array', items: { $ref: '#/$defs/item' } } },
      required: ['items'],
    };
    expect(validateRuntimeToolInput(referenced, { items: [{ name: 'ok' }] }).valid).toBe(true);
    expect(validateRuntimeToolInput(referenced, { items: [{ name: 9 }] }).valid).toBe(false);
    expect(validateRuntimeToolInput(referenced, { items: [{}] }).valid).toBe(false);
  });

  it('accepts documentation and extension metadata without treating them as subschemas', () => {
    const documented = {
      ...schema,
      title: 'Provider contract',
      description: 'Tool input',
      examples: [{ type: 'invalid' }],
      'x-provider': { type: 'invalid', required: 'metadata' },
    };
    expect(validateRuntimeToolInput(documented, valid).valid).toBe(true);
  });

  it.each([
    { anchor: { $dynamicAnchor: 'node' }, reference: { $dynamicRef: '#node' } },
    { anchor: { $recursiveAnchor: true }, reference: { $recursiveRef: '#' } },
  ])('validates resolvable recursive contracts: %j', ({ anchor, reference }) => {
    const recursive = {
      ...anchor,
      type: 'object',
      properties: { name: { type: 'string' }, child: reference },
      required: ['name'],
    };
    expect(
      validateRuntimeToolInput(recursive, { name: 'root', child: { name: 'nested' } }).valid,
    ).toBe(true);
    expect(validateRuntimeToolInput(recursive, { name: 'root', child: { name: 2 } }).valid).toBe(
      false,
    );
  });

  it.each([
    null,
    'invalid',
    { type: 'invalid' },
    { type: [] },
    { type: 'object', required: 'query' },
    { type: 'object', properties: { query: { type: 'invalid' } } },
    { type: 'object', properties: { query: 'invalid' } },
    { type: 'object', properties: { query: { type: 'string', pattern: '[' } } },
    { $ref: '#/$defs/missing' },
    { type: 'object', properties: { optional: { $ref: '#/$defs/missing' } } },
    { type: 'object', properties: { optional: { $dynamicRef: '#missing' } } },
    { type: 'object', properties: { optional: { $recursiveRef: '#missing' } } },
    { $ref: 10 },
    { type: 'object', properties: { options: { type: 'object', required: 10 } } },
  ])('fails closed for unsupported or malformed contracts: %j', (unsupported) => {
    expect(validateRuntimeToolInput(unsupported, valid)).toEqual({
      valid: false,
      reason: 'unsupported',
      issues: [],
    });
  });

  it('preserves native TypeBox validation and fails closed for unknown native kinds', () => {
    const native = Type.Object({ count: Type.Integer() });
    expect(validateRuntimeToolInput(native, { count: 2 }).valid).toBe(true);
    expect(validateRuntimeToolInput(native, { count: '2' }).valid).toBe(false);
    expect(validateRuntimeToolInput({ [Kind]: 'Unregistered', type: 'object' }, {})).toMatchObject({
      valid: false,
      reason: 'unsupported',
    });
  });

  it('keeps unconstrained and boolean JSON Schema semantics', () => {
    expect(validateRuntimeToolInput({}, valid).valid).toBe(true);
    expect(validateRuntimeToolInput(true, valid).valid).toBe(true);
    expect(validateRuntimeToolInput(false, valid).valid).toBe(false);
  });
});

/**
 * The layer that actually gates a model tool call at runtime is Pi's
 * `validateToolArguments` (third_party/pi-mono/packages/ai/src/utils/validation.ts), reached from
 * `agent-loop.ts` for every call; `validateRuntimeToolInput` above is only used for MCP tools and
 * for re-checking a Hook-rewritten input. reported incident turned on the difference: an extra
 * key in a tool's arguments must reach the model as a retryable error, so this pins that Pi neither
 * strips the key before checking nor accepts it once the schema forbids it.
 */
describe('Pi validateToolArguments, the runtime gate for a model tool call', () => {
  const properties = {
    content: Type.String({ minLength: 1 }),
    end_turn: Type.Optional(Type.Boolean()),
  };
  const call = (args: Record<string, unknown>) => ({
    id: 'call-1',
    name: 'send_to_user',
    arguments: args,
  });
  const tool = (schema: unknown) =>
    ({ name: 'send_to_user', description: '', parameters: schema }) as Parameters<
      typeof validateToolArguments
    >[0];

  it('accepts the extra key when the schema does not forbid it, which is the reported bug', () => {
    const loose = tool(Type.Object(properties));
    expect(
      validateToolArguments(loose, call({ content: '任务已派出。', invoke: { name: 'run_code' } })),
    ).toMatchObject({ content: '任务已派出。' });
  });

  it('rejects the extra key once the schema forbids it, without stripping it first', () => {
    const strict = tool(Type.Object(properties, { additionalProperties: false }));
    const args = { content: '任务已派出。', invoke: { name: 'run_code' } };
    expect(() => validateToolArguments(strict, call(args))).toThrow(/Validation failed/);
    // Not stripped: the caller's own object is untouched and the error quotes the extra key back.
    expect(args).toHaveProperty('invoke');
    try {
      validateToolArguments(strict, call(args));
      expect.unreachable('a forbidden extra key must not validate');
    } catch (error) {
      expect(String(error)).toContain('invoke');
    }
  });

  it('still accepts the documented fields under the strict schema', () => {
    const strict = tool(Type.Object(properties, { additionalProperties: false }));
    expect(validateToolArguments(strict, call({ content: '做完了。', end_turn: true }))).toEqual({
      content: '做完了。',
      end_turn: true,
    });
    expect(validateToolArguments(strict, call({ content: '好的。' }))).toEqual({ content: '好的。' });
  });
});

describe('isRuntimeToolInputValid', () => {
  it('uses the same validation after Hook rewrites and rejects unknown targets', () => {
    const tool = defineRuntimeTool({
      name: 'provider_tool',
      description: '',
      schema: Type.Object({}),
      execute: async () => ({ tool_name: 'provider_tool', text: '', content: [] }),
    });
    const providerTool = {
      ...tool,
      def: { ...tool.def, schema: schema as unknown as typeof tool.def.schema },
    };
    expect(isRuntimeToolInputValid([providerTool], 'provider_tool', valid)).toBe(true);
    expect(
      isRuntimeToolInputValid([providerTool], 'provider_tool', {
        ...valid,
        options: { count: '2', enabled: false },
      }),
    ).toBe(false);
    expect(isRuntimeToolInputValid([providerTool], 'unknown', valid)).toBe(false);
  });
});

describe('repairRuntimeToolInput', () => {
  const typeboxSchema = Type.Object({
    session_id: Type.String(),
    limit: Type.Optional(Type.Integer({ minimum: 1 })),
  });
  const deepFreeze = <T>(value: T): T => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(deepFreeze);
      Object.freeze(value);
    }
    return value;
  };
  /** The value execution would receive: the repaired copy only when it validates. */
  const executable = (target: unknown, value: unknown): unknown => {
    const repaired = repairRuntimeToolInput(target, value);
    return repaired.validation.valid ? repaired.value : undefined;
  };

  it.each([
    ['TypeBox', typeboxSchema],
    ['plain JSON Schema', JSON.parse(JSON.stringify(typeboxSchema)) as unknown],
  ])('repairs stringified integers for %s without mutating the input', (_name, target) => {
    const value = deepFreeze({ session_id: 'abc', limit: '2' });
    expect(executable(target, value)).toEqual({ session_id: 'abc', limit: 2 });
  });

  it('returns valid inputs by identity', () => {
    const value = { session_id: 'abc', limit: 2 };
    expect(repairRuntimeToolInput(typeboxSchema, value)).toEqual({
      value,
      validation: { valid: true },
    });
    expect(repairRuntimeToolInput(typeboxSchema, value).value).toBe(value);
  });

  const numeric = {
    type: 'object',
    properties: { n: { type: 'number' }, i: { type: 'integer' } },
  };
  it.each([
    [{ n: '25.7840' }, { n: 25.784 }],
    [{ n: '-0.5' }, { n: -0.5 }],
    [{ n: '1e3' }, { n: 1000 }],
    [{ i: '1e3' }, { i: 1000 }],
    [{ i: '2.0' }, { i: 2 }],
    [{ i: '123456789012345' }, { i: 123456789012345 }],
    [{ i: '1730000000123456' }, { i: 1730000000123456 }],
    [{ n: '-1730000000123456' }, { n: -1730000000123456 }],
    // A coordinate copied from an earlier tool result keeps all 17 digits.
    [{ n: '25.771371841430664' }, { n: 25.771371841430664 }],
    [{ n: '1234567890.123456' }, { n: 1234567890.123456 }],
    // Surrounding whitespace is trimmed before the literal check.
    [{ n: ' 2' }, { n: 2 }],
    [{ i: '5\n' }, { i: 5 }],
    [{ n: '\t-1.5 ' }, { n: -1.5 }],
  ])('maps lossless JSON number literal %j', (value, expected) => {
    expect(executable(numeric, value)).toEqual(expected);
  });

  it.each([
    { i: '2.5' },
    { i: '12345678901234567890' },
    { i: '9007199254740993' },
    { n: '0.3000000000000000444' },
    { n: '25.7713718414306640001' },
    { n: '1e-400' },
    { n: '1e400' },
    { n: '1 2' },
    { n: ' +2' },
    { n: '+2' },
    { n: '.5' },
    { n: '0x10' },
    { n: 'Infinity' },
    { n: 'NaN' },
    { n: '' },
  ])('keeps non-literal or inexact number %j unchanged', (value) => {
    expect(repairRuntimeToolInput(numeric, value)).toMatchObject({
      value,
      validation: { valid: false },
    });
  });

  it('never rewrites numbers into strings or fills nulls', () => {
    const wrongType = { ...valid, query: 2 };
    expect(repairRuntimeToolInput(schema, wrongType).value).toBe(wrongType);
    const nulled = { ...valid, options: { count: null, enabled: false } };
    expect(repairRuntimeToolInput(schema, nulled).value).toBe(nulled);
  });

  it('maps exact boolean literals and keeps other spellings rejected', () => {
    expect(
      executable(schema, { query: 'q', options: { count: '2', enabled: 'false' } }),
    ).toEqual({ query: 'q', options: { count: 2, enabled: false } });
    for (const enabled of ['False', 'TRUE', 'yes', '1', ' true']) {
      const value = { query: 'q', options: { count: 2, enabled } };
      expect(repairRuntimeToolInput(schema, value)).toMatchObject({
        value,
        validation: { valid: false },
      });
    }
  });

  it('unwraps {"item": ...} array wrappers and JSON-text arrays through $defs/$ref', () => {
    const tagged = {
      type: 'object',
      $defs: {
        Tag: {
          type: 'object',
          properties: {
            names: { type: 'array', items: { type: 'string' } },
            ids: { type: 'array', items: { type: 'integer' } },
          },
          required: ['names', 'ids'],
        },
      },
      properties: { tags: { type: 'array', items: { $ref: '#/$defs/Tag' } } },
      required: ['tags'],
    };
    const value = deepFreeze({
      tags: { item: { names: { item: 'a' }, ids: { item: ['1', '2'] } } },
    });
    expect(executable(tagged, value)).toEqual({ tags: [{ names: ['a'], ids: [1, 2] }] });
    expect(executable(tagged, { tags: '[{"names":["b"],"ids":[3]}]' })).toEqual({
      tags: [{ names: ['b'], ids: [3] }],
    });
  });

  it('does not unwrap {"item": ...} when a sibling object branch declares item', () => {
    const listed = {
      type: 'object',
      properties: {
        list: {
          anyOf: [
            { type: 'array', items: { type: 'integer' } },
            {
              type: 'object',
              properties: { item: { type: 'integer' } },
              required: ['item'],
              additionalProperties: false,
            },
          ],
        },
      },
    };
    expect(executable(listed, deepFreeze({ list: { item: '5' } }))).toEqual({
      list: { item: 5 },
    });
  });

  const objectItem = {
    type: 'object',
    properties: { item: { type: 'integer' } },
    required: ['item'],
    additionalProperties: false,
  };
  it.each([
    ['a $ref chain', { $ref: '#/$defs/P' }],
    ['a nested union', { anyOf: [{ type: 'null' }, objectItem] }],
    ['allOf', { allOf: [objectItem] }],
  ])('does not unwrap {"item": ...} when the item branch is behind %s', (_shape, itemBranch) => {
    const listed = {
      type: 'object',
      $defs: { P: { $ref: '#/$defs/O' }, O: objectItem },
      properties: {
        list: { anyOf: [{ type: 'array', items: { type: 'integer' } }, itemBranch] },
      },
    };
    expect(executable(listed, deepFreeze({ list: { item: '5' } }))).toEqual({
      list: { item: 5 },
    });
  });

  it('checks `#` inside a referenced definition against the root, not the branch', () => {
    const nested = {
      type: 'object',
      $defs: {
        Node: {
          type: 'object',
          properties: { inner: { $ref: '#' } },
          additionalProperties: false,
        },
      },
      properties: {
        limit: { type: 'integer' },
        count: { type: 'string' },
        x: {
          anyOf: [
            { $ref: '#/$defs/Node' },
            {
              type: 'object',
              properties: {
                inner: { type: 'object', properties: { count: { type: 'integer' } } },
              },
            },
          ],
        },
      },
    };
    expect(executable(nested, deepFreeze({ limit: '3', x: { inner: { count: '5' } } }))).toEqual({
      limit: 3,
      x: { inner: { count: '5' } },
    });
  });

  it('decodes JSON-text objects for a nullable anyOf object', () => {
    const filtered = {
      type: 'object',
      properties: {
        filter: {
          anyOf: [
            { type: 'object', properties: { limit: { type: 'integer' } } },
            { type: 'null' },
          ],
        },
      },
    };
    expect(executable(filtered, { filter: '{"limit":"5"}' })).toEqual({ filter: { limit: 5 } });
    const notJson = { filter: 'status=open' };
    expect(repairRuntimeToolInput(filtered, notJson).value).toBe(notJson);
  });

  const valueObject = (valueType: string) => ({
    type: 'object',
    properties: { value: { type: valueType } },
  });
  it.each([
    [
      'an anyOf object field',
      { anyOf: [valueObject('number'), valueObject('string')] },
      '{"field":"sku","value":"1234"}',
      { field: 'sku', value: '1234' },
    ],
    [
      'a oneOf object field',
      {
        oneOf: [
          { ...valueObject('number'), required: ['value'] },
          { ...valueObject('string'), required: ['value'] },
        ],
      },
      '{"field":"sku","value":"1234"}',
      { field: 'sku', value: '1234' },
    ],
    [
      'anyOf array items',
      {
        anyOf: [
          { type: 'array', items: { type: 'integer' } },
          { type: 'array', items: { type: 'string' } },
        ],
      },
      '["1","2"]',
      ['1', '2'],
    ],
    [
      'a oneOf branch without item types',
      {
        oneOf: [
          { type: 'array', items: { type: 'number' } },
          { type: 'array', minItems: 1 },
        ],
      },
      '["1"]',
      ['1'],
    ],
    [
      'a string field an array branch would decode',
      {
        anyOf: [
          { type: 'object', properties: { a: { type: 'array' } } },
          { type: 'object', properties: { a: { type: 'string' } } },
        ],
      },
      '{"a":"[1]"}',
      { a: '[1]' },
    ],
    [
      'a string field an object branch would decode',
      {
        anyOf: [
          { type: 'object', properties: { q: { type: 'object' } } },
          { type: 'object', properties: { q: { type: 'string' } } },
        ],
      },
      '{"q":"{\\"x\\":1}"}',
      { q: '{"x":1}' },
    ],
    [
      'string items a nested-array branch would decode',
      {
        anyOf: [
          { type: 'array', items: { type: 'array', items: { type: 'number' } } },
          { type: 'array', items: { type: 'string' } },
        ],
      },
      '["[1]"]',
      ['[1]'],
    ],
    [
      'an {"item": X} object inside the text',
      {
        anyOf: [
          { type: 'object', properties: { a: { type: 'array', items: { type: 'string' } } } },
          {
            type: 'object',
            properties: { a: { type: 'object', properties: { item: { type: 'string' } } } },
          },
        ],
      },
      '{"a":{"item":"x"}}',
      { a: { item: 'x' } },
    ],
    [
      'a text {"item": X} when a sibling object branch declares item',
      {
        anyOf: [
          { type: 'array', items: { type: 'integer' } },
          {
            type: 'object',
            properties: { item: { type: 'integer' } },
            required: ['item'],
            additionalProperties: false,
          },
        ],
      },
      '{"item":"5"}',
      { item: 5 },
    ],
  ])(
    'keeps strings in JSON text when a union branch accepts them for %s',
    (_shape, union, text, expected) => {
      const target = { type: 'object', properties: { v: union } };
      expect(executable(target, { v: text })).toEqual({ v: expected });
    },
  );

  it('repairs union scalars when the repairing branches agree on the result', () => {
    const nullable = {
      type: 'object',
      properties: {
        n: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        filter: { anyOf: [valueObject('number'), { type: 'null' }] },
        both: { anyOf: [{ type: 'number' }, { type: 'integer' }] },
      },
    };
    expect(executable(nullable, { n: '5', filter: { value: '5' }, both: '6' })).toEqual({
      n: 5,
      filter: { value: 5 },
      both: 6,
    });
  });

  it('leaves union scalars unrepaired when branches disagree or oneOf would match twice', () => {
    const ambiguous = {
      type: 'object',
      properties: {
        pair: {
          anyOf: [
            { type: 'object', properties: { a: { type: 'integer' } }, required: ['a'] },
            { type: 'object', properties: { b: { type: 'boolean' } }, required: ['b'] },
          ],
        },
        one: { oneOf: [{ type: 'number' }, { type: 'integer' }] },
      },
    };
    for (const value of [{ pair: { a: '1', b: 'true' } }, { one: '5' }]) {
      expect(repairRuntimeToolInput(ambiguous, value)).toMatchObject({
        value,
        validation: { valid: false },
      });
    }
  });

  const numberOrString = [valueObject('number'), valueObject('string')].map((branch) => ({
    ...branch,
    properties: { a: branch.properties.value },
  }));
  it.each([
    [
      'an enclosing allOf',
      { allOf: [{ anyOf: numberOrString }, { properties: { a: { const: 1 } } }] },
      '{"a":"1"}',
      { a: 1 },
    ],
    [
      'a sibling not',
      {
        anyOf: numberOrString,
        not: { type: 'object', properties: { a: { type: 'string' } } },
      },
      '{"a":"1"}',
      { a: 1 },
    ],
    [
      'a sibling contains',
      {
        anyOf: [
          { type: 'array', items: { type: 'number' } },
          { type: 'array', items: { type: 'string' } },
        ],
        contains: { type: 'number' },
      },
      '["1"]',
      [1],
    ],
    [
      'an enclosing oneOf both branches would accept the string',
      {
        oneOf: [
          { type: 'object', anyOf: numberOrString },
          { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        ],
      },
      '{"a":"1"}',
      { a: 1 },
    ],
  ])(
    'maps union scalars when keeping the string leaves %s unsatisfied',
    (_shape, location, text, expected) => {
      const target = { type: 'object', properties: { v: location } };
      expect(executable(target, { v: text })).toEqual({ v: expected });
    },
  );

  it('repairs a union branch that points into a definition with references of its own', () => {
    const schema = {
      type: 'object',
      properties: {
        to: { anyOf: [{ $ref: '#/definitions/Place/properties/loc' }, { type: 'null' }] },
      },
      definitions: {
        Place: {
          type: 'object',
          properties: {
            loc: {
              type: 'object',
              properties: { lat: { type: 'number' }, lng: { type: 'number' } },
            },
            tags: { type: 'array', items: { $ref: '#/definitions/Tag' } },
          },
        },
        Tag: { type: 'string' },
      },
    };
    const { value, validation } = repairRuntimeToolInput(schema, {
      to: { lat: '1.5', lng: '2.5' },
    });
    expect(validation.valid).toBe(true);
    expect(value).toEqual({ to: { lat: 1.5, lng: 2.5 } });
  });

  it('repairs JSON text next to a value nested too deep for a structured clone', () => {
    let deep: unknown = 'leaf';
    for (let level = 0; level < 10_000; level += 1) deep = [deep];
    const schema = {
      type: 'object',
      properties: { n: { type: 'object', properties: { a: { type: 'integer' } } }, free: {} },
    };
    const { value, validation } = repairRuntimeToolInput(schema, { n: '{"a":"1"}', free: deep });
    expect(validation.valid).toBe(true);
    expect((value as { n: unknown }).n).toEqual({ a: 1 });
  });

  it('repairs as many rows of an undiscriminated union as a first-accepted-branch repair', () => {
    const row = { type: 'object', properties: { n: { type: 'integer' }, s: { type: 'string' } } };
    const schema = {
      type: 'object',
      properties: { rows: { type: 'array', items: { anyOf: Array.from({ length: 20 }, () => structuredClone(row)) } } },
    };
    const rows = Array.from({ length: 4_300 }, () => ({ n: '3', s: 'x' }));
    const { value, validation } = repairRuntimeToolInput(schema, { rows });
    expect(validation.valid).toBe(true);
    expect((value as { rows: { n: unknown }[] }).rows[4_299]!.n).toBe(3);
  });

  it('gives equal JSON texts at two places their own repaired objects', () => {
    const schema = {
      type: 'object',
      properties: {
        a: { type: 'object', properties: { x: { type: 'integer' } } },
        b: { type: 'object', properties: { x: { type: 'integer' } } },
      },
    };
    const { value, validation } = repairRuntimeToolInput(schema, { a: '{"x":1}', b: '{"x":1}' });
    expect(validation.valid).toBe(true);
    const repaired = value as { a: { x: number }; b: { x: number } };
    expect(repaired).toEqual({ a: { x: 1 }, b: { x: 1 } });
    expect(repaired.a).not.toBe(repaired.b);
  });

  it('repairs through agreeing union branches around deeply nested free values', () => {
    let free: unknown = 1;
    for (let level = 0; level < 10_000; level += 1) free = [free];
    const open = { type: 'object', properties: { n: { type: 'integer' }, free: {} } };
    const target = { type: 'object', properties: { v: { anyOf: [open, { ...open }] } } };
    expect(repairRuntimeToolInput(target, { v: { n: '1', free } })).toMatchObject({
      value: { v: { n: 1, free: expect.any(Array) } },
      validation: { valid: true },
    });
  });

  it('reports only the issues left after repair', () => {
    const value = deepFreeze({ query: 'q', options: { count: '2', enabled: 'yes' } });
    const repaired = repairRuntimeToolInput(schema, value);
    expect(repaired.value).toEqual({ query: 'q', options: { count: 2, enabled: 'yes' } });
    expect(repaired.validation).toMatchObject({
      valid: false,
      issues: ['/options/enabled: must be boolean'],
      paths: ['/options/enabled'],
    });
  });

  it('walks tuple items, prefixItems and patternProperties by their own schemas', () => {
    const tuple = Type.Object({ pair: Type.Tuple([Type.Integer(), Type.Boolean()]) });
    expect(executable(tuple, { pair: ['1', 'true'] })).toEqual({ pair: [1, true] });

    const prefixed = {
      type: 'object',
      properties: {
        row: { type: 'array', prefixItems: [{ type: 'string' }], items: { type: 'integer' } },
      },
    };
    expect(executable(prefixed, { row: ['7', '8'] })).toEqual({ row: ['7', 8] });

    const patterned = {
      type: 'object',
      patternProperties: { '^s_': { type: 'string' } },
      additionalProperties: { type: 'integer' },
    };
    expect(executable(patterned, { s_id: '5', n: '6' })).toEqual({ s_id: '5', n: 6 });
  });

  it('validates union branches against the whole schema, including root-relative refs', () => {
    const rooted = {
      $id: 'https://example.test/tool',
      type: 'object',
      properties: {
        s: { type: 'string' },
        b: { type: 'boolean' },
        n: { type: 'integer' },
        v: { anyOf: [{ $ref: '#/properties/s' }, { type: 'integer' }] },
        t: { anyOf: [{ $ref: '#' }, { type: 'integer' }] },
        w: { anyOf: [{ $ref: 'https://example.test/tool#/properties/b' }, { type: 'integer' }] },
      },
    };
    const repaired = repairRuntimeToolInput(rooted, { n: '4', v: '5', t: '3', w: 'true' });
    // "5" already matches the root-relative string branch and stays a string;
    // "3" fails the `#` object branch and is repaired for the integer one.
    expect(repaired.value).toEqual({ n: 4, v: '5', t: 3, w: true });
  });

  it('stays bounded on recursive unions with an unrepairable deep leaf', () => {
    const tree = (kind: string) => ({
      type: 'object',
      properties: {
        kind: { const: kind },
        children: { type: 'array', items: { $ref: '#/$defs/node' } },
      },
      required: ['kind'],
    });
    const recursive = {
      $defs: { node: { anyOf: [tree('a'), tree('b')] } },
      type: 'object',
      properties: { root: { $ref: '#/$defs/node' } },
    };
    let node: Record<string, unknown> = { kind: 'leaf' };
    for (let depth = 0; depth < 40; depth += 1) node = { kind: 'a', children: [node] };
    const value = { root: node };

    const started = performance.now();
    const repaired = repairRuntimeToolInput(recursive, value);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(repaired.value).toBe(value);
    // Enumerating every failed branch would be exponential in the nesting.
    expect(repaired.validation).toMatchObject({
      valid: false,
      issues: [expect.stringContaining('not listed')],
    });
  });

  it('stays bounded when recursive and wide unions need scalar repairs', () => {
    const tree = (kind: string) => ({
      type: 'object',
      properties: {
        kind: { const: kind },
        count: { type: 'integer' },
        children: { type: 'array', items: { $ref: '#/$defs/node' } },
      },
      required: ['kind'],
    });
    const recursive = {
      $defs: { node: { anyOf: [tree('a'), tree('b')] } },
      type: 'object',
      properties: { root: { $ref: '#/$defs/node' } },
    };
    const nest = (count: (level: number) => unknown) => {
      let node: Record<string, unknown> = { kind: 'b', count: count(0) };
      for (let level = 1; level <= 25; level += 1) {
        node = { kind: level % 2 ? 'a' : 'b', count: count(level), children: [node] };
      }
      return { root: node };
    };
    let started = performance.now();
    expect(executable(recursive, nest(String))).toEqual(nest((level) => level));
    expect(performance.now() - started).toBeLessThan(2000);

    const branches = Array.from({ length: 200 }, (_, index) => ({
      type: 'object',
      properties: { kind: { const: `k${index}` }, count: { type: 'integer' } },
      required: ['kind'],
    }));
    const wide = {
      type: 'object',
      properties: { rows: { type: 'array', items: { anyOf: branches } } },
    };
    const rows = (count: (index: number) => unknown) => ({
      rows: Array.from({ length: 50 }, (_, index) => ({
        kind: `k${199 - index}`,
        count: count(index),
      })),
    });
    started = performance.now();
    expect(executable(wide, rows(String))).toEqual(rows((index) => index));
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('stays linear on recursive unions nested in JSON text', () => {
    const node = (index: number) => ({
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: index % 2 ? 'number' : 'integer' } },
        child: { $ref: '#/$defs/node' },
      },
    });
    // Every branch accepts every level, so no branch is ruled out early.
    const recursive = {
      $defs: { node: { anyOf: [node(0), node(1), node(2)] } },
      type: 'object',
      properties: { root: { $ref: '#/$defs/node' } },
    };
    const ids = Array.from({ length: 150 }, () => '1');
    let level: Record<string, unknown> = { ids };
    for (let depth = 1; depth < 8; depth += 1) level = { ids, child: JSON.stringify(level) };
    const started = performance.now();
    const repaired = repairRuntimeToolInput(recursive, { root: level });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(repaired.validation.valid).toBe(true);
  });

  it('repairs wide unions old inputs fit the work budget with', () => {
    // Bounds for loaded CI runners: the regression this guards against took seconds to minutes.
    const keyed = {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          items: {
            anyOf: Array.from({ length: 200 }, (_, index) => ({
              type: 'object',
              properties: { [`p${index}`]: { type: 'integer' } },
              required: [`p${index}`],
            })),
          },
        },
      },
    };
    const rows = Array.from({ length: 450 }, () => ({ p0: '3' }));
    let started = performance.now();
    expect(repairRuntimeToolInput(keyed, { rows }).validation.valid).toBe(true);
    expect(performance.now() - started).toBeLessThan(10_000);

    const arrays = {
      type: 'object',
      properties: {
        v: {
          anyOf: Array.from({ length: 20 }, () => ({ type: 'array', items: { type: 'number' } })),
        },
      },
    };
    started = performance.now();
    const repaired = repairRuntimeToolInput(arrays, {
      v: Array.from({ length: 1_000_000 }, () => '1'),
    });
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(repaired.validation.valid).toBe(true);
  });

  it('compiles only the definitions a union branch uses', () => {
    const $defs: Record<string, unknown> = {};
    for (let model = 0; model < 100; model += 1) {
      $defs[`M${model}`] = {
        type: 'object',
        properties: {
          kind: { const: `m${model}` },
          data: {
            anyOf: Array.from({ length: 20 }, (_, index) => ({
              type: 'object',
              properties: { k: { const: `d${index}` }, n: { type: 'integer' } },
              required: ['k'],
            })),
          },
        },
        required: ['kind'],
      };
    }
    const models = {
      $defs,
      type: 'object',
      properties: {
        v: { anyOf: Array.from({ length: 100 }, (_, model) => ({ $ref: `#/$defs/M${model}` })) },
      },
    };
    // Validators are cached per schema object, so this measures the first, compiling call.
    const started = performance.now();
    expect(executable(models, { v: { kind: 'm99', data: { k: 'd19', n: '1' } } })).toEqual({
      v: { kind: 'm99', data: { k: 'd19', n: 1 } },
    });
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it('stays bounded when $ref/allOf fan out on a scalar', () => {
    const fanOut = {
      type: 'object',
      $defs: {
        a: { allOf: [{ type: 'number' }, { $ref: '#/$defs/a' }, { $ref: '#/$defs/a' }] },
      },
      properties: { x: { $ref: '#/$defs/a' } },
    };
    const value = { x: 'q' };
    const started = performance.now();
    const repaired = repairRuntimeToolInput(fanOut, value);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(repaired.value).toBe(value);
  });

  const notListed = {
    valid: false,
    reason: 'invalid',
    issues: [expect.stringContaining('not listed for recursive or very large schemas')],
  };
  /** `{ c: { c: ... leaf } }`, `depth` levels deep. */
  const cChain = (depth: number, leaf: unknown = {}) => {
    let current = leaf;
    for (let level = 0; level < depth; level += 1) current = { c: current };
    return current;
  };

  it('never lists issues for recursive schemas, however shallow the value', () => {
    const node = (kind: string) => ({
      type: 'object',
      properties: { kind: { const: kind }, next: { $ref: '#/$defs/node' } },
      required: ['kind'],
    });
    const recursive = {
      $defs: { node: { anyOf: [node('a'), node('b')] } },
      type: 'object',
      properties: { root: { $ref: '#/$defs/node' } },
    };
    const chain = (depth: number) => {
      let current: Record<string, unknown> = { kind: 'leaf' };
      for (let level = 0; level < depth; level += 1) current = { kind: 'a', next: current };
      return { root: current };
    };
    for (const depth of [0, 2, 10]) {
      expect(validateRuntimeToolInput(recursive, chain(depth))).toMatchObject(notListed);
    }
    const arrays = {
      $defs: {
        n: { anyOf: [{ type: 'string' }, { type: 'array', items: { $ref: '#/$defs/n' } }] },
      },
      type: 'object',
      properties: { n: { $ref: '#/$defs/n' } },
    };
    expect(validateRuntimeToolInput(arrays, { n: [[5]] })).toMatchObject(notListed);
  });

  it('treats recursive allOf branches like union branches', () => {
    const next = { type: 'object', properties: { next: { $ref: '#/$defs/node' } } };
    const recursive = {
      $defs: {
        node: {
          type: 'object',
          properties: { kind: { type: 'string' } },
          // Both branches lead back into node, so listing revisits each level twice.
          allOf: [next, { ...next, required: ['kind'] }],
        },
      },
      type: 'object',
      properties: { root: { $ref: '#/$defs/node' } },
    };
    const chain = (depth: number) => {
      let current: Record<string, unknown> = { kind: 5 };
      for (let level = 0; level < depth; level += 1) current = { kind: 'k', next: current };
      return { root: current };
    };
    for (const depth of [2, 20]) {
      expect(validateRuntimeToolInput(recursive, chain(depth))).toMatchObject(notListed);
    }

    // An allOf off any cycle keeps listing issues however deep the value nests.
    const flat = {
      type: 'object',
      allOf: [
        { properties: { limit: { type: 'integer' } } },
        { properties: { data: { type: 'object' } } },
      ],
    };
    expect(validateRuntimeToolInput(flat, { limit: 'x', data: cChain(40) })).toMatchObject({
      valid: false,
      issues: ['/limit: must be integer'],
    });
  });

  it('keeps listing issues for non-recursive schemas with deep payloads and wide unions', () => {
    const consts = Array.from({ length: 120 }, (_, index) => ({ const: `k${index}` }));
    const flat = {
      type: 'object',
      properties: {
        mode: { anyOf: consts },
        limit: { type: 'integer' },
        payload: { type: 'object' },
      },
      required: ['mode'],
    };
    expect(
      validateRuntimeToolInput(flat, { mode: 'k0', limit: 'abc', payload: cChain(60) }),
    ).toMatchObject({ valid: false, issues: ['/limit: must be integer'] });
  });

  it('stops listing issues once value size times schema size passes the work bound', () => {
    const rows = {
      type: 'object',
      properties: {
        rows: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } } } },
        limit: { type: 'integer' },
      },
    };
    const value = (count: number) => ({
      limit: 'abc',
      rows: Array.from({ length: count }, (_, id) => ({ id })),
    });
    expect(validateRuntimeToolInput(rows, value(100))).toMatchObject({
      valid: false,
      issues: ['/limit: must be integer'],
    });
    expect(validateRuntimeToolInput(rows, value(100_000))).toMatchObject(notListed);
  });

  it('keeps listing specific issues for real MCP tool schemas', () => {
    // MCP-Atlas `airtable_create_comment` and `twelvedata_GetTechnicalIndicators` (descriptions trimmed).
    const comment = {
      properties: {
        baseId: { title: 'Baseid', type: 'string' },
        tableId: { title: 'Tableid', type: 'string' },
        recordId: { title: 'Recordid', type: 'string' },
        text: { title: 'Text', type: 'string' },
        parentCommentId: { default: null, title: 'Parentcommentid', type: 'string' },
      },
      required: ['baseId', 'tableId', 'recordId', 'text'],
      title: 'create_commentArguments',
      type: 'object',
    };
    expect(
      validateRuntimeToolInput(comment, { baseId: 'b', tableId: 't', recordId: 7 }),
    ).toMatchObject({
      valid: false,
      reason: 'invalid',
      issues: ['/text: must have required properties text', '/recordId: must be string'],
    });
    const indicators = {
      $defs: {
        GetTechnicalIndicatorsRequest: {
          properties: {
            outputsize: { default: 10, examples: [10], title: 'Outputsize', type: 'integer' },
            apikey: { default: 'demo', examples: ['demo'], title: 'Apikey', type: 'string' },
          },
          title: 'GetTechnicalIndicatorsRequest',
          type: 'object',
        },
      },
      properties: { params: { $ref: '#/$defs/GetTechnicalIndicatorsRequest' } },
      required: ['params'],
      type: 'object',
    };
    expect(validateRuntimeToolInput(indicators, { params: { outputsize: '10x' } })).toMatchObject({
      valid: false,
      reason: 'invalid',
      issues: ['/params/outputsize: must be integer'],
    });
  });

  /** Two-way union of `combine(a, b, c, d)` leaves recursing through `x`. */
  const combinatorCycle = (combine: (...leaves: object[]) => object) => {
    const leaf = (kind: string) => ({
      type: 'object',
      properties: { kind: { const: kind }, x: { $ref: '#/$defs/S' } },
      required: ['kind'],
    });
    return {
      $defs: { S: combine(leaf('a'), leaf('b'), leaf('c'), leaf('d')) },
      type: 'object',
      properties: { root: { $ref: '#/$defs/S' } },
    };
  };
  const kindChain = (depth: number) => {
    let current: Record<string, unknown> = { kind: 'bad' };
    for (let level = 0; level < depth; level += 1) current = { kind: 'a', x: current };
    return { root: current };
  };
  /** Three nested two-way unions around a two-way `$ref` union: 16 paths per level. */
  const fanOut16 = (apply: (inner: object) => object, ref: string) => {
    const wrap = (inner: object) => ({ anyOf: [apply(inner), apply(inner)] });
    return wrap(wrap(wrap({ anyOf: [{ $ref: ref }, { $ref: ref }] })));
  };
  const sameValueCycle = (apply: (inner: object) => object) => {
    const S = fanOut16(apply, '#/$defs/N');
    return JSON.parse(
      JSON.stringify({
        $defs: { N: { type: 'object', properties: { c: S } } },
        type: 'object',
        properties: { name: { type: 'string' }, c: S },
        required: ['name'],
      }),
    ) as object;
  };
  /** `d0 .. d28`, each applying the next level twice to the same value: no cycle. */
  const diamond = () => {
    const defs: Record<string, object> = { d28: { properties: { a: { type: 'string' } } } };
    for (let level = 27; level >= 0; level -= 1) {
      const next = { $ref: `#/$defs/d${level + 1}` };
      defs[`d${level}`] = { allOf: [next, next] };
    }
    return { $defs: defs, $ref: '#/$defs/d0' };
  };
  /** A nested `$id` resource reached first by fragment, then as a whole. */
  const nestedResource = {
    $id: 'https://example.test/root',
    type: 'object',
    properties: {
      x: { $ref: 'https://example.test/b#/$defs/n' },
      y: { $ref: 'https://example.test/b' },
    },
    required: ['name'],
    $defs: {
      b: {
        $id: 'https://example.test/b',
        $defs: {
          n: {
            type: 'object',
            properties: { c: { $ref: '#/$defs/n' }, d: { $ref: '#/$defs/n' } },
          },
        },
        $ref: '#/$defs/n',
      },
    },
  };
  const nestedArrays = (depth: number) => {
    let current: unknown = 'x';
    for (let level = 0; level < depth; level += 1) current = [current];
    return current;
  };

  it.each([
    [
      'nested anyOf cycle',
      combinatorCycle((a, b, c, d) => ({ anyOf: [{ anyOf: [a, b] }, { anyOf: [c, d] }] })),
      kindChain(12),
    ],
    [
      'allOf of anyOfs',
      combinatorCycle((a, b, c, d) => ({ allOf: [{ anyOf: [a, b] }, { anyOf: [c, d] }] })),
      kindChain(12),
    ],
    ['if/then layers', sameValueCycle((inner) => ({ if: true, then: inner })), cChain(8)],
    ['if/else layers', sameValueCycle((inner) => ({ if: false, else: inner })), cChain(8)],
    [
      'dependentSchemas',
      sameValueCycle((inner) => ({ dependentSchemas: { c: inner } })),
      cChain(8),
    ],
    [
      'overlapping properties/patternProperties, depth 20',
      {
        properties: { c: { $ref: '#' } },
        patternProperties: { '^c$': { $ref: '#' } },
        type: 'object',
      },
      cChain(20, 5),
    ],
    [
      'overlapping properties/patternProperties, depth 26',
      {
        properties: { c: { $ref: '#' } },
        patternProperties: { '^c$': { $ref: '#' } },
        type: 'object',
      },
      cChain(26, 5),
    ],
    [
      'overlapping items/contains, depth 20',
      { type: 'array', items: { $ref: '#' }, contains: { $ref: '#' } },
      nestedArrays(20),
    ],
    [
      'recursive not',
      { type: 'object', properties: { c: { $ref: '#' } }, not: { required: ['c', 'd'] } },
      cChain(20, { c: 1, d: 1 }),
    ],
    ['$ref diamond without cycle, depth 28', diamond(), { a: 1, b: 0 }],
    ['nested $id base hiding a cycle', nestedResource, { y: cChain(18) }],
  ])('returns quickly without listing issues: %s', (_name, crafted, value) => {
    const started = performance.now();
    const result = validateRuntimeToolInput(crafted, value);
    expect(performance.now() - started).toBeLessThan(200);
    expect(result).toMatchObject(notListed);
    const repairStarted = performance.now();
    expect(repairRuntimeToolInput(crafted, value).validation).toMatchObject(notListed);
    expect(performance.now() - repairStarted).toBeLessThan(200);
  });

  it('resolves $dynamicRef cycles as recursive without listing issues', () => {
    const dynamic = {
      $dynamicAnchor: 'node',
      type: 'object',
      properties: { c: { $dynamicRef: '#node' }, d: { $dynamicRef: '#node' } },
      required: ['name'],
    };
    const started = performance.now();
    const result = validateRuntimeToolInput(dynamic, cChain(20));
    expect(performance.now() - started).toBeLessThan(200);
    expect(result).toMatchObject(notListed);
  });

  it('stops expanding a wide recursive schema once the node limit is queued', () => {
    const leaves = Array.from({ length: 30_000 }, () => ({ type: 'string' }));
    const wide = {
      $defs: {
        w: { oneOf: [...leaves, { type: 'object', properties: { z: { $ref: '#/$defs/w' } } }] },
      },
      type: 'object',
      properties: { z: { $ref: '#/$defs/w' } },
    };
    expect(expandedSchemaCost(wide).size).toBe(1_001);
    expect(validateRuntimeToolInput(wide, { z: 1 })).toMatchObject(notListed);
  });

  it('weights nested contains and skips listing uniqueItems on long arrays', () => {
    let nested: Record<string, unknown> = { type: 'number' };
    for (let level = 0; level < 7; level += 1) {
      nested = { type: 'array', contains: nested, minContains: 1 };
    }
    expect(validateRuntimeToolInput(nested, [[[[[[['x']]]]]]])).toMatchObject(notListed);
    expect(
      validateRuntimeToolInput({ type: 'array', contains: { type: 'number' } }, ['x']),
    ).toMatchObject({ issues: [expect.not.stringContaining('not listed')] });
    const unique = { type: 'array', uniqueItems: true, maxItems: 1 };
    expect(validateRuntimeToolInput(unique, Array(50_000).fill(1))).toMatchObject(notListed);
    expect(validateRuntimeToolInput(unique, [1, 1])).toMatchObject({
      issues: expect.arrayContaining([expect.stringContaining('duplicate')]),
    });
  });

  it('charges anchor references a walk of the whole raw schema per application', () => {
    const anchored = (enumSize: number) => ({
      type: 'array',
      $defs: {
        a: { $anchor: 'a', type: 'string' },
        unused: { enum: Array.from({ length: enumSize }, (_, i) => `value-${i}`) },
      },
      items: { $ref: '#a' },
    });
    const large = anchored(100_000);
    expect(validateRuntimeToolInput(large, Array(10_000).fill(1))).toMatchObject(notListed);
    expect(expandedSchemaCost(large).work).toBeGreaterThan(100_000);
    expect(validateRuntimeToolInput(anchored(10), [1])).toMatchObject({
      valid: false,
      issues: ['/0: must be string'],
    });
  });

  it('never treats data or property names as schemas when deciding to list issues', () => {
    const dataRef = {
      type: 'object',
      properties: { n: { type: 'integer', default: { $ref: 'http://[bad' } } },
    };
    expect(validateRuntimeToolInput(dataRef, { n: 2 })).toEqual({ valid: true });
    expect(validateRuntimeToolInput(dataRef, { n: 'x' })).toMatchObject({
      valid: false,
      reason: 'invalid',
      issues: ['/n: must be integer'],
    });
    const keywordNames = {
      type: 'object',
      properties: {
        if: { type: 'string' },
        then: { $ref: '#/$defs/count' },
        $ref: { type: 'string' },
        $dynamicRef: { type: 'string' },
      },
      $defs: { count: { type: 'integer' } },
    };
    expect(validateRuntimeToolInput(keywordNames, { if: 1, then: 'x' })).toMatchObject({
      valid: false,
      reason: 'invalid',
      issues: ['/if: must be string', '/then: must be integer'],
    });
  });

  it('reports invalid TypeBox inputs whose schema holds BigInt values', () => {
    const bigint = Type.Object({ n: Type.BigInt({ minimum: 1n }) });
    expect(validateRuntimeToolInput(bigint, { n: 'x' })).toMatchObject({
      valid: false,
      reason: 'invalid',
    });
    expect(repairRuntimeToolInput(bigint, { n: 'x' }).validation.valid).toBe(false);
  });

  it('keeps repairing when embedded JSON holds a huge array', () => {
    const listed = {
      type: 'object',
      properties: { ids: { type: 'array', items: { type: 'integer' } }, n: { type: 'integer' } },
    };
    const ids = Array.from({ length: 100_000 }, () => 1);
    const repaired = repairRuntimeToolInput(listed, { ids: JSON.stringify(ids), n: '3' });
    expect(repaired.validation.valid).toBe(true);
    expect(repaired.value).toMatchObject({ n: 3 });
  });

  it.each([
    { ids: '[12345678901234567890]' },
    { ids: '[1, 9007199254740993]' },
    { filter: '{"id":9007199254740993}' },
    { filter: '{"nested":{"n":0.3000000000000000444}}' },
    { filter: '{"n":1e400}' },
  ])('keeps embedded JSON with inexact number literals unchanged: %j', (value) => {
    const embedded = {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'number' } },
        filter: { type: 'object' },
      },
    };
    expect(repairRuntimeToolInput(embedded, value)).toMatchObject({
      value,
      validation: { valid: false },
    });
    expect(executable(embedded, { ids: '[1.5, 2e3, -0.25]', filter: '{"n":{"m":25.7840}}' }))
      .toEqual({ ids: [1.5, 2000, -0.25], filter: { n: { m: 25.784 } } });
  });

  it('rejects oversized number literals in linear time', () => {
    const numberOnly = { type: 'object', properties: { n: { type: 'number' } } };
    const value = { n: `1${'0'.repeat(256 * 1024)}1` };
    const started = performance.now();
    const repaired = repairRuntimeToolInput(numberOnly, value);
    expect(performance.now() - started).toBeLessThan(100);
    expect(repaired.value).toBe(value);
    expect(repaired.validation.valid).toBe(false);
    // Every finite double still fits when written out in full.
    const tiny = `0.${'0'.repeat(300)}25`;
    expect(repairRuntimeToolInput(numeric, { n: tiny }).value).toEqual({ n: Number(tiny) });
  });
});
