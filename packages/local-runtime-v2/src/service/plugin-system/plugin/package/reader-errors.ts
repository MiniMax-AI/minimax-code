import type { PluginReaderDiagnostic } from './types.js';

const MAX_IGNORED_MANIFEST_FIELD_DIAGNOSTICS = 32;

export class PluginReaderError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'PluginReaderError';
  }
}

export function readerFail(code: string, detail: string): never {
  throw new PluginReaderError(code, detail);
}

/**
 * Newer packages may declare manifest fields this client does not understand.
 * They are ignored instead of rejecting the package; diagnostics name the field
 * only, never its value, and are capped per package.
 */
export function ignoredManifestFieldDiagnostics(
  manifest: Readonly<Record<string, unknown>>,
  knownFields: ReadonlySet<string>,
): PluginReaderDiagnostic[] {
  const fields = Object.keys(manifest).filter((field) => !knownFields.has(field));
  const diagnostics: PluginReaderDiagnostic[] = fields
    .slice(0, MAX_IGNORED_MANIFEST_FIELD_DIAGNOSTICS)
    .map((field) => ({ code: 'MANIFEST_UNKNOWN_FIELD_IGNORED', name: field }));
  if (fields.length > MAX_IGNORED_MANIFEST_FIELD_DIAGNOSTICS) {
    diagnostics.push({ code: 'MANIFEST_UNKNOWN_FIELDS_TRUNCATED' });
  }
  return diagnostics;
}
