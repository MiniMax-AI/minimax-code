import {
  McodeUpdateService,
  resolveMcodeInstallRoot,
  type McodeUpdateApplyResult,
  type McodeUpdateCheckResult,
  type McodeUpdateRequest,
} from './service.js';
import {
  buildMcodePackageManagerCommand,
  bindMcodeNpmCommandToRuntime,
  createMcodeNpmRuntimeEnvironment,
  detectMcodeInstallSource,
  resolveMcodeNpmDistribution,
  resolveMcodeNpmDistTag,
  resolveMcodeNpmPrefixInstall,
  resolveInstalledMcodePackageVersion,
  resolveLatestMcodeRegistryVersion,
  runMcodePackageManagerCommand,
  type McodeInstallSource,
  type McodeNpmDistTag,
  type McodeNpmDistribution,
  type McodeNpmPackageName,
  type McodeNpmPrefixInstall,
  type McodePackageManagerCommand,
  type McodePackageManagerInstallSource,
  type McodePackageManagerRunOptions,
} from './install-source.js';
import { compareMcodeVersions } from './release.js';
import { reportMcodeUpdatePhase } from './progress.js';
import {
  mcodePrefixNonPrefixPlanMessage,
  mcodePrefixNotStagedMessage,
  mcodePrefixOwnershipMissingMessage,
  mcodePrefixPendingActivationMessage,
  mcodePrefixPendingCleanupMessage,
  mcodePrefixVersionedInstalledMessage,
  mcodePrefixStagedVersionMismatchMessage,
} from './messages.js';
import {
  countMcodePrefixUpdateBlockers,
  inspectPendingMcodePrefixUpdate,
  readMcodePrefixPackageMetadata,
  removeMcodePrefixUpdateStaging,
  validateMcodePrefixPackage,
  type McodePrefixPackageMetadata,
} from './prefix-update.js';
import {
  acquireMcodeVersionedPrefixUpdateLock,
  activateMcodeVersionedPrefixInstall,
  createMcodeVersionedPrefixStagingPrefix,
  prepareMcodeVersionedPrefixStaging,
  type McodeVersionedPrefixActivation,
} from './versioned-prefix.js';

interface ManagedUpdateService {
  check(request?: McodeUpdateRequest): Promise<McodeUpdateCheckResult>;
  apply(request?: McodeUpdateRequest): Promise<McodeUpdateApplyResult>;
}

interface McodeManagedUpdatePlan {
  readonly source: 'managed-installer';
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly channel: 'stable' | 'preview';
}

interface McodePackageManagerVersionPlan {
  readonly source: McodePackageManagerInstallSource;
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly packageTag: McodeNpmDistTag;
}

export type McodeUpdatePlan =
  | (McodeManagedUpdatePlan & { readonly kind: 'current' })
  | (McodeManagedUpdatePlan & { readonly kind: 'ahead' })
  | (McodeManagedUpdatePlan & { readonly kind: 'available' })
  | (McodePackageManagerVersionPlan & { readonly kind: 'current' })
  | (McodePackageManagerVersionPlan & { readonly kind: 'ahead' })
  | {
      readonly kind: 'package-manager';
      readonly source: McodePackageManagerInstallSource;
      readonly currentVersion: string;
      readonly latestVersion: string;
      readonly packageTag: McodeNpmDistTag;
      readonly command: McodePackageManagerCommand;
    }
  | {
      readonly kind: 'manual';
      readonly source: 'unsupported';
      readonly currentVersion: string;
      readonly command: string;
    };

export interface McodeUpdateOutcome {
  readonly applied: boolean;
  readonly message: string;
  readonly restartRequired?: boolean;
}

export type McodeUpdateApplyOptions = McodePackageManagerRunOptions;

export interface McodeUpdateApplicationOptions {
  readonly currentVersion: string;
  readonly installRoot?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly packageTag?: McodeNpmDistTag;
  readonly packageName?: McodeNpmPackageName;
  readonly prefixInstall?: McodeNpmPrefixInstall;
  readonly entryFile?: string;
  readonly runtimeExecutable?: string;
}

export interface McodeUpdateApplicationDependencies {
  readonly detectInstallSource: () => Promise<McodeInstallSource>;
  readonly createManagedService: () => ManagedUpdateService;
  readonly resolveLatestPackageVersion: (tag: McodeNpmDistTag) => Promise<string>;
  readonly runPackageManager: (
    command: McodePackageManagerCommand,
    options?: McodePackageManagerRunOptions,
  ) => Promise<void>;
  readonly readInstalledPackageVersion: () => string | undefined;
  readonly readPrefixPackageMetadata: (
    prefix: string,
    packageName: McodeNpmPackageName,
  ) => McodePrefixPackageMetadata;
  readonly validatePrefixPackage: (
    prefix: string,
    metadata: McodePrefixPackageMetadata,
    expectedVersion: string,
  ) => Promise<void>;
  readonly countPrefixUpdateBlockers: (activePrefix: string) => number | undefined;
  readonly removePrefixStaging: (stagingPrefix: string) => void;
  readonly createVersionedPrefixStaging: (prefix: string, version: string) => string;
  readonly prepareVersionedPrefixStaging: (stagingPrefix: string) => void;
  readonly activateVersionedPrefix: (activation: McodeVersionedPrefixActivation) => string;
  readonly acquirePrefixUpdateLock: (activePrefix: string) => () => void;
}

export class McodeUpdateApplication {
  private readonly currentVersion: string;
  private readonly packageTag: McodeNpmDistTag;
  private readonly distribution: McodeNpmDistribution;
  private readonly platform: NodeJS.Platform;
  private readonly prefixInstall?: McodeNpmPrefixInstall;
  private readonly entryFile?: string;
  private readonly runtimeExecutable: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly dependencies: McodeUpdateApplicationDependencies;

  constructor(
    options: McodeUpdateApplicationOptions,
    dependencies: Partial<McodeUpdateApplicationDependencies> = {},
  ) {
    this.currentVersion = options.currentVersion;
    const environment = options.environment ?? process.env;
    const installRoot = options.installRoot ?? resolveMcodeInstallRoot(environment);
    const platform = options.platform ?? process.platform;
    this.platform = platform;
    this.environment = environment;
    this.entryFile = options.entryFile ?? process.argv[1];
    this.prefixInstall =
      options.prefixInstall ?? resolveMcodeNpmPrefixInstall(this.entryFile, platform);
    // Keep updates on the Node executable recorded in the install receipt. On
    // macOS process.execPath resolves Homebrew's stable bin/node symlink into a
    // versioned Cellar path that `brew upgrade` removes.
    this.runtimeExecutable =
      options.runtimeExecutable ?? this.prefixInstall?.nodeExecutable ?? process.execPath;
    const packageManagerEnvironment = this.prefixInstall
      ? createMcodeNpmRuntimeEnvironment(environment, this.runtimeExecutable, platform)
      : environment;
    this.packageTag = options.packageTag ?? resolveMcodeNpmDistTag();
    this.distribution = resolveMcodeNpmDistribution(
      options.packageName,
      this.prefixInstall?.registry,
    );
    this.dependencies = {
      detectInstallSource:
        dependencies.detectInstallSource ??
        (() =>
          detectMcodeInstallSource({
            installRoot,
            platform,
            prefixInstall: () => this.prefixInstall,
          })),
      createManagedService:
        dependencies.createManagedService ??
        (() =>
          new McodeUpdateService({
            currentVersion: options.currentVersion,
            installRoot,
            environment,
          })),
      resolveLatestPackageVersion:
        dependencies.resolveLatestPackageVersion ??
        ((tag) =>
          resolveLatestMcodeRegistryVersion(tag, {
            platform,
            distribution: this.distribution,
            environment: packageManagerEnvironment,
            ...(this.prefixInstall
              ? {
                  npmExecutable: this.prefixInstall.executable,
                  runtimeExecutable: this.runtimeExecutable,
                }
              : {}),
          })),
      runPackageManager:
        dependencies.runPackageManager ??
        ((command, progress) =>
          runMcodePackageManagerCommand(
            this.prefixInstall
              ? bindMcodeNpmCommandToRuntime(command, this.runtimeExecutable)
              : command,
            packageManagerEnvironment,
            progress,
          )),
      readInstalledPackageVersion:
        dependencies.readInstalledPackageVersion ?? resolveInstalledMcodePackageVersion,
      readPrefixPackageMetadata:
        dependencies.readPrefixPackageMetadata ??
        ((prefix, packageName) => readMcodePrefixPackageMetadata(prefix, packageName, platform)),
      validatePrefixPackage:
        dependencies.validatePrefixPackage ??
        ((prefix, metadata, expectedVersion) =>
          validateMcodePrefixPackage(prefix, metadata, this.runtimeExecutable, expectedVersion)),
      countPrefixUpdateBlockers:
        dependencies.countPrefixUpdateBlockers ?? countMcodePrefixUpdateBlockers,
      removePrefixStaging: dependencies.removePrefixStaging ?? removeMcodePrefixUpdateStaging,
      createVersionedPrefixStaging:
        dependencies.createVersionedPrefixStaging ??
        ((prefix, version) => createMcodeVersionedPrefixStagingPrefix(prefix, version, platform)),
      prepareVersionedPrefixStaging:
        dependencies.prepareVersionedPrefixStaging ?? prepareMcodeVersionedPrefixStaging,
      activateVersionedPrefix:
        dependencies.activateVersionedPrefix ??
        ((activation) => activateMcodeVersionedPrefixInstall(activation, platform)),
      acquirePrefixUpdateLock:
        dependencies.acquirePrefixUpdateLock ?? acquireMcodeVersionedPrefixUpdateLock,
    };
  }

  async inspect(): Promise<McodeUpdatePlan> {
    const source = await this.dependencies.detectInstallSource();
    if (source === 'managed-installer') {
      const result = await this.dependencies.createManagedService().check();
      return {
        kind: result.status,
        source,
        currentVersion: result.currentVersion,
        latestVersion: result.latestVersion,
        channel: result.channel,
      };
    }
    if (source === 'unsupported') {
      return {
        kind: 'manual',
        source,
        currentVersion: this.currentVersion,
        command: buildMcodePackageManagerCommand(
          'npm-global',
          this.packageTag,
          this.platform,
          this.distribution,
        ).display,
      };
    }
    const pendingUpdate =
      source === 'npm-prefix' ? inspectPendingMcodePrefixUpdate(this.entryFile) : undefined;
    if (pendingUpdate) {
      const latestVersion = pendingUpdate.activation.expectedVersion;
      return {
        kind: 'package-manager',
        source,
        currentVersion: this.currentVersion,
        latestVersion,
        packageTag: this.packageTag,
        command: buildMcodePackageManagerCommand(
          source,
          latestVersion,
          this.platform,
          this.distribution,
          this.prefixInstall,
        ),
      };
    }
    const latestVersion = await this.dependencies.resolveLatestPackageVersion(this.packageTag);
    const comparison = compareMcodeVersions(this.currentVersion, latestVersion);
    const followsRollingTag = this.packageTag !== 'latest';
    if (comparison === 0) {
      return {
        kind: 'current',
        source,
        currentVersion: this.currentVersion,
        latestVersion,
        packageTag: this.packageTag,
      };
    }
    if (comparison > 0 && !followsRollingTag) {
      return {
        kind: 'ahead',
        source,
        currentVersion: this.currentVersion,
        latestVersion,
        packageTag: this.packageTag,
      };
    }
    return {
      kind: 'package-manager',
      source,
      currentVersion: this.currentVersion,
      latestVersion,
      packageTag: this.packageTag,
      command: buildMcodePackageManagerCommand(
        source,
        latestVersion,
        this.platform,
        this.distribution,
        this.prefixInstall,
      ),
    };
  }

  async apply(
    plan: McodeUpdatePlan,
    options: McodeUpdateApplyOptions = {},
  ): Promise<McodeUpdateOutcome> {
    if (plan.kind === 'manual' || plan.kind === 'current' || plan.kind === 'ahead') {
      throw new Error(`MCode update plan ${plan.kind} cannot be applied automatically.`);
    }
    if (plan.kind === 'available') {
      const result = await this.dependencies.createManagedService().apply({
        channel: plan.channel,
        version: plan.latestVersion,
        ...options,
      });
      return result.applied
        ? {
            applied: true,
            message:
              `MCode ${result.latestVersion} is installed. ` +
              'Restart running MCode sessions to use it.',
          }
        : {
            applied: false,
            message: `MCode ${result.currentVersion} is already active.`,
          };
    }

    if (plan.source === 'npm-prefix') {
      return this.applyNpmPrefixUpdate(plan, options);
    }

    reportMcodeUpdatePhase(options, 'installing', false);
    await this.dependencies.runPackageManager(plan.command, options);
    const installedVersion = this.dependencies.readInstalledPackageVersion();
    if (installedVersion !== plan.latestVersion) {
      throw new Error(
        `MCode update installed ${installedVersion || '<unknown>'}; expected ${plan.latestVersion}.`,
      );
    }
    reportMcodeUpdatePhase(options, 'completed', false);
    return {
      applied: true,
      message:
        `MCode ${plan.latestVersion} was installed through ${packageManagerName(plan.source)}. ` +
        'Restart MCode to use the installed version.',
    };
  }

  private async applyNpmPrefixUpdate(
    plan: Extract<McodeUpdatePlan, { kind: 'package-manager' }>,
    options: McodeUpdateApplyOptions,
  ): Promise<McodeUpdateOutcome> {
    if (plan.source !== 'npm-prefix') {
      throw new Error(mcodePrefixNonPrefixPlanMessage(this.environment));
    }
    const prefixInstall = this.prefixInstall;
    if (!prefixInstall) {
      throw new Error(mcodePrefixOwnershipMissingMessage(this.environment));
    }
    const pendingUpdate = inspectPendingMcodePrefixUpdate(this.entryFile);
    if (pendingUpdate) {
      const blockingSessionCount = this.dependencies.countPrefixUpdateBlockers(
        pendingUpdate.activation.activePrefix,
      );
      return {
        applied: false,
        restartRequired: true,
        message:
          pendingUpdate.state === 'activated'
            ? mcodePrefixPendingCleanupMessage(pendingUpdate.activation.expectedVersion, {
                blockingSessionCount,
                environment: this.environment,
              })
            : mcodePrefixPendingActivationMessage(pendingUpdate.activation.expectedVersion, {
                blockingSessionCount,
                environment: this.environment,
              }),
      };
    }
    const releaseLock = this.dependencies.acquirePrefixUpdateLock(prefixInstall.prefix);
    let stagingPrefix: string | undefined;
    try {
      stagingPrefix = this.dependencies.createVersionedPrefixStaging(
        prefixInstall.prefix,
        plan.latestVersion,
      );
      const stagedCommand = buildMcodePackageManagerCommand(
        'npm-prefix',
        plan.latestVersion,
        this.platform,
        this.distribution,
        { ...prefixInstall, prefix: stagingPrefix },
      );
      reportMcodeUpdatePhase(options, 'staging', true);
      this.dependencies.prepareVersionedPrefixStaging(stagingPrefix);
      reportMcodeUpdatePhase(options, 'installing', false);
      await this.dependencies.runPackageManager(stagedCommand, options);
      reportMcodeUpdatePhase(options, 'validating', false);
      const stagedPackage = this.dependencies.readPrefixPackageMetadata(
        stagingPrefix,
        prefixInstall.packageName,
      );
      if (stagedPackage.version !== plan.latestVersion) {
        throw new Error(
          mcodePrefixStagedVersionMismatchMessage(
            stagedPackage.version,
            plan.latestVersion,
            this.environment,
          ),
        );
      }
      await this.dependencies.validatePrefixPackage(
        stagingPrefix,
        stagedPackage,
        plan.latestVersion,
      );
      reportMcodeUpdatePhase(options, 'activating', false);
      this.dependencies.activateVersionedPrefix({
        stagingPrefix,
        activePrefix: prefixInstall.prefix,
        packageName: prefixInstall.packageName,
        expectedVersion: plan.latestVersion,
        runtimeExecutable: this.runtimeExecutable,
        npmExecutable: prefixInstall.executable,
        registry: prefixInstall.registry,
      });
      reportMcodeUpdatePhase(options, 'completed', false);
      return {
        applied: true,
        restartRequired: false,
        message: mcodePrefixVersionedInstalledMessage(plan.latestVersion, this.environment),
      };
    } catch (error) {
      if (stagingPrefix) this.dependencies.removePrefixStaging(stagingPrefix);
      throw new Error(
        mcodePrefixNotStagedMessage(plan.latestVersion, errorMessage(error), this.environment),
        { cause: error },
      );
    } finally {
      releaseLock();
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function packageManagerName(source: McodePackageManagerInstallSource): string {
  if (source === 'npm-prefix') return 'npm';
  return source.replace('-global', '');
}
