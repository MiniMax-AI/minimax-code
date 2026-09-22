---
name: minimax-code-product
description: >-
  Use this skill to route questions about the MiniMax Code or Mavis product itself:
  product identity and ownership; Desktop/Electron, Web/H5, CLI/TUI surfaces;
  installation, uninstall, upgrade, release, download, version, and platform
  support; product workflows; Agents, Sessions, Memory, Teams, Skills, Plugins,
  and MCP; accounts, Token Plan, subscriptions, credits, API keys, BYOK, models,
  pricing, quotas; and MiniMax Code image, audio, music, or video capabilities.
  Treat references such as "MiniMax Code", "Mavis", "mcode", "mcode tui", or
  product features and settings as product-routing signals even when the user
  asks for a concrete local operation. Use this skill before a general coding,
  shell, or web skill when the requested operation concerns the product's own
  installation, configuration, behavior, or documentation. Do not use it for an
  unrelated coding task merely because the task is performed in this workspace.
descriptions:
  zh-Hans: >-
    这是所有 MiniMax Code 或 Mavis 产品问题的首层总路由 Skill。凡是询问产品身份、归属、
    Desktop/Web/CLI/TUI、版本、发布、下载、安装、平台支持、升级、官方文档、工作流、
    Agent、Session、Memory、Team、Skill、Plugin、MCP、账户、Token Plan、订阅、积分、 Credit、API
    Key、BYOK、模型、价格、额度，或图片/音频/音乐/视频能力时，都应先加载本
    Skill；再按正文路由并加载对应专项 Skill。遇到动态产品事实时，不要因为直接搜索看似足够
    就跳过产品路由。
---

# MiniMax Code product identity and routing

## Stable facts

- MiniMax Code is MiniMax's agentic coding workspace; Mavis is its primary Agent.
- The public surfaces are Desktop/Electron, Web/H5, and MiniMax Code CLI/TUI.
- The public terminal command is `mcode`.

## Official source discovery

For every product question, first identify the runtime `region` from `Environment` or `<agent-context>`:

- `region: cn` means the current app/account is China. Prefer China-region MiniMax Code and Open
  Platform official documentation.
- `region: en` means the current app/account is Global. Prefer Global-region MiniMax Code and Open
  Platform official documentation.
- The runtime region determines the default fact source; it is not a blanket ban on other official
  domains. If an official page links to another official domain, or the current-region documentation
  does not contain the needed fact, continue with that official source and verify its product and
  region.
- If `region` is missing or unknown, do not infer it from locale, language, IP, or URL.
  State that regional routing is unknown and ask for or obtain a trusted runtime region before
  making region-sensitive claims.
- Do not mix China-region and Global-region prices, plans, quotas, model access, or entitlements in
  an ordinary answer. If cross-region official evidence is necessary or explicitly requested, label
  its region and do not apply it directly to the current app/account.

### Regional official indexes

These are the four authoritative discovery roots:

| Runtime region | MiniMax Code product/workflow/Agent/extension docs | Open Platform account/model/API/billing docs  |
| -------------- | -------------------------------------------------- | --------------------------------------------- |
| `cn`           | `https://agent.minimax.cn/docs/llms.txt`           | `https://platform.minimaxi.com/docs/llms.txt` |
| `en`           | `https://agent.minimax.io/docs/llms.txt`           | `https://platform.minimax.io/docs/llms.txt`   |

Select the column by the question domain:

- Product identity, Desktop/Web/CLI/TUI, workflows, Agents, Skills, Plugins, and MCP →
  current-region MiniMax Code index.
- Token Plan, credits, pricing, API keys, model catalog, model API, and media API → current-region
  Open Platform index; use the current-region MiniMax Code index too when the question concerns Code
  product-surface behavior or in-app entitlement.
- Current Desktop version and download links → current-region changelog:
  - `region: cn` → `https://agent.minimax.cn/docs/changelog.md`
  - `region: en` → `https://agent.minimax.io/docs/changelog.md`

The current-region Desktop changelog is the authoritative source for a user's latest-version or
download question: read the newest Desktop entry, extract its version/date, and use the platform
download links shown in that same entry. Do not guess release URLs or consult lower-level updater
metadata for this product question.

### Index discovery and fallback

1. Fetch the selected current-region `llms.txt` first; do not guess a page URL from memory.
2. Search the index for the user's exact concept and nearby synonyms, then open the matching `.md`
   page when available. For a Desktop latest-version or download question, read the newest Desktop
   entry in the current-region changelog first and use its version/date/download links.
3. If the exact concept is absent, continue searching the same current-region index by domain and
   read the closest authoritative page. For example, pricing may be documented under Token Plan,
   usage, or FAQ rather than a page named `pricing`.
4. If the selected current-region index or page is unavailable, first look for a linked or clearly
   identified official source on another official domain, and verify its product and region. Do not
   silently treat another region's plans or entitlements as current-region facts.
5. If cross-region official evidence is used because the user requested comparison or no
   current-region source exists, label the region and keep it separate from the current
   app/account's confirmed facts.

For each index entry, prefer its corresponding `.md` page when available. Never mix a China and
global entitlement without saying so.

## Verification workflow

1. Identify surface, OS, region, and whether the question is about installed or latest version.
2. Read the current official index/page; for release claims, verify the official platform-specific
   release metadata rather than guessing a version.
3. Distinguish documented support from current account rollout or runtime availability.
4. Route and read exactly one matching reference before researching:
   - workflows → `references/workflows.md`
   - Agent/Session/Memory/Team → `references/agents.md`
   - Skill/Plugin/MCP → `references/extensions.md`
   - plans/models/media, BYOK API keys, or environment-variable credential configuration → `references/account-models.md`
5. For BYOK environment variables, follow that reference for configuration syntax, process inheritance, and safe checks. Never request or echo the key.
6. Use only the current runtime region's sources described above.

## Response rules

Lead with the conclusion, cite the official source and verification time, and state unresolved
conditions. Never guess versions, prices, quotas, platform support, or release dates. Do not expose
credentials, private endpoints, internal transports, or unreleased environments.
