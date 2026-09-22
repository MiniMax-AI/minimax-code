# MiniMax account, models, and media reference

Use this reference for MiniMax Code or MiniMax Open Platform accounts, Token Plan, subscription keys, credits/points/Credit, plans, usage, quotas, API keys, BYOK, providers, model catalogs and access, context windows, image/audio/music/video or multimodal entitlements, and why a model or media task is unavailable.

## Stable boundaries

- A Token Plan/subscription resource and pay-as-you-go API balance/API key are different resource paths; never assume their keys, quotas, or model access are interchangeable.
- Model availability depends on product surface, key/provider type, account, region, plan, version, and current service rollout—not the model name alone.
- Media support and credit eligibility are separate questions: a model may exist in the catalog without being enabled for the user's product, plan, or requested operation.
- The Agent cannot change balance, entitlement, quota, permissions, or server-side validation.

## BYOK environment-variable credentials

For an API key supplied through the environment, locate the active profile's
`config.yaml` and change the existing credential field to a whole `${NAME}`
reference. Preserve its API format, endpoint, models, and other options:

```yaml
custom_provider:
  work:
    options:
      apiKey: '${WORK_API_KEY}'
minimax_api:
  apiKey: '${MINIMAX_API_KEY}'
```

- Supported credential fields are `custom_provider.<id>.options.apiKey` and
  `minimax_api.apiKey`. Variable names start with a letter or underscore and may
  then contain letters, digits, or underscores.
- `$NAME`, `Bearer ${NAME}`, and partial interpolation remain literal strings;
  `{env: NAME}` is an invalid credential type.
- Have the user set the variable locally in the shell that launches `mcode`.
  Restart TUI, exec, or ACP after changing its launch environment. An already
  running process keeps its existing environment.
- Missing or blank variables produce an error naming the provider, field, and
  variable. Check only whether the variable is set and nonempty; never echo it
  or ask the user to paste a secret into the conversation.
- Model requests, saved-provider discovery and connection tests use the resolved
  key. Saving settings preserves the reference text in the configuration.
- `provider add --api-key-env` reads and saves a value; edit `config.yaml` to keep
  a reference. Do not assume custom headers or Base URLs expand variables.

## Official source discovery

Use only the current region's sources:

- `region: cn` → MiniMax Code `https://agent.minimaxi.com/docs/llms.txt`; Open Platform `https://platform.minimaxi.com/docs/llms.txt`
- `region: en` → MiniMax Code `https://agent.minimax.io/docs/llms.txt`; Open Platform `https://platform.minimax.io/docs/llms.txt`

MiniMax Code docs are authoritative for product-surface behavior. Open Platform docs are authoritative for API models and underlying billing rules. Prefer `.md` pages discovered from the matching index. Never query both regional indexes for an ordinary current-region question.

## Verification workflow

1. Identify resource: subscription/Token Plan, purchased credits, pay-as-you-go balance, or BYOK provider.
2. Identify surface, region, model, media type, and requested operation.
3. Read the current regional official pages and specific model/API documentation; do not rely on historical model names, prices, quotas, or UI paths.
4. For account-specific state, tell the user where to inspect the console and mark balance/entitlement as unverified unless runtime/account evidence exists.
5. For “can credits generate video?” or similar, verify model operation support, product/plan eligibility, and current billing/credit rule.
6. Report the conclusion first, source links next, and unresolved account or rollout conditions last.

## Safety

Never expose or ask the user to paste API keys, subscription keys, passwords, OAuth secrets, or verification codes. Never promise that every model/media operation is covered by credits, or that a plan bypasses API billing. Do not bypass region, plan, account, or permission restrictions.
