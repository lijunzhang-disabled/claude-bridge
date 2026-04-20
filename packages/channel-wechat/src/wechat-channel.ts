import { join } from 'node:path';
import { unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';

import type {
  Channel,
  InboundMessage,
  AccountInfo,
  ImageData,
} from '@claude-bridge/core';
import { DATA_DIR, logger } from '@claude-bridge/core';

import { WeChatApi } from './api.js';
import { loadLatestAccount, type AccountData } from './accounts.js';
import { startQrLogin, waitForQrScan } from './login.js';
import { createMonitor, type MonitorCallbacks } from './monitor.js';
import { createSender } from './send.js';
import { downloadImage, extractText, extractFirstImageUrl } from './media.js';
import { MessageType, type WeixinMessage, type MessageItem } from './types.js';

function extractTextFromItems(items: NonNullable<WeixinMessage['item_list']>): string {
  return items.map((item) => extractText(item)).filter(Boolean).join('\n');
}

/** Open a file with the platform's default application (used to show QR code). */
function openFile(filePath: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  if (platform === 'darwin') { cmd = 'open'; args = [filePath]; }
  else if (platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', filePath]; }
  else { cmd = 'xdg-open'; args = [filePath]; }
  const result = spawnSync(cmd, args, { stdio: 'ignore' });
  if (result.error) {
    logger.warn('Failed to open file', { cmd, filePath, error: result.error.message });
  }
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

export class WeChatChannel implements Channel {
  readonly name = 'wechat';
  private account: AccountData | null = null;
  private api: WeChatApi | null = null;
  private sender: ReturnType<typeof createSender> | null = null;
  private monitor: ReturnType<typeof createMonitor> | null = null;

  async setup(): Promise<void> {
    mkdirSync(DATA_DIR, { recursive: true });
    const QR_PATH = join(DATA_DIR, 'qrcode.png');
    console.log('正在设置...\n');

    while (true) {
      const { qrcodeUrl, qrcodeId } = await startQrLogin();
      const isHeadlessLinux = process.platform === 'linux' &&
        !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

      if (isHeadlessLinux) {
        try {
          const qrcodeTerminal = await import('qrcode-terminal');
          console.log('请用微信扫描下方二维码：\n');
          qrcodeTerminal.default.generate(qrcodeUrl, { small: true });
          console.log('\n二维码链接：', qrcodeUrl, '\n');
        } catch {
          logger.warn('qrcode-terminal not available, falling back to URL');
          console.log('无法在终端显示二维码，请访问链接：\n' + qrcodeUrl + '\n');
        }
      } else {
        const QRCode = await import('qrcode');
        const pngData = await QRCode.toBuffer(qrcodeUrl, { type: 'png', width: 400, margin: 2 });
        writeFileSync(QR_PATH, pngData);
        openFile(QR_PATH);
        console.log('已打开二维码图片，请用微信扫描：');
        console.log(`图片路径: ${QR_PATH}\n`);
      }

      console.log('等待扫码绑定...');

      try {
        await waitForQrScan(qrcodeId);
        console.log('✅ 绑定成功!');
        break;
      } catch (err: any) {
        if (err.message?.includes('expired')) {
          console.log('⚠️ 二维码已过期，正在刷新...\n');
          continue;
        }
        throw err;
      }
    }

    try { unlinkSync(QR_PATH); } catch {
      logger.warn('Failed to clean up QR image', { path: QR_PATH });
    }
  }

  loadAccount(): AccountInfo | null {
    const account = loadLatestAccount();
    if (!account) return null;
    this.account = account;
    return { accountId: account.accountId, userId: account.userId };
  }

  async start(
    onMessage: (msg: InboundMessage) => Promise<void>,
    onSessionExpired?: () => void,
  ): Promise<void> {
    if (!this.account) {
      const loaded = this.loadAccount();
      if (!loaded || !this.account) {
        throw new Error('WeChat account not set up — run setup first');
      }
    }

    this.api = new WeChatApi(this.account!.botToken, this.account!.baseUrl);
    this.sender = createSender(this.api, this.account!.accountId);

    const callbacks: MonitorCallbacks = {
      onMessage: async (msg: WeixinMessage) => {
        const inbound = await this.translateInbound(msg);
        if (inbound) await onMessage(inbound);
      },
      onSessionExpired: () => {
        logger.warn('WeChat session expired');
        onSessionExpired?.();
      },
    };

    this.monitor = createMonitor(this.api, callbacks);
    await this.monitor.run();
  }

  stop(): void {
    this.monitor?.stop();
  }

  async sendText(to: string, contextToken: string, text: string): Promise<void> {
    if (!this.sender) throw new Error('WeChat channel not started');
    await this.sender.sendText(to, contextToken, text);
  }

  /** Translate a WeixinMessage into the channel-agnostic InboundMessage format. */
  private async translateInbound(msg: WeixinMessage): Promise<InboundMessage | null> {
    if (msg.message_type !== MessageType.USER) return null;
    if (!msg.from_user_id || !msg.item_list) return null;

    const text = extractTextFromItems(msg.item_list);
    const imageItem = extractFirstImageUrl(msg.item_list);
    let images: ImageData[] | undefined;

    if (imageItem) {
      const dataUri = await downloadImage(imageItem);
      if (dataUri) {
        const matches = dataUri.match(/^data:([^;]+);base64,(.+)$/);
        if (matches) {
          images = [{ mediaType: matches[1], base64Data: matches[2] }];
        }
      }
    }

    return {
      from: msg.from_user_id,
      text,
      contextToken: msg.context_token ?? '',
      images,
      raw: msg,
    };
  }
}
