import { getConfig, type TelemetryConfig } from './config.js';

export type TelemetryChannel = keyof TelemetryConfig;

const TELEMETRY_OPT_OUT_ENV = ['MCODE_DISABLE_TELEMETRY', 'DO_NOT_TRACK'] as const;

/**
 * True only when the channel is explicitly opted in and no global opt-out is set.
 * An unreadable config never authorizes an upload.
 */
export function isTelemetryChannelEnabled(
  channel: TelemetryChannel,
  readConfigured: () => boolean | undefined = () => getConfig().telemetry[channel],
): boolean {
  for (const key of TELEMETRY_OPT_OUT_ENV) {
    if (/^(?:1|true|yes|on)$/iu.test(process.env[key]?.trim() ?? '')) return false;
  }
  try {
    return readConfigured() === true;
  } catch {
    return false;
  }
}
