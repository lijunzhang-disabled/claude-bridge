import type { CommandContext, CommandResult } from './router.js';
import { scanAllSkills, formatSkillList, findSkill, type SkillInfo } from '../claude/skill-scanner.js';
import { loadConfig, saveConfig } from '../config.js';
import { logger } from '../logger.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HELP_TEXT = `Commands:

Session:
  /help             Show this help
  /clear            Clear the current session
  /reset            Full reset (includes working directory etc.)
  /status           Show session state
  /compact          Compact context (start a new SDK session, keep history)
  /history [n]      Show conversation history (default last 20)
  /undo [n]         Undo last n turns (default 1)

Config:
  /cwd [path]       Show or change working directory
  /model [name]     Show or change Claude model
  /permission [mode]  Show or change permission mode
  /prompt [text]    Show or set the system prompt (global)

Bots (Telegram only):
  /bots             List all running bots
  /spawn <token> <cwd>  Add a new bot (get token from @BotFather first)
  /rmbot <accountId>    Remove a bot and delete its data

Other:
  /skills [full]    List installed skills (full shows descriptions)
  /version          Show version
  /<skill> [args]   Invoke an installed skill

Just send a message to talk to Claude Code.`;

// 缓存 skill 列表，避免每次命令都扫描文件系统
let cachedSkills: SkillInfo[] | null = null;
let lastScanTime = 0;
const CACHE_TTL = 60_000; // 60秒

function getSkills(): SkillInfo[] {
  const now = Date.now();
  if (!cachedSkills || now - lastScanTime > CACHE_TTL) {
    cachedSkills = scanAllSkills();
    lastScanTime = now;
  }
  return cachedSkills;
}

/** 清除缓存，用于 /skills 命令强制刷新 */
export function invalidateSkillCache(): void {
  cachedSkills = null;
}

export function handleHelp(_args: string): CommandResult {
  return { reply: HELP_TEXT, handled: true };
}

export function handleClear(ctx: CommandContext): CommandResult {
  // Reject any pending permission to avoid orphaned promise corrupting new session
  ctx.rejectPendingPermission?.();
  const newSession = ctx.clearSession();
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已清除，下次消息将开始新会话。', handled: true };
}

export function handleCwd(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: `当前工作目录: ${ctx.session.workingDirectory}\n用法: /cwd <路径>`, handled: true };
  }
  ctx.updateSession({ workingDirectory: args });
  return { reply: `✅ 工作目录已切换为: ${args}`, handled: true };
}

export function handleModel(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    return { reply: '用法: /model <模型名称>\n例: /model claude-sonnet-4-6', handled: true };
  }
  ctx.updateSession({ model: args });
  return { reply: `✅ 模型已切换为: ${args}`, handled: true };
}

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  default: '每次工具使用需手动审批',
  acceptEdits: '自动批准文件编辑，其他需审批',
  plan: '只读模式，不允许任何工具',
  auto: '自动批准所有工具（危险模式）',
};

export function handlePermission(ctx: CommandContext, args: string): CommandResult {
  if (!args) {
    const current = ctx.session.permissionMode ?? 'default';
    const lines = [
      '🔒 当前权限模式: ' + current,
      '',
      '可用模式:',
      ...PERMISSION_MODES.map(m => `  ${m} — ${PERMISSION_DESCRIPTIONS[m]}`),
      '',
      '用法: /permission <模式>',
    ];
    return { reply: lines.join('\n'), handled: true };
  }
  const mode = args.trim();
  if (!PERMISSION_MODES.includes(mode as any)) {
    return {
      reply: `未知模式: ${mode}\n可用: ${PERMISSION_MODES.join(', ')}`,
      handled: true,
    };
  }
  ctx.updateSession({ permissionMode: mode as any });
  const warning = mode === 'auto' ? '\n\n⚠️ 已开启危险模式：所有工具调用将自动批准，无需手动确认。' : '';
  return { reply: `✅ 权限模式已切换为: ${mode}\n${PERMISSION_DESCRIPTIONS[mode]}${warning}`, handled: true };
}

export function handleStatus(ctx: CommandContext): CommandResult {
  const s = ctx.session;
  const mode = s.permissionMode ?? 'default';
  const lines = [
    '📊 会话状态',
    '',
    `工作目录: ${s.workingDirectory}`,
    `模型: ${s.model ?? '默认'}`,
    `权限模式: ${mode}`,
    `会话ID: ${s.sdkSessionId ?? '无'}`,
    `状态: ${s.state}`,
  ];
  return { reply: lines.join('\n'), handled: true };
}

export function handleSkills(args: string): CommandResult {
  invalidateSkillCache();
  const skills = getSkills();
  if (skills.length === 0) {
    return { reply: '未找到已安装的 skill。', handled: true };
  }

  const showFull = args.trim().toLowerCase() === 'full';
  if (showFull) {
    const lines = skills.map(s => `/${s.name}\n   ${s.description}`);
    return { reply: `📋 已安装的 Skill (${skills.length}):\n\n${lines.join('\n\n')}`, handled: true };
  }
  const lines = skills.map(s => `/${s.name}`);
  return { reply: `📋 已安装的 Skill (${skills.length}):\n\n${lines.join('\n')}\n\n使用 /skills full 查看完整描述`, handled: true };
}

const MAX_HISTORY_LIMIT = 100;

export function handleHistory(ctx: CommandContext, args: string): CommandResult {
  const limit = args ? parseInt(args, 10) : 20;
  if (isNaN(limit) || limit <= 0) {
    return { reply: '用法: /history [数量]\n例: /history 50（显示最近50条对话）', handled: true };
  }
  const effectiveLimit = Math.min(limit, MAX_HISTORY_LIMIT);

  const historyText = ctx.getChatHistoryText?.(effectiveLimit) || '暂无对话记录';

  return { reply: `📝 对话记录（最近${effectiveLimit}条）:\n\n${historyText}`, handled: true };
}

/** 完全重置会话（包括工作目录等设置） */
export function handleReset(ctx: CommandContext): CommandResult {
  ctx.rejectPendingPermission?.();
  const newSession = ctx.clearSession();
  newSession.workingDirectory = process.cwd();
  newSession.model = undefined;
  newSession.permissionMode = undefined;
  Object.assign(ctx.session, newSession);
  return { reply: '✅ 会话已完全重置，所有设置恢复默认。', handled: true };
}

/** 压缩上下文 — 清除 SDK 会话 ID，开始新上下文但保留聊天历史 */
export function handleCompact(ctx: CommandContext): CommandResult {
  const currentSessionId = ctx.session.sdkSessionId;
  if (!currentSessionId) {
    return { reply: 'ℹ️ 当前没有活动的 SDK 会话，无需压缩。', handled: true };
  }
  ctx.updateSession({
    previousSdkSessionId: currentSessionId,
    sdkSessionId: undefined,
  });
  return {
    reply: '✅ 上下文已压缩\n\n下次消息将开始新的 SDK 会话（token 清零）\n聊天历史已保留，可用 /history 查看',
    handled: true,
  };
}

/** 撤销最近 N 条对话 */
export function handleUndo(ctx: CommandContext, args: string): CommandResult {
  const count = args ? parseInt(args, 10) : 1;
  if (isNaN(count) || count <= 0) {
    return { reply: '用法: /undo [数量]\n例: /undo 2（撤销最近2条对话）', handled: true };
  }
  const history = ctx.session.chatHistory || [];
  if (history.length === 0) {
    return { reply: '⚠️ 没有对话记录可撤销', handled: true };
  }
  const actualCount = Math.min(count, history.length);
  ctx.session.chatHistory = history.slice(0, -actualCount);
  ctx.updateSession({ chatHistory: ctx.session.chatHistory });
  return { reply: `✅ 已撤销最近 ${actualCount} 条对话`, handled: true };
}

/** 查看版本信息 */
export function handleVersion(): CommandResult {
  try {
    const __dirname = fileURLToPath(new URL('.', import.meta.url));
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    const version = pkg.version || 'unknown';
    return { reply: `wechat-claude-code v${version}`, handled: true };
  } catch {
    return { reply: 'wechat-claude-code (version unknown)', handled: true };
  }
}

export function handlePrompt(_ctx: CommandContext, args: string): CommandResult {
  const config = loadConfig();
  if (!args) {
    const current = config.systemPrompt;
    if (current) {
      return { reply: `📝 当前系统提示词:\n${current}\n\n用法:\n/prompt <提示词>  — 设置\n/prompt clear   — 清除`, handled: true };
    }
    return { reply: '📝 暂无系统提示词\n\n用法: /prompt <提示词>\n例: /prompt 用中文回答我', handled: true };
  }
  if (args.trim().toLowerCase() === 'clear') {
    config.systemPrompt = undefined;
    saveConfig(config);
    return { reply: '✅ 系统提示词已清除', handled: true };
  }
  config.systemPrompt = args.trim();
  saveConfig(config);
  return { reply: `✅ 系统提示词已设置:\n${config.systemPrompt}`, handled: true };
}

export function handleUnknown(cmd: string, args: string): CommandResult {
  const skills = getSkills();
  const skill = findSkill(skills, cmd);

  if (skill) {
    const prompt = args ? `Use the ${skill.name} skill: ${args}` : `Use the ${skill.name} skill`;
    return { handled: true, claudePrompt: prompt };
  }

  return {
    handled: true,
    reply: `Skill not found: ${cmd}\nRun /skills to see the list.`,
  };
}

/** Telegram bot token format: <digits>:<alnum/-/_>{35,} */
const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{35,}$/;

/** Register and hot-load a new Telegram bot from chat. */
export function handleSpawn(ctx: CommandContext, args: string): CommandResult {
  if (!ctx.daemon) {
    return {
      reply: '⚠️ /spawn is not available in this context.',
      handled: true,
    };
  }

  const trimmed = args.trim();
  if (!trimmed) {
    return {
      reply: [
        'Usage: /spawn <bot_token> <working_directory>',
        '',
        '1. Create a new bot via @BotFather (/newbot) and copy the token.',
        '2. Open the new bot and tap Start.',
        '3. Send /spawn <token> <path> here.',
        '',
        'IMPORTANT: delete your /spawn message after this bot confirms,',
        'so your token does not stay in chat history.',
      ].join('\n'),
      handled: true,
    };
  }

  const firstSpace = trimmed.indexOf(' ');
  if (firstSpace === -1) {
    return { reply: 'Usage: /spawn <bot_token> <working_directory>', handled: true };
  }
  const token = trimmed.slice(0, firstSpace).trim();
  const cwd = trimmed.slice(firstSpace + 1).trim();

  if (!TELEGRAM_TOKEN_RE.test(token)) {
    return { reply: '⚠️ Invalid bot token format. Copy it from @BotFather.', handled: true };
  }
  if (!cwd) {
    return { reply: 'Usage: /spawn <bot_token> <working_directory>', handled: true };
  }

  // Fire-and-forget: daemon.addTelegramBot is async (hits the Telegram API).
  // Return a placeholder reply now; the daemon will send a follow-up message
  // once registration completes.
  const daemon = ctx.daemon;
  const startReply = '⏳ Validating token and spawning bot…';

  // Actual work runs in claudePrompt-style async path via the daemon context.
  // We schedule it as a background task attached to the command result.
  ctx.daemon = daemon; // reassign for closure capture
  queueMicrotask(async () => {
    try {
      await daemon.addTelegramBot(token, cwd);
      // Follow-up confirmation is sent by the daemon itself (has channel access).
    } catch (err) {
      logger.error('Spawn failed', { error: err instanceof Error ? err.message : String(err) });
      // Daemon is expected to send the error message back to the chat; if it
      // cannot, the failure will surface in logs.
    }
  });

  return { reply: startReply, handled: true };
}

/** Remove a bot from the daemon and delete its data. */
export function handleRmbot(ctx: CommandContext, args: string): CommandResult {
  if (!ctx.daemon) {
    return { reply: '⚠️ /rmbot is not available in this context.', handled: true };
  }

  const targetId = args.trim();
  if (!targetId) {
    return {
      reply: 'Usage: /rmbot <accountId>\nRun /bots to see accountIds.',
      handled: true,
    };
  }

  if (targetId === ctx.accountId) {
    return {
      reply: '⚠️ Cannot remove the bot you are currently talking to. Use another bot, or stop the daemon and edit files manually.',
      handled: true,
    };
  }

  const daemon = ctx.daemon;
  queueMicrotask(async () => {
    try {
      await daemon.removeBot(targetId);
    } catch (err) {
      logger.error('rmbot failed', { error: err instanceof Error ? err.message : String(err) });
    }
  });

  return { reply: `⏳ Removing ${targetId}…`, handled: true };
}

/** List all running bots in the daemon. */
export function handleBots(ctx: CommandContext): CommandResult {
  if (!ctx.daemon) {
    return { reply: '⚠️ /bots is not available in this context.', handled: true };
  }
  const bots = ctx.daemon.listBots();
  if (bots.length === 0) {
    return { reply: 'No bots running.', handled: true };
  }
  const lines = ['Running bots:', ''];
  for (const b of bots) {
    const marker = b.accountId === ctx.accountId ? ' (you)' : '';
    lines.push(`  ${b.accountId}${marker}  ${b.label}`);
  }
  return { reply: lines.join('\n'), handled: true };
}
