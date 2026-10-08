import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { McodeNpmPackageName } from './install-source.js';
import {
  readMcodePrefixPackageMetadata,
  type McodePrefixPackageMetadata,
} from './prefix-update.js';

const RELEASES_DIRECTORY = 'releases';
const CURRENT_FILE = 'current';
const UPDATE_LOCK_DIRECTORY = '.mcode-update.lock';
const LAYOUT_VERSION = 2;

type McodePlatformPath = typeof path.posix | typeof path.win32;

export interface McodeVersionedPrefixActivation {
  readonly stagingPrefix: string;
  readonly activePrefix: string;
  readonly packageName: McodeNpmPackageName;
  readonly expectedVersion: string;
  readonly runtimeExecutable: string;
  readonly npmExecutable: string;
  readonly registry: string;
}

export function createMcodeVersionedPrefixStagingPrefix(
  activePrefix: string,
  version: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const platformPath = platformPathFor(platform);
  return platformPath.join(
    activePrefix,
    RELEASES_DIRECTORY,
    `.staging-${version}-${process.pid}-${randomUUID()}`,
  );
}

export function prepareMcodeVersionedPrefixStaging(stagingPrefix: string): void {
  mkdirSync(stagingPrefix, { recursive: true, mode: 0o700 });
}

export function acquireMcodeVersionedPrefixUpdateLock(activePrefix: string): () => void {
  const lockDirectory = path.join(activePrefix, UPDATE_LOCK_DIRECTORY);
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const claimName = `${String(process.pid)}-${randomUUID()}.claim`;
  const claimFile = path.join(lockDirectory, claimName);
  writeFileSync(claimFile, 'choosing\n', { flag: 'wx', mode: 0o600 });
  try {
    const ticket =
      Math.max(0, ...readLiveUpdateClaims(lockDirectory).map((claim) => claim.ticket ?? 0)) + 1;
    writeAtomicText(claimFile, `${String(ticket)}\n`, 0o600);
    const blocked = readLiveUpdateClaims(lockDirectory).some(
      (claim) =>
        claim.name !== claimName &&
        (claim.ticket === undefined ||
          claim.ticket < ticket ||
          (claim.ticket === ticket &&
            (claim.pid < process.pid ||
              (claim.pid === process.pid && claim.name.localeCompare(claimName) < 0)))),
    );
    if (blocked) throw new Error('Another MCode update is already running.');
  } catch (error) {
    rmSync(claimFile, { force: true });
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(claimFile, { force: true });
  };
}

export function activateMcodeVersionedPrefixInstall(
  activation: McodeVersionedPrefixActivation,
  platform: NodeJS.Platform = process.platform,
): string {
  const platformPath = platformPathFor(platform);
  const releasesRoot = platformPath.join(activation.activePrefix, RELEASES_DIRECTORY);
  const stagingMetadata = readExpectedMetadata(activation.stagingPrefix, activation, platform);

  // A release is complete before it becomes visible under releases/<release-key>.
  // Launchers use paths relative to the release root so the staged directory can be renamed.
  writeVersionedReleaseLaunchers(
    activation.stagingPrefix,
    stagingMetadata,
    activation.runtimeExecutable,
    platform,
  );
  assertVersionedRelease(activation.stagingPrefix, activation, platform);

  mkdirSync(releasesRoot, { recursive: true, mode: 0o700 });
  let releaseKey = activation.expectedVersion;
  let releasePrefix = platformPath.join(releasesRoot, releaseKey);
  if (existsSync(releasePrefix)) {
    // Never select bytes that did not pass this update attempt's full staging validation.
    releaseKey = `${activation.expectedVersion}-repair-${randomUUID()}`;
    releasePrefix = platformPath.join(releasesRoot, releaseKey);
  }
  renameSync(activation.stagingPrefix, releasePrefix);
  assertVersionedRelease(releasePrefix, activation, platform);

  writeVersionedInstallReceipt(activation, platform);
  if (!versionedRootLaunchersAreValid(activation.activePrefix, platform)) {
    writeVersionedRootLaunchers(activation.activePrefix, platform);
  }
  // The pointer is the commit point and is written only after the selected release and root
  // launchers are complete.
  writeAtomicText(
    platformPath.join(activation.activePrefix, CURRENT_FILE),
    `${releaseKey}\n`,
    0o600,
  );
  return releasePrefix;
}

function readExpectedMetadata(
  prefix: string,
  activation: McodeVersionedPrefixActivation,
  platform: NodeJS.Platform,
): McodePrefixPackageMetadata {
  const metadata = readMcodePrefixPackageMetadata(prefix, activation.packageName, platform);
  if (metadata.version !== activation.expectedVersion) {
    throw new Error(
      `MCode release contains ${metadata.version}; expected ${activation.expectedVersion}.`,
    );
  }
  return metadata;
}

function assertVersionedRelease(
  releasePrefix: string,
  activation: McodeVersionedPrefixActivation,
  platform: NodeJS.Platform,
): void {
  const metadata = readExpectedMetadata(releasePrefix, activation, platform);
  const expected = versionedReleaseLauncherContents(
    releasePrefix,
    metadata,
    activation.runtimeExecutable,
    platform,
  );
  for (const [file, contents] of expected) {
    if (readFileSync(file, 'utf8') !== contents) {
      throw new Error(`MCode release launcher is invalid: ${file}`);
    }
  }
}

function writeVersionedReleaseLaunchers(
  releasePrefix: string,
  metadata: McodePrefixPackageMetadata,
  runtimeExecutable: string,
  platform: NodeJS.Platform,
): void {
  for (const [file, contents] of versionedReleaseLauncherContents(
    releasePrefix,
    metadata,
    runtimeExecutable,
    platform,
  )) {
    writeAtomicText(file, contents, 0o700);
  }
}

function versionedReleaseLauncherContents(
  releasePrefix: string,
  metadata: McodePrefixPackageMetadata,
  runtimeExecutable: string,
  platform: NodeJS.Platform,
): ReadonlyMap<string, string> {
  const platformPath = platformPathFor(platform);
  const launchers = new Map<string, string>();
  if (!existsSync(runtimeExecutable)) {
    throw new Error('MCode versioned launcher runtime is missing.');
  }
  for (const command of versionedCommands(metadata)) {
    if (!command.binEntry) {
      throw new Error(`MCode versioned ${command.name} package entry is missing.`);
    }
    const entryFile = platformPath.join(metadata.packageRoot, ...command.binEntry.split('/'));
    const relativeEntry = platformPath.relative(releasePrefix, entryFile);
    if (
      !relativeEntry ||
      relativeEntry.startsWith('..') ||
      platformPath.isAbsolute(relativeEntry) ||
      !existsSync(entryFile)
    ) {
      throw new Error(`MCode versioned ${command.name} launcher path is invalid.`);
    }

    if (platform === 'win32') {
      launchers.set(
        platformPath.join(releasePrefix, `${command.releaseLauncher}.cmd`),
        `@ECHO off\r\n"${escapeBatch(runtimeExecutable)}" "%~dp0${escapeBatch(relativeEntry)}" %*\r\nEXIT /B %ERRORLEVEL%\r\n`,
      );
      launchers.set(
        platformPath.join(releasePrefix, `${command.releaseLauncher}.ps1`),
        `#!/usr/bin/env pwsh\r\n& '${escapePowerShell(runtimeExecutable)}' (Join-Path $PSScriptRoot '${escapePowerShell(relativeEntry)}') @args\r\nexit $LASTEXITCODE\r\n`,
      );
      continue;
    }

    launchers.set(
      platformPath.join(releasePrefix, command.releaseLauncher),
      `#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)\nnode=${quoteShell(runtimeExecutable)}\nif [ ! -x "$node" ]; then\n  printf "%s\\n" "MCode: Node runtime is missing: $node" "MCode: a system upgrade such as brew upgrade may have removed it." "MCode: re-run the MCode installer to repair this installation." >&2\n  exit 127\nfi\nexec "$node" "$root/${escapeDoubleQuoted(relativeEntry)}" "$@"\n`,
    );
  }
  return launchers;
}

function writeVersionedRootLaunchers(activePrefix: string, platform: NodeJS.Platform): void {
  for (const [file, contents] of versionedRootLauncherContents(activePrefix, platform)) {
    writeAtomicText(file, contents, 0o700);
  }
}

function versionedRootLaunchersAreValid(activePrefix: string, platform: NodeJS.Platform): boolean {
  try {
    for (const [file, contents] of versionedRootLauncherContents(activePrefix, platform)) {
      if (readFileSync(file, 'utf8') !== contents) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function versionedRootLauncherContents(
  activePrefix: string,
  platform: NodeJS.Platform,
): ReadonlyMap<string, string> {
  const platformPath = platformPathFor(platform);
  const launchers = new Map<string, string>();
  if (platform === 'win32') {
    for (const command of versionedCommands()) {
      launchers.set(
        platformPath.join(activePrefix, `${command.name}.cmd`),
        `@ECHO off\r\nSETLOCAL\r\nSET /P MCODE_RELEASE=<"%~dp0current"\r\nECHO(%MCODE_RELEASE%| %SystemRoot%\\System32\\findstr.exe /R /X "[0-9A-Za-z][0-9A-Za-z._-]*" >NUL || EXIT /B 1\r\nCALL "%~dp0releases\\%MCODE_RELEASE%\\${command.releaseLauncher}.cmd" %*\r\nEXIT /B %ERRORLEVEL%\r\n`,
      );
      launchers.set(
        platformPath.join(activePrefix, `${command.name}.ps1`),
        `#!/usr/bin/env pwsh\r\n$release = (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'current') -Raw).Trim()\r\nif ($release -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') { throw 'Invalid MCode current release pointer.' }\r\n& (Join-Path $PSScriptRoot "releases\\$release\\${command.releaseLauncher}.ps1") @args\r\nexit $LASTEXITCODE\r\n`,
      );
    }
    return launchers;
  }
  for (const command of versionedCommands()) {
    launchers.set(
      platformPath.join(activePrefix, 'bin', command.name),
      `#!/bin/sh\nset -eu\nroot=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)\nrelease=$(tr -d "\\r\\n" < "$root/current")\ncase "$release" in ""|*[!0-9A-Za-z._-]*) echo "Invalid MCode current release pointer." >&2; exit 1;; esac\nexec "$root/releases/$release/${command.releaseLauncher}" "$@"\n`,
    );
  }
  return launchers;
}

interface McodeVersionedCommand {
  readonly name: 'mcode' | 'mcode-tools';
  readonly releaseLauncher: '.mcode-launcher' | '.mcode-tools-launcher';
  readonly binEntry?: string;
}

function versionedCommands(
  metadata?: McodePrefixPackageMetadata,
): readonly McodeVersionedCommand[] {
  return [
    {
      name: 'mcode',
      releaseLauncher: '.mcode-launcher',
      ...(metadata ? { binEntry: metadata.binEntry } : {}),
    },
    {
      name: 'mcode-tools',
      releaseLauncher: '.mcode-tools-launcher',
      ...(metadata ? { binEntry: metadata.mcodeToolsBinEntry } : {}),
    },
  ];
}

function writeVersionedInstallReceipt(
  activation: McodeVersionedPrefixActivation,
  platform: NodeJS.Platform,
): void {
  const platformPath = platformPathFor(platform);
  const receipt = {
    schemaVersion: 2,
    product: 'minimax-code',
    updateOwner: 'npm-prefix',
    packageManager: 'npm',
    packageName: activation.packageName,
    registry: new URL(activation.registry).href,
    distTag: 'latest',
    npmExecutable: activation.npmExecutable,
    nodeExecutable: activation.runtimeExecutable,
    prefix: activation.activePrefix,
    layoutVersion: LAYOUT_VERSION,
    releasesDirectory: RELEASES_DIRECTORY,
    currentFile: CURRENT_FILE,
  };
  writeAtomicText(
    platformPath.join(activation.activePrefix, 'install.json'),
    `${JSON.stringify(receipt, null, 2)}\n`,
    0o600,
  );
}

function writeAtomicText(file: string, contents: string, mode: number): void {
  const temporaryFile = `${file}.tmp-${process.pid}-${randomUUID()}`;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(temporaryFile, contents, { mode });
    chmodSync(temporaryFile, mode);
    renameSync(temporaryFile, file);
  } catch (error) {
    rmSync(temporaryFile, { force: true });
    throw error;
  }
}

function readLiveUpdateClaims(
  lockDirectory: string,
): readonly { readonly name: string; readonly pid: number; readonly ticket?: number }[] {
  const claims: { name: string; pid: number; ticket?: number }[] = [];
  for (const name of readdirSync(lockDirectory)) {
    const match = /^(\d+)-.+\.claim$/u.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !isProcessAlive(pid)) continue;
    try {
      const rawTicket = readFileSync(path.join(lockDirectory, name), 'utf8').trim();
      const ticket = /^\d+$/u.test(rawTicket) ? Number(rawTicket) : undefined;
      claims.push({ name, pid, ...(ticket && Number.isSafeInteger(ticket) ? { ticket } : {}) });
    } catch {
      // A claim that disappeared was released before this snapshot completed.
    }
  }
  return claims;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function platformPathFor(platform: NodeJS.Platform): McodePlatformPath {
  return platform === 'win32' ? path.win32 : path.posix;
}

function quoteShell(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function escapeDoubleQuoted(value: string): string {
  return value
    .replaceAll('\\', '/')
    .replaceAll('"', '\\"')
    .replaceAll('$', '\\$')
    .replaceAll('`', '\\`');
}

function escapeBatch(value: string): string {
  return value.replaceAll('%', '%%');
}

function escapePowerShell(value: string): string {
  return value.replaceAll("'", "''");
}
