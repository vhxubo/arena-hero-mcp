# arena-hero MCP

[![npm version](https://img.shields.io/npm/v/arena-hero-mcp.svg)](https://www.npmjs.com/package/arena-hero-mcp)
[![license](https://img.shields.io/npm/l/arena-hero-mcp.svg)](https://github.com/vhxubo/arena-hero-mcp/blob/main/LICENSE)

让 AI 读取 Arena Hero 浏览器中的探索地图、移动目标、指令上下文，并预览路线。无需修改 Web 代码；浏览器数据由 Tampermonkey 脚本转发给本地 MCP server。

## 安装

```bash
npx -y arena-hero-mcp install <agent>          # 当前项目
npx -y arena-hero-mcp install <agent> --global # 全局
```

支持 `claude`、`claude-desktop`、`cursor`、`windsurf`、`cline`、`continue` 和 `codex`。`claude-desktop`、`codex` 仅支持 `--global`。安装后重启 agent。

手动配置：

```json
{
  "mcpServers": {
    "arena-hero-mcp": {
      "command": "npx",
      "args": ["-y", "arena-hero-mcp"]
    }
  }
}
```

## 浏览器配置

1. 安装 Tampermonkey 或 Violentmonkey。
2. 调用 MCP 工具 `get_userscript`，将返回的脚本全文粘贴为新用户脚本并保存。
3. 在 `https://app.arenahero.io` 的站点设置中允许“不安全内容”，使 HTTPS 页面可以连接本机 `ws://127.0.0.1:7790`。
4. 登录并打开 `https://app.arenahero.io/arena`。右上角显示 `📡 已连 MCP 桥` 即可使用。

脚本自动识别当前用户名，无需修改配置。

## 工具

| 工具 | 用途 |
|---|---|
| `get_exploration_map` | 查询已探索的 `EMPTY`、`RESOURCE`、`OBSTACLE`，支持 kind 和坐标范围筛选 |
| `get_movement_goals` | 查询 Web 保存的跨 Tick 移动目标 |
| `get_command_context` | 查询当前 Agent、Manual 和合并后的有效指令 |
| `get_web_game_context` | 查询 Tick、连接阶段、指令窗口剩余时间和移动目标 |
| `preview_route` | 按 Web 规则预览对象到目标坐标的路线 |
| `list_resources` | 查询探索记忆中的资源坐标 |
| `list_obstacles` | 查询已知永久障碍坐标 |
| `get_all_cells` | 查询所有非空探索记忆格 |
| `snapshot_info` | 查询版本、namespace、格子统计和浏览器连接状态 |
| `refresh` | 强制浏览器重读 IndexedDB |
| `get_userscript` | 获取当前版本的用户脚本 |

首次安装可调用 `snapshot_info` 验证：

```json
{
  "browserConnected": true,
  "versionMatch": true
}
```

## 边界

- 未探索区域没有数据。
- `RESOURCE` 是探索记忆，可能已被采集、补充或移位；实时资源以游戏状态为准。
- `preview_route` 在油猴脚本中复刻 Web 的视野、地形、占位和移动规则。
- `selected_object_id` 无稳定浏览器资源来源，因此固定返回 `null`。
- 关闭 Arena 页面后浏览器桥会断开。

## 排错

- `browserConnected: false`：确认 MCP server 已启动、Arena 页面已打开，并允许了不安全内容。
- “无探索数据”：先进入 Arena 探索地图。
- 脚本版本不匹配：重新调用 `get_userscript` 并覆盖旧用户脚本。
- `EADDRINUSE`：端口 7790 已被另一实例占用。
- Codex 日志出现 `listen EPERM`：当前沙箱禁止监听本机端口，需要在允许本地监听的环境中运行 MCP server。

## 开发

需要 Node.js 18+。

```bash
npm install
PORT=17790 npm test
```

`PORT` 默认是 `7790`；修改后需要同步修改用户脚本中的 `WS_URL`。
