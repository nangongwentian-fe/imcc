# CLAUDE.md — imcc 项目指引

## 项目概述

imcc 是一个极简的 IM 桥接工具，将本机 Claude Code CLI 桥接到飞书、Telegram 等 IM 软件，让用户通过手机随时与本机 Claude 对话。

- **定位**：个人用，零容器，直连本机 Claude Code
- **核心代码** < 500 行，无数据库，无后台服务
- **仓库**：https://github.com/nangongwentian-fe/imcc

## 技术栈

- **语言**：TypeScript（strict mode），ESM（`"type": "module"`）
- **编译**：`tsc`，target ES2022，module NodeNext
- **运行时**：Node.js >= 18
- **包管理**：npm
- **关键依赖**：
  - `@larksuiteoapi/node-sdk` — 飞书 SDK（WebSocket 长连接 + HTTP API）
  - `grammy` — Telegram Bot SDK
  - `commander` — CLI 框架
  - `@clack/prompts` + `picocolors` — 交互式引导 UI

## 目录结构

```
src/
├── cli.ts            # CLI 入口（commander 定义 start/setup 命令）
├── bridge.ts         # 核心：spawn claude 进程，捕获 stdout
├── router.ts         # 消息路由：鉴权 → 命令处理 → claude 调用 → 回复
├── commands.ts       # 飞书内命令系统（/help /clear /model /cwd）
├── config.ts         # 配置读写（~/.imcc/config.json）
├── onboarding.ts     # 交互式配置向导（imcc setup）
├── types.ts          # Channel 接口定义
└── channels/
    ├── index.ts      # 注册所有 channel（import 触发 registerChannel）
    ├── registry.ts   # Channel 工厂注册表
    ├── lark.ts       # 飞书 channel 实现
    └── telegram.ts   # Telegram channel 实现
```

## 架构要点

- **Channel 抽象**：所有 IM 平台实现 `Channel` 接口（connect / sendMessage / setTyping / disconnect），通过 `registerChannel` 工厂注册
- **消息流**：IM 消息 → WebSocket → router（鉴权 + 白名单）→ spawn `claude --print --continue` → 捕获 stdout → 回复 IM
- **会话管理**：依赖 Claude Code 自身的 session 机制（`--continue`），imcc 不存储对话数据
- **单并发**：每个 jid 同一时间只允许一个 claude 进程（`inFlight` Set），后续消息直接丢弃
- **jid 格式**：`lark:{chat_id}` / `tg:{chat_id}`，用于 channel 路由

## 常用命令

```bash
npm run dev          # 开发模式（tsx --watch）
npm run build        # 编译 TypeScript → dist/
npm start            # 等同 tsx src/cli.ts start
imcc setup           # 交互式配置
imcc start           # 启动桥接服务
```

## 开发约定

- 新增 IM 平台时，在 `src/channels/` 下创建新文件，实现 `Channel` 接口，并在 `index.ts` 中 import 触发注册
- 配置结构在 `src/config.ts` 的 `Config` 接口中定义
- 飞书消息渲染使用 `msg_type: post` + `md` tag（非纯 text），通过 `optimizeMarkdownStyle` 优化标题层级
- Typing 指示器使用飞书表情回应（Typing emoji reaction），属于 best-effort

## 当前状态

- 飞书（Lark）：✅ 可用（WebSocket 长连接）
- Telegram：🚧 基础框架已实现，开发中
- 当前为同步等待完整响应后再回复，尚未实现流式输出

## 参考实现

### 1. 飞书官方 OpenClaw 插件

- **NPM 包名**：`@larksuiteoapi/feishu-openclaw-plugin`
- **NPM 地址**：https://www.npmjs.com/package/@larksuiteoapi/feishu-openclaw-plugin
- **GitHub 社区指南**：https://github.com/AlexAnys/openclaw-feishu
- **飞书官方文档**：https://www.feishu.cn/content/article/7613711414611463386

该插件由飞书开放平台团队开发维护，是飞书官方为 OpenClaw 提供的流式输出插件。imcc 在飞书相关功能实现时应参考该插件的做法，重点关注：

- **流式卡片回复**：通过飞书交互式卡片实现实时流式输出，而非等待完整响应后一次性发送
- **消息交互增强**：识别合并转发消息、表情回应等
- **权限与授权模型**：以用户身份操作飞书文档、日历、任务、多维表格等的权限设计

### 2. Claude-to-IM

- **仓库**：https://github.com/op7418/Claude-to-IM
- **定位**：host-agnostic 桥接库，从桌面 GUI 客户端 CodePilot 提取的核心模块
- **技术栈**：TypeScript，Claude Code SDK（SSE 事件流），@larksuiteoapi/node-sdk
- **支持平台**：飞书、Telegram、Discord、QQ

该项目是一个功能完备的 IM 桥接库，与 imcc 定位相似但架构更重（DI 容器、数据库抽象、多用户）。imcc 应重点借鉴以下能力：

#### a. 飞书交互卡片权限审批（高优先级）

imcc 当前使用 `--dangerously-skip-permissions` 跳过所有权限检查。Claude-to-IM 实现了通过飞书交互卡片让用户在手机上审批 Claude 的工具调用（Allow / Allow Session / Deny），这是比跳过权限更安全、更实用的方案。

**关键实现**（参考 `permission-broker.ts` + `feishu-adapter.ts`）：
- 当 Claude 请求工具权限时，通过 `forwardPermissionRequest()` 发送飞书交互卡片，卡片包含工具名、输入参数摘要、三个操作按钮（Allow / Allow Session / Deny）
- 按钮点击触发飞书 `card.action.trigger` 事件，由 `handleCardAction()` 转为 `callbackData` 入队处理
- `handlePermissionCallback()` 解析回调，通过 Claude Code SDK 的 `resolvePendingPermission()` 完成审批
- 安全防护：校验 chatId/messageId 来源一致性、原子去重防止重复点击、30s 过期清理
- 降级策略：卡片按钮失败时 fallback 到文本命令 `/perm allow|deny <id>`，再失败则纯文本
- 注意：飞书 WSClient 默认只处理 `type="event"` 消息，`card.action.trigger` 是 `type="card"`，需要 monkey-patch `handleEventData` 将 card 类型转为 event 类型才能被 EventDispatcher 处理

#### b. 流式卡片输出（高优先级）

imcc 当前等待 claude 进程完全结束后才回复。Claude-to-IM 使用飞书 CardKit 流式卡片实现了实时流式输出。

**注意：Claude-to-IM 代码中的 API 路径有误**，它用了 `cardkit.v2.card.*`（通过 `as any` 绕过类型检查），实际 SDK 中只有 `cardkit.v1`。"v2" 指的是卡片 JSON schema 版本 `"2.0"`，不是 API 版本。正确的 SDK 调用路径：

| Claude-to-IM 中的写法 | 正确的 SDK 调用 |
|---|---|
| `cardkit.v2.card.create` | `client.cardkit.v1.card.create({ data: { type: 'card_json', data } })` |
| `cardkit.v2.card.streamContent` | `client.cardkit.v1.cardElement.content({ path: { card_id, element_id }, data: { content, sequence } })` |
| `cardkit.v2.card.settings.streamingMode.set` | `client.cardkit.v1.card.settings({ path: { card_id }, data: { settings: JSON.stringify({config:{streaming_mode:false}}), sequence } })` |
| `cardkit.v2.card.update` | `client.cardkit.v1.card.update({ path: { card_id }, data: { card: { type: 'card_json', data }, sequence } })` |

**正确的流式卡片流程**：
1. `cardkit.v1.card.create` 创建 `streaming_mode: true` 的卡片 → 获得 `card_id`
2. `im.message.create/reply` 发送卡片消息 → 获得 `message_id`
3. 循环调用 `cardkit.v1.cardElement.content` 更新 `element_id` 对应的文本（全量文本，非增量；若新文本是旧文本的追加，飞书自动以打字机效果渲染），200ms 节流，`sequence` 严格递增
4. `cardkit.v1.card.settings` 关闭 `streaming_mode`
5. `cardkit.v1.card.update` 写入最终卡片内容 + 状态 footer

**踩坑注意**：
- `element_id` 命名 1~20 字符，字母开头，仅字母数字下划线
- `sequence` 在同一 card_id 上的所有操作（settings/content/update）共用，必须严格递增
- 代码块前后不能有额外空格，否则渲染失败
- `streaming_config.print_step` 建议设为 1（设 2+ 可能导致文字重复/闪烁）
- 卡片实体有效期 14 天；卡片大小需控制在 30KB 以内
- 所需权限：`cardkit:card:write`

#### c. 消息渲染策略（中优先级）

- 包含代码块/表格的复杂内容 → schema 2.0 交互卡片（markdown element）
- 简单文本 → post 消息 + md tag（与 imcc 当前一致）
- 三级降级：card → post → plain text

#### d. 其他值得参考的功能

- **消息去重**：LRU Map（1000 条）防止重复处理同一 message_id
- **群聊 @mention 检测**：解析 bot 多种 ID（open_id / user_id / union_id）做 mention 匹配
- **图片/文件下载**：通过 `im.messageResource.get` 下载消息附件，支持 stream 和 writeFile 两种方式
- **Bot 身份解析**：启动时调用 `/bot/v3/info/` 获取 bot 的 open_id，用于群聊 @mention 判断
- **速率限制**：令牌桶算法，20 msg/min per chat

### 3. 会话列表与恢复（imcc 差异化方向）

现有同类项目（OpenClaw 飞书插件、Claude-to-IM）均未解决从 IM 端列出和恢复本地 Claude Code 会话的问题。imcc 当前也仅通过 `--continue` 续接最近一次 session。这是一个差异化的机会。

#### Claude Code 原生会话能力

- `claude --continue` — 续接最近 session
- `claude --resume <session_id>` — 恢复指定 session
- `claude --resume`（交互式）— 显示列表供选择，但需要 TTY，无法在非交互模式下使用
- **没有 `--list` 参数** — 社区已提 Feature Request（https://github.com/anthropics/claude-code/issues/34318 ）但尚未合并
- Session 文件存储在 `~/.claude/projects/<project-path-hash>/sessions/` 下

#### 实现思路

1. **直接读取 session 文件**：扫描 `~/.claude/projects/*/sessions/` 目录，解析 session 元信息（ID、最后修改时间、项目路径、摘要等）
2. **IM 命令**：新增 `/sessions` 命令，在飞书中展示最近的会话列表
3. **恢复指定会话**：用户选择后通过 `claude --resume <session_id>` 恢复，替代当前的 `--continue`
4. **可参考的社区工具**：
   - cc-sessions（Rust CLI，并行扫描所有项目目录）：https://github.com/chronologos/cc-sessions
   - claude-sesh（Node CLI + Web Dashboard，session 搜索/恢复）：https://github.com/abracadabra50/claude-sesh

## 技术研究结论（实现前必读）

### Claude Code CLI stream-json 协议

使用 `claude -p --output-format stream-json --verbose --include-partial-messages` 可获得逐 token 的流式输出。

**必需参数**：`--verbose`（否则 stream-json 报错）+ `--include-partial-messages`（否则只有完整消息快照，没有 token 级增量）

**事件类型（每行一个 JSON，NDJSON 格式）**：

| type | subtype | 说明 |
|---|---|---|
| `system` | `init` | 首条消息，含 `session_id`、model、tools 等 |
| `system` | `api_retry` | API 重试（含 attempt、error_status） |
| `stream_event` | — | 增量流式事件（仅 `--include-partial-messages` 时出现） |
| `assistant` | — | 助手完整消息快照（含完整 content 数组） |
| `user` | — | 工具执行结果（tool_result）或权限拒绝 |
| `result` | `success` / `error_*` | 最终结果（含 duration_ms、cost、usage、permission_denials） |

**stream_event 内部的 event.type**：
- `content_block_start` — 内容块开始（text / tool_use / thinking）
- `content_block_delta` — **增量内容**（`text_delta` / `input_json_delta` / `thinking_delta`），文本是增量的需自行拼接
- `content_block_stop` — 内容块结束
- `message_start` / `message_delta` / `message_stop` — 消息级事件

### 权限审批方案

**重要：CLI 的 `--input-format stream-json` 不支持交互式权限审批。** 在 `-p` 模式下，未被 `--allowedTools` 预批准的工具调用会被自动拒绝。

可行的权限审批方案：
1. **`--permission-prompt-tool <mcp_tool>`**：委托一个 MCP tool 处理权限请求。imcc 可以启动一个本地 MCP server，当 claude 请求权限时调用该 tool，tool 内部发送飞书卡片并等待用户回调
2. **`--allowedTools` 动态白名单**：启动时根据配置传入允许的工具列表，不在列表中的自动拒绝
3. **Claude Code SDK（`@anthropic-ai/claude-code-sdk`）**：提供 `canUseTool` 回调，可在回调中发卡片等用户响应后返回 allow/deny。但引入 SDK 会增加复杂度

### 飞书 WSClient card.action.trigger 处理

**@larksuiteoapi/node-sdk（v1.59.0）的 WSClient 不支持卡片回调。** `handleEventData`（源码第 85542 行）硬编码 `if (type !== 'event') return;`，导致 `type="card"` 的消息被静默丢弃。

**必须 monkey-patch**（当前 SDK 版本无替代方案）：
```typescript
const orig = wsClient.handleEventData.bind(wsClient);
wsClient.handleEventData = (data: any) => {
  const msgType = data.headers?.find((h: any) => h.key === 'type')?.value;
  if (msgType === 'card') {
    data = { ...data, headers: data.headers.map((h: any) =>
      h.key === 'type' ? { ...h, value: 'event' } : h
    )};
  }
  return orig(data);
};
```

EventDispatcher 注册时使用 `'card.action.trigger'` 作为事件名（需 `as any`）。SDK 的 `parse()` 会从 header.event_type 中提取此值做派发。

**card.action.trigger 回调数据结构**（经 SDK parse 展平后）：
- `action.value` — 按钮自定义数据（callback_data 在这里）
- `action.tag` — 组件类型（如 `"button"`）
- `context.open_chat_id` — 聊天 ID
- `context.open_message_id` — 卡片消息 ID
- `operator.open_id` — 操作者 ID

**回调返回值**（必须 3 秒内返回）：
```json
{ "toast": { "type": "info", "content": "已收到" } }
```

### Session 文件格式

存储路径：`~/.claude/projects/<project-path-hash>/<session-id>.jsonl`

每行一个 JSON。session 的首条 `type: "user"` 消息包含：
- `message.content` — 用户输入文本（可作为会话摘要）
- `timestamp` — ISO 时间戳
- `cwd` — 工作目录
- `sessionId` — session UUID
- `version` — Claude Code 版本
