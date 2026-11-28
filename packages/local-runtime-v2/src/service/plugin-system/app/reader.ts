import { readPluginJsonObject, type CanonicalPluginRoot } from '../plugin/package/filesystem.js';
import { readerFail } from '../plugin/package/reader-errors.js';
import type { PluginAppReference } from '../plugin/package/types.js';

const APP_FIELDS = new Set(['$schema', 'schemaVersion', 'provider']);
const CONNECTOR_PROVIDER = /^[a-z0-9_-]{1,64}$/u;

/**
 * The App reference contract on already-parsed JSON: only `$schema`, `schemaVersion: 1`
 * and a connector `provider`. Returns undefined for anything else.
 */
export function parseAppReference(value: Record<string, unknown>): PluginAppReference | undefined {
  if (
    Object.keys(value).some((key) => !APP_FIELDS.has(key)) ||
    (value.$schema !== undefined && typeof value.$schema !== 'string') ||
    value.schemaVersion !== 1 ||
    typeof value.provider !== 'string' ||
    !CONNECTOR_PROVIDER.test(value.provider)
  ) {
    return undefined;
  }
  return { provider: value.provider };
}

export async function readAppReference(
  root: CanonicalPluginRoot,
  relativePath: string,
): Promise<PluginAppReference> {
  const { value } = await readPluginJsonObject(root, relativePath, { portable: true });
  return (
    parseAppReference(value) ??
    readerFail('APP_SCHEMA_INVALID', `${relativePath} has an invalid App reference`)
  );
}
