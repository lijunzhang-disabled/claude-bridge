/**
 * Channel interface — the abstraction every chat platform (WeChat, Telegram,
 * Discord, ...) implements. The daemon talks to channels only through this
 * interface so the core logic is platform-agnostic.
 */

export interface ImageData {
  /** e.g. "image/jpeg", "image/png" */
  mediaType: string;
  /** Base64-encoded image bytes, without the "data:...;base64," prefix */
  base64Data: string;
}

export interface InboundMessage {
  /** Channel-specific user identifier (e.g. WeChat user_id, Telegram chat_id) */
  from: string;
  /** Plain text content, empty string if image-only */
  text: string;
  /**
   * Channel-specific token needed to reply in the same conversation context.
   * WeChat uses `context_token`; other channels may use chat/thread IDs.
   * Pass back unchanged when calling sendText().
   */
  contextToken: string;
  /** Optional images attached to the message */
  images?: ImageData[];
  /** Channel-specific raw message — for debugging / advanced use */
  raw?: unknown;
}

export interface AccountInfo {
  /** Stable account identifier used for session storage */
  accountId: string;
  /** User ID of the bot owner, if applicable (for self-messaging) */
  userId?: string;
}

export interface Channel {
  /** Human-readable channel name, e.g. "wechat", "telegram" */
  readonly name: string;

  /**
   * Interactive setup flow: log in, obtain credentials, persist them.
   * Called from the CLI `setup` command.
   */
  setup(): Promise<void>;

  /**
   * Load the previously set up account. Returns null if setup has not run.
   */
  loadAccount(): AccountInfo | null;

  /**
   * Start the message loop. Calls onMessage for each inbound message.
   * Resolves when the loop is stopped. Should only be called once per instance.
   */
  start(
    onMessage: (msg: InboundMessage) => Promise<void>,
    onSessionExpired?: () => void,
  ): Promise<void>;

  /** Stop the message loop and release resources. */
  stop(): void;

  /**
   * Send a text message to a user, in the context established by a prior
   * inbound message. `contextToken` comes from InboundMessage.contextToken.
   */
  sendText(to: string, contextToken: string, text: string): Promise<void>;
}
