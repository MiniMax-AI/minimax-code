import { getQuickJS } from 'quickjs-emscripten';
import type { QuickJSContext, QuickJSHandle } from 'quickjs-emscripten';

import {
  ptcToolCallLimitRefusal,
  type PtcFailure,
  type PtcToolDescriptor,
} from '../../execution/ptc/contracts.js';

export interface PtcQuickJsProgramInput {
  readonly code: string;
  readonly tools: readonly PtcToolDescriptor[];
  readonly maxHeapBytes: number;
  readonly maxComputeMs: number;
  readonly maxToolCalls: number;
  readonly signal: AbortSignal;
  onActivityChange?(active: boolean): void;
  /** Called once per call refused by the tool-call budget; the program keeps running. */
  onLimitExceeded?(budget: 'tool_calls'): void;
  /** One formatted console.* line (args joined by spaces); the caller owns the byte budget. */
  onConsole?(line: string): void;
  callTool(input: {
    readonly requestId: string;
    readonly name: string;
    readonly argsJson: string;
  }): Promise<string>;
}

/** Undefined fields the return value lost to JSON.stringify rules (first paths only). */
interface PtcReturnValueDrops {
  readonly droppedUndefinedPaths: readonly string[];
  readonly droppedUndefinedCount: number;
}

export type PtcQuickJsProgramResult =
  | ({
      readonly ok: true;
      /** Absent when the code returned no value. */
      readonly valueJson?: string;
      readonly pendingRequestIds: readonly string[];
    } & PtcReturnValueDrops)
  | {
      readonly ok: false;
      readonly error: PtcFailure;
      readonly pendingRequestIds: readonly string[];
    };

/**
 * Applies the console byte budget in the Worker: lines are forwarded while
 * they fit, then the part that still fits goes out once with `truncated` and
 * the rest is dropped, so a chatty loop can neither flood the bridge nor grow
 * the outer result.
 */
export function createPtcConsoleSink(
  maxBytes: number,
  emit: (text: string, truncated: boolean) => void,
): (line: string) => void {
  const encoder = new TextEncoder();
  let used = 0;
  let exhausted = false;
  return (line) => {
    if (exhausted) return;
    const encoded = encoder.encode(`${line}\n`);
    if (used + encoded.byteLength <= maxBytes) {
      used += encoded.byteLength;
      emit(`${line}\n`, false);
      return;
    }
    exhausted = true;
    const fitted = new TextDecoder().decode(encoded.slice(0, Math.max(0, maxBytes - used)), {
      stream: true,
    });
    used = maxBytes;
    emit(fitted, true);
  };
}

/** At most this many dropped-field paths travel to the host; the outer line lists up to 5. */
const MAX_REPORTED_DROPPED_PATHS = 5;

/** Runs one untrusted async function body in a fresh QuickJS runtime. */
export async function executePtcQuickJsProgram(
  input: PtcQuickJsProgramInput,
): Promise<PtcQuickJsProgramResult> {
  const quickJs = await getQuickJS();
  const runtime = quickJs.newRuntime();
  const context = runtime.newContext();
  const pending = new Map<string, ReturnType<typeof context.newPromise>>();
  // Refused calls whose result is still to be delivered from a host microtask
  // (see the refusal branch in __ptcCall). Kept apart from `pending`: they
  // never reached the bridge, so they are not unsettled child calls.
  const refusals = new Map<string, ReturnType<typeof context.newPromise>>();
  const pendingDeliveries = new Map<string, Promise<void>>();
  let rootHandle: QuickJSHandle | undefined;
  // Setup-script decoder that calls the JSON.parse saved before guest code
  // ran; see resolveDecoded.
  let decodeHandle: QuickJSHandle | undefined;
  let stopped = input.signal.aborted;
  let computeElapsedMs = 0;
  let computeStartedAtMs: number | undefined;
  let callCount = 0;
  let pumping = false;

  const checkInterrupted = () => {
    if (stopped || input.signal.aborted) return true;
    return currentComputeMs() >= input.maxComputeMs;
  };
  const pump = () => {
    if (pumping || stopped) return;
    pumping = true;
    try {
      measureCompute(() => {
        const result = runtime.executePendingJobs();
        if ('error' in result && result.error) result.error.dispose();
      });
    } finally {
      pumping = false;
    }
  };
  const rejectPending = (message: string) => {
    for (const deferred of pending.values()) {
      if (!deferred.alive) continue;
      const error = context.newError(message);
      deferred.reject(error);
      error.dispose();
    }
    pump();
  };
  const abort = () => {
    stopped = true;
    rejectPending('PTC execution stopped.');
  };

  runtime.setMemoryLimit(input.maxHeapBytes);
  runtime.setInterruptHandler(checkInterrupted);
  input.signal.addEventListener('abort', abort, { once: true });

  try {
    const names = new Set(input.tools.map((tool) => tool.name));
    const callback = context.newFunction('__ptcCall', (nameHandle, argsHandle) => {
      const deferred = context.newPromise();
      try {
        const name = context.getString(nameHandle);
        const argsJson = context.getString(argsHandle);
        if (!names.has(name)) throw new Error(`Tool is not available to PTC: ${name}`);
        if (stopped || input.signal.aborted) throw new Error('PTC execution stopped.');
        const requestId = `ptc-${++callCount}`;
        if (callCount > input.maxToolCalls) {
          // Over the budget the call is refused without running, and the program
          // keeps going: earlier results stay usable instead of being discarded
          // with a stopped program. The host counts each refusal for the outer note.
          input.onLimitExceeded?.('tool_calls');
          // Delivered from a host microtask, never inside this callback: guest
          // frames are on the stack here, and resolving with an object looks
          // up `then` on it, which guest code can turn into an accessor that
          // calls tools again and so re-enters this callback without bound
          // (the runtime then aborts at teardown with
          // list_empty(&rt->gc_obj_list) and the result is lost). From a
          // microtask such an accessor runs once per refusal, within the
          // compute budget.
          refusals.set(requestId, deferred);
          queueMicrotask(() => settleRefusal(requestId));
          return deferred.handle;
        }
        pending.set(requestId, deferred);
        const delivery: Promise<void> = (async () => {
          try {
            settleDeferred(
              requestId,
              deferred,
              await input.callTool({ requestId, name, argsJson }),
            );
          } catch (error) {
            rejectDeferred(requestId, deferred, error);
          } finally {
            pendingDeliveries.delete(requestId);
          }
        })();
        pendingDeliveries.set(requestId, delivery);
      } catch (error) {
        const handle = guestErrorHandle(context, error);
        deferred.reject(handle);
        handle.dispose();
      }
      return deferred.handle;
    });
    context.setProp(context.global, '__ptcCall', callback);
    callback.dispose();
    // Console output leaves the guest at once, so it survives a later guest
    // error or a host stop; the Worker applies the byte budget.
    const consoleCallback = context.newFunction('__ptcConsole', (lineHandle) => {
      if (!stopped) input.onConsole?.(readConsoleLine(context, lineHandle));
    });
    context.setProp(context.global, '__ptcConsole', consoleCallback);
    consoleCallback.dispose();
    const setup = measureCompute(() =>
      evaluate(context, createToolsSetup(input.tools.map((tool) => tool.name)), 'ptc_runtime.js'),
    );
    setup.dispose();
    // The setup script leaves its decoder on the global object only long
    // enough for the host to take a handle; guest code never sees it.
    decodeHandle = context.getProp(context.global, '__ptcDecodeForHost');
    evaluate(context, 'delete globalThis.__ptcDecodeForHost;', 'ptc_runtime.js').dispose();
    rootHandle = measureCompute(() => evaluate(context, wrapCode(input.code), 'run_code.js'));
    const rootResult = context.resolvePromise(rootHandle);
    pump();
    const resolved = await rootResult;
    const valueHandle = unwrap(context, resolved);
    try {
      return {
        ok: true,
        ...readEncodedResult(context, valueHandle),
        pendingRequestIds: [...pending.keys()],
      };
    } finally {
      valueHandle.dispose();
    }
  } catch (error) {
    return {
      ok: false,
      error: guestFailure(
        error,
        stopped || input.signal.aborted,
        currentComputeMs() >= input.maxComputeMs,
      ),
      pendingRequestIds: [...pending.keys()],
    };
  } finally {
    input.signal.removeEventListener('abort', abort);
    stopped = true;
    pendingDeliveries.clear();
    rejectPending('PTC execution ended.');
    rootHandle?.dispose();
    decodeHandle?.dispose();
    for (const deferred of pending.values()) if (deferred.alive) deferred.dispose();
    // A refusal still waiting for its microtask holds QuickJS handles too.
    for (const deferred of refusals.values()) if (deferred.alive) deferred.dispose();
    refusals.clear();
    context.dispose();
    runtime.dispose();
  }

  /**
   * Delivers a refused call's result after the guest call returned (see the
   * refusal branch in __ptcCall). A program that already ended disposed the
   * deferred in its finally block; a stopped one never resumes, so only the
   * handles are freed.
   */
  function settleRefusal(requestId: string): void {
    const deferred = refusals.get(requestId);
    if (!deferred) return;
    refusals.delete(requestId);
    if (stopped) {
      deferred.dispose();
      return;
    }
    const refusal = ptcToolCallLimitRefusal(requestId, input.maxToolCalls);
    settleDeferred(requestId, deferred, JSON.stringify(refusal));
  }

  function settleDeferred(
    requestId: string,
    deferred: ReturnType<typeof context.newPromise>,
    resultJson: string,
  ): void {
    pending.delete(requestId);
    if (stopped || !deferred.alive) return;
    measureCompute(() => resolveDecoded(context, decodeHandle, deferred, resultJson));
    deferred.dispose();
    queueMicrotask(pump);
  }

  function rejectDeferred(
    requestId: string,
    deferred: ReturnType<typeof context.newPromise>,
    error: unknown,
  ): void {
    pending.delete(requestId);
    if (stopped || !deferred.alive) return;
    const handle = guestErrorHandle(context, error);
    deferred.reject(handle);
    handle.dispose();
    deferred.dispose();
    queueMicrotask(pump);
  }

  function measureCompute<T>(operation: () => T): T {
    const startedAt = performance.now();
    computeStartedAtMs = startedAt;
    input.onActivityChange?.(true);
    try {
      return operation();
    } finally {
      computeElapsedMs += performance.now() - startedAt;
      computeStartedAtMs = undefined;
      input.onActivityChange?.(false);
    }
  }

  function currentComputeMs(): number {
    return (
      computeElapsedMs +
      (computeStartedAtMs === undefined ? 0 : performance.now() - computeStartedAtMs)
    );
  }
}

function evaluate(context: QuickJSContext, source: string, fileName: string): QuickJSHandle {
  return unwrap(context, context.evalCode(source, fileName));
}

/**
 * Settles a guest call with the parsed result. JSON.parse runs in a direct
 * host-to-guest call, not in a promise job (the former `.then(JSON.parse)`):
 * with quickjs-emscripten 0.31, parsing a string of about 4 MB or more inside
 * a job leaks QuickJS objects, so freeing the runtime aborts the Worker with
 * "Assertion failed: list_empty(&rt->gc_obj_list)" after the program already
 * finished and its result is lost. Sixteen parallel ~1 MiB glob results hit
 * it; the same parse in a direct call frees cleanly. The decoder calls the
 * JSON.parse saved before guest code ran, so decoding itself never runs guest
 * code. Only called from host microtasks, never inside a guest-to-host
 * callback: resolving with an object looks up `then` on it, and a guest
 * accessor there must not be able to re-enter the callback. The caller
 * measures compute time.
 */
function resolveDecoded(
  context: QuickJSContext,
  decoder: QuickJSHandle | undefined,
  deferred: ReturnType<QuickJSContext['newPromise']>,
  resultJson: string,
): void {
  if (!decoder) throw new Error('PTC result decoder is not ready.');
  const text = context.newString(resultJson);
  let decoded: ReturnType<QuickJSContext['callFunction']>;
  try {
    decoded = context.callFunction(decoder, context.undefined, text);
  } finally {
    text.dispose();
  }
  if ('value' in decoded) {
    deferred.resolve(decoded.value);
    decoded.value.dispose();
    return;
  }
  // Invalid JSON, or the guest heap or compute budget running out while
  // parsing: the guest sees that error on this call, as with the former
  // promise-job parse, and the program decides what to do with it.
  deferred.reject(decoded.error);
  decoded.error.dispose();
}

/** Shown instead of a console line that was not a primitive string. */
const DROPPED_CONSOLE_LINE = '[PTC dropped a console line that was not a string]';

/**
 * Only a primitive string is read. getString on anything else runs the
 * guest's toString inside the console host callback, where it can log again
 * and re-enter without bound. The setup formatter always passes a string
 * unless guest code replaced Array.prototype.map or join; the marker line
 * keeps such a drop visible in the outer result.
 */
function readConsoleLine(context: QuickJSContext, handle: QuickJSHandle): string {
  return context.typeof(handle) === 'string' ? context.getString(handle) : DROPPED_CONSOLE_LINE;
}

function unwrap(
  context: QuickJSContext,
  result: { readonly value: QuickJSHandle } | { readonly error: QuickJSHandle },
): QuickJSHandle {
  if ('value' in result) return result.value;
  const failure = result.error;
  if (!failure) throw new Error('QuickJS returned an empty failure.');
  try {
    throw new Error(guestErrorText(context.dump(failure)));
  } finally {
    failure.dispose();
  }
}

const GUEST_UNSAFE_CHARS: Record<string, string> = {
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

/** JSON string literal with the characters that can break out of code escaped. */
function toGuestStringLiteral(value: string): string {
  return JSON.stringify(value).replace(/[<>/\u2028\u2029]/gu, (char) => GUEST_UNSAFE_CHARS[char] ?? char);
}

function createToolsSetup(names: readonly string[]): string {
  const definitions = names
    .map(
      (name) =>
        `Object.defineProperty(__ptcTools, ${toGuestStringLiteral(name)}, { enumerable: true, value: (args) => __ptcCall(${toGuestStringLiteral(name)}, __ptcEncodeArgs(args)) });`,
    )
    .join('\n');
  // The JSON boundary follows JSON.stringify (undefined fields dropped, array
  // holes/undefined/NaN/Infinity become null, functions dropped, toJSON
  // honoured) because models write code that relies on it. What JSON.stringify
  // would turn into silent garbage still fails, naming the field path: cycles,
  // BigInt, and class instances such as Map or Set (they would become {}).
  return `
const __ptcTools = Object.create(null);
const __ptcUnsafeKeys = new Set(["__proto__", "constructor", "prototype"]);
const __ptcUndefined = Symbol("undefined");
const __ptcSkipped = Symbol("skipped");
const __ptcIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const __ptcMaxDepth = 100;
const __ptcMaxReportedDrops = ${MAX_REPORTED_DROPPED_PATHS};
const __ptcChildPath = (path, key) => typeof key === "number"
  ? path + "[" + key + "]"
  : __ptcIdentifier.test(key) ? path + "." + key : path + "[" + JSON.stringify(key) + "]";
const __ptcUnsupported = (value) => {
  if (value instanceof Map) return "Map is not JSON data; convert it with Object.fromEntries(map)";
  if (value instanceof Set) return "Set is not JSON data; convert it with Array.from(set)";
  if (value instanceof Promise) return "a Promise is not JSON data; await it first";
  let name = "Object";
  try {
    const candidate = Object.getPrototypeOf(value)?.constructor?.name;
    if (typeof candidate === "string" && candidate) name = candidate;
  } catch {}
  return name + " instance is not JSON data; use plain objects and arrays";
};
const __ptcToJsonData = (root, label) => {
  const seen = new Set();
  const dropped = [];
  let droppedCount = 0;
  const fail = (path, reason) => {
    throw new TypeError(label + " not JSON-serializable at " + path + ": " + reason);
  };
  const visit = (key, input, path, depth) => {
    let value = input;
    if ((typeof value === "object" && value !== null) || typeof value === "bigint") {
      const toJSON = value.toJSON;
      if (typeof toJSON === "function") value = toJSON.call(value, String(key));
    }
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (value === undefined) return __ptcUndefined;
    if (typeof value === "function" || typeof value === "symbol") return __ptcSkipped;
    if (typeof value === "bigint") fail(path, "BigInt is not JSON data; convert it with String() or Number()");
    if (value instanceof Number) return visit(key, Number(value), path, depth);
    if (value instanceof String) return String(value);
    if (value instanceof Boolean) return value.valueOf();
    if (depth >= __ptcMaxDepth) fail(path, "nesting is deeper than " + __ptcMaxDepth + " levels");
    if (seen.has(value)) fail(path, "circular reference");
    seen.add(value);
    let output;
    if (Array.isArray(value)) {
      output = [];
      for (let index = 0; index < value.length; index += 1) {
        const item = visit(index, value[index], __ptcChildPath(path, index), depth + 1);
        output.push(typeof item === "symbol" ? null : item);
      }
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) fail(path, __ptcUnsupported(value));
      output = {};
      for (const name of Object.keys(value)) {
        const childPath = __ptcChildPath(path, name);
        if (__ptcUnsafeKeys.has(name)) fail(childPath, "unsafe property name");
        const item = visit(name, value[name], childPath, depth + 1);
        if (item === __ptcUndefined) {
          droppedCount += 1;
          if (dropped.length < __ptcMaxReportedDrops) dropped.push(childPath);
          continue;
        }
        if (item === __ptcSkipped) continue;
        output[name] = item;
      }
    }
    seen.delete(value);
    return output;
  };
  return { value: visit("", root, "$", 0), dropped, droppedCount };
};
const __ptcEncodeArgs = (args) => {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw new TypeError("PTC tool arguments must be an object.");
  }
  const encoded = __ptcToJsonData(args, "PTC tool arguments are");
  if (encoded.value === null || typeof encoded.value !== "object" || Array.isArray(encoded.value)) {
    throw new TypeError("PTC tool arguments must be an object.");
  }
  return JSON.stringify(encoded.value);
};
// No return (undefined) is a valid outcome: the outer result then says
// "No return value." instead of failing a program that already did its work.
const __ptcEncodeResult = (value) => {
  if (value === undefined) return { json: undefined, dropped: [], droppedCount: 0 };
  const encoded = __ptcToJsonData(value, "PTC return value is");
  if (encoded.value === __ptcUndefined) return { json: undefined, dropped: [], droppedCount: 0 };
  if (encoded.value === __ptcSkipped) {
    throw new TypeError("PTC return value is not JSON-serializable at $: a function is not JSON data");
  }
  return { json: JSON.stringify(encoded.value), dropped: encoded.dropped, droppedCount: encoded.droppedCount };
};
// console.*: arguments joined by spaces, strings as is, other values as JSON.
const __ptcFormat = (value) => {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.name + ": " + value.message;
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {}
  try {
    return String(value);
  } catch {
    return "[unprintable]";
  }
};
const __ptcConsoleSink = globalThis.__ptcConsole;
const __ptcLog = (...args) => {
  __ptcConsoleSink(args.map(__ptcFormat).join(" "));
};
// Saved before any guest code runs. The host calls the decoder directly, so it
// must never run code the guest can replace: a JSON.parse replaced with a
// function that called tools again re-entered the host without bound and broke
// runtime teardown. JSON.parse without a reviver creates properties with
// CreateDataProperty, so no prototype setter runs either. As a consequence a
// guest that replaces or removes JSON still receives the real tool results.
// (A const: guest code can see the binding but cannot rebind it.)
const __ptcJsonParse = JSON.parse;
// The host takes this decoder and deletes the global before guest code runs;
// results are parsed by a direct host call, never in a promise job.
globalThis.__ptcDecodeForHost = (json) => __ptcJsonParse(json);
${definitions}
Object.freeze(__ptcTools);
globalThis.tools = __ptcTools;
globalThis.console = Object.freeze({ log: __ptcLog, info: __ptcLog, warn: __ptcLog, error: __ptcLog, debug: __ptcLog });
// Codex code mode habits. Models write text(r.output) and, after reading an
// image, image(r.data.content); in the 969645 eval 168 programs failed with
// "'text' is not defined" (99) or "'image' is not defined" (69, all GDPval63).
// text() logs exactly like console.log. image() returns its argument: images a
// tool read are already attached to the run_code result (media-projection.ts,
// also when the program fails), so it only has to not throw. Plain writable
// globals, so a program's own const/let/function or assignment still wins.
// Deliberately not in the run_code description or PTC section.
globalThis.text = __ptcLog;
globalThis.image = (value) => value;
delete globalThis.__ptcConsole;
delete globalThis.process;
delete globalThis.require;
delete globalThis.fetch;
delete globalThis.setTimeout;
delete globalThis.setInterval;
`;
}

/**
 * Reads the `{ json, dropped, droppedCount }` envelope built by
 * `__ptcEncodeResult`. Guest code can monkeypatch JSON or Array globals, so
 * every field is validated here instead of being trusted.
 */
function readEncodedResult(
  context: QuickJSContext,
  handle: QuickJSHandle,
): { readonly valueJson?: string } & PtcReturnValueDrops {
  const json = readProp(context, handle, 'json');
  if (json === undefined) return { droppedUndefinedPaths: [], droppedUndefinedCount: 0 };
  if (typeof json !== 'string') throw new Error('PTC returned a value that is not JSON text.');
  const dropped = readProp(context, handle, 'dropped');
  const droppedCount = readProp(context, handle, 'droppedCount');
  const paths = Array.isArray(dropped)
    ? dropped.filter((path): path is string => typeof path === 'string')
    : [];
  return {
    valueJson: json,
    droppedUndefinedPaths: paths.slice(0, MAX_REPORTED_DROPPED_PATHS),
    droppedUndefinedCount:
      typeof droppedCount === 'number' && Number.isSafeInteger(droppedCount) && droppedCount >= 0
        ? Math.max(droppedCount, paths.length)
        : paths.length,
  };
}

function readProp(context: QuickJSContext, handle: QuickJSHandle, key: string): unknown {
  const property = context.getProp(handle, key);
  try {
    return context.dump(property);
  } finally {
    property.dispose();
  }
}

function wrapCode(code: string): string {
  return `(async () => {\n${code}\n})().then(__ptcEncodeResult)`;
}

function guestFailure(error: unknown, stopped: boolean, computeExceeded: boolean): PtcFailure {
  if (computeExceeded) {
    return {
      code: 'compute_budget_exceeded',
      message: 'PTC exceeded its JavaScript compute budget.',
    };
  }
  if (stopped) return { code: 'cancelled', message: 'PTC execution was stopped.' };
  return { code: 'guest_error', message: scrubGuestError(errorMessage(error)) };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return guestErrorText(error);
}

function guestErrorHandle(context: QuickJSContext, error: unknown): QuickJSHandle {
  const handle = context.newError(errorMessage(error));
  const failure = readPtcFailure(error);
  if (!failure) return handle;
  for (const [key, value] of [
    ['code', failure.code],
    ['toolCallId', failure.toolCallId],
    ['retryable', failure.retryable],
  ] as const) {
    if (value === undefined) continue;
    const property =
      typeof value === 'boolean' ? booleanHandle(context, value) : context.newString(value);
    context.setProp(handle, key, property);
    if (typeof value !== 'boolean') property.dispose();
  }
  return handle;
}

function booleanHandle(context: QuickJSContext, value: boolean): QuickJSHandle {
  return value ? context.true : context.false;
}

function readPtcFailure(
  error: unknown,
):
  | { readonly code: string; readonly toolCallId?: string; readonly retryable?: boolean }
  | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const failure = Reflect.get(error, 'failure');
  if (!failure || typeof failure !== 'object') return undefined;
  const code = Reflect.get(failure, 'code');
  if (typeof code !== 'string' || !code) return undefined;
  const toolCallId = Reflect.get(failure, 'toolCallId');
  const retryable = Reflect.get(failure, 'retryable');
  return {
    code,
    ...(typeof toolCallId === 'string' && toolCallId ? { toolCallId } : {}),
    ...(typeof retryable === 'boolean' ? { retryable } : {}),
  };
}

function guestErrorText(error: unknown): string {
  if (error && typeof error === 'object') {
    const message = Reflect.get(error, 'message');
    const stack = Reflect.get(error, 'stack');
    if (typeof message === 'string' && typeof stack === 'string') return `${message}\n${stack}`;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function scrubGuestError(message: string): string {
  return message
    .replace(/file:\/\/[^\s)]+/g, 'run_code.js')
    .split('\n')
    .filter(
      (line) =>
        !line.includes('ptc_runtime.js') &&
        !line.includes('__ptcEncodeResult') &&
        !/^\s*at <eval> \(run_code\.js:\d+(?::\d+)?\)\s*$/.test(line),
    )
    .join('\n')
    .replace(/run_code\.js:(\d+)(?::(\d+))?/g, (_match, line, column) => {
      const adjustedLine = Math.max(1, Number(line) - 1);
      return `run_code.js:${adjustedLine}${column ? `:${column}` : ''}`;
    });
}
