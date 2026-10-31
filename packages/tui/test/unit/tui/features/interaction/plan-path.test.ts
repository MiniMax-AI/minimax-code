import { describe, expect, it } from 'vitest';

import {
  formatPlanPath,
  renderPlanPathRows,
} from '../../../../../src/tui/features/interaction/plan-path.js';
import { stripAnsi } from '../../../../../src/tui/rendering/text.js';

describe('Plan File path', () => {
  it('shortens the home directory only on POSIX hosts', () => {
    expect(formatPlanPath('/Users/a/.mcode/s/artifacts/plan.md', 'darwin', '/Users/a')).toBe(
      '~/.mcode/s/artifacts/plan.md',
    );
    expect(formatPlanPath('/Users/ab/plan.md', 'darwin', '/Users/a')).toBe('/Users/ab/plan.md');
    expect(formatPlanPath('C:\\Users\\a\\plan.md', 'win32', 'C:\\Users\\a')).toBe(
      'C:\\Users\\a\\plan.md',
    );
  });

  it('labels the first row and keeps every path character across wrapped rows', () => {
    const path = `/tmp/${'segment/'.repeat(10)}plan.md`;
    const rows = renderPlanPathRows(path, 30).map((row) => stripAnsi(row));

    expect(rows.length).toBeGreaterThan(1);
    expect(rows[0]?.startsWith('Plan  /tmp/')).toBe(true);
    expect(rows.every((row) => row.length <= 30)).toBe(true);
    expect(rows.map((row) => row.slice('Plan  '.length)).join('')).toBe(path);
  });

  it('renders nothing without a path', () => {
    expect(renderPlanPathRows(undefined, 40)).toEqual([]);
    expect(renderPlanPathRows('  ', 40)).toEqual([]);
  });
});
