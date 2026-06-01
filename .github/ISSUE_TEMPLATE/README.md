# Issue Templates — MiniMax Code

This folder holds structured issue forms. When you open a new issue, GitHub shows
these as selectable templates. Pick the one that matches your case.

## Available templates

| Template | When to use |
|---|---|
| **Badcase** | MiniMax Code didn't behave as expected — wrong output, stuck loop, broken automation, bad team routing, habit learned wrong, etc. |

## How to file a badcase (the fast path)

1. **Search first** — your issue may already be reported. If you find a match, add a "Me too" with your repro details, don't open a duplicate.
2. **Upgrade** — make sure you're on the latest version. A lot of "bugs" are already fixed.
3. **Pick the "Badcase" template** — fills in a structured form so triage is fast.
4. **Fill in the form, top to bottom** — every field exists because someone on triage has been blocked by its absence. If a field truly doesn't apply, write `N/A`, don't leave it blank.
5. **Strip the noise** — minimum repro wins. "My screen froze" beats "I clicked 47 things then it froze, here's everything I did today".
6. **Logs > screenshots > text** — for visual bugs, a 10-second screen recording beats 5 screenshots. For backend / agent team bugs, paste the relevant log line, not the whole log.
7. **Don't share secrets** — strip API keys, tokens, personal info before submitting.

## After you submit

- A bot will auto-label and route the issue. You don't need to do anything.
- Triage usually responds within **3 business days**. S0 / S1 fast-tracked.
- If you can, stick around for follow-up questions — most badcases need a back-and-forth to nail down.

## Severity cheat sheet

| Level | Meaning | Examples |
|---|---|---|
| S0 | Crashed / lost data / unusable | App won't launch, schedule silently dropped, habit data wiped |
| S1 | Core feature broken | Agent team routes wrong, automation doesn't run, Feishu sync broken |
| S2 | Works but wrong | Right team picked, but wrong output; habit learned the wrong pattern |
| S3 | Cosmetic / minor | UI glitch, slow but functional, typo in a label |

When in doubt, pick the higher severity — triage will downgrade if needed, but won't upgrade.
