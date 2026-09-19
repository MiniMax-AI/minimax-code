# Telemetry

All automatic telemetry uploads are disabled by default and each requires its own opt-in: TUI usage events (`telemetry.enabled`), runtime performance metrics (`telemetry.metrics`), and automatic error diagnostics (`telemetry.diagnostics`). Opting in to usage events does not authorize the other two channels. Login, model requests, update checks, and user-submitted feedback are separate product actions and are not controlled by these switches.

## Turn it on or off

Add this to the active profile's `config.yaml`, then restart MCode. Builds from this repository and the published npm CLI `@minimax-ai/code@0.4.12` default to `~/.minimax/config.yaml` (or `~/.minimax-<profile>/config.yaml` when a profile is selected). Overrides can change this path; see [Accounts and data](installation.md#accounts-and-data) to locate it. The telemetry controls below describe this repository's source build and are not a guarantee of feature parity with that npm release.

```yaml
telemetry:
  enabled: true      # TUI usage events (anonymous, described below)
  metrics: false     # Runtime counters, gauges, and histograms
  diagnostics: false # Account-linked TUI and LLM error diagnostics
```

Remove a setting or set it to `false` to turn that channel off. Either environment variable below turns **all channels** off and takes precedence over the config file:

```sh
MCODE_DISABLE_TELEMETRY=1 mcode
DO_NOT_TRACK=1 mcode
```

Inspect the effective setting of every channel with `mcode telemetry status`. Run `mcode telemetry preview` to see a representative decoded usage-event request. Preview does not send a request. When usage telemetry is disabled, preview shows `request: null`, independently of the metrics and diagnostics settings.

## Usage-event data sent

The HTTP body is `application/x-www-form-urlencoded` with two fields:

| Field  | Value                                                       |
| ------ | ----------------------------------------------------------- |
| `data` | Base64-encoded JSON envelope described below                |
| `ext`  | `crc=<number>`, an integrity checksum of the encoded `data` |

The decoded JSON envelope contains:

| Field                            | Value                                         |
| -------------------------------- | --------------------------------------------- |
| `identities.$identity_cookie_id` | Fresh random ID for this event                |
| `distinct_id`                    | The same fresh random ID                      |
| `lib.$lib`                       | `js`                                          |
| `lib.$lib_method`                | `code`                                        |
| `lib.$lib_version`               | MCode version                                 |
| `properties`                     | Common and event-specific fields listed below |
| `type`                           | `track`                                       |
| `event`                          | Event name from the table below               |
| `time`                           | Unix timestamp in milliseconds                |

Every `properties` object includes:

| Field         | Value                                                        |
| ------------- | ------------------------------------------------------------ |
| `surface`     | `tui`                                                        |
| `os`          | Node.js platform name, such as `darwin`, `linux`, or `win32` |
| `region`      | `cn` or `en`                                                 |
| `build_env`   | `dev`, `test`, `staging`, or `prod`                          |
| `app_version` | MCode version                                                |

Event-specific fields are limited to:

- `tui_launch`: `launch_type` (`cold`, `hot`).
- `login_click`, `logout_click`: no extra fields.
- `login_result`: `source` (`agent_web`, `agent_desktop`, `openplatform`, `mcode_tui`, `mcode_cli`); `result_type` (`1` success, `2` failure); `fail_reason` (empty for success, `1` server, `2` network, `3` cancelled, `4` other, `5` OAuth/authorization); `login_type` (`google`, `mobile`, `wechat`, `apple`, `minimax_sso`, `minimax_oauth`).
- `btw_session_lifecycle`: `phase` (`opened`, `closed`); `duration_bucket` (`not_applicable`, `under_1m`, `1m_to_5m`, `5m_to_30m`, `over_30m`); `exit_reason` (empty, `ctrl_c`, `ctrl_d`, `navigation`, `replaced`).
- `chat_send`: `chat_type` (`chat`, `agent_team`, `claw`, `hermes`, `IM`); `is_first_message` (`0`, `1`); `is_attachment` (`text`, `attachment`).
- `slash_command_menu_view`, `at_command_menu_view`: `chat_type` (values above).
- `slash_command_click`: `chat_type`; `command_type` (`skill`, `new_chat`, `summarize`, `plan_mode`, `goal_mode`, `other`).
- `at_command_click`: `chat_type`; `command_type` (`plugins`, `goal_mode`, `plan_mode`, `file`, `directory`).

MCode does not send account IDs, device IDs, workspace paths or names, session IDs, model names, prompts, responses, filenames, command text, plugin names, or credentials through this channel. The receiver requires an identity-shaped envelope, so the client creates a fresh random event ID for each request. It is never persisted or reused and cannot link two events on its own. MCode does not add an account authorization header to these requests.

As with any network request, the receiving server can observe transport metadata such as the source IP address. The client does not add that value to the event payload. `mcode telemetry preview` displays the decoded envelope.

## Usage-event destinations

The destination depends on region and build environment:

- China production: `https://data.hailuoai.com/meerkat-reporter/api/report?project=MiniMaxAgent`
- Global production: `https://data.hailuo.ai/meerkat-reporter/api/report?project=MiniMaxAgent`
- China non-production: `https://bigdata-test.xingyeai.com/meerkat-reporter/api/report?project=MiniMaxAgent`
- Global non-production: `https://bigdata-test.talkie-ai.com/meerkat-reporter/api/report?project=MiniMaxAgent`

The client keeps pending events only in memory and does not write them to disk. This repository does not define or verify server-side retention. Keep telemetry disabled when that policy does not meet your requirements.

## Runtime performance metrics

`telemetry.metrics: true` enables the built-in cloud metrics transport: metric names, timestamps, counter/gauge/histogram values, and low-cardinality labels (runtime owner and mode, version, and per-instrument dimensions such as model, tool, or outcome). No account credential is attached. Production destinations are `https://agent.minimax.cn/matrix/api/v1/metrics/batch` (China) and `https://agent.minimax.io/matrix/api/v1/metrics/batch` (global). Metrics stay in memory; when the channel is disabled, no cloud reporter is created.

## Automatic error diagnostics

`telemetry.diagnostics: true` authorizes both TUI incident reports and LLM request-failure reports. Both additionally require a signed-in account: the transport uses the account's Bearer token and a `user_id` query parameter, so these reports are **account-linked** even though their contents are minimized and encrypted. The minimization schemas are described in [TUI capability coverage](tui-capabilities.md#diagnostic-upload-privacy). Both use `/minimax-cloud/api/v1/observability/desktop-errors/batch` on the regional MiniMax host. When the channel is disabled, TUI incidents are written as local-only files (7 days / 200 files) that are never uploaded, and LLM failure reports are dropped before buffering.

Server-side retention for any channel is not defined or verified by this repository. Login, model requests, update checks, and user-submitted feedback have separate network behavior described in [TUI capability coverage](tui-capabilities.md).
