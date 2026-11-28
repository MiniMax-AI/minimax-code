/**
 * desktop / cloud mavis 共用的 operation 分类器。
 *
 * 两侧 dispatcher 的命令归一化必须和 observability 的 operation label 完全
 * 一致，否则 Grafana 上会出现「命令能跑通但只落进 unknown 桶」的偏差，所以
 * `normalizeMavisCommand` 由两侧 dispatcher 和分类器共同复用。
 */

import type { ToolOperationClassifier } from '@mavis/agent-core/tools';

export function normalizeMavisCommand(rawCommand: string): string {
  const tokens = rawCommand.trim().split(/\s+/).filter(Boolean);
  const aliased = tokens.map((token) => (token === '-h' || token === '--help' ? 'help' : token));
  return aliased.join(' ');
}

export function createMavisOperationClassifier(
  allowedValues: readonly string[],
): ToolOperationClassifier {
  const allowed = new Set(allowedValues);
  return {
    allowedValues,
    classify(args) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined;
      const rawCommand = (args as { command?: unknown }).command;
      if (typeof rawCommand !== 'string') return undefined;
      const command = normalizeMavisCommand(rawCommand);
      return allowed.has(command) ? command : undefined;
    },
  };
}

/**
 * A tool split out of the composite mavis runs exactly one command, so its
 * operation label is that command whatever arguments the call carries. The
 * label vocabulary stays the mavis command set, so a dashboard reading
 * `session list` keeps reading it after the command became its own tool.
 */
export function fixedOperationClassifier(operation: string): ToolOperationClassifier {
  return {
    allowedValues: [operation],
    classify: () => operation,
  };
}
