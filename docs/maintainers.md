# Maintainers and contribution workflow

## Responsibility

| Responsibility | Current routing | Responsibilities |
| --- | --- | --- |
| Repository administration and release coordination | @hetaoBackend, release coordinator | Maintain access and branch protection, assign reviewers, coordinate release approval and publish only verified candidates |
| Code review | `.github/CODEOWNERS` requests @hetaoBackend; the release coordinator assigns a repository collaborator other than the author | Review correctness, tests, capability boundaries, licenses and public-source scope; authors do not approve their own PRs |
| Security triage | @hetaoBackend coordinates a private channel under [Security](../SECURITY.md) | Receive reports privately, appoint a responder and coordinate fixes/disclosure; no response SLA is currently promised |
| Shared-source synchronization | The release coordinator assigns a maintainer to each sync PR | Preserve public adaptations, review conflicts and new files, and keep private history/review material out of public PRs |

These are repository maintenance responsibilities, not an assertion that an account owns the product's copyright. Every PR that requires approval needs a reviewer other than the author, and security reports need a working private response path. Review maintainer additions and policy changes in a PR; do not silently grant repository access.

## Review and merge

1. Repository collaborators open an issue for substantial scope or submit a focused feature-branch PR. Other users may open issues to discuss ideas and proposals. Security details follow the private reporting process.
2. The release coordinator selects a reviewer other than the author. Use the PR template to record user-visible behavior, checks and untested boundaries.
3. Review changed publication scope and existing licenses before regenerating the inventory. Run the shared verification profile required by the change. A test fixture is not live-service evidence.
4. Require a current independent approval, resolved review conversations, and successful `verification` and `source-history-artifact` checks. Dismiss stale approvals when the reviewed code changes. A billing outage, cancellation or absent check is not a pass.
5. Squash or merge the reviewed public PR while preserving contributor attribution. Do not bypass checks to unblock a release. No maintainer may substitute a self-approval for independent review.

When migrating older CI configurations, replace required individual OS/Node check names with the two aggregate contexts above before removing the old names. Documentation-only changes intentionally skip platform jobs, so those individual contexts must not be required. Read back both classic branch protection and effective rulesets; workflow changes do not update either setting.

CODEOWNERS requests reviewers; it does not enforce protection by itself. The intended administrative configuration is [`.github/branch-protection.json`](../.github/branch-protection.json). Applying it requires repository administration access. Read back the live settings after applying; committing this file does not activate it.

```bash
release_repo=MiniMax-AI/minimax-code
gh api "/repos/$release_repo/branches/main/protection"
gh api --method PUT "/repos/$release_repo/branches/main/protection" \
  --input .github/branch-protection.json
gh api "/repos/$release_repo/branches/main/protection"
```

Inspect existing rules before applying: the PUT operation replaces classic branch protection. Preserve any stronger existing protections. This baseline requires the two GitHub Actions checks, one independent approval, resolved conversations and enforcement for administrators; force pushes and branch deletion remain disabled. Confirm that a reviewer other than the PR author has write access before enabling the rule. Required code-owner approval is disabled while CODEOWNERS names only one reviewer; enable it when at least two active reviewers are listed. Independent PR approval remains required. Repository plan availability and token permissions must support the settings.

## Contributions and licenses

Contributors must have permission to submit their changes under the existing license applicable to each changed file/package. Preserve original authorship and notices, identify imported material and its provenance, and do not include credentials or third-party personal data. The PR template records this confirmation. This process introduces no separate CLA, DCO bot or copyright assignment. If a contribution needs different terms, resolve them before merging.

## Collaborator contributions and internal synchronization

Accepted changes land through repository PRs first. The assigned sync maintainer ports accepted shared changes into the internal source, preserving attribution and recording the PR reference internally. PRs may record that porting is pending or complete; they must not expose private links, commit messages or review reports.

For the next sync, use the three-way process in [Source synchronization](source-sync.md). Confirm that the accepted public contribution remains present, inspect conflicts and deletions, and advance `sourceRevision` only after reviewing the complete candidate. Do not use a bulk overwrite or import internal Git history.

## Release handoff

The release coordinator explicitly dispatches `Node compatibility` and `Source candidate` for the reviewed revision before a source release; normal PR/main checks do not produce a candidate. Changes to supported Node versions, native dependencies or compatibility-sensitive verification tooling need the compatibility run before merge, and candidate/export changes need a selected-branch candidate run once its manual entry is available.

The release coordinator records the selected source commit and archive receipt, current verification results, [publication scope](publication-authorization.md), known limitations and the reviewer. Update [source status](open-source-status.md), [verification records](verification.md), and both README entry points when their shared content changes. Publish source previews separately from npm and installer releases, following [Releasing](releasing.md).

The release coordinator applies administrative settings only on the intended repository and reads back the result. Check current administrative readiness from the live repository before each release.
