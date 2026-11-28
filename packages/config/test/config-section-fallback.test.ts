import { describe, expect, it } from 'vitest';

import type { ConfigIssue } from '../src/config.js';
import { resolveConfigFromRaw } from '../src/config.js';
import { createSectionFallback } from '../src/config-section-fallback.js';

// Every top-level key read by resolveConfigFromRaw. A section parser that rejects
// its input must not take the whole config (and therefore the runtime) down:
// the section falls back to its default and the problem is reported instead.
const SECTIONS = [
  'advisor', 'agentRuntime', 'agentStop', 'agents', 'askUser', 'asr', 'beta', 'browser',
  'cli', 'contentReview', 'contextManagement', 'custom_provider',
  'defaultLightModel', 'defaultModel', 'defaultModelContextWindow', 'defaultModelThinking',
  'defaultModelVariant', 'devPort', 'diagnostics', 'goal', 'logLevel', 'logRetentionDays',
  'mcpToolSearch', 'memory', 'mergeRequests', 'miniAppSuggestion', 'minimaxModelContextLimits',
  'minimaxModelSource', 'minimax_api', 'nextStepBox', 'nexus', 'notifications', 'opencode',
  'permission', 'permissionMode', 'pluginAppearanceStartupFault', 'pluginRecommendation', 'plugins',
  'promptConfig',
  'promptSuggestion', 'provider', 'quotaAutoResume', 'requestMedia', 'review', 'runawayGuard',
  'sandbox', 'sessionRotate', 'sessionTitle', 'skillEvolve', 'skills', 'skipParentDeathGuard',
  'skipWindowsHardSafetyChecks', 'sseErrorPush', 'startupRecoveryFault', 'subagent',
  'toolResultCompaction', 'tui', 'defaultAdvisor', 'worktreeAutoCleanupEnabled',
  'worktreeKeepCount', 'worktreeRefreshBeforeCreate',
];
// Keys parsed together report the group's first key.
const SECTION_GROUP: Record<string, string> = {
  defaultModel: 'provider',
  defaultAdvisor: 'advisor',
  worktreeKeepCount: 'worktreeAutoCleanupEnabled',
  worktreeRefreshBeforeCreate: 'worktreeAutoCleanupEnabled',
};
const VALUES: unknown[] = ['x', 1, -1, 0, 1.5, true, [], ['x', 1], {}, { a: 1 }, { enabled: 'x' }, null];
const NESTED: Record<string, unknown>[] = [
  { sandbox: { filesystem: { policy: { mode: 'danger_full_access' } } } },
  { sandbox: { network: { policy: { mode: 'x' }, deniedDomains: ['http://x'] } } },
  { sandbox: { localAccess: 'x' } },
  { skillEvolve: { lifecycle: { staleThresholdDays: 90, archiveThresholdDays: 30 } } },
  { plugins: { forbidden: ['ok', ''] } },
];

describe('config section fallback', () => {
  it.each(SECTIONS)('never throws for an invalid %s section', (section) => {
    for (const value of VALUES) {
      const resolved = resolveConfigFromRaw({ [section]: value, logLevel: 'debug' }, '/tmp/mavis-config-issues');
      if (section !== 'logLevel') expect(resolved.logLevel).toBe('debug');
      for (const issue of resolved.configIssues) {
        expect(issue).toMatchObject({ kind: 'invalid_section', section: SECTION_GROUP[section] ?? section });
      }
    }
  });

  it.each(NESTED)('reports a nested invalid value instead of throwing: %j', (raw) => {
    const resolved = resolveConfigFromRaw({ ...raw, logLevel: 'debug' }, '/tmp/mavis-config-issues');
    expect(resolved.logLevel).toBe('debug');
    expect(resolved.configIssues).toEqual([
      expect.objectContaining({ kind: 'invalid_section', section: Object.keys(raw)[0] }),
    ]);
  });

  it('accepts an empty config, so every section has a last fallback that cannot throw', () => {
    // createSectionFallback ends with parse({}); a parser that rejected it would
    // throw out of getConfig() again. An empty config.yaml must also load on its own.
    expect(resolveConfigFromRaw({}, '/tmp/mavis-config-issues').configIssues).toEqual([]);
  });

  it('reports each invalid section once', () => {
    const resolved = resolveConfigFromRaw(
      { minimaxModelContextLimits: { 'MiniMax-M2': -1 }, sandbox: 'x' },
      '/tmp/mavis-config-issues',
    );
    const sections = resolved.configIssues.map((issue) => issue.section);
    expect(new Set(sections).size).toBe(sections.length);
  });

  it('keeps every valid section when several sections are invalid', () => {
    const resolved = resolveConfigFromRaw(
      { logLevel: 'debug', plugins: null, sandbox: 'full', browser: { headless: true } },
      '/tmp/mavis-config-issues',
    );
    expect(resolved.logLevel).toBe('debug');
    expect(resolved.configIssues.map((issue) => issue.section)).toEqual(['plugins', 'sandbox']);
  });
});

describe('keys parsed together', () => {
  const parse = (source: Record<string, unknown>) => {
    if (source.mode === 'bad') throw new Error('Invalid mode "bad"');
    if (source.level === 'bad') throw new Error('Invalid level "bad"');
    return { mode: source.mode ?? 'default', level: source.level ?? 'default' };
  };

  it('drops only the key at fault and keeps its valid sibling', () => {
    const issues: ConfigIssue[] = [];
    const section = createSectionFallback({ mode: 'bad', level: 'high' }, issues);
    expect(section(['mode', 'level'], parse)).toEqual({ mode: 'default', level: 'high' });
    expect(issues).toEqual([expect.objectContaining({ kind: 'invalid_section', section: 'mode' })]);
  });

  it('falls back for the whole group and reports every key with its own error', () => {
    const issues: ConfigIssue[] = [];
    const section = createSectionFallback({ mode: 'bad', level: 'bad' }, issues);
    expect(section(['mode', 'level'], parse)).toEqual({ mode: 'default', level: 'default' });
    expect(issues).toEqual([
      { kind: 'invalid_section', section: 'mode', message: 'Invalid mode "…"' },
      { kind: 'invalid_section', section: 'level', message: 'Invalid level "…"' },
    ]);
  });
});
