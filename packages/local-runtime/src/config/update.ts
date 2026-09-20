import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { getConfig, getConfigPath, MINIMAX_API_MODEL_CATALOG, resetConfig } from '@mavis/config';
import yaml from 'js-yaml';
import lockfile from 'proper-lockfile';

import type { LocalRuntimeConfig } from './types.js';

// BYOK trees ('minimax_api', 'custom_provider') are intentionally excluded
// from both whitelists below: they hold plaintext API keys and must only be
// written through the dedicated ModelProvider API. Allowing them here would
// reopen the masked-value read-modify-write hazard — GET /config returns
// masked keys, so writing that payload back would clobber the real keys.
const LOCAL_CONFIG_MUTABLE_FIELDS = new Set([
  'permissionMode',
  'defaultModel',
  'defaultModelVariant',
  'defaultLightModel',
  'provider',
  'asr',
  'sseErrorPush',
  'beta',
  'nexus',
  'thinking',
  'memory',
  'review',
  'agents',
]);

const LOCAL_CONFIG_DOTTED_MUTABLE_ROOTS = new Set([
  'provider',
  'asr',
  'sseErrorPush',
  'beta',
  'nexus',
  'thinking',
  'memory',
  'agents',
]);

const LOCAL_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'auto',
  'off',
]);

const LOCAL_CONFIG_WRITE_ERROR_MESSAGE = 'Local runtime failed to update config file';
const LOCAL_CONFIG_FILE_MODE = 0o600;
const DANGEROUS_CONFIG_PATH_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

class LocalConfigValidationError extends Error {
  override name = 'LocalConfigValidationError';
}

class LocalConfigWriteError extends Error {
  override name = 'LocalConfigWriteError';

  constructor() {
    super(LOCAL_CONFIG_WRITE_ERROR_MESSAGE);
  }
}

export interface LocalConfigUpdateResult {
  config: LocalRuntimeConfig;
}

export interface LocalModelContextCompareAndSetResult extends LocalConfigUpdateResult {
  updated: boolean;
}

export async function updateLocalConfigFile(
  body: Record<string, unknown>,
  extraMutableRoots: ReadonlySet<string> = new Set(),
  preparedCommitPayload?: Readonly<Record<string, unknown>>,
): Promise<LocalConfigUpdateResult> {
  const configPath = getConfigPath();
  let release: (() => Promise<void>) | undefined;
  try {
    await fs.promises.mkdir(dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, '', { flag: 'a', mode: LOCAL_CONFIG_FILE_MODE });
    await fs.promises.chmod(configPath, LOCAL_CONFIG_FILE_MODE);
    release = await lockfile.lock(configPath, {
      stale: 10_000,
      retries: { retries: 20, factor: 1, minTimeout: 5, maxTimeout: 25 },
    });
    const raw = readLocalRawConfig(configPath);
    if (preparedCommitPayload) {
      assertSafeConfigRecord({ ...preparedCommitPayload });
      const invalidRoot = Object.keys(preparedCommitPayload).find(
        (root) => !extraMutableRoots.has(root) || DANGEROUS_CONFIG_PATH_SEGMENTS.has(root),
      );
      if (invalidRoot) {
        throw new LocalConfigValidationError(
          `Local runtime cannot update config field "${invalidRoot}"`,
        );
      }
      Object.assign(raw, preparedCommitPayload);
    } else {
      applyLocalConfigUpdate(raw, body);
    }
    await atomicWriteFile(configPath, yaml.dump(raw, { indent: 2, lineWidth: -1, noRefs: true }));
    resetConfig();
    return { config: getConfig() };
  } catch (err) {
    throw toLocalConfigError(err);
  } finally {
    await release?.().catch(() => undefined);
  }
}

export async function compareAndSetLocalModelContext(
  input: {
    providerId: string;
    modelId: string;
    expectedContextLimit: number;
    contextLimit: number;
  },
  beforeCommit: (currentConfig: LocalRuntimeConfig) => Promise<boolean>,
): Promise<LocalModelContextCompareAndSetResult> {
  const modelId = input.modelId.trim();
  if (
    (input.providerId !== 'minimax' && input.providerId !== 'minimax_api') ||
    !modelId ||
    DANGEROUS_CONFIG_PATH_SEGMENTS.has(modelId)
  ) {
    throw new LocalConfigValidationError('Invalid MiniMax model context target');
  }
  if (
    input.providerId === 'minimax_api' &&
    !MINIMAX_API_MODEL_CATALOG[modelId]?.contextWindowOptions?.includes(input.contextLimit)
  ) {
    throw new LocalConfigValidationError('Invalid MiniMax API context limit');
  }
  const configPath = getConfigPath();
  let release: (() => Promise<void>) | undefined;
  try {
    await fs.promises.mkdir(dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, '', { flag: 'a', mode: LOCAL_CONFIG_FILE_MODE });
    await fs.promises.chmod(configPath, LOCAL_CONFIG_FILE_MODE);
    release = await lockfile.lock(configPath, {
      stale: 10_000,
      retries: { retries: 20, factor: 1, minTimeout: 5, maxTimeout: 25 },
    });
    const raw = readLocalRawConfig(configPath);
    resetConfig();
    const currentConfig = getConfig() as LocalRuntimeConfig;
    const currentContext =
      input.providerId === 'minimax'
        ? currentConfig.provider?.minimax?.models?.[modelId]?.limit?.context
        : currentMinimaxApiContext(currentConfig, modelId);
    if (currentContext !== input.expectedContextLimit) {
      return { updated: false, config: currentConfig };
    }
    if (!(await beforeCommit(currentConfig))) {
      return { updated: false, config: currentConfig };
    }
    if (input.providerId === 'minimax') {
      const modelContextLimits = isPlainRecord(raw.minimaxModelContextLimits)
        ? raw.minimaxModelContextLimits
        : {};
      raw.minimaxModelContextLimits = {
        ...modelContextLimits,
        [modelId]: input.contextLimit,
      };
    } else {
      const minimaxApi = isPlainRecord(raw.minimax_api) ? raw.minimax_api : {};
      const modelContextLimits = isPlainRecord(minimaxApi.modelContextLimits)
        ? minimaxApi.modelContextLimits
        : {};
      raw.minimax_api = {
        ...minimaxApi,
        modelContextLimits: { ...modelContextLimits, [modelId]: input.contextLimit },
      };
    }
    assertSafeConfigRecord(raw);
    await atomicWriteFile(configPath, yaml.dump(raw, { indent: 2, lineWidth: -1, noRefs: true }));
    resetConfig();
    return { updated: true, config: getConfig() as LocalRuntimeConfig };
  } catch (err) {
    throw toLocalConfigError(err);
  } finally {
    await release?.().catch(() => undefined);
  }
}

function currentMinimaxApiContext(config: LocalRuntimeConfig, modelId: string): number | undefined {
  const model = MINIMAX_API_MODEL_CATALOG[modelId];
  const override = config.minimax_api?.modelContextLimits?.[modelId];
  return override !== undefined && model?.contextWindowOptions?.includes(override)
    ? override
    : model?.limit?.context;
}

// ── BYOK dedicated write path ──────────────────────────────────────────────
// The generic PUT /config route can never write the BYOK trees (see the
// whitelist note above). The ModelProvider API uses this dedicated function
// instead: same lock + atomic-write semantics, but scoped to exactly the two
// BYOK roots and never reachable from a request-body field name.

export interface LocalByokConfigDraft {
  minimax_api?: Record<string, unknown>;
  custom_provider?: Record<string, unknown>;
  minimaxModelSource?: 'token_plan' | 'minimax_api_key';
  defaultModel?: string;
  defaultModelVariant?: string;
}

const LOCAL_BYOK_CONFIG_ROOTS = ['minimax_api', 'custom_provider'] as const;

/**
 * Drops null/non-object entries from a BYOK subtree. A retired provider can
 * survive in config as a bare `key: null` (e.g. `oaii-oauth: null`), which is
 * not a usable provider config; keeping it would make every consumer that
 * walks the tree dereference null.
 */
function withoutEmptyEntries(
  subtree: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!subtree) return undefined;
  return Object.fromEntries(Object.entries(subtree).filter(([, value]) => isPlainRecord(value)));
}

export async function updateLocalByokConfig(
  mutate: (draft: LocalByokConfigDraft, currentConfig: LocalRuntimeConfig) => void | Promise<void>,
): Promise<LocalConfigUpdateResult> {
  const configPath = getConfigPath();
  let release: (() => Promise<void>) | undefined;
  try {
    await fs.promises.mkdir(dirname(configPath), { recursive: true });
    await fs.promises.writeFile(configPath, '', { flag: 'a', mode: LOCAL_CONFIG_FILE_MODE });
    await fs.promises.chmod(configPath, LOCAL_CONFIG_FILE_MODE);
    release = await lockfile.lock(configPath, {
      stale: 10_000,
      retries: { retries: 20, factor: 1, minTimeout: 5, maxTimeout: 25 },
    });
    const raw = readLocalRawConfig(configPath);
    const draft: LocalByokConfigDraft = {
      minimax_api: isPlainRecord(raw.minimax_api) ? raw.minimax_api : undefined,
      custom_provider: withoutEmptyEntries(
        isPlainRecord(raw.custom_provider) ? raw.custom_provider : undefined,
      ),
      minimaxModelSource:
        typeof raw.minimaxModelSource === 'string'
          ? (raw.minimaxModelSource as 'token_plan' | 'minimax_api_key')
          : undefined,
      defaultModel: typeof raw.defaultModel === 'string' ? raw.defaultModel : undefined,
      defaultModelVariant:
        typeof raw.defaultModelVariant === 'string' ? raw.defaultModelVariant : undefined,
    };
    resetConfig();
    await mutate(draft, getConfig() as LocalRuntimeConfig);
    for (const root of LOCAL_BYOK_CONFIG_ROOTS) {
      const value = draft[root];
      if (value === undefined) {
        delete raw[root];
        continue;
      }
      if (!isPlainRecord(value)) {
        throw new LocalConfigValidationError(`Invalid BYOK config subtree "${root}"`);
      }
      assertSafeConfigRecord(value);
      raw[root] = value;
    }
    if (draft.minimaxModelSource) {
      raw.minimaxModelSource = draft.minimaxModelSource;
    } else if (draft.minimaxModelSource === undefined && 'minimaxModelSource' in raw) {
      delete raw.minimaxModelSource;
    }
    if (draft.defaultModel) {
      raw.defaultModel = draft.defaultModel;
    } else if (draft.defaultModel === undefined && 'defaultModel' in raw) {
      delete raw.defaultModel;
    }
    if (draft.defaultModelVariant) {
      raw.defaultModelVariant = draft.defaultModelVariant;
    } else if (draft.defaultModelVariant === undefined && 'defaultModelVariant' in raw) {
      delete raw.defaultModelVariant;
    }
    await atomicWriteFile(configPath, yaml.dump(raw, { indent: 2, lineWidth: -1, noRefs: true }));
    resetConfig();
    return { config: getConfig() };
  } catch (err) {
    throw toLocalConfigError(err);
  } finally {
    await release?.().catch(() => undefined);
  }
}

export async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const tmpPath = join(dirname(filePath), `.config-tmp-${randomBytes(6).toString('hex')}`);
  let created = false;
  try {
    const mode = LOCAL_CONFIG_FILE_MODE;
    const temporary = await fs.promises.open(tmpPath, 'wx', mode);
    created = true;
    try {
      await temporary.writeFile(content, 'utf-8');
      await temporary.chmod(mode);
    } finally {
      await temporary.close();
    }
    await fs.promises.rename(tmpPath, filePath);
  } catch {
    if (created) await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw new LocalConfigWriteError();
  }
}

function readLocalRawConfig(configPath: string): Record<string, unknown> {
  // Callers create missing files before locking. A read failure must abort the
  // update rather than turn an existing configuration into an empty document.
  const source = fs.readFileSync(configPath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = yaml.load(source);
  } catch {
    // YAML errors include source snippets, which may contain credentials.
    throw new LocalConfigValidationError('Invalid config.yaml: unable to parse YAML');
  }
  if (parsed == null) return {};
  if (!isPlainRecord(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) {
    throw new LocalConfigValidationError('Invalid config.yaml: expected a YAML mapping');
  }
  return parsed;
}

function applyLocalConfigUpdate(raw: Record<string, unknown>, body: Record<string, unknown>): void {
  const field = typeof body.field === 'string' ? body.field : undefined;
  if (field) {
    assertMutableConfigField(field);
    if (Object.prototype.hasOwnProperty.call(body, 'set')) {
      applyLocalConfigSet(raw, field, body.set);
      if (field === 'defaultModel') delete raw.defaultModelVariant;
      return;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'put')) {
      if (field === 'review.mode') {
        throw new LocalConfigValidationError(`Unsupported config update operation for ${field}`);
      }
      const [target, key] = resolvePath(raw, field);
      const current = isPlainRecord(target[key]) ? target[key] : {};
      const patch = isPlainRecord(body.put) ? body.put : {};
      assertSafeConfigRecord(patch);
      target[key] = deepMergeRecord(
        current,
        field === 'review' ? validateReviewConfigRecord(patch) : patch,
      );
      return;
    }
    throw new LocalConfigValidationError(`Unsupported config update operation for ${field}`);
  }

  const updatesDefaultModel = Object.prototype.hasOwnProperty.call(body, 'defaultModel');
  const updatesDefaultModelVariant = Object.prototype.hasOwnProperty.call(
    body,
    'defaultModelVariant',
  );
  for (const [key, value] of Object.entries(body)) {
    applyLocalConfigSet(raw, key, value);
  }
  if (updatesDefaultModel && !updatesDefaultModelVariant) delete raw.defaultModelVariant;
}

function applyLocalConfigSet(raw: Record<string, unknown>, field: string, value: unknown): void {
  assertMutableConfigField(field);
  const [target, key] = resolvePath(raw, field);
  if (field === 'defaultModelVariant' && value === null) {
    delete target[key];
    return;
  }
  target[key] = validateLocalConfigValue(field, value);
}

function assertMutableConfigField(field: string): void {
  if (field === 'permission.policyOwner' || field === 'permission.storageWriteVersion') return;
  const parts = field.split('.');
  const [root, ...children] = parts;
  if (
    !root ||
    parts.some((part) => !part || DANGEROUS_CONFIG_PATH_SEGMENTS.has(part)) ||
    !LOCAL_CONFIG_MUTABLE_FIELDS.has(root) ||
    (children.length > 0 &&
      (root === 'review' ? field !== 'review.mode' : !LOCAL_CONFIG_DOTTED_MUTABLE_ROOTS.has(root)))
  ) {
    throw new LocalConfigValidationError(`Local runtime cannot update config field "${field}"`);
  }
}

function assertSafeConfigRecord(record: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(record)) {
    if (!key || DANGEROUS_CONFIG_PATH_SEGMENTS.has(key)) {
      throw new LocalConfigValidationError(
        `Local runtime cannot update config field segment "${key}"`,
      );
    }
    if (isPlainRecord(value)) assertSafeConfigRecord(value);
  }
}

function validateLocalConfigValue(field: string, value: unknown): unknown {
  if (field === 'permission.policyOwner') {
    if (value === 'engine' || value === 'core') return value;
    throw new LocalConfigValidationError(`Invalid permission.policyOwner "${String(value)}"`);
  }
  if (field === 'permission.storageWriteVersion') {
    if (value === 1 || value === 2) return value;
    throw new LocalConfigValidationError(
      `Invalid permission.storageWriteVersion "${String(value)}"`,
    );
  }
  if (field === 'permissionMode') {
    if (typeof value === 'string' && LOCAL_PERMISSION_MODES.has(value)) return value;
    throw new LocalConfigValidationError(`Invalid permissionMode "${String(value)}"`);
  }
  if (field === 'review.mode') {
    return validateReviewMode(value);
  }
  if (field === 'review') {
    if (!isPlainRecord(value)) {
      throw new LocalConfigValidationError('Invalid review config');
    }
    return validateReviewConfigRecord(value);
  }
  if (field === 'defaultModelVariant' && typeof value !== 'string') {
    throw new LocalConfigValidationError(`Invalid defaultModelVariant "${String(value)}"`);
  }
  return value;
}

function validateReviewConfigRecord(value: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(value);
  const invalidKey = keys.find((key) => key !== 'mode');
  if (invalidKey) {
    throw new LocalConfigValidationError(
      `Local runtime cannot update config field "review.${invalidKey}"`,
    );
  }
  return Object.prototype.hasOwnProperty.call(value, 'mode')
    ? { mode: validateReviewMode(value.mode) }
    : {};
}

function validateReviewMode(value: unknown): 'inline' | 'subagent' {
  if (value === 'inline' || value === 'subagent') return value;
  throw new LocalConfigValidationError(`Invalid review.mode "${String(value)}"`);
}

function deepMergeRecord(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] =
      isPlainRecord(value) && isPlainRecord(out[key]) ? deepMergeRecord(out[key], value) : value;
  }
  return out;
}

function resolvePath(
  raw: Record<string, unknown>,
  field: string,
): [Record<string, unknown>, string] {
  const parts = field.split('.');
  const target = parts.slice(0, -1).reduce(ensurePlainRecordChild, raw);
  return [target, parts.at(-1) ?? field];
}

function ensurePlainRecordChild(
  target: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = Object.prototype.hasOwnProperty.call(target, key) ? target[key] : undefined;
  if (isPlainRecord(value)) return value;
  const child: Record<string, unknown> = {};
  target[key] = child;
  return child;
}

function toLocalConfigError(err: unknown): Error {
  if (err instanceof LocalConfigValidationError || err instanceof LocalConfigWriteError) return err;
  return new LocalConfigWriteError();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
