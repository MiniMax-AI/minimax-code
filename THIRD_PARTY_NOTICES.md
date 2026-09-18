# Third-party notices

- **Pi**: `third_party/pi-mono` and derived terminal code, MIT. Full notices are in `third_party/pi-mono/LICENSE` and `packages/tui/THIRD_PARTY_NOTICES.md`. Local modifications are recorded in `third_party/pi-mono/MINIMAX_CHANGES.md`.
- **Sandbox Runtime**: `third_party/sandbox-runtime`, Apache-2.0. See its README, LICENSE, and upstream.json for the upstream version, source revision, fork changes, and native build instructions.
- **models.dev**: the bundled provider / model catalog snapshot, MIT; notices are in `packages/tui/THIRD_PARTY_NOTICES.md`.
- **Bundled assets**: LICENSE, NOTICE, and file-level declarations in each asset directory retain their original attribution.
- **npm dependencies**: versions and declared licenses are recorded in `release/dependency-licenses.json`; `pnpm-lock.yaml` is authoritative for dependency resolution and integrity.
- **mcode-tools 0.0.4**: extracted unchanged from the public `@minimax-ai/code@0.3.11` package during the build. Its distribution manifest declares MIT; archive and CLI hashes are pinned in `scripts/lib/mcode-tools-artifact.mjs`. The tool's own manifest is retained, and the original distribution's third-party notices are copied to `dist/MCODE_TOOLS_NOTICES.md`. The root license does not replace this artifact's existing declarations.

The root MIT license does not replace these materials' separate licenses or copyright notices.
