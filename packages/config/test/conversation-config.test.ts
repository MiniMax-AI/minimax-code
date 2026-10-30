import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONVERSATION_STOP_CONFIG_DEFAULTS,
  parseConversationStopConfig,
  readConversationStopConfig,
} from '../src/index.js';

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const DEFAULT_SOURCES = { stopSubAgent: 'default', stopAsyncBash: 'default' } as const;
const FAILED_SOURCES = { stopSubAgent: 'read_failed', stopAsyncBash: 'read_failed' } as const;

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mavis-conversation-config-'));
  roots.push(root);
  return root;
}

async function configFile(content: string): Promise<string> {
  const path = join(await tempDir(), 'config.yaml');
  await writeFile(path, content);
  return path;
}

describe('parseConversationStopConfig', () => {
  it('uses the defaults when the conversation section is missing or not a mapping', () => {
    for (const raw of [
      {},
      { conversation: null },
      { conversation: true },
      { conversation: ['stopSubAgent'] },
    ]) {
      expect(parseConversationStopConfig(raw)).toEqual({
        ...CONVERSATION_STOP_CONFIG_DEFAULTS,
        policySource: DEFAULT_SOURCES,
      });
    }
    // The documented defaults: a stop cascades to both subagents and background bash.
    expect(CONVERSATION_STOP_CONFIG_DEFAULTS).toEqual({ stopSubAgent: true, stopAsyncBash: true });
  });

  it('takes explicit booleans and marks them explicit', () => {
    expect(
      parseConversationStopConfig({ conversation: { stopSubAgent: true, stopAsyncBash: false } }),
    ).toEqual({
      stopSubAgent: true,
      stopAsyncBash: false,
      policySource: { stopSubAgent: 'explicit', stopAsyncBash: 'explicit' },
    });
    // `stopSubAgent` is absent, so it falls back to the (on) default.
    expect(parseConversationStopConfig({ conversation: { stopAsyncBash: false } })).toEqual({
      stopSubAgent: true,
      stopAsyncBash: false,
      policySource: { stopSubAgent: 'default', stopAsyncBash: 'explicit' },
    });
  });

  it('keeps the default for a non-boolean value and lists the key as ignored', () => {
    expect(
      parseConversationStopConfig({ conversation: { stopSubAgent: 'true', stopAsyncBash: 0 } }),
    ).toEqual({
      ...CONVERSATION_STOP_CONFIG_DEFAULTS,
      policySource: DEFAULT_SOURCES,
      ignoredKeys: ['stopSubAgent', 'stopAsyncBash'],
    });
    // An empty value (`stopSubAgent:`) is present but not a boolean either.
    expect(parseConversationStopConfig({ conversation: { stopSubAgent: null } })).toMatchObject({
      stopSubAgent: true,
      ignoredKeys: ['stopSubAgent'],
    });
  });
});

describe('readConversationStopConfig', () => {
  it('returns the defaults as default when config.yaml does not exist', async () => {
    const path = join(await tempDir(), 'config.yaml');

    expect(readConversationStopConfig(path)).toEqual({
      ...CONVERSATION_STOP_CONFIG_DEFAULTS,
      policySource: DEFAULT_SOURCES,
      configPath: path,
    });
  });

  it('returns the defaults as default for an empty file', async () => {
    const path = await configFile('');

    expect(readConversationStopConfig(path)).toEqual({
      ...CONVERSATION_STOP_CONFIG_DEFAULTS,
      policySource: DEFAULT_SOURCES,
      configPath: path,
    });
  });

  it('reads explicit switches and ignores YAML words that are not booleans', async () => {
    const path = await configFile(
      ['defaultModel: provider/model', 'conversation:', '  stopSubAgent: yes', '  stopAsyncBash: false', ''].join(
        '\n',
      ),
    );

    expect(readConversationStopConfig(path)).toEqual({
      stopSubAgent: true,
      stopAsyncBash: false,
      policySource: { stopSubAgent: 'default', stopAsyncBash: 'explicit' },
      ignoredKeys: ['stopSubAgent'],
      configPath: path,
    });
  });

  it('returns read_failed with a fixed reason and the line only for invalid YAML', async () => {
    const secret = 'sk-live-do-not-log-1234567890';
    const path = await configFile(
      ['provider:', '  test:', `    apiKey: ${secret}`, 'conversation: [unclosed', ''].join('\n'),
    );

    const result = readConversationStopConfig(path);

    expect(result).toEqual({
      ...CONVERSATION_STOP_CONFIG_DEFAULTS,
      policySource: FAILED_SOURCES,
      failure: { reason: 'yaml_error', line: expect.any(Number) },
      configPath: path,
    });
    expect(result.failure?.line).toBeGreaterThanOrEqual(4);
    // YAML errors quote source lines; none of the file's content may leave the reader.
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain('unclosed');
  });

  it('returns read_failed when the root is not a mapping', async () => {
    const path = await configFile('- conversation\n- stopSubAgent\n');

    expect(readConversationStopConfig(path)).toEqual({
      ...CONVERSATION_STOP_CONFIG_DEFAULTS,
      policySource: FAILED_SOURCES,
      failure: { reason: 'not_a_mapping' },
      configPath: path,
    });
  });

  it('returns read_failed with the errno code when the path cannot be read', async () => {
    const path = await tempDir();

    expect(readConversationStopConfig(path)).toEqual({
      ...CONVERSATION_STOP_CONFIG_DEFAULTS,
      policySource: FAILED_SOURCES,
      failure: { reason: 'read_error', errorCode: 'EISDIR' },
      configPath: path,
    });
  });

  it('reads the file afresh on every call', async () => {
    const path = await configFile('conversation:\n  stopSubAgent: true\n');
    expect(readConversationStopConfig(path).stopSubAgent).toBe(true);

    await writeFile(path, 'conversation:\n  stopSubAgent: false\n');

    expect(readConversationStopConfig(path)).toMatchObject({
      stopSubAgent: false,
      policySource: { stopSubAgent: 'explicit' },
    });
  });

  it('never writes the config file or its directory', async () => {
    const dir = await tempDir();
    const path = join(dir, 'config.yaml');
    const content = 'conversation:\n  stopSubAgent: true\n';
    await writeFile(path, content, { mode: 0o644 });
    const before = await stat(path);

    readConversationStopConfig(path);

    const after = await stat(path);
    expect(await readFile(path, 'utf8')).toBe(content);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.mode).toBe(before.mode);
    expect(await readdir(dir)).toEqual(['config.yaml']);
  });

  it('reads getConfigPath() when no path is given', async () => {
    const dir = await tempDir();
    vi.stubEnv('MINIMAX_DATA_DIR', dir);
    await writeFile(join(dir, 'config.yaml'), 'conversation:\n  stopAsyncBash: false\n');

    expect(readConversationStopConfig()).toEqual({
      stopSubAgent: true,
      stopAsyncBash: false,
      policySource: { stopSubAgent: 'default', stopAsyncBash: 'explicit' },
      configPath: join(dir, 'config.yaml'),
    });
  });
});
