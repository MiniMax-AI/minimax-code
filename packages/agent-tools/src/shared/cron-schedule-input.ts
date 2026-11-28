/** 适配器解析 `after`/`at`、`every` 输入时使用的稳定校验错误。 */
export class LocalMavisCronValidationError extends Error {
  readonly status = 400;
  readonly statusCode = 400;
  readonly code = 'CRON_VALIDATION_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'LocalMavisCronValidationError';
  }
}

/**
 * `cron_create` 创建入口的保留值：为任务建立专用会话，后续执行持续复用。
 *
 * 它只出现在工具创建入参里。运行时把它翻译成「尚未绑定真实 ID」的 pending
 * 目标，由桌面或云端在首次执行时创建并绑定专用会话；禁止拿它查询会话、
 * 作为真实目标 ID 持久化，或传入要求真实 ID 的请求。
 */
export const CRON_FIXED_SESSION_ID = 'fixed';

/** 大小写、首尾空格与 `me` 保持一致的处理方式，避免同一输入在两端分裂。 */
export function isCronFixedSessionId(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === CRON_FIXED_SESSION_ID;
}

/**
 * 创建入口中「任务自己的对话」的唯一判定：显式 `fixed` 或省略 `session_id`。
 *
 * 参数校验与 handler 必须共用这一处，否则共享工具定义广告的省略形态会被 schema
 * 挡掉，而 handler 里为它准备的分支永远不可达。
 */
export function isCronDedicatedSessionTarget(
  session: { mode?: string; session_id?: string } | undefined,
): boolean {
  return (
    session?.mode === 'sessionId' &&
    (session.session_id === undefined || isCronFixedSessionId(session.session_id))
  );
}

export function isMeSessionSentinel(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'me';
}

/**
 * 创建入口的旧别名说明。`fixed` 承担「任务自己的对话」，`me` 只属于
 * `self_reminder` 代表的当前工作跟进。
 */
export const CRON_CREATE_ME_REJECTED_MESSAGE =
  'session.session_id "me" is not accepted when creating a scheduled task. ' +
  'Use session_id "fixed" to give the task its own conversation that every run reuses, ' +
  'or pass a real session ID to bind an existing conversation. ' +
  'Use self_reminder for follow-up on the current conversation.';

// Desktop 与 Cloud 共用时间和间隔解析，保持输入语义一致。

const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * 解析 `cron once` 请求的绝对运行时间，单位为 Unix ms。`after` 相对时长与
 * `at` 绝对时间必须且只能提供一个，结果必须严格晚于当前时间。
 */
export function parseOnceRunAtMs(
  req: { after?: string; at?: string | number; timezone?: string },
  now: number,
): number {
  const hasAfter = typeof req.after === 'string' && req.after.trim().length > 0;
  const hasAt = req.at !== undefined && String(req.at).trim().length > 0;
  if (hasAfter === hasAt) {
    throw new LocalMavisCronValidationError('cron once requires exactly one of `after` or `at`');
  }
  const runAtMs = hasAfter ? now + parseDurationMs(req.after!) : parseAtMs(req.at!, req.timezone);
  if (!Number.isFinite(runAtMs) || runAtMs <= now) {
    throw new LocalMavisCronValidationError('cron once target time must be in the future');
  }
  return runAtMs;
}

function parseAtMs(input: string | number, timezone: string | undefined): number {
  if (typeof input === 'number') {
    if (timezone) validateTimeZone(timezone);
    return input;
  }
  const raw = input.trim();
  if (timezone) validateTimeZone(timezone);
  if (/^\d+$/.test(raw)) return Number(raw);

  const wallClock = parseWallClockWithoutOffset(raw);
  if (timezone && wallClock) return zonedWallClockToEpochMs(wallClock, timezone);

  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(raw)
    ? raw.replace(' ', 'T')
    : raw;
  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    throw new LocalMavisCronValidationError(`Invalid cron once at time: ${JSON.stringify(input)}`);
  }
  return parsed;
}

type WallClockParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function parseWallClockWithoutOffset(input: string): WallClockParts | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(input);
  if (!match) return undefined;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: match[6] ? Number(match[6]) : 0,
  };
}

function validateTimeZone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new LocalMavisCronValidationError(
      `Invalid cron once timezone: ${JSON.stringify(timezone)}`,
    );
  }
}

function zonedWallClockToEpochMs(parts: WallClockParts, timezone: string): number {
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let utcMs = localAsUtc - getTimeZoneOffsetMs(timezone, localAsUtc);
  utcMs = localAsUtc - getTimeZoneOffsetMs(timezone, utcMs);

  const resolved = getWallClockParts(timezone, utcMs);
  if (
    resolved.year !== parts.year ||
    resolved.month !== parts.month ||
    resolved.day !== parts.day ||
    resolved.hour !== parts.hour ||
    resolved.minute !== parts.minute ||
    resolved.second !== parts.second
  ) {
    throw new LocalMavisCronValidationError(
      `Invalid cron once at time for timezone ${timezone}: nonexistent wall-clock time`,
    );
  }

  return utcMs;
}

function getTimeZoneOffsetMs(timezone: string, utcMs: number): number {
  const parts = getWallClockParts(timezone, utcMs);
  const zonedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return zonedAsUtc - utcMs;
}

function getWallClockParts(timezone: string, utcMs: number): WallClockParts {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const value = (type: Intl.DateTimeFormatPartTypes) => {
    const part = formatted.find((item) => item.type === type)?.value;
    if (!part) throw new Error(`Missing ${type} while formatting timezone ${timezone}`);
    return Number(part);
  };
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

function parseDurationMs(input: string): number {
  const raw = input.trim().toLowerCase();
  // Consume one anchored `<number><unit>` token at a time: a start-anchored pattern cannot be
  // retried from every offset, so long digit runs fail in linear rather than quadratic time.
  // `ms` must precede `m` so millisecond tokens are not split into minutes plus a stray `s`.
  const token = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/;
  let total = 0;
  let rest = raw;
  while (rest) {
    const match = token.exec(rest);
    if (!match) break;
    const amount = Number(match[1]);
    const unit = match[2]!;
    total += amount * DURATION_UNIT_MS[unit]!;
    rest = rest.slice(match[0].length);
  }
  if (!total || rest) {
    throw new LocalMavisCronValidationError(
      `Invalid cron once after duration: ${JSON.stringify(input)}`,
    );
  }
  return Math.floor(total);
}

/**
 * 把 `cron self` 的 `every` 间隔转换为五段式 Cron 表达式。支持紧凑时长
 * `30s`、`5m`、`1h30m`、`2d12h`、`1w`，五段或六段 Cron 表达式则原样透传。
 */
export function everyToCronExpression(every: string): string {
  const raw = every.trim().toLowerCase();
  if (!raw) {
    throw new LocalMavisCronValidationError(
      'cron self `every` is empty; try "5m" or a cron expression',
    );
  }
  if (/\s/.test(raw)) {
    const parts = raw.split(/\s+/);
    if (parts.length < 5 || parts.length > 6) {
      throw new LocalMavisCronValidationError(
        `cannot parse cron self interval ${JSON.stringify(every)}: expected a duration like "5m" or a 5-field cron expression`,
      );
    }
    return raw;
  }

  const seconds = parseIntervalSeconds(raw, every);
  return intervalSecondsToCron(seconds, every);
}

function parseIntervalSeconds(raw: string, original: string): number {
  const re = /(\d+(?:\.\d+)?)(s|m|h|d|w)/g;
  let total = 0;
  let consumed = '';
  for (const match of raw.matchAll(re)) {
    const amount = Number(match[1]);
    const unit = match[2]!;
    consumed += match[0];
    total += amount * (DURATION_UNIT_MS[unit]! / 1000);
  }
  if (!total || consumed !== raw) {
    throw new LocalMavisCronValidationError(
      `cannot parse cron self interval ${JSON.stringify(original)}: expected a duration like "5m" or a cron expression`,
    );
  }
  return Math.floor(total);
}

function intervalSecondsToCron(seconds: number, original: string): string {
  if (seconds < 60) {
    throw new LocalMavisCronValidationError(
      `cron self interval ${JSON.stringify(original)} is below the 1-minute minimum; use a cron expression for sub-minute cadences`,
    );
  }
  const minutes = Math.round(seconds / 60);
  // 五段式 Cron 的步长字段 `*/N` 要求 N 位于字段范围内：分钟 0-59、小时 0-23、
  // 月内日 1-31。90m、150m、60d 这类间隔无法用单一步长准确表达；
  // `*/90 * * * *` 在 croner 中属于语法错误，含义也不是“每 90 分钟”。
  // 此处明确拒绝并提示调用方使用完整表达式，避免生成无效模式。
  if (minutes < 60) return `*/${minutes} * * * *`;
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    if (hours < 24) return `0 */${hours} * * *`;
    if (hours % 24 === 0) {
      const days = hours / 24;
      if (days <= 31) return `0 0 */${days} * *`;
    }
  }
  throw new LocalMavisCronValidationError(
    `cron self interval ${JSON.stringify(original)} has no faithful cron form; use a whole number of minutes (<60), hours (<24), or days (<=31), or pass an explicit cron expression`,
  );
}

export function appendQuietOnSkipPromptSuffix(basePrompt: string, quietOnSkip: boolean): string {
  if (!quietOnSkip) return basePrompt;
  return [
    basePrompt.trimEnd(),
    '',
    '---',
    '[gate-discipline] If your guard condition is not met (CI still running, MR not merged, no new evidence), wrap a one-line status in `<mavis-progress>...</mavis-progress>` and exit. The progress tag lets the user glance at "still waiting" without lighting up an unread notification. Do NOT send IMs and do NOT write plain replies on skip ticks.',
  ].join('\n');
}
