import {
  resolveRunawayGuardConfig,
  type RunawayGuardSettings,
} from "./runaway-guard-config.js";
import fs from "node:fs";
import { restrictConfigFileSync, writePrivateConfigFileSync } from "./private-config-file.js";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import { parseTuiConfig, type TuiConfig } from "./tui-config.js";
import {
  applyManagedMinimaxContextLimits,
  applyRequiredProviderOverrides,
  migrateLegacyByokProvidersOnDisk,
  restrictLegacyByokBackups,
  normalizeLegacyThinkingEfforts,
  parseCustomProvidersConfig,
  parseMinimaxApiConfig,
  parseModelContextLimits,
  type RequiredProviderOverrideDeps,
} from "./byok-config.js";
import {
  type CuBackend,
  DEFAULT_CU_BACKEND,
  parseCuBackend,
} from "./cu-backend.js";
import { parseReviewConfig } from "./review-config.js";
import { parseOpenCodeAdapterConfig } from "./opencode-config.js";
import type { AsrConfig } from "./asr.js";
import { ASR_DEFAULTS, parseAsrConfig } from "./asr.js";
import {
  parsePermissionConfig,
  type PermissionConfig,
} from "./permission-config.js";

import type { SkillEvolveConfig } from "./skill-evolve-config.js";
import {
  DEFAULT_SKILLS_CONFIG,
  parseSkillsConfig,
  type SkillsConfig,
} from "./skills-config.js";
import {
  DEFAULT_AGENT_RUNTIME_FRAMEWORK,
  parseAgentRuntimeConfig,
  type AgentRuntimeConfig,
} from "./agent-runtime-config.js";
import { resolveDataDir } from "./data-dir.js";
import type { ProviderAuthMode } from "./provider-auth-mode.js";
import { parseAgentsConfig, type AgentsConfig } from "./agent-capabilities.js";
import {
  ASK_USER_CONFIG_DEFAULTS,
  parseAskUserConfig,
  type AskUserConfig,
} from "./ask-user-config.js";
import {
  GOAL_CONFIG_DEFAULTS,
  parseGoalConfig,
  type GoalConfig,
} from "./goal-config.js";
import {
  TOOL_RESULT_COMPACTION_DEFAULTS,
  parseToolResultCompactionConfig,
  type ToolResultCompactionSettings,
} from "./tool-result-compaction-config.js";
import {
  BROWSER_CONFIG_DEFAULTS,
  parseBrowserConfig,
  type BrowserConfig,
} from "./browser-config.js";
import {
  parseSandboxConfig,
  SANDBOX_CONFIG_DEFAULTS,
  type SandboxConfig,
} from "./sandbox-config.js";

export type { TuiConfig, TuiCustomStatusLineConfig } from "./tui-config.js";

/** Set to `true` by esbuild during `pnpm build:npm`; undefined in dev (tsx). */
declare const __IS_NPM_BUILD__: boolean | undefined;

function isLegacyRuntimeEnvAllowed(): boolean {
  return process.env.__MAVIS_ALLOW_LEGACY_RUNTIME_ENV === "1";
}

// ---------------------------------------------------------------------------
// Runtime environment types & helpers (MAVIS_* plus Electron cold-start fallbacks)
// ---------------------------------------------------------------------------

export type MavisRegion = "cn" | "en";
export type MavisBuildEnv = "test" | "prod" | "dev" | "staging";

// Electron loads the config package before local-runtime's managed-env
// bootstrap has copied the build-time NEXT_PUBLIC_* values into MAVIS_*.
// Keep this mapping local to config so the first (sticky) beta-flag read sees
// the packaged build environment. Electron's dev build uses the test runtime.
const ELECTRON_BUILD_ENV_TO_RUNTIME: Readonly<Record<string, MavisBuildEnv>> = {
  dev: "test",
  test: "test",
  staging: "staging",
  prod: "prod",
};

function isValidRuntimeRegion(value: string | undefined): value is MavisRegion {
  return value === "cn" || value === "en";
}

function isValidRuntimeBuildEnv(
  value: string | undefined,
): value is MavisBuildEnv {
  return (
    value === "test" ||
    value === "prod" ||
    value === "dev" ||
    value === "staging"
  );
}

export function getRuntimeRegion(): MavisRegion {
  const val = process.env.MAVIS_REGION;
  if (isValidRuntimeRegion(val)) return val;

  if (isElectronProcess()) {
    const locale = process.env.NEXT_PUBLIC_LOCALE;
    if (locale === "zh") return "cn";
    if (locale === "en") return "en";
  }

  return "en";
}

export function getRuntimeBuildEnv(): MavisBuildEnv {
  const val = process.env.MAVIS_BUILD_ENV;
  if (isValidRuntimeBuildEnv(val)) return val;

  if (isElectronProcess()) {
    const nextBuildEnv = process.env.NEXT_PUBLIC_BUILD_ENV;
    const mapped =
      nextBuildEnv &&
      Object.prototype.hasOwnProperty.call(
        ELECTRON_BUILD_ENV_TO_RUNTIME,
        nextBuildEnv,
      )
        ? ELECTRON_BUILD_ENV_TO_RUNTIME[nextBuildEnv]
        : undefined;
    if (mapped) return mapped;
  }

  return "dev";
}

/**
 * Whether this process is running inside the managed runtime (Electron app or
 * packaged desktop runtime).
 *
 * Detection priority:
 *   1. Explicit __MAVIS_RUNTIME_MANAGED env var ('1'/'0') — for overrides
 *      - '1': force-enable (e.g. `__MAVIS_RUNTIME_MANAGED=1 pnpm dev` to test C-end locally)
 *      - '0': force-disable (used by internal/no-safety Electron builds to opt out)
 *   2. Auto-detect Electron (main process or ELECTRON_RUN_AS_NODE=1 helpers)
 *   3. Auto-detect production build (MAVIS_BUILD_ENV=prod)
 *   4. Default: false (pnpm dev / npm package)
 *
 * C-end features (safety hooks, remote models, managed token injection,
 * remote skill hub) should ONLY activate when this returns true.
 */
export function isManagedRuntime(): boolean {
  if (hasCliFlag("managed")) return true;
  const explicit = process.env.__MAVIS_RUNTIME_MANAGED;
  if (explicit === "1") return true;
  if (explicit === "0") return false;

  if (isElectronProcess()) return true;

  // Production builds always enable managed runtime
  if (getRuntimeBuildEnv() === "prod" || getRuntimeBuildEnv() === "staging")
    return true;

  return false;
}

function isElectronProcess(): boolean {
  const versions = process.versions as NodeJS.ProcessVersions & {
    electron?: string;
  };
  // ELECTRON_RUN_AS_NODE is kept for older helper subprocesses. The unified
  // local runtime runs inside Electron main and intentionally clears it.
  return (
    process.env.ELECTRON_RUN_AS_NODE === "1" ||
    typeof versions.electron === "string"
  );
}

export type PresetKey = `${MavisRegion}-${MavisBuildEnv}`;

export function getRuntimePresetKey(): PresetKey {
  return `${getRuntimeRegion()}-${getRuntimeBuildEnv()}` as PresetKey;
}

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "auto"
  | "off";

/** Upstream-defined reasoning effort stored verbatim for model configuration. */
export type EffortLevel = string;

export interface ThinkingConfig {
  /** User-defined choices exposed by the message input model selector. */
  effortOptions?: EffortLevel[];
  /** Explicit provider default. Managed models receive this from Apollo. */
  defaultEffort?: EffortLevel;
}

export type ModelThinkingMode =
  | "switchable"
  | "forced_on"
  | "forced_off"
  | "hidden";

export interface ModelThinkingConfig {
  /** Frontend thinking toggle display mode from remote model capability config. */
  mode?: ModelThinkingMode;
  /** Initial switch state for switchable models. Expected values: "true" or "false". */
  default_value?: string;
}

export interface SSEErrorPushConfig {
  /** Whether to publish history API errors to global SSE (`system.error`). */
  history: boolean;
  /** Whether to publish stream pipeline errors to global SSE (`system.error`). */
  stream: boolean;
}
export {
  isProposalEligibleAgent,
  type SkillEvolveConfig,
  type SkillEvolveInSessionConfig,
  type SkillEvolveLifecycleConfig,
  type SkillEvolveProposalConfig,
} from "./skill-evolve-config.js";

export interface NotificationsConfig {
  /** Alert root session when a branch session finishes without reporting. Default: false. */
  branchFinish?: boolean;
}

export interface PromptConfig {
  /** Automatic prompt delivery switch; enabled by default in official prod and inside builds, disabled in internal and non-prod builds. */
  autoUpdate: boolean;
}

// ── Session Rotation ─────────────────────────────────────────────

export interface SessionRotateConfig {
  /**
   * Master switch for session rotation (Main and Branch).
   * When false, `POST /api/agent/:name/session/rotate` returns 403 FEATURE_DISABLED.
   * Default: true. Set to false to disable rotation entirely.
   */
  enabled: boolean;

  /**
   * Lookback window used by rotate bootstrap to list recently active sessions.
   * Sessions with updatedAt within this many hours are shown to the new session
   * so it can explain why follow-up messages may arrive after rotation.
   *
   * Default: 12. Valid range: positive finite number.
   */
  activeSessionLookbackHours: number;
}

/**
 * `AgentStopDetector` runtime tunables — wired into the daemon at boot
 * via the runtime container so operators can tune the debounce window
 * and active-span backstop without rebuilding the binary.
 *
 * ```yaml
 * agentStop:
 *   debounceMs: 500           # 0 disables debouncing entirely
 *   maxActiveSpanMs: 1800000  # 30 min; 0 disables the backstop
 * ```
 */
export interface AgentStopDetectorConfig {
  /**
   * Window in ms for coalescing terminal `session.*` events before the
   * detector evaluates AgentStop gates. Default 500ms. Setting `0`
   * effectively disables debouncing — every terminal event triggers a
   * synchronous re-evaluation, which is generally only useful in tests.
   */
  debounceMs: number;
  /**
   * Maximum continuous producer-active span (in ms) before the detector
   * forces an `AgentStop` even when the inbox is non-empty. Default 30
   * minutes. Set to `0` to disable the backstop entirely (the detector
   * still fires on natural idle).
   */
  maxActiveSpanMs: number;
}

export type * from "./asr.js";
// ── Beta Features ────────────────────────────────────────────────

/**
 * Centralized switches for beta/experimental features.
 * Each feature is declared in `BETA_FEATURE_DEFS` with one default visibility
 * and one explicit-configuration ceiling.
 *
 * ```yaml
 * beta:
 *   autoMemory: false
 *   skillEvolve: false
 *   browserBridge: false
 *   filePanelBrowser: false
 *   filePanelBrowserMultiTab: false
 *   browserUseTooling: false
 *   browserUseAutoOpenPanel: false
 *   browserAgentCursor: false
 *   desktopPlanMode: true
 *   desktopPlanModeAgentEntry: false
 *   taskHistoryProjectGrouping: false
 *   threadGoal: false
 *   mcodeTools: false
 *   codexOAuth: false
 * ```
 */
export interface BetaConfig {
  /** Auto-memory extraction + daily digest + session promoter. */
  autoMemory: boolean;
  /**
   * Skill self-evolution — signal collection, scanning, editor spawning,
   * and the nightly evolve cron.
   *
   * `defaultVisibility: 'test', configurableVisibility: 'online'` — dev/test
   * ships ON by default so contributors get the feedback loop without extra
   * setup; production ships OFF by default and requires `beta.skillEvolve:
   * true` opt-in (model gating + nightly cron + filesystem writes are
   * non-trivial side effects that prod users should explicitly accept).
   *
   * Note: `skillEvolveBuiltinMr` is the finer-grained gate for the built-in
   * MR path specifically; it is configurable only through the test channel
   * and is relevant only when this parent gate is on.
   */
  skillEvolve: boolean;
  /**
   * Built-in skill evolution via MR — when set, the nightly evolver may
   * dispatch a worker that opens a GitLab MR against the daemon source repo
   * for each built-in skill needing changes. Gated separately from
   * `skillEvolve` so users with a source repo (dev installs) can still opt
   * out of MR-driven built-in evolution while keeping user/agent/project
   * skill evolution enabled. Its visibility ceiling is `test` because prod
   * npm installs have no source repo to push to.
   */
  skillEvolveBuiltinMr: boolean;
  /**
   * v3 skill creation proposal pipeline — session-end fallback re-prompt
   * asks eligible agents to reflect on whether the just-finished session
   * revealed a reusable pattern worth crystallizing into a new skill.
   * Wires up the ProposalStore CRUD and the fallback prompt's "proposal"
   * section. `defaultVisibility: 'test', configurableVisibility: 'online'`:
   * dev/test ships ON by default so contributors collect proposals
   * automatically; prod ships OFF and requires `beta.skillProposal: true`
   * opt-in (extra session-end LLM tokens + ProposalStore writes are
   * explicit-consent surface).
   */
  skillProposal: boolean;
  /**
   * Browser bridge HTTP API and UI panel — drives a real Chrome session via
   * the Mavis Browser Bridge extension (logged-in sites, persistent cookies,
   * extensions). `defaultVisibility: 'test', configurableVisibility:
   * 'online'` — ships ON in dev/test for daily use and OFF in prod by
   * default; prod users opt in via `beta.browserBridge: true` once they've
   * installed the Chrome extension and confirmed the broker socket.
   */
  browserBridge: boolean;
  /**
   * FilePanel embedded browser — an Electron-only WebContentsView target
   * shown inside the right-side panel. Both visibility fields are `online`,
   * so it ships ON by default in every environment while retaining
   * `beta.filePanelBrowser: false` as an emergency kill switch.
   */
  filePanelBrowser: boolean;
  /**
   * Multiple logical tabs inside the FilePanel embedded browser.
   *
   * Both visibility fields are `online`, so it ships ON by default in every
   * environment while retaining `beta.filePanelBrowserMultiTab: false` as an
   * emergency rollback to the established single-tab behavior.
   */
  filePanelBrowserMultiTab: boolean;
  /** Explicit Browser tool/Skill opt-in for CLI/TUI; Desktop activation is Plugin-managed. */
  browserUseTooling: boolean;
  /**
   * Whether model-driven Browser actions reveal the right-side Browser panel.
   * This is a presentation preference only: disabling it does not revoke
   * Browser Use permission or prevent the Agent from operating an existing
   * Browser tab in the background.
   *
   * The preference defaults ON in every environment to preserve the existing
   * visible-action behavior, while an explicit `false` keeps Browser actions
   * in the background until the user opens the panel manually.
   */
  browserUseAutoOpenPanel: boolean;
  /**
   * Visible pointer animation for model-driven Browser click, double-click,
   * and hover actions. Kept separate from both the CLI/TUI
   * `browserUseTooling` opt-in and Desktop Plugin activation so Browser Use
   * can remain available while the presentation layer is rolled out safely.
   *
   * Both visibility fields are `online`, so dev/test, Preview, Inside, and
   * external production builds show the pointer by default. An explicit
   * `beta.browserAgentCursor: false` remains available as a kill switch.
   */
  browserAgentCursor: boolean;
  /**
   * Desktop Plan Mode. Available online by default, with explicit `false` as
   * an emergency kill switch for new entry. Runtime owners must keep exit and
   * persisted-state recovery available while this switch is off.
   */
  desktopPlanMode: boolean;
  /**
   * Model-facing Desktop Plan Mode entry guidance and `EnterPlanMode` tool.
   * Kept separate from `desktopPlanMode` so users retain manual `/plan` and
   * composer entry while Agent-initiated entry stays opt-in.
   *
   * `defaultVisibility: 'none', configurableVisibility: 'online'` — every
   * channel starts with Agent entry disabled; explicit `true` is available as
   * a controlled rollback while the parent Plan Mode switch remains enabled.
   */
  desktopPlanModeAgentEntry: boolean;
  /**
   * /btw side-question peek command (the UI's "Aside" slash palette row). Both visibility fields
   * are `test`, so dev/test ships ON by default while prod is force-off regardless of config.yaml
   * (even `beta.peek: true` cannot open it).
   * Fail-closed contract: local-runtime `/mavis/api/config` returns the resolved `beta.peek`, UI
   * hydrates `runtimeFlagStore.peekEnabled` strictly from `beta?.peek === true`, and the composer
   * only exposes `/btw` when that flag is true.
   */
  peek: boolean;
  /**
   * Legacy OpenCode keep-alive pool. New local sessions do not use this path,
   * but the daemon package remains in the workspace compile surface while old
   * opencode sessions are still resumable through the legacy boundary.
   */
  keepAlive: boolean;
  /**
   * Memory prompt override via filesystem — when enabled, memory-related
   * LLM prompts check `{dataDir}/internal/prompts/{name}.md` first.
   * If the file exists, its content replaces the hardcoded prompt entirely.
   * Its visibility ceiling is `test` because prompt file paths are not yet
   * stable for end-users.
   */
  promptOverride: boolean;
  /**
   * Computer Use mode — agent-driven mouse/keyboard/screen control via the archon Electron
   * renderer. Adds a CU toggle to the chat input toolbar, a CUBanner above MessageInput, a Computer
   * Use permissions section in SettingsModal/Desktop, and the dock-restore abort behaviour.
   *
   * Both visibility fields are `online`, so CU is available in every environment. CU controls the
   * user's host machine via macOS TCC-gated screen recording / accessibility / input synthesis, but
   * the toggle still defaults to OFF — user must explicitly click it and grant macOS TCC
   * permissions.
   *
   * Even when this gate is true, the toggle still defaults to OFF and the user must explicitly
   * click it (and grant the macOS TCC permission on first run) before any CU tool call can fire.
   * The gate controls whether the toggle/banner/permission section are *available* in the UI — not
   * whether CU is *active*.
   */
  cuMode: boolean;
  asr: boolean;
  /**
   * Sidebar Task History project-grouping overflow entry (`recents` ↔
   * `projects`). Replaces the prior `isWebVariant` platform gate. Hydrated
   * from `beta?.taskHistoryProjectGrouping === true` (strict); fail-closed
   * keeps trigger hidden + `viewMode` locked to `recents`. Both visibility
   * fields are `online`, keeping the desktop selector available by default in
   * every channel. See runtime-flags.ts.
   */
  taskHistoryProjectGrouping: boolean;
  /**
   * Thread Goal UI, tools, accounting, and auto-continuation. Dev/test and
   * internal prod builds default ON for dogfooding; external and inside prod
   * builds default OFF but can be explicitly enabled with
   * `beta.threadGoal: true` in config.yaml.
   */
  threadGoal: boolean;
  /**
   * Bundled mcode-tools CLI and Electron Device Flow integration. Packaged
   * dev/test/staging/prod builds default ON on macOS/Linux/Windows. An explicit
   * config.yaml false value may opt any supported build out. This switch does
   * not control native web_search; Electron, TUI and CLI use the native tool
   * without starting the built-in Matrix MCP.
   */
  mcodeTools: boolean;
  /**
   * OpenAI Codex OAuth settings entry. Enabled by default in internal builds and development
   * environments, regardless of the connected backend environment. Public prod / external staging /
   * Inside / test builds expose the OAuth connection button in desktop model settings via
   * `beta.codexOAuth: true`. Provider configuration stays in `config.yaml` and OAuth credentials
   * stay in `<dataDir>/codex-auth.json`.
   */
  codexOAuth: boolean;
}

export type FeatureVisibility = "none" | "test" | "internal" | "online";
export type FeatureChannel = Exclude<FeatureVisibility, "none">;
export type BetaBuildVariant = "internal" | "inside";

export interface BetaFeatureDef {
  /** Furthest channel where the feature is enabled without explicit config. */
  defaultVisibility: FeatureVisibility;
  /** Exact build environments where the feature is enabled without explicit config. */
  defaultBuildEnvironments?: readonly MavisBuildEnv[];
  /** Platforms where any default rollout may enable the feature. */
  defaultPlatforms?: readonly NodeJS.Platform[];
  /**
   * Features enabled by default for build variants (internal / inside), independent of buildEnv.
   * Variant flags are injected by the packaging lane; internal builds use a staging backend but
   * must retain internal-build feature defaults.
   */
  defaultBuildVariants?: readonly BetaBuildVariant[];
  /** Furthest channel where explicit `true` may enable the feature. */
  configurableVisibility: FeatureVisibility;
}

export const VISIBILITY_RANK: Readonly<Record<FeatureVisibility, number>> = {
  none: 0,
  test: 1,
  internal: 2,
  online: 3,
};

const BUILD_VARIANT_VISIBILITY: Readonly<
  Record<BetaBuildVariant, FeatureChannel>
> = {
  internal: "internal",
  inside: "online",
};

/**
 * Fail fast when a feature's default rollout is wider than its opt-in ceiling.
 * Silently correcting this would hide a release-policy error and could expose a
 * feature to a broader channel than intended.
 */
export function assertBetaFeatureDefinitions(
  defs: Readonly<Record<string, BetaFeatureDef>>,
): void {
  for (const [feature, def] of Object.entries(defs)) {
    if (
      VISIBILITY_RANK[def.defaultVisibility] >
      VISIBILITY_RANK[def.configurableVisibility]
    ) {
      throw new Error(
        `Invalid beta feature definition "${feature}": defaultVisibility ` +
          `(${def.defaultVisibility}) must not exceed configurableVisibility ` +
          `(${def.configurableVisibility})`,
      );
    }
    for (const variant of def.defaultBuildVariants ?? []) {
      const variantVisibility = BUILD_VARIANT_VISIBILITY[variant];
      if (
        VISIBILITY_RANK[variantVisibility] >
        VISIBILITY_RANK[def.configurableVisibility]
      ) {
        throw new Error(
          `Invalid beta feature definition "${feature}": defaultBuildVariant ` +
            `(${variant}) must not exceed configurableVisibility ` +
            `(${def.configurableVisibility})`,
        );
      }
    }
    for (const buildEnv of def.defaultBuildEnvironments ?? []) {
      const buildEnvVisibility: FeatureChannel =
        buildEnv === "prod" ? "online" : "test";
      if (
        VISIBILITY_RANK[buildEnvVisibility] >
        VISIBILITY_RANK[def.configurableVisibility]
      ) {
        throw new Error(
          `Invalid beta feature definition "${feature}": defaultBuildEnvironment ` +
            `(${buildEnv}) must not exceed configurableVisibility ` +
            `(${def.configurableVisibility})`,
        );
      }
    }
  }
}

export const BETA_FEATURE_DEFS = {
  autoMemory: { defaultVisibility: "online", configurableVisibility: "online" },
  skillEvolve: { defaultVisibility: "test", configurableVisibility: "online" },
  skillEvolveBuiltinMr: {
    defaultVisibility: "none",
    configurableVisibility: "test",
  },
  skillProposal: {
    defaultVisibility: "test",
    configurableVisibility: "online",
  },
  browserBridge: {
    defaultVisibility: "test",
    configurableVisibility: "online",
  },
  filePanelBrowser: {
    defaultVisibility: "online",
    configurableVisibility: "online",
  },
  filePanelBrowserMultiTab: {
    defaultVisibility: "online",
    configurableVisibility: "online",
  },
  browserUseTooling: {
    defaultVisibility: "online",
    configurableVisibility: "online",
  },
  browserUseAutoOpenPanel: {
    defaultVisibility: "online",
    configurableVisibility: "online",
  },
  browserAgentCursor: {
    defaultVisibility: "online",
    configurableVisibility: "online",
  },
  desktopPlanMode: {
    defaultVisibility: "online",
    configurableVisibility: "online",
  },
  desktopPlanModeAgentEntry: {
    defaultVisibility: "none",
    configurableVisibility: "online",
  },
  peek: { defaultVisibility: "test", configurableVisibility: "test" },
  keepAlive: { defaultVisibility: "test", configurableVisibility: "test" },
  promptOverride: { defaultVisibility: "test", configurableVisibility: "test" },
  cuMode: { defaultVisibility: "online", configurableVisibility: "online" },
  asr: { defaultVisibility: "online", configurableVisibility: "online" },
  taskHistoryProjectGrouping: {
    defaultVisibility: "online",
    configurableVisibility: "online",
  },
  threadGoal: { defaultVisibility: "online", configurableVisibility: "online" },
  mcodeTools: {
    defaultVisibility: "none",
    defaultBuildEnvironments: ["dev", "test", "staging", "prod"],
    defaultPlatforms: ["darwin", "linux", "win32"],
    configurableVisibility: "online",
  },
  codexOAuth: {
    defaultVisibility: "none",
    defaultBuildEnvironments: ["dev"],
    defaultBuildVariants: ["internal"],
    configurableVisibility: "online",
  },
} satisfies Record<keyof BetaConfig, BetaFeatureDef>;

assertBetaFeatureDefinitions(BETA_FEATURE_DEFS);

export interface BetaFeatureResolutionContext {
  buildEnv?: MavisBuildEnv;
  defaultBuildEnvironment?: MavisBuildEnv;
  internalBuild?: boolean;
  insideBuild?: boolean;
  platform?: NodeJS.Platform;
  mcodeToolsDevMode?: "published";
}

function getBetaFeatureChannel(
  context: BetaFeatureResolutionContext,
): FeatureChannel {
  const buildEnv = context.buildEnv ?? getRuntimeBuildEnv();
  if (buildEnv !== "prod") return "test";
  return context.internalBuild === true ? "internal" : "online";
}

// Variant defaults depend only on variant flags: internal builds use buildEnv=staging but remain on the internal release lane
// and must retain internal defaults such as codexOAuth. Inside builds still use buildEnv=prod.
function isDefaultEnabledForBuildVariant(
  def: BetaFeatureDef,
  context: BetaFeatureResolutionContext,
): boolean {
  const variants = def.defaultBuildVariants;
  if (!variants) return false;
  return (
    (context.internalBuild === true && variants.includes("internal")) ||
    (context.insideBuild === true && variants.includes("inside"))
  );
}

function isDefaultEnabledForBuildEnvironment(
  def: BetaFeatureDef,
  context: BetaFeatureResolutionContext,
): boolean {
  const buildEnv =
    context.defaultBuildEnvironment ??
    context.buildEnv ??
    getBetaDefaultBuildEnvironment();
  return def.defaultBuildEnvironments?.includes(buildEnv) === true;
}

function getBetaDefaultBuildEnvironment(): MavisBuildEnv {
  const electronBuildEnv = isElectronProcess()
    ? process.env.NEXT_PUBLIC_BUILD_ENV
    : undefined;
  return isValidRuntimeBuildEnv(electronBuildEnv)
    ? electronBuildEnv
    : getRuntimeBuildEnv();
}

function isDefaultEnabledForPlatform(
  def: BetaFeatureDef,
  context: BetaFeatureResolutionContext,
): boolean {
  return (
    def.defaultPlatforms?.includes(context.platform ?? process.platform) !==
    false
  );
}

/**
 * Resolve every beta flag with one channel model. `defaultVisibility` controls
 * the channel rollout, exact build-environment/platform defaults narrow special
 * releases, `defaultBuildVariants` adds build-variant defaults independent of the
 * build environment, and `configurableVisibility` controls explicit opt-in.
 * Published-resource dev commands are explicit opt-ins; other environments
 * remain fail-closed. Inside builds map to online unless declared otherwise.
 */
export function resolveBetaFeature(
  feature: keyof BetaConfig,
  configured: unknown,
  context: BetaFeatureResolutionContext = {},
): boolean {
  const def: BetaFeatureDef = BETA_FEATURE_DEFS[feature];
  const channelRank = VISIBILITY_RANK[getBetaFeatureChannel(context)];
  const defaultBuildEnvironment =
    context.defaultBuildEnvironment ??
    context.buildEnv ??
    getBetaDefaultBuildEnvironment();
  if (
    feature === "mcodeTools" &&
    defaultBuildEnvironment === "dev" &&
    context.mcodeToolsDevMode === "published" &&
    isDefaultEnabledForPlatform(def, context)
  )
    return true;
  if (configured === false) return false;
  if (configured === true)
    return channelRank <= VISIBILITY_RANK[def.configurableVisibility];
  if (!isDefaultEnabledForPlatform(def, context)) return false;
  if (isDefaultEnabledForBuildEnvironment(def, context)) return true;
  if (isDefaultEnabledForBuildVariant(def, context)) return true;
  return channelRank <= VISIBILITY_RANK[def.defaultVisibility];
}

/** @deprecated Prefer `resolveBetaFeature`; retained for CLI compatibility. */
export function isBetaFeatureProdReady(feature: keyof BetaConfig): boolean {
  return BETA_FEATURE_DEFS[feature].configurableVisibility === "online";
}

export function isInternalBuild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.__MAVIS_BUILD_INTERNAL === "true";
}

function isInsideBuild(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.__MAVIS_BUILD_INSIDE === "true";
}

export type { AskUserConfig } from "./ask-user-config.js";

// ── Session Title Generation ──────────────────────────────────────

/**
 * LLM session-title generation flag. Default `true`. Set
 * `sessionTitle.enabled: false` to drop the extra title model request
 * (e.g. headless / evaluation runs that don't want it in the trajectory).
 */
export interface SessionTitleConfig {
  enabled: boolean;
}

// ── CLI Feature Flags ─────────────────────────────────────────────

export interface CliSpawnConfig {
  /**
   * Expose `mavis session spawn` CLI command.
   * `spawn` lets users / external scripts manually create child sessions for an agent
   * (with parent linkage, initial prompt, and optional agent auto-creation).
   * Mavis itself and its agents do NOT need this — team plans spawn worker sessions
   * via the in-process daemon API, not via CLI.
   * Default: false. Enable only if you want external tooling to drive spawn.
   */
  enabled: boolean;
}

export interface CliConfig {
  spawn: CliSpawnConfig;
}

// ── Legacy OpenCode Adapter (daemon compile compatibility) ───────

export interface OpenCodeKeepAliveConfig {
  enabled: boolean;
  maxProcesses: number;
  maxLifetimeMs: number;
  agents: string[];
}

export type OpenCodeStartupImportMode = "off" | "background" | "blocking";

export interface OpenCodeXdgConfig {
  dataIsolation: boolean;
  startupImport: OpenCodeStartupImportMode;
}

export interface OpenCodeAdapterConfig {
  keepAlive: OpenCodeKeepAliveConfig;
  xdg: OpenCodeXdgConfig;
  spawnConcurrency: number;
}

// ── Context Management ──────────────────────────────────────────

export interface DailyDigestConfig {
  /**
   * Generate daily digest files under `<dataDir>/agents/<name>/daily/`.
   *
   * This only gates digest generation and daily TTL archival. It does NOT
   * disable the scheduler itself: session-level fallback re-prompts and
   * memory-tracking cleanup continue to run.
   *
   * Default: false.
   */
  enabled: boolean;
}

export interface MemoryConfig {
  /**
   * Master switch for desktop memory behavior.
   *
   * When false, the desktop daemon/plugin stop injecting memory, showing
   * memory reminders, auto-generating/cleaning memory, and accepting memory
   * writes through Mavis APIs. Existing files are preserved and read/search
   * remains available for inspection.
   *
   * Default: true.
   */
  enabled: boolean;
  /**
   * Opt-in hot-path reminder that asks the main agent to evaluate durable memory.
   *
   * Default: false.
   */
  proactive: boolean;
  dailyDigest: DailyDigestConfig;
}

export interface ContextManagementConfig {
  /**
   * Models for which the per-message `<system-reminder>` injection is fully
   * disabled.
   *
   * Used by models with very tight context budgets where repeated SR
   * injection is too costly (e.g. minimax M2.7). Each turn the daemon would
   * normally append a `<system-reminder>` block to the user message; for
   * listed models the block is skipped entirely.
   *
   * Format: array of `"providerID/modelID"` strings.
   * Default: empty (SR enabled for every model).
   *
   * Note: this only affects the per-message SR (path B). The static
   * `<agent_memory>` / `<global_memory>` / `<daily_digest>` blocks injected
   * into the system prompt (path A) are unaffected.
   */
  disableSystemReminderModels: string[];

  /**
   * Maximum number of Computer Use screenshots to keep as inline image data
   * in the conversation context sent to the LLM.
   *
   * CU screenshots (from `desktop_screenshot`, `desktop_zoom`,
   * `desktop_screenshot_region` tools) are large base64-encoded images that
   * accumulate rapidly during CU sessions.  When the total count exceeds
   * this limit, older screenshots are replaced with a text placeholder
   * containing the on-disk file path, so the model can re-read them via
   * the Read tool if needed.
   *
   * Set to `0` to disable (keep all screenshots).
   * Default: 5.
   */
  cuMaxScreenshotsInContext: number;
}

/**
 * MCP progressive-disclosure ("tool search") tunables.
 *
 * All fields optional; unset fields fall back to the disclosure defaults
 * applied by the local-runtime resolver. When the whole block is absent the
 * value is `undefined` and the feature stays off (empty whitelist matches no
 * model). See `packages/local-runtime/src/mcp/disclosure-options.ts`.
 */
export interface McpToolSearchConfig {
  enabled?: boolean;
  modelWhitelist?: string[];
  thresholdPct?: number;
  minDeferCount?: number;
  topKDefault?: number;
  topKMax?: number;
  systemHint?: boolean;
  maxSchemaTextLen?: number;
}

export interface ReviewConfig {
  mode: "inline" | "subagent";
  /** Generated during parsing to distinguish product defaults from explicit user choices; not read from the config file. */
  modeSource?: "default" | "explicit";
}

export interface TelemetryConfig {
  /** Send anonymous TUI usage events. Disabled until the user opts in. */
  enabled: boolean;
  /** Send runtime performance metrics. Separate opt-in, disabled by default. */
  metrics?: boolean;
  /** Send minimized, account-linked automatic error reports. Separate opt-in, disabled by default. */
  diagnostics?: boolean;
}

export interface Config {
  logLevel: string;
  devPort: number;
  provider: ModelsConfig;
  /**
   * BYOK: user's own MiniMax API key. Written only through the ModelProvider
   * API — excluded from the generic config update whitelist so a sanitized
   * GET /config payload can never be written back over the real key.
   */
  minimax_api?: MinimaxApiConfig;
  /** User-owned Context selections for the managed MiniMax catalog. */
  minimaxModelContextLimits?: Record<string, number>;
  /** BYOK: user-created external providers (same write boundary as minimax_api). */
  custom_provider?: CustomProvidersConfig;
  /** BYOK: active model source — 'token_plan' uses managed-login, 'minimax_api_key' uses user's own API key. */
  minimaxModelSource?: "token_plan" | "minimax_api_key";
  nexus?: NexusConfig;
  /** Default model for new agents, format: "providerID/modelID" */
  defaultModel?: string;
  /** Persisted variant for the default model, such as a reasoning effort. */
  defaultModelVariant?: string;
  defaultModelThinking?: { effort?: string };
  defaultModelContextWindow?: number;
  /** Optional lightweight model for auxiliary tasks (title gen, etc.). Falls back to defaultModel. Format: "providerID/modelID" */
  defaultLightModel?: string;
  /** Permission mode for tool call authorization. */
  permissionMode: PermissionMode;
  permission: PermissionConfig;
  /** Global SSE error event publishing controls. */
  sseErrorPush: SSEErrorPushConfig;
  /** Notification controls. */
  notifications?: NotificationsConfig;
  dataDir: string;
  agentsDir: string;
  sessionsDir: string;
  memoryDir: string;
  skillsDir: string;
  /** Hidden directory for daemon-bundled built-in skills (read-only). */
  builtinSkillsDir: string;
  logsDir: string;
  pluginsDir: string;
  plansDir: string;
  harnessesDir: string;
  subAgentsDir: string;
  /** Beta / experimental feature switches. */
  beta: BetaConfig;
  /** Builtin capability defaults inherited by every Agent. */
  agents: AgentsConfig;
  /** Memory feature controls. */
  memory: MemoryConfig;
  /** Skill self-evolution configuration. */
  skillEvolve: SkillEvolveConfig;
  /** Session rotation configuration. */
  sessionRotate: SessionRotateConfig;
  /** AgentStop detector tunables (debounce, active-span backstop). */
  agentStop: AgentStopDetectorConfig;
  asr: AsrConfig; // cloud ASR (speech-to-text) — see ./asr.ts
  /** External skill source ingestion — see ./skills-config.ts */
  skills: SkillsConfig;
  /** ask_user tool feature flag — see `AskUserConfig`. */
  askUser: AskUserConfig;
  /** Session title auto-generation feature flag — see `SessionTitleConfig`. */
  sessionTitle: SessionTitleConfig;
  /** CLI feature flags. */
  cli: CliConfig;
  /** Browser provider options; activation is owned by V2 Plugin/config policy. */
  browser: BrowserConfig;
  /** TUI presentation options, such as the status line item order. */
  tui: TuiConfig;
  /** Anonymous TUI business telemetry. */
  telemetry: TelemetryConfig;
  /** Legacy OpenCode framework adapter tunables. */
  opencode: OpenCodeAdapterConfig;
  /** Per-model context management overrides (e.g. disable SR for low-context models). */
  contextManagement: ContextManagementConfig;
  /** Local Runaway Guard policy; valid Apollo booleans override it on Desktop. */
  runawayGuard: RunawayGuardSettings;
  /** ToolResult archive/trim thresholds shared by TUI, CLI and managed Desktop. */
  toolResultCompaction: ToolResultCompactionSettings;
  /** Runtime selection knobs (e.g. `defaultFramework` for new sessions). */
  agentRuntime: AgentRuntimeConfig;
  /**
   * Number of days to retain log files before automatic cleanup.
   * Default: 3. A value of 0 or undefined also defaults to 3.
   */
  logRetentionDays: number;
  /** Content review (safety) test controls. Production routing is fixed. */
  contentReview?: { enabled?: boolean; testBaseURL?: string };
  /** MCP progressive-disclosure ("tool search") tunables — undefined when absent. */
  mcpToolSearch?: McpToolSearchConfig;
  /** Computer Use backend: 'native' (default) for in-process Electron impl; 'mcp' reserved and throws via assertCuBackendSupported. See cu-backend.ts. */
  cuBackend: CuBackend;
  /** Built-in local code review behavior. */
  review: ReviewConfig;
  /** Automatic prompt delivery policy. */
  promptConfig: PromptConfig;
  /** Durable Goal policy, budgets, breaker, and verifier defaults. */
  goal: GoalConfig;
  /** Process sandbox product policy. Runtime-only fields are derived elsewhere. */
  sandbox: SandboxConfig;
  /** Non-fatal corrections made while parsing Goal policy. */
  goalWarnings: readonly string[];
}

// --- Modality & Status ---

export type Modality = "text" | "audio" | "image" | "video" | "pdf";

export type ModelStatus = "alpha" | "beta" | "deprecated";

// --- Cost ---

export interface ModelCostTier {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

export interface ModelCost extends ModelCostTier {
  context_over_200k?: ModelCostTier;
}

// --- Limit & Modalities ---

export interface ModelLimit {
  context: number;
  input?: number;
  output: number;
}

export interface ModelModalities {
  input: Modality[];
  output: Modality[];
}

// --- Model ---

export interface ModelCapabilitiesConfig {
  support_image?: boolean;
  support_video?: boolean;
  /** Model endpoint enforces response_format: { type: 'json_object' }. */
  support_json_object_output?: boolean;
  support_files_api?: boolean;
  use_file_api?: boolean;
  files_api_upload_endpoint?: string;
  files_api_ref_scheme?: string;
  files_api_file_id_ttl_sec?: number;
  max_image_bytes_inline?: number | string;
  max_video_bytes_inline?: number | string;
  max_request_body_bytes?: number | string;
  max_attachments_count?: number | string;
  [key: string]: unknown;
}

export type ModelConfigurationSource = "manual" | "discovered";
export type ModelContextWindowOptionHint = "higher_usage";

export interface ModelConfig {
  id?: string;
  name?: string;
  enabled?: boolean;
  family?: string;
  release_date?: string;
  configuration_source?: ModelConfigurationSource;
  attachment?: boolean;
  reasoning?: boolean;
  temperature?: boolean;
  tool_call?: boolean;
  interleaved?: true | { field: "reasoning_content" | "reasoning_details" };
  cost?: ModelCost;
  limit?: ModelLimit;
  /** Ordered context choices advertised by the managed model catalog. */
  contextWindowOptions?: number[];
  /** Derived by managed catalogue sync; never read from a selection request. */
  parameterErrors?: { contextOptions?: true; effortOptions?: true };
  /** Semantic UI hints keyed by decimal context-window size. */
  contextWindowOptionHints?: Record<string, ModelContextWindowOptionHint>;
  modalities?: ModelModalities;
  experimental?: boolean;
  status?: ModelStatus;
  thinking?: ThinkingConfig;
  thinking_config?: ModelThinkingConfig;
  options?: Record<string, unknown>;
  headers?: Record<string, string>;
  capabilities?: ModelCapabilitiesConfig;
  provider?: { npm?: string; api?: string };
  variants?: Record<string, { disabled?: boolean; [key: string]: unknown }>;
  defaultVariant?: string;
}

// --- Provider ---

export interface ProviderOptions {
  apiKey?: string;
  baseURL?: string;
  authMode?: ProviderAuthMode;
  enterpriseUrl?: string;
  setCacheKey?: boolean;
  timeout?: number | false;
  chunkTimeout?: number;
  headers?: Record<string, string>;
  [key: string]: unknown;
}

export interface ProviderConfig {
  api?: string;
  name?: string;
  env?: string[];
  id?: string;
  npm?: string;
  models?: Record<string, ModelConfig>;
  /** Display order for managed models; omitted models retain their catalog order. */
  model_order?: string[];
  blacklist?: string[];
  whitelist?: string[];
  options?: ProviderOptions;
}

export type ModelsConfig = Record<string, ProviderConfig>;

// --- BYOK user providers (settings-page owned; see the BYOK model configuration technical design) ---

/**
 * User's own MiniMax API key ("MiniMax API" settings tab). Stores the raw key
 * locally; every API response must mask it. v1 is replace-only through the
 * ModelProvider API (no remove/clear); `baseURL` is a hand-edited override
 * only and is intentionally not exposed via the upsert endpoint. Model list
 * and capabilities are derived by the runtime and never stored here.
 */
export interface MinimaxApiConfig {
  apiKey?: string;
  /** Optional endpoint override; defaults to the runtime's builtin MiniMax API endpoint. */
  baseURL?: string;
  /** User-owned context selections applied only to the independent MiniMax API catalog. */
  modelContextLimits?: Record<string, number>;
}

/**
 * User-created external provider ("Custom Model" settings tab). Reuses the
 * ProviderConfig field vocabulary. Map keys (`provider_key`) are generated
 * once from the display name at creation time and are immutable afterwards —
 * renames only change `name`.
 */
export interface CustomProviderConfig extends ProviderConfig {
  /** Provider kind; user-created providers are always 'custom'. */
  kind?: string;
  /** Disabled providers keep their config but drop out of the effective model list. */
  enabled?: boolean;
}

export type CustomProvidersConfig = Record<string, CustomProviderConfig>;

// --- Nexus ---

export interface NexusModelConfig {
  providerID: string;
  modelID: string;
  variant?: string;
}

export interface NexusConfig {
  enabled?: boolean;
  model?: NexusModelConfig;
}

// ---------------------------------------------------------------------------
// Brand constants — single source of truth for all brand-related strings.
// ---------------------------------------------------------------------------
export const BRAND = {
  /** Data directory basename (e.g. '.minimax'). */
  APP_DIR: ".minimax",
  /** Environment variable prefix (e.g. 'minimax'). */
  ENV_PREFIX: "minimax",
  /** CLI binary name. */
  CLI_NAME: "minimax",
} as const;

/** Legacy runtime env prefix. New runtime identity travels via args/files. */
export const RUNTIME_ENV_PREFIX = "__MAVIS_RUNTIME";

/**
 * Read an internal runtime environment variable.
 * This lazy approach works correctly even when env vars are set after module load
 * (e.g., in test beforeEach hooks or dynamically by service managers).
 */
function runtimeEnv(suffix: string): string | undefined {
  return isLegacyRuntimeEnvAllowed()
    ? process.env[`${RUNTIME_ENV_PREFIX}_${suffix}`]
    : undefined;
}

function cliArgValue(name: string): string | undefined {
  const flag = `--${name}`;
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === flag) return process.argv[i + 1];
    if (arg?.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

function hasCliFlag(name: string): boolean {
  const flag = `--${name}`;
  return process.argv
    .slice(2)
    .some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

export const DEFAULT_PORT = 5321;
const DEFAULT_UI_PORT = 5001;
const MAX_TCP_PORT = 65535;
const GIT_AUTO_PORT_SLOT_COUNT = 500;
const GIT_AUTO_PORT_STRIDE = 2;
const MAX_GIT_AUTO_PORT_OFFSET =
  GIT_AUTO_PORT_SLOT_COUNT * GIT_AUTO_PORT_STRIDE;
export const OPENCODE_PORT_OFFSET =
  MAX_GIT_AUTO_PORT_OFFSET + GIT_AUTO_PORT_STRIDE;
const OPENCODE_FALLBACK_OFFSET = 1;
const REPO_NAMES: ReadonlySet<string> = new Set(["agent-archon", "mavis"]);

// ---------------------------------------------------------------------------
// Git port / profile detection (inlined here to avoid tsx dual-module-instance
// issues that arise when importing across workspace package boundaries)
// ---------------------------------------------------------------------------

/** POSIX cksum CRC-32 table (polynomial 0x04C11DB7, big-endian) */
const CRC_TABLE = (() => {
  const POLY = 0x04c11db7;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let j = 0; j < 8; j++) {
      c = (c & 0x80000000) !== 0 ? POLY ^ (c << 1) : c << 1;
      c >>>= 0;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

/**
 * POSIX cksum on UTF-8(str + '\n'), matching `echo "$str" | cksum | awk '{print $1}'`
 */
function posixCksum(str: string): number {
  const buf = Buffer.from(`${str}\n`, "utf-8");
  let crc = 0;
  for (const byte of buf) {
    crc = (CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]! ^ (crc << 8)) >>> 0;
  }
  let len = buf.length;
  while (len !== 0) {
    crc = (CRC_TABLE[((crc >>> 24) ^ (len & 0xff)) & 0xff]! ^ (crc << 8)) >>> 0;
    len >>>= 8;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function calcOffset(branchName: string): number {
  // 500 slots with stride 2 (offsets: 2,4,6,...,1000).
  // Keep even offsets to preserve historically stable branch ports and leave
  // room for per-profile sidecars without collapsing adjacent assignments.
  return (
    (posixCksum(branchName) % GIT_AUTO_PORT_SLOT_COUNT) * GIT_AUTO_PORT_STRIDE +
    2
  );
}

function runGit(args: string[], cwd?: string): string | null {
  try {
    const result = spawnSync("git", args, {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
      ...(cwd ? { cwd } : {}),
    });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
    return null;
  } catch {
    return null;
  }
}

function parseRepoName(remoteUrl: string): string | null {
  const match = remoteUrl.match(/[/:]([^/:]+?)(?:\.git)?$/);
  return match?.[1] ?? null;
}

function getExplicitPublicDataDirEnv(): string | undefined {
  return (
    process.env.MINIMAX_DATA_DIR?.trim() || process.env.MAVIS_DATA_DIR?.trim()
  );
}

function shouldUseGitAutoConfig(): boolean {
  if (
    hasCliFlag("disable-git-auto-config") ||
    runtimeEnv("DISABLE_GIT_AUTO_CONFIG")
  )
    return false;
  if (cliArgValue("data-dir")) return false;
  if (getExplicitPublicDataDirEnv()) return false;
  return true;
}

function getExplicitProfileEnv(): string | null {
  const profile = cliArgValue("profile") ?? runtimeEnv("PROFILE");
  return profile && profile.length > 0 ? profile : null;
}

function getExplicitPortEnv(): number | null {
  const explicitPort = cliArgValue("port") ?? runtimeEnv("PORT");
  const parsedExplicitPort = explicitPort ? parseInt(explicitPort, 10) : NaN;
  return Number.isNaN(parsedExplicitPort) ? null : parsedExplicitPort;
}

function getExplicitDataDirArg(): string | null {
  const dataDir =
    cliArgValue("data-dir") ??
    getExplicitPublicDataDirEnv() ??
    runtimeEnv("DATA_DIR");
  return dataDir && dataDir.length > 0 ? dataDir : null;
}

function shouldPreferExplicitDataDir(): boolean {
  return Boolean(getExplicitProfileEnv() && getExplicitDataDirArg());
}

function shouldPreferExplicitPort(): boolean {
  return Boolean(getExplicitProfileEnv() && getExplicitPortEnv() !== null);
}

interface GitPortInfo {
  runtimePort: number;
  uiPort: number;
  profile: string | null;
  autoDetected: boolean;
}

export type { GitPortInfo };

let _gitCached: GitPortInfo | null = null;

/** Reset cached git detection result (for testing) */
export function resetGitDetect(): void {
  _gitCached = null;
}

/**
 * Detect port and profile from git branch name.
 * Any branch in the mavis repo gets a hash-based offset.
 * Default port 5321 is reserved for non-git / non-mavis environments.
 */
export function detectGitPortInfo(): GitPortInfo {
  if (_gitCached !== null) return _gitCached;

  const defaults: GitPortInfo = {
    runtimePort: DEFAULT_PORT,
    uiPort: DEFAULT_UI_PORT,
    profile: null,
    autoDetected: false,
  };

  // npm build: skip git detection entirely — always use default port 5321.
  // esbuild constant-folds this to `true`, eliminating the git spawn code.
  if (typeof __IS_NPM_BUILD__ !== "undefined") {
    _gitCached = defaults;
    return defaults;
  }

  // Try to detect from process.cwd() first, then fall back to the directory
  // containing this config file. The fallback ensures correct detection when
  // a runtime helper starts from a wrong cwd — the config file is always
  // co-located with the source inside the git worktree.
  const candidateDirs: Array<string | undefined> = [
    undefined, // process.cwd() (default spawnSync behavior)
    currentModuleDir(),
  ];

  for (const cwd of candidateDirs) {
    try {
      const remoteUrl = runGit(["remote", "get-url", "origin"], cwd);
      if (!remoteUrl) continue;
      const repoName = parseRepoName(remoteUrl);
      if (!repoName || !REPO_NAMES.has(repoName)) continue;

      const branch = runGit(["branch", "--show-current"], cwd);
      if (!branch) continue;

      const offset = calcOffset(branch);
      _gitCached = {
        runtimePort: DEFAULT_PORT + offset,
        uiPort: DEFAULT_UI_PORT + offset,
        profile: branch.replace(/\//g, "-"),
        autoDetected: true,
      };
      return _gitCached;
    } catch {
      // try next candidate
    }
  }

  _gitCached = defaults;
  return defaults;
}

function currentModuleDir(): string | undefined {
  try {
    if (typeof __dirname === "string") return __dirname;
  } catch {
    /* ESM has no __dirname */
  }

  const stack = new Error().stack ?? "";
  for (const line of stack.split("\n")) {
    const fileUrl = /file:\/\/[^)\s]+/u
      .exec(line)?.[0]
      ?.replace(/:\d+:\d+$/u, "");
    if (fileUrl) {
      try {
        return path.dirname(fileURLToPath(fileUrl));
      } catch {
        /* keep scanning */
      }
    }

    const filePath =
      /\(?((?:\/|[A-Za-z]:\\)[^()]+?\.(?:cjs|mjs|js|ts)):\d+:\d+\)?/u.exec(
        line,
      )?.[1];
    if (filePath) return path.dirname(filePath);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export function getProfile(): string | null {
  const profile = getExplicitProfileEnv();
  if (profile) return profile;
  if (!shouldUseGitAutoConfig()) return null;
  return detectGitPortInfo().profile;
}

// ---------------------------------------------------------------------------
// Data directory resolution
// ---------------------------------------------------------------------------

export function getDataDir(): string {
  // Data-dir resolution priority (mirrors port resolution in getConfig):
  // 0. ${RUNTIME_ENV_PREFIX}_DISABLE_GIT_AUTO_CONFIG=1 → skip repo auto-detection entirely
  //    and fall back to the explicit env/default "user mode" resolution below.
  // 1. Explicit profile-scoped data dir (service/supervisor) → fixed data dir
  // 2. Git auto-detection (any branch in mavis repo) → profile-scoped dir
  //    This takes highest priority because the parent daemon process injects
  //    ${RUNTIME_ENV_PREFIX}_DATA_DIR into child process environments, which would
  //    incorrectly override the per-branch isolation that git detection provides.
  // 3. ${RUNTIME_ENV_PREFIX}_DATA_DIR env var → used only when git detection is not active
  // 4. ${RUNTIME_ENV_PREFIX}_PROFILE env var → manual profile override
  // 5. resolveDataDir() → non-git / non-mavis default data directory
  const explicitProfile = getExplicitProfileEnv();
  if (shouldPreferExplicitDataDir()) {
    return getExplicitDataDirArg()!;
  }

  if (shouldUseGitAutoConfig()) {
    const gitInfo = detectGitPortInfo();
    if (gitInfo.autoDetected && gitInfo.profile) {
      return resolveDataDir({ profile: gitInfo.profile });
    }
  }
  const explicitDataDir = getExplicitDataDirArg();
  if (explicitDataDir) {
    return explicitDataDir;
  }
  if (explicitProfile) {
    return resolveDataDir({ profile: explicitProfile });
  }
  return resolveDataDir();
}

export function getConfigPath(): string {
  return path.join(getDataDir(), "config.yaml");
}

// ---------------------------------------------------------------------------
// Default provider presets per environment combo (MAVIS_REGION x MAVIS_BUILD_ENV)
// ---------------------------------------------------------------------------

const MINIMAX_M3_FILE_API_CAPABILITIES: ModelCapabilitiesConfig = {
  support_files_api: true,
  files_api_upload_endpoint: "/v1/files/upload",
  max_image_bytes_inline: 10_485_760,
  max_video_bytes_inline: 52_428_800,
  max_request_body_bytes: 67_108_864,
  max_attachments_count: 4,
};

const MINIMAX_MODELS: Record<string, ModelConfig> = {
  "MiniMax-M3": {
    name: "MiniMax-M3",
    attachment: true,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ["text", "image", "video"], output: ["text"] },
    limit: { context: 512000, output: 128000 },
    contextWindowOptions: [512000, 1000000],
    contextWindowOptionHints: { "1000000": "higher_usage" },
    options: { reasoningSummary: "auto" },
    thinking_config: { mode: "switchable", default_value: "true" },
    variants: {
      "none-thinking": { thinking: { type: "disabled" } },
      thinking: { thinking: { type: "adaptive" } },
    },
    capabilities: MINIMAX_M3_FILE_API_CAPABILITIES,
  },
  "MiniMax-M2.7-highspeed": {
    name: "MiniMax-M2.7-highspeed",
    attachment: false,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 200000, output: 128000 },
  },
  "MiniMax-M2.7": {
    name: "MiniMax-M2.7",
    attachment: false,
    reasoning: true,
    tool_call: true,
    temperature: true,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 200000, output: 128000 },
  },
};

/** MiniMax models the user's own API key may call and the first-run managed fallback. */
export const MINIMAX_API_MODEL_CATALOG: Record<string, ModelConfig> =
  MINIMAX_MODELS;

const PRESET_BASE_URLS: Record<PresetKey, string> = {
  "cn-test": "https://matrix-test.example.invalid/mavis/api/v1/llm/v1",
  "cn-dev": "https://matrix-test.example.invalid/mavis/api/v1/llm/v1",
  "cn-staging": "https://matrix-pre.example.invalid/mavis/api/v1/llm/v1",
  "en-test": "https://matrix-overseas-test.example.invalid/mavis/api/v1/llm/v1",
  "en-dev": "https://matrix-overseas-test.example.invalid/mavis/api/v1/llm/v1",
  "en-staging":
    "https://matrix-overseas-pre.example.invalid/mavis/api/v1/llm/v1",
  "cn-prod": "https://agent.minimax.cn/mavis/api/v1/llm/v1",
  "en-prod": "https://agent.minimax.io/mavis/api/v1/llm/v1",
};

const LEGACY_MANAGED_PRESET_BASE_URLS = [
  "https://agent.minimaxi.com/mavis/api/v1/llm/v1",
] as const;
const MANAGED_PRESET_BASE_URLS = new Set([
  ...Object.values(PRESET_BASE_URLS),
  ...LEGACY_MANAGED_PRESET_BASE_URLS,
]);
const MANAGED_PRESET_ORIGINS = new Set(
  [...Object.values(PRESET_BASE_URLS), ...LEGACY_MANAGED_PRESET_BASE_URLS].map(
    (baseURL) => new URL(baseURL).origin,
  ),
);

function isManagedPresetBaseUrl(baseURL: string): boolean {
  if (MANAGED_PRESET_BASE_URLS.has(baseURL)) return true;

  try {
    const parsed = new URL(baseURL);
    return (
      !parsed.username &&
      !parsed.password &&
      MANAGED_PRESET_ORIGINS.has(parsed.origin)
    );
  } catch {
    return false;
  }
}

/** Test desktop builds may route the builtin managed MiniMax provider through a local fault proxy. */
export function allowsManagedMinimaxProviderOverride(): boolean {
  return getRuntimeBuildEnv() === "test";
}

function shouldEnforceManagedProviderProtection(): boolean {
  return !allowsManagedMinimaxProviderOverride();
}

function syncManagedPresetBaseUrl(configPath: string): void {
  if (!isManagedRuntime() || !fs.existsSync(configPath)) {
    return;
  }

  const raw = readConfigFile(configPath);
  const { provider } = raw;
  if (
    provider == null ||
    typeof provider !== "object" ||
    Array.isArray(provider)
  )
    return;

  const { minimax } = provider as Record<string, unknown>;
  if (minimax == null || typeof minimax !== "object" || Array.isArray(minimax))
    return;

  const { options } = minimax as Record<string, unknown>;
  if (options == null || typeof options !== "object" || Array.isArray(options))
    return;

  const currentBaseURL = (options as Record<string, unknown>).baseURL;
  if (typeof currentBaseURL !== "string") return;

  const presetBaseURL = PRESET_BASE_URLS[getRuntimePresetKey()];
  if (
    currentBaseURL === presetBaseURL ||
    !isManagedPresetBaseUrl(currentBaseURL)
  )
    return;

  const originalContent = fs.readFileSync(configPath);
  (options as Record<string, unknown>).baseURL = presetBaseURL;
  try {
    writePrivateConfigFileSync(
      configPath,
      yaml.dump(raw, { indent: 2, lineWidth: -1, noRefs: true }),
    );
  } catch (error) {
    // This on-disk sync is optional, but a failure after truncation is not safe
    // to hide. Only continue when the original document is still intact.
    let unchanged = false;
    try {
      unchanged = fs.readFileSync(configPath).equals(originalContent);
    } catch {
      // Preserve the original write error if integrity cannot be verified.
    }
    if (!unchanged) throw error;
    // Do not include the error message: config errors may contain credentials.
    console.warn(
      "[config] managed preset baseURL sync skipped; config file unchanged, using runtime provider settings",
    );
  }
}

function buildPresetEntry(key: PresetKey) {
  const provider: ProviderConfig = {
    name: "MiniMax",
    npm: "@ai-sdk/anthropic",
    options: {
      authMode: "managed-login",
      apiKey: "sk-xxx",
      baseURL: PRESET_BASE_URLS[key],
    },
    models: MINIMAX_MODELS,
  };
  return {
    provider: { minimax: provider } as ModelsConfig,
    defaultModel: "minimax/MiniMax-M3",
  };
}

export const DEFAULT_MODEL_PRESETS: Record<
  PresetKey,
  { provider: ModelsConfig; defaultModel: string }
> = {
  "cn-test": buildPresetEntry("cn-test"),
  "cn-dev": buildPresetEntry("cn-dev"),
  "cn-staging": buildPresetEntry("cn-staging"),
  "cn-prod": buildPresetEntry("cn-prod"),
  "en-test": buildPresetEntry("en-test"),
  "en-dev": buildPresetEntry("en-dev"),
  "en-staging": buildPresetEntry("en-staging"),
  "en-prod": buildPresetEntry("en-prod"),
} as const;

const DEFAULTS: Omit<
  Config,
  | "dataDir"
  | "agentsDir"
  | "sessionsDir"
  | "memoryDir"
  | "skillsDir"
  | "builtinSkillsDir"
  | "logsDir"
  | "pluginsDir"
  | "plansDir"
  | "harnessesDir"
  | "subAgentsDir"
  | "provider"
  | "permission"
  | "promptConfig"
> = {
  logLevel: "info",
  devPort: DEFAULT_UI_PORT,
  permissionMode: "auto",
  sseErrorPush: {
    history: true,
    stream: true,
  },
  beta: Object.fromEntries(
    (Object.keys(BETA_FEATURE_DEFS) as (keyof BetaConfig)[]).map((key) => [
      key,
      resolveBetaFeature(key, undefined, { buildEnv: "dev" }),
    ]),
  ) as unknown as BetaConfig,
  agents: { default: {} },
  memory: {
    enabled: true,
    proactive: false,
    dailyDigest: {
      enabled: false,
    },
  },
  skillEvolve: {
    enabled: true,
    inSession: {
      N: 20,
      minIntervalSeconds: 30,
      maxPendingPerSession: 1,
    },
    signalCooldownHours: 24,
    minConfidence: 0.7,
    excludeAgents: ["skill-editor"],
    disableModelPrefixes: ["MiniMax-M2"],
    builtinMrEnabled: false,
    sourceRepo: undefined,
    proposal: {
      enabled: false,
      eligibleAgents: ["mavis"],
      minMessageCount: 40,
      skipPassiveSessionEnd: true,
    },
    lifecycle: { staleThresholdDays: 15, archiveThresholdDays: 30 }, // tightened from legacy 30d/90d
  },
  sessionRotate: {
    enabled: true,
    activeSessionLookbackHours: 12,
  },
  agentStop: {
    debounceMs: 500,
    maxActiveSpanMs: 30 * 60 * 1000, // 30 min
  },
  asr: { ...ASR_DEFAULTS }, // Cloud ASR master switch only. Seed / Qwen client providers and their WS bridge were retired; Amadeus uses the authenticated HTTP+SSE proxy from Web/Electron. Legacy `asr.mode` / `asr.proxyBaseUrl` / `asr.primaryProvider` / `asr.fallbackProvider` / `asr.{seed,qwen}.*` are dropped on parse with a warn.
  skills: DEFAULT_SKILLS_CONFIG,
  askUser: { ...ASK_USER_CONFIG_DEFAULTS },
  sessionTitle: {
    // Default ON. See `SessionTitleConfig`.
    enabled: true,
  },
  cli: {
    spawn: {
      enabled: false,
    },
  },
  browser: { ...BROWSER_CONFIG_DEFAULTS },
  // No status line items by default: the TUI picks its build-specific default
  // when `tui.statusLine` is absent.
  tui: {},
  telemetry: { enabled: false, metrics: false, diagnostics: false },
  opencode: {
    xdg: {
      dataIsolation: false,
      startupImport: "off",
    },
    keepAlive: {
      enabled: false,
      maxProcesses: 5,
      maxLifetimeMs: 28_800_000,
      agents: ["mavis", "main", "verifier", "code-reviewer"],
    },
    spawnConcurrency: 3,
  },
  contextManagement: {
    disableSystemReminderModels: [],
    cuMaxScreenshotsInContext: 2,
  },
  runawayGuard: { enabled: true },
  toolResultCompaction: { ...TOOL_RESULT_COMPACTION_DEFAULTS },
  agentRuntime: {
    // Single source of truth lives in `./agent-runtime-config.ts` so the
    // default and the union type cannot drift.
    defaultFramework: DEFAULT_AGENT_RUNTIME_FRAMEWORK,
  },
  logRetentionDays: 3,
  cuBackend: DEFAULT_CU_BACKEND,
  review: {
    mode: "subagent",
    modeSource: "default",
  },
  goal: structuredClone(GOAL_CONFIG_DEFAULTS),
  sandbox: structuredClone(SANDBOX_CONFIG_DEFAULTS),
  goalWarnings: [],
};

function ensureConfigFile(): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (fs.existsSync(configPath)) {
    prepareConfigFileForRead(configPath);
    return;
  }

  // In non-managed runtime (pnpm dev / npm package), the UI onboarding flow
  // owns config.yaml generation — it walks the user through getting an API
  // key and writes the file. Daemon must NOT pre-seed a placeholder here,
  // otherwise the UI flow has no way to know whether the user has actually
  // configured anything.
  //
  // However, when a worktree daemon starts with a derived dataDir (e.g.
  // <dataDir>-feature-foo/), the developer's API keys live in the default
  // dataDir (<dataDir>/config.yaml). Copy it over so the worktree daemon
  // inherits the existing configuration.
  if (!isManagedRuntime()) {
    const defaultDataDir = resolveDataDir({ homeDir: os.homedir() });
    const defaultConfigPath = path.join(defaultDataDir, "config.yaml");
    if (configPath !== defaultConfigPath && fs.existsSync(defaultConfigPath)) {
      restrictConfigFileSync(defaultConfigPath);
      writePrivateConfigFileSync(configPath, fs.readFileSync(defaultConfigPath), true);
    }
    return;
  }

  const preset = DEFAULT_MODEL_PRESETS[getRuntimePresetKey()];
  const content = yaml.dump({
    logLevel: DEFAULTS.logLevel,
    provider: managedPresetBaseUrlSyncEnabled ? preset.provider : undefined,
    defaultModel: preset.defaultModel,
  });
  writePrivateConfigFileSync(configPath, content, true);
}

function readConfigFile(configPath = getConfigPath()): Record<string, unknown> {
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = yaml.load(raw);
    if (
      parsed != null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

let _cached: Config | null = null;

function parseNotificationsConfig(
  raw: unknown,
): NotificationsConfig | undefined {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw))
    return undefined;
  const obj = raw as Record<string, unknown>;
  return {
    branchFinish:
      typeof obj.branchFinish === "boolean" ? obj.branchFinish : false,
  };
}

// ── BYOK config parsing + required provider overrides: see ./byok-config.ts ──

const REQUIRED_PROVIDER_OVERRIDE_DEPS: RequiredProviderOverrideDeps = {
  isManagedRuntime,
  shouldEnforceManagedProviderProtection,
  getManagedPreset: () => DEFAULT_MODEL_PRESETS[getRuntimePresetKey()],
  isManagedPresetBaseUrl,
};

let legacyByokProviderMigrationEnabled = true;
let managedPresetBaseUrlSyncEnabled = true;

export function setLegacyByokProviderMigrationEnabled(enabled: boolean): void {
  legacyByokProviderMigrationEnabled = enabled;
}

/** Hosts sharing config with older clients can use the current preset without persisting it. */
export function setManagedPresetBaseUrlSyncEnabled(enabled: boolean): void {
  managedPresetBaseUrlSyncEnabled = enabled;
}

export function prepareConfigFileForRead(configPath: string): void {
  restrictConfigFileSync(configPath);
  restrictLegacyByokBackups(configPath);
  if (legacyByokProviderMigrationEnabled) {
    migrateLegacyByokProvidersOnDisk(
      configPath,
      REQUIRED_PROVIDER_OVERRIDE_DEPS,
    );
  }
  if (managedPresetBaseUrlSyncEnabled) syncManagedPresetBaseUrl(configPath);
}

export function resetConfig(): void {
  _cached = null;
}

export function getConfig(): Config {
  if (_cached) return _cached;

  ensureConfigFile();
  const raw = readConfigFile();
  _cached = resolveConfigFromRaw(raw, getDataDir());
  return _cached;
}

export function resolveConfigFromRaw(
  raw: Record<string, unknown>,
  dataDir: string,
): Config {
  const rawSSEErrorPush = raw.sseErrorPush;
  const sseErrorPush =
    rawSSEErrorPush != null &&
    typeof rawSSEErrorPush === "object" &&
    !Array.isArray(rawSSEErrorPush)
      ? (rawSSEErrorPush as Record<string, unknown>)
      : undefined;

  // devPort resolution (kept in Config for UI dev server)
  let devPort =
    typeof raw.devPort === "number" ? raw.devPort : DEFAULTS.devPort;
  if (shouldUseGitAutoConfig() && !shouldPreferExplicitPort()) {
    const gitInfo = detectGitPortInfo();
    if (gitInfo.autoDetected) {
      devPort = gitInfo.uiPort;
    }
  }
  const goalParsed = parseGoalConfig(raw.goal);
  const managedProvider = applyRequiredProviderOverrides(
    {
      provider:
        raw.provider != null &&
        typeof raw.provider === "object" &&
        !Array.isArray(raw.provider)
          ? normalizeLegacyThinkingEfforts(raw.provider as ModelsConfig)
          : {},
      defaultModel:
        typeof raw.defaultModel === "string" ? raw.defaultModel : undefined,
    },
    REQUIRED_PROVIDER_OVERRIDE_DEPS,
  );
  const minimaxModelContextLimits = parseModelContextLimits(
    raw.minimaxModelContextLimits,
  );
  const beta = parseBetaConfig(raw);

  return {
    logLevel:
      typeof raw.logLevel === "string" ? raw.logLevel : DEFAULTS.logLevel,
    devPort,
    ...managedProvider,
    provider: applyManagedMinimaxContextLimits(
      managedProvider.provider,
      minimaxModelContextLimits,
    ),
    defaultModelVariant:
      typeof raw.defaultModelVariant === "string"
        ? raw.defaultModelVariant
        : undefined,
    defaultModelThinking:
      raw.defaultModelThinking &&
      typeof raw.defaultModelThinking === "object" &&
      typeof (raw.defaultModelThinking as Record<string, unknown>).effort ===
        "string"
        ? { effort: (raw.defaultModelThinking as { effort: string }).effort }
        : undefined,
    defaultModelContextWindow:
      Number.isSafeInteger(raw.defaultModelContextWindow) &&
      Number(raw.defaultModelContextWindow) > 0 &&
      Number(raw.defaultModelContextWindow) <= 2_147_483_647
        ? Number(raw.defaultModelContextWindow)
        : undefined,
    minimax_api: parseMinimaxApiConfig(raw.minimax_api),
    minimaxModelContextLimits,
    custom_provider: parseCustomProvidersConfig(raw.custom_provider),
    minimaxModelSource:
      typeof raw.minimaxModelSource === "string" &&
      (raw.minimaxModelSource === "token_plan" ||
        raw.minimaxModelSource === "minimax_api_key")
        ? raw.minimaxModelSource
        : undefined,
    nexus:
      raw.nexus != null &&
      typeof raw.nexus === "object" &&
      !Array.isArray(raw.nexus)
        ? (() => {
            const parsed: NexusConfig = {};
            if (typeof Reflect.get(raw.nexus, "enabled") === "boolean") {
              parsed.enabled = Reflect.get(raw.nexus, "enabled") as boolean;
            }

            const rawModel = Reflect.get(raw.nexus, "model");
            if (
              rawModel != null &&
              typeof rawModel === "object" &&
              !Array.isArray(rawModel) &&
              typeof Reflect.get(rawModel, "providerID") === "string" &&
              typeof Reflect.get(rawModel, "modelID") === "string"
            ) {
              parsed.model = {
                providerID: Reflect.get(rawModel, "providerID") as string,
                modelID: Reflect.get(rawModel, "modelID") as string,
                ...(typeof Reflect.get(rawModel, "variant") === "string"
                  ? {
                      variant: Reflect.get(rawModel, "variant") as string,
                    }
                  : {}),
              };
            }

            return Object.keys(parsed).length > 0 ? parsed : undefined;
          })()
        : undefined,
    defaultLightModel:
      typeof raw.defaultLightModel === "string"
        ? raw.defaultLightModel
        : undefined,
    permissionMode:
      typeof raw.permissionMode === "string" &&
      ["default", "bypassPermissions", "auto", "off"].includes(
        raw.permissionMode,
      )
        ? (raw.permissionMode as PermissionMode)
        : DEFAULTS.permissionMode,
    permission: parsePermissionConfig(raw),
    sseErrorPush: {
      history:
        typeof sseErrorPush?.history === "boolean"
          ? (sseErrorPush.history as boolean)
          : DEFAULTS.sseErrorPush.history,
      stream:
        typeof sseErrorPush?.stream === "boolean"
          ? (sseErrorPush.stream as boolean)
          : DEFAULTS.sseErrorPush.stream,
    },
    notifications: parseNotificationsConfig(raw.notifications),
    dataDir,
    agentsDir: path.join(dataDir, "agents"),
    sessionsDir: path.join(dataDir, "sessions"),
    memoryDir: path.join(dataDir, "memory"),
    skillsDir: path.join(dataDir, "skills"),
    builtinSkillsDir: path.join(dataDir, ".builtin-skills"),
    logsDir: path.join(dataDir, "logs"),
    pluginsDir: path.join(dataDir, "plugins"),
    plansDir: path.join(dataDir, "plans"),
    harnessesDir: path.join(dataDir, "harnesses"),
    subAgentsDir: path.join(dataDir, "subagents"),
    beta,
    agents: parseAgentsConfig(raw.agents),
    memory: parseMemoryConfig(raw),
    skillEvolve: parseSkillEvolveConfig(raw, beta),
    sessionRotate: parseSessionRotateConfig(raw),
    agentStop: parseAgentStopDetectorConfig(raw),
    asr: parseAsrConfig(raw),
    skills: parseSkillsConfig(raw),
    askUser: parseAskUserConfig(raw, DEFAULTS.askUser),
    sessionTitle: parseSessionTitleConfig(raw),
    cli: parseCliConfig(raw),
    browser: parseBrowserConfig(raw.browser),
    tui: parseTuiConfig(raw),
    telemetry: parseTelemetryConfig(raw.telemetry),
    opencode: parseOpenCodeAdapterConfig(raw, DEFAULTS.opencode),
    contextManagement: parseContextManagementConfig(raw),
    runawayGuard: resolveRunawayGuardConfig(raw.runawayGuard),
    toolResultCompaction: parseToolResultCompactionConfig(
      raw.toolResultCompaction,
    ),
    agentRuntime: parseAgentRuntimeConfig(raw.agentRuntime),
    logRetentionDays: parseLogRetentionDays(raw),
    contentReview: parseContentReviewConfig(raw),
    mcpToolSearch: parseMcpToolSearchConfig(raw),
    cuBackend: parseCuBackend(raw.cuBackend),
    review: parseReviewConfig(raw.review, DEFAULTS.review),
    promptConfig: resolvePromptConfig(raw.promptConfig),
    goal: goalParsed.config,
    goalWarnings: goalParsed.warnings,
    sandbox: parseSandboxConfig(raw.sandbox),
  };
}

// ── Memory config parsing ──────────────────────────────────────

function parseTelemetryConfig(raw: unknown): TelemetryConfig {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ...DEFAULTS.telemetry };
  }
  const enabled = Reflect.get(raw, "enabled");
  return {
    enabled: typeof enabled === "boolean" ? enabled : DEFAULTS.telemetry.enabled,
    metrics: Reflect.get(raw, "metrics") === true,
    diagnostics: Reflect.get(raw, "diagnostics") === true,
  };
}

function parseMemoryConfig(raw: Record<string, unknown>): MemoryConfig {
  const memoryRaw = raw.memory;
  const memoryObj =
    memoryRaw != null &&
    typeof memoryRaw === "object" &&
    !Array.isArray(memoryRaw)
      ? (memoryRaw as Record<string, unknown>)
      : {};
  const dailyDigestRaw = memoryObj.dailyDigest;
  const dailyDigestObj =
    dailyDigestRaw != null &&
    typeof dailyDigestRaw === "object" &&
    !Array.isArray(dailyDigestRaw)
      ? (dailyDigestRaw as Record<string, unknown>)
      : {};

  return {
    enabled:
      typeof memoryObj.enabled === "boolean"
        ? memoryObj.enabled
        : DEFAULTS.memory.enabled,
    proactive:
      typeof memoryObj.proactive === "boolean"
        ? memoryObj.proactive
        : DEFAULTS.memory.proactive,
    dailyDigest: {
      enabled:
        typeof dailyDigestObj.enabled === "boolean"
          ? dailyDigestObj.enabled
          : DEFAULTS.memory.dailyDigest.enabled,
    },
  };
}

// ── Beta features config parsing ────────────────────────────────

function parseBetaConfig(raw: Record<string, unknown>): BetaConfig {
  const obj =
    raw.beta != null && typeof raw.beta === "object" && !Array.isArray(raw.beta)
      ? (raw.beta as Record<string, unknown>)
      : {};

  const context: BetaFeatureResolutionContext = {
    buildEnv: getRuntimeBuildEnv(),
    defaultBuildEnvironment: getBetaDefaultBuildEnvironment(),
    internalBuild: isInternalBuild(),
    insideBuild: isInsideBuild(),
    mcodeToolsDevMode:
      process.env.MAVIS_DEV_MCODE_TOOLS_MODE === "published"
        ? "published"
        : undefined,
  };
  const result = {} as BetaConfig;
  for (const key of Object.keys(BETA_FEATURE_DEFS) as (keyof BetaConfig)[]) {
    result[key] = resolveBetaFeature(key, obj[key], context);
  }
  return result;
}

// ── Skill Evolve config parsing ─────────────────────────────────

/**
 * Collect all model IDs from the provider config.
 * Returns an empty array when no models are configured.
 */
function collectModelIds(raw: Record<string, unknown>): string[] {
  const providerRaw = raw.provider;
  if (
    providerRaw == null ||
    typeof providerRaw !== "object" ||
    Array.isArray(providerRaw)
  ) {
    return [];
  }
  const ids: string[] = [];
  for (const prov of Object.values(providerRaw as Record<string, unknown>)) {
    if (prov == null || typeof prov !== "object" || Array.isArray(prov))
      continue;
    const { models } = prov as Record<string, unknown>;
    if (models == null || typeof models !== "object" || Array.isArray(models))
      continue;
    ids.push(...Object.keys(models as Record<string, unknown>));
  }
  return ids;
}

/**
 * Auto-derive the `skillEvolve.enabled` flag from the configured model list.
 *
 * When **every** configured model ID starts with one of the
 * `disableModelPrefixes` (case-insensitive), skill-evolve has no capable
 * model to work with, so it is disabled automatically.
 * If at least one model does NOT match, the feature is enabled.
 *
 * Edge cases: no providers / no models configured → `false`
 * (no capable model means the feature cannot operate).
 */
function deriveSkillEvolveEnabled(
  raw: Record<string, unknown>,
  disableModelPrefixes: string[],
): boolean {
  if (disableModelPrefixes.length === 0) return true;
  const modelIds = collectModelIds(raw);
  if (modelIds.length === 0) return false;
  const lowerPrefixes = disableModelPrefixes.map((p) => p.toLowerCase());
  return !modelIds.every((id) =>
    lowerPrefixes.some((p) => id.toLowerCase().startsWith(p)),
  );
}

function parsePositiveDays(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function parseSkillEvolveConfig(
  raw: Record<string, unknown>,
  betaConfig: BetaConfig,
): SkillEvolveConfig {
  const defaults = DEFAULTS.skillEvolve;
  const se = raw.skillEvolve;
  const hasSection = se != null && typeof se === "object" && !Array.isArray(se);
  const obj = hasSection
    ? (se as Record<string, unknown>)
    : ({} as Record<string, unknown>);

  const inSessionRaw = obj.inSession;
  let { inSession } = defaults;
  if (
    inSessionRaw != null &&
    typeof inSessionRaw === "object" &&
    !Array.isArray(inSessionRaw)
  ) {
    const ins = inSessionRaw as Record<string, unknown>;
    inSession = {
      N: typeof ins.N === "number" && ins.N > 0 ? ins.N : defaults.inSession.N,
      minIntervalSeconds:
        typeof ins.minIntervalSeconds === "number" &&
        ins.minIntervalSeconds >= 0
          ? ins.minIntervalSeconds
          : defaults.inSession.minIntervalSeconds,
      maxPendingPerSession:
        typeof ins.maxPendingPerSession === "number" &&
        ins.maxPendingPerSession >= 1
          ? ins.maxPendingPerSession
          : defaults.inSession.maxPendingPerSession,
    };
  }

  const excludeRaw = obj.excludeAgents;
  const excludeAgents =
    Array.isArray(excludeRaw) && excludeRaw.every((e) => typeof e === "string")
      ? (excludeRaw as string[])
      : defaults.excludeAgents;

  const disableModelPrefixes =
    Array.isArray(obj.disableModelPrefixes) &&
    obj.disableModelPrefixes.every((e: unknown) => typeof e === "string")
      ? (obj.disableModelPrefixes as string[])
      : defaults.disableModelPrefixes;

  // `enabled` — beta gate wins first; then explicit config; then auto-derive from model list.
  const enabled = !betaConfig.skillEvolve
    ? false
    : typeof obj.enabled === "boolean"
      ? obj.enabled
      : deriveSkillEvolveEnabled(raw, disableModelPrefixes);

  // `builtinMrEnabled` — beta gate wins first; then explicit config; then default.
  // Implicitly false when the parent `enabled` is false (no point evolving built-ins
  // when the pipeline as a whole is off).
  const builtinMrEnabled = !enabled
    ? false
    : !betaConfig.skillEvolveBuiltinMr
      ? false
      : typeof obj.builtinMrEnabled === "boolean"
        ? obj.builtinMrEnabled
        : defaults.builtinMrEnabled;

  const sourceRepoRaw = obj.sourceRepo;
  const sourceRepo =
    typeof sourceRepoRaw === "string" && sourceRepoRaw.trim().length > 0
      ? sourceRepoRaw.trim()
      : defaults.sourceRepo;

  // v3: `proposal` — beta gate + parent gate must both be true; otherwise
  // resolved sub-config still parses but `enabled` is forced false. Other
  // fields (eligibleAgents, minMessageCount, skipPassiveSessionEnd) are
  // honored even when the gate is off so operators can pre-stage config.
  const proposalRaw = obj.proposal;
  const proposalDefaults = defaults.proposal;
  const proposalObj =
    proposalRaw != null &&
    typeof proposalRaw === "object" &&
    !Array.isArray(proposalRaw)
      ? (proposalRaw as Record<string, unknown>)
      : ({} as Record<string, unknown>);

  const proposalEligibleAgents =
    Array.isArray(proposalObj.eligibleAgents) &&
    proposalObj.eligibleAgents.every((e) => typeof e === "string")
      ? (proposalObj.eligibleAgents as string[])
      : proposalDefaults.eligibleAgents;

  const proposalMinMessageCount =
    typeof proposalObj.minMessageCount === "number" &&
    proposalObj.minMessageCount >= 1
      ? Math.floor(proposalObj.minMessageCount)
      : proposalDefaults.minMessageCount;

  const proposalSkipPassiveSessionEnd =
    typeof proposalObj.skipPassiveSessionEnd === "boolean"
      ? proposalObj.skipPassiveSessionEnd
      : proposalDefaults.skipPassiveSessionEnd;

  const proposalEnabledExplicit =
    typeof proposalObj.enabled === "boolean" ? proposalObj.enabled : null;
  const proposalEnabled = !enabled
    ? false
    : !betaConfig.skillProposal
      ? false
      : (proposalEnabledExplicit ?? true);

  // `lifecycle` — strict invariant stale < archive (fail-fast at boot).
  const lcRaw = obj.lifecycle;
  const lc =
    lcRaw && typeof lcRaw === "object" && !Array.isArray(lcRaw)
      ? (lcRaw as Record<string, unknown>)
      : {};
  const staleThresholdDays = parsePositiveDays(lc.staleThresholdDays, defaults.lifecycle.staleThresholdDays); // prettier-ignore
  const archiveThresholdDays = parsePositiveDays(lc.archiveThresholdDays, defaults.lifecycle.archiveThresholdDays); // prettier-ignore
  if (!(staleThresholdDays < archiveThresholdDays)) {
    throw new Error(
      `Invalid skillEvolve.lifecycle config: staleThresholdDays (${staleThresholdDays}) must be strictly less than archiveThresholdDays (${archiveThresholdDays}).`,
    );
  }

  return {
    enabled,
    inSession,
    signalCooldownHours:
      typeof obj.signalCooldownHours === "number" && obj.signalCooldownHours > 0
        ? obj.signalCooldownHours
        : defaults.signalCooldownHours,
    minConfidence:
      typeof obj.minConfidence === "number" &&
      obj.minConfidence >= 0 &&
      obj.minConfidence <= 1
        ? obj.minConfidence
        : defaults.minConfidence,
    scannerModel:
      typeof obj.scannerModel === "string" ? obj.scannerModel : undefined,
    excludeAgents,
    disableModelPrefixes,
    builtinMrEnabled,
    sourceRepo,
    proposal: {
      enabled: proposalEnabled,
      eligibleAgents: proposalEligibleAgents,
      minMessageCount: proposalMinMessageCount,
      skipPassiveSessionEnd: proposalSkipPassiveSessionEnd,
    },
    lifecycle: { staleThresholdDays, archiveThresholdDays },
  };
}

/**
 * v3 helper: `isProposalEligibleAgent` lives in `./skill-evolve-config.ts`
 * — re-exported above with the rest of the SkillEvolve types.
 */

// ── Session Rotate config parsing ───────────────────────────────

function parseSessionRotateConfig(
  raw: Record<string, unknown>,
): SessionRotateConfig {
  const defaults = DEFAULTS.sessionRotate;
  const sr = raw.sessionRotate;
  if (sr == null || typeof sr !== "object" || Array.isArray(sr))
    return { ...defaults };
  const obj = sr as Record<string, unknown>;
  const rawLookback = obj.activeSessionLookbackHours;
  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : defaults.enabled,
    activeSessionLookbackHours:
      typeof rawLookback === "number" &&
      Number.isFinite(rawLookback) &&
      rawLookback > 0
        ? rawLookback
        : defaults.activeSessionLookbackHours,
  };
}

// ── AgentStop detector config parsing ───────────────────────────

function parseAgentStopDetectorConfig(
  raw: Record<string, unknown>,
): AgentStopDetectorConfig {
  const defaults = DEFAULTS.agentStop;
  const obj = raw.agentStop;
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    return { ...defaults };
  }
  const o = obj as Record<string, unknown>;
  const rawDebounce = o.debounceMs;
  const rawSpan = o.maxActiveSpanMs;
  // `0` is a meaningful operator opt-out for both knobs (no debounce, no
  // active-span backstop). Reject negatives / non-finite values back to
  // defaults so a malformed config can't silently disable the detector.
  return {
    debounceMs:
      typeof rawDebounce === "number" &&
      Number.isFinite(rawDebounce) &&
      rawDebounce >= 0
        ? rawDebounce
        : defaults.debounceMs,
    maxActiveSpanMs:
      typeof rawSpan === "number" && Number.isFinite(rawSpan) && rawSpan >= 0
        ? rawSpan
        : defaults.maxActiveSpanMs,
  };
}

export function resolvePromptConfig(obj: unknown): PromptConfig {
  // The startup environment is injected after module loading; compute defaults during config parsing.
  const defaultAutoUpdate =
    getRuntimeBuildEnv() === "prod" && !isInternalBuild();
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) {
    return { autoUpdate: defaultAutoUpdate };
  }
  const rawAutoUpdate = (obj as Record<string, unknown>).autoUpdate;
  return {
    autoUpdate:
      typeof rawAutoUpdate === "boolean" ? rawAutoUpdate : defaultAutoUpdate,
  };
}

// ── session title config parsing ────────────────────────────────

function parseSessionTitleConfig(
  raw: Record<string, unknown>,
): SessionTitleConfig {
  const defaults = DEFAULTS.sessionTitle;
  const rawSessionTitle = raw.sessionTitle;
  if (
    rawSessionTitle == null ||
    typeof rawSessionTitle !== "object" ||
    Array.isArray(rawSessionTitle)
  ) {
    return { ...defaults };
  }
  const obj = rawSessionTitle as Record<string, unknown>;
  return {
    enabled: typeof obj.enabled === "boolean" ? obj.enabled : defaults.enabled,
  };
}

// ── CLI config parsing ──────────────────────────────────────────

function parseCliConfig(raw: Record<string, unknown>): CliConfig {
  const defaults = DEFAULTS.cli;
  const rawCli = raw.cli;
  if (rawCli == null || typeof rawCli !== "object" || Array.isArray(rawCli)) {
    return { spawn: { ...defaults.spawn } };
  }
  const rawSpawn = (rawCli as Record<string, unknown>).spawn;
  if (
    rawSpawn == null ||
    typeof rawSpawn !== "object" ||
    Array.isArray(rawSpawn)
  ) {
    return { spawn: { ...defaults.spawn } };
  }
  const spawnObj = rawSpawn as Record<string, unknown>;
  return {
    spawn: {
      enabled:
        typeof spawnObj.enabled === "boolean"
          ? spawnObj.enabled
          : defaults.spawn.enabled,
    },
  };
}

// ── Context Management config parsing ───────────────────────────

function parseContextManagementConfig(
  raw: Record<string, unknown>,
): ContextManagementConfig {
  const defaults = DEFAULTS.contextManagement;
  const rawCm = raw.contextManagement;
  if (rawCm == null || typeof rawCm !== "object" || Array.isArray(rawCm)) {
    return {
      disableSystemReminderModels: [...defaults.disableSystemReminderModels],
      cuMaxScreenshotsInContext: defaults.cuMaxScreenshotsInContext,
    };
  }
  const obj = rawCm as Record<string, unknown>;
  const rawList = obj.disableSystemReminderModels;
  const disableSystemReminderModels =
    Array.isArray(rawList) &&
    rawList.every((e) => typeof e === "string" && e.length > 0)
      ? (rawList as string[])
      : [...defaults.disableSystemReminderModels];

  const rawCuMax = obj.cuMaxScreenshotsInContext;
  const cuMaxScreenshotsInContext =
    typeof rawCuMax === "number" && Number.isFinite(rawCuMax) && rawCuMax >= 0
      ? Math.floor(rawCuMax)
      : defaults.cuMaxScreenshotsInContext;

  return { disableSystemReminderModels, cuMaxScreenshotsInContext };
}

// ── Agent Runtime config parsing — see ./agent-runtime-config.ts for the
// canonical implementation. Re-exposed here so the public `getConfig()`
// surface keeps a single import point for callers; the helper is the
// source of truth for the `AgentRuntimeFramework` string union and the
// Pi-only runtime selection parser.

// ── Log Retention config parsing ────────────────────────────────

function parseLogRetentionDays(raw: Record<string, unknown>): number {
  const val = raw.logRetentionDays;
  if (typeof val === "number" && val >= 1 && Number.isFinite(val)) {
    return Math.floor(val);
  }
  return DEFAULTS.logRetentionDays;
}

// ── Content Review config parsing ───────────────────────────────

function parseContentReviewConfig(
  raw: Record<string, unknown>,
): { enabled?: boolean; testBaseURL?: string } | undefined {
  const obj = raw.contentReview;
  if (obj == null || typeof obj !== "object" || Array.isArray(obj))
    return undefined;
  const result: { enabled?: boolean; testBaseURL?: string } = {};
  const enabled = Reflect.get(obj, "enabled");
  if (typeof enabled === "boolean") result.enabled = enabled;
  const testBaseURL = Reflect.get(obj, "testBaseURL");
  if (typeof testBaseURL === "string" && testBaseURL.trim()) {
    result.testBaseURL = testBaseURL.trim();
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// ── MCP tool-search config parsing ──────────────────────────────

function parseMcpToolSearchConfig(
  raw: Record<string, unknown>,
): McpToolSearchConfig | undefined {
  const obj = raw.mcpToolSearch;
  if (obj == null || typeof obj !== "object" || Array.isArray(obj))
    return undefined;

  const result: McpToolSearchConfig = {};

  const enabled = Reflect.get(obj, "enabled");
  if (typeof enabled === "boolean") result.enabled = enabled;

  const systemHint = Reflect.get(obj, "systemHint");
  if (typeof systemHint === "boolean") result.systemHint = systemHint;

  const thresholdPct = Reflect.get(obj, "thresholdPct");
  if (typeof thresholdPct === "number") result.thresholdPct = thresholdPct;

  const minDeferCount = Reflect.get(obj, "minDeferCount");
  if (typeof minDeferCount === "number") result.minDeferCount = minDeferCount;

  const topKDefault = Reflect.get(obj, "topKDefault");
  if (typeof topKDefault === "number") result.topKDefault = topKDefault;

  const topKMax = Reflect.get(obj, "topKMax");
  if (typeof topKMax === "number") result.topKMax = topKMax;

  const maxSchemaTextLen = Reflect.get(obj, "maxSchemaTextLen");
  if (typeof maxSchemaTextLen === "number")
    result.maxSchemaTextLen = maxSchemaTextLen;

  const modelWhitelist = Reflect.get(obj, "modelWhitelist");
  if (Array.isArray(modelWhitelist)) {
    result.modelWhitelist = modelWhitelist.filter(
      (v): v is string => typeof v === "string",
    );
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

// ---------------------------------------------------------------------------
// Port resolution — compute the target local runtime port from env / git / defaults
// ---------------------------------------------------------------------------

/**
 * Resolve the target local runtime port.
 *
 * Priority:
 * 0. DISABLE_GIT_AUTO_CONFIG=1 → skip git auto-detection
 * 1. Explicit profile-scoped port (__MAVIS_RUNTIME_PROFILE + __MAVIS_RUNTIME_PORT both set)
 * 2. Git auto-detection (hash-based offset from branch name in mavis repo)
 * 3. __MAVIS_RUNTIME_PORT env var (only when git detection is not active)
 * 4. DEFAULT_PORT (5321)
 *
 * Not cached — env vars and git state can change between calls.
 */
export function resolvePort(): number {
  const explicitPort = getExplicitPortEnv();

  if (shouldUseGitAutoConfig() && !shouldPreferExplicitPort()) {
    const gitInfo = detectGitPortInfo();
    if (gitInfo.autoDetected) {
      return gitInfo.runtimePort;
    }
  }

  return explicitPort ?? DEFAULT_PORT;
}

/**
 * Legacy OpenCode listens on a dedicated offset above the runtime port range.
 * New sessions do not use this; existing daemon callers still compile against it.
 */
export function getOpenCodePort(runtimePort = resolvePort()): number {
  const preferredPort = runtimePort + OPENCODE_PORT_OFFSET;
  if (preferredPort <= MAX_TCP_PORT) {
    return preferredPort;
  }

  const fallbackPort = runtimePort + OPENCODE_FALLBACK_OFFSET;
  if (fallbackPort <= MAX_TCP_PORT) {
    return fallbackPort;
  }

  throw new Error(
    `Cannot allocate an OpenCode sidecar port for runtime port ${String(runtimePort)}; choose a runtime port <= ${String(MAX_TCP_PORT - OPENCODE_FALLBACK_OFFSET)}.`,
  );
}
