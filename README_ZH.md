<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/wordmark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/wordmark-light.svg">
    <img src="docs/assets/wordmark-light.svg" alt="MiniMax Code" width="760">
  </picture>
</p>

<h1 align="center">MiniMax Code</h1>
<p align="center">A terminal coding agent with MiniMax, your own models, and tools beyond code.</p>
<p align="center">
  <a href="#快速开始">Get started</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="docs/examples.md">Examples</a> ·
  <a href="CONTRIBUTING.md">Contributing</a>
</p>
<p align="center"><a href="README.md">English</a> · <strong>简体中文</strong></p>
<p align="center">
  <img src="docs/assets/source-preview.svg" alt="Source preview">
  <img src="docs/assets/node.svg" alt="Compatibility: Node.js 22.19+, 24.2+, 25, and 26">
  <a href="LICENSE-STATUS.md"><img src="docs/assets/license.svg" alt="First-party default license: MIT"></a>
</p>

在终端里读懂项目、修改代码并运行测试。使用 MiniMax 账号或自己的模型，把搜索、插件和多模态工具接入同一个工作流。

[![MiniMax Code 真实 TUI：修复 clamp、查看代码 diff 并运行测试](docs/assets/tui-demo.png)](docs/demo.md)

<p align="center"><a href="docs/demo.md">观看 20 秒真实演示 →</a> · 真实终端输出回放，已压缩等待时间</p>

## 快速开始

### 1. 安装 MCode

按操作系统选择官方安装器。安装器会安装最新版 CLI，并在需要时准备兼容的 Node.js，无需 `sudo` 或管理员权限；目前不支持 Alpine / musl Linux。

**macOS / Linux / WSL**

```bash
curl -fsSL https://filecdn.minimax.chat/public/install.sh | bash
```

**Windows（PowerShell）**

```powershell
irm https://filecdn.minimax.chat/public/install.ps1 | iex
```

脚本在 macOS / Linux / WSL 上默认安装到 `~/.minimax-code`，在 Windows 上默认安装到 `%USERPROFILE%\.minimax-code`。POSIX 启动器为 `bin/mcode` 和 `bin/mcode-tools`；Windows 启动器为 `mcode.cmd` / `mcode.ps1` 和 `mcode-tools.cmd` / `mcode-tools.ps1`。安装前设置 `MCODE_INSTALL_DIR` 可更改安装位置。移除 CLI 的方法见[卸载](#卸载)。

**npm**：适用于已安装 **Node.js 22.19+（22.x）、24.2+（24.x）、25 或 26** 的环境。

```bash
npm install -g @minimax-ai/code@latest --registry=https://registry.npmjs.org/ --ignore-scripts=false --include=optional --allow-scripts=@minimax-ai/code,better-sqlite3
```

该 npm 命令使用公共 registry，包含可选的 SQLite 依赖，并允许执行主包和 SQLite 的安装脚本。固定版本和 Node.js 兼容范围见[安装指南](docs/installation.md)。

重新打开终端后检查安装：

```bash
mcode --version
mcode --help
```

参阅官网的[快速开始](https://agent.minimaxi.com/docs/cli/quick-start)、[功能与配置](https://agent.minimaxi.com/docs/cli/features)和[故障排查](https://agent.minimaxi.com/docs/cli/faq)。

### 2. 登录账号或配置 API Key

中国大陆账号运行：

```bash
mcode login
```

Global 账号运行：

```bash
mcode login --region global
```

在浏览器中完成登录，再启动 `mcode`，通过 `/status` 检查账号、通过 `/provider` 选择模型。退出登录使用 `mcode logout`。

Token Plan 需要账号与可用额度。从本仓库构建的版本与已发布的 npm CLI `@minimax-ai/code@0.4.12` 均默认将用户数据保存在 `~/.minimax`（选择 profile 时为 `~/.minimax-<profile>`）。`MINIMAX_DATA_DIR` 或 `MAVIS_DATA_DIR` 可以覆盖数据目录。安装脚本使用的 `~/.minimax-code` 安装目录与数据目录的选择是两回事。查找或删除配置和会话前，请参阅[账号与数据](docs/installation.md#accounts-and-data)。

<details>
<summary>使用自己的 API Key（BYOK）</summary>

BYOK 无需先登录 MiniMax。先在当前 shell 中设置 `MCODE_PROVIDER_API_KEY`，再添加提供方；将下方示例地址和模型名替换为实际配置：

```bash
mcode provider add --name my-provider --base-url https://example.com/v1 \
  --api-format openai-completions --model my-model \
  --api-key-env MCODE_PROVIDER_API_KEY --use
mcode
```

`--use` 会先测试第一个模型，成功后保存并设为默认模型；连接测试失败时不保存。省略 `--use` 则仅保存，不测试，也不改变默认模型。对于自定义或本地模型，可添加 `--context-limit 32768 --output-limit 4096`（请填写服务器的实际限制）。两个值都必须是正安全整数，并应用于所有重复指定的 `--model`。可通过 `mcode provider list --json` 查看已配置的限制。省略这两个参数时保持现有的模型限制默认值。

支持 `openai-completions`、`openai-responses` 和 `anthropic-messages`。连接测试、单次模型切换及环境变量设置见 [模型示例](docs/examples.md#2-choose-your-own-model)。

</details>

### 3. 完成第一个任务

进入要处理的项目目录：

```bash
cd /path/to/your/project
mcode
```

在 TUI 中描述任务，也可以在启动时直接提交：

```bash
mcode "Find a failing test, fix the implementation, and run the relevant tests."
```

使用 `mcode init .` 生成或更新 `AGENTS.md` 项目指导。任务中应说明期望结果、修改边界和验证方式。

| 入口 | 命令 | 适用场景 |
| --- | --- | --- |
| 交互式 TUI | `mcode [prompt]` | 探索代码、持续对话、审阅修改与权限确认。 |
| Headless | `mcode exec [prompt]` | Shell、CI、批处理与评测。 |
| ACP | `mcode acp` | 支持 Agent Client Protocol 的编辑器与客户端。 |

### 继续之前的工作

```bash
# 恢复当前工作区最近的会话
mcode --continue

# 打开会话选择器
mcode --session
```

在 TUI 中输入 `/sessions` 查找历史会话，输入 `/help` 查看完整命令与快捷键。

| 操作 | 快捷键 |
| --- | --- |
| 发送消息，或在任务运行中调整当前响应 | `Enter` |
| 在任务运行中将后续消息加入队列 | `Alt+Enter` |
| 在输入框中换行 | `Shift+Enter` |
| 引用工作区文件或目录 | `@` |
| 切换 Plan Mode | `Shift+Tab` |
| 切换权限模式 | `Alt+M` |
| 关闭面板或中断正在运行的任务 | `Esc` |

## 卸载

卸载前请关闭正在运行的 MCode 会话，包括编辑器中的集成。先通过 `command -v mcode`（macOS / Linux / WSL）或 `Get-Command mcode -All`（PowerShell）定位命令，再按对应的安装方式操作。当前官方安装脚本**不提供卸载参数**。

### 通过脚本安装

以下命令会删除默认安装目录，包括两个启动器、下载的版本，以及安装器管理的 Node.js 运行时。如果使用过 `MCODE_INSTALL_DIR`，请替换为实际安装目录。删除前请先检查：早期源码构建曾将用户数据保存在 `~/.minimax-code`，自定义数据目录也可能与安装目录重合。请先备份需要保留的配置和会话。

**macOS / Linux / WSL**

```bash
rm -rf -- "$HOME/.minimax-code"
```

从安装器修改的 shell 配置文件中删除 `# MiniMax Code CLI` 注释及其下一行 PATH 配置：zsh 使用 `~/.zshrc`；bash 依次选择 `~/.bashrc`、`~/.bash_profile`、`~/.profile` 中第一个已存在的文件，均不存在时创建 `~/.bashrc`；fish 使用 `~/.config/fish/config.fish`；其他 shell 使用 `~/.profile`。对应配置为 `export PATH="/absolute/install/path/bin:$PATH"`，fish 则为 `fish_add_path -g "/absolute/install/path/bin"`。只移除 MCode 对应的条目，保留其他 PATH 设置。如果设置了 `MCODE_NO_MODIFY_PATH` 或路径已存在，安装器会跳过此修改。

**Windows（PowerShell）**

```powershell
Remove-Item -LiteralPath "$env:USERPROFILE\.minimax-code" -Recurse -Force
```

打开“编辑账户的环境变量”，编辑用户 **Path**，仅删除安装目录对应的条目（默认为 `%USERPROFILE%\.minimax-code`，也可能显示为展开后的绝对路径）。Windows 安装器修改的是用户 Path，不是 PowerShell 配置文件；设置 `MCODE_NO_MODIFY_PATH` 会跳过此持久化修改。

### 通过 npm 或源码安装

全局 npm 安装请使用当初安装 MCode 时的同一套 npm 和安装前缀：

```bash
npm uninstall -g @minimax-ai/code
```

源码构建请先保存工作，再仅删除自己创建的源码目录，详见[更新或移除](docs/installation.md#update-or-remove)。

卸载后重新打开终端（编辑器集成终端需要完全重启编辑器），再次运行 `command -v mcode` 或 `Get-Command mcode -All`。没有结果表示 PATH 中已找不到该命令。如果出现另一份安装，请先确认它的安装方式再移除。

### 可选：删除用户数据

移除程序会保留单独存储的用户数据。如果还要删除本地登录状态、提供方配置、缓存和会话，请先按[账号与数据](docs/installation.md#accounts-and-data)确认实际数据目录，并备份需要保留的内容。其他 MCode 安装可能共用该目录。以下命令仅适用于默认的 `~/.minimax`：

```bash
# macOS / Linux / WSL — 永久删除默认用户数据
rm -rf -- "$HOME/.minimax"
```

```powershell
# Windows — 永久删除默认用户数据
Remove-Item -LiteralPath "$env:USERPROFILE\.minimax" -Recurse -Force
```

profile 使用 `~/.minimax-<profile>`；`MINIMAX_DATA_DIR` 或 `MAVIS_DATA_DIR` 可以指定其他位置。只删除确定不再需要的具体目录，不要使用通配符批量删除。如果不再需要自行添加的 MCode 环境变量，也请从 shell 配置或用户环境变量设置中移除对应赋值。

## 可以做什么

| 场景 | 使用方式 |
| --- | --- |
| **修改与验证代码** | 读取文件、编辑 diff、执行 Shell 和测试；通过权限与沙箱控制工具执行。 |
| **选择模型** | MiniMax 账号 / Token Plan，或兼容 OpenAI、Anthropic 格式的自定义提供方。 |
| **搜索与多模态** | 内置搜索、`mcode-tools` 媒体工具、MCP 和托管连接器；按账号权限和服务额度使用。 |
| **延续工作** | 会话恢复、任务规划、子 Agent、官方 / 本地 / GitHub 插件与内置 Skills。 |
| **接入工作流** | Headless CLI 用于脚本任务，ACP 用于兼容的编辑器和客户端。 |

账号、更新、反馈与诊断能力也在。托管工具需要网络和相应授权，详细边界见 [能力与服务边界](docs/tui-capabilities.md)。

## 试一试

在示例目录启动 TUI，输入：

> Read clamp.mjs and clamp.test.mjs. Run node --test to reproduce the failure, fix clamp without changing the tests, then run the tests again.

这个 [可复现的小项目](examples/clamp) 就是上方演示使用的任务。[更多示例](docs/examples.md) 包括切换模型、执行真实搜索，以及使用自己的图片输入。

## 从源码构建

开发 MCode 或运行本仓库源码需要 Git、Node.js **22.19+（22 系列）、24.2+（24 系列）、25 或 26**，以及 **pnpm 9.12.0**。

```bash
git clone https://github.com/MiniMax-AI/minimax-code.git
cd minimax-code
pnpm install --frozen-lockfile
pnpm build
pnpm mcode
```

首次构建需要联网；依赖和经过校验的 `mcode-tools` 均来自公共 npm。pnpm 安装、系统依赖和更新方法见[源码安装指南](docs/installation.md)。

从源码目录运行时，将上方示例中的 `mcode` 替换为 `pnpm mcode`。要在自己的项目中工作，先切换到项目目录，再运行构建产物：

```bash
node /absolute/path/to/minimax-code/dist/cli.js
```

本仓库目标为 **0.4.12 源码预览**。安装已发布的包与构建本仓库是两条独立路径，版本一致不代表构建来源完全相同，详见[版本与证据基线](docs/open-source-status.md#version-and-evidence-baseline)。

## 文档与贡献

- [安装与更新](docs/installation.md) · [使用示例](docs/examples.md) · [TUI 状态栏](packages/tui/docs/status-line-config.md)
- [贡献指南](CONTRIBUTING.md) · [报告 Bug / 提出建议](https://github.com/MiniMax-AI/minimax-code/issues/new/choose) · [报告安全问题](SECURITY.md)
- [全部文档](docs/README.md)：架构、能力对照、验证记录、源码同步和发布流程。

项目文档以英文为主，本页为首页的简体中文译文。

目前仅接受仓库协作者提交代码和文档 Pull Request。如果你不是协作者，但有想法或方案，欢迎先通过 [Issue](https://github.com/MiniMax-AI/minimax-code/issues/new/choose) 讨论。请在报告中移除密钥、账号信息和私人项目内容。

## 桌面版与问题反馈

<a href="https://agent.minimaxi.com/download" title="下载 MiniMax Code">
  <img src="https://filecdn.minimax.chat/public/c3ebbd2e-f55b-48d7-adff-030abb63e06d.png" alt="MiniMax Code 桌面版 — 点击下载" width="100%" />
</a>

[下载 macOS 或 Windows 桌面版](https://agent.minimaxi.com/download) · [报告问题或提问](https://github.com/MiniMax-AI/minimax-code/issues/new/choose)

本仓库也承接 MiniMax Code 桌面版的问题反馈。公开源码范围为终端 TUI、Headless CLI 和 ACP，不包含桌面应用源码。提交 Issue 时请选择对应产品。桌面版问题请注明应用版本、操作系统，以及「设置 → 通用 → 上传日志」生成的日志上传 ID（如可用）；CLI 问题请注明 `mcode --version`、运行入口与最小复现。报告中请移除凭据和私人项目内容。

## 许可

第一方代码默认采用 [MIT](LICENSE)；文件或子包已有独立声明时保留原许可。依赖、资源与 `mcode-tools` 的许可分别见 [第三方声明](THIRD_PARTY_NOTICES.md) 和 [许可状态](LICENSE-STATUS.md)。
