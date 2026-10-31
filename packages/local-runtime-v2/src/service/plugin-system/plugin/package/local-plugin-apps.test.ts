import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { readMiniMaxPluginPackage } from './minimax-reader.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('local minimax Plugin App declarations', () => {
  it('reads App references declared by a local package', async () => {
    const root = await packageRoot();
    await writePackage(
      root,
      {
        'drive.app.json': appFile('google_drive'),
        'skills/notes/SKILL.md': skillFile('notes'),
      },
      ['drive.app.json'],
    );

    const plugin = await readMiniMaxPluginPackage(root, { source: 'LOCAL_MINIMAX' });

    expect(plugin.apps).toEqual([{ provider: 'google_drive' }]);
    expect(plugin.diagnostics).toEqual([]);
    expect(plugin.skills).toHaveLength(1);
  });

  it('accepts a local App-only package', async () => {
    const root = await packageRoot();
    await writePackage(root, { 'drive.app.json': appFile('google_drive') }, ['drive.app.json']);

    const plugin = await readMiniMaxPluginPackage(root, { source: 'LOCAL_MINIMAX' });

    expect(plugin).toMatchObject({ apps: [{ provider: 'google_drive' }], skills: [] });
  });

  it('keeps the other capabilities and reports each skipped App reference', async () => {
    const root = await packageRoot();
    await writePackage(
      root,
      {
        'drive.app.json': appFile('google_drive'),
        'bad.app.json': appFile('Not Valid'),
        'again.app.json': appFile('google_drive'),
        'skills/notes/SKILL.md': skillFile('notes'),
      },
      ['drive.app.json', 'bad.app.json', 'again.app.json', 'missing.app.json'],
    );

    const plugin = await readMiniMaxPluginPackage(root, { source: 'LOCAL_MINIMAX' });

    expect(plugin.apps).toEqual([{ provider: 'google_drive' }]);
    expect(plugin.skills).toHaveLength(1);
    expect(plugin.diagnostics).toEqual([
      { code: 'APP_SCHEMA_INVALID', capability: 'APP', name: 'bad.app.json' },
      { code: 'APP_PROVIDER_DUPLICATE', capability: 'APP', name: 'google_drive' },
      { code: 'PLUGIN_PATH_NOT_FOUND', capability: 'APP', name: 'missing.app.json' },
    ]);
  });

  it('rejects an official package whose App reference is broken', async () => {
    const root = await packageRoot();
    await writePackage(
      root,
      {
        'bad.app.json': appFile('Not Valid'),
        'skills/notes/SKILL.md': skillFile('notes'),
      },
      ['bad.app.json'],
    );

    await expect(
      readMiniMaxPluginPackage(root, { source: 'OFFICIAL' }),
    ).rejects.toMatchObject({ code: 'APP_SCHEMA_INVALID' });
  });
});

async function packageRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'minimax-plugin-apps-'));
  roots.push(root);
  return root;
}

async function writePackage(
  root: string,
  files: Readonly<Record<string, string>>,
  apps: readonly string[],
): Promise<void> {
  const manifest = {
    schemaVersion: 1,
    name: 'notes-sync',
    version: '1.0.0',
    description: 'Sync notes.',
    author: 'Test',
    icon: 'icon.png',
    category: 'Productivity',
    exampleQueries: ['sync my notes'],
    apps,
    mcpServers: [],
    skills: Object.keys(files).filter((name) => name.startsWith('skills/')),
  };
  await write(root, '.minimax-plugin/plugin.json', `${JSON.stringify(manifest, null, 2)}\n`);
  await write(root, 'icon.png', 'icon');
  for (const [name, content] of Object.entries(files)) await write(root, name, content);
}

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

function appFile(provider: string): string {
  return `${JSON.stringify({ schemaVersion: 1, provider }, null, 2)}\n`;
}

function skillFile(name: string): string {
  return `---\nname: ${name}\ndescription: Sync notes.\n---\n\n# ${name}\n`;
}
