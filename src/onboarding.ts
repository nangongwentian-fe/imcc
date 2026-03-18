import * as p from '@clack/prompts';
import pc from 'picocolors';
import * as lark from '@larksuiteoapi/node-sdk';
import {
  listProfiles,
  saveProfile,
  type ApprovalPolicy,
  type ChannelKind,
  type ProfileConfig,
  type ProviderKind,
  type SandboxMode,
} from './config.js';

function isCancelled(value: unknown): boolean {
  return p.isCancel(value);
}

function bail(): never {
  p.cancel('Setup cancelled.');
  process.exit(0);
}

function buildSuggestedProfileName(provider: ProviderKind): string {
  const existing = new Set(listProfiles().map((profile) => profile.name));
  const base = provider === 'claude' ? 'claude-main' : 'codex-main';

  if (!existing.has(base)) {
    return base;
  }

  let suffix = 2;
  while (existing.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function parseListInput(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseExtraArgs(raw: string): string[] | undefined {
  const matches = raw.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const args = matches
    .map((part) => part.replace(/^"(.*)"$/, '$1').trim())
    .filter(Boolean);

  return args.length > 0 ? args : undefined;
}

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

async function promptProvider(): Promise<ProviderKind> {
  const value = await p.select({
    message: '选择要接入的本机工具',
    options: [
      {
        value: 'claude',
        label: 'Claude Code',
        hint: '支持流式卡片和飞书工具审批',
      },
      {
        value: 'codex',
        label: 'Codex',
        hint: 'v1 不支持飞书远程审批，默认受限模式',
      },
    ],
  });
  if (isCancelled(value)) bail();
  return value as ProviderKind;
}

async function promptProfileName(provider: ProviderKind): Promise<string> {
  const suggestion = buildSuggestedProfileName(provider);
  const existing = new Set(listProfiles().map((profile) => profile.name));

  const value = await p.text({
    message: 'Profile 名称',
    placeholder: suggestion,
    validate: (input) => {
      const name = String(input ?? '').trim() || suggestion;
      if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
        return '仅支持字母、数字、点、下划线和短横线';
      }
      if (existing.has(name)) {
        return '该 profile 已存在，请换一个名字';
      }
      return undefined;
    },
  });
  if (isCancelled(value)) bail();

  return String(value ?? '').trim() || suggestion;
}

async function promptChannel(): Promise<ChannelKind> {
  const value = await p.select({
    message: '选择消息渠道',
    options: [
      {
        value: 'lark',
        label: '飞书（Lark）',
        hint: 'v1 仅支持飞书 profile 创建',
      },
    ],
  });
  if (isCancelled(value)) bail();
  return value as ChannelKind;
}

async function onboardLark(profileName: string): Promise<ProfileConfig['channel']> {
  p.note(
    [
      `Profile：${pc.bold(profileName)}`,
      `如果你要同时启动多个 profile，请为每个 profile 配置 ${pc.bold('独立的飞书应用 / Bot')}。`,
      '',
      `1. 打开 ${pc.cyan('https://open.feishu.cn/app')}`,
      `2. 创建"企业自建应用"`,
      `3. 「添加应用能力」→ 选择 ${pc.bold('机器人')}`,
      `4. 「权限管理」→ 搜索并开通：`,
      `   ${pc.green('✓')} ${pc.bold('im:message')}（收发单聊/群聊消息）`,
    ].join('\n'),
    '飞书应用配置',
  );

  const appId = await p.text({
    message: 'App ID',
    placeholder: 'cli_xxxxxxxxxxxxxxxx',
    validate: (value) => (String(value ?? '').trim() ? undefined : '不能为空'),
  });
  if (isCancelled(appId)) bail();

  const appSecret = await p.password({
    message: 'App Secret',
    validate: (value) => (String(value ?? '').trim() ? undefined : '不能为空'),
  });
  if (isCancelled(appSecret)) bail();

  const spinner = p.spinner();
  spinner.start('验证飞书凭证...');
  const probe = await probeLark(String(appId).trim(), String(appSecret).trim());
  if (probe.ok) {
    spinner.stop(
      `${pc.green('✓')} 凭证验证通过${probe.name ? `，Bot 名称：${pc.bold(probe.name)}` : ''}`,
    );
  } else {
    spinner.stop(`${pc.yellow('⚠')} 凭证验证失败：${probe.error}`);
    const cont = await p.confirm({
      message: '仍然继续保存这个飞书 profile 吗？',
      initialValue: false,
    });
    if (isCancelled(cont) || !cont) bail();
  }

  const allowPolicy = await p.select({
    message: '谁可以给这个 Bot 发消息？',
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
      message: '用户 open_id（多个用逗号或空格分隔）',
      placeholder: 'ou_xxxxx, ou_yyyyy',
      validate: (value) => (String(value ?? '').trim() ? undefined : '至少填一个'),
    });
    if (isCancelled(raw)) bail();
    allowedUserIds = parseListInput(String(raw));
  }

  return {
    type: 'lark',
    appId: String(appId).trim(),
    appSecret: String(appSecret).trim(),
    allowedUserIds,
  };
}

async function promptRuntime(provider: ProviderKind): Promise<ProfileConfig['runtime']> {
  p.note(
    provider === 'claude'
      ? 'Claude profile 会继续复用流式输出、/sessions、/resume 和飞书权限审批。'
      : 'Codex profile 当前不支持飞书远程审批，默认会改成自动执行模式（workspace-write + never）。'
    ,
    '运行时选项',
  );

  const cwd = await p.text({
    message: '默认工作目录（回车使用 ~）',
    placeholder: '~/projects',
  });
  if (isCancelled(cwd)) bail();

  const timeout = await p.text({
    message: '单次请求超时（毫秒，0 表示不超时）',
    placeholder: '300000',
    validate: (value) => {
      const raw = String(value ?? '').trim();
      if (!raw) return undefined;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? undefined : '请输入大于等于 0 的整数';
    },
  });
  if (isCancelled(timeout)) bail();

  const permissionTimeout = await p.text({
    message: '工具审批超时（毫秒，0 表示一直等待）',
    placeholder: '30000',
    validate: (value) => {
      const raw = String(value ?? '').trim();
      if (!raw) return undefined;
      const parsed = Number.parseInt(raw, 10);
      return Number.isFinite(parsed) && parsed >= 0 ? undefined : '请输入大于等于 0 的整数';
    },
  });
  if (isCancelled(permissionTimeout)) bail();

  const model = await p.text({
    message: provider === 'claude' ? '默认 Claude 模型（可留空）' : '默认 Codex 模型（可留空）',
    placeholder: provider === 'claude' ? 'claude-sonnet-4-6' : '使用 Codex 默认模型',
  });
  if (isCancelled(model)) bail();

  const extraArgs = await p.text({
    message: '额外 CLI 参数（可留空，按空格分隔）',
    placeholder: '--append-system-prompt "Be concise"',
  });
  if (isCancelled(extraArgs)) bail();

  const timeoutMs = Number.parseInt(String(timeout ?? '').trim(), 10);
  const permissionTimeoutMs = Number.parseInt(String(permissionTimeout ?? '').trim(), 10);
  return {
    cwd: String(cwd ?? '').trim() || undefined,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : 300000,
    permissionTimeoutMs: Number.isFinite(permissionTimeoutMs) && permissionTimeoutMs >= 0
      ? permissionTimeoutMs
      : 30000,
    model: String(model ?? '').trim() || undefined,
    extraArgs: parseExtraArgs(String(extraArgs ?? '').trim()),
  };
}

async function promptCodexConfig(): Promise<{ sandboxMode: SandboxMode; approvalPolicy: ApprovalPolicy }> {
  const mode = await p.select({
    message: 'Codex 运行模式',
    options: [
      {
        value: 'workspace-write',
        label: '自动执行（推荐）',
        hint: '工作区内自动执行，不再审批',
      },
      {
        value: 'read-only',
        label: '只读',
        hint: '仅允许读取，不适合远程执行修改',
      },
      {
        value: 'danger-full-access',
        label: '全权限',
        hint: '不再审批，也不做沙箱限制',
      },
    ],
  });
  if (isCancelled(mode)) bail();

  return {
    sandboxMode: mode as SandboxMode,
    approvalPolicy: 'never',
  };
}

export async function runOnboarding(): Promise<string> {
  p.intro(pc.bgCyan(pc.black(' imcc setup ')));

  console.log(
    `\n  ${pc.bold('imcc')} 会把你的本机 Claude Code 或 Codex 桥接到飞书。\n`,
  );

  const provider = await promptProvider();
  const profileName = await promptProfileName(provider);
  const channel = await promptChannel();

  if (channel !== 'lark') {
    throw new Error(`Unsupported channel: ${channel}`);
  }

  const larkChannel = await onboardLark(profileName);
  const runtime = await promptRuntime(provider);
  const codex = provider === 'codex' ? await promptCodexConfig() : undefined;

  const profile: ProfileConfig = {
    name: profileName,
    provider,
    channel: larkChannel,
    runtime,
    codex,
  };

  saveProfile(profile);

  p.outro(
    [
      `Profile ${pc.bold(profileName)} 已保存到 ${pc.cyan('~/.imcc/config.json')}`,
      `启动命令：${pc.cyan(`imcc start --profile ${profileName}`)}`,
    ].join('\n'),
  );

  return profileName;
}
