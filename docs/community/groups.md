# Community groups

This document defines the three community layers, what each layer is for, and the rule for moving
between them. It is public so that joining a group is a predictable decision rather than a guess.

## Layers

| Layer | Who can join | What belongs there | What does not |
| --- | --- | --- | --- |
| Newcomer | Anyone with the group QR code or the Discord link | Install, configuration, first-run usage, frequently asked questions | Unreleased features, internal roadmap, internal test builds |
| Advanced | Anyone who has opened at least one issue, or who is invited | Architecture discussion, PR intentions, performance findings, design proposals | Internal roadmap, unreleased features |
| Insider | Invitation only, after signing the external-disclosure rule | Test builds, unreleased features, early feedback | Screenshots of accounts, session identifiers, or unreleased versions |

The three layers are rules first and separate groups second. A new group with fewer than 50 active
members is not created; the rule applies to the existing group until the volume justifies a split.

## The one entry point

Every layer carries the same pinned card, pointing at the same three places:

1. **Report an issue** — `https://github.com/MiniMax-AI/minimax-code/issues/new/choose`
2. **Claim a task** — the `good first issue` label:
   `https://github.com/MiniMax-AI/minimax-code/labels/good%20first%20issue`
3. **See the on-call rota and the weekly replay** — [Community on-call](oncall.md)

Feedback posted in chat without an issue number is not tracked. If a chat report is not converted into
an issue within 24 hours, the on-call owner raises it on the reporter's behalf.

## Moving between layers

- **Newcomer → Advanced**: automatic, as soon as the member opens an issue or is invited. There is no
  application and no approval.
- **Advanced → Insider**: invitation only. The invite includes the external-disclosure rule below, and
  the rule is acknowledged before any test build is shared.
- **Insider → public**: content returns to a public layer only through the formal release notes. Chat
  history is never the source for external material.

## External-disclosure rule for the Insider layer

Acknowledged by every Insider member before receiving a test build.

1. Test builds, unreleased feature names, and internal version numbers stay in the Insider layer. They
   are not posted to a public group, a public issue, a screenshot, a blog post, or a video.
2. Account identifiers, session identifiers, tokens, and customer project content are never shared in
   any layer. Use synthetic files and dedicated test accounts.
3. External material about a feature comes from the release notes for a released version, not from a
   chat log. If a screenshot is needed for a public post, it must be regenerated from a released
   build.
4. A leak is reported to the release coordinator immediately, and the affected material is withdrawn
   as soon as it is identified. Reporting a leak is never held against the reporter.

## What a layer may be used for

| Activity | Newcomer | Advanced | Insider |
| --- | --- | --- | --- |
| Install and configuration help | Yes | Yes | Yes |
| Bug report and question answering | Yes | Yes | Yes |
| Weekly feedback replay | Yes | Yes | Yes |
| AMA session (biweekly) | Yes | Yes | Yes |
| Showcase wall submission | Yes | Yes | Yes |
| Architecture and design discussion | No | Yes | Yes |
| Pull request review participation | No | On invitation | Yes |
| Test build distribution | No | No | Yes |

## Showcase wall

Showcases are collected in `docs/showcase/` and mirrored to a GitHub Discussions category.

- **Threshold:** a showcase must be runnable — a repository, or a prompt that reproduces it, plus the
  verification command. Screenshots alone are not accepted.
- **Every showcase produces a task.** Each accepted showcase must yield at least one
  `good first issue` task, by extracting the step a newcomer could do independently. This is the point
  of the wall: a showcase that produces no task brings in visitors who find nothing to do.
- **Low bar by design:** the entry requirement is "post a prompt that runs". A showcase is not a
  product pitch.

## AMA sessions

Biweekly, 30 minutes: 20 minutes of product questions, 10 minutes walking through live issues.

- **Agenda comes from the queue.** Every question discussed is drawn from the current
  `needs-triage` queue or a contribution request. The host does not choose topics independently.
- **Recording and minutes** are archived to the Discussions `AMA` category, with the issue numbers
  discussed listed in the minutes.
- **Failure condition:** if three consecutive sessions draw fewer than 30% of registrants, the format
  changes to a smaller closed-door session over live issues instead of a public AMA. Adding more
  sessions is not the response.
