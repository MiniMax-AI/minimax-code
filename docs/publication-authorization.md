# Publication scope

This repository publishes the reviewed MiniMax Code TUI, headless CLI, and ACP source listed in `release/public-source.json`. First-party code defaults to MIT. Third-party and file-level declarations continue to apply to their own material, including Apache-2.0 for `third_party/sandbox-runtime` and the retained notices for Pi and bundled skills.

## Included material

- First-party source in the reviewed package roots, build and release scripts, tests, prompts, agents, skills, templates, examples, and documentation.
- MiniMax names and the specific brand assets committed to this repository.
- Vendored components and the model catalog under their existing terms. The repository also records pinned versions, integrity checks, and license metadata for the `mcode-tools` artifact and npm dependencies downloaded during installation or build.

The source inventory is the machine-readable boundary. Adding a path to that inventory does not replace review of its content, provenance, license, or user-data risk.

## Excluded material

The published source does not include the Desktop application's source, internal Git history, private review material, account data, logs, sessions, credentials, or later unreviewed additions. Source publication does not publish an npm package or installer and does not grant access to paid services or third-party accounts.

## Release checks

For each source release, maintainers record the selected commit, source-candidate receipt, archive SHA-256, inventory digest, verification results, known limits, and reviewer. Preserve the root MIT license, `NOTICE`, third-party notices, and package-level exceptions. Any confidential approval records remain outside the repository.

See [License status](../LICENSE-STATUS.md), [Releasing](releasing.md), and [Maintainers](maintainers.md) for the corresponding license, verification, and review steps.
