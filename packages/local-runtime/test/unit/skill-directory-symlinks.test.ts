import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SKILLS_CONFIG } from '@mavis/config';
import { createSkillRegistry, type SkillRegistryWatcher } from '@mavis/skills';
import { readConfiguredSkillRoots } from '../../src/skills/roots.js';

let fixture: string;
let workspace: string;
let watcher: SkillRegistryWatcher | undefined;

beforeEach(async () => {
  fixture = await realpath(await mkdtemp(join(tmpdir(), 'mcode-skill-links-')));
  workspace = join(fixture, 'workspace');
  await mkdir(join(workspace, '.git'), { recursive: true });
});

afterEach(async () => {
  watcher?.close();
  watcher = undefined;
  await rm(fixture, { recursive: true, force: true });
});

function workspaceRoots() {
  return readConfiguredSkillRoots(
    { dataDir: join(fixture, 'data'), provider: {} },
    'mavis',
    workspace,
  ).filter((root) => root.kind === 'workspace');
}

async function writeSkill(dir: string, name = 'linked', body = 'Initial instructions') {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Linked skill\n---\n# Linked skill\n${body}\n`,
  );
}

async function linkDirectory(target: string, link: string, relativeTarget = false) {
  await mkdir(dirname(link), { recursive: true });
  await symlink(
    relativeTarget && process.platform !== 'win32' ? relative(dirname(link), target) : target,
    link,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
}

describe('configured workspace skill directory links', () => {
  it.each(['.agents', '.claude', '.minimax'])(
    'discovers a linked %s/skills root',
    async (source) => {
      const target = join(workspace, 'skills', 'linked');
      await writeSkill(target);
      await linkDirectory(dirname(target), join(workspace, source, 'skills'), true);

      const registry = await createSkillRegistry(workspaceRoots());
      const [skill] = registry.getAvailableSkills();
      expect(skill?.name).toBe('linked');
      expect(skill?.skillDir).toBe(target);
      expect(registry.readByLocationUri(skill!.locationUri)).toContain('Initial instructions');
      expect(registry.getSnapshot()?.diagnostics).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'skill_outside_root' })]),
      );
    },
  );

  it.each([false, true])(
    'discovers child directory links (relative: %s) outside the workspace',
    async (relativeTarget) => {
      const target = join(fixture, 'shared', 'linked');
      const link = join(workspace, '.agents', 'skills', 'linked');
      await writeSkill(target);
      await linkDirectory(target, link, relativeTarget);

      const registry = await createSkillRegistry(workspaceRoots());
      const [skill] = registry.getAvailableSkills();
      expect(skill).toMatchObject({
        name: 'linked',
        skillDir: target,
        entryDir: link,
      });
      expect(fileURLToPath(skill!.locationUri.replace(/^files:/, 'file:'))).toBe(
        join(target, 'SKILL.md'),
      );
    },
  );

  it('deduplicates shared root aliases using existing source priority', async () => {
    const target = join(workspace, 'skills', 'linked');
    await writeSkill(target);
    await linkDirectory(dirname(target), join(workspace, '.agents', 'skills'), true);
    await linkDirectory(dirname(target), join(workspace, '.claude', 'skills'), true);

    const registry = await createSkillRegistry(workspaceRoots());
    expect(registry.getAvailableSkills()).toHaveLength(1);
    expect(registry.getAvailableSkills()[0]?.rootId).toContain('workspace-cc:');
    expect(registry.getSnapshot()?.entries).toHaveLength(2);
  });

  it('retains external-source disable controls', () => {
    const config = {
      dataDir: join(fixture, 'data'),
      provider: {},
      skills: {
        external: { ...DEFAULT_SKILLS_CONFIG.external, enabled: false },
      },
    };
    expect(
      readConfiguredSkillRoots(config, 'mavis', workspace).filter((root) => root.external),
    ).toEqual([]);
    config.skills.external.enabled = true;
    config.skills.external.sources = {
      ...DEFAULT_SKILLS_CONFIG.external.sources,
      'workspace-agents': { enabled: false, priority: 55 },
    };
    expect(
      readConfiguredSkillRoots(config, 'mavis', workspace).some((root) =>
        root.id.startsWith('external:workspace-agents:'),
      ),
    ).toBe(false);
  });

  it('refreshes a retargeted child link without retaining cached content', async () => {
    const first = join(fixture, 'first');
    const second = join(fixture, 'second');
    const link = join(workspace, '.agents', 'skills', 'linked');
    await writeSkill(first, 'linked', 'First instructions');
    await writeSkill(second, 'linked', 'Second instructions');
    await linkDirectory(first, link);
    const registry = await createSkillRegistry(workspaceRoots());
    expect(registry.getAvailableSkills()[0]?.content).toContain('First instructions');
    await rm(link);
    await linkDirectory(second, link);
    await registry.refresh();
    expect(registry.getAvailableSkills()[0]).toMatchObject({
      skillDir: second,
      entryDir: link,
    });
    expect(registry.getAvailableSkills()[0]?.content).toContain('Second instructions');
  });

  it('watches linked directories before SKILL.md exists and reloads later edits', async () => {
    const target = join(fixture, 'shared', 'linked');
    await mkdir(target, { recursive: true });
    await linkDirectory(target, join(workspace, '.agents', 'skills', 'linked'));
    const registry = await createSkillRegistry(workspaceRoots());
    expect(registry.getAvailableSkills()).toEqual([]);
    const onChange = vi.fn();
    watcher = registry.watch({ onChange });

    // Native watchers may finish arming after watch() returns. Observe a real
    // event in the linked target before making the one-shot SKILL.md write.
    await vi.waitFor(
      async () => {
        if (onChange.mock.calls.length === 0) {
          await writeFile(join(target, '.watch-ready'), String(Date.now()));
        }
        expect(onChange).toHaveBeenCalled();
      },
      { timeout: 4000, interval: 250 },
    );
    expect(registry.getAvailableSkills()).toEqual([]);
    onChange.mockClear();
    await writeSkill(target);
    await vi.waitFor(
      () => {
        expect(onChange).toHaveBeenCalled();
        expect(registry.getAvailableSkills()[0]?.content).toContain('Initial instructions');
      },
      { timeout: 4000 },
    );
    onChange.mockClear();
    await writeSkill(target, 'linked', 'Updated instructions');
    await vi.waitFor(
      () => {
        expect(onChange).toHaveBeenCalled();
        expect(registry.getAvailableSkills()[0]?.content).toContain('Updated instructions');
      },
      { timeout: 4000 },
    );
  }, 15000);

  it.skipIf(process.platform === 'win32')(
    'skips broken, cyclic and non-directory links without losing valid skills',
    async () => {
      const root = join(workspace, '.agents', 'skills');
      await writeSkill(join(root, 'valid'), 'valid');
      await symlink(join(fixture, 'missing'), join(root, 'broken'));
      await symlink('cycle', join(root, 'cycle'));
      await writeFile(join(fixture, 'plain.txt'), 'Not a directory');
      await symlink(join(fixture, 'plain.txt'), join(root, 'file'));
      const registry = await createSkillRegistry(workspaceRoots());
      expect(registry.getAvailableSkills().map((skill) => skill.name)).toEqual(['valid']);
      expect(registry.getSnapshot()?.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'skill_directory_link_unreadable' }),
          expect.objectContaining({
            code: 'skill_directory_link_not_directory',
          }),
        ]),
      );
    },
  );

  it.skipIf(process.platform === 'win32')('continues rejecting SKILL.md file links', async () => {
    const target = join(fixture, 'shared');
    await writeSkill(target);
    const skillDir = join(workspace, '.agents', 'skills', 'linked');
    await mkdir(skillDir, { recursive: true });
    await symlink(join(target, 'SKILL.md'), join(skillDir, 'SKILL.md'));
    const registry = await createSkillRegistry(workspaceRoots());
    expect(registry.getAvailableSkills()).toEqual([]);
    expect(registry.getSnapshot()?.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'skill_symlink_rejected' }),
    );
  });

  it.each(['project', 'workspace'] as const)('keeps unopted %s roots bounded', async (kind) => {
    const target = join(fixture, 'shared', 'linked');
    const root = join(workspace, 'bounded');
    await writeSkill(target);
    await linkDirectory(target, join(root, 'linked'));
    const registry = await createSkillRegistry([{ id: 'bounded', kind, rootPath: root }]);
    expect(registry.getAvailableSkills()).toEqual([]);
    expect(registry.getSnapshot()?.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'skill_outside_root' }),
    );
  });
});
