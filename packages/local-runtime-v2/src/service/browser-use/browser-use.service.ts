import type { RuntimeTool, ToolResult } from '@mavis/agent-core/tools';
import {
  buildLocalBrowserRuntimeTools,
  CONTROL_IN_APP_BROWSER_SKILL_NAME,
  type LocalBrowserAdapter,
  type LocalBrowserSkillSessionStore,
} from '@mavis/agent-tools/desktop';

import type {
  BrowserUseService,
  BrowserUseServiceOptions,
  BrowserUseTurnToolSafetyGuard,
  BrowserUseTurnCapability,
  BrowserUseTurnCapabilityInput,
  BrowserUseBoundSkill,
  BrowserUseBuiltinSkillDescriptor,
  BrowserUseTurnReminder,
  BrowserUseTurnReminderInput,
} from './contracts.js';
import { readBrowserUseBuiltinSkillAsset } from './browser-skill-asset.js';
import {
  createBrowserUseExtension,
  createBrowserUseTurnToolSafetyGuard,
  isBrowserUseToolingAvailable,
} from './policy.js';
import {
  BROWSER_CONTROL_DISABLED_GUIDANCE,
  buildInAppBrowserContext,
  hasExplicitInAppBrowserOperationIntent,
} from './reminders.js';
import { createBrowserScreenshotPreprocessor } from './screenshot-preprocessor.js';
import type { BrowserScreenshotPreprocessor } from './screenshot-preprocessor.js';
import { BrowserSkillSessionStore, BrowserTurnContextStore } from './session-state.js';
import { createWorkspaceBrowserAssetAdapter } from './workspace-assets.adapter.js';

const DESKTOP_PLUGIN_DISABLED_GUIDANCE =
  'Browser control is provided by a Browser Use Plugin with an admitted Host Binding. Ask the user to enable or install that Plugin from Plugins; do not call request_feature_enable and do not claim that the legacy Browser Use switch can authorize control.';

type BrowserUseDesktopCapabilities = NonNullable<
  BrowserUseTurnCapabilityInput['desktopCapabilities']
>;
type BrowserUseHostBinding = NonNullable<BrowserUseDesktopCapabilities['hostBindings']>[number];

export class LocalBrowserUseService implements BrowserUseService {
  readonly turnContext = new BrowserTurnContextStore();
  private readonly skillSessionStore = new BrowserSkillSessionStore();
  private readonly requiredSkillByTurn = new Map<string, string>();
  private readonly screenshotPreprocessor: BrowserScreenshotPreprocessor;
  private readonly explicitBuiltinSkill: BrowserUseBuiltinSkillDescriptor | undefined;
  readonly extension = createBrowserUseExtension({
    requiredSkillName: (sessionId, turnId) =>
      this.requiredSkillByTurn.get(turnKey(sessionId, turnId)),
    clearTurn: (sessionId, turnId) => this.requiredSkillByTurn.delete(turnKey(sessionId, turnId)),
  });
  readonly reminders = {
    buildTurnReminder: (input: BrowserUseTurnReminderInput) => this.buildTurnReminder(input),
  };

  constructor(private readonly options: BrowserUseServiceOptions) {
    this.explicitBuiltinSkill =
      options.activationMode === 'explicit-config' ? readBrowserUseBuiltinSkillAsset() : undefined;
    this.screenshotPreprocessor = createBrowserScreenshotPreprocessor({
      getImageEncoding: options.getImageEncoding,
      registerGeneratedAsset: options.registerGeneratedAsset,
    });
  }

  isAvailable(desktopCapabilities?: BrowserUseTurnCapabilityInput['desktopCapabilities']): boolean {
    return this.isAvailableForCapabilities(desktopCapabilities);
  }

  createTurnToolSafetyGuard(): BrowserUseTurnToolSafetyGuard {
    return createBrowserUseTurnToolSafetyGuard({
      rejectLegacyFeatureEnable: this.options.activationMode === 'desktop-plugin',
    });
  }

  resolveTurnCapability(input: BrowserUseTurnCapabilityInput): BrowserUseTurnCapability {
    const requiredSkill = this.resolveRequiredSkill(
      input.desktopCapabilities,
      input.allowedExtensionSkillNames,
      input.surface,
    );
    const key = turnKey(input.sessionId, input.turnId);
    if (requiredSkill) this.requiredSkillByTurn.set(key, requiredSkill.name);
    else this.requiredSkillByTurn.delete(key);

    const baseTools = input.baseTools.map((tool) => {
      if (tool.def.name === 'skill') {
        return wrapBrowserSkillTool(tool, {
          mode: this.options.activationMode,
          requiredSkill,
          receipts: this.skillSessionStore,
        });
      }
      return tool;
    });
    const delegate = this.options.adapter;
    if (!delegate || !requiredSkill) {
      return { tools: baseTools, controlAuthorized: false };
    }
    const assertLiveAvailability = () =>
      this.options.activationMode === 'explicit-config'
        ? this.isExplicitlyEnabled()
        : this.isProviderAvailable();
    const guardedDelegate = createLiveBrowserUseAdapter(delegate, assertLiveAvailability);
    const workspaceAdapter = createWorkspaceBrowserAssetAdapter(guardedDelegate, {
      workspaceRoot: input.workspaceRoot,
    });
    const receipt = bindTurnSkillReceipt(this.skillSessionStore, requiredSkill);
    const exposure =
      this.options.activationMode === 'desktop-plugin' ? 'compact' : this.options.toolExposure;
    const browserTools = buildLocalBrowserRuntimeTools(
      // Keep the live kill switch outside every action-specific adapter so a
      // revoked Turn performs no workspace I/O before failing closed.
      createLiveBrowserUseAdapter(workspaceAdapter, assertLiveAvailability),
      {
        ...(exposure ? { exposure } : {}),
        browserSkillSessionStore: receipt,
        preprocessScreenshot: this.screenshotPreprocessor,
      },
    ).map((tool) => bindRequiredSkillDescription(tool, requiredSkill.name));
    return {
      tools: insertBrowserTools(baseTools, browserTools),
      requiredSkill,
      controlAuthorized: true,
    };
  }

  builtinSkillDescriptor(): BrowserUseBuiltinSkillDescriptor | undefined {
    return this.options.activationMode === 'explicit-config' && this.isExplicitlyEnabled()
      ? this.explicitBuiltinSkill
      : undefined;
  }

  admitQuestionnaireRequest(
    input: Parameters<BrowserUseService['admitQuestionnaireRequest']>[0],
  ): ReturnType<BrowserUseService['admitQuestionnaireRequest']> {
    if (
      this.options.activationMode !== 'desktop-plugin' ||
      input.request.mode !== 'feature-enable' ||
      input.request.modePayload?.featureKey !== 'browser-use'
    ) {
      return undefined;
    }
    return {
      status: 403,
      code: 'BROWSER_PLUGIN_MANAGED',
      message:
        'Desktop Browser control is managed by the Browser Use Plugin; the legacy feature-enable card is not accepted.',
    };
  }

  notifyContextReset(sessionId: string): void {
    this.skillSessionStore.clearSession(sessionId);
  }

  clearSession(sessionId: string): void {
    this.skillSessionStore.clearSession(sessionId);
    this.screenshotPreprocessor.clearSession(sessionId);
    this.turnContext.clearSession(sessionId);
    for (const key of this.requiredSkillByTurn.keys()) {
      if (key.startsWith(`${sessionId}\0`)) this.requiredSkillByTurn.delete(key);
    }
  }

  close(): void {
    this.skillSessionStore.clear();
    this.screenshotPreprocessor.clear();
    this.turnContext.clear();
    this.requiredSkillByTurn.clear();
  }

  private buildTurnReminder(input: BrowserUseTurnReminderInput): BrowserUseTurnReminder {
    const inAppBrowser = this.turnContext.read(input.sessionId, input.turnId);
    const browserOperationIntentDetected = hasExplicitInAppBrowserOperationIntent(input.userPrompt);
    if (
      this.options.activationMode === 'desktop-plugin' &&
      (input.surface ?? 'interactive') !== 'interactive'
    ) {
      return {
        content: '',
        diagnostic: {
          browserControlDisabled: true,
          browserOperationIntentDetected,
          browserDisabledGuidanceInjected: false,
          browserSurfaceVisible: inAppBrowser?.visible === true,
          browserSurfaceSelected: inAppBrowser?.selectedTab === true,
          browserControlAuthorized: false,
        },
      };
    }
    const controlAuthorized = this.isAvailableForCapabilities(
      input.desktopCapabilities,
      input.allowedExtensionSkillNames,
      input.surface,
    );
    const browserControlDisabled = !controlAuthorized;
    const browserDisabledGuidanceInjected =
      browserControlDisabled && browserOperationIntentDetected;
    const surfaceVisible = inAppBrowser?.visible === true;
    const disabledGuidance = resolveDisabledGuidance(
      this.options.activationMode,
      browserDisabledGuidanceInjected,
    );
    const content = [
      surfaceVisible ? buildInAppBrowserContext({ ...inAppBrowser, controlAuthorized }) : '',
      disabledGuidance,
    ]
      .filter(Boolean)
      .join('\n\n');
    return {
      content,
      diagnostic: {
        browserControlDisabled,
        browserOperationIntentDetected,
        browserDisabledGuidanceInjected,
        browserSurfaceVisible: surfaceVisible,
        browserSurfaceSelected: inAppBrowser?.selectedTab === true,
        browserControlAuthorized: controlAuthorized,
      },
    };
  }

  private resolveRequiredSkill(
    capabilities: BrowserUseTurnCapabilityInput['desktopCapabilities'],
    allowedExtensionSkillNames?: readonly string[],
    surface: BrowserUseTurnCapabilityInput['surface'] = 'interactive',
  ): BrowserUseBoundSkill | undefined {
    if (!this.isProviderAvailable()) return undefined;
    if (this.options.activationMode === 'explicit-config') {
      return this.isExplicitlyEnabled() ? this.explicitBuiltinSkill : undefined;
    }
    return resolveDesktopRequiredSkill(capabilities, allowedExtensionSkillNames, surface);
  }

  private isAvailableForCapabilities(
    capabilities: BrowserUseTurnCapabilityInput['desktopCapabilities'],
    allowedExtensionSkillNames?: readonly string[],
    surface?: BrowserUseTurnCapabilityInput['surface'],
  ): boolean {
    return (
      this.resolveRequiredSkill(capabilities, allowedExtensionSkillNames, surface) !== undefined
    );
  }

  private isProviderAvailable(): boolean {
    const adapter = this.options.adapter;
    if (!adapter) return false;
    const provider = adapter.getCapabilities?.().provider?.trim();
    return provider && provider !== 'electron-file-panel'
      ? true
      : this.options.readConfig().filePanelBrowserEnabled === true;
  }

  private isExplicitlyEnabled(): boolean {
    const config = this.options.readConfig();
    return isBrowserUseToolingAvailable(
      config.filePanelBrowserEnabled,
      config.browserUseToolingEnabled,
      this.options.adapter?.getCapabilities?.().provider,
    );
  }
}

function resolveDisabledGuidance(
  mode: BrowserUseServiceOptions['activationMode'],
  shouldInject: boolean,
): string {
  if (!shouldInject) return '';
  if (mode === 'desktop-plugin') return DESKTOP_PLUGIN_DISABLED_GUIDANCE;
  return BROWSER_CONTROL_DISABLED_GUIDANCE;
}

function resolveDesktopRequiredSkill(
  capabilities: BrowserUseTurnCapabilityInput['desktopCapabilities'],
  allowedExtensionSkillNames: readonly string[] | undefined,
  surface: BrowserUseTurnCapabilityInput['surface'],
): BrowserUseBoundSkill | undefined {
  if (!capabilities || surface !== 'interactive') return undefined;
  const binding = findBrowserUseBinding(capabilities.hostBindings ?? [], surface);
  if (!binding) return undefined;
  const name = binding.requiredSkillRuntimeNames[0];
  if (!name) return undefined;
  if (!isExtensionSkillSelected(allowedExtensionSkillNames, binding.pluginName, name)) {
    return undefined;
  }
  const skill = capabilities.skills.find((candidate) => candidate.name === name);
  if (!skill) return undefined;
  return {
    name: skill.name,
    content: skill.content,
    location: skill.location,
    sourceKind: skill.sourceKind,
  };
}

function findBrowserUseBinding(
  bindings: readonly BrowserUseHostBinding[],
  surface: 'interactive',
): BrowserUseHostBinding | undefined {
  const matches = bindings.filter((binding) => isBrowserUseBinding(binding, surface));
  return matches.length === 1 ? matches[0] : undefined;
}

function isBrowserUseBinding(binding: BrowserUseHostBinding, surface: 'interactive'): boolean {
  return (
    binding.hostCapability.id === 'browser.use' &&
    binding.hostCapability.version === 1 &&
    binding.requiredSkillRuntimeNames.length === 1 &&
    binding.allowedSurfaces.some((allowedSurface) => allowedSurface === surface)
  );
}

function bindTurnSkillReceipt(
  store: BrowserSkillSessionStore,
  skill: BrowserUseBoundSkill,
): LocalBrowserSkillSessionStore {
  return {
    requiredSkillName: skill.name,
    hasLoaded: (sessionId) => store.hasLoaded(sessionId, skill.content),
    markLoaded: (sessionId, content) => store.markLoaded(sessionId, content),
    clearSession: (sessionId) => store.clearSession(sessionId),
  };
}

function wrapBrowserSkillTool(
  tool: RuntimeTool,
  input: {
    readonly mode: BrowserUseServiceOptions['activationMode'];
    readonly requiredSkill?: BrowserUseBoundSkill;
    readonly receipts: BrowserSkillSessionStore;
  },
): RuntimeTool {
  return {
    ...tool,
    impl: {
      async execute(ctx, rawInput, signal, onUpdate) {
        const requested = readSkillName(rawInput);
        const requiredSkill = input.requiredSkill;
        if (
          input.mode === 'desktop-plugin' &&
          requested === CONTROL_IN_APP_BROWSER_SKILL_NAME &&
          requested !== requiredSkill?.name
        ) {
          return missingSkillResult(requested);
        }
        if (
          requiredSkill &&
          requested === requiredSkill.name &&
          isReadableBoundSkill(requiredSkill)
        ) {
          if (signal?.aborted) throw new Error('Operation aborted');
          const loadedSkills = (ctx as { readonly loadedSkills?: Set<string> }).loadedSkills;
          loadedSkills?.add(requested);
          input.receipts.markLoaded(ctx.sessionId, requiredSkill.content);
          return boundSkillResult(requiredSkill);
        }
        if (input.mode === 'explicit-config' && requested === CONTROL_IN_APP_BROWSER_SKILL_NAME) {
          return missingSkillResult(requested);
        }
        return tool.impl.execute(ctx, rawInput as never, signal, onUpdate);
      },
    },
  };
}

function isReadableBoundSkill(skill: BrowserUseBoundSkill): skill is BrowserUseBoundSkill & {
  readonly content: string;
  readonly location: string;
  readonly sourceKind: string;
} {
  return (
    typeof skill.content === 'string' &&
    typeof skill.location === 'string' &&
    typeof skill.sourceKind === 'string'
  );
}

function boundSkillResult(
  skill: BrowserUseBoundSkill & {
    readonly content: string;
    readonly location: string;
    readonly sourceKind: string;
  },
): ToolResult {
  const header = [`# Skill: ${skill.name}`, `Location: ${skill.location}`];
  const text = `${header.join('\n')}\n\n${skill.content}`;
  return {
    tool_name: 'skill',
    text,
    content: [{ type: 'text', text }],
    details: {
      kind: 'skill',
      skill: skill.name,
      found: true,
      readable: true,
      owner: 'browser-use-v2',
      source: skill.sourceKind,
      location: skill.location,
    },
  };
}

function missingSkillResult(name: string): ToolResult {
  const text = `Local skill not found: ${name}`;
  return {
    tool_name: 'skill',
    text,
    content: [{ type: 'text', text }],
    details: { kind: 'skill', skill: name, found: false, readable: false, owner: 'desktop' },
  };
}

function insertBrowserTools(
  baseTools: readonly RuntimeTool[],
  browserTools: readonly RuntimeTool[],
): readonly RuntimeTool[] {
  const names = new Set(baseTools.map((tool) => tool.def.name));
  for (const tool of browserTools) {
    if (names.has(tool.def.name)) {
      throw new Error(`Browser Use tool conflicts with an existing tool: ${tool.def.name}`);
    }
    names.add(tool.def.name);
  }
  const insertion = baseTools.reduce(
    (index, tool, current) =>
      tool.def.name === 'web_fetch' || tool.def.name === 'web_search' ? current + 1 : index,
    0,
  );
  return [...baseTools.slice(0, insertion), ...browserTools, ...baseTools.slice(insertion)];
}

function bindRequiredSkillDescription(tool: RuntimeTool, requiredSkillName: string): RuntimeTool {
  if (requiredSkillName === CONTROL_IN_APP_BROWSER_SKILL_NAME) return tool;
  return {
    ...tool,
    def: {
      ...tool.def,
      description: tool.def.description.replaceAll(
        `\`${CONTROL_IN_APP_BROWSER_SKILL_NAME}\``,
        `\`${requiredSkillName}\``,
      ),
    },
  };
}

function readSkillName(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const name = Reflect.get(value, 'name');
  return typeof name === 'string' ? name.trim() : undefined;
}

function turnKey(sessionId: string, turnId: string): string {
  return `${sessionId}\0${turnId}`;
}

function isExtensionSkillSelected(
  selected: readonly string[] | undefined,
  pluginName: string,
  skillName: string,
): boolean {
  if (selected === undefined) return true;
  const name = normalizedName(skillName);
  const qualified = `${normalizedName(pluginName)}:${name}`;
  return selected.some((candidate) => {
    const normalized = normalizedName(candidate);
    return normalized === name || normalized === qualified;
  });
}

function normalizedName(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function createLiveBrowserUseAdapter(
  delegate: LocalBrowserAdapter,
  isAvailable: () => boolean,
): LocalBrowserAdapter {
  const getCapabilities = delegate.getCapabilities?.bind(delegate);
  return {
    ...(getCapabilities ? { getCapabilities } : {}),
    async execute(ctx, action, input, signal) {
      if (!isAvailable()) {
        throw new Error(
          'BROWSER_CONTROL_DISABLED: Browser control permission was disabled during this turn.',
        );
      }
      return delegate.execute(ctx, action, input, signal);
    },
  };
}
