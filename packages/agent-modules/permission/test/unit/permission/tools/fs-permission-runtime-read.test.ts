import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPathAllowed } from '../../../../src/tools/fs-permission.js';
import type { PathCheckContext } from '../../../../src/types.js';

const dataDir = '/home/user/.minimax';
const homeDir = '/home/user';

function sessionDir(sessionId: string): string {
  const encoded = `session_${Buffer.from(sessionId, 'utf8').toString('base64url')}`;
  return path.join(dataDir, 'v2', 'sessions', '2026', '10', '20', `10-00-00-000-${encoded}`);
}

const currentSessionId = 'mvs_current_session_0001';
const otherSessionId = 'mvs_other_session_00002';

function makeContext(overrides: Partial<PathCheckContext> = {}): PathCheckContext {
  return {
    workingDirectory: '/home/user/project',
    dataDir,
    homeDir,
    ...overrides,
  };
}

function decide(filePath: string, toolName: string, context = makeContext()): string {
  const result = isPathAllowed(filePath, [], context, toolName);
  return result.allowed ? `allow:${result.reason.type}` : `deny:${result.reason.type}`;
}

const currentToolOutputs = path.join(sessionDir(currentSessionId), 'reports', 'tool-outputs');
const otherToolOutputs = path.join(sessionDir(otherSessionId), 'reports', 'tool-outputs');
const sessionWorkspace = path.join(dataDir, 'sessions', currentSessionId, 'workspace');

/**
 * The runtime externalizes oversized tool results into the active Session's
 * own artifact directory and hands the Agent that path, so the Agent must be
 * able to read the artifact back. Those artifacts live under the private
 * runtime tree, which the engine refuses to read — the host therefore injects
 * the Session's own artifact directory as a read grant.
 */
function grantedContext(overrides: Partial<PathCheckContext> = {}): PathCheckContext {
  return makeContext({ sessionOwnedReadablePaths: [currentToolOutputs], ...overrides });
}

describe('runtime-private read boundaries', () => {
  it('reads the current Session own tool-output artifact when the host grants it', () => {
    const target = path.join(currentToolOutputs, 'abc.readable.v1.jsonl');

    for (const toolName of ['read', 'grep', 'glob', 'list']) {
      expect(decide(target, toolName, grantedContext())).toBe('allow:sessionOwnedReadablePath');
    }
  });

  it('reads the current Session own tool-output directory for a recursive grep', () => {
    expect(decide(currentToolOutputs, 'grep', grantedContext())).toBe(
      'allow:sessionOwnedReadablePath',
    );
  });

  it('blocks the current Session artifact when the host grants nothing', () => {
    const target = path.join(currentToolOutputs, 'abc.readable.v1.jsonl');

    expect(decide(target, 'read')).toBe('deny:safetyCheck');
  });

  it('keeps another Session artifacts blocked', () => {
    const target = path.join(otherToolOutputs, 'abc.readable.v1.jsonl');

    expect(decide(target, 'read', grantedContext())).toBe('deny:safetyCheck');
    expect(decide(otherToolOutputs, 'grep', grantedContext())).toBe('deny:safetyCheck');
  });

  it('keeps compaction snapshots blocked when only tool outputs are granted', () => {
    const target = path.join(sessionDir(currentSessionId), 'snapshots', 'g1.jsonl');

    expect(decide(target, 'read', grantedContext())).toBe('deny:safetyCheck');
  });

  it('keeps a default Session workspace blocked when it is not this Session cwd or grant', () => {
    expect(decide(path.join(sessionWorkspace, 'notes.md'), 'read', makeContext())).toBe(
      'deny:safetyCheck',
    );
  });

  it('keeps runtime configuration and credentials blocked', () => {
    expect(decide(path.join(dataDir, 'config.yaml'), 'read', grantedContext())).toBe(
      'deny:safetyCheck',
    );
    expect(decide(path.join(dataDir, 'auth', 'token.json'), 'read', grantedContext())).toBe(
      'deny:safetyCheck',
    );
  });
});

describe('Session-owned readable path boundaries', () => {
  let realDataDir: string;
  let realToolOutputs: string;

  const writeFixture = (filePath: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{"synthetic":true}\n');
  };

  afterEach(() => {
    if (realDataDir) fs.rmSync(realDataDir, { recursive: true, force: true });
    realDataDir = '';
  });

  const realContext = (overrides: Partial<PathCheckContext> = {}): PathCheckContext => ({
    workingDirectory: path.join(realDataDir, 'workspace'),
    dataDir: realDataDir,
    homeDir: path.join(realDataDir, 'home'),
    agentName: 'mavis',
    sessionOwnedReadablePaths: [realToolOutputs],
    ...overrides,
  });

  it('blocks a symlink inside the Session artifact directory that escapes it', () => {
    realDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-session-artifacts-'));
    realToolOutputs = path.join(realDataDir, 'v2', 'sessions', 'own', 'reports', 'tool-outputs');
    const secret = path.join(realDataDir, 'secret.txt');
    writeFixture(secret);
    const alias = path.join(realToolOutputs, 'alias.txt');
    fs.mkdirSync(realToolOutputs, { recursive: true });
    fs.symlinkSync(secret, alias);

    const result = isPathAllowed(alias, [], realContext(), 'read');

    expect(result.allowed).toBe(false);
    expect(result.reason.type).toBe('safetyCheck');
  });

  it('does not grant write access to the Session artifact directory', () => {
    realDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-session-artifacts-'));
    realToolOutputs = path.join(realDataDir, 'v2', 'sessions', 'own', 'reports', 'tool-outputs');
    const target = path.join(realToolOutputs, 'abc.readable.v1.jsonl');
    writeFixture(target);

    for (const toolName of ['write', 'edit']) {
      const result = isPathAllowed(target, [], realContext(), toolName);
      expect(result.allowed).toBe(false);
      expect(result.reason.type).not.toBe('sessionOwnedReadablePath');
    }
  });

  it('reads a real artifact through the granted directory', () => {
    realDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-session-artifacts-'));
    realToolOutputs = path.join(realDataDir, 'v2', 'sessions', 'own', 'reports', 'tool-outputs');
    const target = path.join(realToolOutputs, 'abc.readable.v1.jsonl');
    writeFixture(target);

    const result = isPathAllowed(target, [], realContext(), 'read');

    expect(result.allowed).toBe(true);
    expect(result.reason.type).toBe('sessionOwnedReadablePath');
  });

  it('accepts the canonical form of the granted directory', () => {
    realDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-session-artifacts-'));
    realToolOutputs = path.join(realDataDir, 'v2', 'sessions', 'own', 'reports', 'tool-outputs');
    const target = path.join(realToolOutputs, 'abc.readable.v1.jsonl');
    writeFixture(target);
    // The host publishes a realpath (e.g. /private/var/... on macOS) while
    // dataDir may still be configured through an alias.
    const context = realContext({ sessionOwnedReadablePaths: [fs.realpathSync(realToolOutputs)] });

    const result = isPathAllowed(target, [], context, 'read');

    expect(result.allowed).toBe(true);
    expect(result.reason.type).toBe('sessionOwnedReadablePath');
  });

  it('ignores a granted directory that is a symlink leaving the runtime tree', () => {
    realDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-session-artifacts-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-outside-'));
    try {
      const target = path.join(outside, 'x.txt');
      writeFixture(target);
      realToolOutputs = path.join(realDataDir, 'v2', 'sessions', 'own', 'reports', 'tool-outputs');
      fs.mkdirSync(path.dirname(realToolOutputs), { recursive: true });
      fs.symlinkSync(outside, realToolOutputs);

      const result = isPathAllowed(path.join(realToolOutputs, 'x.txt'), [], realContext(), 'read');

      expect(result.reason.type).not.toBe('sessionOwnedReadablePath');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('ignores a granted directory that is a symlink to other private runtime state', () => {
    realDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-session-artifacts-'));
    const authDir = path.join(realDataDir, 'auth');
    writeFixture(path.join(authDir, 'token.json'));
    realToolOutputs = path.join(realDataDir, 'v2', 'sessions', 'own', 'reports', 'tool-outputs');
    fs.mkdirSync(path.dirname(realToolOutputs), { recursive: true });
    fs.symlinkSync(authDir, realToolOutputs);

    for (const target of [
      path.join(realToolOutputs, 'token.json'),
      path.join(authDir, 'token.json'),
    ]) {
      const result = isPathAllowed(target, [], realContext(), 'read');
      expect(result.allowed).toBe(false);
      expect(result.reason.type).toBe('safetyCheck');
    }
  });

  it('ignores a granted directory reached through a symlinked ancestor', () => {
    realDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-session-artifacts-'));
    const realReports = path.join(realDataDir, 'agents', 'other-agent', 'workspace');
    writeFixture(path.join(realReports, 'tool-outputs', 'notes.md'));
    const aliasSession = path.join(realDataDir, 'v2', 'sessions', 'own');
    fs.mkdirSync(aliasSession, { recursive: true });
    fs.symlinkSync(realReports, path.join(aliasSession, 'reports'));
    realToolOutputs = path.join(aliasSession, 'reports', 'tool-outputs');

    const result = isPathAllowed(path.join(realToolOutputs, 'notes.md'), [], realContext(), 'read');

    expect(result.allowed).toBe(false);
    expect(result.reason.type).toBe('safetyCheck');
  });

  it('ignores a grant for the runtime root itself', () => {
    realDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-session-artifacts-'));
    realToolOutputs = realDataDir;
    const configPath = path.join(realDataDir, 'config.yaml');
    writeFixture(configPath);

    const result = isPathAllowed(configPath, [], realContext(), 'read');

    expect(result.allowed).toBe(false);
    expect(result.reason.type).toBe('safetyCheck');
  });

  it('ignores an injected root outside the private runtime tree', () => {
    realDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-session-artifacts-'));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-outside-'));
    try {
      const target = path.join(outsideRoot, 'artifact.jsonl');
      writeFixture(target);
      const context = realContext({ sessionOwnedReadablePaths: [outsideRoot] });

      const result = isPathAllowed(target, [], context, 'read');

      // Ordinary rules decide outside the runtime tree (here: the temp-read
      // allowance), never the Session-owned grant.
      expect(result.reason.type).not.toBe('sessionOwnedReadablePath');
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it('does not let an injected root outside the private tree widen access inside it', () => {
    realDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-session-artifacts-'));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-outside-'));
    try {
      const configPath = path.join(realDataDir, 'config.yaml');
      writeFixture(configPath);
      const context = realContext({ sessionOwnedReadablePaths: [outsideRoot] });

      const result = isPathAllowed(configPath, [], context, 'read');

      expect(result.allowed).toBe(false);
      expect(result.reason.type).toBe('safetyCheck');
    } finally {
      fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});

/**
 * The runtime hands the Agent paths inside its own data directory: the
 * Session's default workspace (its cwd), the user's attachments copied into
 * the asset store, and the Plan document it must keep up to date. Each is
 * readable only through a host-issued grant; everything next to it stays
 * private. Incident MCT-202610-A2VA9DM3: a Windows Session could not read its
 * attachment, the ask could not be auto-approved, and the turn waited hours.
 */
describe('runtime-handed paths under the private data directory', () => {
  let root: string;

  const writeFixture = (filePath: string) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'synthetic\n');
  };

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  function layout() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-runtime-handed-'));
    const data = path.join(root, '.minimax');
    const workspace = path.join(data, 'sessions', 'mvs_own', 'workspace');
    const dayDir = path.join(data, 'v2', 'assets', '2026', '10', '21');
    const ownAsset = path.join(dayDir, '01-47-28-870-asset_own-calendar.pdf');
    const otherAsset = path.join(dayDir, '01-50-00-000-asset_other-notes.pdf');
    const plan = path.join(data, 'v2', 'sessions', '2026', '10', '21', 'own', 'artifacts', 'plan.md');
    for (const file of [path.join(workspace, 'notes.md'), ownAsset, otherAsset, plan]) {
      writeFixture(file);
    }
    writeFixture(path.join(data, 'auth', 'token.json'));
    return { data, workspace, dayDir, ownAsset, otherAsset, plan };
  }

  function contextFor(
    paths: ReturnType<typeof layout>,
    overrides: Partial<PathCheckContext> = {},
  ): PathCheckContext {
    return {
      workingDirectory: paths.workspace,
      dataDir: paths.data,
      homeDir: root,
      agentName: 'mavis',
      ...overrides,
    };
  }

  function decideIn(target: string, toolName: string, context: PathCheckContext) {
    const result = isPathAllowed(target, [], context, toolName);
    if (result.allowed) return `allow:${result.reason.type}`;
    const category = result.reason.type === 'safetyCheck' ? `:${result.reason.category}` : '';
    return `deny:${result.reason.type}${category}`;
  }

  it('asks for private runtime data when the runtime has not granted its own workspace', () => {
    const paths = layout();

    expect(decideIn(path.join(paths.workspace, 'notes.md'), 'read', contextFor(paths))).toBe(
      'deny:safetyCheck:privateRuntimeData',
    );
  });

  it('reads, searches and lists the Session workspace the runtime granted as its cwd', () => {
    const paths = layout();
    const context = contextFor(paths, { sessionOwnedReadablePaths: [paths.workspace] });

    expect(decideIn(path.join(paths.workspace, 'notes.md'), 'read', context)).toBe(
      'allow:sessionOwnedReadablePath',
    );
    // grep / glob / list without a path search the cwd itself.
    for (const toolName of ['grep', 'glob', 'list']) {
      expect(decideIn(paths.workspace, toolName, context)).toBe('allow:sessionOwnedReadablePath');
    }
    // Writes keep the ordinary working-directory rule.
    expect(decideIn(path.join(paths.workspace, 'out.md'), 'write', context)).toBe(
      'allow:workingDirectory',
    );
  });

  it('asks for a secret reached through a symlink inside the granted workspace', () => {
    const paths = layout();
    const envFile = path.join(paths.workspace, '.env');
    writeFixture(envFile);
    const alias = path.join(paths.workspace, 'notes.txt');
    fs.symlinkSync(envFile, alias);
    const context = contextFor(paths, { sessionOwnedReadablePaths: [paths.workspace] });

    // The alias must not read what the direct path has to ask for.
    expect(decideIn(envFile, 'read', context)).toBe('deny:safetyCheck:envFile');
    expect(decideIn(alias, 'read', context)).toBe('deny:safetyCheck:envFile');
  });

  it('keeps private runtime state next to the granted workspace blocked', () => {
    const paths = layout();
    const context = contextFor(paths, { sessionOwnedReadablePaths: [paths.workspace] });

    expect(decideIn(path.join(paths.data, 'auth', 'token.json'), 'read', context)).toBe(
      'deny:safetyCheck:privateRuntimeData',
    );
    expect(decideIn(paths.data, 'grep', context)).toBe('deny:safetyCheck:privateRuntimeData');
  });

  it('reads an attachment granted as an exact file but not its neighbours', () => {
    const paths = layout();
    const context = contextFor(paths, { sessionOwnedReadablePaths: [paths.ownAsset] });

    expect(decideIn(paths.ownAsset, 'read', context)).toBe('allow:sessionOwnedReadablePath');
    expect(decideIn(paths.otherAsset, 'read', context)).toBe('deny:safetyCheck:privateRuntimeData');
    expect(decideIn(paths.dayDir, 'grep', context)).toBe('deny:safetyCheck:privateRuntimeData');
    expect(decideIn(paths.ownAsset, 'write', context)).not.toBe('allow:sessionOwnedReadablePath');
  });

  it('ignores an exact-file grant swapped for a symlink to private state', () => {
    const paths = layout();
    fs.rmSync(paths.ownAsset);
    fs.symlinkSync(path.join(paths.data, 'auth', 'token.json'), paths.ownAsset);
    const context = contextFor(paths, { sessionOwnedReadablePaths: [paths.ownAsset] });

    expect(decideIn(paths.ownAsset, 'read', context)).toBe('deny:safetyCheck:privateRuntimeData');
  });

  it('reads back the exact Plan document the turn may write', () => {
    const paths = layout();
    const context = contextFor(paths, { trustedExactWritePaths: [paths.plan] });

    expect(decideIn(paths.plan, 'read', context)).toBe('allow:sessionOwnedReadablePath');
    expect(decideIn(path.join(path.dirname(paths.plan), 'plan.backup.md'), 'read', context)).toBe(
      'deny:safetyCheck:privateRuntimeData',
    );
  });

  it('does not read back an exact write target that is a symlink to private state', () => {
    const paths = layout();
    fs.rmSync(paths.plan);
    fs.symlinkSync(path.join(paths.data, 'auth', 'token.json'), paths.plan);
    const context = contextFor(paths, { trustedExactWritePaths: [paths.plan] });

    expect(decideIn(paths.plan, 'read', context)).toBe('deny:safetyCheck:privateRuntimeData');
  });

  it("does not treat a sibling profile's MEMORY.md as this data directory's whitelist", () => {
    const paths = layout();
    const sibling = path.join(root, '.minimax-dev', 'agents', 'mavis', 'MEMORY.md');
    writeFixture(sibling);
    const context = contextFor(paths, { workingDirectory: path.join(root, 'project') });

    expect(decideIn(sibling, 'write', context)).not.toBe('allow:internalWhitelist');
    expect(decideIn(path.join(paths.data, 'agents', 'mavis', 'MEMORY.md'), 'write', context)).toBe(
      'allow:internalWhitelist',
    );
  });
});
