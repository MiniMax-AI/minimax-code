import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { retryWindowsFileSystemOperation } from '@mavis/shared';
import { redactSecretText } from '@mavis/shared/logging/redact-log-secret';

import { inspectConfigText } from './comment-preserving-config-write.js';
import type { ConfigIssue, PluginsConfig } from './config.js';
import {
  CONFIG_RESET_PENDING_FILE,
  CONFIG_STATE_FILE,
  CONFIG_STATE_LOCK_FILE,
  CONFIG_STATE_LOCK_GUARD_FILE,
} from './config-state-paths.js';
import { withStateLockSync } from './config-state-lock.js';
import { PRIVATE_CONFIG_FILE_MODE, writePrivateFileAtomicSync } from './private-config-file.js';

/**
 * How getConfig() reads config.yaml and tells the user what it could not use:
 * unreadable files, YAML errors, non-mapping roots, and a file that was deleted
 * or emptied after it held the user's own settings.
 */

export interface ConfigFileRead {
  raw: Record<string, unknown>;
  issues: ConfigIssue[];
  /** Whether config.yaml existed at this read; unreadable files exist. */
  exists: boolean;
  /** sha256 of the bytes this read parsed; absent when nothing was read. */
  sha256?: string;
}

/** config.yaml as seen before getConfig() let the app create or rewrite it. */
export interface ConfigFileSnapshot {
  existed: boolean;
}

const CONFIG_ISSUE_MESSAGE_MAX_LENGTH = 300;
/**
 * Fields whose rejected value may be quoted back to the user: closed sets of
 * mode names that cannot hold a secret. Every other quoted value is masked.
 */
const SHOWN_VALUE_FIELDS = [
  'sandbox.filesystem.policy.mode',
  'sandbox.network.policy.mode',
  'sandbox.localAccess',
];
const SHOWN_VALUE_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * A config.yaml that could not be used at all also lost its plugins.forbidden
 * list, so plugins fail closed exactly as for an invalid plugins section: only
 * official plugins load until the file is fixed (its issue says failClosed).
 */
export function withWholeFileFallback<T extends { plugins: PluginsConfig }>(
  config: T,
  file: ConfigFileRead,
): T {
  return file.issues.some((issue) => issue.failClosed)
    ? { ...config, plugins: { forbidden: [], onlyOfficial: true } }
    : config;
}

/** Messages never contain YAML source text, whose lines may hold credentials. */
export function readConfigFileForResolve(configPath: string): ConfigFileRead {
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf-8');
  } catch (error) {
    const raw = (error as NodeJS.ErrnoException | undefined)?.code;
    if (raw === 'ENOENT') return { raw: {}, issues: [], exists: false };
    const code = typeof raw === 'string' && /^[A-Z0-9_]+$/.test(raw) ? raw : undefined;
    return {
      raw: {},
      exists: true,
      issues: [
        {
          kind: 'unreadable',
          ...(code ? { code } : {}),
          message: `config.yaml could not be read${code ? ` (${code})` : ''}`,
          failClosed: true,
        },
      ],
    };
  }
  const { raw, problem } = inspectConfigText(text);
  const read = { exists: true, sha256: textSha256(text) };
  if (!problem) return { raw, issues: [], ...read };
  if (problem.kind === 'invalid_root') {
    return {
      raw,
      ...read,
      issues: [
        { kind: 'invalid_root', message: 'config.yaml must be a YAML mapping', failClosed: true },
      ],
    };
  }
  const where = problem.line === undefined ? '' : ` (line ${problem.line})`;
  return {
    raw,
    ...read,
    issues: [
      {
        kind: 'invalid_yaml',
        ...(problem.line === undefined ? {} : { line: problem.line }),
        message: `config.yaml is not valid YAML${where}`,
        failClosed: true,
      },
    ],
  };
}

/**
 * One line from a section parser's error. A quoted rejected value is shown only
 * for SHOWN_VALUE_FIELDS (mode names the user needs to find the typo); every
 * other quoted value is masked, so a secret pasted into the wrong place never
 * reaches a dialog, transcript, stderr or log.
 */
export function configIssueMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let singleLine = message.replace(/\s+/g, ' ').trim() || 'Invalid configuration';
  singleLine = singleLine.replace(/"([^"]*)"/g, (match, value: string, offset: number) => {
    const before = singleLine.slice(0, offset).trimEnd();
    const shown =
      SHOWN_VALUE_FIELDS.some((field) => before.endsWith(field)) && SHOWN_VALUE_PATTERN.test(value);
    return shown ? match : '"…"';
  });
  // Unquoted credentials (api_key=…, Bearer …, sk-…) use the shared vocabulary.
  singleLine = redactSecretText(singleLine);
  return singleLine.length > CONFIG_ISSUE_MESSAGE_MAX_LENGTH
    ? `${singleLine.slice(0, CONFIG_ISSUE_MESSAGE_MAX_LENGTH - 1)}…`
    : singleLine;
}

// ── Deleted or emptied config.yaml ─────────────────────────────────────────
//
// A missing or empty config.yaml is also what a fresh install looks like, so the
// file alone cannot say whether settings were lost. The state file records the
// sha256 of what the app itself generated (first-install defaults, defaults
// written after a deletion, and the app's own rewrites of those), and whether
// config.yaml ever held anything else: the user's settings. Only losing those
// is reported. A deletion stays pending in its own file until an interactive
// host has shown it, because the first reader may be a process without a UI,
// and a separate file keeps a stale state write from bringing it back.

const MISSING_CONFIG_ISSUE: ConfigIssue = {
  kind: 'missing',
  message: 'config.yaml was deleted; all settings use defaults',
};
const EMPTY_CONFIG_ISSUE: ConfigIssue = {
  kind: 'empty',
  message: 'config.yaml is empty; all settings use defaults',
};

interface ConfigFileState {
  /** sha256 of the config.yaml the app last generated itself. */
  generatedSha256?: string;
  /** config.yaml held content the app did not generate. */
  hadUserSettings?: boolean;
  /** sha256 of the user's config.yaml as last seen; putting it back resolves a deletion. */
  lastUserSha256?: string;
  /** An emptied file has been shown; it stays quiet until the user adds settings again. */
  emptyAcknowledged?: boolean;
  /** Token of the pending deletion an interactive host acknowledged. */
  acknowledgedReset?: string;
}

/** What getConfig()'s own preparation did to config.yaml, reported by the writer itself. */
export interface ConfigFileWrite {
  /** Wrote first-install defaults: the sha256 of the bytes it wrote. */
  generatedSha256?: string;
  /** Copied an existing config from the default data dir (derived profile, worktree). */
  copied?: boolean;
  /** Rewrote the existing file while preparing it (migrations, preset sync). */
  rewrite?: { fromSha256?: string; toSha256?: string };
  /**
   * The existing file is exactly the defaults the app generates (e.g. from an
   * older install): the sha256 of the bytes it compared.
   */
  matchesDefaultsSha256?: string;
}

function siblingPath(configPath: string, name: string): string {
  return path.join(path.dirname(configPath), name);
}

/** The digest every lifecycle comparison uses: of the UTF-8 text the parser sees. */
export function textSha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Whether a parsed config.yaml holds nothing but app defaults: every key it has
 * equals that key in one of `defaults`. Any build or region counts, and so does
 * an older version that wrote fewer keys; losing such a file loses no setting
 * the user chose.
 */
export function holdsOnlyDefaults(
  document: Record<string, unknown>,
  defaults: readonly Record<string, unknown>[],
): boolean {
  const keys = Object.keys(document);
  return (
    keys.length > 0 &&
    defaults.some((candidate) =>
      keys.every((key) => key in candidate && isDeepStrictEqual(document[key], candidate[key])),
    )
  );
}

/** One read, so a digest a writer reports is of exactly the text it went on to compare. */
export function readConfigTextWithSha256(filePath: string): { text?: string; sha256?: string } {
  try {
    const text = fs.readFileSync(filePath, 'utf-8');
    return { text, sha256: textSha256(text) };
  } catch {
    return {};
  }
}

export function fileSha256(filePath: string): string | undefined {
  return readConfigTextWithSha256(filePath).sha256;
}

export function snapshotConfigFile(configPath: string): ConfigFileSnapshot {
  return { existed: fs.existsSync(configPath) };
}

function readConfigFileState(configPath: string): ConfigFileState {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(siblingPath(configPath, CONFIG_STATE_FILE), 'utf-8'),
    );
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const {
      generatedSha256,
      hadUserSettings,
      lastUserSha256,
      emptyAcknowledged,
      acknowledgedReset,
    } = parsed as Record<string, unknown>;
    return {
      ...(typeof generatedSha256 === 'string' ? { generatedSha256 } : {}),
      ...(typeof hadUserSettings === 'boolean' ? { hadUserSettings } : {}),
      ...(typeof lastUserSha256 === 'string' ? { lastUserSha256 } : {}),
      ...(typeof emptyAcknowledged === 'boolean' ? { emptyAcknowledged } : {}),
      ...(typeof acknowledgedReset === 'string' ? { acknowledgedReset } : {}),
    };
  } catch {
    return {};
  }
}

/** Runs `update` under the state lock; false when the lock stayed busy or failed. */
function withConfigStateLock(
  configPath: string,
  update: (lock: { stillHeld(): boolean }) => void,
): boolean {
  try {
    return withStateLockSync(
      {
        lockPath: siblingPath(configPath, CONFIG_STATE_LOCK_FILE),
        guardPath: siblingPath(configPath, CONFIG_STATE_LOCK_GUARD_FILE),
      },
      update,
    );
  } catch {
    // Advisory only: losing the marker can only cost a notice, never a start.
    return false;
  }
}

/**
 * Merges `patch` into the state file under the state lock, so another
 * process's fields written meanwhile are kept; `afterWrite` runs in the same
 * locked step. A busy lock skips the write instead of overwriting another
 * process's fields; the state is derived again on the next read.
 */
function mergeConfigFileState(
  configPath: string,
  patch: ConfigFileState,
  afterWrite?: () => void,
  /** Checked under the lock; false drops the write (still counts as done). */
  stillApplies?: () => boolean,
): boolean {
  let written = false;
  withConfigStateLock(configPath, (lock) => {
    if (stillApplies && !stillApplies()) {
      written = true;
      return;
    }
    const next = { ...readConfigFileState(configPath), ...patch };
    // Suspended long enough to be reclaimed: the new holder owns the file.
    if (!lock.stillHeld()) return;
    writePrivateFileAtomicSync(
      siblingPath(configPath, CONFIG_STATE_FILE),
      `${JSON.stringify(next)}\n`,
      retryWindowsFileSystemOperation,
    );
    written = true;
    afterWrite?.();
  });
  return written;
}

/**
 * The pending deletion's token, '' when it cannot be read, undefined when none
 * is pending. The token ties an acknowledgement to this one deletion, so a
 * marker left behind after its acknowledgement was recorded is recognized.
 */
function resetPendingToken(configPath: string): string | undefined {
  const marker = siblingPath(configPath, CONFIG_RESET_PENDING_FILE);
  // Existence alone decides pending, as before tokens existed.
  if (!fs.existsSync(marker)) return undefined;
  try {
    return fs.readFileSync(marker, 'utf-8').trim();
  } catch {
    return '';
  }
}

/**
 * Marks a deletion of the user's settings, judged on the state as it is now:
 * the caller's copy may predate an acknowledgement another process recorded,
 * and marking from it would bring that notice back. Checked under the lock
 * that acknowledgements also hold; without the lock, on a fresh read.
 */
function markResetPendingIfStillLost(configPath: string): void {
  const mark = () => {
    if (readConfigFileState(configPath).hadUserSettings) markResetPending(configPath);
  };
  if (withConfigStateLock(configPath, mark)) return;
  // Without the lock an acknowledgement may land between that read and the
  // write: check again afterwards and take back only the marker written here.
  const token = readConfigFileState(configPath).hadUserSettings
    ? markResetPending(configPath)
    : undefined;
  if (token && !readConfigFileState(configPath).hadUserSettings) {
    if (resetPendingToken(configPath) === token) clearResetPending(configPath);
  }
}

/** Creates the marker; returns its token when this call created it. */
function markResetPending(configPath: string): string | undefined {
  const token = randomUUID();
  try {
    fs.writeFileSync(siblingPath(configPath, CONFIG_RESET_PENDING_FILE), `${token}\n`, {
      flag: 'wx',
      mode: PRIVATE_CONFIG_FILE_MODE,
    });
    return token;
  } catch {
    // Already pending, or not writable: either way nothing more to record.
    return undefined;
  }
}

function clearResetPending(configPath: string): void {
  try {
    retryWindowsFileSystemOperation(() =>
      fs.rmSync(siblingPath(configPath, CONFIG_RESET_PENDING_FILE), { force: true }),
    );
  } catch {
    // Advisory only.
  }
}

/**
 * Issues about config.yaml's own lifecycle; also keeps the state files current.
 * `before` is the file as seen before getConfig() prepared it, `write` what that
 * preparation did, as reported by the writer, never inferred from hashes.
 */
export function trackConfigFileLifecycle(
  configPath: string,
  before: ConfigFileSnapshot,
  write: ConfigFileWrite,
  file: ConfigFileRead,
): ConfigIssue[] {
  // An acknowledgement the state lock turned away earlier is recorded first.
  const unrecorded = unrecordedAcknowledgements.get(configPath);
  if (unrecorded) recordAcknowledgement(configPath, unrecorded);
  const state = readConfigFileState(configPath);
  // The parsed bytes, not a later re-read that another writer may have changed.
  const afterSha256 = file.sha256;
  const patch: ConfigFileState = {};

  // Only the bytes the writer itself produced or compared count as generated:
  // another process may replace the file between that write and this read.
  const appSha256 = write.generatedSha256 ?? write.matchesDefaultsSha256;
  if (appSha256 !== undefined && afterSha256 === appSha256) patch.generatedSha256 = afterSha256;
  else if (
    write.rewrite?.toSha256 &&
    write.rewrite.fromSha256 !== undefined &&
    write.rewrite.fromSha256 === state.generatedSha256
  ) {
    // The app's own migration of a file it generated is still generated.
    patch.generatedSha256 = write.rewrite.toSha256;
  }
  const generatedSha256 = patch.generatedSha256 ?? state.generatedSha256;
  // Existence is not readability: an unreadable file (EACCES, a directory) is
  // reported as unreadable, never as deleted.
  const exists = file.exists;
  const readable = file.issues.length === 0;
  const empty = exists && readable && Object.keys(file.raw).length === 0;
  // Anything the app did not generate is the user's, including a copied config
  // and an unparsable file (its YAML problem is reported on its own).
  const userContent =
    afterSha256 !== undefined &&
    !empty &&
    (write.copied === true || afterSha256 !== generatedSha256);

  // Gone when this read began, or deleted while it ran. A config copied in to
  // replace it does not undo the loss: the copy only decides whether the file
  // now in use is the user's.
  const deleted = !before.existed || !exists;
  if (deleted && state.hadUserSettings) markResetPendingIfStillLost(configPath);
  const pendingToken = resetPendingToken(configPath);
  let pending = pendingToken !== undefined;
  const acknowledged = pendingToken !== '' && pendingToken === state.acknowledgedReset;
  // The user put the same config.yaml back, or a host acknowledged this
  // deletion but did not get to remove its marker: nothing left to report.
  if (pending && (acknowledged || (userContent && afterSha256 === state.lastUserSha256))) {
    clearResetPending(configPath);
    pending = false;
  }

  const issues: ConfigIssue[] = [];
  // Shown in this process but not yet recorded: do not show it again, unless
  // a new deletion replaced the one that was shown.
  const unrecordedNow = unrecordedAcknowledgements.get(configPath);
  const shownHere =
    unrecordedNow !== undefined &&
    (unrecordedNow.token === undefined || unrecordedNow.token === pendingToken);
  if (!shownHere && empty && state.hadUserSettings && !state.emptyAcknowledged) {
    issues.push(EMPTY_CONFIG_ISSUE);
  }
  // A file written after the deletion may be in use: say so instead of claiming
  // that every setting fell back to its default.
  else if (!shownHere && pending)
    issues.push(userContent ? { ...MISSING_CONFIG_ISSUE, fileInUse: true } : MISSING_CONFIG_ISSUE);

  if (userContent) {
    if (!state.hadUserSettings) patch.hadUserSettings = true;
    if (state.lastUserSha256 !== afterSha256) patch.lastUserSha256 = afterSha256;
    if (state.emptyAcknowledged) patch.emptyAcknowledged = false;
  }
  if (Object.keys(patch).length > 0) mergeConfigFileState(configPath, patch);
  return issues;
}

/**
 * An interactive host showed these lost-settings issues. A deletion then counts
 * as a fresh start, so settings the user adds later are tracked again. An empty
 * file stays quiet until the user adds settings again; deleting it afterwards is
 * still reported.
 */
export function acknowledgeConfigResetAt(
  configPath: string,
  shown: { missing?: boolean; empty?: boolean },
): void {
  if (shown.missing) {
    recordAcknowledgement(configPath, {
      patch: { hadUserSettings: false, lastUserSha256: undefined },
      // The deletion that was shown; a later one must not be acknowledged with it.
      token: resetPendingToken(configPath) || undefined,
    });
  } else if (shown.empty) {
    recordAcknowledgement(configPath, { patch: { emptyAcknowledged: true } });
  }
}

interface Acknowledgement {
  patch: ConfigFileState;
  /** Token of the deletion marker that was shown (`missing` only). */
  token?: string;
}

/**
 * Acknowledgements the busy state lock turned away, retried on the next read
 * of the same config.yaml in this process; until then that read reports no
 * lost settings, which this process has already shown.
 */
const unrecordedAcknowledgements = new Map<string, Acknowledgement>();

function recordAcknowledgement(configPath: string, acknowledgement: Acknowledgement): void {
  const { patch, token } = acknowledgement;
  // State first: a pending deletion cleared before its state was recorded
  // would leave hadUserSettings set and report the next deletion of defaults.
  // The state names the deletion, so a marker the removal below misses (a kill,
  // a Windows sharing violation) is recognized as acknowledged on the next read.
  const recorded = mergeConfigFileState(
    configPath,
    token ? { ...patch, acknowledgedReset: token } : patch,
    () => clearResetPending(configPath),
    // A deletion acknowledged later than shown applies only while its marker is
    // still the one shown: once the user restored the file or deleted it again,
    // recording it would hide a deletion nobody saw.
    () => token === undefined || resetPendingToken(configPath) === token,
  );
  if (recorded) unrecordedAcknowledgements.delete(configPath);
  else unrecordedAcknowledgements.set(configPath, acknowledgement);
}

type ConfigIssueReporter = (issues: readonly ConfigIssue[]) => void;
let configIssueReporter: ConfigIssueReporter | undefined;
let lastReportedConfigIssues = '';

/**
 * Lets a process without a UI (the utility runtime) log config.yaml problems.
 * Called once per distinct set of problems; never called with none.
 */
export function setConfigIssueReporter(reporter: ConfigIssueReporter | undefined): void {
  configIssueReporter = reporter;
  lastReportedConfigIssues = '';
}

/**
 * Identifies a set of issues for "already told the user" checks. Every field
 * takes part (`fileInUse` and `code` change what the user is told), with
 * keys in a fixed order so equal issues always give the same key.
 */
export function configIssuesFingerprint(issues: readonly ConfigIssue[]): string {
  return JSON.stringify(
    issues.map((issue) =>
      Object.entries(issue)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    ),
  );
}

export function reportConfigIssues(issues: readonly ConfigIssue[]): void {
  if (!configIssueReporter || issues.length === 0) return;
  const key = configIssuesFingerprint(issues);
  if (key === lastReportedConfigIssues) return;
  lastReportedConfigIssues = key;
  try {
    configIssueReporter(issues);
  } catch {
    // A failing logger must not affect config loading.
  }
}
