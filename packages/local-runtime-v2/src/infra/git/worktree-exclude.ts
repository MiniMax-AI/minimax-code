import { execFile as execFileCallback } from 'node:child_process';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const ENTRY = '/.worktrees/';

/**
 * Keep the managed `.worktrees/` directory out of the repository's `git status`
 * by listing it in the local `info/exclude` file, which is never committed.
 * Best effort: a repository whose exclude file cannot be read or written still
 * gets its worktree.
 */
export async function excludeManagedWorktrees(repositoryDir: string): Promise<void> {
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: repositoryDir,
      encoding: 'utf-8',
      env: gitEnv(),
    });
    const relativePath = String(stdout).trim();
    if (!relativePath) return;
    const file = isAbsolute(relativePath) ? relativePath : resolve(repositoryDir, relativePath);
    const current = await readText(file);
    if (current.split(/\r?\n/).some((line) => isWorktreesEntry(line.trim()))) return;
    await mkdir(dirname(file), { recursive: true });
    const separator = current === '' || current.endsWith('\n') ? '' : '\n';
    await appendFile(file, `${separator}${ENTRY}\n`);
  } catch {
    // Best effort: the worktree is still created without the exclude entry.
  }
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf-8');
  } catch {
    return '';
  }
}

function isWorktreesEntry(line: string): boolean {
  return ['.worktrees', '.worktrees/', '/.worktrees', ENTRY].includes(line);
}

function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}
