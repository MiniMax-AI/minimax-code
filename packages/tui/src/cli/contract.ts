import { InvalidArgumentError, Option, type Command } from 'commander';
import { parseHeadlessModelOverride } from '../headless/model-selection.js';
import type { TuiMode } from '../tui/engine/public.js';
import { parseTuiStartupEnvironment } from './environment.js';
import type { TuiBuildEnvironment } from '../auth/environment.js';

const RETIRED_TOP_LEVEL_COMMAND_NAMES = new Set(['git', 'changes', 'projects']);

export interface TuiInteractiveLaunchRequest {
  readonly initialPrompt?: string;
  readonly model?: string;
  readonly sessionId?: string;
  readonly showSessionPicker?: boolean;
  readonly continueLatestSession?: boolean;
  readonly workspaceDir?: string;
  readonly resumeDraftAfterLogin?: boolean;
  readonly tuiMode?: TuiMode;
  readonly lane?: string;
}

export interface RawTuiInteractiveOptions {
  readonly model?: string;
  readonly session?: string | boolean;
  readonly continue?: boolean;
  readonly resume?: string;
  readonly tuiMode?: TuiMode;
  readonly lane?: string;
  readonly env?: TuiBuildEnvironment;
}

export function applyInteractiveCliContract(
  command: Command,
  options: { readonly allowStartupEnvironmentSelection?: boolean } = {},
): Command {
  const configured = command
    .argument('[prompt]', 'task to execute in the interactive TUI')
    .addOption(new Option('-m, --model <provider/model>', 'select the model for this Session only'))
    .addOption(new Option('--lane <lane>', 'managed backend lane for test or staging builds'))
    .addOption(
      new Option('--session [id]', 'open a Session by id, or browse Sessions when id is omitted'),
    )
    .addOption(new Option('-c, --continue', 'continue the latest Session in the current workspace'))
    .addOption(
      new Option('--tui-mode <mode>', 'TUI mode: regular (default) or fullscreen').argParser(
        parseTuiMode,
      ),
    )
    .addOption(new Option('--resume <id>').hideHelp())
    .allowExcessArguments(false)
    .showHelpAfterError();
  if (options.allowStartupEnvironmentSelection) {
    configured.addOption(
      new Option(
        '--env <environment>',
        'startup environment for the internal package: test, staging (pre), or prod',
      ).argParser(parseStartupEnvironmentOption),
    );
  }
  return configured;
}

export function resolveInteractiveLaunchRequest(
  prompt: string | undefined,
  commandOptions: RawTuiInteractiveOptions,
): TuiInteractiveLaunchRequest {
  if (prompt && RETIRED_TOP_LEVEL_COMMAND_NAMES.has(prompt)) {
    throw new Error('too many arguments');
  }
  const explicitSessionId =
    typeof commandOptions.session === 'string' ? commandOptions.session.trim() : undefined;
  const compatibilitySessionId = commandOptions.resume?.trim();
  const showSessionPicker = commandOptions.session === true;
  const requestedModes = [
    Boolean(explicitSessionId || showSessionPicker),
    Boolean(compatibilitySessionId),
    commandOptions.continue === true,
  ].filter(Boolean).length;
  if (requestedModes > 1) {
    throw new Error('--session, --continue, and --resume cannot be combined');
  }
  const sessionId = explicitSessionId || compatibilitySessionId;
  const model = commandOptions.model?.trim();
  if (commandOptions.model !== undefined) {
    parseHeadlessModelOverride(model ?? '');
    if (showSessionPicker) {
      throw new Error(
        '--model requires a Session id with --session; use --session <id> or --continue.',
      );
    }
  }
  return {
    ...(prompt ? { initialPrompt: prompt } : {}),
    ...(model ? { model } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(showSessionPicker ? { showSessionPicker: true } : {}),
    ...(commandOptions.continue ? { continueLatestSession: true } : {}),
    ...(commandOptions.tuiMode ? { tuiMode: commandOptions.tuiMode } : {}),
    ...(commandOptions.lane ? { lane: commandOptions.lane } : {}),
  };
}

export function applyExecCliContract(command: Command): Command {
  return command
    .argument('[prompt]', 'task to execute')
    .addOption(new Option('--input <source>', 'read explicit input; only "-" is supported'))
    .addOption(new Option('--input-format <format>', 'input format: text or json').default('text'))
    .addOption(new Option('--cwd <path>', 'workspace directory'))
    .addOption(
      new Option('--file <path>', 'attach a file (repeatable)')
        .argParser(collectOptionValue)
        .default([]),
    )
    .addOption(new Option('--model <provider/model>', 'override the model for this Run only'))
    .addOption(new Option('--effort <level>', 'override the reasoning effort for this Run only'))
    .addOption(
      new Option('--prompt-mode <mode>', 'Prompt mode: tui, coding, or work')
        .choices(['tui', 'coding', 'work'])
        .default('tui'),
    )
    .addOption(new Option('--session <id>', 'run in an existing active Session'))
    .addOption(new Option('--continue', 'continue the latest active Session in --cwd'))
    .addOption(
      new Option('--config <path>', 'use an explicit Runtime config file for this process'),
    )
    .addOption(
      new Option(
        '--permission <policy>',
        'permission policy: smart, full, or off (ask requires TUI/ACP)',
      ).default('smart'),
    )
    .addOption(new Option('--timeout <duration>', 'Run timeout, for example 30s or 2m'))
    .addOption(new Option('--max-steps <count>', 'maximum assistant steps'))
    .addOption(new Option('--output-format <format>', 'output format: text, json, or stream-json'))
    .addOption(
      new Option(
        '--diagnostics-dir <path>',
        'save bounded execution diagnostics to a fresh directory',
      ),
    )
    .addOption(
      new Option(
        '--output-schema <schema>',
        'JSON Schema file or inline object for the final answer',
      ),
    )
    .addOption(
      new Option('-o, --output-last-message <path>', 'write the final agent message to a file'),
    );
}

export function applyExecReviewCliContract(command: Command): Command {
  return command
    .addOption(new Option('--cwd <path>', 'workspace directory'))
    .addOption(new Option('--model <provider/model>', 'override the model for this Run only'))
    .addOption(new Option('--effort <level>', 'override the reasoning effort for this Run only'))
    .addOption(
      new Option('--config <path>', 'use an explicit Runtime config file for this process'),
    )
    .addOption(
      new Option(
        '--permission <policy>',
        'permission policy: smart, full, or off (ask requires TUI/ACP)',
      ).default('smart'),
    )
    .addOption(new Option('--timeout <duration>', 'Run timeout, for example 30s or 2m'))
    .addOption(new Option('--max-steps <count>', 'maximum assistant steps'))
    .addOption(new Option('--output-format <format>', 'output format: text, json, or stream-json'))
    .addOption(
      new Option('-o, --output-last-message <path>', 'write the final review result to a file'),
    )
    .allowExcessArguments(false)
    .showHelpAfterError();
}

function parseTuiMode(value: string): TuiMode {
  if (value === 'regular' || value === 'fullscreen') return value;
  throw new InvalidArgumentError('TUI mode must be regular or fullscreen');
}

function parseStartupEnvironmentOption(value: string): TuiBuildEnvironment {
  try {
    return parseTuiStartupEnvironment(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
}

function collectOptionValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}
