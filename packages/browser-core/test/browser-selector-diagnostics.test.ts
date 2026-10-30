import { describe, expect, it } from 'vitest';

import {
  landmarkSelectorHead,
  selectorHead,
  selectorMissRecovery,
  selectorTail,
} from '../src/browser-selector-diagnostics.js';

describe('selectorTail', () => {
  it('returns the last compound after a top-level combinator', () => {
    expect(selectorTail('body > div:last-child select')).toBe('select');
    expect(selectorTail('form .row + .row ~ input[name="q"]')).toBe('input[name="q"]');
  });

  it('keeps bracketed and quoted parts intact', () => {
    expect(selectorTail('nav button[aria-label="Open menu"]')).toBe(
      'button[aria-label="Open menu"]',
    );
    expect(selectorTail('ul li:not(.a > .b)')).toBe('li:not(.a > .b)');
  });

  it('does not decompose single compounds or selector lists', () => {
    expect(selectorTail('[data-backend-node-id="41"]')).toBeUndefined();
    expect(selectorTail('button[aria-label=Notifications]')).toBeUndefined();
    expect(selectorTail('a b, c d')).toBeUndefined();
  });
});

describe('selectorMissRecovery', () => {
  it('points at the wrong ancestor chain when the tail alone still matches', () => {
    expect(selectorMissRecovery({ selectorTail: { selector: 'select', matchCount: 3 } })).toMatch(
      /alone matches 3 element\(s\)[\s\S]*ancestor/,
    );
  });

  it('reports a target that does not exist when even the tail misses', () => {
    expect(selectorMissRecovery({ selectorTail: { selector: 'select', matchCount: 0 } })).toMatch(
      /matches nothing/,
    );
  });

  it('explains that backend node ids are not DOM attributes', () => {
    expect(selectorMissRecovery({})).toMatch(/data-backend-node-id/);
  });
});

describe('selectorHead / landmarkSelectorHead', () => {
  it('returns the first compound or the whole single compound', () => {
    expect(selectorHead('main div.group > a')).toBe('main');
    expect(selectorHead('[role="dialog"] button')).toBe('[role="dialog"]');
    expect(selectorHead('form')).toBe('form');
    expect(selectorHead('a, b')).toBeUndefined();
  });

  it('recognises landmark tags and roles only', () => {
    expect(landmarkSelectorHead('main')).toBe('main');
    expect(landmarkSelectorHead('form')).toBe('form');
    expect(landmarkSelectorHead('[role=dialog]')).toBe('[role=dialog]');
    expect(landmarkSelectorHead('div[role="main"] p')).toBe('div[role="main"]');
    expect(landmarkSelectorHead('main.content')).toBeUndefined();
    expect(landmarkSelectorHead('.main')).toBeUndefined();
    expect(landmarkSelectorHead('button[aria-label=Notifications]')).toBeUndefined();
  });
});

describe('selectorMissRecovery with a missing landmark', () => {
  it('replaces the ref advice for a whole-selector landmark miss', () => {
    const recovery = selectorMissRecovery({
      missingLandmark: { selector: 'form', wholeSelector: true },
    });
    expect(recovery).toContain('no element matching "form"');
    expect(recovery).toContain('"body"');
    expect(recovery).not.toContain('data-backend-node-id');
  });
});
