import type { RuntimeTool, ToolResult } from '@mavis/agent-core/tools';
import {
  buildLocalBrowserRuntimeTools,
  CONTROL_IN_APP_BROWSER_SKILL_NAME,
  type LocalBrowserAdapter,
  type LocalBrowserSkillSessionStore,
} from '@mavis/agent-tools/desktop';

import { logger } from '../../infra/logging/logger.js';

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
import {
  readBrowserUseBuiltinSkillAsset,
  readBrowserUseProgramSkillAsset,
  readBrowserUseShortSkillAsset,
  withBrowserOnDemandNote,
  withBrowserProgramSection,
} from './assets/browser-skill-asset.js';
import {
  createBrowserUseExtension,
  createBrowserUseTurnToolSafetyGuard,
  isBrowserUseToolingAvailable,
} from './policy.js';
import {
  BROWSER_CONTROL_CONFIG_DISABLED_GUIDANCE,
  buildInAppBrowserContext,
  hasExplicitInAppBrowserOperationIntent,
} from './reminders.js';
import { createBrowserScreenshotPreprocessor } from './assets/screenshot-preprocessor.js';
import type { BrowserScreenshotPreprocessor } from './assets/screenshot-preprocessor.js';
import { BrowserSkillSessionStore, BrowserTurnContextStore } from './session-state.js';
import { createWorkspaceBrowserAssetAdapter } from './assets/workspace-assets.adapter.js';
import { createBrowserUseMetrics, type BrowserUseMetrics } from './browser-use-metrics.js';
import { createBrowserProgramExecutor } from './program/program-executor.js';
import { BrowserProgramStateStore } from './program/state-store.js';

const BROWSER_UNAVAILABLE_GUIDANCE =
  'Browser control is unavailable in this turn. Report the unavailable Browser capability; do not call request_feature_enable.';

type BrowserUseDesktopCapabilities = NonNullable<
  BrowserUseTurnCapabilityInput['desktopCapabilities']
>;
type BrowserUseHostBinding = NonNullable<BrowserUseDesktopCapabilities['hostBindings']>[number];

export class LocalBrowserUseService implements BrowserUseService {
  readonly turnContext = new BrowserTurnContextStore();
  private readonly skillSessionStore = new BrowserSkillSessionStore();
  private readonly requiredSkillByTurn = new Map<string, string>();
  /** Sub-Agent sessions whose Browser is private and closed when the Agent ends. */
  private readonly ephemeralBrowserSessions = new Set<string>();
  private readonly screenshotPreprocessor: BrowserScreenshotPreprocessor;
  private builtinSkillFailed = false;
  /**
   * Skill variants (program, short, Plugin program section) whose assets did
   * not fit: their turns use the plain Skill instead, logged once per Runtime.
   */
  private readonly failedSkillVariants = new Set<string>();
  private readonly metrics: BrowserUseMetrics | undefined;
  private readonly programState = new BrowserProgramStateStore();
  private readonly programExecutor = createBrowserProgramExecutor({
    stateStore: this.programState,
  });
  readonly extension = createBrowserUseExtension({
    requiredSkillName: (sessionId, turnId) =>
      this.requiredSkillByTurn.get(turnKey(sessionId, turnId)),
    clearTurn: (sessionId, turnId) => {
      this.requiredSkillByTurn.delete(turnKey(sessionId, turnId));
      this.metrics?.finishTurn(sessionId, turnId);
    },
    notifyLifecycle: (type, sessionId, turnId) => {
      const ephemeral = this.ephemeralBrowserSessions.has(sessionId);
      if (type === 'turn_end') this.ephemeralBrowserSessions.delete(sessionId);
      this.options.adapter?.notifyLifecycle?.({
        type,
        sessionId,
        turnId,
        ...(ephemeral ? { ephemeral: true } : {}),
      });
    },
  });
  readonly reminders = {
    buildTurnReminder: (input: BrowserUseTurnReminderInput) => this.buildTurnReminder(input),
  };

  constructor(private readonly options: BrowserUseServiceOptions) {
    this.screenshotPreprocessor = createBrowserScreenshotPreprocessor({
      getImageEncoding: options.getImageEncoding,
      registerGeneratedAsset: options.registerGeneratedAsset,
    });
    this.metrics = options.metrics ? createBrowserUseMetrics(options.metrics) : undefined;
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
    // PTC on = Browser programs (the provider must declare programOps).
    // ARCHON_BROWSER_PROGRAM=0 is an internal evaluation control only.
    const wantPrograms = input.ptc === true && process.env.ARCHON_BROWSER_PROGRAM !== '0';
    const short = this.usesShortTexts();
    const { skill: requiredSkill, programs } = this.turnSkill(
      this.resolveRequiredSkill(
        input.desktopCapabilities,
        input.allowedExtensionSkillNames,
        input.surface,
      ),
      wantPrograms,
      short,
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
    const providerAdapter = this.options.adapter;
    if (!providerAdapter || !requiredSkill) {
      return { tools: baseTools, controlAuthorized: false };
    }
    // A sub-Agent gets its own private Browser, closed when its turn ends.
    const ephemeral = input.surface === 'task-child';
    if (ephemeral) this.ephemeralBrowserSessions.add(input.sessionId);
    const delegate = ephemeral ? createEphemeralBrowserAdapter(providerAdapter) : providerAdapter;
    const assertLiveAvailability = () =>
      this.options.activationMode === 'explicit-config'
        ? this.isExplicitlyEnabled()
        : this.isProviderAvailable();
    const guardedDelegate = createLiveBrowserUseAdapter(delegate, assertLiveAvailability);
    const workspaceAdapter = createWorkspaceBrowserAssetAdapter(guardedDelegate, {
      workspaceRoot: input.workspaceRoot,
    });
    const receipt = bindTurnSkillReceipt(this.skillSessionStore, requiredSkill);
    const exposure = this.toolExposure();
    const browserTools = buildLocalBrowserRuntimeTools(
      // Keep the live kill switch outside every action-specific adapter so a
      // revoked Turn performs no workspace I/O before failing closed.
      createLiveBrowserUseAdapter(workspaceAdapter, assertLiveAvailability),
      {
        ...(exposure ? { exposure } : {}),
        browserSkillSessionStore: receipt,
        preprocessScreenshot: this.screenshotPreprocessor,
        ...(this.metrics ? { observer: this.metrics } : {}),
        postActionVisualInPtc: () => this.options.readConfig().ptcPostActionScreenshot !== false,
        compactInspect: () => this.options.readConfig().compactInspect === true,
        shortDescription: short,
        ...(programs ? { programRunner: this.programExecutor } : {}),
      },
    ).map((tool) => bindRequiredSkillDescription(tool, requiredSkill.name));
    return {
      tools: insertBrowserTools(baseTools, browserTools),
      requiredSkill,
      controlAuthorized: true,
    };
  }

  builtinSkillDescriptor(): BrowserUseBuiltinSkillDescriptor | undefined {
    return this.readBuiltinSkill();
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
    this.metrics?.clearSession(sessionId);
    this.programState.clearSession(sessionId);
    for (const key of this.requiredSkillByTurn.keys()) {
      if (key.startsWith(`${sessionId}\0`)) this.requiredSkillByTurn.delete(key);
    }
  }

  close(): void {
    this.skillSessionStore.clear();
    this.screenshotPreprocessor.clear();
    this.turnContext.clear();
    this.metrics?.clear();
    this.requiredSkillByTurn.clear();
    this.programState.clear();
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
    // Tabs are worth reporting even while the panel is closed: the Agent may reuse one.
    const hasTabs = (inAppBrowser?.tabs?.length ?? 0) > 0;
    const disabledGuidance = resolveDisabledGuidance(
      this.options.activationMode,
      browserDisabledGuidanceInjected,
      this.options.readConfig().browserUseToolingEnabled,
    );
    const content = [
      inAppBrowser && (surfaceVisible || hasTabs)
        ? buildInAppBrowserContext({ ...inAppBrowser, controlAuthorized })
        : '',
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
      return this.readBuiltinSkill();
    }
    return resolveDesktopRequiredSkill(capabilities, allowedExtensionSkillNames, surface);
  }

  /**
   * The Skill describes this turn's run_script, so it follows the provider
   * check `buildLocalBrowserRuntimeTools` makes for the runner: the builtin
   * Skill becomes its program variant, a Plugin-bound Skill (desktop) gets the
   * program section, naming the Browser by its Plugin-bound name
   * `mcp_browser`. `short` (`browser.compactInspect`) selects the short
   * builtin Skill; a Plugin-bound Skill keeps the Plugin's text. Desktop
   * exposure is compact, and the compact Browser loads on demand, so the
   * Plugin-bound Skill always ends with the on-demand host note. When the
   * program variant cannot be built, the turn runs without programs, so its
   * run_script matches the Skill it got.
   */
  private turnSkill(
    skill: BrowserUseBoundSkill | undefined,
    wantPrograms: boolean,
    short: boolean,
  ): { skill: BrowserUseBoundSkill | undefined; programs: boolean } {
    if (!skill) return { skill, programs: wantPrograms };
    const programVariant =
      wantPrograms &&
      this.toolExposure() !== 'full' &&
      this.options.adapter?.getCapabilities?.().programOps === true;
    if (this.options.activationMode === 'explicit-config') {
      const programSkill = programVariant ? this.readBuiltinSkill(true, short) : undefined;
      if (programSkill) return { skill: programSkill, programs: true };
      return {
        skill: this.readBuiltinSkill(false, short),
        programs: wantPrograms && !programVariant,
      };
    }
    if (skill.content === undefined) return { skill, programs: wantPrograms };
    return this.pluginTurnSkill({ ...skill, content: skill.content }, wantPrograms, programVariant);
  }

  /**
   * The Plugin-bound Skill (desktop): the program section when this turn runs
   * programs (without programs when the section cannot be built), and the
   * on-demand host note at its end.
   */
  private pluginTurnSkill(
    skill: BrowserUseBoundSkill & { readonly content: string },
    wantPrograms: boolean,
    programVariant: boolean,
  ): { skill: BrowserUseBoundSkill; programs: boolean } {
    const section = programVariant
      ? this.skillVariant('plugin-program', () =>
          withBrowserProgramSection(skill.content, 'mcp_browser'),
        )
      : undefined;
    const programs = wantPrograms && (!programVariant || section !== undefined);
    return {
      skill: { ...skill, content: withBrowserOnDemandNote(section ?? skill.content) },
      programs,
    };
  }

  /**
   * The builtin Skill. A variant (program, short) whose assets do not fit
   * falls back to the next plainer one: a program variant to undefined (the
   * caller then runs the turn without programs), the short Skill to SKILL.md.
   * Only a missing or invalid SKILL.md withdraws Browser.
   */
  private readBuiltinSkill(
    programs = false,
    short = false,
  ): BrowserUseBuiltinSkillDescriptor | undefined {
    if (
      this.options.activationMode !== 'explicit-config' ||
      !this.isProviderAvailable() ||
      !this.isExplicitlyEnabled()
    ) {
      return undefined;
    }
    if (programs) {
      return this.skillVariant(`program${short ? '-short' : ''}`, () =>
        readBrowserUseProgramSkillAsset(short),
      );
    }
    if (short) {
      return this.skillVariant('short', readBrowserUseShortSkillAsset) ?? this.readBuiltinSkill();
    }
    try {
      return readBrowserUseBuiltinSkillAsset();
    } catch (error) {
      // Assets belong to the installation. Keep this capability unavailable until
      // Runtime restarts, without repeating a broken read on every ordinary turn.
      this.builtinSkillFailed = true;
      this.requiredSkillByTurn.clear();
      logger.warn({ err: error, programs, short }, 'browser.skill_asset_unavailable');
      return undefined;
    }
  }

  /**
   * One Skill variant, or undefined when its assets do not fit (a reference
   * reworded so a section is no longer found). Logged once and not retried
   * until Runtime restarts; Browser itself stays available.
   */
  private skillVariant<T>(variant: string, build: () => T): T | undefined {
    if (this.failedSkillVariants.has(variant)) return undefined;
    try {
      return build();
    } catch (error) {
      this.failedSkillVariants.add(variant);
      logger.warn({ err: error, variant }, 'browser.skill_variant_unavailable');
      return undefined;
    }
  }

  private toolExposure(): BrowserUseServiceOptions['toolExposure'] {
    return this.options.activationMode === 'desktop-plugin' ? 'compact' : this.options.toolExposure;
  }

  /** `browser.compactInspect` this Turn: the short texts go with the compact tool only. */
  private usesShortTexts(): boolean {
    return this.options.readConfig().compactInspect === true && this.toolExposure() !== 'full';
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
    if (this.builtinSkillFailed) return false;
    const adapter = this.options.adapter;
    if (!adapter) return false;
    const provider = adapter.getCapabilities?.().provider?.trim();
    return provider && provider !== 'electron-file-panel'
      ? true
      : this.options.readConfig().filePanelBrowserEnabled === true;
  }

  private isExplicitlyEnabled(): boolean {
    if (this.builtinSkillFailed) return false;
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
  browserUseToolingEnabled: boolean | undefined,
): string {
  if (!shouldInject) return '';
  // Only the config switch is fixable by the user; a missing provider is not.
  if (mode === 'explicit-config' && browserUseToolingEnabled === false) {
    return BROWSER_CONTROL_CONFIG_DISABLED_GUIDANCE;
  }
  return BROWSER_UNAVAILABLE_GUIDANCE;
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
        const otherCopy = otherBrowserSkillCopy(requested, requiredSkill?.name);
        if (otherCopy) return otherCopy;
        if (input.mode === 'desktop-plugin' && requested === CONTROL_IN_APP_BROWSER_SKILL_NAME) {
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

/**
 * Another copy of the Browser Skill: the native asset where the Plugin binds
 * Browser, or a Plugin copy (`<plugin>:control-in-app-browser`) where the
 * native Browser runs (one evaluation run: 4 tasks per arm loaded the Plugin copy
 * and then hit SKILL_REQUIRED). The bodies differ (the Plugin copy drives
 * `mcp_browser`), so the result names the copy this turn's Browser needs
 * instead of loading the other one.
 */
function otherBrowserSkillCopy(
  requested: string | undefined,
  requiredSkillName: string | undefined,
): ToolResult | undefined {
  if (!requested || !requiredSkillName || requested === requiredSkillName) return undefined;
  const isCopy =
    requested === CONTROL_IN_APP_BROWSER_SKILL_NAME ||
    requested.endsWith(`:${CONTROL_IN_APP_BROWSER_SKILL_NAME}`);
  return isCopy ? otherBrowserSkillCopyResult(requested, requiredSkillName) : undefined;
}

function otherBrowserSkillCopyResult(requested: string, requiredSkillName: string): ToolResult {
  const text = `Not loaded: \`${requested}\` is another copy of the Browser Skill, written for a different Browser tool, and does not unlock the Browser of this session. Load \`${requiredSkillName}\` with the skill tool instead, as the only tool call of that step.`;
  return {
    tool_name: 'skill',
    text,
    content: [{ type: 'text', text }],
    details: {
      kind: 'skill',
      skill: requested,
      found: false,
      readable: false,
      owner: 'browser-use-v2',
      requiredSkill: requiredSkillName,
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

function createEphemeralBrowserAdapter(delegate: LocalBrowserAdapter): LocalBrowserAdapter {
  const getCapabilities = delegate.getCapabilities?.bind(delegate);
  return {
    ...(getCapabilities ? { getCapabilities } : {}),
    // run_script's program_start/program_end reach the provider here, marked like its ops.
    notifyLifecycle: (event) => delegate.notifyLifecycle?.({ ...event, ephemeral: true }),
    execute: (ctx, action, input, signal) =>
      delegate.execute({ ...ctx, browserEphemeral: true }, action, input, signal),
  };
}

function createLiveBrowserUseAdapter(
  delegate: LocalBrowserAdapter,
  isAvailable: () => boolean,
): LocalBrowserAdapter {
  const getCapabilities = delegate.getCapabilities?.bind(delegate);
  return {
    ...(getCapabilities ? { getCapabilities } : {}),
    // Lifecycle is not gated: a program_end must reach the provider even after revocation.
    notifyLifecycle: (event) => delegate.notifyLifecycle?.(event),
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
