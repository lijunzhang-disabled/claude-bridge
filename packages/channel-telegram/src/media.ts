import { logger } from '@claude-bridge/core';

function detectMimeType(data: Buffer): string {
  if (data[0] === 0x89 && data[1] === 0x50) return 'image/png';
  if (data[0] === 0xFF && data[1] === 0xD8) return 'image/jpeg';
  if (data[0] === 0x47 && data[1] === 0x49) return 'image/gif';
  if (data[0] === 0x52 && data[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

/**
 * Download a Telegram file by URL (from bot.api.getFile + getFileUrl).
 * Returns { mediaType, base64Data } or null on failure.
 */
export async function downloadTelegramFile(
  url: string,
): Promise<{ mediaType: string; base64Data: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      logger.warn('Failed to download telegram file', { status: res.status });
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const mediaType = detectMimeType(buf);
    logger.info('Telegram image downloaded', { size: buf.length });
    return { mediaType, base64Data: buf.toString('base64') };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn('Failed to download telegram file', { error: msg });
    return null;
  }
}
