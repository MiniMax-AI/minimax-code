import { getQuickJS } from 'quickjs-emscripten';
import type {
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSRuntime,
} from 'quickjs-emscripten';

import { settleInBackground } from '../../../infra/async/settle.js';
import { BROWSER_PROGRAM_GUEST_SETUP } from './guest-library.js';
import { locateGuestSyntaxError } from './guest/syntax-error.js';
import {
  clearHostSleeps,
  GUEST_TIMERS_SETUP,
  installHostSleep,
  type HostSleeps,
} from './guest/timers.js';
import type { BrowserProgramFailure, BrowserProgramStateCapture } from './worker-protocol.js';

/** The program file name in guest stack traces; its line 1 is the wrapper. */
const PROGRAM_FILE = 'program.js';
const SETUP_FILE = 'browser_program_runtime.js';
const DISPOSE_FAILURE_MESSAGE_MAX_CHARS = 200;

export interface BrowserProgramRuntimeInput {
  readonly code: string;
  readonly initialStateJson?: string;
  readonly maxHeapBytes: number;
  /** Unix ms; the interrupt handler stops guest JavaScript after it. */
  readonly deadlineAt: number;
  /** One page operation: the op as JSON in, the op result as JSON out. */
  callOp(opJson: string): Promise<string>;
  onConsole(line: string): void;
  /** Why freeing QuickJS failed after the result was computed; called at most once. */
  onDisposeFailed?(message: string): void;
}

export type BrowserProgramRuntimeResult =
  | {
      readonly ok: true;
      /** Absent when the program returned nothing. */
      readonly valueJson?: string;
      readonly state: BrowserProgramStateCapture;
    }
  | {
      readonly ok: false;
      readonly error: BrowserProgramFailure;
      readonly state?: BrowserProgramStateCapture;
    };

/**
 * Settles a guest promise with a parsed JSON answer by a direct host call (the
 * decoder is the JSON.parse saved before guest code ran), never in a promise
 * job: run_code found that a parse of several MB inside a job leaks QuickJS
 * objects in quickjs-emscripten 0.31 (quickjs-runtime.ts, settleDecoded).
 */
function resolveJson(
  context: QuickJSContext,
  decoder: QuickJSHandle,
  deferred: QuickJSDeferredPromise,
  json: string,
): void {
  const text = context.newString(json);
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
  deferred.reject(decoded.error);
  decoded.error.dispose();
}

function wrapProgram(code: string): string {
  // The program is an async function body; the outcome is always an object,
  // so the host never has to unwrap a guest exception. Promises left in the
  // return value (`return { url: page.url() }`) are awaited first.
  return `(async () => {\n${code}\n})().then(__programSettle).then((value) => ({ ok: true, json: __programEncode(value, "The return value") }), (error) => ({ ok: false, error: __programDescribe(error) })).catch((error) => ({ ok: false, error: __programDescribe(error) }))`;
}

/** Helpers the setup script defines before the library; guest code cannot reach the host's copies. */
const PRELUDE = String.raw`
const __programParse = JSON.parse;
const __programStringify = JSON.stringify;
globalThis.__programDecode = (json) => __programParse(json);
const __programSettle = async (value, depth = 0) => {
  const item = await value;
  if (depth >= 4 || item === null || typeof item !== 'object' || typeof item.toJSON === 'function') return item;
  if (Array.isArray(item)) return Promise.all(item.map((entry) => __programSettle(entry, depth + 1)));
  if (Object.getPrototypeOf(item) !== Object.prototype) return item;
  const out = {};
  for (const name of Object.keys(item)) out[name] = await __programSettle(item[name], depth + 1);
  return out;
};
const __programEncode = (value, label) => {
  if (value === undefined) return undefined;
  const seen = new Set();
  const visit = (key, input, path) => {
    let item = input;
    if (item !== null && typeof item === 'object' && typeof item.toJSON === 'function') item = item.toJSON(key);
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') return Number.isFinite(item) ? item : null;
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') return undefined;
    if (typeof item === 'bigint') throw new TypeError(label + ' is not JSON at ' + path + ': BigInt; convert it with String() or Number().');
    if (item instanceof Map) throw new TypeError(label + ' is not JSON at ' + path + ': a Map; convert it with Object.fromEntries(map).');
    if (item instanceof Set) throw new TypeError(label + ' is not JSON at ' + path + ': a Set; convert it with Array.from(set).');
    if (item instanceof Promise) throw new TypeError(label + ' is not JSON at ' + path + ': a Promise; await it first.');
    if (seen.has(item)) throw new TypeError(label + ' is not JSON at ' + path + ': a circular reference.');
    seen.add(item);
    let out;
    if (Array.isArray(item)) {
      out = item.map((entry, index) => { const next = visit(String(index), entry, path + '[' + index + ']'); return next === undefined ? null : next; });
    } else {
      out = {};
      for (const name of Object.keys(item)) {
        const next = visit(name, item[name], path + '.' + name);
        if (next !== undefined) out[name] = next;
      }
    }
    seen.delete(item);
    return out;
  };
  const plain = visit('', value, '$');
  return plain === undefined ? undefined : __programStringify(plain);
};
const __programDescribe = (error) => {
  if (error && typeof error === 'object') {
    const read = (key) => { try { const v = error[key]; return typeof v === 'string' ? v : undefined; } catch { return undefined; } };
    return { name: read('name') || 'Error', message: read('message') || String(error), code: read('code'), recovery: read('recovery'), stack: read('stack') };
  }
  return { name: 'Error', message: String(error) };
};
globalThis.__programEncodeState = () => __programEncode(globalThis.state === undefined ? {} : globalThis.state, 'state');
`;

/** The program line of a guest stack trace: the wrapper adds one line before the body. */
function programLine(stack: string | undefined): number | undefined {
  const match = stack
    ? new RegExp(`${PROGRAM_FILE.replace('.', '\\.')}:(\\d+)`, 'u').exec(stack)
    : null;
  const line = match ? Number(match[1]) - 1 : undefined;
  return line !== undefined && line >= 1 ? line : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value ? value : undefined;
}

const TIMEOUT_FAILURE: BrowserProgramFailure = {
  kind: 'timeout',
  name: 'TimeoutError',
  message: 'The program ran past its time limit.',
};

function failureKind(
  message: string,
  name: string,
  code: string | undefined,
): BrowserProgramFailure['kind'] {
  if (/out of memory/iu.test(message) || (name === 'InternalError' && /memory/iu.test(message))) {
    return 'memory';
  }
  return code ? 'browser' : 'guest';
}

/** A guest exception or engine failure in the shape the host reports. */
function describeFailure(raw: unknown, interrupted: boolean): BrowserProgramFailure {
  if (interrupted) return TIMEOUT_FAILURE;
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const message = readString(record, 'message') ?? String(raw);
  const name = readString(record, 'name') ?? 'Error';
  const code = readString(record, 'code');
  const recovery = readString(record, 'recovery');
  const line = programLine(readString(record, 'stack'));
  return {
    kind: failureKind(message, name, code),
    name,
    message,
    ...(code ? { code } : {}),
    ...(recovery ? { recovery } : {}),
    ...(line !== undefined ? { line } : {}),
  };
}

/** A program that did not compile: QuickJS's failure with its line, column and code. */
function withSyntaxLocation(failure: BrowserProgramFailure, code: string): BrowserProgramFailure {
  if (failure.name !== 'SyntaxError') return failure;
  const found = locateGuestSyntaxError(code, {
    message: failure.message,
    ...(failure.line === undefined ? {} : { line: failure.line }),
  });
  return {
    ...failure,
    message: found.message,
    line: found.line,
    ...(found.column === undefined ? {} : { column: found.column }),
    snippet: found.snippet,
  };
}

/** One program's QuickJS runtime: the host functions, the limits and the run. */
class BrowserProgramSandbox {
  private readonly pending = new Set<QuickJSDeferredPromise>();
  private readonly sleeps: HostSleeps = new Map();
  private decoder: QuickJSHandle | undefined;
  private encodeState: QuickJSHandle | undefined;
  private root: QuickJSHandle | undefined;
  private ended = false;
  private interrupted = false;
  private notifyInterrupted: (() => void) | undefined;
  private readonly interruption = new Promise<undefined>((resolve) => {
    this.notifyInterrupted = () => resolve(undefined);
  });

  constructor(
    private readonly runtime: QuickJSRuntime,
    private readonly context: QuickJSContext,
    private readonly input: BrowserProgramRuntimeInput,
  ) {
    runtime.setMemoryLimit(input.maxHeapBytes);
    runtime.setMaxStackSize(1024 * 1024);
    runtime.setInterruptHandler(() => {
      if (!this.interrupted && Date.now() > input.deadlineAt) {
        this.interrupted = true;
        this.notifyInterrupted?.();
      }
      return this.interrupted;
    });
  }

  private get stopped(): boolean {
    return this.ended || this.interrupted;
  }

  private readonly pump = (): void => {
    if (this.stopped) return;
    const result = this.runtime.executePendingJobs();
    if ('error' in result && result.error) result.error.dispose();
  };

  private settleLater(deferred: QuickJSDeferredPromise, settle: () => void): void {
    // From a host task, never inside the guest-to-host callback.
    queueMicrotask(() => {
      this.pending.delete(deferred);
      if (this.stopped || !deferred.alive) return;
      settle();
      deferred.dispose();
      this.pump();
    });
  }

  private async answerOp(deferred: QuickJSDeferredPromise, opJson: string): Promise<void> {
    let resultJson: string;
    try {
      resultJson = await this.input.callOp(opJson);
    } catch (error) {
      this.settleLater(deferred, () => {
        const handle = this.context.newError(
          error instanceof Error ? error.message : String(error),
        );
        deferred.reject(handle);
        handle.dispose();
      });
      return;
    }
    this.settleLater(deferred, () => {
      if (this.decoder) resolveJson(this.context, this.decoder, deferred, resultJson);
    });
  }

  installHost(): void {
    const { context, input } = this;
    const opCallback = context.newFunction('__programOp', (opHandle) => {
      const deferred = context.newPromise();
      this.pending.add(deferred);
      settleInBackground(this.answerOp(deferred, context.getString(opHandle)));
      return deferred.handle;
    });
    context.setProp(context.global, '__programOp', opCallback);
    opCallback.dispose();
    installHostSleep(context, this.sleeps, () => this.stopped, this.pump);
    const consoleCallback = context.newFunction('__programConsole', (lineHandle) => {
      // Only a primitive string is read: getString on anything else would run guest code here.
      if (!this.ended && context.typeof(lineHandle) === 'string') {
        input.onConsole(context.getString(lineHandle));
      }
    });
    context.setProp(context.global, '__programConsole', consoleCallback);
    consoleCallback.dispose();
    if (input.initialStateJson !== undefined) {
      const initial = context.newString(input.initialStateJson);
      context.setProp(context.global, '__programInitialState', initial);
      initial.dispose();
    }
  }

  setup(): void {
    const { context } = this;
    const setup = context.evalCode(
      `${PRELUDE}\n${GUEST_TIMERS_SETUP}\n${BROWSER_PROGRAM_GUEST_SETUP}`,
      SETUP_FILE,
    );
    if ('error' in setup && setup.error) {
      const failure = context.dump(setup.error);
      setup.error.dispose();
      throw new Error(`Browser program setup failed: ${JSON.stringify(failure)}`);
    }
    setup.value.dispose();
    this.decoder = context.getProp(context.global, '__programDecode');
    this.encodeState = context.getProp(context.global, '__programEncodeState');
    const hide = context.evalCode(
      'delete globalThis.__programDecode; delete globalThis.__programEncodeState;',
      SETUP_FILE,
    );
    if ('value' in hide) hide.value.dispose();
    else hide.error.dispose();
  }

  async run(code: string): Promise<BrowserProgramRuntimeResult> {
    const { context } = this;
    const evaluated = context.evalCode(wrapProgram(code), PROGRAM_FILE);
    if ('error' in evaluated && evaluated.error) {
      const raw = context.dump(evaluated.error);
      evaluated.error.dispose();
      return { ok: false, error: withSyntaxLocation(this.describe(raw), code) };
    }
    this.root = evaluated.value;
    const settled = context.resolvePromise(this.root);
    this.pump();
    const outcome = await Promise.race([settled, this.interruption]);
    if (!outcome || this.interrupted) return { ok: false, error: TIMEOUT_FAILURE };
    if ('error' in outcome && outcome.error) {
      const raw = context.dump(outcome.error);
      outcome.error.dispose();
      return { ok: false, error: this.describe(raw) };
    }
    const value = context.dump(outcome.value) as Record<string, unknown>;
    outcome.value.dispose();
    const state = this.captureState();
    if (value.ok !== true) return { ok: false, error: describeFailure(value.error, false), state };
    return {
      ok: true,
      ...(typeof value.json === 'string' ? { valueJson: value.json } : {}),
      state,
    };
  }

  describe(raw: unknown): BrowserProgramFailure {
    return describeFailure(raw, this.interrupted);
  }

  /** `state` as JSON once the program has ended; a failure keeps the earlier state. */
  private captureState(): BrowserProgramStateCapture {
    const { context, encodeState } = this;
    if (!encodeState || this.interrupted) return { error: 'the program was stopped' };
    const encoded = context.callFunction(encodeState, context.undefined);
    if ('error' in encoded && encoded.error) {
      const raw = context.dump(encoded.error) as Record<string, unknown> | undefined;
      encoded.error.dispose();
      return { error: readString(raw ?? {}, 'message') ?? 'state is not JSON data' };
    }
    const handle = encoded.value;
    const json = context.typeof(handle) === 'string' ? context.getString(handle) : undefined;
    handle.dispose();
    return json === undefined ? { error: 'state is not JSON data' } : { json };
  }

  /**
   * Frees the guest. JS_FreeRuntime can abort ("Assertion failed:
   * list_empty(&rt->gc_obj_list)") after a program stopped at its time or
   * memory limit past an await, and it used to throw out of
   * runBrowserProgram's `finally`: the result already computed (the limit, or
   * a return value and state) became a runtime crash. As PTC's disposeGuest:
   * the Worker ends right after, so a failed teardown only gives up memory
   * the process releases anyway, the result stands, and the first failure is
   * reported. The runtime is freed even when the context could not be.
   */
  dispose(): void {
    this.ended = true;
    let failure: unknown;
    try {
      for (const deferred of this.sleeps.values()) if (deferred.alive) deferred.dispose();
      clearHostSleeps(this.sleeps);
      for (const deferred of this.pending) if (deferred.alive) deferred.dispose();
      this.root?.dispose();
      this.decoder?.dispose();
      this.encodeState?.dispose();
      this.context.dispose();
    } catch (error) {
      failure = error;
    }
    try {
      this.runtime.dispose();
    } catch (error) {
      failure ??= error;
    }
    if (failure === undefined) return;
    const message = failure instanceof Error ? failure.message : String(failure);
    this.input.onDisposeFailed?.(message.slice(0, DISPOSE_FAILURE_MESSAGE_MAX_CHARS));
  }
}

/** Runs one Browser program in a fresh QuickJS runtime on this (Worker) thread. */
export async function runBrowserProgram(
  input: BrowserProgramRuntimeInput,
): Promise<BrowserProgramRuntimeResult> {
  const quickJs = await getQuickJS();
  const runtime = quickJs.newRuntime();
  const sandbox = new BrowserProgramSandbox(runtime, runtime.newContext(), input);
  try {
    sandbox.installHost();
    sandbox.setup();
    return await sandbox.run(input.code);
  } catch (error) {
    return { ok: false, error: sandbox.describe(error) };
  } finally {
    sandbox.dispose();
  }
}
