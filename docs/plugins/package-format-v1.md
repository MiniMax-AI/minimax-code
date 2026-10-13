# MiniMax Plugin Package Format V1

本文定义官方 MiniMax Plugin V1 的仓库结构、manifest 引用、archive 安全边界和 digest
算法。Publisher、Desktop 与 cloud-runtime 均以本文和仓库内 checked-in vectors 为准。

## 1. 仓库与包边界

Marketplace 仓库结构：

```text
.minimax-plugin/marketplace.json
plugins/<plugin-name>/
  .minimax-plugin/plugin.json
  <icon>
  *.app.json
  *.mcp.json
  skills/<skill-name>/SKILL.md
  hooks/hooks.json
  bindings/<binding-name>.binding.json
  <其他被能力文件引用的普通文件>
```

`.minimax-plugin/marketplace.json` 使用
[`marketplace-v1.schema.json`](../../schemas/plugins/marketplace-v1.schema.json)，显式列出当前目录中的
Plugin name、repository-root-relative path、端分发范围和安装策略。每项必填 `deliveryTargets`，
只允许 `desktop`、`cloud` 中的 1～2 个不重复值；可选 `installationPolicy` 只允许
`USER_MANAGED` 或 `DEFAULT_INSTALLED_UNREMOVABLE`，省略时按 `USER_MANAGED` 处理。后者表示该
官方 Plugin 对所有用户默认安装且不可卸载，但仍允许用户停用和重新启用；策略作用于 entry 的
全部 `deliveryTargets`。`plugins` 数组表示插件池快照，校验和发布过程仍原样保留顺序，
以维持既有发布摘要和幂等契约。环境完成 Registry 运营策略迁移后，市场展示顺序与上下架
以管理后台为唯一来源；Git 重排不改变运营顺序，新名称默认上架，已有运营状态保留。
删除仍上架名称会拒绝整次发布，需先后台下架。端分发、安装策略和池数组顺序属于 catalog
元数据，不进入 package 的 content digest。

每个 `plugins/<plugin-name>/` 是一个独立 package root：

- archive 根目录直接包含 `.minimax-plugin/plugin.json`，不得再套一层 Plugin 目录；
- `content_digest` 只覆盖该 package root 的完整文件树，不包含仓库级 marketplace.json；
- manifest 的所有路径均相对 package root，使用 `/`，不得相对 manifest 自身解析；
- 未被 manifest 引用的普通文件仍属于包，也必须进入 digest 和安全上限统计；
- Plugin name 必须与 marketplace entry、package 目录名和 manifest `name` 完全一致。该闭合校验
  由 Marketplace validator 实现。

## 2. Manifest 与能力文件

> **生产兼容门禁（2026-09-05）**：下面保留 V1 的 `darkIcon` 字段定义，但当前 `main`
> 的 validator 禁止 manifest 携带该字段（包括空值、`null`），统一使用默认 `icon`。
> 不要把深色图标资源及其元数据加入生产包。失败码为 `DARK_ICON_TEMPORARILY_DISABLED`，
> Publisher 构建、dry-run 与 CI 都会执行该校验。`dev` 不受本次修改影响。
> 待发布 owner 确认大部分生产用户升级到支持该字段的 Desktop 后，通过独立 MR 同步
> 解除 validator、测试、文档和 `plugin-creator` 的限制，不能用新版本已发布代替覆盖率确认。

官方 manifest 使用
[`plugin-v1.schema.json`](../../schemas/plugins/plugin-v1.schema.json)。V1 包含 App、MCP、Skill、
同步 command Hook，以及可选 Host Binding：

- `apps`：引用一个或多个 `*.app.json`，每个文件遵循
  [`app-v1.schema.json`](../../schemas/plugins/app-v1.schema.json)，只保存 Connector `provider`。provider
  命名直接复用 Connector catalog 的 `[a-z0-9_-]{1,64}` 完整字符串规则，不允许尾随换行或控制字符；
- `mcpServers`：引用一个或多个 `*.mcp.json`，每个文件遵循
  [`mcp-v1.schema.json`](../../schemas/plugins/mcp-v1.schema.json)，文件内使用
  `{ "schemaVersion": 1, "mcpServers": { "<name>": <config> } }`；
- `skills`：引用 `skills/<skill-name>/SKILL.md`。正文必须是 UTF-8、无 BOM，并以 YAML
  frontmatter 开始；frontmatter 至少包含与目录一致的 `name` 和非空 `description`；
- 可选 `hooks`：引用一个或多个 package-relative JSON 文件。文件顶层使用
  `{"hooks":{"<Event>":[{"matcher":"...","hooks":[...]}]}}`。第三版只统计并执行
  `type=command` 且未声明 `async=true` 的 handler；单包最多 64 个可执行 handler，
  单 handler `timeout` 为 1～10 秒。`args`、`shell`、`if`、`asyncRewake` 等兼容扩展字段会使
  当前 handler 被跳过且不计入 `hookCount`，也不再校验其 command 路径、timeout 或 Windows
  override。对于接纳执行的同步 command handler，显式的 `timeout`、`commandWindows` 必须
  为合法值。其他未知 handler 字段被忽略，不改变执行行为或计数；创建时不要依赖这些字段。
  异步 command 与其他 handler 类型不会使同包的
  App、MCP、Skill 或合法 Hook 失效。`matcher` 推荐使用精确名称或 `|` 分隔的精确
  alternatives（也接受逗号分隔）；matcher 总长度不超过 256。`UserPromptSubmit` 和 `Stop`
  在非空字符串与长度检查后忽略 matcher 内容，建议省略；其他事件不接受正则 matcher。
  工具 matcher 大小写敏感，必须使用 MiniMax 原生名称（`bash`、`read`、`write`、`edit`、
  `task`），不能使用兼容层别名（`Bash`、`Read`、`Write`、`Edit`、`Agent`）。`*` 表示显式
  匹配全部。

可选 `hostBindings` 引用 `bindings/<name>.binding.json`；省略或 `[]` 表示不声明 Host 能力。
声明后仍严格检查路径、重复引用、Binding 结构和必需 Skill 的包内引用；未知字段仍拒绝。
该扩展不要求改变 manifest 的 `schemaVersion: 1`。旧客户端需升级才可消费新增属性；
Marketplace 校验和发布仅接受 V1；已发布 manifest V2 包仅由 Desktop reader 保留读取兼容。
详见 [Host Binding 扩展](host-bindings.md)。

Hook command 的 cwd 是当前 turn workspace，不是 Plugin package。Runtime 会提供
`PLUGIN_ROOT`（以及兼容格式对应的 root 变量）；包内脚本必须使用显式解释器并从该根引用，
例如 `bash "$PLUGIN_ROOT/scripts/cleanup.sh"`。官方 archive 不保留 executable bit，validator
会拒绝直接执行 `.sh`、`bash ./scripts/...` 和不存在的 `$PLUGIN_ROOT` 文件引用。
可静态识别的宿主脚本路径（POSIX 绝对路径、Windows drive/UNC、`~` 开头的用户目录路径）均拒绝。
Windows override 使用规范字段 `commandWindows`，由 Windows 默认 shell 执行。Runtime 在启动
shell 前展开 `${PLUGIN_ROOT}`，两端均可使用；Windows 也接受 `%PLUGIN_ROOT%`，但不接受
裸 `$PLUGIN_ROOT`。Node 脚本可使用
`node "%PLUGIN_ROOT%\scripts\hook.mjs"`；包内 PowerShell 脚本应使用
`powershell -File %PLUGIN_ROOT%\scripts\cleanup.ps1`（或 `pwsh`），并接受同样的文件闭包校验。
validator 只做静态解释器和路径校验，不保证运行环境一定安装 `node` 等外部解释器。

`plugin.json` 的 `category` 必须是以下展示字符串之一：

```text
Office
Studio
Design & Sites
Code
Business
Sales
Productivity
Science & Healthcare
Education
Other
```

`version` 必须是完整 SemVer，不能带尾随换行。所有 schema 中的标识与路径正则均要求完整
匹配；JSON Schema 的正则使用显式字符串结束断言，避免 `$` 接受末尾换行。

`exampleQueries` 是字符串数组，允许空数组、最多 3 项、每项最多 4,096 个字符；
每个实际元素 trim 后必须
非空。可选的 `displayName` 和必填的 `author` 在 trim 后都必须非空，且分别不得超过 1,024
UTF-8 bytes。创建技能推荐填写展示名及 1～3 条有意义的示例问题，这是内容质量建议，
不改变 V1 的可选字段与空数组兼容性；不要为通过检查而编造内容。JSON Schema 的 `maxLength` 提供字符数预检，
Marketplace validator 负责精确的
UTF-8 字节校验，确保上传 OSS 前即可满足 Registry 字段约束。单个 Plugin 最多引用 256 个
App。Publisher 与 Registry 还会按 PolarDB `mediumtext`
实际容量校验 `example_queries` / `app_providers` 的紧凑 UTF-8 JSON 字节数。官方 `icon` 必填，
表示默认/浅色 Logo；可选 `darkIcon` 表示深色 Logo。两者都只允许 PNG、JPEG 或 WebP，并接受
相同的路径、真实字节、符号链接和归档闭包校验。图标必须通过 Pillow 的格式识别、
完整性验证与像素解码（动画图片检查所有帧），解码格式必须匹配扩展名；
截断文件或仅有文件头的文件会被拒绝。
保留 Pillow 的解压炸弹保护，相关警告按失败处理，不在校验过程中重写图标。
缺少 `darkIcon` 时客户端回退 `icon`。App 的
名称与图标不写入包，由 BFF 使用 Connector catalog 的权威元数据填充。

MCP V1 只允许：

- `type: "stdio"`：必须提供 `command`；`command` 必须是 PATH 中的解释器/可执行名，不得
  包含 `/` 或 `\\`。参数不得使用 POSIX、Windows drive 或 UNC 绝对路径；包内脚本通过参数
  中的显式相对路径引用，由运行时解析到 package root；
- `type: "streamable-http"`：必须提供 `url`；
- `type: "sse"`：必须提供 `url`。

官方包不接受 `type: "http"` alias、`auth`、OAuth 或 refresh 字段。Desktop 的 Claude Code
兼容 reader 可以接受的额外输入不属于官方 schema。

所有 JSON 文件均为 UTF-8、无 BOM 的 JSON object。JSON 空白与 key 顺序不会被运行时重新
canonicalize；它们是普通文件字节，改变后会改变 `content_digest`。

V1 每个 `name+version` 只有一个 universal package，不存在 OS/arch variant、安装脚本或
post-install step。包不能依赖 symlink、源 checkout executable bit 或平台专属 native binary；
需要脚本时应由已声明的跨平台解释器显式启动。P1B validator 负责对可静态识别的违规内容
fail closed。

## 3. Universal path contract

V1 为了在 Windows、macOS 和 Linux 上得到同一文件树，只接受 portable ASCII path：

- archive entry 和 manifest reference 必须是相对 POSIX path；
- segment 只允许 `[A-Za-z0-9._-]+`，`.` 和 `..` segment 禁止；
- 禁止绝对路径、盘符、UNC、反斜杠、空 segment、NUL 和控制字符；regular file entry
  与 manifest reference 禁止尾随 `/`。ZIP directory entry 如存在，必须以且仅以一个 `/`
  结尾，reader 去掉该结尾后按同一规则验证；
- 每个 segment 最多 128 bytes，完整 path 最多 512 bytes，最多 16 个 segment；
- Windows reserved basename（`CON`、`PRN`、`AUX`、`NUL`、`COM1`…`COM9`、
  `LPT1`…`LPT9`，包括带扩展名形式）禁止；
- exact duplicate、ASCII case-insensitive collision，以及 file/parent 类型冲突均拒绝；
- symlink、hardlink、device、FIFO、socket 和其他非普通文件 entry 均拒绝。

文件内容可以是任意 bytes；要求文本格式的文件再由对应 schema/validator 校验 UTF-8。因此
中文等 Unicode 内容合法，但 V1 文件名只使用 portable ASCII。未来如需 Unicode path，必须
新增 digest/path contract 版本，不能修改 V1。

## 4. 固定安全上限

Publisher 与两个运行时必须在写入目标目录前执行同一组 fail-closed 检查：

| 项目 | V1 上限 |
| --- | ---: |
| archive 原始字节 | 64 MiB |
| archive entries（含目录） | 2,048 |
| regular files | 1,024 |
| 单文件解包后字节 | 16 MiB |
| 全部 regular files 解包后总字节 | 64 MiB |
| path bytes | 512 |
| segment bytes | 128 |
| path segments | 16 |

V1 archive 是无 wrapper directory 的 ZIP，且只允许 `STORE`（method 0）：

- 不允许 encryption、data descriptor、ZIP64、multi-disk、archive/entry comment 或 extra field；
- directory entry 必须是零字节 `STORE` entry，且不进入 digest；Publisher 的确定性 archive
  不输出 directory entry；
- `STORE` 使 declared compressed size 必须等于 uncompressed size，从格式上消除压缩炸弹；
- reader 仍须同时验证 archive 大小、entry 数、单文件和累计实际写入字节，不能只信 central directory；
- 校验与解包写入临时目录；全部成功并通过 `content_digest` 后才可原子发布。

## 5. `content_digest`

V1 输出格式：

```text
sha256-tree-v1:<64 lowercase hex>
```

输入是经过第 3、4 节校验后的所有 regular files。directory、mode、mtime、uid/gid 和 archive
entry 顺序不参与 digest；空目录因此不影响结果。文件内容按原始 bytes 参与。

算法：

1. 将 relative path 编码为 ASCII bytes，按 path bytes 升序排列。
2. 初始化 SHA-256，并按顺序写入：

```text
ASCII "MINIMAX-PLUGIN-CONTENT-DIGEST" + 0x00
uint32_be(1)                         # contract version
uint32_be(file_count)
for each file:
  byte 0x46                          # "F"
  uint32_be(path_byte_length)
  path_bytes
  uint64_be(content_byte_length)
  content_bytes
```

3. 将 SHA-256 小写 hex 加上 `sha256-tree-v1:` 前缀。

长度字段使 path/content 边界无歧义。实现必须以 streaming 方式更新 hash，并在读文件过程中
再次执行累计字节上限。

## 6. Deterministic archive 与 `archive_sha256`

Publisher 按以下 V1 规则构建 ZIP：

- regular files 按 relative path bytes 升序；
- 只写 file entry，compression method 固定为 `STORE`；
- `version made by` 固定为 Unix 2.0（OS=3、version=20），`version needed to extract`
  固定为 1.0（10）；
- DOS timestamp 固定为 `1980-01-01 00:00:00`；
- internal attributes 固定为 0；external attributes 固定为 Unix regular file `0100644`
  左移 16 位，不依赖源 checkout mode；
- path 均为 ASCII，因此 general-purpose bit flag 固定为 0；extra field、entry comment 和
  archive comment 均为空；
- archive root 直接是 package root。

`archive_sha256` 是最终 ZIP 完整原始字节的 SHA-256 小写 64 位 hex，不带前缀。运行时只需先
验证实际下载 bytes，无需重新构造 ZIP。`archive_sha256` 通过后仍必须执行 entry 安全校验与
`content_digest`，两者不能互相替代。

## 7. Reference vectors

[`content-digest-v1.source.json`](../../test-vectors/plugins/content-digest-v1.source.json) 使用与真实文件树
等价的虚拟 entry 描述合法和拒绝场景；生成结果固定在
[`content-digest-v1.expected.json`](../../test-vectors/plugins/content-digest-v1.expected.json)。

vector 中的 `valid` 只表示 path/archive/digest contract 接受该虚拟文件树，不表示它已经通过
Plugin manifest、Skill frontmatter、App/MCP schema 等 P1B 语义校验。例如 empty tree 具有
定义明确的 tree digest，但不是可发布的官方 Plugin。

合法 vectors 覆盖空树、排序、空目录、mode/mtime 忽略、空文件和 UTF-8 内容；拒绝 vectors
覆盖 traversal、反斜杠、Unicode path、大小写/重复冲突、Windows reserved name、symlink、
特殊文件、STORE 之外的压缩方式以及单文件/累计大小边界。

任何语言的实现均应直接读取 checked-in expected vectors 做测试。只有在有意新增 contract
版本或补充不改变语义的场景时，才运行 generator 并 review expected diff。

## 8. 官方 Marketplace validator

`tools/validate_marketplace.py` 对仓库当前目录做一次完整、fail-closed 的校验，并输出供后续
Publisher 消费的确定性投影。它直接复用本规范第 3～6 节的 reference implementation，不定义
第二套 path、digest 或 archive 规则。

除 JSON Schema 外，validator 还执行以下跨文件语义：

- marketplace entry、`plugins/<name>` 目录和 manifest name 必须闭合；目录不能漏列，所有
  manifest 引用必须存在，能力形态文件不能存在未引用副本；
- JSON 必须是 UTF-8、无 BOM、无重复 key、无非标准数字的 object；Skill 使用安全 YAML
  loader，frontmatter 无重复 key，`name` 与目录一致且 `description` 非空；
- 当前 catalog 内 Plugin name 使用 NFKC + case-fold 后不得冲突；MCP server name 只在
  同一 Plugin 内按该规则判重，包括分散在多个 MCP 文件中的声明。不同 Plugin 可以声明同名
  MCP server 及同名 tool，运行时按 Plugin 身份区分并分配不冲突的名称。静态声明的 MCP tool
  在同一 Plugin 内按 `mcp__<server>__<tool>` 的 normalize/truncate 规则检查冲突；动态 tool
  由运行时分配名称。同一 Plugin 内的 Skill name 使用 NFKC + case-fold 判重，不同 Plugin
  可以声明同名 Skill，运行时名称固定为 `<plugin-name>:<skill-name>`；
- 同一 Plugin 不能重复引用同一 Connector provider；官方 MCP 仅接受 `stdio`、
  `streamable-http`、`sse`，JSON Schema 的封闭字段同时拒绝 `http` alias、OAuth/auth/refresh
  等声明；
- 可静态识别的 native binary 后缀和 `package.json` 的 `preinstall/install/postinstall` 生命周期
  脚本被拒绝。checkout executable bit 不进入 archive，stdio 只能通过 PATH interpreter 启动；
  Markdown shell 代码块中由 validator 可静态识别的 simple command、subshell 或 command
  substitution 若以 `.sh` 作为 command word（包括经 `env`、`command`、`sudo` 等 wrapper
  执行），必须显式使用 `bash`/`sh`/`zsh` 等解释器；
- 投影包含 manifest 元数据、App provider、每个 MCP server 的 canonical `transport` 与稳定
  compact/sorted `configJson`、每个 Skill 的完整 UTF-8 `SKILL.md` 正文，以及 package 的两个
  digest 和大小统计。`configJson` 的格式仅用于确定性传输，package digest 始终以原文件
  bytes 为准。

仓库根 catalog 与 `tests/fixtures/four-types` 中的 App-only、MCP-only、Skill-only、组合 Plugin
都在 CI 中执行 validator。fixture 不进入用户可见 catalog，也不会被正式 Publisher 发布。

## 9. Publisher 与部署边界

`tools/publish_marketplace.py` 只消费第 8 节完整校验成功后的投影，并重新构建第 6 节 archive；
两次计算的 SHA/size 不一致时拒绝发布。固定对象 key 为：

```text
plugin-marketplace/v1/packages/<name>/<version>/<archive_sha256>.zip
plugin-marketplace/v1/icons/<name>/<version>/<icon_sha256>.<ext>
```

默认与深色 Logo 都使用第二种按内容寻址的 key；内容不同自然得到不同 key。包写入 deployment
私有 package bucket，Logo 写入可匿名读取的 static bucket。Registry 的 `data_oss_key` 保存前者
key，`icon_url` / `dark_icon_url` 由该 deployment 的固定 HTTPS public base URL 与对应 Logo
逻辑 key 组成；`dark_icon_url` 缺失时消费端使用 `icon_url`。CN static bucket 的物理 key 在逻辑
key 前增加 `cdn-yingshi-ai-com/`，该前缀由
CDN 回源映射隐去，不进入 `icon_url`；US 物理 key 与逻辑 key 相同。两个 bucket 都使用 OSS
forbid-overwrite；同一物理 key 已存在时必须读取并验证 SHA 与大小，内容不同即拒绝，不能覆盖。

一个 deployment 的全部 package/icon 上传成功后，Publisher 才向受鉴权 Publisher Relay 的
固定环境 target 提交一次完整 catalog；Relay 通过生成代码的 typed Kitex client 发起无用户
`BaseReq` 的 `PublishPluginCatalog`。请求携带固定 `source_commit`，不携带 RPC 地址或泳道。
完整 catalog 的紧凑 JSON 请求体上限统一为 64 MiB；Publisher 必须在上传任何 OSS 对象前
完成全部目标 deployment 的大小预检，Relay 与 Ingress 也使用相同上限。
catalog 原子校验/登记/切换由 Registry 事务负责。CN 和 US 使用各自 bucket、public icon base
与固定 Relay target 并独立记录结果；单边失败不回滚成功侧，整体发布仍返回失败。同
commit+同内容重试由不可变 OSS 对象与 Registry `unchanged` 响应共同保证幂等。
