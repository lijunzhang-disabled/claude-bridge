import type { Session } from '../session.js';
import { findSkill } from '../claude/skill-scanner.js';
import { logger } from '../logger.js';
import { handleHelp, handleClear, handleCwd, handleModel, handlePermission, handleStatus, handleSkills, handleHistory, handleReset, handleCompact, handleUndo, handleVersion, handlePrompt, handleSpawn, handleRmbot, handleBots, handleUnknown } from './handlers.js';

export interface SpawnBotResult {
  accountId: string;
  username: string;
  workingDirectory: string;
}

/**
 * Hooks into the running daemon runtime. Injected by the daemon when
 * building CommandContext; undefined in contexts that don't support
 * dynamic bot management (e.g. tests).
 */
export interface DaemonHooks {
  /**
   * Register and hot-load a new Telegram bot.
   * @throws if the token is invalid, already registered, or the bot fails to start.
   */
  addTelegramBot(token: string, workingDirectory: string): Promise<SpawnBotResult>;

  /**
   * Stop a bot, delete its account + session data, and remove it from the daemon.
   * Returns true if the bot existed, false if the accountId was unknown.
   */
  removeBot(accountId: string): Promise<boolean>;

  /** List currently running bot instances (accountId + human-readable label). */
  listBots(): Array<{ accountId: string; label: string }>;
}

export interface CommandContext {
  accountId: string;
  session: Session;
  updateSession: (partial: Partial<Session>) => void;
  clearSession: () => Session;
  getChatHistoryText?: (limit?: number) => string;
  rejectPendingPermission?: () => boolean;
  daemon?: DaemonHooks;
  text: string;
}

export interface CommandResult {
  reply?: string;
  handled: boolean;
  claudePrompt?: string; // If set, this text should be sent to Claude
}

/**
 * Parse and dispatch a slash command.
 *
 * Supported commands:
 *   /help     - Show help text with all available commands
 *   /clear    - Clear the current session
 *   /model <name> - Update the session model
 *   /status   - Show current session info
 *   /skills   - List all installed skills
 *   /<skill>  - Invoke a skill by name (args are forwarded to Claude)
 */
export function routeCommand(ctx: CommandContext): CommandResult {
  const text = ctx.text.trim();

  if (!text.startsWith('/')) {
    return { handled: false };
  }

  const spaceIdx = text.indexOf(' ');
  const cmd = (spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  logger.info(`Slash command: /${cmd} ${args}`.trimEnd());

  switch (cmd) {
    case 'help':
      return handleHelp(args);
    case 'clear':
      return handleClear(ctx);
    case 'reset':
      return handleReset(ctx);
    case 'cwd':
      return handleCwd(ctx, args);
    case 'model':
      return handleModel(ctx, args);
    case 'permission':
      return handlePermission(ctx, args);
    case 'prompt':
      return handlePrompt(ctx, args);
    case 'status':
      return handleStatus(ctx);
    case 'skills':
      return handleSkills(args);
    case 'history':
      return handleHistory(ctx, args);
    case 'undo':
      return handleUndo(ctx, args);
    case 'compact':
      return handleCompact(ctx);
    case 'version':
    case 'v':
      return handleVersion();
    case 'spawn':
      return handleSpawn(ctx, args);
    case 'rmbot':
      return handleRmbot(ctx, args);
    case 'bots':
      return handleBots(ctx);
    default:
      return handleUnknown(cmd, args);
  }
}
