/** Cron task name used for the daemon-managed memory cleanup automation. */
export const MEMORY_CLEANUP_CRON_NAME = 'memory-cleanup';

/** Stable prefix for sessions created by cron-like background automations. */
export const CRON_SESSION_PURPOSE_PREFIX = 'cron:';

/** Build a machine-readable purpose for sessions spawned by a cron-like task. */
export function createCronSessionPurpose(agentName: string, cronName: string): string {
  return `${CRON_SESSION_PURPOSE_PREFIX}${agentName}:${cronName}`;
}

/** Format the user-visible title for a Cron-created session. */
export function formatCronRunTitle(cronName: string, _input?: number | Date): string {
  return cronName;
}

/** Parse `cron:<agentName>:<cronName>` purpose values written into session metadata. */
export function parseCronSessionPurpose(
  purpose: string | undefined,
): { agentName: string; cronName: string } | null {
  if (!purpose?.startsWith(CRON_SESSION_PURPOSE_PREFIX)) return null;
  const parts = purpose.slice(CRON_SESSION_PURPOSE_PREFIX.length).split(':');
  if (parts.length < 2) return null;
  const [agentName, ...rest] = parts;
  const cronName = rest.join(':');
  return agentName && cronName ? { agentName, cronName } : null;
}

/** Legacy memory-cleanup sessions predate machine-readable cron purpose metadata. */
export function isLegacyMemoryCleanupTitle(title: string | undefined): boolean {
  return /^Memory cleanup \d{4}-\d{2}-\d{2}$/.test(title ?? '');
}

/** Self-reminders use a dedicated Cron ID format; ordinary Cron definitions use UUIDs. */
export function isSelfReminderId(cronId: string | undefined): boolean {
  return /^self-[a-f0-9]{32}$/.test(cronId ?? '');
}

export const SELF_REMINDER_NAME_PREFIX = '@self-reminder/';

export function isSelfReminderName(cronName: string | undefined): boolean {
  return (cronName ?? '').trim().toLowerCase().startsWith(SELF_REMINDER_NAME_PREFIX);
}

export function formatSelfReminderName(reminderId: string): string {
  return `Task follow-up (${reminderId.slice(-8)})`;
}
