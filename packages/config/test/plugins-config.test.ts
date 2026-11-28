import { describe, expect, it } from 'vitest';
import yaml from 'js-yaml';

import { resolveConfigFromRaw } from '../src/config.js';

describe('plugins.forbidden config', () => {
  it.each([{}, { plugins: {} }, { plugins: { forbidden: [] } }])(
    'defaults to an empty list for %j',
    (raw) => {
      expect(resolveConfigFromRaw(raw, process.cwd()).plugins).toEqual({ forbidden: [] });
    },
  );

  it('normalizes Unicode, case and whitespace, and deduplicates without changing the input', () => {
    const forbidden = [' ＭＣＯＤＥ ', 'mcode', 'Cafe\u0301', 'CAFÉ', '\tI\n', 'i', '插件', '　插件　'];
    const original = [...forbidden];

    expect(resolveConfigFromRaw({ plugins: { forbidden } }, process.cwd()).plugins).toEqual({
      forbidden: ['mcode', 'café', 'i', '插件'],
    });
    expect(forbidden).toEqual(original);
  });

  it('keeps multiple names and other configuration when resolving YAML', () => {
    const raw = yaml.load(`
plugins:
  forbidden:
    - code-review
    - browser-tools
pluginRecommendation:
  enabled: false
  dismissedPlugins: [another-plugin]
logLevel: debug
permissionMode: bypassPermissions
notifications:
  branchFinish: true
`) as Record<string, unknown>;

    expect(resolveConfigFromRaw(raw, process.cwd())).toMatchObject({
      plugins: { forbidden: ['code-review', 'browser-tools'] },
      pluginRecommendation: { enabled: false, dismissedPlugins: ['another-plugin'] },
      logLevel: 'debug',
      permissionMode: 'bypassPermissions',
      notifications: { branchFinish: true },
    });
  });

  it('keeps selector-like strings literal without expanding them', () => {
    expect(
      resolveConfigFromRaw(
        { plugins: { forbidden: [' Code-Review@Marketplace ', 'code-review'] } },
        process.cwd(),
      ).plugins.forbidden,
    ).toEqual(['code-review@marketplace', 'code-review']);
  });

  const invalidPlugins = (
    raw: Record<string, unknown>,
    message: string,
    readable: string[] = [],
  ) => {
    const resolved = resolveConfigFromRaw({ ...raw, logLevel: 'debug' }, process.cwd());
    // Fail closed to official plugins only, keeping the names that can be read.
    expect(resolved.plugins).toEqual({ forbidden: readable, onlyOfficial: true });
    expect(resolved.logLevel).toBe('debug');
    expect(resolved.configIssues).toEqual([
      { kind: 'invalid_section', section: 'plugins', message, failClosed: true },
    ]);
  };

  it('keeps the readable forbidden names when the plugins section fails closed', () => {
    const resolved = resolveConfigFromRaw(
      { plugins: { forbidden: [' Code-Review ', '', 42, 'code-review'] } },
      process.cwd(),
    );
    // An official plugin the user turned off must stay off.
    expect(resolved.plugins).toEqual({ forbidden: ['code-review'], onlyOfficial: true });
    expect(resolved.configIssues).toEqual([
      expect.objectContaining({ section: 'plugins', failClosed: true }),
    ]);
  });

  it.each(['null', 'false', '42', '"code-review"', '[]', '[code-review]', '2026-01-01'])(
    'reports an invalid plugins section and starts with defaults: %s',
    (value) => {
      const raw = yaml.load(`plugins: ${value}`) as Record<string, unknown>;
      invalidPlugins(raw, 'Invalid plugins config: expected an object.');
    },
  );

  it.each(['null', 'false', '42', '"code-review"', '{}', '{ name: code-review }'])(
    'reports a non-array plugins.forbidden and starts with defaults: %s',
    (value) => {
      const raw = yaml.load(`plugins: { forbidden: ${value} }`) as Record<string, unknown>;
      invalidPlugins(raw, 'Invalid plugins.forbidden config: expected an array of plugin names.');
    },
  );

  it.each([null, false, 42, {}, [], '', ' \t\n', '　'])(
    'reports an invalid entry instead of silently dropping it: %j',
    (name) => {
      invalidPlugins(
        { plugins: { forbidden: ['code-review', name] } },
        'Invalid plugins.forbidden[1]: expected a non-empty plugin name string.',
        ['code-review'],
      );
    },
  );
});
