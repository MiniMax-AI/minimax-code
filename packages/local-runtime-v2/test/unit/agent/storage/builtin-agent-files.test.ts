import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as filePublication from '../../../../src/infra/file/jsonl.js';
import { AgentFiles } from '../../../../src/service/agent/storage/agent-files.js';
import { BuiltinAgentFiles } from '../../../../src/service/agent/storage/builtin-agent-files.js';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});

async function createFiles(prefix: string) {
  const dataDir = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }));
  const files = new AgentFiles(dataDir);
  return { dataDir, files, builtinFiles: new BuiltinAgentFiles(files, dataDir) };
}

describe('BuiltinAgentFiles startup reload', () => {
  const bundled = {
    name: 'explore',
    description: 'Explore repositories',
    features: { mavis: false, delegation: false, webSearch: true },
    systemPrompt: 'Current bundled body.',
  } as const;

  async function seededExplore(prefix: string) {
    const { files, builtinFiles } = await createFiles(prefix);
    await builtinFiles.seed('explore', {
      ...bundled,
      description: 'Old description',
      systemPrompt: 'Old bundled body.',
    });
    const agentFile = join(files.builtinAgentDir('explore'), 'agent.md');
    return {
      files,
      builtinFiles,
      agentFile,
      current: await files.readCanonicalDocument('explore', true),
    };
  }

  it('overwrites a valid Builtin source in place, including non-model fields, without an archive', async () => {
    const { files, builtinFiles, agentFile, current } = await seededExplore(
      'agent-files-builtin-reload-',
    );

    await expect(builtinFiles.reload('explore', bundled, current.revision)).resolves.toBe(
      'rewritten',
    );

    await expect(files.getBuiltinCanonicalConfig('explore')).resolves.toMatchObject({
      description: 'Explore repositories',
      systemPrompt: 'Current bundled body.',
    });
    await expect(readdir(files.builtinAgentDir('explore'))).resolves.toEqual(['agent.md']);
    const second = await files.readCanonicalDocument('explore', true);
    const before = await lstat(agentFile);
    await expect(builtinFiles.reload('explore', bundled, second.revision)).resolves.toBe(
      'unchanged',
    );
    expect((await lstat(agentFile)).mtimeMs).toBe(before.mtimeMs);
    await expect(files.readCanonicalDocument('explore', true)).resolves.toMatchObject({
      revision: second.revision,
    });
  });

  it('skips the reload when the source changed or vanished since it was read', async () => {
    const { builtinFiles, agentFile, current } = await seededExplore(
      'agent-files-builtin-reload-cas-',
    );
    const userContent = current.content.replace('Old bundled body.', 'User changed body.');
    await writeFile(agentFile, userContent, 'utf8');

    await expect(builtinFiles.reload('explore', bundled, current.revision)).resolves.toBe(
      'conflict',
    );
    await expect(readFile(agentFile, 'utf8')).resolves.toBe(userContent);

    await rm(agentFile);
    await expect(builtinFiles.reload('explore', bundled, current.revision)).resolves.toBe(
      'conflict',
    );
    await expect(readFile(agentFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the old source when validation or the atomic replace fails', async () => {
    const { files, builtinFiles, agentFile, current } = await seededExplore(
      'agent-files-builtin-reload-fail-',
    );

    await expect(
      builtinFiles.reload(
        'explore',
        { ...bundled, features: undefined } as unknown as typeof bundled,
        current.revision,
      ),
    ).rejects.toThrow();
    await expect(readFile(agentFile, 'utf8')).resolves.toBe(current.content);

    const failure = new Error('rename failed');
    vi.spyOn(filePublication, 'replaceFileAtomically').mockRejectedValueOnce(failure);
    await expect(builtinFiles.reload('explore', bundled, current.revision)).rejects.toBe(failure);
    await expect(readFile(agentFile, 'utf8')).resolves.toBe(current.content);
    await expect(readdir(files.builtinAgentDir('explore'))).resolves.toEqual(['agent.md']);
  });
});

describe('BuiltinAgentFiles corrupted Builtin repair', () => {
  const bundled = {
    name: 'mavis',
    description: 'Mavis',
    features: { mavis: true, delegation: true, webSearch: true },
    systemPrompt: 'Bundled template.',
  };

  async function corruptedBuiltin(prefix: string, raw: Buffer) {
    const { files, builtinFiles } = await createFiles(prefix);
    const agentDir = files.builtinAgentDir('mavis');
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, 'agent.md'), raw);
    return { files, builtinFiles, agentDir, archiveFile: `.agent.md.corrupted.${sha256(raw)}.raw` };
  }

  it.each([
    ['broken frontmatter', Buffer.from('---\r\nname: mavis\r\ntools: [\r\n---\r\n用户提示词\r\n')],
    ['plain text without frontmatter', Buffer.from('你是我的私人助理。\nKeep answers short.\n')],
  ])(
    'archives %s byte-for-byte and rewrites agent.md from the bundled template',
    async (_label, raw) => {
      const { files, builtinFiles, agentDir, archiveFile } = await corruptedBuiltin(
        'agent-files-builtin-corrupted-',
        raw,
      );
      await expect(files.getBuiltinCanonicalConfig('mavis')).rejects.toMatchObject({
        code: 'AGENT_CONFIG_INVALID',
      });

      await expect(builtinFiles.repair('mavis', bundled)).resolves.toEqual({ archiveFile });

      expect((await readFile(join(agentDir, archiveFile))).equals(raw)).toBe(true);
      await expect(files.getBuiltinCanonicalConfig('mavis')).resolves.toMatchObject({
        name: 'mavis',
        systemPrompt: 'Bundled template.',
      });
    },
  );

  it('does not create another archive when the same corrupted bytes are repaired again', async () => {
    const raw = Buffer.from('---\nname: [mavis\n---\nBody\n');
    const { files, builtinFiles, agentDir, archiveFile } = await corruptedBuiltin(
      'agent-files-builtin-corrupted-repeat-',
      raw,
    );
    await builtinFiles.repair('mavis', bundled);
    await writeFile(join(agentDir, 'agent.md'), raw);

    await expect(builtinFiles.repair('mavis', bundled)).resolves.toEqual({ archiveFile });

    const archives = (await readdir(agentDir)).filter((name) => name.includes('.corrupted.'));
    expect(archives).toEqual([archiveFile]);
    await expect(files.getBuiltinCanonicalConfig('mavis')).resolves.toMatchObject({
      systemPrompt: 'Bundled template.',
    });
  });

  it('leaves the corrupted source untouched when its archive cannot be published', async () => {
    const raw = Buffer.from('plain prompt\n');
    const { builtinFiles, agentDir, archiveFile } = await corruptedBuiltin(
      'agent-files-builtin-corrupted-archive-failure-',
      raw,
    );
    const failure = new Error('private archive staging unavailable');
    vi.spyOn(filePublication, 'publishFileIfAbsent').mockRejectedValueOnce(failure);

    await expect(builtinFiles.repair('mavis', bundled)).rejects.toMatchObject({
      name: 'BuiltinAgentConfigRepairError',
      stage: 'archive',
      failure,
    });

    expect((await readFile(join(agentDir, 'agent.md'))).equals(raw)).toBe(true);
    await expect(readFile(join(agentDir, archiveFile))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps a newer source that changed after the corrupted bytes were archived', async () => {
    const raw = Buffer.from('plain prompt\n');
    const { builtinFiles, agentDir, archiveFile } = await corruptedBuiltin(
      'agent-files-builtin-corrupted-race-',
      raw,
    );
    const agentFile = join(agentDir, 'agent.md');
    const publishFileIfAbsent = filePublication.publishFileIfAbsent;
    vi.spyOn(filePublication, 'publishFileIfAbsent').mockImplementationOnce(
      async (path, contents, validateTemporary) => {
        const outcome = await publishFileIfAbsent(path, contents, validateTemporary);
        await writeFile(agentFile, 'user fixed it meanwhile\n', 'utf8');
        return outcome;
      },
    );

    await expect(builtinFiles.repair('mavis', bundled)).rejects.toMatchObject({
      stage: 'rewrite',
      archiveFile,
    });

    await expect(readFile(agentFile, 'utf8')).resolves.toBe('user fixed it meanwhile\n');
    expect((await readFile(join(agentDir, archiveFile))).equals(raw)).toBe(true);
  });

  it('still repairs a source whose YAML parses but whose avatar is unusable', async () => {
    // The in-lock re-check must be the full startup read: a YAML-only check
    // would call this file valid and skip the repair.
    const { files, builtinFiles } = await createFiles('agent-files-builtin-corrupted-avatar-');
    await builtinFiles.seed('mavis', bundled);
    const agentDir = files.builtinAgentDir('mavis');
    const agentFile = join(agentDir, 'agent.md');
    const raw = Buffer.from(
      (await readFile(agentFile, 'utf8')).replace(
        /^---\n/u,
        '---\nx-mavis:\n  avatar: ./avatar.png\n',
      ),
    );
    await writeFile(agentFile, raw);
    await expect(files.getBuiltinCanonicalConfig('mavis')).rejects.toMatchObject({
      code: 'AGENT_CONFIG_AVATAR_INVALID',
    });

    const archiveFile = `.agent.md.corrupted.${sha256(raw)}.raw`;
    await expect(builtinFiles.repair('mavis', bundled)).resolves.toEqual({ archiveFile });

    expect((await readFile(join(agentDir, archiveFile))).equals(raw)).toBe(true);
    await expect(files.getBuiltinCanonicalConfig('mavis')).resolves.toMatchObject({
      systemPrompt: 'Bundled template.',
    });
  });

  it('refuses to archive through a linked agent.md and leaves the link target untouched', async () => {
    const { dataDir, files, builtinFiles } = await createFiles(
      'agent-files-builtin-corrupted-link-',
    );
    const agentDir = files.builtinAgentDir('mavis');
    await mkdir(agentDir, { recursive: true });
    const outside = join(dataDir, 'outside.md');
    await writeFile(outside, 'outside secret\n', 'utf8');
    await symlink(outside, join(agentDir, 'agent.md'));

    await expect(builtinFiles.repair('mavis', bundled)).rejects.toMatchObject({
      stage: 'archive',
    });

    await expect(readFile(outside, 'utf8')).resolves.toBe('outside secret\n');
    expect((await lstat(join(agentDir, 'agent.md'))).isSymbolicLink()).toBe(true);
    expect((await readdir(agentDir)).filter((name) => name.includes('.corrupted.'))).toEqual([]);
  });
});

function sha256(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex');
}
