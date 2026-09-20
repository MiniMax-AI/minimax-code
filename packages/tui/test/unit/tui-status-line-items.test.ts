import { afterEach, describe, expect, it } from 'vitest';

import { applyTuiRenderTheme, getTuiThemeSnapshot, tuiChalk, tuiColors } from '../../src/tui/theme/runtime.js';
import { MINIMAX_CODE_DARK_THEME, MINIMAX_CODE_LIGHT_THEME } from '../../src/tui/theme/palettes.js';
import { TuiStatusLine } from '../../src/tui/shell/chrome.js';
import { stripAnsi, visibleWidth } from '../../src/tui/rendering/text.js';
import { setCapabilityOverrides } from '../../src/tui/engine/public.js';
import type { TuiShellState } from '../../src/tui/shell/contracts.js';
import { resolveTuiAgentRef } from '../../src/tui/shell/status-protocol.js';
import {
  TUI_STATUS_LINE_DEFAULT_ITEMS,
  parseTuiStatusLineItem,
  parseTuiStatusLineItems,
} from '../../src/tui/shell/status-line-items.js';

const BASE_STATE: TuiShellState = {
  version: '0.1.0',
  workspace: '/home/dev/repo',
  homeDir: '/home/dev',
  runtimeStatus: 'ready',
  sessionTitle: 'Ship status line',
  model: 'minimax/m2',
  thinking: 'on',
  permissionMode: 'auto',
  workspaceGit: {
    isGitRepo: true,
    branch: 'feat/status-line',
    detached: false,
    isWorktree: false,
  },
};

function render(state: TuiShellState, width = 200): string {
  return new TuiStatusLine(state).render(width).join('\n');
}

describe('status line item parsing', () => {
  it('resolves canonical ids and known aliases', () => {
    expect(parseTuiStatusLineItem('current-dir')).toBe('current-dir');
    expect(parseTuiStatusLineItem('workspace')).toBe('current-dir');
    expect(parseTuiStatusLineItem('permissions')).toBe('approval-mode');
    expect(parseTuiStatusLineItem('context')).toBe('context-remaining');
    expect(parseTuiStatusLineItem('context-window')).toBe('context-window');
    expect(parseTuiStatusLineItem('cache-read')).toBe('cache-read-ratio');
    expect(parseTuiStatusLineItem('build-mode')).toBe('build-mode');
    expect(parseTuiStatusLineItem('status-protocol')).toBe('build-mode');
    expect(parseTuiStatusLineItem('vela')).toBe('build-mode');
    expect(parseTuiStatusLineItem('custom-command')).toBe('custom-command');
    expect(parseTuiStatusLineItem('custom')).toBe('custom-command');
    expect(parseTuiStatusLineItem('tips')).toBeUndefined();
  });

  it('is case and whitespace insensitive', () => {
    expect(parseTuiStatusLineItem('  Model-With-Reasoning ')).toBe('model-with-reasoning');
  });

  it('ignores unknown ids instead of failing', () => {
    expect(parseTuiStatusLineItem('five-hour-limit')).toBeUndefined();
    expect(parseTuiStatusLineItems(['current-dir', 'not-a-real-item', 'git-branch'])).toEqual([
      'current-dir',
      'git-branch',
    ]);
  });

  it('preserves configured order and drops duplicates', () => {
    expect(parseTuiStatusLineItems(['git-branch', 'current-dir', 'branch'])).toEqual([
      'git-branch',
      'current-dir',
    ]);
  });
});

describe('TuiStatusLine default items', () => {
  it('keeps build-mode and cache diagnostics out of the default order', () => {
    expect(TUI_STATUS_LINE_DEFAULT_ITEMS).not.toContain('build-mode');
    expect(TUI_STATUS_LINE_DEFAULT_ITEMS).toContain('context-remaining');
    expect(TUI_STATUS_LINE_DEFAULT_ITEMS).not.toContain('custom-command');
    expect(TUI_STATUS_LINE_DEFAULT_ITEMS).not.toContain('tips');
    expect(TUI_STATUS_LINE_DEFAULT_ITEMS).not.toContain('cache-read-ratio');
  });

  it('replaces capacity with live context headroom while preserving explicit configuration', () => {
    const state = {
      ...BASE_STATE,
      sessionCacheReadRatio: 0.9,
      contextUsage: { usedTokens: 80_000, contextWindowTokens: 100_000 },
    };
    const lowContext = stripAnsi(render(state));
    expect(lowContext).toContain('Context 20% left');
    expect(lowContext).not.toContain('Context 100K');
    expect(lowContext).not.toContain('Cache');

    const healthyContext = stripAnsi(
      render({
        ...state,
        contextUsage: { usedTokens: 50_000, contextWindowTokens: 100_000 },
      }),
    );
    expect(healthyContext).toContain('Context 50% left');
    expect(healthyContext).not.toContain('Context 100K');
    expect(render({ ...state, statusLineItems: ['model'] })).not.toContain('Context');
    expect(render({ ...state, statusLineItems: ['cache-read-ratio'] })).toContain('Cache 90%');
    expect(
      render({
        ...state,
        contextUsage: { usedTokens: Number.NaN, contextWindowTokens: 100_000 },
      }),
    ).not.toContain('NaN');
  });

  it('keeps explicitly configured capacity and headroom independent', () => {
    const explicit = stripAnsi(
      render({
        ...BASE_STATE,
        statusLineItems: ['context-window', 'context-remaining'],
        contextUsage: { usedTokens: 50_000, contextWindowTokens: 100_000 },
      }),
    );
    expect(explicit).toContain('Context 100K');
    expect(explicit).toContain('Context 50% left');
  });

  it('keeps rotating prose out of the stable status rail', () => {
    expect(render(BASE_STATE)).not.toContain('Tip:');
  });

  it('lets build-mode own the line when conditional items are also configured', () => {
    const line = render({
      ...BASE_STATE,
      statusLineItems: ['build-mode', 'context-remaining'],
      agentStatus: 'ready',
      contextUsage: { usedTokens: 40_000, contextWindowTokens: 200_000 },
    });
    expect(line).toContain('[V]');
    expect(line).not.toContain('Context 80% left');
  });
});

describe('context window capacity', () => {
  it.each([
    [1_000_000, '1M'],
    [512_000, '512K'],
    [128_001, '128001'],
  ] as const)('shows %d tokens by default before any usage is available', (tokens, label) => {
    expect(stripAnsi(render({ ...BASE_STATE, contextWindowTokens: tokens }))).toContain(
      `Context ${label}`,
    );
  });

  it('uses the Runtime usage window before the model fallback', () => {
    const line = stripAnsi(
      render({
        ...BASE_STATE,
        statusLineItems: ['context-window'],
        contextWindowTokens: 1_000_000,
        contextUsage: { usedTokens: 1_000, contextWindowTokens: 512_000 },
      }),
    );
    expect(line).toContain('Context 512K');
    expect(line).not.toContain('Context 1M');
    expect(line).not.toContain('% left');
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'hides unavailable capacity %s',
    (tokens) => {
      expect(
        render({
          ...BASE_STATE,
          statusLineItems: ['context-window'],
          contextWindowTokens: tokens,
        }).trim(),
      ).toBe('');
    },
  );

  it('honours configured items and keeps capacity readable at common widths', () => {
    const state = { ...BASE_STATE, contextWindowTokens: 1_000_000 };
    expect(render({ ...state, statusLineItems: ['model'] })).not.toContain('Context');
    expect(stripAnsi(render({ ...state, statusLineItems: ['context-window'] }))).toContain(
      'Context 1M',
    );
    for (const width of [80, 120]) {
      const line = render(state, width);
      expect(stripAnsi(line)).toMatch(/(?:Context|Ctx) 1M/u);
      expect(line.split('\n').every((row) => visibleWidth(row) <= width)).toBe(true);
    }
  });
});

describe('agent ref', () => {
  it('is stable, bounded, and opaque', () => {
    const firstTurn = 'turn_550e8400-e29b-41d4-a716-446655440000';
    const secondTurn = 'turn_6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    const firstRef = resolveTuiAgentRef(firstTurn);

    expect(firstRef).toMatch(/^[a-z0-9]{6}$/u);
    expect(resolveTuiAgentRef(firstTurn)).toBe(firstRef);
    expect(resolveTuiAgentRef(secondTurn)).toMatch(/^[a-z0-9]{6}$/u);
    expect(resolveTuiAgentRef(secondTurn)).not.toBe(firstRef);
    expect(firstRef).not.toContain('550e8400');
  });

  it('uses none when no Runtime turn id is available', () => {
    expect(resolveTuiAgentRef(undefined)).toBe('none');
    expect(resolveTuiAgentRef('   ')).toBe('none');
  });
});

describe('TuiStatusLine configured items', () => {
  it('renders only the configured items, in the configured order', () => {
    const line = render({
      ...BASE_STATE,
      statusLineItems: ['model-with-reasoning', 'current-dir'],
    });
    // The model label keeps only its last path segment, matching existing behaviour.
    expect(line).toContain('m2');
    expect(line).toContain('~/repo');
    // Git and session title are omitted because they were not configured.
    expect(line).not.toContain('feat/status-line');
    expect(line).not.toContain('Ship status line');
    expect(line.indexOf('m2')).toBeLessThan(line.indexOf('~/repo'));
  });

  it('honours an empty configured list as a blank status line', () => {
    expect(render({ ...BASE_STATE, statusLineItems: [] }).trim()).toBe('');
  });

  it('renders the model without the reasoning suffix for the model item', () => {
    const line = render({ ...BASE_STATE, statusLineItems: ['model'] });
    expect(line).toContain('m2');
    expect(line).not.toContain('Thinking');
  });
});

describe('context-remaining item', () => {
  const items: TuiShellState['statusLineItems'] = ['context-remaining'];

  it('falls back to the model context window when usage omits one', () => {
    const line = render({
      ...BASE_STATE,
      statusLineItems: items,
      contextUsage: { usedTokens: 50_000 },
      contextWindowTokens: 100_000,
    });
    expect(line).toContain('Context 50% left');
  });

  it('renders nothing when no context window can be resolved', () => {
    const line = render({
      ...BASE_STATE,
      statusLineItems: items,
      contextUsage: { usedTokens: 1_000 },
    });
    expect(line.trim()).toBe('');
  });

  it('clamps overflow to zero rather than reporting negative headroom', () => {
    const line = render({
      ...BASE_STATE,
      statusLineItems: items,
      contextUsage: { usedTokens: 150_000, contextWindowTokens: 100_000 },
    });
    expect(line).toContain('Context 0% left');
  });

  it('shrinks to a compact label on a narrow terminal', () => {
    const state: TuiShellState = {
      ...BASE_STATE,
      statusLineItems: ['current-dir', 'context-remaining'],
      contextUsage: { usedTokens: 25_000, contextWindowTokens: 100_000 },
    };
    expect(render(state)).toContain('Context 75% left');

    const narrow = render(state, 16);
    expect(narrow).not.toContain('Context 75% left');
    expect(narrow).toContain('75%');
  });
});

describe('cache-read-ratio item', () => {
  it('renders the Session-wide cache read ratio when prompt usage is available', () => {
    const line = render({
      ...BASE_STATE,
      statusLineItems: ['cache-read-ratio'],
      sessionCacheReadRatio: 0.8,
    });

    expect(line).toContain('Cache 80%');
  });

  it('renders nothing before the Runtime supplies a Session metric', () => {
    expect(render({ ...BASE_STATE, statusLineItems: ['cache-read-ratio'] }).trim()).toBe('');
  });

  it('shrinks to a compact label without changing the percentage', () => {
    const state: TuiShellState = {
      ...BASE_STATE,
      statusLineItems: ['current-dir', 'cache-read-ratio'],
      sessionCacheReadRatio: 0.923,
    };

    expect(render(state)).toContain('Cache 92%');
    expect(render(state, 16)).toContain('92%');
  });
});

describe('custom-command block display', () => {
  const blockState: TuiShellState = {
    ...BASE_STATE,
    statusLineItems: ['current-dir', 'custom-command', 'model'],
    customStatusText:
      'Context ready\nCI passed\nEnvironment test\nTasks idle\nExtra status\nToo many',
  };

  it.each([undefined, 'above', 'below'] as const)(
    'places custom rows %s without changing the original footer at any width',
    (position) => {
      const status = new TuiStatusLine(blockState, { display: 'block', maxLines: 2, position });
      const original = new TuiStatusLine({
        ...blockState,
        statusLineItems: ['current-dir', 'model'],
      });
      for (const width of [160, 40, 1]) {
        const lines = status.render(width).map(stripAnsi);
        const originalLines = original.render(width).slice(1).map(stripAnsi);
        expect(lines).toHaveLength(3 + originalLines.length);
        expect(
          position === 'below' ? lines.slice(1, 1 + originalLines.length) : lines.slice(3),
        ).toEqual(originalLines);
        expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
      }
      const lines = status.render(160).map(stripAnsi);
      expect(position === 'below' ? lines.slice(-2) : lines.slice(1, 3)).toEqual([
        'Context ready',
        'CI passed',
      ]);
    },
  );

  it.each([
    [undefined, 3],
    [Number.NaN, 3],
    [0, 1],
    [2.9, 2],
    [100, 5],
  ])('bounds maxLines %s to %s visible rows', (maxLines, expected) => {
    const status = new TuiStatusLine(blockState, { display: 'block', maxLines });
    expect(status.render(120)).toHaveLength(expected + 2);
  });

  it('sanitizes multiline controls, discards blank rows and truncates wide Unicode text', () => {
    const status = new TuiStatusLine(
      {
        ...blockState,
        statusLineItems: ['custom-command'],
        customStatusText:
          '\u001b[31m中文状态很长\u001b[0m\r\n\n\u0007\nCI\tpassed\rOK\n\u001b]0;title\u0007ready',
      },
      { display: 'block' },
    );
    const lines = status.render(10).map(stripAnsi);
    expect(lines).toEqual(['', '中文状态…', 'CI passed…', 'ready']);
    expect(lines.every((line) => visibleWidth(line) <= 10)).toBe(true);
    expect(lines.join('')).not.toMatch(/[\r\n\t\u0007\u001b]/u);
  });

  it.each(['above', 'below'] as const)(
    'shrinks custom rows %s first and restores them when the viewport grows',
    (position) => {
      const status = new TuiStatusLine(blockState, { display: 'block', maxLines: 5, position });
      const original = new TuiStatusLine({
        ...blockState,
        statusLineItems: ['current-dir', 'model'],
      });
      const lines = status.renderViewport(120, 3).map(stripAnsi);
      expect(position === 'below' ? lines.slice(-1) : lines.slice(1, -1)).toEqual([
        'Context ready',
      ]);
      expect(status.renderViewport(120, 2)).toEqual(original.render(120));
      expect(status.renderViewport(120, 0)).toEqual(original.render(120));
      expect(status.renderViewport(120, 20)).toHaveLength(7);
    },
  );

  it('does not reserve rows for empty or control-only output', () => {
    const original = new TuiStatusLine({
      ...blockState,
      statusLineItems: ['current-dir', 'model'],
    });
    for (const text of ['', '\n\u0007\u001b[0m\n', undefined]) {
      const status = new TuiStatusLine(
        { ...blockState, customStatusText: text },
        { display: 'block' },
      );
      expect(status.render(120)).toEqual(original.render(120));
    }
  });

  it('keeps an explicit custom-only block empty when there is no output or room', () => {
    const status = new TuiStatusLine(
      { ...blockState, statusLineItems: ['custom-command'] },
      { display: 'block' },
    );
    expect(status.renderViewport(120, 1)).toEqual([]);
    status.setState({ ...blockState, statusLineItems: ['custom-command'], customStatusText: '' });
    expect(status.render(120)).toEqual([]);
  });

  it('does not enable custom output through the block settings alone', () => {
    for (const statusLineItems of [undefined, [], ['model']] as const) {
      const state = { ...blockState, statusLineItems };
      expect(new TuiStatusLine(state, { display: 'block' }).render(120)).toEqual(
        new TuiStatusLine(state).render(120),
      );
    }
  });
});

describe('custom-command item', () => {
  it('ignores block position in inline mode and keeps only the first line', () => {
    const state: TuiShellState = {
      ...BASE_STATE,
      statusLineItems: ['current-dir', 'custom-command', 'model'],
      customStatusText: 'first\nsecond',
    };
    const above = new TuiStatusLine(state, { position: 'above' }).render(200);
    const below = new TuiStatusLine(state, { display: 'inline', position: 'below' }).render(200);
    expect(below).toEqual(above);
    expect(above.join('')).toContain('first');
    expect(above.join('')).not.toContain('second');
    expect(stripAnsi(above[1] ?? '')).toMatch(/repo.*first.*m2/u);
  });

  it('renders the latest command output as one ordinary muted segment', () => {
    const line = stripAnsi(
      render({
        ...BASE_STATE,
        statusLineItems: ['custom-command'],
        customStatusText: 'Cost $1.23',
      }),
    );
    expect(line).toContain('Cost $1.23');
  });

  it('renders nothing before the first successful command run', () => {
    expect(render({ ...BASE_STATE, statusLineItems: ['custom-command'] }).trim()).toBe('');
  });

  it('renders nothing when the last run deliberately blanked the item', () => {
    expect(
      render({ ...BASE_STATE, statusLineItems: ['custom-command'], customStatusText: '' }).trim(),
    ).toBe('');
  });

  it('strips ANSI and control characters from untrusted command output', () => {
    const line = render({
      ...BASE_STATE,
      statusLineItems: ['custom-command'],
      customStatusText: '\u001b[31mCost\u001b[0m \u0007$1.23',
    });
    expect(line).not.toContain('\u001b[31m');
    expect(line).not.toContain('\u0007');
    expect(stripAnsi(line)).toContain('Cost $1.23');
  });

  it('truncates long output instead of flooding the rail', () => {
    const line = stripAnsi(
      render({
        ...BASE_STATE,
        statusLineItems: ['custom-command'],
        customStatusText: 'x'.repeat(100),
      }),
    );
    expect(line).toContain('…');
    expect(line).not.toContain('x'.repeat(61));
  });

  it('yields the whole line to build-mode when both are configured', () => {
    const line = render({
      ...BASE_STATE,
      statusLineItems: ['build-mode', 'custom-command'],
      agentStatus: 'ready',
      customStatusText: 'Cost $1.23',
    });
    expect(line).toContain('[V]');
    expect(line).not.toContain('Cost $1.23');
  });
});

describe('review link status item', () => {
  afterEach(() => {
    setCapabilityOverrides({});
  });

  const withReview = (
    reviewLink: NonNullable<TuiShellState['workspaceGit']>['reviewLink'],
  ): TuiShellState => ({
    ...BASE_STATE,
    statusLineItems: ['review-link'],
    workspaceGit: { ...BASE_STATE.workspaceGit!, reviewLink },
  });

  it('resolves the vendor-neutral aliases users are likely to configure', () => {
    expect(parseTuiStatusLineItem('review-link')).toBe('review-link');
    expect(parseTuiStatusLineItem('pr')).toBe('review-link');
    expect(parseTuiStatusLineItem('mr')).toBe('review-link');
    expect(parseTuiStatusLineItem('merge-request')).toBe('review-link');
  });

  it('renders a GitLab merge request with its ! shorthand', () => {
    const line = stripAnsi(
      render(withReview({ vendor: 'gitlab', url: 'https://x/-/merge_requests/312', number: 312 })),
    );

    expect(line).toContain('MR');
    expect(line).toContain('!312');
  });

  it('renders a GitHub pull request with its # shorthand', () => {
    const line = stripAnsi(
      render(withReview({ vendor: 'github', url: 'https://x/pull/88', number: 88 })),
    );

    expect(line).toContain('PR');
    expect(line).toContain('#88');
  });

  it('renders nothing when the branch has no recorded review', () => {
    // The whole line collapses because `review-link` was the only item
    // configured — an unrecorded branch must not reserve a blank rail.
    expect(render({ ...BASE_STATE, statusLineItems: ['review-link'] })).toBe('');
  });

  it('stays in the default order next to the branch it belongs to', () => {
    expect(TUI_STATUS_LINE_DEFAULT_ITEMS).toContain('review-link');
    expect(TUI_STATUS_LINE_DEFAULT_ITEMS.indexOf('review-link')).toBe(
      TUI_STATUS_LINE_DEFAULT_ITEMS.indexOf('git-branch') + 1,
    );
  });

  it('wraps the segment in an OSC 8 hyperlink so the review can be opened', () => {
    setCapabilityOverrides({ hyperlinks: true });
    const url = 'https://github.com/acme/widgets/pull/50';

    const line = render(withReview({ vendor: 'github', url, number: 50 }));

    expect(line).toContain(`\u001b]8;;${url}\u001b\\`);
    expect(line).toContain('\u001b]8;;\u001b\\');
    expect(stripAnsi(line)).toContain('#50');
  });

  it('emits no escape where the terminal does not forward hyperlinks', () => {
    // tmux and screen without passthrough would render the escape as garbage.
    setCapabilityOverrides({ hyperlinks: false });

    const line = render(
      withReview({ vendor: 'github', url: 'https://github.com/acme/widgets/pull/50', number: 50 }),
    );

    expect(line).not.toContain(']8;;');
    expect(stripAnsi(line)).toContain('#50');
  });

  it('does not let the hyperlink escape count toward the line width', () => {
    setCapabilityOverrides({ hyperlinks: true });
    const url = 'https://github.com/acme/widgets/pull/50';

    const linked = stripAnsi(render(withReview({ vendor: 'github', url, number: 50 })));
    setCapabilityOverrides({ hyperlinks: false });
    const plain = stripAnsi(render(withReview({ vendor: 'github', url, number: 50 })));

    expect(linked).toBe(plain);
  });

  it('keeps the number visible when the line is too narrow for the vendor label', () => {
    const narrow = stripAnsi(
      render(
        withReview({ vendor: 'gitlab', url: 'https://x/-/merge_requests/312', number: 312 }),
        24,
      ),
    );

    expect(narrow).toContain('!312');
  });
});

describe('context meter item', () => {
  it('resolves the canonical id and its aliases', () => {
    expect(parseTuiStatusLineItem('context-meter')).toBe('context-meter');
    expect(parseTuiStatusLineItem('context-bar')).toBe('context-meter');
    expect(parseTuiStatusLineItem('context-gauge')).toBe('context-meter');
  });

  it('stays out of the default status line', () => {
    expect(TUI_STATUS_LINE_DEFAULT_ITEMS).toEqual([
      'current-dir', 'session-title', 'git-branch', 'review-link', 'plan-mode',
      'approval-mode', 'model-with-reasoning', 'context-window', 'subagent',
      'token-quota', 'context-remaining',
    ]);
    const state = {
      ...BASE_STATE,
      contextUsage: { usedTokens: 20_000, contextWindowTokens: 100_000 },
    };
    expect(stripAnsi(render(state))).not.toContain('▕');
  });

  it('renders the remaining-headroom gauge when configured explicitly', () => {
    const state = {
      ...BASE_STATE,
      statusLineItems: ['context-meter'],
      contextUsage: { usedTokens: 20_000, contextWindowTokens: 100_000 },
    };
    expect(stripAnsi(render(state))).toContain('Context ▕██████░░▏ 80% left');
  });

  it('drains the gauge with the remaining headroom', () => {
    const state = {
      ...BASE_STATE,
      statusLineItems: ['context-meter'],
      contextUsage: { usedTokens: 50_000, contextWindowTokens: 100_000 },
    };
    expect(stripAnsi(render(state))).toContain('▕████░░░░▏ 50% left');
  });

  it('shrinks to a shorter gauge in narrow terminals', () => {
    const state = {
      ...BASE_STATE,
      statusLineItems: ['context-meter'],
      contextUsage: { usedTokens: 50_000, contextWindowTokens: 100_000 },
    };
    const narrow = stripAnsi(render(state, 20));
    expect(narrow).toContain('Ctx');
    expect(narrow).toContain('50%');
    expect(narrow).not.toContain('left');
    expect(narrow).not.toContain('▕████░░░░▏');
  });

  it('is hidden without usage and never shows NaN', () => {
    expect(render({ ...BASE_STATE, statusLineItems: ['context-meter'], contextWindowTokens: 100_000 })).toBe('');
    expect(
      stripAnsi(
        render({
          ...BASE_STATE,
          statusLineItems: ['context-meter'],
          contextUsage: { usedTokens: Number.NaN, contextWindowTokens: 100_000 },
        }),
      ),
    ).not.toContain('NaN');
  });
});

describe('context meter presentation contract', () => {
  it.each([
    ['context-remaining', 'model', 'context-bar', 'context-gauge'],
    ['context-gauge', 'model', 'context-left'],
  ])('prefers the meter at its configured position for %j', (...configured) => {
    const statusLineItems = parseTuiStatusLineItems(configured);
    const line = stripAnsi(render({
      ...BASE_STATE,
      statusLineItems,
      contextUsage: { usedTokens: 50_000, contextWindowTokens: 100_000 },
    }));
    expect(line.match(/50%/gu)).toHaveLength(1);
    expect(line).toContain('Context ▕████░░░░▏ 50% left');
    expect(line.indexOf('Context') < line.indexOf('m2')).toBe(configured[0] === 'context-gauge');
  });
});

describe('context meter boundaries', () => {
  it.each([
    [undefined, 100_000, 50],
    [200_000, 100_000, 75],
    [Number.NaN, 100_000, 50],
    [0, 100_000, 50],
    [-1, 100_000, 50],
    [Number.POSITIVE_INFINITY, 100_000, 50],
  ])('resolves snapshot window %s before model window %s', (snapshot, model, remaining) => {
    for (const item of ['context-meter', 'context-remaining'] as const) {
      const line = stripAnsi(render({
        ...BASE_STATE,
        statusLineItems: [item],
        contextWindowTokens: model,
        contextUsage: { usedTokens: 50_000, contextWindowTokens: snapshot },
      }));
      expect(line).toContain(`${remaining}% left`);
    }
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'hides the meter when neither window is usable (%s)', (window) => {
      expect(render({
        ...BASE_STATE,
        statusLineItems: ['context-meter'],
        contextWindowTokens: window,
        contextUsage: { usedTokens: 1, contextWindowTokens: window },
      })).toBe('');
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'hides invalid usage %s even with valid model capacity', (usedTokens) => {
      expect(render({
        ...BASE_STATE,
        statusLineItems: ['context-meter'],
        contextWindowTokens: 100_000,
        contextUsage: { usedTokens },
      })).toBe('');
    },
  );

  it.each([
    [-1, '▕████████▏ 100% left'],
    [0, '▕████████▏ 100% left'],
    [100, '▕░░░░░░░░▏ 0% left'],
    [150, '▕░░░░░░░░▏ 0% left'],
  ])('clamps used tokens %d to a valid gauge', (usedTokens, expected) => {
    expect(stripAnsi(render({
      ...BASE_STATE,
      statusLineItems: ['context-meter'],
      contextUsage: { usedTokens, contextWindowTokens: 100 },
    }))).toContain(expected);
  });

  it.each([
    [30, 'Context ▕████░░░░▏ 50% left'],
    [20, 'Ctx ▕███░░░▏ 50%'],
    [7, 'Ctx 50%'],
    [6, ''],
  ])('fits a width of %d with the expected presentation', (width, expected) => {
    const line = render({
      ...BASE_STATE,
      statusLineItems: ['context-meter'],
      contextUsage: { usedTokens: 50, contextWindowTokens: 100 },
    }, width);
    expect(stripAnsi(line).trim()).toBe(expected);
    expect(line.split('\n').every((row) => visibleWidth(row) <= width)).toBe(true);
  });

  it('uses the same warning and error boundaries as the percentage item', () => {
    const previous = getTuiThemeSnapshot();
    applyTuiRenderTheme(MINIMAX_CODE_DARK_THEME, 3);
    try {
      for (const [remaining, color] of [
        [26, tuiColors.muted], [25, tuiColors.warning],
        [11, tuiColors.warning], [10, tuiColors.error], [0, tuiColors.error],
      ] as const) {
        for (const item of ['context-meter', 'context-remaining'] as const) {
          const line = render({
            ...BASE_STATE,
            statusLineItems: [item],
            contextUsage: { usedTokens: 100 - remaining, contextWindowTokens: 100 },
          }).trim();
          expect(line).not.toBe(stripAnsi(line));
          expect(line).toBe(tuiChalk.hex(color)(stripAnsi(line)));
        }
      }
    } finally {
      applyTuiRenderTheme(
        previous.appearance === 'light' ? MINIMAX_CODE_LIGHT_THEME : MINIMAX_CODE_DARK_THEME,
        previous.colorLevel,
      );
    }
  });

  it('keeps build-mode in control when the meter is selected', () => {
    const line = stripAnsi(render({
      ...BASE_STATE,
      statusLineItems: ['context-meter', 'build-mode', 'context-remaining'],
      contextUsage: { usedTokens: 50, contextWindowTokens: 100 },
    }));
    expect(line).toContain('[V]');
    expect(line).not.toContain('Context');
  });
});
