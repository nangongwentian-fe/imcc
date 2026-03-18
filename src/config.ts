import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ProviderKind = 'claude' | 'codex';
export type ChannelKind = 'lark' | 'telegram';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ApprovalPolicy = 'untrusted' | 'on-request' | 'never';

export interface RuntimeConfig {
  cwd?: string;
  extraArgs?: string[];
  timeoutMs?: number;
  permissionTimeoutMs?: number;
  model?: string;
}

export interface LarkChannelConfig {
  type: 'lark';
  appId: string;
  appSecret: string;
  allowedUserIds?: string[];
  verificationToken?: string;
  encryptKey?: string;
  webhookPort?: number;
}

export interface TelegramChannelConfig {
  type: 'telegram';
  botToken: string;
  allowedChatIds?: string[];
}

export type ProfileChannelConfig = LarkChannelConfig | TelegramChannelConfig;

export interface ProfileConfig {
  name: string;
  provider: ProviderKind;
  channel: ProfileChannelConfig;
  runtime?: RuntimeConfig;
  codex?: {
    sandboxMode?: SandboxMode;
    approvalPolicy?: ApprovalPolicy;
  };
}

interface LegacyConfig {
  claude?: {
    cwd?: string;
    extraArgs?: string[];
    timeoutMs?: number;
    permissionTimeoutMs?: number;
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

export interface Config extends LegacyConfig {
  version?: number;
  lastProfile?: string;
  profiles?: Record<string, ProfileConfig>;
}

const CONFIG_PATH = path.join(os.homedir(), '.imcc', 'config.json');
const CURRENT_CONFIG_VERSION = 2;

let cached: Config | null = null;

function cloneConfig(config: Config): Config {
  return JSON.parse(JSON.stringify(config)) as Config;
}

function hasProfiles(config: Config): boolean {
  return Boolean(config.profiles && Object.keys(config.profiles).length > 0);
}

function buildLegacyProfiles(config: Config): Record<string, ProfileConfig> {
  const profiles: Record<string, ProfileConfig> = {};
  const runtime: RuntimeConfig | undefined = config.claude
    ? {
        cwd: config.claude.cwd,
        extraArgs: config.claude.extraArgs,
        timeoutMs: config.claude.timeoutMs,
        permissionTimeoutMs: config.claude.permissionTimeoutMs,
      }
    : undefined;

  const lark = config.channels?.lark;
  if (lark?.appId && lark.appSecret) {
    profiles['claude-default'] = {
      name: 'claude-default',
      provider: 'claude',
      channel: {
        type: 'lark',
        appId: lark.appId,
        appSecret: lark.appSecret,
        allowedUserIds: lark.allowedUserIds ?? [],
        verificationToken: lark.verificationToken,
        encryptKey: lark.encryptKey,
        webhookPort: lark.webhookPort,
      },
      runtime,
    };
  }

  const telegram = config.channels?.telegram;
  if (telegram?.botToken) {
    profiles['claude-telegram-default'] = {
      name: 'claude-telegram-default',
      provider: 'claude',
      channel: {
        type: 'telegram',
        botToken: telegram.botToken,
        allowedChatIds: telegram.allowedChatIds ?? [],
      },
      runtime,
    };
  }

  return profiles;
}

function migrateConfigIfNeeded(input: Config): { config: Config; migrated: boolean } {
  if (hasProfiles(input)) {
    const normalized = cloneConfig(input);
    normalized.version = CURRENT_CONFIG_VERSION;

    for (const [name, profile] of Object.entries(normalized.profiles ?? {})) {
      profile.name = profile.name || name;
    }

    return { config: normalized, migrated: normalized.version !== input.version };
  }

  const migratedProfiles = buildLegacyProfiles(input);
  if (Object.keys(migratedProfiles).length === 0) {
    const normalized = cloneConfig(input);
    normalized.version = CURRENT_CONFIG_VERSION;
    normalized.profiles = normalized.profiles ?? {};
    return { config: normalized, migrated: normalized.version !== input.version };
  }

  const migrated: Config = {
    version: CURRENT_CONFIG_VERSION,
    lastProfile: migratedProfiles['claude-default']
      ? 'claude-default'
      : Object.keys(migratedProfiles)[0],
    profiles: migratedProfiles,
  };

  return { config: migrated, migrated: true };
}

function loadConfigFromDisk(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {
      version: CURRENT_CONFIG_VERSION,
      profiles: {},
    };
  }

  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Config;
  } catch (err) {
    console.error(`Failed to parse config at ${CONFIG_PATH}:`, err);
    return {
      version: CURRENT_CONFIG_VERSION,
      profiles: {},
    };
  }
}

export function getConfig(): Config {
  if (cached) return cached;

  const raw = loadConfigFromDisk();
  const { config, migrated } = migrateConfigIfNeeded(raw);
  cached = config;

  if (migrated) {
    writeConfig(config);
  }

  return cached;
}

export function writeConfig(config: Config): void {
  const dir = path.dirname(CONFIG_PATH);
  fs.mkdirSync(dir, { recursive: true });

  const normalized = cloneConfig(config);
  normalized.version = CURRENT_CONFIG_VERSION;
  normalized.profiles = normalized.profiles ?? {};

  for (const [name, profile] of Object.entries(normalized.profiles)) {
    profile.name = profile.name || name;
  }

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2) + '\n');
  cached = normalized;
}

export function listProfiles(): ProfileConfig[] {
  return Object.values(getConfig().profiles ?? {}).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
}

export function getProfile(name: string): ProfileConfig | null {
  return getConfig().profiles?.[name] ?? null;
}

export function saveProfile(profile: ProfileConfig): void {
  const config = getConfig();
  config.profiles = config.profiles ?? {};
  config.profiles[profile.name] = profile;
  config.lastProfile = profile.name;
  writeConfig(config);
}

export function setLastProfile(name: string): void {
  const config = getConfig();
  config.lastProfile = name;
  writeConfig(config);
}
