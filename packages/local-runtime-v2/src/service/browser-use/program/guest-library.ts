/**
 * The guest side of a Browser program, as source for the QuickJS setup script:
 * `browser`, `Page`, `Locator` (a Playwright subset), the error classes, the
 * timers and `state`. Every page call becomes one op of Browser Core's program
 * protocol, sent through `__programOp`; pages and locators hold plain data, so
 * they can sit in `state` across programs. Locator reads are declarative (what
 * to read, never how); page JavaScript runs only through the `evaluate` family
 * and `runPageScript`. `all()` (and the second read
 * of some `list.nth(i)`) copies a list in one op, so reads of its items cost no
 * op until the next non-read op or timer.
 *
 * The Worker loads this module, so it must not import anything.
 */
export const BROWSER_PROGRAM_GUEST_SETUP = String.raw`
(() => {
  const opHost = globalThis.__programOp;
  const logHost = globalThis.__programConsole;
  delete globalThis.__programOp;
  delete globalThis.__programConsole;
  const stringify = JSON.stringify;

  const format = (value) => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.name + ': ' + value.message;
    try {
      const json = stringify(value);
      if (json !== undefined) return json;
    } catch {}
    try { return String(value); } catch { return '[unprintable]'; }
  };
  const log = (...args) => { logHost(args.map(format).join(' ')); };
  globalThis.console = Object.freeze({ log, info: log, warn: log, error: log, debug: log });

  // setTimeout, clearTimeout and sleep come from the guest timer setup
  // (guest/timers.ts GUEST_TIMERS_SETUP), installed before this script.
  const noInterval = (name) => function () {
    throw new ReferenceError(name + ' is not available in a Browser program. Loop with await sleep(ms), or better wait for what you expect with locator.waitFor() or page.waitFor().');
  };
  globalThis.setInterval = noInterval('setInterval');
  globalThis.clearInterval = noInterval('clearInterval');
  delete globalThis.process;
  delete globalThis.require;
  delete globalThis.fetch;
  // Models call other tools from inside a program (seen in evaluation); say why that cannot work.
  Object.defineProperty(globalThis, 'tools', {
    configurable: false,
    get() {
      throw new ReferenceError('tools is not available inside a Browser program: a program cannot call other tools. Return the data the next step needs from the program, then call the tool from run_code.');
    },
  });

  const describeCandidates = (label, list) => Array.isArray(list) && list.length > 0
    ? ' ' + label + ': ' + list.map((c, i) => '[' + i + '] ' + (c.role || c.tag) + ' ' + stringify(c.name || c.text) + (c.selector ? ' selector ' + stringify(c.selector) : '') + (c.frame ? ' inside iframe ' + stringify(c.frame) : '') + (c.context ? ' in ' + stringify(c.context) : '') + (c.visible ? '' : ' (hidden)')).join('; ') + '.'
    : '';
  class BrowserError extends Error {
    constructor(failure) {
      const details = failure.details || {};
      const listed = describeCandidates(failure.code === 'LOCATOR_NOT_FOUND' ? 'Similar elements on the page' : 'Candidates', details.candidates);
      super(failure.message + listed + (failure.recovery ? ' Next: ' + failure.recovery : ''));
      this.name = 'BrowserError';
      this.code = failure.code;
      this.retryable = failure.retryable === true;
      if (failure.recovery) this.recovery = failure.recovery;
      if (failure.details) {
        for (const key of Object.keys(failure.details)) {
          if (key !== 'name' && key !== 'message' && key !== 'code') this[key] = failure.details[key];
        }
      }
    }
  }
  const subclass = (name) => {
    const Sub = class extends BrowserError {
      constructor(failure) { super(failure); this.name = name; }
    };
    Object.defineProperty(Sub, 'name', { value: name });
    return Sub;
  };
  const errors = {
    BrowserError,
    LocatorNotFound: subclass('LocatorNotFound'),
    LocatorAmbiguous: subclass('LocatorAmbiguous'),
    NotActionable: subclass('NotActionable'),
    TimeoutError: subclass('TimeoutError'),
    WriteOutcomeUnknown: subclass('WriteOutcomeUnknown'),
    UnverifiedWriteRetry: subclass('UnverifiedWriteRetry'),
    PageLoading: subclass('PageLoading'),
    JsDialogActive: subclass('JsDialogActive'),
  };
  const ERROR_BY_CODE = {
    LOCATOR_NOT_FOUND: errors.LocatorNotFound,
    LOCATOR_AMBIGUOUS: errors.LocatorAmbiguous,
    NOT_ACTIONABLE: errors.NotActionable,
    TIMEOUT: errors.TimeoutError,
    UNVERIFIED_WRITE_RETRY: errors.UnverifiedWriteRetry,
    PAGE_LOADING: errors.PageLoading,
    BROWSER_JS_DIALOG_ACTIVE: errors.JsDialogActive,
  };
  const toError = (failure) => {
    if (failure.writeOutcomeUnknown === true) return new errors.WriteOutcomeUnknown(failure);
    const Known = ERROR_BY_CODE[failure.code];
    return Known ? new Known(failure) : new BrowserError(failure);
  };

  // Ops that leave the page as it was: list copies stay current across them.
  const READ_ONLY_OPS = { read: 1, readAll: 1, rows: 1, url: 1, title: 1, tabs: 1, observe: 1, screenshot: 1, networkCheckpoint: 1, keep: 1, show: 1 };
  let pageEpoch = 0;
  // Ops reach the page one at a time, in call order, also from Promise.all.
  let tail = Promise.resolve();
  const send = async (op) => {
    const reply = await opHost(stringify(op));
    if (reply && reply.ok === true) return reply;
    throw toError(reply && reply.error ? reply.error : { code: 'BROWSER_OP_FAILED', message: 'BROWSER_OP_FAILED: no result.' });
  };
  const runReply = (op) => {
    if (READ_ONLY_OPS[op.op] !== 1) pageEpoch += 1;
    const run = tail.then(() => send(op));
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
  const runValue = (op) => runReply(op).then((reply) => reply.value);
  // A write that opened a page (a click, mouse.click) answers { popup }: the page to continue in.
  const runWrite = (op) => runReply(op).then((reply) => ({
    ...(reply.value && typeof reply.value === 'object' ? reply.value : {}),
    ...(reply.openedInNewTab === true && typeof reply.tabId === 'number' ? { popup: new Page(reply.tabId) } : {}),
  }));
  // Time passing lets the page change on its own: copies taken before are not reused.
  const timerSleep = globalThis.sleep;
  const timerSetTimeout = globalThis.setTimeout;
  globalThis.sleep = (ms) => {
    pageEpoch += 1;
    return timerSleep(ms).then(() => { pageEpoch += 1; });
  };
  globalThis.setTimeout = function (callback, ms, ...args) {
    if (typeof callback !== 'function') return timerSetTimeout(callback, ms, ...args);
    pageEpoch += 1;
    return timerSetTimeout((...given) => { pageEpoch += 1; return callback(...given); }, ms, ...args);
  };
  const opsIdle = async () => {
    let seen;
    do { seen = tail; await seen; } while (seen !== tail);
  };

  // Page JavaScript: the function's source goes to the page (Playwright: String(fn)), so it
  // sees page globals and its arguments only, never this program's variables.
  const runPageScript = async (op, fn, arg) => {
    if (typeof fn !== 'function' && typeof fn !== 'string') throw new TypeError('Pass a function (or an expression string), for example page.evaluate(() => document.title).');
    const reply = await runReply({ ...op, op: 'evaluate', source: String(fn), ...(arg === undefined ? {} : { arg }) });
    const result = reply.value || {};
    const effects = result.effects;
    if (effects && (effects.writeLike || effects.blockedRequests > 0)) {
      const sent = effects.nonGetRequests > 0 ? effects.nonGetRequests + ' non-GET request(s)' : '';
      const notes = [sent, effects.submits > 0 ? 'a form submit' : '', effects.navigation ? 'a navigation' : '', effects.blockedRequests > 0 ? effects.blockedRequests + ' request(s) to another site blocked' : ''].filter(Boolean).join(', ');
      console.warn('page script: ' + notes + (effects.writeLike ? '. The next write waits until you read the page.' : '.'));
    }
    return result.undefined === true ? undefined : result.value;
  };

  const timeoutOf = (options) => {
    if (options === undefined || options === null || options.timeout === undefined) return {};
    const timeoutMs = Number(options.timeout);
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError('timeout must be a number of milliseconds.');
    return { timeoutMs };
  };
  const textSpec = (value) => {
    if (value instanceof RegExp) return { regex: value.source, flags: value.flags };
    if (typeof value === 'string') return value;
    if (value === undefined || value === null) throw new TypeError('A text to match is required.');
    return String(value);
  };
  // Playwright pseudo-classes CSS does not know: :visible, :text-is(), :text(), :has-text().
  // A compound that uses them becomes a CSS step and filters; what follows it
  // continues as a descendant (space) or child (>) search inside the matches.
  const PSEUDO = /^:(visible|text-is|text|has-text)(?![\w-])/;
  const escapeRegex = (text) => text.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const pseudoFilter = (name, arg, alone) => {
    if (name === 'visible') return { by: 'filter', visible: true };
    if (name === 'text-is') return alone ? { by: 'text', value: arg, exact: true } : { by: 'filter', hasText: { regex: '^\\s*' + escapeRegex(arg.replace(/\s+/g, ' ').trim()) + '\\s*$', flags: '' } };
    return alone && name === 'text' ? { by: 'text', value: arg } : { by: 'filter', hasText: arg };
  };
  // One selector of a list: the CSS it holds and the filters its pseudo-classes add.
  const selectorPartSteps = (selector) => {
    const steps = [];
    let css = '';
    let compound = '';
    let filters = [];
    let combinator = '';
    let quote = '';
    let depth = 0;
    const flush = (final) => {
      if (filters.length === 0) {
        css += combinator + compound;
      } else {
        if (combinator.trim() === '+' || combinator.trim() === '~') throw new TypeError('locator(): a sibling combinator (+ or ~) cannot follow :visible, :text() or :has-text(); put the pseudo-class on the last element of the selector.');
        const base = compound.trim();
        const alone = base === '' && css === '' && steps.length === 0 && filters.length === 1;
        const filterSteps = filters.map((f) => pseudoFilter(f.name, f.arg, alone));
        if (alone && filterSteps[0].by === 'text') {
          steps.push(filterSteps[0]);
        } else {
          const prefix = steps.length > 0 && css === '' && combinator.trim() === '>' ? ':scope > ' : css + combinator;
          steps.push({ by: 'css', selector: (prefix + (base || '*')).trim() }, ...filterSteps);
        }
        css = '';
      }
      if (final && css.trim()) steps.push({ by: 'css', selector: steps.length > 0 && css.trim().indexOf('>') === 0 ? ':scope ' + css.trim() : css.trim() });
      compound = '';
      filters = [];
      combinator = '';
    };
    for (let at = 0; at < selector.length; at += 1) {
      const char = selector[at];
      if (quote) { compound += char; if (char === quote && selector[at - 1] !== '\\') quote = ''; continue; }
      if (char === '"' || char === "'") { quote = char; compound += char; continue; }
      if (char === '(' || char === '[') depth += 1;
      if (char === ')' || char === ']') depth -= 1;
      if (depth === 0 && char === ':') {
        const pseudo = PSEUDO.exec(selector.slice(at));
        if (pseudo) {
          let arg = '';
          at += pseudo[0].length;
          if (pseudo[1] !== 'visible') {
            const open = /^\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)]*?))\s*\)/s.exec(selector.slice(at));
            if (!open) throw new TypeError('locator(): :' + pseudo[1] + '() needs a text, for example :' + pseudo[1] + '("Save").');
            arg = open[1] !== undefined ? open[1] : open[2] !== undefined ? open[2] : open[3];
            at += open[0].length;
          }
          at -= 1;
          filters.push({ name: pseudo[1], arg });
          continue;
        }
      }
      if (depth === 0 && /[\s>+~]/.test(char) && compound.trim() !== '') {
        let next = at;
        while (next < selector.length && /[\s>+~]/.test(selector[next])) next += 1;
        const joined = selector.slice(at, next);
        if (filters.length > 0) {
          flush(false);
        } else {
          css += combinator + compound;
          compound = '';
        }
        combinator = /[>+~]/.test(joined) ? ' ' + joined.trim() + ' ' : ' ';
        at = next - 1;
        continue;
      }
      compound += char;
    }
    if (steps.length === 0 && filters.length === 0) return [{ by: 'css', selector }];
    flush(true);
    return steps;
  };
  // The selector list's parts at its top-level commas; a comma in quotes, (), [] or escaped stays in its part.
  const selectorListParts = (selector) => {
    const parts = [];
    let start = 0;
    let quote = '';
    let depth = 0;
    for (let at = 0; at < selector.length; at += 1) {
      const char = selector[at];
      if (char === '\\') { at += 1; continue; }
      if (quote) { if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") quote = char;
      else if (char === '(' || char === '[') depth += 1;
      else if (char === ')' || char === ']') depth -= 1;
      else if (char === ',' && depth === 0) { parts.push(selector.slice(start, at).trim()); start = at + 1; }
    }
    parts.push(selector.slice(start).trim());
    return parts;
  };
  // A list of plain CSS stays one CSS step; with pseudo-classes in it, each part
  // becomes a chain of an 'or' step (Playwright: the matches of all parts, in document order).
  const selectorSteps = (selector) => {
    if (typeof selector !== 'string' || selector === '') throw new TypeError('locator() needs a CSS selector string.');
    if (selector.indexOf('text=') === 0) {
      const raw = selector.slice(5);
      const quoted = /^"(.*)"$/s.exec(raw);
      return quoted ? [{ by: 'text', value: quoted[1], exact: true }] : [{ by: 'text', value: raw }];
    }
    const parts = selectorListParts(selector);
    if (parts.length === 1) return selectorPartSteps(selector);
    const chains = parts.map(selectorPartSteps);
    if (chains.every((chain) => chain.length === 1 && chain[0].by === 'css')) return [{ by: 'css', selector }];
    return [{ by: 'or', chains }];
  };
  const byRole = (role, options) => ({
    by: 'role',
    role: String(role),
    ...(options && options.name !== undefined ? { name: textSpec(options.name) } : {}),
    ...(options && options.exact === true ? { exact: true } : {}),
  });
  const byText = (by, value, options) => ({
    by,
    value: textSpec(value),
    ...(options && options.exact === true ? { exact: true } : {}),
  });
  const optionValues = (value) => {
    const list = Array.isArray(value) ? value : [value];
    return list.map((entry) => {
      if (entry && typeof entry === 'object') {
        if (entry.value !== undefined) return String(entry.value);
        if (entry.label !== undefined) return String(entry.label);
        throw new TypeError('selectOption takes a value or label, for example { label: "Red" }.');
      }
      return String(entry);
    });
  };
  const notAvailable = (name, instead) => {
    const stub = function () {
      throw new TypeError(name + ' is not available in a Browser program. ' + instead);
    };
    stub.unavailable = true;
    return stub;
  };
  const methodsOf = (holder) => Object.getOwnPropertyNames(holder).filter((name) => {
    if (name === 'constructor' || name === 'toJSON' || name.charAt(0) === '_') return false;
    const own = Object.getOwnPropertyDescriptor(holder, name);
    return own.get !== undefined || (typeof own.value === 'function' && own.value.unavailable !== true);
  }).join(', ');
  // A Playwright call this library lacks names what there is, instead of "not a function".
  const withMissingHint = (kind, object, holder) => new Proxy(object, {
    get(target, key, receiver) {
      if (typeof key !== 'string' || key in target || key === 'then' || !/^[a-z$]/.test(key)) return Reflect.get(target, key, receiver);
      return notAvailable(kind + '.' + key + '()', 'A ' + kind + ' has: ' + methodsOf(holder) + '.');
    },
  });
  const NO_HANDLES = 'Handles do not exist here: page.evaluate and locator.evaluate return JSON values.';
  const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  // A list copy holds at most this many matches, each string cut at LIST_COPY_CHARS (longer reads go to the page).
  const LIST_COPY_LIMIT = 1000;
  const LIST_COPY_CHARS = 2000;
  const CACHED_READS = { text: 'text', innerText: 'innerText', value: 'value', visible: 'visible', enabled: 'enabled', checked: 'checked' };
  const MISS = {};
  // A locator read answered from a list copy; MISS when the copy lacks it or cut it.
  const fromCopy = (copy, what) => {
    const cut = copy.cut || [];
    if (what && typeof what === 'object') {
      if (typeof what.attr !== 'string') return MISS;
      const key = hasOwn(copy.attrs, what.attr) ? what.attr : what.attr.toLowerCase();
      if (cut.includes('@' + key)) return MISS;
      return hasOwn(copy.attrs, key) ? copy.attrs[key] : null;
    }
    const field = CACHED_READS[what];
    return field === undefined || cut.includes(field) ? MISS : copy[field];
  };
  // Copies of a list's matches (by tab and locator chain), current while no write,
  // navigation, wait or timer has run since: reads of list.nth(i) are answered
  // from them. all() takes them; so does the second nth read of a list.
  const listCopies = new Map();
  const nthReadSeen = new Map();
  // Enqueues its readAll when called (async functions run to their first await), keeping op order.
  const copyList = async (tabId, chain) => {
    const read = await runValue({ op: 'readAll', target: { tabId, chain }, tabId, fields: { copy: { what: { element: { maxChars: LIST_COPY_CHARS } } } }, limit: LIST_COPY_LIMIT });
    for (const [key, entry] of listCopies) if (entry.epoch !== pageEpoch) listCopies.delete(key);
    const entry = { epoch: pageEpoch, copies: read.rows.map((row) => row.copy), total: read.total };
    listCopies.set(stringify([tabId, chain]), entry);
    return entry;
  };
  // A read of list.nth(i) from the list's copies: MISS, { value }, or a promise of either once the list is copied.
  const listCopyRead = (tabId, chain, what) => {
    const last = chain[chain.length - 1];
    if (chain.length < 2 || last.by !== 'nth' || last.index < 0) return MISS;
    if (!(what && typeof what === 'object' && typeof what.attr === 'string') && CACHED_READS[what] === undefined) return MISS;
    const list = chain.slice(0, -1);
    const key = stringify([tabId, list]);
    const answer = (entry) => {
      const copy = entry.copies[last.index];
      const value = copy && entry.epoch === pageEpoch ? fromCopy(copy, what) : MISS;
      return value === MISS ? MISS : { value };
    };
    const entry = listCopies.get(key);
    if (entry && entry.epoch === pageEpoch) return answer(entry);
    // One read of list.nth(i) is a plain read; the second copies the list.
    if (nthReadSeen.get(key) !== pageEpoch) {
      nthReadSeen.set(key, pageEpoch);
      return MISS;
    }
    return copyList(tabId, list).then(answer);
  };
  const fieldSpec = (spec) => {
    if (spec && typeof spec === 'object') return spec;
    const text = String(spec);
    if (text === 'text') return { what: 'text' };
    if (text === 'value') return { what: 'value' };
    const at = /^([\s\S]*?)\s*@([A-Za-z_][\w.:-]*)$/.exec(text);
    if (at && !at[1].endsWith('\\')) return { what: at[2].toLowerCase() === 'html' ? 'html' : { attr: at[2] }, ...(at[1] ? { sel: at[1] } : {}) };
    return { what: 'text', sel: text };
  };
  const warnTruncated = (read) => {
    if (read.truncated === true) console.warn('Only the first ' + read.rows.length + ' of ' + read.total + ' matches were read; narrow the locator or pass a limit.');
  };

  class Locator {
    constructor(tabId, chain) {
      this.tabId = tabId;
      this.chain = chain;
      return withMissingHint('locator', this, Locator.prototype);
    }
    toJSON() { return { __browserLocator: true, tabId: this.tabId, chain: this.chain }; }
    _with(...steps) { return new Locator(this.tabId, [...this.chain, ...steps]); }
    _op(op, options) { return { ...op, target: { tabId: this.tabId, chain: this.chain }, tabId: this.tabId, ...timeoutOf(options) }; }
    _write(op, options) { return runWrite(this._op(op, options)); }
    _read(what, options) {
      const read = () => runValue(this._op({ op: 'read', what }, options));
      const copied = listCopyRead(this.tabId, this.chain, what);
      if (copied === MISS) return read();
      if (copied instanceof Promise) return copied.then((late) => (late === MISS ? read() : late.value));
      return Promise.resolve(copied.value);
    }

    locator(selector) { return this._with(...selectorSteps(selector)); }
    getByRole(role, options) { return this._with(byRole(role, options)); }
    getByText(value, options) { return this._with(byText('text', value, options)); }
    getByLabel(value, options) { return this._with(byText('label', value, options)); }
    getByPlaceholder(value, options) { return this._with(byText('placeholder', value, options)); }
    getByTestId(id) { return this.locator('[data-testid=' + stringify(String(id)) + ']'); }
    nth(index) {
      if (!Number.isInteger(index)) throw new TypeError('nth() needs an integer.');
      return this._with({ by: 'nth', index });
    }
    first() { return this._with({ by: 'nth', index: 0 }); }
    last() { return this._with({ by: 'nth', index: -1 }); }
    filter(options) {
      const step = { by: 'filter' };
      if (options && options.hasText !== undefined) step.hasText = textSpec(options.hasText);
      if (options && options.hasNotText !== undefined) step.hasNotText = textSpec(options.hasNotText);
      if (options && typeof options.visible === 'boolean') step.visible = options.visible;
      return this._with(step);
    }

    click(options) { return this._write({ op: options && options.clickCount === 2 ? 'dblclick' : 'click' }, options); }
    tap(options) { return this.click(options); }
    dblclick(options) { return this._write({ op: 'dblclick' }, options); }
    hover(options) { return this._write({ op: 'hover' }, options); }
    check(options) { return this._write({ op: 'check' }, options); }
    uncheck(options) { return this._write({ op: 'uncheck' }, options); }
    setChecked(checked, options) { return this._write({ op: checked ? 'check' : 'uncheck' }, options); }
    fill(value, options) { return this._write({ op: 'fill', value: String(value) }, options); }
    clear(options) { return this._write({ op: 'fill', value: '' }, options); }
    type(value, options) { return this._write({ op: 'type', value: String(value) }, options); }
    pressSequentially(value, options) { return this.type(value, options); }
    press(key, options) { return this._write({ op: 'press', key: String(key) }, options); }
    selectOption(value, options) { return this._write({ op: 'selectOption', values: optionValues(value) }, options); }

    textContent(options) { return this._read('text', options); }
    innerText(options) { return this._read('innerText', options); }
    inputValue(options) { return this._read('value', options); }
    getAttribute(name, options) { return this._read({ attr: String(name) }, options); }
    count() { return this._read('count'); }
    isVisible() { return this._read('visible'); }
    isHidden() { return this._read('visible').then((visible) => !visible); }
    isEnabled() { return this._read('enabled'); }
    isDisabled() { return this._read('enabled').then((enabled) => !enabled); }
    isChecked() { return this._read('checked'); }
    innerHTML(options) { return this._read('innerHTML', options); }
    outerHTML(options) { return this._read('outerHTML', options); }
    evaluate(fn, arg) { return runPageScript({ target: { tabId: this.tabId, chain: this.chain }, tabId: this.tabId }, fn, arg); }
    evaluateAll(fn, arg) { return runPageScript({ target: { tabId: this.tabId, chain: this.chain }, tabId: this.tabId, all: true }, fn, arg); }

    // One operation copies the matches, so reads on each returned locator cost none until the page changes.
    async all() {
      const { total } = await copyList(this.tabId, this.chain);
      const out = [];
      for (let index = 0; index < total; index += 1) out.push(this.nth(index));
      return out;
    }
    async readAll(fields, options) {
      if (!fields || typeof fields !== 'object') throw new TypeError('readAll() needs { name: "css" | "css@attr" | "@attr" | "text" | "value" }.');
      const specs = {};
      for (const name of Object.keys(fields)) specs[name] = fieldSpec(fields[name]);
      const read = await runValue(this._op({ op: 'readAll', fields: specs, ...(options && options.limit !== undefined ? { limit: options.limit } : {}) }, options));
      warnTruncated(read);
      return read.rows;
    }
    async allTextContents() { return (await this.readAll({ text: 'text' })).map((row) => row.text); }
    async allInnerTexts() { return (await this.readAll({ text: { what: 'innerText' } })).map((row) => row.text); }
    async rows(options) {
      const limit = options && options.limit !== undefined ? Number(options.limit) : 5000;
      const out = [];
      let offset = 0;
      for (;;) {
        const page = await runValue(this._op({
          op: 'rows',
          offset,
          limit: Math.min(200, limit - out.length),
          ...(options && options.fields ? { fields: options.fields } : {}),
          ...(options && options.maxChars !== undefined ? { maxChars: options.maxChars } : {}),
        }, options));
        out.push(...page.rows);
        if (page.nextOffset === undefined || out.length >= limit) return out;
        offset = page.nextOffset;
      }
    }
    async waitFor(options) {
      await runValue(this._op({ op: 'waitFor', state: (options && options.state) || 'visible' }, options));
    }
  }
  for (const [name, instead] of Object.entries({
    evaluateHandle: NO_HANDLES,
    elementHandle: 'Locators are found again on each use; keep the locator.',
    elementHandles: 'Use all() for one locator per match, or readAll() to read them in one operation.',
    text: 'Use textContent() or innerText().',
    value: 'Use inputValue().',
    boundingBox: 'Layout is not read; check isVisible().',
    scrollIntoViewIfNeeded: 'Actions scroll to their element themselves; for a plain scroll use the single-step scroll action outside the program.',
    focus: 'Use click(), or fill()/press(), which focus the element themselves.',
    blur: 'Use press("Tab") or click another element.',
    dispatchEvent: 'Use the action itself: click(), fill(), check(), selectOption() or press().',
    dragTo: 'Use the single-step drag action outside the program.',
    setInputFiles: 'Use the single-step upload_files action outside the program.',
    selectText: 'Use fill() to replace the content.',
    screenshot: 'Use page.screenshot().',
  })) {
    Locator.prototype[name] = notAvailable('locator.' + name + '()', instead);
  }

  const WAIT_KEYS = { selector: 1, state: 1, url: 1, text: 1, load: 1, waitUntil: 1, timeout: 1 };
  const LOAD_STATES = { load: 'load', domcontentloaded: 'domcontentloaded', networkidle: 'load', commit: 'domcontentloaded' };
  const WAIT_FORMS = 'Wait for something: page.waitFor({ selector: "css", state: "visible" }), page.waitFor({ text: "Saved" }), page.waitFor({ url: /\\/done/ }) or page.waitFor({ load: "load" }); pause with page.waitForTimeout(ms).';
  // page.waitFor's condition from the fields given: a selector, a load state, a URL, a text, or a bare pause.
  const waitCondition = (condition) => {
    if (typeof condition === 'number') return { pause: condition };
    if (typeof condition === 'string') return { selector: condition };
    if (typeof condition === 'function') throw new TypeError('page.waitFor(fn) is not available: use page.waitForFunction(fn). ' + WAIT_FORMS);
    if (!condition || typeof condition !== 'object') throw new TypeError('page.waitFor() needs a condition. ' + WAIT_FORMS);
    const unknown = Object.keys(condition).filter((key) => WAIT_KEYS[key] !== 1);
    if (unknown.length > 0) throw new TypeError('page.waitFor() does not take ' + unknown.join(', ') + '. ' + WAIT_FORMS);
    const spec = { ...condition };
    const load = spec.load !== undefined ? spec.load : spec.waitUntil;
    delete spec.waitUntil;
    if (load !== undefined) spec.load = load === true ? 'load' : LOAD_STATES[load];
    if (load !== undefined && spec.load === undefined) throw new TypeError('page.waitFor() load must be "load" or "domcontentloaded". ' + WAIT_FORMS);
    if (spec.selector === undefined && typeof spec.state === 'string' && LOAD_STATES[spec.state] !== undefined) {
      spec.load = spec.load || LOAD_STATES[spec.state];
      delete spec.state;
    }
    if (spec.selector === undefined && spec.state !== undefined) throw new TypeError('page.waitFor() state "' + spec.state + '" needs a selector. ' + WAIT_FORMS);
    if (spec.selector === undefined && spec.url === undefined && spec.text === undefined && spec.load === undefined) {
      if (spec.timeout === undefined) throw new TypeError('page.waitFor() needs a condition. ' + WAIT_FORMS);
      return { pause: spec.timeout };
    }
    return spec;
  };

  // page.url() and page.title() answer through an op, so they return a Promise
  // (Playwright's are synchronous). Used as a string, it names the call and the
  // fix instead of failing with "not a function" or reading "[object Promise]".
  const pendingCalls = new WeakMap();
  class PendingText extends Promise {
    static get [Symbol.species]() { return Promise; }
  }
  const notAwaited = (promise, use) => new TypeError(pendingCalls.get(promise) + ' returns a Promise in a Browser program, not a string: write (await ' + pendingCalls.get(promise) + ')' + use);
  for (const name of Object.getOwnPropertyNames(String.prototype)) {
    if (name === 'constructor') continue;
    const use = name === 'length' ? '.length' : '.' + name + '(…)';
    Object.defineProperty(PendingText.prototype, name, { get() { throw notAwaited(this, use); } });
  }
  Object.defineProperty(PendingText.prototype, Symbol.toPrimitive, { value() { throw notAwaited(this, ' to get the string'); } });
  const pendingText = (call, promise) => {
    const pending = new PendingText((resolve, reject) => { promise.then(resolve, reject); });
    pendingCalls.set(pending, call);
    return pending;
  };

  class Page {
    constructor(tabId) {
      this.tabId = tabId;
      // What browser.tabs() read about the tab (owner, visible, ...); null on other pages.
      this.info = null;
      return withMissingHint('page', this, Page.prototype);
    }
    toJSON() { return { __browserPage: true, tabId: this.tabId }; }
    get keyboard() {
      const tabId = this.tabId;
      return Object.freeze({
        press(key, options) { return runValue({ op: 'press', key: String(key), tabId, ...timeoutOf(options) }); },
        type(value, options) { return runValue({ op: 'type', value: String(value), tabId, ...timeoutOf(options) }); },
        insertText(value) { return runValue({ op: 'type', value: String(value), tabId }); },
        down: notAvailable('page.keyboard.down()', 'Use page.keyboard.press("Shift+ArrowDown") with the whole chord, or locator.press(key).'),
        up: notAvailable('page.keyboard.up()', 'Use page.keyboard.press(key) with the whole chord, or locator.press(key).'),
      });
    }
    get mouse() {
      const tabId = this.tabId;
      const point = (x, y) => {
        if (typeof x !== 'number' || typeof y !== 'number') throw new TypeError('page.mouse takes viewport coordinates x and y in CSS pixels.');
        return { x, y };
      };
      return Object.freeze({
        click(x, y, options) {
          return runWrite({ op: 'mouseClick', tabId, ...point(x, y), ...(options && options.button ? { button: options.button } : {}), ...(options && options.clickCount ? { clickCount: options.clickCount } : {}) });
        },
        dblclick(x, y, options) {
          return runWrite({ op: 'mouseClick', tabId, ...point(x, y), clickCount: 2, ...(options && options.button ? { button: options.button } : {}) });
        },
        move(x, y) { return runValue({ op: 'mouseMove', tabId, ...point(x, y) }); },
        wheel(deltaX, deltaY, options) {
          const at = options && typeof options.x === 'number' && typeof options.y === 'number' ? point(options.x, options.y) : { x: 1, y: 1 };
          return runValue({ op: 'mouseWheel', tabId, ...at, deltaX: Number(deltaX) || 0, deltaY: Number(deltaY) || 0 });
        },
        down: notAvailable('page.mouse.down()', 'Use page.mouse.click(x, y) or locator.click().'),
        up: notAvailable('page.mouse.up()', 'Use page.mouse.click(x, y) or locator.click().'),
      });
    }
    _load(op, options) {
      const wait = options && options.waitUntil === 'domcontentloaded' ? { wait: 'domcontentloaded' } : {};
      return runValue({ ...op, tabId: this.tabId, ...wait, ...timeoutOf(options) });
    }
    goto(url, options) { return this._load({ op: 'goto', url: String(url) }, options); }
    goBack(options) { return this._load({ op: 'back' }, options); }
    back(options) { return this.goBack(options); }
    reload(options) { return this._load({ op: 'reload' }, options); }
    url() { return pendingText('page.url()', runValue({ op: 'url', tabId: this.tabId })); }
    title() { return pendingText('page.title()', runValue({ op: 'title', tabId: this.tabId })); }
    content() { return this.locator('html').first().outerHTML(); }
    async close() { await runValue({ op: 'closeTab', tabId: this.tabId }); }
    // Takes control of this page (select_tab): a user's page needs it before a write.
    async bringToFront() { await runValue({ op: 'selectTab', tabId: this.tabId }); }
    // mark_tab: the page stays open for the next turn, or after this one with { deliverable: true }.
    keep(options) {
      return runValue({ op: 'keep', tabId: this.tabId, ...(options && options.deliverable === true ? { deliverable: true } : {}) });
    }
    // show_tab: puts this page in front of the user; control and turn-end retention do not change.
    async show() {
      const shown = await runValue({ op: 'show', tabId: this.tabId });
      return {
        shown: shown.shown === true,
        ...(shown.pending === true ? { pending: true } : {}),
        panelVisible: shown.panelVisible === true,
        ...(typeof shown.notice === 'string' ? { notice: shown.notice } : {}),
      };
    }

    _locator(steps) { return new Locator(this.tabId, steps); }
    locator(selector) { return this._locator(selectorSteps(selector)); }
    getByRole(role, options) { return this._locator([byRole(role, options)]); }
    getByText(value, options) { return this._locator([byText('text', value, options)]); }
    getByLabel(value, options) { return this._locator([byText('label', value, options)]); }
    getByPlaceholder(value, options) { return this._locator([byText('placeholder', value, options)]); }
    getByTestId(id) { return this.locator('[data-testid=' + stringify(String(id)) + ']'); }
    ref(ref) { return this._locator([{ by: 'ref', ref: String(ref) }]); }

    click(selector, options) { return this.locator(selector).click(options); }
    tap(selector, options) { return this.locator(selector).tap(options); }
    dblclick(selector, options) { return this.locator(selector).dblclick(options); }
    hover(selector, options) { return this.locator(selector).hover(options); }
    fill(selector, value, options) { return this.locator(selector).fill(value, options); }
    type(selector, value, options) { return this.locator(selector).type(value, options); }
    press(selector, key, options) { return this.locator(selector).press(key, options); }
    check(selector, options) { return this.locator(selector).check(options); }
    uncheck(selector, options) { return this.locator(selector).uncheck(options); }
    selectOption(selector, value, options) { return this.locator(selector).selectOption(value, options); }
    textContent(selector, options) { return this.locator(selector).textContent(options); }
    innerText(selector, options) { return this.locator(selector).innerText(options); }
    inputValue(selector, options) { return this.locator(selector).inputValue(options); }
    getAttribute(selector, name, options) { return this.locator(selector).getAttribute(name, options); }
    innerHTML(selector, options) { return this.locator(selector).innerHTML(options); }
    isVisible(selector) { return this.locator(selector).isVisible(); }
    isEnabled(selector) { return this.locator(selector).isEnabled(); }
    isChecked(selector) { return this.locator(selector).isChecked(); }
    $(selector) { return Promise.resolve(this.locator(selector).first()); }
    $$(selector) { return this.locator(selector).all(); }

    async waitFor(condition) {
      const spec = waitCondition(condition);
      if (spec.pause !== undefined) {
        await globalThis.sleep(spec.pause);
        return;
      }
      const steps = spec.selector !== undefined ? selectorSteps(spec.selector) : undefined;
      await runValue({
        op: 'waitFor',
        tabId: this.tabId,
        ...(steps ? { target: { tabId: this.tabId, chain: steps } } : {}),
        ...(spec.state ? { state: spec.state } : {}),
        ...(spec.url !== undefined ? { url: textSpec(spec.url) } : {}),
        ...(spec.text !== undefined ? { text: textSpec(spec.text) } : {}),
        ...(spec.load ? { load: spec.load } : {}),
        ...timeoutOf(spec),
      });
    }
    waitForLoadState(state, options) {
      return this.waitFor({ load: state === 'domcontentloaded' ? 'domcontentloaded' : 'load', ...(options && options.timeout !== undefined ? { timeout: options.timeout } : {}) });
    }
    waitForURL(url, options) { return this.waitFor({ url, ...(options && options.timeout !== undefined ? { timeout: options.timeout } : {}) }); }
    waitForTimeout(ms) { return globalThis.sleep(ms); }
    async waitForSelector(selector, options) {
      const locator = this.locator(selector);
      await locator.waitFor(options);
      return locator;
    }
    // Waits behind the ops already called, as in Promise.all([page.waitForNavigation(), link.click()]).
    async waitForNavigation(options) {
      await opsIdle();
      await this.waitForLoadState('load', options);
    }
    async waitForResponse(urlIncludes, options) {
      if (typeof urlIncludes !== 'string') throw new TypeError('waitForResponse() takes part of the URL as a string.');
      const afterSequence = await runValue({ op: 'networkCheckpoint', tabId: this.tabId });
      await opsIdle();
      return runValue({ op: 'waitForResponse', urlIncludes, afterSequence, tabId: this.tabId, ...timeoutOf(options) });
    }
    observe(options) { return runValue({ op: 'observe', tabId: this.tabId, ...(options && options.mode ? { mode: options.mode } : {}) }); }
    evaluate(fn, arg) { return runPageScript({ tabId: this.tabId }, fn, arg); }
    $eval(selector, fn, arg) { return this.locator(selector).first().evaluate(fn, arg); }
    $$eval(selector, fn, arg) { return this.locator(selector).evaluateAll(fn, arg); }
    waitForFunction(fn, arg, options) { return runPageScript({ tabId: this.tabId, poll: true, ...timeoutOf(options) }, fn, arg); }
    async screenshot(options) {
      await runValue({ op: 'screenshot', tabId: this.tabId, ...(options && options.fullPage === true ? { fullPage: true } : {}) });
      return { attached: true };
    }
    handleDialog(options) {
      if (!options || typeof options.dialogId !== 'string' || (options.action !== 'accept' && options.action !== 'dismiss')) {
        throw new TypeError("handleDialog() needs { dialogId, action: 'accept' | 'dismiss', promptText? }.");
      }
      return runValue({ op: 'handleDialog', dialogId: options.dialogId, action: options.action, tabId: this.tabId, ...(typeof options.promptText === 'string' ? { promptText: options.promptText } : {}) });
    }
  }
  for (const [name, instead] of Object.entries({
    evaluateHandle: NO_HANDLES,
    addScriptTag: 'Run the code with page.evaluate(() => ...) instead.',
    addInitScript: 'Run the code with page.evaluate(() => ...) after the page loads.',
    exposeFunction: 'A page script cannot call back into the program: pass what it needs as arg and use what it returns.',
    context: 'A program has no browser context: use browser.tabs() and browser.newPage(url).',
    frames: 'Locators already reach into iframes: use page.locator(css) directly.',
    mainFrame: 'Locators already reach into iframes: use page.locator(css) directly.',
    frame: 'Locators already reach into iframes: use page.locator(css) directly.',
    frameLocator: 'Locators already reach into iframes: use page.locator(css) directly.',
    setViewportSize: 'The viewport is fixed.',
    pdf: 'Use page.screenshot().',
    on: 'A JavaScript dialog throws JsDialogActive (with .dialog.dialogId) from the call it interrupted; read it with page.observe(), then page.handleDialog({ dialogId, action }).',
    once: 'A JavaScript dialog throws JsDialogActive (with .dialog.dialogId) from the call it interrupted; read it with page.observe(), then page.handleDialog({ dialogId, action }).',
    waitForEvent: 'A click that opens a tab returns it as { popup }.',
    route: 'Requests cannot be intercepted.',
    setContent: 'Use page.goto(url).',
  })) {
    Page.prototype[name] = notAvailable('page.' + name + '()', instead);
  }

  // One list_tabs row as a page's info: what the tab was when browser.tabs() read it.
  const tabInfo = (entry) => Object.freeze({
    url: typeof entry.url === 'string' ? entry.url : '',
    title: typeof entry.title === 'string' ? entry.title : '',
    kind: entry.surfaceKind === 'miniapp' ? 'miniapp' : 'web',
    ...(entry.owner === 'agent' || entry.owner === 'user' ? { owner: entry.owner } : {}),
    ...(typeof entry.retention === 'string' ? { retention: entry.retention } : {}),
    current: entry.current === true,
    visible: entry.visible === true,
    asleep: entry.asleep === true,
    takenOverLastTurn: entry.takenOverLastTurn === true,
  });

  const browserApi = Object.freeze({
    errors: Object.freeze(errors),
    async page() {
      const list = await runValue({ op: 'tabs' });
      if (typeof list.currentTabId !== 'number') {
        throw new BrowserError({
          code: 'TAB_NOT_CONTROLLED',
          message: 'TAB_NOT_CONTROLLED: browser.page() found no page to work on.',
          recovery: 'Pick a page from browser.tabs() and call page.bringToFront() on it, or open one with browser.newPage(url).',
        });
      }
      return new Page(list.currentTabId);
    },
    async tabs() {
      const list = await runValue({ op: 'tabs' });
      return (list.tabs || []).map((entry) => {
        const page = new Page(entry.tabId);
        if (typeof entry.url === 'string') page.lastUrl = entry.url;
        if (typeof entry.title === 'string') page.lastTitle = entry.title;
        page.current = entry.current === true;
        page.info = tabInfo(entry);
        return page;
      });
    },
    // The Browser panel as list_tabs reports it: is it on screen, and which page it shows.
    // current: false only reads the list: it does not resolve (or open) the page browser.page() uses.
    async panel() {
      const list = await runValue({ op: 'tabs', current: false });
      return Object.freeze({
        visible: list.panelVisible === true,
        visibleTabId: typeof list.visibleTabId === 'number' ? list.visibleTabId : null,
      });
    },
    async newPage(url, options) {
      if (typeof url !== 'string') throw new TypeError('browser.newPage() needs an http(s) URL.');
      const opened = await runValue({ op: 'newPage', url });
      const page = new Page(opened.tabId);
      // open_tab { url, show: true }: the new page goes in front of the user too.
      if (options && options.show === true) await page.show();
      return page;
    },
  });
  globalThis.browser = withMissingHint('browser', browserApi, browserApi);
  Object.assign(globalThis, errors);

  const revive = (value) => {
    if (Array.isArray(value)) return value.map(revive);
    if (!value || typeof value !== 'object') return value;
    if (value.__browserPage === true) return new Page(value.tabId);
    if (value.__browserLocator === true) return new Locator(value.tabId, value.chain);
    const out = {};
    for (const key of Object.keys(value)) out[key] = revive(value[key]);
    return out;
  };
  const initial = globalThis.__programInitialState;
  delete globalThis.__programInitialState;
  globalThis.state = typeof initial === 'string' ? revive(JSON.parse(initial)) : {};
})();
`;
