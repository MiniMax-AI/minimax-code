import { randomUUID } from 'node:crypto';
import type { MavisBuildEnv, MavisRegion } from '@mavis/config';

export type McodeChatType = 'chat' | 'agent_team' | 'claw' | 'hermes' | 'IM';
export type McodeLoginSource =
  | 'agent_web'
  | 'agent_desktop'
  | 'openplatform'
  | 'mcode_tui'
  | 'mcode_cli';
export type McodeLoginFailReason = '' | '1' | '2' | '3' | '4' | '5';
export type McodeSlashCommandType =
  | 'skill'
  | 'new_chat'
  | 'summarize'
  | 'plan_mode'
  | 'goal_mode'
  | 'other';
export type McodeAtCommandType = 'plugins' | 'goal_mode' | 'plan_mode' | 'file' | 'directory';
export type McodeDurationBucket =
  'not_applicable' | 'under_1m' | '1m_to_5m' | '5m_to_30m' | 'over_30m';

interface ChatContextProperties {
  readonly chat_type: McodeChatType;
}

export interface McodeBusinessEventMap {
  readonly tui_launch: { readonly launch_type: 'cold' | 'hot' };
  readonly login_click: Record<string, never>;
  readonly logout_click: Record<string, never>;
  readonly login_result: {
    readonly source: McodeLoginSource;
    readonly result_type: '1' | '2';
    readonly fail_reason: McodeLoginFailReason;
    readonly login_type: 'google' | 'mobile' | 'wechat' | 'apple' | 'minimax_sso' | 'minimax_oauth';
  };
  readonly btw_session_lifecycle: {
    readonly phase: 'opened' | 'closed';
    readonly duration_bucket: McodeDurationBucket;
    readonly exit_reason: '' | 'ctrl_c' | 'ctrl_d' | 'navigation' | 'replaced';
  };
  /**
   * TUI-only metric, in the shape Desktop used before it moved to the
   * `prompt_suggestion_*` events. The text is never reported.
   */
  readonly prompt_suggestion: {
    readonly session_id: string;
    readonly turn_id: string;
    readonly prompt_version: string;
    readonly elapsed_ms: number;
    readonly action: 'shown' | 'accepted' | 'sent';
    readonly edited?: boolean;
  };
  readonly chat_send: ChatContextProperties & {
    readonly is_first_message: 0 | 1;
    readonly is_attachment: 'text' | 'attachment';
  };
  readonly slash_command_menu_view: ChatContextProperties;
  readonly slash_command_click: ChatContextProperties & {
    readonly command_type: McodeSlashCommandType;
  };
  readonly at_command_menu_view: ChatContextProperties;
  readonly at_command_click: ChatContextProperties & {
    readonly command_type: McodeAtCommandType;
  };
}

export type McodeBusinessEventName = keyof McodeBusinessEventMap;
export type McodeBusinessEvent = {
  [Event in McodeBusinessEventName]: {
    readonly event: Event;
    readonly properties: McodeBusinessEventMap[Event];
  };
}[McodeBusinessEventName];

export interface McodeBusinessTelemetry {
  track<Event extends McodeBusinessEventName>(
    event: Event,
    properties: McodeBusinessEventMap[Event],
  ): void;
  flush(): Promise<void>;
}

export interface CreateMcodeBusinessTelemetryOptions {
  readonly region: MavisRegion;
  readonly buildEnv: MavisBuildEnv;
  readonly version: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly randomId?: () => string;
  readonly queueLimit?: number;
  readonly timeoutMs?: number;
}

export interface McodeTelemetryPolicy {
  readonly enabled: boolean;
  readonly configured: boolean;
  readonly blockedBy?: 'MCODE_DISABLE_TELEMETRY' | 'DO_NOT_TRACK';
}

export interface McodeBusinessTelemetryPreview {
  readonly endpoint: string;
  readonly method: 'POST';
  readonly contentType: 'application/x-www-form-urlencoded';
  readonly payload: SensorsPayload;
}

export interface SensorsPayload {
  readonly identities: { readonly $identity_cookie_id: string };
  readonly distinct_id: string;
  readonly lib: {
    readonly $lib: 'js';
    readonly $lib_method: 'code';
    readonly $lib_version: string;
  };
  readonly properties: Record<string, unknown>;
  readonly type: 'track';
  readonly event: McodeBusinessEventName;
  readonly time: number;
}

const DEFAULT_QUEUE_LIMIT = 100;
const EVENT_PROPERTY_KEYS = {
  tui_launch: ['launch_type'],
  login_click: [],
  logout_click: [],
  login_result: ['source', 'result_type', 'fail_reason', 'login_type'],
  btw_session_lifecycle: ['phase', 'duration_bucket', 'exit_reason'],
  prompt_suggestion: [
    'session_id',
    'turn_id',
    'prompt_version',
    'elapsed_ms',
    'action',
    'edited',
  ],
  chat_send: ['chat_type', 'is_first_message', 'is_attachment'],
  slash_command_menu_view: ['chat_type'],
  slash_command_click: ['chat_type', 'command_type'],
  at_command_menu_view: ['chat_type'],
  at_command_click: ['chat_type', 'command_type'],
} as const satisfies {
  [Event in McodeBusinessEventName]: readonly Extract<keyof McodeBusinessEventMap[Event], string>[];
};

export function resolveMcodeBusinessTelemetryPolicy(options: {
  readonly configEnabled?: boolean;
  readonly environment?: NodeJS.ProcessEnv;
}): McodeTelemetryPolicy {
  const environment = options.environment ?? process.env;
  const configured = options.configEnabled === true;
  if (isEnabledEnvironmentFlag(environment.MCODE_DISABLE_TELEMETRY)) {
    return { enabled: false, configured, blockedBy: 'MCODE_DISABLE_TELEMETRY' };
  }
  if (isEnabledEnvironmentFlag(environment.DO_NOT_TRACK)) {
    return { enabled: false, configured, blockedBy: 'DO_NOT_TRACK' };
  }
  return { enabled: configured, configured };
}

export function createMcodeBusinessTelemetry(
  options: CreateMcodeBusinessTelemetryOptions,
): McodeBusinessTelemetry {
  const fetchImpl = options.fetch ?? fetch;
  const endpoint = resolveMcodeBusinessTelemetryEndpoint(options.region, options.buildEnv);
  const queueLimit = Math.max(1, options.queueLimit ?? DEFAULT_QUEUE_LIMIT);
  const queue: McodeBusinessEvent[] = [];
  let drainPromise: Promise<void> | undefined;
  let drainScheduled = false;

  const drain = async (): Promise<void> => {
    drainScheduled = false;
    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) continue;
      try {
        const payload = createSensorsPayload(item, options);
        await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: encodeSensorsRequest(payload),
          signal: AbortSignal.timeout(options.timeoutMs ?? 3_000),
        });
      } catch {
        // Usage reporting must never affect the product flow.
      }
    }
  };

  const scheduleDrain = (): void => {
    if (drainScheduled || drainPromise) return;
    drainScheduled = true;
    queueMicrotask(() => {
      if (!drainScheduled || drainPromise) return;
      drainPromise = drain().finally(() => {
        drainPromise = undefined;
        if (queue.length > 0) scheduleDrain();
      });
    });
  };

  return {
    track(event, properties) {
      if (queue.length >= queueLimit) queue.shift();
      queue.push({ event, properties } as McodeBusinessEvent);
      scheduleDrain();
    },
    async flush() {
      drainScheduled = false;
      if (drainPromise) await drainPromise;
      if (queue.length > 0) await drain();
    },
  };
}

export function createMcodeBusinessTelemetryPreview<Event extends McodeBusinessEventName>(
  event: Event,
  properties: McodeBusinessEventMap[Event],
  options: CreateMcodeBusinessTelemetryOptions,
): McodeBusinessTelemetryPreview {
  return {
    endpoint: resolveMcodeBusinessTelemetryEndpoint(options.region, options.buildEnv),
    method: 'POST',
    contentType: 'application/x-www-form-urlencoded',
    payload: createSensorsPayload({ event, properties } as McodeBusinessEvent, options),
  };
}

export function bucketMcodeDuration(durationMs: number): McodeDurationBucket {
  if (durationMs < 60_000) return 'under_1m';
  if (durationMs < 5 * 60_000) return '1m_to_5m';
  if (durationMs < 30 * 60_000) return '5m_to_30m';
  return 'over_30m';
}

function createSensorsPayload(
  item: McodeBusinessEvent,
  options: CreateMcodeBusinessTelemetryOptions,
): SensorsPayload {
  const eventProperties = selectEventProperties(item);
  // A fresh ID satisfies the receiver's envelope without linking separate events.
  const eventId = (options.randomId ?? randomUUID)();
  return {
    identities: { $identity_cookie_id: eventId },
    distinct_id: eventId,
    lib: { $lib: 'js', $lib_method: 'code', $lib_version: options.version },
    properties: {
      surface: 'tui',
      os: process.platform,
      region: options.region,
      build_env: options.buildEnv,
      app_version: options.version,
      ...eventProperties,
    },
    type: 'track',
    event: item.event,
    time: (options.now ?? Date.now)(),
  };
}

function selectEventProperties(item: McodeBusinessEvent): Record<string, string | number> {
  const selected: Record<string, string | number> = {};
  const properties = item.properties as Record<string, string | number>;
  for (const key of EVENT_PROPERTY_KEYS[item.event]) selected[key] = properties[key]!;
  return selected;
}

export function resolveMcodeBusinessTelemetryEndpoint(
  region: MavisRegion,
  buildEnv: MavisBuildEnv,
): string {
  if (region === 'en') {
    return buildEnv === 'prod'
      ? 'https://data.hailuo.ai/meerkat-reporter/api/report?project=MiniMaxAgent'
      : 'https://bigdata-test.talkie-ai.com/meerkat-reporter/api/report?project=MiniMaxAgent';
  }
  return buildEnv === 'prod'
    ? 'https://data.hailuoai.com/meerkat-reporter/api/report?project=MiniMaxAgent'
    : 'https://bigdata-test.xingyeai.com/meerkat-reporter/api/report?project=MiniMaxAgent';
}

function isEnabledEnvironmentFlag(value: string | undefined): boolean {
  return /^(?:1|true|yes|on)$/iu.test(value?.trim() ?? '');
}

function encodeSensorsRequest(payload: SensorsPayload): string {
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  return new URLSearchParams({ data, ext: `crc=${javaStringHash(data)}` }).toString();
}

function javaStringHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash &= hash;
  }
  return hash;
}
