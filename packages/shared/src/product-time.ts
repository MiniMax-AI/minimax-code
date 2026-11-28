const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const FOUR_DAYS_MS = 4 * DAY_MS;
const RECENT_CALENDAR_DAYS = 7;

const EN_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const EN_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
const ZH_WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const;

const DEFAULT_TIME_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
})();

const formatterCache = new Map<string, Intl.DateTimeFormat>();

export type ProductTimePreset =
  | 'social-precise'
  | 'social-compact'
  | 'message-divider'
  | 'community-relative'
  | 'task-relative'
  | 'common-precise'
  | 'common-date'
  | 'audit-datetime'
  | 'audit-date'
  | 'share-version-date'
  | 'subscription-date';

export interface ProductTimeOptions {
  preset: ProductTimePreset;
  /** Runtime locale. Chinese locales use Chinese date labels; others use English rules. */
  locale?: string;
  /** Injectable clock for deterministic rendering and tests. Defaults to Date.now(). */
  nowMs?: number;
  /** IANA timezone used for calendar boundaries. Defaults to the user's local timezone. */
  timeZone?: string;
}

type ProductTimeLocale = 'en' | 'zh';

interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

function getZonedDateParts(timestampMs: number, timeZone: string): ZonedDateParts {
  const values: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of getFormatter(timeZone).formatToParts(timestampMs)) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
  };
}

function resolveLocale(locale?: string): ProductTimeLocale {
  return (locale ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function padTwo(value: number): string {
  return String(value).padStart(2, '0');
}

function formatTime(parts: ZonedDateParts): string {
  return `${padTwo(parts.hour)}:${padTwo(parts.minute)}`;
}

function isSameDay(left: ZonedDateParts, right: ZonedDateParts): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

function formatDate(
  parts: ZonedDateParts,
  locale: ProductTimeLocale,
  includeYear: boolean,
): string {
  const month = padTwo(parts.month);
  const day = padTwo(parts.day);
  if (!includeYear) return locale === 'zh' ? `${month}-${day}` : `${month}/${day}`;
  return locale === 'zh' ? `${parts.year}-${month}-${day}` : `${month}/${day}/${parts.year}`;
}

function formatDateTime(
  parts: ZonedDateParts,
  locale: ProductTimeLocale,
  includeYear: boolean,
): string {
  return `${formatDate(parts, locale, includeYear)} ${formatTime(parts)}`;
}

function calendarDayIndex(parts: ZonedDateParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS;
}

function formatWeekday(parts: ZonedDateParts, locale: ProductTimeLocale): string {
  const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
  const labels = locale === 'zh' ? ZH_WEEKDAYS : EN_WEEKDAYS;
  return labels[weekday] ?? labels[0];
}

function formatSocialTime(
  timestampMs: number,
  nowMs: number,
  timestamp: ZonedDateParts,
  now: ZonedDateParts,
  locale: ProductTimeLocale,
  precise: boolean,
): string {
  const sameYear = timestamp.year === now.year;
  if (timestampMs > nowMs) {
    return precise
      ? formatDateTime(timestamp, locale, !sameYear)
      : formatDate(timestamp, locale, !sameYear);
  }

  const elapsedMs = nowMs - timestampMs;
  if (elapsedMs < MINUTE_MS) return locale === 'zh' ? '刚刚' : 'Now';
  if (isSameDay(timestamp, now)) return formatTime(timestamp);

  const dayDelta = calendarDayIndex(now) - calendarDayIndex(timestamp);
  if (dayDelta === 1) {
    const yesterday = locale === 'zh' ? '昨天' : 'Yesterday';
    return `${yesterday} ${formatTime(timestamp)}`;
  }
  if (dayDelta > 1 && dayDelta < RECENT_CALENDAR_DAYS) {
    const weekday = formatWeekday(timestamp, locale);
    return precise ? `${weekday} ${formatTime(timestamp)}` : weekday;
  }

  return precise
    ? formatDateTime(timestamp, locale, !sameYear)
    : formatDate(timestamp, locale, !sameYear);
}

function formatCommunityTime(
  timestampMs: number,
  nowMs: number,
  timestamp: ZonedDateParts,
  now: ZonedDateParts,
  locale: ProductTimeLocale,
): string {
  const sameYear = timestamp.year === now.year;
  if (timestampMs > nowMs) return formatDate(timestamp, locale, !sameYear);

  const elapsedMs = nowMs - timestampMs;
  if (elapsedMs < MINUTE_MS) return locale === 'zh' ? '刚刚' : 'Now';
  if (elapsedMs < HOUR_MS) {
    const minutes = Math.floor(elapsedMs / MINUTE_MS);
    return locale === 'zh' ? `${minutes}分钟前` : `${minutes}m`;
  }
  if (elapsedMs < DAY_MS) {
    const hours = Math.floor(elapsedMs / HOUR_MS);
    return locale === 'zh' ? `${hours}小时前` : `${hours}h`;
  }
  if (elapsedMs < FOUR_DAYS_MS) {
    const days = Math.floor(elapsedMs / DAY_MS);
    return locale === 'zh' ? `${days}天前` : `${days}d`;
  }

  return formatDate(timestamp, locale, !sameYear);
}

function formatTaskTime(
  timestampMs: number,
  nowMs: number,
  timestamp: ZonedDateParts,
  now: ZonedDateParts,
  locale: ProductTimeLocale,
): string {
  if (timestampMs > nowMs) return formatDate(timestamp, locale, timestamp.year !== now.year);

  const elapsedMs = nowMs - timestampMs;
  if (elapsedMs < MINUTE_MS) return locale === 'zh' ? '刚刚' : 'Now';
  if (elapsedMs < HOUR_MS) {
    const minutes = Math.floor(elapsedMs / MINUTE_MS);
    return locale === 'zh' ? `${minutes}分钟前` : `${minutes}m ago`;
  }
  if (elapsedMs < DAY_MS) {
    const hours = Math.floor(elapsedMs / HOUR_MS);
    return locale === 'zh' ? `${hours}小时前` : `${hours}h ago`;
  }

  const days = Math.floor(elapsedMs / DAY_MS);
  if (days < 7) return locale === 'zh' ? `${days}天前` : `${days}d ago`;
  if (days < 30) {
    const weeks = Math.floor(days / 7);
    return locale === 'zh' ? `${weeks}周前` : `${weeks}w ago`;
  }
  if (days < 365) {
    const months = Math.floor(days / 30);
    return locale === 'zh' ? `${months}个月前` : `${months}mo ago`;
  }
  const years = Math.floor(days / 365);
  return locale === 'zh' ? `${years}年前` : `${years}y ago`;
}

/**
 * Project-wide UI timestamp calculator.
 *
 * Input must be Unix milliseconds. Choose a semantic preset instead of assembling date patterns
 * at a call site. See `.harness/docs/design/time-display.md` for preset selection and exclusions.
 */
export function formatProductTime(
  timestampMs: number | null | undefined,
  options: ProductTimeOptions,
): string {
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) return '';

  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) return '';

  const locale = resolveLocale(options.locale);
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const timestamp = getZonedDateParts(timestampMs, timeZone);
  const now = getZonedDateParts(nowMs, timeZone);
  const sameYear = timestamp.year === now.year;

  switch (options.preset) {
    case 'social-precise':
      return formatSocialTime(timestampMs, nowMs, timestamp, now, locale, true);
    case 'social-compact':
      return formatSocialTime(timestampMs, nowMs, timestamp, now, locale, false);
    case 'message-divider': {
      // A divider is rendered once and stays, so it never uses "Now" or weekday-only dates.
      if (isSameDay(timestamp, now)) {
        return formatTime(timestamp);
      }
      if (calendarDayIndex(now) - calendarDayIndex(timestamp) === 1) {
        const yesterday = locale === 'zh' ? '昨天' : 'Yesterday';
        return `${yesterday} ${formatTime(timestamp)}`;
      }
      return formatDateTime(timestamp, locale, !sameYear);
    }
    case 'community-relative':
      return formatCommunityTime(timestampMs, nowMs, timestamp, now, locale);
    case 'task-relative':
      return formatTaskTime(timestampMs, nowMs, timestamp, now, locale);
    case 'common-precise':
      return isSameDay(timestamp, now)
        ? formatTime(timestamp)
        : formatDateTime(timestamp, locale, !sameYear);
    case 'common-date':
      return isSameDay(timestamp, now)
        ? formatTime(timestamp)
        : formatDate(timestamp, locale, !sameYear);
    case 'audit-datetime':
      return formatDateTime(timestamp, locale, true);
    case 'share-version-date':
      return `${String(timestamp.year).slice(-2)}.${String(timestamp.month).padStart(2, '0')}.${String(timestamp.day).padStart(2, '0')}`;
    case 'audit-date':
      return formatDate(timestamp, locale, true);
    case 'subscription-date':
      return locale === 'zh'
        ? `${timestamp.year}年${timestamp.month}月${timestamp.day}日`
        : `${EN_MONTHS[timestamp.month - 1]} ${timestamp.day}, ${timestamp.year}`;
  }
}
