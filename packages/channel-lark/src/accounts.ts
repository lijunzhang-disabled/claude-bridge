import { join } from 'node:path';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { loadJson, saveJson, logger, DATA_DIR } from '@claude-bridge/core';

export interface LarkAccountData {
  /** Custom-app App ID (looks like "cli_xxx") */
  appId: string;
  /** Custom-app App Secret */
  appSecret: string;
  /** Bot's display name (best-effort, populated from getBotInfo when available) */
  botName?: string;
  /**
   * Owner's Feishu open_id. Captured on the first inbound message
   * (claim-on-first-message). Once set, the bot rejects messages from
   * any other open_id.
   */
  ownerOpenId?: string;
  /** Working directory this bot operates in (each bot = one project) */
  workingDirectory: string;
  /** If true, the daemon will not start this bot on boot. */
  paused?: boolean;
  createdAt: string;
}

const ACCOUNTS_DIR = join(DATA_DIR, 'accounts');

function validateAccountId(accountId: string): void {
  if (!/^[a-zA-Z0-9_.-]+$/.test(accountId)) {
    throw new Error(`Invalid accountId: "${accountId}"`);
  }
}

/** appId can contain "cli_" + alphanumerics; sanitize for filename use. */
function larkAccountId(appId: string): string {
  const safe = appId.replace(/[^a-zA-Z0-9]/g, '_');
  return `lark-${safe}`;
}

function accountPath(accountId: string): string {
  validateAccountId(accountId);
  return join(ACCOUNTS_DIR, `${accountId}.json`);
}

export function saveLarkAccount(data: LarkAccountData): string {
  const id = larkAccountId(data.appId);
  saveJson(accountPath(id), data);
  logger.info('Lark account saved', { accountId: id, appId: data.appId });
  return id;
}

export function loadLarkAccount(accountId: string): LarkAccountData | null {
  return loadJson<LarkAccountData | null>(accountPath(accountId), null);
}

/** Load the most recently modified lark account. Returns null if none. */
export function loadLatestLarkAccount(): { id: string; data: LarkAccountData } | null {
  try {
    const files = readdirSync(ACCOUNTS_DIR).filter(
      (f) => f.startsWith('lark-') && f.endsWith('.json'),
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
    const data = loadLarkAccount(id);
    return data ? { id, data } : null;
  } catch {
    return null;
  }
}

export function listLarkAccountIds(): string[] {
  try {
    return readdirSync(ACCOUNTS_DIR)
      .filter((f) => f.startsWith('lark-') && f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

export function deleteLarkAccount(accountId: string): void {
  try {
    unlinkSync(accountPath(accountId));
    logger.info('Lark account deleted', { accountId });
  } catch (err: any) {
    if (err?.code !== 'ENOENT') {
      logger.warn('Failed to delete lark account', { accountId, error: err?.message });
    }
  }
}

/**
 * Validate Feishu credentials by acquiring a tenant_access_token.
 * Returns the token on success; throws with a useful message on failure.
 * Done via raw fetch rather than the SDK so we don't depend on a particular
 * SDK method path that might shift between versions.
 */
export async function probeFeishuCredentials(opts: {
  appId: string;
  appSecret: string;
}): Promise<string> {
  const url = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: opts.appId, app_secret: opts.appSecret }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach Feishu: ${msg}`);
  }
  const body = (await res.json().catch(() => null)) as
    | { code?: number; msg?: string; tenant_access_token?: string }
    | null;
  if (!body) throw new Error(`Feishu returned non-JSON response (status=${res.status})`);
  if (body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`Feishu rejected credentials: code=${body.code} msg=${body.msg}`);
  }
  return body.tenant_access_token;
}

/**
 * Non-interactive registration: validate credentials and persist the account.
 */
export async function registerLarkAccount(opts: {
  appId: string;
  appSecret: string;
  workingDirectory: string;
}): Promise<{ accountId: string; appId: string }> {
  if (!opts.appId) throw new Error('appId is required');
  if (!opts.appSecret) throw new Error('appSecret is required');
  if (!opts.workingDirectory) throw new Error('workingDirectory is required');

  await probeFeishuCredentials({ appId: opts.appId, appSecret: opts.appSecret });

  const data: LarkAccountData = {
    appId: opts.appId,
    appSecret: opts.appSecret,
    workingDirectory: opts.workingDirectory,
    createdAt: new Date().toISOString(),
  };
  const id = saveLarkAccount(data);
  return { accountId: id, appId: opts.appId };
}
