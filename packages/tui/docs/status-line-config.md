# Status line configuration

Use `/statusline` or the configuration file to choose **which items appear** and **their order** in the bottom TUI status line. There is one build and one item catalog. The `[V]` machine-readable protocol is enabled only by the `build-mode` configuration item, regardless of build type. Ordinary items follow list order; `build-mode` reserves the entire status line for its machine contract.

## Quick setup

Open `/statusline` to configure ordinary items:

- Use `↑` / `↓` to select, `Space` to toggle, and `←` / `→` to reorder.
- Type to search IDs or descriptions. Reordering is unavailable during search; clear the query to restore it.
- `Ctrl+R` restores defaults. `Enter` saves and applies immediately. `Esc` / `Ctrl+C` discards the draft.
- The preview uses actual status data and the same narrow-terminal fitting rules. Unavailable items are labeled; no quota or usage data is invented.
- Saving with every item deselected writes `[]` and hides the line. Saving restored defaults removes `tui.statusLine`, preserving conditional default behavior.
- Wait for a save to finish. On write failure, the original file and current line remain; the panel retains the draft for retry.
- Both regular and fullscreen modes adapt the panel to available height. Small windows prioritize search, the selected option, and save / cancel hints.
- The panel is unavailable during pending permission / question interactions and in side sessions. It may open during ordinary execution without sending a model request.

The panel manages ordinary items only. For automation, edit the current profile's `config.yaml` (default in this distribution: `~/.minimax/config.yaml`):

```yaml
tui:
  statusLine:
    - build-mode
```

Restart mcode after saving to enable the `[V]` line. `build-mode` is not in the ordinary selector. When enabled, the panel only explains how to edit configuration and restart; it does not switch the machine protocol or result channel.

## Configuration location

- File: `config.yaml` in the runtime data directory, normally `~/.minimax/config.yaml`.
- Key: `tui.statusLine`, a **string array** of item IDs.
- List order is display order, left to right. Items not listed are hidden.

| Configuration | Behavior |
| --- | --- |
| Missing `tui.statusLine` | Ordinary defaults, **without** `build-mode` |
| Empty array `[]` | Empty status line; no default fallback |
| Unknown ID | Silently ignored; recognized items still render |
| Duplicate ID | First occurrence wins |
| Includes `build-mode` | `[V]` exclusively owns the line; other configured items do not render |
| Missing, damaged, or unreadable config | Silent default fallback; TUI startup is not blocked |

Configuration loading checks that the value is an array. The TUI validates individual IDs, so one typo does not invalidate the entire line.

## Available items

| Item ID | Display |
| --- | --- |
| `build-mode` | Exclusive, opt-in machine-readable agent status (`[V]`) |
| `current-dir` | Current working directory |
| `session-title` | Session title |
| `git-branch` | Current Git branch |
| `review-link` | GitHub PR / GitLab MR associated with the branch |
| `plan-mode` | Plan mode state |
| `approval-mode` | Permission / approval mode |
| `model-with-reasoning` | Model and reasoning level |
| `model` | Model only |
| `context-window` | Configured context capacity before usage is available |
| `subagent` | Subagent indicator |
| `token-quota` | Token quota / plan |
| `cache-read-ratio` | Aggregate cache read ratio for the current session, such as `Cache 80%` |
| `context-remaining` | Remaining context percentage from the same runtime snapshot as `/context`; hidden if unavailable |
| `custom-command` | External command stdout; first line inline by default, optional separate multiline block; opt-in |

`cache-read-ratio` aggregates persisted session usage as `cacheRead / (input + cacheRead + cacheWrite)`, where `input` is fresh uncached input. It uses existing provider usage fields; missing cache counts contribute zero, so sessions mixing providers can underestimate cache reads. The item is hidden before any prompt tokens exist. In-process notifications refresh the session after usage persists; read failures stay silent. `/usage` also shows Read, Fresh, and Write token counts.

### Aliases

| Alias | Canonical ID |
| --- | --- |
| `status-protocol` / `vela` | `build-mode` |
| `workspace` / `cwd` / `project-dir` | `current-dir` |
| `git` / `branch` | `git-branch` |
| `pr` / `mr` / `pull-request` / `merge-request` / `review` | `review-link` |
| `permissions` / `permission-mode` | `approval-mode` |
| `model-with-thinking` / `identity` | `model-with-reasoning` |
| `sub-agent` | `subagent` |
| `quota` / `token-plan` | `token-quota` |
| `cache-read` | `cache-read-ratio` |
| `context` / `context-left` | `context-remaining` |
| `custom` | `custom-command` |

## Defaults

Without `tui.statusLine`, items render in this order:

```text
current-dir · session-title · git-branch · review-link · plan-mode · approval-mode · model-with-reasoning · context-window · subagent · token-quota · context-remaining
```

`build-mode` is **not a default**. Explicitly listing it is the only way to enable the machine-readable protocol; the build type does not matter. It may appear anywhere in the list and takes over the entire line to keep free text out of the strict record. Remove it to disable the protocol.

By default, `context-window` shows capacity before usage is available; `context-remaining` replaces it once a runtime usage snapshot exists. Explicit item lists retain the selected presentation. Session changes clear old data, and refresh failures do not reuse stale values. Context comes from the latest runtime snapshot, not a live per-token counter. `cache-read-ratio` remains opt-in. Narrow terminals prioritize permissions, context warnings, model, and session title. Even the shortest context display retains `Ctx` to distinguish it from `5h` / `W` plan quotas.

`custom-command` is also **not a default**. It runs an external command and requires both an explicit item and `tui.customStatusLine.command`.

## Custom command extension

Each trigger executes `tui.customStatusLine.command`, passes current context as stdin JSON, and displays stdout. Scripts may report sessions, environments, builds, tasks, or independently queried costs. The TUI does not interpret these business fields or introduce a billing, usage, or hook event system.

The default `display: inline` uses **only the first stdout line** as an ordinary status item, including narrow-terminal fitting and dropping. Existing configurations need no migration:

```yaml
tui:
  statusLine:
    - current-dir
    - git-branch
    - custom-command
  customStatusLine:
    command: my-status-probe # Required; same tokenization as externalEditorCommand.
    timeoutMs: 5000 # Optional; default 5000, clamped to 500–30000.
    intervalSeconds: 0 # Optional; default 0 (events only); positive values have a 10-second minimum.
```

### Separate multiline block

Set `display: block` to show custom output above the ordinary status line, or `position: below` to place it underneath. The custom item no longer occupies an inline segment; other items retain their order, content, and fitting behavior.

`maxLines` defaults to 3, is rounded down, and is clamped to 1–5. Even 1 remains a separate block. Unknown `display` values fall back to inline; `maxLines` alone does not enable multiline display. `position` accepts `above` / `below`, defaults to `above` for missing or unknown values, and is ignored inline.

Append `custom-command` to your existing item list, then configure:

```yaml
tui:
  # Preserve ordinary items; append custom-command to your own list if already configured.
  statusLine:
    - current-dir
    - session-title
    - git-branch
    - review-link
    - plan-mode
    - approval-mode
    - model-with-reasoning
    - subagent
    - token-quota
    - context-remaining
    - custom-command
  customStatusLine:
    command: node "/absolute/path/status.mjs"
    display: block
    position: above # Optional; below places output beneath the ordinary line.
    colorMode: plain # Optional; ansi permits script-provided colors.
    maxLines: 2
    timeoutMs: 5000
    intervalSeconds: 15
```

Example `status.mjs`:

```js
import { readFileSync } from 'node:fs';

const status = JSON.parse(readFileSync(0, 'utf8'));
console.log(`Session: ${status.session_title ?? status.session_id ?? 'none selected'}`);
console.log(`Model: ${status.model ?? 'loading'} | Workspace: ${status.workspace_dir}`);
```

Display structure:

```text
Session: Fix the build
Model: MiniMax-M3 | Workspace: /path/to/workspace
Ordinary status line: directory | branch | permissions | model | ...
```

With `position: below`, the ordinary line appears first, followed by custom output.

Lines split on LF / CRLF, lose surrounding whitespace, and omit empty lines. Lines beyond `maxLines` are discarded; each line truncates to available terminal width without wrapping. Both regular and fullscreen modes reserve room for input, interactions, and the ordinary line first. They reduce or hide custom lines when height is insufficient and restore cached content when space returns. Script output never enters the conversation transcript.

**`build-mode` overrides the entire extension.** Even with `display: block`, `position: below`, `colorMode: ansi`, `maxLines: 5`, and `custom-command`, no command runs and no custom lines appear. Only the existing ANSI-free `[V]` contract remains. A command configuration alone has no effect if `tui.statusLine` is absent, empty, or does not include `custom-command`.

### Script colors

`colorMode` accepts `plain` / `ansi`. Missing, unknown, or `plain` values keep gray plain text. `ansi` permits script foreground and background colors in both inline and block modes. Colors come from stdout; scripts may query APIs, read caches, and construct their own output without TUI-defined progress bars or business fields.

For example, point `command` at this script with `display: block`, `position: below`, and `colorMode: ansi`. Percentages below are demonstration values only:

```sh
#!/bin/sh
printf '5-hour quota [\033[32m████████\033[90m░░\033[0m] 79%% left\n'
printf 'Weekly quota [\033[32m█████████\033[90m░\033[0m] 86%% left\n'
```

Allowed ANSI SGR uses semicolon parameters: normal / bright 16-color foreground and background (30–37, 40–47, 90–97, 100–107), 256 colors (`38;5;n` / `48;5;n`), RGB (`38;2;r;g;b` / `48;2;r;g;b`), and resets (0, 39, 49). Color components must be 0–255. An entire SGR is dropped if it mixes unsupported attributes such as bold, blink, or conceal, or has invalid color parameters. Cursor movement, screen clearing, titles, hyperlinks, clipboard operations, and other terminal controls are always filtered.

Lines inherit colors left active by the previous line. Each rendered line / inline segment resets colors after truncation to protect separators, the ordinary line, input, and padding. Width uses terminal columns; ANSI sequences occupy none. Disabled terminal colors, such as `NO_COLOR`, force plain text. Actual palette and RGB appearance depend on terminal capabilities.

### Triggers

The stdin JSON `event` identifies the trigger:

| Event | Trigger |
| --- | --- |
| `startup` | TUI startup |
| `turn-end` | A turn ends: busy → idle |
| `session-change` | Active session changes; clear cached output first |
| `workspace-change` | Working directory changes; clear cached output first |
| `interval` | Periodic refresh configured by `intervalSeconds` |

Commands run serially. New triggers during execution coalesce into **one** trailing rerun using the latest event rather than queueing. A timeout settles the run, closes pipes, and attempts to terminate the process tree. Subsequent refreshes do not wait indefinitely for `close`, even if the command ignores termination or a descendant holds stdout. POSIX uses a separate process group; Windows uses `taskkill /T /F`, falling back to termination of the root process when unavailable.

### stdin protocol 1

The command receives one JSON line. Fields use snake_case; unavailable context fields are omitted:

```json
{
  "protocol": 1,
  "event": "turn-end",
  "session_id": "…",
  "workspace_dir": "/path/to/workspace",
  "model": "…",
  "session_title": "…",
  "tui_version": "0.5.0"
}
```

A command may ignore stdin. stdout is accepted only after exit code `0` without a timeout; successful empty output hides the extension. This is an independent status-command protocol. Adapt existing scripts to these fields; another tool's hooks configuration is not imported automatically.

### Behavior

| Condition | Result |
| --- | --- |
| Success, exit 0 | First line inline, configured lines in block mode; empty output hides the extension |
| Failure, timeout, or launch error | **Keep the last successful value** without flicker or an error message |
| Session / workspace changes | Clear old output, discard late results from earlier runs, display after rerun |
| List includes `build-mode` | Exclusive `[V]`; **no command execution** or multiline block |
| Missing `customStatusLine.command` | Silently hide the custom item |
| Command parse error, such as unmatched quotes | Disable the item; TUI starts normally |
| stdout exceeds 8192 UTF-16 code units | Discard overflow; separate line-count and width limits still apply |

### Limits and security

- Tokenization follows `externalEditorCommand`. POSIX runs **without a shell**, so wrap pipes / redirection in a script. Windows starts through a shell. Quote paths containing spaces.
- Output colors are stripped unless `colorMode: ansi` allows the color sequences above. Terminal controls are always filtered.
- Configuration is read only from data-directory `config.yaml`, with the same trust level as `externalEditorCommand`; project-level configuration is unsupported.
- Inline width is limited to approximately 60 columns, shrinking to 24 / 12 in narrow terminals. Blocks use available content width.

## Composer tips

- Tips appear at the right of the idle conversation's composer title row. They do not enter the status line, add footer rows, or persist in sessions, runtime, or transcripts.
- Copy comes from a bundled read-only i18n catalog, selecting `en` or `zh-Hans` with the TUI locale; no network fetch.
- A deterministic selection changes every 30-second time bucket, using existing redraws rather than a dedicated timer. An idle terminal does not redraw merely to rotate tips; the next normal redraw selects the current bucket.
- Left-side composer mode and action hints remain stable. Prefer a full tip, then a short version, then hide it if space is insufficient.
- Welcome, active execution, follow-ups, goals, permission / question interactions, attachments, nonempty drafts, and temporary hints take precedence and suppress tips.
- Tips are enabled by default. Disable them in `~/.minimax/config.yaml`:

```yaml
tui:
  showTips: false
```

## `[V]` machine-readable format

The `build-mode` line is a stable automation protocol, for example for systems that inspect terminal output to determine turn state:

```text
[V] seq=<base36> state=<state> session=<ref|none> turn=<ref|none> request=<ref|none> agents=<active>/<total>
```

- **Fixed key order; no ANSI anywhere in the line.** Parse keys rather than guessing by position. Fail closed on unknown states or missing fields.
- **`seq`**: a base36 sequence incremented within the session when machine-readable semantics change. It detects state transitions; it is not a runtime turn ID.
- **Three refs**: `session`, `turn`, and `request` are six-character lowercase base36 opaque tokens or `none`. They map stably from internal IDs, cannot be reversed, and do not expose full runtime IDs.
- **`agents`**: unsettled delegated members and total members of the current root session. `queued`, `running`, and `waiting` count as active. Completed background agents remain active until their parent session's delivery turn is persisted. Counts are bounded to 0–9999. This does not change the root turn's canonical `state`; consumers requiring the final parent report may keep waiting for `active=0` after a terminal turn state.
- **`state`**: one of `ready`, `run`, `perm`, `ask`, `plan`, `done`, `fail`, `cancel`, `error`. Publish `ready` only when SSE is live and a structured snapshot confirms no active / retiring / queued turn or pending interaction. Startup, loading, reconnecting, retrying, compaction, stopping, and interaction submission project to `run`.
- **Waiting for input**: `perm`, `ask`, and `plan` are stable actionable states and require both `turn` and `request`. Submission immediately returns to `run` and clears `request`; no transient `_submit` state is published.
- **Terminal states**: `done`, `fail`, and `cancel` are canonical outcomes of a specific turn and require a non-`none` `turn`. Runtime `blocked` maps to `fail`; `ExecResultV1.status` retains the exact `blocked` result.
- **Fatal errors**: `error` always uses `turn=none request=none` for errors not attributable to the current turn, such as login blocks or invalid interactions. Consumers should fail immediately. It persists until session reset or process recovery. Recoverable reconnect / history-refresh failures and turn errors without canonical settlement remain `run`.
- **Single source of truth**: Automation Status Store uses only structured runtime / controller facts. It does not read human-facing activity phases, assistant text, or transcripts, or infer completion from spinners / idle labels.
- **Read-only status line**: consumers must not infer interaction states from pane content, popup copy, or transcripts.

Agent counts use a `sessionId`-keyed Map / Set, not stack push / pop operations. Delegation snapshots restore and replace the full state; global runtime SSE events trigger idempotent updates / refreshes. Settled members leave active but remain in total. Duplicate, out-of-order, or missing events therefore cannot permanently corrupt counts; reconnect snapshots reconcile them.

Examples, with explanatory comments after each record:

```text
[V] seq=c state=run session=3j5p7m turn=0a1b2c request=none agents=2/3       ← Turn running
[V] seq=d state=perm session=3j5p7m turn=0a1b2c request=4d5e6f agents=2/3   ← Waiting for permission
[V] seq=e state=run session=3j5p7m turn=0a1b2c request=none agents=2/3      ← Decision submitted; awaiting runtime confirmation
[V] seq=f state=done session=3j5p7m turn=0a1b2c request=none agents=1/3     ← Root turn succeeded; agents or reports remain unsettled
[V] seq=g state=fail session=3j5p7m turn=0a1b2c request=none agents=1/3     ← Failed or blocked; read the side channel for the exact result
[V] seq=h state=error session=3j5p7m turn=none request=none agents=0/3      ← Fatal error not tied to a turn
```

The full record, with an eight-character `seq`, longest state `cancel`, three refs, and four-digit agent counts, requires **86 columns**. Automation and evaluation tmux panes must provide at least 86 columns. Below this width, generic TUI fitting may truncate the record; reject incomplete records instead of guessing. The default Ludus pane is wider than this requirement.

## Applying changes

- A successful `/statusline` save applies immediately. Only the current profile's `tui.statusLine` changes; other fields remain. If `config.yaml` is a symlink, its real target is atomically updated while preserving the link. YAML is reserialized, so comment formatting is not retained.
- Manual edits to `config.yaml` require restart; external file changes are not watched.
- Git metadata polling starts only when `git-branch` or `review-link` is selected. It runs every 10 seconds and refreshes immediately on workspace changes or turn end. Hiding those items stops polling and discards late results; enabling them queries immediately.
- Preview does not query Git or run commands. `custom-command` previews cached successful output and executes only after it is enabled and saved. Disabling clears cached output, stops future triggers, and discards late results; an already-running process finishes under its original timeout. Rapid re-enabling still waits for that process, preserving at most one execution at a time.

## Notes

The panel does not edit command contents or introduce new metric definitions; use `tui.customStatusLine` for command configuration. Ordinary status items shrink or drop in narrow terminals. The `[V]` record requires at least 86 columns and has no parseability guarantee below that width.
