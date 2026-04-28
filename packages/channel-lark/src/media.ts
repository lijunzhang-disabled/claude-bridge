import { logger } from '@claude-bridge/core';

function detectMimeType(data: Buffer): string {
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  if (data[0] === 0xFF && data[1] === 0xD8) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49) return 'image/gif';
  if (data[0] === 0x52 && data[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

/**
 * Download an image attached to a Feishu message.
 *
 * Lark's resource endpoint requires a tenant_access_token bearer (the SDK
 * Client manages this transparently when you call `messageResource.get`).
 * The SDK returns a response object whose `getReadableStream()` yields the
 * raw bytes. We collect those into a Buffer and base64-encode for the core
 * `ImageData` shape.
 */
export async function downloadLarkImage(
  client: any,
  messageId: string,
  fileKey: string,
): Promise<{ mediaType: string; base64Data: string } | null> {
  try {
    const resp = await client.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: 'image' },
    });

    const stream = resp.getReadableStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks);

    const mediaType = detectMimeType(buf);
    logger.info('Lark image downloaded', { size: buf.length, fileKey });
    return { mediaType, base64Data: buf.toString('base64') };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to download lark image', { error: msg, fileKey });
    return null;
  }
}
