export const AGENT_BUILTIN_TOOL_IDS = [
  'read',
  'write',
  'edit',
  'bash',
  'task_query',
  'task_output',
  'task_stop',
  'grep',
  'glob',
  'todowrite',
  'web_fetch',
  'website_deploy',
  'advisor',
  'skill',
  // A run_code child on PTC Turns; without it no Agent could save its first script.
  'save_run_code_script',
] as const;

export type AgentBuiltinToolId = (typeof AGENT_BUILTIN_TOOL_IDS)[number];

/**
 * Standalone Builtin Matrix MCP tools that may be selected independently.
 * `web_search` is feature-owned because its Tool and Prompt are gated together
 * through `features.webSearch`.
 */
export const AGENT_BUILTIN_MCP_TOOL_IDS = [
  'images_understand',
  'image_synthesize',
  'images_search_and_download',
  'image_reverse_search',
  'submit_video_generation',
  'query_video_generation',
  'gen_videos',
  'batch_text_to_video',
  'batch_image_to_video',
  'get_voice_list',
  'batch_text_to_audio',
  'batch_text_to_music',
  'synthesize_speech',
  'batch_synthesize_speech',
  'audios_understand',
  'videos_understand',
  'transcribe_audio',
] as const;

export type AgentBuiltinMcpToolId = (typeof AGENT_BUILTIN_MCP_TOOL_IDS)[number];

/**
 * Standalone Builtin Skills that may be selected independently.
 * Skills owned by another capability are derived at runtime so they cannot
 * outlive the Tool or feature that makes their instructions executable.
 */
export const AGENT_BUILTIN_SKILL_IDS = [
  'code-review',
  'deep-research',
  'deploy-website',
  'docx',
  'edit-deployed-website',
  'init',
  'lark-tools',
  'llm-call',
  'mcode-tools-master',
  'mavis-doctor',
  'pdf',
  'plugin-creator',
  'pptx',
  'skill-creator',
  'skill-refiner',
  'visual-page',
  'x-link-reader',
  'xlsx',
] as const;

export type AgentBuiltinSkillId = (typeof AGENT_BUILTIN_SKILL_IDS)[number];

export const AGENT_CAPABILITY_OWNED_SKILL_IDS = [
  'control-in-app-browser',
  'resume-codex',
  'mavis',
  'agent-manage',
  'session-manage',
  'session-dispatch',
  'mcp-manage',
  'cron-manage',
  'memory-manage',
  'im-routing',
  'skill-management',
  'windows-tool-bootstrap',
  'create-agent',
  'minimax-code-product',
  'miniapp-creator',
  'plugin-management',
] as const;

export interface AgentCapabilityConfig {
  /** Saved model configuration used by delegated child agents by default. */
  modelConfigId?: string;
  persona?: { enabled?: boolean };
  /** Undefined keeps every currently available Builtin Tool; [] selects none. */
  tools?: AgentBuiltinToolId[];
  /** Undefined keeps every standalone Builtin Matrix MCP Tool; [] selects none. */
  builtinTools?: AgentBuiltinMcpToolId[];
  /** Undefined keeps every compatible standalone Builtin Skill; [] selects none. */
  skills?: AgentBuiltinSkillId[];
  features?: {
    mavis?: boolean;
    delegation?: boolean;
    webSearch?: boolean;
  };
}

export interface AgentsConfig {
  default: AgentCapabilityConfig;
  /**
   * Corrections made while parsing, such as tool IDs this version does not know. A parser shared
   * with the interactive TUI must not write to the console, so the runtime logs these instead.
   */
  warnings?: readonly string[];
}

export interface ResolvedAgentCapabilities {
  persona: { enabled: boolean };
  tools: AgentBuiltinToolId[] | undefined;
  builtinTools: AgentBuiltinMcpToolId[] | undefined;
  skills: AgentBuiltinSkillId[] | undefined;
  features: {
    mavis: boolean;
    delegation: boolean;
    webSearch: boolean;
  };
}

const ROOT_KEYS = new Set([
  'modelConfigId',
  'persona',
  'tools',
  'builtinTools',
  'skills',
  'features',
]);
const PERSONA_KEYS = new Set(['enabled']);
const FEATURE_KEYS = new Set(['mavis', 'delegation', 'webSearch']);
const TOOL_IDS = new Set<string>(AGENT_BUILTIN_TOOL_IDS);
const TASK_CONTROL_IDS: readonly AgentBuiltinToolId[] = ['task_query', 'task_output', 'task_stop'];
const MCP_TOOL_IDS = new Set<string>(AGENT_BUILTIN_MCP_TOOL_IDS);
const SKILL_IDS = new Set<string>(AGENT_BUILTIN_SKILL_IDS);
const OWNED_SKILL_IDS = new Set<string>(AGENT_CAPABILITY_OWNED_SKILL_IDS);
// Preserve existing user allowlists while removing a retired ID. The strict
// bundled-agent parser intentionally continues to reject retired IDs.
// The Office Skills (docx / pdf / pptx / xlsx) moved to the official Word /
// Excel / PDF / PPT plugins, which are not gated by this allowlist.
const RETIRED_TOLERANT_SKILL_IDS = new Set(['plan-mode']);

export function parseAgentsConfig(raw: unknown): AgentsConfig {
  const root = asRecord(raw);
  const defaults = asRecord(root?.default);
  const warnings: string[] = [];
  const parsed = defaults ? parseTolerantAgentCapabilityConfig(defaults, warnings) : {};
  return { default: parsed, ...(warnings.length > 0 ? { warnings } : {}) };
}

/** Strict parser for bundled built-in agent.md capability overrides. */
export function parseAgentCapabilityConfig(raw: unknown, path = 'agent'): AgentCapabilityConfig {
  if (raw === undefined) return {};
  const obj = readObject(raw, path);
  rejectUnknownKeys(obj, ROOT_KEYS, path);
  const result: AgentCapabilityConfig = {};

  if (obj.modelConfigId !== undefined) {
    if (typeof obj.modelConfigId !== 'string' || !obj.modelConfigId.trim()) {
      invalid(`${path}.modelConfigId`, 'must be a non-empty string');
    }
    result.modelConfigId = obj.modelConfigId.trim();
  }

  if (obj.persona !== undefined) {
    const persona = readObject(obj.persona, `${path}.persona`);
    rejectUnknownKeys(persona, PERSONA_KEYS, `${path}.persona`);
    if (persona.enabled !== undefined && typeof persona.enabled !== 'boolean') {
      invalid(`${path}.persona.enabled`, 'must be a boolean');
    }
    result.persona = {
      ...(typeof persona.enabled === 'boolean' ? { enabled: persona.enabled } : {}),
    };
  }

  if (obj.tools !== undefined) {
    if (!Array.isArray(obj.tools)) invalid(`${path}.tools`, 'must be an array');
    result.tools = obj.tools.map((value, index) => {
      if (typeof value !== 'string' || !TOOL_IDS.has(value)) {
        invalid(`${path}.tools[${index}]`, `must be one of ${AGENT_BUILTIN_TOOL_IDS.join(', ')}`);
      }
      return value as AgentBuiltinToolId;
    });
  }

  if (obj.builtinTools !== undefined) {
    if (!Array.isArray(obj.builtinTools)) invalid(`${path}.builtinTools`, 'must be an array');
    result.builtinTools = obj.builtinTools.map((value, index) => {
      if (value === 'web_search') {
        invalid(
          `${path}.builtinTools[${index}]`,
          'web_search is feature-owned; use features.webSearch',
        );
      }
      if (typeof value !== 'string' || !MCP_TOOL_IDS.has(value)) {
        invalid(
          `${path}.builtinTools[${index}]`,
          `must be one of ${AGENT_BUILTIN_MCP_TOOL_IDS.join(', ')}`,
        );
      }
      return value as AgentBuiltinMcpToolId;
    });
  }

  if (obj.skills !== undefined) {
    if (!Array.isArray(obj.skills)) invalid(`${path}.skills`, 'must be an array');
    result.skills = obj.skills.map((value, index) => {
      if (typeof value === 'string' && OWNED_SKILL_IDS.has(value.trim())) {
        const name = value.trim();
        invalid(
          `${path}.skills[${index}]`,
          `${name} is capability-owned; use its owning Tool or feature switch`,
        );
      }
      if (typeof value !== 'string' || !SKILL_IDS.has(value.trim())) {
        invalid(`${path}.skills[${index}]`, `must be one of ${AGENT_BUILTIN_SKILL_IDS.join(', ')}`);
      }
      return value.trim() as AgentBuiltinSkillId;
    });
  }

  if (obj.features !== undefined) {
    const features = readObject(obj.features, `${path}.features`);
    rejectUnknownKeys(features, FEATURE_KEYS, `${path}.features`);
    for (const key of FEATURE_KEYS) {
      if (features[key] !== undefined && typeof features[key] !== 'boolean') {
        invalid(`${path}.features.${key}`, 'must be a boolean');
      }
    }
    result.features = {
      ...(typeof features.mavis === 'boolean' ? { mavis: features.mavis } : {}),
      ...(typeof features.delegation === 'boolean' ? { delegation: features.delegation } : {}),
      ...(typeof features.webSearch === 'boolean' ? { webSearch: features.webSearch } : {}),
    };
  }

  return result;
}

function parseTolerantAgentCapabilityConfig(
  obj: Record<string, unknown>,
  warnings: string[],
): AgentCapabilityConfig {
  const result: AgentCapabilityConfig = {};
  if (typeof obj.modelConfigId === 'string' && obj.modelConfigId.trim()) {
    result.modelConfigId = obj.modelConfigId.trim();
  }
  const persona = asRecord(obj.persona);
  if (typeof persona?.enabled === 'boolean') {
    result.persona = { enabled: persona.enabled };
  }

  // User config may name tool IDs this build does not know (newer builds, removed tools, typos).
  // Drop those one by one: discarding the whole list would widen it to "every tool".
  if (Array.isArray(obj.tools)) {
    const tools = dropUnknownIds(
      obj.tools,
      TOOL_IDS,
      'agents.default.tools',
      warnings,
    ) as AgentBuiltinToolId[];
    // Older user allowlists predate configurable task controls: those tools
    // remained available even with tools: [] or delegation disabled. Preserve
    // that behavior unless the list explicitly selects the new control IDs.
    // Bundled agent.md uses the strict parser and keeps its exact ceiling.
    if (!TASK_CONTROL_IDS.some((id) => tools.includes(id))) {
      tools.push(...TASK_CONTROL_IDS);
    }
    result.tools = tools;
  }
  if (isKnownIdArray(obj.builtinTools, MCP_TOOL_IDS)) {
    result.builtinTools = [...obj.builtinTools] as AgentBuiltinMcpToolId[];
  }
  if (Array.isArray(obj.skills)) {
    const normalizedSkills = obj.skills.map((value) =>
      typeof value === 'string' ? value.trim() : value,
    );
    if (
      normalizedSkills.every(
        (value) =>
          typeof value === 'string' &&
          (SKILL_IDS.has(value) || RETIRED_TOLERANT_SKILL_IDS.has(value)) &&
          !OWNED_SKILL_IDS.has(value),
      )
    ) {
      result.skills = normalizedSkills.filter(
        (value): value is AgentBuiltinSkillId => typeof value === 'string' && SKILL_IDS.has(value),
      );
    }
  }

  const features = asRecord(obj.features);
  if (features) {
    const parsedFeatures: NonNullable<AgentCapabilityConfig['features']> = {};
    for (const key of FEATURE_KEYS as Set<keyof typeof parsedFeatures>) {
      if (typeof features[key] === 'boolean') parsedFeatures[key] = features[key];
    }
    if (Object.keys(parsedFeatures).length > 0) result.features = parsedFeatures;
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isKnownIdArray(
  value: unknown,
  knownIds: ReadonlySet<string>,
): value is AgentBuiltinToolId[] | AgentBuiltinMcpToolId[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === 'string' && knownIds.has(item))
  );
}

/**
 * Keeps the IDs this build knows. Each dropped ID narrows the list the user wrote, so it becomes a
 * warning and a tool missing from the Agent can be traced back to the config.
 */
function dropUnknownIds(
  values: readonly unknown[],
  known: ReadonlySet<string>,
  path: string,
  warnings: string[],
): string[] {
  const isKnown = (item: unknown): item is string => typeof item === 'string' && known.has(item);
  const dropped = values.filter((item) => !isKnown(item));
  if (dropped.length > 0) {
    const ids = dropped.map((item) => String(JSON.stringify(item)).slice(0, 64)).join(', ');
    warnings.push(`${path}: ignored IDs this version does not know: ${ids}`);
  }
  return values.filter(isKnown);
}

export function resolveAgentCapabilities(
  defaults: AgentCapabilityConfig = {},
  override: AgentCapabilityConfig = {},
): ResolvedAgentCapabilities {
  return {
    persona: {
      enabled: override.persona?.enabled ?? defaults.persona?.enabled ?? true,
    },
    tools: cloneOptionalArray(override.tools ?? defaults.tools),
    builtinTools: cloneOptionalArray(override.builtinTools ?? defaults.builtinTools),
    skills: cloneOptionalArray(override.skills ?? defaults.skills),
    features: {
      mavis: override.features?.mavis ?? defaults.features?.mavis ?? true,
      delegation: override.features?.delegation ?? defaults.features?.delegation ?? true,
      webSearch: override.features?.webSearch ?? defaults.features?.webSearch ?? true,
    },
  };
}

export function isAgentBuiltinToolEnabled(
  capabilities: ResolvedAgentCapabilities,
  toolName: AgentBuiltinToolId,
): boolean {
  return capabilities.tools === undefined || capabilities.tools.includes(toolName);
}

export function isAgentBuiltinMcpToolEnabled(
  capabilities: ResolvedAgentCapabilities,
  toolName: AgentBuiltinMcpToolId,
): boolean {
  return capabilities.builtinTools === undefined || capabilities.builtinTools.includes(toolName);
}

export function isAgentBuiltinSkillEnabled(
  capabilities: ResolvedAgentCapabilities,
  skillName: AgentBuiltinSkillId,
): boolean {
  return capabilities.skills === undefined || capabilities.skills.includes(skillName);
}

function cloneOptionalArray<T>(value: readonly T[] | undefined): T[] | undefined {
  return value === undefined ? undefined : [...value];
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(path, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, 'is not supported');
  }
}

function invalid(path: string, message: string): never {
  throw new Error(`Invalid configuration at ${path}: ${message}`);
}
