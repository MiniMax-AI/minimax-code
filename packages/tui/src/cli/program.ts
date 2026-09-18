import { Command, InvalidArgumentError } from 'commander';
import type { MavisRegion } from '@mavis/config';
import { TuiContributionRegistry } from '../contributions/index.js';
import type { RawTuiExecOptions } from '../headless/invocation.js';
import {
  applyExecCliContract,
  applyExecReviewCliContract,
  applyInteractiveCliContract,
  resolveInteractiveLaunchRequest,
  type RawTuiInteractiveOptions,
  type TuiInteractiveLaunchRequest,
} from './contract.js';
import type { McodeProviderCliRequest } from './provider-command.js';
import {
  isModelProviderApiFormat,
  MCODE_PROVIDER_API_FORMATS,
  type McodeProviderApiFormat,
} from '../provider/contract.js';
import type { McodePluginCliRequest, McodePluginMarketplace } from '../plugin/contract.js';
import { resolveTuiManagedBackendLane } from './environment.js';
import type { McodeTelemetryCliAction } from './telemetry-command.js';

export type { TuiInteractiveLaunchRequest } from './contract.js';

export interface TuiCliCommandContribution {
  readonly id: string;
  readonly order?: number;
  readonly name: string;
  readonly register: (program: Command, options: CreateTuiProgramOptions) => void;
}

export interface CreateTuiProgramOptions {
  version: string;
  launchTui: (request: TuiInteractiveLaunchRequest) => Promise<void>;
  runExec: (
    prompt: string | undefined,
    commandOptions: RawTuiExecOptions,
    lane?: string,
  ) => Promise<void>;
  runAcp?: (lane?: string) => Promise<void>;
  runLogin: (region?: MavisRegion, openBrowser?: boolean, lane?: string) => Promise<void>;
  runLogout: (region?: MavisRegion) => Promise<void>;
  runUpdate: () => Promise<void>;
  runProvider?: (request: McodeProviderCliRequest, lane?: string) => Promise<void>;
  runPlugin?: (request: McodePluginCliRequest, lane?: string) => Promise<void>;
  runTelemetry?: (action: McodeTelemetryCliAction) => Promise<void>;
  resolveLane?: typeof resolveTuiManagedBackendLane;
  allowStartupEnvironmentSelection?: boolean;
  commandContributions?: readonly TuiCliCommandContribution[];
}

export function createTuiProgram(options: CreateTuiProgramOptions): Command {
  let activeLane: string | undefined;
  const withLane = <T extends object>(request: T): T & { lane?: string } => ({
    ...request,
    ...(activeLane ? { lane: activeLane } : {}),
  });
  const runProvider = (request: McodeProviderCliRequest) =>
    activeLane
      ? requireProviderRunner(options)(request, activeLane)
      : requireProviderRunner(options)(request);
  const runPlugin = (request: McodePluginCliRequest) =>
    activeLane
      ? requirePluginRunner(options)(request, activeLane)
      : requirePluginRunner(options)(request);
  const program = applyInteractiveCliContract(
    new Command()
      .name('mcode')
      .description('Minimax Code — terminal coding agent')
      .version(options.version)
      .enablePositionalOptions(),
    { allowStartupEnvironmentSelection: options.allowStartupEnvironmentSelection },
  ).action((prompt: string | undefined, commandOptions: RawTuiInteractiveOptions) =>
    options.launchTui(withLane(resolveInteractiveLaunchRequest(prompt, commandOptions))),
  );

  program.hook('preAction', () => {
    activeLane = (options.resolveLane ?? resolveTuiManagedBackendLane)(
      program.opts<{ lane?: string }>().lane,
    );
  });

  program
    .command('init')
    .description('Analyze the codebase and generate AGENTS.md with the Runtime init Skill')
    .argument('[directory]', 'project directory', '.')
    .action((directory: string) =>
      options.launchTui(withLane({ initialPrompt: '/init', workspaceDir: directory })),
    );

  const exec = program.command('exec').description('Run one prompt without starting the TUI');
  applyExecCliContract(exec).action(
    (prompt: string | undefined, commandOptions: RawTuiExecOptions) =>
      activeLane
        ? options.runExec(prompt, commandOptions, activeLane)
        : options.runExec(prompt, commandOptions),
  );
  applyExecReviewCliContract(
    exec.command('review').description('Review staged, unstaged, and untracked local changes'),
  ).action((_commandOptions: RawTuiExecOptions, command: Command) => {
    const reviewOptions = resolveExecReviewOptions(exec, command);
    return activeLane
      ? options.runExec(undefined, reviewOptions, activeLane)
      : options.runExec(undefined, reviewOptions);
  });

  const acp = program
    .command('acp')
    .description('Run MiniMax Code as an Agent Client Protocol server over stdio')
    .allowExcessArguments(false)
    .action(() =>
      activeLane ? requireAcpRunner(options)(activeLane) : requireAcpRunner(options)(),
    );

  acp
    .command('login')
    .description('Sign in to use MiniMax Code Agent features')
    .option('--region <region>', 'account region: cn or global', parseLoginRegion)
    .option('--no-browser', 'print the authorization URL without opening a browser')
    .allowExcessArguments(false)
    .action((commandOptions: { region?: MavisRegion; browser?: boolean }) =>
      activeLane
        ? options.runLogin(commandOptions.region, commandOptions.browser !== false, activeLane)
        : options.runLogin(commandOptions.region, commandOptions.browser !== false),
    );

  program
    .command('login')
    .description('Sign in to use MiniMax Code Agent features')
    .option('--region <region>', 'account region: cn or global', parseLoginRegion)
    .option('--no-browser', 'print the authorization URL without opening a browser')
    .allowExcessArguments(false)
    .action((commandOptions: { region?: MavisRegion; browser?: boolean }) =>
      activeLane
        ? options.runLogin(commandOptions.region, commandOptions.browser !== false, activeLane)
        : options.runLogin(commandOptions.region, commandOptions.browser !== false),
    );

  program
    .command('logout')
    .description('Sign out of the MiniMax account used by this CLI')
    .option('--region <region>', 'account region: cn or global', parseLoginRegion)
    .allowExcessArguments(false)
    .action((commandOptions: { region?: MavisRegion }) => options.runLogout(commandOptions.region));

  program
    .command('update')
    .description('Check for and install a Minimax Code update')
    .allowExcessArguments(false)
    .action(options.runUpdate);

  const telemetry = program
    .command('telemetry')
    .description('Inspect anonymous TUI usage reporting');

  telemetry
    .command('status')
    .description('Show whether usage reporting is enabled and why')
    .allowExcessArguments(false)
    .action(() => requireTelemetryRunner(options)('status'));

  telemetry
    .command('preview')
    .description('Show a representative decoded request without sending it')
    .allowExcessArguments(false)
    .action(() => requireTelemetryRunner(options)('preview'));

  const provider = program
    .command('provider')
    .description('Manage model providers and API keys')
    .allowExcessArguments(false)
    .action(() => options.launchTui(withLane({ initialPrompt: '/provider' })));

  provider
    .command('list')
    .description('List configured providers')
    .option('--json', 'print a JSON document')
    .action((commandOptions: { json?: boolean }) =>
      runProvider({ action: 'list', json: commandOptions.json }),
    );

  provider
    .command('add')
    .description('Add a custom provider')
    .requiredOption('--name <name>', 'provider display name')
    .requiredOption('--base-url <url>', 'provider API base URL')
    .option(
      '--api-format <format>',
      MCODE_PROVIDER_API_FORMATS.join(', '),
      parseApiFormat,
      'anthropic-messages',
    )
    .option('--model <id>', 'model ID (repeatable)', collectOptionValue, [])
    .option('--api-key-env <name>', 'environment variable containing the API key')
    .option('--context-limit <tokens>', 'context limit for every listed model', parsePositiveSafeInteger)
    .option('--output-limit <tokens>', 'output limit for every listed model', parsePositiveSafeInteger)
    .option('--use', 'test the first model, then save and select it as the default')
    .action(
      (commandOptions: {
        name: string;
        baseUrl: string;
        apiFormat: McodeProviderApiFormat;
        model: string[];
        contextLimit?: number;
        outputLimit?: number;
        apiKeyEnv?: string;
        use?: boolean;
      }) => {
        if (commandOptions.model.length === 0) {
          throw new Error('At least one --model <id> is required.');
        }
        return runProvider({
          action: 'add',
          name: commandOptions.name,
          baseUrl: commandOptions.baseUrl,
          apiFormat: commandOptions.apiFormat,
          models: commandOptions.model,
          contextLimit: commandOptions.contextLimit,
          outputLimit: commandOptions.outputLimit,
          apiKeyEnv: commandOptions.apiKeyEnv,
          saveAndUse: commandOptions.use,
        });
      },
    );

  provider
    .command('remove')
    .description('Remove a custom provider')
    .argument('<provider-id>', 'custom_provider:<id>')
    .option('--yes', 'confirm removal')
    .action((providerId: string, commandOptions: { yes?: boolean }) =>
      runProvider({
        action: 'remove',
        providerId,
        confirmed: Boolean(commandOptions.yes),
      }),
    );

  provider
    .command('test')
    .description('Test a provider or one configured model')
    .argument('<provider-id>', 'provider id')
    .option('--model <id>', 'test one model')
    .option('--json', 'print a JSON document')
    .action((providerId: string, commandOptions: { model?: string; json?: boolean }) =>
      runProvider({
        action: 'test',
        providerId,
        modelId: commandOptions.model,
        json: commandOptions.json,
      }),
    );

  provider
    .command('use')
    .description('Choose the MiniMax credential source')
    .argument('<source>', 'token-plan or api-key', parseProviderSource)
    .action((source: 'token_plan' | 'minimax_api_key') => runProvider({ action: 'use', source }));

  provider
    .command('set-minimax-key')
    .description('Save and use a MiniMax API key')
    .option('--api-key-env <name>', 'environment variable containing the API key')
    .action((commandOptions: { apiKeyEnv?: string }) =>
      runProvider({
        action: 'set-minimax-key',
        apiKeyEnv: commandOptions.apiKeyEnv,
      }),
    );

  const plugin = program
    .command('plugin')
    .description('Manage MiniMax Code Plugins')
    .allowExcessArguments(false)
    .action(() => options.launchTui(withLane({ initialPrompt: '/plugins' })));

  plugin
    .command('list')
    .description('List installed or available Plugins')
    .option('-m, --marketplace <marketplace>', 'official or local', parsePluginMarketplace)
    .option('--available', 'include uninstalled Plugins')
    .option('--json', 'print a JSON document')
    .action(
      (commandOptions: {
        marketplace?: McodePluginMarketplace;
        available?: boolean;
        json?: boolean;
      }) =>
        runPlugin({
          action: 'list',
          marketplace: commandOptions.marketplace,
          available: commandOptions.available,
          json: commandOptions.json,
        }),
    );

  for (const action of ['add', 'remove', 'enable', 'disable'] as const) {
    plugin
      .command(action)
      .description(`${pluginActionLabel(action)} a Plugin`)
      .argument('<plugin[@marketplace]>', 'Plugin selector')
      .option('-m, --marketplace <marketplace>', 'official or local', parsePluginMarketplace)
      .option('--json', 'print a JSON document')
      .action(
        (
          selector: string,
          commandOptions: { marketplace?: McodePluginMarketplace; json?: boolean },
        ) =>
          runPlugin({
            action,
            selector,
            marketplace: commandOptions.marketplace,
            json: commandOptions.json,
          }),
      );
  }

  const marketplace = plugin
    .command('marketplace')
    .description('List or refresh MiniMax Code Plugin sources');

  marketplace
    .command('list')
    .description('List Plugin sources')
    .option('--json', 'print a JSON document')
    .action((commandOptions: { json?: boolean }) =>
      runPlugin({ action: 'marketplace-list', json: commandOptions.json }),
    );

  marketplace
    .command('upgrade')
    .description('Refresh all Plugin source snapshots')
    .option('--json', 'print a JSON document')
    .action((commandOptions: { json?: boolean }) =>
      runPlugin({
        action: 'marketplace-upgrade',
        json: commandOptions.json,
      }),
    );

  const contributionRegistry = new TuiContributionRegistry<TuiCliCommandContribution>();
  contributionRegistry.registerAll(options.commandContributions ?? []);
  for (const contribution of contributionRegistry.freeze()) {
    if (program.commands.some((command) => command.name() === contribution.name)) {
      throw new Error(`Duplicate CLI command name: ${contribution.name}`);
    }
    contribution.register(program, options);
  }

  return program;
}

function resolveExecReviewOptions(exec: Command, review: Command): RawTuiExecOptions {
  const options: RawTuiExecOptions = { ...review.opts<RawTuiExecOptions>(), review: true };
  const supportedOptions = new Set(review.options.map((option) => option.attributeName()));
  for (const option of exec.options) {
    const name = option.attributeName();
    if (exec.getOptionValueSource(name) !== 'cli') continue;
    if (!supportedOptions.has(name)) {
      review.error(`error: option '${option.long}' is not supported by 'exec review'`, {
        code: 'commander.unknownOption',
      });
    }
    // Child defaults must not mask explicit parent options, especially permissions.
    if (review.getOptionValueSource(name) !== 'cli') {
      Object.assign(options, { [name]: exec.getOptionValue(name) });
    }
  }
  return options;
}

function collectOptionValue(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseLoginRegion(value: string): MavisRegion {
  if (value === 'cn') return 'cn';
  if (value === 'global') return 'en';
  throw new InvalidArgumentError('expected "cn" or "global"');
}

function parseApiFormat(value: string): McodeProviderApiFormat {
  if (isModelProviderApiFormat(value)) return value;
  throw new InvalidArgumentError(`expected one of: ${MCODE_PROVIDER_API_FORMATS.join(', ')}`);
}

function parseProviderSource(value: string): 'token_plan' | 'minimax_api_key' {
  if (value === 'token-plan') return 'token_plan';
  if (value === 'api-key') return 'minimax_api_key';
  throw new InvalidArgumentError('expected "token-plan" or "api-key"');
}

function parsePluginMarketplace(value: string): McodePluginMarketplace {
  const normalized = value.trim().toLocaleLowerCase();
  if (normalized === 'official' || normalized === 'local') return normalized;
  throw new InvalidArgumentError('expected "official" or "local"');
}

function pluginActionLabel(action: 'add' | 'remove' | 'enable' | 'disable'): string {
  if (action === 'add') return 'Install';
  if (action === 'remove') return 'Uninstall';
  return action === 'enable' ? 'Enable' : 'Disable';
}

function requireProviderRunner(options: CreateTuiProgramOptions) {
  if (!options.runProvider) throw new Error('Provider management is unavailable.');
  return options.runProvider;
}

function requirePluginRunner(options: CreateTuiProgramOptions) {
  if (!options.runPlugin) throw new Error('Plugin management is unavailable.');
  return options.runPlugin;
}

function requireAcpRunner(options: CreateTuiProgramOptions) {
  if (!options.runAcp) throw new Error('ACP server is unavailable.');
  return options.runAcp;
}

function requireTelemetryRunner(options: CreateTuiProgramOptions) {
  if (!options.runTelemetry) throw new Error('Telemetry inspection is unavailable.');
  return options.runTelemetry;
}

function parsePositiveSafeInteger(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new InvalidArgumentError('expected a positive safe integer');
  }
  return number;
}
