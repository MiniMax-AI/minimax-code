import { getConfig, getConfigPath, type Config } from '@mavis/config';
import {
  createMcodeBusinessTelemetryPreview,
  resolveMcodeBusinessTelemetryPolicy,
} from '../analytics/business-telemetry.js';
import { resolveMcodeAuthEnvironment, type McodeAuthEnvironment } from '../auth/environment.js';

export type McodeTelemetryCliAction = 'status' | 'preview';

export interface RunMcodeTelemetryCommandDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly readConfig?: () => Pick<Config, 'telemetry'>;
  readonly readConfigPath?: () => string;
  readonly resolveEnvironment?: (environment: NodeJS.ProcessEnv) => McodeAuthEnvironment;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

export function runMcodeTelemetryCommand(
  action: McodeTelemetryCliAction,
  version: string,
  dependencies: RunMcodeTelemetryCommandDependencies = {},
): string {
  const environment = dependencies.environment ?? process.env;
  const config = (dependencies.readConfig ?? getConfig)();
  const channel = (configEnabled: boolean | undefined) =>
    resolveMcodeBusinessTelemetryPolicy({ configEnabled, environment });
  const policy = channel(config.telemetry.enabled);
  const status = {
    enabled: policy.enabled,
    configured: policy.configured,
    blockedBy: policy.blockedBy ?? null,
    configFile: (dependencies.readConfigPath ?? getConfigPath)(),
    channels: {
      usage: policy,
      metrics: channel(config.telemetry.metrics),
      diagnostics: channel(config.telemetry.diagnostics),
    },
    optInSetting: { telemetry: { enabled: true, metrics: true, diagnostics: true } },
    optOutEnvironment: ['MCODE_DISABLE_TELEMETRY=1', 'DO_NOT_TRACK=1'],
  };
  if (action === 'status') return `${JSON.stringify(status, null, 2)}\n`;
  if (!policy.enabled) {
    return `${JSON.stringify(
      {
        ...status,
        request: null,
        message: 'Usage telemetry is disabled. No business telemetry request will be sent.',
      },
      null,
      2,
    )}\n`;
  }

  const scope = (dependencies.resolveEnvironment ?? defaultResolveEnvironment)(environment);
  return `${JSON.stringify(
    {
      ...status,
      request: createMcodeBusinessTelemetryPreview(
        'tui_launch',
        { launch_type: 'cold' },
        {
          ...scope,
          version,
          now: dependencies.now,
          randomId: dependencies.randomId,
        },
      ),
    },
    null,
    2,
  )}\n`;
}

function defaultResolveEnvironment(environment: NodeJS.ProcessEnv): McodeAuthEnvironment {
  return resolveMcodeAuthEnvironment({
    runtimeRegion: environment.MAVIS_REGION === 'en' ? 'en' : 'cn',
  });
}
