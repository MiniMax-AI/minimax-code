# 主题配置指南

mcode TUI 的配色由**具名主题**决定，每个主题同时提供深色和浅色两套调色板。终端深浅背景默认由
终端证据自动探测，`/theme` 在此之上让用户切换主题、锁定明暗，并支持自己编写主题文件。

## TL;DR

输入 `/theme` 打开主题面板：

- `↑` / `↓` 移动光标，**实时预览**对应配色；`Enter` 保存并立即生效，`Esc` / `Ctrl+C` 取消并还原打开面板时的主题。
- `a` 在「自动 / 浅色 / 深色」之间循环。自动模式跟随终端探测结果，锁定后不再被终端证据覆盖。
- 每行右侧是配色条，面板底部显示当前外观、主题来源和说明。
- 主题选择写入运行时数据目录下的 `tui/tui-settings.json`；写入失败时面板保持打开并提示，不会丢失当前选择。
- `/theme` 是 `search-only` 命令：可以直接输入 `/theme` 使用，也能在命令搜索中找到，但不会出现在默认 slash 列表里。

## 内置主题

| 主题 ID | 名称 | 特点 |
| --- | --- | --- |
| `minimax` | MCode | 默认主题。MiniMax 蓝 + Catppuccin 语法高亮 |
| `midnight` | Midnight | 更深的蓝黑背景，抬高了前景对比度 |
| `graphite` | Graphite | 中性低彩度表面，长输出更安静 |
| `aurora` | Aurora | 偏青绿的次级色阶 |

每个主题都定义了完整的深色和浅色版本，因此终端切换到浅色时不会出现缺色或错配。`minimax`
的取值与主题系统引入前完全一致，现有用户不会看到任何视觉变化。

内置主题的正文色与 `line` 非文本色需要满足
[WCAG AA 对比度](./tui-foundation.md#主题与终端能力) 基线（正文 4.5:1、非文本 3:1），由
`packages/tui/test/unit/tui/theme/palettes.test.ts` 对全部主题、全部外观做回归校验。

## 配置落点

- 文件：`~/.minimax/tui/tui-settings.json`（即运行时数据目录下的 `tui/tui-settings.json`）。
- 键：`theme`，值是主题 ID，或 `主题ID/light`、`主题ID/dark` 锁定外观。

```json
{
  "tuiMode": "regular",
  "theme": "midnight"
}
```

`theme` 与 `tuiMode` 写在同一份文件里，写入其中一个不会覆盖另一个；文件中的未知键也会原样保留。
无法识别的 `theme` 值会回退到默认主题，不会阻断启动。

## 自定义主题文件

MCode 从运行时数据目录下的 `tui/themes/*.json` 读取用户主题。

- 一个文件提供一种外观。`aurora.json` 提供深色，`aurora-light.json` 提供浅色；两个文件的
  `name` 相同即组成一个可选主题。
- 没有提供的外观会回退到默认主题对应外观的调色板，因此只写深色文件也能正常使用。
- 文件名可以是任意 `.json`，主题 ID 取文件里的 `name`；`name` 不能包含 `/`，也不能与内置主题
  ID 相同（内置主题优先，冲突文件会被忽略并在加载问题里报告）。
- **热重载**：编辑正在使用的自定义主题文件后，保存即生效，无需重启。

### 文件格式

```json
{
  "name": "my-theme",
  "label": "My Theme",
  "description": "A custom MCode palette",
  "appearance": "dark",
  "vars": {
    "brand": "#68c0ff",
    "gray": "#949494"
  },
  "colors": {
    "brand": "brand",
    "signal": "brand",
    "accent": "brand",
    "text": "#d6d6d6",
    "muted": "gray",
    "line": "gray"
  },
  "syntax": {
    "text": "#cdd6f4",
    "mauve": "#cba6f7",
    "overlay2": "#9399b2"
  }
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 主题 ID，`[a-z0-9][a-z0-9._-]{0,63}` |
| `appearance` | 是 | `dark` 或 `light` |
| `label` / `description` | 否 | 面板中显示的名称与说明 |
| `vars` | 否 | 可复用的颜色别名 |
| `colors` | 是 | UI 颜色对象；可以只写要覆盖的字段 |
| `syntax` | 否 | 语法高亮色板；未写的色调沿用默认主题 |

`colors` 和 `syntax` 的值可以是：

- **hex 字面量**：`"#68c0ff"` 或三位简写 `"#6cf"`。
- **`vars` 引用**：在 `colors` / `syntax` 里写 `vars` 中定义的别名名。
- **空字符串** `""`：使用终端默认色。

`vars` 的值只能是 hex 字面量或空字符串——**不支持嵌套引用**（`vars.a` 不能再指向另一个 `vars` 键），
这类写法会在加载时被拒绝并给出定位到具体路径的错误。

只写部分 `colors` 字段即可，其余沿用默认主题对应外观的值——这样新增主题只需描述差异。

### 可用字段

`colors` 支持以下 21 个键：

`brand`、`wordmarkHighlight`、`wordmarkShadow`、`signal`、`orbit`、`accent`、`markdownHeading`、
`markdownCode`、`markdownLink`、`userMessageBg`、`diffAddedBg`、`diffRemovedBg`、`text`、`muted`、
`dim`、`border`、`line`、`success`、`warning`、`error`。

`syntax` 支持以下 13 个色调：

`blue`、`flamingo`、`green`、`mauve`、`overlay2`、`peach`、`pink`、`red`、`sapphire`、`subtext0`、
`teal`、`text`、`yellow`。

自定义主题不参与内置主题的对比度回归校验。终端只支持 16 色时，UI 颜色会映射到终端语义色，
语法色使用固定的 ANSI16 映射（与内置主题一致）。

## 终端能力与降级

主题只消费探测到的 terminal capability，不改变任何业务语义：

- 深浅背景优先采用 OSC 11 查询结果，其次是终端的 DEC 2031 上报，最后回退到 `COLORFGBG`；
- 锁定外观后（`/theme` 按 `a`，或配置里写 `主题ID/dark`），终端证据不再改变外观；
- ANSI16 / 256 / truecolor 逐级降级，不支持颜色时仍保持文本层级。

## 相关文件

| 路径 | 职责 |
| --- | --- |
| `src/tui/theme/contracts.ts` | 主题、调色板、语法色板的类型契约 |
| `src/tui/theme/palettes.ts` | 内置主题定义与默认主题 |
| `src/tui/theme/custom-themes.ts` | 自定义主题文件的发现、校验、加载与热重载 |
| `src/tui/theme/registry.ts` | 内置与自定义主题的合并、解析与回退 |
| `src/tui/theme/controller.ts` | 主题选择、外观锁定、终端明暗探测 |
| `src/tui/theme/runtime.ts` | 颜色与语法色板的活绑定 |
| `src/tui/features/settings/theme-picker.ts` | `/theme` 面板 |
| `src/host/tui-settings.ts` | `tui-settings.json` 读写 |
