import { homedir } from 'node:os';
import { join } from 'node:path';

export const DATA_DIR = process.env.CLAUDE_BRIDGE_DATA_DIR || join(homedir(), '.claude-bridge');
