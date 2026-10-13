# MiniMax Plugin V1 — 可选 Host Binding 扩展

Host Binding 是 manifest V1 的可选属性，不需要另起一版包格式。V1 的路径、archive、digest、App、
MCP、Skill 和 Hook 契约保持不变；未声明该属性的普通插件行为不变。
这里的 V1 指插件包格式，与 Desktop 使用的 Local Runtime V2 不是同一个版本概念。
国内外 Marketplace 使用同一扩展契约；某个区域支持此格式，不代表其 catalog 已上架 Browser Use。

## 1. 适用范围

Host Binding 让官方 Plugin 声明“希望复用 Desktop Host 已提供的一项原生能力”。它只描述依赖和
映射请求，不包含能力实现，不启动额外进程，也不自动绕过 Host 的版本、surface、来源和安全策略。

新包统一使用 `schemaVersion: 1` 和 `plugin-v1.schema.json`，包括 Browser Use。
根 `.minimax-plugin/marketplace.json` 同样仍使用 catalog schema v1。
Marketplace validator 和 Publisher 仅接受 manifest V1，不转换或接收 V2。已发布 V2 包由
Desktop reader 保留读取兼容，不改写旧包或 digest；不维护独立 V2 schema。

## 2. 包结构

```text
plugins/<plugin-name>/
  .minimax-plugin/plugin.json
  bindings/<binding-name>.binding.json
  skills/<skill-name>/SKILL.md
  <icon>
```

V1 manifest 继续显式列出 `apps`、`mcpServers`、`skills`，并允许可选数组 `hostBindings`。
省略或空数组都表示不声明 Host Binding；使用该能力时填入 Binding 文件引用。Binding
路径必须匹配 `bindings/<name>.binding.json`，同一引用不能重复。未被 manifest 引用的 Binding
文件按 capability closure 规则拒绝。

## 3. Binding V1

Binding 文件遵循 [`host-binding-v1.schema.json`](../../schemas/plugins/host-binding-v1.schema.json)：

```json
{
  "schemaVersion": 1,
  "bindingId": "browser-control",
  "logicalToolName": "browser.control",
  "hostCapability": { "id": "browser.use", "version": 1 },
  "requiredSkills": ["control-in-app-browser"],
  "allowedSurfaces": ["interactive"]
}
```

- `bindingId`：包内稳定且唯一的 Binding 标识；运行时据此生成不透明、稳定的
  `plugin:<plugin-name>:<bindingId>` 引用。
- `logicalToolName`：包内的逻辑能力名，只在包内判重；是否曝光为模型工具及其名称由 Host 的
  capability 准入与映射决定，不直接使用这个字段作为模型 `tools[]` 中的工具名。
- `hostCapability`：Host 契约的 id 与整数版本；是否存在匹配 Adapter 由 Host 决定。
- `requiredSkills`：必须精确引用同一 manifest 已声明的 Skill name，区分大小写。为兼容 Desktop
  reader，Binding V1 限制为小写字母开头的 `[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*` 完整标识，
  最多 128 字符。普通 Skill 的 portable path 名称范围更宽，因此合法的 `Writer` 等名称不能
  被 Binding V1 引用。不要自动重命名既有 Skill；放宽范围需与 Desktop reader 协同迁移。
  Binding 只有在这些 Skill 对当前 Turn 可用时才能解析。
- `allowedSurfaces`：V1 只允许 `interactive`，Task child、CLI 和其他 surface 默认 fail closed。

同一包的 `bindingId` 和 `logicalToolName` 分别唯一。未知字段、未知 surface、缺失 Skill、重复值、
非官方来源由 Desktop reader 拒绝；Marketplace Validator 校验 Binding 结构和包内闭包，Desktop Host
再拒绝不受支持的 capability/version/surface。

## 4. Browser 能力如何被调用

Browser Use 通过 Host Binding 复用宿主已有的 compact `browser` 集合工具，不携带另一套浏览器
实现。插件启用且 Binding 获准后，Host 以插件入口 `mcp_browser` 将它及当前 schema 放入模型
`tools[]`，模型按 `mcp_browser({action, input})` 调用。

这里的 `mcp_browser` 是插件声明、Host 托管的工具名，不代表新增标准 MCP Server。
BU manifest 的 `mcpServers` 保持空数组；调用继续复用 Host 的会话上下文、安全检查和内部
RPC → Electron 链路，不新增进程、端口或浏览器实例。

```text
Browser Use 插件启用，Host 接纳 Binding 并曝光 mcp_browser
  → 模型完整读取 BU Skill（按 Skill 的 Session 规则复用有效加载）
  → 模型直接调用 mcp_browser({action, input})
  → Host 针对 Browser 工具执行安全检查
  → Browser 工具执行动作，结果返回模型
```

### 4.1 Host 返回什么，模型如何使用

Browser 的动作与参数以当前 `mcp_browser` 工具 schema 为准，参数直接传递 `{action, input}` 对象，
其中数组、布尔值和数字保持原生 JSON 类型。BU Skill 的读取结果不再另附全量
`Host tool contracts`，也不需要模型查找或拼接 `tool_ref`，或通过 `mcp_invoke` /
`arguments_json` 包装 Browser 调用。

Skill 文件继续维护完整工作流、安全规则和代表性示例，不重复维护完整 schema。模型必须遵循
BU Skill 的完整加载、Session 隔离和重新加载规则；工具可见不替代 Skill 加载要求。
缺少 `mcp_browser` 工具/schema 时停止并提示检查客户端或插件，不能通过试调用猜测参数。

这项直接曝光只适用于 `browser.use`。其他 Host Binding 仍可通过 `mcp_invoke` gateway 及
Host 返回的 `tool_ref`、`arguments_schema`、`arguments_transport` 调用；使用
`arguments_json` 时仍须按该契约传递 JSON 字符串。`mcp_invoke` 不是独立网络服务或 MCP Server，
本次没有移除其他 Binding 的 gateway 路径。

### 4.2 工具列表与缓存有什么变化

Browser Use 的插件状态与 Host 准入结果决定 `mcp_browser` 是否进入当前模型的顶层工具列表
`tools[]`，其 schema 来自实际 Browser 执行契约。其他仍走 gateway 的 Binding 不因此全部直出。

Browser 的接入或退出会改变顶层工具定义；Skill 清单和工具返回内容也会改变模型上下文，
不能据此保证整个提示词缓存（prompt cache）始终命中。

## 5. 每次调用仍需通过安全检查

调用入口可用、工具可见或插件已安装，都不等于当前 Browser 动作已获授权。

- Host 必须针对真实目标工具名和真实参数执行 PreToolUse、产品策略、权限检查及调用来源记录
  （provenance），再调用 Host Adapter。直接调用 `mcp_browser` 不绕过这些检查。
- Browser 的可信能力身份来自 Host 核准的 Binding，不来自工具名称或 `mcp_` 前缀；不能因第三方
  工具同名就信任其结果。认证接管后的强制 `ask_user` 门禁仍须覆盖真实 BU 调用。
- 其他 Binding 经 gateway 解析引用后同样检查真实目标，不能把 `mcp_invoke` 入口已通过检查
  当作目标工具也已获准。未知引用应返回失败，不能在错误信息中列出内部注册表的其他工具。
- 插件声明的能力随插件整体启用；Host 仍可因产品策略、版本不匹配、surface 不允许、能力不可用
  或安全规则拒绝调用。这是每次调用的准入检查，不是给 Plugin 另设第二个启用开关。

## 6. 兼容与发布顺序

BU 的直接调用版本须与对应 Runtime 更新协调发布：先让 Desktop 客户端支持新契约，再发布
依赖该契约的插件；不能让用户先收到无法调用的包。

1. Desktop 先支持 manifest V1 的可选 `hostBindings`、历史 manifest V2 读取兼容和 Binding V1，
   并具备 `browser.use` 准入后的 `mcp_browser` 直接曝光、当前 schema、Skill 读取门禁及真实目标安全检查；
   其他 Binding 的 gateway 契约保持不变。
2. Marketplace 合入 schema、validator、Publisher dry-run 与 Browser Use 包，并先发布 `dev` 测试目录。
3. 验证 BU 准入时顶层工具列表包含 `mcp_browser`，直接动作可执行且 Skill 不再附加全量契约；
   未安装、禁用、Skill 未完整读取或不允许的 surface 必须拒绝调用。其他 Binding 的 gateway
   仍可调用，未知引用仍须拒绝。
4. 对已经开启旧 Browser Use 模式的用户执行一次性默认安装迁移。
5. 测试环境验收后，只把本次相关提交从最新 `main` 生产分支带入生产 MR。

不认识 `hostBindings` 的旧 Desktop 仍会拒绝新字段；不支持 `mcp_browser` 直接曝光的客户端，
不能先接收依赖它的插件版本。新 BU Skill 不提供老客户端的猜测式回退。发布新内容必须升级
包版本，不覆盖已发布内容。

历史记录：Browser Use 从 1.0.1 升级到 1.0.2 时改用扩展后的 manifest V1。这是格式迁移记录，
不是当前版本声明；各区域是否上架及当前版本，以该区域 catalog 和对应 manifest 为准。

## Computer Use

`computer-use` 声明 `computer.use@1`，仅分发到 Desktop，由用户安装和管理。
Binding 要求包内 `computer-use` Skill，运行时名称为 `computer-use:computer-use`。
Desktop 保留现有 `computer_*` 工具名称，仅在交互会话显式选择电脑操控、插件启用且权限检查通过后开放。
插件包提供元数据、图标和操作说明；原生驱动、系统授权、预览与停止控制仍由 App 实现。
需配合支持该 capability 的 Desktop 发布；旧版本无法仅通过安装包获得原生能力。
