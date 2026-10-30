import {
  getKeybindings,
  isKeyRelease,
  KeybindingsManager,
  matchesKey,
  TUI_KEYBINDINGS,
  type Keybinding,
  type KeybindingDefinitions,
  type KeybindingsConfig,
  type KeyId,
} from '../engine/public.js';
import { formatTuiShortcut } from './shortcut-labels.js';

export type TuiShellKeyAction =
  | 'paste-image'
  | 'open-external-editor'
  | 'search-history'
  | 'resume-codex'
  | 'submit-guidance'
  | 'queue-draft'
  | 'restore-waiting'
  | 'manage-waiting'
  | 'toggle-tasks'
  | 'toggle-details'
  | 'toggle-plan'
  | 'toggle-side-session'
  | 'cycle-permission'
  | 'scroll-up'
  | 'scroll-down'
  | 'view-plan'
  | 'restore-draft'
  | 'clear'
  | 'interrupt'
  | 'exit'
  | 'suspend';

export interface TuiKeybindingContext {
  interactionActive: boolean;
  hasLiveRun: boolean;
  hasWaitingMessage?: boolean;
  hasRestorableDraft?: boolean;
}

export type TuiKeybindingScope =
  | 'application'
  | 'composer'
  | 'idle'
  | 'live-run'
  | 'waiting'
  | 'interaction';

export interface TuiKeybindingDefinition {
  readonly id: string;
  readonly key: KeyId;
  readonly action: TuiShellKeyAction;
  readonly when: TuiKeybindingScope;
  readonly description?: string;
  readonly helpOrder?: number;
  readonly helpGroup?: string;
  readonly queueOnly?: boolean;
}

export interface TuiKeybindingHelpRow {
  readonly ids: readonly string[];
  readonly keys: string;
  readonly description: string;
}

export type TuiKeybindingOverride = KeyId | KeyId[] | undefined;

export interface TuiKeybindingConflict {
  readonly key: KeyId;
  readonly ids: readonly string[];
}

const KEYBINDING_ID_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/u;
const KEY_ID_PATTERN =
  /^(?:(?:ctrl|shift|alt|super)\+)*(?:[a-z0-9\-/]|escape|enter|tab|space|backspace|delete|home|end|pageUp|pageDown|up|down|left|right)$/u;

export class TuiKeybindingRegistry {
  private readonly bindings = new Map<string, TuiKeybindingDefinition>();

  constructor(
    definitions: readonly TuiKeybindingDefinition[] = [],
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly engineKeybindings?: KeybindingsManager,
    private readonly baseOverrides: KeybindingsConfig = {},
  ) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: TuiKeybindingDefinition): void {
    validateDefinition(definition);
    if (this.bindings.has(definition.id)) {
      throw new Error(`Duplicate keybinding id: ${definition.id}`);
    }
    const conflict = [...this.bindings.values()].find(
      (candidate) =>
        keySignature(candidate.key) === keySignature(definition.key) &&
        scopesOverlap(candidate.when, definition.when),
    );
    if (conflict) {
      throw new Error(
        `Keybinding conflict: ${definition.key} is already registered for ${conflict.id}`,
      );
    }
    this.bindings.set(definition.id, definition);
  }

  resolve(data: string, context: TuiKeybindingContext): TuiShellKeyAction | undefined {
    if (isKeyRelease(data)) return undefined;
    return [...this.bindings.values()].find(
      (binding) =>
        this.matches(data, binding) &&
        scopeMatches(binding.when, context) &&
        !(binding.action === 'restore-draft' && context.hasRestorableDraft !== true) &&
        // Legacy terminals report both Ctrl+/ and Ctrl+_ as the bare 0x1F
        // byte. While a cleared Draft is restorable, that ambiguous byte
        // belongs to restore-draft; unambiguous CSI-u / modifyOtherKeys
        // Ctrl+/ reports still toggle the side conversation.
        !(
          binding.action === 'toggle-side-session' &&
          context.hasRestorableDraft === true &&
          data === '\x1f'
        ) &&
        !(binding.action === 'restore-waiting' && context.hasWaitingMessage !== true),
    )?.action;
  }

  list(): readonly TuiKeybindingDefinition[] {
    return [...this.bindings.values()].map((definition) => this.effective(definition));
  }

  get(id: string): TuiKeybindingDefinition | undefined {
    const definition = this.bindings.get(id);
    return definition ? this.effective(definition) : undefined;
  }

  /** Return all effective keys, including user-configured aliases. */
  keys(id: string): readonly KeyId[] {
    const definition = this.bindings.get(id);
    if (definition) {
      return this.engineKeybindings?.getKeys(id as Keybinding) ?? [definition.key];
    }
    return Object.hasOwn(TUI_KEYBINDINGS, id)
      ? (this.engineKeybindings ?? getKeybindings()).getKeys(id as Keybinding)
      : [];
  }

  findConflicts(
    overrides: Readonly<Record<string, TuiKeybindingOverride>>,
  ): readonly TuiKeybindingConflict[] {
    const candidates = [...this.bindings.values()].map((definition) => ({
      definition,
      keys: this.keysForOverrides(definition.id, overrides),
    }));
    const conflicts: TuiKeybindingConflict[] = [];
    for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
      const left = candidates[leftIndex];
      if (!left) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
        const right = candidates[rightIndex];
        if (!right) continue;
        if (!scopesOverlap(left.definition.when, right.definition.when)) continue;
        for (const key of left.keys) {
          if (!right.keys.some((candidate) => keySignature(candidate) === keySignature(key)))
            continue;
          conflicts.push({ key, ids: [left.definition.id, right.definition.id] });
        }
      }
    }
    return conflicts;
  }

  format(key: KeyId): string {
    return formatTuiShortcut(key, this.platform);
  }

  help(queueEnabled = true): readonly TuiKeybindingDefinition[] {
    return this.list()
      .filter(
        (binding) =>
          binding.description &&
          binding.helpOrder !== undefined &&
          (queueEnabled || !binding.queueOnly),
      )
      .sort((left, right) => (left.helpOrder ?? 0) - (right.helpOrder ?? 0));
  }

  helpRows(queueEnabled = true): readonly TuiKeybindingHelpRow[] {
    const rows = new Map<
      string,
      { ids: string[]; keys: string[]; description: string; order: number }
    >();
    for (const binding of this.help(queueEnabled)) {
      const group = binding.helpGroup ?? binding.id;
      const existing = rows.get(group);
      if (existing) {
        existing.ids.push(binding.id);
        existing.keys.push(...this.keys(binding.id).map((key) => this.format(key)));
        existing.order = Math.min(existing.order, binding.helpOrder ?? 0);
        continue;
      }
      rows.set(group, {
        ids: [binding.id],
        keys: this.keys(binding.id).map((key) => this.format(key)),
        description: binding.description ?? '',
        order: binding.helpOrder ?? 0,
      });
    }
    return [...rows.values()]
      .sort((left, right) => left.order - right.order)
      .map((row) => ({
        ids: row.ids,
        keys: row.keys.length > 0 ? row.keys.join(' / ') : 'Unbound',
        description: row.description,
      }));
  }

  withOverrides(overrides: Readonly<Record<string, TuiKeybindingOverride>>): TuiKeybindingRegistry {
    const definitions = this.list().map((definition) => {
      if (!(definition.id in overrides)) return definition;
      const override = overrides[definition.id];
      const key = Array.isArray(override) ? override[0] : override;
      if (!key) return definition;
      return { ...definition, key };
    });
    for (const id of Object.keys(overrides)) {
      if (!this.bindings.has(id)) throw new Error(`Unknown keybinding id: ${id}`);
    }
    return new TuiKeybindingRegistry(definitions, this.platform);
  }

  private matches(data: string, definition: TuiKeybindingDefinition): boolean {
    return (
      this.engineKeybindings?.matches(data, definition.id as Keybinding) ??
      matchesKey(data, definition.key)
    );
  }

  private effective(definition: TuiKeybindingDefinition): TuiKeybindingDefinition {
    const key = this.keys(definition.id)[0];
    return key && key !== definition.key ? { ...definition, key } : definition;
  }

  private keysForOverrides(
    id: string,
    overrides: Readonly<Record<string, TuiKeybindingOverride>>,
  ): readonly KeyId[] {
    const override = overrides[id];
    if (override !== undefined) return Array.isArray(override) ? [...override] : [override];
    const base = this.baseOverrides[id];
    if (base !== undefined) return Array.isArray(base) ? [...base] : [base];
    const definition = this.bindings.get(id);
    return definition ? [definition.key] : [];
  }
}

function keySignature(key: KeyId): string {
  const parts = key.toLocaleLowerCase().split('+');
  const base = parts.pop() ?? '';
  return `${parts.sort().join('+')}+${base}`;
}

const DEFAULT_TUI_KEYBINDINGS: readonly TuiKeybindingDefinition[] = [
  {
    id: 'app.clear',
    key: 'ctrl+c',
    action: 'clear',
    when: 'composer',
    description: 'Clear the Composer; press twice to exit',
    helpOrder: 120,
  },
  {
    id: 'app.interrupt',
    key: 'escape',
    action: 'interrupt',
    when: 'composer',
    description: 'Close the current panel, or interrupt the active turn',
    helpOrder: 110,
  },
  {
    id: 'app.exit',
    key: 'ctrl+d',
    action: 'exit',
    when: 'composer',
    description: 'Exit when the Composer is empty',
    helpOrder: 121,
  },
  {
    id: 'app.suspend',
    key: 'ctrl+z',
    action: 'suspend',
    when: 'application',
    description: 'Suspend MCode and return to the shell',
    helpOrder: 122,
  },
  {
    id: 'app.toggle-side-session',
    key: 'ctrl+/',
    action: 'toggle-side-session',
    when: 'application',
    description: 'Toggle between the parent and temporary side conversation',
    helpOrder: 123,
  },
  {
    id: 'welcome.resume-codex',
    key: 'ctrl+u',
    action: 'resume-codex',
    when: 'idle',
  },
  {
    id: 'composer.paste-image',
    key: 'ctrl+v',
    action: 'paste-image',
    when: 'composer',
    description: 'Paste an image or copied video file from the clipboard',
    helpOrder: 70,
  },
  {
    id: 'composer.paste-image-windows',
    key: 'alt+v',
    action: 'paste-image',
    when: 'composer',
  },
  {
    id: 'composer.paste-image-macos',
    key: 'super+v',
    action: 'paste-image',
    when: 'composer',
    description: 'Paste an image or copied video file from the clipboard',
    helpOrder: 70,
  },
  {
    id: 'composer.external-editor',
    key: 'ctrl+g',
    action: 'open-external-editor',
    when: 'composer',
    description: 'Search prompt history / edit in an external editor',
    helpOrder: 50,
    helpGroup: 'composer.prompt-tools',
  },
  {
    id: 'composer.search-history',
    key: 'ctrl+r',
    action: 'search-history',
    when: 'composer',
    description: 'Search prompt history / edit in an external editor',
    helpOrder: 40,
    helpGroup: 'composer.prompt-tools',
  },
  {
    id: 'run.submit-guidance',
    key: 'enter',
    action: 'submit-guidance',
    when: 'live-run',
    description: 'Guide the current response with the current Draft',
    helpOrder: 90,
  },
  {
    id: 'run.queue-draft',
    key: 'alt+enter',
    action: 'queue-draft',
    when: 'live-run',
    description: 'Queue the current Draft for the next turn',
    helpOrder: 91,
    queueOnly: true,
  },
  {
    id: 'run.restore-waiting-option',
    key: 'alt+up',
    action: 'restore-waiting',
    when: 'live-run',
    description: 'Move the latest queued message back to the Composer',
    helpOrder: 92,
    helpGroup: 'run.restore-waiting',
    queueOnly: true,
  },
  {
    id: 'run.restore-waiting-shift-left',
    key: 'shift+left',
    action: 'restore-waiting',
    when: 'live-run',
    description: 'Move the latest queued message back to the Composer',
    helpOrder: 92,
    helpGroup: 'run.restore-waiting',
    queueOnly: true,
  },
  {
    id: 'composer.toggle-tasks',
    key: 'ctrl+t',
    action: 'toggle-tasks',
    when: 'composer',
    description: 'Show or hide the full Todo list',
    helpOrder: 25,
  },
  {
    id: 'composer.toggle-details',
    key: 'ctrl+o',
    action: 'toggle-details',
    when: 'composer',
    description: 'Show or hide Thinking, Tool output, and diffs',
    helpOrder: 20,
  },
  {
    id: 'composer.toggle-plan',
    key: 'shift+tab',
    action: 'toggle-plan',
    when: 'composer',
    description: 'Plan Mode: Default or Plan',
    helpOrder: 10,
  },
  {
    id: 'composer.cycle-permission',
    key: 'alt+m',
    action: 'cycle-permission',
    when: 'composer',
    description: 'Permission mode: Ask, Auto, Full access',
    helpOrder: 11,
  },
  {
    id: 'composer.restore-draft',
    key: 'ctrl+-',
    action: 'restore-draft',
    when: 'composer',
    description: 'Undo the last Draft clear',
    helpOrder: 60,
  },
  {
    id: 'interaction.scroll-up',
    key: 'pageUp',
    action: 'scroll-up',
    when: 'interaction',
    description: 'Scroll the current interaction',
    helpOrder: 80,
    helpGroup: 'interaction.navigation',
  },
  {
    id: 'interaction.scroll-down',
    key: 'pageDown',
    action: 'scroll-down',
    when: 'interaction',
    description: 'Scroll the current interaction',
    helpOrder: 81,
    helpGroup: 'interaction.navigation',
  },
  {
    id: 'interaction.view-plan',
    key: 'ctrl+o',
    action: 'view-plan',
    when: 'interaction',
    description: 'Show or hide the full Plan during Plan Review',
    helpOrder: 82,
  },
];

export function createDefaultTuiKeybindingRegistry(): TuiKeybindingRegistry {
  return new TuiKeybindingRegistry(DEFAULT_TUI_KEYBINDINGS);
}

export interface TuiHostKeybindingOptions {
  readonly platform: NodeJS.Platform;
  readonly suspendSupported: boolean;
  readonly windowsClipboardInterop?: boolean;
  readonly userOverrides?: KeybindingsConfig;
}

export interface TuiHostKeybindings {
  readonly manager: KeybindingsManager;
  readonly registry: TuiKeybindingRegistry;
  readonly hostOverrides: KeybindingsConfig;
}

function resolveTuiHostKeybindingDefinitions(
  options: TuiHostKeybindingOptions,
): readonly TuiKeybindingDefinition[] {
  const pasteHelpGroup = 'composer.paste-media';
  const windowsPasteAlias =
    options.platform === 'win32' || options.windowsClipboardInterop === true;
  const definitions = DEFAULT_TUI_KEYBINDINGS.flatMap((definition) => {
    if (definition.id === 'app.suspend' && !options.suspendSupported) return [];
    if (definition.id === 'composer.paste-image-windows' && !windowsPasteAlias) return [];
    if (definition.id === 'composer.paste-image-macos' && options.platform !== 'darwin') return [];
    if (definition.id === 'composer.restore-draft' && options.platform === 'win32') {
      return [{ ...definition, key: 'ctrl+z' as const }];
    }
    if (
      definition.id === 'composer.paste-image' &&
      (windowsPasteAlias || options.platform === 'darwin')
    ) {
      return [
        {
          ...definition,
          ...(windowsPasteAlias ? { key: 'alt+v' as const } : {}),
          helpGroup: pasteHelpGroup,
        },
      ];
    }
    if (definition.id === 'composer.paste-image-windows') {
      return [
        {
          ...definition,
          key: 'ctrl+v' as const,
          description: 'Paste an image or copied video file from the clipboard',
          helpOrder: 70,
          helpGroup: pasteHelpGroup,
        },
      ];
    }
    if (definition.id === 'composer.paste-image-macos') {
      return [
        {
          ...definition,
          description: 'Paste an image or copied video file from the clipboard',
          helpOrder: 70,
          helpGroup: pasteHelpGroup,
        },
      ];
    }
    return [definition];
  });
  return definitions;
}

export function createTuiHostKeybindings(options: TuiHostKeybindingOptions): TuiHostKeybindings {
  const definitions = resolveTuiHostKeybindingDefinitions(options);
  const hostOverrides = createTuiHostEngineOverrides(options.platform);
  const manager = new KeybindingsManager(
    {
      ...TUI_KEYBINDINGS,
      ...toEngineKeybindingDefinitions(definitions),
    },
    { ...hostOverrides, ...(options.userOverrides ?? {}) },
  );
  return {
    manager,
    registry: new TuiKeybindingRegistry(definitions, options.platform, manager, hostOverrides),
    hostOverrides,
  };
}

function createTuiHostEngineOverrides(platform: NodeJS.Platform): KeybindingsConfig {
  return {
    'tui.altScreen.previousPrompt': ['ctrl+shift+up', 'ctrl+up'],
    'tui.altScreen.nextPrompt': ['ctrl+shift+down', 'ctrl+down'],
    ...(platform === 'win32' ? { 'tui.editor.undo': ['ctrl+-', 'ctrl+z'] } : {}),
  };
}

function toEngineKeybindingDefinitions(
  definitions: readonly TuiKeybindingDefinition[],
): KeybindingDefinitions {
  return Object.fromEntries(
    definitions.map((definition) => [
      definition.id,
      { defaultKeys: definition.key, description: definition.description },
    ]),
  );
}

const defaultTuiKeybindings = createDefaultTuiKeybindingRegistry();

export function getDefaultTuiKeybindingRegistry(): TuiKeybindingRegistry {
  return defaultTuiKeybindings;
}

export function formatTuiKeybinding(
  id: string,
  registry: TuiKeybindingRegistry = defaultTuiKeybindings,
): string {
  if (!Object.hasOwn(TUI_KEYBINDINGS, id)) getTuiKeybindingDefinition(id, registry);
  const keys = registry.keys(id);
  return keys.length > 0 ? keys.map((key) => registry.format(key)).join(' / ') : 'Unbound';
}

export function getTuiKeybindingDefinition(
  id: string,
  registry: TuiKeybindingRegistry = defaultTuiKeybindings,
): TuiKeybindingDefinition {
  const binding = registry.get(id);
  if (!binding) throw new Error(`Unknown keybinding id: ${id}`);
  return binding;
}

export function resolveTuiKeybinding(
  data: string,
  context: TuiKeybindingContext,
): TuiShellKeyAction | undefined {
  return defaultTuiKeybindings.resolve(data, context);
}

function validateDefinition(definition: TuiKeybindingDefinition): void {
  if (!KEYBINDING_ID_PATTERN.test(definition.id)) {
    throw new Error(`Invalid keybinding id: ${definition.id}`);
  }
  if (!KEY_ID_PATTERN.test(definition.key)) {
    throw new Error(`Invalid keybinding key: ${definition.key}`);
  }
}

function scopeMatches(scope: TuiKeybindingScope, context: TuiKeybindingContext): boolean {
  if (scope === 'application') return true;
  if (scope === 'interaction') return context.interactionActive;
  if (context.interactionActive) return false;
  if (scope === 'composer') return true;
  if (scope === 'idle') return !context.hasLiveRun;
  if (scope === 'waiting') return context.hasWaitingMessage === true;
  return context.hasLiveRun;
}

function scopesOverlap(left: TuiKeybindingScope, right: TuiKeybindingScope): boolean {
  if (left === 'application' || right === 'application') return true;
  if (left === 'interaction' || right === 'interaction') return left === right;
  if (left === 'composer' || right === 'composer') return true;
  if (left === right) return true;
  if (left === 'waiting' || right === 'waiting') return true;
  return false;
}
