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

Use `/model` in the interactive TUI to select a model or choose **+ Add 3rd-party provider…**; `/provider` manages saved connections. The known-provider picker labels Z.AI and Zhipu plans separately as **Coding Plan** and **API**. The regional default order puts Coding Plan first; remotely configured pinning can override that order. Choose the plan matching your key. On the model screen, review the Base URL or press **Ctrl+E** to edit it before testing. If the test fails, changes are not saved; the model and key draft remain available for editing and retry. Changing the URL requires another explicit test/save action and never triggers an automatic endpoint fallback.

Preset IDs come from models.dev and do not select entries in the bundled inference registry. Onboarding saves the chosen URL under `custom_provider`; subsequent requests use that saved URL.

Before adding a custom provider, set a key in your current shell rather than putting it in command arguments or source:

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

### Third-party relays and custom auth headers

Providers created by `mcode provider add` are stored under `custom_provider` in the active profile's `config.yaml`. That tree is the supported home for any endpoint other than the official MiniMax API; `minimax_api` is reserved for the official endpoint and keeps its fixed authentication scheme.

Authentication follows the API format: `openai-completions` and `openai-responses` send `Authorization: Bearer <key>`, and `anthropic-messages` sends the key as `x-api-key`. A relay that expects Bearer authentication on an OpenAI-compatible endpoint therefore needs no extra configuration. If a relay only exposes an Anthropic-compatible endpoint (`/v1/messages`) and requires Bearer authentication, add explicit headers to the provider entry in `config.yaml`:

```yaml
custom_provider:
  my-relay:
    options:
      apiKey: sk-relay-key
      baseURL: https://relay.example.com
      headers:
        Authorization: Bearer sk-relay-key
    models:
      MiniMax-M2: {}
```

`api` can be omitted and defaults to `anthropic-messages`. Configured headers are sent on both connection tests and conversation requests, and they are part of the connection-test fingerprint, so editing them retires a cached test verdict. The default `x-api-key` header is still sent alongside; the relay must tolerate rather than reject it. Header values are stored in plaintext like `apiKey` and are reported by name only in provider views. After editing the file, verify with `mcode provider list` and `mcode provider test <provider-id>`.

[Live acceptance](verification.md) separately verified MiniMax Token Plan and one configured BYOK provider. This is not a guarantee for every compatible service.

### Prompt-cache session affinity

A relay that routes prompt-cache hits per session needs to recognize which session a request belongs to. MCode never derives that from the Anthropic `metadata.user_id` field: `metadata` is forwarded only when a caller sets it explicitly, because it is an abuse-detection and attribution field rather than a cache key. The supported mechanism is the `sendSessionAffinityHeaders` compatibility override, declared per model under `compat`:

```yaml
custom_provider:
  my-relay:
    options:
      apiKey: sk-relay-key
      baseURL: https://relay.example.com
    models:
      MiniMax-M2:
        compat:
          sendSessionAffinityHeaders: true
```

With the override enabled, every request carries the current session id as `x-session-affinity`. An `openai-completions` provider additionally sends the same value as `session_id` and `x-client-request-id`. Key the relay's cache routing on those headers. Requests made with cache retention disabled send no session headers at all; leave the routing fallback in place rather than treating a missing header as a new session.

The override defaults to `false`, so a provider that ignores these headers is unaffected; it is enabled automatically only for endpoints known to require it, such as Fireworks and the Anthropic route of Cloudflare AI Gateway. `compat` accepts further per-model capability overrides, and each value is applied only when it has the declared type, so a quoted `"false"` is discarded rather than read as true. Restart MCode after editing configuration.

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

See [capability coverage](tui-capabilities.md) for custom MCP, managed connectors, and media tools, and the [authenticated project MCP walkthrough](#5-connect-an-authenticated-project-mcp-server) below for your own remote server.

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

## 5. Connect an authenticated project MCP server

Choose a service you trust and review what you will send before starting a task.
Enabled project servers connect automatically during tool discovery or calls;
connecting exposes the canonical workspace root through MCP `roots/list`, even
to a remote server. Tool calls send their arguments to that service. A tool
permission prompt happens after connection and does not prevent this initial
contact. This optional configuration leaves built-in search unchanged.

Create `.mcp.json` in the workspace root you will launch MCode from:

```json
{
  "mcpServers": {
    "research": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${RESEARCH_MCP_API_KEY}"
      }
    }
  }
}
```

Replace the placeholder URL with your service's exact MCP endpoint, including
its path. Keep the API key out of the file and URL: `${RESEARCH_MCP_API_KEY}` is
a literal environment-variable reference, expanded by the runtime. Set the
variable in the shell that will launch MCode, for example in Bash:

```bash
read -r -s -p 'Research MCP API key: ' RESEARCH_MCP_API_KEY
export RESEARCH_MCP_API_KEY
cd /absolute/path/to/your-project
node /absolute/path/to/minimax-code/dist/cli.js
```

For PowerShell, use `Read-Host -AsSecureString` as in the [provider example](#2-choose-your-own-model), assigning the result to `$env:RESEARCH_MCP_API_KEY`.
Only the session's main workspace directory is checked for `.mcp.json`; MCode
does not search parent directories or `/add-dir` locations. No plugin import or
MCP-specific approval command is needed.

Inside the TUI, enter `/mcp` (or `/mcp research` to filter). The **Project ·
.mcp.json** section lists the server as `configured` before connection. Listing
configuration does not contact the server or prove authentication. Close the
panel with `Esc`, then ask MCode to use a tool offered by your selected service
with a small, non-sensitive input. Inspect the actual tool call and result with
`Ctrl+O`; a prose answer alone does not prove a tool ran. After successful
discovery or a call, `/mcp` shows `available`, which still does not establish that
a research task succeeded.

To troubleshoot or change the configuration:

- A missing `RESEARCH_MCP_API_KEY` produces `error`, names the missing variable,
  and prevents that server from connecting. Export it and restart MCode from
  that shell; `/mcp reload` cannot import environment changes from another shell.
- Set `"enabled": false` inside the `research` entry to stop using it. A valid
  disabled entry shows `disabled`; invalid fields or missing variables still
  show `error`.
- After editing `.mcp.json`, close the panel and enter `/mcp reload` to reread
  and display the configuration. It is not a connection or authentication test.
  Discovery and calls also reread the file automatically; a changed configuration
  retires the old connection and is used on the next discovery or call.
- For a server that has already connected, exit MCode before editing and restart
  afterward. Local CLI validation found that reloading a changed HTTP entry after
  a successful call can stop the TUI with `This operation was aborted.`
- If connection fails, check the endpoint, key and service availability. An
  `error` does not by itself identify an authentication failure.

For transport options, environment defaults and configuration precedence, see
the [detailed project MCP reference (Chinese)](../packages/local-runtime-v2/docs/project-mcp.md).
