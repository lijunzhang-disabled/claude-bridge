import { createInterface } from 'node:readline';
import process from 'node:process';
import { mkdirSync } from 'node:fs';

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
} from '@claude-bridge/core';

import { WeChatChannel } from '@claude-bridge/channel-wechat';
import { TelegramChannel, listTelegramAccountIds } from '@claude-bridge/channel-telegram';

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
 * Return all configured account IDs for a channel. An empty array means
 * the user has not yet run setup. A single-element array is normal for
 * channels where one account is the natural model (e.g. WeChat).
 */
function listAccountIdsForChannel(name: string): string[] {
  switch (name) {
    case 'telegram':
      return listTelegramAccountIds();
    case 'wechat': {
      // WeChat stays single-account: load the latest and report its ID.
      const probe = new WeChatChannel();
      const acc = probe.loadAccount();
      return acc ? [acc.accountId] : [];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Per-bot instance — holds everything a single bot needs
// ---------------------------------------------------------------------------

interface BotInstance {
  accountId: string;
  userId?: string;
  channel: Channel;
  claudeSession: PersistentSession;
  session: Session;
  sharedCtx: { lastContextToken: string };
  activeAbortControllers: Map<string, AbortController>;
  permissionBroker: ReturnType<typeof createPermissionBroker>;
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
// Setup
// ---------------------------------------------------------------------------

async function runSetup(channelName: string): Promise<void> {
  mkdirSync(DATA_DIR, { recursive: true });

  const channel = createChannel(channelName);
  await channel.setup();

  const workingDir = await promptUser('Working directory', process.cwd());
  const config = loadConfig();
  config.workingDirectory = workingDir;
  config.channel = channelName;
  saveConfig(config);

  console.log('Setup complete. Run: npm run daemon -- start');
}

// ---------------------------------------------------------------------------
// Daemon
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

  const instances: BotInstance[] = [];

  for (const accountId of accountIds) {
    const channel = createChannel(channelName, accountId);
    const account = channel.loadAccount();
    if (!account) {
      logger.warn('Skipping account — failed to load', { accountId });
      continue;
    }

    const session: Session = sessionStore.load(account.accountId);

    // Backfill session.workingDirectory: prefer account's per-bot dir, then
    // global config, then leave alone.
    const desiredCwd = account.workingDirectory ?? config.workingDirectory;
    if (desiredCwd && session.workingDirectory === process.cwd()) {
      session.workingDirectory = desiredCwd;
      sessionStore.save(account.accountId, session);
    }

    if (session.state !== 'idle') {
      logger.warn('Resetting stale session state on startup', {
        accountId: account.accountId,
        state: session.state,
      });
      session.state = 'idle';
      sessionStore.save(account.accountId, session);
    }

    const effectivePermissionMode = session.permissionMode ?? config.permissionMode;
    const isAutoPermission = effectivePermissionMode === 'auto';
    const sdkPermissionMode = isAutoPermission ? 'bypassPermissions' as const : effectivePermissionMode;
    const cwd = (session.workingDirectory || account.workingDirectory || config.workingDirectory || process.cwd())
      .replace(/^~/, process.env.HOME || '');

    const claudeSession = new PersistentSession({
      cwd,
      model: session.model,
      systemPrompt: config.systemPrompt,
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
        logger.warn('Failed to send permission timeout message', { accountId: account.accountId });
      }
    });

    instances.push({
      accountId: account.accountId,
      userId: account.userId,
      channel,
      claudeSession,
      session,
      sharedCtx,
      activeAbortControllers,
      permissionBroker,
    });

    logger.info('Bot instance ready', { accountId: account.accountId, cwd, channel: channelName });
  }

  if (instances.length === 0) {
    console.error('No bot instances could be started.');
    process.exit(1);
  }

  // -- Shutdown --
  function shutdown(): void {
    logger.info('Shutting down...');
    for (const inst of instances) {
      try { inst.claudeSession.close(); } catch {}
      try { inst.channel.stop(); } catch {}
    }
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Daemon started', { channel: channelName, bots: instances.length });
  console.log(`Started (channel=${channelName}, bots=${instances.length})`);
  for (const inst of instances) console.log(`  - ${inst.accountId}`);

  // Run all bots concurrently. Channel.start() polls forever; Promise.all
  // keeps the process alive until any channel stops.
  await Promise.all(instances.map((inst) =>
    inst.channel.start(
      async (msg: InboundMessage) => {
        await handleMessage(msg, inst, sessionStore, config);
      },
      () => {
        logger.warn('Channel session expired', { accountId: inst.accountId });
        console.error(`⚠️ Channel session expired for ${inst.accountId}.`);
      },
    ),
  ));
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: InboundMessage,
  inst: BotInstance,
  sessionStore: ReturnType<typeof createSessionStore>,
  config: ReturnType<typeof loadConfig>,
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
    // Convert channel-agnostic ImageData[] to Claude SDK format
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
