import { WeChatApi } from './api.js';
import { MessageItemType, MessageType, MessageState, type MessageItem, type OutboundMessage } from './types.js';
import { logger } from '../logger.js';

export function createSender(api: WeChatApi, botAccountId: string) {
  let clientCounter = 0;

  function generateClientId(): string {
    return `wcc-${Date.now()}-${++clientCounter}`;
  }

  async function sendText(toUserId: string, contextToken: string, text: string): Promise<void> {
    const clientId = generateClientId();

    const items: MessageItem[] = [
      {
        type: MessageItemType.TEXT,
        text_item: { text },
      },
    ];

    const msg: OutboundMessage = {
      from_user_id: botAccountId,
      to_user_id: toUserId,
      client_id: clientId,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      context_token: contextToken,
      item_list: items,
    };

    logger.info('Sending text message', { toUserId, clientId, textLength: text.length });
    try {
      await api.sendMessage({ msg });
      logger.info('Text message sent', { toUserId, clientId });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // WAF blocks (HTTP 566) and other send failures should not crash the caller.
      // Log and continue so Claude's processing is not interrupted.
      if (errMsg.includes('566') || errMsg.includes('EdgeOne') || errMsg.includes('security')) {
        logger.warn('Message blocked by WAF, skipping', { clientId, textLength: text.length });
      } else {
        logger.error('Failed to send message', { clientId, error: errMsg });
        throw err; // re-throw non-WAF errors
      }
    }
  }

  return { sendText };
}
