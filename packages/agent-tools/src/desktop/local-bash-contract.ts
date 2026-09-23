import { getShellConfig } from '@earendil-works/pi-coding-agent/shell';
import type { ToolDefinition } from '@mavis/agent-core/tools';
import { Clone, Type } from '@sinclair/typebox';

import { LocalBashToolDef } from './builtin-defs.js';
import {
  DEFAULT_FOREGROUND_BASH_SOFT_YIELD_MS,
  DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS,
  MAX_FOREGROUND_BASH_TIMEOUT_SECONDS,
  MAX_MANAGED_BASH_TIMEOUT_SECONDS,
} from './local-bash-timing.js';

export interface LocalBashTurnCapabilities {
  readonly background: boolean;
  readonly shell: ReturnType<typeof getShellConfig>['type'] | 'unavailable';
}

export function resolveLocalBashShell(): LocalBashTurnCapabilities['shell'] {
  try {
    return getShellConfig().type;
  } catch {
    return 'unavailable';
  }
}

/** A fresh definition for the final admitted Turn inventory. */
export function createLocalBashToolDefinition(
  capabilities: LocalBashTurnCapabilities,
): ToolDefinition {
  const base = Clone(LocalBashToolDef.schema);
  const schema = capabilities.background ? base : Type.Omit(base, ['run_in_background']);
  schema.properties.timeout.description = capabilities.background
    ? `Total command timeout in seconds. Foreground with automatic backgrounding: default/max ${MAX_MANAGED_BASH_TIMEOUT_SECONDS}s, including foreground time. Explicit background: uses the specified timeout, or a 30-minute limit if omitted.`
    : `Timeout in seconds. Foreground: default ${DEFAULT_FOREGROUND_BASH_TIMEOUT_SECONDS}s; values above ${MAX_FOREGROUND_BASH_TIMEOUT_SECONDS}s are capped.`;
  return {
    ...LocalBashToolDef,
    schema,
    description: `${LocalBashToolDef.description}\n\n${renderBashUsage(capabilities)}`,
  };
}

function renderBashUsage(capabilities: LocalBashTurnCapabilities): string {
  return [
    ...(capabilities.background
      ? [
          `- Foreground calls wait up to ${DEFAULT_FOREGROUND_BASH_SOFT_YIELD_MS / 1000}s, then return a task_id if unfinished. The same command continues in the background; do not start it again.`,
          '- Set run_in_background=true to return a task_id without waiting for completion.',
          '- Background completion notifies you automatically. Continue independent work; use task_output for current output and task_stop, when available, to cancel.',
          '- Backgrounding and reading output do not reset the command timeout.',
        ]
      : ['- This Turn supports foreground execution only.']),
    "- Large output preserves the beginning and end. Follow the result's instructions to read omitted output.",
    ...shellRules(capabilities.shell),
  ].join('\n');
}

function shellRules(shell: LocalBashTurnCapabilities['shell']): string[] {
  if (shell === 'unavailable')
    return [
      '- No local shell was resolved. Do not assume Bash or PowerShell syntax is executable.',
    ];
  if (shell === 'bash')
    return [
      '- Selected shell: Bash. Use Bash syntax, including on Windows when Bash is the selected fallback.',
    ];
  if (shell === 'sh')
    return [
      '- Selected shell: POSIX sh. Use POSIX shell syntax; Bash arrays, [[ ... ]] and process substitution are unavailable.',
    ];
  return [
    shell === 'pwsh'
      ? '- Selected shell: PowerShell 7 (pwsh). Pipeline-chain operators && and || are supported; use PowerShell quoting and variable syntax.'
      : '- Selected shell: Windows PowerShell 5.1. The && and || operators are unsupported; use separate statements and explicit success checks.',
    '- Use $env:VAR and single quotes for literals/regex. Do not use Bash export, /dev/null, heredocs, sed -i, or backslash quoting. Do not wrap ordinary commands in powershell -Command or cmd /c.',
    "- Start multi-statement scripts with $ErrorActionPreference = 'Stop'. Check $LASTEXITCODE after native programs, or enable $PSNativeCommandUseErrorActionPreference when available.",
    `- Prefer dedicated file tools. If shell file I/O is necessary, specify UTF-8 and avoid Get-Content | ... | Set-Content editing pipelines.${
      shell === 'powershell'
        ? ' PowerShell 5.1 -Encoding UTF8 writes a BOM.'
        : ' PowerShell 7 defaults to UTF-8 without BOM.'
    }`,
    '- If a CLI is missing, check .cmd/.ps1 wrappers. Change strategy after repeated syntax failures.',
  ];
}
