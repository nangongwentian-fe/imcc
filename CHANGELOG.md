# Changelog

## [0.2.0] - 2026-03-15

### Added
- 飞书内命令系统：`/help`、`/clear`、`/model`、`/cwd`
- `/model` 切换模型时自动开启新 session，确保模型立即生效
- 飞书 markdown 正确渲染：改用 `msg_type: post` + `md` tag，支持加粗、代码块、列表、标题等

### Fixed
- 调用 claude 时默认加 `--dangerously-skip-permissions`，避免交互式授权提示导致无响应

---

## [0.1.0] - 2026-03-14

### Added
- 飞书 WebSocket 长连接（无需公网 IP 或 tunnel）
- `imcc start` 启动桥接，`imcc setup` 交互式配置向导
- Typing 表情回应（处理中提示）
- `claude --print --continue` 自动续接上次对话
- 白名单用户控制（`allowedUserIds`）
- 开机自启说明（macOS launchd）
