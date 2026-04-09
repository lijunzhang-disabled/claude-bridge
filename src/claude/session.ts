/**
 * Persistent Claude Code session using query() with streaming input.
 *
 * Instead of spawning a new Claude Code process per message, this keeps
 * a single process alive and feeds messages through an AsyncIterable.
 * Context stays in memory — no disk round-trip between messages.
 */

import {
  query,
  type SDKMessage,
  type SDKAssistantMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type Options,
  type CanUseTool,
  type PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import { logger } from "../logger.js";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

// ---------------------------------------------------------------------------
// MessageStream — push-based AsyncIterable for feeding messages to query()
// ---------------------------------------------------------------------------

class MessageStream implements AsyncIterable<SDKUserMessage>, AsyncIterator<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private resolve?: (result: IteratorResult<SDKUserMessage>) => void;
  private reject?: (err: Error) => void;
  private isDone = false;
  private started = false;

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    if (this.started) throw new Error("MessageStream can only be iterated once");
    this.started = true;
    return this;
  }

  next(): Promise<IteratorResult<SDKUserMessage>> {
    if (this.queue.length > 0) {
      return Promise.resolve({ done: false, value: this.queue.shift()! });
    }
    if (this.isDone) {
      return Promise.resolve({ done: true, value: undefined as any });
    }
    return new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  enqueue(msg: SDKUserMessage): void {
    if (this.isDone) return;
    if (this.resolve) {
      const resolve = this.resolve;
      this.resolve = undefined;
      this.reject = undefined;
      resolve({ done: false, value: msg });
    } else {
      this.queue.push(msg);
    }
  }

  close(): void {
    this.isDone = true;
    if (this.resolve) {
      const resolve = this.resolve;
      this.resolve = undefined;
      this.reject = undefined;
      resolve({ done: true, value: undefined as any });
    }
  }

  return(): Promise<IteratorResult<SDKUserMessage>> {
    this.close();
    return Promise.resolve({ done: true, value: undefined as any });
  }
}

// ---------------------------------------------------------------------------
// Resolve global claude cli.js path
// ---------------------------------------------------------------------------

function resolveGlobalClaudeCliPath(): string | undefined {
  try {
    const claudeBin = execSync("which claude", { encoding: "utf8" }).trim();
    const realBin = execSync(
      `readlink -f "${claudeBin}" 2>/dev/null || realpath "${claudeBin}" 2>/dev/null || echo "${claudeBin}"`,
      { encoding: "utf8" },
    ).trim();
    if (realBin.endsWith(".js") && existsSync(realBin)) return realBin;
    const cliJs = join(dirname(realBin), "cli.js");
    if (existsSync(cliJs)) return cliJs;
    const npmPrefix = execSync("npm config get prefix", { encoding: "utf8" }).trim();
    const npmCli = join(npmPrefix, "lib", "node_modules", "@anthropic-ai", "claude-code", "cli.js");
    if (existsSync(npmCli)) return npmCli;
  } catch {
    // ignore
  }
  return undefined;
}

const GLOBAL_CLAUDE_CLI_PATH = resolveGlobalClaudeCliPath();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOOL_ICONS: Record<string, string> = {
  Bash: "🔧", Read: "📖", Write: "✏️", Edit: "✏️", MultiEdit: "✏️",
  Grep: "🔍", Glob: "🔍", WebFetch: "🌐", WebSearch: "🌐",
  TodoWrite: "📝", TodoRead: "📝", Task: "🤖",
};

function formatToolUse(toolName: string, input: Record<string, unknown>): string {
  const icon = TOOL_ICONS[toolName] ?? "⚙️";
  let detail = "";
  if (input.command) detail = String(input.command).slice(0, 80);
  else if (input.file_path) detail = String(input.file_path);
  else if (input.pattern) detail = String(input.pattern).slice(0, 60);
  else if (input.query) detail = String(input.query).slice(0, 60);
  else if (input.url) detail = String(input.url).slice(0, 60);
  return detail ? `${icon} ${toolName}: ${detail}` : `${icon} ${toolName}`;
}

function extractText(msg: SDKAssistantMessage): string {
  const content = msg.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block: any) => block.type === "text")
    .map((block: any) => (block.text as string) ?? "")
    .join("");
}

function getSessionId(msg: SDKMessage): string | undefined {
  if ("session_id" in msg) return (msg as { session_id: string }).session_id;
  return undefined;
}

function buildUserMessage(
  text: string,
  images?: Array<{ type: "image"; source: { type: "base64"; media_type: string; data: string } }>,
): SDKUserMessage {
  const contentBlocks: Array<any> = [{ type: "text", text }];
  if (images?.length) {
    for (const img of images) {
      contentBlocks.push({ type: "image", source: img.source });
    }
  }
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: { role: "user", content: contentBlocks },
  };
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface SessionConfig {
  cwd: string;
  model?: string;
  systemPrompt?: string;
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  resume?: string;
}

export interface SendOptions {
  text: string;
  images?: Array<{ type: "image"; source: { type: "base64"; media_type: string; data: string } }>;
  onText?: (text: string) => Promise<void> | void;
  onThinking?: (summary: string) => Promise<void> | void;
  onPermissionRequest?: (toolName: string, toolInput: string) => Promise<boolean>;
  abortSignal?: AbortSignal;
}

export interface SendResult {
  text: string;
  sessionId: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// PersistentSession
// ---------------------------------------------------------------------------

export class PersistentSession {
  private messageStream: MessageStream | null = null;
  private queryIterator: AsyncIterator<SDKMessage> | null = null;
  private sessionId = "";
  private config: SessionConfig;
  private alive = false;

  /** Permission handler set per-message (changes between sends). */
  private currentPermissionHandler?: (toolName: string, toolInput: string) => Promise<boolean>;

  constructor(config: SessionConfig) {
    this.config = config;
  }

  get isAlive(): boolean {
    return this.alive;
  }

  get currentSessionId(): string {
    return this.sessionId;
  }

  /**
   * Start the persistent session. Spawns the Claude Code process.
   * Call once on daemon startup.
   */
  start(): void {
    if (this.alive) return;

    this.messageStream = new MessageStream();

    const sdkOptions: Options = {
      cwd: this.config.cwd,
      permissionMode: this.config.permissionMode,
      allowDangerouslySkipPermissions: this.config.permissionMode === "bypassPermissions",
      settingSources: ["user", "project"],
      includePartialMessages: true,
    };

    if (GLOBAL_CLAUDE_CLI_PATH) {
      (sdkOptions as any).pathToClaudeCodeExecutable = GLOBAL_CLAUDE_CLI_PATH;
      logger.debug("Using global claude cli.js", { path: GLOBAL_CLAUDE_CLI_PATH });
    }

    if (this.config.model) sdkOptions.model = this.config.model;
    if (this.config.resume) sdkOptions.resume = this.config.resume;
    if (this.config.systemPrompt) {
      (sdkOptions as any).systemPrompt = {
        type: "preset",
        preset: "claude_code",
        append: this.config.systemPrompt,
      };
    }

    // Permission bridge — delegates to the per-message handler
    const canUseTool: CanUseTool = async (
      toolName: string,
      input: Record<string, unknown>,
    ): Promise<PermissionResult> => {
      if (!this.currentPermissionHandler) {
        return { behavior: "allow", updatedInput: input };
      }
      try {
        const inputStr = JSON.stringify(input);
        logger.info("Permission request from SDK", { toolName });
        const allowed = await this.currentPermissionHandler(toolName, inputStr);
        if (allowed) {
          return { behavior: "allow", updatedInput: input };
        }
        return { behavior: "deny", message: "Permission denied by user.", interrupt: true };
      } catch (err) {
        logger.error("Permission handler error", { toolName, err });
        return { behavior: "deny", message: "Permission check failed.", interrupt: true };
      }
    };

    sdkOptions.canUseTool = canUseTool;

    const q = query({ prompt: this.messageStream, options: sdkOptions });
    this.queryIterator = q[Symbol.asyncIterator]();
    this.alive = true;

    logger.info("Persistent session started", {
      cwd: this.config.cwd,
      resume: this.config.resume,
      model: this.config.model,
    });
  }

  /**
   * Send a message and collect the response for this turn.
   * Blocks until Claude produces a result message.
   */
  async send(options: SendOptions): Promise<SendResult> {
    if (!this.alive || !this.messageStream || !this.queryIterator) {
      throw new Error("Session not started");
    }

    this.currentPermissionHandler = options.onPermissionRequest;

    const MAX_THINKING_PREVIEW = 300;
    const textParts: string[] = [];
    let errorMessage: string | undefined;
    let thinkingBuf = "";
    let thinkingCapped = false;

    // Enqueue user message
    const userMsg = buildUserMessage(options.text, options.images);
    this.messageStream.enqueue(userMsg);

    // Read messages until result
    try {
      while (true) {
        if (options.abortSignal?.aborted) {
          throw new Error("Aborted");
        }

        const { value: message, done } = await this.queryIterator.next();
        if (done) {
          // Process exited unexpectedly
          this.alive = false;
          errorMessage = "Claude Code process exited unexpectedly";
          break;
        }

        const sid = getSessionId(message);
        if (sid) this.sessionId = sid;

        switch (message.type) {
          case "assistant": {
            const aMsg = message as SDKAssistantMessage;
            const content = aMsg.message?.content;
            if (options.onThinking && Array.isArray(content)) {
              for (const block of content) {
                if ((block as any).type === "tool_use") {
                  const summary = formatToolUse(
                    (block as any).name ?? "Tool",
                    (block as any).input ?? {},
                  );
                  await options.onThinking(summary);
                }
              }
            }
            const text = extractText(aMsg);
            if (text) textParts.push(text);
            break;
          }

          case "stream_event": {
            const evt = (message as any).event;
            if (evt?.type === "content_block_start") {
              if (evt?.content_block?.type === "thinking") {
                thinkingBuf = "";
                thinkingCapped = false;
              }
            } else if (evt?.type === "content_block_delta") {
              const deltaType: string = evt.delta?.type ?? "";
              if (deltaType === "text_delta" && options.onText) {
                const delta: string = evt.delta.text;
                if (delta) await options.onText(delta);
              } else if (deltaType === "thinking_delta" && options.onText && !thinkingCapped) {
                thinkingBuf += (evt.delta.thinking as string) ?? "";
                if (thinkingBuf.length >= MAX_THINKING_PREVIEW) {
                  thinkingCapped = true;
                  await options.onText("💭 " + thinkingBuf.slice(0, MAX_THINKING_PREVIEW).trim() + "…\n");
                  thinkingBuf = "";
                }
              }
            } else if (evt?.type === "content_block_stop") {
              if (thinkingBuf.trim() && options.onText && !thinkingCapped) {
                await options.onText("💭 " + thinkingBuf.trim() + "\n");
              }
              thinkingBuf = "";
              thinkingCapped = false;
            }
            break;
          }

          case "result": {
            const rm = message as SDKResultMessage;
            if (rm.subtype === "success" && "result" in rm) {
              if (rm.result) {
                const combined = textParts.join("");
                if (!combined.includes(rm.result)) {
                  textParts.push(rm.result);
                }
              }
            } else if ("errors" in rm && rm.errors.length > 0) {
              errorMessage = rm.errors.join("; ");
              logger.error("SDK returned error result", { errors: rm.errors });
            }
            // Turn complete
            const fullText = textParts.join("\n").trim();
            this.currentPermissionHandler = undefined;
            return {
              text: fullText,
              sessionId: this.sessionId,
              error: errorMessage,
            };
          }

          case "system":
            logger.debug("SDK system message", {
              subtype: (message as { subtype?: string }).subtype,
            });
            break;

          default:
            break;
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort") || msg.includes("Abort")) {
        logger.info("Send aborted");
      } else {
        logger.error("Error during send", { error: msg });
        // Process may have crashed
        this.alive = false;
        errorMessage = msg;
      }
    }

    this.currentPermissionHandler = undefined;

    const fullText = textParts.join("\n").trim();
    if (!fullText && !errorMessage) {
      errorMessage = "Claude returned an empty response.";
    }

    return {
      text: fullText,
      sessionId: this.sessionId,
      error: errorMessage,
    };
  }

  /**
   * Close the session and terminate the Claude Code process.
   */
  close(): void {
    if (!this.alive) return;
    this.alive = false;
    this.messageStream?.close();
    this.messageStream = null;
    this.queryIterator = null;
    this.currentPermissionHandler = undefined;
    logger.info("Persistent session closed");
  }

  /**
   * Restart the session, optionally resuming from the current session ID.
   */
  restart(configOverrides?: Partial<SessionConfig>): void {
    const oldSessionId = this.sessionId;
    this.close();

    if (configOverrides) {
      Object.assign(this.config, configOverrides);
    }

    // Resume from last session if we have one
    if (oldSessionId && !this.config.resume) {
      this.config.resume = oldSessionId;
    }

    this.start();
    logger.info("Persistent session restarted", { resume: this.config.resume });
  }

  /**
   * Update config (e.g. cwd, model, systemPrompt) — takes effect on next restart.
   */
  updateConfig(partial: Partial<SessionConfig>): void {
    Object.assign(this.config, partial);
  }
}
