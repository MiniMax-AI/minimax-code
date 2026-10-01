import { readdirSync, readFileSync, statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { Ajv, type ValidateFunction } from 'ajv';
import {
  TUI_SYNTAX_TONE_NAMES,
  TUI_THEME_COLOR_NAMES,
  type TuiResolvedAppearance,
  type TuiThemeColors,
  type TuiThemeDefinition,
  type TuiThemePalette,
  type TuiThemeSyntaxTones,
} from './contracts.js';
import { BUILT_IN_THEMES, DEFAULT_THEME_ID, defaultPalette } from './palettes.js';

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;
const THEME_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/iu;

/**
 * A color entry is a hex literal, the empty string for "terminal default", or
 * a `vars` name. References are resolved after schema validation, so the schema
 * only has to accept the identifier shape; an unresolvable name fails with a
 * readable message from {@link resolveValue}.
 */
const COLOR_SCHEMA = {
  anyOf: [
    { type: 'string', pattern: '^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' },
    { type: 'string', maxLength: 0 },
    { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_-]*$' },
  ],
} as const;

/**
 * `vars` holds literal colors only. Allowing an identifier here would let a
 * nested reference pass validation and then fail during resolution with a
 * confusing message, so reject it up front instead.
 */
const VAR_SCHEMA = {
  anyOf: [
    { type: 'string', pattern: '^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' },
    { type: 'string', maxLength: 0 },
  ],
} as const;

const THEME_FILE_SCHEMA = {
  type: 'object',
  required: ['name', 'appearance', 'colors'],
  additionalProperties: false,
  properties: {
    $schema: { type: 'string' },
    name: { type: 'string', pattern: THEME_ID.source },
    label: { type: 'string', minLength: 1, maxLength: 40 },
    description: { type: 'string', maxLength: 120 },
    appearance: { enum: ['dark', 'light'] },
    vars: {
      type: 'object',
      additionalProperties: VAR_SCHEMA,
    },
    colors: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(TUI_THEME_COLOR_NAMES.map((name) => [name, COLOR_SCHEMA])),
    },
    syntax: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(TUI_SYNTAX_TONE_NAMES.map((name) => [name, COLOR_SCHEMA])),
    },
  },
} as const;

interface CustomThemeDocument {
  readonly name: string;
  readonly label?: string;
  readonly description?: string;
  readonly appearance: TuiResolvedAppearance;
  readonly vars?: Readonly<Record<string, string>>;
  readonly colors: Readonly<Partial<Record<keyof TuiThemeColors, string>>>;
  readonly syntax?: Readonly<Partial<TuiThemeSyntaxTones>>;
}

export interface TuiThemeLoadIssue {
  readonly filePath: string;
  readonly message: string;
}

export interface TuiThemeLoadResult {
  readonly themes: readonly TuiThemeDefinition[];
  readonly issues: readonly TuiThemeLoadIssue[];
}

/** Directory MCode scans for user-authored theme files. */
export function customThemesDirectory(dataDir: string): string {
  return path.join(dataDir, 'tui', 'themes');
}

let cachedValidator: ValidateFunction | undefined;

function themeFileValidator(): ValidateFunction {
  if (cachedValidator) return cachedValidator;
  const validator = new Ajv({ allErrors: true, strict: false }).compile(THEME_FILE_SCHEMA);
  cachedValidator = validator;
  return validator;
}

interface StagedVariant extends TuiThemePalette {
  readonly filePath: string;
}

/**
 * Resolve one `colors` / `syntax` value: an explicit hex, a `vars` reference,
 * or the empty string meaning "terminal default".
 */
function resolveValue(
  value: string,
  vars: Readonly<Record<string, string>>,
  fallback: string,
  filePath: string,
): string {
  if (value === '') return '';
  if (HEX_COLOR.test(value)) return value.toUpperCase();
  const referenced = vars[value];
  if (referenced === undefined) {
    throw new Error(`"${value}" is not a hex color or a name defined in "vars"`);
  }
  if (referenced === '') return '';
  if (!HEX_COLOR.test(referenced)) {
    throw new Error(`vars.${value} = "${referenced}" is not a hex color`);
  }
  void filePath;
  return referenced.toUpperCase();
}

function buildVariant(document: CustomThemeDocument, filePath: string): StagedVariant {
  const vars = document.vars ?? {};
  const base = defaultPalette(document.appearance);
  const colors = { ...base.colors } as Record<keyof TuiThemeColors, string>;
  for (const [key, value] of Object.entries(document.colors)) {
    const role = key as keyof TuiThemeColors;
    const raw = value as string;
    colors[role] = resolveValue(raw, vars, colors[role], filePath) || colors[role];
  }
  const syntax = { ...base.syntax } as Record<keyof TuiThemeSyntaxTones, string>;
  for (const [key, value] of Object.entries(document.syntax ?? {})) {
    const tone = key as keyof TuiThemeSyntaxTones;
    syntax[tone] = resolveValue(value as string, vars, syntax[tone], filePath) || syntax[tone];
  }
  return {
    id: document.name,
    appearance: document.appearance,
    colors: Object.freeze(colors) as TuiThemeColors,
    syntax: Object.freeze(syntax) as TuiThemeSyntaxTones,
    filePath,
  };
}

function readThemeFile(filePath: string): CustomThemeDocument | Error {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/u, '')) as unknown;
    const validate = themeFileValidator();
    if (!validate(raw)) {
      const detail = (validate.errors ?? [])
        .slice(0, 4)
        .map((error) => `${error.instancePath || '/'} ${error.message ?? 'is invalid'}`.trim())
        .join('; ');
      return new Error(detail || 'does not match the theme schema');
    }
    return raw as CustomThemeDocument;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Load every `*.json` under `<dataDir>/tui/themes`.
 *
 * A theme is assembled from one file per appearance: `aurora.json` plus
 * `aurora-light.json` form a single selectable `aurora` theme. Any appearance a
 * custom theme does not provide falls back to the default palette so selecting
 * the theme never breaks rendering on a terminal of the other appearance.
 * Built-in ids always win over a same-named file so a stray file cannot shadow
 * a shipped theme.
 */
export function loadCustomThemes(dataDir: string): TuiThemeLoadResult {
  const directory = customThemesDirectory(dataDir);
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return { themes: [], issues: [] };
  }

  const builtinIds = new Set(BUILT_IN_THEMES.map((theme) => theme.id));
  const staged = new Map<
    string,
    { label?: string; description?: string; variants: StagedVariant[] }
  >();
  const issues: TuiThemeLoadIssue[] = [];

  for (const entry of entries.sort()) {
    if (!entry.toLowerCase().endsWith('.json')) continue;
    const filePath = path.join(directory, entry);
    try {
      if (!statSync(filePath).isFile()) continue;
    } catch {
      continue;
    }
    const document = readThemeFile(filePath);
    if (document instanceof Error) {
      issues.push({ filePath, message: document.message });
      continue;
    }
    if (builtinIds.has(document.name)) {
      issues.push({
        filePath,
        message: `"${document.name}" is a built-in theme id and is ignored`,
      });
      continue;
    }
    let variant: StagedVariant;
    try {
      variant = buildVariant(document, filePath);
    } catch (error) {
      issues.push({ filePath, message: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const group = staged.get(document.name) ?? { variants: [] };
    if (document.label) group.label = document.label;
    if (document.description) group.description = document.description;
    const existing = group.variants.findIndex(
      (candidate) => candidate.appearance === variant.appearance,
    );
    if (existing >= 0) group.variants.splice(existing, 1, variant);
    else group.variants.push(variant);
    staged.set(document.name, group);
  }

  const themes: TuiThemeDefinition[] = [];
  for (const [id, group] of staged) {
    const supplied = new Map(group.variants.map((variant) => [variant.appearance, variant]));
    const pick = (appearance: TuiResolvedAppearance): TuiThemePalette => {
      const variant = supplied.get(appearance);
      if (variant) return variant;
      // The file did not supply this appearance; borrow the default palette so
      // selecting the theme still renders correctly on a terminal of that kind.
      return { ...defaultPalette(appearance), id };
    };
    themes.push(
      Object.freeze({
        id,
        label: group.label ?? id,
        ...(group.description ? { description: group.description } : {}),
        source: 'custom',
        dark: pick('dark'),
        light: pick('light'),
        filePath: group.variants[0]?.filePath,
      }),
    );
  }

  return { themes, issues };
}

/**
 * Watch the custom theme directory and re-run the loader on change so editing a
 * theme file updates the TUI without a restart. The watcher is a convenience:
 * a failure to watch (missing directory, inotify limit) must never block the
 * TUI, so errors collapse into a no-op.
 */
export function watchCustomThemes(
  dataDir: string,
  onChange: (result: TuiThemeLoadResult) => void,
): () => void {
  const directory = customThemesDirectory(dataDir);
  let watcher: FSWatcher | undefined;
  let timer: NodeJS.Timeout | undefined;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      try {
        onChange(loadCustomThemes(dataDir));
      } catch {
        // A reload failure must never break the running session.
      }
    }, 150);
    timer.unref?.();
  };
  try {
    watcher = watch(directory, { persistent: false }, fire);
    watcher.on('error', () => undefined);
    // Native watching may miss edits made while it starts (notably on macOS).
    // Reconcile once after registration, then use the same debounced event path.
    fire();
  } catch {
    watcher = undefined;
  }
  return () => {
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}

export { DEFAULT_THEME_ID };
