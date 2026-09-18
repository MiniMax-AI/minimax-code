# Source status

The current source target is **TUI 0.4.12**. This repository contains the terminal TUI, headless CLI, ACP implementation, and the public distribution tooling around them.

## Version and evidence baseline

| Concern | Current value | Source of truth |
| --- | --- | --- |
| TUI capability version | 0.4.12 | `packages/tui/package.json` |
| Root workspace version | 0.4.12, aligned with the TUI | Root `package.json` |
| Published npm observation | `@minimax-ai/code@0.4.12`; npm `latest` was 0.4.12 on 2026-09-18 | Public npm registry |
| Shared-source baseline | `9b9885e42a3cf1a3df1cfa52a46e4fdb034cfcee` | `release/extraction.json` |
| Embedded mcode-tools | 0.0.4, extracted from public `@minimax-ai/code@0.3.11` | `scripts/lib/mcode-tools-artifact.mjs` |
| Historical live-service acceptance and demo | TUI 0.3.11, recorded 2026-09-11 | `docs/verification.md`, `docs/release-audit.md`, `docs/demo.md` |

The product, TUI, and root workspace use the same 0.4.12 version. The embedded tool has its own version. Workspace and local-build manifests remain `private: true` to prevent accidental npm publication. Matching version strings do not prove that this source tree reproduces the published npm tarball.

## Source boundary

- MiniMax OAuth and Token Plan, BYOK, accounts, quota views, the official plugin marketplace, managed connectors, search, mcode-tools, updates, feedback, and bounded diagnostic clients are included.
- The in-process runtime, public workspace dependencies, tools, and sandbox are included. Internal generated IDL, the Desktop HTTP front door, and cloud-executor-only implementations are excluded.
- mcode-tools is extracted from a pinned public npm package with archive and file-hash verification. Only the host holds refresh tokens.
- Source checks permit reviewed public service API paths while rejecting internal addresses, generated protocols, and obvious credentials.
- Internal Git history stays outside this repository. Shared-source updates use the reviewed process in [Source synchronization](source-sync.md).

See [TUI capability coverage](tui-capabilities.md) for individual features, [Verification records](verification.md) for evidence, and [Publication scope](publication-authorization.md) for the repository boundary.

## Repository baseline

The initial CLI source snapshot was imported into `MiniMax-AI/minimax-code` on 2026-09-18 at commit `c59cf5377045aa1a3e699c242d089b73b7cdc2ad`. Commit `4e2e7bb5f771e9c42b2edefb1046483819b9032f` restored the Desktop image above the download links. The import preserved the repository's Desktop issue history and support workflow while adding the CLI source without internal Git history.

Open dependency upgrades remain separate changes and require their own review and validation. Current test results and untested service boundaries are recorded in [Verification records](verification.md).
