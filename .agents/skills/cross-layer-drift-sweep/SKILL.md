---
name: cross-layer-drift-sweep
description: Check completed cross-layer changes for stale fields, defaults, types, contracts or wording across storage, runtime, adapters, TUI and documentation. Use after a rename or contract change with downstream consumers, not for unrelated single-file edits.
---

# Cross-Layer Drift Sweep

Type checking can miss manual mappings, serialized fields and assertions hidden
behind casts. Sweep the narrow data flow affected by the change before reporting
completion.

## Establish the change

Record the change axis: type narrowing, field rename, configuration default,
contract evolution or display wording. Name the old and new expressions and the
producer and final observable consumer.

Draw the relevant flow, for example:

```text
storage -> runtime writer -> local service -> adapter -> TUI / exec / ACP -> docs
```

Only include layers that actually consume the changed value.

## Sweep

1. Search both old and new expressions. Include source, comments, tests,
   fixtures, snapshots and relevant documentation. Paired searches reveal layers
   that adopted only part of a change.
2. Check the likely gaps for the change axis:

   | Axis | Common gaps |
   | --- | --- |
   | Type narrowing | Runtime writers, filesystem reads with casts, serializers, adapter mappings |
   | Field rename | Schema, migrations, inline test DDL, fixtures, mappings, user-visible labels |
   | Configuration default | Defaults, thresholds, examples, logs, status output and documentation |
   | Contract evolution | Local protocol types, service exports, call sites and compatibility fixtures |
   | Display wording | TUI, exec output, logs, screenshots and exact-string assertions |

3. Fix mismatches within the changed data flow. Explain deliberate compatibility
   remnants in an adjacent comment or regression test. Avoid changing unrelated
   matches merely because they contain the same token.
4. Verify an assertion at the final observable layer, such as rendered text,
   serialized output, a local-service result or a database-backed read. Reuse an
   existing assertion when it already covers the behavior; add one when there is
   a meaningful regression gap.
5. Run affected tests and type checks using
   [testing-workflow](../testing-workflow/SKILL.md). For runtime inputs with
   alternate paths or caches, also use
   [verify-all-runtime-sinks](../verify-all-runtime-sinks/SKILL.md).

## Evidence

Report the axis, data flow, old/new search terms, layers checked, mismatches fixed
and verification results. Explain remaining old-token matches. If the final
consumer could not be exercised, state the gap and the nearest contract evidence
instead of treating a parser-only test as complete validation.
