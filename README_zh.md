# claude-bridge

[English](README.md) | **中文**

将聊天平台桥接到本地 [Claude Code](https://claude.ai/claude-code)。在手机上通过 **Telegram** 或微信与 Claude 对话——文字、图片、权限审批、斜杠命令全部支持。

📖 **运行多个机器人？** 请看 **[docs/multi-bot.md](docs/multi-bot.md)** —— 添加、列出、修改、删除机器人（含聊天中 `/spawn` 热添加）。*仅支持 Telegram* —— 微信当前限制为每个 daemon 一个账号。

> **致谢。** 本项目源自 [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) 的 fork，之后进行了较大改动：重构为 monorepo + channel 适配器架构；迁移到 persistent session 模型；修复了多个生产问题（协议头、IDC 重定向、WAF 清洗、会话恢复、"始终允许"权限等）；扩展支持 Telegram 及多机器人 + 聊天热添加。完整改动见 `git log`。

## 功能特性

- **Channel 适配器架构** —— 当前支持 Telegram + 微信，添加 Discord/Slack/... 只需实现 `Channel` 接口
- **多机器人（Telegram）** —— 一个 daemon 同时运行多个机器人，各自独立的工作目录与 Claude 会话
- **聊天热添加** —— 在已有机器人中发送 `/spawn <token> <cwd>` 即可注册新机器人，无需重启
- **持久化 Claude 会话** —— 每个机器人一个长期运行的 Claude Code 进程，上下文在内存中保留
- **实时进度推送** —— 实时查看 Claude 的工具调用（🔧 Bash、📖 Read、🔍 Glob…）
- **思考预览** —— 每次工具调用前展示 💭 Claude 的推理摘要
- **中断支持** —— 在 Claude 处理中发送新消息可打断当前任务
- **权限审批** —— 聊天中回复 `y`（允许）、`n`（拒绝）、`a`（始终允许此工具）
- **图片识别** —— 发送照片让 Claude 分析
- **斜杠命令** —— `/help`、`/clear`、`/model`、`/prompt`、`/status`、`/skills`、`/bots`、`/spawn`、`/rmbot` 等
- **跨平台** —— macOS（launchd）、Linux（systemd + nohup 回退）

## 安装位置

本项目**可以放在任何位置** —— 它作为后台 daemon 运行，不是 Claude Code Skill。任意路径均可：

```bash
git clone https://github.com/lijunzhang-disabled/claude-bridge.git ~/projects/claude-bridge
# 或
git clone https://github.com/lijunzhang-disabled/claude-bridge.git /opt/claude-bridge
# 或任意路径
```

只有当你希望 Claude Code 将此项目作为 skill 自动发现（通过 `SKILL.md`）时，才需要放在 `~/.claude/skills/claude-bridge/`。日常使用机器人不需要这样做。

## 前置条件

- Node.js >= 18
- macOS 或 Linux
- 已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（含 `@anthropic-ai/claude-agent-sdk`）
  > **注意：** 该 SDK 支持第三方 API 提供商（OpenRouter、AWS Bedrock、自定义 OpenAI 兼容接口）——按需设置 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_API_KEY` 即可。

### 各 channel 的前置条件

- **Telegram**（推荐）：来自 [@BotFather](https://t.me/BotFather) 的机器人 token。创建机器人免费且耗时不到一分钟。
- **微信**：个人微信账号。请先将微信更新到最新版本，并在 设置 → 插件 中启用 ClawBot（龙虾）插件。

## 安装

```bash
git clone https://github.com/lijunzhang-disabled/claude-bridge.git
cd claude-bridge
npm install
```

`postinstall` 会自动通过 `tsc -b` 编译所有 package。

## 快速开始 —— Telegram

### 1. 在 Telegram 创建机器人

1. 打开 Telegram，搜索 **@BotFather**（带蓝色认证标的账号）。或点击 [t.me/BotFather](https://t.me/BotFather)。
2. 开始聊天并发送：
   ```
   /newbot
   ```
3. BotFather 会问你机器人的**显示名称** —— 例如 `My Claude Bot`。这是聊天中显示的名字。
4. 再问**用户名** —— 必须全局唯一，且必须以 `bot` 结尾（例如 `my_claude_bot`、`junzhang_claude_bot`）。如果已被占用 BotFather 会让你再试。
5. BotFather 返回你的 **HTTP API token**，形如：
   ```
   1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ...
   ```
   **复制并保密** —— 任何拿到这个 token 的人都能控制你的机器人。
6. 给 [@userinfobot](https://t.me/userinfobot) 发一条消息，它会返回你的 **Telegram 数字用户 ID**（类似 `123456789`）。机器人只接受来自这个用户的消息，其他人发的都会被忽略。
7. **打开你的新机器人**（在 Telegram 中搜索它的 `@username`），点 **Start**。这样机器人就有权给你发消息了。

### 2. 设置

```bash
npm run setup -- telegram
```

setup 会依次询问三项：

- **Bot token** —— 第 5 步从 BotFather 复制的那个
- **你的 Telegram 数字用户 ID** —— 第 6 步获得的
- **工作目录** —— 该机器人对应的项目路径（例如 `/Users/you/projects/api`）

setup 会通过 Telegram 的 `getMe` 接口验证 token，然后把凭证保存到 `~/.claude-bridge/accounts/telegram-<botId>.json`。

### 3. 启动 daemon

```bash
npm run daemon -- start
```

- **macOS**：注册 launchd agent，开机自启 + 崩溃自动重启
- **Linux**：使用 systemd user service（不可用时回退到 nohup）

### 4. 聊天

在 Telegram 中向你的机器人发送任何消息，Claude 就会回复。

### 稍后添加更多机器人

两种方式任选其一：再次运行 `npm run setup -- telegram`（然后 `npm run daemon -- restart`），**或**在已有机器人中发送：

```
/spawn <新 token> /path/to/new/project
```

新机器人立即可用 —— 无需重启 daemon。详见 [docs/multi-bot.md](docs/multi-bot.md)。

## 快速开始 —— 微信（替代方案）

```bash
npm run setup -- wechat
```

会自动弹出二维码图片 —— 用微信扫码（需启用 ClawBot 插件），然后配置工作目录。接着：

```bash
npm run daemon -- start
```

微信当前限制为每个 daemon 一个账号。

## 服务管理

```bash
npm run daemon -- status     # 查看状态
npm run daemon -- stop       # 停止
npm run daemon -- restart    # 重启（代码更新后）
npm run daemon -- logs       # 查看日志
```

## 聊天命令

| 命令 | 说明 |
|------|------|
| `/help` | 查看可用命令 |
| `/clear` | 清除当前会话 |
| `/reset` | 完全重置（包括工作目录） |
| `/model <名称>` | 切换 Claude 模型 |
| `/permission <模式>` | 切换权限模式 |
| `/prompt [文本]` | 查看或设置附加到每次查询的系统提示词 |
| `/status` | 查看会话状态 |
| `/cwd [路径]` | 查看或切换工作目录（仅当前会话） |
| `/skills` | 列出已安装的 Claude Code skills |
| `/history [n]` | 查看最近 N 条对话 |
| `/compact` | 开启新 SDK 会话 |
| `/undo [n]` | 删除最近 N 条历史 |
| `/bots` | **Telegram** —— 列出所有运行中的机器人 |
| `/spawn <token> <cwd>` | **Telegram** —— 热添加新机器人 |
| `/rmbot <accountId>` | **Telegram** —— 停止并删除机器人 |
| `/<skill> [参数]` | 触发已安装的 skill |

## 权限审批

Claude 请求执行工具时，你会收到权限请求：

- `y` 或 `yes` —— 本次允许
- `n` 或 `no` —— 拒绝
- `a` 或 `always` —— 允许并自动批准后续所有对此工具的调用（本次会话）
- 10 分钟内未回复视为拒绝

通过 `/permission <模式>` 切换模式：

| 模式 | 说明 |
|------|------|
| `default` | 每次工具调用都需手动批准 |
| `acceptEdits` | 自动批准文件编辑，其他工具需要审批 |
| `plan` | 只读模式，不允许任何工具 |
| `auto` | 自动批准所有工具（危险模式） |

## 架构

```
聊天平台  ←→  Channel 适配器  ←→  Daemon  ←→  PersistentSession  ←→  Claude Code
(Telegram /        (实现 Channel         (编排、权限、         (每个机器人一个
 微信 /             接口)                 多机器人运行时)      长期运行的 claude
 Discord)                                                      进程，上下文在内存)
```

- Daemon 从配置的 channel 拉取入站消息
- 消息路由到对应机器人的长期运行 Claude Code 进程
- Claude 工作过程中，工具调用和思考预览实时回传
- 每个机器人有独立的工作目录和会话状态

### 添加新 channel

实现 `@claude-bridge/core` 中的 `Channel` 接口。参考实现：
`packages/channel-telegram/src/telegram-channel.ts`、
`packages/channel-wechat/src/wechat-channel.ts`。

## 仓库结构

```
claude-bridge/
├── packages/
│   ├── core/                 # PersistentSession、权限 broker、Channel 接口
│   ├── channel-wechat/       # 微信适配器（iLink bot API）
│   ├── channel-telegram/     # Telegram 适配器（grammy）
│   └── daemon/               # 编排层 —— DaemonRuntime、消息循环
├── docs/
│   └── multi-bot.md          # 多机器人使用指南
├── scripts/
│   └── daemon.sh             # 跨平台服务管理脚本
└── packages/<pkg>/src/       # 每个 package 的 TypeScript 源码
```

## 数据存储

所有数据存放在 `~/.claude-bridge/`：

```
~/.claude-bridge/
├── accounts/       # channel 账号凭证（每个机器人一份 JSON）
├── config.env      # 全局配置（channel、工作目录、模型、权限模式、系统提示词）
├── sessions/       # 每账号会话数据
├── get_updates_buf # 微信消息轮询同步 buffer（使用微信时）
└── logs/           # 滚动日志（每日一份，保留 30 天）
```

可通过 `CLAUDE_BRIDGE_DATA_DIR` 环境变量覆盖存储位置。

## 开发

```bash
npm run build    # 编译所有 package
npm run dev      # watch 模式，自动编译
npm run clean    # 清空所有 dist/
```

## 许可证

[MIT](LICENSE) —— 完整条款见 `LICENSE`。Fork 自 [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code)（同为 MIT）。
