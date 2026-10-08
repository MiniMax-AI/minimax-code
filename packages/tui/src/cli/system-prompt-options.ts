import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Option, type Command } from 'commander';

/** Launch-scoped main-Agent prompt overrides; held in process memory only. */
export interface SystemPromptOverrides {
  readonly customPrompt?: string;
  readonly appendSystemPrompt?: string;
}

export interface RawSystemPromptOptions {
  readonly systemPrompt?: string;
  readonly systemPromptFile?: string;
  readonly appendSystemPrompt?: string;
  readonly appendSystemPromptFile?: string;
}

const SYSTEM_PROMPT_FLAGS = [
  '--system-prompt',
  '--system-prompt-file',
  '--append-system-prompt',
  '--append-system-prompt-file',
] as const;

/** Replace and append are independent; inline text and file are two forms of one slot. */
const SYSTEM_PROMPT_SLOTS = [
  ['systemPrompt', 'systemPromptFile'],
  ['appendSystemPrompt', 'appendSystemPromptFile'],
] as const satisfies readonly (readonly (keyof RawSystemPromptOptions)[])[];

export const SYSTEM_PROMPT_OPTION_NAMES: ReadonlySet<string> = new Set(SYSTEM_PROMPT_SLOTS.flat());

export function applySystemPromptCliOptions(command: Command): Command {
  return command
    .addOption(
      new Option(
        '--system-prompt <text>',
        'replace the main Agent identity prompt for this process',
      ),
    )
    .addOption(
      new Option(
        '--system-prompt-file <path>',
        'read the replacement main Agent identity prompt from a file',
      ),
    )
    .addOption(
      new Option(
        '--append-system-prompt <text>',
        'append text after the main Agent identity prompt for this process',
      ),
    )
    .addOption(
      new Option(
        '--append-system-prompt-file <path>',
        'read the appended main Agent prompt text from a file',
      ),
    );
}

/**
 * Fills each prompt slot from the nearest parent command that received it on the
 * command line, so `mcode --system-prompt-file a.md acp` still applies. A slot set
 * closer to the subcommand wins as a whole: `exec --system-prompt` replaces a
 * `--system-prompt-file` given before `exec` instead of conflicting with it.
 */
export function inheritSystemPromptOptions<T extends RawSystemPromptOptions>(
  command: Command,
  options: T,
): T {
  let resolved = options;
  for (const slot of SYSTEM_PROMPT_SLOTS) {
    if (slot.some((name) => options[name] !== undefined)) continue;
    for (let parent = command.parent; parent; parent = parent.parent) {
      const owner = parent;
      const given = slot.filter((name) => owner.getOptionValueSource(name) === 'cli');
      if (given.length === 0) continue;
      for (const name of given) resolved = { ...resolved, [name]: owner.getOptionValue(name) };
      break;
    }
  }
  return resolved;
}

/**
 * Prompt flags written before a subcommand that does not accept them fail the
 * launch instead of being parsed by a parent and silently ignored.
 */
export function rejectUnsupportedSystemPromptOptions(command: Command): void {
  if (command.options.some((option) => option.attributeName() === 'systemPrompt')) return;
  for (let parent = command.parent; parent; parent = parent.parent) {
    for (const option of parent.options) {
      const name = option.attributeName();
      if (!SYSTEM_PROMPT_OPTION_NAMES.has(name)) continue;
      if (parent.getOptionValueSource(name) !== 'cli') continue;
      const path: string[] = [];
      for (let current: Command | null = command; current?.parent; current = current.parent) {
        path.unshift(current.name());
      }
      command.error(`error: option '${option.long}' is not supported by '${path.join(' ')}'`, {
        code: 'commander.unknownOption',
      });
    }
  }
}

/** Reads each file once at startup; failures abort the launch instead of running unpatched. */
export function resolveSystemPromptOverrides(
  options: RawSystemPromptOptions,
  cwd: string = process.cwd(),
): SystemPromptOverrides | undefined {
  const customPrompt = readPromptSource(
    '--system-prompt',
    options.systemPrompt,
    options.systemPromptFile,
    cwd,
  );
  const appendSystemPrompt = readPromptSource(
    '--append-system-prompt',
    options.appendSystemPrompt,
    options.appendSystemPromptFile,
    cwd,
  );
  if (customPrompt === undefined && appendSystemPrompt === undefined) return undefined;
  return {
    ...(customPrompt === undefined ? {} : { customPrompt }),
    ...(appendSystemPrompt === undefined ? {} : { appendSystemPrompt }),
  };
}

/** Restarted processes keep the original flags; the overrides are never persisted. */
export function systemPromptRestartArguments(argv: readonly string[]): string[] {
  const result: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined || argument === '--') break;
    const flag = SYSTEM_PROMPT_FLAGS.find(
      (candidate) => argument === candidate || argument.startsWith(`${candidate}=`),
    );
    if (!flag) continue;
    if (argument !== flag) {
      result.push(argument);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined) break;
    result.push(flag, value);
    index += 1;
  }
  return result;
}

function readPromptSource(
  flag: string,
  inline: string | undefined,
  file: string | undefined,
  cwd: string,
): string | undefined {
  if (inline !== undefined && file !== undefined) {
    throw new Error(`${flag} and ${flag}-file cannot be combined.`);
  }
  if (inline !== undefined) {
    if (!inline.trim()) throw new Error(`${flag} cannot be empty.`);
    return inline;
  }
  if (file === undefined) return undefined;
  if (!file.trim()) throw new Error(`${flag}-file requires a path.`);
  let text: string;
  try {
    text = readFileSync(resolve(cwd, file), 'utf8');
  } catch (error) {
    throw new Error(
      `Failed to read ${flag}-file ${file}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!text.trim()) throw new Error(`${flag}-file ${file} is empty.`);
  return text;
}
