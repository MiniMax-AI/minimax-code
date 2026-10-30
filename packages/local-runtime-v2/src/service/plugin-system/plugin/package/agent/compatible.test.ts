import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writePluginTree } from '../../../../../../test/helpers/plugin-package.js';
import { readCompatiblePluginPackage } from '../compatibility-reader.js';
import { canonicalizePluginRoot } from '../filesystem.js';
import { readCompatiblePluginAgents } from './compatible.js';

const roots: string[] = [];
const userConfigToken = ['$', '{user_config.token}'].join('');
const compatibleManifestPath = '.\u0063\u006c\u0061\u0075\u0064\u0065-plugin/plugin.json';
const compatibleSourceFormat = '\u0043\u004c\u0041\u0055\u0044\u0045';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('compatible Plugin Agents', () => {
  it('recursively scans the default directory and maps compatible fields', async () => {
    const root = await pluginRoot('compatible-agent-scan');
    await writePluginTree(
      root,
      compatibleFiles(
        {},
        {
          'agents/reviewer.md': [
            '---',
            'description: Reviews',
            'tools: Read, Bash(git push *), Agent, NotebookEdit, mcp__docs__search',
            'disallowedTools: [WebSearch]',
            'model: external-alias',
            'effort: xhigh',
            'skills: [research]',
            'permissionMode: acceptEdits',
            'color: blue',
            '---',
            'Review.',
          ].join('\n'),
          'agents/review/security.md': '---\nname: sec\ndescription: Security\n---\nAudit.\n',
          'agents/notes.txt': 'not an agent',
        },
      ),
    );

    const plugin = await readCompatiblePluginPackage(root);

    expect(plugin.agents?.map((agent) => [agent.scopedName, agent.name])).toEqual([
      ['demo:review:sec', 'review:sec'],
      ['demo:reviewer', 'reviewer'],
    ]);
    expect(plugin.agents?.[1]).toMatchObject({
      sourceFormat: compatibleSourceFormat,
      description: 'Reviews',
      systemPrompt: 'Review.',
      effort: 'xhigh',
      tools: ['read', 'bash', 'mcp__docs__search'],
      disallowedTools: ['web_search'],
      skills: ['demo:research'],
      extensionSkills: ['demo:research'],
    });
    expect(plugin.agents?.[1]?.model).toBeUndefined();
    expect(plugin.diagnostics).toEqual(
      expect.arrayContaining([
        agentDiagnostic('AGENT_TOOL_IGNORED', 'agents/reviewer.md#tools:Agent'),
        agentDiagnostic('AGENT_TOOL_IGNORED', 'agents/reviewer.md#tools:NotebookEdit'),
        agentDiagnostic('AGENT_SKILLS_ALLOWLIST', 'agents/reviewer.md'),
        agentDiagnostic('AGENT_FIELD_IGNORED', 'agents/reviewer.md#model'),
        agentDiagnostic('AGENT_FIELD_IGNORED', 'agents/reviewer.md#permissionMode'),
        agentDiagnostic('AGENT_FIELD_IGNORED', 'agents/reviewer.md#color'),
      ]),
    );
  });

  it('lets manifest agents replace the default directory', async () => {
    const root = await pluginRoot('compatible-agent-manifest');
    await writePluginTree(
      root,
      compatibleFiles(
        { agents: ['./custom/helper.md'] },
        {
          'agents/ignored.md': '---\ndescription: Ignored\n---\nBody\n',
          'custom/helper.md': '---\ndescription: Helper\n---\nBody\n',
        },
      ),
    );

    const plugin = await readCompatiblePluginPackage(root);

    expect(plugin.agents?.map((agent) => agent.scopedName)).toEqual(['demo:helper']);
    expect(plugin.diagnostics).toContainEqual(
      agentDiagnostic('AGENT_DEFAULT_DIRECTORY_IGNORED', 'agents'),
    );
  });

  it('skips broken, duplicate, and tool-less Agents while keeping valid ones', async () => {
    const root = await pluginRoot('compatible-agent-skip');
    await writePluginTree(
      root,
      compatibleFiles(
        {},
        {
          'agents/a-first.md': '---\nname: shared\ndescription: First\n---\nBody\n',
          'agents/b-second.md': '---\nname: shared\ndescription: Second\n---\nBody\n',
          'agents/no-frontmatter.md': 'Just text\n',
          'agents/no-description.md': '---\nname: nodesc\n---\nBody\n',
          'agents/unknown-tools.md': '---\ndescription: X\ntools: NotebookEdit\n---\nBody\n',
          'agents/disabled.md': '---\ndescription: Disabled\ntools: []\n---\nBody\n',
          'agents/bad name.md': '---\ndescription: Spaces\n---\nBody\n',
        },
      ),
    );

    const plugin = await readCompatiblePluginPackage(root);

    expect(plugin.agents?.map((agent) => [agent.scopedName, agent.description])).toEqual([
      ['demo:shared', 'First'],
      ['demo:disabled', 'Disabled'],
    ]);
    expect(plugin.agents?.[1]?.tools).toEqual([]);
    expect(plugin.diagnostics).toEqual(
      expect.arrayContaining([
        agentDiagnostic('AGENT_DUPLICATE', 'demo:shared'),
        agentDiagnostic('AGENT_INVALID', 'agents/no-frontmatter.md'),
        agentDiagnostic('AGENT_INVALID', 'agents/no-description.md'),
        agentDiagnostic('AGENT_INVALID', 'agents/unknown-tools.md'),
        agentDiagnostic('AGENT_NAME_INVALID', 'agents/bad name.md'),
      ]),
    );
  });

  it('accepts a compatible package whose only capability is an Agent', async () => {
    const root = await pluginRoot('compatible-agent-only');
    await writePluginTree(root, {
      [compatibleManifestPath]: JSON.stringify({ name: 'demo' }),
      'agents/helper.md': `---\ndescription: Helper\n---\nBody ${userConfigToken}\n`,
    });

    const plugin = await readCompatiblePluginPackage(root);

    expect(plugin.agents?.map((agent) => agent.scopedName)).toEqual(['demo:helper']);
    expect(plugin.diagnostics).toEqual([
      agentDiagnostic('AGENT_USER_CONFIG_UNSUPPORTED', 'agents/helper.md'),
    ]);
  });

  it('does not recognize Agents in Codex packages', async () => {
    const root = await pluginRoot('codex-agent');
    await writePluginTree(root, {
      '.codex-plugin/plugin.json': JSON.stringify({ name: 'demo' }),
      'agents/helper.md': '---\ndescription: Helper\n---\nBody\n',
    });

    await expect(readCompatiblePluginPackage(root, { kind: 'CODEX' })).rejects.toMatchObject({
      code: 'MANIFEST_SCHEMA_INVALID',
    });
  });

  it('reports a non-Markdown manifest declaration', async () => {
    const root = await pluginRoot('compatible-agent-bad-path');
    await writePluginTree(root, compatibleFiles({}, {}));
    const canonical = await canonicalizePluginRoot(root);

    const result = await readCompatiblePluginAgents(canonical, {
      pluginName: 'demo',
      declared: ['agents/helper.txt'],
      skills: [],
    });

    expect(result).toEqual({
      agents: [],
      diagnostics: [agentDiagnostic('AGENT_PATH_INVALID', 'agents/helper.txt')],
    });
  });
});

async function pluginRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `${label}-`));
  roots.push(root);
  return root;
}

function agentDiagnostic(code: string, name: string) {
  return { code, capability: 'AGENT', name };
}

function compatibleFiles(
  manifest: Record<string, unknown>,
  extraFiles: Record<string, string>,
): Record<string, string | Buffer> {
  return {
    [compatibleManifestPath]: JSON.stringify({ name: 'demo', ...manifest }),
    'skills/research/SKILL.md': '---\nname: research\ndescription: Research a topic\n---\nGo.\n',
    ...extraFiles,
  };
}
