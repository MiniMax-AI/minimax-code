import path from 'node:path';

import {
  AgentConfigError,
  parseCanonicalAgentMarkdown,
  type CanonicalAgentConfig,
} from '../../../../agent/storage/canonical-agent-config.js';
import type { CanonicalPluginRoot } from '../filesystem.js';
import { readerFail } from '../reader-errors.js';
import type { PluginReaderDiagnostic } from '../types.js';
import {
  acceptPluginAgents,
  agentDiagnostic,
  readAgentMarkdown,
  type AgentCandidate,
  type AgentCandidateConfig,
  type PluginAgentReadContext,
  type PluginAgentReadResult,
} from './accept.js';

/**
 * MiniMax Agents use the Custom Agent `agent.md` contract verbatim; the file
 * stem is the identity. Invalid declared files reject the package, like Skills.
 */
export async function readMiniMaxPluginAgents(
  root: CanonicalPluginRoot,
  input: PluginAgentReadContext & { readonly declared: readonly string[] },
): Promise<PluginAgentReadResult> {
  const diagnostics: PluginReaderDiagnostic[] = [];
  const candidates: AgentCandidate[] = [];
  for (const agentPath of input.declared) {
    const stem = path.posix.basename(agentPath, '.md');
    const file = await readAgentMarkdown(root, agentPath, { portable: true });
    let config: CanonicalAgentConfig;
    try {
      config = parseCanonicalAgentMarkdown(file.content, stem);
    } catch (error) {
      if (error instanceof AgentConfigError) {
        readerFail('AGENT_SCHEMA_INVALID', `${agentPath} ${error.field} is invalid`);
      }
      throw error;
    }
    for (const diagnostic of config.diagnostics) {
      diagnostics.push(agentDiagnostic(diagnostic.code, `${agentPath}#${diagnostic.field}`));
    }
    for (const field of ['avatar', 'defaultWorkspaceDir'] as const) {
      if (config.xMavis?.[field] !== undefined) {
        diagnostics.push(agentDiagnostic('AGENT_FIELD_IGNORED', `${agentPath}#x-mavis.${field}`));
      }
    }
    candidates.push({
      segments: [stem],
      sourceFormat: 'MINIMAX',
      agentPath,
      agentFilePath: file.path,
      content: file.content,
      config: miniMaxCandidateConfig(config),
    });
  }
  return acceptPluginAgents(input, candidates, diagnostics);
}

function miniMaxCandidateConfig(config: CanonicalAgentConfig): AgentCandidateConfig {
  return {
    description: config.description,
    systemPrompt: config.systemPrompt,
    ...(config.model ? { model: config.model } : {}),
    ...(config.effort ? { effort: config.effort } : {}),
    ...(config.tools === undefined ? {} : { tools: config.tools }),
    ...(config.disallowedTools === undefined ? {} : { disallowedTools: config.disallowedTools }),
    ...(config.mcpServers === undefined ? {} : { mcpServers: config.mcpServers }),
    ...(config.skills === undefined ? {} : { skills: config.skills }),
    ...(config.xMavis ? miniMaxExtensionConfig(config.xMavis) : {}),
  };
}

function miniMaxExtensionConfig(
  mavis: NonNullable<CanonicalAgentConfig['xMavis']>,
): Pick<
  AgentCandidateConfig,
  'displayName' | 'contextWindow' | 'maxOutputTokens' | 'extensionSkills'
> {
  return {
    ...(mavis.displayName ? { displayName: mavis.displayName } : {}),
    ...(mavis.contextWindow === undefined ? {} : { contextWindow: mavis.contextWindow }),
    ...(mavis.maxOutputTokens === undefined ? {} : { maxOutputTokens: mavis.maxOutputTokens }),
    ...(mavis.extensionSkills === undefined ? {} : { extensionSkills: mavis.extensionSkills }),
  };
}
