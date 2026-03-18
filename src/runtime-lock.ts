import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK_DIR = path.join(os.homedir(), '.imcc', 'run');

interface LockPayload {
  pid: number;
  profile: string;
  startedAt: string;
}

function sanitizeProfileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '-');
}

function getLockPath(profileName: string): string {
  return path.join(LOCK_DIR, `${sanitizeProfileName(profileName)}.json`);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireProfileLock(profileName: string): () => void {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const lockPath = getLockPath(profileName);

  if (fs.existsSync(lockPath)) {
    try {
      const raw = fs.readFileSync(lockPath, 'utf8');
      const payload = JSON.parse(raw) as LockPayload;
      if (isProcessAlive(payload.pid)) {
        throw new Error(
          `Profile "${profileName}" is already running in pid ${payload.pid}. ` +
            'Use another profile or stop the existing instance first.',
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('already running')) {
        throw err;
      }
    }
  }

  const payload: LockPayload = {
    pid: process.pid,
    profile: profileName,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(lockPath, JSON.stringify(payload, null, 2) + '\n');

  return () => {
    try {
      if (!fs.existsSync(lockPath)) return;

      const raw = fs.readFileSync(lockPath, 'utf8');
      const current = JSON.parse(raw) as LockPayload;
      if (current.pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    } catch {
      // Best-effort cleanup only.
    }
  };
}
