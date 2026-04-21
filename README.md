# claude-bridge

**English** | [中文](README_zh.md)

Bridge chat platforms to your local [Claude Code](https://claude.ai/claude-code). Chat with Claude from your phone — text, images, permission approvals, slash commands — via **Telegram** today, with WeChat also supported.

📖 **Running multiple bots?** See **[docs/multi-bot.md](docs/multi-bot.md)** — add, list, change, and remove bots (with hot-add from chat via `/spawn`).

> **Attribution.** This project started as a fork of [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code). It has since been restructured into a monorepo with a channel-adapter architecture, migrated to the persistent-session pattern (one long-running Claude process instead of one per message), hardened against production issues (protocol headers, IDC redirect, WAF sanitization, session recovery, "always allow" permissions), and extended to support Telegram with multi-bot and hot-add via chat. See `git log` for the full list of changes.

## Features

- **Channel-adapter architecture** — Telegram and WeChat today, Discord/Slack/... trivially added by implementing the `Channel` interface
- **Multi-bot (Telegram)** — one daemon runs many bots concurrently, each with its own project directory and isolated Claude session
- **Hot-add bots from chat** — `/spawn <token> <cwd>` registers a new bot without restarting anything
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
- **WeChat**: personal WeChat account. Update WeChat to the latest version and enable the ClawBot plugin in Settings → WeChat Plus (插件) before scanning.

## Installation

```bash
git clone https://github.com/lijunzhang-disabled/claude-bridge.git
cd claude-bridge
npm install
```

`postinstall` automatically compiles all packages via `tsc -b`.

## Quick Start — Telegram

### 1. Create a bot

Open [@BotFather](https://t.me/BotFather), send `/newbot`, follow the prompts. Copy the HTTP API token BotFather gives you.

Find your Telegram numeric user ID via [@userinfobot](https://t.me/userinfobot) — the bot will only accept messages from this user.

### 2. Setup

```bash
npm run setup -- telegram
```

Paste the token, your user ID, and the working directory for this bot. Setup validates the token via `getMe` and persists the credentials.

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
| `/bots` | **Telegram** — list all running bots |
| `/spawn <token> <cwd>` | **Telegram** — hot-add a new bot |
| `/rmbot <accountId>` | **Telegram** — stop and delete a bot |
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
   WeChat /             Channel              permissions,        claude process per
   Discord)             interface)           multi-bot runtime)  bot, context in RAM)
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

Reference implementations: `packages/channel-telegram/src/telegram-channel.ts`, `packages/channel-wechat/src/wechat-channel.ts`.

## Repository layout

```
claude-bridge/
├── packages/
│   ├── core/                 # PersistentSession, permission broker, Channel interface
│   ├── channel-wechat/       # WeChat adapter (iLink bot API)
│   ├── channel-telegram/     # Telegram adapter (grammy)
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
