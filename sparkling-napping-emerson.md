# imcc 优化实施计划

## Context

imcc 当前通过 `claude --print --continue` 同步等待完整响应后一次性回复飞书消息，存在两个核心问题：
1. **体验差**：用户发消息后需等待 30s~5min 才能看到回复，无任何中间反馈（仅有 Typing emoji）
2. **安全性差**：使用 `--dangerously-skip-permissions` 跳过所有权限检查

本计划分阶段实施流式输出、权限审批、会话管理三大功能。

---

## Phase 0：bridge 层流式化改造

**目标**：将 `bridge.ts` 从"等进程结束 → 返回字符串"改为"逐行解析 stream-json → 事件回调"

### 改动文件

#### `src/bridge.ts`（重写核心）

当前 `runClaude()` 收集全部 stdout 后返回 `{ status, output }`。改为：

```
spawn claude -p --output-format stream-json --verbose --include-partial-messages --continue <prompt>
```

新增 `StreamCallbacks` 接口：
```typescript
interface StreamCallbacks {
  onInit?: (sessionId: string) => void;
  onText?: (delta: string, fullText: string) => void;       // 增量 + 已拼接全文
  onToolUse?: (toolName: string, toolInput: unknown) => void;
  onToolResult?: (toolName: string, isError: boolean) => void;
  onComplete?: (result: { text: string; durationMs: number; cost: number }) => void;
  onError?: (error: string) => void;
}
```

新增 `runClaudeStream(prompt, opts, callbacks)` 函数：
- spawn 进程，逐行读取 stdout（按 `\n` 分割）
- 解析每行 JSON 的 `type` 字段：
  - `system/init` → 提取 `session_id`，调用 `onInit`
  - `stream_event` → 解析 `event.type`：
    - `content_block_delta` + `text_delta` → 拼接文本，调用 `onText(delta, fullText)`
    - `content_block_start` + `tool_use` → 调用 `onToolUse`
  - `user` + `tool_result` → 调用 `onToolResult`
  - `result/success` → 调用 `onComplete`
  - `result/error_*` → 调用 `onError`
- 保留现有 `runClaude()` 作为兼容封装（内部调用 `runClaudeStream` + 只用 `onComplete`）

#### `src/router.ts`（适配流式）

当前流程：`runClaude() → sendMessage()`

改为：
```
runClaudeStream(text, opts, {
  onInit: () => channel.onStreamStart?.(jid),
  onText: (delta, full) => channel.onStreamText?.(jid, full),
  onComplete: (result) => channel.onStreamEnd?.(jid, 'completed', result.text),
  onError: (err) => channel.onStreamEnd?.(jid, 'error', err),
})
```

对于不支持流式的 channel（如 Telegram），`onStreamEnd` 时一次性发送完整消息即可。

#### `src/types.ts`（扩展 Channel 接口）

新增可选方法：
```typescript
onStreamStart?(jid: string): Promise<void>;
onStreamText?(jid: string, fullText: string): void;
onStreamEnd?(jid: string, status: 'completed' | 'error', text: string): Promise<void>;
```

### 验证方式
- `npm run dev` 启动后在飞书发送消息
- 观察终端日志确认 stream_event 被正确解析
- 此阶段飞书端行为不变（仍等 onComplete 后一次性回复），但 bridge 层已切换到流式

---

## Phase 1：飞书流式卡片输出

**目标**：用户发消息后立即看到实时输出流

### 改动文件

#### `src/channels/lark.ts`（核心改动）

新增流式卡片状态管理：
```typescript
interface CardState {
  cardId: string;
  messageId: string;
  sequence: number;
  startTime: number;
  throttleTimer: ReturnType<typeof setTimeout> | null;
  lastUpdateAt: number;
}
private activeCards = new Map<string, CardState>();
```

新增方法：

**`onStreamStart(jid)`**：
1. `client.cardkit.v1.card.create` 创建卡片（`streaming_mode: true`, `element_id: 'content'`）
2. `client.im.message.reply` 回复用户消息（`msg_type: 'interactive'`, `content: { type: 'card', data: { card_id } }`）
3. 存入 `activeCards`

初始卡片 JSON：
```json
{
  "schema": "2.0",
  "config": {
    "streaming_mode": true, "wide_screen_mode": true,
    "streaming_config": { "print_frequency_ms": { "default": 70 }, "print_step": { "default": 1 }, "print_strategy": "fast" }
  },
  "body": { "elements": [{ "tag": "markdown", "content": "Thinking...", "element_id": "content" }] }
}
```

**`onStreamText(jid, fullText)`**：
- 200ms 节流（trailing edge）
- `client.cardkit.v1.cardElement.content({ path: { card_id, element_id: 'content' }, data: { content: optimizeMarkdownStyle(fullText), sequence: ++seq } })`
- 注意：传入全量文本（非增量），飞书会对追加部分做打字机效果

**`onStreamEnd(jid, status, text)`**：
1. `client.cardkit.v1.card.settings` → 关闭 `streaming_mode`
2. `client.cardkit.v1.card.update` → 最终卡片（含 footer：状态 + 耗时）
3. 清理 `activeCards`
4. 移除 Typing emoji reaction

**降级**：如果 `cardkit.v1.card.create` 失败（权限不足等），fallback 到当前的 post 方式一次性发送。

### 需要新增的飞书权限
- `cardkit:card:write`（创建与更新卡片）

### 验证方式
- 飞书发消息后应立即看到"Thinking..."卡片
- 随后卡片内容实时更新（打字机效果）
- 完成后卡片底部显示状态和耗时

---

## Phase 2：飞书交互卡片权限审批

**目标**：去掉 `--dangerously-skip-permissions`，在飞书中审批 Claude 的工具调用

### 技术方案选择

CLI `-p` 模式不支持交互式权限审批。三个可选方案：

| 方案 | 复杂度 | 说明 |
|---|---|---|
| A. `--permission-prompt-tool` + 本地 MCP server | 中 | 启动 stdio MCP server，claude 请求权限时调用该 tool，tool 内部发卡片等回调 |
| B. `--allowedTools` 静态白名单 | 低 | 用户在配置中指定允许的工具列表，不在列表中的自动拒绝 |
| C. Claude Code SDK (`@anthropic-ai/claude-code-sdk`) | 高 | 引入 SDK，用 `canUseTool` 回调 |

**推荐方案 A**：复杂度适中，能实现完整的交互式审批，且不引入重量级 SDK。

### 改动文件

#### 新增 `src/permission-mcp.ts`

实现一个 stdio MCP server（遵循 MCP 协议），暴露一个 tool：
- tool name: `imcc_permission_prompt`
- 输入：`{ toolName, toolInput }`
- 行为：
  1. 发送飞书交互卡片（Allow / Allow Session / Deny 按钮）
  2. 等待用户点击回调（Promise + 超时）
  3. 返回用户选择结果

#### `src/bridge.ts`

`runClaudeStream` 的 spawn 参数中：
- 去掉 `--dangerously-skip-permissions`
- 添加 `--permission-prompt-tool imcc_permission_prompt`
- 添加 `--mcp-config` 指向本地 MCP server 配置

#### `src/channels/lark.ts`

**monkey-patch WSClient**（在 `connect()` 中）：
```typescript
const orig = this.wsClient.handleEventData.bind(this.wsClient);
this.wsClient.handleEventData = (data: any) => {
  const msgType = data.headers?.find((h: any) => h.key === 'type')?.value;
  if (msgType === 'card') {
    data = { ...data, headers: data.headers.map((h: any) =>
      h.key === 'type' ? { ...h, value: 'event' } : h) };
  }
  return orig(data);
};
```

注册 `card.action.trigger` 事件处理器，解析 `action.value.callback_data`，resolve 对应的 permission Promise。

**`sendPermissionCard(jid, toolName, toolInput, permId)`**：
- 发送 schema 2.0 交互卡片，包含：
  - 工具名 + 输入参数摘要（截断到 300 字符）
  - 三个按钮：Allow (primary) / Allow Session (default) / Deny (danger)
  - 按钮 `value` 中携带 `callback_data: "perm:<action>:<permId>"` 和 `chatId`
- 降级：卡片失败 → `/perm` 文本命令

### 验证方式
- 不带 `--dangerously-skip-permissions` 启动
- 飞书发送需要工具调用的消息（如"读取 xxx 文件"）
- 应收到权限审批卡片，点击 Allow 后 Claude 继续执行

---

## Phase 3：会话列表与恢复

**目标**：在飞书中查看和切换本地 Claude Code 会话

### 改动文件

#### 新增 `src/sessions.ts`

```typescript
interface SessionInfo {
  id: string;
  projectPath: string;     // 从目录名还原
  firstMessage: string;    // 首条 user message 摘要
  timestamp: Date;         // 文件修改时间
  cwd: string;
}

function listSessions(opts?: { cwd?: string; limit?: number }): SessionInfo[]
```

实现：
- 扫描 `~/.claude/projects/*/` 下的 `*.jsonl` 文件
- 如指定 cwd，只扫描对应 project-path-hash 目录
- 读取每个 `.jsonl` 文件的前几行，找到首条 `type: "user"` 消息提取摘要
- 按文件修改时间降序排列
- 返回前 N 条（默认 10）

#### `src/commands.ts`

新增命令：
- **`/sessions [n]`**：列出最近 n 个会话（默认 5），格式如：
  ```
  最近会话：
  1. [abc123] 3h ago — ~/projects/imcc
     "飞书官方给open claw专门做的..."
  2. [def456] 1d ago — ~/projects/other
     "帮我写一个..."
  ```
- **`/resume <id前缀>`**：设置 `state.resumeSessionId`，下次消息使用 `--resume <id>` 代替 `--continue`

#### `src/bridge.ts`

`BridgeOptions` 新增 `resumeSessionId?: string`。当设置时，使用 `--resume <id>` 代替 `--continue`。

### 验证方式
- 飞书发送 `/sessions` 查看会话列表
- 发送 `/resume <id前缀>` 切换会话
- 后续消息应在对应会话上下文中继续

---

## 实施顺序与依赖

```
Phase 0 (bridge 流式化)        ← 1-2h，后续所有 phase 的前置
  │
  ├── Phase 1 (流式卡片)       ← 2-3h，体验提升最大
  │
  ├── Phase 2 (权限审批)       ← 3-4h，需要研究 --permission-prompt-tool 的 MCP 协议细节
  │
  └── Phase 3 (会话管理)       ← 1-2h，独立于 1/2，可随时做
```

建议按 0 → 1 → 3 → 2 的顺序实施（Phase 3 简单独立，可以在 Phase 2 的 MCP 方案研究期间先完成）。

---

## 验证清单

- [ ] Phase 0: `npm run dev` 启动，终端能看到 stream_event 日志
- [ ] Phase 1: 飞书发消息后立即看到流式卡片，内容实时更新
- [ ] Phase 1: 卡片完成后显示状态 footer
- [ ] Phase 1: CardKit API 失败时正确降级到 post 消息
- [ ] Phase 2: 飞书收到权限审批卡片，点击按钮后 Claude 继续/停止
- [ ] Phase 2: 按钮超时后自动 deny
- [ ] Phase 3: `/sessions` 正确列出本地会话
- [ ] Phase 3: `/resume <id>` 切换后消息在正确会话中继续
- [ ] 全流程: `npm run build` 编译无错误
