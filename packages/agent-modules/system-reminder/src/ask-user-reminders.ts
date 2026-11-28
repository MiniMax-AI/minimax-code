/**
 * AskUser model-visible reminders: the `<ask-user-policy>` declaration (all
 * models) and the `<ask-user-guidance>` block (managed models only).
 *
 * Both are injected into the Turn's user-message prefix and therefore persist
 * in conversation history; every later request re-sends them. So instead of
 * re-injecting each Turn, the host passes the runtime-owned text of earlier user
 * messages and we inject only when history does not already carry the needed
 * block. This also self-heals after summary compaction (`llm_checkpoint`), which
 * drops every injected block, and after process restarts, which would reset any
 * in-memory Turn counter.
 *
 * Detection matches the complete runtime-rendered block text, never a tag-name
 * substring: a user quoting `<ask-user-policy>` in chat must not be mistaken for
 * a runtime declaration. The host narrows the scanned text further to the
 * runtime-owned prefix of each user message.
 *
 * Pure module: no IO, no logging. Every decision carries a stable reason code so
 * the host can log why a block was (not) injected.
 */

/**
 * `goal-skip` is the `skip` setting inside an active Goal: there a question
 * waits up to 60 seconds and then the runtime selects the recommended options,
 * so the plain `skip` text ("never waits ... returns immediately") would be
 * wrong. It is its own declared state, so switching between a Goal and
 * ordinary skip injects the matching text.
 */
export type AskUserReminderPolicy = 'auto' | 'block' | 'skip' | 'goal-skip';

/**
 * `block` / `skip` / `auto`: texts confirmed by the user on 2026-09-24.
 * `goal-skip`: added 2026-10-22 when Goal questions began waiting up to 60 s
 * instead of returning at once. Keep every text verbatim; changing a single
 * character makes previously injected declarations undetectable and triggers
 * one re-injection per affected session.
 */
const ASK_USER_POLICY_BODIES: Readonly<Record<AskUserReminderPolicy, string>> = {
  block:
    "User setting: every ask_user question in this context waits for the user's reply, and the async parameter is ignored. Each question pauses the task until the user responds, so ask only when you cannot proceed without the answer.",
  skip: 'User setting: ask_user never waits for a reply in this context, and the async parameter is ignored. Each call returns immediately; if the user answers, the answer arrives later as a new message.',
  auto: 'User setting: ask_user follows the async parameter again. Earlier ask-user-policy notes in this conversation no longer apply.',
  'goal-skip':
    "User setting: in Goal mode each ask_user question waits up to 60 seconds for the user's reply, and the async parameter is ignored. If the user does not answer in time, the recommended option of each question (or its first option) is selected automatically and returned to you, marked as not confirmed by the user.",
};

const ASK_USER_POLICIES: readonly AskUserReminderPolicy[] = ['block', 'skip', 'auto', 'goal-skip'];

/** Render the `<ask-user-policy>` declaration for one effective policy. */
export function buildAskUserPolicyBlock(policy: AskUserReminderPolicy): string {
  return ['<ask-user-policy>', ASK_USER_POLICY_BODIES[policy], '</ask-user-policy>'].join('\n');
}

/**
 * Question timing and quality guidance for managed models.
 *
 * Why each rule is worded the way it is:
 * - Only timing and question quality, never sync/async: `async` usage lives in
 *   the tool description every model sees, so repeating it here would let the
 *   two drift apart.
 * - The first rule lists when asking is required. In the 2026-10-13 Ask User
 *   v2 eval, 10 of the 40 cases that should ask made no ask_user call: the
 *   model chose a direction that changes the deliverable itself (meeting
 *   purpose, job level, handling path, contracting party). The previous first
 *   rule only said when not to ask and never said when asking is required.
 *   Its closing "do not ask for what is already stated" keeps the 18
 *   should-not-ask cases from being triggered by the wider list.
 * - "A default is reasonable only if a wrong guess costs the user nothing":
 *   models treated "the file can be rewritten" as reversible, so they built a
 *   whole deliverable on a guessed direction, or built several versions at
 *   once (Chinese, bilingual and English) to avoid choosing.
 * - "Whenever you need the user's decision or material": widens the previous
 *   "if the user asks you to confirm first, call ask_user" rule, because the
 *   eval also had models requesting material in reply text without creating a
 *   questionnaire. A question written in reply text shows the user nothing to
 *   answer.
 * - "Check that the answers would let you finish": 3 cases did call ask_user
 *   but asked only how to send material, what to name the assistant, or which
 *   tone to use, and missed scope, stop conditions and permissions, so the
 *   model would have had to ask again or guess.
 * - "Every question needs 2–4 options": the ask_user schema requires `options`
 *   on every question. The previous wording ("For each question with options")
 *   read as if options were optional, and models wrote option-less fill-in
 *   questions that then failed schema validation.
 * - Lengths (200 characters per question; 50 per option, label and description
 *   counted together) are recommendations only. By the user's decision of
 *   2026-10-12 there is deliberately no `maxLength` or other enforcement in the
 *   schema; the old "explain every consequence and the recommendation" wording
 *   produced 47–103 character option descriptions, so the prompt now asks for
 *   brevity instead.
 * - "It marks your suggestion, not the user's answer": `recommended` only
 *   highlights an option; it must not be read as the user having approved it.
 *
 * `hasAskUserGuidance` matches this full text, so any wording change makes
 * existing sessions miss it once and get the new version re-injected on their
 * next Turn. That single re-injection is expected.
 */
export function buildAskUserGuidanceBlock(): string {
  return [
    '<ask-user-guidance>',
    'Call `ask_user` before building on a guess when the answer decides what you deliver: a choice between mutually exclusive versions or directions, a fact only the user knows (such as an approved level, the contracting party, or the intended use), or the scope, permissions, or stop conditions of something you create for the user. Do not ask for anything the conversation or files already state.',
    'Decide execution details yourself. A default is reasonable only if a wrong guess costs the user nothing: a whole deliverable built on a guessed direction is not a default, even though the file can be rewritten, and building several versions instead of asking is not a default either.',
    "Whenever you need the user's decision or material to continue, call `ask_user`; a question written in your reply shows no questionnaire.",
    'Before calling, check that the answers would let you finish without asking again. How the user sends material, a name, or a tone never replaces the scope, constraints, or permissions you need.',
    'Put related decisions in one questionnaire, one decision per question. Every question needs 2–4 options. For open-ended input, offer likely choices as options; the user can type a custom answer, so never add an "Other" option.',
    'Keep it brief and put everything the user needs in the question and its options. Aim for at most 200 characters per question and at most 50 characters per option, counting the label and its description together.',
    "Put one recommended option first with `recommended: true`; it marks your suggestion, not the user's answer. Do not invent facts, sources, or user preferences.",
    '</ask-user-guidance>',
  ].join('\n');
}

/**
 * Latest runtime-rendered policy declaration in chronological `texts`, or
 * undefined when history carries none (never declared, or compacted away).
 */
export function findLatestAskUserPolicyDeclaration(
  texts: readonly string[],
): AskUserReminderPolicy | undefined {
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    const text = texts[index] ?? '';
    let latest: { readonly policy: AskUserReminderPolicy; readonly offset: number } | undefined;
    for (const policy of ASK_USER_POLICIES) {
      const offset = text.lastIndexOf(buildAskUserPolicyBlock(policy));
      if (offset >= 0 && (!latest || offset > latest.offset)) latest = { policy, offset };
    }
    if (latest) return latest.policy;
  }
  return undefined;
}

export function hasAskUserGuidance(texts: readonly string[]): boolean {
  const block = buildAskUserGuidanceBlock();
  return texts.some((text) => text.includes(block));
}

export type AskUserPolicyReminderReason =
  | 'no-ask-user-tool'
  | 'already-declared'
  | 'auto-without-declaration'
  | 'first-declaration'
  | 'policy-changed'
  | 'restore-auto';

export type AskUserGuidanceReminderReason =
  | 'no-ask-user-tool'
  | 'unmanaged-provider'
  | 'already-in-history'
  | 'missing-from-history';

export interface AskUserReminderDecision {
  /** Complete `<system-reminder>` block, or undefined when nothing is injected. */
  readonly reminder?: string;
  readonly policy: {
    readonly injected: boolean;
    readonly reason: AskUserPolicyReminderReason;
    readonly effective: AskUserReminderPolicy;
    readonly declared?: AskUserReminderPolicy;
  };
  readonly guidance: {
    readonly injected: boolean;
    readonly reason: AskUserGuidanceReminderReason;
  };
}

/**
 * Decide both AskUser reminders for one Turn start.
 *
 * Policy declaration: inject only when the effective policy differs from the
 * latest declaration in history. AUTO with no declaration stays silent (AUTO is
 * what the tool description already describes); switching back to AUTO after a
 * block/skip/goal-skip declaration injects the restore note, otherwise the
 * stale "async is ignored" note would keep misleading the model. Injected for
 * every model because it states a user setting, not model-specific coaching.
 *
 * Guidance: managed models only (BYOK relies on the shared tool description),
 * once per history; re-added after compaction or when a session switches from
 * BYOK to a managed model mid-way.
 *
 * Both require `ask_user` in this Turn's final tool catalog; task children,
 * explore and verifier Turns have no ask_user and get neither.
 */
export function decideAskUserReminders(input: {
  readonly effectivePolicy: AskUserReminderPolicy;
  readonly hasAskUserTool: boolean;
  readonly managedProvider: boolean;
  /** Runtime-owned text of earlier user messages, oldest first. */
  readonly historyTexts: readonly string[];
}): AskUserReminderDecision {
  const effective = input.effectivePolicy;
  if (!input.hasAskUserTool) {
    return {
      policy: { injected: false, reason: 'no-ask-user-tool', effective },
      guidance: { injected: false, reason: 'no-ask-user-tool' },
    };
  }
  const declared = findLatestAskUserPolicyDeclaration(input.historyTexts);
  const policyReason = policyDecisionReason(effective, declared);
  const injectPolicy =
    policyReason === 'first-declaration' ||
    policyReason === 'policy-changed' ||
    policyReason === 'restore-auto';
  const guidanceReason: AskUserGuidanceReminderReason = !input.managedProvider
    ? 'unmanaged-provider'
    : hasAskUserGuidance(input.historyTexts)
      ? 'already-in-history'
      : 'missing-from-history';
  const injectGuidance = guidanceReason === 'missing-from-history';
  const blocks = [
    ...(injectGuidance ? [buildAskUserGuidanceBlock()] : []),
    ...(injectPolicy ? [buildAskUserPolicyBlock(effective)] : []),
  ];
  return {
    ...(blocks.length > 0
      ? { reminder: ['<system-reminder>', ...blocks, '</system-reminder>'].join('\n') }
      : {}),
    policy: {
      injected: injectPolicy,
      reason: policyReason,
      effective,
      ...(declared ? { declared } : {}),
    },
    guidance: { injected: injectGuidance, reason: guidanceReason },
  };
}

function policyDecisionReason(
  effective: AskUserReminderPolicy,
  declared: AskUserReminderPolicy | undefined,
): AskUserPolicyReminderReason {
  if (declared === effective) return 'already-declared';
  if (declared === undefined) {
    return effective === 'auto' ? 'auto-without-declaration' : 'first-declaration';
  }
  return effective === 'auto' ? 'restore-auto' : 'policy-changed';
}
