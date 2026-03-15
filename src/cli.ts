#!/usr/bin/env node
import { program } from 'commander';
import './channels/index.js';
import { createChannels } from './channels/registry.js';
import { createMessageHandler } from './router.js';
import { getConfig } from './config.js';

program
  .name('imcc')
  .description('Bridge local Claude Code to IM apps')
  .version('0.1.0');

program
  .command('start')
  .description('Start the IM bridge')
  .action(async () => {
    const cfg = getConfig();

    // No channels configured → guide user to setup first
    const hasLark = cfg.channels?.lark?.appId;
    const hasTelegram = cfg.channels?.telegram?.botToken;
    if (!hasLark && !hasTelegram) {
      console.log('\nNo channels configured. Running setup...\n');
      const { runOnboarding } = await import('./onboarding.js');
      await runOnboarding();
      console.log('');
    }

    let channels: ReturnType<typeof createChannels> = [];
    const handler = createMessageHandler(() => channels);
    channels = createChannels(handler);

    if (channels.length === 0) {
      console.error('No channels configured. Run `imcc setup` to configure.');
      process.exit(1);
    }

    const finalCfg = getConfig();
    console.log(`\nimcc starting (${channels.length} channel(s))...`);
    console.log(`Claude cwd: ${finalCfg.claude?.cwd ?? '~'}\n`);

    for (const ch of channels) {
      await ch.connect();
    }

    // Lark-specific: remind user to complete first-time setup steps
    if (channels.some((c) => c.name === 'lark')) {
      console.log([
        '',
        '  ─── 飞书首次配置（如已完成可忽略）──────────────────────',
        '  1. 飞书开放平台 → 「事件与回调」→「添加事件」',
        '     订阅 im.message.receive_v1（接收消息）',
        '     ⚠ 添加事件后展开「所需权限」，确保所有权限都已开通',
        '       （默认仅开通群@机器人权限，私聊需额外开通）',
        '  2. 同页面「订阅方式」→ 选「使用长连接接收事件」→ 保存',
        '     （现在服务已运行，飞书可检测到连接，可以保存了）',
        '  3. 「版本管理与发布」→ 发布应用',
        '  ──────────────────────────────────────────────────────',
        '',
      ].join('\n'));
    }

    const shutdown = async () => {
      console.log('\nShutting down...');
      for (const ch of channels) {
        await ch.disconnect();
      }
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program
  .command('setup')
  .description('Configure imcc interactively')
  .action(async () => {
    const { runOnboarding } = await import('./onboarding.js');
    await runOnboarding();
  });

program.parse();
