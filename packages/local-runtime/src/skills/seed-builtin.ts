import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
  type RmOptions,
} from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

import { logger } from '../common/logger.js';
import { combinedSeedFingerprint, fingerprintSkillDir } from './seed-fingerprint.js';

const SKILL_FILE = 'SKILL.md';
/** Runtime marker: the combined fingerprint of the last fully successful seed. */
const SEED_MARKER_FILE = '.seed-fingerprint';
/** Build-time per-skill aggregates emitted by scripts/lib/seed-fingerprints.mjs. */
const SEED_FINGERPRINTS_FILE = '.seed-fingerprints.json';
/** Per-file manifest of the superseded incremental-sync design. */
const LEGACY_MANIFEST_FILE = '.seed-manifest.json';
/** Sibling backup dir of the retired pre-manifest backup/staging mechanism. */
const LEGACY_BACKUP_DIR_SUFFIX = '.seed-backups';
/** Temp-name marker used by both superseded seeding mechanisms. */
const LEGACY_TMP_MARKER = '.tmp-seed';
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const REMOVE_OPTIONS: RmOptions = {
  recursive: true,
  force: true,
  maxRetries: 3,
  retryDelay: 50,
};

export interface SeedBuiltinSkillsDeps {
  builtinSkillsDir: string;
  sourceDirs: string[];
  /** Return false to treat a source skill as absent (excluded from seeding). */
  isSkillEnabled?: (skillName: string) => boolean;
}

/**
 * Seed bundled builtin skills into `builtinSkillsDir` at startup.
 *
 * Marker-driven full reseed: `<builtinSkillsDir>/.seed-fingerprint` holds the
 * combined fingerprint (over the per-skill aggregates of every enabled
 * skill) of the last fully successful seed. When the marker matches the
 * current combined value and every enabled skill dir exists, the whole seed
 * is skipped without a single write. On any mismatch every enabled skill dir
 * is replaced in place (other entries in the shared dir are left alone); the marker is written last, only
 * after every skill copied, so a crash or partial failure replays the whole
 * seed on the next startup (self-healing). Entries not owned by this seed
 * (another host's skills, user files) are never removed.
 *
 * Must not import registry code. Fail-open everywhere: a broken skill or an
 * unreadable source never throws out of this function.
 *
 * Only asar-compatible fs APIs are used (readdirSync/readFileSync/
 * writeFileSync/mkdirSync/rmSync/statSync/existsSync).
 * `cpSync` is NOT patched by Electron for asar transparency, so copying from
 * an asar-packed source (e.g. `app.asar/node_modules/.../assets/skills/foo`)
 * would throw `ENOTDIR`. Works on macOS, Windows, and Linux.
 */
export function seedBuiltinSkills(deps: SeedBuiltinSkillsDeps): void {
  const { builtinSkillsDir, sourceDirs, isSkillEnabled } = deps;

  cleanupLegacySeedArtifacts(builtinSkillsDir);

  // Union the skill sets of every readable source dir; candidate order is
  // priority order (e.g. the MAVIS_BUILTIN_SKILLS_DIR override is listed
  // first), so for a name present in several dirs the earliest readable
  // candidate wins. A candidate path may exist but not be a readable
  // directory (points at a file, EACCES, or a broken symlink). readdirSync
  // would throw and — because the host constructor calls this on the
  // unconditional startup path — take down local-runtime startup. Treat an
  // unreadable candidate as "absent": log and move on instead of throwing.
  let sawSourceDir = false;
  const sourceSkills = new Map<string, { src: string; buildAggregate: string | undefined }>();
  for (const candidate of sourceDirs) {
    if (!existsSync(candidate)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(candidate, { withFileTypes: true });
    } catch (err) {
      logger.error(
        { sourceDir: candidate, err: errorMessage(err) },
        'Failed to enumerate built-in skills source dir (skipping candidate, local-runtime will continue)',
      );
      continue;
    }
    sawSourceDir = true;
    const buildAggregates = loadSeedFingerprintsFile(candidate);
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (sourceSkills.has(entry.name)) continue; // earlier candidate wins
      sourceSkills.set(entry.name, {
        src: join(candidate, entry.name),
        buildAggregate: buildAggregates?.get(entry.name),
      });
    }
  }

  // Fail-open no-op when no bundled source dir resolved (packaging glitch or a
  // transient MAVIS_BUILTIN_SKILLS_DIR outage): leave dest and marker
  // untouched so we never wipe already-seeded builtin skills that a prior
  // successful run installed.
  if (!sawSourceDir) {
    logger.warn(
      { builtinSkillsDir, sourceDirs },
      'No bundled builtin skills source dir found; skipping seed to preserve existing .builtin-skills',
    );
    return;
  }

  // Resolve the enabled set and each skill's aggregate. A skill whose
  // aggregate cannot be computed is skipped this boot and withholds the
  // marker so the next startup retries the whole seed.
  const enabledSkills = new Map<string, { src: string; aggregate: string }>();
  let allOk = true;
  for (const [skillName, { src, buildAggregate }] of sourceSkills) {
    if (isSkillEnabled && !isSkillEnabled(skillName)) continue;
    if (buildAggregate !== undefined) {
      // Build-time entries are pre-vetted: generateSeedFingerprints omits
      // retired skills, so a listed entry needs no SKILL.md read here and the
      // fast path stays free of per-skill content reads.
      enabledSkills.set(skillName, { src, aggregate: buildAggregate });
      continue;
    }
    if (isSkillRuntimeRetiredFile(join(src, SKILL_FILE))) {
      logger.info({ skillName }, 'Skipped retired built-in skill');
      continue;
    }
    try {
      enabledSkills.set(skillName, { src, aggregate: fingerprintSkillDir(src).aggregate });
    } catch (err) {
      // Strict source walk: an unreadable entry fails the whole skill instead
      // of seeding a partial copy.
      allOk = false;
      logger.error(
        { skillName, err: errorMessage(err) },
        'Failed to fingerprint built-in skill source (skipped this boot, local-runtime will continue)',
      );
    }
  }

  const aggregates = new Map<string, string>();
  for (const [skillName, { aggregate }] of enabledSkills) aggregates.set(skillName, aggregate);
  const combined = combinedSeedFingerprint(aggregates);

  // Fast path: marker matches and every enabled skill dir survives — the
  // whole seed is a no-op with zero writes.
  if (readSeedMarker(builtinSkillsDir) === combined) {
    let allPresent = true;
    for (const skillName of enabledSkills.keys()) {
      if (!existsSync(join(builtinSkillsDir, skillName))) {
        allPresent = false;
        break;
      }
    }
    if (allPresent) return;
  }

  // Per-skill refresh: only dirs named after skills this seed owns are
  // replaced. The dest dir is shared with other hosts (desktop app, CLI/ACP),
  // so foreign skills and user files are never touched. Each failure (EPERM,
  // EBUSY, ...) is contained to its skill; the marker is withheld so the next
  // startup retries.
  try {
    mkdirSync(builtinSkillsDir, { recursive: true });
  } catch (err) {
    logger.error(
      { builtinSkillsDir, err: errorMessage(err) },
      'Failed to create built-in skills dir for seeding (local-runtime will continue)',
    );
    return;
  }

  for (const [skillName, { src }] of enabledSkills) {
    const dest = join(builtinSkillsDir, skillName);
    try {
      rmSync(dest, REMOVE_OPTIONS);
    } catch (err) {
      allOk = false;
      logger.error(
        { skillName, err: errorMessage(err) },
        'Failed to clear built-in skill for reseed (kept existing copy, local-runtime will continue)',
      );
      continue;
    }
    try {
      copySkillDir(src, dest, true);
    } catch (err) {
      allOk = false;
      try {
        rmSync(dest, REMOVE_OPTIONS);
      } catch {
        // A stuck partial copy is cleared by the replay on the next startup.
      }
      logger.error(
        { skillName, err: errorMessage(err) },
        'Failed to seed built-in skill (skipped this boot, local-runtime will continue)',
      );
    }
  }

  // The marker is the commit point: written only after every enabled skill
  // seeded. Withholding it (or crashing before this line) makes the next
  // startup replay the whole seed.
  if (!allOk) return;
  try {
    writeFileSync(join(builtinSkillsDir, SEED_MARKER_FILE), combined);
  } catch (err) {
    logger.error(
      { builtinSkillsDir, err: errorMessage(err) },
      'Failed to write built-in skill seed marker (seed replays next startup, local-runtime will continue)',
    );
  }
}

/**
 * Remove leftovers of the superseded seeding mechanisms: the per-file
 * `.seed-manifest.json`, the sibling `<builtinSkillsDir>.seed-backups` dir,
 * and `.tmp-seed` staging residue at the dest top level. No restoration —
 * the marker mechanism replays the whole seed anyway.
 */
function cleanupLegacySeedArtifacts(builtinSkillsDir: string): void {
  const legacyPaths: string[] = [];
  const manifestFile = join(builtinSkillsDir, LEGACY_MANIFEST_FILE);
  if (existsSync(manifestFile)) legacyPaths.push(manifestFile);
  const backupDir = `${builtinSkillsDir}${LEGACY_BACKUP_DIR_SUFFIX}`;
  if (existsSync(backupDir)) legacyPaths.push(backupDir);
  if (existsSync(builtinSkillsDir)) {
    try {
      for (const name of readdirSync(builtinSkillsDir)) {
        if (name.includes(LEGACY_TMP_MARKER)) legacyPaths.push(join(builtinSkillsDir, name));
      }
    } catch {
      // An unreadable dest dir surfaces via the seeding pass itself.
    }
  }
  for (const path of legacyPaths) {
    try {
      rmSync(path, REMOVE_OPTIONS);
    } catch (err) {
      logger.warn(
        { path, err: errorMessage(err) },
        'Failed to remove legacy built-in skill seeding artifact (local-runtime will continue)',
      );
    }
  }
}

/**
 * Load the build-time `<sourceDir>/.seed-fingerprints.json` as a
 * name → aggregate map. Returns undefined (never throws) when the file is
 * missing, unreadable, invalid JSON, or has an unexpected shape — callers
 * fall back to runtime fingerprinting. Entries are only ever used as
 * aggregate lookups keyed by real dir entry names, never as paths.
 */
function loadSeedFingerprintsFile(sourceDir: string): Map<string, string> | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(join(sourceDir, SEED_FINGERPRINTS_FILE), 'utf8'),
    );
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.skills)) {
      return undefined;
    }
    const aggregates = new Map<string, string>();
    for (const [skillName, entry] of Object.entries(parsed.skills)) {
      if (!isRecord(entry) || typeof entry.aggregate !== 'string') return undefined;
      aggregates.set(skillName, entry.aggregate);
    }
    return aggregates;
  } catch {
    return undefined;
  }
}

/** Read the seed marker; undefined when missing or unreadable (→ full seed). */
function readSeedMarker(builtinSkillsDir: string): string | undefined {
  try {
    return readFileSync(join(builtinSkillsDir, SEED_MARKER_FILE), 'utf8').trim();
  } catch {
    return undefined;
  }
}

/**
 * asar-safe recursive copy of one skill dir (see the seedBuiltinSkills doc
 * for why cpSync is off-limits). Reads the source listing before creating
 * the dest, so a broken source (dangling symlink root) fails without leaving
 * a partial dest. Empty non-root directories are skipped — the fingerprint
 * ignores them, so copying them would desync dest from the aggregate for no
 * benefit. Symlink entries are read through as files; a link to a directory
 * fails the read (EISDIR) and thereby the whole skill — the copy never
 * traverses links.
 */
function copySkillDir(src: string, dest: string, isRoot: boolean): void {
  const entries = readdirSync(src, { withFileTypes: true });
  if (!isRoot && entries.length === 0) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      copySkillDir(srcPath, destPath, false);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      const content = readFileSync(srcPath);
      if (process.platform === 'win32') {
        writeFileSync(destPath, content);
      } else {
        // writeFileSync applies `mode` on creation, restoring the POSIX
        // execute bit without chmodSync (dest was just wiped, so files are
        // always freshly created here).
        const executable = (statSync(srcPath).mode & 0o111) !== 0;
        writeFileSync(destPath, content, { mode: executable ? 0o755 : 0o644 });
      }
    }
    // Skip other entry types (sockets, block devices, etc.)
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSkillRuntimeRetiredFile(skillFilePath: string): boolean {
  try {
    const content = readFileSync(skillFilePath, 'utf8');
    const match = FRONTMATTER_RE.exec(content);
    if (!match?.[1]) return false;
    const data = yaml.load(match[1]);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    return (data as Record<string, unknown>).retired === true;
  } catch {
    return false;
  }
}
