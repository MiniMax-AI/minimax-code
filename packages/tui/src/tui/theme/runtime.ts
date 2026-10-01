import { Chalk, type ChalkInstance } from 'chalk';
import { highlight, supportsLanguage } from 'cli-highlight';
import type { MarkdownTheme } from '../engine/public.js';
import { detectProcessTerminalCapabilities } from '../platform/terminal-capabilities.js';
import type { EditorTheme } from '../widgets/editor/editor.js';
import type { SelectListTheme } from '../widgets/select-list.js';
import type {
  TuiColorLevel,
  TuiThemeColors,
  TuiThemePalette,
  TuiThemeSyntaxTones,
} from './contracts.js';
import { resolveTuiAnsi16Foreground, shouldSuppressTuiAnsi16Background } from './ansi16.js';
import { resolveEnvironmentAppearance } from './detection.js';
import { MINIMAX_CODE_DARK_THEME, MINIMAX_CODE_LIGHT_THEME } from './palettes.js';
import { createSyntaxHighlightTheme } from './syntax.js';

export interface TuiRenderThemeSnapshot {
  readonly name: string;
  readonly appearance: 'light' | 'dark';
  readonly colorLevel: TuiColorLevel;
  readonly signature: string;
}

const initialCapabilities = detectProcessTerminalCapabilities();
const initialAppearance = resolveEnvironmentAppearance(process.env).appearance;
let renderThemeSnapshot: TuiRenderThemeSnapshot = {
  name: 'minimax',
  appearance: initialAppearance,
  colorLevel: initialCapabilities.colorLevel,
  signature: '',
};
let activeColors: TuiThemeColors =
  initialAppearance === 'light' ? MINIMAX_CODE_LIGHT_THEME.colors : MINIMAX_CODE_DARK_THEME.colors;
let activeSyntax: TuiThemeSyntaxTones =
  initialAppearance === 'light' ? MINIMAX_CODE_LIGHT_THEME.syntax : MINIMAX_CODE_DARK_THEME.syntax;
renderThemeSnapshot = {
  ...renderThemeSnapshot,
  signature: paletteSignature(
    initialAppearance === 'light' ? MINIMAX_CODE_LIGHT_THEME : MINIMAX_CODE_DARK_THEME,
  ),
};

export const tuiColors: TuiThemeColors = Object.freeze({
  get brand() {
    return activeColors.brand;
  },
  get wordmarkHighlight() {
    return activeColors.wordmarkHighlight;
  },
  get wordmarkShadow() {
    return activeColors.wordmarkShadow;
  },
  get signal() {
    return activeColors.signal;
  },
  get orbit() {
    return activeColors.orbit;
  },
  get accent() {
    return activeColors.accent;
  },
  get markdownHeading() {
    return activeColors.markdownHeading;
  },
  get markdownCode() {
    return activeColors.markdownCode;
  },
  get markdownLink() {
    return activeColors.markdownLink;
  },
  get userMessageBg() {
    return activeColors.userMessageBg;
  },
  get diffAddedBg() {
    return activeColors.diffAddedBg;
  },
  get diffRemovedBg() {
    return activeColors.diffRemovedBg;
  },
  get text() {
    return activeColors.text;
  },
  get muted() {
    return activeColors.muted;
  },
  get dim() {
    return activeColors.dim;
  },
  get border() {
    return activeColors.border;
  },
  get line() {
    return activeColors.line;
  },
  get success() {
    return activeColors.success;
  },
  get warning() {
    return activeColors.warning;
  },
  get error() {
    return activeColors.error;
  },
});

export function createTuiChalk(options: {
  readonly isTTY?: boolean;
  readonly noColor?: boolean;
  readonly colorLevel?: TuiColorLevel;
}): ChalkInstance {
  const level =
    options.isTTY === false || options.noColor
      ? (0 as const)
      : (options.colorLevel ?? (3 as const));
  return new Chalk({ level });
}

let activeChalk = createTuiChalk({
  colorLevel: initialCapabilities.colorLevel,
});
type TuiChalkModifier = 'bold' | 'italic' | 'strikethrough' | 'underline';

const MINIMAX_CODE_CHALK_MODIFIERS = new Set<TuiChalkModifier>([
  'bold',
  'italic',
  'strikethrough',
  'underline',
]);

function resolveActiveChalk(modifiers: readonly TuiChalkModifier[]): ChalkInstance {
  let resolved = activeChalk;
  for (const modifier of modifiers) resolved = resolved[modifier];
  return resolved;
}

function createDynamicTuiChalk(modifiers: readonly TuiChalkModifier[] = []): ChalkInstance {
  const target = (() => '') as unknown as ChalkInstance;
  return new Proxy(target, {
    apply: (_target, _thisArgument, argumentsList) => {
      const resolved = resolveActiveChalk(modifiers);
      return Reflect.apply(resolved, resolved, argumentsList);
    },
    get: (_target, property) => {
      if (property === 'hex') {
        return (color: string): ChalkInstance => {
          const resolved = resolveActiveChalk(modifiers);
          if (renderThemeSnapshot.colorLevel === 1) {
            return (
              resolveTuiAnsi16Foreground(
                resolved,
                activeColors,
                renderThemeSnapshot.appearance,
                color,
              ) ?? resolved.hex(color)
            );
          }
          return resolved.hex(color);
        };
      }
      if (property === 'bgHex') {
        return (color: string): ChalkInstance => {
          const resolved = resolveActiveChalk(modifiers);
          if (
            renderThemeSnapshot.colorLevel === 1 &&
            shouldSuppressTuiAnsi16Background(activeColors, color)
          ) {
            return resolved;
          }
          return resolved.bgHex(color);
        };
      }
      if (
        typeof property === 'string' &&
        MINIMAX_CODE_CHALK_MODIFIERS.has(property as TuiChalkModifier)
      ) {
        return createDynamicTuiChalk([...modifiers, property as TuiChalkModifier]);
      }
      const resolved = resolveActiveChalk(modifiers);
      return Reflect.get(resolved, property, resolved);
    },
  });
}

export const tuiChalk = createDynamicTuiChalk();

const TUI_ACTION_KEY_PATTERN =
  /(?<![\p{L}\p{N}_])(?:(?:(?:Ctrl|Shift|Alt|Cmd|Meta|Option|Command|Fn|Super)\+)+(?:Enter|Esc|Tab|Space|PgUp|PgDn|Home|End|Delete|Backspace|Up|Down|Left|Right|F\d+|[\p{L}\p{N}]|[+\-\\/])|Enter|Esc|Tab|Space|PgUp|PgDn|Home|End|Delete|Backspace|Wheel|F\d+|\d-\d|\/[a-z][a-z0-9-]*|\/(?=\s)|[↑↓←→])(?![\p{L}\p{N}_])/giu;

/**
 * Render user-operable guidance with readable copy and visually distinct keys.
 * `dim` is reserved for non-essential metadata, borders, and truncation chrome.
 */
export function renderTuiActionHint(value: string): string {
  const segments = value.split(/( · )/u);
  return segments
    .map((segment) => {
      if (segment === ' · ') return tuiChalk.hex(tuiColors.dim)(segment);
      const matches = [...segment.matchAll(TUI_ACTION_KEY_PATTERN)];
      if (matches.length === 0) {
        const singleKey = /^(\s*)([a-z0-9/])(?=\s)/iu.exec(segment);
        if (!singleKey) return tuiChalk.hex(tuiColors.muted)(segment);
        const prefix = singleKey[1] ?? '';
        const key = singleKey[2] ?? '';
        return `${tuiChalk.hex(tuiColors.muted)(prefix)}${tuiChalk.bold.hex(tuiColors.text)(
          key,
        )}${tuiChalk.hex(tuiColors.muted)(segment.slice(prefix.length + key.length))}`;
      }

      const rendered: string[] = [];
      let offset = 0;
      for (const match of matches) {
        const index = match.index ?? 0;
        if (index > offset) {
          rendered.push(tuiChalk.hex(tuiColors.muted)(segment.slice(offset, index)));
        }
        rendered.push(tuiChalk.bold.hex(tuiColors.text)(match[0]));
        offset = index + match[0].length;
      }
      if (offset < segment.length) {
        rendered.push(tuiChalk.hex(tuiColors.muted)(segment.slice(offset)));
      }
      return rendered.join('');
    })
    .join('');
}

/**
 * Identity of a palette's *content*, not just its name. Editing a custom theme
 * file in place keeps the same id and appearance, so comparing ids alone would
 * swallow the repaint and leave stale colors on screen.
 */
export function paletteSignature(palette: TuiThemePalette): string {
  return JSON.stringify([palette.id, palette.appearance, palette.colors, palette.syntax]);
}

export function applyTuiRenderTheme(palette: TuiThemePalette, colorLevel: TuiColorLevel): boolean {
  const signature = paletteSignature(palette);
  const changed =
    renderThemeSnapshot.signature !== signature || renderThemeSnapshot.colorLevel !== colorLevel;
  if (!changed) return false;
  const colorLevelChanged = renderThemeSnapshot.colorLevel !== colorLevel;
  renderThemeSnapshot = {
    name: palette.id,
    appearance: palette.appearance,
    colorLevel,
    signature,
  };
  activeColors = palette.colors;
  activeSyntax = palette.syntax;
  if (colorLevelChanged) activeChalk = createTuiChalk({ colorLevel });
  return true;
}

export function getTuiThemeSnapshot(): TuiRenderThemeSnapshot {
  return { ...renderThemeSnapshot };
}

const tuiHighlightTheme = createSyntaxHighlightTheme(
  tuiChalk,
  () => activeSyntax,
  () => renderThemeSnapshot.appearance,
);

export function highlightTuiCode(code: string, language: string): string[] {
  const normalizedLanguage = language.trim().toLowerCase();
  const resolvedLanguage = supportsLanguage(normalizedLanguage) ? normalizedLanguage : 'text';
  try {
    return highlight(code, {
      language: resolvedLanguage,
      ignoreIllegals: true,
      theme: tuiHighlightTheme,
    }).split('\n');
  } catch {
    return code.split('\n').map((line) => tuiChalk.hex(tuiColors.text)(line));
  }
}

export function createTuiMarkdownTheme(): MarkdownTheme {
  return {
    heading: (text) => tuiChalk.bold.hex(tuiColors.markdownHeading)(text),
    link: (text) => tuiChalk.hex(tuiColors.markdownLink)(text),
    linkUrl: (text) => tuiChalk.hex(tuiColors.dim)(text),
    code: (text) => tuiChalk.hex(tuiColors.markdownCode)(text),
    codeBlock: (text) => tuiChalk.hex(tuiColors.text)(text),
    codeBlockBorder: (text) => tuiChalk.hex(tuiColors.muted)(text),
    quote: (text) => tuiChalk.italic.hex(tuiColors.muted)(text),
    quoteBorder: (text) => tuiChalk.hex(tuiColors.muted)(text),
    hr: (text) => tuiChalk.hex(tuiColors.muted)(text),
    listBullet: (text) => tuiChalk.hex(tuiColors.muted)(text),
    bold: (text) => tuiChalk.bold(text),
    italic: (text) => tuiChalk.italic(text),
    strikethrough: (text) => tuiChalk.strikethrough(text),
    underline: (text) => tuiChalk.underline(text),
    codeBlockChrome: 'plain',
    highlightCode: (code, lang) => {
      return highlightTuiCode(code, lang ?? 'text');
    },
  };
}

export const tuiMarkdownTheme = createTuiMarkdownTheme();
export const tuiStreamingMarkdownTheme = tuiMarkdownTheme;

export const tuiSelectListTheme: SelectListTheme = {
  selectedPrefix: (text) => tuiChalk.hex(tuiColors.signal)(text),
  selectedText: (text) => tuiChalk.bold.hex(tuiColors.signal)(text),
  description: (text) => tuiChalk.hex(tuiColors.muted)(text),
  scrollInfo: (text) => tuiChalk.hex(tuiColors.dim)(text),
  noMatch: (text) => tuiChalk.hex(tuiColors.dim)(text),
};

export const tuiEditorTheme: EditorTheme = {
  borderColor: (text) => tuiChalk.hex(tuiColors.line)(text),
  placeholder: (text) => tuiChalk.hex(tuiColors.muted)(text),
  selectList: tuiSelectListTheme,
};
