import path from 'node:path';

import { readOfficialAppReference } from '../../app/reader.js';
import { readOfficialMcpFile } from '../../mcp/config.js';
import { readPluginSkill } from '../../skill/reader.js';
import {
  canonicalizePluginRoot,
  readPluginJsonObject,
  resolvePluginFile,
  type CanonicalPluginRoot,
} from './filesystem.js';
import { readOptionalMiniAppContribution } from './miniapp/reader.js';
import { ignoredManifestFieldDiagnostics, readerFail } from './reader-errors.js';
import { readPluginHooks } from './hook/reader.js';
import {
  MARKETPLACE_CATEGORY_NAMES,
  type MarketplaceCategoryName,
  type PluginHostBinding,
  type PluginHostBindingSurface,
  type PluginPackageSource,
  type ReadPluginPackage,
} from './types.js';

const MANIFEST_PATH = '.minimax-plugin/plugin.json';
const PLUGIN_NAME = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-((?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const ICON_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.(?:png|jpe?g|webp)$/u;
const APP_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.app\.json$/u;
const MCP_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.mcp\.json$/u;
const SKILL_PATH = /^skills\/[A-Za-z0-9._-]+\/SKILL\.md$/u;
const HOOK_PATH = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.json$/u;
const HOST_BINDING_PATH = /^bindings\/[A-Za-z0-9._-]+\.binding\.json$/u;
const HOST_BINDING_IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/u;
const HOST_BINDING_FIELDS = new Set([
  '$schema',
  'schemaVersion',
  'bindingId',
  'logicalToolName',
  'hostCapability',
  'requiredSkills',
  'allowedSurfaces',
]);
const HOST_CAPABILITY_FIELDS = new Set(['id', 'version']);
const SUPPORTED_HOST_BINDING_SURFACES = new Set<PluginHostBindingSurface>(['interactive']);
const MANIFEST_FIELDS = new Set([
  '$schema',
  'schemaVersion',
  'name',
  'displayName',
  'version',
  'description',
  'author',
  'icon',
  'darkIcon',
  'category',
  'exampleQueries',
  'apps',
  'mcpServers',
  'skills',
  'hooks',
  'hostBindings',
]);

export async function readMiniMaxPluginPackage(
  packageRoot: string,
  options: {
    source: Extract<PluginPackageSource, 'OFFICIAL' | 'LOCAL_MINIMAX'>;
    requireMiniApp?: boolean;
  },
): Promise<ReadPluginPackage> {
  const root = await canonicalizePluginRoot(packageRoot, { rejectSymlink: true });
  const { path: manifestPath, value } = await readPluginJsonObject(root, MANIFEST_PATH, {
    portable: true,
  });
  const manifest = readManifest(value);
  const iconPath = await resolvePluginFile(root, manifest.icon, { portable: true });
  const darkIconPath = manifest.darkIcon
    ? await resolvePluginFile(root, manifest.darkIcon, { portable: true })
    : undefined;
  const apps =
    options.source === 'OFFICIAL'
      ? await Promise.all(
          manifest.apps.map((relativePath) => readOfficialAppReference(root, relativePath)),
        )
      : [];
  const mcpGroups = await Promise.all(
    manifest.mcpServers.map((relativePath) => readOfficialMcpFile(root, relativePath)),
  );
  const mcpServers = mcpGroups.flatMap((group) => group.servers);
  assertUniqueNames(mcpServers, 'MCP', (server) => server.name);
  const skills = await Promise.all(
    manifest.skills.map((relativePath) =>
      readPluginSkill(root, relativePath, {
        portable: true,
        expectedName: path.posix.basename(path.posix.dirname(relativePath)),
      }),
    ),
  );
  assertUniqueNames(skills, 'Skill', (skill) => skill.name);
  const hostBindings = await readPluginHostBindings(root, manifest.hostBindings);
  const skillNames = new Set(skills.map((skill) => skill.name));
  const invalidBinding = hostBindings.find((binding) =>
    binding.requiredSkills.some((skill) => !skillNames.has(skill)),
  );
  if (invalidBinding) {
    readerFail(
      'HOST_BINDING_SKILL_MISSING',
      `Host Binding ${invalidBinding.bindingId} references an undeclared Skill`,
    );
  }
  const hookResult = await readPluginHooks(root, {
    pluginName: manifest.name,
    declared: manifest.hooks,
    sourceFormat: 'MINIMAX',
  });
  const miniapp = await readOptionalMiniAppContribution(
    root.path,
    mcpServers.map((server) => server.name),
  );
  assertRequiredMiniApp(miniapp, options.requireMiniApp);
  if (
    apps.length +
      mcpServers.length +
      skills.length +
      hostBindings.length +
      hookResult.hooks.length ===
      0 &&
    !miniapp
  ) {
    readerFail('MANIFEST_SCHEMA_INVALID', 'MiniMax Plugin has no executable capability');
  }

  return {
    source: options.source,
    manifestKind: 'MINIMAX',
    rootPath: root.path,
    manifestPath,
    name: manifest.name,
    ...(manifest.displayName ? { displayName: manifest.displayName } : {}),
    version: manifest.version,
    description: manifest.description,
    author: manifest.author,
    iconPath,
    ...(darkIconPath ? { darkIconPath } : {}),
    category: manifest.category,
    exampleQueries: manifest.exampleQueries,
    apps,
    mcpServers,
    skills,
    hostBindings,
    hooks: hookResult.hooks,
    ...(miniapp ? { miniapp } : {}),
    diagnostics: [
      ...hookResult.diagnostics,
      ...ignoredManifestFieldDiagnostics(value, MANIFEST_FIELDS),
    ],
  };
}

function assertRequiredMiniApp(
  miniapp: ReadPluginPackage['miniapp'],
  required: boolean | undefined,
): void {
  if (required && !miniapp) {
    readerFail('MINIAPP_MCODE_SCHEMA_INVALID', 'package.json#mcode must declare a MiniApp');
  }
}

async function readPluginHostBindings(
  root: CanonicalPluginRoot,
  relativePaths: readonly string[],
): Promise<PluginHostBinding[]> {
  if (relativePaths.length === 0) return [];
  const bindings = await Promise.all(
    relativePaths.map(async (relativePath) => {
      const { value } = await readPluginJsonObject(root, relativePath, { portable: true });
      return readHostBinding(value, relativePath);
    }),
  );
  assertUniqueHostBindingValues(
    bindings.map((binding) => binding.bindingId),
    'bindingId',
  );
  assertUniqueHostBindingValues(
    bindings.map((binding) => binding.logicalToolName),
    'logicalToolName',
  );
  return bindings;
}

function readHostBinding(
  value: Readonly<Record<string, unknown>>,
  sourcePath: string,
): PluginHostBinding {
  if (
    Object.keys(value).some((key) => !HOST_BINDING_FIELDS.has(key)) ||
    (value.$schema !== undefined && typeof value.$schema !== 'string') ||
    value.schemaVersion !== 1
  ) {
    readerFail('HOST_BINDING_SCHEMA_INVALID', 'Host Binding must use strict schemaVersion 1');
  }
  const bindingId = readHostBindingIdentifier(value.bindingId, 'bindingId');
  const logicalToolName = readHostBindingIdentifier(value.logicalToolName, 'logicalToolName');
  const hostCapability = readHostCapability(value.hostCapability);
  const requiredSkills = readUniqueHostBindingIdentifiers(value.requiredSkills, 'requiredSkills');
  if (requiredSkills.length === 0) {
    readerFail('HOST_BINDING_SCHEMA_INVALID', 'requiredSkills must not be empty');
  }
  const allowedSurfaces = readAllowedHostBindingSurfaces(value.allowedSurfaces);
  return {
    schemaVersion: 1,
    bindingId,
    logicalToolName,
    hostCapability,
    requiredSkills,
    allowedSurfaces,
    sourcePath,
  };
}

function readHostCapability(value: unknown): { readonly id: string; readonly version: number } {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !HOST_CAPABILITY_FIELDS.has(key)) ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) < 1
  ) {
    readerFail('HOST_BINDING_SCHEMA_INVALID', 'hostCapability is invalid');
  }
  return {
    id: readHostBindingIdentifier(value.id, 'hostCapability.id'),
    version: value.version as number,
  };
}

function readAllowedHostBindingSurfaces(value: unknown): PluginHostBindingSurface[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (surface) =>
        typeof surface !== 'string' || !SUPPORTED_HOST_BINDING_SURFACES.has(surface as never),
    ) ||
    new Set(value).size !== value.length
  ) {
    readerFail('HOST_BINDING_SCHEMA_INVALID', 'allowedSurfaces is invalid');
  }
  return value as PluginHostBindingSurface[];
}

function readUniqueHostBindingIdentifiers(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    readerFail('HOST_BINDING_SCHEMA_INVALID', `${label} must be a string array`);
  }
  const identifiers = (value as string[]).map((item) => readHostBindingIdentifier(item, label));
  if (new Set(identifiers).size !== identifiers.length) {
    readerFail('HOST_BINDING_SCHEMA_INVALID', `${label} contains a duplicate`);
  }
  return identifiers;
}

function readHostBindingIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 128 || !HOST_BINDING_IDENTIFIER.test(value)) {
    readerFail('HOST_BINDING_SCHEMA_INVALID', `${label} is invalid`);
  }
  return value;
}

function assertUniqueHostBindingValues(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    readerFail('HOST_BINDING_SCHEMA_INVALID', `Host Binding contains duplicate ${label}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface MiniMaxManifest {
  readonly name: string;
  readonly displayName?: string;
  readonly version: string;
  readonly description: string;
  readonly author: string;
  readonly icon: string;
  readonly darkIcon?: string;
  readonly category: MarketplaceCategoryName;
  readonly exampleQueries: string[];
  readonly apps: string[];
  readonly mcpServers: string[];
  readonly skills: string[];
  readonly hooks: string[];
  readonly hostBindings: string[];
}

function readManifest(value: Record<string, unknown>): MiniMaxManifest {
  assertManifestEnvelope(value);
  const identity = readManifestIdentity(value);
  const icon = readManifestIcon(value.icon);
  const darkIcon =
    value.darkIcon === undefined ? undefined : readManifestIcon(value.darkIcon, 'darkIcon');
  const category = readManifestCategory(value.category);
  const exampleQueries = readExampleQueries(value.exampleQueries);
  const capabilities = readManifestCapabilities(value);
  return {
    ...identity,
    icon,
    ...(darkIcon ? { darkIcon } : {}),
    category,
    exampleQueries,
    ...capabilities,
  };
}

function assertManifestEnvelope(value: Record<string, unknown>): void {
  // Host capabilities are granted only through Host Bindings, never by a manifest claim.
  if (Object.hasOwn(value, 'hostCapabilities')) {
    readerFail('MANIFEST_SCHEMA_INVALID', 'MiniMax manifest cannot declare host capabilities');
  }
  if (
    (value.$schema !== undefined && typeof value.$schema !== 'string') ||
    value.schemaVersion !== 1
  ) {
    readerFail('MANIFEST_SCHEMA_INVALID', 'MiniMax manifest schemaVersion must be 1');
  }
}

function readManifestIdentity(
  value: Record<string, unknown>,
): Pick<MiniMaxManifest, 'name' | 'displayName' | 'version' | 'description' | 'author'> {
  const name = requiredString(value.name, 'name');
  if (name.length > 80 || !PLUGIN_NAME.test(name)) {
    readerFail('MANIFEST_SCHEMA_INVALID', 'MiniMax Plugin name is invalid');
  }
  const version = requiredString(value.version, 'version');
  if (version.length > 128 || !SEMVER.test(version)) {
    readerFail('MANIFEST_SCHEMA_INVALID', 'MiniMax Plugin version is not semver');
  }
  const displayName = optionalString(value.displayName, 'displayName');
  const description = requiredString(value.description, 'description');
  const author = requiredString(value.author, 'author');
  return {
    name,
    ...(displayName ? { displayName } : {}),
    version,
    description,
    author,
  };
}

function readManifestIcon(value: unknown, label = 'icon'): string {
  const icon = requiredString(value, label);
  if (icon.length > 512 || !ICON_PATH.test(icon)) {
    readerFail('MANIFEST_SCHEMA_INVALID', `MiniMax Plugin ${label} path is invalid`);
  }
  return icon;
}

function readManifestCategory(category: unknown): MarketplaceCategoryName {
  // Category id 8 / name "Tools" is retired. Keep old installed packages
  // readable without exposing the retired category to current projections.
  if (category === 'Tools') return 'Other';
  if (
    typeof category !== 'string' ||
    !MARKETPLACE_CATEGORY_NAMES.includes(category as MarketplaceCategoryName)
  ) {
    readerFail('MANIFEST_SCHEMA_INVALID', 'MiniMax Plugin category is invalid');
  }
  return category as MarketplaceCategoryName;
}

function readExampleQueries(value: unknown): string[] {
  const exampleQueries = stringArray(value, 'exampleQueries');
  if (exampleQueries.some((query) => !query.trim())) {
    readerFail('MANIFEST_SCHEMA_INVALID', 'MiniMax Plugin example query is blank');
  }
  return exampleQueries;
}

function readManifestCapabilities(
  value: Record<string, unknown>,
): Pick<MiniMaxManifest, 'apps' | 'mcpServers' | 'skills' | 'hooks' | 'hostBindings'> {
  const apps = referenceArray(value.apps, 'apps', APP_PATH);
  const mcpServers = referenceArray(value.mcpServers, 'mcpServers', MCP_PATH);
  const skills = referenceArray(value.skills, 'skills', SKILL_PATH);
  const hooks = value.hooks === undefined ? [] : referenceArray(value.hooks, 'hooks', HOOK_PATH);
  const hostBindings =
    value.hostBindings === undefined
      ? []
      : referenceArray(value.hostBindings, 'hostBindings', HOST_BINDING_PATH);
  return { apps, mcpServers, skills, hooks, hostBindings };
}

function referenceArray(value: unknown, label: string, pattern: RegExp): string[] {
  const items = uniqueStringArray(value, label);
  if (items.some((item) => item.length > 512 || !pattern.test(item))) {
    readerFail('MANIFEST_SCHEMA_INVALID', `${label} contains an invalid path`);
  }
  return items;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    readerFail('MANIFEST_SCHEMA_INVALID', `${label} must be a string array`);
  }
  return value as string[];
}

function uniqueStringArray(value: unknown, label: string): string[] {
  const items = stringArray(value, label);
  if (new Set(items).size !== items.length) {
    readerFail('MANIFEST_SCHEMA_INVALID', `${label} contains a duplicate`);
  }
  return items;
}

function requiredString(value: unknown, label: string): string {
  const parsed = optionalString(value, label);
  if (!parsed) readerFail('MANIFEST_SCHEMA_INVALID', `${label} is required`);
  return parsed;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    readerFail('MANIFEST_SCHEMA_INVALID', `${label} must be a non-empty string`);
  }
  return value.trim();
}

function assertUniqueNames<T>(
  values: readonly T[],
  label: string,
  nameOf: (value: T) => string,
): void {
  const names = values.map(nameOf);
  if (new Set(names).size !== names.length) {
    readerFail('MANIFEST_SCHEMA_INVALID', `MiniMax Plugin contains duplicate ${label} names`);
  }
}
