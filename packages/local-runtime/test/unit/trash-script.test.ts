import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

import { expect, it, vi } from 'vitest';

import { TRASH_SCRIPT_CONTENT } from '../../src/infra/trash-script.js';

const darwinScript = TRASH_SCRIPT_CONTENT.match(/osascript -l JavaScript -e '([\s\S]*?)' --/u)![1]!;

it.skipIf(process.platform === 'win32')(
  'passes paths and sandbox mode as data and preserves files on failure',
  () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mavis-quiet-trash-')));
    const bin = path.join(root, 'bin');
    const home = path.join(root, 'home');
    const log = path.join(root, 'calls');
    try {
      mkdirSync(bin);
      mkdirSync(path.join(home, '.Trash'), { recursive: true });
      writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\nprintf Darwin', { mode: 0o755 });
      writeFileSync(
        path.join(bin, 'osascript'),
        [
          '#!/bin/bash',
          'set -eu',
          '[ "$#" -eq 8 ] && [ "$1" = -l ] && [ "$2" = JavaScript ] && [ "$3" = -e ] && [ "$5" = -- ]',
          'printf "%s\\0%s\\0" "$6" "$7" >> "$TRASH_TEST_LOG"',
          'if [ "$TRASH_TEST_FAIL" = 1 ]; then exit 1; fi',
          '/bin/mv -- "$6" "$8/"',
        ].join('\n'),
        { mode: 0o755 },
      );
      const script = path.join(bin, 'mavis-trash');
      writeFileSync(script, TRASH_SCRIPT_CONTENT, { mode: 0o755 });
      const targets = ['中文 " $() `literal`\nfile', 'second', 'sandbox', 'denied'].map((name) =>
        path.join(root, name),
      );
      for (const target of targets) writeFileSync(target, target);
      const env = {
        ...process.env,
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        TRASH_TEST_LOG: log,
        TRASH_TEST_FAIL: '0',
        MAVIS_TRASH_FORCE_MV: '',
      };
      const native = spawnSync(script, ['--', ...targets.slice(0, 2)], {
        cwd: root,
        env,
        encoding: 'utf8',
      });
      expect(native.status, native.stderr).toBe(0);
      const sandbox = spawnSync(script, ['--', targets[2]!], {
        cwd: root,
        env: { ...env, MAVIS_TRASH_FORCE_MV: '1' },
        encoding: 'utf8',
      });
      expect(sandbox.status, sandbox.stderr).toBe(0);
      const failure = spawnSync(script, ['--', targets[3]!], {
        cwd: root,
        env: { ...env, TRASH_TEST_FAIL: '1' },
        encoding: 'utf8',
      });
      expect(failure.status).toBe(1);
      expect(readFileSync(targets[3]!, 'utf8')).toBe(targets[3]);
      expect(existsSync(path.join(home, '.Trash', 'denied'))).toBe(false);
      expect(readFileSync(log, 'utf8').split('\0').filter(Boolean)).toEqual([
        targets[0],
        'trash',
        targets[1],
        'trash',
        targets[2],
        'move',
        targets[3],
        'trash',
      ]);
      for (const target of targets.slice(0, 3))
        expect(readFileSync(path.join(home, '.Trash', path.basename(target)), 'utf8')).toBe(target);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it('falls back only for unavailable CoreServices and propagates permission and FileManager failures', () => {
  const source = '/tmp/中文 " `file`';
  for (const scenario of [
    'success',
    'missing',
    'unimplemented',
    'unsupported',
    'denied',
    'fallback-denied',
  ] as const) {
    const fallback = vi.fn(() => scenario !== 'fallback-denied');
    const free = vi.fn();
    const imports: string[] = [];
    const context = {
      ObjC: {
        import: (name: string) => {
          imports.push(name);
          if (scenario === 'missing' && name === 'CoreServices')
            throw new Error('missing framework');
        },
        bindFunction: vi.fn(),
        unwrap: (value: unknown) => value,
      },
      Ref: () => [{ localizedDescription: 'permission denied' }],
      $: {
        calloc: () => ({}),
        free,
        FSPathMakeRefWithOptions: () => 0,
        FSMoveObjectToTrashSync: () =>
          ({
            success: 0,
            missing: 0,
            unimplemented: -4,
            unsupported: -1426,
            denied: -54,
            'fallback-denied': -4,
          })[scenario],
        NSURL: { fileURLWithPath: (value: string) => value },
        NSFileManager: { defaultManager: { trashItemAtURLResultingItemURLError: fallback } },
      },
    };
    const run = runInNewContext(`${darwinScript}\nrun`, context) as (argv: string[]) => void;
    if (scenario === 'denied' || scenario === 'fallback-denied')
      expect(() => run([source, 'trash', '/trash'])).toThrow();
    else run([source, 'trash', '/trash']);
    const shouldFallback = !['success', 'denied'].includes(scenario);
    expect(fallback, scenario).toHaveBeenCalledTimes(shouldFallback ? 1 : 0);
    expect(imports.includes('Foundation'), scenario).toBe(shouldFallback);
    if (shouldFallback)
      expect(fallback).toHaveBeenCalledWith(source, null, [
        { localizedDescription: 'permission denied' },
      ]);
    expect(free, scenario).toHaveBeenCalledTimes(scenario === 'missing' ? 0 : 1);
  }
});

it('uses exclusive moves in the sandbox, retries only collisions, and never calls a recycling API', () => {
  for (const error of [17, 13, 18, 45]) {
    const move = vi.fn().mockReturnValueOnce(-1).mockReturnValue(0);
    const core = vi.fn();
    const fallback = vi.fn();
    const run = runInNewContext(`${darwinScript}\nrun`, {
      ObjC: { import: vi.fn(), bindFunction: vi.fn(), unwrap: (value: unknown) => value },
      $: {
        renamex_np: move,
        __error: () => [error],
        NSUUID: { UUID: { UUIDString: 'unique' } },
        FSMoveObjectToTrashSync: core,
        NSFileManager: { defaultManager: { trashItemAtURLResultingItemURLError: fallback } },
      },
    }) as (argv: string[]) => void;
    if (error === 17) run(['/source/name', 'move', '/trash']);
    else expect(() => run(['/source/name', 'move', '/trash'])).toThrow(`errno ${error}`);
    expect(move).toHaveBeenNthCalledWith(1, '/source/name', '/trash/name', 4);
    expect(move).toHaveBeenCalledTimes(error === 17 ? 2 : 1);
    if (error === 17)
      expect(move).toHaveBeenNthCalledWith(2, '/source/name', '/trash/name.unique', 4);
    expect(core).not.toHaveBeenCalled();
    expect(fallback).not.toHaveBeenCalled();
  }
});

it.skipIf(process.platform !== 'darwin')(
  'preserves concurrent same-name files, directories and dangling symlinks with the real macOS move API',
  async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'mavis-exclusive-trash-')));
    const home = path.join(root, 'home');
    const trash = path.join(home, '.Trash');
    try {
      mkdirSync(trash, { recursive: true });
      const script = path.join(root, 'mavis-trash');
      writeFileSync(script, TRASH_SCRIPT_CONTENT, { mode: 0o755 });
      // An existing dangling symlink must count as a conflict, too.
      symlinkSync('/nonexistent-original-trash-target', path.join(trash, 'same'));
      const sources = Array.from({ length: 4 }, (_, i) => {
        const dir = path.join(root, String(i));
        mkdirSync(dir);
        const file = path.join(dir, 'same');
        writeFileSync(file, `content-${i}`);
        return file;
      });
      const directory = path.join(root, 'directory');
      mkdirSync(directory);
      writeFileSync(path.join(directory, 'child'), 'child');
      const link = path.join(root, 'link');
      symlinkSync('/nonexistent-source-target', link);
      sources.push(directory, link);
      const moves = await Promise.allSettled(
        sources.map(
          (source) =>
            new Promise<void>((resolve, reject) => {
              const child = spawn(script, ['--', source], {
                cwd: root,
                env: { ...process.env, HOME: home, MAVIS_TRASH_FORCE_MV: '1' },
                stdio: ['ignore', 'ignore', 'pipe'],
                timeout: 10_000,
              });
              let stderr = '';
              child.stderr.on('data', (data: Buffer) => {
                stderr += data.toString();
              });
              child.on('error', reject);
              child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
            }),
        ),
      );
      for (const move of moves) {
        if (move.status === 'rejected') throw move.reason;
      }
      expect(readlinkSync(path.join(trash, 'same'))).toBe('/nonexistent-original-trash-target');
      const names = readdirSync(trash).filter((name) => name.startsWith('same.'));
      expect(names.map((name) => readFileSync(path.join(trash, name), 'utf8')).sort()).toEqual([
        'content-0',
        'content-1',
        'content-2',
        'content-3',
      ]);
      expect(readFileSync(path.join(trash, 'directory', 'child'), 'utf8')).toBe('child');
      expect(lstatSync(path.join(trash, 'link')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(path.join(trash, 'link'))).toBe('/nonexistent-source-target');
      for (const source of sources) expect(() => lstatSync(source)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// The Linux backend is unchanged by the macOS migration.
it('keeps the guarded Linux gio path and direct-move fallback', () => {
  const linux = TRASH_SCRIPT_CONTENT.split('    Linux)')[1]!;
  expect(linux).toContain('MAVIS_TRASH_FORCE_MV');
  expect(linux.indexOf('MAVIS_TRASH_FORCE_MV')).toBeLessThan(linux.indexOf('if gio trash'));
  expect(linux).toContain('mv "$file" "$dest"');
  expect(linux).toContain('the sandbox denied moving this file to the trash');
});
