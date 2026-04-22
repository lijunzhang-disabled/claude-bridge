import { createInterface } from 'node:readline';
import process from 'node:process';
import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import {
  createSessionStore,
  createPermissionBroker,
  routeCommand,
  PersistentSession,
  loadConfig,
  saveConfig,
  logger,
  DATA_DIR,
  type Session,
  type SendOptions,
  type CommandContext,
  type CommandResult,
  type Channel,
  type InboundMessage,
  type DaemonHooks,
  type SpawnBotResult,
} from '@claude-bridge/core';

import { WeChatChannel } from '@claude-bridge/channel-wechat';
import {
  TelegramChannel,
  listTelegramAccountIds,
  deleteTelegramAccount,
  loadTelegramAccount,
  saveTelegramAccount,
  registerTelegramAccount,
} from '@claude-bridge/channel-telegram';

// ---------------------------------------------------------------------------
// Channel selection
// ---------------------------------------------------------------------------

function createChannel(name: string, accountId?: string): Channel {
  switch (name) {
    case 'wechat':
      return new WeChatChannel();
    case 'telegram':
      return new TelegramChannel(accountId);
    default:
      throw new Error(`Unknown channel: ${name}. Supported: wechat, telegram`);
  }
}

/**
 * Map raw grammy / getMe errors to a friendlier hint so the user knows what
 * to try next. Returns empty string if we don't recognize the error.
 */
function diagnoseTokenError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('unauthorized') || m.includes('401')) {
    return 'Hint: the bot token is wrong or was revoked. Go to @BotFather → /mybots → pick the bot → API Token to copy a fresh token.';
  }
  if (m.includes('not found') || m.includes('404')) {
    return 'Hint: Telegram does not recognize this token. It may have been deleted via @BotFather.';
  }
  if (m.includes('etimedout') || m.includes('enotfound') || m.includes('network') || m.includes('fetch failed')) {
    return 'Hint: could not reach Telegram. Check your internet connection and any firewall/proxy.';
  }
  if (m.includes('too many requests') || m.includes('429')) {
    return 'Hint: rate-limited by Telegram. Wait a minute and try again.';
  }
  return '';
}

function listAccountIdsForChannel(name: string): string[] {
  switch (name) {
    case 'telegram':
      return listTelegramAccountIds();
    case 'wechat': {
      const probe = new WeChatChannel();
      const acc = probe.loadAccount();
      return acc ? [acc.accountId] : [];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// BotInstance — per-bot state
// ---------------------------------------------------------------------------

interface BotInstance {
  accountId: string;
  label: string;              // human-readable, e.g. "@mybot /path/to/project"
  userId?: string;
  channel: Channel;
  claudeSession: PersistentSession;
  session: Session;
  sharedCtx: { lastContextToken: string };
  activeAbortControllers: Map<string, AbortController>;
  permissionBroker: ReturnType<typeof createPermissionBroker>;
  /** The forever-running channel.start() promise. */
  polling: Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAX_MESSAGE_LENGTH = 2048;

function splitMessage(text: string, maxLen: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitIdx = remaining.lastIndexOf('\n', maxLen);
    if (splitIdx < maxLen * 0.3) splitIdx = maxLen;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }
  return chunks;
}

function promptUser(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const display = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
    rl.question(display, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

// ---------------------------------------------------------------------------
// DaemonRuntime — single source of truth for running bots. Supports
// hot-add (/spawn) and hot-remove (/rmbot) from chat.
// ---------------------------------------------------------------------------

class DaemonRuntime {
  private readonly instances = new Map<string, BotInstance>();
  private readonly channelName: string;
  private readonly config: ReturnType<typeof loadConfig>;
  private readonly sessionStore: ReturnType<typeof createSessionStore>;
  private stopping = false;

  constructor(channelName: string, config: ReturnType<typeof loadConfig>, sessionStore: ReturnType<typeof createSessionStore>) {
    this.channelName = channelName;
    this.config = config;
    this.sessionStore = sessionStore;
  }

  /**
   * Build a BotInstance for an already-saved account and start its channel
   * polling in the background. Used by bootstrap and by addTelegramBot.
   */
  private startBotForAccount(accountId: string): BotInstance {
    if (this.instances.has(accountId)) {
      throw new Error(`Bot already running: ${accountId}`);
    }

    const channel = createChannel(this.channelName, accountId);
    const account = channel.loadAccount();
    if (!account) {
      throw new Error(`Failed to load account: ${accountId}`);
    }

    const session: Session = this.sessionStore.load(account.accountId);
    const desiredCwd = account.workingDirectory ?? this.config.workingDirectory;
    if (desiredCwd && session.workingDirectory === process.cwd()) {
      session.workingDirectory = desiredCwd;
      this.sessionStore.save(account.accountId, session);
    }
    if (session.state !== 'idle') {
      logger.warn('Resetting stale session state', { accountId, state: session.state });
      session.state = 'idle';
      this.sessionStore.save(account.accountId, session);
    }

    const effectivePermissionMode = session.permissionMode ?? this.config.permissionMode;
    const isAutoPermission = effectivePermissionMode === 'auto';
    const sdkPermissionMode = isAutoPermission ? 'bypassPermissions' as const : effectivePermissionMode;
    const cwd = (session.workingDirectory || account.workingDirectory || this.config.workingDirectory || process.cwd())
      .replace(/^~/, process.env.HOME || '');

    const claudeSession = new PersistentSession({
      cwd,
      model: session.model,
      systemPrompt: this.config.systemPrompt,
      permissionMode: sdkPermissionMode,
      resume: session.sdkSessionId,
    });
    claudeSession.start();

    const sharedCtx = { lastContextToken: '' };
    const activeAbortControllers = new Map<string, AbortController>();
    const permissionBroker = createPermissionBroker(async () => {
      try {
        await channel.sendText(account.userId ?? '', sharedCtx.lastContextToken, '⏰ Permission request timed out, auto-denied.');
      } catch {
        logger.warn('Failed to send permission timeout message', { accountId });
      }
    });

    const label = this.labelFor(accountId, cwd);

    // Build the instance first so message handlers can reference it.
    const inst: BotInstance = {
      accountId: account.accountId,
      label,
      userId: account.userId,
      channel,
      claudeSession,
      session,
      sharedCtx,
      activeAbortControllers,
      permissionBroker,
      polling: Promise.resolve(), // replaced below
    };

    inst.polling = channel.start(
      async (msg: InboundMessage) => {
        await handleMessage(msg, inst, this.sessionStore, this.config, this.hooksForInstance(inst));
      },
      () => {
        logger.warn('Channel session expired', { accountId });
        console.error(`⚠️ Channel session expired for ${accountId}.`);
      },
    ).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.stopping) return;
      logger.error('Channel stopped unexpectedly', { accountId, error: msg });
    });

    this.instances.set(accountId, inst);
    logger.info('Bot instance started', { accountId, cwd, channel: this.channelName });
    return inst;
  }

  private labelFor(accountId: string, cwd: string): string {
    if (this.channelName === 'telegram' && accountId.startsWith('telegram-')) {
      const data = loadTelegramAccount(accountId);
      if (data) return `@${data.botUsername || accountId}  ${cwd}`;
    }
    return `${accountId}  ${cwd}`;
  }

  /**
   * Build the DaemonHooks object passed to CommandContext. Binds the
   * triggering instance so /spawn etc. can reply back through it.
   */
  private hooksForInstance(triggerInst: BotInstance): DaemonHooks {
    return {
      addTelegramBot: (token, cwd) => this.addTelegramBot(token, cwd, triggerInst),
      removeBot: (accountId) => this.removeBot(accountId, triggerInst),
      pauseBot: (accountId) => this.pauseBot(accountId, triggerInst),
      resumeBot: (accountId) => this.resumeBot(accountId, triggerInst),
      listBots: () => this.listBots(),
    };
  }

  /** Return true if a telegram account is marked paused. */
  private isPaused(accountId: string): boolean {
    if (!accountId.startsWith('telegram-')) return false;
    const data = loadTelegramAccount(accountId);
    return Boolean(data?.paused);
  }

  /** Persist the paused flag on a telegram account file. */
  private setPausedFlag(accountId: string, paused: boolean): boolean {
    if (!accountId.startsWith('telegram-')) return false;
    const data = loadTelegramAccount(accountId);
    if (!data) return false;
    data.paused = paused;
    saveTelegramAccount(data);
    return true;
  }

  async bootstrap(accountIds: string[]): Promise<void> {
    for (const id of accountIds) {
      if (this.isPaused(id)) {
        logger.info('Skipping paused bot on bootstrap', { accountId: id });
        continue;
      }
      try {
        this.startBotForAccount(id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('Failed to bootstrap bot', { accountId: id, error: msg });
      }
    }
  }

  /** Add and hot-load a new Telegram bot. Invoked via /spawn. */
  async addTelegramBot(
    token: string,
    workingDirectory: string,
    triggerInst: BotInstance,
  ): Promise<SpawnBotResult> {
    const send = (text: string) =>
      triggerInst.channel.sendText(triggerInst.userId ?? '', triggerInst.sharedCtx.lastContextToken, text)
        .catch((err) => logger.warn('Failed to send spawn response', { error: String(err) }));

    // Pre-validation — send the error to the chat before throwing so the user
    // always sees something after the initial "⏳ Validating…" placeholder.
    if (this.channelName !== 'telegram') {
      await send(`⚠️ /spawn is only available when channel=telegram (current: ${this.channelName}).`);
      throw new Error(`addTelegramBot called with channel=${this.channelName}`);
    }

    const ownerUserId = Number(triggerInst.userId);
    if (!Number.isFinite(ownerUserId) || ownerUserId <= 0) {
      await send('⚠️ Cannot determine your Telegram user ID from this chat. Try again from a different bot.');
      throw new Error('Cannot determine triggering user ID for ownership');
    }

    let registered;
    try {
      registered = await registerTelegramAccount({ token, ownerUserId, workingDirectory });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const hint = diagnoseTokenError(raw);
      await send(`⚠️ Failed to validate token with Telegram.\n\n${raw}${hint ? '\n\n' + hint : ''}`);
      throw err;
    }

    if (this.instances.has(registered.accountId)) {
      // Already running — registration overwrote the account file, but we
      // should pick up any config changes. Simplest: stop + restart it.
      logger.info('Bot already running, restarting with new config', { accountId: registered.accountId });
      await this.removeBotInternal(registered.accountId, /* deleteData */ false);
      await send(`ℹ️ @${registered.username} was already registered — restarting with the new working directory.`);
    }

    try {
      this.startBotForAccount(registered.accountId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await send(`⚠️ Registered @${registered.username} but failed to start polling: ${msg}\n\nThe account file is saved at ~/.claude-bridge/accounts/${registered.accountId}.json. Restart the daemon to retry.`);
      throw err;
    }

    const line = [
      `✅ Registered @${registered.username} (${registered.accountId})`,
      `   in ${workingDirectory}`,
      '',
      `Open the chat with @${registered.username} and tap Start, then send a message.`,
      'If the bot doesn\'t respond, the Start tap is usually the missing step.',
      '',
      '⚠️ Delete your /spawn message now so the token does not stay in chat history.',
    ].join('\n');
    await send(line);

    return {
      accountId: registered.accountId,
      username: registered.username,
      workingDirectory,
    };
  }

  /**
   * Pause a bot: stop polling + close Claude subprocess, keep the account and
   * session files. Persists paused=true so daemon restarts don't revive it.
   * Self-pause is allowed — to resume, use another bot or restart the daemon.
   */
  async pauseBot(accountId: string, triggerInst?: BotInstance): Promise<boolean> {
    const send = triggerInst
      ? (text: string) =>
          triggerInst.channel.sendText(triggerInst.userId ?? '', triggerInst.sharedCtx.lastContextToken, text)
            .catch((err) => logger.warn('Failed to send pause response', { error: String(err) }))
      : async (_text: string) => {};

    const isSelf = Boolean(triggerInst && accountId === triggerInst.accountId);

    if (!this.isPaused(accountId) && !this.instances.has(accountId)) {
      await send(`⚠️ Unknown bot: ${accountId}`);
      return false;
    }

    if (!this.instances.has(accountId)) {
      await send(`ℹ️ ${accountId} is already paused.`);
      return false;
    }

    // Set paused flag first so if startup races, next bootstrap skips it.
    if (!this.setPausedFlag(accountId, true)) {
      await send(`⚠️ Could not mark ${accountId} as paused (account data missing).`);
      return false;
    }

    // Send confirmation BEFORE teardown. If this is self-pause, the bot's
    // own channel is about to be torn down — sending afterwards would fail.
    const confirmation = isSelf
      ? `⏸  Paused. I'll be gone until you send /resume ${accountId} from another bot (or restart the daemon).`
      : `⏸  Paused ${accountId}. Its account + session are kept; /resume to restart.`;
    await send(confirmation);

    await this.removeBotInternal(accountId, /* deleteData */ false);
    logger.info('Bot paused', { accountId, isSelf });
    return true;
  }

  /**
   * Resume a paused bot: clear the paused flag and start polling + Claude
   * again. Returns false if the bot is unknown or already running.
   */
  async resumeBot(accountId: string, triggerInst?: BotInstance): Promise<boolean> {
    const send = triggerInst
      ? (text: string) =>
          triggerInst.channel.sendText(triggerInst.userId ?? '', triggerInst.sharedCtx.lastContextToken, text)
            .catch((err) => logger.warn('Failed to send resume response', { error: String(err) }))
      : async (_text: string) => {};

    if (this.instances.has(accountId)) {
      await send(`ℹ️ ${accountId} is already running.`);
      return false;
    }

    if (!accountId.startsWith('telegram-') || !loadTelegramAccount(accountId)) {
      await send(`⚠️ Unknown bot: ${accountId}`);
      return false;
    }

    if (!this.setPausedFlag(accountId, false)) {
      await send(`⚠️ Could not update ${accountId}'s account file.`);
      return false;
    }

    try {
      this.startBotForAccount(accountId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await send(`⚠️ Failed to resume ${accountId}: ${msg}`);
      throw err;
    }

    logger.info('Bot resumed', { accountId });
    await send(`▶️  Resumed ${accountId}.`);
    return true;
  }

  /** Stop and remove a bot (and its account + session data). */
  async removeBot(accountId: string, triggerInst?: BotInstance): Promise<boolean> {
    const existed = this.instances.has(accountId);
    await this.removeBotInternal(accountId, /* deleteData */ true);

    if (triggerInst) {
      const reply = existed
        ? `✅ Removed bot ${accountId} and deleted its data.`
        : `⚠️ Unknown bot: ${accountId}`;
      await triggerInst.channel.sendText(triggerInst.userId ?? '', triggerInst.sharedCtx.lastContextToken, reply)
        .catch((err) => logger.warn('Failed to send rmbot response', { error: String(err) }));
    }
    return existed;
  }

  private async removeBotInternal(accountId: string, deleteData: boolean): Promise<void> {
    const inst = this.instances.get(accountId);
    if (inst) {
      try { inst.claudeSession.close(); } catch {}
      try { inst.channel.stop(); } catch {}
      // The polling promise will resolve naturally once channel.stop() kicks in.
      this.instances.delete(accountId);
      logger.info('Bot instance removed', { accountId });
    }

    if (deleteData) {
      if (accountId.startsWith('telegram-')) {
        deleteTelegramAccount(accountId);
      }
      this.sessionStore.remove(accountId);
    }
  }

  listBots(): Array<{ accountId: string; label: string; status: 'running' | 'paused' }> {
    const running = Array.from(this.instances.values()).map((inst) => ({
      accountId: inst.accountId,
      label: inst.label,
      status: 'running' as const,
    }));

    // Enumerate paused accounts on disk (known to the daemon's channel) that
    // aren't currently running.
    const paused: Array<{ accountId: string; label: string; status: 'paused' }> = [];
    if (this.channelName === 'telegram') {
      for (const id of listTelegramAccountIds()) {
        if (this.instances.has(id)) continue;
        if (!this.isPaused(id)) continue;
        const data = loadTelegramAccount(id);
        const label = data
          ? `@${data.botUsername || id}  ${data.workingDirectory}`
          : id;
        paused.push({ accountId: id, label, status: 'paused' });
      }
    }

    return [...running, ...paused];
  }

  size(): number {
    return this.instances.size;
  }

  shutdown(): void {
    this.stopping = true;
    for (const inst of this.instances.values()) {
      try { inst.claudeSession.close(); } catch {}
      try { inst.channel.stop(); } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

/**
 * Detect whether a daemon process is already running on this host. Used to
 * decide whether to tell the user to `start` or `restart` after setup.
 * Uses pgrep; falls back to false if pgrep is unavailable or excluded by PATH.
 */
function isDaemonRunning(): boolean {
  try {
    // -f matches the full command line; exclude the current process (setup)
    // by matching only 'main.js start'.
    const result = spawnSync('pgrep', ['-f', 'packages/daemon/dist/main.js start'], {
      stdio: 'pipe',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function runSetup(channelName: string): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });

  const channel = createChannel(channelName);
  await channel.setup();

  const workingDir = await promptUser('Working directory', process.cwd());
  const config = loadConfig();
  config.workingDirectory = workingDir;
  config.channel = channelName;
  saveConfig(config);

  console.log('');
  console.log('Setup complete.');
  if (isDaemonRunning()) {
    console.log('');
    console.log('⚠️  The daemon is already running — it will not pick up this new bot');
    console.log('    until you restart it:');
    console.log('');
    console.log('      npm run daemon -- restart');
    console.log('');
    console.log('    (Tip: `npm run daemon -- start` also works — it auto-detects the');
    console.log('     running daemon and restarts it. Or hot-add from chat with /spawn');
    console.log('     to skip the restart entirely.)');
  } else {
    console.log('Start the daemon:');
    console.log('');
    console.log('  npm run daemon -- start');
  }
}

// ---------------------------------------------------------------------------
// Daemon entry
// ---------------------------------------------------------------------------

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const channelName = config.channel || 'wechat';
  const sessionStore = createSessionStore();

  const accountIds = listAccountIdsForChannel(channelName);
  if (accountIds.length === 0) {
    console.error(`No accounts found. Run: npm run setup -- ${channelName}`);
    process.exit(1);
  }

  const runtime = new DaemonRuntime(channelName, config, sessionStore);
  await runtime.bootstrap(accountIds);

  if (runtime.size() === 0) {
    console.error('No bot instances could be started.');
    process.exit(1);
  }

  process.on('SIGINT', () => { logger.info('Shutting down...'); runtime.shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { logger.info('Shutting down...'); runtime.shutdown(); process.exit(0); });

  logger.info('Daemon started', { channel: channelName, bots: runtime.size() });
  console.log(`Started (channel=${channelName}, bots=${runtime.size()})`);
  for (const b of runtime.listBots()) console.log(`  - ${b.accountId}  ${b.label}`);

  // Keep the process alive forever. Individual bot polling runs in the
  // background; we wait on an unresolved promise so SIGINT/SIGTERM fire.
  await new Promise<void>(() => {});
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: InboundMessage,
  inst: BotInstance,
  sessionStore: ReturnType<typeof createSessionStore>,
  config: ReturnType<typeof loadConfig>,
  daemon: DaemonHooks,
): Promise<void> {
  const { accountId, channel, session, permissionBroker, sharedCtx, activeAbortControllers: activeControllers, claudeSession } = inst;
  const contextToken = msg.contextToken;
  const fromUserId = msg.from;
  sharedCtx.lastContextToken = contextToken;

  const userText = msg.text;
  const images = msg.images;

  // Concurrency guard: abort current query when new message arrives
  if (session.state === 'processing') {
    if (userText.startsWith('/clear')) {
      const ctrl = activeControllers.get(accountId);
      if (ctrl) { ctrl.abort(); activeControllers.delete(accountId); }
      session.state = 'idle';
      sessionStore.save(accountId, session);
    } else if (!userText.startsWith('/')) {
      const ctrl = activeControllers.get(accountId);
      if (ctrl) { ctrl.abort(); activeControllers.delete(accountId); }
      session.state = 'idle';
      sessionStore.save(accountId, session);
    } else if (!userText.startsWith('/status') && !userText.startsWith('/help')) {
      return;
    }
  }

  // Grace period: catch late y/n/a after timeout
  if (session.state === 'idle' && permissionBroker.isTimedOut(accountId)) {
    const lower = userText.toLowerCase();
    if (lower === 'y' || lower === 'yes' || lower === 'n' || lower === 'no' || lower === 'a' || lower === 'always') {
      permissionBroker.clearTimedOut(accountId);
      await channel.sendText(fromUserId, contextToken, '⏰ Permission request already timed out. Please resend your request.');
      return;
    }
  }

  // Permission state handling
  if (session.state === 'waiting_permission') {
    const pendingPerm = permissionBroker.getPending(accountId);
    if (!pendingPerm) {
      session.state = 'idle';
      sessionStore.save(accountId, session);
      await channel.sendText(fromUserId, contextToken, '⚠️ Permission request lost (likely due to a daemon restart). Please resend your request.');
      return;
    }

    const lower = userText.toLowerCase();
    if (lower === 'y' || lower === 'yes') {
      const resolved = permissionBroker.resolvePermission(accountId, true);
      await channel.sendText(fromUserId, contextToken, resolved ? '✅ Allowed' : '⚠️ Failed to resolve permission — may have timed out');
    } else if (lower === 'a' || lower === 'always') {
      const toolName = pendingPerm.toolName;
      permissionBroker.addAlwaysAllow(accountId, toolName);
      const resolved = permissionBroker.resolvePermission(accountId, true);
      await channel.sendText(fromUserId, contextToken, resolved ? `✅ Allowed. ${toolName} will be auto-approved from now on.` : '⚠️ Failed to resolve permission — may have timed out');
    } else if (lower === 'n' || lower === 'no') {
      const resolved = permissionBroker.resolvePermission(accountId, false);
      await channel.sendText(fromUserId, contextToken, resolved ? '❌ Denied' : '⚠️ Failed to resolve permission — may have timed out');
    } else {
      await channel.sendText(fromUserId, contextToken, 'Waiting for permission approval. Reply y, n, or a (always allow this tool).');
    }
    return;
  }

  // Command routing
  if (userText.startsWith('/')) {
    const updateSession = (partial: Partial<Session>) => {
      Object.assign(session, partial);
      sessionStore.save(accountId, session);
    };

    const ctx: CommandContext = {
      accountId,
      session,
      updateSession,
      clearSession: () => sessionStore.clear(accountId),
      getChatHistoryText: (limit?: number) => sessionStore.getChatHistoryText(session, limit),
      rejectPendingPermission: () => permissionBroker.rejectPending(accountId),
      daemon,
      text: userText,
    };

    const result: CommandResult = routeCommand(ctx);

    if (result.handled && result.reply) {
      if (userText.startsWith('/clear')) {
        permissionBroker.clearAlwaysAllowed(accountId);
        claudeSession.restart({ resume: undefined });
      }
      await channel.sendText(fromUserId, contextToken, result.reply);
      return;
    }

    if (result.handled && result.claudePrompt) {
      await sendToClaude(result.claudePrompt, images, fromUserId, contextToken, inst, sessionStore, config);
      return;
    }

    if (result.handled) return;
  }

  // Normal message -> Claude
  if (!userText && !images?.length) {
    await channel.sendText(fromUserId, contextToken, 'Unsupported message type. Send text or an image.');
    return;
  }

  await sendToClaude(userText, images, fromUserId, contextToken, inst, sessionStore, config);
}

async function sendToClaude(
  userText: string,
  images: InboundMessage['images'],
  fromUserId: string,
  contextToken: string,
  inst: BotInstance,
  sessionStore: ReturnType<typeof createSessionStore>,
  config: ReturnType<typeof loadConfig>,
): Promise<void> {
  const { accountId, channel, session, permissionBroker, activeAbortControllers: activeControllers, claudeSession } = inst;
  session.state = 'processing';
  sessionStore.save(accountId, session);

  const abortController = new AbortController();
  activeControllers.set(accountId, abortController);

  sessionStore.addChatMessage(session, 'user', userText || '(image)');

  try {
    const sdkImages: SendOptions['images'] = images?.map((img) => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType, data: img.base64Data },
    }));

    const effectivePermissionMode = session.permissionMode ?? config.permissionMode;
    const isAutoPermission = effectivePermissionMode === 'auto';

    let pendingBuffer = '';
    let anySent = false;
    let lastSendTime = Date.now();
    const SEND_INTERVAL_MS = 36_000;

    async function trySend(force = false): Promise<void> {
      if (!pendingBuffer.trim()) return;
      const now = Date.now();
      if (!force && now - lastSendTime < SEND_INTERVAL_MS) return;
      const toSend = pendingBuffer.trim();
      pendingBuffer = '';
      const chunks = splitMessage(toSend);
      for (const chunk of chunks) {
        lastSendTime = Date.now();
        anySent = true;
        await channel.sendText(fromUserId, contextToken, chunk);
      }
    }

    if (!claudeSession.isAlive) {
      logger.warn('Claude session not alive, restarting');
      claudeSession.restart();
    }

    const result = await claudeSession.send({
      text: userText || 'Please analyze this image.',
      images: sdkImages,
      abortSignal: abortController.signal,
      onText: async (delta: string) => {
        pendingBuffer += delta;
        await trySend();
      },
      onThinking: async (summary: string) => {
        pendingBuffer += (pendingBuffer ? '\n' : '') + summary;
        await trySend();
      },
      onPermissionRequest: isAutoPermission
        ? async () => true
        : async (toolName: string, toolInput: string) => {
            if (permissionBroker.isAlwaysAllowed(accountId, toolName)) {
              logger.info('Tool auto-approved', { toolName });
              return true;
            }

            session.state = 'waiting_permission';
            sessionStore.save(accountId, session);

            const permissionPromise = permissionBroker.createPending(accountId, toolName, toolInput);

            const perm = permissionBroker.getPending(accountId);
            if (perm) {
              await channel.sendText(fromUserId, contextToken, permissionBroker.formatPendingMessage(perm));
            }

            const allowed = await permissionPromise;
            session.state = 'processing';
            sessionStore.save(accountId, session);
            return allowed;
          },
    });

    await trySend(true);

    if (result.text) {
      if (result.error) {
        logger.warn('Claude had error but returned text, using text', { error: result.error });
      }
      sessionStore.addChatMessage(session, 'assistant', result.text);
      if (!anySent) {
        const chunks = splitMessage(result.text);
        for (const chunk of chunks) {
          await channel.sendText(fromUserId, contextToken, chunk);
        }
      }
    } else if (result.error) {
      logger.error('Claude error', { error: result.error });
      await channel.sendText(fromUserId, contextToken, '⚠️ Claude errored while processing. Please try again.');
      if (!claudeSession.isAlive) {
        logger.warn('Session died during query, will restart on next message');
      }
    } else if (!anySent) {
      await channel.sendText(fromUserId, contextToken, 'ℹ️ Claude returned no content (possibly terminated by permission denial).');
    }

    if (result.sessionId) {
      session.sdkSessionId = result.sessionId;
    }
    session.state = 'idle';
    sessionStore.save(accountId, session);
  } catch (err) {
    const isAbort = err instanceof Error && (err.name === 'AbortError' || err.message.includes('abort') || err.message.includes('Abort'));
    if (isAbort) {
      logger.info('Claude query aborted by new message');
    } else {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error('Error in sendToClaude', { error: errorMsg });
      await channel.sendText(fromUserId, contextToken, '⚠️ Error processing message. Please try again.');
    }
    session.state = 'idle';
    sessionStore.save(accountId, session);
  } finally {
    if (activeControllers.get(accountId) === abortController) {
      activeControllers.delete(accountId);
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const command = process.argv[2];
const channelArg = process.argv[3] ?? 'wechat';

if (command === 'setup') {
  runSetup(channelArg).catch((err) => {
    logger.error('Setup failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('Setup failed:', err);
    process.exit(1);
  });
} else {
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('Daemon start failed:', err);
    process.exit(1);
  });
}
