---
name: claude-bridge
description: Bridge chat platforms (Telegram, WeChat, ...) to local Claude Code. Supports multi-bot, permission approval, images, slash commands.
---

# claude-bridge

Run a daemon that connects chat apps (Telegram by default, WeChat also supported) to your local Claude Code. Multi-bot, hot-add from chat, permission approval, images, slash commands.

## Prerequisites

- Node.js >= 18
- macOS or Linux
- Claude Code (`@anthropic-ai/claude-agent-sdk`)
- Telegram bot token from @BotFather (for Telegram), or a personal WeChat account with the ClawBot plugin enabled (for WeChat)

## Trigger scenarios

Triggered when the user mentions "Telegram bot", "WeChat bridge", "claude bridge", "connect my bot", "set up telegram claude", "chat bot for claude code", etc.

## Behavior when triggered

**When triggered, do not take any actions immediately.** First probe the current state, then present the user with actionable options.

Assume the project lives at the directory that contains this `SKILL.md` file (so relative commands work). Shell commands below assume that working directory.

### Step 1: Check if dependencies are installed

```bash
test -d node_modules && echo "installed" || echo "not_installed"
```

- If `not_installed`: tell the user to run `npm install` (from the project directory). Stop.

### Step 2: Check which channels are configured

```bash
ls ~/.claude-bridge/accounts/*.json 2>/dev/null | head -3
```

- If no account files: tell the user no channel is set up yet. Ask which channel they want (Telegram recommended) and run `npm run setup -- telegram` or `npm run setup -- wechat`.
- If account files exist: continue.

### Step 3: Check daemon status

```bash
npm run daemon -- status
```

### Step 4: Show status summary

**If the daemon is not running:**

```
claude-bridge is configured but not running.

Options:
  setup    Add a new bot (run npm run setup -- <channel>)
  start    Start the daemon (npm run daemon -- start)
  logs     View recent logs (npm run daemon -- logs)
```

**If the daemon is running:**

```
claude-bridge is running (PID: xxx, N bots).

Options:
  stop     Stop the daemon
  restart  Restart after code changes
  logs     Tail recent logs

Chat commands (send in Telegram/WeChat):
  /help                 List all commands
  /bots                 List running bots (Telegram)
  /spawn <token> <cwd>  Add a new Telegram bot without restart
  /rmbot <accountId>    Remove a bot
  /clear                Start a fresh conversation
  /status               Show session state
```

If the user explicitly requests an action (e.g. "start the bot", "stop it", "show logs"), skip the status preview and run the corresponding command directly.

## Subcommand reference

All commands run from the project directory.

| Command | Executes | Description |
|---------|----------|-------------|
| setup | `npm run setup -- <channel>` | Interactive setup for telegram or wechat |
| start | `npm run daemon -- start` | Start the daemon (launchd/systemd) |
| stop | `npm run daemon -- stop` | Stop the daemon |
| restart | `npm run daemon -- restart` | Restart |
| status | `npm run daemon -- status` | Show status |
| logs | `npm run daemon -- logs` | Tail recent logs |

## Data directory

All data is stored in `~/.claude-bridge/`:

```
~/.claude-bridge/
├── accounts/       # one JSON per configured bot
├── config.env      # global config (channel, working dir, model, permission mode)
├── sessions/       # per-account session state
├── logs/           # daily log files (30-day retention)
└── get_updates_buf # WeChat polling sync buffer (if using WeChat)
```

Override the location with `CLAUDE_BRIDGE_DATA_DIR`.

## Multi-bot

One daemon can run many Telegram bots simultaneously, each with its own working directory. See `docs/multi-bot.md` in the project directory.

## Permission approval

When Claude requests a tool, the user receives a permission prompt in chat:

- `y` / `yes` — allow once
- `n` / `no` — deny
- `a` / `always` — allow and auto-approve future calls to that tool (per-session)
- 10-minute timeout auto-denies
