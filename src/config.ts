import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  claude?: {
    cwd?: string;
    extraArgs?: string[];
    timeoutMs?: number;
  };
  channels?: {
    telegram?: {
      botToken?: string;
      allowedChatIds?: string[];
    };
    lark?: {
      appId?: string;
      appSecret?: string;
      verificationToken?: string;
      encryptKey?: string;
      allowedUserIds?: string[];
      webhookPort?: number;
    };
  };
}

const CONFIG_PATH = path.join(os.homedir(), '.imcc', 'config.json');

let cached: Config | null = null;

export function getConfig(): Config {
  if (cached) return cached;

  if (!fs.existsSync(CONFIG_PATH)) {
    cached = {};
    return cached;
  }

  try {
    cached = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;
  } catch (err) {
    console.error(`Failed to parse config at ${CONFIG_PATH}:`, err);
    cached = {};
  }
  return cached;
}

export function writeConfig(config: Config): void {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  cached = config;
}
