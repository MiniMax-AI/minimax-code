import fs from 'node:fs';
import os from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isPrivateTemporaryNameFor,
  privateTemporaryPath,
  writePrivateConfigFileSync,
  writePrivateFileAtomicSync,
} from '../src/private-config-file.js';

let root: string;
let file: string;

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'private-config-write-'));
  file = join(root, 'config.yaml');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

// These use the native filesystem on every OS, including Windows.
describe('private config writes', () => {
  it.each([false, true])('creates a missing file (exclusive=%s)', (exclusive) => {
    writePrivateConfigFileSync(file, 'logLevel: info\n', exclusive);
    expect(fs.readFileSync(file, 'utf8')).toBe('logLevel: info\n');
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it.each(['logLevel: info\n', Buffer.from('logLevel: info\n')])(
    'replaces longer content without appending or retaining a suffix',
    (content) => {
      fs.writeFileSync(file, 'logLevel: debug\n# old credentials and trailing data\n');
      writePrivateConfigFileSync(file, content);
      expect(fs.readFileSync(file, 'utf8')).toBe('logLevel: info\n');
    },
  );

  it('does not overwrite an existing file in exclusive mode', () => {
    fs.writeFileSync(file, 'original');
    expect(() => writePrivateConfigFileSync(file, 'replacement', true)).toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('original');
  });

  it.each(['fchmodSync', 'ftruncateSync'] as const)(
    'closes the descriptor and stops writing when %s fails',
    (operation) => {
      fs.writeFileSync(file, 'original');
      const failure = Object.assign(new Error('synthetic failure'), { code: 'EPERM' });
      vi.spyOn(fs, operation).mockImplementation(() => {
        throw failure;
      });
      const write = vi.spyOn(fs, 'writeFileSync');
      const close = vi.spyOn(fs, 'closeSync');
      expect(() => writePrivateConfigFileSync(file, 'replacement')).toThrow(failure);
      expect(write).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(file, 'utf8')).toBe('original');
    },
  );

  it('propagates a write failure and closes the descriptor', () => {
    const failure = new Error('synthetic write failure');
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => {
      throw failure;
    });
    const close = vi.spyOn(fs, 'closeSync');
    expect(() => writePrivateConfigFileSync(file, 'replacement')).toThrow(failure);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('atomic private writes', () => {
  it('replaces the target with an owner-only file and leaves no temporary file', () => {
    fs.writeFileSync(file, 'original', { mode: 0o644 });
    writePrivateFileAtomicSync(file, 'replacement');
    expect(fs.readFileSync(file, 'utf8')).toBe('replacement');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(root)).toEqual(['config.yaml']);
  });

  it('keeps the old file, removes the temporary file and rethrows when the replace fails', () => {
    fs.writeFileSync(file, 'original');
    const failure = Object.assign(new Error('synthetic rename failure'), { code: 'EBUSY' });
    let attempts = 0;
    expect(() =>
      writePrivateFileAtomicSync(file, 'replacement', () => {
        attempts += 1;
        throw failure;
      }),
    ).toThrow(failure);
    expect(attempts).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe('original');
    expect(fs.readdirSync(root)).toEqual(['config.yaml']);
  });

  it('recognizes exactly its own temporary names, never a look-alike the user made', () => {
    const own = basename(privateTemporaryPath(join(root, '.config-state.json')));
    expect(isPrivateTemporaryNameFor(own, '.config-state.json')).toBe(true);
    for (const name of [
      '.config-state.json',
      '.config-state.json.bak',
      '.config-state.json.bak.tmp',
      '.config-state.json.42.abc.tmp',
      `x${own}`,
    ]) {
      expect(isPrivateTemporaryNameFor(name, '.config-state.json')).toBe(false);
    }
  });
});
