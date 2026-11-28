import { modifierBit, platformModifier, splitKeyCombo } from '../browser-action-helpers.js';
import { isRecord } from '../browser-state.js';
import { BrowserProgramError } from './errors.js';

/**
 * The internal page-operation protocol of run_code programs. Programs never
 * see it: the sandbox library turns each Playwright-style call into one op and
 * the host hands it to `BrowserCoreSession.executeOp`. A locator is plain data,
 * resolved again by a fixed page script on every use, so it can be saved in
 * the program's `state` between run_code calls.
 */

/** A string to match, or a regular expression the sandbox encoded as data. */
export type ProgramTextMatch = string | { readonly regex: string; readonly flags?: string };

export type ProgramLocatorStep =
  | {
      readonly by: 'role';
      readonly role: string;
      readonly name?: ProgramTextMatch;
      readonly exact?: boolean;
    }
  | {
      readonly by: 'text' | 'label' | 'placeholder';
      readonly value: ProgramTextMatch;
      readonly exact?: boolean;
    }
  | { readonly by: 'css'; readonly selector: string }
  | { readonly by: 'ref'; readonly ref: string }
  | { readonly by: 'nth'; readonly index: number }
  | {
      readonly by: 'filter';
      readonly hasText?: ProgramTextMatch;
      readonly hasNotText?: ProgramTextMatch;
      readonly visible?: boolean;
    }
  /**
   * A selector list (`a:has-text("Go"), button`): each chain runs from the
   * matches so far, and their matches together, in document order, go on.
   */
  | { readonly by: 'or'; readonly chains: readonly (readonly ProgramLocatorStep[])[] };

export interface ProgramLocator {
  readonly tabId?: number;
  readonly chain: readonly ProgramLocatorStep[];
}

export type ProgramReadWhat =
  | 'text'
  | 'innerText'
  | 'value'
  | 'selectedText'
  | 'count'
  | 'visible'
  | 'enabled'
  | 'checked'
  | 'innerHTML'
  | 'outerHTML'
  | { readonly attr: string };

/**
 * `element` copies a match for reads that follow (the program's `locator.all()`):
 * its attributes, text, value and states; strings longer than `maxChars` are
 * cut and named in the copy's `cut`.
 */
export interface ProgramElementRead {
  readonly maxChars?: number;
}

/** `html` is the element's innerHTML (readAll's `"@html"`). */
export type ProgramFieldWhat =
  | 'text'
  | 'innerText'
  | 'value'
  | 'html'
  | { readonly attr: string }
  | { readonly element: ProgramElementRead };

export interface ProgramReadField {
  readonly sel?: string;
  readonly what: ProgramFieldWhat;
}

interface ProgramOpBase {
  readonly tabId?: number;
  readonly timeoutMs?: number;
}

export type ProgramOp = ProgramOpBase &
  (
    | { readonly op: 'goto'; readonly url: string; readonly wait?: ProgramLoadState }
    | { readonly op: 'back' | 'reload'; readonly wait?: ProgramLoadState }
    | {
        readonly op: 'click' | 'dblclick' | 'hover' | 'check' | 'uncheck';
        readonly target: ProgramLocator;
      }
    | { readonly op: 'fill'; readonly target: ProgramLocator; readonly value: string }
    | { readonly op: 'type'; readonly target?: ProgramLocator; readonly value: string }
    | { readonly op: 'press'; readonly target?: ProgramLocator; readonly key: string }
    | {
        readonly op: 'selectOption';
        readonly target: ProgramLocator;
        readonly values: readonly string[];
      }
    | { readonly op: 'read'; readonly target: ProgramLocator; readonly what: ProgramReadWhat }
    | {
        readonly op: 'readAll';
        readonly target: ProgramLocator;
        readonly fields: Readonly<Record<string, ProgramReadField>>;
        readonly limit?: number;
      }
    | {
        readonly op: 'rows';
        readonly target: ProgramLocator;
        readonly fields?: Readonly<Record<string, string>>;
        readonly limit?: number;
        readonly offset?: number;
        readonly maxChars?: number;
      }
    | {
        readonly op: 'waitFor';
        readonly target?: ProgramLocator;
        readonly state?: ProgramElementState;
        readonly url?: ProgramTextMatch;
        readonly text?: ProgramTextMatch;
        readonly load?: ProgramLoadState;
      }
    | {
        readonly op: 'waitForResponse';
        readonly urlIncludes: string;
        readonly afterSequence?: number;
      }
    | { readonly op: 'networkCheckpoint' }
    | { readonly op: 'observe'; readonly mode?: 'outline' | 'interactive' }
    | { readonly op: 'url' | 'title' }
    | { readonly op: 'screenshot'; readonly fullPage?: boolean }
    | {
        readonly op: 'mouseClick';
        readonly x: number;
        readonly y: number;
        readonly button: ProgramMouseButton;
        readonly clickCount: number;
      }
    | { readonly op: 'mouseMove'; readonly x: number; readonly y: number }
    | {
        readonly op: 'mouseWheel';
        readonly x: number;
        readonly y: number;
        readonly deltaX: number;
        readonly deltaY: number;
      }
    | {
        readonly op: 'handleDialog';
        readonly dialogId: string;
        readonly action: 'accept' | 'dismiss';
        readonly promptText?: string;
      }
    | ProgramEvaluateOp
  );

/**
 * Page JavaScript (page.evaluate, locator.evaluate/evaluateAll, waitForFunction).
 * `source` is a function or expression source; a function gets `arg` (with a
 * target: the element, or every match with `all`, first). It runs only on a
 * web page, on the origin the page had when the op started. `poll` repeats it
 * until it returns a truthy value (waitForFunction).
 */
export interface ProgramEvaluateOp {
  readonly op: 'evaluate';
  readonly source: string;
  readonly arg?: unknown;
  readonly target?: ProgramLocator;
  readonly all?: boolean;
  readonly poll?: boolean;
}

/** A request a page script sent (or tried to send) while it ran. */
export interface ProgramPageScriptRequest {
  readonly method: string;
  readonly url: string;
  readonly status?: number;
  /** Refused before it left the browser: another site than the page's. */
  readonly blocked?: true;
}

/**
 * What one page script did while it ran, measured over its time window: DOM
 * mutations, form submits, requests and a main-frame navigation. The page's
 * own activity in that window is counted too (no per-call attribution).
 * `writeLike` (a non-GET request, a submit or a navigation) makes the next
 * write wait for a read, like an uncertain write.
 */
export interface ProgramPageScriptEffects {
  readonly origin: string;
  readonly durationMs: number;
  readonly mutations: number;
  readonly submits: number;
  readonly requests: readonly ProgramPageScriptRequest[];
  /** All requests in the window; `requests` lists at most 20. */
  readonly requestCount: number;
  readonly nonGetRequests: number;
  readonly blockedRequests: number;
  readonly navigation?: Readonly<Record<string, unknown>>;
  readonly writeLike: boolean;
}

/** The audit record of a page script: its effects and its code (first 4 KB). */
export interface ProgramPageScriptAudit extends ProgramPageScriptEffects {
  readonly source: string;
  readonly sourceTruncated?: true;
  readonly calls?: number;
}

export type ProgramLoadState = 'load' | 'domcontentloaded';
export type ProgramMouseButton = 'left' | 'right' | 'middle';
export type ProgramElementState = 'visible' | 'hidden' | 'attached' | 'detached';

/** One page operation: what ran, on what, how long, and a write's outcome. */
export interface ProgramOpStep {
  readonly op: string;
  readonly target?: string;
  readonly durationMs: number;
  readonly url?: string;
  readonly navigation?: Readonly<Record<string, unknown>>;
  /** Whether the op can change the page (the same list as Browser write actions). */
  readonly write: boolean;
  readonly outcome?: 'succeeded' | 'failed' | 'uncertain';
  readonly code?: string;
  /** A read that returned while a main-frame load was pending: it shows the page before that load. */
  readonly pendingNavigation?: Readonly<Record<string, unknown>>;
  /** Page JavaScript only: what it ran and what it did. */
  readonly pageScript?: ProgramPageScriptAudit;
}

export interface ProgramOpFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly recovery?: string;
  /** The write may have reached the page or server; read before repeating it. */
  readonly writeOutcomeUnknown?: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Facts every result may carry besides its value; the Browser Core records as they are. */
interface ProgramOpFacts {
  readonly step: ProgramOpStep;
}

export type ProgramOpResult =
  | (ProgramOpFacts & { readonly ok: true; readonly value: unknown })
  | (ProgramOpFacts & { readonly ok: false; readonly error: ProgramOpFailure });

const MAX_CHAIN_STEPS = 32;
const MAX_LOCATOR_TEXT = 4_096;
const MAX_VALUE_CHARS = 1_048_576;
const MAX_READ_FIELDS = 50;
const MAX_TIMEOUT_MS = 120_000;
const LOAD_STATES: Readonly<Record<string, true>> = { load: true, domcontentloaded: true };
const ELEMENT_STATES: Readonly<Record<string, true>> = {
  visible: true,
  hidden: true,
  attached: true,
  detached: true,
};
const READ_KINDS: Readonly<Record<string, true>> = {
  text: true,
  innerText: true,
  value: true,
  selectedText: true,
  count: true,
  visible: true,
  enabled: true,
  checked: true,
  innerHTML: true,
  outerHTML: true,
};
const FIELD_KINDS: Readonly<Record<string, true>> = {
  text: true,
  innerText: true,
  value: true,
  html: true,
};
/** A page script's source, as page.evaluate in a run_script page script allows. */
const MAX_EVALUATE_SOURCE_CHARS = 64 * 1024;
/** The JSON argument of a page script. */
const MAX_EVALUATE_ARG_CHARS = 256 * 1024;

function invalid(message: string): BrowserProgramError {
  return new BrowserProgramError('INVALID_OP', message, {
    recovery: 'The page operation is malformed; fix the arguments of this call.',
  });
}

function boundedString(value: unknown, label: string, max = MAX_LOCATOR_TEXT): string {
  if (typeof value !== 'string') throw invalid(`${label} must be a string.`);
  if (value.length > max) throw invalid(`${label} is longer than ${max} characters.`);
  return value;
}

function optionalNumber(
  value: unknown,
  label: string,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw invalid(`${label} must be a number.`);
  }
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function textMatch(value: unknown, label: string): ProgramTextMatch {
  if (typeof value === 'string') return boundedString(value, label);
  if (isRecord(value) && typeof value.regex === 'string') {
    return {
      regex: boundedString(value.regex, `${label} regex`),
      ...(typeof value.flags === 'string' ? { flags: boundedString(value.flags, 'flags', 8) } : {}),
    };
  }
  throw invalid(`${label} must be a string or a regular expression.`);
}

function parseStep(raw: unknown, inBranch = false): ProgramLocatorStep {
  if (!isRecord(raw)) throw invalid('A locator step must be an object.');
  const exact = raw.exact === true ? { exact: true as const } : {};
  switch (raw.by) {
    case 'role':
      return {
        by: 'role',
        role: boundedString(raw.role, 'role', 64),
        ...(raw.name === undefined ? {} : { name: textMatch(raw.name, 'name') }),
        ...exact,
      };
    case 'text':
    case 'label':
    case 'placeholder':
      return { by: raw.by, value: textMatch(raw.value, raw.by), ...exact };
    case 'css':
      return { by: 'css', selector: boundedString(raw.selector, 'selector') };
    case 'ref':
      if (inBranch) throw invalid('page.ref() cannot be part of a selector list.');
      return { by: 'ref', ref: boundedString(raw.ref, 'ref') };
    case 'nth':
      if (typeof raw.index !== 'number' || !Number.isInteger(raw.index)) {
        throw invalid('nth needs an integer index.');
      }
      return { by: 'nth', index: raw.index };
    case 'filter':
      return {
        by: 'filter',
        ...(raw.hasText === undefined ? {} : { hasText: textMatch(raw.hasText, 'hasText') }),
        ...(raw.hasNotText === undefined
          ? {}
          : { hasNotText: textMatch(raw.hasNotText, 'hasNotText') }),
        ...(typeof raw.visible === 'boolean' ? { visible: raw.visible } : {}),
      };
    case 'or': {
      if (inBranch) throw invalid('A selector list cannot hold another one.');
      if (
        !Array.isArray(raw.chains) ||
        raw.chains.length === 0 ||
        raw.chains.length > MAX_CHAIN_STEPS
      ) {
        throw invalid(`A selector list needs 1-${MAX_CHAIN_STEPS} chains.`);
      }
      const chains = raw.chains.map((branch: unknown) => {
        if (!Array.isArray(branch) || branch.length === 0 || branch.length > MAX_CHAIN_STEPS) {
          throw invalid(`Each chain of a selector list needs 1-${MAX_CHAIN_STEPS} steps.`);
        }
        return branch.map((step: unknown) => parseStep(step, true));
      });
      return { by: 'or', chains };
    }
    default:
      throw invalid(`Unknown locator step ${JSON.stringify(raw.by)}.`);
  }
}

/** Steps a chain holds, those inside its selector lists included. */
function stepCount(chain: readonly ProgramLocatorStep[]): number {
  let count = 0;
  for (const step of chain) {
    count += 1;
    if (step.by === 'or') for (const branch of step.chains) count += stepCount(branch);
  }
  return count;
}

function parseLocator(raw: unknown): ProgramLocator {
  if (!isRecord(raw) || !Array.isArray(raw.chain) || raw.chain.length === 0) {
    throw invalid('A locator needs a non-empty chain.');
  }
  if (raw.chain.length > MAX_CHAIN_STEPS) {
    throw invalid(`A locator chain has at most ${MAX_CHAIN_STEPS} steps.`);
  }
  const tabId = optionalNumber(raw.tabId, 'tabId', 0, Number.MAX_SAFE_INTEGER);
  const chain = raw.chain.map((step: unknown) => parseStep(step));
  if (stepCount(chain) > MAX_CHAIN_STEPS) {
    throw invalid(`A locator chain has at most ${MAX_CHAIN_STEPS} steps, selector lists included.`);
  }
  const ref = chain.findIndex((step) => step.by === 'ref');
  if (ref > 0) throw invalid('page.ref() can only start a locator chain.');
  return { ...(tabId === undefined ? {} : { tabId }), chain };
}

function parseFields(raw: unknown): Readonly<Record<string, ProgramReadField>> {
  if (!isRecord(raw)) throw invalid('readAll fields must be an object.');
  const entries = Object.entries(raw);
  if (entries.length === 0 || entries.length > MAX_READ_FIELDS) {
    throw invalid(`readAll needs 1-${MAX_READ_FIELDS} fields.`);
  }
  return Object.fromEntries(
    entries.map(([name, field]) => {
      if (!isRecord(field)) throw invalid(`Field ${JSON.stringify(name)} must be an object.`);
      const what = field.what;
      const parsedWhat: ProgramFieldWhat =
        typeof what === 'string' && FIELD_KINDS[what] === true
          ? (what as ProgramFieldWhat)
          : isRecord(what) && typeof what.attr === 'string'
            ? { attr: boundedString(what.attr, 'attr', 256) }
            : isRecord(what) && isRecord(what.element)
              ? {
                  element:
                    what.element.maxChars === undefined
                      ? {}
                      : {
                          maxChars: optionalNumber(
                            what.element.maxChars,
                            'maxChars',
                            1,
                            1_000_000,
                          ) as number,
                        },
                }
              : (() => {
                  throw invalid(`Field ${JSON.stringify(name)} reads an unknown value.`);
                })();
      return [
        name,
        {
          ...(field.sel === undefined ? {} : { sel: boundedString(field.sel, 'field selector') }),
          what: parsedWhat,
        },
      ];
    }),
  );
}

function parseLoad(raw: unknown): ProgramLoadState | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw === 'string' && LOAD_STATES[raw] === true) return raw as ProgramLoadState;
  throw invalid('A load state must be "load" or "domcontentloaded".');
}

/**
 * Structural check of an op from the sandbox. The model's arguments reach it
 * without the Browser tool's input validation, so every field the page script
 * or a CDP command uses is checked here, once, in Browser Core.
 */
export function parseProgramOp(raw: unknown): ProgramOp {
  if (!isRecord(raw) || typeof raw.op !== 'string') throw invalid('An op needs an "op" name.');
  const base = {
    ...(raw.tabId === undefined
      ? {}
      : { tabId: optionalNumber(raw.tabId, 'tabId', 0, Number.MAX_SAFE_INTEGER) as number }),
    ...(raw.timeoutMs === undefined
      ? {}
      : { timeoutMs: optionalNumber(raw.timeoutMs, 'timeout', 0, MAX_TIMEOUT_MS) as number }),
  };
  const wait = parseLoad(raw.wait);
  switch (raw.op) {
    case 'goto':
      return {
        ...base,
        op: 'goto',
        url: boundedString(raw.url, 'url', 65_536).trim(),
        ...(wait ? { wait } : {}),
      };
    case 'back':
    case 'reload':
      return { ...base, op: raw.op, ...(wait ? { wait } : {}) };
    case 'click':
    case 'dblclick':
    case 'hover':
    case 'check':
    case 'uncheck':
      return { ...base, op: raw.op, target: parseLocator(raw.target) };
    case 'fill':
      return {
        ...base,
        op: 'fill',
        target: parseLocator(raw.target),
        value: boundedString(raw.value, 'value', MAX_VALUE_CHARS),
      };
    case 'type':
      return {
        ...base,
        op: 'type',
        ...(raw.target === undefined ? {} : { target: parseLocator(raw.target) }),
        value: boundedString(raw.value, 'value', MAX_VALUE_CHARS),
      };
    case 'press': {
      const key = boundedString(raw.key, 'key', 128);
      // An unknown modifier would be dropped and the last key typed as text.
      const unknown = splitKeyCombo(key)
        .slice(0, -1)
        .find((name) => modifierBit(platformModifier(name)) === 0);
      if (unknown !== undefined) {
        throw new BrowserProgramError(
          'INVALID_OP',
          `${JSON.stringify(unknown)} in ${JSON.stringify(key)} is not a modifier key.`,
          {
            recovery:
              'Put Alt, Control, Meta, Shift or ControlOrMeta before the key, for example "Control+A"; to enter text use fill() or type().',
          },
        );
      }
      return {
        ...base,
        op: 'press',
        ...(raw.target === undefined ? {} : { target: parseLocator(raw.target) }),
        key,
      };
    }
    case 'selectOption': {
      const values = Array.isArray(raw.values)
        ? raw.values.map((value) => boundedString(value, 'option'))
        : [];
      if (values.length === 0) throw invalid('selectOption needs at least one option.');
      return { ...base, op: 'selectOption', target: parseLocator(raw.target), values };
    }
    case 'read': {
      const what = raw.what;
      const parsedWhat: ProgramReadWhat =
        typeof what === 'string' && READ_KINDS[what] === true
          ? (what as ProgramReadWhat)
          : isRecord(what) && typeof what.attr === 'string'
            ? { attr: boundedString(what.attr, 'attr', 256) }
            : (() => {
                throw invalid('read asks for an unknown value.');
              })();
      return { ...base, op: 'read', target: parseLocator(raw.target), what: parsedWhat };
    }
    case 'readAll':
      return {
        ...base,
        op: 'readAll',
        target: parseLocator(raw.target),
        fields: parseFields(raw.fields),
        ...(raw.limit === undefined
          ? {}
          : { limit: optionalNumber(raw.limit, 'limit', 1, 5_000) as number }),
      };
    case 'rows':
      return parseRowsOp(raw, base);
    case 'waitFor':
      return parseWaitOp(raw, base);
    case 'waitForResponse':
      return {
        ...base,
        op: 'waitForResponse',
        urlIncludes: boundedString(raw.urlIncludes, 'url'),
        ...(raw.afterSequence === undefined
          ? {}
          : {
              afterSequence: optionalNumber(
                raw.afterSequence,
                'afterSequence',
                0,
                Number.MAX_SAFE_INTEGER,
              ) as number,
            }),
      };
    case 'networkCheckpoint':
    case 'url':
    case 'title':
      return { ...base, op: raw.op };
    case 'observe':
      return {
        ...base,
        op: 'observe',
        ...(raw.mode === 'outline' || raw.mode === 'interactive' ? { mode: raw.mode } : {}),
      };
    case 'screenshot':
      return {
        ...base,
        op: 'screenshot',
        ...(raw.fullPage === true ? { fullPage: true } : {}),
      };
    case 'handleDialog':
      if (raw.action !== 'accept' && raw.action !== 'dismiss') {
        throw invalid("handleDialog needs action: 'accept' or 'dismiss'.");
      }
      return {
        ...base,
        op: 'handleDialog',
        dialogId: boundedString(raw.dialogId, 'dialogId'),
        action: raw.action,
        ...(typeof raw.promptText === 'string'
          ? { promptText: boundedString(raw.promptText, 'promptText', MAX_VALUE_CHARS) }
          : {}),
      };
    case 'mouseClick':
    case 'mouseMove':
    case 'mouseWheel':
      return parseMouseOp(raw, base);
    case 'evaluate':
      return parseEvaluateOp(raw, base);
    default:
      throw invalid(`Unknown page operation ${JSON.stringify(raw.op)}.`);
  }
}

const MOUSE_BUTTONS: Readonly<Record<string, true>> = { left: true, right: true, middle: true };

function viewportNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw invalid(`${label} must be a number.`);
  return Math.max(-100_000, Math.min(100_000, value));
}

/** Viewport coordinates (CSS pixels), as page.mouse takes them. */
function parseMouseOp(raw: Record<string, unknown>, base: ProgramOpBase): ProgramOp {
  const x = viewportNumber(raw.x, 'x');
  const y = viewportNumber(raw.y, 'y');
  if (raw.op === 'mouseMove') return { ...base, op: 'mouseMove', x, y };
  if (raw.op === 'mouseWheel') {
    return {
      ...base,
      op: 'mouseWheel',
      x,
      y,
      deltaX: raw.deltaX === undefined ? 0 : viewportNumber(raw.deltaX, 'deltaX'),
      deltaY: raw.deltaY === undefined ? 0 : viewportNumber(raw.deltaY, 'deltaY'),
    };
  }
  const button = raw.button === undefined ? 'left' : raw.button;
  if (typeof button !== 'string' || MOUSE_BUTTONS[button] !== true) {
    throw invalid('button must be "left", "right" or "middle".');
  }
  const clickCount = optionalNumber(raw.clickCount, 'clickCount', 1, 3) ?? 1;
  return {
    ...base,
    op: 'mouseClick',
    x,
    y,
    button: button as ProgramMouseButton,
    clickCount,
  };
}

function parseEvaluateOp(raw: Record<string, unknown>, base: ProgramOpBase): ProgramOp {
  const source = boundedString(raw.source, 'The page script', MAX_EVALUATE_SOURCE_CHARS);
  if (!source.trim()) throw invalid('page.evaluate needs a function or an expression.');
  let arg: unknown;
  if (raw.arg !== undefined) {
    let json: string | undefined;
    try {
      json = JSON.stringify(raw.arg);
    } catch {
      json = undefined;
    }
    if (json === undefined || json.length > MAX_EVALUATE_ARG_CHARS) {
      throw invalid(
        `The page script argument must be JSON of at most ${MAX_EVALUATE_ARG_CHARS} characters.`,
      );
    }
    arg = JSON.parse(json) as unknown;
  }
  const target = raw.target === undefined ? undefined : parseLocator(raw.target);
  if (raw.all === true && !target) throw invalid('evaluateAll needs a locator.');
  return {
    ...base,
    op: 'evaluate',
    source,
    ...(arg === undefined ? {} : { arg }),
    ...(target ? { target } : {}),
    ...(raw.all === true ? { all: true } : {}),
    ...(raw.poll === true ? { poll: true } : {}),
  };
}

function parseRowsOp(raw: Record<string, unknown>, base: ProgramOpBase): ProgramOp {
  const limit = optionalNumber(raw.limit, 'limit', 1, 200);
  const offset = optionalNumber(raw.offset, 'offset', 0, Number.MAX_SAFE_INTEGER);
  const maxChars = optionalNumber(raw.maxChars, 'maxChars', 1, 10_000);
  let fields: Record<string, string> | undefined;
  if (raw.fields !== undefined) {
    if (!isRecord(raw.fields)) throw invalid('rows fields must map names to selectors.');
    fields = Object.fromEntries(
      Object.entries(raw.fields).map(([name, spec]) => [name, boundedString(spec, 'field')]),
    );
  }
  return {
    ...base,
    op: 'rows',
    target: parseLocator(raw.target),
    ...(fields ? { fields } : {}),
    ...(limit === undefined ? {} : { limit }),
    ...(offset === undefined ? {} : { offset }),
    ...(maxChars === undefined ? {} : { maxChars }),
  };
}

function parseWaitOp(raw: Record<string, unknown>, base: ProgramOpBase): ProgramOp {
  let state: ProgramElementState | undefined;
  if (raw.state !== undefined) {
    if (typeof raw.state !== 'string' || ELEMENT_STATES[raw.state] !== true) {
      throw invalid('state must be visible, hidden, attached or detached.');
    }
    state = raw.state as ProgramElementState;
  }
  const load = parseLoad(raw.load);
  if (raw.target === undefined && raw.url === undefined && raw.text === undefined && !load) {
    throw invalid('waitFor needs a locator, url, text or load state.');
  }
  return {
    ...base,
    op: 'waitFor',
    ...(raw.target === undefined ? {} : { target: parseLocator(raw.target) }),
    ...(state ? { state } : {}),
    ...(raw.url === undefined ? {} : { url: textMatch(raw.url, 'url') }),
    ...(raw.text === undefined ? {} : { text: textMatch(raw.text, 'text') }),
    ...(load ? { load } : {}),
  };
}

function quoteMatch(value: ProgramTextMatch): string {
  return typeof value === 'string'
    ? JSON.stringify(value.slice(0, 80))
    : `/${value.regex.slice(0, 80)}/${value.flags ?? ''}`;
}

/** The locator as a program would write it; names targets in the write list and errors. */
export function describeProgramLocator(locator: ProgramLocator): string {
  return describeChain(locator.chain).slice(0, 200);
}

function describeChain(chain: readonly ProgramLocatorStep[]): string {
  return chain
    .map((step, index) => {
      const dot = index === 0 ? '' : '.';
      switch (step.by) {
        case 'role':
          return `${dot}getByRole(${JSON.stringify(step.role)}${step.name === undefined ? '' : `, ${quoteMatch(step.name)}`})`;
        case 'text':
          return `${dot}getByText(${quoteMatch(step.value)})`;
        case 'label':
          return `${dot}getByLabel(${quoteMatch(step.value)})`;
        case 'placeholder':
          return `${dot}getByPlaceholder(${quoteMatch(step.value)})`;
        case 'css':
          return `${dot}locator(${JSON.stringify(step.selector.slice(0, 120))})`;
        case 'ref':
          return `${dot}ref(${JSON.stringify(step.ref)})`;
        case 'nth':
          return `${dot}nth(${step.index})`;
        case 'filter':
          return `${dot}filter(${step.hasText === undefined ? '' : quoteMatch(step.hasText)})`;
        case 'or':
          return `${dot}or(${step.chains.map(describeChain).join(', ')})`;
        default:
          return '';
      }
    })
    .join('');
}
