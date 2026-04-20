# claude-bridge

[English](README.md) | **中文**

将聊天平台桥接到本地 [Claude Code](https://claude.ai/claude-code)。在手机上通过微信、Telegram、Discord 等与 Claude 对话——文字、图片、权限审批、斜杠命令全部支持。当前已支持微信，Telegram/Discord 通过实现 Channel 接口即可加入。

> **致谢。** 本项目源自 [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) 的 fork，之后进行了较大改动：重构为 monorepo + channel 适配器架构；迁移到 persistent session 模型（一个长期运行的 Claude 进程替代每条消息新起进程）；修复了多个生产问题（iLink 协议头、IDC 重定向、WAF 清洗、会话恢复、"始终允许"权限等）。完整改动见 `git log`。

## 功能特性

- **Channel 适配器架构** — 当前支持微信，添加 Telegram/Discord 只需实现 `Channel` 接口
- **持久化 Claude 会话** — 一个长期运行的 Claude Code 进程在内存中保留上下文，不再每条消息都起新进程
- **实时进度推送** — 实时查看 Claude 的工具调用（🔧 Bash、📖 Read、🔍 Glob…）
- **思考预览** — 每次工具调用前展示 💭 Claude 的推理摘要
- **中断支持** — 在 Claude 处理中发送新消息可打断当前任务
- **权限审批** — 聊天中回复 `y`（允许）、`n`（拒绝）、`a`（始终允许此工具）
- **图片识别** — 发送照片让 Claude 分析
- **斜杠命令** — `/help`、`/clear`、`/model`、`/prompt`、`/status`、`/skills` 等
- **跨平台** — macOS（launchd）、Linux（systemd + nohup 回退）

## 仓库结构

```
claude-bridge/
├── packages/
│   ├── core/              # 与 channel 无关：PersistentSession、权限 broker、命令
│   ├── channel-wechat/    # 微信适配器（iLink bot API）
│   └── daemon/            # 编排层 —— 选择 channel，运行消息循环
├── scripts/
│   └── daemon.sh          # 跨平台服务管理脚本
└── packages/<pkg>/src/    # 每个 package 的 TypeScript 源码
```

## 前置条件

- Node.js >= 18
- macOS 或 Linux
- 已安装 [Claude Code](https://docs.anthropic.com/en/docs/claude-code)（含 `@anthropic-ai/claude-agent-sdk`）
  > **注意：** 该 SDK 支持第三方 API 提供商（OpenRouter、AWS Bedrock、自定义 OpenAI 兼容接口）——按需设置 `ANTHROPIC_BASE_URL` 与 `ANTHROPIC_API_KEY` 即可。

### Channel 特定前置条件

- **微信**：个人微信账号。请先将微信更新到最新版本，并在 设置 → 插件 中启用 ClawBot（龙虾）插件。

## 安装

```bash
git clone https://github.com/lijunzhang-disabled/claude-bridge.git ~/.claude/skills/claude-bridge
cd ~/.claude/skills/claude-bridge
npm install
```

`postinstall` 脚本会自动通过 `tsc -b` 编译所有 package。

## 快速开始

### 1. 首次设置

```bash
npm run setup           # 默认使用 wechat
# 或显式指定：
npm run setup -- wechat
```

微信：会自动弹出二维码图片，用微信扫码后配置工作目录。

### 2. 启动服务

```bash
npm run daemon -- start
```

- **macOS**：注册 launchd agent，开机自启 + 崩溃自动重启
- **Linux**：使用 systemd user service（不可用时回退到 nohup）

### 3. 聊天

在对应的聊天应用中发送任何消息即可开始与 Claude Code 对话。

### 4. 服务管理

```bash
npm run daemon -- status
npm run daemon -- stop
npm run daemon -- restart
npm run daemon -- logs
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
| `/cwd [路径]` | 查看或切换工作目录 |
| `/skills` | 列出已安装的 Claude Code skills |
| `/history [n]` | 查看最近 N 条对话 |
| `/compact` | 开启新 SDK 会话 |
| `/undo [n]` | 删除最近 N 条历史 |
| `/<skill> [参数]` | 触发已安装的 skill |

## 权限审批

Claude 请求执行工具时，你会收到权限请求：

- `y` 或 `yes` — 本次允许
- `n` 或 `no` — 拒绝
- `a` 或 `always` — 允许并自动批准后续所有对此工具的调用（本次会话）
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
(微信 /            (实现 Channel         (消息编排、         (单一长期运行的
 Telegram /         接口)                 权限)              claude 进程，
 Discord)                                                     上下文在内存)
```

- Daemon 按照配置从对应 channel 拉取入站消息
- 消息通过 streaming input 转发给单一的长期运行 Claude Code 进程
- Claude 工作过程中，工具调用和思考预览实时回传
- 响应通过同一个 channel 适配器返回

### 添加新 channel

实现 `@claude-bridge/core` 中的 `Channel` 接口：

```typescript
export interface Channel {
  readonly name: string;
  setup(): Promise<void>;
  loadAccount(): AccountInfo | null;
  start(onMessage, onSessionExpired?): Promise<void>;
  stop(): void;
  sendText(to: string, contextToken: string, text: string): Promise<void>;
}
```

参考实现：`packages/channel-wechat/src/wechat-channel.ts`。

## 数据存储

所有数据存放在 `~/.wechat-claude-code/`（为与上游项目兼容沿用该目录）：

```
~/.wechat-claude-code/
├── accounts/       # channel 账号凭证
├── config.env      # 全局配置（channel、工作目录、模型、权限模式、系统提示词）
├── sessions/       # 每账号会话数据
├── get_updates_buf # 微信消息轮询同步 buffer
└── logs/           # 滚动日志（每日一份，保留 30 天）
```

## 开发

```bash
npm run build    # 编译所有 package
npm run dev      # watch 模式，自动编译
npm run clean    # 清空所有 dist/
```

## 许可证

[MIT](LICENSE) —— 完整条款见 `LICENSE`。Fork 自 [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code)（同为 MIT）。
