# claude-bridge

**English** | [中文](README_zh.md)

Bridge chat platforms to your local [Claude Code](https://claude.ai/claude-code). Chat with Claude from your phone — text, images, permission approvals, slash commands — via **Telegram**, **Feishu (飞书)**, or **WeChat**.

📖 **Running multiple bots?** See **[docs/multi-bot.md](docs/multi-bot.md)** — add, list, change, and remove bots. Telegram supports hot-add from chat (`/spawn`); Feishu supports multi-bot via setup + restart; WeChat is one account per daemon.

> **Attribution.** This project started as a fork of [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code). It has since been restructured into a monorepo with a channel-adapter architecture, migrated to the persistent-session pattern (one long-running Claude process instead of one per message), hardened against production issues (protocol headers, IDC redirect, WAF sanitization, session recovery, "always allow" permissions), and extended to support Telegram with multi-bot and hot-add via chat. See `git log` for the full list of changes.

## Features

- **Channel-adapter architecture** — Telegram, Feishu, and WeChat today; Discord/Slack/... trivially added by implementing the `Channel` interface
- **Multi-bot (Telegram + Feishu)** — one daemon runs many bots concurrently, each with its own project directory and isolated Claude session
- **Hot-add bots from chat (Telegram)** — `/spawn <token> <cwd>` registers a new bot without restarting anything
- **Persistent Claude sessions** — one long-running Claude Code process per bot, context stays in memory across messages
- **Real-time progress updates** — see Claude's tool calls (🔧 Bash, 📖 Read, 🔍 Glob…) as they happen
- **Thinking preview** — get a 💭 preview of Claude's reasoning before each tool call
- **Interrupt support** — send a new message mid-query to abort and redirect Claude
- **Permission approval** — reply `y` (allow once), `n` (deny), or `a` (always allow this tool) in chat
- **Image recognition** — send photos for Claude to analyze
- **Slash commands** — `/help`, `/clear`, `/model`, `/prompt`, `/status`, `/skills`, `/bots`, `/spawn`, `/rmbot`, and more
- **Cross-platform** — macOS (launchd), Linux (systemd + nohup fallback)

## Where to install

The project can live **anywhere** — it runs as a background daemon, not a Claude Code Skill. Any path works:

```bash
git clone https://github.com/lijunzhang-disabled/claude-bridge.git ~/projects/claude-bridge
# or
git clone https://github.com/lijunzhang-disabled/claude-bridge.git /opt/claude-bridge
# or wherever you want
```

`~/.claude/skills/claude-bridge/` is only needed if you want Claude Code to auto-discover this as a skill (so you can ask Claude Code "set up the bridge" and it finds `SKILL.md`). Not required to use the bot.

## Prerequisites

- Node.js >= 18
- macOS or Linux
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with `@anthropic-ai/claude-agent-sdk` installed
  > **Note:** The SDK supports third-party API providers (OpenRouter, AWS Bedrock, custom OpenAI-compatible endpoints) — set `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` accordingly.

### Channel-specific prerequisites

- **Telegram** (recommended): a bot token from [@BotFather](https://t.me/BotFather). Creating a bot is free and takes under a minute.
- **Feishu (飞书)**: a custom app from the [Feishu Open Platform](https://open.feishu.cn/app) with the bot capability enabled, long-connection (长连接) mode selected, and the `im.message.receive_v1` event subscribed. See the Feishu quick-start below for the full console walkthrough.
- **WeChat**: personal WeChat account. Update WeChat to the latest version and enable the ClawBot plugin in Settings → WeChat Plus (插件) before scanning.

## Installation

```bash
git clone https://github.com/lijunzhang-disabled/claude-bridge.git
cd claude-bridge
npm install
```

`postinstall` automatically compiles all packages via `tsc -b`.

## Quick Start — Telegram

### 1. Create a bot on Telegram

1. Open Telegram and search for **@BotFather** (the account with the blue checkmark). Or tap this link: [t.me/BotFather](https://t.me/BotFather).
2. Start the chat and send:
   ```
   /newbot
   ```
3. BotFather asks for a **display name** — e.g. `My Claude Bot`. This is what appears in chats.
4. Then a **username** — must be unique across Telegram and must end in `bot` (e.g. `my_claude_bot`, `junzhang_claude_bot`). If it's taken, BotFather asks again.
5. BotFather replies with your **HTTP API token**, which looks like:
   ```
   1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ...
   ```
   **Copy it and keep it secret** — anyone with this token can control the bot.
6. Find your Telegram **numeric user ID** by messaging [@userinfobot](https://t.me/userinfobot) — it replies with your ID (a number like `123456789`). The bot only accepts messages from this user; everyone else is ignored.
7. **Open your new bot's chat** (search for its `@username` in Telegram) and tap **Start**. This tells Telegram the bot has permission to message you.

### 2. Setup

```bash
npm run setup -- telegram
```

Setup prompts for three things:

- **Bot token** — paste the one from BotFather in step 5
- **Your Telegram numeric user ID** — from step 6
- **Working directory** — the project path this bot will operate on (e.g. `/Users/you/projects/api`)

Setup validates the token via Telegram's `getMe` API, then persists the credentials to `~/.claude-bridge/accounts/telegram-<botId>.json`.

### 3. Start the daemon

```bash
npm run daemon -- start
```

- **macOS**: registers a launchd agent for auto-start and auto-restart
- **Linux**: uses systemd user service (falls back to nohup if systemd unavailable)

### 4. Chat

Send any message to your Telegram bot and Claude will respond.

### Add more bots (later)

Either run `npm run setup -- telegram` again (then `npm run daemon -- restart`), **or** message an existing bot:

```
/spawn <new_token> /path/to/new/project
```

The new bot is live immediately — no daemon restart. Full details in [docs/multi-bot.md](docs/multi-bot.md).

## Quick Start — Feishu (飞书)

Feishu uses an outbound long-connection (WebSocket) to receive events, so no public URL or webhook setup is required — it works behind NAT just like Telegram.

### 1. Create a custom app on the Feishu Open Platform

Open [open.feishu.cn/app](https://open.feishu.cn/app) → 创建企业自建应用. Then, in the app's console:

1. **应用能力 (App Features)** → enable **机器人 (Bot)**. Without this, the message-receive permission cannot be added.
2. **事件与回调 (Events & Callbacks) → 事件配置** → switch 推送方式 (Push Method) to **长连接 (Long Connection)**.
3. On the same page, **添加事件 (Add Event)** → search and add **接收消息 v2.0** (`im.message.receive_v1`).
4. **权限管理 (Permissions)** → enable these scopes:
   - `im:message:receive_v1` (Get direct messages sent to bot)
   - `im:message:send_as_bot` (Send messages as the application)
   - `im:resource` (Read message resource — needed for image attachments)
5. **版本管理与发布** → 创建版本 → submit for tenant-admin approval, then **publish** the released version.
6. **凭证与基础信息 (Credentials)** → copy the **App ID** (looks like `cli_xxx`) and **App Secret**.

### 2. Setup

```bash
npm run setup -- lark
```

Setup prompts for three things:

- **App ID** — from step 6 above
- **App Secret** — from step 6 above
- **Working directory** — the project path this bot operates on

Setup validates the credentials by acquiring a `tenant_access_token`, then persists them to `~/.claude-bridge/accounts/lark-<appId>.json`.

### 3. Start the daemon

```bash
npm run daemon -- start
```

### 4. Claim ownership and chat

Open Feishu, search for your bot by its display name, and **send the first message yourself**. The first inbound message claims you as the owner — the daemon writes your `open_id` into the account file and ignores everyone else thereafter.

> If the bot doesn't appear in Feishu search, double-check that the app version is **已发布 (Released)** under 版本管理与发布, not just approved, and that your account is within the app's 可用范围 (Availability) under 应用功能 → 机器人.

### Add more Feishu bots

Repeat steps 1-2 for a separate custom app, then `npm run daemon -- restart`. Hot-add via `/spawn` is Telegram-only (it relies on a bot-token-only registration flow that doesn't fit Feishu's app model). All other multi-bot commands (`/bots`, `/pause`, `/resume`, `/rmbot`) work the same. See [docs/multi-bot.md](docs/multi-bot.md).

## Quick Start — WeChat (alternative)

```bash
npm run setup -- wechat
```

A QR code image opens — scan it with WeChat (requires the ClawBot plugin enabled). Configure working directory. Then:

```bash
npm run daemon -- start
```

WeChat is currently limited to one account per daemon.

## Daemon management

```bash
npm run daemon -- status     # check if running
npm run daemon -- stop       # stop
npm run daemon -- restart    # restart (after code updates)
npm run daemon -- logs       # recent logs
```

## Chat Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear the current session (start fresh) |
| `/reset` | Full reset including working directory |
| `/model <name>` | Switch Claude model |
| `/permission <mode>` | Switch permission mode |
| `/prompt [text]` | View or set a system prompt appended to every query |
| `/status` | View current session state |
| `/cwd [path]` | View or switch working directory (session-only) |
| `/skills` | List installed Claude Code skills |
| `/history [n]` | View last N chat messages |
| `/compact` | Start a new SDK session (clear token context) |
| `/undo [n]` | Remove last N messages from history |
| `/yolo` / `/un-yolo` | Auto-approve every tool for this bot (dangerous) / back to normal |
| `/bots` | **Telegram + Feishu** — list all bots (running + paused) |
| `/spawn <token> <cwd>` | **Telegram only** — hot-add a new bot |
| `/pause [accountId]` | **Telegram + Feishu** — pause a bot (defaults to current); keeps data, frees ~200MB RAM |
| `/resume <accountId>` | **Telegram + Feishu** — resume a paused bot |
| `/rmbot <accountId>` | **Telegram + Feishu** — stop and delete a bot |
| `/<skill> [args]` | Trigger any installed skill |

## Permission Approval

When Claude requests to execute a tool, you'll receive a permission request:

- `y` or `yes` — allow once
- `n` or `no` — deny
- `a` or `always` — allow and auto-approve all future calls to this tool for the session
- No response within 10 minutes = auto-deny

Switch permission mode with `/permission <mode>`:

| Mode | Description |
|------|-------------|
| `default` | Manual approval for each tool use |
| `acceptEdits` | Auto-approve file edits, other tools need approval |
| `plan` | Read-only mode, no tools allowed |
| `auto` | Auto-approve all tools (dangerous mode) |

## Architecture

```
Chat platform  ←→  Channel adapter  ←→  Daemon  ←→  PersistentSession  ←→  Claude Code
  (Telegram /          (implements          (orchestration,     (one long-running
   Feishu /             Channel              permissions,        claude process per
   WeChat /             interface)           multi-bot runtime)  bot, context in RAM)
   Discord)
```

- The daemon polls each configured channel for inbound messages
- Messages are routed to the right bot's long-running Claude Code process
- Tool calls and thinking previews are streamed back as Claude works
- Each bot has its own working directory and isolated session state

### Adding a new channel

Implement `Channel` from `@claude-bridge/core`:

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

Reference implementations: `packages/channel-telegram/src/telegram-channel.ts`, `packages/channel-lark/src/lark-channel.ts`, `packages/channel-wechat/src/wechat-channel.ts`.

## Repository layout

```
claude-bridge/
├── packages/
│   ├── core/                 # PersistentSession, permission broker, Channel interface
│   ├── channel-wechat/       # WeChat adapter (iLink bot API)
│   ├── channel-telegram/     # Telegram adapter (grammy)
│   ├── channel-lark/         # Feishu/Lark adapter (open-platform WebSocket)
│   └── daemon/               # orchestrator — DaemonRuntime, message loop
├── docs/
│   └── multi-bot.md          # multi-bot guide
├── scripts/
│   └── daemon.sh             # cross-platform service manager
└── packages/<pkg>/src/       # TypeScript sources per package
```

## Data

All data is stored in `~/.claude-bridge/`:

```
~/.claude-bridge/
├── accounts/       # channel account credentials (one JSON per bot)
├── config.env      # global config (channel, working dir, model, permission mode, system prompt)
├── sessions/       # per-account session data
├── get_updates_buf # WeChat message polling sync buffer (if using WeChat)
└── logs/           # rotating logs (daily, 30-day retention)
```

Override the location with the `CLAUDE_BRIDGE_DATA_DIR` environment variable.

## Development

```bash
npm run build    # compile all packages
npm run dev      # watch mode, auto-compile
npm run clean    # remove all dist/
```

## License

[MIT](LICENSE) — see `LICENSE` for the full text. Forked from [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) (also MIT).
