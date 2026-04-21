import { join } from 'node:path';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { Bot } from 'grammy';
import { loadJson, saveJson, logger, DATA_DIR } from '@claude-bridge/core';

export interface TelegramAccountData {
  /** Bot token from @BotFather */
  botToken: string;
  /** Numeric bot ID (from getMe) — used as the stable accountId */
  botId: number;
  /** Bot username (e.g. "my_claude_bot") — for display only */
  botUsername: string;
  /** The Telegram user ID the bot is locked to (accept messages only from them) */
  ownerUserId: number;
  /** Working directory this bot operates in (each bot = one project) */
  workingDirectory: string;
  createdAt: string;
}

const ACCOUNTS_DIR = join(DATA_DIR, 'accounts');

/** Accept only safe filename characters. */
function validateAccountId(accountId: string): void {
  if (!/^[a-zA-Z0-9_.-]+$/.test(accountId)) {
    throw new Error(`Invalid accountId: "${accountId}"`);
  }
}

/** All telegram accounts are prefixed so they don't collide with wechat accounts. */
function telegramAccountId(botId: number): string {
  return `telegram-${botId}`;
}

function accountPath(accountId: string): string {
  validateAccountId(accountId);
  return join(ACCOUNTS_DIR, `${accountId}.json`);
}

export function saveTelegramAccount(data: TelegramAccountData): string {
  const id = telegramAccountId(data.botId);
  saveJson(accountPath(id), data);
  logger.info('Telegram account saved', { accountId: id, botUsername: data.botUsername });
  return id;
}

export function loadTelegramAccount(accountId: string): TelegramAccountData | null {
  return loadJson<TelegramAccountData | null>(accountPath(accountId), null);
}

/** Load the most recently modified telegram account. Returns null if none. */
export function loadLatestTelegramAccount(): { id: string; data: TelegramAccountData } | null {
  try {
    const files = readdirSync(ACCOUNTS_DIR).filter(
      (f) => f.startsWith('telegram-') && f.endsWith('.json'),
    );
    if (files.length === 0) return null;

    let latestFile = files[0];
    let latestMtime = 0;
    for (const file of files) {
      const stat = statSync(join(ACCOUNTS_DIR, file));
      if (stat.mtimeMs > latestMtime) {
        latestMtime = stat.mtimeMs;
        latestFile = file;
      }
    }

    const id = latestFile.replace(/\.json$/, '');
    const data = loadTelegramAccount(id);
    return data ? { id, data } : null;
  } catch {
    return null;
  }
}

/** List all configured telegram account IDs. Returns empty array if none. */
export function listTelegramAccountIds(): string[] {
  try {
    return readdirSync(ACCOUNTS_DIR)
      .filter((f) => f.startsWith('telegram-') && f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

/** Delete a telegram account's credentials file. No-op if already gone. */
export function deleteTelegramAccount(accountId: string): void {
  try {
    unlinkSync(accountPath(accountId));
    logger.info('Telegram account deleted', { accountId });
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger.warn('Failed to delete telegram account', { accountId, error: err?.message });
    }
  }
}

/**
 * Non-interactive registration: validate the token via getMe and persist
 * the account. Used by /spawn (hot-load from chat) and by tests. Setup
 * still uses its own prompt-driven flow.
 */
export async function registerTelegramAccount(opts: {
  token: string;
  ownerUserId: number;
  workingDirectory: string;
}): Promise<{ accountId: string; botId: number; username: string }> {
  if (!opts.token) throw new Error('token is required');
  if (!opts.workingDirectory) throw new Error('workingDirectory is required');
  if (!Number.isFinite(opts.ownerUserId) || opts.ownerUserId <= 0) {
    throw new Error('ownerUserId must be a positive number');
  }

  const probeBot = new Bot(opts.token);
  let me;
  try {
    me = await probeBot.api.getMe();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid bot token: ${msg}`);
  }

  const data: TelegramAccountData = {
    botToken: opts.token,
    botId: me.id,
    botUsername: me.username ?? '',
    ownerUserId: opts.ownerUserId,
    workingDirectory: opts.workingDirectory,
    createdAt: new Date().toISOString(),
  };
  const id = saveTelegramAccount(data);
  return { accountId: id, botId: me.id, username: me.username ?? '' };
}
