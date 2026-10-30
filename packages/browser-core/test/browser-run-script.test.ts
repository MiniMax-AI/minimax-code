import { describe, expect, it } from 'vitest';

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
  terminations = 0;
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
    if (options?.signal?.aborted) {
      throw Object.assign(new Error('ABORTED: command aborted'), { code: 'ABORTED' });
    }
    if (method === this.timeoutMethod) {
      throw Object.assign(new Error(`BROWSER_OPERATION_TIMEOUT: ${method}`), {
        code: 'BROWSER_OPERATION_TIMEOUT',
      });
    }
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
    if (method === 'Runtime.evaluate') {
      this.evaluations += 1;
      this.evaluateTimeouts.push(options?.timeoutMs);
      this.onEvaluate?.(this.evaluations);
      const expression = String(params.expression);
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
      if (this.hung.size > 0) throw new Error('page is busy');
      const page = this.page;
      // eslint-disable-next-line no-new-func -- test page stands in for Chrome's evaluator
      const value = new Function('page', `return (${expression});`)(page);
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
    return {} as T;
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
) {
  const core = new BrowserCore({ provider: 'test', version: 1, actions: ['run_script'] as const });
  return core.createSession(transport, {
    captureScreenshot: async () => {
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

  it('keeps the interrupted page.evaluate warning when the action ends with a cancellation', async () => {
    const transport = new ScriptPageTransport();
    transport.hangOn = 'pendingContinuation';
    const controller = new AbortController();
    transport.onEvaluate = (count) => {
      // Cancel once the long-running page function has been sent.
      if (count >= 1) queueMicrotask(() => controller.abort());
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
