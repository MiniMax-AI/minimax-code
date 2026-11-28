export const EN_RUNTIME_TRANSLATIONS = {
  'plan.entry.title': 'Enter Plan Mode',
  'plan.entry.question': 'Enter Plan Mode for this task?',
  'plan.entry.confirm.label': 'Confirm',
  'plan.entry.confirm.description': 'Investigate and prepare a plan before implementation.',
  'plan.entry.decline.label': 'Decline',
  'plan.entry.decline.description': 'Continue without entering Plan Mode.',
  'plan.implementation.display': 'Implement this plan',
  'questionnaire.noAnswer': 'No answer',
  'questionnaire.others': 'Others',
  'nestedRuntime.deleteGuard':
    'Deletion protection is enabled for this agent session (sandbox filesystem mode "delete_guard"), so MiniMax Code cannot be started inside it. A nested Runtime could create lock and ownership files outside the workspace but would be unable to remove them, leaving stale locks that block later launches. This nested run was stopped before it created any Runtime state. Run MiniMax Code from a terminal outside this agent session.',
  'update.versionedInstalled':
    'MCode {version} is installed. New MCode sessions will use it; running sessions can continue normally.',
} as const;

export type RuntimeTranslationKey = keyof typeof EN_RUNTIME_TRANSLATIONS;
export type RuntimeTranslations = Readonly<Record<RuntimeTranslationKey, string>>;
