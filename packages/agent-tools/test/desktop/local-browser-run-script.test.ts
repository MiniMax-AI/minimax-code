import { describe, expect, it } from 'vitest';

import { buildLocalBrowserRuntimeTools } from '../../src/desktop/local-browser.js';
import type {
  LocalBrowserAdapter,
  LocalBrowserToolAction,
  LocalRuntimeToolContext,
} from '../../src/desktop/types.js';

const CTX: LocalRuntimeToolContext = { sessionId: 'session-script', turnId: 'turn-script' };
const IMAGE = Buffer.from('script-frame').toString('base64');

function buildTool(result: unknown) {
  const calls: Array<{ action: LocalBrowserToolAction; input: Record<string, unknown> }> = [];
  const adapter: LocalBrowserAdapter = {
    getCapabilities: () => ({
      provider: 'native-headless-chrome',
      version: 1,
      actions: ['run_script', 'screenshot'],
    }),
    async execute(_ctx, action, input) {
      calls.push({ action, input });
      return result;
    },
  };
  const [tool] = buildLocalBrowserRuntimeTools(adapter, {
    preprocessScreenshot: async (shot) => shot,
  });
  if (!tool) throw new Error('browser tool not assembled');
  return {
    calls,
    run: (input: Record<string, unknown>) =>
      tool.impl.execute(CTX, { action: 'run_script', input }) as Promise<{
        text: string;
        content: Array<{ type: string; data?: string }>;
        isError?: boolean;
        details: { code?: string };
      }>,
  };
}

describe('browser run_script tool result', () => {
  it('requires exactly one of code or path before reaching the provider', async () => {
    const { run, calls } = buildTool({ success: true });

    const both = await run({ code: 'return 1', path: 'e2e/play.js' });
    const neither = await run({ timeout: 5_000 });

    expect(both).toMatchObject({ isError: true, details: { code: 'invalid_input' } });
    expect(neither).toMatchObject({ isError: true, details: { code: 'invalid_input' } });
    expect(calls).toEqual([]);
  });

  it('attaches script screenshots as images on success and keeps their bytes out of the text', async () => {
    const { run } = buildTool({
      success: true,
      durationMs: 812,
      filename: 'e2e/play.js',
      logs: [{ level: 'log', text: 'clicked 28' }],
      pageEvaluate: { calls: 2, sites: [{ api: 'evaluate', line: 4, column: 9, calls: 2 }] },
      input: { keyEvents: 10, mouseEvents: 56, autoReleased: ['ShiftLeft'] },
      pageErrors: [],
      screenshots: [
        { label: 'after-clicks', reason: 'script', data: IMAGE, format: 'png', width: 800, height: 600 },
        { label: 'final', reason: 'script', data: IMAGE, format: 'png' },
      ],
    });

    const result = await run({ code: 'return 1' });
    const parsed = JSON.parse(result.text) as { result: Record<string, unknown> };

    expect(result.isError).toBeUndefined();
    expect(result.content.filter((part) => part.type === 'image')).toHaveLength(2);
    expect(result.text).not.toContain(IMAGE);
    expect(parsed.result).toMatchObject({
      pageEvaluate: { calls: 2 },
      input: { autoReleased: ['ShiftLeft'] },
      screenshots: [
        { image: 1, label: 'after-clicks', reason: 'script', attached: true },
        { image: 2, label: 'final', reason: 'script', attached: true },
      ],
    });
  });

  it('keeps a failed script text-only: screenshots are omitted and reported as unattached', async () => {
    const { run } = buildTool({
      success: false,
      code: 'SCRIPT_ASSERTION_FAILED',
      durationMs: 812,
      filename: 'e2e/play.js',
      logs: [{ level: 'log', text: 'clicked 28' }],
      error: { name: 'AssertionError', message: 'mismatch', location: { line: 14, column: 3 } },
      pageEvaluate: { calls: 2, sites: [{ api: 'evaluate', line: 4, column: 9, calls: 2 }] },
      input: { keyEvents: 10, mouseEvents: 56, autoReleased: ['ShiftLeft'] },
      pageErrors: [],
      screenshots: [
        { label: 'after-clicks', reason: 'script', data: IMAGE, format: 'png', width: 800, height: 600 },
        { label: 'failure', reason: 'failure', data: IMAGE, format: 'png' },
      ],
    });

    const result = await run({ code: 'assert.fail()' });
    const parsed = JSON.parse(result.text) as { result: Record<string, unknown> };

    expect(result.isError).toBe(true);
    // Error tool results must be text-only: some upstream model providers
    // reject is_error=true results carrying image blocks (eval 1019788).
    expect(result.content.filter((part) => part.type === 'image')).toHaveLength(0);
    expect(result.text).not.toContain(IMAGE);
    expect(parsed.result).toMatchObject({
      code: 'SCRIPT_ASSERTION_FAILED',
      error: { location: { line: 14 } },
      pageEvaluate: { calls: 2 },
      input: { autoReleased: ['ShiftLeft'] },
      screenshots: [
        { image: 1, label: 'after-clicks', reason: 'script', attached: false },
        { image: 2, label: 'failure', reason: 'failure', attached: false },
      ],
      visualObservation: { available: false, omittedOnError: true },
    });
  });

  it('surfaces the provider cancellation detail instead of a generic abort', async () => {
    const started = Promise.withResolvers<void>();
    const adapter: LocalBrowserAdapter = {
      getCapabilities: () => ({ provider: 'native-headless-chrome', version: 1, actions: ['run_script'] }),
      execute: (_ctx, _action, _input, signal) =>
        new Promise((_resolve, reject) => {
          // The provider settles after the abort with a more specific error.
          signal?.addEventListener('abort', () =>
            queueMicrotask(() =>
              reject(
                Object.assign(
                  new Error('ABORTED: Browser script was cancelled. 1 page.evaluate call(s) did not finish'),
                  { code: 'ABORTED' },
                ),
              ),
            ),
          );
          started.resolve();
        }),
    };
    const [tool] = buildLocalBrowserRuntimeTools(adapter, { preprocessScreenshot: async (shot) => shot });
    const controller = new AbortController();
    const pending = tool!.impl.execute(CTX, { action: 'run_script', input: { code: 'x' } }, controller.signal) as Promise<{
      text: string;
    }>;
    await started.promise;
    controller.abort();

    expect((await pending).text).toContain('page.evaluate call(s) did not finish');
  });
});
