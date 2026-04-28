# Managing multiple bots

The daemon can run multiple bots simultaneously — one per
conversation/project. Each bot has:

- its own working directory
- its own Claude Code subprocess with independent context
- its own permission state (auto-approved tools, `/clear` scope)
- its own session history

Multi-bot is supported on **Telegram** and **Feishu**. The two differ in
how new bots get added:

- **Telegram** — full multi-bot, including hot-add from chat (`/spawn
  <token> <cwd>`). Adding a bot is one chat message, no daemon restart.
- **Feishu (飞书)** — multi-bot via terminal setup + daemon restart. Hot-add
  from chat is **not supported** because Feishu requires a per-app
  configuration in the Open Platform console (event subscription, scopes,
  version approval) that can't be automated from a chat command. All
  other commands (`/bots`, `/pause`, `/resume`, `/rmbot`) work the same.

> **WeChat note.** WeChat currently supports one account per daemon (one
> QR scan = one account). Multi-bot is not available for WeChat.

---

## Vocabulary

**`accountId`** — each bot's unique identifier. Stable across re-runs of
setup; used by every bot-management command.

- **Telegram bots:** `telegram-<botId>`, where `<botId>` is the numeric
  ID Telegram assigned your bot (the one BotFather's `getMe` returns).
- **Feishu bots:** `lark-<appId>` (with non-alphanumeric characters in
  the appId replaced by `_`), e.g. `lark-cli_a1b2c3d4`.

**`(you)` marker** — appears next to the bot you're currently chatting
with in `/bots` output. Helps you tell which chat you're in and which
bot you can't `/rmbot` yourself from.

---

## Quick reference

All chat commands run inside one of your bots; all terminal commands run
in the project directory.

| Action | From terminal | From chat |
|---|---|---|
| Add a Telegram bot | `npm run setup -- telegram` + restart | `/spawn <token> <cwd>` (hot-load, Telegram only) |
| Add a Feishu bot | `npm run setup -- lark` + restart | *(not available)* |
| List bots (running + paused) | daemon startup log / `ls accounts/` | `/bots` |
| Reset a bot's Claude conversation | — | `/clear` (in that bot) |
| Pause a bot (keep data, free RAM) | edit JSON `paused: true` + restart | `/pause` (in it) or `/pause <accountId>` (in another) |
| Resume a paused bot | edit JSON `paused: false` + restart | `/resume <accountId>` |
| Remove a bot (delete data) | delete JSON files + restart | `/rmbot <accountId>` (from another bot) |
| Auto-approve all tools | — | `/yolo` (in that bot) |
| Exit auto-approve | — | `/un-yolo` (in that bot) |
| Change working dir | re-run setup + restart | *(Telegram only: re-run `/spawn`)* |

Both the terminal and chat paths write to the same account files, so
they compose freely.

---

## Adding a bot

Two ways to register a new bot. Both end up writing the same account
file — pick whichever fits your situation.

### Option A: From chat (hot-add, no restart) — recommended

Use this once you have at least one working bot. No terminal access
required.

#### 1. Create the bot on Telegram

Open [@BotFather](https://t.me/BotFather):

```
/newbot
```

Follow the prompts — give it a name and a username ending in `_bot`.
BotFather replies with an **HTTP API token** (looks like
`1234567890:ABCdefGHI...`). Copy it.

#### 2. Start a chat with the new bot

On Telegram, search for the new bot by its `@username`, open the chat,
tap **Start**. This gives the bot permission to message you.

#### 3. Register it via an existing bot

Open your existing bot (`@bot1`) and send:

```
/spawn 1234567890:ABC...token...XYZ /path/to/new/project
```

`@bot1` validates the token, spins up the new bot, and replies:

```
✅ Registered @newbot (telegram-<id>) in /path/to/new/project.
You can start chatting with it on Telegram now.
⚠️ Remember to delete your /spawn message so the token is not
   left in chat history.
```

#### 4. Delete your `/spawn` message

The bot token is sensitive and Telegram keeps message history —
delete the `/spawn` line from the chat immediately after registration.

#### 5. Message the new bot

It's already polling. The owner is auto-set to your Telegram user ID
(the same user who ran `/spawn`).

---

### Option B: From the terminal (first bot, or when daemon isn't running)

Use this when you're setting up your **very first** bot (there's no
existing bot to `/spawn` from), or when you prefer a CLI flow.

#### 1. Create the bot on Telegram

Same as Option A step 1 — `/newbot` in [@BotFather](https://t.me/BotFather),
copy the token.

#### 2. Start a chat with the new bot

Same as Option A step 2 — tap **Start** in the new bot's chat.

#### 3. Run setup

```bash
cd /path/to/claude-bridge   # wherever you cloned the repo
npm run setup -- telegram
```

Setup prompts for three things:

- **Bot token** — paste the one from BotFather
- **Your Telegram user ID** — find via [@userinfobot](https://t.me/userinfobot)
- **Working directory** — the project path this bot operates on

Setup validates the token via `getMe`, creates
`~/.claude-bridge/accounts/telegram-<botId>.json`, and leaves
other bots untouched.

#### 4. Restart the daemon

```bash
npm run daemon -- restart
```

Startup will list every configured bot:

```
Started (channel=telegram, bots=2)
  - telegram-8569776287
  - telegram-<new bot id>
```

Send a message to `@newbot` and Claude will respond using the new
working directory. Other bots keep using theirs.

---

### Option C: Adding a Feishu bot

Feishu doesn't support `/spawn` (see the note at the top of this doc).
The flow is always: configure a custom app on the Open Platform, then
run setup, then restart the daemon.

#### 1. Create the custom app

In the [Feishu Open Platform](https://open.feishu.cn/app), create a new
企业自建应用 and:

- 应用能力 → enable 机器人
- 事件与回调 → set 推送方式 to 长连接 → add event `im.message.receive_v1`
- 权限管理 → enable `im:message:receive_v1`, `im:message:send_as_bot`,
  `im:resource`
- 版本管理与发布 → 创建版本 → submit and publish (admin approval)

The full step-by-step is in the [main README's Feishu quick-start](../README.md#quick-start--feishu-飞书).

#### 2. Run setup

```bash
npm run setup -- lark
```

Prompts for App ID, App Secret, and working directory. Setup validates
the credentials by acquiring a `tenant_access_token` and writes
`~/.claude-bridge/accounts/lark-<appId>.json`.

#### 3. Restart the daemon

```bash
npm run daemon -- restart
```

Startup will list every configured bot:

```
Started (channel=lark, bots=2)
  - lark-cli_old_app    cli_old_app  /path/to/project1
  - lark-cli_new_app    cli_new_app  /path/to/project2
```

#### 4. Claim ownership on the new bot

Open Feishu, find the new bot, send it a message. The first inbound
message claims you as the owner — the daemon writes your `open_id`
into the new account file. Other bots' owners are unaffected.

> A daemon can only run one channel type at a time (`channel=telegram`
> *or* `channel=lark`, set in `~/.claude-bridge/config.env`). To run
> Telegram and Feishu bots side-by-side you'd need two daemons with
> different `CLAUDE_BRIDGE_DATA_DIR` values.

---

## Listing configured bots

```bash
ls ~/.claude-bridge/accounts/
# telegram bots: telegram-<botId>.json
# feishu bots:   lark-<appId>.json
```

Each account file is plain JSON showing the bot's credentials, owner ID,
and working directory.

Or just read the daemon's startup log:

```bash
npm run daemon -- logs
```

### From chat

Send `/bots` to any running bot. It lists every bot the daemon knows
about — both running and paused — with its accountId, Telegram
username, and working directory. Your own bot is marked `(you)`.

```
Bots:

  ▶️  telegram-8569776287 (you)  @bot1  /path/to/project1
  ▶️  telegram-9999999999        @bot2  /path/to/project2
  ⏸   telegram-1234567890        @bot3  /path/to/project3

▶️ = running, ⏸ = paused (use /resume <accountId> to restart)
```

The `telegram-<number>` part is the accountId. You'll paste it into
`/pause`, `/resume`, or `/rmbot` commands.

---

## Changing a bot's working directory

Two options.

### Option A: Re-run setup (simplest)

Setup overwrites the account record when you paste the same token:

```bash
npm run setup -- telegram
# paste the same token, same user ID, new working directory
npm run daemon -- restart
```

### Option B: Edit the JSON directly

```bash
# Edit the file
nano ~/.claude-bridge/accounts/telegram-<botId>.json
# Change "workingDirectory": "/old/path" to the new path
# Save, then:
npm run daemon -- restart
```

> The in-chat `/cwd` command only updates the **session** working
> directory. It does not persist to the account file and is reset on
> daemon restart. Use one of the options above for a permanent change.

---

## Pausing and resuming a bot

Sometimes you want to stop a bot temporarily without losing its setup —
for example, to free up ~200 MB of RAM when you're not actively using
it. Pausing keeps the account file and the session history; only the
Claude Code subprocess and the Telegram poll are stopped.

### Pause

- **From the bot itself** (shortcut):
  ```
  /pause
  ```
  The bot replies, then goes offline. To bring it back, see *Resume* below.

- **From another bot:**
  ```
  /pause telegram-<botId>
  ```
  The current bot confirms: `⏸ Paused telegram-<id>. ...`

A paused bot is marked with `⏸` in `/bots` output and survives daemon
restarts — it won't come back on its own.

### Resume

From any **running** bot:
```
/resume telegram-<botId>
```

The daemon clears the paused flag, starts a fresh Claude Code subprocess
for that bot, and resumes Telegram polling. Chat history, `/yolo` state,
and auto-approved tools are all preserved.

> You can't resume a bot from itself (it isn't polling), so use another
> running bot — or restart the daemon (`npm run daemon -- restart`),
> which will bring back all non-paused bots and leave paused ones
> paused.

### Pause vs. Clear vs. Remove

| Command | Claude subprocess | Chat history | Account file |
|---|---|---|---|
| `/clear` | restarted (fresh context) | cleared | kept |
| `/pause` | stopped | kept | kept (+ `paused: true`) |
| `/resume` | started | restored from kept file | `paused: false` |
| `/rmbot` | stopped | deleted | deleted |

---

## Removing a bot

### Hot-remove from chat

From any **other** bot (you can't remove the bot you're currently
talking to), run:

```
/rmbot telegram-<botId>
```

The daemon will:

- stop that bot's Telegram polling
- close its Claude Code subprocess
- delete `~/.claude-bridge/accounts/telegram-<botId>.json`
- delete `~/.claude-bridge/sessions/telegram-<botId>.json`
- confirm back to you

This only cleans up the daemon's side. If you want to fully retire the
bot, also revoke it on @BotFather (below).

### Full cleanup (recommended)

Decommissioning is three steps: clean up on Telegram, on the daemon,
and in Claude Code.

### 1. Revoke or delete the bot on Telegram

Open [@BotFather](https://t.me/BotFather):

- `/revoke` — invalidates the bot token (keeps the bot itself)
- `/deletebot` — permanently deletes the bot

Do this first so the token can't be misused.

### 2. Delete the daemon's account record

```bash
rm ~/.claude-bridge/accounts/telegram-<botId>.json
```

### 3. Delete the daemon's session data

```bash
rm ~/.claude-bridge/sessions/telegram-<botId>.json
```

This clears the bot's chat history, model override, permission mode,
and stored `sdkSessionId`.

### 4. (Optional) Delete Claude Code's conversation file

Claude Code stores its own conversation transcript keyed by the
working directory:

```bash
ls ~/.claude/projects/
# find the directory matching the bot's working directory
rm -rf ~/.claude/projects/<matching-dir>
```

Skip this if you want to keep the conversation history for manual
inspection later.

### 5. Restart the daemon

```bash
npm run daemon -- restart
```

The removed bot is no longer listed or polled.

---

## Tips

- **`accountId` = `telegram-<botId>`** — the numeric bot ID from
  BotFather's `getMe` response. Stable across re-runs of setup.

- **One bot per project** is the cleanest mental model. The bot's
  identity *is* the project context — no `/cwd` switching needed.

- **Don't share tokens.** Each bot token is a secret. The daemon
  stores them with `0600` permissions in
  `~/.claude-bridge/accounts/`.

- **Memory usage.** Each bot spawns one `claude` subprocess (~200 MB
  RAM). Three to five bots is comfortable on a laptop; dozens will
  start to bite.

- **Owner restriction.** A bot only accepts messages from the
  Telegram user ID you set during setup. Anyone else's messages are
  silently dropped with a warning in the daemon log.

- **Permission isolation.** `/clear` in one bot's chat only clears
  *that bot's* session and auto-approved tools. The other bots keep
  their state.
