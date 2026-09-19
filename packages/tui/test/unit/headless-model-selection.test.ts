import { describe, expect, it, vi } from 'vitest';

import { TuiExecError } from '../../src/headless/exit-policy.js';
import {
  parseHeadlessModelOverride,
  resolveHeadlessModelSelection,
} from '../../src/headless/model-selection.js';
import type { TuiModel, TuiSession } from '../../src/runtime/port.js';

const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh'];

function session(model?: TuiSession['model']): TuiSession {
  return { sessionId: 'session-1', workspaceDir: '/tmp/workspace', ...(model ? { model } : {}) };
}

function catalog(...models: readonly Partial<TuiModel>[]): TuiModel[] {
  return models.map((model) => ({ providerId: 'provider', modelId: 'model', ...model }));
}

function runtimeWith(models: readonly TuiModel[]) {
  return { listModels: vi.fn(async () => [...models]) };
}

const defaultRuntime = () =>
  runtimeWith(catalog({ selected: true, effortOptions: EFFORT_OPTIONS }));

async function expectInvocationError(
  promise: Promise<unknown>,
  expected: string | RegExp,
): Promise<void> {
  await expect(promise).rejects.toThrow(TuiExecError);
  await expect(promise).rejects.toThrow(expected);
}

describe('parseHeadlessModelOverride', () => {
  it.each(['model', '/model', 'provider/', 'provider/model#'])(
    'rejects the malformed reference %s',
    (value) => {
      expect(() => parseHeadlessModelOverride(value)).toThrow(
        '--model must use provider/model or provider/model#variant.',
      );
    },
  );

  it('keeps the provider, model, and legacy variant separate', () => {
    expect(parseHeadlessModelOverride('custom_provider:work/deep-reasoner#thinking')).toEqual({
      providerId: 'custom_provider:work',
      modelId: 'deep-reasoner',
      variant: 'thinking',
    });
    expect(parseHeadlessModelOverride('provider/model')).toEqual({
      providerId: 'provider',
      modelId: 'model',
    });
  });
});

describe('resolveHeadlessModelSelection', () => {
  it('returns no selection when neither --model nor --effort is given', async () => {
    const runtime = defaultRuntime();

    await expect(
      resolveHeadlessModelSelection({ session: session(), runtime }),
    ).resolves.toBeUndefined();
    expect(runtime.listModels).not.toHaveBeenCalled();
  });

  it('carries an explicit effort as thinking.effort beside the model', async () => {
    await expect(
      resolveHeadlessModelSelection({
        model: 'provider/model',
        effort: 'xhigh',
        session: session(),
        runtime: defaultRuntime(),
      }),
    ).resolves.toEqual({
      providerId: 'provider',
      modelId: 'model',
      thinking: { effort: 'xhigh' },
    });
  });

  it('omits thinking entirely when --effort is absent', async () => {
    const selection = await resolveHeadlessModelSelection({
      model: 'provider/model',
      session: session(),
      runtime: defaultRuntime(),
    });

    expect(selection).toEqual({ providerId: 'provider', modelId: 'model' });
    expect(selection).not.toHaveProperty('thinking');
  });

  it('keeps a legacy thinking variant while applying an explicit effort', async () => {
    await expect(
      resolveHeadlessModelSelection({
        model: 'provider/model#thinking',
        effort: 'high',
        session: session(),
        runtime: defaultRuntime(),
      }),
    ).resolves.toEqual({
      providerId: 'provider',
      modelId: 'model',
      variant: 'thinking',
      thinking: { effort: 'high' },
    });
  });

  it('completes the Session model when only --effort is given', async () => {
    const runtime = runtimeWith(
      catalog(
        { providerId: 'other', modelId: 'unselected', effortOptions: EFFORT_OPTIONS },
        { selected: true, effortOptions: EFFORT_OPTIONS },
      ),
    );

    await expect(
      resolveHeadlessModelSelection({ effort: 'xhigh', session: session(), runtime }),
    ).resolves.toEqual({
      providerId: 'provider',
      modelId: 'model',
      thinking: { effort: 'xhigh' },
    });
    expect(runtime.listModels).toHaveBeenCalledWith('session-1');
  });

  it('falls back to the Session model echo when the roster marks nothing selected', async () => {
    const runtime = runtimeWith(
      catalog({ providerId: 'echo', modelId: 'echoed', effortOptions: EFFORT_OPTIONS }),
    );

    await expect(
      resolveHeadlessModelSelection({
        effort: 'low',
        session: session({ providerId: 'echo', modelId: 'echoed' }),
        runtime,
      }),
    ).resolves.toEqual({
      providerId: 'echo',
      modelId: 'echoed',
      thinking: { effort: 'low' },
    });
  });

  it('keeps the Session model variant when only --effort is given', async () => {
    const runtime = runtimeWith(
      catalog({ selected: true, variant: 'fast', effortOptions: EFFORT_OPTIONS }),
    );

    await expect(
      resolveHeadlessModelSelection({ effort: 'xhigh', session: session(), runtime }),
    ).resolves.toEqual({
      providerId: 'provider',
      modelId: 'model',
      variant: 'fast',
      thinking: { effort: 'xhigh' },
    });
  });

  it('keeps the Session echo variant when the roster marks nothing selected', async () => {
    const runtime = runtimeWith(
      catalog({ providerId: 'echo', modelId: 'echoed', effortOptions: EFFORT_OPTIONS }),
    );

    await expect(
      resolveHeadlessModelSelection({
        effort: 'low',
        session: session({ providerId: 'echo', modelId: 'echoed', variant: 'thinking' }),
        runtime,
      }),
    ).resolves.toEqual({
      providerId: 'echo',
      modelId: 'echoed',
      variant: 'thinking',
      thinking: { effort: 'low' },
    });
  });

  it('rejects --effort when the Session itself runs a thinking-off variant', async () => {
    await expectInvocationError(
      resolveHeadlessModelSelection({
        effort: 'xhigh',
        session: session(),
        runtime: runtimeWith(
          catalog({ selected: true, variant: '', effortOptions: EFFORT_OPTIONS }),
        ),
      }),
      'this Session runs the thinking-off variant "#"',
    );
  });

  it('rejects --effort for an explicit model whose catalog default is thinking-off', async () => {
    await expectInvocationError(
      resolveHeadlessModelSelection({
        model: 'minimax/Official-M4',
        effort: 'high',
        session: session(),
        runtime: runtimeWith(
          catalog({
            providerId: 'minimax',
            modelId: 'Official-M4',
            variant: '',
            thinkingConfig: { mode: 'switchable', defaultValue: 'false' },
            effortOptions: ['low', 'high'],
          }),
        ),
      }),
      'minimax/Official-M4 runs with thinking off by default, so --effort high would be discarded. Pass --model minimax/Official-M4#thinking to turn thinking on.',
    );
  });

  it('omits the #thinking remedy when the model is forced off', async () => {
    const promise = resolveHeadlessModelSelection({
      model: 'provider/model',
      effort: 'high',
      session: session(),
      runtime: runtimeWith(
        catalog({
          variant: '',
          thinkingConfig: { mode: 'forced_off' },
          effortOptions: ['low', 'high'],
        }),
      ),
    });

    await expectInvocationError(promise, 'runs with thinking off by default');
    await expect(promise).rejects.not.toThrow('#thinking');
  });

  it('applies --effort to an explicit model whose catalog default keeps thinking on', async () => {
    await expect(
      resolveHeadlessModelSelection({
        model: 'provider/model',
        effort: 'high',
        session: session(),
        runtime: runtimeWith(
          catalog({
            variant: 'thinking',
            thinkingConfig: { mode: 'switchable', defaultValue: 'true' },
            effortOptions: EFFORT_OPTIONS,
          }),
        ),
      }),
    ).resolves.toEqual({
      providerId: 'provider',
      modelId: 'model',
      thinking: { effort: 'high' },
    });
  });

  it('reports an unknown model reference instead of blaming effort support', async () => {
    await expectInvocationError(
      resolveHeadlessModelSelection({
        model: 'typo/name',
        effort: 'high',
        session: session(),
        runtime: defaultRuntime(),
      }),
      "typo/name is not in this Session's model list, so --effort high cannot be validated.",
    );
  });

  it('keeps a declared model variant that only looks like an effort level', async () => {
    await expect(
      resolveHeadlessModelSelection({
        model: 'provider/model#High',
        session: session(),
        runtime: runtimeWith(
          catalog({
            selected: true,
            variant: 'High',
            supportedVariants: ['High', 'Low'],
            effortOptions: EFFORT_OPTIONS,
          }),
        ),
      }),
    ).resolves.toEqual({ providerId: 'provider', modelId: 'model', variant: 'High' });
  });

  it('rejects an effort level the model does not declare', async () => {
    await expectInvocationError(
      resolveHeadlessModelSelection({
        model: 'provider/model',
        effort: 'ultra',
        session: session(),
        runtime: defaultRuntime(),
      }),
      '--effort ultra is not available for provider/model. Available levels: low, medium, high, xhigh.',
    );
  });

  it('rejects --effort for a model without any effort option', async () => {
    await expectInvocationError(
      resolveHeadlessModelSelection({
        model: 'provider/model',
        effort: 'xhigh',
        session: session(),
        runtime: runtimeWith(catalog({ selected: true })),
      }),
      'provider/model does not support reasoning effort selection',
    );
  });

  it('rejects --effort when no model can be resolved', async () => {
    await expectInvocationError(
      resolveHeadlessModelSelection({
        effort: 'xhigh',
        session: session(),
        runtime: runtimeWith([]),
      }),
      '--effort could not resolve a model.',
    );
  });

  it('rejects --effort combined with a thinking-off variant', async () => {
    await expectInvocationError(
      resolveHeadlessModelSelection({
        model: 'provider/model#none-thinking',
        effort: 'xhigh',
        session: session(),
        runtime: defaultRuntime(),
      }),
      '--effort cannot be combined with the thinking-off variant "#none-thinking"',
    );
  });

  /**
   * Legacy compatibility. `#xhigh` predates `--effort`; Runtime reads it as a
   * model variant and downgrades the strength silently. Callers already rely on
   * that Run starting, so it must stay a variant rather than fail the Run.
   */
  it.each(['provider/model#xhigh', 'provider/model#High'])(
    'keeps the legacy effort-shaped variant %s runnable without --effort',
    async (model) => {
      const runtime = defaultRuntime();
      const variant = model.slice(model.indexOf('#') + 1);

      await expect(
        resolveHeadlessModelSelection({ model, session: session(), runtime }),
      ).resolves.toEqual({ providerId: 'provider', modelId: 'model', variant });
      // Nothing needs validating, so the roster is never consulted either.
      expect(runtime.listModels).not.toHaveBeenCalled();
    },
  );

  it('lets an explicit --effort travel beside a legacy effort-shaped variant', async () => {
    await expect(
      resolveHeadlessModelSelection({
        model: 'provider/model#xhigh',
        effort: 'xhigh',
        session: session(),
        runtime: defaultRuntime(),
      }),
    ).resolves.toEqual({
      providerId: 'provider',
      modelId: 'model',
      variant: 'xhigh',
      thinking: { effort: 'xhigh' },
    });
  });

  it('preserves a genuine model variant that is not an effort level', async () => {
    await expect(
      resolveHeadlessModelSelection({
        model: 'provider/model#fast',
        session: session(),
        runtime: runtimeWith(
          catalog({ selected: true, variant: 'fast', effortOptions: EFFORT_OPTIONS }),
        ),
      }),
    ).resolves.toEqual({ providerId: 'provider', modelId: 'model', variant: 'fast' });
  });

  it('fails --effort when the model roster cannot be read', async () => {
    const runtime = { listModels: vi.fn(async () => Promise.reject(new Error('roster down'))) };

    await expect(
      resolveHeadlessModelSelection({
        model: 'provider/model',
        effort: 'xhigh',
        session: session(),
        runtime,
      }),
    ).rejects.toThrow('the model roster is unavailable: roster down');
  });

  it('keeps an unverifiable variant working when the model roster cannot be read', async () => {
    const runtime = { listModels: vi.fn(async () => Promise.reject(new Error('roster down'))) };

    await expect(
      resolveHeadlessModelSelection({
        model: 'provider/model#fast',
        session: session(),
        runtime,
      }),
    ).resolves.toEqual({ providerId: 'provider', modelId: 'model', variant: 'fast' });
  });
});

describe('resolveHeadlessModelSelection with Kimi K3 effort levels', () => {
  const k3Runtime = () =>
    runtimeWith(
      catalog({
        providerId: 'custom_provider:moonshotai',
        modelId: 'kimi-k3',
        selected: true,
        effortOptions: ['low', 'high', 'max'],
      }),
    );

  it.each(['low', 'high', 'max'] as const)('accepts --effort %s', async (effort) => {
    await expect(
      resolveHeadlessModelSelection({
        model: 'custom_provider:moonshotai/kimi-k3',
        effort,
        session: session(),
        runtime: k3Runtime(),
      }),
    ).resolves.toEqual({
      providerId: 'custom_provider:moonshotai',
      modelId: 'kimi-k3',
      thinking: { effort },
    });
  });

  it('rejects an effort level Kimi K3 does not declare', async () => {
    await expectInvocationError(
      resolveHeadlessModelSelection({
        model: 'custom_provider:moonshotai/kimi-k3',
        effort: 'medium',
        session: session(),
        runtime: k3Runtime(),
      }),
      '--effort medium is not available for custom_provider:moonshotai/kimi-k3. Available levels: low, high, max.',
    );
  });
});
