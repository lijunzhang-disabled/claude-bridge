import { createInterface } from 'node:readline';
import { Bot, GrammyError, HttpError } from 'grammy';

import type {
  Channel,
  InboundMessage,
  AccountInfo,
  ImageData,
} from '@claude-bridge/core';
import { logger, scanAllSkills } from '@claude-bridge/core';

import {
  saveTelegramAccount,
  loadTelegramAccount,
  loadLatestTelegramAccount,
  type TelegramAccountData,
} from './accounts.js';
import { downloadTelegramFile } from './media.js';

/**
 * Built-in slash commands exposed via the Telegram "/" autocomplete menu.
 * Keep names matching Telegram's rules: lowercase [a-z0-9_], max 32 chars.
 * `un-yolo` is exposed as `un_yolo` because `-` is not allowed.
 */
const BUILTIN_COMMANDS: Array<{ command: string; description: string }> = [
  { command: 'help', description: '显示帮助' },
  { command: 'status', description: '查看当前状态' },
  { command: 'skills', description: '列出可用 skill' },
  { command: 'clear', description: '清空会话上下文' },
  { command: 'reset', description: '完全重置会话' },
  { command: 'compact', description: '压缩上下文' },
  { command: 'history', description: '查看对话历史' },
  { command: 'undo', description: '撤销最近 N 条对话' },
  { command: 'cwd', description: '查看或设置工作目录' },
  { command: 'model', description: '切换 Claude 模型' },
  { command: 'permission', description: '切换权限模式' },
  { command: 'prompt', description: '设置系统提示词' },
  { command: 'yolo', description: '开启 YOLO（自动批准所有工具调用）' },
  { command: 'un_yolo', description: '关闭 YOLO 模式' },
  { command: 'bots', description: '列出所有 bot' },
  { command: 'spawn', description: '新增一个 Telegram bot' },
  { command: 'rmbot', description: '删除某个 bot' },
  { command: 'pause', description: '暂停某个 bot' },
  { command: 'resume', description: '恢复某个 bot' },
  { command: 'version', description: '显示版本' },
];

const TELEGRAM_CMD_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_TELEGRAM_COMMANDS = 100;

function buildCommandMenu(): Array<{ command: string; description: string }> {
  const cmds = [...BUILTIN_COMMANDS];
  const builtinNames = new Set(cmds.map((c) => c.command));

  for (const s of scanAllSkills()) {
    const safe = s.name.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
    if (!TELEGRAM_CMD_RE.test(safe)) continue;
    if (builtinNames.has(safe)) continue;
    const desc = (s.description || 'Skill').slice(0, 256);
    cmds.push({ command: safe, description: desc });
    if (cmds.length >= MAX_TELEGRAM_COMMANDS) break;
  }

  return cmds;
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

export class TelegramChannel implements Channel {
  readonly name = 'telegram';
  private account: TelegramAccountData | null = null;
  private accountId: string | null = null;
  private bot: Bot | null = null;
  private readonly preferredAccountId: string | null;

  /**
   * @param accountId - If provided, this instance is bound to that specific
   *   Telegram account (used for multi-bot mode). If omitted, setup creates
   *   a new account and loadAccount picks the most recently added one.
   */
  constructor(accountId?: string) {
    this.preferredAccountId = accountId ?? null;
  }

  async setup(): Promise<void> {
    console.log('\nTelegram Bot Setup');
    console.log('-------------------');
    console.log('1. Open https://t.me/BotFather in Telegram');
    console.log('2. Send /newbot, follow the prompts to create a bot');
    console.log('3. Copy the HTTP API token BotFather gives you');
    console.log('');

    const token = await promptUser('Paste your bot token');
    if (!token) throw new Error('Bot token is required');

    // Validate the token by calling getMe
    const probeBot = new Bot(token);
    let me;
    try {
      me = await probeBot.api.getMe();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Invalid bot token: ${msg}`);
    }

    console.log(`✓ Token valid. Bot: @${me.username} (id=${me.id})`);
    console.log('');
    console.log('4. Send /start to your bot in Telegram so it can reach you');
    console.log('5. Find your Telegram numeric user ID: send a message to @userinfobot');
    console.log('');

    const ownerStr = await promptUser('Your Telegram numeric user ID');
    const ownerUserId = Number(ownerStr);
    if (!Number.isFinite(ownerUserId) || ownerUserId <= 0) {
      throw new Error(`Invalid user ID: ${ownerStr}`);
    }

    const workingDirectory = await promptUser(
      'Working directory for this bot',
      process.cwd(),
    );

    const data: TelegramAccountData = {
      botToken: token,
      botId: me.id,
      botUsername: me.username ?? '',
      ownerUserId,
      workingDirectory,
      createdAt: new Date().toISOString(),
    };

    const id = saveTelegramAccount(data);
    this.account = data;
    this.accountId = id;
    console.log(`✅ Telegram bot bound (accountId=${id}, cwd=${workingDirectory})`);
    console.log('\nTip: run `npm run setup -- telegram` again to add another bot.');
  }

  loadAccount(): AccountInfo | null {
    let id: string;
    let data: TelegramAccountData | null;

    if (this.preferredAccountId) {
      id = this.preferredAccountId;
      data = loadTelegramAccount(id);
    } else {
      const loaded = loadLatestTelegramAccount();
      if (!loaded) return null;
      id = loaded.id;
      data = loaded.data;
    }

    if (!data) return null;
    this.account = data;
    this.accountId = id;
    return {
      accountId: id,
      userId: String(data.ownerUserId),
      workingDirectory: data.workingDirectory,
    };
  }

  async start(
    onMessage: (msg: InboundMessage) => Promise<void>,
    _onSessionExpired?: () => void,
  ): Promise<void> {
    if (!this.account) {
      const loaded = this.loadAccount();
      if (!loaded || !this.account) {
        throw new Error('Telegram account not set up — run setup first');
      }
    }

    const bot = new Bot(this.account!.botToken);
    this.bot = bot;
    const ownerUserId = this.account!.ownerUserId;

    bot.on('message', async (ctx) => {
      const from = ctx.from?.id;
      if (from !== ownerUserId) {
        logger.warn('Ignoring message from non-owner', { from, owner: ownerUserId });
        return;
      }

      logger.info('Telegram message received', { from, text: (ctx.message?.text ?? '').slice(0, 60) });
      const inbound = await this.translateInbound(ctx);
      if (!inbound) return;

      // Fire-and-forget so grammy can continue fetching updates while Claude
      // processes this message. Otherwise a permission prompt would deadlock:
      // the user's y/n/a reply wouldn't be received until the first handler
      // finished, but the first handler is blocked waiting for that reply.
      onMessage(inbound).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('Error handling telegram message', { error: msg });
      });
    });

    bot.catch((err) => {
      if (err.error instanceof GrammyError) {
        logger.error('Grammy API error', { description: err.error.description });
      } else if (err.error instanceof HttpError) {
        logger.error('Grammy HTTP error', { error: String(err.error) });
      } else {
        logger.error('Grammy unknown error', { error: String(err.error) });
      }
    });

    // Publish the "/" autocomplete menu (built-ins + installed skills).
    // Safe to fail: if Telegram is unreachable we just lose autocomplete.
    try {
      const menu = buildCommandMenu();
      await bot.api.setMyCommands(menu);
      logger.info('Telegram command menu published', {
        botId: this.account!.botId,
        count: menu.length,
      });
    } catch (err) {
      logger.warn('Failed to publish Telegram command menu', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    logger.info('Starting Telegram bot long-poll', {
      botId: this.account!.botId,
      username: this.account!.botUsername,
    });

    // bot.start() runs long-polling forever until bot.stop() is called.
    await bot.start({ drop_pending_updates: true });
  }

  stop(): void {
    if (this.bot) {
      void this.bot.stop();
      this.bot = null;
    }
  }

  async sendText(_to: string, contextToken: string, text: string): Promise<void> {
    if (!this.bot) throw new Error('Telegram channel not started');
    // For Telegram, contextToken holds the chat_id — use that to reply.
    // In direct chats chat_id === user_id; in groups they differ.
    const chatId = Number(contextToken);
    if (!Number.isFinite(chatId)) {
      throw new Error(`Invalid telegram chat id: ${contextToken}`);
    }
    // Telegram message limit is 4096 chars. Core already splits at 2048.
    await this.bot.api.sendMessage(chatId, text);
  }

  /** Translate a grammy message context into InboundMessage. */
  private async translateInbound(ctx: any): Promise<InboundMessage | null> {
    const msg = ctx.message;
    if (!msg) return null;

    const from = String(ctx.from?.id ?? '');
    const chatId = String(ctx.chat?.id ?? '');
    if (!from || !chatId) return null;

    const text = msg.text ?? msg.caption ?? '';
    let images: ImageData[] | undefined;

    // Telegram sends multiple sizes in msg.photo[]; pick the largest.
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      try {
        const file = await ctx.api.getFile(largest.file_id);
        if (file.file_path) {
          const url = `https://api.telegram.org/file/bot${this.account!.botToken}/${file.file_path}`;
          const img = await downloadTelegramFile(url);
          if (img) images = [img];
        }
      } catch (err) {
        const m = err instanceof Error ? err.message : String(err);
        logger.warn('Failed to fetch telegram photo', { error: m });
      }
    }

    return {
      from,
      text,
      // For Telegram, contextToken carries the chat_id we reply to.
      // In direct bots, chat_id === from. Kept separate for group support later.
      contextToken: chatId,
      images,
      raw: msg,
    };
  }
}
