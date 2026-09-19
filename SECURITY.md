# Security

This project is a source preview. Maintainers prioritize security issues on the default branch; no support period for older versions or response SLA has been committed.

Report vulnerabilities privately through **Security → Advisories → Report a vulnerability** on GitHub. If that entry is not enabled, open an issue without vulnerability details asking maintainers for a private channel. Share reproduction details only after that channel is available. Do not put credentials, exploit details, or real user data in public issues.

The release coordinator, @hetaoBackend, coordinates security triage; see [Maintainers](docs/maintainers.md). GitHub private vulnerability reporting is not currently enabled, and no public fallback security email is listed. Until a private channel is available, open an issue without vulnerability details as described above. No response SLA is currently promised.

Include the affected version, operating system and Node.js version, a minimal reproduction, expected and actual permission boundaries, and necessary redacted evidence. Use synthetic files and dedicated test accounts; do not test other people's accounts or infrastructure.

## Data and service boundaries

- The active data directory stores login state, provider configuration (including API keys in `config.yaml`), and sessions. Builds from this repository and the published npm CLI `@minimax-ai/code@0.4.12` default to `~/.minimax` (or `~/.minimax-<profile>` when a profile is selected). Environment overrides can select another directory. Follow [Accounts and data](docs/installation.md#accounts-and-data) to identify it; the installer location alone does not identify stored credentials. Restrict local access to every data directory you have used and keep them out of Git, including old profiles. They are not shareable project configuration.
- Models, official plugins, connectors, search, media, feedback, and telemetry may contact external services. Those services continue to control authorization and credits; source access does not grant access to accounts or third-party resources.
- mcode-tools obtains short-lived access tokens through the host's lease broker. Never pass refresh tokens to tool processes.
- Permissions and sandboxing do not replace review of untrusted plugins, MCP servers, and shell commands. If automatic permission classification is unavailable, retain user confirmation rather than allowing operations by default.
- If credentials leak, revoke or rotate them with the service first, then remediate files and Git history. Deleting the current file does not remove historical copies.

Scan source, Git history, and build artifacts separately. A passing scan does not guarantee the absence of unknown vulnerabilities.
