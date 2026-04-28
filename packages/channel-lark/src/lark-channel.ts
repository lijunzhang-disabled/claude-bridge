import { createInterface } from 'node:readline';
import * as Lark from '@larksuiteoapi/node-sdk';

import type {
  Channel,
  InboundMessage,
  AccountInfo,
  ImageData,
} from '@claude-bridge/core';
import { logger } from '@claude-bridge/core';

import {
  saveLarkAccount,
  loadLarkAccount,
  loadLatestLarkAccount,
  probeFeishuCredentials,
  type LarkAccountData,
} from './accounts.js';
import { downloadLarkImage } from './media.js';

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

export class LarkChannel implements Channel {
  readonly name = 'lark';
  private account: LarkAccountData | null = null;
  private accountId: string | null = null;
  private wsClient: Lark.WSClient | null = null;
  private apiClient: Lark.Client | null = null;
  private readonly preferredAccountId: string | null;

  constructor(accountId?: string) {
    this.preferredAccountId = accountId ?? null;
  }

  async setup(): Promise<void> {
    console.log('\nFeishu Bot Setup');
    console.log('-----------------');
    console.log('1. Open https://open.feishu.cn/app and create a 自建应用 (custom app)');
    console.log('2. In "凭证与基础信息" copy the App ID (cli_...) and App Secret');
    console.log('3. In "事件与回调" → switch to "长连接" (long connection) mode');
    console.log('4. Subscribe to event: im.message.receive_v1');
    console.log('5. In "权限管理" add scopes:');
    console.log('     - im:message (or im:message:receive_v1)');
    console.log('     - im:message:send_as_bot');
    console.log('     - im:resource (to download images)');
    console.log('6. Publish an app version and have the admin approve it');
    console.log('');
    console.log('Owner is claimed automatically: the first person who messages the bot');
    console.log('becomes the owner; messages from anyone else are then ignored.');
    console.log('');

    const appId = await promptUser('App ID');
    if (!appId) throw new Error('App ID is required');

    const appSecret = await promptUser('App Secret');
    if (!appSecret) throw new Error('App Secret is required');

    process.stdout.write('Validating credentials… ');
    try {
      await probeFeishuCredentials({ appId, appSecret });
      console.log('OK');
    } catch (err) {
      console.log('FAILED');
      throw err;
    }

    const workingDirectory = await promptUser(
      'Working directory for this bot',
      process.cwd(),
    );

    const data: LarkAccountData = {
      appId,
      appSecret,
      workingDirectory,
      createdAt: new Date().toISOString(),
    };

    const id = saveLarkAccount(data);
    this.account = data;
    this.accountId = id;
    console.log(`✅ Lark bot bound (accountId=${id}, cwd=${workingDirectory})`);
    console.log('Send a message from your own Feishu account to claim ownership.');
  }

  loadAccount(): AccountInfo | null {
    let id: string;
    let data: LarkAccountData | null;

    if (this.preferredAccountId) {
      id = this.preferredAccountId;
      data = loadLarkAccount(id);
    } else {
      const loaded = loadLatestLarkAccount();
      if (!loaded) return null;
      id = loaded.id;
      data = loaded.data;
    }

    if (!data) return null;
    this.account = data;
    this.accountId = id;
    return {
      accountId: id,
      userId: data.ownerOpenId,
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
        throw new Error('Lark account not set up — run setup first');
      }
    }
    const account = this.account!;

    const apiClient = new Lark.Client({
      appId: account.appId,
      appSecret: account.appSecret,
      domain: Lark.Domain.Feishu,
    });
    this.apiClient = apiClient;

    const wsClient = new Lark.WSClient({
      appId: account.appId,
      appSecret: account.appSecret,
      domain: Lark.Domain.Feishu,
    });
    this.wsClient = wsClient;

    const eventDispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        try {
          await this.handleIncoming(data, onMessage);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.error('Error handling lark event', { error: msg });
        }
      },
    });

    logger.info('Starting Lark long-connection', {
      appId: account.appId,
      ownerOpenId: account.ownerOpenId ?? '(not yet claimed)',
    });

    // wsClient.start runs forever; on stop() it closes and start() resolves.
    await wsClient.start({ eventDispatcher });
  }

  stop(): void {
    if (this.wsClient) {
      try {
        // SDK exposes stop on the underlying connection; method name has
        // varied across versions, so we call it defensively.
        const anyWs = this.wsClient as any;
        if (typeof anyWs.stop === 'function') anyWs.stop();
        else if (typeof anyWs.close === 'function') anyWs.close();
      } catch (err) {
        logger.warn('Error stopping lark WS client', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.wsClient = null;
    }
    this.apiClient = null;
  }

  async sendText(_to: string, contextToken: string, text: string): Promise<void> {
    if (!this.apiClient) throw new Error('Lark channel not started');
    if (!contextToken) throw new Error('Empty contextToken (chat_id) for lark sendText');

    await this.apiClient.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: contextToken,
        msg_type: 'text',
        content: JSON.stringify({ text }),
      },
    });
  }

  /**
   * Translate a Lark event into InboundMessage and route it to the daemon.
   * Implements claim-on-first-message ownership.
   */
  private async handleIncoming(
    event: any,
    onMessage: (msg: InboundMessage) => Promise<void>,
  ): Promise<void> {
    const account = this.account;
    if (!account || !this.accountId) return;

    const senderOpenId: string | undefined = event?.sender?.sender_id?.open_id;
    const message = event?.message;
    if (!senderOpenId || !message) {
      logger.warn('Lark event missing sender open_id or message', {});
      return;
    }

    // Claim-on-first-message: lock ownership to the first sender we see.
    if (!account.ownerOpenId) {
      account.ownerOpenId = senderOpenId;
      saveLarkAccount(account);
      logger.info('Lark bot owner claimed', {
        accountId: this.accountId,
        ownerOpenId: senderOpenId,
      });
    } else if (account.ownerOpenId !== senderOpenId) {
      logger.warn('Ignoring lark message from non-owner', {
        from: senderOpenId,
        owner: account.ownerOpenId,
      });
      return;
    }

    const messageId: string = message.message_id;
    const chatId: string = message.chat_id;
    const messageType: string = message.message_type;
    const rawContent: string = message.content ?? '';

    let text = '';
    let images: ImageData[] | undefined;

    let parsed: any = null;
    try {
      parsed = rawContent ? JSON.parse(rawContent) : null;
    } catch {
      logger.warn('Failed to parse lark message content as JSON', { messageType });
    }

    if (messageType === 'text') {
      text = parsed?.text ?? '';
    } else if (messageType === 'image') {
      const fileKey: string | undefined = parsed?.image_key;
      if (fileKey && this.apiClient) {
        const img = await downloadLarkImage(this.apiClient, messageId, fileKey);
        if (img) images = [img];
      }
    } else if (messageType === 'post') {
      // Rich post — flatten the title + text runs into a single string.
      text = flattenPost(parsed) || '';
    } else {
      logger.info('Unhandled lark message_type, treating as empty', { messageType });
    }

    logger.info('Lark message received', {
      from: senderOpenId,
      type: messageType,
      preview: text.slice(0, 60),
    });

    // Fire-and-forget so the WS loop can keep dispatching events while
    // Claude processes (and possibly waits for permission replies).
    onMessage({
      from: senderOpenId,
      text,
      contextToken: chatId,
      images,
      raw: event,
    }).catch((err) => {
      const m = err instanceof Error ? err.message : String(err);
      logger.error('Error handling lark message', { error: m });
    });
  }
}

/** Flatten a Feishu "post" message into plain text (title + concatenated runs). */
function flattenPost(parsed: any): string {
  if (!parsed) return '';
  const parts: string[] = [];
  if (typeof parsed.title === 'string' && parsed.title) parts.push(parsed.title);
  const content = parsed.content;
  if (Array.isArray(content)) {
    for (const line of content) {
      if (!Array.isArray(line)) continue;
      const lineText = line
        .map((seg: any) => (typeof seg?.text === 'string' ? seg.text : ''))
        .join('');
      if (lineText) parts.push(lineText);
    }
  }
  return parts.join('\n');
}
