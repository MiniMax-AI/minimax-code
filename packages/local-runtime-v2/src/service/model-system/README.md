# Model System

Model System 是 Local Runtime v2 的模型 owner。它同时维护两组能力：

- resolution：把进程配置、认证上下文和 Agent 模型引用解析成 Agent runner 使用的 `LLMModelConfig`；
- provider management：管理 BYOK Provider 配置、模型目录、连通性、缓存与 OAuth 状态。

两组能力共享模型身份、请求地址、请求头、thinking 协议与同一个 profile 配置端口。
`initializeModelSystem` 创建唯一 resolver，并把解析与管理组装成同一进程级 owner。Turn
preparation 接收该 resolver，Session 建立后再组装 `ModelProviderApplication`。Turn admission、HTTP
DTO 映射、AgentHost lifecycle 和 Session persistence 仍由各自边界持有。

OpenRouter 使用官方 `https://openrouter.ai` endpoint 时，Model
System 会在真实推理、连接测试和模型发现请求中统一加入 MiniMax Code 的 app attribution
headers：`HTTP-Referer`、`X-OpenRouter-Title` 和
`X-OpenRouter-Categories`。这些产品身份字段由 Runtime 按 header
name 大小写不敏感地覆盖，用户自定义 Provider headers 不能改变归因身份；其他 endpoint 不受影响。

OpenCode Go 的官方 HTTPS 地址
`https://opencode.ai/zen/go`、`https://opencode.ai/inference/go`（models.dev 当前按协议拆分的入口）及其子路径会自动携带
`x-opencode-session` 和
`User-Agent: MiniMaxCode`，无需依赖自定义 Provider 名称。推理请求使用 Runtime 提供的 Session
ID，同一会话跨 Turn、恢复与重试保持稳定，不同会话各自隔离；标题与压缩沿用已解析的请求头。连接测试和模型发现没有产品会话：一次连接测试生成一个探测 ID，按 Think
Effort 逐档发出的请求共用它（与会话内切换档位时 ID 不变一致），不同次检测各自独立；模型发现每次请求独立生成。这两个身份字段按 header
name 大小写不敏感地覆盖静态配置，其他请求头保持原值。普通 Zen
`/zen/v1`、`/inference/v1`、代理地址和其他 Provider 不自动应用这项策略。

## 目录

- `contracts.ts`：共享配置 read model、解析与 Provider capability contract；
- `identity.ts`：Provider ID、来源与 API 协议的唯一身份定义；
- `initialize.ts`：绑定 profile 配置端口并组装进程级 Model System owner；
- `resolution/`：Provider、BYOK、model ref、thinking 与 credential 解析；
- `catalog/`：模型列表、Provider view、缓存与选择；
- `connectivity/`：Provider 请求规则、模型发现与连接测试；
- `management/`：Provider 配置变更与 MiniMax Context 工作流；
- `codex-oauth.ts`：Codex OAuth 登录状态；
- `index.ts`：唯一公开入口，仅做 re-export。

其他 service 的生产代码只从 `service/model-system/index.ts` 导入。当前 AgentHost
preparation 消费 resolution capability，ModelProvider Controller 和 Session
Application 消费同一 owner 的 management
capability。V1 沿用既有实现并继续按原计划退役，这个目录不承担 V1 兼容职责。

## Codex OAuth 登录

`CodexOAuthManager.startLogin({ method })` 支持 `browser`（默认）和 `device_code`，复用 vendored
Pi 的 OAuth 实现与宿主 `fetch`。TUI 通过 process-local
capability 选择方式、查询状态和取消登录；HTTP 入口默认使用浏览器登录。

Runtime 在内存中持有当前登录的 `loginId`、授权地址和设备码。设备授权到期时间使用 Unix
ms；这些临时数据不写入配置。相同方式的重复请求复用当前授权，切换方式前需取消。`cancelLogin(loginId)`
只取消对应尝试，防止过期面板影响新登录。

凭据先保存在本次授权的内存存储中，确认未取消后才写入当前 profile 的
`codex-auth.json`。取消和超时会停止授权请求并阻止迟到结果配置模型。设备码页面由 TUI 展示，账号 token 保留在 Runtime。

## BYOK 模型发现

Anthropic Messages 的 Provider 先请求协议原生的
`<base>/v1/models`。该端点返回 404 或 405 时，依次回退到 `<base>/models`
和去掉 base 路径前缀后的站点根
`/models`，覆盖把 Messages 与模型列表分挂两处的兼容网关：DeepSeek 把兼容面挂在
`https://api.deepseek.com` 的子路径下，只实现 `/v1/messages`，模型列表在
`https://api.deepseek.com/models`。

兜底只在端点缺失时发生。鉴权失败、限流和服务端错误立即按原状态返回，不把真实故障归因成路径不对；候选全部缺失时统一返回
`models_endpoint_missing`，产品文案提示手动添加模型，不暴露 HTTP 状态码。每次尝试各自使用完整的请求超时，命中兜底的模型列表与原生端点在 UI 上没有区别。

## Codex OAuth 模型发现

登录完成后，`CodexOAuthManager` 从当前 profile 的 `codex-auth.json` 获取凭据，复用 `AuthStorage`
的刷新机制和宿主 `fetch`，请求
`https://chatgpt.com/backend-api/codex/models?client_version=0.200.0`。
`connectivity/codex-model-discovery.ts`
负责这个独立的 Codex 协议。兼容版本来自已验证的 Codex 客户端协议，与 MiniMax
Code 产品版本独立；模型 ID 和思考等级由响应提供。OAuth 解析复用可配置思考协议，将远端等级原样映射到请求；
`ultra` 等新增等级不依赖 Pi 的静态等级枚举。

只导入 `visibility=list` 的模型，ChatGPT OAuth 不用 `supported_in_api`
过滤。模型名称、思考选项和输入类型来自响应。默认上下文取 `context_window`，缺失时取
`max_context_window`；远端仅给出最大可配置窗口时才用该值初始化。输出上限沿用已有配置，新模型使用 Runtime 的通用缺省值。

模型清单按 ID 合并，保持已有排序，追加新发现模型。已保存字段拥有最高优先级，嵌套的
`limit.context`、`limit.output`、`thinking.effortOptions`、`modalities.input/output`
分别合并。用户的名称、启用状态、默认模型和其他设置同样保留。旧版本自动写入的字段缺少编辑历史，也按本地配置保留。合并在配置事务内读取最新值，覆盖刷新期间的用户改动被禁止。

首次 OAuth 完成后自动获取模型列表；后续在模型设置中点击“获取模型列表”主动更新。打开设置时的 GET
OAuth 状态请求只读取状态，POST `/mavis/api/provider-auth/openai-codex/models`
执行模型发现；无定时刷新或时间节流，并发发现请求共享执行。按钮获取期间显示加载状态，失败后可立即重试。已有 provider 配置作为最后成功的持久结果：刷新失败保留配置，首次发现失败保留登录凭据供连接入口重试。远端超时、错误响应或空清单不会用静态列表替换已有配置。

删除 provider 后，状态查询保持删除结果；刷新期间删除凭据或 provider 也会放弃保存。手动删除单个模型后，下次远端发现仍可补入该模型，需要持续隐藏时使用模型启用开关。
