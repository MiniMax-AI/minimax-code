import { constants as fsConstants } from 'node:fs';
import { lstat, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  publishFileIfAbsent,
  replaceFileAtomically,
  type FilePublicationOutcome,
} from '../../../infra/file/jsonl.js';
import type { BuiltinCorruptedConfigRepair } from '../contracts.js';
import {
  AgentConfigRevisionConflictError,
  documentRevision,
  rawDigest,
  type AgentFiles,
} from './agent-files.js';
import {
  AgentConfigError,
  parseBuiltinCanonicalAgentMarkdown,
  readStableAgentMarkdown,
  serializeBuiltinCanonicalAgentConfig,
  validateAgentAvatar,
  type BuiltinCanonicalAgentConfigForWrite,
} from './canonical-agent-config.js';

const SYSTEM_PROMPT_FILE = 'agent.md';

/**
 * Names the step that failed while repairing a corrupted Builtin source, so
 * startup can log where the repair stopped without exposing paths or content.
 * `archiveFile` is set once the original bytes are safely archived.
 */
export class BuiltinAgentConfigRepairError extends Error {
  constructor(
    readonly stage: 'archive' | 'rewrite',
    readonly failure: unknown,
    readonly archiveFile?: string,
  ) {
    super(`Builtin Agent configuration repair failed during ${stage}.`);
    this.name = 'BuiltinAgentConfigRepairError';
  }
}

/**
 * Whole-file writes of a Builtin source `.builtin/<name>/agent.md`: seed a
 * missing file, reload a valid one to the bundled content, and archive then
 * rewrite a corrupted one. Each runs under the `.builtin:<name>` lock that
 * AgentFiles uses for every other operation on the same Builtin source.
 */
export class BuiltinAgentFiles {
  constructor(
    private readonly files: AgentFiles,
    private readonly dataDir: string,
  ) {}

  /**
   * Seeds a Builtin source only when its canonical file is absent. Reports
   * whether this call published it, so a racing writer can tell it lost.
   */
  seed(name: string, config: BuiltinCanonicalAgentConfigForWrite): Promise<FilePublicationOutcome> {
    return this.files.withLock(`.builtin:${name}`, async () => {
      const agentDir = this.files.builtinAgentDir(name);
      await this.files.ensureSafeAgentDirectory(agentDir);
      await this.validateForWrite(agentDir, name, config);
      const filePath = join(agentDir, SYSTEM_PROMPT_FILE);
      const serialized = serializeBuiltinCanonicalAgentConfig({ config });
      return publishFileIfAbsent(filePath, serialized, async (temporaryPath) => {
        parseBuiltinCanonicalAgentMarkdown(await readFile(temporaryPath, 'utf8'), name, {
          requireFeaturePolicy: true,
        });
      });
    });
  }

  /**
   * Startup-only reload of a valid Builtin source to the current bundled
   * content. Unlike a Config PUT this may change every field, so it bypasses
   * the model-only guard. It compares against the revision the caller read and
   * skips (`conflict`) when the file changed since; identical bytes are left
   * alone (`unchanged`) so an unchanged startup does not touch the file.
   */
  reload(
    name: string,
    config: BuiltinCanonicalAgentConfigForWrite,
    expectedRevision: string,
  ): Promise<'rewritten' | 'unchanged' | 'conflict'> {
    return this.files.withLock(`.builtin:${name}`, async () => {
      const agentDir = this.files.builtinAgentDir(name);
      await this.files.ensureSafeAgentDirectory(agentDir);
      let current: string;
      try {
        current = await readStableAgentMarkdown({
          agentDir,
          routeName: name,
          trustedRoot: this.dataDir,
        });
      } catch (error) {
        if (error instanceof AgentConfigError && error.code === 'AGENT_CONFIG_NOT_FOUND') {
          return 'conflict';
        }
        throw error;
      }
      if (documentRevision(current) !== expectedRevision) return 'conflict';
      const serialized = serializeBuiltinCanonicalAgentConfig({ config });
      if (serialized === current) return 'unchanged';
      await this.validateForWrite(agentDir, name, config);
      await replaceFileAtomically(join(agentDir, SYSTEM_PROMPT_FILE), serialized, async (path) => {
        parseBuiltinCanonicalAgentMarkdown(await readFile(path, 'utf8'), name, {
          requireFeaturePolicy: true,
        });
      });
      return 'rewritten';
    });
  }

  /**
   * Startup-only repair for a Builtin source that exists but can no longer be
   * read as a valid config. Before the bundled baseline replaces it, the exact
   * bytes are copied beside it as `.agent.md.corrupted.<sha256>.raw` so user
   * edits stay recoverable. If archiving fails the original is left untouched;
   * if the file changed after it was archived, the newer bytes are not replaced.
   * A source that is valid or missing again by the time the lock is held is
   * left as it is (`skipped`).
   */
  repair(
    name: string,
    config: BuiltinCanonicalAgentConfigForWrite,
  ): Promise<BuiltinCorruptedConfigRepair> {
    return this.files.withLock(`.builtin:${name}`, async () => {
      const agentDir = this.files.builtinAgentDir(name);
      const filePath = join(agentDir, SYSTEM_PROMPT_FILE);
      let raw: Buffer;
      let archiveFile: string;
      try {
        await this.files.ensureSafeAgentDirectory(agentDir);
        const skipped = await this.reasonToSkipRepair(name);
        if (skipped) return { skipped };
        raw = await readRegularFileBytes(filePath);
        archiveFile = `.${SYSTEM_PROMPT_FILE}.corrupted.${rawDigest(raw)}.raw`;
        await publishVerifiedRawArchive(join(agentDir, archiveFile), raw);
      } catch (error) {
        throw new BuiltinAgentConfigRepairError('archive', error);
      }
      try {
        if (!(await readRegularFileBytes(filePath)).equals(raw)) {
          throw new AgentConfigRevisionConflictError();
        }
        await this.validateForWrite(agentDir, name, config);
        const serialized = serializeBuiltinCanonicalAgentConfig({ config });
        await replaceFileAtomically(filePath, serialized, async (temporaryPath) => {
          parseBuiltinCanonicalAgentMarkdown(await readFile(temporaryPath, 'utf8'), name, {
            requireFeaturePolicy: true,
          });
        });
      } catch (error) {
        throw new BuiltinAgentConfigRepairError('rewrite', error, archiveFile);
      }
      return { archiveFile };
    });
  }

  /**
   * The caller judged the source corrupted before it awaited the bundled
   * template and the model group. Meanwhile the user may have fixed and saved
   * it, or an old ACP client may have deleted it and a Turn reseeded it. The
   * raw-bytes checks in repair() would accept such a file, and the fix,
   * including a just-saved model, would be replaced by a baseline built
   * without that model. So under the lock, run the same full read as the
   * startup check (getBuiltinCanonicalConfig, avatar included; a YAML-only
   * parse would miss AGENT_CONFIG_AVATAR_INVALID) and repair only a source
   * that is still unusable.
   */
  private async reasonToSkipRepair(name: string): Promise<'now_valid' | 'missing' | undefined> {
    try {
      await this.files.getBuiltinCanonicalConfig(name);
      return 'now_valid';
    } catch (error) {
      if (!(error instanceof AgentConfigError)) throw error;
      return error.code === 'AGENT_CONFIG_NOT_FOUND' ? 'missing' : undefined;
    }
  }

  private async validateForWrite(
    agentDir: string,
    routeName: string,
    config: BuiltinCanonicalAgentConfigForWrite,
  ): Promise<void> {
    parseBuiltinCanonicalAgentMarkdown(
      serializeBuiltinCanonicalAgentConfig({ config }),
      routeName,
      { requireFeaturePolicy: true },
    );
    if (config.xMavis?.avatar) {
      await validateAgentAvatar(agentDir, config.xMavis.avatar, this.dataDir);
    }
  }
}

/** Reads raw bytes without following a linked agent.md out of the Agent directory. */
async function readRegularFileBytes(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) {
      throw new AgentConfigError(
        'AGENT_CONFIG_INVALID',
        'agent.md',
        'Agent configuration must be a regular file.',
      );
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Same immutable-copy contract as the legacy template archive, but the bytes
 * are verified after a fresh publication too: the source may be replaced only
 * once this exact copy is readable from disk.
 */
async function publishVerifiedRawArchive(archivePath: string, raw: Buffer): Promise<void> {
  await publishFileIfAbsent(archivePath, raw);
  const metadata = await lstat(archivePath);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size !== raw.length) {
    throw new Error('Corrupted Builtin config archive is not the expected regular file.');
  }
  if (!(await readFile(archivePath)).equals(raw)) {
    throw new Error('Corrupted Builtin config archive does not match the current source.');
  }
}
