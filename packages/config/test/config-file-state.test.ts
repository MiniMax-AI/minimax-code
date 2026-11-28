import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acknowledgeConfigResetAt,
  configIssueMessage,
  fileSha256,
  holdsOnlyDefaults,
  readConfigFileForResolve,
  snapshotConfigFile,
  textSha256,
  trackConfigFileLifecycle,
  type ConfigFileWrite,
} from '../src/config-file-state.js';
import {
  CONFIG_RESET_PENDING_FILE,
  CONFIG_STATE_FILE,
  CONFIG_STATE_LOCK_FILE,
} from '../src/config-state-paths.js';

// Drives the config.yaml lifecycle the way getConfig() does: snapshot, let the
// app prepare the file and report what it wrote, read it, then track.
let dir: string;
let configPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-file-state-'));
  configPath = path.join(dir, 'config.yaml');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const DEFAULTS = 'logLevel: info\ndefaultModel: preset\n';

/** One getConfig() read. `app` is what the app's own preparation writes. */
function load(
  app?: { defaults?: string; copy?: string; rewrite?: string },
  during?: () => void,
): string[] {
  const before = snapshotConfigFile(configPath);
  let write: ConfigFileWrite = {};
  if (app?.defaults !== undefined) {
    fs.writeFileSync(configPath, app.defaults);
    write = { generatedSha256: textSha256(app.defaults) };
  } else if (app?.copy !== undefined) {
    fs.writeFileSync(configPath, app.copy);
    write = { copied: true };
  } else if (app?.rewrite !== undefined) {
    const fromSha256 = fileSha256(configPath);
    fs.writeFileSync(configPath, app.rewrite);
    write = { rewrite: { fromSha256, toSha256: fileSha256(configPath) } };
  }
  during?.();
  const file = readConfigFileForResolve(configPath);
  return [
    ...trackConfigFileLifecycle(configPath, before, write, file).map((issue) => issue.kind),
    ...file.issues.map((issue) => issue.kind),
  ];
}

function userSettings(content = 'logLevel: debug\n'): void {
  fs.writeFileSync(configPath, content);
  expect(load()).toEqual([]);
}

describe('config.yaml lifecycle', () => {
  it('says nothing about a first install or its untouched defaults being deleted', () => {
    expect(load({ defaults: DEFAULTS })).toEqual([]);
    expect(load({ rewrite: DEFAULTS.replace('preset', 'preset-v2') })).toEqual([]);
    fs.rmSync(configPath);
    expect(load({ defaults: DEFAULTS })).toEqual([]);
  });

  it('reports lost user settings until acknowledged, across recreated and migrated defaults', () => {
    load({ defaults: DEFAULTS });
    userSettings();
    fs.rmSync(configPath);
    // A reader without a UI notices first and the app recreates defaults…
    expect(load({ defaults: DEFAULTS })).toEqual(['missing']);
    // …the window still sees it, also after the app migrates its own file.
    expect(load({ rewrite: DEFAULTS.replace('preset', 'preset-v2') })).toEqual(['missing']);
    expect(load()).toEqual(['missing']);

    acknowledgeConfigResetAt(configPath, { missing: true });
    expect(load()).toEqual([]);
  });

  it('keeps a deletion pending when another writer changes the recreated file', () => {
    userSettings();
    fs.rmSync(configPath);
    expect(load({ defaults: DEFAULTS })).toEqual(['missing']);
    // A settings write (runtime config update) is not the user's lost file coming back.
    fs.writeFileSync(configPath, `${DEFAULTS}permissionMode: auto\n`);
    expect(load()).toEqual(['missing']);
  });

  it('resolves a deletion only when the same user file is put back', () => {
    userSettings('logLevel: debug\n');
    fs.rmSync(configPath);
    expect(load({ defaults: DEFAULTS })).toEqual(['missing']);
    fs.writeFileSync(configPath, 'logLevel: debug\n');
    expect(load()).toEqual([]);
    expect(load()).toEqual([]);
  });

  it('reports a file deleted while the read was running', () => {
    userSettings();
    expect(load(undefined, () => fs.rmSync(configPath))).toEqual(['missing']);
    expect(load()).toEqual(['missing']);
  });

  it("treats a config copied from the default data dir as the user's", () => {
    expect(load({ copy: 'logLevel: debug\nprovider: { x: {} }\n' })).toEqual([]);
    fs.rmSync(configPath);
    expect(load()).toEqual(['missing']);
  });

  it('reports a deletion that a config copied from the default data dir replaced', () => {
    // A derived profile (worktree) whose own settings the user changed.
    expect(load({ copy: 'logLevel: debug\n' })).toEqual([]);
    userSettings('logLevel: warn\n');
    fs.rmSync(configPath);
    const before = snapshotConfigFile(configPath);
    fs.writeFileSync(configPath, 'logLevel: debug\n');
    const file = readConfigFileForResolve(configPath);
    expect(trackConfigFileLifecycle(configPath, before, { copied: true }, file)).toEqual([
      expect.objectContaining({ kind: 'missing', fileInUse: true }),
    ]);
  });

  it("counts a file replaced between the app's write and this read as the user's", () => {
    // Another process saves the user's settings right after the defaults are written.
    expect(load({ defaults: DEFAULTS }, () => fs.writeFileSync(configPath, 'logLevel: debug\n'))).toEqual(
      [],
    );
    fs.rmSync(configPath);
    expect(load({ defaults: DEFAULTS })).toEqual(['missing']);
  });

  it('still notices a later loss after an acknowledgement', () => {
    userSettings();
    fs.rmSync(configPath);
    expect(load({ defaults: DEFAULTS })).toEqual(['missing']);
    acknowledgeConfigResetAt(configPath, { missing: true });
    expect(load()).toEqual([]);

    userSettings('logLevel: warn\n');
    fs.rmSync(configPath);
    expect(load({ defaults: DEFAULTS })).toEqual(['missing']);
  });

  it('reports an emptied file once shown, again after new settings are emptied, and its deletion', () => {
    userSettings();
    fs.writeFileSync(configPath, '# nothing left\n');
    expect(load()).toEqual(['empty']);
    acknowledgeConfigResetAt(configPath, { empty: true });
    expect(load()).toEqual([]);

    userSettings('logLevel: warn\n');
    fs.writeFileSync(configPath, '');
    expect(load()).toEqual(['empty']);
    acknowledgeConfigResetAt(configPath, { empty: true });
    fs.rmSync(configPath);
    expect(load({ defaults: DEFAULTS })).toEqual(['missing']);
  });

  it('reports a deleted file recreated empty as empty, not as missing', () => {
    userSettings();
    fs.rmSync(configPath);
    expect(load()).toEqual(['missing']);
    fs.writeFileSync(configPath, '');
    expect(load()).toEqual(['empty']);
    acknowledgeConfigResetAt(configPath, { empty: true });
    expect(load()).toEqual([]);
  });

  it('does not let a stale state write bring back an acknowledged deletion', () => {
    userSettings();
    fs.rmSync(configPath);
    expect(load({ defaults: DEFAULTS })).toEqual(['missing']);
    const staleState = fs.readFileSync(path.join(dir, CONFIG_STATE_FILE), 'utf-8');
    acknowledgeConfigResetAt(configPath, { missing: true });
    // Another process finishes a write it prepared before the acknowledgement.
    fs.writeFileSync(path.join(dir, CONFIG_STATE_FILE), staleState);
    expect(load()).toEqual([]);
  });

  it('keeps an unparsable restored file reported as a YAML problem', () => {
    userSettings();
    fs.rmSync(configPath);
    expect(load({ defaults: DEFAULTS })).toEqual(['missing']);
    fs.writeFileSync(configPath, 'logLevel: debug\nother: [\n');
    expect(load()).toEqual(['missing', 'invalid_yaml']);
  });

  it('reports an unreadable file as unreadable, not as deleted', () => {
    userSettings();
    fs.rmSync(configPath);
    fs.mkdirSync(configPath);
    expect(load()).toEqual(['unreadable']);
    expect(fs.existsSync(path.join(dir, CONFIG_RESET_PENDING_FILE))).toBe(false);
    fs.rmdirSync(configPath);
    fs.writeFileSync(configPath, 'logLevel: debug\n');
    expect(load()).toEqual([]);
  });

  it('marks a deletion whose replacement file is now in use', () => {
    userSettings('logLevel: debug\n');
    fs.rmSync(configPath);
    expect(load({ defaults: DEFAULTS })).toEqual(['missing']);
    fs.writeFileSync(configPath, 'logLevel: warn\nprovider: { x: {} }\n');
    const before = snapshotConfigFile(configPath);
    const file = readConfigFileForResolve(configPath);
    expect(trackConfigFileLifecycle(configPath, before, {}, file)).toEqual([
      expect.objectContaining({ kind: 'missing', fileInUse: true }),
    ]);
  });

  it('treats a file matching the generated defaults as the app\'s', () => {
    fs.writeFileSync(configPath, DEFAULTS);
    const before = snapshotConfigFile(configPath);
    const file = readConfigFileForResolve(configPath);
    expect(
      trackConfigFileLifecycle(configPath, before, { matchesDefaultsSha256: textSha256(DEFAULTS) }, file),
    ).toEqual([]);
    fs.rmSync(configPath);
    expect(load({ defaults: DEFAULTS })).toEqual([]);
  });

  it('judges by the bytes it parsed, not a later write by another process', () => {
    userSettings('logLevel: debug\n');
    fs.rmSync(configPath);
    expect(load({ defaults: DEFAULTS })).toEqual(['missing']);
    const before = snapshotConfigFile(configPath);
    const file = readConfigFileForResolve(configPath);
    // The user's file lands after this read parsed the defaults.
    fs.writeFileSync(configPath, 'logLevel: debug\n');
    expect(trackConfigFileLifecycle(configPath, before, {}, file).map((issue) => issue.kind)).toEqual([
      'missing',
    ]);
    expect(load()).toEqual([]);
  });

  it('keeps state files private and leaves no temporary file or lock behind', () => {
    userSettings();
    fs.rmSync(configPath);
    load({ defaults: DEFAULTS });
    if (process.platform !== 'win32') {
      for (const name of [CONFIG_STATE_FILE, CONFIG_RESET_PENDING_FILE]) {
        expect(fs.statSync(path.join(dir, name)).mode & 0o777).toBe(0o600);
      }
    }
    expect(fs.readdirSync(dir).sort()).toEqual(
      [CONFIG_RESET_PENDING_FILE, CONFIG_STATE_FILE, 'config.yaml'].sort(),
    );
  });

  function state(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(dir, CONFIG_STATE_FILE), 'utf-8'));
  }

  it('never overwrites the state while another process holds its lock, and records the acknowledgement later', () => {
    userSettings();
    fs.writeFileSync(configPath, '');
    expect(load()).toEqual(['empty']);
    const lockPath = path.join(dir, CONFIG_STATE_LOCK_FILE);
    fs.writeFileSync(lockPath, '');
    // The holder may be writing fields this process has not read yet.
    acknowledgeConfigResetAt(configPath, { empty: true });
    expect(state()).not.toHaveProperty('emptyAcknowledged');
    expect(fs.existsSync(lockPath)).toBe(true);
    // Shown already: the next read does not show it again.
    expect(load()).toEqual([]);

    fs.rmSync(lockPath);
    expect(load()).toEqual([]);
    expect(state()).toMatchObject({ hadUserSettings: true, emptyAcknowledged: true });
  });

  it('does not report again a deletion whose marker survived its recorded acknowledgement', () => {
    userSettings();
    fs.rmSync(configPath);
    expect(load({ defaults: DEFAULTS })).toEqual(['missing']);
    const marker = path.join(dir, CONFIG_RESET_PENDING_FILE);
    const token = fs.readFileSync(marker, 'utf-8');
    acknowledgeConfigResetAt(configPath, { missing: true });
    // Killed (or a Windows sharing violation) before the marker was removed.
    fs.writeFileSync(marker, token);
    expect(load()).toEqual([]);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('does not mark a deletion again from state read before another process acknowledged it', () => {
    userSettings();
    fs.rmSync(configPath);
    expect(load({ defaults: DEFAULTS })).toEqual(['missing']);
    const statePath = path.join(dir, CONFIG_STATE_FILE);
    const before = fs.readFileSync(statePath, 'utf-8');
    // Another process shows and acknowledges it while this read is running.
    acknowledgeConfigResetAt(configPath, { missing: true });
    fs.rmSync(configPath);
    const read = fs.readFileSync;
    let stale = true;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      if (stale && file === statePath) {
        stale = false;
        return before;
      }
      return (read as (...args: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    expect(load({ defaults: DEFAULTS })).toEqual([]);
    vi.restoreAllMocks();
    expect(fs.existsSync(path.join(dir, CONFIG_RESET_PENDING_FILE))).toBe(false);
  });

  it('does not let a late acknowledgement swallow a deletion that happened after it was shown', () => {
    userSettings('logLevel: debug\n');
    fs.rmSync(configPath);
    expect(load({ defaults: DEFAULTS })).toEqual(['missing']);
    // Another process holds the state lock for all of what follows.
    const lockPath = path.join(dir, CONFIG_STATE_LOCK_FILE);
    fs.writeFileSync(lockPath, `${process.pid} holder`);
    acknowledgeConfigResetAt(configPath, { missing: true });
    // Before it is recorded the user puts the file back, then deletes it again.
    fs.writeFileSync(configPath, 'logLevel: debug\n');
    expect(load()).toEqual([]);
    fs.rmSync(configPath);
    // A new deletion: not the one that was shown.
    expect(load({ defaults: DEFAULTS })).toEqual(['missing']);
    fs.rmSync(lockPath);
    expect(load()).toEqual(['missing']);
    expect(fs.existsSync(path.join(dir, CONFIG_RESET_PENDING_FILE))).toBe(true);
  });

  it('takes back a deletion marked without the lock once another process acknowledged it', () => {
    userSettings();
    fs.rmSync(configPath);
    const statePath = path.join(dir, CONFIG_STATE_FILE);
    const pendingPath = path.join(dir, CONFIG_RESET_PENDING_FILE);
    // A live holder keeps the lock, so this process marks without it.
    fs.writeFileSync(path.join(dir, CONFIG_STATE_LOCK_FILE), `${process.pid} holder`);
    const write = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
      const result = (write as (...args: unknown[]) => unknown)(file, ...rest);
      // Another process acknowledges right after the marker is written.
      if (file === pendingPath) {
        const acknowledged = { ...JSON.parse(fs.readFileSync(statePath, 'utf-8')), hadUserSettings: false };
        (write as (...args: unknown[]) => unknown)(statePath, JSON.stringify(acknowledged));
      }
      return result;
    }) as typeof fs.writeFileSync);
    load();
    vi.restoreAllMocks();
    expect(fs.existsSync(pendingPath)).toBe(false);
  });

  it('keeps a deletion pending until its acknowledgement is recorded', () => {
    userSettings();
    fs.rmSync(configPath);
    expect(load({ defaults: DEFAULTS })).toEqual(['missing']);
    const lockPath = path.join(dir, CONFIG_STATE_LOCK_FILE);
    fs.writeFileSync(lockPath, '');
    acknowledgeConfigResetAt(configPath, { missing: true });
    // Clearing it before hadUserSettings is reset would report deleting the defaults.
    expect(fs.existsSync(path.join(dir, CONFIG_RESET_PENDING_FILE))).toBe(true);
    fs.rmSync(lockPath);
    expect(load()).toEqual([]);
    expect(fs.existsSync(path.join(dir, CONFIG_RESET_PENDING_FILE))).toBe(false);
    fs.rmSync(configPath);
    expect(load({ defaults: DEFAULTS })).toEqual([]);
  });

  it('reclaims a state lock left by a process that died holding it', () => {
    userSettings();
    fs.writeFileSync(configPath, '');
    const lockPath = path.join(dir, CONFIG_STATE_LOCK_FILE);
    fs.writeFileSync(lockPath, '');
    const longAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, longAgo, longAgo);
    acknowledgeConfigResetAt(configPath, { empty: true });
    expect(state()).toMatchObject({ hadUserSettings: true, emptyAcknowledged: true });
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});

describe('holdsOnlyDefaults', () => {
  const cnProd = { logLevel: 'info', provider: { minimax: { baseURL: 'https://cn' } }, defaultModel: 'cn-model' };
  const enProd = { logLevel: 'info', provider: { minimax: { baseURL: 'https://en' } }, defaultModel: 'en-model' };
  const candidates = [cnProd, enProd, { logLevel: 'info', defaultModel: 'cn-model' }];

  it("accepts another build's or region's defaults and an older version's shorter file", () => {
    expect(holdsOnlyDefaults(structuredClone(enProd), candidates)).toBe(true);
    // Written by a version that did not yet write provider.
    expect(holdsOnlyDefaults({ logLevel: 'info', defaultModel: 'cn-model' }, candidates)).toBe(true);
  });

  it('treats any value the defaults never held as a user setting', () => {
    expect(holdsOnlyDefaults({ ...cnProd, logLevel: 'debug' }, candidates)).toBe(false);
    expect(holdsOnlyDefaults({ ...cnProd, permissionMode: 'auto' }, candidates)).toBe(false);
    // Mixing two regions' values is not any build's defaults.
    expect(holdsOnlyDefaults({ ...cnProd, defaultModel: 'en-model' }, candidates)).toBe(false);
    expect(holdsOnlyDefaults({}, candidates)).toBe(false);
  });
});

describe('configIssueMessage', () => {
  it('shows only rejected mode names and masks every other quoted value', () => {
    expect(
      configIssueMessage(new Error('Invalid sandbox.filesystem.policy.mode "danger_full_access"')),
    ).toBe('Invalid sandbox.filesystem.policy.mode "danger_full_access"');
    expect(configIssueMessage(new Error('Invalid provider.work.apiKey "sk-synthetic"'))).toBe(
      'Invalid provider.work.apiKey "…"',
    );
    // A key pasted into a non-secret field of an allowlisted section is still masked.
    expect(
      configIssueMessage(new Error('Invalid sandbox.network.deniedDomains entry "sk-abc123"')),
    ).toBe('Invalid sandbox.network.deniedDomains entry "…"');
    // A value that does not look like a mode name is masked even for a mode field.
    expect(configIssueMessage(new Error(`Invalid sandbox.localAccess "${'x'.repeat(100)}"`))).toBe(
      'Invalid sandbox.localAccess "…"',
    );
    expect(configIssueMessage(new Error('Invalid mcp.headers "Bearer sk-1"'))).toBe(
      'Invalid mcp.headers "…"',
    );
    // Unquoted credentials go through the shared redaction vocabulary.
    const syntheticQueryToken = ['abcdef', '123456'].join('');
    expect(
      configIssueMessage(new Error(`Invalid sandbox entry https://x.io/v1?api_key=${syntheticQueryToken}`)),
    ).not.toContain(syntheticQueryToken);
  });
});
