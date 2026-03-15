import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { BridgeResult } from './types.js';

export interface BridgeOptions {
  /** Working directory for claude. Defaults to ~ */
  cwd?: string;
  /** Extra CLI args to pass to claude */
  extraArgs?: string[];
  /** Timeout in ms. Defaults to 5 minutes */
  timeoutMs?: number;
  /** Model to use, e.g. "claude-opus-4-6". Defaults to claude's own default. */
  model?: string;
  /** Whether to pass --continue. Defaults to true. Set false to start a fresh session. */
  continueSession?: boolean;
}

/**
 * Invoke `claude --print --continue <prompt>` and return the output.
 *
 * Each call is a fresh process. `--continue` makes claude resume the most
 * recent session, so conversation history is preserved automatically via
 * claude's own session files in ~/.claude/.
 */
export async function runClaude(
  prompt: string,
  opts: BridgeOptions = {},
): Promise<BridgeResult> {
  const cwd = opts.cwd
    ? opts.cwd.replace(/^~/, os.homedir())
    : os.homedir();

  const args = [
    '--print',
    '--dangerously-skip-permissions',
    ...(opts.continueSession !== false ? ['--continue'] : []),
    ...(opts.model ? ['--model', opts.model] : []),
    ...(opts.extraArgs ?? []),
    prompt,
  ];

  return new Promise((resolve) => {
    const proc = spawn('claude', args, {
      cwd: path.resolve(cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({
        status: 'error',
        output: `Claude timed out after ${timeoutMs / 1000}s`,
      });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);

      const output = stdout.trim();

      if (code !== 0) {
        const errMsg = stderr.trim() || `Process exited with code ${code}`;
        resolve({ status: 'error', output: errMsg });
        return;
      }

      resolve({ status: 'success', output });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        status: 'error',
        output: `Failed to spawn claude: ${err.message}`,
      });
    });
  });
}
