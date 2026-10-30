import fs from 'node:fs';

import yaml from 'js-yaml';

import { getConfigPath } from './config.js';

/**
 * The `conversation` section of config.yaml: what a user stop of a main
 * conversation (desktop Stop button, phone remote control, IM `/stop`, TUI Esc)
 * also stops.
 *
 * ```yaml
 * conversation:
 *   stopSubAgent: false   # also stop the background subagents it started
 *   stopAsyncBash: true   # also stop the background bash it started
 * ```
 *
 * Deliberately not part of `Config` / `getConfig()`. There is no GUI for these
 * switches, so they stay out of `GET /config` and the config write whitelist,
 * and the default config template does not write them: a later change of the
 * defaults still reaches existing installs. Stop paths read them through
 * {@link readConversationStopConfig} on every stop instead, because
 * `getConfig()` caches per process and only resets when this process writes the
 * config; a hand edit, or a write by the other client process (desktop vs TUI),
 * would otherwise go unnoticed.
 */
export interface ConversationStopConfig {
  /**
   * Also stop the background subagents the stopped conversation started
   * (including `task_append` continuations), together with everything in their
   * child Sessions.
   */
  readonly stopSubAgent: boolean;
  /** Also stop the background bash the stopped conversation itself started. */
  readonly stopAsyncBash: boolean;
}

export const CONVERSATION_STOP_CONFIG_DEFAULTS: Readonly<ConversationStopConfig> = Object.freeze({
  stopSubAgent: false,
  stopAsyncBash: true,
});

/**
 * Where a value came from: an explicit YAML boolean; the default (no config
 * file, no `conversation` section, key missing or not a boolean); or the
 * default because the file could not be read or parsed.
 */
export type ConversationStopValueSource = 'explicit' | 'default' | 'read_failed';

/** Why a read failed. Fixed codes only, see `ConversationStopConfigRead.failure`. */
export type ConversationStopReadFailure =
  | 'path_error'
  | 'read_error'
  | 'yaml_error'
  | 'not_a_mapping';

type ConversationStopKey = keyof ConversationStopConfig;

export interface ConversationStopConfigRead extends ConversationStopConfig {
  readonly policySource: Readonly<Record<ConversationStopKey, ConversationStopValueSource>>;
  /**
   * Keys present under `conversation` whose value is not a YAML boolean (for
   * example `"true"`, `yes` or `1`). They keep the default; listing them is what
   * lets a user tell "I set it" apart from "it took effect".
   */
  readonly ignoredKeys?: readonly ConversationStopKey[];
  /**
   * Set only when the file could not be read or parsed. Never carries parser or
   * system error text: YAML errors quote the offending source lines, and a
   * config file can hold credentials.
   */
  readonly failure?: {
    readonly reason: ConversationStopReadFailure;
    /** errno code, e.g. `EACCES` or `EISDIR`. */
    readonly errorCode?: string;
    /** 1-based line of a YAML syntax error; never the line's content. */
    readonly line?: number;
  };
  /** The file that was read, when its path could be resolved. */
  readonly configPath?: string;
}

const STOP_KEYS: readonly ConversationStopKey[] = ['stopSubAgent', 'stopAsyncBash'];

/**
 * Parses the stop switches from an already parsed config document. A missing
 * `conversation` section, a section that is not a mapping, a missing key and a
 * key that is not a YAML boolean all mean "use the default".
 */
export function parseConversationStopConfig(
  raw: Record<string, unknown>,
): ConversationStopConfigRead {
  const section = isPlainRecord(raw.conversation) ? raw.conversation : {};
  const values: Record<ConversationStopKey, boolean> = { ...CONVERSATION_STOP_CONFIG_DEFAULTS };
  const policySource: Record<ConversationStopKey, ConversationStopValueSource> = {
    stopSubAgent: 'default',
    stopAsyncBash: 'default',
  };
  const ignoredKeys: ConversationStopKey[] = [];
  for (const key of STOP_KEYS) {
    const value = section[key];
    if (typeof value === 'boolean') {
      values[key] = value;
      policySource[key] = 'explicit';
    } else if (value !== undefined) {
      ignoredKeys.push(key);
    }
  }
  return { ...values, policySource, ...(ignoredKeys.length > 0 ? { ignoredKeys } : {}) };
}

/**
 * Reads the stop switches from config.yaml, afresh on every call. Never throws,
 * never caches and never writes: unlike `getConfig()` or `loadConfigFromFile()`
 * it does not chmod the file, migrate BYOK providers or sync managed presets.
 * Every failure falls back to the defaults and is described in `failure`.
 *
 * Synchronous on purpose. Callers read it inside a stop request, and a small
 * local file reads and parses well under a millisecond; the TUI also relies on
 * it to decide, before it aborts the root Run, whether to stop delegated agents,
 * in the same order as before. Writers replace the file atomically (write, then
 * rename), so no lock is needed: a read sees either the old or the new file.
 *
 * `configPath` defaults to `getConfigPath()`: the data directory of this
 * process, which the local runtime host pins to its own data directory when it
 * starts, so a stop always reads the file its runtime uses.
 */
export function readConversationStopConfig(configPath?: string): ConversationStopConfigRead {
  let path: string;
  try {
    path = configPath ?? getConfigPath();
  } catch {
    return readFailed({ reason: 'path_error' });
  }
  let text: string;
  try {
    text = fs.readFileSync(path, 'utf8');
  } catch (error) {
    const errorCode = errnoCode(error);
    // No config file at all is an ordinary install, not a failure.
    if (errorCode === 'ENOENT') return { ...parseConversationStopConfig({}), configPath: path };
    return readFailed({ reason: 'read_error', ...(errorCode ? { errorCode } : {}) }, path);
  }
  let parsed: unknown;
  try {
    parsed = yaml.load(text);
  } catch (error) {
    const line = yamlErrorLine(error);
    return readFailed({ reason: 'yaml_error', ...(line ? { line } : {}) }, path);
  }
  if (parsed == null) return { ...parseConversationStopConfig({}), configPath: path };
  if (!isPlainRecord(parsed)) return readFailed({ reason: 'not_a_mapping' }, path);
  return { ...parseConversationStopConfig(parsed), configPath: path };
}

function readFailed(
  failure: NonNullable<ConversationStopConfigRead['failure']>,
  configPath?: string,
): ConversationStopConfigRead {
  return {
    ...CONVERSATION_STOP_CONFIG_DEFAULTS,
    policySource: { stopSubAgent: 'read_failed', stopAsyncBash: 'read_failed' },
    failure,
    ...(configPath ? { configPath } : {}),
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function errnoCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** js-yaml reports a 0-based `mark.line`; only the number leaves this module. */
function yamlErrorLine(error: unknown): number | undefined {
  const line = (error as { mark?: { line?: unknown } } | null | undefined)?.mark?.line;
  return typeof line === 'number' && Number.isInteger(line) && line >= 0 ? line + 1 : undefined;
}
