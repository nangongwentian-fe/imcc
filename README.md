# imcc

将本机 Claude Code CLI 桥接到 IM 软件，让你在手机上随时通过飞书、Telegram 等与本机 Claude 对话。

> Bridge your local Claude Code CLI to IM apps (Lark, Telegram, etc.)

[![npm version](https://img.shields.io/npm/v/imcc)](https://www.npmjs.com/package/imcc)
[![npm downloads](https://img.shields.io/npm/dm/imcc)](https://www.npmjs.com/package/imcc)
[![GitHub stars](https://img.shields.io/github/stars/nangongwentian-fe/imcc)](https://github.com/nangongwentian-fe/imcc)
[![GitHub issues](https://img.shields.io/github/issues/nangongwentian-fe/imcc)](https://github.com/nangongwentian-fe/imcc/issues)
[![license](https://img.shields.io/github/license/nangongwentian-fe/imcc)](LICENSE)
[![Node.js](https://img.shields.io/node/v/imcc)](package.json)

## 特点

- **零容器**：直接调用本机 `claude` CLI，继承你的 CLAUDE.md、memory、MCP、skills 等所有配置
- **极简**：核心代码不到 500 行，无数据库，无后台服务
- **长连接**：基于飞书 WebSocket 长连接，无需公网 IP 或 tunnel
- **会话连续**：使用 `claude --continue` 自动续接上次对话，无需手动管理 session
- **单用户**：面向个人使用，安全、简单

## 支持平台

| 平台 | 状态 |
|---|---|
| 飞书（Lark） | ✅ 可用 |
| Telegram | 🚧 开发中 |

## 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) >= 18
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) 已安装并可用

```bash
npm install -g @anthropic-ai/claude-code
```

### 安装

```bash
npm install -g imcc
```

### 配置

```bash
imcc setup
```

引导流程：
1. 在[飞书开放平台](https://open.feishu.cn/)创建企业自建应用
2. 添加机器人能力，开通 `im:message` 权限
3. 填入 App ID 和 App Secret
4. 选择消息权限（所有人 / 白名单用户）

### 启动

```bash
imcc start
```

首次启动后，按照终端提示完成飞书控制台的剩余配置：
- 订阅 `im.message.receive_v1` 事件，并开通所需权限
- 开启「使用长连接接收事件」订阅方式
- 发布应用版本

### 使用

直接在飞书中向 Bot 发消息，即可与本机 Claude Code 对话。

**内置命令：**

| 命令 | 说明 |
|---|---|
| `/help` | 显示帮助信息 |
| `/clear` | 清除当前 session，开启新对话 |
| `/model <name>` | 切换模型（如 `claude-opus-4-6`） |
| `/cwd <path>` | 切换 Claude 工作目录 |

## 配置文件

配置保存在 `~/.imcc/config.json`：

```json
{
  "claude": {
    "cwd": "~/projects",
    "timeoutMs": 300000
  },
  "channels": {
    "lark": {
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "allowedUserIds": []
    }
  }
}
```

| 字段 | 说明 | 默认值 |
|---|---|---|
| `claude.cwd` | Claude 运行的工作目录 | `~` |
| `claude.timeoutMs` | 单次响应超时时间（毫秒） | `300000`（5 分钟）|
| `channels.lark.allowedUserIds` | 白名单用户 open_id，空数组表示允许所有人 | `[]` |

## 工作原理

```
飞书消息
  → WebSocket 长连接（飞书 SDK）
  → 消息路由（鉴权 + 白名单）
  → spawn: claude --print --continue "消息内容"
  → 捕获 stdout
  → 回复飞书消息
```

每条消息 fork 一次 `claude` 进程，`--continue` 自动续接最近的 session。Session 状态由 Claude Code 自身管理（`~/.claude/`），imcc 不存储任何对话数据。

## 开机自启（macOS）

创建 `~/Library/LaunchAgents/dev.imcc.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.imcc</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>imcc start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/imcc.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/imcc.error.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/dev.imcc.plist
```

查看日志：

```bash
tail -f /tmp/imcc.log
```

## 与同类项目对比

| 项目 | 定位 |
|---|---|
| OpenClaw | 多功能 AI Agent 平台，500k 行代码，70+ 依赖 |
| NanoClaw | OpenClaw 轻量替代，容器隔离，多 IM，多用户 |
| **imcc** | 个人用，无容器，直连本机 Claude Code，极简桥接层 |

## 路线图

- [x] 飞书（Lark）WebSocket 长连接
- [x] Typing 表情回应（处理中提示）
- [x] 交互式 onboarding 引导
- [x] 飞书内命令系统（/help /clear /model /cwd）
- [ ] Telegram 支持
- [ ] `imcc status` 查看运行状态
- [ ] 开机自启配置向导（`imcc install`）
- [ ] 消息队列（避免并发请求丢失）
- [ ] 多工作目录切换（按对话切换 cwd）

## 贡献

欢迎提交 Issue 和 Pull Request。

开发环境：

```bash
git clone https://github.com/nangongwentian-fe/imcc.git
cd imcc
npm install
npm run dev
```

## License

[MIT](LICENSE) © [nangongwentian-fe](https://github.com/nangongwentian-fe)
