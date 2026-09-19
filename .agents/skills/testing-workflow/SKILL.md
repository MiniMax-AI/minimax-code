---
name: testing-workflow
description: Select and report verification for MiniMax Code changes using the repository's declared test suites and CI gates. Use when validating code, skills, documentation, build tooling or source-distribution changes.
---

# Testing Workflow

Start with changed files, then identify the owning runtime, user entry point and
final observable behavior. Read `AGENTS.md`, `CONTRIBUTING.md` and the applicable
steps in `scripts/verify.mjs`.

## Focused iteration

Vitest files belong to groups in `test/vitest-suites.json`; aliases and inclusion
come from `vitest.oss.config.mjs`. Select an existing declared file for a focused
run, for example:

```bash
pnpm exec vitest run --config vitest.oss.config.mjs packages/tui/test/unit/headless-contract.test.ts
```

Register new Vitest files in the suite declaration. Do not add hard-coded file
lists to package scripts or the Vitest configuration. Vendored upstream test
suites are outside this distribution's verification.

| Scope | Repository gate |
| --- | --- |
| Runtime, TUI, providers, plugins and ACP | `pnpm test:capabilities` |
| Headless CLI and offline BYOK behavior | `pnpm test:byok` |
| CLI artifact smoke | `pnpm test:smoke` |
| Public artifact content | `pnpm test:artifact` |
| TUI build-mode contract | `pnpm test:status-contract` |
| Permission facade on macOS/Linux | `pnpm test:policy` |
| Sandbox on macOS | `pnpm test:sandbox` |
| Source-sync, workflow and release tools | `pnpm test:release-tools` |
| Types and standalone build boundary | `pnpm typecheck`, `pnpm build`, `pnpm check:standalone` |
| Published files and generated paths | `pnpm check:source`, `pnpm check:tsconfig` |

Artifact-dependent tests require a current `pnpm build`. Keep test state and
reports outside the repository, using synthetic data and temporary directories.

The declared Vitest gate runner serializes test files on Windows to limit
filesystem contention while retaining individual test deadlines. Run the owning
gate for platform acceptance; a direct Vitest invocation uses its default worker
count. Full-runtime smoke children have a 30-second Windows startup budget,
matching ACP; lightweight help and validation checks retain 15 seconds.

## Delivery verification

Run `git diff --check` and the relevant individual gates while editing. Review
new or removed files before regenerating `release/public-source.json` with
`node scripts/source-inventory.mjs --write`.

Before opening a PR, run `pnpm verify` on the reviewed commit with a clean tracked
working tree. Source export reads committed HEAD and rejects uncommitted tracked
changes; report that limitation if only iteration checks are possible.

Use `pnpm verify --list` to inspect the current platform's gates. Use the `docs`
profile only when every changed path qualifies under `scripts/ci-changes.mjs`.
Skills under `.agents/skills`, unknown paths and inventory changes require the
full profile. The `archive` profile is for source-archive validation, not a way to
bypass the clean-commit export requirement.

## Manual evidence and reporting

For CLI behavior, exercise the built `dist/cli.js` and inspect stdout, stderr and
exit code. For terminal presentation, exercise the relevant interaction when
feasible. For provider or service changes, distinguish offline fixtures from a
real endpoint call.

Report scope, commands and results, manual scenarios, and untested boundaries.
Use PASS/FAIL/BLOCKED for actual checks; mark checks that did not run explicitly.
Local macOS success does not establish Windows/Linux or live-service acceptance.
