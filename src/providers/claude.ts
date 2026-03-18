import { runClaudeStream, type BridgeOptions, type StreamCallbacks } from '../bridge.js';
import type { ProfileConfig } from '../config.js';
import { findClaudeSessionByPrefix, listClaudeSessions } from '../sessions.js';
import type { BridgeResult } from '../types.js';
import type { Provider, ProviderRunContext, SessionState } from './types.js';

const MODEL_ALIASES: Record<string, string> = {
  opus: 'claude-opus-4-6',
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5-20251001',
};

function buildOptions(
  profile: ProfileConfig,
  state: SessionState,
  permissionPromptJid?: string,
): BridgeOptions {
  return {
    cwd: state.cwd ?? profile.runtime?.cwd,
    extraArgs: profile.runtime?.extraArgs,
    timeoutMs: profile.runtime?.timeoutMs,
    model: state.model ?? profile.runtime?.model,
    resumeSessionId: state.resumeSessionId,
    allowedTools: state.allowedTools,
    permissionPromptJid,
  };
}

export class ClaudeProvider implements Provider {
  kind = 'claude' as const;
  displayName = 'Claude Code';
  capabilities = {
    permissionPrompts: true,
    trueStreaming: true,
    modelHelp: '可选：opus · sonnet · haiku，或完整 claude-* 模型名',
  };

  resolveModel(input: string): string | null {
    const lower = input.toLowerCase().trim();
    if (MODEL_ALIASES[lower]) return MODEL_ALIASES[lower];
    if (lower.startsWith('claude-')) return input.trim();
    return null;
  }

  getCurrentModel(state: SessionState, profile: ProfileConfig): string {
    return state.model ?? profile.runtime?.model ?? '未设置（使用 Claude 默认）';
  }

  async runStream(
    prompt: string,
    context: ProviderRunContext,
    callbacks: StreamCallbacks,
  ): Promise<BridgeResult> {
    return runClaudeStream(
      prompt,
      buildOptions(context.profile, context.state, context.permissionPromptJid),
      callbacks,
    );
  }

  async startFreshSession(
    context: Omit<ProviderRunContext, 'permissionPromptJid'>,
  ): Promise<string | null> {
    let sessionId: string | null = null;
    const result = await runClaudeStream(
      '.',
      {
        ...buildOptions(context.profile, { ...context.state, resumeSessionId: undefined, allowedTools: undefined }),
        continueSession: false,
        resumeSessionId: undefined,
      },
      {
        onInit: async (id) => {
          sessionId = id;
        },
      },
    );

    if (result.status === 'error') {
      throw new Error(result.output || 'Failed to create a fresh Claude session');
    }

    return sessionId;
  }

  listSessions(opts: { cwd?: string; limit?: number }) {
    return listClaudeSessions(opts);
  }

  findSessionByPrefix(prefix: string, opts: { cwd?: string; limit?: number }) {
    return findClaudeSessionByPrefix(prefix, opts);
  }
}
