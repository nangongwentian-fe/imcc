import { resolvePermissionFromCommand } from './permission-broker.js';
import type { ProfileConfig } from './config.js';
import type { Provider, SessionState } from './providers/types.js';
import type { Channel } from './types.js';

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.max(1, Math.floor(diffMs / 60_000));
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function buildHelp(provider: Provider, profile: ProfileConfig): string {
  const lines = [
    `当前实例：${profile.name} (${provider.displayName})`,
    '可用命令：',
    '  /help                 显示此帮助',
    '  /clear                开启新对话（清除上下文）',
    '  /model                查看当前模型',
    '  /model <名称>         切换模型',
    '  /cwd                  查看当前工作目录',
    '  /cwd <路径>           切换工作目录',
    '  /sessions [n]         查看最近会话',
    '  /resume <id前缀>      恢复指定会话',
  ];

  if (provider.capabilities.permissionPrompts) {
    lines.push('  /perm ...              审批 Claude 工具权限');
  }

  return lines.join('\n');
}

function addAllowedTool(state: SessionState, toolName: string): void {
  const current = new Set(state.allowedTools ?? []);
  current.add(toolName);
  state.allowedTools = [...current];
}

function formatSessions(
  provider: Provider,
  limit: number,
  cwd?: string,
): string {
  const sessions = provider.listSessions({ cwd, limit });
  if (sessions.length === 0) {
    return `没有找到可恢复的本地 ${provider.displayName} 会话`;
  }

  const lines = [`最近会话（${provider.displayName}）：`];
  sessions.forEach((session, index) => {
    lines.push(
      `${index + 1}. [${session.id.slice(0, 8)}] ${formatRelativeTime(session.timestamp)} — ${session.projectPath}`,
    );
    lines.push(`   "${session.firstMessage}"`);
  });
  return lines.join('\n');
}

async function switchFreshSession(
  jid: string,
  channel: Channel,
  provider: Provider,
  profile: ProfileConfig,
  state: SessionState,
): Promise<void> {
  await channel.setTyping?.(jid, true);
  try {
    const sessionId = await provider.startFreshSession({ profile, state });
    state.resumeSessionId = sessionId ?? undefined;
  } finally {
    await channel.setTyping?.(jid, false);
  }
}

async function handleResumeCommand(
  args: string[],
  jid: string,
  channel: Channel,
  provider: Provider,
  profile: ProfileConfig,
  state: SessionState,
): Promise<boolean> {
  const prefix = args[0]?.trim();
  if (!prefix) {
    await channel.sendMessage(jid, '用法：/resume <会话ID前缀>');
    return true;
  }

  const cwd = state.cwd ?? profile.runtime?.cwd;
  const matches = provider.findSessionByPrefix(prefix, { cwd, limit: 50 });

  if (matches.length === 0) {
    await channel.sendMessage(jid, `未找到以 ${prefix} 开头的会话`);
    return true;
  }

  if (matches.length > 1) {
    const suggestions = matches
      .slice(0, 5)
      .map((session) => `${session.id.slice(0, 8)} — ${session.firstMessage}`)
      .join('\n');
    await channel.sendMessage(jid, `匹配到多个会话，请提供更长前缀：\n${suggestions}`);
    return true;
  }

  const [matched] = matches;
  state.resumeSessionId = matched.id;
  await channel.sendMessage(
    jid,
    `已切换到会话 ${matched.id.slice(0, 8)}\n"${matched.firstMessage}"`,
  );
  return true;
}

export async function handleCommand(
  text: string,
  jid: string,
  channel: Channel,
  provider: Provider,
  profile: ProfileConfig,
  state: SessionState,
): Promise<boolean> {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return false;

  const [cmd, ...args] = trimmed.split(/\s+/);

  switch (cmd.toLowerCase()) {
    case '/help': {
      await channel.sendMessage(jid, buildHelp(provider, profile));
      return true;
    }

    case '/clear': {
      state.allowedTools = undefined;
      state.resumeSessionId = undefined;
      await switchFreshSession(jid, channel, provider, profile, state);
      await channel.sendMessage(jid, '新对话已开启');
      return true;
    }

    case '/model': {
      if (args.length === 0) {
        await channel.sendMessage(
          jid,
          `当前模型：${provider.getCurrentModel(state, profile)}\n${provider.capabilities.modelHelp}`,
        );
        return true;
      }

      const resolved = provider.resolveModel(args[0]);
      if (!resolved) {
        await channel.sendMessage(jid, `未知模型：${args[0]}\n${provider.capabilities.modelHelp}`);
        return true;
      }

      state.model = resolved;
      state.allowedTools = undefined;
      state.resumeSessionId = undefined;
      await switchFreshSession(jid, channel, provider, profile, state);
      await channel.sendMessage(jid, `已切换到 ${resolved}，新对话已开启`);
      return true;
    }

    case '/cwd': {
      if (args.length === 0) {
        const current = state.cwd ?? profile.runtime?.cwd ?? '~';
        await channel.sendMessage(jid, `当前工作目录：${current}`);
        return true;
      }

      state.cwd = args[0];
      state.allowedTools = undefined;
      state.resumeSessionId = undefined;
      await switchFreshSession(jid, channel, provider, profile, state);
      await channel.sendMessage(jid, `工作目录已切换到 ${args[0]}，新对话已开启`);
      return true;
    }

    case '/sessions': {
      const count = Number.parseInt(args[0] ?? '', 10);
      const limit = Number.isFinite(count) && count > 0 ? count : 5;
      await channel.sendMessage(
        jid,
        formatSessions(provider, limit, state.cwd ?? profile.runtime?.cwd),
      );
      return true;
    }

    case '/resume':
      return handleResumeCommand(args, jid, channel, provider, profile, state);

    case '/perm': {
      if (!provider.capabilities.permissionPrompts) {
        await channel.sendMessage(jid, '当前实例不支持远程权限审批');
        return true;
      }

      if (args.length < 2) {
        await channel.sendMessage(jid, '用法：/perm allow|allow-session|deny <id>');
        return true;
      }

      const result = resolvePermissionFromCommand(args[0], args[1]);
      await channel.sendMessage(jid, result.message);
      return true;
    }

    default: {
      await channel.sendMessage(jid, `未知命令：${cmd}\n发送 /help 查看可用命令`);
      return true;
    }
  }
}

export function allowToolForSession(state: SessionState, toolName: string): void {
  addAllowedTool(state, toolName);
}
