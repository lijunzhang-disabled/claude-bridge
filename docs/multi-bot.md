# Managing multiple Telegram bots

The daemon can run multiple Telegram bots simultaneously — one per
conversation/project. Each bot has:

- its own working directory
- its own Claude Code subprocess with independent context
- its own permission state (auto-approved tools, `/clear` scope)
- its own session history

> **WeChat note.** WeChat currently supports one account per daemon (one
> QR scan = one account). Multi-bot is a Telegram-only feature today.

---

## Quick reference

| Action | From terminal | From chat |
|---|---|---|
| Add a bot | `npm run setup -- telegram` + restart | `/spawn <token> <cwd>` (hot-load) |
| List bots | daemon startup log / `ls accounts/` | `/bots` |
| Remove a bot | delete JSON files + restart | `/rmbot <accountId>` |
| Change working dir | re-run setup with same token + restart | *(re-run `/spawn`)* |

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

## Listing configured bots

```bash
ls ~/.claude-bridge/accounts/ | grep '^telegram-'
```

Each `telegram-<botId>.json` is a plain JSON file showing the bot's
token, owner user ID, and working directory.

Or just read the daemon's startup log:

```bash
npm run daemon -- logs
```

### From chat

Send `/bots` to any running bot. It lists every bot the daemon is
currently running, with its accountId and working directory. Your own
bot is marked `(you)`.

```
Running bots:

  telegram-8569776287 (you)  @bot1  /path/to/project1
  telegram-9999999999        @bot2  /path/to/project2
```

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
