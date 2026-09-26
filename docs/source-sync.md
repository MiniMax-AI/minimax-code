# Source synchronization

`release/extraction.json` pins the source revision and package scope; `release/public-source.json` is the reviewed public file inventory. Maintain internal implementation and public distribution adaptations separately. Do not configure the internal repository as a mergeable upstream or cherry-pick internal commits into public history.

## Generate candidates

Run the following from this repository. The source repository must contain both the recorded baseline and the target revision. The output directory must not exist and must be outside both repositories.

```bash
node scripts/prepare-source-sync.mjs --source /path/to/source-repository \
  --ref <reviewed-upstream-commit> --out /path/to/new-private-review-directory
```

The tool reads Git objects, not the source working tree or credentials. For source files in the public inventory, it compares the old source, target source, and current public version to produce three-way merge candidates that preserve public changes. Conflicts keep their markers; deletions are reported without deleting files. New upstream files are reported by path and require separate review before inclusion. Selecting a revision does not automatically advance the recorded baseline.

Output includes `report.json`, `candidates/`, and `.private-review`. Candidates are **unreviewed internal material**: do not upload them directly to GitHub, attach them to a PR, or copy the entire directory into the public repository. The tool never changes the current repository, runs upstream scripts, or carries internal commit authors, messages, or history.

## Review and apply

1. Inspect conflicts, deletions, new files, non-regular files, and missing source files. Include new files only when actual dependencies require them; do not recursively copy whole packages.
2. Review internal addresses, generated IDL, credentials, prompt / asset licenses, and service contracts. Preserve in-process boundaries and public environment configuration.
3. Apply approved files individually to a public feature branch. Resolve all conflicts, then update `sourceRevision` in `release/extraction.json` to the report's `targetRevision`. Do not advance the baseline before reviewing all differences.
4. Regenerate the dependency license inventory if dependencies changed, then review and update the public source inventory. Run source, standalone, type, build, and explicitly selected affected tests.
5. Scan complete history and current source before creating the public PR. Include public changes, validation results, and capability descriptions, never private review reports.

After accepted public changes are ported back, subsequent three-way comparisons should show them as synchronized or cleanly mergeable while retaining standalone adaptations. Synchronization is not a blind overwrite: conflicts, missing source, and new files require maintainer judgment.

## Selective release updates

A bounded release update can port reviewed behavior without adopting unrelated
runtime ownership migrations or private service integrations. Keep the existing
three-way baseline until the entire target revision has been reviewed; record
the selected revision, included behavior and excluded boundaries separately.
See the [0.5.5 review](source-sync-0.5.5.md) for the current selective update.
