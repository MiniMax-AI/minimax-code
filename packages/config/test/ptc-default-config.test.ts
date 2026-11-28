import { describe, expect, it } from 'vitest';

import { resolveConfigFromRaw } from '../src/config.js';
import { resolveEffectivePtc } from '../src/effective-ptc.js';
import {
  describePtcDefaultFieldIssues,
  isPtcDefaultConfigured,
  isPtcRemoteApply,
  matchPtcDefaultUser,
  parsePtcDefaultConfig,
  resolvePtcToolCallMode,
  PTC_REMOTE_APPLY_VALUES,
  type PtcDefaultConfig,
} from '../src/ptc-default-config.js';

/** What Apollo sends when it configured nothing the runtime can act on. */
const DEFAULTS: PtcDefaultConfig = {
  version: '',
  rolloutPercent: 100,
  userIds: [],
};

describe('parsePtcDefaultConfig', () => {
  it.each([[undefined], [null], ['on'], [1], [[]], [{}]])(
    'leaves enabled absent for a value with no usable switch: %j',
    (raw) => {
      expect(parsePtcDefaultConfig(raw)).toEqual(DEFAULTS);
      expect(isPtcDefaultConfigured(raw)).toBe(false);
    },
  );

  it('reads a complete object', () => {
    const raw = {
      enabled: true,
      version: '2026-11-r1',
      rollout_percent: 50,
      user_ids: ['100', '200'],
    };

    expect(parsePtcDefaultConfig(raw)).toEqual({
      enabled: true,
      version: '2026-11-r1',
      rolloutPercent: 50,
      userIds: ['100', '200'],
    });
    expect(isPtcDefaultConfigured(raw)).toBe(true);
  });

  it('keeps an explicit off, which is a value to write and not a missing key', () => {
    const raw = { enabled: false, version: 'r1' };

    expect(parsePtcDefaultConfig(raw).enabled).toBe(false);
    expect(isPtcDefaultConfigured(raw)).toBe(true);
  });

  it.each([['true'], [1], [null], [{}], [[]]])(
    'never reads a non-boolean enabled as false: %j',
    (enabled) => {
      expect(parsePtcDefaultConfig({ enabled })).not.toHaveProperty('enabled');
      expect(isPtcDefaultConfigured({ enabled })).toBe(false);
    },
  );

  it.each([[1], [null], [{}]])('falls back on a non-string version: %j', (version) => {
    expect(parsePtcDefaultConfig({ version }).version).toBe('');
  });

  it.each([['50'], [null], [50.5], [-1], [101], [Number.NaN]])(
    'reads a mis-filled rollout_percent as 0, never as everyone: %j',
    (rollout_percent) => {
      expect(parsePtcDefaultConfig({ rollout_percent }).rolloutPercent).toBe(0);
    },
  );

  it('keeps everyone in when rollout_percent is absent', () => {
    expect(parsePtcDefaultConfig({}).rolloutPercent).toBe(100);
    expect(parsePtcDefaultConfig({ rollout_percent: undefined }).rolloutPercent).toBe(100);
    expect(parsePtcDefaultConfig({ enabled: true }).rolloutPercent).toBe(100);
  });

  it.each([[0], [100]])('accepts the rollout_percent boundary %j', (rollout_percent) => {
    expect(parsePtcDefaultConfig({ rollout_percent }).rolloutPercent).toBe(rollout_percent);
  });

  it('keeps only non-empty strings in user_ids', () => {
    expect(parsePtcDefaultConfig({ user_ids: ['100', 200, '', null] }).userIds).toEqual(['100']);
    expect(parsePtcDefaultConfig({ user_ids: '100' }).userIds).toEqual([]);
  });
});

describe('describePtcDefaultFieldIssues', () => {
  it.each([[undefined], [null], ['on'], [1], [[]]])(
    'reports nothing when Apollo sent no ptc_default object: %j',
    (raw) => {
      expect(describePtcDefaultFieldIssues(raw)).toEqual([]);
    },
  );

  it('reports nothing for a complete object', () => {
    expect(
      describePtcDefaultFieldIssues({
        enabled: true,
        version: 'r1',
        rollout_percent: 50,
        user_ids: ['100', '200'],
      }),
    ).toEqual([]);
  });

  it('reports every unusable field with what it read instead', () => {
    expect(
      describePtcDefaultFieldIssues({
        enabled: 'true',
        version: 1,
        rollout_percent: '50',
      }),
    ).toEqual([
      { field: 'enabled', received: '"true"', applied: 'enabled unusable' },
      { field: 'version', received: '1', applied: 'version=""' },
      { field: 'rollout_percent', received: '"50"', applied: 'rollout_percent=0' },
    ]);
  });

  it('reports a missing enabled, the one key every caller needs', () => {
    expect(describePtcDefaultFieldIssues({ version: 'r1' })).toEqual([
      { field: 'enabled', received: 'absent', applied: 'enabled unusable' },
    ]);
    expect(describePtcDefaultFieldIssues({})).toEqual([
      { field: 'enabled', received: 'absent', applied: 'enabled unusable' },
    ]);
  });

  it('keeps an absent rollout_percent out of the report, and a mis-filled one in it', () => {
    expect(describePtcDefaultFieldIssues({ enabled: true })).toEqual([]);
    expect(describePtcDefaultFieldIssues({ enabled: true, rollout_percent: null })).toEqual([
      { field: 'rollout_percent', received: 'null', applied: 'rollout_percent=0' },
    ]);
    expect(describePtcDefaultFieldIssues({ enabled: true, rollout_percent: Number.NaN })).toEqual([
      { field: 'rollout_percent', received: 'NaN', applied: 'rollout_percent=0' },
    ]);
  });

  it.each([
    ['100,200', 'string'],
    [{ a: '100' }, 'object'],
    [null, 'null'],
    [100, 'number'],
  ])('names only the type of a mis-filled allowlist: %j', (user_ids, type) => {
    const issues = describePtcDefaultFieldIssues({ enabled: true, user_ids });

    expect(issues).toEqual([
      { field: 'user_ids', received: `not an array (${type})`, applied: 'user_ids=[]' },
    ]);
    // The uploaded log must not carry the IDs a mis-typed allowlist happens to hold.
    expect(JSON.stringify(issues)).not.toContain('100');
  });

  it('describes the allowlist by shape and never by its user IDs', () => {
    expect(describePtcDefaultFieldIssues({ enabled: true, user_ids: ['100', 200, ''] })).toEqual([
      { field: 'user_ids', received: '3 entries, 2 unusable', applied: 'user_ids kept 1' },
    ]);
    expect(
      JSON.stringify(describePtcDefaultFieldIssues({ enabled: true, user_ids: ['100', 200] })),
    ).not.toContain('100');
  });

  it('reports what the parser actually applied, so a changed fallback reaches the log', () => {
    const raw = {
      enabled: 'true',
      version: 1,
      rollout_percent: '50',
      user_ids: '100',
    };
    const parsed = parsePtcDefaultConfig(raw);

    expect(describePtcDefaultFieldIssues(raw)).toEqual([
      { field: 'enabled', received: '"true"', applied: 'enabled unusable' },
      { field: 'version', received: '1', applied: `version="${parsed.version}"` },
      {
        field: 'rollout_percent',
        received: '"50"',
        applied: `rollout_percent=${parsed.rolloutPercent}`,
      },
      {
        field: 'user_ids',
        received: 'not an array (string)',
        applied: `user_ids=${JSON.stringify(parsed.userIds)}`,
      },
    ]);
    expect(parsed).not.toHaveProperty('enabled');
  });
});

describe('matchPtcDefaultUser', () => {
  const base: PtcDefaultConfig = { enabled: true, ...DEFAULTS };

  it('matches the allowlist by exact realUserID', () => {
    const config = { ...base, userIds: ['100'] };
    expect(matchPtcDefaultUser(config, '100').in_whitelist).toBe(true);
    expect(matchPtcDefaultUser(config, '1000').in_whitelist).toBe(false);
  });

  it('puts every user in at 100 and nobody in at 0', () => {
    for (const userId of ['1', '2', '3', 'abc', '99999999999']) {
      expect(matchPtcDefaultUser({ ...base, rolloutPercent: 100 }, userId).in_rollout).toBe(true);
      expect(matchPtcDefaultUser({ ...base, rolloutPercent: 0 }, userId).in_rollout).toBe(false);
    }
  });

  it('pins the bucket: djb2 of the prefixed ID, mod 100', () => {
    // djb2('ptc_default:100') is 2400652827, bucket 27, so the cut-off sits exactly there.
    expect(matchPtcDefaultUser({ ...base, rolloutPercent: 28 }, '100').in_rollout).toBe(true);
    expect(matchPtcDefaultUser({ ...base, rolloutPercent: 27 }, '100').in_rollout).toBe(false);
  });

  it('only adds users when the percentage grows', () => {
    const ids = Array.from({ length: 200 }, (_, index) => String(1_000_000 + index));
    const members = (rolloutPercent: number) =>
      ids.filter((id) => matchPtcDefaultUser({ ...base, rolloutPercent }, id).in_rollout);
    const low = members(20);
    const high = new Set(members(60));

    expect(low.length).toBeGreaterThan(0);
    expect(high.size).toBeGreaterThan(low.length);
    expect(low.every((id) => high.has(id))).toBe(true);
  });

  it('matches nothing without an account', () => {
    expect(matchPtcDefaultUser({ ...base, userIds: [''] }, '')).toEqual({
      in_whitelist: false,
      in_rollout: false,
    });
  });
});

describe('isPtcRemoteApply', () => {
  it('accepts every value the apply endpoint can return', () => {
    expect([...PTC_REMOTE_APPLY_VALUES]).toEqual(['on', 'off', 'skip', 'done', 'none', 'failed']);
    for (const apply of PTC_REMOTE_APPLY_VALUES) {
      expect(isPtcRemoteApply(apply)).toBe(true);
    }
  });

  it.each([['ON'], ['skipped'], [''], [1], [null], [undefined], [{}], [['on']]])(
    'rejects anything else, so an unknown answer reads as none: %j',
    (value) => {
      expect(isPtcRemoteApply(value)).toBe(false);
    },
  );
});

describe('resolvePtcToolCallMode', () => {
  it.each([
    [true, false, { mode: 'ptc', source: 'user' }],
    [false, true, { mode: 'native', source: 'user' }],
    [undefined, true, { mode: 'ptc', source: 'build' }],
    [undefined, false, { mode: 'native', source: 'build' }],
  ] as const)('explicit %j, build %j', (explicit, buildDefault, expected) => {
    expect(resolvePtcToolCallMode({ explicit, buildDefault })).toEqual(expected);
  });
});

describe('resolveEffectivePtc', () => {
  it.each([
    [{ beta: { ptc: true } }, 'ptc'],
    [{ beta: { ptc: false } }, 'native'],
    [{ explicitPtc: true, beta: { ptc: true } }, 'ptc'],
    [{ explicitPtc: false, beta: { ptc: false } }, 'native'],
  ] as const)('follows what config.yaml holds: %j', (config, mode) => {
    expect(resolveEffectivePtc(config).mode).toBe(mode);
  });

  it('reports an unset switch as the build default, never as a user choice', () => {
    const resolved = resolveEffectivePtc({});
    expect(resolved.source).toBe('build');
    expect(resolved.mode).toBe(resolveEffectivePtc({ beta: {} }).mode);
  });
});

describe('Config.explicitPtc', () => {
  it('carries the saved value next to the resolved flag', () => {
    expect(resolveConfigFromRaw({ beta: { ptc: false } }, '/tmp/data').explicitPtc).toBe(false);
    expect(resolveConfigFromRaw({ beta: { ptc: true } }, '/tmp/data').explicitPtc).toBe(true);
  });

  it.each([[{}], [{ beta: {} }], [{ beta: 'on' }], [{ beta: { ptc: 'yes' } }]])(
    'is absent when the file holds no choice: %j',
    (raw) => {
      expect(resolveConfigFromRaw(raw, '/tmp/data').explicitPtc).toBeUndefined();
    },
  );

  it('never leaks the saved value into the beta section the API returns', () => {
    expect(resolveConfigFromRaw({ beta: { ptc: false } }, '/tmp/data').beta).not.toHaveProperty(
      'explicitPtc',
    );
  });
});
