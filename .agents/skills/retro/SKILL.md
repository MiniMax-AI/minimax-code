---
name: retro
description: Extract evidence-backed lessons from a completed development session and propose focused improvements to repository guidance. Use when the user asks for a retrospective or to capture reusable lessons.
---

# Session Retrospective

Turn concrete failures, retries and workflow gaps into a small set of reusable
improvements. Do not turn one-off preferences into repository-wide rules.

## Review the evidence

For each useful lesson, record:

- **Event:** what happened, with a public-safe file, command, error or commit.
- **Cause:** the demonstrated reason, separated from hypotheses.
- **Lesson:** what a future contributor should do differently.
- **Impact:** safety/data, correctness, efficiency or preference.

Skip unsupported opinions and one-off circumstances. Combine duplicate lessons
and keep the result focused on the few changes that would prevent recurrence.
Redact credentials, private service details and real user content from evidence.

## Find the right home

Read existing guidance before proposing additions:

| Lesson | Candidate location |
| --- | --- |
| Repository-wide constraint | `AGENTS.md` or `CONTRIBUTING.md` |
| A specific reusable workflow | The relevant `.agents/skills` entry |
| Build, release or source-sync procedure | The relevant document under `docs/` |
| A behavioral defect | A focused code fix and regression test proposal |

Prefer correcting an existing instruction over introducing a parallel process
or a new notes/proposals directory. Check current source and scripts before
preserving an explanation that might already be stale.

## Scope and delivery

If the user asks only for a retrospective, return the findings and proposed
edits. Apply documentation changes when requested, within the established scope.
Do not treat the retrospective as authorization to create issues, send messages,
publish changes or modify personal/agent memory. Write memory only when the user
explicitly asks for that persistence and the environment supports it.

For applied changes, keep public contributor guidance in English. New files
require publication review and inventory regeneration; content-only changes do
not. Report the lessons, evidence, proposed or applied destinations, checks run
and remaining decisions.
