#!/usr/bin/env node
import * as p from '@clack/prompts';
import { program } from 'commander';
import pc from 'picocolors';
import './channels/index.js';
import { createChannels } from './channels/registry.js';
import { getConfig, getProfile, listProfiles, setLastProfile, type ProfileConfig } from './config.js';
import { getPermissionBroker } from './permission-broker.js';
import { createProvider } from './providers/index.js';
import { createMessageHandler } from './router.js';
import { acquireProfileLock } from './runtime-lock.js';

function bail(): never {
  p.cancel('Operation cancelled.');
  process.exit(0);
}

function describeProfile(profile: ProfileConfig): string {
  return `${profile.name} · ${profile.provider} · ${profile.channel.type}`;
}

function sortProfilesForSelection(profiles: ProfileConfig[]): ProfileConfig[] {
  const lastProfile = getConfig().lastProfile;
  return [...profiles].sort((a, b) => {
    if (a.name === lastProfile) return -1;
    if (b.name === lastProfile) return 1;
    return a.name.localeCompare(b.name);
  });
}

async function ensureProfile(explicitName?: string): Promise<ProfileConfig> {
  if (explicitName) {
    const profile = getProfile(explicitName);
    if (!profile) {
      throw new Error(`Profile "${explicitName}" 不存在，请先运行 \`imcc setup\``);
    }
    return profile;
  }

  let profiles = listProfiles();
  if (profiles.length === 0) {
    console.log('\nNo profiles configured. Running setup...\n');
    const { runOnboarding } = await import('./onboarding.js');
    const createdProfile = await runOnboarding();
    const profile = getProfile(createdProfile);
    if (!profile) {
      throw new Error(`Profile "${createdProfile}" 保存失败`);
    }
    return profile;
  }

  if (profiles.length === 1) {
    return profiles[0]!;
  }

  profiles = sortProfilesForSelection(profiles);
  const selected = await p.select({
    message: '选择要启动的 profile',
    options: profiles.map((profile) => ({
      value: profile.name,
      label: profile.name,
      hint: `${profile.provider} / ${profile.channel.type}${profile.name === getConfig().lastProfile ? ' / recent' : ''}`,
    })),
  });
  if (p.isCancel(selected)) bail();

  const profile = getProfile(String(selected));
  if (!profile) {
    throw new Error(`Profile "${String(selected)}" 不存在`);
  }
  return profile;
}

program
  .name('imcc')
  .description('Bridge local Claude Code and Codex CLIs to IM apps')
  .version('0.2.0');

program
  .command('start')
  .description('Start one configured IM bridge profile')
  .option('-p, --profile <name>', 'Start a specific profile')
  .action(async (options: { profile?: string }) => {
    let releaseLock = () => {};
    let channels: ReturnType<typeof createChannels> = [];
    let shuttingDown = false;

    try {
      const profile = await ensureProfile(options.profile);
      releaseLock = acquireProfileLock(profile.name);
      setLastProfile(profile.name);

      const provider = createProvider(profile);
      const handler = createMessageHandler({
        getChannels: () => channels,
        profile,
        provider,
      });
      channels = createChannels(profile, handler);

      if (channels.length === 0) {
        throw new Error(
          `Profile "${profile.name}" 的 channel (${profile.channel.type}) 当前不可用，请先重新 setup`,
        );
      }

      console.log(`\nimcc starting: ${describeProfile(profile)}`);
      console.log(`Provider: ${provider.displayName}`);
      console.log(`Workdir: ${profile.runtime?.cwd ?? '~'}\n`);

      for (const channel of channels) {
        await channel.connect();
      }

      if (channels.some((channel) => channel.name === 'lark')) {
        console.log([
          '',
          '  ─── 飞书首次配置（如已完成可忽略）──────────────────────',
          '  1. 飞书开放平台 → 「开发配置」→「权限管理」',
          '     开通 cardkit:card:read / cardkit:card:write / cardkit:template:read',
          '     开通 im:message / im:message:group_at_msg:readonly',
          '     开通 im:message:group_msg / im:message:p2p_msg:readonly',
          '     （消息权限和卡片权限都不要漏）',
          '  2. 飞书开放平台 → 「开发配置」→「事件与回调」',
          '  3. 「事件配置」页签：',
          '     选择「使用长连接接收事件」→ 添加 im.message.receive_v1',
          '  4. 「回调配置」页签：',
          '     选择「使用长连接接收回调」→ 添加 card.action.trigger',
          '     （未订阅时，审批卡片按钮点击不会回传到 imcc）',
          '  5. 保存长连接配置',
          '     （现在服务已运行，飞书可检测到连接，可以保存了）',
          '  6. 「版本管理与发布」→ 发布应用',
          '  ──────────────────────────────────────────────────────',
          '',
        ].join('\n'));
      }

      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;

        console.log(`\nShutting down profile ${profile.name}...`);
        for (const channel of channels) {
          await channel.disconnect().catch(() => {});
        }
        await getPermissionBroker().stop().catch(() => {});
        releaseLock();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (err) {
      for (const channel of channels) {
        await channel.disconnect().catch(() => {});
      }
      await getPermissionBroker().stop().catch(() => {});
      releaseLock();

      const message = err instanceof Error ? err.message : String(err);
      console.error(pc.red(`Error: ${message}`));
      process.exit(1);
    }
  });

program
  .command('setup')
  .description('Create a profile interactively')
  .action(async () => {
    const { runOnboarding } = await import('./onboarding.js');
    await runOnboarding();
  });

program.parse();
