import { constants as fsConstants } from 'node:fs';
import { lstat, open, readlink, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { TextDecoder } from 'node:util';

import { isDefaultAgentAvatarMarker } from '@mavis/shared/agent-avatar';
import yaml from 'yaml';

import { logger } from '../../../infra/logging/index.js';
// Leaf import on purpose: the ModelSystem barrel pulls in provider/OAuth
// runtimes, and this parser is loaded by lightweight config consumers.
import { parseSourceQualifiedModelKey } from '../../model-system/resolution/model-key.js';

/**
 * User-owned Custom Agent configuration. This module deliberately contains
 * no database access: a canonical file is the only source of Custom Agent
 * behaviour once it exists.
 */
export interface CanonicalAgentConfig {
  readonly name: string;
  readonly description: string;
  readonly model?: string;
  readonly effort?: string;
  /** `undefined` inherits the runtime inventory; [] explicitly disables it. */
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly mcpServers?: readonly string[];
  readonly skills?: readonly string[];
  readonly xMavis?: CanonicalAgentMavisConfig;
  readonly systemPrompt: string;
  /** Unknown keys are retained in the file and only surfaced as diagnostics. */
  readonly diagnostics: readonly AgentConfigDiagnostic[];
}

/** Runtime-owned policy written only into the rebuilt `.builtin` mirror. */
interface BuiltinAgentFeaturePolicy {
  readonly mavis: boolean;
  readonly delegation: boolean;
  readonly webSearch: boolean;
}

/** A parsed `.builtin` file keeps its managed policy outside Custom config. */
export interface BuiltinCanonicalAgentConfig {
  readonly config: CanonicalAgentConfig;
  /** Omitted only for a valid pre-policy Builtin file during an upgrade. */
  readonly features?: BuiltinAgentFeaturePolicy;
}

export type BuiltinCanonicalAgentConfigForWrite = Omit<CanonicalAgentConfig, 'diagnostics'> & {
  readonly features: BuiltinAgentFeaturePolicy;
};

export interface CanonicalAgentMavisConfig {
  readonly displayName?: string;
  readonly avatar?: string;
  readonly contextWindow?: number;
  readonly maxOutputTokens?: number;
  readonly defaultWorkspaceDir?: string;
  readonly extensionSkills?: readonly string[];
}

interface AgentConfigDiagnostic {
  readonly code: 'agent_name_mismatch' | 'unsupported_agent_field' | 'model_limit_clamped';
  readonly field: string;
}

export class AgentConfigError extends Error {
  constructor(
    readonly code:
      | 'AGENT_CONFIG_NOT_FOUND'
      | 'AGENT_CONFIG_INVALID'
      | 'AGENT_CONFIG_UNSTABLE'
      | 'AGENT_CONFIG_AVATAR_INVALID',
    readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'AgentConfigError';
  }
}

const MAX_AGENT_FILE_BYTES = 1024 * 1024;
const AGENT_AVATAR_MAX_BYTES = 10 * 1024 * 1024;
const MAX_YAML_ALIASES = 32;
const MAX_YAML_DEPTH = 16;
const STABLE_READ_ATTEMPTS = 3;
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const DATA_IMAGE_TYPES: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};
const MAX_DATA_IMAGE_BASE64_LENGTH = 4 * Math.ceil(AGENT_AVATAR_MAX_BYTES / 3);
const DATA_DIR_SOURCE_ENV = '__MAVIS_RUNTIME_DATA_DIR_SOURCE';
const KNOWN_DATA_DIR_SOURCES = new Set([
  'default',
  'profile',
  'desktop_custom',
  'minimax_env',
  'mavis_env',
  'legacy_runtime_env',
  'test_isolation',
]);
const KNOWN_FIELDS = new Set([
  'name',
  'description',
  'model',
  'effort',
  'tools',
  'disallowedTools',
  'mcpServers',
  'skills',
  'x-mavis',
]);
const BUILTIN_KNOWN_FIELDS = new Set([...KNOWN_FIELDS, 'features']);
const BUILTIN_FEATURE_FIELDS = new Set(['mavis', 'delegation', 'webSearch']);
const KNOWN_MAVIS_FIELDS = new Set([
  'displayName',
  'avatar',
  'contextWindow',
  'maxOutputTokens',
  'defaultWorkspaceDir',
  'extensionSkills',
]);
const LEGACY_DESCRIPTION_NON_PLAIN_PREFIXES = '"\'[]{}&,*!|>@`#';
const loggedAgentDirectoryLinks = new Set<string>();

/** Read an editable agent.md without accepting a half-written or linked file. */
export async function readCanonicalAgentConfig(input: {
  readonly agentDir: string;
  readonly routeName: string;
  readonly fileName?: string;
  /** Desktop dataDir boundary for the logical Agent-directory path. */
  readonly trustedRoot?: string;
}): Promise<CanonicalAgentConfig> {
  const contents = await readStableAgentMarkdown(input);
  const parsed = parseCanonicalAgentMarkdown(contents, input.routeName);
  if (parsed.xMavis?.avatar) {
    await validateAgentAvatar(input.agentDir, parsed.xMavis.avatar, input.trustedRoot);
  }
  return parsed;
}

/** Reads the managed `.builtin` mirror without extending the Custom-Agent codec. */
export async function readBuiltinCanonicalAgentConfig(input: {
  readonly agentDir: string;
  readonly routeName: string;
  readonly fileName?: string;
  /** Desktop dataDir boundary used to reject linked ancestors. */
  readonly trustedRoot?: string;
}): Promise<BuiltinCanonicalAgentConfig> {
  const contents = await readStableAgentMarkdown(input);
  const parsed = parseBuiltinCanonicalAgentMarkdown(contents, input.routeName);
  if (parsed.config.xMavis?.avatar) {
    await validateAgentAvatar(input.agentDir, parsed.config.xMavis.avatar, input.trustedRoot);
  }
  return parsed;
}

/** Reads the same safe/stable agent.md bytes without interpreting frontmatter. */
export async function readStableAgentMarkdown(input: {
  readonly agentDir: string;
  readonly routeName: string;
  readonly fileName?: string;
  /** Desktop dataDir boundary for the logical Agent-directory path. */
  readonly trustedRoot?: string;
}): Promise<string> {
  const fileName = input.fileName ?? 'agent.md';
  const filePath = resolve(input.agentDir, fileName);
  if (!isWithinDirectory(input.agentDir, filePath)) {
    throw new AgentConfigError(
      'AGENT_CONFIG_INVALID',
      'file',
      'Agent config path escapes its directory.',
    );
  }
  let lastChanged = false;
  for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
    await assertSafeAgentDirectory(input.agentDir, input.trustedRoot);
    const snapshot = await readStableRegularFile(filePath);
    if (snapshot === 'changed') {
      lastChanged = true;
      continue;
    }
    await assertSafeAgentDirectory(input.agentDir, input.trustedRoot);
    return snapshot.contents;
  }
  throw new AgentConfigError(
    lastChanged ? 'AGENT_CONFIG_UNSTABLE' : 'AGENT_CONFIG_INVALID',
    'agent.md',
    'Agent configuration changed while it was being read.',
  );
}

/** Parse an already stable agent.md payload. Exported for narrow unit tests. */
export function parseCanonicalAgentMarkdown(raw: string, routeName: string): CanonicalAgentConfig {
  const source = parseCanonicalAgentMarkdownSource(raw);
  return canonicalConfigFromSource(source.frontmatter, routeName, source.body);
}

/**
 * Decodes the complete editable YAML structure and Markdown body without
 * projecting away unknown fields. Storage uses this narrow raw-document view
 * when a Builtin Config PUT may change only its model selection.
 */
export function parseCanonicalAgentMarkdownSource(raw: string): {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
} {
  const split = splitFrontmatter(raw);
  return {
    frontmatter: parseFrontmatterSource(split.frontmatter),
    body: split.body,
  };
}

/**
 * Parses the runtime-owned `.builtin` mirror. The generic Custom Agent parser
 * deliberately still reports `features` as unsupported.
 */
export function parseBuiltinCanonicalAgentMarkdown(
  raw: string,
  routeName: string,
  options: { readonly requireFeaturePolicy?: boolean } = {},
): BuiltinCanonicalAgentConfig {
  const source = parseCanonicalAgentMarkdownSource(raw);
  const features = options.requireFeaturePolicy
    ? requiredBuiltinFeaturePolicy(source.frontmatter)
    : optionalBuiltinFeaturePolicy(source.frontmatter);
  const config = canonicalConfigFromSource(
    source.frontmatter,
    routeName,
    source.body,
    BUILTIN_KNOWN_FIELDS,
  );
  return { config, ...(features ? { features } : {}) };
}

function parseFrontmatterSource(frontmatter: string): Record<string, unknown> {
  const document = parseFrontmatterDocument(frontmatter);
  if (document) return decodeFrontmatterDocument(document);

  const legacyDescription = quoteLegacyDescriptionPlainScalar(frontmatter);
  if (!legacyDescription) {
    throw invalid('frontmatter', 'Agent frontmatter is not valid YAML.');
  }
  const repairedDocument = parseFrontmatterDocument(legacyDescription);
  if (!repairedDocument) {
    throw invalid('frontmatter', 'Agent frontmatter is not valid YAML.');
  }
  return decodeFrontmatterDocument(repairedDocument);
}

function parseFrontmatterDocument(
  frontmatter: string,
): ReturnType<typeof yaml.parseDocument> | undefined {
  let document: ReturnType<typeof yaml.parseDocument>;
  try {
    document = yaml.parseDocument(frontmatter, {
      prettyErrors: false,
      uniqueKeys: true,
    });
  } catch {
    return undefined;
  }
  return document.errors.length === 0 ? document : undefined;
}

function decodeFrontmatterDocument(
  document: ReturnType<typeof yaml.parseDocument>,
): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = document.toJS({ maxAliasCount: MAX_YAML_ALIASES });
  } catch {
    throw invalid('frontmatter', 'Agent frontmatter exceeds the YAML alias limit.');
  }
  assertYamlDepth(decoded);
  const source = asPlainObject(decoded);
  if (!source) throw invalid('frontmatter', 'Agent frontmatter must be a mapping.');
  return source;
}

/**
 * Accept one historical spelling only: a top-level, one-line plain
 * `description` scalar containing `: `. The repaired YAML is parse-only; the
 * user-owned agent.md remains byte-for-byte untouched.
 */
function quoteLegacyDescriptionPlainScalar(frontmatter: string): string | undefined {
  const lines = frontmatter.replace(/\r\n/gu, '\n').split('\n');
  const descriptionLines = lines.flatMap((line, index) =>
    line.startsWith('description:') ? [index] : [],
  );
  if (descriptionLines.length !== 1) return undefined;
  const index = descriptionLines[0] as number;
  const line = lines[index] as string;
  const match = /^description:[ \t]+(.+)$/u.exec(line);
  const value = match?.[1];
  if (!isLegacyDescriptionPlainScalar(value, lines[index + 1])) return undefined;
  lines[index] = `description: ${JSON.stringify(value)}`;
  return lines.join('\n');
}

function isLegacyDescriptionPlainScalar(
  value: string | undefined,
  nextLine: string | undefined,
): value is string {
  if (!value || value.trim() !== value || !value.includes(': ')) return false;
  return (
    !LEGACY_DESCRIPTION_NON_PLAIN_PREFIXES.includes(value[0] as string) &&
    !/^[?:-](?:[ \t]|$)/u.test(value) &&
    !/[ \t]#/u.test(value) &&
    !/^[ \t]/u.test(nextLine ?? '')
  );
}

function canonicalConfigFromSource(
  source: Record<string, unknown>,
  routeName: string,
  systemPrompt: string,
  knownFields: ReadonlySet<string> = KNOWN_FIELDS,
): CanonicalAgentConfig {
  const name = requiredText(source, 'name');
  const description = requiredText(source, 'description');
  const model = optionalModel(source);
  const effort = optionalText(source, 'effort');
  const tools = optionalTextArray(source, 'tools');
  const disallowedTools = optionalTextArray(source, 'disallowedTools');
  const mcpServers = optionalTextArray(source, 'mcpServers');
  const skills = optionalTextArray(source, 'skills');
  const xMavis = parseMavis(source['x-mavis']);
  return {
    name,
    description,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(tools === undefined ? {} : { tools }),
    ...(disallowedTools === undefined ? {} : { disallowedTools }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(skills === undefined ? {} : { skills }),
    ...(xMavis ? { xMavis } : {}),
    systemPrompt,
    diagnostics: diagnosticsForSource(source, name, routeName, knownFields),
  };
}

function diagnosticsForSource(
  source: Record<string, unknown>,
  name: string,
  routeName: string,
  knownFields: ReadonlySet<string> = KNOWN_FIELDS,
): readonly AgentConfigDiagnostic[] {
  const diagnostics: AgentConfigDiagnostic[] = [];
  if (name !== routeName) diagnostics.push({ code: 'agent_name_mismatch', field: 'name' });
  diagnostics.push(...unsupportedFieldDiagnostics(source, knownFields));
  const mavisSource = asPlainObject(source['x-mavis']);
  if (mavisSource) {
    diagnostics.push(...unsupportedFieldDiagnostics(mavisSource, KNOWN_MAVIS_FIELDS, 'x-mavis.'));
  }
  return Object.freeze(diagnostics);
}

function unsupportedFieldDiagnostics(
  source: Record<string, unknown>,
  knownFields: ReadonlySet<string>,
  prefix = '',
): AgentConfigDiagnostic[] {
  return Object.keys(source)
    .filter((field) => !knownFields.has(field))
    .map((field) => ({ code: 'unsupported_agent_field', field: `${prefix}${field}` }));
}

/** A deterministic writer used only for Custom create/materialization. */
export function serializeCanonicalAgentConfig(input: {
  readonly config: Omit<CanonicalAgentConfig, 'diagnostics'>;
}): string {
  return serializeAgentConfig(input.config);
}

/** Writes the managed `.builtin` mirror without extending Custom Agent files. */
export function serializeBuiltinCanonicalAgentConfig(input: {
  readonly config: BuiltinCanonicalAgentConfigForWrite;
}): string {
  return serializeAgentConfig(
    input.config,
    requiredBuiltinFeaturePolicy({ features: input.config.features }),
  );
}

function serializeAgentConfig(
  config: Omit<CanonicalAgentConfig, 'diagnostics'>,
  features?: BuiltinAgentFeaturePolicy,
): string {
  const frontmatter: Record<string, unknown> = {
    name: config.name,
    description: config.description,
  };
  if (config.model) frontmatter.model = config.model;
  if (config.effort) frontmatter.effort = config.effort;
  if (config.tools !== undefined) frontmatter.tools = [...config.tools];
  if (config.disallowedTools !== undefined)
    frontmatter.disallowedTools = [...config.disallowedTools];
  if (config.mcpServers !== undefined) frontmatter.mcpServers = [...config.mcpServers];
  if (config.skills !== undefined) frontmatter.skills = [...config.skills];
  if (features) {
    frontmatter.features = {
      mavis: features.mavis,
      delegation: features.delegation,
      webSearch: features.webSearch,
    };
  }
  const xMavis = serializeMavis(config.xMavis);
  if (xMavis) frontmatter['x-mavis'] = xMavis;
  const rendered = yaml.stringify(frontmatter, { indent: 2, lineWidth: -1 }).trimEnd();
  const body = config.systemPrompt;
  return `---\n${rendered}\n---${body.length > 0 ? `\n\n${body}` : '\n'}`;
}

async function readStableRegularFile(
  filePath: string,
): Promise<{ readonly contents: string } | 'changed'> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(filePath);
  } catch (error) {
    if (isNotFound(error))
      throw new AgentConfigError(
        'AGENT_CONFIG_NOT_FOUND',
        'agent.md',
        'Agent configuration is missing.',
      );
    throw error;
  }
  assertRegularFile(before, 'agent.md');
  if (before.size > MAX_AGENT_FILE_BYTES) {
    throw invalid('agent.md', `Agent configuration exceeds ${MAX_AGENT_FILE_BYTES} bytes.`);
  }
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    assertRegularFile(opened, 'agent.md');
    if (!sameFile(before, opened) || opened.size > MAX_AGENT_FILE_BYTES) return 'changed';
    const contents = decodeCanonicalUtf8(await readBoundedOpenFile(handle, opened.size));
    const afterHandle = await handle.stat();
    const afterPath = await lstat(filePath);
    if (!sameFile(before, afterHandle) || !sameFile(before, afterPath)) return 'changed';
    return { contents };
  } catch (error) {
    if (isNoFollowError(error)) {
      throw new AgentConfigError(
        'AGENT_CONFIG_INVALID',
        'agent.md',
        'Agent configuration must be a regular file.',
      );
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * `Buffer#toString('utf8')` replaces malformed byte sequences with U+FFFD.
 * Config revisions are hashes of the exact on-disk bytes, so accepting that
 * lossy conversion would make a GET document impossible to round-trip via
 * PUT. Reject it instead of silently presenting altered source to an editor.
 */
function decodeCanonicalUtf8(bytes: Buffer): string {
  try {
    // Preserve a leading UTF-8 BOM as U+FEFF too: the Config API hashes exact
    // bytes, and silently stripping it would break a GET → PUT round trip.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new AgentConfigError(
      'AGENT_CONFIG_INVALID',
      'agent.md',
      'Agent configuration must be valid UTF-8.',
    );
  }
}

export async function validateAgentAvatar(
  agentDir: string,
  avatar: string,
  trustedRoot?: string,
): Promise<void> {
  // Marker-only avatars are virtual token SVGs rendered by the shared UI. They
  // deliberately own no file under the Desktop data directory.
  if (isDefaultAgentAvatarMarker(avatar)) return;
  await readSafeAgentAvatar(agentDir, avatar, trustedRoot);
}

/** Returns only a regular, stable, in-directory image file. */
export async function readSafeAgentAvatar(
  agentDir: string,
  avatar: string,
  trustedRoot?: string,
): Promise<{ readonly bytes: Buffer; readonly extension: string }> {
  const { filePath, extension } = avatarPath(agentDir, avatar);
  const metadata = await readAvatarMetadata(agentDir, filePath, trustedRoot);
  assertSafeAvatarFile(metadata);
  const bytes = await readStableAvatar(agentDir, filePath, metadata, trustedRoot);
  if (!looksLikeImage(bytes, extension))
    throw avatarInvalid('Avatar contents are not a supported image.');
  return { bytes, extension };
}

/** Strictly decodes the Desktop create-only image payload before it touches disk. */
export function decodeAgentAvatarDataUrl(value: string): {
  readonly bytes: Buffer;
  readonly extension: string;
} {
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]*)$/u.exec(value);
  const mimeType = match?.[1];
  const payload = match?.[2];
  const extension = mimeType ? DATA_IMAGE_TYPES[mimeType] : undefined;
  if (!extension || payload === undefined || payload.length > MAX_DATA_IMAGE_BASE64_LENGTH) {
    throw avatarInvalid('Avatar must be a bounded supported image data URL.');
  }
  if (payload.length % 4 !== 0) {
    throw avatarInvalid('Avatar data URL must use strict base64 encoding.');
  }
  // Exact re-encoding below validates alphabet and padding without a repeated-group
  // regex, which can overflow the JS stack on a valid 10 MiB avatar.
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length > AGENT_AVATAR_MAX_BYTES || bytes.toString('base64') !== payload) {
    throw avatarInvalid('Avatar data URL exceeds the supported image limit.');
  }
  if (!looksLikeImage(bytes, extension)) {
    throw avatarInvalid('Avatar data URL MIME type does not match image contents.');
  }
  return { bytes, extension };
}

function avatarPath(
  agentDir: string,
  avatar: string,
): { readonly filePath: string; readonly extension: string } {
  if (!avatar.trim() || isAbsolute(avatar)) {
    throw avatarInvalid('Avatar must be a relative image path.');
  }
  const filePath = resolve(agentDir, avatar);
  if (!isWithinDirectory(agentDir, filePath)) {
    throw avatarInvalid('Avatar path escapes the Agent directory.');
  }
  const extension = extname(filePath).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    throw avatarInvalid('Avatar must be a supported image file.');
  }
  return { filePath, extension };
}

async function readAvatarMetadata(
  agentDir: string,
  filePath: string,
  trustedRoot: string | undefined,
): Promise<Awaited<ReturnType<typeof lstat>>> {
  const root = resolve(agentDir);
  const segments = relative(root, filePath).split(sep).filter(Boolean);
  let current = root;
  let metadata = await assertSafeAgentAvatarDirectory(root, trustedRoot);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    metadata = await avatarLstat(current);
    if (metadata.isSymbolicLink())
      throw avatarInvalid('Avatar path must not contain symbolic links.');
    if (index < segments.length - 1) assertRealAvatarDirectory(metadata);
  }
  return metadata;
}

/** Verifies the logical Agent-directory path before a canonical file is opened. */
async function assertSafeAgentDirectory(
  agentDir: string,
  trustedRoot = dirname(dirname(agentDir)),
): Promise<void> {
  await inspectSafeAgentDirectory(agentDir, trustedRoot, true, (message) =>
    invalid('agent.md', message),
  );
}

/** Verifies an Agent directory before a create path stages an avatar under it. */
export async function assertSafeAgentAvatarDirectory(
  agentDir: string,
  trustedRoot = dirname(dirname(agentDir)),
): Promise<Awaited<ReturnType<typeof lstat>>> {
  const metadata = await inspectSafeAgentDirectory(agentDir, trustedRoot, false, avatarInvalid);
  if (!metadata) throw avatarInvalid('Avatar directory does not exist.');
  return metadata;
}

async function inspectSafeAgentDirectory(
  agentDir: string,
  trustedRoot: string,
  allowMissing: boolean,
  fail: (message: string) => AgentConfigError,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  const root = resolve(trustedRoot);
  const target = resolve(agentDir);
  if (!isWithinDirectory(root, target)) {
    throw fail('Agent directory path escapes the Desktop data directory.');
  }
  let current = root;
  let metadata: Awaited<ReturnType<typeof lstat>> | undefined;
  const segments = relative(root, target).split(sep).filter(Boolean);
  for (const [index, segment] of ['', ...segments].entries()) {
    if (segment) current = join(current, segment);
    try {
      metadata = await lstat(current);
    } catch (error) {
      if (allowMissing && isNotFound(error)) return undefined;
      throw fail('Agent directory does not exist or cannot be read.');
    }
    if (metadata.isSymbolicLink())
      metadata = await resolveAgentDirectoryLink({
        root,
        current,
        segment: agentDirectorySegment(segments, index),
        fail,
      });
    if (!metadata.isDirectory()) throw fail('Agent directory is not a directory.');
  }
  return metadata;
}

type AgentDirectorySegment = 'data_dir' | 'agents' | 'builtin' | 'agent' | 'nested';
type AgentDirectoryTargetScope =
  | 'expected_default_target'
  | 'data_dir_inside'
  | 'data_dir_outside'
  | 'unresolvable';
type AgentDirectoryResolvedTargetKind = 'directory' | 'not_directory' | 'unresolvable';

async function resolveAgentDirectoryLink(input: {
  readonly root: string;
  readonly current: string;
  readonly segment: AgentDirectorySegment;
  readonly fail: (message: string) => AgentConfigError;
}): Promise<Awaited<ReturnType<typeof lstat>>> {
  let rawTarget: string | null = null;
  let resolvedTarget: string | null = null;
  try {
    rawTarget = await readlink(input.current);
  } catch {
    // The warning below records that the link target could not be inspected.
  }
  try {
    resolvedTarget = await realpath(input.current);
  } catch {
    // The stable error below distinguishes dangling links from non-directories.
  }
  let targetMetadata: Awaited<ReturnType<typeof stat>> | undefined;
  if (resolvedTarget) {
    try {
      targetMetadata = await stat(resolvedTarget);
    } catch {
      // The warning below records that the resolved target could not be read.
    }
  }
  let resolvedTargetKind: AgentDirectoryResolvedTargetKind;
  if (!targetMetadata) {
    resolvedTargetKind = 'unresolvable';
  } else if (targetMetadata.isDirectory()) {
    resolvedTargetKind = 'directory';
  } else {
    resolvedTargetKind = 'not_directory';
  }
  const targetScope = await agentDirectoryTargetScope(input.root, input.current, resolvedTarget);
  logAgentDirectoryLink({
    root: input.root,
    current: input.current,
    segment: input.segment,
    rawTarget,
    resolvedTarget,
    resolvedTargetKind,
    targetScope,
  });
  if (!targetMetadata) throw input.fail('Agent directory does not exist or cannot be read.');
  return targetMetadata;
}

function logAgentDirectoryLink(input: {
  readonly root: string;
  readonly current: string;
  readonly segment: AgentDirectorySegment;
  readonly rawTarget: string | null;
  readonly resolvedTarget: string | null;
  readonly resolvedTargetKind: AgentDirectoryResolvedTargetKind;
  readonly targetScope: AgentDirectoryTargetScope;
}): void {
  const key = `${input.current}\0${input.resolvedTarget ?? 'unresolvable'}`;
  if (loggedAgentDirectoryLinks.has(key)) return;
  loggedAgentDirectoryLinks.add(key);
  logger.warn(
    {
      event: 'agent_directory_link_followed',
      data_dir_source: dataDirSource(),
      segment: input.segment,
      logical_link_path: input.current,
      readlink_raw_target: input.rawTarget,
      realpath_resolved_target: input.resolvedTarget,
      resolved_target_kind: input.resolvedTargetKind,
      target_scope: input.targetScope,
      root_kind: agentDirectoryRootKind(input.root),
    },
    'Following linked Agent directory',
  );
}

function dataDirSource(): string {
  const source = process.env[DATA_DIR_SOURCE_ENV];
  return source && KNOWN_DATA_DIR_SOURCES.has(source) ? source : 'unknown';
}

function agentDirectoryRootKind(root: string): '.minimax' | '.mavis' | 'other' {
  const name = basename(root).toLowerCase();
  if (name === '.minimax' || name.startsWith('.minimax-')) return '.minimax';
  if (name === '.mavis' || name.startsWith('.mavis-')) return '.mavis';
  return 'other';
}

function agentDirectorySegment(segments: readonly string[], index: number): AgentDirectorySegment {
  if (index === 0) return 'data_dir';
  if (segments[0] !== 'agents') return 'nested';
  if (index === 1) return 'agents';
  if (segments[1] === '.builtin' && index === 2) return 'builtin';
  if (index === 2 || (segments[1] === '.builtin' && index === 3)) return 'agent';
  return 'nested';
}

async function agentDirectoryTargetScope(
  root: string,
  current: string,
  resolvedTarget: string | null,
): Promise<AgentDirectoryTargetScope> {
  if (!resolvedTarget) return 'unresolvable';
  try {
    if (await isExpectedDefaultDataDirTarget(root, current, resolvedTarget)) {
      return 'expected_default_target';
    }
    const resolvedRoot = await realpath(root);
    return isWithinDirectory(resolvedRoot, resolvedTarget) ? 'data_dir_inside' : 'data_dir_outside';
  } catch {
    return 'unresolvable';
  }
}

async function isExpectedDefaultDataDirTarget(
  root: string,
  current: string,
  resolvedTarget: string,
): Promise<boolean> {
  if (current !== root || agentDirectoryRootKind(root) !== '.mavis') return false;
  try {
    return samePath(
      resolvedTarget,
      await realpath(join(dirname(root), expectedDefaultMinimaxDataDirName(root))),
    );
  } catch {
    return false;
  }
}

function expectedDefaultMinimaxDataDirName(root: string): string {
  const name = basename(root);
  return name.startsWith('.mavis-') ? `.minimax${name.slice('.mavis'.length)}` : '.minimax';
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function avatarLstat(filePath: string): Promise<Awaited<ReturnType<typeof lstat>>> {
  try {
    return await lstat(filePath);
  } catch {
    throw avatarInvalid('Avatar file does not exist or cannot be safely read.');
  }
}

function assertRealAvatarDirectory(metadata: Awaited<ReturnType<typeof lstat>>): void {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw avatarInvalid('Avatar path must not contain symbolic links.');
  }
}

function assertSafeAvatarFile(metadata: Awaited<ReturnType<typeof lstat>>): void {
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw avatarInvalid('Avatar must be a regular file.');
  }
  if (metadata.size > AGENT_AVATAR_MAX_BYTES) {
    throw avatarInvalid(`Avatar exceeds ${AGENT_AVATAR_MAX_BYTES} bytes.`);
  }
}

async function readStableAvatar(
  agentDir: string,
  filePath: string,
  before: Awaited<ReturnType<typeof lstat>>,
  trustedRoot: string | undefined,
): Promise<Buffer> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > AGENT_AVATAR_MAX_BYTES || !sameFile(before, opened)) {
      throw avatarInvalid('Avatar changed while it was being read.');
    }
    const bytes = await readBoundedOpenFile(handle, opened.size);
    const afterHandle = await handle.stat();
    const afterPath = await readAvatarMetadata(agentDir, filePath, trustedRoot);
    if (!sameFile(before, afterHandle) || !sameFile(before, afterPath)) {
      throw avatarInvalid('Avatar changed while it was being read.');
    }
    return bytes;
  } catch (error) {
    if (isNoFollowError(error)) throw avatarInvalid('Avatar must be a regular file.');
    throw error;
  } finally {
    await handle?.close();
  }
}

/** The pre-open stat bound remains effective if a concurrent writer grows the file. */
async function readBoundedOpenFile(
  handle: Awaited<ReturnType<typeof open>>,
  size: number,
): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return offset === buffer.length ? buffer : buffer.subarray(0, offset);
}

function looksLikeImage(bytes: Buffer, extension: string): boolean {
  if (extension === '.png')
    return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (extension === '.jpg' || extension === '.jpeg')
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === '.gif')
    return (
      bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      bytes.subarray(0, 6).toString('ascii') === 'GIF89a'
    );
  return (
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  );
}

function splitFrontmatter(raw: string): { readonly frontmatter: string; readonly body: string } {
  // A BOM remains part of the raw Config API source/revision, but it is not a
  // YAML token. Ignore it only for structural parsing so GET can faithfully
  // return the original bytes without rejecting an otherwise valid document.
  const source = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const lineEnding = openingFrontmatterLineEnding(source);
  if (!lineEnding) {
    throw invalid('frontmatter', 'Agent configuration requires YAML frontmatter.');
  }
  const frontmatterStart = 3 + lineEnding.length;
  const closing = closingFrontmatter(source, frontmatterStart);
  if (!closing) {
    throw invalid('frontmatter', 'Agent configuration is missing the closing frontmatter marker.');
  }
  return {
    frontmatter: source.slice(frontmatterStart, closing.frontmatterEnd),
    body: closing.body,
  };
}

function openingFrontmatterLineEnding(source: string): '\n' | '\r\n' | undefined {
  if (source.startsWith('---\r\n')) return '\r\n';
  if (source.startsWith('---\n')) return '\n';
  return undefined;
}

function closingFrontmatter(
  source: string,
  start: number,
): { readonly frontmatterEnd: number; readonly body: string } | undefined {
  let cursor = start;
  while (cursor <= source.length) {
    const lineEnd = source.indexOf('\n', cursor);
    const end = lineEnd === -1 ? source.length : lineEnd;
    const rawLine = source.slice(cursor, end);
    if (rawLine.replace(/\r$/u, '') === '---') {
      return { frontmatterEnd: cursor, body: bodyAfterFrontmatter(source, lineEnd, rawLine) };
    }
    if (lineEnd === -1) return undefined;
    cursor = lineEnd + 1;
  }
  return undefined;
}

function bodyAfterFrontmatter(source: string, lineEnd: number, closingLine: string): string {
  if (lineEnd === -1) return '';
  const body = source.slice(lineEnd + 1);
  const lineEnding = closingLine.endsWith('\r') ? '\r\n' : '\n';
  return body.startsWith(lineEnding) ? body.slice(lineEnding.length) : body;
}

function parseMavis(value: unknown): CanonicalAgentMavisConfig | undefined {
  if (value === undefined) return undefined;
  const source = asPlainObject(value);
  if (!source) throw invalid('x-mavis', 'x-mavis must be a mapping.');
  const defaultWorkspaceDir = canonicalWorkspace(source);
  const result = mavisFields(source, defaultWorkspaceDir);
  return Object.keys(result).length === 0 ? undefined : result;
}

function canonicalWorkspace(source: Record<string, unknown>): string | undefined {
  const workspace = optionalText(source, 'defaultWorkspaceDir', { allowBlank: true })?.trim();
  if (workspace && !isAbsolute(workspace)) {
    throw invalid(
      'x-mavis.defaultWorkspaceDir',
      'defaultWorkspaceDir must be an absolute path or empty.',
    );
  }
  return workspace || undefined;
}

function mavisFields(
  source: Record<string, unknown>,
  defaultWorkspaceDir: string | undefined,
): CanonicalAgentMavisConfig {
  const displayName = optionalText(source, 'displayName');
  const avatar = optionalText(source, 'avatar');
  const contextWindow = optionalPositiveInteger(source, 'contextWindow');
  const maxOutputTokens = optionalPositiveInteger(source, 'maxOutputTokens');
  const extensionSkills = optionalTextArray(source, 'extensionSkills');
  return {
    ...(displayName ? { displayName } : {}),
    ...(avatar ? { avatar } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(defaultWorkspaceDir ? { defaultWorkspaceDir } : {}),
    ...(extensionSkills === undefined ? {} : { extensionSkills }),
  };
}

function serializeMavis(
  value: CanonicalAgentMavisConfig | undefined,
): Record<string, unknown> | undefined {
  if (!value) return undefined;
  const result: Record<string, unknown> = {};
  if (value.displayName) result.displayName = value.displayName;
  if (value.avatar) result.avatar = value.avatar;
  if (value.contextWindow !== undefined) result.contextWindow = value.contextWindow;
  if (value.maxOutputTokens !== undefined) result.maxOutputTokens = value.maxOutputTokens;
  if (value.defaultWorkspaceDir) result.defaultWorkspaceDir = value.defaultWorkspaceDir;
  if (value.extensionSkills !== undefined) result.extensionSkills = [...value.extensionSkills];
  return Object.keys(result).length === 0 ? undefined : result;
}

function optionalBuiltinFeaturePolicy(
  source: Record<string, unknown>,
): BuiltinAgentFeaturePolicy | undefined {
  try {
    return requiredBuiltinFeaturePolicy(source);
  } catch {
    // The old generic reader treated arbitrary `features` as an unsupported
    // field. Keep a partial or hand-edited legacy mirror readable so its valid
    // model group survives the startup rebuild.
    return undefined;
  }
}

function requiredBuiltinFeaturePolicy(source: Record<string, unknown>): BuiltinAgentFeaturePolicy {
  const value = source.features;
  const features = asPlainObject(value);
  if (!features) throw invalid('features', 'features must be a mapping.');
  if (Object.keys(features).some((field) => !BUILTIN_FEATURE_FIELDS.has(field))) {
    throw invalid('features', 'features contains unsupported fields.');
  }
  return Object.freeze({
    mavis: requiredBoolean(features, 'mavis'),
    delegation: requiredBoolean(features, 'delegation'),
    webSearch: requiredBoolean(features, 'webSearch'),
  });
}

function requiredBoolean(source: Record<string, unknown>, field: string): boolean {
  const value = source[field];
  if (typeof value !== 'boolean') {
    throw invalid(`features.${field}`, `${field} must be a boolean.`);
  }
  return value;
}

function requiredText(source: Record<string, unknown>, field: string): string {
  const value = optionalText(source, field);
  if (!value) throw invalid(field, `${field} is required.`);
  return value;
}

function optionalText(
  source: Record<string, unknown>,
  field: string,
  options: { readonly allowBlank?: boolean } = {},
): string | undefined {
  const value = source[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw invalid(field, `${field} must be a string.`);
  if (!options.allowBlank && value.trim().length === 0)
    throw invalid(field, `${field} cannot be blank.`);
  return value;
}

function optionalModel(source: Record<string, unknown>): string | undefined {
  const model = optionalText(source, 'model');
  // Split like ModelSystem: the provider ends at the first `/` and the model
  // id may itself contain `/` (for example `openrouter/qwen/qwen3`).
  if (model !== undefined && (/\s/u.test(model) || !parseSourceQualifiedModelKey(model))) {
    throw invalid('model', 'model must use the provider/model form.');
  }
  return model;
}

function optionalTextArray(
  source: Record<string, unknown>,
  field: string,
): readonly string[] | undefined {
  const value = source[field];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.trim().length === 0)
  ) {
    throw invalid(field, `${field} must be an array of non-empty strings.`);
  }
  return Object.freeze([...value]);
}

function optionalPositiveInteger(
  source: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = source[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw invalid(field, `${field} must be a positive safe integer.`);
  }
  return value;
}

function asPlainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assertYamlDepth(value: unknown, depth = 0, seen = new WeakSet<object>()): void {
  if (depth > MAX_YAML_DEPTH) {
    throw invalid(
      'frontmatter',
      `Agent frontmatter exceeds the maximum depth of ${MAX_YAML_DEPTH}.`,
    );
  }
  if (!value || typeof value !== 'object') return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    assertYamlDepth(child, depth + 1, seen);
  }
}

function assertRegularFile(value: Awaited<ReturnType<typeof lstat>>, field: string): void {
  if (!value.isFile() || value.isSymbolicLink()) {
    throw new AgentConfigError(
      'AGENT_CONFIG_INVALID',
      field,
      'Agent configuration must be a regular file.',
    );
  }
}

function sameFile(
  left: Pick<Awaited<ReturnType<typeof lstat>>, 'dev' | 'ino' | 'size' | 'mtimeMs'>,
  right: Pick<Awaited<ReturnType<typeof lstat>>, 'dev' | 'ino' | 'size' | 'mtimeMs'>,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function isWithinDirectory(directory: string, target: string): boolean {
  const path = relative(resolve(directory), target);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function invalid(field: string, message: string): AgentConfigError {
  return new AgentConfigError('AGENT_CONFIG_INVALID', field, message);
}

function avatarInvalid(message: string): AgentConfigError {
  return new AgentConfigError('AGENT_CONFIG_AVATAR_INVALID', 'x-mavis.avatar', message);
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function isNoFollowError(error: unknown): boolean {
  return ['ELOOP', 'EINVAL'].includes((error as NodeJS.ErrnoException | undefined)?.code ?? '');
}
