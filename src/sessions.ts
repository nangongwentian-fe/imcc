import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const CODEX_HOME = path.join(os.homedir(), '.codex');
const CODEX_SESSION_INDEX = path.join(CODEX_HOME, 'session_index.jsonl');
const CODEX_SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');
const DEFAULT_LIMIT = 10;

export interface SessionInfo {
  id: string;
  projectPath: string;
  firstMessage: string;
  timestamp: Date;
  cwd: string;
}

interface ClaudeSessionRecord {
  type?: string;
  isMeta?: boolean;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  message?: {
    content?: unknown;
  };
}

interface CodexIndexRecord {
  id?: string;
  thread_name?: string;
  updated_at?: string;
}

interface CodexSessionMetaRecord {
  type?: string;
  payload?: {
    id?: string;
    timestamp?: string;
    cwd?: string;
  };
}

function normalizeCwd(cwd?: string): string | undefined {
  if (!cwd) return undefined;
  return path.resolve(cwd.replace(/^~/, os.homedir()));
}

function cwdToProjectDirName(cwd: string): string {
  return cwd.replace(/[/:\\]/g, '-');
}

function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const text = (block as { text?: unknown }).text;
      return typeof text === 'string' ? text.trim() : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function sanitizeSummary(text: string): string {
  const compact = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!compact) return '';
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

function collectJsonlFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];

  const result: string[] = [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        result.push(fullPath);
        continue;
      }

      if (entry.isDirectory()) {
        result.push(...collectJsonlFiles(fullPath));
      }
    }
  } catch {
    return result;
  }

  return result;
}

function isUsefulClaudeUserMessage(record: ClaudeSessionRecord, summary: string): boolean {
  if (record.type !== 'user' || record.isMeta) return false;
  if (!summary) return false;
  if (summary.includes('local-command-caveat')) return false;
  return !summary.startsWith('/clear');
}

function readClaudeSessionSummary(filePath: string): SessionInfo | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;

    let record: ClaudeSessionRecord;
    try {
      record = JSON.parse(line) as ClaudeSessionRecord;
    } catch {
      continue;
    }

    const text = extractTextContent(record.message?.content);
    const summary = sanitizeSummary(text);
    if (!isUsefulClaudeUserMessage(record, summary)) continue;

    const cwd = record.cwd ? path.resolve(record.cwd) : '';
    const projectPath = cwd || path.dirname(filePath);
    const timestamp = record.timestamp ? new Date(record.timestamp) : stat.mtime;
    const sessionId = record.sessionId || path.basename(filePath, '.jsonl');

    return {
      id: sessionId,
      projectPath,
      firstMessage: summary,
      timestamp: Number.isNaN(timestamp.getTime()) ? stat.mtime : timestamp,
      cwd,
    };
  }

  return null;
}

function getCandidateClaudeProjectDirs(cwd?: string): string[] {
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return [];

  const normalized = normalizeCwd(cwd);
  if (!normalized) {
    return fs
      .readdirSync(CLAUDE_PROJECTS_DIR)
      .map((entry) => path.join(CLAUDE_PROJECTS_DIR, entry));
  }

  const exactDir = path.join(CLAUDE_PROJECTS_DIR, cwdToProjectDirName(normalized));
  if (fs.existsSync(exactDir)) {
    return [exactDir];
  }

  return fs
    .readdirSync(CLAUDE_PROJECTS_DIR)
    .map((entry) => path.join(CLAUDE_PROJECTS_DIR, entry));
}

export function listClaudeSessions(opts: { cwd?: string; limit?: number } = {}): SessionInfo[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const normalizedCwd = normalizeCwd(opts.cwd);
  const files = getCandidateClaudeProjectDirs(opts.cwd).flatMap(collectJsonlFiles);
  const deduped = new Map<string, SessionInfo>();

  for (const filePath of files) {
    const session = readClaudeSessionSummary(filePath);
    if (!session) continue;
    if (normalizedCwd && session.cwd && session.cwd !== normalizedCwd) continue;
    deduped.set(session.id, session);
  }

  return [...deduped.values()]
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, limit);
}

export function findClaudeSessionByPrefix(
  prefix: string,
  opts: { cwd?: string; limit?: number } = {},
): SessionInfo[] {
  const normalizedPrefix = prefix.trim().toLowerCase();
  if (!normalizedPrefix) return [];

  return listClaudeSessions({ ...opts, limit: opts.limit ?? 50 }).filter((session) =>
    session.id.toLowerCase().startsWith(normalizedPrefix),
  );
}

function readCodexIndex(): CodexIndexRecord[] {
  if (!fs.existsSync(CODEX_SESSION_INDEX)) return [];

  try {
    return fs
      .readFileSync(CODEX_SESSION_INDEX, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as CodexIndexRecord];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function findCodexSessionFile(sessionId: string): string | null {
  if (!fs.existsSync(CODEX_SESSIONS_DIR)) return null;

  const files = collectJsonlFiles(CODEX_SESSIONS_DIR);
  return files.find((filePath) => filePath.endsWith(`${sessionId}.jsonl`)) ?? null;
}

function readCodexSessionMeta(sessionId: string): { cwd: string; timestamp: Date } | null {
  const filePath = findCodexSessionFile(sessionId);
  if (!filePath) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return null;
  }

  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = content.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;

    let record: CodexSessionMetaRecord;
    try {
      record = JSON.parse(line) as CodexSessionMetaRecord;
    } catch {
      continue;
    }

    if (record.type !== 'session_meta') continue;

    const cwd = record.payload?.cwd ? path.resolve(record.payload.cwd) : '';
    const timestamp = record.payload?.timestamp
      ? new Date(record.payload.timestamp)
      : stat.mtime;

    return {
      cwd,
      timestamp: Number.isNaN(timestamp.getTime()) ? stat.mtime : timestamp,
    };
  }

  return {
    cwd: '',
    timestamp: stat.mtime,
  };
}

export function listCodexSessions(opts: { cwd?: string; limit?: number } = {}): SessionInfo[] {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const normalizedCwd = normalizeCwd(opts.cwd);
  const deduped = new Map<string, SessionInfo>();

  for (const record of readCodexIndex()) {
    if (!record.id) continue;

    const meta = readCodexSessionMeta(record.id);
    const cwd = meta?.cwd ?? '';
    if (normalizedCwd && cwd && cwd !== normalizedCwd) continue;

    const timestamp = record.updated_at ? new Date(record.updated_at) : meta?.timestamp ?? new Date();
    deduped.set(record.id, {
      id: record.id,
      projectPath: cwd || CODEX_SESSIONS_DIR,
      firstMessage: sanitizeSummary(record.thread_name ?? '') || '(untitled session)',
      timestamp: Number.isNaN(timestamp.getTime()) ? meta?.timestamp ?? new Date() : timestamp,
      cwd,
    });
  }

  return [...deduped.values()]
    .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
    .slice(0, limit);
}

export function findCodexSessionByPrefix(
  prefix: string,
  opts: { cwd?: string; limit?: number } = {},
): SessionInfo[] {
  const normalizedPrefix = prefix.trim().toLowerCase();
  if (!normalizedPrefix) return [];

  return listCodexSessions({ ...opts, limit: opts.limit ?? 50 }).filter((session) =>
    session.id.toLowerCase().startsWith(normalizedPrefix),
  );
}
