# Contributing

This repository contains the standalone MiniMax Code TUI, headless CLI, and ACP source. Start with the [architecture](docs/architecture.md), [capability coverage](docs/tui-capabilities.md), and [installation guide](docs/installation.md).

Thanks for your interest in contributing. For now, we only accept code and documentation contributions from repository collaborators. If you are not a collaborator but have an idea or proposal, please [open an issue](https://github.com/MiniMax-AI/minimax-code/issues/new/choose) so we can discuss it.

Repository collaborators should submit pull requests from feature branches; do not push directly to the default branch. Describe user-visible changes, checks you ran, live-service or platform validation you did not run, and documentation impact. Preserve real author identities and existing copyright notices.

## Maintainers and review

See [Maintainers](docs/maintainers.md) for review ownership, independent approval, security/release routing and the public-to-internal contribution flow. The [PR template](.github/PULL_REQUEST_TEMPLATE.md) records checks, untested boundaries and permission to contribute under the existing applicable licenses. CODEOWNERS routes reviews; required checks and approvals must also be enabled in repository settings.

## Documentation language

English is the primary language for project documentation, examples, issue templates, and contributor guidance. Write new documentation and commit messages in English. Keep `README.md` in English and `README_ZH.md` as its Simplified Chinese translation, with reciprocal language links. Update both when their shared content changes. Additional translations are optional and must be clearly labeled and linked from the English source.

Preserve original third-party license text. Localized product strings, multilingual examples, and bundled runtime prompts / skill resources retain the languages required by their behavior; changing them is a runtime-content change, not a documentation translation.

## Local validation

Repository development skills are available under [`.agents/skills`](.agents/skills):

| Skill | Use |
| --- | --- |
| [cli-guide](.agents/skills/cli-guide/SKILL.md) | Navigate TUI, exec, ACP and their runtime boundary |
| [cross-layer-drift-sweep](.agents/skills/cross-layer-drift-sweep/SKILL.md) | Check renames, defaults and contracts across consumers |
| [testing-workflow](.agents/skills/testing-workflow/SKILL.md) | Select focused checks and the required delivery gates |
| [verify-all-runtime-sinks](.agents/skills/verify-all-runtime-sinks/SKILL.md) | Verify alternate runtime paths, caches and artifacts |
| [retro](.agents/skills/retro/SKILL.md) | Turn demonstrated failures into focused guidance improvements |

These are contributor workflows, separate from bundled product skills. They are
adapted to this distribution's paths and verification contracts; workflow changes
should update the relevant skill alongside its source of truth.

```bash
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` runs the complete gate list in the same order as GitHub CI. Normal PR and main-branch checks use Node.js 24 on Linux, macOS and Windows. The Linux job runs this full profile; the other two platforms use `pnpm verify --profile platform`, which omits only the duplicate TypeScript compiler check. All three jobs still export source, build, and test their own platform artifacts. Gates that depend on platform behaviour are selected by platform rather than skipped silently; run `pnpm verify --list` or `pnpm verify --profile platform --list` to inspect either plan. Individual gates remain available as their own scripts, such as `pnpm typecheck` or `pnpm test:byok`, while you iterate.

CI writes per-gate timing and exit metadata to the Job Summary and a seven-day `verification-<os>-node-<version>-<attempt>` artifact. For a local report, set `MCODE_VERIFY_REPORT_DIR` to a directory outside the repository. Reports distinguish `PASS`, `FAIL`, intentional `SKIP`, and `NOT_RUN` after a failure. JSON is checkpointed before and after each gate; a cancelled run may leave `RUNNING`, which is not a pass. If installation fails before verification starts, no verification report is available. Reports do not collect command output, environment variables, or runtime data; read the corresponding gate's job log for failure details, including the existing bounded BYOK timeout diagnostics. CI jobs have a 15-minute verification limit and a 10-minute release-audit limit.

Existing README files, `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE.md`, Markdown under `docs/`, and media directly under `docs/assets/` use the `docs` profile when they are the only changed paths. That profile checks the source inventory and generated paths, exports the committed source, and tests release tooling. History and source-snapshot secret scans still run; platform builds and distribution scans are skipped. Mixed changes, unknown paths, missing comparisons, and any `release/` inventory change get full CI. Documentation-only changes skip the platform matrix entirely. The `verification` aggregate check always runs and rejects failed, cancelled, or unexpectedly skipped jobs. Use it together with `source-history-artifact` as required checks when configuring branch protection; this repository's automation does not change administrative settings.

`Node compatibility` runs weekly and on demand against macOS, Linux and Windows with Node 22.19.0, 24.2.0, 25 and 26. It does not run automatically on PRs. Dispatch it on the selected branch for changes to supported Node versions, native dependencies or compatibility-sensitive verification tooling, and before a source release. This covers the minimum versions of the two supported ranges and the additional supported majors. Deferring those versions from ordinary PR checks can delay regression discovery; a known failure in a supported version still needs resolution before release. Dependabot proposes weekly Actions and npm updates, grouping Actions and development-tool minor/patch updates. External Actions use reviewed full commit SHAs, while local actions and reusable workflows come from the same checked-out revision.

Source candidates are requested independently through the `Source candidate` workflow; ordinary PRs and main pushes do not produce them. Its three-platform archive validation is described in [Releasing](docs/releasing.md). Product npm and installer publication remains a separate release process.

Source export reports separate archive creation, extraction, inventory validation, hashing, and cleanup timings in `export.json`. Windows uses native `tar` after complete archive preflight; other systems use the Node extractor. The preflight rejects traversal, links, duplicate entries and Git metadata before writing files. A machine without native `tar` falls back to Node. Set `MCODE_SOURCE_EXTRACTOR=node` or `native` when comparing extractors locally.

Test files are declared in `test/vitest-suites.json`, grouped by the gate that runs them. Add a test file there instead of adding a path to `package.json` or to the Vitest config. Do not describe protocol fixtures or offline tests as live-model acceptance.

`tsconfig.standalone.json` path mappings are generated from the package scope in `release/extraction.json` and each package's `exports`. After adding a package or an export subpath, run `pnpm gen:tsconfig`; `pnpm check:tsconfig` fails when the committed mapping has drifted.

Review added or removed files before running `node scripts/source-inventory.mjs --write`. Updating the inventory must not bypass checks for private protocols, internal addresses, credentials, or third-party licensing. Before a source release, also scan the complete Git history with Gitleaks; see the [release process](docs/releasing.md).

## Capability boundaries

Preserve MiniMax OAuth, Token Plan, BYOK, mcode-tools, search, plugins, connectors, updates, and feedback. Do not solve standalone-build problems by removing capabilities. Managed services use public clients; internal HTTP services, generated IDL, and cloud executor implementations are outside this repository.

Do not commit account data, logs, sessions, API keys, or real user content. Use temporary data directories and synthetic inputs for tests. Do not attach unredacted diagnostic bundles to issues; follow the [security reporting process](SECURITY.md).

## Synchronizing with the source repository

The internal product repository remains the source of shared implementation. This repository maintains standalone distribution adaptations and a reviewed public projection. Use the [source synchronization process](docs/source-sync.md) to generate candidates, review them, validate changes, and submit a PR. Never merge internal Git history. Changes should land through pull requests before maintainers port them back internally; subsequent synchronization must preserve public adaptations.
