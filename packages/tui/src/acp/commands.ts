import * as acp from '@agentclientprotocol/sdk';

import { TUI_COMMAND_DESCRIPTORS } from '../application/command-descriptors.js';
import { sanitizeTerminalText } from '../tui/rendering/terminal-text.js';
import type { TuiModel, TuiSkillList } from '../runtime/port.js';
import type { TuiAcpRuntime } from './runtime.js';

export const TUI_ACP_AVAILABLE_COMMANDS = [
  {
    ...TUI_COMMAND_DESCRIPTORS.help,
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.new,
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.model,
    input: { hint: '[provider/model[#variant]]' },
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.status,
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.doctor,
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.context,
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.skills,
    input: { hint: '[filter]' },
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.mcp,
    input: { hint: '[filter]' },
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.usage,
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.compact,
    input: { hint: '[instructions]' },
  },
] satisfies readonly acp.AvailableCommand[];

/** Keep native commands authoritative and expose only invocable Skill names. */
export function availableSkillCommands(result: TuiSkillList): acp.AvailableCommand[] {
  const seen = new Set<string>(TUI_ACP_AVAILABLE_COMMANDS.map((command) => command.name));
  return (result.skills ?? [])
    .flatMap((skill): acp.AvailableCommand[] => {
      const name = skill.name.trim().toLowerCase();
      if (
        skill.enabled === false ||
        seen.has(name) ||
        name.length > 128 ||
        !/^[a-z0-9][a-z0-9._-]*(?::[a-z0-9][a-z0-9._-]*)?$/u.test(name)
      )
        return [];
      seen.add(name);
      const description = sanitizeTerminalText(
        skill.displayDescription ?? skill.description ?? '',
      ).trim();
      return [
        {
          name,
          description: description ? `[Skill] ${description}` : '[Skill]',
          input: { hint: '[instructions]' },
        },
      ];
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export type TuiAcpCommandResult =
  | { readonly handled: false }
  | {
      readonly handled: true;
      readonly output: string;
    };

export async function executeTuiAcpCommand(options: {
  readonly runtime: Pick<
    TuiAcpRuntime,
    | 'getAccountStatus'
    | 'getContextSnapshot'
    | 'getRuntimeDiagnostics'
    | 'getSessionUsage'
    | 'listMcpServers'
    | 'listModels'
    | 'listSkills'
    | 'requestCompaction'
    | 'selectModel'
  >;
  readonly sessionId: string;
  readonly agentName?: string;
  readonly workspaceDir?: string;
  readonly prompt: readonly acp.ContentBlock[];
}): Promise<TuiAcpCommandResult> {
  const command = parseCommand(options.prompt);
  if (!command) return { handled: false };
  if (command.name === 'help') {
    if (command.input) {
      throw acp.RequestError.invalidParams(undefined, 'Use `/help` without arguments.');
    }
    return { handled: true, output: formatAvailableCommands() };
  }
  if (command.name === 'new') {
    if (command.input) {
      throw acp.RequestError.invalidParams(undefined, 'Use `/new` without arguments.');
    }
    return {
      handled: true,
      output: 'Start a new thread in your ACP client to begin a fresh session.',
    };
  }
  if (command.name === 'status') {
    if (command.input) {
      throw acp.RequestError.invalidParams(undefined, 'Use `/status` without arguments.');
    }
    const [account, models] = await Promise.all([
      options.runtime.getAccountStatus(options.sessionId),
      options.runtime.listModels(options.sessionId),
    ]);
    return { handled: true, output: formatStatus(account, models) };
  }
  if (command.name === 'doctor') {
    if (command.input) {
      throw acp.RequestError.invalidParams(undefined, 'Use `/doctor` without arguments.');
    }
    return {
      handled: true,
      output: formatDiagnostics(await options.runtime.getRuntimeDiagnostics()),
    };
  }
  if (command.name === 'context') {
    requireNoInput(command, 'context');
    return {
      handled: true,
      output: formatContext(await options.runtime.getContextSnapshot(options.sessionId)),
    };
  }
  if (command.name === 'skills') {
    return {
      handled: true,
      output: formatSkills(
        await options.runtime.listSkills(
          options.agentName,
          command.input || undefined,
          options.workspaceDir,
        ),
      ),
    };
  }
  if (command.name === 'mcp') {
    return {
      handled: true,
      output: formatMcpServers(
        await options.runtime.listMcpServers(command.input || undefined, options.sessionId),
      ),
    };
  }
  if (command.name === 'usage') {
    requireNoInput(command, 'usage');
    return {
      handled: true,
      output: formatUsage(await options.runtime.getSessionUsage(options.sessionId)),
    };
  }
  if (command.name === 'compact') {
    const result = await options.runtime.requestCompaction(
      options.sessionId,
      options.agentName,
      command.input || undefined,
    );
    if (result.success) return { handled: true, output: formatCompaction(result) };
    if (result.code === 'NOTHING_TO_COMPACT' || result.code === 'unchanged') {
      return {
        handled: true,
        output: 'No compaction is needed for this conversation yet.',
      };
    }
    throw acp.RequestError.internalError(
      undefined,
      result.error ?? result.code ?? 'Runtime rejected the compaction request.',
    );
  }
  if (command.name !== 'model') return { handled: false };

  const models = await options.runtime.listModels(options.sessionId);
  if (!command.input) {
    return { handled: true, output: formatAvailableModels(models) };
  }

  const selection = resolveModelSelection(models, command.input);
  const selected = await options.runtime.selectModel(selection, options.sessionId);
  if (!selected) {
    throw acp.RequestError.invalidParams(
      undefined,
      `MiniMax Code Runtime rejected model selection ${formatModelSelection(selection)}.`,
    );
  }
  return { handled: true, output: `Model selected: ${formatModelSelection(selection)}` };
}

function formatCompaction(result: Awaited<ReturnType<TuiAcpRuntime['requestCompaction']>>): string {
  return [
    'Compaction completed.',
    ...(result.messagesBefore !== undefined && result.messagesAfter !== undefined
      ? [
          `Messages: ${formatInteger(result.messagesBefore)} → ${formatInteger(result.messagesAfter)}`,
        ]
      : []),
    ...(result.tokensBefore !== undefined && result.tokensAfter !== undefined
      ? [`Tokens: ${formatInteger(result.tokensBefore)} → ${formatInteger(result.tokensAfter)}`]
      : []),
  ].join('\n');
}

function requireNoInput(command: { readonly input: string }, name: string): void {
  if (command.input) {
    throw acp.RequestError.invalidParams(undefined, `Use \`/${name}\` without arguments.`);
  }
}

function formatContext(snapshot: Awaited<ReturnType<TuiAcpRuntime['getContextSnapshot']>>): string {
  if (snapshot.status === 'loading') return 'Context is still loading. Retry /context shortly.';
  const usage = snapshot.contextUsage;
  if (!usage || snapshot.status === 'empty') {
    return 'No Runtime context snapshot is available for this session yet.';
  }
  const window = usage.contextWindowTokens || snapshot.model?.contextWindow;
  const utilization = window
    ? `${String(Math.round((usage.usedTokens / window) * 100))}%`
    : 'unknown';
  const model = snapshot.model ? `${snapshot.model.provider}/${snapshot.model.id}` : 'not selected';
  return [
    `Context: ${snapshot.status}`,
    `Model: ${model}`,
    `Budget: ${formatInteger(usage.usedTokens)} / ${window ? formatInteger(window) : 'unknown'} tokens (${utilization})`,
    `Compaction: ${snapshot.compaction?.state ?? 'never'}`,
    ...(usage.components.length > 0
      ? [
          'Components:',
          ...usage.components.map(
            (component) =>
              `- ${contextComponentLabel(component.kind)}: ${formatInteger(component.tokens)} tokens`,
          ),
        ]
      : []),
  ].join('\n');
}

function contextComponentLabel(kind: string): string {
  const label = kind.toLocaleLowerCase().replaceAll('_', ' ');
  return `${label.slice(0, 1).toLocaleUpperCase()}${label.slice(1)}`;
}

function formatSkills(result: Awaited<ReturnType<TuiAcpRuntime['listSkills']>>): string {
  const skills = result.skills ?? [];
  if (skills.length === 0) return 'No Skills matched the current Agent configuration.';
  return [
    `Skills · ${String(skills.length)}${result.hasMore ? '+' : ''}`,
    ...skills.map((skill) => {
      const name = skill.displayName ?? skill.name;
      const description = skill.displayDescription ?? skill.description;
      return `- ${name}${description ? ` — ${description}` : ''}`;
    }),
    ...(result.hasMore ? ['More Skills exist; narrow the list with /skills <filter>.'] : []),
  ].join('\n');
}

function formatMcpServers(servers: Awaited<ReturnType<TuiAcpRuntime['listMcpServers']>>): string {
  if (servers.length === 0) return 'No configured MCP servers matched the filter.';
  return [
    `MCP servers · ${String(servers.length)}`,
    ...servers.map(
      (server) =>
        `- ${server.name} — ${server.enabled ? 'enabled' : 'disabled'} · ${server.transport ?? 'unknown transport'}${server.description ? ` — ${server.description}` : ''}`,
    ),
  ].join('\n');
}

function formatUsage(usage: Awaited<ReturnType<TuiAcpRuntime['getSessionUsage']>>): string {
  const summary = usage.summary;
  if (!summary) return 'No usage has been recorded for this session.';
  return [
    'Session usage:',
    `Input tokens: ${formatInteger(summary.inputTokens ?? 0)}`,
    `Output tokens: ${formatInteger(summary.outputTokens ?? 0)}`,
    `Reasoning tokens: ${formatInteger(summary.reasoningTokens ?? 0)}`,
    `Cache read tokens: ${formatInteger(summary.cacheReadTokens ?? 0)}`,
    `Cache write tokens: ${formatInteger(summary.cacheWriteTokens ?? 0)}`,
    `Total tokens: ${formatInteger(summary.totalTokens ?? 0)}`,
    `Turns: ${formatInteger(summary.turns ?? 0)}`,
    `Cost: ${summary.costUsd === undefined ? 'unknown' : `$${summary.costUsd.toFixed(4)}`}`,
  ].join('\n');
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
}

function formatDiagnostics(
  diagnostics: Awaited<ReturnType<TuiAcpRuntime['getRuntimeDiagnostics']>>,
): string {
  const presence = (value: boolean | undefined): string =>
    value === undefined ? 'unknown' : value ? 'present' : 'missing';
  return [
    `Configuration status: ${diagnostics.status ?? 'unknown'}`,
    `Config path: ${diagnostics.configPath ?? 'unavailable'}`,
    `Config file: ${presence(diagnostics.configPresent)}`,
    `Default model: ${diagnostics.defaultModel ?? 'not configured'}`,
    `Provider: ${diagnostics.providerId ?? 'unknown'}`,
    `Authentication: ${diagnostics.authMode ?? 'unknown'}`,
    `Managed token: ${presence(diagnostics.managedTokenPresent)}`,
    `API key: ${presence(diagnostics.apiKeyPresent)}`,
    ...(diagnostics.warnings.length === 0
      ? ['Warnings: none']
      : ['Warnings:', ...diagnostics.warnings.map((warning) => `- ${warning}`)]),
  ].join('\n');
}

function formatStatus(
  account: Awaited<ReturnType<TuiAcpRuntime['getAccountStatus']>>,
  models: readonly TuiModel[],
): string {
  const selected = models.find((model) => model.selected);
  const selectedModel = selected
    ? `${selected.providerId}/${selected.modelId}${selected.displayName ? ` (${selected.displayName})` : ''}`
    : (account.defaultModel ?? 'not selected');
  return [
    `Account status: ${account.status}`,
    `Model: ${selectedModel}`,
    `Model source: ${account.modelSource ?? 'unknown'}`,
    `Authentication: ${account.authMode ?? 'unknown'}`,
    `Managed token: ${account.managedTokenPresent === undefined ? 'unknown' : account.managedTokenPresent ? 'present' : 'missing'}`,
    ...(account.warnings.length === 0
      ? ['Warnings: none']
      : ['Warnings:', ...account.warnings.map((warning) => `- ${warning}`)]),
  ].join('\n');
}

function formatAvailableCommands(): string {
  return [
    'Available commands:',
    ...TUI_ACP_AVAILABLE_COMMANDS.map((command) => {
      const input = 'input' in command && command.input.hint ? ` ${command.input.hint}` : '';
      return `- /${command.name}${input} — ${command.description}`;
    }),
  ].join('\n');
}

function parseCommand(
  prompt: readonly acp.ContentBlock[],
): { readonly name: string; readonly input: string } | undefined {
  if (prompt.length !== 1 || prompt[0]?.type !== 'text') return undefined;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*?))?\s*$/u.exec(prompt[0].text);
  if (!match?.[1]) return undefined;
  return { name: match[1], input: match[2]?.trim() ?? '' };
}

function formatAvailableModels(models: readonly TuiModel[]): string {
  if (models.length === 0) return 'No models are available for this session.';
  return [
    'Available models:',
    ...models.map((model) => {
      const label = model.displayName ? ` (${model.displayName})` : '';
      const selected = model.selected ? ' [selected]' : '';
      return `- ${model.providerId}/${model.modelId}${label}${selected}`;
    }),
    '',
    'Use `/model <provider/model[#variant]>` to switch.',
  ].join('\n');
}

function resolveModelSelection(
  models: readonly TuiModel[],
  input: string,
): Pick<TuiModel, 'providerId' | 'modelId' | 'variant'> {
  const hashIndex = input.indexOf('#');
  const modelRef = hashIndex === -1 ? input : input.slice(0, hashIndex);
  const variant = hashIndex === -1 ? undefined : input.slice(hashIndex + 1);
  const slashIndex = modelRef.indexOf('/');
  if (slashIndex <= 0 || slashIndex === modelRef.length - 1 || (hashIndex !== -1 && !variant)) {
    throw acp.RequestError.invalidParams(
      undefined,
      'Use `/model <provider/model[#variant]>` to select a model.',
    );
  }

  const providerId = modelRef.slice(0, slashIndex);
  const modelId = modelRef.slice(slashIndex + 1);
  const model = models.find(
    (candidate) => candidate.providerId === providerId && candidate.modelId === modelId,
  );
  if (!model) {
    throw acp.RequestError.invalidParams(undefined, `Unknown model ${providerId}/${modelId}.`);
  }
  if (variant && model.supportedVariants && !model.supportedVariants.includes(variant)) {
    throw acp.RequestError.invalidParams(
      undefined,
      `Unknown variant ${variant} for ${providerId}/${modelId}.`,
    );
  }
  return {
    providerId,
    modelId,
    ...(variant ? { variant } : {}),
  };
}

function formatModelSelection(
  selection: Pick<TuiModel, 'providerId' | 'modelId' | 'variant'>,
): string {
  return `${selection.providerId}/${selection.modelId}${selection.variant ? `#${selection.variant}` : ''}`;
}
