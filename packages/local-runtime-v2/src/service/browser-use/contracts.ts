import type { PiAfterToolCallHook, PiBeforeToolCallHook } from '@mavis/agent-core/pi-turn-runner';
import type { RuntimeTool } from '@mavis/agent-core/tools';
import type { AgentExtension } from '@mavis/agent-runtime';
import type { LocalBrowserAdapter, LocalBrowserToolExposure } from '@mavis/agent-tools/desktop';

interface BrowserUseConfigSnapshot {
  readonly filePanelBrowserEnabled?: boolean;
  readonly browserUseToolingEnabled?: boolean;
}

export interface InAppBrowserSurfaceState {
  readonly visible: boolean;
  readonly selectedTab: boolean;
}

export interface InAppBrowserReminderState extends InAppBrowserSurfaceState {
  readonly controlAuthorized: boolean;
}

export interface BrowserTurnContextRecordInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly inAppBrowser: InAppBrowserSurfaceState;
}

export interface BrowserTurnContextCapability {
  record(input: BrowserTurnContextRecordInput): void;
  read(sessionId: string, turnId: string | undefined): InAppBrowserSurfaceState | undefined;
  clearSession(sessionId: string): void;
}

/** `requestMedia.image`, the limits every image entering the conversation is encoded to. */
export interface BrowserScreenshotImageEncoding {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxBase64Bytes: number;
}

interface BrowserGeneratedScreenshotAsset {
  readonly assetId: string;
  readonly absolutePath: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly bytes: number;
}

type BrowserGeneratedAssetRegistrar = (input: {
  readonly fileName: string;
  readonly mimeType: string;
  readonly kind: 'image';
  readonly sourceKind: 'generated';
  readonly dataUrl: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly generatedBy: 'browser_screenshot';
}) => Promise<BrowserGeneratedScreenshotAsset>;

export interface BrowserUseServiceOptions {
  readonly adapter?: LocalBrowserAdapter;
  readonly toolExposure?: LocalBrowserToolExposure;
  readonly readConfig: () => BrowserUseConfigSnapshot;
  readonly getImageEncoding: () => BrowserScreenshotImageEncoding;
  readonly registerGeneratedAsset: BrowserGeneratedAssetRegistrar;
  /** Desktop is Plugin-managed; CLI/TUI retain explicit config enablement. */
  readonly activationMode: 'desktop-plugin' | 'explicit-config';
}

export interface BrowserUseBoundSkill {
  readonly name: string;
  readonly content?: string;
  readonly location?: string;
  readonly sourceKind?: string;
}

/** Package-owned standalone Skill used only by explicit CLI/TUI Browser mode. */
export interface BrowserUseBuiltinSkillDescriptor extends BrowserUseBoundSkill {
  readonly description: string;
  readonly content: string;
  readonly location: string;
  readonly sourceKind: 'builtin';
}

export interface BrowserUseTurnCapabilityInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly surface?: 'interactive' | 'task-child' | 'cli';
  readonly workspaceRoot: string;
  readonly baseTools: readonly RuntimeTool[];
  readonly allowedExtensionSkillNames?: readonly string[];
  readonly desktopCapabilities?: {
    readonly hostBindings?: readonly {
      readonly pluginName: string;
      readonly hostCapability: { readonly id: string; readonly version: number };
      readonly requiredSkillRuntimeNames: readonly string[];
      readonly allowedSurfaces: readonly NonNullable<BrowserUseTurnCapabilityInput['surface']>[];
    }[];
    readonly skills: readonly {
      readonly name: string;
      readonly content: string;
      readonly location: string;
      readonly sourceKind: string;
    }[];
  };
}

export interface BrowserUseTurnCapability {
  readonly tools: readonly RuntimeTool[];
  readonly requiredSkill?: BrowserUseBoundSkill;
  readonly controlAuthorized: boolean;
}

export interface BrowserUseTurnReminderInput {
  readonly sessionId: string;
  readonly turnId: string;
  readonly surface?: BrowserUseTurnCapabilityInput['surface'];
  readonly userPrompt: string;
  readonly allowedExtensionSkillNames?: readonly string[];
  readonly desktopCapabilities?: BrowserUseTurnCapabilityInput['desktopCapabilities'];
}

export interface BrowserUseTurnReminder {
  readonly content: string;
  readonly diagnostic?: Readonly<Record<string, unknown>>;
}

interface BrowserUseQuestionnaireAdmissionInput {
  readonly request: {
    readonly mode?: string;
    readonly modePayload?: { readonly featureKey?: string };
  };
}

interface BrowserUseQuestionnaireAdmissionRejection {
  readonly status: 403;
  readonly code: 'BROWSER_PLUGIN_MANAGED';
  readonly message: string;
}

interface BrowserUseReminderCapability {
  buildTurnReminder(input: BrowserUseTurnReminderInput): BrowserUseTurnReminder;
}

export interface BrowserUseTurnToolSafetyGuard {
  readonly beforeToolCall: PiBeforeToolCallHook;
  readonly afterToolCall: (
    input: Parameters<PiAfterToolCallHook>[0],
    signal?: AbortSignal,
  ) => void | Promise<void>;
}

export interface BrowserUseService {
  readonly extension: AgentExtension;
  readonly turnContext: BrowserTurnContextCapability;
  readonly reminders: BrowserUseReminderCapability;
  createTurnToolSafetyGuard(): BrowserUseTurnToolSafetyGuard;
  isAvailable(desktopCapabilities?: BrowserUseTurnCapabilityInput['desktopCapabilities']): boolean;
  resolveTurnCapability(input: BrowserUseTurnCapabilityInput): BrowserUseTurnCapability;
  builtinSkillDescriptor(): BrowserUseBuiltinSkillDescriptor | undefined;
  admitQuestionnaireRequest(
    input: BrowserUseQuestionnaireAdmissionInput,
  ): BrowserUseQuestionnaireAdmissionRejection | undefined;
  notifyContextReset(sessionId: string): void;
  clearSession(sessionId: string): void;
  close(): void;
}
