import { isProxy } from 'node:util/types';

import { IncrementalSha256 } from './incremental-sha256.js';

export interface SemanticSnapshot<T> {
  readonly value: T;
  readonly fingerprint: string;
}

const ownedValues = new WeakSet<object>();
const fingerprints = new WeakMap<object, string>();

/**
 * Detach callback-owned History/event data before it becomes an in-run
 * identity or deferred delivery payload. Unsupported or cyclic values fail
 * closed. The digest is streamed so identity memory does not scale with the
 * encoded payload size.
 */
export function captureSemanticSnapshot<T>(value: T): SemanticSnapshot<T> {
  const snapshot =
    typeof value === 'object' && value !== null && ownedValues.has(value)
      ? value
      : freezeSemanticValue(
          cloneSemanticValue(value, new Map<object, object>()),
          new WeakSet<object>(),
        );
  let fingerprint: string | undefined;
  return {
    value: snapshot,
    // Value-only consumers still validate and detach eagerly, but never encode
    // or hash the history. Only values frozen by this module may be reused.
    get fingerprint() {
      if (fingerprint !== undefined) return fingerprint;
      const object = typeof snapshot === 'object' && snapshot !== null ? snapshot : undefined;
      fingerprint = object ? fingerprints.get(object) : undefined;
      if (fingerprint === undefined) {
        const encoder = new SemanticIdentityEncoder(new IncrementalSha256());
        encodeValue(snapshot, new WeakSet<object>(), encoder);
        fingerprint = encoder.digest();
        if (object) fingerprints.set(object, fingerprint);
      }
      return fingerprint;
    },
  };
}

// Preserve structured-clone semantics for plain data, including holes and
// shared references, while retaining our own immutable history subtrees.
function cloneSemanticValue<T>(value: T, clones: Map<object, object>): T {
  if (typeof value !== 'object' || value === null) return structuredClone(value);
  if (ownedValues.has(value)) return value;
  // Native cloning rejects proxies without running their traps. Preserve that
  // boundary, and defer accessor side effects to native property enumeration.
  if (isProxy(value)) return structuredClone(value);
  const previous = clones.get(value);
  if (previous) return previous as T;
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return structuredClone(value);
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) {
    return structuredClone(value);
  }
  const copy: object = Array.isArray(value) ? new Array(value.length) : {};
  clones.set(value, copy);
  for (const key of keys) {
    Object.defineProperty(copy, key, {
      value: cloneSemanticValue(Reflect.get(value, key), clones),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return copy as T;
}

/**
 * Measures the streamed semantic representation without cloning or building
 * a canonical string. Used only for already-detached replay results.
 */
export function estimateSemanticValueSize(value: unknown): number {
  const encoder = new SemanticIdentityEncoder();
  encodeValue(value, new WeakSet<object>(), encoder);
  return encoder.byteSize;
}

class SemanticIdentityEncoder {
  byteSize = 0;

  constructor(private readonly hash?: IncrementalSha256) {}

  frame(tag: string, payload: string): void {
    this.write(`${Buffer.byteLength(tag)}:`);
    this.write(tag);
    this.write(`${Buffer.byteLength(payload)}:`);
    this.write(payload);
  }

  digest(): string {
    if (!this.hash) throw new Error('Semantic identity digest was not requested.');
    return this.hash.digestHex();
  }

  private write(value: string): void {
    this.byteSize += Buffer.byteLength(value);
    this.hash?.update(value);
  }
}

function freezeSemanticValue<T>(value: T, ancestors: WeakSet<object>): T {
  if (typeof value !== 'object' || value === null) {
    if (!['undefined', 'string', 'boolean', 'number'].includes(typeof value) && value !== null) {
      throw new TypeError(`Unsupported semantic identity value: ${typeof value}.`);
    }
    return value;
  }
  if (ownedValues.has(value)) return value;
  if (ancestors.has(value)) throw new TypeError('Cyclic semantic identity values are unsupported.');
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Semantic identity values must contain only plain objects and arrays.');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('Symbol-keyed semantic identity values are unsupported.');
  }
  ancestors.add(value);
  for (const key of Object.keys(value)) freezeSemanticValue(Reflect.get(value, key), ancestors);
  ancestors.delete(value);
  Object.freeze(value);
  ownedValues.add(value);
  return value;
}

function encodeValue(
  value: unknown,
  ancestors: WeakSet<object>,
  encoder: SemanticIdentityEncoder,
): void {
  if (encodePrimitive(value, encoder)) return;
  if (typeof value !== 'object' || value === null) {
    throw new TypeError(`Unsupported semantic identity value: ${typeof value}.`);
  }
  encodeObject(value, ancestors, encoder);
}

function encodePrimitive(value: unknown, encoder: SemanticIdentityEncoder): boolean {
  if (value === null) {
    encoder.frame('null', '');
    return true;
  }
  switch (typeof value) {
    case 'undefined':
      encoder.frame('undefined', '');
      return true;
    case 'string':
      encoder.frame('string', value);
      return true;
    case 'boolean':
      encoder.frame('boolean', value ? 'true' : 'false');
      return true;
    case 'number':
      encoder.frame('number', encodeNumber(value));
      return true;
    case 'object':
      return false;
    default:
      throw new TypeError(`Unsupported semantic identity value: ${typeof value}.`);
  }
}

function encodeNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  return Object.is(value, -0) ? '-0' : String(value);
}

function encodeObject(
  value: object,
  ancestors: WeakSet<object>,
  encoder: SemanticIdentityEncoder,
): void {
  if (ancestors.has(value)) {
    throw new TypeError('Cyclic semantic identity values are unsupported.');
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) encodeArray(value, ancestors, encoder);
    else encodePlainObject(value, ancestors, encoder);
  } finally {
    ancestors.delete(value);
  }
}

function encodeArray(
  values: readonly unknown[],
  ancestors: WeakSet<object>,
  encoder: SemanticIdentityEncoder,
): void {
  if (Object.getOwnPropertySymbols(values).length > 0) {
    throw new TypeError('Symbol-keyed semantic identity values are unsupported.');
  }
  encoder.frame('begin', 'array');
  encoder.frame('length', String(values.length));
  Object.keys(values)
    .sort()
    .forEach((key) => {
      encoder.frame('key', key);
      encodeValue(Reflect.get(values, key), ancestors, encoder);
    });
  encoder.frame('end', 'array');
}

function encodePlainObject(
  value: object,
  ancestors: WeakSet<object>,
  encoder: SemanticIdentityEncoder,
): void {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Semantic identity values must contain only plain objects and arrays.');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError('Symbol-keyed semantic identity values are unsupported.');
  }
  encoder.frame('begin', 'object');
  Object.keys(value)
    .sort()
    .forEach((key) => {
      encoder.frame('key', key);
      encodeValue(Reflect.get(value, key), ancestors, encoder);
    });
  encoder.frame('end', 'object');
}
