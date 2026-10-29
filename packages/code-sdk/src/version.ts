import { spawn } from 'node:child_process';

import { buildSpawnCommand, type ResolvedCli } from './cli-resolver.js';
import { MCODE_INSTALL_HINT, MCodeError, MCodeNotFoundError, MCodeVersionError } from './errors.js';

/**
 * First CLI release whose `mcode exec` flags cover everything the SDK passes.
 * `--system-prompt-file`, `--append-system-prompt-file` and `--mode` landed in 0.6.3
 * (`packages/tui/CHANGELOG.md`); `--output-format stream-json` and the other exec flags were
 * already present. This repository's CLI is 0.6.5, so a source build of this tree satisfies the
 * check. Preview builds such as `0.6.3-preview.N` satisfy `0.6.3`.
 */
export const MIN_CLI_VERSION = '0.6.3';

const VERSION_TIMEOUT_MS = 30_000;

export interface ParsedVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease?: string;
}

export function parseVersion(text: string): ParsedVersion | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/u.exec(text);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    ...(match[4] ? { prerelease: match[4] } : {}),
  };
}

/**
 * Compares only `major.minor.patch`. Preview builds such as `0.6.3-preview.N` satisfy `0.6.3`
 * because the preview channel ships the same exec contract as its release line.
 */
export function satisfiesMinimum(version: ParsedVersion, minimum: ParsedVersion): boolean {
  if (version.major !== minimum.major) return version.major > minimum.major;
  if (version.minor !== minimum.minor) return version.minor > minimum.minor;
  return version.patch >= minimum.patch;
}

/** Runs `mcode --version` and rejects CLIs older than {@link MIN_CLI_VERSION}. */
export async function checkCliVersion(
  cli: ResolvedCli,
  env: Readonly<Record<string, string | undefined>>,
  spawnChild: typeof spawn = spawn,
): Promise<string> {
  const output = await readVersionOutput(cli, env, spawnChild);
  const parsed = parseVersion(output);
  const minimum = parseVersion(MIN_CLI_VERSION) as ParsedVersion;
  if (!parsed) {
    throw new MCodeVersionError(
      `Could not read the mcode version from: ${output.trim() || '(empty)'}.`,
    );
  }
  const version =
    output
      .trim()
      .split(/\s+/u)
      .find((part) => parseVersion(part)) ?? output.trim();
  if (!satisfiesMinimum(parsed, minimum)) {
    throw new MCodeVersionError(
      `mcode ${version} is older than the minimum ${MIN_CLI_VERSION} required by @minimax-ai/code-sdk. Upgrade with \`${MCODE_INSTALL_HINT}\`.`,
      { version },
    );
  }
  return version;
}

function readVersionOutput(
  cli: ResolvedCli,
  env: Readonly<Record<string, string | undefined>>,
  spawnChild: typeof spawn,
): Promise<string> {
  const command = buildSpawnCommand(cli, ['--version']);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const child = spawnChild(command.command, command.args, {
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    // Attach before any use of stdio. A failed spawn (EMFILE) emits 'error' on the next tick
    // with null pipes; touching stdout first throws and leaves that event unhandled.
    child.once('error', (error: NodeJS.ErrnoException) => {
      finish(() => {
        reject(
          error.code === 'ENOENT' || error.code === 'EACCES'
            ? new MCodeNotFoundError(`Could not start mcode at ${cli.path}.`, { cause: error })
            : error,
        );
      });
    });
    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, VERSION_TIMEOUT_MS);
    if (!child.stdout || !child.stderr) {
      finish(() => {
        reject(new MCodeError('mcode stdout is unavailable.'));
      });
      return;
    }
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('close', (code, signal) => {
      finish(() => {
        if (code === 0) {
          resolve(stdout);
          return;
        }
        reject(
          new MCodeVersionError(
            `\`mcode --version\` failed (${String(code ?? signal)}); cannot verify CLI compatibility.`,
            { exitCode: code, signal, stderr: stderr.slice(-4096) },
          ),
        );
      });
    });
  });
}
