import { types } from 'node:util';
import { IncrementalSha256 } from './incremental-sha256.js';

export interface SemanticSnapshot<T> {
  readonly value: T;
  readonly fingerprint: string;
  /** Process-local replay identity; never used as a persisted history digest. */
  readonly replayFingerprint: string;
}

const ownedValues = new WeakSet<object>();
const fingerprints = new WeakMap<object, string>();
const replayFingerprints = new WeakMap<object, string>();
const measuredSizes = new WeakMap<object, number>();

/**
 * Detach callback-owned History/event data before it becomes an in-run
 * identity or deferred delivery payload. Unsupported or cyclic values fail
 * closed. The digest is streamed so identity memory does not scale with the
 * encoded payload size. An optional previously owned snapshot lets fresh plain
 * data share unchanged immutable descendants while preserving input aliases.
 */
export function captureSemanticSnapshot<T>(value: T, previous?: T): SemanticSnapshot<T> {
  // Native cloning preserves external getters and aliases. Data-only wrappers
  // can instead share descendants already detached and frozen by this module.
  const snapshot =
    typeof value === 'object' && value !== null && ownedValues.has(value)
      ? value
      : freezeSemanticValue(
          cloneOwnedWrapper(value, previous) ?? structuredClone(value),
          new WeakSet<object>(),
        );
  let fingerprint: string | undefined;
  return {
    value: snapshot,
    get replayFingerprint() {
      if (typeof snapshot === 'object' && snapshot !== null) return replaySubtreeFingerprint(snapshot);
      return this.fingerprint;
    },
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

// Each immutable child contributes a framed SHA-256 digest. Equal detached
// values produce the same tree identity, including repeated aliases, but old
// message bodies are encoded only once. The legacy byte digest stays separate.
function replaySubtreeFingerprint(value: object): string {
  const cached = replayFingerprints.get(value);
  if (cached !== undefined) return cached;
  if (!ownedValues.has(value)) throw new TypeError('Replay identity requires an owned snapshot.');
  const encoder = new SemanticIdentityEncoder(new IncrementalSha256(), true);
  encodeObject(value, new WeakSet<object>(), encoder);
  const digest = encoder.digest();
  replayFingerprints.set(value, digest);
  return digest;
}

const NATIVE_CLONE_REQUIRED = Symbol('native-clone-required');
const PREVIOUS_SHARING_UNAVAILABLE = Symbol('previous-sharing-unavailable');

function plainDataDescriptors(value: object): PropertyDescriptorMap | undefined {
  // Inspecting a Proxy would invoke traps that native structuredClone rejects.
  if (types.isProxy(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    !(Array.isArray(value) && prototype === Array.prototype)
  )
    return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((d) => d.enumerable && !('value' in d))) return undefined;
  return descriptors;
}

function cloneOwnedWrapper<T>(value: T, previous?: T): T | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const descriptors = plainDataDescriptors(value);
  const reusePrevious =
    typeof previous === 'object' && previous !== null && ownedValues.has(previous);
  if (
    !descriptors ||
    (!reusePrevious &&
      !Object.values(descriptors).some(
        (d) =>
          d.enumerable && typeof d.value === 'object' && d.value !== null && ownedValues.has(d.value),
      ))
  )
    return undefined;

  const copies = new WeakMap<object, object>();
  const previousOwners = new WeakMap<object, object>();
  const visiting = new WeakSet<object>();
  const allocate = (node: object, fields: PropertyDescriptorMap): object => {
    const result = Array.isArray(node) ? new Array(fields.length!.value as number) : {};
    copies.set(node, result);
    return result;
  };
  const define = (target: object, key: string, child: unknown) => {
    Object.defineProperty(target, key, {
      value: child, enumerable: true, writable: true, configurable: true,
    });
  };
  const clone = (node: unknown, prior?: unknown): unknown => {
    if (typeof node !== 'object' || node === null) {
      if (node !== null && !['undefined', 'string', 'boolean', 'number'].includes(typeof node)) {
        throw NATIVE_CLONE_REQUIRED;
      }
      return node;
    }
    if (ownedValues.has(node)) {
      // Mixing existing owned nodes with value-based reuse could merge two
      // distinct input aliases. Keep the original wrapper path for that case.
      if (reusePrevious) throw PREVIOUS_SHARING_UNAVAILABLE;
      return node;
    }
    const existing = copies.get(node);
    if (existing) return existing;
    const fields = node === value ? descriptors : plainDataDescriptors(node);
    if (!fields) throw NATIVE_CLONE_REQUIRED;
    if (visiting.has(node)) throw NATIVE_CLONE_REQUIRED;
    visiting.add(node);
    const candidate =
      reusePrevious &&
      typeof prior === 'object' && prior !== null && ownedValues.has(prior) &&
      Array.isArray(prior) === Array.isArray(node) &&
      (!previousOwners.has(prior) || previousOwners.get(prior) === node)
        ? prior as Record<string, unknown>
        : undefined;
    const keys = Object.keys(fields).filter((key) => fields[key]!.enumerable);
    const priorKeys = candidate ? Object.keys(candidate) : [];
    let unchanged =
      candidate !== undefined && keys.length === priorKeys.length &&
      keys.every((key, index) => key === priorKeys[index]) &&
      (!Array.isArray(node) || node.length === candidate['length']);
    let copy: object | undefined;
    if (!unchanged) copy = allocate(node, fields);
    for (let index = 0; index < keys.length; index++) {
      const key = keys[index]!;
      const priorChild = candidate && Object.hasOwn(candidate, key) ? candidate[key] : undefined;
      const child = clone(fields[key]!.value, priorChild);
      if (unchanged && Object.is(child, candidate![key])) continue;
      if (unchanged) {
        unchanged = false;
        copy = allocate(node, fields);
        for (let preceding = 0; preceding < index; preceding++) {
          const priorKey = keys[preceding]!;
          define(copy, priorKey, candidate![priorKey]);
        }
      }
      define(copy!, key, child);
    }
    visiting.delete(node);
    if (unchanged) {
      previousOwners.set(candidate!, node);
      copies.set(node, candidate!);
      return candidate;
    }
    return copy!;
  };
  try {
    return clone(value, previous) as T;
  } catch (error) {
    if (error === PREVIOUS_SHARING_UNAVAILABLE) return cloneOwnedWrapper(value);
    if (error === NATIVE_CLONE_REQUIRED) return undefined;
    throw error;
  }
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

const SEMANTIC_TAGS = [
  'null',
  'undefined',
  'string',
  'boolean',
  'number',
  'begin',
  'length',
  'end',
  'key',
  'subtree',
] as const;
type SemanticTag = (typeof SEMANTIC_TAGS)[number];
const FRAME_PREFIXES = Object.fromEntries(
  SEMANTIC_TAGS.map((tag) => [tag, `${tag.length}:${tag}`]),
) as Record<SemanticTag, string>;

class SemanticIdentityEncoder {
  byteSize = 0;

  get measuresOnly(): boolean { return this.hash === undefined; }

  constructor(private readonly hash?: IncrementalSha256, readonly replayTree = false) {}

  frame(tag: SemanticTag, payload: string): void {
    // Only string values and object/array keys can contain non-ASCII text.
    const payloadBytes =
      tag === 'string' || tag === 'key' ? Buffer.byteLength(payload) : payload.length;
    const prefix = FRAME_PREFIXES[tag];
    const payloadLength = `${payloadBytes}:`;
    this.byteSize += prefix.length + payloadLength.length + payloadBytes;
    // Tags and length fields are ASCII. Keep the payload in its own update so
    // UTF-8 surrogate handling remains identical at each frame boundary.
    this.hash?.update(`${prefix}${payloadLength}`);
    this.hash?.update(payload);
  }

  digest(): string {
    if (!this.hash) throw new Error('Semantic identity digest was not requested.');
    return this.hash.digestHex();
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
  if (encoder.replayTree) {
    encoder.frame('subtree', replaySubtreeFingerprint(value));
    return;
  }
  // Only this module's deeply frozen values are safe to reuse. Count each
  // occurrence, including aliases, so replay eviction retains the same budget.
  const reusable = encoder.measuresOnly && ownedValues.has(value);
  const measured = reusable ? measuredSizes.get(value) : undefined;
  if (measured !== undefined) {
    encoder.byteSize += measured;
    return;
  }
  const before = encoder.byteSize;
  encodeObject(value, ancestors, encoder);
  if (reusable) measuredSizes.set(value, encoder.byteSize - before);
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
