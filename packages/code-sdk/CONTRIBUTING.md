# Contributing to `@minimax-ai/code-sdk`

This file is for repository contributors and is not part of the npm package (`files` only includes
`dist`, `src`, `README.md` and `CHANGELOG.md`). Repository-wide rules are in the root
[CONTRIBUTING.md](../../CONTRIBUTING.md) and [AGENTS.md](../../AGENTS.md); releases follow
[RELEASING.md](RELEASING.md).

## Commands

```bash
pnpm install --frozen-lockfile
pnpm test:code-sdk          # Vitest suite "code-sdk" from test/vitest-suites.json
pnpm typecheck:code-sdk     # SDK sources and tests
pnpm --filter @minimax-ai/code-sdk run build
```

Both gates are part of `pnpm verify`: `typecheck:code-sdk` in the full profile, `test:code-sdk` on
Linux and macOS. Add new test files to the `code-sdk` group in `test/vitest-suites.json`.

## Test doubles and contracts

- The tests use `test/fixtures/cli-package/mcode.mjs` as a fake CLI. It replays recorded and
  sanitized `stream-json` output from `test/fixtures/*.jsonl` (a successful run with tool calls, an
  upstream failure, a resumed Session and a cancellation). Mock runs are not evidence of live model
  behavior.
- The same directory is linked as the `@minimax-ai/code` devDependency. pnpm installs a workspace
  project's own peer dependencies, optional ones included; the link keeps the real CLI out of the
  workspace and lets the tests exercise the "installed package" resolution path.
- The SDK owns its public types (`src/types.ts`). `test/cli-contract.test.ts` imports the CLI's real
  JSONL projector (`packages/tui/src/headless/events.ts`) and exit-code policy
  (`packages/tui/src/headless/exit-policy.ts`) to check parsing, normalization and exit-code mapping.
  `test/cli-resolution.test.ts` keeps `engines.node` identical to `packages/tui/package.json`. When
  you change those CLI files or the CLI Node.js range, run the SDK suite as well.

## Published text

`dist/`, `src/`, `README.md` and `CHANGELOG.md` are published verbatim. Keep repository paths,
CI job names and contributor instructions out of them; put them here or in `RELEASING.md`.
`release:check` scans the packed tarball before every release.
