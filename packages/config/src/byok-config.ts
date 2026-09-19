// BYOK config parsing + required provider overrides.
//
// Split out of config.ts (2000-line layout budget). Types stay in config.ts
// (they are part of the Config surface); the back edge here is type-only, so
// there is no runtime import cycle.

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { restrictConfigFileSync, writePrivateConfigFileSync } from './private-config-file.js';

import type {
  CustomProvidersConfig,
  MinimaxApiConfig,
  ModelsConfig,
  ProviderConfig,
} from './config.js';

export function parseMinimaxApiConfig(raw: unknown): MinimaxApiConfig | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const parsed: MinimaxApiConfig = {};
  if (typeof obj.apiKey === 'string') parsed.apiKey = obj.apiKey;
  if (typeof obj.baseURL === 'string') parsed.baseURL = obj.baseURL;
  const modelContextLimits = parseModelContextLimits(obj.modelContextLimits);
  if (modelContextLimits) parsed.modelContextLimits = modelContextLimits;
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

export function parseModelContextLimits(raw: unknown): Record<string, number> | undefined {
  if (!isPlainRecord(raw)) return undefined;
  const entries = Object.entries(raw).filter(
    (entry): entry is [string, number] =>
      entry[0].length > 0 && Number.isSafeInteger(entry[1]) && (entry[1] as number) > 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/** Apply user-owned managed Context selections without mutating the official snapshot. */
export function applyManagedMinimaxContextLimits(
  provider: ModelsConfig,
  contextLimits: Record<string, number> | undefined,
): ModelsConfig {
  const minimax = provider.minimax;
  if (!minimax?.models || !contextLimits) return provider;

  let changed = false;
  const models = Object.fromEntries(
    Object.entries(minimax.models).map(([modelId, model]) => {
      const context = contextLimits[modelId];
      if (
        context === undefined ||
        !model.contextWindowOptions?.includes(context) ||
        model.limit?.context === context
      ) {
        return [modelId, model];
      }
      changed = true;
      return [modelId, { ...model, limit: { ...model.limit, context } }];
    }),
  );

  return changed ? { ...provider, minimax: { ...minimax, models } } : provider;
}

export function parseCustomProvidersConfig(raw: unknown): CustomProvidersConfig | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entries = Object.entries(raw as Record<string, unknown>).filter(
    ([, value]) => value != null && typeof value === 'object' && !Array.isArray(value),
  );
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([providerKey, provider]) => [
      providerKey,
      normalizeLegacyThinkingEffort(provider as Record<string, unknown>),
    ]),
  ) as CustomProvidersConfig;
}

export function normalizeLegacyThinkingEfforts(config: ModelsConfig): ModelsConfig {
  return Object.fromEntries(
    Object.entries(config).map(([providerKey, provider]) => [
      providerKey,
      isPlainRecord(provider)
        ? normalizeLegacyThinkingEffort(provider as Record<string, unknown>)
        : provider,
    ]),
  ) as ModelsConfig;
}

function normalizeLegacyThinkingEffort(provider: Record<string, unknown>): Record<string, unknown> {
  if (!isPlainRecord(provider.models)) return provider;
  let changed = false;
  const models = Object.fromEntries(
    Object.entries(provider.models).map(([modelId, value]) => {
      if (!isPlainRecord(value) || !isPlainRecord(value.thinking)) return [modelId, value];
      const legacyEffort =
        typeof value.thinking.effort === 'string' ? value.thinking.effort.trim() : '';
      const configuredDefaultEffort =
        typeof value.thinking.defaultEffort === 'string' ? value.thinking.defaultEffort.trim() : '';
      if (
        !Object.hasOwn(value.thinking, 'effort') &&
        !Object.hasOwn(value.thinking, 'defaultEffort')
      ) {
        return [modelId, value];
      }

      const effortOptions: string[] = [];
      const seen = new Set<string>();
      if (Array.isArray(value.thinking.effortOptions)) {
        for (const option of value.thinking.effortOptions) {
          if (typeof option !== 'string') continue;
          const normalized = option.trim();
          if (!normalized || seen.has(normalized)) continue;
          seen.add(normalized);
          effortOptions.push(normalized);
        }
      }
      if (legacyEffort && !seen.has(legacyEffort)) {
        seen.add(legacyEffort);
        effortOptions.push(legacyEffort);
      }
      if (configuredDefaultEffort && !seen.has(configuredDefaultEffort)) {
        seen.add(configuredDefaultEffort);
        effortOptions.push(configuredDefaultEffort);
      }

      const thinkingRest = { ...value.thinking };
      delete thinkingRest.effort;
      delete thinkingRest.effortOptions;
      delete thinkingRest.defaultEffort;
      const thinking = {
        ...thinkingRest,
        ...(effortOptions.length > 0 ? { effortOptions } : {}),
        ...(configuredDefaultEffort ? { defaultEffort: configuredDefaultEffort } : {}),
      };
      const model = { ...value };
      if (Object.keys(thinking).length > 0) model.thinking = thinking;
      else delete model.thinking;
      changed = true;
      return [modelId, model];
    }),
  );
  return changed ? { ...provider, models } : provider;
}

export interface RequiredProviderOverrideDeps {
  isManagedRuntime(): boolean;
  shouldEnforceManagedProviderProtection(): boolean;
  getManagedPreset(): { provider: ModelsConfig; defaultModel: string };
  isManagedPresetBaseUrl(baseURL: string): boolean;
}

export interface LegacyByokProviderMigrationResult {
  migrated: boolean;
  migratedProviders: Record<string, string>;
  backupPath?: string;
}

const LEGACY_BYOK_MIGRATION_KEY = 'byok_legacy_provider_to_custom_provider_v1';
const LEGACY_BYOK_BACKUP_PREFIX = 'config.yaml.bak.byok-legacy-provider.';
const RESERVED_CUSTOM_PROVIDER_KEYS = new Set([
  'minimax',
  'minimax_api',
  'provider',
  'custom_provider',
]);
const SIMPLE_ASCII_NAME = /^[A-Za-z0-9 _-]+$/;

/**
 * Feature-branch dogfood builds allowed BYOK-like providers to be hand-written
 * under `provider.*`. New builds keep `provider` as the managed/builtin tree,
 * so legacy user-owned entries are moved into `custom_provider` before the
 * config is parsed. Classification is intentionally conservative: eligible
 * legacy entries always become custom providers, never `minimax_api`.
 */
export function migrateLegacyByokProvidersOnDisk(
  configPath: string,
  deps: RequiredProviderOverrideDeps,
): LegacyByokProviderMigrationResult {
  const empty = { migrated: false, migratedProviders: {} };
  if (!deps.isManagedRuntime()) return empty;
  if (!fs.existsSync(configPath)) return empty;

  const raw = readRawConfigForMigration(configPath);
  if (!isPlainRecord(raw.provider)) return empty;

  const provider = raw.provider;
  const customProvider = isPlainRecord(raw.custom_provider) ? raw.custom_provider : {};
  const marker = readLegacyMigrationMarker(raw);
  const migratedProviders: Record<string, string> = {};
  const nextCustomProvider: Record<string, unknown> = { ...customProvider };
  const existingKeys = new Set(Object.keys(nextCustomProvider));
  let changed = false;

  const managedProvider = deps.getManagedPreset().provider;
  for (const [providerId, providerConfig] of Object.entries(provider)) {
    if (!shouldMigrateLegacyProvider(providerId, providerConfig, managedProvider)) {
      continue;
    }

    const recordedKey = marker.providers[providerId];
    if (
      recordedKey &&
      !RESERVED_CUSTOM_PROVIDER_KEYS.has(recordedKey) &&
      !isPlainRecord(nextCustomProvider[recordedKey])
    ) {
      delete provider[providerId];
      changed = true;
      continue;
    }

    const customKey =
      recordedKey && !RESERVED_CUSTOM_PROVIDER_KEYS.has(recordedKey)
        ? recordedKey
        : generateLegacyCustomProviderKey(providerId, providerConfig, existingKeys);
    migratedProviders[providerId] = customKey;

    if (!isPlainRecord(nextCustomProvider[customKey])) {
      nextCustomProvider[customKey] = toMigratedCustomProvider(providerConfig);
      existingKeys.add(customKey);
      changed = true;
    }

    if (marker.providers[providerId] !== customKey) {
      marker.providers[providerId] = customKey;
      changed = true;
    }
    delete provider[providerId];
    changed = true;
  }

  if (!changed && Object.keys(migratedProviders).length === 0) return empty;

  changed = rewriteModelRefField(raw, 'defaultModel', migratedProviders) || changed;
  changed = rewriteModelRefField(raw, 'defaultLightModel', migratedProviders) || changed;
  changed = rewriteNexusModelProvider(raw, migratedProviders) || changed;

  if (!changed) return { migrated: false, migratedProviders };

  if (Object.keys(nextCustomProvider).length > 0) raw.custom_provider = nextCustomProvider;
  else delete raw.custom_provider;
  writeLegacyMigrationMarker(raw, marker);
  try {
    const backupPath = backupConfigForMigration(configPath);
    writePrivateConfigFileSync(
      configPath,
      yaml.dump(raw, { indent: 2, lineWidth: -1, noRefs: true }),
    );
    return { migrated: true, migratedProviders, backupPath };
  } catch (err) {
    console.warn(`[config] legacy BYOK provider migration skipped: ${formatMigrationError(err)}`);
    return { migrated: false, migratedProviders };
  }
}

// config.yaml lives in the user-writable dataDir, so the provider tree cannot
// be trusted as-is: the builtin managed provider may be deleted or hand-edited.
// In managed runtime every read restores a usable `provider.minimax`: a missing
// or gutted entry is rebuilt from the current preset and missing models/npm are
// backfilled. Protected builds additionally force `baseURL` and `authMode` back
// to the current preset with managed-login. Test builds deliberately preserve
// existing connection fields so developers can route the builtin provider
// through a local fault-injection proxy. In non-managed dev/runtime, an existing
// `provider.minimax` that explicitly points at a managed preset gateway still
// gets the built-in model table only when its managed snapshot is absent, but
// custom endpoints are left untouched. `provider.minimax` remains the builtin managed provider; user
// BYOK for protected builds lives exclusively in the `minimax_api` /
// `custom_provider` trees. The result is never written back to disk, and
// user-owned trees (`minimax_api`, `custom_provider`) are never touched.
// Selection fallback for a dangling defaultModel is owned by the models/select
// layer, not by this read path.
//
// `minimax_api` is additionally a reserved provider id: the resolver matches
// it before falling back to the legacy provider map, so a hand-written
// `provider.minimax_api` entry would be permanently shadowed. It is dropped
// from the effective view with a warning (in every runtime mode).
export function applyRequiredProviderOverrides(
  input: { provider: ModelsConfig; defaultModel?: string },
  deps: RequiredProviderOverrideDeps,
): { provider: ModelsConfig; defaultModel?: string } {
  let provider = input.provider;
  const defaultModel = input.defaultModel;

  if (Object.prototype.hasOwnProperty.call(provider, 'minimax_api')) {
    const { minimax_api: _shadowed, ...rest } = provider;
    provider = rest;
    console.warn(
      '[config] "minimax_api" is a reserved provider id; ignoring provider.minimax_api from config.yaml',
    );
  }

  const preset = deps.getManagedPreset();
  const presetProvider = preset.provider.minimax as ProviderConfig;
  const existing = provider.minimax;
  const managedRuntime = deps.isManagedRuntime();
  const shouldBackfillManagedMinimax =
    managedRuntime || isManagedOriginMinimaxProvider(existing, deps);
  if (!shouldBackfillManagedMinimax) return { provider, defaultModel };

  const existingOptions = existing?.options;
  const enforceProtection = managedRuntime && deps.shouldEnforceManagedProviderProtection();

  // A persisted managed snapshot is the complete model catalog. The built-in
  // preset is used only before the first valid remote snapshot is available.
  // The on-disk config.yaml is never rewritten by this read-time protection.
  const models = mergeManagedModelTables(presetProvider.models, existing?.models);

  // The on-disk apiKey is paired with the on-disk endpoint. When the override
  // discards a non-managed endpoint, the paired key is meaningless against
  // the managed gateway (stable 401) and, worse, a real key bypasses the
  // managed-login "auth token is not synced" sentinel (which only fires on
  // the placeholder). Reset it to the preset placeholder so the sentinel
  // works again. Keys stored alongside a managed-origin endpoint (legacy
  // gateway-key flow) stay valid for the gateway and are preserved.
  const existingBaseURL =
    typeof existingOptions?.baseURL === 'string' && existingOptions.baseURL.length > 0
      ? existingOptions.baseURL
      : undefined;
  const dropPairedApiKey =
    enforceProtection && existingBaseURL != null && !deps.isManagedPresetBaseUrl(existingBaseURL);

  provider = {
    ...provider,
    minimax: {
      ...presetProvider,
      ...(existing ?? {}),
      npm: existing?.npm ?? presetProvider.npm,
      models,
      options: {
        ...(presetProvider.options ?? {}),
        ...(existingOptions ?? {}),
        ...(dropPairedApiKey ? { apiKey: presetProvider.options?.apiKey } : {}),
        ...(enforceProtection
          ? { authMode: 'managed-login', baseURL: presetProvider.options?.baseURL }
          : {}),
      },
    },
  };

  return { provider, defaultModel };
}

function isManagedOriginMinimaxProvider(
  provider: ProviderConfig | undefined,
  deps: RequiredProviderOverrideDeps,
): boolean {
  const options = provider?.options;
  if (options?.authMode === 'managed-login') return true;
  return typeof options?.baseURL === 'string' && deps.isManagedPresetBaseUrl(options.baseURL);
}

function mergeManagedModelTables(
  presetModels: ProviderConfig['models'] | undefined,
  existingModels: ProviderConfig['models'] | undefined,
): ProviderConfig['models'] {
  return existingModels && Object.keys(existingModels).length > 0
    ? existingModels
    : (presetModels ?? {});
}

function readRawConfigForMigration(configPath: string): Record<string, unknown> {
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, 'utf-8'));
    return isPlainRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function shouldMigrateLegacyProvider(
  providerId: string,
  providerConfig: unknown,
  managedProvider: ModelsConfig,
): providerConfig is Record<string, unknown> {
  // Builtin identity is stable even when old config contains a proxy endpoint.
  // Never turn an official Session choice into an API-key provider alias.
  if (providerId === 'minimax' || providerId === 'minimax_api') return false;
  if (!isProviderLikeRecord(providerConfig)) return false;
  if (!hasLegacyByokProviderShape(providerConfig)) return false;
  return !Object.prototype.hasOwnProperty.call(managedProvider, providerId);
}

function hasLegacyByokProviderShape(providerConfig: Record<string, unknown>): boolean {
  const options = isPlainRecord(providerConfig.options) ? providerConfig.options : undefined;
  return (
    typeof options?.apiKey === 'string' &&
    options.apiKey.trim().length > 0 &&
    typeof options.baseURL === 'string' &&
    options.baseURL.trim().length > 0 &&
    isPlainRecord(providerConfig.models)
  );
}

function toMigratedCustomProvider(
  providerConfig: Record<string, unknown>,
): Record<string, unknown> {
  const options = isPlainRecord(providerConfig.options) ? providerConfig.options : {};
  return {
    ...providerConfig,
    kind: 'custom',
    enabled: providerConfig.enabled !== false,
    options: {
      ...options,
      authMode: 'api-key',
    },
  };
}

function generateLegacyCustomProviderKey(
  providerId: string,
  providerConfig: unknown,
  existingKeys: Set<string>,
): string {
  const record = isPlainRecord(providerConfig) ? providerConfig : {};
  const name = typeof record.name === 'string' ? record.name : undefined;
  const fallback = `provider-${stableHash(providerId)}`;
  const base = slugify(providerId) ?? slugify(name) ?? fallback;
  for (let suffix = 0; ; suffix += 1) {
    const candidate = suffix === 0 ? base : `${base}-${suffix + 1}`;
    if (!existingKeys.has(candidate) && !RESERVED_CUSTOM_PROVIDER_KEYS.has(candidate)) {
      return candidate;
    }
  }
}

function slugify(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !SIMPLE_ASCII_NAME.test(trimmed)) return undefined;
  const slug = trimmed
    .toLowerCase()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || undefined;
}

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function rewriteModelRefField(
  raw: Record<string, unknown>,
  field: 'defaultModel' | 'defaultLightModel',
  migratedProviders: Record<string, string>,
): boolean {
  const value = raw[field];
  if (typeof value !== 'string') return false;
  const next = rewriteModelRef(value, migratedProviders);
  if (next === value) return false;
  raw[field] = next;
  return true;
}

function rewriteModelRef(value: string, migratedProviders: Record<string, string>): string {
  const slash = value.indexOf('/');
  if (slash <= 0 || slash === value.length - 1) return value;
  const providerId = value.slice(0, slash);
  const customKey = migratedProviders[providerId];
  if (!customKey) return value;
  return `custom_provider:${customKey}/${value.slice(slash + 1)}`;
}

function rewriteNexusModelProvider(
  raw: Record<string, unknown>,
  migratedProviders: Record<string, string>,
): boolean {
  if (!isPlainRecord(raw.nexus) || !isPlainRecord(raw.nexus.model)) return false;
  const providerID = raw.nexus.model.providerID;
  if (typeof providerID !== 'string') return false;
  const customKey = migratedProviders[providerID];
  if (!customKey) return false;
  raw.nexus.model.providerID = `custom_provider:${customKey}`;
  return true;
}

/** Repair old backups without making archival maintenance a config-load dependency. */
export function restrictLegacyByokBackups(configPath: string): void {
  if (process.platform === 'win32') return;
  const directory = path.dirname(configPath);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    console.warn(
      `[config] Could not inspect legacy BYOK backups in ${JSON.stringify(directory)}. ` +
      'Backup permissions were not verified; check directory access and restrict backup permissions manually.',
    );
    return;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith(LEGACY_BYOK_BACKUP_PREFIX)) {
      const backupPath = path.join(directory, entry.name);
      try {
        restrictConfigFileSync(backupPath);
      } catch {
        // Do not expose arbitrary error messages that could contain config content.
        console.warn(
          `[config] Could not restrict legacy BYOK backup ${JSON.stringify(backupPath)}. ` +
          'It may still be readable by other users; restrict its permissions manually.',
        );
      }
    }
  }
}

function backupConfigForMigration(configPath: string): string {
  const backupPath = path.join(
    path.dirname(configPath),
    `${LEGACY_BYOK_BACKUP_PREFIX}${Date.now()}.${randomUUID()}`,
  );
  restrictConfigFileSync(configPath);
  writePrivateConfigFileSync(backupPath, fs.readFileSync(configPath), true);
  return backupPath;
}

function readLegacyMigrationMarker(raw: Record<string, unknown>): {
  providers: Record<string, string>;
} {
  const migrations = isPlainRecord(raw.migrations) ? raw.migrations : undefined;
  const marker = migrations?.[LEGACY_BYOK_MIGRATION_KEY];
  const providers =
    isPlainRecord(marker) && isPlainRecord(marker.providers)
      ? Object.fromEntries(
          Object.entries(marker.providers).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : {};
  return { providers };
}

function writeLegacyMigrationMarker(
  raw: Record<string, unknown>,
  marker: { providers: Record<string, string> },
): void {
  const migrations = isPlainRecord(raw.migrations) ? raw.migrations : {};
  migrations[LEGACY_BYOK_MIGRATION_KEY] = {
    version: 1,
    providers: marker.providers,
  };
  raw.migrations = migrations;
}

function isProviderLikeRecord(value: unknown): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false;
  return (
    typeof value.name === 'string' ||
    typeof value.npm === 'string' ||
    typeof value.api === 'string' ||
    isPlainRecord(value.options) ||
    isPlainRecord(value.models)
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function formatMigrationError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
