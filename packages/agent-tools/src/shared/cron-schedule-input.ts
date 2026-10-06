/** Stable validation error used when the adapter parses `after`/`at` and `every` inputs. */
export class LocalMavisCronValidationError extends Error {
  readonly status = 400;
  readonly statusCode = 400;
  readonly code = 'CRON_VALIDATION_ERROR';

  constructor(message: string) {
    super(message);
    this.name = 'LocalMavisCronValidationError';
  }
}

// Desktop and Cloud share time and interval parsing to keep input semantics consistent.

const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Resolve the absolute run time of `cron once` in Unix milliseconds. Exactly one of relative
 * `after` or absolute `at` is required, and the result must be strictly later than now.
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
 * Convert the `cron self` interval `every` to a five-field Cron expression. Supports compact
 * durations `30s`, `5m`, `1h30m`, `2d12h`, and `1w`; five- or six-field Cron expressions pass
 * through unchanged.
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
  // Five-field Cron step values `*/N` must fit the field range: minutes 0–59, hours 0–23,
  // day of month 1–31. Intervals such as 90m, 150m, or 60d cannot be expressed accurately by one step;
  // `*/90 * * * *` is invalid in croner and does not mean "every 90 minutes".
  // Reject explicitly and ask callers for a full expression rather than generating invalid patterns.
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
