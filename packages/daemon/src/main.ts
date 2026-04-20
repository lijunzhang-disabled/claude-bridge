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
import { TelegramChannel } from '@claude-bridge/channel-telegram';

// ---------------------------------------------------------------------------
// Channel selection
// ---------------------------------------------------------------------------

function createChannel(name: string): Channel {
  switch (name) {
    case 'wechat':
      return new WeChatChannel();
    case 'telegram':
      return new TelegramChannel();
    default:
      throw new Error(`Unknown channel: ${name}. Supported: wechat, telegram`);
  }
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

  const workingDir = await promptUser('请输入工作目录', process.cwd());
  const config = loadConfig();
  config.workingDirectory = workingDir;
  config.channel = channelName;
  saveConfig(config);

  console.log('运行 npm run daemon -- start 启动服务');
}

// ---------------------------------------------------------------------------
// Daemon
// ---------------------------------------------------------------------------

async function runDaemon(): Promise<void> {
  const config = loadConfig();
  const channelName = config.channel || 'wechat';
  const channel = createChannel(channelName);

  const account = channel.loadAccount();
  if (!account) {
    console.error(`未找到账号，请先运行 setup (channel=${channelName})`);
    process.exit(1);
  }

  const sessionStore = createSessionStore();
  const session: Session = sessionStore.load(account.accountId);

  if (config.workingDirectory && session.workingDirectory === process.cwd()) {
    session.workingDirectory = config.workingDirectory;
    sessionStore.save(account.accountId, session);
  }

  if (session.state !== 'idle') {
    logger.warn('Resetting stale session state on startup', { state: session.state });
    session.state = 'idle';
    sessionStore.save(account.accountId, session);
  }

  // -- Persistent Claude session --
  const effectivePermissionMode = session.permissionMode ?? config.permissionMode;
  const isAutoPermission = effectivePermissionMode === 'auto';
  const sdkPermissionMode = isAutoPermission ? 'bypassPermissions' as const : effectivePermissionMode;
  const cwd = (session.workingDirectory || config.workingDirectory || process.cwd())
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
      await channel.sendText(account.userId ?? '', sharedCtx.lastContextToken, '⏰ 权限请求超时，已自动拒绝。');
    } catch {
      logger.warn('Failed to send permission timeout message');
    }
  });

  // -- Shutdown --
  function shutdown(): void {
    logger.info('Shutting down...');
    claudeSession.close();
    channel.stop();
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  logger.info('Daemon started', { accountId: account.accountId, channel: channelName });
  console.log(`已启动 (${channelName} 账号: ${account.accountId})`);

  await channel.start(
    async (msg: InboundMessage) => {
      await handleMessage(msg, account.accountId, account.userId, session, sessionStore, permissionBroker, channel, config, sharedCtx, activeAbortControllers, claudeSession);
    },
    () => {
      logger.warn('Channel session expired');
      console.error('⚠️ 会话已过期，请重新运行 setup');
    },
  );
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

async function handleMessage(
  msg: InboundMessage,
  accountId: string,
  _userId: string | undefined,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  permissionBroker: ReturnType<typeof createPermissionBroker>,
  channel: Channel,
  config: ReturnType<typeof loadConfig>,
  sharedCtx: { lastContextToken: string },
  activeControllers: Map<string, AbortController>,
  claudeSession: PersistentSession,
): Promise<void> {
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
      await channel.sendText(fromUserId, contextToken, '⏰ 权限请求已超时，请重新发送你的请求。');
      return;
    }
  }

  // Permission state handling
  if (session.state === 'waiting_permission') {
    const pendingPerm = permissionBroker.getPending(accountId);
    if (!pendingPerm) {
      session.state = 'idle';
      sessionStore.save(accountId, session);
      await channel.sendText(fromUserId, contextToken, '⚠️ 权限请求已失效（可能因服务重启），请重新发送你的请求。');
      return;
    }

    const lower = userText.toLowerCase();
    if (lower === 'y' || lower === 'yes') {
      const resolved = permissionBroker.resolvePermission(accountId, true);
      await channel.sendText(fromUserId, contextToken, resolved ? '✅ 已允许' : '⚠️ 权限请求处理失败，可能已超时');
    } else if (lower === 'a' || lower === 'always') {
      const toolName = pendingPerm.toolName;
      permissionBroker.addAlwaysAllow(accountId, toolName);
      const resolved = permissionBroker.resolvePermission(accountId, true);
      await channel.sendText(fromUserId, contextToken, resolved ? `✅ 已允许，${toolName} 后续将自动批准` : '⚠️ 权限请求处理失败，可能已超时');
    } else if (lower === 'n' || lower === 'no') {
      const resolved = permissionBroker.resolvePermission(accountId, false);
      await channel.sendText(fromUserId, contextToken, resolved ? '❌ 已拒绝' : '⚠️ 权限请求处理失败，可能已超时');
    } else {
      await channel.sendText(fromUserId, contextToken, '正在等待权限审批，请回复 y、n 或 a（始终允许此工具）。');
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
      await sendToClaude(
        result.claudePrompt, images, fromUserId, contextToken,
        accountId, session, sessionStore, permissionBroker,
        channel, config, activeControllers, claudeSession,
      );
      return;
    }

    if (result.handled) return;
  }

  // Normal message -> Claude
  if (!userText && !images?.length) {
    await channel.sendText(fromUserId, contextToken, '暂不支持此类型消息，请发送文字或图片');
    return;
  }

  await sendToClaude(
    userText, images, fromUserId, contextToken,
    accountId, session, sessionStore, permissionBroker,
    channel, config, activeControllers, claudeSession,
  );
}

async function sendToClaude(
  userText: string,
  images: InboundMessage['images'],
  fromUserId: string,
  contextToken: string,
  accountId: string,
  session: Session,
  sessionStore: ReturnType<typeof createSessionStore>,
  permissionBroker: ReturnType<typeof createPermissionBroker>,
  channel: Channel,
  config: ReturnType<typeof loadConfig>,
  activeControllers: Map<string, AbortController>,
  claudeSession: PersistentSession,
): Promise<void> {
  session.state = 'processing';
  sessionStore.save(accountId, session);

  const abortController = new AbortController();
  activeControllers.set(accountId, abortController);

  sessionStore.addChatMessage(session, 'user', userText || '(图片)');

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
      text: userText || '请分析这张图片',
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
      await channel.sendText(fromUserId, contextToken, '⚠️ Claude 处理请求时出错，请稍后重试。');
      if (!claudeSession.isAlive) {
        logger.warn('Session died during query, will restart on next message');
      }
    } else if (!anySent) {
      await channel.sendText(fromUserId, contextToken, 'ℹ️ Claude 无返回内容（可能因权限被拒而终止）');
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
      await channel.sendText(fromUserId, contextToken, '⚠️ 处理消息时出错，请稍后重试。');
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
    console.error('设置失败:', err);
    process.exit(1);
  });
} else {
  runDaemon().catch((err) => {
    logger.error('Daemon start failed', { error: err instanceof Error ? err.message : String(err) });
    console.error('启动失败:', err);
    process.exit(1);
  });
}
