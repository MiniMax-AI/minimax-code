import Handlebars from 'handlebars';
import yaml from 'yaml';
import {
  AGENT_BUILTIN_TOOL_IDS,
  isAgentBuiltinToolEnabled,
  type AgentBuiltinToolId,
  type ResolvedAgentCapabilities,
} from '@mavis/config';
import { roleDirectoryText } from '@mavis/agent-tools/desktop/subagent-roles';

import type { BuiltinRenderInput } from './definitions.js';

const BUILTIN_HANDLEBARS = Handlebars.create();

export function createBuiltinPromptContext(
  input: BuiltinRenderInput,
  featurePrompts: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const capabilities: ResolvedAgentCapabilities = input.capabilities;
  const tools = Object.fromEntries(
    AGENT_BUILTIN_TOOL_IDS.map((toolName) => [
      toolName,
      isAgentBuiltinToolEnabled(capabilities, toolName),
    ]),
  ) as Record<AgentBuiltinToolId, boolean>;
  const skills = Object.fromEntries(
    (capabilities.skills ?? []).map((skill) => [skill, true]),
  ) as Record<string, boolean>;
  skills.mavis = capabilities.features.mavis;
  return {
    tools,
    persona: capabilities.persona,
    profile: { tui: input.promptProfile === 'tui' },
    features: capabilities.features,
    skills,
    memory: { enabled: input.memoryEnabled ?? capabilities.features.mavis },
    cron: { enabled: input.cronEnabled ?? capabilities.features.mavis },
    surface: {
      interactive: input.surface !== 'task-child',
      taskChild: input.surface === 'task-child',
      cli: input.surface === 'cli',
    },
    featurePrompts,
    // Templates must read this only through `lookup` (see _v2/tui/SYSTEM.md.hbs):
    // online prompts are shared by every client version, older contexts have
    // no `ptc`, and strict mode throws on `ptc.enabled` when it is missing.
    ptc: { enabled: input.ptc !== undefined, section: input.ptc?.section ?? '' },
    DATA_DIR: input.dataDirToken ?? '{{DATA_DIR}}',
    ROLE_DIRECTORY: roleDirectoryText(),
  };
}

export function renderBuiltinTemplate(
  template: string,
  context: Record<string, unknown>,
  source: string,
): string {
  try {
    return BUILTIN_HANDLEBARS.compile(template, { noEscape: true, strict: true })(context);
  } catch (error) {
    throw new Error(`Invalid V2 built-in Agent prompt ${source}: ${describeError(error)}`, {
      cause: error,
    });
  }
}

export function parseFrontmatter(raw: string): {
  readonly frontmatter: Record<string, unknown>;
  readonly body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(raw);
  if (!match) return { frontmatter: {}, body: raw };
  const parsed = parseYaml(match[1] ?? '');
  return {
    frontmatter:
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
    body: raw.slice(match[0].length),
  };
}

export function stripFrontmatter(raw: string): string {
  return parseFrontmatter(raw).body;
}

function parseYaml(raw: string): unknown {
  return yaml.parse(raw);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
