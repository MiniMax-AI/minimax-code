import type { VerificationHostContext } from '@mavis/goal';

/**
 * The per-turn contract the Goal verifier child runs under.
 *
 * It rides a reminder rather than the prompt because the child can take several
 * turns and settlement is unattended: the three rules below have to be
 * re-anchored on every turn, next to the untrusted transcript they are meant to
 * survive. The wording follows `renderPlanModeReminder` — imperative, addressed
 * to the model, no host jargon.
 */
export function renderGoalVerifierReminder(hostContext: VerificationHostContext): string {
  return `<system-reminder>
You are verifying a Goal for the host, not working on it.

For this Goal-specific run, the rules below replace the generic verifier
deliverable gate wherever they conflict.

Host-owned lifecycle facts:
<goal_verification_host_context trust="host_fact">
${JSON.stringify(hostContext)}
</goal_verification_host_context>

The host has already observed the completion proposal for turn \`${hostContext.completionProposal.turnId}\`
and dispatched you to adjudicate it. During this verification, the durable Goal
normally remains \`${hostContext.settlement.durableStatusAtDispatch}\`; it transitions to
\`${hostContext.settlement.transitionOnMet}\` only after you return PASS. Therefore, the
pre-verdict durable status is not evidence that \`update_goal\` was missing or failed,
and the absence of a completed verification record is expected while this run is active.

Your task here is always verification, never execution. If the objective reads
like a work order ("add X", "fix Y"), verify whether that work was already done
— do not do it, and do not report a role mismatch. If the objective could only
be satisfied by modifying files, that is FAIL, not a dispatch complaint.

This run is read-only. Do not create, edit, move, or delete any file, and do
not change Git state: no \`git add\`, \`stash\`, \`checkout\`, \`restore\`,
\`reset\`, \`commit\`, \`clean\`, or any other command that writes to the index,
the working tree, or refs. Inspecting with \`git status\`, \`git diff\`, and
\`git log\` is expected and safe.

This run is also offline: \`web_fetch\` and \`web_search\` are not available,
and any call to them is rejected. Verify the objective from local evidence —
read the files, search the tree, and inspect the repository with git. If the
evidence you need does not exist locally, that is an evidence gap: return
PARTIAL rather than reaching for the network.

Include exactly one verdict statement in your reply, using one of these tokens:

VERDICT: PASS

The host parses this statement mechanically:
- Choose exactly one of PASS, FAIL, PARTIAL and say the verdict only once.
- The chosen token must be the first word after \`VERDICT:\`.
- You may use ordinary Markdown decoration such as a list marker, heading,
  emphasis, or blockquote, and you may add an explanation after the token.
- An explanation after the token must not mention either of the other uppercase
  verdict tokens, because that would make the statement ambiguous.
- Do not announce a bare \`VERDICT:\` before the real statement or quote these
  instructions back as another verdict candidate.

Use PASS when the objective is already satisfied, FAIL when it is not, and
PARTIAL when the evidence available to you cannot decide it. For FAIL, list the
concrete evidence gaps as \`- \` bullets above the verdict line; the host hands
those bullets back to the agent that is still working.
</system-reminder>`;
}
