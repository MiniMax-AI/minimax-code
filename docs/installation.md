# Install from source

The official CLI is available as [`@minimax-ai/code`](https://www.npmjs.com/package/@minimax-ai/code). Public npm `latest` was 0.4.12 on 2026-09-18. Follow the [official quick start](https://agent.minimax.io/docs/cli/quick-start) or the [README installation steps](../README.md#quick-start) for the macOS / Linux / WSL installer, Windows PowerShell installer, or npm installation.

For npm, use the command in the README: it explicitly selects the public registry, includes optional dependencies, and allows the `@minimax-ai/code` and `better-sqlite3` lifecycle scripts. SQLite is declared optional in the package metadata, but a working native SQLite binding is required at runtime. Do not omit optional dependencies or disable installation scripts. On npm versions that enforce script approvals, `--allow-scripts` grants these two packages permission without allowing every dependency script.

`@latest` follows the stable npm dist-tag. For a reproducible CLI version, replace `@latest` with an exact published version such as `@0.4.12`, keeping the other options. Use Node.js 22.19+ (22.x), 24.2+ (24.x), 25, or 26 for both npm and source installations.

This guide builds the 0.4.12 source preview. Workspace/local build manifests remain `private: true` to prevent accidental publishing. A source checkout may contain additional reviewed distribution changes; matching version strings alone do not establish byte-for-byte or build-provenance equivalence with the official npm tarball. Use the committed source revision and release receipt to identify a source build.

For a source build, you need Git, Node.js 22.19+ (22.x), 24.2+ (24.x), 25, or 26, and pnpm 9.12.0. Regular CI uses Node.js 24 across Linux, macOS, and Windows. The weekly and manual compatibility matrix covers Node.js 22.19.0, 24.2.0, 25, and 26 on all three platforms. Initial installation and build require access to public npm.

Node 24.0 and 24.1 are unsupported: their bundled libuv can return inconsistent Windows file identity metadata, causing safe configuration reads to fail. [Node 24.2.0](https://nodejs.org/en/blog/release/v24.2.0) includes libuv 1.51.0 with the [upstream fix](https://github.com/libuv/libuv/commit/82cdfb75f). Use a current patch release of a supported Node line.

```bash
git clone https://github.com/MiniMax-AI/minimax-code.git
cd minimax-code
corepack enable
corepack prepare pnpm@9.12.0 --activate
pnpm install --frozen-lockfile
pnpm build
pnpm mcode --help
pnpm mcode
```

If your Node.js installation does not include Corepack, install the exact pnpm version using your existing package manager. Native dependencies without matching prebuilt binaries require C/C++ build tools and Python: the C++ workload in Visual Studio Build Tools on Windows, Command Line Tools on macOS, or the system build toolchain on Linux.

The build extracts mcode-tools from a pinned public `@minimax-ai/code` archive and verifies both archive and CLI hashes. The cache is in `.cache/artifacts`. On integrity failure, check the network or remove that cache and retry; never bypass hash verification.

To use the CLI in another project, open that project's directory and run the built entry point by absolute path:

```bash
node /absolute/path/to/minimax-code/dist/cli.js
```

On Windows, also use `node` with the appropriate local absolute path. Do not overwrite another globally installed command with this source build.

## Accounts and data

Run `/login` in the TUI or `pnpm mcode login`, choosing the region for your account. Token Plan requires an account and available credits. See the root README for BYOK configuration and testing.

Source builds and the published npm CLI use the same default user data directory:

| CLI artifact | Default user data directory |
| --- | --- |
| Published npm `@minimax-ai/code@0.4.12` | `~/.minimax` |
| Build from this repository | `~/.minimax` |

The npm 0.4.12 default was checked against the [public registry artifact](https://registry.npmjs.org/@minimax-ai/code/0.4.12) on 2026-09-19, with its SHA-512 integrity verified. This applies to that published version, including local npm dependencies; do not infer the default of another release from its version label alone. A selected profile uses `~/.minimax-<profile>`. The source default is defined in [`data-dir.ts`](../packages/tui/src/runtime/data-dir.ts). Login state, provider configuration such as `config.yaml`, caches, and sessions belong to the selected data directory.

Both accept a non-empty `MINIMAX_DATA_DIR`, falling back to a non-empty `MAVIS_DATA_DIR`, before the default. The [macOS / Linux / WSL installer](https://filecdn.minimax.chat/public/install.sh) installs the npm package under `~/.minimax-code` by default (`MCODE_INSTALL_DIR` changes the installation location). It does not set either data-directory override. Installation files and user data are separate concerns, even when their directories have the same name.

Earlier source builds used `~/.minimax-code` for user data. The new default does not move or merge that data. To keep using an existing source-build data directory, explicitly set `MINIMAX_DATA_DIR` to its path.

To locate data safely:

1. Identify the launcher you actually use with `command -v mcode` (POSIX) or `Get-Command mcode -All` (PowerShell), and run that launcher's `--version`. For a local npm dependency, use `node_modules/.bin/mcode --version`; a global npm listing does not identify it. A source build may report the same version as the npm release.
2. Check whether either data-directory override is set in that launcher's environment. Otherwise use the artifact-specific default above. Inspect directory and file names/permissions locally, without printing `config.yaml`, authentication files, or session contents. For builds from this repository, `mcode telemetry status` also reports the selected `configFile` path without printing credentials; npm 0.4.12 does not provide that command.
3. If both directories exist, their presence alone does not identify the active one. Keep both protected, and include the launcher, version, installation method, and whether overrides are set when requesting help. Redact personal path components; do not attach configuration or authentication files. Changing an override does not migrate existing data, so do not move or delete either directory merely to match these docs.

For tests, explicitly set `MINIMAX_DATA_DIR` to a temporary directory to keep normal sessions separate. Use `$env:MINIMAX_DATA_DIR = 'C:\path\to\test-profile'` in PowerShell or `export MINIMAX_DATA_DIR=/path/to/test-profile` in a POSIX shell.

## Update or remove

Save your changes, fetch a reviewed revision with Git, then repeat the frozen install and build. A source installation does not automatically become an official npm installation.

To uninstall a source build, save any work and remove the source directory you created. Separately stored user data remains in place. See [Uninstall](../README.md#uninstall) for official installer and npm removal, shell PATH cleanup, and optional user-data deletion.
