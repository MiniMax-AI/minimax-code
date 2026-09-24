# TUI capability coverage

The current capability target is **TUI 0.4.12**; see [version and evidence baseline](open-source-status.md#version-and-evidence-baseline) for the separate workspace and embedded-tool versions. “Restored” below describes implementation and assembly, not acceptance of every account or online service.

## Terminal titles and notifications

Terminal titles show the current state, session name and MCode, for example
`Needs approval | Fix login | MCode`. Renaming or switching a session updates the
title. Unnamed sessions use the project name and a short session ID. Titles are
cleared when MCode exits or suspends and reapplied when it resumes.

Configure these presentation settings in the MCode data directory's `config.yaml`:

```yaml
tui:
  terminalTitle: [status, session-name, app-name]
  notifications:
    when: unfocused
    method: auto
    events: [turn-complete, turn-failed, permission-required, question-required]
```

Title items can be ordered or omitted; `project-name` is also available. Set
`terminalTitle` to `null` or `[]` to disable title updates. Unknown items are ignored.
Notification `when` accepts `unfocused`, `always` or `never`; `method` accepts
`auto`, `osc9`, `osc777` or `bel`. Omitting `events` enables all four events; `[]`
disables them. Apply configuration changes by restarting MCode.

Notifications identify the session and suppress duplicates. Completion waits for
the session's queue to finish; failed turns and requests for input can notify
independently. Known foreground focus suppresses notifications by default. When
focus is unknown, delivery is best-effort; cmux manages its own surface focus.
Automatic delivery uses the detected terminal's notification protocol or falls
back to a bell. The existing Windows toast bridge is restricted to local Windows
or WSL interop. Terminal settings and OS notification permissions still apply.

VS Code normally displays a process name in its terminal tabs. To display MCode's
session titles, use this VS Code setting:

```json
"terminal.integrated.tabs.title": "${sequence}"
```

A manually assigned tab title overrides automatic titles. VS Code's bell is a
terminal-tab indicator, not a guarantee of a desktop notification. See the
[VS Code terminal appearance documentation](https://code.visualstudio.com/docs/terminal/appearance#_tab-text).
Inside tmux, OSC notifications require passthrough and support from the outer
terminal; use `method: bel` for a bell fallback.

The evidence column summarizes the historical TUI 0.3.11 restoration record from 2026-09-11. It does not claim fresh TUI 0.4.12 live-service acceptance. Use [current verification status](verification.md#current-source-verification-status) for checks run against the updated source and explicit NOT RUN boundaries.

| Capability | Implementation | Evidence |
| --- | --- | --- |
| MiniMax login, logout, Token Plan, quota, check-in | OAuth Core, account clients, and TUI / CLI entry points restored | Login-state, auth-command, check-in, provider, and ACP tests; production Token Plan session and resume passed |
| BYOK / custom models | Retained; headless model overrides no longer inherit the default Token Plan login requirement | Local protocol server drives runtime, resume, and file tools; live BYOK session passed; managed models still reject unauthenticated requests |
| mcode-tools | Public package's unchanged 0.0.4 artifact, launcher, and short-lived token leases restored | Archive SHA-512, CLI SHA-256, real CLI startup, lease and host integration tests; production shared-broker authentication passed |
| Search and Matrix image / audio / video tools | Matrix MCP and tool assembly restored; search is independent of mcode-tools | MCP configuration and auth-isolation tests; actual search passed; generation requests not run |
| Official and local plugins; runtime GitHub importer | `/plugins` and `mcode plugin` manage official installations and discovered local packages; arbitrary marketplace registration and GitHub URL import are not exposed in the CLI/TUI. See [plugin management](examples.md#4-manage-plugins) | Plugin application, source-page, and offline local CLI tests; actual official catalog read passed |
| Managed connectors | Cloud client, permissions, and invocation adapters restored | Connector runtime and cloud transport tests; actual tool discovery passed; business writes not run |
| Updates | Update entry points, install-source detection, and signature verification restored; public packages use public npm | Update application and service tests; no real installation / upgrade on the development machine |
| Feedback and diagnostic uploads | Reviewed feedback text and minimized diagnostic summaries | Synthetic fixtures exercise session collection and capture/decode the final ZIP upload; no live uploads or real content |
| Automatic LLM error reports | Disabled by default; requires `telemetry.diagnostics` opt-in; bounded diagnostic facts minimized before encryption | Synthetic provider errors and native Headers; final HTTP batches captured and decrypted locally |
| Telemetry | Usage, metrics, and diagnostics each disabled by default with separate opt-ins; `MCODE_DISABLE_TELEMETRY` / `DO_NOT_TRACK` override all channels; usage-event identifiers removed | Privacy regression tests intercept and decode requests locally; no live upload |
| Auto permissions | Cloud classifier restored; local rules and confirmation on failure retained | Classifier client, permission facade, and sandbox tests |
| Model catalog | Online catalog and bundled snapshot fallback restored | Actual build boundary checks and offline startup; online catalog contents not accepted |
| Files, shell, subagents, sessions, headless, ACP | Actual runtime retained | BYOK, file reads, session resume, ACP, sandbox, and status protocol tests |
| Built-in skills, MCP, plugin tools | Original TUI assets and activation conditions retained | Asset build, plugin, and MCP tests; no claim that every skill has passed a real task |

## Local Bash execution

When the current turn includes native `task_output`, foreground Bash waits up to
60 seconds before returning the same command's background task ID. Its total
command timeout defaults to 600 seconds and is capped at 600 seconds; a shorter
requested timeout applies. Backgrounding and output reads preserve the original
deadline. Without native `task_output`, Bash stays in the foreground with a
120-second default and a 300-second cap, and its schema omits `run_in_background`.
Explicit background commands use the requested timeout; when omitted, the
existing 30-minute runtime watchdog applies.

Only exit code zero is success. Results retain available exit, signal, timeout,
cancellation, and partial-output facts. Large output keeps its original beginning
and end within a 24 KiB first-response text budget, with a full-log reference when
persistence succeeds. `task_output` reads use byte offsets; a successful read can
report a failed command. Stop failures and incomplete logs are reported separately.
An optional `description` supplies the TUI summary while execution and permission
checks continue to use the original command.

## Skill directory links

Workspace `.agents/skills`, `.claude/skills`, and `.minimax/skills` support
directory symlinks, both for the entire skill root and for individual skill
directories. Targets may live outside the workspace. Existing external-source
enable settings and duplicate-name priority still apply. Linked directories are
watched for `SKILL.md` creation and edits; broken links are skipped. `SKILL.md`
itself must remain a regular file.

## ACP Skill commands

ACP clients receive enabled Skills alongside built-in slash commands when a session
is created, loaded, resumed, or forked. Discovery uses the session's Agent and
workspace, including installed plugin Skills. Command names come from the runtime
Skill roster (for example, `/review` or `/plugin:review`), not the installation
package name. Select a command and append instructions to invoke it through the
normal Agent turn. `/skills [filter]` lists the session's available Skills.

Built-in command names take priority over conflicting Skill names. Disabled,
duplicate, and invalid command names are omitted. If Skill discovery fails,
built-in commands remain available. Reopen the session after installing or enabling
Skills to refresh its command menu. Protocol tests cover command discovery and
prompt forwarding; this does not establish live Zed or model acceptance.

## Desktop boundary

Background workspace indexing is removed from this distribution. Runtime startup and conversation turns do not collect workspace snapshots, create workspace ZIP archives, or upload/retry them for cloud indexing. The semantic workspace search tool and its enablement policy are also removed; a saved indexing preference cannot reactivate them. Existing indexing records are left inert. User-directed file reading, search, and Git operations remain available.

Desktop features not enabled by default in the original TUI are outside this restoration commitment: remote encrypted prompt updates, cloud session handoff, and native Electron desktop control. Earlier descriptions incorrectly counted removal of those sources as TUI feature loss. Desktop HTTP services and internal generated IDL remain outside the public repository.

Website deployment tools and routes follow the original tool set. Successful deployment still depends on login, service permissions, and backend support; no real deployment has been performed.

## Release boundary

Production client paths are restored without internal registries or test-service addresses as build dependencies. Real account behavior, quota, billing, model quality, media generation, and deployment require separate acceptance. Mocks, protocol fixtures, successful builds, and the source import do not replace that evidence. Public npm `latest` was 0.4.12 on 2026-09-18; that metadata observation does not validate the installed package or deploy a backend. See [verification records](verification.md) and the historical [release audit](release-audit.md) for recorded acceptance results.

## Diagnostic upload privacy

Automatic LLM error reports use an allowlist before buffering and encryption. Schema 3 retains a numeric release version, the fixed metric error category, known error names/codes, HTTP statuses (100–599), and bounded error/cause/properties relationships. It excludes error messages, stacks, headers (including native `Headers`), prompts, request/model metadata, URLs, arbitrary property names/values, and binary data. Unknown event types are dropped; the event type and code location are fixed at the reporter boundary. Encryption remains a transport layer, not redaction. Authenticated transport still uses the signed-in account token and user ID.

The separate TUI incident reporter uses schema 2. It retains a fixed event category, phase/severity/impact, handled flag, generated IDs, timestamps, numeric release/Node versions, known platform/architecture, known error names/codes and HTTP status, and up to 20 fixed breadcrumb names with an optional phase. It excludes free-form error text, stack/cause/aggregate contents, caller context, component/operation labels, terminal/OS strings, and original code locations. Fingerprints are derived only from the minimized category and error facts, so grouping is intentionally coarser. Legacy schema-1 pending and sent files are deleted best-effort at startup and never uploaded; current-schema pending files are projected again before encryption and replaced with their minimized copy before being marked sent. The gateway wire encryption format is unchanged. Production ingestion of schema 2 has not been tested.

Feedback review describes the actual upload: user-reviewed feedback text, bounded client/platform and optional session metadata, and diagnostic **counts**, not original session files. Recognized credentials are redacted from the reviewed description; arbitrary personal text in that description is still sent, so review it before submitting.

Every collected diagnostic artifact, including prioritized session artifacts, is projected through `diagnostic-counts-v1`. The ZIP contains counts of known roles, states, error types/codes, log levels and HTTP statuses, plus parsing/omission indicators. JSON/JSONL can contribute these facts; malformed data, binary attachments and free-text logs contribute no raw content. Source filenames and paths are replaced with opaque archive names; only a small fixed list of artifact kinds (such as `messages.jsonl`) is retained. Unrelated session manifests are not collected. Local source files are unchanged.

There is no raw-attachment upload option in this flow. Prompts, conversation text, tool arguments/results, command output, workspace excerpts, raw errors and unknown fields are excluded even if they contain no recognizable credential pattern. This intentionally reduces diagnostic detail: reproducing an exact response or inspecting an original stack is not possible from these uploads. Future raw attachments would require a separate, explicit review and consent surface describing their contents and scope.

The regression tests use temporary synthetic files and intercepted HTTP only. They decrypt the final automatic-report request as a receiver would, and unzip the actual feedback PUT body after real session-report collection. They do not validate production ingestion of the new schemas, retention policies, live services, other telemetry paths or other platforms.


## Interactive startup model

Use `mcode -m <provider-id>/<model-id>` or
`mcode "Fix the failing tests" --model <provider-id>/<model-id>` to select the
model for the startup Session. References use the same syntax as `exec --model`,
including `custom_provider:<id>/<model-id>`, model IDs containing `/`, and the
optional `#variant` suffix. The provider must already be configured and the model
must be available to Runtime; invalid references fail before the initial prompt runs.

Without a resume option, this creates a new Session even when no prompt is given.
With `--session <id>` or `--continue`, it updates the opened Session's model before
submitting the prompt. The selection is saved with that Session, so later turns
and resumes keep it. It does not change the global default, and `/new` returns to
the configured default. Omitting `--model` preserves existing startup behavior.
The untargeted `--session` picker cannot be combined with `--model`; provide an ID
or use `--continue` instead. If opening or continuing a Session fails, the override
and initial prompt are not applied.

## Feature panels and chat restoration

In regular mode, independent feature panels occupy the complete visible terminal
area, including short Rewind previews and scope pickers. Closing a panel restores
the current conversation. Closing, replacing or shrinking a transient region
restores the exposed chat rows. This includes inline selectors such as `/theme`,
completion menus, multi-line drafts, image previews, queued messages, task and
Goal summaries, welcome notices and status rows. Short documents refresh in place;
history is reconstructed only when the smaller layout needs to bring scrolled
rows back into view. This rule follows the rendered layout, including asynchronous
updates, rather than requiring each close handler to request a special redraw.
When background running content shrinks entirely within the current screen and
the transient layout stays unchanged, the renderer keeps native scrollback and
the Composer position stable.
Freed rows temporarily remain blank at the top of the active screen and subsequent
output reuses them. This avoids resetting the host's scroll position when a turn
finishes. Redundant resize notifications with unchanged dimensions do not rebuild
history. Viewport-only redraws erase rows in place so terminals that save a cleared
screen to scrollback, including Apple Terminal, do not retain the old Composer,
status line or duplicate transcript rows.

When a change removes or replaces text already in scrollback, the renderer still
reconstructs the current session to avoid stale or duplicate history. Real resizes
and image layout changes also retain the existing reconstruction behavior. A
reconstruction clears earlier shell scrollback and can reset the host's scroll
position; ordinary updates keep native scrolling and selection behavior.

Rewind and Fork history-loading hints disappear as soon as their lists are ready.
Returning from a cancelled operation must not leave a stale loading message in the
Composer. Rewind displays its completed result after a successful operation.

## Temporary side conversations

Use `/btw [question]` (or `/side [question]`) to open a temporary side conversation
while the main task continues. The side conversation inherits the latest complete
prefix of persisted history. Completed tool calls retain all their results; an
unfinished group of tool calls is excluded together. The selected boundary is
fixed before creation, so later main-task output does not change that fork.
Inherited tool calls are context and are not executed again.

Press `Ctrl+/` to switch between the main and side views, or `/parent` to return
to the main view. Press `Ctrl+C` on an empty Composer to discard the side
conversation. Side conversations retain the main session's permission mode and
remain hidden from `/sessions` and `/resume`.

Creation and activation failures record a bounded, redacted cause chain in the
local `session.side.failed` diagnostic event. Feedback uploads still apply the
existing diagnostic-counts projection; raw error text, stacks and session IDs
are not added to the uploaded ZIP. Offline tests cover persisted tool histories,
archives, concurrent parent output, side-session cleanup and local diagnostics;
this does not establish native-terminal or live-model acceptance.

## Select a plugin for a message

Type `@` in the Composer to search files and installed, enabled plugins. Plugin
candidates show their source so packages with the same display name can be
selected independently. Choose a plugin with Tab or Enter, then describe the task.
The Composer shows `@Name` and retains the plugin identity through editing, undo,
prompt history, queued-message recovery, saved drafts, and `/edit` after a
message is sent. Ctrl+C clearing/restoration and external-editor edits retain
unchanged plugin bindings. If external edits make duplicate labels ambiguous,
reselect those plugins in the Composer. Displayed messages remain readable; Runtime retains
the original input separately when needed to recover the plugin identity for editing.

Selection applies to that message. Runtime checks the plugin's effective Skills,
MCP tools, and App tools again for the turn and asks the Agent to prefer relevant
capabilities. Selecting a plugin does not install or enable it. An unavailable
selection is reported to the Agent rather than redirected to a same-named package.

Exec and ACP text prompts can use the durable linked form, for example
`[@Notes](plugin://notes%40local) summarize these files`. The ID is the package
name plus its `local` or `official` source; display labels do not determine the
selection. Legacy whitespace-delimited `@package-name` text remains supported
when it identifies exactly one effective plugin.
