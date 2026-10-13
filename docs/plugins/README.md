# 写一个 MiniMax Code Plugin

本文是外部作者的上手路径：从零到一个可提交校验的 Plugin 包。目标是让你在本地
就能跑出与官方 CI 同一条校验命令，避免提交后才发现格式问题。

## 1. 先跑通环境

```bash
git clone https://github.com/MiniMax-AI/minimax-code.git
cd minimax-code
pnpm install
pnpm verify --profile docs
```

最后一条必须先通过。它验证的是本仓库自身的公开边界，能跑通说明你的环境是对的——
这是整条路径的信任锚点。

## 2. 创建一个 Plugin 包

一个 Plugin 是一个独立目录，根下必须有 `.minimax-plugin/plugin.json`：

```text
my-plugin/
  .minimax-plugin/plugin.json
  skills/research/SKILL.md
  my-tool.mcp.json
```

最小的 manifest：

```json
{
  "schemaVersion": 1,
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "一句话说明这个 Plugin 做什么。",
  "author": "你的名字或组织",
  "icon": "icon.png",
  "category": "Code",
  "exampleQueries": ["用它做一件具体的事"],
  "apps": [],
  "mcpServers": ["my-tool.mcp.json"],
  "skills": ["skills/research/SKILL.md"]
}
```

`name` 必须与目录名一致。`category` 只能取 `Office`、`Studio`、`Design & Sites`、
`Code`、`Business`、`Sales`、`Productivity`、`Science & Healthcare`、`Education`、`Other`。
`apps`、`mcpServers`、`skills`、`hooks` 至少有一项非空。

完整字段与约束见 [Plugin 包格式 V1](package-format-v1.md)。

## 3. 本地校验

```bash
node tools/plugins/validate-plugin.mjs path/to/my-plugin
```

或用仓库脚本：

```bash
pnpm check:plugin path/to/my-plugin
```

这条校验与 `pnpm verify --profile docs` 内部执行的是**同一段代码**，所以本地通过
意味着 CI 也会通过。它会检查：

- manifest 是否满足 `schemas/plugins/plugin-v1.schema.json`
- 被引用的 App / MCP / Hook 文件是否存在且满足各自 schema
- 每个 Skill 的 frontmatter 是否包含与目录一致的 `name` 和非空 `description`
- 路径是否为 V1 允许的 portable ASCII path（禁止绝对路径、`..`、反斜杠、Windows 保留名）

退出码 `0` 表示通过，`1` 表示发现问题，`2` 表示用法错误。

## 4. 提交

通过校验后按仓库的贡献流程提交 Plugin：先开 issue 描述你的 Plugin 与改动范围，
再从 fork 提 PR。PR 描述里请贴上 `validate-plugin.mjs` 的真实输出。

## 5. 这条校验不覆盖什么

本地校验**不等于**发布通过。以下由官方 Marketplace validator 在提交时执行：

- catalog 成员资格（Plugin 是否进入官方目录）
- 跨文件能力闭合（manifest 引用与实际文件树完全一致）
- archive 体积与 entry 上限、`content_digest` 计算
- icon 与 Showcase 媒体的真实字节校验

因此请不要把本地校验通过理解为"可以直接上架"。它保证的是包**格式正确**，
而不是包**内容合格**。

## 6. 参考

| 主题 | 文档 |
| --- | --- |
| 包格式、路径契约、安全上限、digest | [package-format-v1.md](package-format-v1.md) |
| Host Binding 扩展 | [host-bindings.md](host-bindings.md) |
| Showcase 案例配置 | [showcases.md](showcases.md) |
| JSON Schema | `schemas/plugins/` |
| 路径与 digest 参考向量 | `test-vectors/plugins/` |
