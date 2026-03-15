import * as p from '@clack/prompts';
import pc from 'picocolors';
import * as lark from '@larksuiteoapi/node-sdk';
import { getConfig, writeConfig } from './config.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function isCancelled(value: unknown): boolean {
  return p.isCancel(value);
}

function bail(): never {
  p.cancel('Setup cancelled.');
  process.exit(0);
}

/** Verify Feishu credentials by calling the bot info API */
async function probeLark(appId: string, appSecret: string): Promise<{ ok: boolean; name?: string; error?: string }> {
  try {
    const client = new lark.Client({ appId, appSecret });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await (client as any).request({
      method: 'GET',
      url: '/open-apis/bot/v3/info',
      data: {},
    }) as any;
    if (res?.code === 0) {
      const bot = res.bot ?? res.data?.bot;
      return { ok: true, name: bot?.bot_name };
    }
    return { ok: false, error: res?.msg ?? `code ${res?.code}` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// ─── Lark onboarding ────────────────────────────────────────────────────────

async function onboardLark(): Promise<void> {
  p.note(
    [
      `1. 打开 ${pc.cyan('https://open.feishu.cn/app')}`,
      `2. 创建"企业自建应用"`,
      `3. 「添加应用能力」→ 选择 ${pc.bold('机器人')}`,
      `4. 「权限管理」→ 搜索并开通：`,
      `   ${pc.green('✓')} ${pc.bold('im:message')}（收发单聊/群聊消息）`,
    ].join('\n'),
    '飞书应用配置',
  );

  // Collect credentials
  const appId = await p.text({
    message: '完成后，填入 App ID',
    placeholder: 'cli_xxxxxxxxxxxxxxxx',
    validate: (v) => ((v ?? "").trim() ? undefined : '不能为空'),
  });
  if (isCancelled(appId)) bail();

  const appSecret = await p.password({
    message: 'App Secret',
    validate: (v) => ((v ?? "").trim() ? undefined : '不能为空'),
  });
  if (isCancelled(appSecret)) bail();

  // Verify credentials
  const spinner = p.spinner();
  spinner.start('验证凭证...');
  const probe = await probeLark(String(appId), String(appSecret));
  if (probe.ok) {
    spinner.stop(`${pc.green('✓')} 凭证验证通过${probe.name ? `，Bot 名称：${pc.bold(probe.name)}` : ''}`);
  } else {
    spinner.stop(`${pc.yellow('⚠')} 凭证验证失败：${probe.error}`);
    const cont = await p.confirm({ message: '仍然继续保存配置？', initialValue: false });
    if (isCancelled(cont) || !cont) bail();
  }

  // Allowlist
  const allowPolicy = await p.select({
    message: '谁可以给 Bot 发消息？',
    options: [
      { value: 'open', label: '所有人', hint: '任何人都可以' },
      { value: 'allowlist', label: '指定用户', hint: '只允许白名单用户' },
    ],
  });
  if (isCancelled(allowPolicy)) bail();

  let allowedUserIds: string[] = [];
  if (allowPolicy === 'allowlist') {
    p.note(
      [
        `在飞书开放平台「测试企业和人员」或通过 API 获取用户 open_id`,
        `格式：ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
      ].join('\n'),
      '如何获取 open_id',
    );

    const raw = await p.text({
      message: '用户 open_id（多个用逗号分隔）',
      placeholder: 'ou_xxxxx, ou_yyyyy',
      validate: (v) => ((v ?? "").trim() ? undefined : '至少填一个'),
    });
    if (isCancelled(raw)) bail();

    allowedUserIds = String(raw).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  }

  // Save config
  const cfg = getConfig();
  cfg.channels = cfg.channels ?? {};
  cfg.channels.lark = {
    appId: String(appId).trim(),
    appSecret: String(appSecret).trim(),
    allowedUserIds,
  };
  writeConfig(cfg);
}

// ─── Telegram onboarding ────────────────────────────────────────────────────

async function onboardTelegram(): Promise<void> {
  p.note(
    [
      `1. 打开 Telegram，搜索 ${pc.cyan('@BotFather')}`,
      `2. 发送 ${pc.bold('/newbot')} 并按提示操作`,
      `   - Bot 名称：例如 "My Claude"`,
      `   - Bot 用户名：必须以 bot 结尾，例如 "my_claude_bot"`,
      `3. 复制获得的 Token（格式：123456:ABC-DEF1234...）`,
    ].join('\n'),
    '创建 Telegram Bot',
  );

  const token = await p.password({
    message: 'Bot Token',
    validate: (v) => ((v ?? "").trim() ? undefined : '不能为空'),
  });
  if (isCancelled(token)) bail();

  p.note(
    [
      `获取 Chat ID：`,
      `1. 打开你的 Bot，发送 /chatid`,
      `2. Bot 会回复形如 ${pc.bold('tg:123456789')} 的 Chat ID`,
      `3. 群组：先把 Bot 加入群组，再在群里发 /chatid`,
    ].join('\n'),
    '获取 Chat ID',
  );

  const chatIdRaw = await p.text({
    message: '允许的 Chat ID（多个用逗号分隔）',
    placeholder: 'tg:123456789, tg:-1001234567890',
    validate: (v) => ((v ?? "").trim() ? undefined : '至少填一个'),
  });
  if (isCancelled(chatIdRaw)) bail();

  const allowedChatIds = String(chatIdRaw).split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

  const cfg = getConfig();
  cfg.channels = cfg.channels ?? {};
  cfg.channels.telegram = {
    botToken: String(token).trim(),
    allowedChatIds,
  };
  writeConfig(cfg);

  p.note(
    [
      `配置已保存到 ${pc.cyan('~/.imcc/config.json')}`,
      ``,
      `运行 ${pc.cyan('imcc start')} 启动服务。`,
    ].join('\n'),
    '配置完成 🎉',
  );
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function runOnboarding(): Promise<void> {
  p.intro(pc.bgCyan(pc.black(' imcc setup ')));

  console.log(
    `\n  ${pc.bold('imcc')} 将你的本机 Claude Code 桥接到 IM 应用。\n`,
  );

  const platform = await p.select({
    message: '选择要接入的平台',
    options: [
      { value: 'lark', label: '飞书（Lark）', hint: '推荐，无需公网地址' },
    ],
  });
  if (isCancelled(platform)) bail();

  if (platform === 'lark') {
    await onboardLark();
  } else {
    await onboardTelegram();
  }

  p.outro(`配置完成！运行 ${pc.cyan('imcc start')} 启动服务，服务启动后会提示如何开启飞书长连接。`);
}
