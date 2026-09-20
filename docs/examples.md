# Examples

Build the project using the [installation guide](installation.md). Run the `pnpm mcode` commands below from the source root. For interactive tasks, open the target project directory and launch the built CLI by absolute path.

## 1. Edit code and run tests

`examples/clamp` is an intentionally broken exercise with one function and three Node.js tests. It needs no additional dependencies. Copy the directory to a temporary location, open that copy, and start:

```bash
node /absolute/path/to/minimax-code/dist/cli.js
```

Enter:

> Read clamp.mjs and clamp.test.mjs. Run node --test to reproduce the failure, fix clamp without changing the tests, then run the tests again.

In the [real demo](demo.md), two tests initially failed. After correcting the bounds, all three passed. Use `Ctrl+O` to inspect tool details. Choose permissions appropriate for your project; the demo ran in a temporary directory containing only synthetic files.

Resume the most recent session in the current directory:

```bash
node /absolute/path/to/minimax-code/dist/cli.js --continue
```

## 2. Choose your own model

Use `/provider` in the interactive TUI to select a configured model. Before adding a custom provider, set a key in your current shell rather than putting it in command arguments or source:

```bash
# POSIX shell: read the key interactively without echoing it.
read -s MCODE_PROVIDER_API_KEY
export MCODE_PROVIDER_API_KEY
```

In PowerShell, use a process environment variable and treat the input as sensitive:

```powershell
$secureKey = Read-Host 'API Key' -AsSecureString
$env:MCODE_PROVIDER_API_KEY = [System.Net.NetworkCredential]::new('', $secureKey).Password
```

Add, inspect, and test the provider:

```bash
pnpm mcode provider add --name my-provider --base-url https://example.com/v1 \
  --api-format openai-completions --model my-model \
  --api-key-env MCODE_PROVIDER_API_KEY --use
pnpm mcode provider list
pnpm mcode provider test <provider-id> --model <model-id>
pnpm mcode exec "Explain this project's test entry points" --model <provider-id>/<model-id>
```

Replace the example URL, model name, and IDs with your configuration and the IDs returned by the list command. `--use` tests the first listed model, then saves the provider and selects that model as the default. A failed connection test exits nonzero without saving or changing the default; correct the URL, key, or first model ID and retry. Omit `--use` to save without a connection test or default-model change. `exec --model` overrides only the current run. Backslash line continuations are for POSIX shells; use a single line in PowerShell.

For a local server, configure its actual token limits explicitly:

```bash
pnpm mcode provider add --name local-models --base-url http://localhost:8080/v1 \
  --api-format openai-completions --model local-model --model another-model \
  --api-key-env MCODE_PROVIDER_API_KEY \
  --context-limit 32768 --output-limit 4096 --use
pnpm mcode provider list --json
```

`--context-limit` and `--output-limit` each accept a positive safe integer (at most `9007199254740991`). Either flag can be used independently. The same limits apply to every repeated `--model`; only the first model is tested and selected by `--use`. The JSON list shows the configured values as `contextLimit` and `maxOutputTokens`. Without these flags, the existing defaults remain unchanged (unknown custom models currently fall back to 200,000 context tokens and 16,384 output tokens). Model discovery does not infer your local server's context size.

`--api-key-env` reads the current environment variable value and stores that value in the active profile's `config.yaml`; it does not save an environment-variable reference. The file still contains plaintext credentials. On POSIX systems, config writes and temporary copies use `0600`. When loading existing files, MCode removes group/other access while preserving the owner's permissions; already-private files such as `0400` or `0600` do not require a permission change. Loading fails if an unsafe main config cannot be restricted. Older migration backups are also checked, but inspection or repair failures produce a warning identifying the directory or backup that needs manual attention rather than preventing the main config from loading. Windows file modes do not provide equivalent ACL protection; restrict access to the profile directory using Windows permissions.

[Live acceptance](verification.md) separately verified MiniMax Token Plan and one configured BYOK provider. This is not a guarantee for every compatible service.

## 3. Search and image input

For a custom BYOK model, declare image input support explicitly when adding the
provider. Use this only if the selected provider endpoint and model accept images:

```bash
pnpm mcode provider add --name my-vision-provider --base-url https://example.com/v1 \
  --api-format openai-completions --model my-vision-model \
  --api-key-env MCODE_PROVIDER_API_KEY --support-image --use
```

`--support-image` applies to every repeated `--model` and saves
`capabilities.support_image: true`. Without it, adding an unknown custom model
does not infer image support from its name. `--use` and `provider test` check
connectivity with a text request; they do not verify vision support.

For an existing provider, close MCode and add the capability to the matching model
in the active profile's `config.yaml` (normally `~/.minimax/config.yaml`; see
[Accounts and data](installation.md#accounts-and-data) for profiles and overrides).
Merge this fragment into the existing provider and keep its other settings:

```yaml
custom_provider:
  my-vision-provider:
    models:
      my-vision-model:
        capabilities:
          support_image: true
```

The existing `modalities: { input: [text, image], output: [text] }` model setting
also enables image input. Either declaration is sufficient. To make a model
text-only again, remove `image` from `modalities.input` and remove or set
`capabilities.support_image` to `false`. Generic `attachment: true` alone does not
declare image input support. Restart MCode after editing configuration and select
the configured model with `/provider`, or use `exec --model` for a single run.

After signing in to MiniMax, try a task that explicitly requires search:

> Use web_search to find the official Node.js test runner documentation. Summarize how to run tests and include the source URL. If the tool is unavailable, say so.

Acceptance observed an actual `web_search` call and returned results; see the [verification record](verification.md). A model returning a URL alone does not prove it used search.

Paste your own image into the TUI, or attach a file explicitly:

```bash
pnpm mcode exec "Describe this UI screenshot's layout and suggest three improvements" \
  --file /absolute/path/to/your-screenshot.png
```

The image is sent as input to the selected model service. Use content suitable for sending and a model that supports images. This is an executable usage example, not a live-service acceptance result from this review. Search, image understanding, and media generation are separate capabilities; mcode-tools generation also requires the relevant account permissions and credits.

See [capability coverage](tui-capabilities.md) for custom MCP, managed connectors, and media tools.

## 4. Manage plugins

Open `/plugins` inside the TUI, or run `mcode plugin` from a shell to open that panel. For a source build, use `pnpm mcode plugin` from the source root instead; the commands below use the installed `mcode` executable.

The panel combines the **official** catalog and **local** plugin directories. Use `Tab` / `Shift+Tab` to switch between All Plugins, Installed, Official, and Local; type to search and use the arrow keys to select a row.

| Action | Key | Scope |
| --- | --- | --- |
| Install an available plugin | `Enter` | Official catalog; requires MiniMax login |
| Enable or disable an installed plugin | `Space` | Official and local |
| Remove an installed plugin | `Delete` or `Ctrl+D` | Official and local; clear the search first with `Esc`, then reselect the plugin |
| Refresh the catalogs | `Ctrl+R` | Official and local |

With a nonempty search, `Delete` / `Ctrl+D` edit the search instead of removing a plugin. `Esc` clears the search, or closes the panel when the search is already empty. Removing a local plugin deletes its installed directory; keep a separate source copy if you need to restore it.

The same operations are available from the shell:

```bash
mcode plugin --help
mcode plugin marketplace list
mcode plugin list --available --marketplace official
mcode plugin add <name>@official
mcode plugin disable <name>@official
mcode plugin enable <name>@official
mcode plugin remove <name>@official
mcode plugin marketplace upgrade
```

Replace `<name>` with a plugin name returned by `list`. Use `@official` or `@local` to disambiguate names shared by both sources; `--marketplace official` / `--marketplace local` are equivalent source selectors. The list and mutation commands support `--json`. `marketplace upgrade` refreshes source snapshots; it does not register a new marketplace.

For a local plugin, run `mcode plugin marketplace list` to find the active profile's local directory. Place a supported plugin package in a direct child directory there, with its manifest at the package's expected location, then refresh `/plugins`. Copy the individual plugin package, not an entire marketplace repository. Discovered local packages already count as installed:

```bash
mcode plugin list --available --marketplace local
mcode plugin disable <name>@local
mcode plugin enable <name>@local
mcode plugin remove <name>@local
```

`mcode plugin add <name>@local` is not a local import command and is unsupported. Neither `plugin add` nor `/plugins` currently accepts a GitHub URL, local path, or arbitrary third-party marketplace registration. Compatible package readers and a GitHub importer exist in the runtime, but the CLI/TUI do not expose that importer. Managing arbitrary marketplaces from the panel remains a separate feature request; the current source selectors are only `official` and `local`.
