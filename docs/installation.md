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

## macOS terminal shortcuts: Ghostty Option+M

In the composer, `Alt+M` (`Option+M` on macOS) cycles permission modes through Ask, Auto, and Full access. Its binding ID is `composer.cycle-permission`. `Shift+Tab` toggles **Plan mode**, a separate setting. You can also use `/permission` to choose a permission mode and `/permission status` to inspect it without an Option shortcut.

If `Option+M` inserts `µ` instead, the terminal is sending text rather than the expected Alt shortcut. MCode preserves literal `µ` as text; it cannot safely infer a permission change from that character. The terminal must forward the modifier, or you can choose another binding.

### Configure Ghostty's Option key

Ghostty's [`macos-option-as-alt`](https://ghostty.org/docs/config/reference#macos-option-as-alt) default is **keyboard-layout dependent** when unset, not always `false`. The current reference lists U.S. Standard and U.S. International as defaulting to `true`; other layouts default to `false`. Check the active macOS input source and the configuration loaded by your installed Ghostty version.

Set this in your Ghostty configuration to send both Option keys as Alt:

```ini
macos-option-as-alt = true
```

Use `left` or `right` instead of `true` to reserve only that Option key for shortcuts and retain Unicode composition on the other side. Use the configured side when testing `Option+M`.

Follow Ghostty's [configuration locations and precedence](https://ghostty.org/docs/config#file-location): macOS-specific files load after XDG files, and later settings can override earlier ones. Inspect the loaded setting from the same Ghostty installation, without `--default`:

```bash
ghostty +show-config | awk '/^macos-option-as-alt[[:space:]]*=/'
```

If `ghostty` is not on `PATH`, use the executable inside your installed app bundle, typically `/Applications/Ghostty.app/Contents/MacOS/ghostty`. An empty or omitted value is not proof of `false`; unset behavior depends on the layout. After editing, reload Ghostty's configuration from its menu (default `Cmd+Shift+,`) and open a new terminal. This is separate from MCode's `/reload` command.

### Keep Option for text and customize MCode instead

While idle, open `/hotkeys`, select `composer.cycle-permission`, press `Enter`, press `Ctrl+X`, then press `Enter` to save. `Ctrl+X` is unused by the current default MCode bindings; check any custom terminal or multiplexer bindings too. Do not choose `Ctrl+M`: terminals commonly encode it identically to `Enter`.

Alternatively, merge this entry into `<data-dir>/tui/keybindings.json`, preserving any existing entries:

```json
{
  "composer.cycle-permission": "ctrl+x"
}
```

For the default profile this is `~/.minimax/tui/keybindings.json`; [profiles and data-directory overrides](#accounts-and-data) change the path. Create the `tui` directory if needed. After editing the file, run `/reload` while idle with no pending interaction or queued message, or restart MCode. This replaces `Alt+M`; use `["alt+m", "ctrl+x"]` as the value to retain both bindings. `/hotkeys` shows the effective binding.

### Verify the result

With an idle composer and no open picker or permission prompt, note `/permission status`, press the configured shortcut, and check the status again. The mode should advance without inserting text. Restore your intended permission mode through `/permission` afterward. Confirm that `Shift+Tab` still toggles Plan mode and that pasting `µ` still inserts text.

If it still fails, record `mcode --version`, Ghostty's version, active keyboard layout, which Option key you pressed, the setting above, the effective `/hotkeys` entry, and whether tmux or SSH is involved. Compare with a direct Ghostty session. MCode supports both legacy ESC-prefixed Alt input and extended keyboard reports; a shell's raw-key display alone does not establish what Ghostty sends after the TUI negotiates its keyboard protocol.

## Update or remove

Save your changes, fetch a reviewed revision with Git, then repeat the frozen install and build. A source installation does not automatically become an official npm installation.

To uninstall a source build, save any work and remove the source directory you created. Separately stored user data remains in place. See [Uninstall](../README.md#uninstall) for official installer and npm removal, shell PATH cleanup, and optional user-data deletion.
