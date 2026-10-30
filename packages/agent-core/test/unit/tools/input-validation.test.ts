import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';

import { coerceRuntimeToolInput } from '../../../src/tools/input-validation.js';

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

const typeboxSchema = Type.Object({
  session_id: Type.String(),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
});

describe('coerceRuntimeToolInput', () => {
  it.each([
    ['TypeBox', typeboxSchema],
    ['plain JSON Schema', JSON.parse(JSON.stringify(typeboxSchema)) as unknown],
  ])('coerces stringified integers for %s without mutating the input', (_name, target) => {
    const value = { session_id: 'abc', limit: '2' };

    expect(coerceRuntimeToolInput(target, value)).toEqual({ session_id: 'abc', limit: 2 });
    expect(value).toEqual({ session_id: 'abc', limit: '2' });
  });

  it('returns valid inputs by identity', () => {
    const value = { session_id: 'abc', limit: 2 };

    expect(coerceRuntimeToolInput(typeboxSchema, value)).toBe(value);
  });

  it.each(['abc', '2.5', '0'])('returns unrecoverable %j unchanged', (limit) => {
    const value = { session_id: 'abc', limit };

    expect(coerceRuntimeToolInput(typeboxSchema, value)).toBe(value);
  });

  it('never rewrites numbers into strings or fills nulls', () => {
    const wrongType = { ...valid, query: 2 };
    expect(coerceRuntimeToolInput(schema, wrongType)).toBe(wrongType);
    const nulled = { ...valid, options: { count: null, enabled: false } };
    expect(coerceRuntimeToolInput(schema, nulled)).toBe(nulled);
  });

  it('coerces nested stringified numbers in plain JSON Schema', () => {
    const value = { query: 'q', options: { count: '2', enabled: false } };

    expect(coerceRuntimeToolInput(schema, value)).toEqual({
      query: 'q',
      options: { count: 2, enabled: false },
    });
  });

  it('keeps boolean strings rejected', () => {
    const value = { query: 'q', options: { count: '2', enabled: 'false' } };

    expect(coerceRuntimeToolInput(schema, value)).toBe(value);
  });
});
