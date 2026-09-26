# Reviewed source update for 0.5.5

This update ports the public-compatible 0.5.5 behavior from source revision
`d28ae33c08a907f5e1ef17d70725eea0d0c667a0` onto the existing public distribution.
It preserves public fixes and distribution adaptations rather than replacing the
repository with a product build's source tree.

## Included behavior

- Managed foreground Bash defaults to a one-hour total timeout and caps larger
  requests at one hour. The 60-second foreground yield preserves the running
  process and its original deadline. Explicit background tasks use a one-hour
  runtime watchdog by default; explicit command timeouts remain separate.
- Automatic context compaction reserves output space before reaching the context
  limit. Checkpoint output scales with the model window; reasoning-only output
  exhaustion advances to a smaller candidate. Provider errors get one bounded
  logical retry. Automatic failures retain the original history; valid manual
  checkpoints are committed even when a local next-request estimate rejects them.
- Update downloads reuse the TUI's proxy and loopback-bypass policy and load
  their network dependency lazily. Existing public installation ownership and
  registry selection remain intact.
- Memory-tool results have a 16 KiB model-facing limit with a head/tail preview
  and guidance for reading more. This does not upload memory or change its storage.

The root and TUI source versions are 0.5.5. This source update does not republish
the existing npm package or move an existing release tag.

## Privacy and publication decisions

| Surface | Decision |
| --- | --- |
| Usage, metrics and diagnostics | Keep the public independent opt-ins, disabled defaults, and `DO_NOT_TRACK` / `MCODE_DISABLE_TELEMETRY` overrides. |
| Evaluation capture and data contribution | Do not import automatic capture wiring, evaluation payload/transport expansions, or default-enabled contribution behavior. |
| Workspace collection and indexing | Keep snapshot collection, archive creation, background upload/retry and semantic-index activation excluded. |
| Feedback and automatic error reports | Keep the public reviewed-text/count-only feedback projection and allowlisted diagnostic schemas; no raw conversations, tool output or workspace files. |
| Compaction observations | Import only local content-free count/budget/outcome facts; preserve the existing public telemetry consent boundary. |
| Managed account, BYOK, plugins, connectors, search and user-requested deployments | Preserve supported public clients and behavior. No private endpoints, generated service contracts or new cloud authorization dependencies are introduced. |

The reviewed update is selective. The older `release/extraction.json`
`sourceRevision` remains the base for future three-way comparisons: changing it
would incorrectly mark the remaining runtime ownership migrations, service
integrations and source-tree moves as synchronized. Those changes need their own
public dependency and privacy review. Private candidate reports remain outside
this repository and are not publication artifacts.

## Validation boundary

Imported tests exercise compaction failure/recovery, budget boundaries and real
Bash execution using synthetic data. Public privacy tests inspect the outgoing
telemetry/diagnostic data, including the final feedback archive. The repository's
full verifier additionally checks source export, types, build boundaries, TUI,
headless BYOK, ACP, permissions and platform-applicable sandbox behavior.

Offline tests are not evidence of live-service ingestion, model quality or
Windows/Linux runtime acceptance. Actual check results belong in the pull
request's validation record.
