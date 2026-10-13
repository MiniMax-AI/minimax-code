# Community on-call and issue SLA

This document defines who watches the community channels, what counts as a response, and how
feedback is replayed back to reporters. It is a public commitment: anyone reading it should be able
to predict when they will hear back.

## Scope

The community on-call covers two surfaces:

| Surface | Meaning | Owner |
| --- | --- | --- |
| Community chat (Chinese Feishu group, Discord) | User questions, feedback, event coordination | On-call A |
| GitHub issues (`MiniMax-AI/minimax-code`) | Bug reports, feature requests, contribution requests | On-call B |

These are two different roles and they are staffed by two different people. A single person holding
both roles cannot cover the 18:00–20:00 window, so that window is explicitly not covered by either
role.

## Rotation

| Role | Window | Timezone | Coverage |
| --- | --- | --- | --- |
| On-call A | Weekdays 10:00–18:00 | Asia/Shanghai | Community chat |
| On-call B | Daily 09:00, 20:00–23:00, and weekends | Asia/Shanghai | GitHub issues |
| Uncovered | 18:00–20:00 weekdays | — | Neither role; escalate to the release coordinator |

The rotation is published in the community chat as a pinned card. It is replaced every two weeks.

## Response SLA

**Every open issue must receive a triage action within 48 hours of being opened.** A triage action is
one of the following, and one of them counts:

- applying a type and product label;
- asking the reporter for the specific missing information (`needs-info`);
- linking a duplicate to its original issue;
- recording a next step in a comment, including a decision to decline with a reason.

A triage action is not a promise to fix or to ship in a release. Classification alone does not commit
the project to a delivery date, and this distinction is stated in every response so reporters know
what they are getting.

Anything that has been open for more than 48 hours without any of the above is a SLA breach and is
listed in the weekly feedback replay.

## Label hygiene

- An issue must not stay on `needs-triage` after it is closed. When closing an issue, remove
  `needs-triage` in the same action.
- `needs-triage` counts only open issues. Reporting a `needs-triage` ratio that includes closed
  issues overstates the backlog; the canonical number is `is:issue is:open label:needs-triage`.
- When an issue is closed as `duplicate` or `wontfix`, the reason is stated in a comment, per the
  triage policy in [Maintainers](../maintainers.md).

## Contribution requests

A request for repository access is a request for a decision, and a decision must be communicated.
Even when the answer is "no", the answer is sent.

- Tag contribution requests with `contribution-request` so the funnel from request to decision is
  measurable.
- Respond within 48 hours with one of: approved, declined with a reason, or already completed
  internally.
- **When the underlying task is completed internally first, the requester is told explicitly and their
  fork and branch are still declared valid.** If the internal fix missed anything, the requester is
  invited to open a fork PR. Silently closing a contribution request because the work was done
  elsewhere is treated as a SLA breach, not as resolution.
- Submission of a fork PR does not require collaborator access. Access is a convenience for
  maintainers, not a precondition for contributing.

## Weekly feedback replay

Every Friday, the on-call owner posts a single message to the community chat summarising the week:

- every issue that received a triage action, with its number and what the action was;
- every issue that was asked for more information, and what is still needed;
- every issue that was closed, and why;
- every open issue that has breached the 48-hour SLA, listed by number.

The replay links issue numbers directly. It exists so that a reporter can see what happened to their
report without having to ask, and it is the mechanism that keeps feedback from being silently dropped.

## Reply templates

### Triage response

```
Thanks for the report — received and triaged.

Triage action: <label / needs-info / duplicate / next step recorded>, removed from `needs-triage`.

What we need from you to take this further:
1. <specific question>
2. <specific question>

We will reply within 48 hours. This triage action is not a commitment to a release date.
```

### Contribution request — already completed internally

```
Thanks for the patch and for following the contribution route. Sorry for the long silence on this
thread; that was our failure, not yours.

The task you prepared for (#<n>) was completed internally by #<n> and #<n>, so that specific task is no
longer open.

Your fork and branch are still valid. If you spot anything the internal fix missed or got wrong,
please open a fork PR — no collaborator access is required to submit a fork PR, and we review it
within 48 hours. The same applies to any other change you have prepared.

If you would like to pick up a scoped task, the `good first issue` label is the canonical list:
<label url> — items there are expected to be independently completable, with
`pnpm verify --profile docs` as the verification command for documentation tasks.
```

The two sentences that matter here are the second and third paragraphs. Reporting that the work was
done elsewhere, and then stating that the requester's work is still valid, is what keeps a second
applicant from being treated the same way. Never write "the task is already done, please resubmit".

### Contribution request — approved

```
Approved. You now have the requested access.

The change is expected to be scoped in an issue first, then submitted as a PR from your fork.
Please run the verification command for the profile that covers your change
(`pnpm verify --profile docs` for documentation) and paste the real command output into the PR
description. Review target is 48 hours; if you have not heard back by then, ping the on-call owner.
```

### Security-relevant report

```
Thank you for the detailed report. This is treated as a safety-priority report and escalated for a
code-level review.

Please do not post further exploit detail in this public thread. If the reproduction involves a
pattern that could affect other users, open a private report per SECURITY.md and reference this issue
number.

We will reply within 48 hours.
```

## Reporting

The on-call owner reports these numbers weekly to the community chat and to the project maintainers:

| Metric | Definition |
| --- | --- |
| 48h triage coverage | share of issues opened in the week that received a triage action within 48 hours |
| Open `needs-triage` | open issues still carrying `needs-triage` (open scope only) |
| SLA breaches | issues open for more than 48 hours with no triage action |
| Zero-reply issues | open issues with no comment at all |
| Contribution request resolution time | hours from request to a communicated decision |
