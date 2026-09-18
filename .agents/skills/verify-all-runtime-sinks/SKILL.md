---
name: verify-all-runtime-sinks
description: Verify that runtime-affecting schema, prompt, identity, adapter, cache or rename changes reach every affected consumer. Use before declaring runtime validation complete when alternate entry points or persisted/generated values can retain old behavior.
---

# Verify All Runtime Sinks

Identify where a changed value is finally consumed, beyond its first parser or
happy-path test. This skill defines where to verify; use
[testing-workflow](../testing-workflow/SKILL.md) for commands and gates.

## Procedure

1. Name the changed contract, field, prompt, identity or adapter behavior. Identify
   the producer and final runtime consumer, and describe the stale behavior that
   a partial change would leave behind.
2. Map the affected consumers. Mark each dimension `covered`, `not applicable`
   or `unknown`, with a reason:
   - **Parser to runtime:** normalized objects, managers, launch options,
     serialization boundaries and service inputs.
   - **Alternate entry points:** TUI, exec, ACP, task/session launches, built-in
     and project agents, and explicit historical-data importers where relevant.
   - **Generated or cached values:** bundled prompts, static prompt caches,
     compiled configuration, persisted state and memoized objects.
   - **Fixtures and artifacts:** tests, snapshots, example agents/skills and
     built distribution assets when affected.
   - **String remnants:** old property names, environment/configuration keys,
     log labels and documentation used by generation or tests.
3. Search for both old and new tokens beyond source files. Include ignored build
   outputs explicitly when checking artifacts; an ordinary repository search may
   skip them. Inspect raw serialized shapes where types or casts can hide drift.
4. Exercise the affected runtime paths through their final consumers. Check each
   adapter that can bypass the tested path. Shared implementation is evidence
   only after tracing how those adapters reach it. For prompts, check source
   selection and caching; for identity/schema changes, check agent kinds that
   parse differently.
5. Record commands, results, remaining old-token hits and compatibility reasons.
   Inspect or regenerate caches using isolated test state; do not clear a user's
   sessions or configuration as part of verification.

## Completion bar

Do not declare complete runtime coverage while a relevant consumer is `unknown`
or an unexplained old value remains. Report narrower passing checks and the
remaining gap. Parser tests alone do not establish propagation through launch,
execution and final presentation.

Example evidence:

```text
Parser to service: covered by the affected integration test.
Exec and ACP: covered by adapter tests; interactive TUI: not run.
Prompt cache: not applicable; the changed value is not cached.
Old field: retained only in the historical importer and its fixture.
Result: focused checks pass; interactive acceptance remains unverified.
```
