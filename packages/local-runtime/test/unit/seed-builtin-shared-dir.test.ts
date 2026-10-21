import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { seedBuiltinSkills } from '../../src/skills/seed-builtin.js';

const roots: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'seed-shared-'));
  roots.push(dir);
  return dir;
}
function skill(dir: string, name: string, body: string): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n${body}\n`);
}
afterEach(() => {
  for (const r of roots.splice(0)) {
    try { chmodSync(r, 0o755); } catch { /* ignore */ }
    rmSync(r, { recursive: true, force: true });
  }
});

describe('seedBuiltinSkills on a shared dest dir', () => {
  it('refreshes owned skills without deleting foreign skills or files', () => {
    const src = tmp();
    const dest = join(tmp(), '.builtin-skills');
    skill(dest, 'mavis', 'desktop');
    skill(dest, 'create-agent', 'desktop');
    writeFileSync(join(dest, 'agent.md'), 'user');
    skill(dest, 'cli-skill', 'stale');
    skill(src, 'cli-skill', 'v1');

    seedBuiltinSkills({ builtinSkillsDir: dest, sourceDirs: [src] });
    expect(readFileSync(join(dest, 'cli-skill', 'SKILL.md'), 'utf8')).toContain('v1');

    skill(src, 'cli-skill', 'v2');
    seedBuiltinSkills({ builtinSkillsDir: dest, sourceDirs: [src] });
    expect(readFileSync(join(dest, 'cli-skill', 'SKILL.md'), 'utf8')).toContain('v2');

    expect(existsSync(join(dest, 'mavis', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dest, 'create-agent', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(dest, 'agent.md'), 'utf8')).toBe('user');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'does not throw when the dest dir is not writable (EACCES/EPERM)',
    () => {
      const src = tmp();
      const dest = join(tmp(), '.builtin-skills');
      skill(src, 'cli-skill', 'v1');
      skill(dest, 'mavis', 'desktop');
      skill(dest, 'cli-skill', 'old');
      chmodSync(dest, 0o555);
      expect(() => seedBuiltinSkills({ builtinSkillsDir: dest, sourceDirs: [src] })).not.toThrow();
      chmodSync(dest, 0o755);
      expect(existsSync(join(dest, 'mavis', 'SKILL.md'))).toBe(true);
    },
  );
});
