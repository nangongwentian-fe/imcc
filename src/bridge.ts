import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { buildPermissionMcpConfig } from './permission-broker.js';
import type { BridgeResult } from './types.js';

interface ClaudeResultEvent {
  subtype?: string;
  duration_ms?: number;
  total_cost_usd?: number;
  result?: string;
}

interface StreamEventPayload {
  type?: string;
  delta?: {
    type?: string;
    text?: string;
  };
  content_block?: {
    type?: string;
    name?: string;
    input?: unknown;
  };
}

export interface StreamCallbacks {
  onInit?: (sessionId: string) => void | Promise<void>;
  onText?: (delta: string, fullText: string) => void | Promise<void>;
  onToolUse?: (toolName: string, toolInput: unknown) => void | Promise<void>;
  onToolResult?: (toolName: string, isError: boolean) => void | Promise<void>;
  onComplete?: (result: {
    text: string;
    durationMs: number;
    cost: number;
  }) => void | Promise<void>;
  onError?: (error: string) => void | Promise<void>;
}

export interface BridgeOptions {
  /** Working directory for claude. Defaults to ~ */
  cwd?: string;
  /** Extra CLI args to pass to claude */
  extraArgs?: string[];
  /** Explicitly allowed tools for the current Claude session */
  allowedTools?: string[];
  /** Timeout in ms. Defaults to 5 minutes */
  timeoutMs?: number;
  /** Model to use, e.g. "claude-opus-4-6". Defaults to claude's own default. */
  model?: string;
  /** Whether to pass --continue. Defaults to true. Set false to start a fresh session. */
  continueSession?: boolean;
  /** Resume a specific session instead of using --continue. */
  resumeSessionId?: string;
  /** Route permission prompts back to the current IM chat. */
  permissionPromptJid?: string;
}

function resolveCwd(cwd?: string): string {
  return cwd ? path.resolve(cwd.replace(/^~/, os.homedir())) : os.homedir();
}

async function buildClaudeArgs(
  prompt: string,
  opts: BridgeOptions,
): Promise<string[]> {
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ];

  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  } else if (opts.continueSession !== false) {
    args.push('--continue');
  }

  if (opts.model) {
    args.push('--model', opts.model);
  }

  if (opts.allowedTools && opts.allowedTools.length > 0) {
    args.push('--allowedTools', opts.allowedTools.join(','));
  }

  if (opts.permissionPromptJid) {
    const permissionConfig = await buildPermissionMcpConfig(opts.permissionPromptJid);
    args.push(
      '--mcp-config',
      permissionConfig.mcpConfig,
      '--permission-prompt-tool',
      permissionConfig.toolName,
    );
  } else {
    args.push('--dangerously-skip-permissions');
  }

  if (opts.extraArgs && opts.extraArgs.length > 0) {
    args.push(...opts.extraArgs);
  }

  args.push(prompt);
  return args;
}

function extractToolResultBlocks(payload: unknown): Array<{ name: string; isError: boolean }> {
  if (!payload || typeof payload !== 'object') return [];

  const message = (payload as { message?: { content?: unknown } }).message;
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.flatMap((block) => {
    if (!block || typeof block !== 'object') return [];
    const typedBlock = block as {
      type?: string;
      tool_name?: string;
      name?: string;
      is_error?: boolean;
    };
    if (typedBlock.type !== 'tool_result') return [];
    return [{
      name: typedBlock.tool_name ?? typedBlock.name ?? 'unknown',
      isError: Boolean(typedBlock.is_error),
    }];
  });
}

function getTextDelta(event: StreamEventPayload): string {
  if (event.delta?.type !== 'text_delta') return '';
  return typeof event.delta.text === 'string' ? event.delta.text : '';
}

function resolveTimeoutMs(timeoutMs?: number): number | null {
  if (timeoutMs === 0) return null;
  if (Number.isFinite(timeoutMs) && Number(timeoutMs) > 0) {
    return Number(timeoutMs);
  }
  return 5 * 60 * 1000;
}

async function invoke<T extends unknown[]>(
  callback: ((...args: T) => void | Promise<void>) | undefined,
  ...args: T
): Promise<void> {
  if (!callback) return;
  try {
    await callback(...args);
  } catch (err) {
    console.warn('[bridge] callback failed:', err);
  }
}

/**
 * Invoke Claude in stream-json mode and emit structured callbacks while the
 * response is still streaming.
 */
export async function runClaudeStream(
  prompt: string,
  opts: BridgeOptions = {},
  callbacks: StreamCallbacks = {},
): Promise<BridgeResult> {
  const cwd = resolveCwd(opts.cwd);
  const args = await buildClaudeArgs(prompt, opts);

  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuffer = '';
    let stderr = '';
    let fullText = '';
    let settled = false;
    let lineQueue = Promise.resolve();
    const startedAt = Date.now();

    const finish = (result: BridgeResult): void => {
      if (settled) return;
      settled = true;
      // Do not await lineQueue here: result/error lines are handled inside the
      // queue itself, so awaiting it would deadlock the current turn forever.
      resolve(result);
    };

    const handleResultSuccess = async (event: ClaudeResultEvent): Promise<void> => {
      const text = typeof event.result === 'string' ? event.result.trim() : fullText.trim();
      await invoke(callbacks.onComplete, {
        text,
        durationMs: event.duration_ms ?? Date.now() - startedAt,
        cost: event.total_cost_usd ?? 0,
      });
      finish({ status: 'success', output: text });
    };

    const handleResultError = async (event: ClaudeResultEvent, fallbackError = 'Claude returned an error'): Promise<void> => {
      const message = typeof event.result === 'string' && event.result.trim()
        ? event.result.trim()
        : fallbackError;
      await invoke(callbacks.onError, message);
      finish({ status: 'error', output: message });
    };

    const handleLine = async (line: string): Promise<void> => {
      if (!line.trim() || settled) return;

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

      const type = typeof payload.type === 'string' ? payload.type : '';
      if (type === 'system' && payload.subtype === 'init') {
        const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
        if (sessionId) {
          await invoke(callbacks.onInit, sessionId);
        }
        return;
      }

      if (type === 'stream_event') {
        const event = (payload.event ?? {}) as StreamEventPayload;
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          await invoke(
            callbacks.onToolUse,
            event.content_block.name ?? 'unknown',
            event.content_block.input,
          );
          return;
        }

        if (event.type === 'content_block_delta') {
          const delta = getTextDelta(event);
          if (!delta) return;
          fullText += delta;
          await invoke(callbacks.onText, delta, fullText);
        }
        return;
      }

      if (type === 'user') {
        for (const block of extractToolResultBlocks(payload)) {
          await invoke(callbacks.onToolResult, block.name, block.isError);
        }
        return;
      }

      if (type === 'result') {
        const resultEvent = payload as ClaudeResultEvent;
        if (resultEvent.subtype === 'success') {
          await handleResultSuccess(resultEvent);
        } else {
          await handleResultError(resultEvent);
        }
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
        lineQueue = lineQueue.then(() => handleLine(line));
      }
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
    const timer = timeoutMs === null
      ? null
      : setTimeout(() => {
          proc.kill('SIGTERM');
          void handleResultError({}, `Claude timed out after ${timeoutMs / 1000}s`);
        }, timeoutMs);

    proc.on('close', (code) => {
      if (timer) {
        clearTimeout(timer);
      }
      lineQueue = lineQueue.then(async () => {
        if (stdoutBuffer.trim()) {
          await handleLine(stdoutBuffer);
        }

        if (settled) return;
        if (code === 0 && fullText.trim()) {
          await handleResultSuccess({ result: fullText });
          return;
        }

        const errMsg = stderr.trim() || `Process exited with code ${code}`;
        await handleResultError({ result: errMsg }, errMsg);
      });
    });

    proc.on('error', (err) => {
      if (timer) {
        clearTimeout(timer);
      }
      void handleResultError({}, `Failed to spawn claude: ${err.message}`);
    });
  });
}

/**
 * Backward-compatible wrapper that waits for the final result only.
 */
export async function runClaude(
  prompt: string,
  opts: BridgeOptions = {},
): Promise<BridgeResult> {
  return runClaudeStream(prompt, opts, {});
}
