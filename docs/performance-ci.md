# Performance CI

Every PR runs `performance`: the base and head SHAs build separately, then run
serially on one `macos-15` runner with Node 22.23.2 and Bun 1.4.2. Manual dispatch
accepts a baseline ref. Build and installation time are excluded.

| Scenario | Input | Purpose |
| --- | --- | --- |
| `startup` | 1 tool round, minimal body | Startup and shutdown |
| `upstream-100` | 100 rounds × approximately 4 KiB, 64-character chunks, zero delay | Original [harness-perf-benchmark](https://github.com/KonghaYao/harness-perf-benchmark) workload |
| `history-300` | 300 rounds × approximately 8 KiB | History growth beyond the 1,048,576 UTF-16-unit token cache budget |

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
| Repetitions | One excluded warmup per revision/scenario; three measured pairs, alternating base/head order |
| Duration regression | Median increases by more than both 25% and 1 second |
| CPU regression | Median increases by more than both 20% and 0.5 core-seconds |
| Sampled peak RSS regression | Median increases by more than both 20% and 32 MiB |
| Pair confirmation | Candidate is worse in all three matched pairs |
| Noise | Range exceeds 30% of median on either revision: `INCONCLUSIVE`, exit 2 |
| Correctness | Exit 0; N+1 requests with complete wire history; N matched bash commands/results; expected echo, pwd and listing output; complete stored bodies; expected final response |
| Invalid evidence | Missing samples, wrong sampler, bad metrics, incomplete runs or changed fixture: fail |

These are initial regression budgets, not service-level targets or statistical
confidence intervals. `REGRESSION` exits 1; `PASS` exits 0. An inconclusive run
needs another clean measurement; it is neither a confirmed regression nor a pass.
Tune budgets from repeated same-revision measurements. Review changes to
scenarios, comparison logic or limits as changes to the performance contract.
The workflow does not change branch protection; maintainers can add
`performance` as a required check after runner calibration.

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

The output directory must be new. Use `--scenario startup` for focused checks;
the PR workflow always runs every declared scenario. It uses read-only
permissions and `pull_request`, without comments or secrets. See GitHub's
[event security guidance](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target).
