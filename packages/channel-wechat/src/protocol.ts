/**
 * iLink protocol constants matching @tencent-weixin/openclaw-weixin@2.1.6.
 *
 * The WeChat ClawBot plugin validates these headers when a user scans a QR code.
 * Without them, WeChat shows "请在OpenClaw中升级WeChat接口版本后再试".
 */

/** iLink-App-Id sent with every request; value from the official package.json `ilink_appid`. */
const ILINK_APP_ID = 'bot';

/**
 * Channel version string included in base_info for POST requests.
 * Matches the official openclaw-weixin package version.
 */
export const CHANNEL_VERSION = '2.1.6';

/**
 * iLink-App-ClientVersion: uint32 encoded as 0x00MMNNPP.
 * e.g. "2.1.6" -> (2 << 16) | (1 << 8) | 6 = 131334
 */
function buildClientVersion(version: string): number {
  const parts = version.split('.').map((p) => parseInt(p, 10));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}

const ILINK_APP_CLIENT_VERSION = String(buildClientVersion(CHANNEL_VERSION));

/** Headers required on every iLink API request (GET and POST). */
export const ILINK_COMMON_HEADERS: Record<string, string> = {
  'iLink-App-Id': ILINK_APP_ID,
  'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
};
