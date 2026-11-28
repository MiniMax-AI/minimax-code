/**
 * Remote default for Programmatic Tool Calling, sourced from Apollo
 * `agent_config.ptc_default`. Apollo only decides once per device: the renderer
 * matches the signed-in user here, the local runtime writes the answer into
 * `beta.ptc` and marks the device, and every later read is local. So this file
 * parses and matches, and never decides whether a value reaches a device.
 *
 * Depends only on `@mavis/shared/rollout-bucket`, for the one rollout hash every
 * Desktop rollout shares; the UI imports this file through its own package entry.
 */

import { stableRolloutHash } from '@mavis/shared/rollout-bucket';

/** Whether this device counts as a first install; `unknown` when that could not be read. */
export type PtcUserCohort = 'new' | 'existing' | 'unknown';
export type PtcSource = 'user' | 'build';

/**
 * What the runtime did with one Apollo answer, as `POST /config/ptc-remote-apply` returns it.
 * `on` / `off` are the switch values actually written, `skip` only marks the device (no hit, no
 * usable `ptc_default`, or the user already chose a switch), `done` means the device was already
 * marked, `none` means this run could not decide and the next launch looks again, and `failed`
 * means the switch or the mark did not land. The one place these are spelled: the runtime returns
 * them, the renderer validates what came back, and telemetry reports it.
 */
export const PTC_REMOTE_APPLY_VALUES = ['on', 'off', 'skip', 'done', 'none', 'failed'] as const;

export type PtcRemoteApply = (typeof PTC_REMOTE_APPLY_VALUES)[number];

/** Whether a value off the wire is an answer this build knows; anything else reads as `none`. */
export function isPtcRemoteApply(value: unknown): value is PtcRemoteApply {
  return (PTC_REMOTE_APPLY_VALUES as readonly unknown[]).includes(value);
}

/** The Apollo object after validation; invalid fields fall back to their defaults. */
export interface PtcDefaultConfig {
  /**
   * The `beta.ptc` value Apollo wants written, absent when the key is missing or is not a
   * boolean. Never read an absent `enabled` as `false`: that would write a switch value Apollo
   * never asked for, on a device Apollo has not decided for yet.
   */
  readonly enabled?: boolean;
  /** Names this rollout round; only telemetry reads it. */
  readonly version: string;
  /**
   * Share of eligible users, as an integer in [0, 100]. An absent Apollo key means everyone;
   * a key that is present but unusable is a mistake and reads as 0, so a mis-filled rollout
   * narrows the audience instead of silently widening it.
   */
  readonly rolloutPercent: number;
  /** `realUserID` allowlist, which skips the percentage. */
  readonly userIds: readonly string[];
}

/** The `Config` fields this file owns, so `config.ts` does not grow for them. */
export interface PtcConfigFields {
  /** `beta.ptc` as config.yaml writes it, absent when the user never chose; `beta.ptc` itself
   *  has the build default folded in, so it cannot tell "explicitly off" from "unset". */
  explicitPtc?: boolean;
}

/** `beta.ptc` exactly as config.yaml writes it, absent when the user never chose. */
export function parseExplicitPtc(raw: Record<string, unknown>): { explicitPtc?: boolean } {
  const configured = asRecord(raw.beta).ptc;
  return typeof configured === 'boolean' ? { explicitPtc: configured } : {};
}

const ROLLOUT_HASH_PREFIX = 'ptc_default:';

/** Whether Apollo sent an object at all, as opposed to nothing or a scalar. */
export function isPtcDefaultObject(raw: unknown): boolean {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

function asRecord(raw: unknown): Record<string, unknown> {
  return isPtcDefaultObject(raw) ? (raw as Record<string, unknown>) : {};
}

function isRolloutPercent(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 100;
}

/** The one allowlist entry shape `matchPtcDefaultUser` can ever hit: a non-empty string. */
function isUsableUserId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Absent means everyone; a present but unusable value is a mistake and reads as nobody. */
function parseRolloutPercent(value: unknown): number {
  if (value === undefined) return 100;
  return isRolloutPercent(value) ? value : 0;
}

/** Never throws, so a malformed remote value cannot get in the way of the app starting. */
export function parsePtcDefaultConfig(raw: unknown): PtcDefaultConfig {
  const record = asRecord(raw);
  return {
    ...(typeof record.enabled === 'boolean' ? { enabled: record.enabled } : {}),
    version: typeof record.version === 'string' ? record.version : '',
    rolloutPercent: parseRolloutPercent(record.rollout_percent),
    userIds: Array.isArray(record.user_ids) ? record.user_ids.filter(isUsableUserId) : [],
  };
}

/** Whether Apollo sent a `ptc_default` this build can act on at all. */
export function isPtcDefaultConfigured(raw: unknown): boolean {
  return typeof asRecord(raw).enabled === 'boolean';
}

/** One Apollo key that is present with a value the parser cannot use, and what it read instead. */
export interface PtcDefaultFieldIssue {
  /** The Apollo key, e.g. `rollout_percent`. */
  readonly field: string;
  /** What Apollo sent, already made safe to log. Never carries an allowlist entry. */
  readonly received: string;
  /** How `parsePtcDefaultConfig` read it instead. */
  readonly applied: string;
}

/** Numbers stay readable as themselves so `NaN` and `Infinity` do not print as `null`. */
export function describePtcDefaultRawValue(value: unknown): string {
  if (typeof value === 'number') return String(value);
  try {
    const text = JSON.stringify(value);
    return (text ?? String(value)).slice(0, 200);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * The shape alone, never the content. `user_ids` is the only field whose raw value can carry a user
 * ID — a mis-filled allowlist such as `"100,200"` would otherwise put real IDs into a log file the
 * user can upload — so a wrong type there is described without ever reading the value.
 */
export function describePtcDefaultValueType(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * The Apollo keys that `parsePtcDefaultConfig` had to correct, so a caller can leave evidence of a
 * mis-filled config instead of silently serving a different audience than intended. Pure, like the
 * parser: `@mavis/config` never logs. An absent key is not an issue — only a key that is present
 * with an unusable value is — except `enabled`, which every caller needs and which is reported
 * even when Apollo left it out. The allowlist is described by shape, never by its user IDs.
 */
export function describePtcDefaultFieldIssues(raw: unknown): readonly PtcDefaultFieldIssue[] {
  const record = asRecord(raw);
  // `applied` is spelled from the parser's own answer, so a changed fallback cannot leave
  // this log describing a value the runtime no longer uses.
  const parsed = parsePtcDefaultConfig(raw);
  const issues: PtcDefaultFieldIssue[] = [];
  const report = (field: string, received: string, applied: string): void => {
    if (field in record) issues.push({ field, received, applied });
  };
  if (isPtcDefaultObject(raw) && typeof record.enabled !== 'boolean') {
    // The one required key: an object without it is as unusable as one that filled it in wrongly,
    // and the runtime leaves the device undecided either way. A value that is not an object at all
    // has no field to describe, so the caller reports that shape itself.
    issues.push({
      field: 'enabled',
      received: 'enabled' in record ? describePtcDefaultRawValue(record.enabled) : 'absent',
      applied: 'enabled unusable',
    });
  }
  if (typeof record.version !== 'string') {
    report('version', describePtcDefaultRawValue(record.version), `version="${parsed.version}"`);
  }
  if (record.rollout_percent !== undefined && !isRolloutPercent(record.rollout_percent)) {
    report(
      'rollout_percent',
      describePtcDefaultRawValue(record.rollout_percent),
      `rollout_percent=${parsed.rolloutPercent}`,
    );
  }
  if (!Array.isArray(record.user_ids)) {
    // Type only: a mis-filled allowlist such as "100,200" still holds real user IDs.
    report(
      'user_ids',
      `not an array (${describePtcDefaultValueType(record.user_ids)})`,
      `user_ids=${JSON.stringify(parsed.userIds)}`,
    );
  } else {
    const kept = parsed.userIds.length;
    if (kept !== record.user_ids.length) {
      // Counts only: the entries themselves are user IDs.
      report(
        'user_ids',
        `${record.user_ids.length} entries, ${record.user_ids.length - kept} unusable`,
        `user_ids kept ${kept}`,
      );
    }
  }
  return issues;
}

/**
 * The prefix keeps these buckets independent of the desktop update rollout, which
 * hashes the bare user ID. Raising the percentage only adds users to the group.
 * The hash itself is the shared DJB2, so a user keeps their bucket across runs.
 */
export function matchPtcDefaultUser(
  config: PtcDefaultConfig,
  realUserID: string,
): { in_whitelist: boolean; in_rollout: boolean } {
  if (!realUserID) return { in_whitelist: false, in_rollout: false };
  return {
    in_whitelist: config.userIds.includes(realUserID),
    in_rollout:
      stableRolloutHash(`${ROLLOUT_HASH_PREFIX}${realUserID}`) % 100 < config.rolloutPercent,
  };
}

/** First match wins: the user's own choice, then the build default. */
export function resolvePtcToolCallMode(input: {
  readonly explicit: boolean | undefined;
  readonly buildDefault: boolean;
}): { mode: 'ptc' | 'native'; source: PtcSource } {
  if (typeof input.explicit === 'boolean') {
    return { mode: input.explicit ? 'ptc' : 'native', source: 'user' };
  }
  return { mode: input.buildDefault ? 'ptc' : 'native', source: 'build' };
}
