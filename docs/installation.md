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

The default data directory is `~/.minimax-code`. For tests, explicitly set `MINIMAX_DATA_DIR` to a temporary directory to keep normal sessions separate. Use `$env:MINIMAX_DATA_DIR = 'C:\path\to\test-profile'` in PowerShell or `export MINIMAX_DATA_DIR=/path/to/test-profile` in a POSIX shell.

## Update or remove

Save your changes, fetch a reviewed revision with Git, then repeat the frozen install and build. A source installation does not automatically become an official npm installation.

To uninstall, remove the source directory you created. User data is separate and remains in place. Delete that directory only when you no longer need its account configuration or sessions.
