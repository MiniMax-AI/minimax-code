import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it, vi } from 'vitest';

import { createTuiSkillsInspectionPanel } from '../../src/tui/features/inspection/capabilities.js';

describe('MCode capability inspection', () => {
  it('renders Skills as a grouped read-only catalog instead of transcript prose', () => {
    const onCancel = vi.fn();
    const panel = createTuiSkillsInspectionPanel(
      {
        skills: [
          {
            name: 'docs',
            displayName: 'Docs',
            displayDescription:
              'Read project documentation and explain repository conventions, architecture, testing, release workflows, and every additional detail before THIRD-LINE-SENTINEL.',
            sourceKind: 'builtin-agent',
            enabled: true,
          },
          {
            name: 'release-notes',
            description: 'Prepare a release summary',
            sourceKind: 'workspace',
            enabled: false,
          },
        ],
        hasMore: true,
      },
      'doc',
      onCancel,
      () => 40,
    );

    const rendered = stripVTControlCharacters(panel.render(80).join('\n'));

    expect(rendered).toContain('Skills');
    expect(rendered).toContain('2+ FOUND');
    expect(rendered).toContain('Matching “doc”');
    expect(rendered).toContain('Built-in · 1');
    expect(rendered).toContain('User · 1');
    expect(rendered).toContain('Docs');
    expect(rendered).toContain('● available · builtin-agent');
    expect(rendered).toContain('Read project documentation');
    expect(rendered).toContain('○ unavailable · workspace');
    expect(rendered).toContain('read only · Esc close');
    expect(rendered).not.toContain('narrow the list with');

    const compact = stripVTControlCharacters(panel.render(50).join('\n'));
    expect(compact).toContain('…');
    expect(compact).not.toContain('THIRD-LINE-SENTINEL');

    panel.handleInput('\x1b');
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
