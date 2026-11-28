import { describe, expect, it } from 'vitest';
import type { TuiModel } from '../../src/runtime/port.js';
import {
  cycleTuiEffort,
  normalizeTuiEffortOptions,
  resolveTuiEffortChoice,
  supportsTuiEffort,
} from '../../src/tui/features/model/effort.js';

function model(effortOptions?: string[], variant?: string): TuiModel {
  return {
    providerId: 'custom_provider:byok',
    modelId: 'byok-large-5',
    ...(effortOptions ? { effortOptions } : {}),
    ...(variant !== undefined ? { variant } : {}),
  };
}

describe('normalizeTuiEffortOptions', () => {
  it('trims, drops blanks and de-duplicates while keeping catalog order', () => {
    expect(normalizeTuiEffortOptions([' low ', 'medium', '', 'low', '   ', 'high'])).toEqual([
      'low',
      'medium',
      'high',
    ]);
  });

  it('returns an empty list for missing options', () => {
    expect(normalizeTuiEffortOptions(undefined)).toEqual([]);
    expect(normalizeTuiEffortOptions([])).toEqual([]);
  });
});

describe('supportsTuiEffort', () => {
  it('is false without usable options', () => {
    expect(supportsTuiEffort(undefined)).toBe(false);
    expect(supportsTuiEffort(model())).toBe(false);
    expect(supportsTuiEffort(model(['  ']))).toBe(false);
  });

  it('is true once at least one level is configured', () => {
    expect(supportsTuiEffort(model(['high']))).toBe(true);
  });
});

describe('resolveTuiEffortChoice', () => {
  it('restores the saved selection before the catalog default or midpoint', () => {
    const selected = {
      ...model(['low', 'medium', 'high', 'xhigh', 'max'], 'thinking'),
      selected: true,
      thinking: { effort: 'max' },
      defaultEffort: 'low',
    };
    expect(resolveTuiEffortChoice(selected)).toBe('max');
    expect(resolveTuiEffortChoice(selected, 'xhigh')).toBe('xhigh');
    expect(resolveTuiEffortChoice({ ...selected, selected: false })).toBe('low');
  });

  it('uses the catalog default before the midpoint and supports a fixed default', () => {
    expect(
      resolveTuiEffortChoice({ ...model(['low', 'medium', 'high']), defaultEffort: 'high' }),
    ).toBe('high');
    expect(resolveTuiEffortChoice({ ...model(), defaultEffort: 'max' })).toBe('max');
    expect(resolveTuiEffortChoice({ ...model(['low', 'high']), defaultEffort: 'removed' })).toBe(
      'high',
    );
  });

  it('does not restore a saved or catalog effort while thinking is off', () => {
    for (const variant of ['', 'none-thinking']) {
      expect(
        resolveTuiEffortChoice(
          { ...model(['low', 'high'], variant), defaultEffort: 'high' },
          'high',
        ),
      ).toBeUndefined();
    }
    expect(
      resolveTuiEffortChoice(
        { ...model(['low', 'high']), thinkingConfig: { mode: 'forced_off' } },
        'high',
      ),
    ).toBeUndefined();
  });

  it('falls back to the middle level like Runtime does', () => {
    expect(resolveTuiEffortChoice(model(['low', 'medium', 'high']))).toBe('medium');
  });

  it('uses the higher midpoint for even-length lists', () => {
    expect(resolveTuiEffortChoice(model(['low', 'medium', 'high', 'max']))).toBe('high');
  });

  it('keeps a stored level that still exists', () => {
    expect(resolveTuiEffortChoice(model(['low', 'medium', 'high']), ' high ')).toBe('high');
  });

  it('falls back when the stored level was removed from the provider config', () => {
    expect(resolveTuiEffortChoice(model(['low', 'medium', 'high']), 'xhigh')).toBe('medium');
  });

  it('keeps Thinking Off suppressing the configured default', () => {
    expect(resolveTuiEffortChoice(model(['low', 'medium', 'high'], ''))).toBeUndefined();
    expect(resolveTuiEffortChoice(model(['low', 'medium', 'high'], 'none-thinking'))).toBeUndefined();
  });

  it('applies the configured default when the legacy variant is thinking-on', () => {
    // `thinking` means thinking is on, which is exactly when an effort applies.
    // Treating it as "no effort" made Runtime omit the level and the provider
    // fall back to its own default.
    expect(resolveTuiEffortChoice(model(['xhigh'], 'thinking'))).toBe('xhigh');
    expect(resolveTuiEffortChoice(model(['low', 'medium', 'high'], 'thinking'), 'removed')).toBe(
      'medium',
    );
  });

  it('keeps a genuine non-thinking model variant suppressing the default', () => {
    expect(resolveTuiEffortChoice(model(['low', 'medium', 'high'], 'fast'))).toBeUndefined();
  });

  it('lets a valid stored effort coexist with the thinking-on variant', () => {
    expect(resolveTuiEffortChoice(model(['low', 'medium', 'high'], 'thinking'), 'high')).toBe(
      'high',
    );
  });

  it('returns undefined when the model exposes no levels', () => {
    expect(resolveTuiEffortChoice(model())).toBeUndefined();
    expect(resolveTuiEffortChoice(undefined, 'high')).toBeUndefined();
  });
});

describe('cycleTuiEffort', () => {
  const options = ['low', 'medium', 'high', 'xhigh', 'max'];

  it('moves one step in each direction', () => {
    expect(cycleTuiEffort(options, 'medium', 1)).toBe('high');
    expect(cycleTuiEffort(options, 'medium', -1)).toBe('low');
  });

  it('clamps at both ends instead of wrapping around', () => {
    expect(cycleTuiEffort(options, 'low', -1)).toBe('low');
    expect(cycleTuiEffort(options, 'max', 1)).toBe('max');
  });

  it('starts from the middle level when the current value is unknown', () => {
    expect(cycleTuiEffort(options, undefined, 1)).toBe('xhigh');
    expect(cycleTuiEffort(options, 'removed', -1)).toBe('medium');
  });

  it('returns undefined without options', () => {
    expect(cycleTuiEffort([], 'low', 1)).toBeUndefined();
    expect(cycleTuiEffort(undefined, 'low', 1)).toBeUndefined();
  });
});
