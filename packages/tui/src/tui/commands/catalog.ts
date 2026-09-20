import type { SlashCommand } from '../widgets/autocomplete.js';
import { SANDBOX_MODE_DESCRIPTIONS } from '@mavis/config';
import { fuzzyFilter } from '../engine/public.js';
import { TuiContributionRegistry } from '../../contributions/index.js';
import { TUI_COMMAND_DESCRIPTORS } from '../../application/command-descriptors.js';
import { sessionHistoryText, sessionMutationText } from '../features/session-mutation/copy.js';

export type TuiCommandCategory =
  | 'Session'
  | 'Runtime'
  | 'Capability'
  | 'Input'
  | 'Transcript'
  | 'Decision'
  | 'Application';

export type TuiCommandAudience = 'user' | 'internal';
export type TuiCommandDiscoverability = 'primary' | 'contextual' | 'search-only';
export type TuiCommandReadiness = 'immediate' | 'controller' | 'full';

export interface TuiCommandContext {
  readonly hasSession: boolean;
  readonly hasParentSession: boolean;
  readonly managedTokenPresent: boolean;
  readonly queueEnabled: boolean;
  readonly hasLiveRun: boolean;
  readonly hasPendingInteraction?: boolean;
  readonly queuedCount: number;
  readonly canRetry: boolean;
  /** True when the paired temporary BTW side projection is visible. */
  readonly sideMode?: boolean;
}

/**
 * Side mode follows Codex's read-only command surface. Navigation, mutation,
 * auth, and process controls stay unavailable even when typed directly.
 * `/parent` stays available as the explicit "switch back to the main
 * conversation" command; it mirrors the Ctrl+/ toggle, not a close.
 */
export const SIDE_MODE_READ_ONLY_COMMANDS = new Set([
  'help',
  'changelog',
  'context',
  'status',
  'usage',
  'export',
  'transcript',
  'copy',
  'parent',
]);

export interface TuiCommand {
  name: string;
  aliases?: readonly string[];
  description: string;
  category: TuiCommandCategory;
  /** Runtime-provided Skill invocations carry Agent instructions after their slash token. */
  invocationKind?: 'skill';
  /**
   * Internal controls stay reserved for parser compatibility and
   * keyboard/interaction fallbacks, but never appear in slash discovery.
   * A reserved command without a handler is treated as unrecognized.
   */
  audience?: TuiCommandAudience;
  discoverability?: TuiCommandDiscoverability;
  readiness?: TuiCommandReadiness;
  /** Commands that replace or mutate the active Session are unavailable while a Turn is live. */
  runAvailability?: 'idle';
  preparingHint?: string;
  visibleWhen?: (context: TuiCommandContext) => boolean;
  /** Commands handled before catalog dispatch can still advertise live Composer intent. */
  inputWhen?: (context: TuiCommandContext) => boolean;
  unavailableReason?: string;
  /**
   * Syntax shown after the command name. Its presence also declares that the
   * command accepts non-whitespace text after its token; commands without a
   * hint are exact-token commands.
   */
  argumentHint?: string;
  /** Pi-compatible argument candidates, resolved when the Composer queries this command. */
  getArgumentCompletions?: SlashCommand['getArgumentCompletions'];
  shortcut?: string;
  usage: string;
  composerTemplate: string;
}

export type TuiCommandSource = Omit<TuiCommand, 'usage' | 'composerTemplate'>;

export interface TuiCommandInvocation {
  raw: string;
  name: string;
  args: string;
}

export interface TuiCommandInputDescriptor {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly argumentHint?: string;
}

export interface TuiCommandInputMatch<TCommand extends TuiCommandInputDescriptor> {
  readonly source: TCommand;
  readonly raw: string;
  readonly token: string;
  readonly args: string;
}

export type TuiCommandExecutionDisposition = 'consumed' | 'retained';

export type TuiCommandHandler = (
  invocation: TuiCommandInvocation,
) => void | TuiCommandExecutionDisposition | Promise<void | TuiCommandExecutionDisposition>;

export interface TuiCommandContribution {
  readonly id: string;
  readonly order?: number;
  readonly kind?: 'command' | 'active-run';
  readonly source: TuiCommandSource;
  readonly execute?: TuiCommandHandler;
}

// Built-in command metadata uses English consistently, independent of the system locale.
const COMMAND_SOURCES: readonly TuiCommandSource[] = [
  {
    ...TUI_COMMAND_DESCRIPTORS.help,
    category: 'Application',
    readiness: 'immediate',
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.new,
    aliases: ['clear'],
    category: 'Session',
    runAvailability: 'idle',
  },
  {
    name: 'update',
    description: 'Check for and install an MCode update',
    category: 'Application',
    discoverability: 'search-only',
  },
  {
    name: 'changelog',
    description: 'Show the packaged MCode update history',
    category: 'Application',
  },
  {
    name: 'sessions',
    aliases: ['resume'],
    description: 'Search, resume, and manage sessions',
    category: 'Session',
    argumentHint: '[query]',
    runAvailability: 'idle',
  },
  {
    name: 'goal',
    description: 'Start or manage the current Session Goal',
    category: 'Session',
    argumentHint: '<objective | action>',
    getArgumentCompletions: argumentCompleter([
      ['pause', 'Pause Goal auto-continuation'],
      ['resume', 'Resume a paused or blocked Goal'],
      ['edit', 'Edit the current Goal objective'],
      ['clear', 'Remove the current Goal'],
      ['help', 'Show Goal syntax and budget examples'],
      ['budget=', 'Set token budget; enter a value such as 50K'],
      ['budget=clear', 'Remove the Goal token budget'],
    ]),
  },
  {
    name: 'plan',
    description: 'Switch Plan Mode or view the latest Plan',
    category: 'Session',
    argumentHint: '[on | off | status | view]',
    getArgumentCompletions: argumentCompleter([
      ['on', 'Enable Plan Mode'],
      ['off', 'Return to default mode'],
      ['status', 'Show the current Plan Mode'],
      ['view', 'View the latest Plan'],
    ]),
    shortcut: 'Shift+Tab',
  },
  {
    name: 'review',
    description: 'Review staged, unstaged, and untracked local changes',
    category: 'Capability',
  },
  {
    name: 'parent',
    description: 'Return from a sub-agent session to its parent',
    category: 'Session',
    discoverability: 'contextual',
    // SessionFlow keeps ordinary parent navigation idle-only, while a BTW
    // side Session may stop its own foreground Turn and return at any time.
    visibleWhen: (context) => context.hasParentSession,
    unavailableReason: 'The current Session has no parent.',
  },
  {
    name: 'btw',
    aliases: ['side'],
    description: 'Ask a side question without interrupting the running task',
    category: 'Session',
    discoverability: 'contextual',
    // Deliberately not `runAvailability: 'idle'`. Asking a side question while
    // the main task runs is the primary use case, and a catalog command is
    // excluded from steer/queue staging, so `/btw ...` cannot be sent to the
    // running Turn by mistake.
    argumentHint: '[question]',
    visibleWhen: (context) => context.hasSession,
    unavailableReason: 'Open a Session before starting a side conversation.',
  },
  {
    name: 'history',
    description: sessionHistoryText('commandDescription', 'en'),
    category: 'Session',
    discoverability: 'contextual',
    visibleWhen: (context) => context.hasSession,
    unavailableReason: sessionHistoryText('commandUnavailable', 'en'),
  },
  {
    name: 'fork',
    description: sessionMutationText('sessionMutation.command.fork.description', 'en'),
    category: 'Session',
    discoverability: 'contextual',
    runAvailability: 'idle',
    visibleWhen: (context) => context.hasSession,
    unavailableReason: sessionMutationText('sessionMutation.command.fork.unavailable', 'en'),
  },
  {
    name: 'rewind',
    description: sessionMutationText('sessionMutation.command.rewind.description', 'en'),
    category: 'Session',
    discoverability: 'contextual',
    runAvailability: 'idle',
    visibleWhen: (context) => context.hasSession,
    unavailableReason: sessionMutationText('sessionMutation.command.rewind.unavailable', 'en'),
  },
  {
    name: 'edit',
    description: sessionMutationText('sessionMutation.command.edit.description', 'en'),
    category: 'Session',
    discoverability: 'contextual',
    runAvailability: 'idle',
    visibleWhen: (context) => context.hasSession,
    unavailableReason: sessionMutationText('sessionMutation.command.edit.unavailable', 'en'),
  },
  {
    name: 'retry',
    description: 'Resend the last message after a failed response',
    category: 'Session',
    discoverability: 'contextual',
    visibleWhen: (context) => context.canRetry && !context.hasLiveRun,
    unavailableReason: 'There is no failed response to retry in this Session.',
  },
  {
    name: 'rename',
    description: 'Rename the active session',
    category: 'Session',
    discoverability: 'contextual',
    visibleWhen: (context) => context.hasSession,
    unavailableReason: 'Start or resume a Session before renaming it.',
    argumentHint: '[title]',
    runAvailability: 'idle',
  },
  {
    name: 'archive',
    description: 'Archive the active session',
    category: 'Session',
    audience: 'internal',
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.compact,
    category: 'Session',
    argumentHint: '[instructions]',
    discoverability: 'contextual',
    runAvailability: 'idle',
    visibleWhen: (context) => context.hasSession,
    unavailableReason: 'Start or resume a Session before compacting it.',
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.status,
    category: 'Runtime',
    readiness: 'controller',
    preparingHint: 'Loading account status…',
  },
  {
    name: 'tasks',
    description: 'Inspect background agents and Runtime tasks',
    category: 'Runtime',
    discoverability: 'contextual',
    visibleWhen: (context) => context.hasSession,
    unavailableReason: 'Start or resume a Session before opening background tasks.',
  },
  {
    name: 'permission',
    description: 'Choose or inspect the Runtime permission mode',
    category: 'Runtime',
    argumentHint: '[status | ask | auto | full]',
    getArgumentCompletions: argumentCompleter([
      ['status', 'Show the current permission mode'],
      ['ask', 'Use Ask mode'],
      ['auto', 'Use Auto mode'],
      ['full', 'Use Full Access mode'],
    ]),
    shortcut: 'Alt+M',
  },
  {
    name: 'sandbox',
    description: 'Choose or inspect the Runtime sandbox mode',
    category: 'Runtime',
    argumentHint: '[status | read-only | workspace-write | danger-full-access]',
    getArgumentCompletions: argumentCompleter([
      ['status', 'Show the current sandbox mode'],
      ['read-only', SANDBOX_MODE_DESCRIPTIONS['read-only']],
      ['workspace-write', SANDBOX_MODE_DESCRIPTIONS['workspace-write']],
      ['danger-full-access', SANDBOX_MODE_DESCRIPTIONS['danger-full-access']],
    ]),
  },
  {
    name: 'login',
    description: 'Sign in to use MiniMax Code Agent features',
    category: 'Runtime',
    discoverability: 'contextual',
    visibleWhen: (context) => !context.managedTokenPresent,
  },
  {
    name: 'logout',
    description: 'Sign out of the shared Desktop account',
    category: 'Runtime',
    discoverability: 'contextual',
    visibleWhen: (context) => context.managedTokenPresent,
    unavailableReason: 'No managed MiniMax account is signed in.',
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.doctor,
    category: 'Runtime',
    discoverability: 'search-only',
    readiness: 'immediate',
    preparingHint: 'Loading configuration check…',
  },
  {
    name: 'config',
    description: 'Show the effective read-only configuration',
    category: 'Runtime',
    audience: 'internal',
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.context,
    category: 'Runtime',
    discoverability: 'contextual',
    visibleWhen: (context) => context.hasSession,
    unavailableReason: 'Start or resume a Session before viewing context.',
  },
  {
    name: 'steer',
    description: 'Steer current work without interrupting it',
    category: 'Runtime',
    argumentHint: '<message>',
  },
  {
    name: 'feedback',
    description: 'Review and submit redacted product feedback',
    category: 'Application',
    argumentHint: '<message>',
    discoverability: 'search-only',
  },
  {
    name: 'checkin',
    description: 'Claim the daily MiniMax account reward',
    category: 'Application',
    readiness: 'controller',
    preparingHint: 'Checking daily reward…',
  },
  {
    name: 'settings',
    description: 'Configure the MCode terminal interface',
    category: 'Application',
  },
  {
    name: 'statusline',
    description: 'Choose, reorder, and preview status line items',
    category: 'Application',
    readiness: 'immediate',
    visibleWhen: (context) => !context.hasPendingInteraction,
    unavailableReason: 'Finish the pending interaction before configuring the status line.',
  },
  {
    name: 'hotkeys',
    description: 'View and customize TUI keyboard shortcuts',
    category: 'Application',
    runAvailability: 'idle',
    unavailableReason: 'Stop the active Turn before opening TUI keyboard shortcuts.',
  },
  {
    name: 'reload',
    description: 'Reload TUI configuration and Plugins',
    category: 'Application',
    runAvailability: 'idle',
    unavailableReason: 'Stop the active Turn before reloading TUI configuration.',
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.model,
    category: 'Runtime',
    argumentHint: '[filter]',
  },
  {
    name: 'provider',
    description: 'View providers and edit MiniMax credentials',
    category: 'Runtime',
  },
  {
    name: 'plugins',
    description: 'Browse, install, enable, and remove Plugins',
    category: 'Capability',
    argumentHint: '[filter]',
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.skills,
    category: 'Capability',
    argumentHint: '[filter]',
    discoverability: 'search-only',
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.mcp,
    category: 'Capability',
    argumentHint: '[filter|reload]',
    discoverability: 'search-only',
  },
  {
    name: 'add-dir',
    description: 'Add a readable and writable workspace directory',
    category: 'Input',
    argumentHint: '<path>',
    discoverability: 'search-only',
  },
  {
    name: 'decision',
    description: 'Reopen the pending action panel',
    category: 'Decision',
    audience: 'internal',
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.usage,
    category: 'Transcript',
    discoverability: 'contextual',
  },
  {
    ...TUI_COMMAND_DESCRIPTORS.export,
    category: 'Transcript',
    argumentHint: '[path.md]',
    discoverability: 'contextual',
    visibleWhen: (context) => context.hasSession,
    unavailableReason: 'Start or resume a Session before exporting it.',
  },
  {
    name: 'transcript',
    description: 'Browse, search, and inspect the full conversation',
    category: 'Transcript',
    discoverability: 'contextual',
    visibleWhen: (context) => context.hasSession,
    unavailableReason: 'Start or resume a Session before opening the Transcript.',
  },
  {
    name: 'copy',
    description: 'Copy last response as Markdown',
    category: 'Transcript',
    discoverability: 'contextual',
    visibleWhen: (context) => context.hasSession,
    unavailableReason: 'Start or resume a Session before copying a response.',
  },
  {
    name: 'allow',
    description: 'Allow the pending tool once',
    category: 'Decision',
    audience: 'internal',
    inputWhen: (context) => context.hasPendingInteraction === true,
  },
  {
    name: 'always',
    description: 'Always allow this action class',
    category: 'Decision',
    audience: 'internal',
    inputWhen: (context) => context.hasPendingInteraction === true,
  },
  {
    name: 'deny',
    description: 'Deny the pending tool',
    category: 'Decision',
    audience: 'internal',
    inputWhen: (context) => context.hasPendingInteraction === true,
  },
  {
    name: 'permissions',
    description: 'Show pending Runtime-owned permission requests',
    category: 'Decision',
    audience: 'internal',
  },
  {
    name: 'stop',
    description: 'Interrupt the running turn',
    category: 'Application',
    audience: 'internal',
    readiness: 'immediate',
  },
  {
    name: 'queue',
    description: 'Manage messages that run after the current response',
    category: 'Input',
    discoverability: 'contextual',
    visibleWhen: (context) =>
      context.queueEnabled && (context.hasLiveRun || context.queuedCount > 0),
    unavailableReason: 'No messages are waiting and no response is currently running.',
  },
  {
    name: 'quit',
    aliases: ['exit'],
    description: 'Exit Minimax Code',
    category: 'Application',
    readiness: 'immediate',
  },
];

const ACTIVE_RUN_COMMAND_SOURCES: readonly TuiCommandSource[] = [];

export interface TuiCommandCatalog {
  readonly commands: readonly TuiCommand[];
  /** Commands whose local handler will run when the exact input is submitted. */
  readonly inputCommands: readonly TuiCommand[];
  readonly activeRunCommands: readonly TuiCommand[];
  readonly discoverableCommands: readonly TuiCommand[];
  readonly searchableCommands: readonly TuiCommand[];
  readonly slashCommands: readonly SlashCommand[];
  resolve(input: string): TuiCommand | undefined;
  dispatch(input: string): Promise<TuiCommandDispatchResult>;
}

export type TuiCommandDispatchResult =
  | { readonly status: 'unrecognized' }
  | { readonly status: 'unavailable'; readonly reason: string }
  | {
      readonly status: 'handled';
      readonly disposition?: TuiCommandExecutionDisposition;
    };

const EMPTY_COMMAND_CONTEXT: TuiCommandContext = {
  hasSession: false,
  hasParentSession: false,
  managedTokenPresent: false,
  queueEnabled: false,
  hasLiveRun: false,
  queuedCount: 0,
  canRetry: false,
  sideMode: false,
};

export function createTuiCommandCatalog(
  contributions: readonly TuiCommandContribution[] = [],
  handlers: Readonly<Partial<Record<string, TuiCommandHandler>>> = {},
  context: () => TuiCommandContext = () => EMPTY_COMMAND_CONTEXT,
): TuiCommandCatalog {
  const registry = new TuiContributionRegistry<TuiCommandContribution>();
  COMMAND_SOURCES.forEach((source, index) =>
    registry.register({
      id: `core/command/${source.name}`,
      order: index,
      source,
      execute: handlers[source.name],
    }),
  );
  ACTIVE_RUN_COMMAND_SOURCES.forEach((source, index) =>
    registry.register({
      id: `core/active-run/${source.name}`,
      order: index,
      kind: 'active-run',
      source,
      execute: handlers[source.name],
    }),
  );
  registry.registerAll(contributions);
  const registeredContributions = registry.freeze();

  const names = new Set<string>();
  const commands = registeredContributions
    .filter((contribution) => (contribution.kind ?? 'command') === 'command')
    .map((contribution) => materializeCommand(contribution.source, names));
  const activeRunCommands = registeredContributions
    .filter((contribution) => contribution.kind === 'active-run')
    .map((contribution) => materializeCommand(contribution.source, names));
  const inputCommandNames = new Set(
    registeredContributions
      .filter(
        (contribution) =>
          (contribution.kind ?? 'command') === 'command' && Boolean(contribution.execute),
      )
      .map((contribution) => contribution.source.name),
  );
  const resolve = (input: string): TuiCommand | undefined => {
    const invocation = parseCommandInvocation(input, registeredContributions);
    if (!invocation) return undefined;
    return [...commands, ...activeRunCommands].find(
      (command) => command.name === invocation.command.name,
    );
  };
  return {
    commands,
    get inputCommands() {
      const currentContext = context();
      return commands.filter(
        (command) =>
          isTuiCommandAllowedInSideMode(command, currentContext) &&
          (inputCommandNames.has(command.name) || command.inputWhen?.(currentContext) === true),
      );
    },
    activeRunCommands,
    get discoverableCommands() {
      return resolveTuiCommandVisibility(commands, context(), 'default');
    },
    get searchableCommands() {
      return resolveTuiCommandVisibility(commands, context(), 'search');
    },
    get slashCommands() {
      return resolveTuiCommandVisibility(commands, context(), 'default').map(
        ({ name, description, argumentHint, getArgumentCompletions }) => ({
          name,
          description,
          ...(argumentHint ? { argumentHint } : {}),
          ...(getArgumentCompletions ? { getArgumentCompletions } : {}),
        }),
      );
    },
    resolve,
    dispatch: async (input) => {
      const invocation = parseCommandInvocation(input, registeredContributions);
      if (!invocation) return { status: 'unrecognized' };
      const command = commands.find((candidate) => candidate.name === invocation.command.name);
      const currentContext = context();
      const resolvedCommand =
        command ?? materializeCommand(invocation.contribution.source, new Set());
      if (
        resolvedCommand.audience !== 'internal' &&
        !isTuiCommandAllowedInSideMode(resolvedCommand, currentContext)
      ) {
        return {
          status: 'unavailable',
          reason: resolveSideModeUnavailableReason(resolvedCommand),
        };
      }
      if (
        command &&
        command.audience !== 'internal' &&
        !isTuiCommandAvailable(command, currentContext)
      ) {
        return {
          status: 'unavailable',
          reason:
            command.runAvailability === 'idle' && currentContext.hasLiveRun
              ? `Stop the running turn before using ${command.usage}.`
              : (command.unavailableReason ?? `${command.usage} is unavailable right now.`),
        };
      }
      const disposition = await invocation.contribution.execute?.(invocation.command);
      return invocation.contribution.execute
        ? {
            status: 'handled',
            ...(disposition ? { disposition } : {}),
          }
        : { status: 'unrecognized' };
    },
  };
}

function parseCommandInvocation(
  input: string,
  contributions: readonly TuiCommandContribution[],
):
  | {
      command: TuiCommandInvocation;
      contribution: TuiCommandContribution;
    }
  | undefined {
  const match = matchTuiCommandInput(
    input,
    contributions.map(({ source }) => source),
  );
  if (!match) return undefined;
  const contribution = contributions.find(({ source }) => source === match.source);
  if (!contribution) return undefined;
  return {
    contribution,
    command: {
      raw: match.raw,
      name: contribution.source.name,
      args: match.args,
    },
  };
}

/**
 * Parse the slash token and trailing payload once for both execution and live Composer intent.
 * Exact-token commands reject non-whitespace suffixes, so callers cannot visually classify input
 * differently from the command path that will handle Enter.
 */
export function matchTuiCommandInput<TCommand extends TuiCommandInputDescriptor>(
  input: string,
  commands: readonly TCommand[],
): TuiCommandInputMatch<TCommand> | undefined {
  const raw = input.trim();
  const token = raw.split(/\s+/u, 1)[0];
  if (!token || (!token.startsWith('/') && !token.startsWith('@'))) return undefined;
  const requestedName = token.startsWith('/') ? token.slice(1) : token;
  const normalizedName = requestedName.toLocaleLowerCase();
  const source = commands.find((command) =>
    [command.name, ...(command.aliases ?? [])].some(
      (name) => name.toLocaleLowerCase() === normalizedName,
    ),
  );
  if (!source) return undefined;
  const args = raw.slice(token.length).trim();
  if (args && !source.argumentHint) return undefined;
  return { source, raw, token, args };
}

function materializeCommand(source: TuiCommandSource, names: Set<string>): TuiCommand {
  const normalizedNames = [source.name, ...(source.aliases ?? [])].map((name) =>
    name.toLocaleLowerCase(),
  );
  for (const name of normalizedNames) {
    if (names.has(name)) throw new Error(`Duplicate command name or alias: ${name}`);
    names.add(name);
  }
  const usage = `/${source.name}${source.argumentHint ? ` ${source.argumentHint}` : ''}`;
  return {
    ...source,
    usage,
    composerTemplate: `/${source.name}${source.argumentHint ? ' ' : ''}`,
  };
}

export function isTuiCommandDiscoverable(command: TuiCommand): boolean {
  return command.audience !== 'internal';
}

export function resolveTuiCommandVisibility(
  commands: readonly TuiCommand[],
  context: TuiCommandContext,
  mode: 'default' | 'search',
): TuiCommand[] {
  return commands.filter((command) => {
    if (!isTuiCommandDiscoverable(command)) return false;
    if (!isTuiCommandAvailable(command, context)) return false;
    return mode === 'search' || command.discoverability !== 'search-only';
  });
}

/** Side mode restricts the surface to the read-only whitelist at every layer. */
export function isTuiCommandAllowedInSideMode(
  command: TuiCommand,
  context: TuiCommandContext,
): boolean {
  if (!context.sideMode) return true;
  return SIDE_MODE_READ_ONLY_COMMANDS.has(command.name.toLocaleLowerCase());
}

/** Mirrors Codex's side-conversation copy so a rejected command explains the exit path. */
export function resolveSideModeUnavailableReason(
  command: Pick<TuiCommand, 'name' | 'usage'>,
): string {
  if (command.name.toLocaleLowerCase() === 'rename') {
    return 'Side conversations are ephemeral and cannot be renamed.';
  }
  return `${command.usage} is unavailable in side conversations. Press Ctrl+C to return to the main session first.`;
}

export function isTuiCommandAvailable(command: TuiCommand, context: TuiCommandContext): boolean {
  if (!isTuiCommandAllowedInSideMode(command, context)) return false;
  if (command.runAvailability === 'idle' && context.hasLiveRun) return false;
  return command.visibleWhen?.(context) ?? true;
}

const DEFAULT_COMMAND_CATALOG = createTuiCommandCatalog();

export const MINIMAX_CODE_COMMANDS: readonly TuiCommand[] = DEFAULT_COMMAND_CATALOG.commands;
export const MINIMAX_CODE_ACTIVE_RUN_COMMANDS: readonly TuiCommand[] =
  DEFAULT_COMMAND_CATALOG.activeRunCommands;
export const MINIMAX_CODE_DISCOVERABLE_COMMANDS: readonly TuiCommand[] =
  DEFAULT_COMMAND_CATALOG.discoverableCommands;

export function formatTuiCommandUsage(command: TuiCommand): string {
  const aliases = command.aliases?.join(', ');
  return aliases ? `${command.usage} (${aliases})` : command.usage;
}

export function filterTuiCommands(
  commands: readonly TuiCommand[],
  query: string,
  context: TuiCommandContext = EMPTY_COMMAND_CONTEXT,
): TuiCommand[] {
  const tokens = query
    .trim()
    .replace(/^\/+/u, '')
    .toLocaleLowerCase()
    .split(/\s+/u)
    .filter(Boolean);
  const discoverableCommands = resolveTuiCommandVisibility(
    commands,
    context,
    tokens.length === 0 ? 'default' : 'search',
  );
  const firstToken = tokens[0];
  const slashQuery = /^\/+/u.test(query.trim());
  const directNameMatches =
    tokens.length === 1 && firstToken
      ? discoverableCommands.filter((command) =>
          [command.name, ...(command.aliases ?? [])].some((name) =>
            name.toLocaleLowerCase().startsWith(firstToken),
          ),
        )
      : [];
  if (directNameMatches.length > 0) return directNameMatches;
  if (slashQuery && tokens.length === 1) return [];
  if (tokens.length === 0) return [...discoverableCommands];

  return discoverableCommands.filter((command) => {
    const searchable = [
      command.name,
      ...(command.aliases ?? []),
      command.usage,
      command.description,
      command.category,
      command.shortcut,
    ]
      .filter(Boolean)
      .join(' ')
      .toLocaleLowerCase();
    return tokens.every((token) => searchable.includes(token));
  });
}

function argumentCompleter(
  choices: readonly (readonly [value: string, description: string])[],
): NonNullable<SlashCommand['getArgumentCompletions']> {
  const items = choices.map(([value, description]) => ({ value, label: value, description }));
  return (prefix) => {
    const query = prefix.trimStart();
    if (/\s/u.test(query)) return null;
    return fuzzyFilter(items, query, (item) => item.value);
  };
}
