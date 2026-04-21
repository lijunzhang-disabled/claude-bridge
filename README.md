# claude-bridge

**English** | [中文](README_zh.md)

Bridge chat platforms to your local [Claude Code](https://claude.ai/claude-code). Chat with Claude from your phone — text, images, permission approvals, slash commands — over WeChat today, Telegram/Discord next.

> **Attribution.** This project started as a fork of [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code). It has since been restructured into a monorepo with a channel-adapter architecture, migrated to the persistent-session pattern (one long-running Claude process instead of one per message), and hardened against a number of production issues (iLink protocol headers, IDC redirect handling, WAF sanitization, session recovery, "always allow" permissions). See `git log` for the full list of changes.

## Features

- **Channel-adapter architecture** — WeChat today, Telegram/Discord trivially added by implementing the `Channel` interface
- **Persistent Claude session** — one long-running Claude Code process keeps context in memory across messages; no subprocess spawn per reply
- **Real-time progress updates** — see Claude's tool calls (🔧 Bash, 📖 Read, 🔍 Glob…) as they happen
- **Thinking preview** — get a 💭 preview of Claude's reasoning before each tool call
- **Interrupt support** — send a new message mid-query to abort and redirect Claude
- **Permission approval** — reply `y` (allow once), `n` (deny), or `a` (always allow this tool) in chat
- **Image recognition** — send photos for Claude to analyze
- **Slash commands** — `/help`, `/clear`, `/model`, `/prompt`, `/status`, `/skills`, and more
- **Cross-platform** — macOS (launchd), Linux (systemd + nohup fallback)

## Repository layout

```
claude-bridge/
├── packages/
│   ├── core/              # channel-agnostic: PersistentSession, permission broker, commands
│   ├── channel-wechat/    # WeChat adapter (iLink bot API)
│   └── daemon/            # orchestrator — selects a channel, runs the message loop
├── scripts/
│   └── daemon.sh          # cross-platform service manager
└── packages/<pkg>/src/    # TypeScript sources per package
```

## Prerequisites

- Node.js >= 18
- macOS or Linux
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) with `@anthropic-ai/claude-agent-sdk` installed
  > **Note:** The SDK supports third-party API providers (OpenRouter, AWS Bedrock, custom OpenAI-compatible endpoints) — set `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` accordingly.

### Channel-specific prerequisites

- **WeChat**: Personal WeChat account. Update WeChat to the latest version and enable the ClawBot plugin in Settings → WeChat Plus (插件) before scanning.

## Installation

```bash
git clone https://github.com/lijunzhang-disabled/claude-bridge.git ~/.claude/skills/claude-bridge
cd ~/.claude/skills/claude-bridge
npm install
```

`postinstall` automatically compiles all packages via `tsc -b`.

## Quick Start

### 1. Setup (first time only)

```bash
npm run setup           # defaults to wechat
# or explicitly:
npm run setup -- wechat
```

For WeChat: a QR code image will open — scan it. Then configure your working directory.

### 2. Start the daemon

```bash
npm run daemon -- start
```

- **macOS**: registers a launchd agent for auto-start and auto-restart
- **Linux**: uses systemd user service (falls back to nohup if systemd unavailable)

### 3. Chat

Send any message in your chat app to start talking to Claude Code.

### 4. Manage the service

```bash
npm run daemon -- status
npm run daemon -- stop
npm run daemon -- restart
npm run daemon -- logs
```

## Running multiple Telegram bots

One daemon can run multiple Telegram bots at once — each with its own
working directory, its own Claude Code subprocess, and isolated session
history. Run `npm run setup -- telegram` once per bot.

See **[docs/multi-bot.md](docs/multi-bot.md)** for adding, listing,
changing, and removing bots.

## Chat Commands

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/clear` | Clear current session (start fresh) |
| `/reset` | Full reset including working directory |
| `/model <name>` | Switch Claude model |
| `/permission <mode>` | Switch permission mode |
| `/prompt [text]` | View or set a system prompt appended to every query |
| `/status` | View current session state |
| `/cwd [path]` | View or switch working directory |
| `/skills` | List installed Claude Code skills |
| `/history [n]` | View last N chat messages |
| `/compact` | Start a new SDK session (clear token context) |
| `/undo [n]` | Remove last N messages from history |
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
  (WeChat /              (implements          (message          (one long-running
   Telegram /             Channel              orchestration,    claude process,
   Discord)               interface)           permissions)      context in memory)
```

- The daemon polls its configured channel for inbound messages
- Messages are forwarded to a single, long-running Claude Code process via streaming input
- Tool calls and thinking previews are streamed back as Claude works
- Responses go back through the same channel adapter

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

See `packages/channel-wechat/src/wechat-channel.ts` for a reference implementation.

## Data

All data is stored in `~/.wechat-claude-code/` (kept for backward compatibility with the upstream project):

```
~/.wechat-claude-code/
├── accounts/       # channel account credentials
├── config.env      # global config (channel, working dir, model, permission mode, system prompt)
├── sessions/       # per-account session data
├── get_updates_buf # WeChat message polling sync buffer
└── logs/           # rotating logs (daily, 30-day retention)
```

## Development

```bash
npm run build    # compile all packages
npm run dev      # watch mode, auto-compile
npm run clean    # remove all dist/
```

## License

[MIT](LICENSE) — see `LICENSE` for the full text. Forked from [Wechat-ggGitHub/wechat-claude-code](https://github.com/Wechat-ggGitHub/wechat-claude-code) (also MIT).
