# Performance CI

Every PR runs the `performance` check: the original 100-round scenario by default.
Adding `perf:full` automatically runs the full suite. While the label remains,
new commits and reopened PRs run the full suite too. Removing it starts a basic
run and cancels any previous automatic run for that PR. Unrelated label changes
skip benchmarking and do not replace the active `performance` check. Both
revisions build separately, then run serially on one `macos-15` runner with Node
22.23.2 and Bun 1.4.2. Build and installation time are excluded.

| Mode | Trigger | Scenarios | Job timeout |
| --- | --- | --- | --- |
| `basic` | PR without `perf:full`; optional manual run | `upstream-100` | 15 minutes |
| `full` | Add `perf:full`, then new commits/reopens while labeled; optional manual run | Startup, `upstream-100`, `history-300` | 45 minutes |

| Scenario | Input | Purpose |
| --- | --- | --- |
| `startup` | 1 tool round, minimal body | Startup and shutdown |
| `upstream-100` | 100 rounds × approximately 4 KiB, 64-character chunks, zero delay | Original [harness-perf-benchmark](https://github.com/KonghaYao/harness-perf-benchmark) workload |
| `history-300` | 300 rounds × approximately 8 KiB | History growth beyond the original 1,048,576 UTF-16-unit token cache budget |

The upstream commit is pinned in `scripts/perf/config.json` and the workflow.
Its generator, mock, sampler and CPU accounting run without source edits.
An observing loopback proxy forwards the request body and response stream to
the mock, validating the complete assistant/tool history on every request.
It records request bytes and validation duration in `requests.jsonl`, without
headers. This adds observer latency to wall time; it is identical on both sides
and outside the sampled CLI process tree. Absolute timings differ from running
the upstream demo without the observer.
The adapter uses synthetic workspaces and the repository's offline network
fixture. No live-model key is needed. The long scenario advertises a
2,000,000-token mock context to prevent compaction from shortening the history;
this is a stress fixture, not production model capacity. The standard scenario
keeps upstream provider defaults. The suite does not measure live-model quality,
latency, compaction acceptance or other products' rankings.

| Rule | Initial setting |
| --- | --- |
| Repetitions | One excluded warmup per revision/scenario; three measured pairs, alternating base/head order; up to two more alternating confirmation pairs when the first three are not conclusively clean |
| Duration pair over budget | Paired candidate duration exceeds its base by more than both 25% and 1 second |
| CPU pair over budget | Paired candidate CPU exceeds its base by more than both 20% and 0.5 core-seconds |
| Sampled peak RSS pair over budget | Paired candidate RSS exceeds its base by more than both 20% and 32 MiB |
| Regression confirmation | A pair is over its metric budget in every measured pair, or in at least four of five once confirmation pairs ran |
| Noise limit | Range exceeds 30% of median on either revision; after five pairs the single most extreme sample per revision is discarded before measuring the range |
| Correctness | Exit 0; N+1 requests with complete wire history; N matched bash commands/results; expected echo, pwd and listing output; complete stored bodies; expected final response |
| Invalid evidence | Missing samples, wrong sampler, bad metrics, incomplete runs or changed fixture: fail |

The first three pairs settle a scenario only when every metric is within
budget and both revisions are within the noise limit. Any other first result
measures the confirmation pairs, and the verdict comes from all five:
`REGRESSION` needs the candidate to exceed the configured relative and absolute
budget against its matched base in at least four of the five pairs, so one
sample corrupted by the runner can neither create nor veto it, and consistent
paired evidence fails the check even when per-revision spread is high. `PASS`
needs the median within budget and both revisions within the noise limit after
discarding one extreme sample per side, so a single slow sample no longer
blocks an otherwise faster candidate.
Everything else is `INCONCLUSIVE`: persistent runner noise, or an over-budget
median that the pairs do not reproduce.

These are initial regression budgets, not service-level targets or statistical
confidence intervals. Locally, `PASS` exits 0, `REGRESSION` and execution
errors exit 1, and `INCONCLUSIVE` exits 2. In CI the workflow converts exit 2
for the basic suite into a passing `performance` check with a warning annotation,
so persistent hosted-runner noise cannot block unrelated pull requests. The
full suite keeps exit 2 as a failed check because labeled performance work must
produce a real `PASS`. The annotation, job summary and report all state that
the run is inconclusive. An inconclusive run is neither a confirmed regression
nor a pass and does not satisfy the [full-coverage requirement](../CONTRIBUTING.md#performance-checks)
for labeled performance PRs; rerun for a clean measurement before relying on
the result.
Tune budgets from repeated same-revision measurements. Review changes to
scenarios, comparison logic or limits as changes to the performance contract.
The workflow does not change branch protection; maintainers can add
`performance` as a required check after runner calibration; its name stays the
same for basic and full runs. The summary and artifact identify the selected
suite. Follow the [label and review requirements](../CONTRIBUTING.md#performance-checks)
when deciding which PRs need full coverage.

The Job Summary contains machine/method and comparison tables. The 14-day
artifact includes JSON results, configuration, commit and fixture hashes,
warmup/measured samples, CLI/mock logs, and synthetic histories. Confirmed
regressions get a separate candidate CPU-profile run, excluded from comparison.
Reports checkpoint after each run; setup failures before the runner starts
remain in job logs. CPU and sampled RSS are compared separately; the combined
CU score is not a gate. Sampling can miss brief memory peaks.

Install and build both checkouts with identical Node/pnpm versions and install
the pinned benchmark with `bun install --frozen-lockfile`, then run:

```bash
node scripts/perf/run.mjs --base /path/to/base --head /path/to/head \
  --benchmark /path/to/pinned-benchmark --out /tmp/new-performance-output
```

The output directory must be new. The CLI defaults to `--suite basic`; pass
`--suite full` explicitly for the complete suite or `--scenario startup` for a
focused local check. Once the workflow is merged into the default branch, open
**Actions → Performance → Run workflow**, choose the PR branch, set the baseline
ref, and select `full` for long-history testing. Manual runs use a separate
concurrency group and do not cancel automatic PR checks. The workflow uses read-only
permissions and `pull_request`, without comments or secrets. See GitHub's
[event security guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).
