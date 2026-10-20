# MCode TUI Changelog

This changelog covers important changes that directly affect MCode TUI users. It includes:

- Features, interactions, display, compatibility, installation, and updates in the TUI itself.
- Shared Runtime, Agent, Tool, and Skill changes that alter TUI behavior.

Internal refactors, test-only changes, and changes limited to other product surfaces are excluded.

## 0.6.5 · 2026-10-09

### Fixed

- The output-speed readout no longer spikes at the start of a turn. Output buffered upstream and
  released in one burst is now excluded, so a burst arriving within the first tenth of the request
  no longer reports a rate far above what the model actually produced.

## 0.6.4 · 2026-10-08

### Fixed

- While you are scrolled back through a long conversation, output that changes or removes text
  already in terminal scrollback no longer moves the viewport to the top of the session. Without
  recent input, the screen repaints in place and the full history rebuild waits for your next
  keystroke; readers following the latest output stay at the bottom.
- Settled one-time feedback, such as the previous run's duration note, finished `!` shell blocks,
  and earlier run errors, now stays in the transcript once later output follows it instead of being
  removed from the middle of the conversation, so later rows no longer shift.
- `cron once --after` accepts `w` (weeks), alone or combined with other units such as `1w2d`.

## 0.6.3 · 2026-10-08

### Added

- Customize the main Agent's system prompt at startup with `--system-prompt` or
  `--system-prompt-file`, or extend it with `--append-system-prompt` or
  `--append-system-prompt-file`. Available in the interactive TUI, `exec`, `exec review`, and ACP.
- Replacement and appended prompts can be combined. They apply only to the current process, preserve
  runtime rules and project instructions, and do not affect Task child Agents. A missing or empty
  prompt file stops the launch instead of running without it.
- Start a new Session in lightweight conversation mode with `--mode lightweight`. It sends a small
  conversational system prompt and no tool schemas, and omits workspace instructions, Skills, memory
  blocks, and MCP schemas, so it cannot inspect or change local files. The mode is fixed when a root
  Session is created and cannot be combined with `--session` or `--continue`; child Agents,
  `/compact`, and ACP stay on the standard context. Reopening a lightweight Session keeps its mode
  and shows `Lightweight` in the status line.
- Each model request attempt now has a first-response bound and a stream idle bound, both 300
  seconds by default. A request that passes a bound is aborted and reported as a retryable timeout,
  so the normal model-request retry runs instead of the turn waiting on a provider that never
  answers. Override the bounds with `MCODE_LLM_FIRST_EVENT_TIMEOUT_MS` and
  `MCODE_LLM_STREAM_IDLE_TIMEOUT_MS`, where `0` disables a bound.

### Improved

- A single model request carries at most 20 images by default. Older images in the request are
  replaced with a text note while the stored history keeps every image, and a provider that allows
  fewer images per request can set `max_images_per_request` on the model (`api.mistral.ai` defaults
  to 8). When compaction is rejected for too many images, it retries with attachments replaced by
  text.
- Deterministic provider rejections, such as an image limit or an HTTP 400 `invalid_request_error`,
  are now reported immediately with the upstream reason instead of being retried, and suggest
  `/compact` or `/new` instead of `/retry`.

### Fixed

- While you are scrolled back, output that shrinks the layout, such as a task list collapsing when a
  reply ends, no longer moves the viewport to the top of the session. The released rows are padded
  and the history rebuild waits for your next keystroke.
- After the agent asks you a question, the turn now waits for your answer instead of ending as a
  retryable empty-response failure.
- `/retry` during a running response now says to stop the running turn first, instead of reporting
  that there is no failed response to retry.
- Clearing or pausing a Goal while a response is still running now says that the current response
  keeps running and to press Esc to interrupt it, instead of implying the turn already stopped.

## 0.6.2 · 2026-10-02

### Fixed

- In a `/btw` side session, pressing Esc on an empty Composer no longer suggests editing the latest
  message; `/edit` is unavailable there.
- Switching between a side session and the main conversation no longer resets the main run's
  Running/Loading timer to zero.

## 0.6.1 · 2026-10-01

### Added

- `/doctor` and `/feedback` now work inside a `/btw` side session, so you can diagnose or report a
  failed side response without leaving it.

## 0.6.0 · 2026-10-01

### Added

- `/retry` now works inside a `/btw` side session. When a side-session model request fails and can
  be retried, run `/retry` there to resend the side session's last message without switching back to
  the main conversation.

### Improved

- The official default model is now `MiniMax-M3.1-Flash-Preview` when no model has been selected.
- When a Goal is marked complete, the agent now ends with one final reply that summarizes what was
  done and where the deliverables are, instead of stopping right after the status update.
- Safety refusals from the model provider are no longer retried, including on BYOK. The original
  error is shown and identified as a refusal from the model provider.
- TLS record verification errors during a model request now trigger the automatic retry like other
  transient network failures.

### Fixed

- In regular mode, the screen no longer jumps back to the opening logo and replays the whole
  conversation while a run is in progress. Rows that can still change stay on screen above the
  footer until they are final.
- The `tok/s` speed is no longer inflated when the provider hides thinking text; generation time now
  starts when thinking starts.
- Fixed repeated failures after context compaction during an automatic continuation.
- Context compaction through OpenAI-compatible Chat Completions providers no longer sends an empty
  `tools` list, which some backends rejected with HTTP 400.

## 0.5.10 · 2026-09-30

### Fixed

- Your own messages now appear exactly as typed in the conversation, pending instructions, and the
  transcript viewer. Text such as `__pycache__`, `*`, and a leading `>` is no longer reformatted as
  Markdown, and trailing blank lines no longer add empty rows.
- The TUI no longer stays stuck showing a run as in progress after Runtime has already finished it.
  Enter now sends a new message instead of steering the finished run, and queued messages are no
  longer held back.

## 0.5.9 · 2026-09-30

### Added

- The build-mode status line now reports `background=N`, the number of active background tasks in
  the current root session. Bash still owned by its foreground tool call is not counted, and the
  count holds at `1` after a turn settles until a fresh task list arrives, so a command that has
  just moved to the background is not reported as `0`.
- `worktreeRefreshBeforeCreate` in `config.yaml`, on by default, fetches the selected upstream
  before a new worktree is created.
- The OpenAI Codex OAuth entry in model settings is enabled by default; set `beta.codexOAuth: false`
  to hide it.

### Improved

- BYOK requests now apply byte limits to large media and accumulated history context, reducing
  failures caused by oversized requests.
- Long conversations load their file list and history navigation with less data, making browsing
  them faster.
- The MiniMax API-key route now uses the same official model catalog as the signed-in route.

### Fixed

- Stopping a conversation with Esc also cancels the background Bash commands and subagents it owns,
  and their completion notices no longer restart the conversation. Their results stay available to
  the next turn. Switching sessions and `/clear` continue to leave background work running.
- Editing and rewinding a message now works after an interrupt that left only a background reminder
  behind.
- Terminal errors from a failed run are cleared when the next run starts, so a successful retry no
  longer shows the earlier error again.
- The thinking toggle for M3 models is sent as a thinking setting instead of a generic reasoning
  effort.

## 0.5.8 · 2026-09-28

### Added

- Added M3.1-Flash-Preview to the built-in fallback model catalog.

### Improved

- Plugin Hook messages appear in the active conversation and restored history, making Hook results
  visible without adding them to model context.

### Fixed

- Restoring a session with `--session` or `--continue` clears terminal scrollback left by the
  previous process before replaying history, avoiding duplicate content. Normal startup preserves
  shell history.
- Improved output queuing on slow terminals and waits for pending output before exiting, suspending,
  or opening an external editor.

## 0.5.6 · 2026-09-28

### Added

- Custom provider setup can import models from `/models` with the API key entered during setup.
  Search and select a model, then save the imported models after a successful connection test; retry
  discovery or enter a model ID manually when needed.

### Fixed

- Token speed now uses actual provider output tokens and the generation window, excluding the wait
  for the first token and tool execution. Streaming text estimates are no longer shown; confirmed
  speed remains visible while waiting for subsequent requests or tools.
- History reloads preserve generation timing. Older messages without timing are excluded from speed
  statistics, and speeds below 10 token/s retain one decimal place.
- Bash tool descriptions are displayed as plain text instead of receiving shell command syntax
  highlighting; actual commands retain syntax highlighting.

## 0.5.5 · 2026-09-27

### Added

- Terminal titles show the current state, session name, and MCode, for example
  `Needs approval | Fix login | MCode`, and follow session renames and switches. Notifications for
  completed turns, failures, permission requests, and questions identify the session and suppress
  duplicates; completion waits for the session's queue to finish. Configure them with
  `tui.terminalTitle` and `tui.notifications` in `config.yaml`.

### Improved

- Bash commands that automatically move to the background now have a one-hour default and maximum
  total timeout. Explicit background tasks also default to one hour when no timeout is specified.
  Foreground calls may return a task ID after 60 seconds without resetting the command timer.
- Reduced the dependencies loaded at startup to keep the startup bundle smaller.
- Improved automatic context compaction reliability: large-context models reserve room for replies
  and start compacting earlier, and adaptive-thinking models at high reasoning effort no longer fail
  repeatedly when reasoning consumes the output budget.
- Update downloads follow the same proxy settings as the TUI.
- Memory tool results shown to the model are limited to 16 KiB, with a preview of the beginning and
  end and guidance for reading more.
- Long sessions repeat less work when indexing and replaying history.

## 0.5.4 · 2026-09-24

### Added

- Press `Ctrl+S` in `/model` to add or remove a favorite. Favorites appear in a separate group at
  the top, retain their insertion order, and persist across sessions.

### Fixed

- Scrolling back through chat remains detached from the latest output when the viewport grows or
  content and the footer shrink.

## 0.5.3 · 2026-09-24

### Added

- Type `@` to select an installed Plugin. Its source identity is preserved when sending, queueing,
  restoring drafts, and editing history, so plugins with the same name cannot replace one another.

### Improved

- Bash tools describe the selected shell and the current turn's background capabilities. Managed
  foreground commands wait up to 60 seconds before returning a task ID, with one command deadline
  covering foreground and background execution.
- Large Bash results preserve the beginning and end of the output, report process outcomes and
  output persistence separately, and keep task receipts bounded.
- `/theme` uses the left and right arrow keys to select light, automatic, or dark appearance. Custom
  theme watching reconciles once at startup to catch edits that could otherwise be missed.
- Workspace Skill directories (`.agents/skills`, `.claude/skills`, and `.minimax/skills`) support
  symbolic links to other locations and watch linked directories for additions and changes.

### Fixed

- Pressing `Esc` before the model has produced an answer or used a tool restores the submitted
  message to the composer, preserving attachments and text entered while stopping.
- Closing autocomplete, history search, settings, or multiline input restores the released chat area
  correctly. Reading earlier messages keeps your position while output arrives, and sending a
  message resumes following the latest output.
- Editing or rewinding history clears todos from discarded turns and stale duration indicators.
  Entering the complete `/rewind` command while editing still runs the local command.
- Large-file edit previews now bound diff size and computation time. Omitted previews show a clear
  notice instead of incorrectly reporting no changes.
- Goal tool calls outside a bound Goal turn return a recoverable error without ending the user turn.
- Windows managed updates validate the installed package through its Node entry point, including
  installation paths containing spaces and shell metacharacters.

## 0.5.2 · 2026-09-22

### Added

- `/theme` opens a theme panel with live preview. Pick from the built-in `minimax`, `midnight`,
  `graphite`, and `aurora` themes, or write your own theme file under `tui/themes/*.json`. Each
  theme provides both a dark and a light palette, and the appearance follows your terminal's
  background until you lock it to light or dark.
- Custom theme files support partial overrides, color aliases, syntax palettes, and hot reload, so
  editing a theme you are already using takes effect without restarting MCode.
- The theme choice is stored in `tui/tui-settings.json` alongside `tuiMode` and can also be set as
  `<theme-id>/light` or `<theme-id>/dark` to pin one appearance. An unrecognized value falls back to
  the default theme instead of blocking startup.

### Improved

- Long conversations stay responsive by reusing verified history and loading less at runtime.
- A failed optional Provider preset sync no longer blocks startup as long as the existing
  configuration stays intact.

### Fixed

- Fixed the transcript jumping back to the start of a conversation when a long turn ended after you
  had scrolled up. Previously visible content now stays in place and the composer remains at the
  bottom.
- Fixed style-only redraws leaving a stale composer, status bar, or duplicated body text behind in
  Apple Terminal. Visible-region repaints now erase in place instead of scrolling old lines into the
  terminal's native scrollback.
- Fixed failed commands being reported as successful when Bash ran through the Windows PowerShell
  wrapper; the native exit code is now preserved.
- Attachment paths are resolved automatically in WSL, so Windows drive letters, UNC paths, and
  `file://` URLs can be attached directly.
- Rewriting private configuration files on Windows no longer interrupts startup.
- Session history writes that wait on a busy store are retried, and stopping a turn while a write
  waits keeps the turn's stopped state.

## 0.5.1 · 2026-09-21

### Improved

- Reduced repeated history processing and token estimation in long conversations.
- Provider setup now displays the Base URL and supports editing it with `ctrl+e` before testing.
  Failed connection tests clearly indicate that changes were not saved. The Z.AI and Zhipu presets
  label their Coding Plan and API endpoints separately.

### Fixed

- Fixed `/btw` side conversations failing to open while tools are running.
- Fixed multiline text pasted by terminals without bracketed-paste framing being submitted line by
  line.
- Kept the input method candidate window anchored to the composer during redraws, including on
  Windows terminals, and prevented stale history rows after content changes.
- Local sessions using custom providers or API keys no longer require a managed login for title
  handling, and the welcome screen no longer asks you to sign in when the selected custom provider
  does not need a MiniMax account.
- Token estimates for Z.AI and Zhipu Coding Plan endpoints no longer fall back to a local
  approximation after a failed token-count request.
- Memory edits containing `$&`, `$$`, or similar sequences are inserted literally.

## 0.5.0 · 2026-09-20

### Added

- Interactive sessions support `mcode -m <provider/model>` to select a model for that session.
- Provider setup supports explicit context and output limits, image input capability
  (`--support-image`), and testing before saving with `--use`.
- ACP clients can discover enabled Skills for the attached session's Agent and workspace alongside
  native slash commands.
- Fullscreen Transcript supports clicking and dragging the scrollbar. An optional `context-meter`
  status line item shows remaining context capacity.
- Each GitHub Release includes a versioned npm installation archive, `minimax-code-X.Y.Z.tar.gz`,
  with a `.sha256` checksum.

### Improved

- Reduced repeated history processing and token estimation during long conversations.
- Provider presets import their explicit reasoning effort options.
- Source builds now use `~/.minimax` as the default data directory, the same as the published npm
  CLI. Data in the earlier `~/.minimax-code` default is not moved; set `MINIMAX_DATA_DIR` to keep
  using it.
- Automatic metrics and diagnostics uploads are off by default and require their own consent; global
  opt-outs are honored.

### Fixed

- Preserved terminal scrollback during redraws and kept collapsed thinking summaries and the
  composer visible when content shrinks.
- Settings updates now reject malformed configuration files without overwriting their contents.
- Invalid attachment markup is removed from assistant messages even when no valid attachment
  remains, and path-based attachments no longer show duplicate placeholders.
- Thinking-enabled custom connections to Mistral, SiliconFlow, DashScope, and Kimi Coding send the
  system prompt with a role those endpoints accept.
- Resource files of built-in and active-Agent Skills can be read in every permission mode.
- Content review failures are reported as such instead of as connectivity problems.
- Context usage is recalculated after compaction instead of showing the pre-compaction value.
- Bash deny and ask rules also match commands prefixed by transparent wrappers such as `nohup` or
  `timeout`.
- Terminal control sequences in model output are sanitized before display, and reading MCode's
  private runtime data requires approval.
- Configuration files that can hold credentials are restricted to owner access.
- `replace_all` edits keep literal `$` sequences.
- Session diffs report renamed files under their destination path and keep Unicode paths.
- A blank `NO_PROXY` falls back to `no_proxy`, and updates work when npm is provided through a pnpm
  shell shim.

## 0.4.12 · 2026-09-18

### Improved

- The default status line shows context capacity before usage is available, then switches to the
  remaining percentage as usage updates, avoiding duplicate context indicators.

### Fixed

- Terminal scrollback is preserved when session status updates trigger a redraw, preventing the
  history from being cleared or Windows Terminal from jumping to the beginning.

## 0.4.11 · 2026-09-17

### Fixed

- Pasted image paths on macOS and Linux now support escaped spaces, including long filenames and
  filenames containing both backslashes and spaces.
- The top login status now refreshes immediately after signing in or out.

## 0.4.10 · 2026-09-17

### Improved

- The default status line shows the current context capacity, such as `Context 1M` or `Context 512K`.
  Users with a custom status line can enable `context-window` in `/statusline`.

### Fixed

- New sessions and default-model updates now preserve the selected context capacity.
- Messages submitted during context compaction now enter the waiting queue instead of failing to send.
- Completed Shell command results no longer reappear in subsequent conversation turns.

## 0.4.9 · 2026-09-16

### Added

- `mcode exec` and `mcode exec review` support `--effort` to choose reasoning effort for a single run.
  Unsupported levels fail before execution, and the override does not change the session's saved effort.

### Fixed

- Fixed saving and restoring the default reasoning effort, so new sessions and submitted requests use
  the same level shown in the model picker and status line.
- Model selection now respects configured effort defaults and fixed levels while preserving the
  Thinking Off setting.

## 0.4.8 · 2026-09-16

### Added

- Explore subagents can run foreground Bash commands to inspect code and Git state, with a
  read-only filesystem policy when sandboxing is available.

### Improved

- Improved content review handling with guided response regeneration and fixed replies when
  applicable, while retracting blocked drafts.
- Improved responsiveness when previewing very long thinking output, while keeping the full text
  available in expanded details.
- Unified elapsed time in the running status, turn summary, and Goal display using `s`, `min`, and
  `h`, retaining seconds for runs longer than an hour.

### Fixed

- Restored the thinking toggle for capable custom provider models without changing their existing
  effective thinking defaults.
- Fixed startup failures when custom agents conflict with built-in agent names, preserving custom
  configuration during migration.
- Improved cancellation of streaming responses from compatible providers so interrupted reads can finish
  promptly.
- Restored editable image labels when editing a previous message with double Esc or `/edit`.
  Images can be removed, restored with undo, previewed when a local file is available, and resent.
- Fixed attachment validation errors when sending images or files during an active run, and
  prevented accepted attachments from being lost when temporary draft files are cleaned up.

## 0.4.7 · 2026-09-15

### Added

- Choose terminal, coding, or general work instructions for non-interactive runs with
  `mcode exec --prompt-mode tui|coding|work`; terminal mode remains the default.

### Improved

- New custom provider models enable switchable thinking by default when supported. Existing model
  settings and explicit thinking choices are preserved.
- Discover models from compatible gateways that expose an OpenAI-style model list. Connection tests
  now use the model's configured output limit.

### Fixed

- Improved MCP compatibility for server and tool names, isolated connections across sessions, and
  prevented connection tests from continuing tool discovery after a timeout.
- Fixed background Shell results being lost in subtasks and cleaned up remaining background work
  when a subtask ends.
- Prevented retries from replaying custom provider responses after visible output has begun.
- Preserved messages sent during an active run when the run ends abnormally, keeping conversation
  history consistent.

## 0.4.6 · 2026-09-14

### Improved

- Preview pasted images above the input, including format, dimensions, file size, and filename. Move
  the cursor back to an image label to view it again. Terminals without image support still show
  image details.
- Press Esc to dismiss an image preview; Enter continues to send. Preview failures do not prevent
  sending the original image.

### Fixed

- Removed extra per-message arrows and command highlights in terminals such as iTerm2, and avoided
  terminal markers interfering with cursor positioning during redraws.

## 0.4.5 · 2026-09-14

### Improved

- Web search now uses a built-in tool without waiting for a separate search MCP service to start.
  User-configured MCP servers continue to work as before.
- Removed the search service component that is no longer needed in the installation package.

## 0.4.3 · 2026-09-13

### Improved

- Configure model-level `compat` in `config.yaml` for custom providers to declare upstream message
  roles, token parameters, and thinking formats when using a gateway. Explicit configuration is
  required for these overrides to take effect.

### Fixed

- Removed the duplicate, truncated original title from the session rename panel. The input retains
  the complete title and scrolls as you move the cursor to edit it.

## 0.4.2 · 2026-09-11

### Added

- Automatically load project MCP servers from `.mcp.json` in the session's main working directory,
  with configuration sources and connection status visible in `/mcp`.
- Switch supported model context sizes, including M3 512K / 1M, with Tab / Shift+Tab in `/model`;
  save the selection for the current session and future use.
- Where OpenAI Codex login is available, choose browser or device code login, with cancellation and
  retry for expired codes.

### Improved

- Refresh a third-party connection's model list in `/provider` with `r`, and edit its API Key, Base
  URL, models, or alias with `e`.
- Reuse an existing provider connection when adding models without entering the API Key again; add
  another account explicitly when needed.

### Fixed

- Fixed mismatched tool arguments when multiple OpenAI Responses tool calls stream concurrently.
- The side-conversation shortcut now clearly warns when no side conversation exists and directs you
  to run `/btw` first.

## 0.4.1 · 2026-09-11

### Improved

- Switching models in an existing conversation warns that prompt cache reuse may be lost and
  additional costs may apply.
- Goal displays its current wait reason, including result verification.
- Goal pauses after three consecutive rounds without tool calls to prevent continued idle execution.

### Fixed

- Restored the terminal-specific system prompt, with capability instructions following the enabled
  features.
- Fixed Goal continuation after user intervention and late usage settlement, and allowed queued user
  messages to proceed while a Goal waits on dependencies.
- Shortcut hints follow custom keybindings, including aliases and disabled bindings.
- Background task details show the full command and error, wrapping long and multiline content.

## 0.4.0 · 2026-09-11

### Added

- Review local changes with `/review` or `mcode exec review`, with findings linked to file
  locations.
- Run Shell commands with `!`, keep results local with `!!`, and use Tab to complete commands and
  paths.
- Customize the status line interactively with `/statusline`, apply changes immediately, and display
  output from a custom command.

### Improved

- Slash commands support argument hints and continued completion; command panels use consistent
  titles, borders, and action bars.
- Headless tasks provide structured output validation and clearer progress and failure diagnostics.

### Fixed

- Improved recovery when context compaction encounters oversized input, and preserved history
  consistency when forking conversations.
- Diagnostic reports retain available files when part of the collection fails.

## 0.3.11 · 2026-09-09

### Fixed

- Fixed long-running tasks stopping with a 401 error after repeated sign-in credential renewals.

## 0.3.10 · 2026-09-08

### Improved

- Selected options use consistent blue highlighting across TUI menus and pickers.
- Command descriptions consistently use English across the command menu.

## 0.3.9 · 2026-09-07

### Fixed

- `/btw` and `/side` sessions now follow the parent session permission mode without an extra
  confirmation step. Full access needs no additional approval; other modes retain their normal
  checks.
- Draft recovery cleanup skips missing files, preventing repeated no-op deletions from exhausting
  the safety budget and disrupting later operations.

## 0.3.8 · 2026-09-07

### Improved

- `/status` now shows the running version, account and plan, instruction file sources, Default/Plan
  mode transitions, and remaining 5-hour and weekly quotas with reset countdowns.
- The compact status panel wraps long paths and keeps local configuration visible while account
  details load or when the account request fails.
- `/logout` and `mcode logout` print a complete browser sign-out link and open the page for the
  current account region and environment. On remote or headless machines, copy the link to your
  browser; command completion does not wait for the browser or page result.

### Fixed

- Fixed authentication when uploading automatic error reports from a signed-in account.

## 0.3.7 · 2026-09-07

### Improved

- Long sessions search and render more smoothly, with cached search indexes and stable Markdown,
  fewer history replays during terminal resizing, and clearer tool retry summaries.
- The default status line warns when remaining context reaches 25% or less. Explicitly configuring
  `context-remaining` keeps valid usage visible; narrow terminals prioritize essential status.
- Terminal notifications support focus-aware policies and configurable delivery methods, with
  improved compatibility for cmux. Composer keyboard hints follow the current platform.

### Fixed

- Improved shared login recovery when switching accounts, cancelling login, or starting offline,
  including concurrent credential renewal and delayed logout synchronization.
- Installation and repair guidance now preserves the selected package, version, and registry and
  explains how to restore native SQLite dependencies when npm 12 blocks installation scripts.

## 0.3.6 · 2026-09-07

### Fixed

- When MCode shares its data directory with MiniMax Desktop, official model endpoints are now
  resolved in memory for the current environment: reading configuration or first-run initialization
  no longer writes new official endpoints into the shared config file, so older Desktop versions
  keep working alongside the TUI. Custom (BYOK) endpoints behave as before.
- Legacy model recovery now also covers numbered model aliases and retired default models, and
  applies consistently to the model list, Goal model checks, and login checks: selections pointing
  at the legacy official gateway resolve to the same-name official model, then the configured
  default model, then the current official default. Shared default models, session model references,
  and migration records are preserved; only explicit user selections are written back to
  configuration.
- Installing or updating with npm 12 no longer breaks the native SQLite module: install and update
  authorize the MCode and `better-sqlite3` lifecycle scripts and keep optional native dependencies.
  When native SQLite fails to load, startup prints a repair command matching the install registry,
  and early startup errors are reported instead of failing silently.

## 0.3.5 · 2026-09-07

### Fixed

- Legacy model repair now also covers resuming sessions and queued messages, not just startup:
  selections from the legacy custom provider switch to the same model on the official MiniMax
  provider, or to the official default model when the same model is unavailable, and the repair is
  saved to the session or default configuration. The model list no longer shows legacy entries.
- After a response fails or is stopped, queued messages that have not run yet are kept and shown as
  paused. Run `/queue` and press `c` to continue from the front of the queue; pending messages can
  also be edited, restored, or deleted. Sending a new message while paused offers to send it first
  and then continue the original queue, or to clear pending messages first; cancelling keeps your
  draft. Reopening the session shows the paused queue and waits for you to continue.
- In-TUI updates now run npm with MCode's own Node runtime and validate the new version's native
  modules with that exact runtime before activation, fixing startup failures after updating on
  machines whose system Node version differs. If validation fails, the previous version stays
  active.
- The macOS/Linux installer resolves the selected Node to its real path for install, launcher, and
  receipt, and re-checks native modules with that runtime on reruns. Broken same-version
  installations now enter a repair install automatically instead of being reported as healthy.

## 0.3.4 · 2026-09-06

### Improved

- On startup, when the selected model comes from the legacy custom provider, the TUI automatically
  switches to the same model on the official MiniMax provider.

### Fixed

- `/login` and `/logout` are always available. `/login` refreshes credentials with the server even
  when already signed in and keeps you signed in if a transient refresh fails; `/logout` safely does
  nothing when already signed out.
- When the server permanently rejects saved credentials, the TUI clears them and falls back to
  device authorization instead of looping on `/login` errors. Temporary or configuration errors no
  longer discard valid credentials.
- Service or resource failures now report the actual failure instead of asking you to sign in again;
  sign-in prompts appear only when signing in is really required.
- Domestic accounts sign in through the updated authentication endpoint.
- Draft recovery failures no longer interfere with typing or other user actions.
- Duplicate session history manifests are recovered automatically so session history keeps loading.

## 0.3.3 · 2026-09-05

### Improved

- Side conversation footers now name the view that the switch shortcut opens. Terminal.app on macOS
  displays the supported `Ctrl+-` shortcut for switching between main and side views.

### Fixed

- Signing in and out now synchronizes the running session's credentials immediately, including
  repeated sign-out requests, instead of waiting for background credential notifications.
- Content review can recover from an expired credential and retry once with a new credential. If
  recovery fails, the request remains blocked and prompts you to sign in again.

## 0.3.2 · 2026-09-04

### Added

- Added `/btw [question]` and `/side [question]` to ask follow-up questions in a temporary side
  conversation while the main task keeps running. Use `Ctrl+/` to switch views, `/parent` to return
  to the main view, or `Ctrl+C` in an empty side Composer to discard the side conversation.
- Side conversations inherit the main conversation's committed context and show its current task
  status. Tools that can modify data require explicit confirmation in every permission mode.
- Internal packages support a global `--env test|staging|prod` option for the current launch, with
  `pre` as an alias for `staging`. The selection survives login and update restarts without changing
  saved configuration or the package's update channel. Public packages do not expose this option.

### Improved

- Markdown headings, inline code, and links have clearer visual distinctions, with more readable
  syntax highlighting in terminals limited to 16 colors.

### Fixed

- Fixed input-method candidate window positioning in side conversations.
- Queue hints now follow custom keyboard shortcuts, including multiple or unbound shortcuts.
- Markdown links preserve nested formatting and restore the surrounding text style correctly.
- PR and MR links are now associated with the Session's actual workspace, avoiding links from
  another checkout.

## 0.3.1 · 2026-09-04

### Added

- TUI and Desktop now use the Shared OAuth Core for the same account session; Runtime and embedded
  `mcode-tools` consume short-lived access-token leases without reading refresh credentials.
- Managed `mcode-tools` packaging validates its version lock, package identity, lease protocol, and
  CLI SHA-256 before enabling the launcher, and remains fail-closed when validation fails.
- Added a unified `/tasks` center for Agent Team and Runtime background work, with a compact
  severity-aware summary above the Composer and drill-down into child Session transcripts.
- Added an opt-in machine-readable `[V]` status line and terminal result records for automation. The
  regular status line can also show the GitHub PR or GitLab MR for the current branch.
- Built-in Subagents can retain an explicitly enabled Web Search capability across Runtime startup
  and recovery.

### Improved

- Internal test and staging builds accept an explicit global `--lane <name>` for OAuth integration
  testing. Production builds reject the option, and MCode does not infer a lane from environment
  variables.
- The Composer now identifies Prompt, Command, and Skill input before submission, shows a localized
  empty-state hint, and treats text following no-argument slash commands as a regular prompt.
- Provider setup offers broader models.dev search, clearer model browsing, and safer API-key edits.
- Queue and Steer presentation now stays aligned with the active Turn through pauses, cancellation,
  recovery, and follow-up delivery.
- Model retries, Goal completion, and compaction report clearer progress and actual Provider token
  usage. Plan Review content remains scrollable in the Transcript.
- Installing MCode now exposes the managed `mcode-tools` command without requiring a TUI startup and
  keeps package-owned launchers clean across updates.

### Fixed

- Invalid grep regular expressions now return a structured, actionable Search failure instead of
  exposing ripgrep's raw parser error, including guidance for literal matching.
- Editing a Custom Provider invalidates stale connection-test status, so changed URLs, credentials,
  headers, and API formats are re-evaluated before their status is shown.
- Fixed Plugin Manager search results ignoring the Space toggle while preserving literal search
  spaces through `Shift+Space`.
- Fixed paused queues rejecting follow-up input, failed Steer cleanup overriding an already-started
  Turn, and pending Steer messages appearing at the wrong time.
- Fixed `/compact` autocomplete occasionally disappearing after Session creation, hidden model retry
  progress, and incomplete Goal completion or security-review guidance.
- Fixed new installs exposing the package-private Node runtime on `PATH` and tightened Windows
  delete command checks when shell redirection is present.

## 0.2.7 · 2026-08-28

### Improved

- Installer-managed updates now publish a complete versioned release and atomically switch new
  Sessions to it, so running Sessions can continue on the previous version without blocking
  activation. Update output also shows each stage and a heartbeat while the package manager is still
  working.
- While a response is running, `Alt+Enter` queues a follow-up and `Tab` remains dedicated to
  Composer completion; `Enter` continues to steer the active Turn.
- Welcome highlights and `/changelog` now select the packaged English or Simplified Chinese
  changelog from the system locale, with a deterministic English fallback.
- TUI Sessions now use a dedicated terminal prompt profile and no longer load Desktop `user.md`
  profile content, keeping terminal behavior isolated from Desktop-only instructions.

### Fixed

- Regular and Fullscreen rendering now preserve native scrollback and scroll positions when
  transient rows collapse, history is remeasured, or interaction chrome changes, avoiding cleared
  history, large blank gaps, replayed lines, and duplicate footer frames.
- Permission and Questionnaire panels remain fully visible above Goal and background-task rows, and
  large expanded Transcript histories only format the visible viewport plus overscan.
- User prompts keep their full-width highlight, compact first-message spacing, and terminal semantic
  markers without shifting the first rendered row.

## 0.2.6 · 2026-08-27

### Improved

- Bash approval prompts and transcripts now extract and highlight the actual command instead of
  rendering JSON wrappers and escaped characters as shell scripts.
- The `/checkin` hint now appears in the startup Tips rotation instead of the version highlights.
- Background work shows its summary plus up to three task rows above the Composer, with additional
  tasks summarized as `… N more`.

### Fixed

- Remaining usage credits are now displayed as whole numbers, matching the underlying credit unit.
- The first frame now refreshes the current terminal viewport instead of leaving the previous shell
  prompt visible.

## 0.2.5 · 2026-08-27

### Added

- `/sessions` is now the Session Center, with workspace or global search, switching, renaming,
  archiving, and restoration. Filters include `id:`, `path:`, `type:`, `status:`, and `model:`.
- Added `/history` for browsing the current Session input history, previewing and creating a branch,
  editing an earlier prompt, rewinding only the conversation, or rewinding both the conversation and
  files. It remains read-only while a response is running.
- Welcome randomly shows three highlights from the installed version. Added `/changelog` for viewing
  the complete packaged history in a read-only panel.
- Added a task panel above the Composer for live Agent Team and Runtime background-task status
  without rewriting Transcript history.
- Added `/checkin` for daily check-ins, streaks, total check-in days, and reward results inside the
  TUI.
- `/model` now lists and selects models from third-party Providers and guides users through Provider
  setup when needed.

### Improved

- `/context`, `/usage`, and `/status` now open as closable interaction panels without leaving
  entries in the Transcript or Session history.
- The status bar and usage panel can show the current Session cache-read ratio and avoid misleading
  ratios when the available statistics are incomplete.
- Queue and Steer status, targets, and recovery feedback are clearer. Queued messages can be
  selected as Steer targets, and queue ownership remains consistent across Session switches,
  cancellation, and recovery.
- While a response is running, commands that create, switch, rename, archive, branch, rewind, edit,
  or compact Sessions are hidden and rejected. Safe read-only history, Queue, Steer, and Stop
  actions remain available.
- Approval prompts and Tool summaries use consistent shell-semantic command highlighting for easier
  reading of long commands.
- Coding and Work modes preserve Markdown link labels and targets as clickable links instead of
  incorrectly rendering them as inline code.
- Regular-mode streaming updates, theme changes, and Surface switches perform fewer full redraws.
  Long-Session Inspector formatting is limited to content near the current viewport.
- Production bundles split startup code and defer nonessential resources, reducing version-query,
  first-frame, and message-ready latency.
- Long Sessions consistently compact accumulated ToolResult content while retaining recoverable
  original output, reducing context usage and repeated trimming.
- The TUI keeps a bounded, redacted local record of abnormal exits and lifecycle failures and
  uploads it after sign-in. Collection or upload failures never block startup, shutdown, or normal
  interaction.

### Fixed

- Fixed Regular mode replaying the full Transcript during live updates, which could damage native
  terminal scrollback or make history jump.
- Fixed duplicate redraws and premature cleanup completion during shutdown, updates, returns from an
  external editor, and terminal restoration.
- Fixed terminal or autocomplete subprocess EOF incorrectly terminating the TUI or losing the first
  stop reason.
- Fixed Session history actions, queued messages, and background tasks being projected into the
  wrong context after asynchronous responses, recovery, or Session switches.
- Fixed built-in Agents without an explicit model failing to inherit the current Session model, and
  explicit routing for Goal verifiers and other subtasks being overwritten by Agent configuration.
- Fixed legacy `main` or `mavis` Agent data preventing Runtime startup.
- Fixed `/fork` offering worktree isolation when the current repository could not safely create it
  and failing only after selection.
- Fixed MiniMax Plugin Hooks receiving incorrect Tool names or input shapes, which broke Hook
  matching and input rewriting.
- Fixed built-in Matrix tools using the wrong authentication method for managed services.
- Fixed interrupted, repeated, or failed install/update attempts leaving incomplete versions, with
  recovery from the transaction record.

## 0.2.4 · 2026-08-24

### Added

- `mcode acp` expands the Session control plane with Session fork, mode and configuration switching,
  Queue/Steer, Goal, and delegation while preserving ownership through rebinding, cancellation,
  permissions, and questionnaires.
- Installed Plugin Skills are directly searchable and invokable through `/`.
- Added lifecycle Hooks compatible with the Plugin format, including Runtime compatibility handling.
- Goal supports runtime budgets, automatic settlement, and independent verification; Ask shows a
  countdown before automatic continuation.
- `mcode exec` now emits structured events and output for automation workflows.
- Press Ctrl+U to continue the latest Codex Session.

### Improved

- Startup shows Server loading state and blocks message submission until Runtime is ready. Startup
  animation and feature pages follow the active TUI mode.
- The idle Composer displays operating tips.
- Pasted absolute image paths use short placeholders. Agent Team rows remain stable during updates,
  and long Bash/background tasks provide clearer progress.
- Long-session compaction prefers Tool-result trimming that saves at least 70% of context, while
  background-task reminder deduplication and read counts are more stable.

### Fixed

- Bounded the retained input/detail size of each Tool Transcript entry, preserving the beginning,
  end, and original byte count for oversized payloads.
- Fixed legacy BYOK Provider, Session, and Custom Agent configuration interfering with migration or
  blocking Runtime startup.
- Consolidated Permission Core as the deterministic policy owner. Command-level denial remains
  fail-closed; provably safe literal deletion commands on Windows use fixed targets, while complex
  or unprovable commands remain denied.
- Fixed pending updates inside an npm prefix failing to resume.
- Fixed local timezone changes altering canonical Session history paths and tightened Host-failure
  and Fork history-retention boundaries.
- Fixed compaction failures after model context changes and lost Subagent state at Compact
  checkpoints.

## 0.2.3 · 2026-08-22

### Added

- Added `/export [path.md]` to export the complete current Session history as Markdown, with
  workspace-relative paths, collision-safe suffixes, credential redaction, `0600` permissions, and
  clickable local file links.
- The model picker groups by Provider and searches Provider, model name, display name, variant, and
  `provider/model`, with Backspace, Delete, cursor movement, and a complete model catalog.

### Improved

- `/rename` without arguments opens Session Manager with the current Session selected. Permission,
  Plan Review, Questionnaire, and similar interactions now share consistent nested-input focus,
  cancellation, failure feedback, and recovery.
- Ctrl+C exit confirmation now stays armed until the next press. Clearing a Draft can be undone with
  Ctrl+Z without a fixed 500 ms window.
- Startup defers nonessential dependencies.
- The MiniMax Code product-knowledge Skill is now a top-level router with trusted region context and
  topic-specific references for accounts, Agents, extensions, workflows, and more.

### Fixed

- Fixed history finalization after in-turn compaction referencing stale identity and causing
  reconciliation errors in long-running Sessions.
- Fixed `tool_trim` rewriting persisted user messages and failing the Turn; original user payloads
  are retained.
- Fixed `mcode update` parsing npm responses that contain a single-element version array.
- Fixed settlement consistency when run results, Agent Team events, and Runtime events arrive after
  reconnects, as duplicates, or out of order.

## 0.2.2 · 2026-08-21

### Added

- Added `/rewind` and `/edit` for selecting a history range, previewing changes, and editing before
  resubmission. `/fork`, attachments, and Draft recovery share the Runtime Session contract.

### Improved

- `/update` reports the real number of blocking MCode sessions and waits for older processes to exit
  safely instead of abandoning activation after a fixed timeout.
- Slash Review switches to a compact Git-discovery prompt when context is tight, preserving review
  output and recovery paths.

### Fixed

- Fixed completed Agent Team subtasks continuing to accumulate elapsed time after restoring a
  historical Session.
- Fixed terminal EOF being reported as abnormal and cleanup steps sharing one timeout that prevented
  later resources from closing.
- Fixed legacy turn leases surviving restarts and blocking future Session work.

## 0.2.1 · 2026-08-20

### Improved

- `/settings` shows the actual Regular and Fullscreen layouts. Arrow keys move focus and the
  selection is applied only after confirmation.

### Fixed

- Fixed Fullscreen Composer input lagging one frame and requiring another keystroke to display the
  previous character.

## 0.2.0 · 2026-08-20

### Added

- Rebuilt terminal rendering and input around consistent Regular/Fullscreen, Markdown, Unicode,
  image, keyboard, mouse, search, and resize behavior.
- Permission requests now use complete approval cards that show commands, files, matching rules, and
  risk, with once, Session, and deny choices. Cards remain open until Runtime confirms the result.
- `/copy` in SSH sessions can write to the local clipboard through terminal protocols, and
  completion notifications are deduplicated according to terminal capabilities.
- Added `sessionTitle.enabled` to disable Runtime model requests for Session titles.

### Improved

- Redesigned `/context`, `/usage`, and `/status` to show context composition, token usage, model,
  reasoning effort, Compaction, and run state through clear capacity, ratio, and status hierarchy.
- Runtime dynamically adjusts output budgets and Compact thresholds from remaining context, avoiding
  premature compaction while reserving safe output space for each turn.
- Long tasks with incomplete Todos recheck progress on the assistant-iteration cadence, reducing
  forgotten remaining steps.
- Project Skills correctly enter TUI Slash Command completion. MCP Server cold starts remain in a
  starting state instead of being reported as failed after the first query timeout.
- Fullscreen scrolling, search, selection, and tail follow share one viewport. Switching between
  Regular and Fullscreen preserves Runtime, Session, Draft, attachments, and blocked interactions.

### Fixed

- Fixed the Composer being clipped when Slash Command completion or feature lists expand in
  Fullscreen, and requiring another keystroke after closing.
- Fixed Fullscreen AskUser covering the latest message and namespaced AskUser Tool completion
  leaking into the Transcript.
- Fixed Tool-detail toggles jumping the viewport to the top during streaming. Windows image paste
  now prefers `Alt+V`, while `Ctrl+Z` provides Editor/Draft undo without conflicting with Windows
  Terminal zoom.
- Fixed the Composer remaining unusable after editing a Draft through `Ctrl+G` in PowerShell and
  closing the external editor.
- Fixed Runtime status updates interrupting Regular-mode Slash Command candidates so the first `/`
  showed nothing and later input lagged behind suggestions.
- Fixed long AskUser, Queue, and Plan viewer content being clipped in Regular mode.
- Unified Settings, AskUser, and similar Composer replacement with Pi mount-state semantics,
  preventing unusable input flashes during empty transition frames and stale content after
  interactions.
- Fixed completed background Subagents reusing the previous Query collapse and timing state, and
  `/review` queued-message sources failing to reconcile with their bubbles.
- Fixed invalid Workspaces blocking the current Session when accelerated indexing was enabled.
- Fixed Windows local-file tools disagreeing on Read-Before-Write path identity and installers
  mistaking `mcode.ps1` for the launcher in PowerShell.
- Fixed `/update` replacing files in place under the npm prefix and colliding with locked native
  modules; updates now use isolated staging and atomic activation.

## 0.1.6 · 2026-08-19

### Fixed

- Fixed long-running Matrix tools such as image generation, image search/download, reverse image
  search, video, and audio failing with `fetch failed` on Node.js 26.

## 0.1.5 · 2026-08-19

### Added

- Added `/retry` to resend retained messages after Provider or network failures, continue incomplete
  requests in restored Sessions, and resume blocked Goals.
- The status bar can select and order workspace, Session, Git, model, reasoning effort, context, and
  other fields, including current run state.

### Improved

- Provider, network, authentication, and rate-limit errors provide clearer causes and next steps.
  Automatic retries show progress, and failure context survives Session switches and restoration.
- MCP Server cold starts remain in a starting state instead of being reported as failed after the
  initial status timeout.
- Model and reasoning effort are applied before the first request. BYOK connectivity checks and
  Codex OAuth proxy behavior are more accurate.
- Installers safely reuse a compatible system Node.js, preserve the existing PATH, and support an
  explicitly selected and verified mainland China download mirror.

### Fixed

- Fixed drag-selecting and copying messages in PowerShell or Windows Terminal clearing the Composer
  Draft.
- Fixed `/quit` being restored into the Composer Draft and Session restoration accidentally sending
  queued messages.
- Fixed duplicate message display after image paste, Goal inline attachments failing to start, and
  elapsed time disappearing after history pagination.
- Improved Windows launcher path escaping and compatibility across partial install and update
  scenarios.

## 0.1.4 · 2026-08-18

### Added

- Added `/goal` for creating, viewing, and managing the current Session Goal, including status,
  progress, and elapsed time consistent with Desktop and Runtime semantics.
- Added Plugin management through `mcode plugin` and the interactive Plugin manager for browsing,
  installing, enabling, disabling, and removing official or local Plugins.
- Expanded `/provider` and `/model` for viewing and testing Providers, switching between MiniMax
  OAuth and API Key, and selecting a model and reasoning effort reflected in the status bar and
  `/status`.
- Expanded ACP and continuous collaboration with persistent Session listing, loading, restoration,
  and closing. Running work can Queue follow-ups and steer the current Draft or next queued message
  without `/new` breaking Session identity.

### Improved

- Unified mouse-wheel, `PgUp`/`PgDn`, drag selection, and copy behavior. Selections remain anchored
  while scrolling and support drag autoscroll; non-TTY and compatible terminals retain native
  scrollback.
- Added visual `/context` and `/usage` information for context window, token composition, Session
  usage, and Compaction state.
- Tool calls, Skill completion, and Queue messages update sooner. Generated-file receipts use clear
  clickable paths that open the file or directory.
- Permission, Questionnaire, and Compaction requests share the Runtime contract, reducing lost or
  duplicate waiting-state requests.

### Fixed

- Fixed copy offsets while scrolling a drag selection and delayed display of queued messages.
- Fixed built-in Matrix tools being incorrectly trimmed when the `mcode-tools` switch was enabled.
- Fixed image paste on Windows and WSL and cross-platform generated-file path display.

## 0.1.3 · 2026-08-17

### Added

- ACP editor integrations can reopen or continue an earlier Session after restart, with fixes for
  `/new` causing Session mismatches.
- `mcode exec` JSON output includes the model actually used for usage analysis.
- Added `/copy` to copy the latest Assistant response to the system clipboard as Markdown, with
  clear feedback and a manual-copy path when no response or clipboard is available.

### Improved

- Session titles are more accurate, with clearer Tool calls and Skill completion.
- macOS scrolling shortcuts now use `Fn` labels that match physical keyboards.

### Fixed

- MiniMax API Key users can start conversations without signing in.
- Fixed extra text attaching to delivered file paths and frequent Composer cursor/border flicker.
- Improved WSL sign-in and Windows PowerShell installer compatibility.
