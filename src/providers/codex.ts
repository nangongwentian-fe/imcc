import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { ProfileConfig } from '../config.js';
import { findCodexSessionByPrefix, listCodexSessions } from '../sessions.js';
import type { StreamCallbacks } from '../bridge.js';
import type { BridgeResult } from '../types.js';
import type { Provider, ProviderRunContext, SessionState } from './types.js';

interface CodexEvent {
  type?: string;
  thread_id?: string;
  item?: {
    type?: string;
    text?: string;
    content?: unknown;
  };
}

function resolveCwd(cwd?: string): string {
  return cwd ? path.resolve(cwd.replace(/^~/, os.homedir())) : os.homedir();
}

function resolveTimeoutMs(timeoutMs?: number): number | null {
  if (timeoutMs === 0) return null;
  if (Number.isFinite(timeoutMs) && Number(timeoutMs) > 0) {
    return Number(timeoutMs);
  }
  return 5 * 60 * 1000;
}

function extractItemText(item: CodexEvent['item']): string {
  if (!item) return '';
  if (typeof item.text === 'string') return item.text.trim();

  if (!Array.isArray(item.content)) return '';
  return item.content
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return '';
      const text = (entry as { text?: unknown }).text;
      return typeof text === 'string' ? text.trim() : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function buildCodexArgs(prompt: string, profile: ProfileConfig, state: SessionState): string[] {
  const args = ['exec'];

  if (state.resumeSessionId) {
    args.push('resume');
  }

  args.push('--json');

  const model = state.model ?? profile.runtime?.model;
  if (model) {
    args.push('--model', model);
  }

  if (profile.provider === 'codex') {
    args.push('--sandbox', profile.codex?.sandboxMode ?? 'workspace-write');
    args.push('--ask-for-approval', profile.codex?.approvalPolicy ?? 'never');
  }

  if (profile.runtime?.extraArgs?.length) {
    args.push(...profile.runtime.extraArgs);
  }

  if (state.resumeSessionId) {
    args.push(state.resumeSessionId);
  }

  args.push(prompt);
  return args;
}

async function runCodexStream(
  prompt: string,
  context: ProviderRunContext,
  callbacks: Pick<StreamCallbacks, 'onInit' | 'onComplete' | 'onError'>,
): Promise<BridgeResult> {
  const cwd = resolveCwd(context.state.cwd ?? context.profile.runtime?.cwd);
  const args = buildCodexArgs(prompt, context.profile, context.state);

  return new Promise((resolve) => {
    const proc = spawn('codex', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let stderr = '';
    let settled = false;
    let fullText = '';
    let initSent = false;
    let lineQueue = Promise.resolve();
    const startedAt = Date.now();

    const finish = async (result: BridgeResult): Promise<void> => {
      if (settled) return;
      settled = true;
      await lineQueue.catch(() => {});
      resolve(result);
    };

    const safeInit = async (sessionId: string): Promise<void> => {
      if (initSent || !callbacks.onInit) {
        initSent = true;
        return;
      }
      initSent = true;
      await callbacks.onInit(sessionId);
    };

    const handleSuccess = async (): Promise<void> => {
      const text = fullText.trim();
      await callbacks.onComplete?.({
        text,
        durationMs: Date.now() - startedAt,
        cost: 0,
      });
      await finish({ status: 'success', output: text });
    };

    const handleError = async (message: string): Promise<void> => {
      await callbacks.onError?.(message);
      await finish({ status: 'error', output: message });
    };

    const handleLine = async (line: string): Promise<void> => {
      if (!line.trim() || settled) return;

      let payload: CodexEvent;
      try {
        payload = JSON.parse(line) as CodexEvent;
      } catch {
        return;
      }

      if (payload.type === 'thread.started') {
        const threadId = typeof payload.thread_id === 'string' ? payload.thread_id : '';
        if (threadId) {
          await safeInit(threadId);
        }
        return;
      }

      if (payload.type === 'turn.started') {
        if (context.state.resumeSessionId) {
          await safeInit(context.state.resumeSessionId);
        }
        return;
      }

      if (payload.type === 'item.completed' && payload.item?.type === 'agent_message') {
        const text = extractItemText(payload.item);
        if (!text) return;

        fullText = fullText ? `${fullText}\n\n${text}` : text;
        return;
      }

      if (payload.type === 'turn.completed') {
        if (fullText.trim()) {
          await handleSuccess();
          return;
        }

        await handleError('Codex returned no agent message');
      }
    };

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;

      while (true) {
        const newlineIndex = stdoutBuffer.indexOf('\n');
        if (newlineIndex === -1) break;

        const line = stdoutBuffer.slice(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        lineQueue = lineQueue.then(() => handleLine(line)).catch(() => {});
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timeoutMs = resolveTimeoutMs(context.profile.runtime?.timeoutMs);
    const timer = timeoutMs === null
      ? null
      : setTimeout(() => {
          proc.kill('SIGTERM');
          void handleError(`Codex timed out after ${timeoutMs / 1000}s`);
        }, timeoutMs);

    proc.on('close', (code) => {
      if (timer) {
        clearTimeout(timer);
      }

      void (async () => {
        if (settled) return;
        if (stdoutBuffer.trim()) {
          await handleLine(stdoutBuffer);
        }

        if (settled) return;
        if (code === 0 && fullText.trim()) {
          await handleSuccess();
          return;
        }

        const message = stderr.trim() || `Codex exited with code ${code}`;
        await handleError(message);
      })();
    });

    proc.on('error', (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      void handleError(`Failed to spawn codex: ${err.message}`);
    });
  });
}

export class CodexProvider implements Provider {
  kind = 'codex' as const;
  displayName = 'Codex';
  capabilities = {
    permissionPrompts: false,
    trueStreaming: false,
    modelHelp: '输入任意 Codex 支持的模型名',
  };

  resolveModel(input: string): string | null {
    const normalized = input.trim();
    return normalized ? normalized : null;
  }

  getCurrentModel(state: SessionState, profile: ProfileConfig): string {
    return state.model ?? profile.runtime?.model ?? '未设置（使用 Codex 默认）';
  }

  runStream(
    prompt: string,
    context: ProviderRunContext,
    callbacks: StreamCallbacks,
  ) {
    return runCodexStream(prompt, context, callbacks);
  }

  async startFreshSession(
    context: Omit<ProviderRunContext, 'permissionPromptJid'>,
  ): Promise<string | null> {
    let sessionId: string | null = null;
    const result = await runCodexStream(
      '.',
      {
        ...context,
        state: {
          ...context.state,
          resumeSessionId: undefined,
        },
      },
      {
        onInit: async (id) => {
          sessionId = id;
        },
      },
    );

    if (result.status === 'error') {
      throw new Error(result.output || 'Failed to create a fresh Codex session');
    }

    return sessionId;
  }

  listSessions(opts: { cwd?: string; limit?: number }) {
    return listCodexSessions(opts);
  }

  findSessionByPrefix(prefix: string, opts: { cwd?: string; limit?: number }) {
    return findCodexSessionByPrefix(prefix, opts);
  }
}
