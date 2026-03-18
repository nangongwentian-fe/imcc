import fs from 'node:fs';
import net, { type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Channel } from './types.js';

const PERMISSION_SERVER_ALIAS = 'imcc_permission';
const PERMISSION_TOOL_NAME = 'imcc_permission_prompt';
const PERMISSION_PACKAGE_NAME = 'imcc-permission-mcp';
const DEFAULT_PERMISSION_TIMEOUT_MS = 30_000;

export type PermissionDecision = 'allow' | 'allow_session' | 'deny';

interface PermissionPayloadAllow {
  behavior: 'allow';
  updatedInput: unknown;
}

interface PermissionPayloadDeny {
  behavior: 'deny';
  message: string;
}

export type PermissionPayload = PermissionPayloadAllow | PermissionPayloadDeny;

interface PermissionContext {
  channel: Channel;
  allowTool(toolName: string): void;
  permissionTimeoutMs?: number;
}

interface PendingPermission {
  id: string;
  jid: string;
  toolName: string;
  toolInput: unknown;
  resolve: (payload: PermissionPayload) => void;
  timer: NodeJS.Timeout | null;
  allowTool: (toolName: string) => void;
}

interface SocketPermissionRequest {
  type: 'permission_request';
  id: string;
  jid: string;
  toolName: string;
  toolInput: unknown;
  toolUseId?: string;
}

interface SocketPermissionResponse {
  type: 'permission_response';
  id: string;
  payload: PermissionPayload;
}

function buildSocketPath(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\imcc-permission-${process.pid}`;
  }

  return path.join(os.tmpdir(), `imcc-permission-${process.pid}.sock`);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeToolInput(toolInput: unknown): string {
  const summary = safeJsonStringify(toolInput).replace(/\s+/g, ' ').trim();
  if (!summary) return '(empty)';
  return summary.length > 300 ? `${summary.slice(0, 297)}...` : summary;
}

function buildPermissionPayload(
  decision: PermissionDecision,
  toolName: string,
  toolInput: unknown,
): PermissionPayload {
  if (decision === 'deny') {
    return {
      behavior: 'deny',
      message: `Permission denied for ${toolName}`,
    };
  }

  return {
    behavior: 'allow',
    updatedInput: toolInput,
  };
}

function formatPermissionFallbackMessage(
  toolName: string,
  toolInputSummary: string,
  permId: string,
): string {
  return [
    `Claude 请求工具权限：${toolName}`,
    `输入：${toolInputSummary}`,
    '回复以下命令审批：',
    `/perm allow ${permId}`,
    `/perm allow-session ${permId}`,
    `/perm deny ${permId}`,
  ].join('\n');
}

function parseDecision(input: string): PermissionDecision | null {
  switch (input) {
    case 'allow':
      return 'allow';
    case 'allow-session':
    case 'allow_session':
      return 'allow_session';
    case 'deny':
      return 'deny';
    default:
      return null;
  }
}

function resolvePermissionTimeoutMs(timeoutMs?: number): number | null {
  if (timeoutMs === 0) return null;
  if (Number.isFinite(timeoutMs) && Number(timeoutMs) > 0) {
    return Number(timeoutMs);
  }
  return DEFAULT_PERMISSION_TIMEOUT_MS;
}

function getNpxCommand(): string {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function resolveLocalPermissionMcpEntry(): string | null {
  const entry = fileURLToPath(
    new URL('../packages/imcc-permission-mcp/dist/index.js', import.meta.url),
  );
  return fs.existsSync(entry) ? entry : null;
}

function getPermissionMcpLaunch(
  socketPath: string,
  jid: string,
): { command: string; args: string[] } {
  const localEntry = resolveLocalPermissionMcpEntry();
  if (localEntry) {
    return {
      command: process.execPath,
      args: [localEntry, '--socket', socketPath, '--jid', jid],
    };
  }

  return {
    command: getNpxCommand(),
    args: ['-y', PERMISSION_PACKAGE_NAME, '--socket', socketPath, '--jid', jid],
  };
}

class PermissionBroker {
  private server: Server | null = null;
  private readonly socketPath = buildSocketPath();
  private readonly contexts = new Map<string, PermissionContext>();
  private readonly pending = new Map<string, PendingPermission>();
  private startPromise: Promise<string> | null = null;

  async ensureStarted(): Promise<string> {
    if (this.server) {
      return this.socketPath;
    }

    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = new Promise<string>((resolve, reject) => {
      const server = net.createServer((socket) => {
        this.attachSocket(socket);
      });

      server.once('error', (err) => {
        this.startPromise = null;
        reject(err);
      });

      if (process.platform !== 'win32') {
        try {
          if (fs.existsSync(this.socketPath)) {
            fs.unlinkSync(this.socketPath);
          }
        } catch {
          // Ignore stale socket cleanup failures and let listen surface the real error.
        }
      }

      server.listen(this.socketPath, () => {
        this.server = server;
        this.startPromise = null;
        resolve(this.socketPath);
      });
    });

    return this.startPromise;
  }

  registerContext(jid: string, context: PermissionContext): void {
    this.contexts.set(jid, context);
  }

  unregisterContext(jid: string): void {
    this.contexts.delete(jid);
  }

  resolvePending(
    permId: string,
    decision: PermissionDecision,
    opts: { chatId?: string } = {},
  ): { ok: boolean; message: string } {
    const pending = this.pending.get(permId);
    if (!pending) {
      return { ok: false, message: '审批请求不存在或已过期' };
    }

    if (opts.chatId && pending.jid !== `lark:${opts.chatId}`) {
      return { ok: false, message: '审批来源与原始会话不匹配' };
    }

    if (pending.timer) {
      clearTimeout(pending.timer);
    }
    this.pending.delete(permId);

    if (decision === 'allow_session') {
      pending.allowTool(pending.toolName);
    }

    pending.resolve(buildPermissionPayload(decision, pending.toolName, pending.toolInput));

    const labels: Record<PermissionDecision, string> = {
      allow: '已允许本次调用',
      allow_session: '已允许本会话后续调用',
      deny: '已拒绝工具调用',
    };

    return { ok: true, message: labels[decision] };
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.values()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.resolve({
        behavior: 'deny',
        message: 'Permission broker stopped before approval was completed',
      });
    }
    this.pending.clear();
    this.contexts.clear();

    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    if (process.platform !== 'win32') {
      try {
        if (fs.existsSync(this.socketPath)) {
          fs.unlinkSync(this.socketPath);
        }
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  private attachSocket(socket: Socket): void {
    socket.setEncoding('utf8');

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;

      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) break;

        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line) continue;
        void this.handleSocketLine(socket, line);
      }
    });
  }

  private async handleSocketLine(socket: Socket, line: string): Promise<void> {
    let request: SocketPermissionRequest;
    try {
      request = JSON.parse(line) as SocketPermissionRequest;
    } catch {
      return;
    }

    if (request.type !== 'permission_request') {
      return;
    }

    const payload = await this.handlePermissionRequest(request);
    const response: SocketPermissionResponse = {
      type: 'permission_response',
      id: request.id,
      payload,
    };
    socket.write(`${JSON.stringify(response)}\n`);
  }

  private async handlePermissionRequest(
    request: SocketPermissionRequest,
  ): Promise<PermissionPayload> {
    const context = this.contexts.get(request.jid);
    if (!context) {
      return {
        behavior: 'deny',
        message: `No active IM context for ${request.jid}`,
      };
    }

    const toolInputSummary = summarizeToolInput(request.toolInput);
    const permissionTimeoutMs = resolvePermissionTimeoutMs(context.permissionTimeoutMs);

    return new Promise<PermissionPayload>((resolve) => {
      const timer = permissionTimeoutMs === null
        ? null
        : setTimeout(() => {
            this.pending.delete(request.id);
            resolve({
              behavior: 'deny',
              message: `Permission request timed out for ${request.toolName}`,
            });
          }, permissionTimeoutMs);

      this.pending.set(request.id, {
        id: request.id,
        jid: request.jid,
        toolName: request.toolName,
        toolInput: request.toolInput,
        resolve,
        timer,
        allowTool: context.allowTool,
      });

      const fallbackMessage = formatPermissionFallbackMessage(
        request.toolName,
        toolInputSummary,
        request.id,
      );

      const sendPrompt = async (): Promise<void> => {
        if (context.channel.sendPermissionCard) {
          await context.channel.sendPermissionCard(
            request.jid,
            request.toolName,
            toolInputSummary,
            request.id,
          );
          return;
        }

        await context.channel.sendMessage(request.jid, fallbackMessage);
      };

      void sendPrompt().catch(async (err) => {
        console.warn('[permission] failed to send approval prompt:', err);

        try {
          await context.channel.sendMessage(request.jid, fallbackMessage);
        } catch {
          if (timer) {
            clearTimeout(timer);
          }
          this.pending.delete(request.id);
          resolve({
            behavior: 'deny',
            message: `Failed to deliver permission prompt for ${request.toolName}`,
          });
        }
      });
    });
  }
}

let brokerSingleton: PermissionBroker | null = null;

export function getPermissionBroker(): PermissionBroker {
  brokerSingleton ??= new PermissionBroker();
  return brokerSingleton;
}

export async function buildPermissionMcpConfig(
  jid: string,
): Promise<{ mcpConfig: string; toolName: string }> {
  const socketPath = await getPermissionBroker().ensureStarted();
  const launch = getPermissionMcpLaunch(socketPath, jid);

  return {
    mcpConfig: JSON.stringify({
      mcpServers: {
        [PERMISSION_SERVER_ALIAS]: {
          type: 'stdio',
          command: launch.command,
          args: launch.args,
        },
      },
    }),
    toolName: `mcp__${PERMISSION_SERVER_ALIAS}__${PERMISSION_TOOL_NAME}`,
  };
}

export function resolvePermissionFromCommand(
  actionInput: string,
  permId: string,
): { ok: boolean; message: string } {
  const decision = parseDecision(actionInput.trim().toLowerCase());
  if (!decision) {
    return {
      ok: false,
      message: '用法：/perm allow|allow-session|deny <id>',
    };
  }

  return getPermissionBroker().resolvePending(permId.trim(), decision);
}
