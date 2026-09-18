# Releasing a source preview

The current source target is MiniMax Code 0.4.12. Workspace and local-build manifests remain `private: true` to prevent accidental npm publication. A source release, npm package, and installer are separate artifacts with separate verification.

## Prepare a release

1. Select a reviewed commit on `main`. For shared-source updates, first complete the three-way process in [Source synchronization](source-sync.md).
2. Review every added, changed, and removed file. Confirm that `release/public-source.json`, package licenses, `LICENSE`, `NOTICE`, and third-party notices match the selected tree.
3. Run `pnpm verify` from a clean checkout. Require successful final-revision Source verification and Release audit checks.
4. Dispatch `Node compatibility` and `Source candidate` on the selected revision. Match each run to the immutable commit SHA and wait for every required platform result.
5. Use temporary projects and synthetic inputs for any live-service checks. Record unavailable accounts or grants as NOT RUN. Confirm costs and upload scope before testing paid media, deployment, feedback, or diagnostics.
6. Record the source commit, archive SHA-256, inventory digest, verification results, reviewer, and known limits. Keep scan reports, account data, and private review material outside the repository.

Before npm or installer distribution, separately validate the published package name and version, update behavior, native dependencies, installation scripts, and bundled license texts. Source verification does not cover those release channels.

## Automated source candidates

The `Source candidate` workflow exports the selected commit without Git history, verifies its receipt, and scans both repository history and the extracted source. Linux, macOS, and Windows runners authenticate the same archive, install from public npm into fresh stores, and run the archive verification profile.

After all platform jobs pass, the workflow creates a `source-candidate-<full-SHA>` artifact containing:

- `minimax-code-source.tar.gz`
- The archive receipt and SHA-256 file
- `candidate.json` with the revision and platform summary
- Per-platform verification reports

The intermediate `unverified-source-<full-SHA>` artifact is not a release candidate. Candidate generation does not create a GitHub Release, publish to npm, or update an installer.

## Publish and read back

1. Create a prerelease tag and release notes for the verified public commit.
2. Attach the authenticated source archive and checksum. Do not attach a local `dist` directory or user profile as a cross-platform artifact.
3. State the source version, installation paths, included interfaces, known limits, and any live-service checks that were not run.
4. Read back the tag, commit, archive digest, documentation links, and release notes after publication.

## Initial repository import

The initial CLI source snapshot was imported on 2026-09-18 at `c59cf5377045aa1a3e699c242d089b73b7cdc2ad`, on top of the existing MiniMax Code Desktop support history. The follow-up commit `4e2e7bb5f771e9c42b2edefb1046483819b9032f` restored the Desktop image. The import kept the existing issue forms and Feishu support workflow, used `README_ZH.md` as the Chinese entry point, and excluded internal Git history.

`release/extraction.json` remains the shared-source baseline. Future updates arrive through reviewed synchronization PRs; the initial import is not repeated.
