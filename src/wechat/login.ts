import type { AccountData } from './accounts.js';
import { DEFAULT_BASE_URL, saveAccount } from './accounts.js';
import { logger } from '../logger.js';
import { ILINK_COMMON_HEADERS } from './protocol.js';

const QR_CODE_URL = `${DEFAULT_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`;
const POLL_INTERVAL_MS = 3_000;

interface QrCodeResponse {
  ret: number;
  qrcode?: string;
  qrcode_img_content?: string;
}

interface QrStatusResponse {
  ret: number;
  status: string;
  retmsg?: string;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  /** New host to redirect polling to when status is scaned_but_redirect. */
  redirect_host?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Phase 1: Request a QR code for login. Returns the URL and ID. */
export async function startQrLogin(): Promise<{ qrcodeUrl: string; qrcodeId: string }> {
  logger.info('Requesting QR code');

  const res = await fetch(QR_CODE_URL, { headers: ILINK_COMMON_HEADERS });
  if (!res.ok) {
    throw new Error(`Failed to get QR code: HTTP ${res.status}`);
  }

  const data = (await res.json()) as QrCodeResponse;

  if (data.ret !== 0 || !data.qrcode_img_content || !data.qrcode) {
    throw new Error(`Failed to get QR code (ret=${data.ret})`);
  }

  logger.info('QR code obtained', { qrcodeId: data.qrcode });

  return {
    qrcodeUrl: data.qrcode_img_content,
    qrcodeId: data.qrcode,
  };
}

/**
 * Phase 2: Wait for the user to scan and confirm the QR code.
 * Throws on expiry so the caller can regenerate the QR image.
 * Returns the full AccountData on success.
 */
export async function waitForQrScan(qrcodeId: string): Promise<AccountData> {
  let currentQrcodeId = qrcodeId;
  /** Effective polling base URL; may change on IDC redirect after scan. */
  let currentBaseUrl = DEFAULT_BASE_URL;

  while (true) {
    const statusUrl = `${currentBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(currentQrcodeId)}`;

    logger.debug('Polling QR status', { qrcodeId: currentQrcodeId, baseUrl: currentBaseUrl });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35_000);
    let res: Response;
    try {
      res = await fetch(statusUrl, {
        headers: ILINK_COMMON_HEADERS,
        signal: controller.signal,
      });
    } catch (e: any) {
      clearTimeout(timer);
      if (e.name === 'AbortError' || e.code === 'ETIMEDOUT') {
        logger.info('QR poll timed out, retrying');
        continue;
      }
      throw e;
    }
    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Failed to check QR status: HTTP ${res.status}`);
    }

    const data = (await res.json()) as QrStatusResponse;
    logger.debug('QR status response', { status: data.status });

    switch (data.status) {
      case 'wait':
      case 'scaned':
        // Not yet confirmed, continue polling
        break;

      case 'scaned_but_redirect': {
        // IDC redirect: WeChat tells us to poll a different data center host.
        const redirectHost = data.redirect_host;
        if (redirectHost) {
          currentBaseUrl = `https://${redirectHost}`;
          logger.info('IDC redirect, switching polling host', { redirectHost });
        } else {
          logger.warn('scaned_but_redirect but redirect_host missing, continuing');
        }
        break;
      }

      case 'confirmed': {
        if (!data.bot_token || !data.ilink_bot_id || !data.ilink_user_id) {
          throw new Error('QR confirmed but missing required fields in response');
        }

        const accountData: AccountData = {
          botToken: data.bot_token,
          accountId: data.ilink_bot_id,
          baseUrl: data.baseurl || DEFAULT_BASE_URL,
          userId: data.ilink_user_id,
          createdAt: new Date().toISOString(),
        };

        saveAccount(accountData);
        logger.info('QR login successful', { accountId: accountData.accountId });

        return accountData;
      }

      case 'expired': {
        logger.info('QR code expired');
        throw new Error('QR code expired');
      }

      default:
        logger.warn('Unknown QR status', { status: data.status, retmsg: data.retmsg });
        // Surface error to user for known failure statuses
        const status = data.status ?? '';
        if (status && (
          status.includes('not_support') ||
          status.includes('version') ||
          status.includes('forbid') ||
          status.includes('reject') ||
          status.includes('cancel')
        )) {
          throw new Error(`二维码扫描失败: ${data.retmsg || status}`);
        }
        if (data.retmsg) {
          throw new Error(`二维码扫描失败: ${data.retmsg}`);
        }
        break;
    }

    await sleep(POLL_INTERVAL_MS);
  }
}
