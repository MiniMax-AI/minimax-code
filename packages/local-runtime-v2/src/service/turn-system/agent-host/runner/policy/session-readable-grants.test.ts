import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PermissionEngine,
  createToolPermissionContext,
  registerDefaultCheckers,
} from '@mavis/permission';

import {
  compactionSnapshotGrantSource,
  createSessionReadableGrantResolver,
  runtimeWorkspaceGrantSource,
  sessionAttachmentGrantSource,
  toolOutputGrantSource,
  type SessionReadableGrantSource,
} from './session-readable-grants.js';

type SessionView = { readonly workspaceDir?: string; readonly parentSessionId?: string | null };

function sessionsFrom(records: Record<string, SessionView>) {
  return async (sessionId: string) => records[sessionId];
}

describe('Session read grant resolver', () => {
  it('merges every source and drops duplicates', async () => {
    const resolve = createSessionReadableGrantResolver({
      loadSession: sessionsFrom({ child: {} }),
      sources: [
        { kind: 'tool-outputs', resolve: async () => ['/data/a'] },
        { kind: 'session-attachments', resolve: async () => ['/data/a', '/data/b'] },
      ],
    });

    await expect(resolve('child')).resolves.toEqual(['/data/a', '/data/b']);
  });

  it('keeps the other grants and logs which source failed', async () => {
    const warn = vi.fn();
    const failing: SessionReadableGrantSource = {
      kind: 'session-attachments',
      resolve: async () => {
        throw new Error('asset index unavailable');
      },
    };
    const resolve = createSessionReadableGrantResolver({
      loadSession: sessionsFrom({}),
      sources: [failing, { kind: 'tool-outputs', resolve: async () => ['/data/tool-outputs'] }],
      logger: { warn },
    });

    await expect(resolve('s1')).resolves.toEqual(['/data/tool-outputs']);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ session_id: 's1', grant_kind: 'session-attachments' }),
      'permission.session_readable_grant_source_failed',
    );
  });

  it("grants a subagent its parents' attachments, stopping at a cycle", async () => {
    const listSessionReadablePaths = vi.fn(async () => []);
    const resolve = createSessionReadableGrantResolver({
      loadSession: sessionsFrom({
        grandchild: { parentSessionId: 'child' },
        child: { parentSessionId: 'root' },
        root: { parentSessionId: 'grandchild' },
      }),
      sources: [sessionAttachmentGrantSource({ listSessionReadablePaths })],
    });

    await resolve('grandchild');

    expect(listSessionReadablePaths).toHaveBeenCalledWith(['grandchild', 'child', 'root']);
  });
});

describe('runtime-allocated workspace grant', () => {
  const granted = (workspaceDir: string, dataDir: string, platform: NodeJS.Platform) =>
    runtimeWorkspaceGrantSource({ dataDir: () => dataDir, platform }).resolve({
      sessionId: 's1',
      lineage: ['s1'],
      workspaceDir,
    });

  it.each([
    ['/home/u/.minimax/sessions/mvs_1/workspace', true],
    ['/home/u/.minimax/workspace', true],
    ['/home/u/.minimax/agents/mavis/workspace', true],
    ['/home/u/.minimax/v2', false],
    ['/home/u/.minimax/sessions/mvs_1', false],
    ['/home/u/.minimax', false],
    ['/home/u/project', false],
  ])('posix %s → %s', async (workspace, expected) => {
    await expect(granted(workspace, '/home/u/.minimax', 'linux')).resolves.toEqual(
      expected ? [workspace] : [],
    );
  });

  it('matches Windows paths regardless of drive and folder casing', async () => {
    const workspace = 'c:\\users\\user\\.minimax\\Sessions\\mvs_751b\\Workspace';
    await expect(granted(workspace, 'C:\\Users\\User\\.minimax', 'win32')).resolves.toEqual([
      workspace,
    ]);
    await expect(
      granted('C:\\Users\\User\\.minimax\\v2\\assets', 'C:\\Users\\User\\.minimax', 'win32'),
    ).resolves.toEqual([]);
  });
});

/**
 * Contract between the runtime's grant sources and the real permission
 * engine: every path the runtime hands the Agent inside its private data
 * directory is readable with the resolved grant, and nothing next to it is.
 * MCT-202610-A2VA9DM3: the default Session workspace and an attachment were
 * refused, the ask could not be auto-approved, and the turn waited for hours.
 */
describe('runtime-handed paths with the real permission engine', () => {
  let root = '';

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function writeFile(filePath: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'synthetic\n');
    return filePath;
  }

  async function arrange() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-session-read-grants-'));
    const dataDir = path.join(root, '.minimax');
    const sessionDir = path.join(dataDir, 'v2', 'sessions', '2026', '10', '21', 'own');
    const workspace = path.join(dataDir, 'sessions', 'mvs_own', 'workspace');
    const assets = path.join(dataDir, 'v2', 'assets', '2026', '10', '21');
    const files = {
      workspaceNote: writeFile(path.join(workspace, 'notes.md')),
      attachment: writeFile(path.join(assets, '01-47-28-870-asset_own-calendar.pdf')),
      otherAttachment: writeFile(path.join(assets, '01-50-00-000-asset_other-notes.pdf')),
      toolOutput: writeFile(path.join(sessionDir, 'reports', 'tool-outputs', 'abc.txt')),
      snapshot: writeFile(path.join(sessionDir, 'snapshots', 'g1.jsonl')),
      transcript: writeFile(path.join(sessionDir, 'messages.jsonl')),
      otherWorkspaceNote: writeFile(
        path.join(dataDir, 'sessions', 'mvs_other', 'workspace', 'n.md'),
      ),
      token: writeFile(path.join(dataDir, 'auth', 'token.json')),
      config: writeFile(path.join(dataDir, 'config.yaml')),
    };
    const resolve = createSessionReadableGrantResolver({
      loadSession: sessionsFrom({
        mvs_child: { workspaceDir: workspace, parentSessionId: 'mvs_own' },
        mvs_own: { workspaceDir: workspace },
      }),
      sources: [
        toolOutputGrantSource({
          readableDirectory: async () => path.join(sessionDir, 'reports', 'tool-outputs'),
        }),
        compactionSnapshotGrantSource({
          inspectSnapshotsDirectory: async () => path.join(sessionDir, 'snapshots'),
        }),
        runtimeWorkspaceGrantSource({ dataDir: () => dataDir }),
        sessionAttachmentGrantSource({
          listSessionReadablePaths: async (ids) =>
            ids.includes('mvs_own') ? [files.attachment] : [],
        }),
      ],
    });
    const engine = new PermissionEngine();
    registerDefaultCheckers(engine);
    const decide = async (sessionId: string, target: string, toolName = 'read') => {
      const context = createToolPermissionContext({
        workingDirectory: workspace,
        dataDir,
        homeDir: root,
        agentName: 'mavis',
        sessionOwnedReadablePaths: await resolve(sessionId),
      });
      const input = toolName === 'grep' ? { pattern: 'x', path: target } : { path: target };
      return engine.checkPermission(toolName, input, context).behavior;
    };
    return { files, workspace, dataDir, decide };
  }

  it('reads every runtime-handed path', async () => {
    const { files, workspace, decide } = await arrange();

    await expect(decide('mvs_own', files.workspaceNote)).resolves.toBe('allow');
    await expect(decide('mvs_own', workspace, 'grep')).resolves.toBe('allow');
    await expect(decide('mvs_own', files.attachment)).resolves.toBe('allow');
    await expect(decide('mvs_own', files.toolOutput)).resolves.toBe('allow');
    await expect(decide('mvs_own', files.snapshot)).resolves.toBe('allow');
    // A subagent shares its parent's workspace and receives its attachments.
    await expect(decide('mvs_child', files.attachment)).resolves.toBe('allow');
  });

  it('keeps everything else in the private data directory behind an ask', async () => {
    const { files, dataDir, decide } = await arrange();

    for (const target of [
      files.otherAttachment,
      files.otherWorkspaceNote,
      files.transcript,
      files.token,
      files.config,
    ]) {
      await expect(decide('mvs_own', target)).resolves.toBe('ask');
    }
    await expect(decide('mvs_own', dataDir, 'grep')).resolves.toBe('ask');
  });
});
