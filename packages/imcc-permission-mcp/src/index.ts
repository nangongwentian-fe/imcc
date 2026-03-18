import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const SERVER_NAME = 'imcc-permission-mcp-server';
const SERVER_VERSION = '0.1.0';
const TOOL_NAME = 'imcc_permission_prompt';
const DEFAULT_PERMISSION_TIMEOUT_MS = 35_000;

type PermissionPayload =
  | {
      behavior: 'allow';
      updatedInput: unknown;
    }
  | {
      behavior: 'deny';
      message: string;
    };

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

const PermissionRequestSchema = z.object({
  tool_name: z.string().min(1).describe('Claude 请求调用的工具名'),
  input: z.unknown().describe('Claude 原始工具入参'),
  tool_use_id: z.string().optional().describe('Claude 提供的可选 tool use id'),
});

function parseCliArgs(args: string[]): { socketPath: string; jid: string } {
  let socketPath = '';
  let jid = '';

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--socket') {
      socketPath = args[i + 1] ?? '';
      i += 1;
      continue;
    }
    if (arg === '--jid') {
      jid = args[i + 1] ?? '';
      i += 1;
    }
  }

  if (!socketPath || !jid) {
    throw new Error(
      'imcc-permission-mcp requires --socket <path> and --jid <jid>. ' +
        'It is meant to be launched by imcc or another compatible broker.',
    );
  }

  return { socketPath, jid };
}

function buildSocketRequest(
  jid: string,
  input: z.infer<typeof PermissionRequestSchema>,
): SocketPermissionRequest {
  return {
    type: 'permission_request',
    id: randomUUID(),
    jid,
    toolName: input.tool_name,
    toolInput: input.input,
    toolUseId: input.tool_use_id,
  };
}

async function sendPermissionRequest(
  socketPath: string,
  request: SocketPermissionRequest,
): Promise<PermissionPayload> {
  return new Promise<PermissionPayload>((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');

    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({
        behavior: 'deny',
        message:
          `Permission bridge timed out for ${request.toolName}. ` +
          'Check whether imcc is still running and the broker socket is reachable.',
      });
    }, DEFAULT_PERMISSION_TIMEOUT_MS);

    let buffer = '';

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });

    socket.on('data', (chunk: string) => {
      buffer += chunk;

      while (true) {
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex === -1) break;

        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;

        try {
          const response = JSON.parse(line) as SocketPermissionResponse;
          if (response.type !== 'permission_response' || response.id !== request.id) {
            continue;
          }

          clearTimeout(timeout);
          socket.end();
          resolve(response.payload);
          return;
        } catch {
          // Ignore malformed lines while waiting for the matching response.
        }
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timeout);
      resolve({
        behavior: 'deny',
        message:
          `Permission bridge connection failed: ${err.message}. ` +
          'Check whether the broker socket path is correct and imcc is running.',
      });
    });
  });
}

function createServer(socketPath: string, jid: string): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    TOOL_NAME,
    {
      title: 'Approve Claude Tool Usage',
      description:
        'Ask imcc to approve or deny Claude tool usage for the current IM chat session.',
      inputSchema: PermissionRequestSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => {
      const payload = await sendPermissionRequest(
        socketPath,
        buildSocketRequest(jid, input),
      );

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(payload),
          },
        ],
      };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const { socketPath, jid } = parseCliArgs(process.argv.slice(2));
  const server = createServer(socketPath, jid);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`${SERVER_NAME} running on stdio`);
}

main().catch((error) => {
  console.error('Fatal error in imcc-permission-mcp:', error);
  process.exit(1);
});
