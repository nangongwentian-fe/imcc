# imcc-permission-mcp

`imcc-permission-mcp` 是给 `imcc` 配套使用的权限审批 MCP server。

它通过 stdio 向 Claude Code 暴露 `imcc_permission_prompt` tool，并通过本地 socket 把审批请求回传给 `imcc` 主进程，由主进程负责把审批卡片发送到飞书/Lark 等 IM 渠道。

## 用法

```bash
npx imcc-permission-mcp --socket /tmp/imcc-permission.sock --jid lark:oc_xxx
```

参数说明：

- `--socket`: `imcc` broker 暴露的本地 socket 路径
- `--jid`: 当前 IM 会话标识

这个包本身不直接连接飞书；它需要和 `imcc` 主进程配合工作。

## 发布后给 Claude Code 配置

发布到 npm 后，可以用标准 `npx` 方式启动：

```json
{
  "mcpServers": {
    "imcc_permission": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "-y",
        "imcc-permission-mcp",
        "--socket",
        "/path/to/imcc.sock",
        "--jid",
        "lark:oc_xxx"
      ]
    }
  }
}
```

在当前仓库开发态，`imcc` 会优先直接调用本地构建产物；当本地产物不存在时，再退回到 `npx imcc-permission-mcp`。
