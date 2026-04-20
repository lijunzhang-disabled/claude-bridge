import { join } from 'node:path';
import { homedir } from 'node:os';
import { readdirSync, statSync } from 'node:fs';
import { loadJson, saveJson, logger } from '@claude-bridge/core';

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

const ACCOUNTS_DIR = join(homedir(), '.wechat-claude-code', 'accounts');

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
