import {
  resolveAgentCapabilities,
  type AgentCapabilityConfig,
  type ResolvedAgentCapabilities,
} from '@mavis/config';

import type {
  AgentAppMode,
  AgentPromptChannel,
  AgentPromptProfile,
  AgentPromptMode,
  AgentPromptSurface,
} from '../contracts.js';
import type { PromptReadScope } from '@mavis/agent-runtime';
import type { PromptReadContext } from '../../prompt-config/index.js';

export type BuiltinPromptReadScope = PromptReadContext | PromptReadScope;

export interface BuiltinRenderInput {
  readonly agentName: string;
  readonly surface: AgentPromptSurface;
  readonly promptProfile?: AgentPromptProfile;
  readonly promptMode?: AgentPromptMode;
  readonly promptVersion?: string;
  readonly appMode: AgentAppMode;
  readonly locale: string;
  readonly promptChannel: AgentPromptChannel;
  readonly capabilities: ResolvedAgentCapabilities;
  readonly memoryEnabled?: boolean;
  readonly cronEnabled?: boolean;
  readonly dataDirToken?: string;
  /** One immutable Prompt directory selected before the enclosing model call starts. */
  readonly promptReadContext?: BuiltinPromptReadScope;
  /** Present only when PTC is really on for this Turn (isPtcTurnEnabled). */
  readonly ptc?: BuiltinPtcRender;
}

/** The rendered `_v2/PTC_TOOL_CALLS.md.hbs` section for a PTC Turn. */
export interface BuiltinPtcRender {
  readonly section: string;
}

export interface BuiltinSurfaceRenderInput {
  readonly agentName: string;
  readonly surface: AgentPromptSurface;
  readonly promptProfile?: AgentPromptProfile;
  readonly promptMode?: AgentPromptMode;
  readonly promptVersion?: string;
  readonly appMode: AgentAppMode;
  readonly locale: string;
  readonly promptChannel: AgentPromptChannel;
  readonly capabilities: ResolvedAgentCapabilities;
  readonly memoryEnabled?: boolean;
  readonly cronEnabled?: boolean;
  readonly dataDirToken?: string;
  readonly agentConfigDir?: string;
  /** One immutable Prompt directory selected before the enclosing model call starts. */
  readonly promptReadContext?: BuiltinPromptReadScope;
  readonly ptc?: BuiltinPtcRender;
}

export const PRIMARY_AGENT_NAME = 'mavis';
const LEGACY_PRIMARY_AGENT_NAME = 'main';
export const BUILTIN_ROSTER_FILE = 'builtin-agents.json';
export const FEATURE_FILES = {
  delegation: 'delegation.md.hbs',
  recoverableDeletion: 'recoverable-deletion.md.hbs',
  taskManagement: 'task-management.md.hbs',
  webSearch: 'web-search.md.hbs',
  cron: 'cron.md.hbs',
  memory: 'memory.md.hbs',
} as const;
/**
 * Local-only V2 section rendered for a PTC Turn and inserted before
 * `# Harness` via the `ptc.section` context field (prompt-exemptions.json).
 */
export const PTC_SECTION_FILE = '_v2/PTC_TOOL_CALLS.md.hbs';

export interface SurfacePromptFiles {
  readonly template: string;
  readonly fallback: string;
}

export function surfacePromptFiles(surface: AgentPromptSurface): SurfacePromptFiles {
  return surface === 'task-child'
    ? {
        template: 'prompt-session-branch.md.hbs',
        fallback: 'prompt-session-branch.md',
      }
    : {
        template: 'prompt-session-root.md.hbs',
        fallback: 'prompt-session-root.md',
      };
}

export function toSurfaceRenderInput(input: BuiltinSurfaceRenderInput): BuiltinRenderInput {
  return {
    agentName: input.agentName,
    surface: input.surface,
    ...(input.promptProfile === undefined ? {} : { promptProfile: input.promptProfile }),
    promptMode: input.promptMode,
    promptVersion: input.promptVersion,
    appMode: input.appMode,
    locale: input.locale,
    promptChannel: input.promptChannel,
    capabilities: input.capabilities,
    memoryEnabled: input.memoryEnabled,
    cronEnabled: input.cronEnabled,
    dataDirToken: input.dataDirToken,
    ...(input.promptReadContext === undefined
      ? {}
      : { promptReadContext: input.promptReadContext }),
    ...(input.ptc === undefined ? {} : { ptc: input.ptc }),
  };
}

export function defaultLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale || 'en';
}

export function canonicalBuiltinName(name: string): string {
  const normalized = name.trim().toLowerCase();
  return normalized === LEGACY_PRIMARY_AGENT_NAME ? PRIMARY_AGENT_NAME : normalized;
}

export function legacyNamesFor(name: string): readonly string[] {
  return name === PRIMARY_AGENT_NAME ? [LEGACY_PRIMARY_AGENT_NAME] : [];
}

export function resolveCanonicalCapabilities(
  configured: AgentCapabilityConfig | ResolvedAgentCapabilities | undefined,
  override: AgentCapabilityConfig | undefined,
): ResolvedAgentCapabilities {
  const base = isResolvedCapabilities(configured)
    ? configured
    : resolveAgentCapabilities(configured);
  if (!override) return base;
  return {
    persona: { enabled: base.persona.enabled && override.persona?.enabled !== false },
    tools: intersect(base.tools, override.tools),
    builtinTools: intersect(base.builtinTools, override.builtinTools),
    skills: intersect(base.skills, override.skills),
    features: {
      mavis: base.features.mavis && override.features?.mavis !== false,
      delegation: base.features.delegation && override.features?.delegation !== false,
      webSearch: base.features.webSearch && override.features?.webSearch !== false,
    },
  };
}

function isResolvedCapabilities(
  value: AgentCapabilityConfig | ResolvedAgentCapabilities | undefined,
): value is ResolvedAgentCapabilities {
  return Boolean(value && 'persona' in value && 'features' in value);
}

function intersect<T>(base: T[] | undefined, override: T[] | undefined): T[] | undefined {
  if (base === undefined) return override === undefined ? undefined : [...override];
  if (override === undefined) return [...base];
  const allowed = new Set(override);
  return base.filter((value) => allowed.has(value));
}
