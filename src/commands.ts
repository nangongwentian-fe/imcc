import { runClaude } from './bridge.js';
import type { BridgeOptions } from './bridge.js';
import type { Channel } from './types.js';

export interface SessionState {
  model?: string;
  cwd?: string;
}

const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

function resolveModel(input: string): string | null {
  const lower = input.toLowerCase().trim();
  if (MODEL_ALIASES[lower]) return MODEL_ALIASES[lower];
  if (lower.startsWith('claude-')) return input.trim();
  return null;
}

const HELP = [
  '可用命令：',
  '  /help           显示此帮助',
  '  /clear          开启新对话（清除上下文）',
  '  /model          查看当前模型',
  '  /model <名称>   切换模型',
  '                  可选：opus · sonnet · haiku',
  '  /cwd            查看当前工作目录',
  '  /cwd <路径>     切换工作目录',
].join('\n');

/**
 * Handle a slash command sent from IM.
 * Returns true if the text was a command (consumed), false if it should be forwarded to claude.
 */
export async function handleCommand(
  text: string,
  jid: string,
  channel: Channel,
  state: SessionState,
  baseCfg: BridgeOptions,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;

  const [cmd, ...args] = trimmed.split(/\s+/);

  switch (cmd.toLowerCase()) {
    case '/help': {
      await channel.sendMessage(jid, HELP);
      return true;
    }

    case '/clear': {
      await channel.setTyping?.(jid, true);
      // Run without --continue to create a new session as the latest one.
      // Future --continue calls will resume from this fresh session.
      await runClaude('.', {
        ...baseCfg,
        cwd: state.cwd ?? baseCfg.cwd,
        model: state.model,
        continueSession: false,
      });
      await channel.setTyping?.(jid, false);
      await channel.sendMessage(jid, '新对话已开启');
      return true;
    }

    case '/model': {
      if (args.length === 0) {
        const current = state.model ?? '未设置（使用 claude 默认）';
        await channel.sendMessage(jid, `当前模型：${current}\n可选：opus · sonnet · haiku`);
        return true;
      }
      const resolved = resolveModel(args[0]);
      if (!resolved) {
        await channel.sendMessage(
          jid,
          `未知模型：${args[0]}\n可选：opus · sonnet · haiku`,
        );
        return true;
      }
      state.model = resolved;
      // Start a fresh session so the new model takes effect immediately.
      // --continue would reuse the previous session's stored model and ignore --model.
      await channel.setTyping?.(jid, true);
      await runClaude('.', {
        ...baseCfg,
        cwd: state.cwd ?? baseCfg.cwd,
        model: resolved,
        continueSession: false,
      });
      await channel.setTyping?.(jid, false);
      await channel.sendMessage(jid, `已切换到 ${resolved}，新对话已开启`);
      return true;
    }

    case '/cwd': {
      if (args.length === 0) {
        const current = state.cwd ?? baseCfg.cwd ?? '~';
        await channel.sendMessage(jid, `当前工作目录：${current}`);
        return true;
      }
      state.cwd = args[0];
      await channel.sendMessage(jid, `工作目录已切换到 ${args[0]}`);
      return true;
    }

    default: {
      await channel.sendMessage(jid, `未知命令：${cmd}\n发送 /help 查看可用命令`);
      return true;
    }
  }
}
