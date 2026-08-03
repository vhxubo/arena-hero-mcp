# arena-hero MCP

让 AI(Claude Code 等 MCP 客户端)查询 arena-hero 游戏页浏览器 IndexedDB 里的探索记忆格(资源/障碍坐标)。MCP 层用官方 `@modelcontextprotocol/sdk`,WS 层手写(RFC6455 子集)。

## 这是什么 / 为什么需要

游戏页把"你这局探索过的格子"记在浏览器 IndexedDB(`arena-hero-exploration-<用户名>` 数据库,`cells` 对象库)。AI 想知道"地图上有哪些资源"时,这份数据**只在浏览器里**,Node 拿不到。本桥用一条 WebSocket 把浏览器和本地 MCP server 连起来,AI 每次调工具时,server 让浏览器读一次 DB、把结果回传给 AI。

- **数据范围**:你这局探索过的格子。没去过的区域没有,任何方案都拿不到。
- **RESOURCE 是过时记忆**:节点可能已被采集/补充/移位,不可当"当前可采";当前可采以游戏 WS 的 `state.objects` 为准。OBSTACLE 是永久地形,记忆可信。

## 架构

```
游戏页(Tampermonkey 脚本)  ──ws://127.0.0.1:7790──►  MCP server (arena-hero-mcp)
  收 {cmd:'refresh'} → 读 IndexedDB cells → 回推 snapshot            内存存最新快照
  自动重连, 晚于 server 启动也能连上                                      │ stdio MCP
                                                                          ▼
                                                                     AI Client
                                              list_resources / list_obstacles / get_all_cells
                                              snapshot_info / refresh
```

**按需触发**:AI 调工具时 server 才通过 WS 让浏览器读一次 DB,不定时、不手动推送。

**生命周期**:server 由 MCP 客户端(Claude Code)启动时拉起,**开启期间一直常驻**(不是每次调用才启),客户端退出才停。油猴是独立浏览器进程,晚于 server 启动,靠自动重连(每 3 秒)连上。AI 在油猴连上之前调工具会收到"浏览器未连接"提示,连上后下次调用即可。

## 安装(给别人用)

### 方式 A:用 npx(推荐,不装包)

把以下 `.mcp.json` 放进你的项目根或用户级 MCP 配置:

```json
{
  "mcpServers": {
    "arena-hero-cells": {
      "command": "npx",
      "args": ["-y", "arena-hero-mcp"]
    }
  }
}
```

首次调用时 npx 自动拉取,无需 `npm install`。

### 方式 B:全局装

```bash
npm install -g arena-hero-mcp
```

`.mcp.json` 用:
```json
{ "mcpServers": { "arena-hero-cells": { "command": "arena-hero-mcp" } } }
```

> 默认 **ws 无证书**(零配置,仅浏览器放行不安全内容)。要 wss 自签:`.mcp.json` 加 `"env": { "USE_WSS": "1" }`,并在包目录放 `cert.pem`/`key.pem`(或设 `CERT`/`KEY` 环境变量指向你的证书路径)。

## 一次性配置(浏览器侧)

### 1. 装 Tampermonkey 脚本

1. 装 Tampermonkey(或 Violentmonkey)扩展
2. 仪表盘 → 新建脚本
3. 把 [`tampermonkey.user.js`](./tampermonkey.user.js) 全文粘进去
4. 改顶部:
   ```js
   const NAMESPACE = 'demo'      // ← 你的 arena-hero 用户名;匿名用 'anonymous'
   const USE_WSS = false         // ← ws 无证书用 false(默认);wss 自签用 true
   ```
5. 保存(Ctrl+S)

### 2. 浏览器放行不安全内容(ws 模式必做)

浏览器禁止 https 页面连 `ws://`。打开 `https://app.arenahero.io` → 地址栏左侧锁/感叹号 → 站点设置 → "不安全内容" → 允许。

> wss 模式:改为访问 `https://127.0.0.1:7790` 走过自签告警。

## 日常使用

每次想让 AI 查资源:

1. 开浏览器,登录 arena-hero,进 `https://app.arenahero.io/arena`(让 IndexedDB 有数据)
2. 右上角按钮变绿 `📡 已连 MCP 桥` → 连上
3. 在 Claude Code 里让 AI 查,比如:
   - "用 list_resources 列出我探索过的资源点"
   - "snapshot_info 看连上没、有多少格"

> 不用手动点油猴按钮触发推送——AI 调工具本身就是触发。按钮只看状态/重连用。

## MCP 工具

| 工具 | 入参 | 返回 |
|---|---|---|
| `list_resources` | 无 | 所有 `kind=RESOURCE` 格(`{x,y}`),前缀带 stale 提示 |
| `list_obstacles` | 无 | 所有 `kind=OBSTACLE` 格(永久地形,可信) |
| `get_all_cells` | 无 | 所有非 EMPTY 格(RESOURCE+OBSTACLE) |
| `snapshot_info` | 无 | `count` / `namespace` / `updatedAt` / `kinds` 分布 / `browserConnected` |
| `refresh` | 无 | 强制让浏览器重读一次 DB;返回数量与 kind 分布 |

> `list_*`/`get_all_cells` 每次自动 refresh,返回即调用那一刻最新。`refresh` 仅怀疑过旧时单独调。

## 验证(装完第一次)

1. Claude Code 开着 → server 常驻(stderr 不直接可见,但 `snapshot_info` 能查状态)
2. 浏览器进 arena 页,按钮变绿 → WS 连上
3. AI 调 `snapshot_info`:`browserConnected: true` 且 `count > 0` → 通
4. AI 调 `list_resources` 拿到坐标 → 全就绪

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 油猴保存报"用户脚本无效" | 元数据解析失败。`@match` 不带端口通配;`@include` 才支持端口。检查脚本头 |
| 按钮 `📡 连接中...` 不变绿 | server 没起(MCP 客户端没拉起)或浏览器没放行不安全内容 |
| 按钮 `📡 桥已断开` | WS 断了。点按钮手动重连;仍断看浏览器 Console `[cells-bridge]` 报错 |
| `snapshot_info` 返回 `browserConnected: false` | 油猴没连。回浏览器看按钮颜色 |
| `list_resources` 返回"已连接但无非EMPTY数据" | `NAMESPACE` 不对。改油猴顶部为你的用户名,刷新游戏页 |
| `list_resources` 返回"等待回包超时" | 油猴连上但没回包。开浏览器 Console 看 `[cells-bridge] 读取失败` |
| `list_resources` 返回"浏览器未连接" | arena 页关了或油猴没连。重开页面 |
| wss 模式连不上 | `cert.pem`/`key.pem` 不在或路径错;设 `USE_WSS=1` 时证书需就位 |

---

# 开发者文档

以下面向维护者:本地起、测试、改代码、发布到 npm。

## 前置

- Node.js ≥ 18
- 已 `npm install`(装 `@modelcontextprotocol/sdk` + `zod`)
- 想测 wss 还需 `cert.pem`/`key.pem`(见末尾"证书")

## 本地起 server

```bash
cd ~/dev/arena-hero-mcp
node server.mjs            # 默认 ws 无证书
USE_WSS=1 node server.mjs  # wss 自签(需 cert.pem/key.pem)
PORT=7788 node server.mjs  # 换端口
```

直接 `node server.mjs` 起来后会**等 stdin**(stdio MCP server 依赖客户端喂 JSON-RPC),stdin EOF 即退出——这是正常的。要它持续运行,要么接 MCP 客户端,要么用下面的测试脚本喂它。

## 测试

### 1. 端到端测试(推荐,日常跑这个)

`tests/e2e.mjs` 起本项目 server + 模拟浏览器 WS 客户端握手、收 refresh 回假快照、发 MCP 调用验全链路:

```bash
node tests/e2e.mjs              # 默认 ws
USE_WSS=1 node tests/e2e.mjs    # 测 wss
```

期望输出:
```
✓ WS握手 OK (ws)
✓ 收到 refresh 指令: {"cmd":"refresh"}
✓ tools/list 工具数: 5
✓ list_resources 返回资源坐标
全部通过 ✓
```
任何 `✗` 即失败,脚本 `process.exit(1)`。

### 2. stdio MCP 手测(只验协议层,无浏览器)

```bash
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
| node server.mjs 2>/dev/null
```

应输出两行 JSON:`serverInfo` + 5 个工具。调 `list_resources` 应返回"浏览器未连接"(无浏览器时正确行为):
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_resources","arguments":{}}}' \
| node server.mjs 2>/dev/null
```

### 3. 真实环境测(Claude Code + 真浏览器)

最终形态验证。本地测建议 `.mcp.json` 临时用 node(npx 发布前才用):
```json
{ "mcpServers": { "arena-hero-cells": { "command": "node", "args": ["server.mjs"] } } }
```
1. 在 `~/dev/arena-hero-mcp` 开 Claude Code → 加载 `.mcp.json` 拉起 server
2. 浏览器装油猴脚本(改 `NAMESPACE`)、放行不安全内容、进 arena 页按钮变绿
3. Claude Code 里让 AI 调 `snapshot_info` → `browserConnected:true` + `count>0` 即通

## 改代码

- `server.mjs`:MCP 工具在 `registerTool(...)` 调用段,加/改工具直接照现有 5 个的写法。WS 协议层(RFC6455 子集)在 `handleWsUpgrade`/`parseFrames`/`sendFrame`,一般不用动。
- `tampermonkey.user.js`:浏览器侧。改了要让用户重装(油猴更新机制)。
- 改完跑 `node tests/e2e.mjs` 回归。

## 发布到 npm

1. 检查 `package.json`:`name`/`version`/`description`/`license`/`author`/`repository`/`homepage`(影响 npm 页面)。当前 `version: 0.3.0`。
2. `npm pack --dry-run` 看打包内容——应只有 `README.md`/`package.json`/`server.mjs`/`tampermonkey.user.js`(`.npmignore` 排除了 `*.pem`/`node_modules`/`package-lock.json`/`.mcp.json`)。
3. `npm login`(首次)→ `npm publish`。
4. 发布后,用户的 `.mcp.json` 用 `npx -y arena-hero-mcp` 即自动拉取。
5. 发新版:改 `version`(`npm version patch|minor|major`)→ `npm publish`。

> **证书不入包**:`.npmignore` 排除 `*.pem`。wss 是可选项,用户按需自行生成证书(见末尾)。默认 ws 模式零证书。

## 证书(wss 模式才需要)

```bash
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"
```
放包根目录,或用 `CERT`/`KEY` 环境变量指路径。**不要把你生成的证书随包共享**——每人自签一份。

## 项目结构

```
arena-hero-mcp/
├── server.mjs            # MCP server(官方 SDK)+ 手写 WS
├── tampermonkey.user.js  # 浏览器油猴 WS 客户端
├── tests/e2e.mjs         # 端到端测试(模拟浏览器)
├── package.json          # bin + 依赖
├── .npmignore            # 发布排除证书/依赖/lock/.mcp.json
├── .mcp.json             # 本项目自用 MCP 注册(npx 版)
├── cert.pem / key.pem    # wss 证书(不入包, .npmignore 排除)
└── README.md             # 本文档
```

## 环境变量(开发者向)

| 变量 | 默认 | 说明 |
|---|---|---|
| `USE_WSS` | 未设(ws) | `=1` 用 wss 自签;不设用 ws 无证书 |
| `PORT` | `7790` | WS 监听端口(改了油猴 `WSS_URL` 也要同步改) |
| `CERT` / `KEY` | 包内 `cert.pem`/`key.pem` | wss 模式证书路径 |

## 注意与边界

- **数据天花板**:只含你这局探索过的格子。没去过的地方没有。
- **RESOURCE 会过时**:记忆点可能已被采/补充/移位,不可当当前可采;当前可采以游戏 WS `state.objects` 为准。
- **DB 名固定**:`arena-hero-exploration-<namespace>`,`cells` 对象库。
- **关 arena 页 = 断连**:AI 调工具返回"浏览器未连接"。重开页面即恢复。
- **证书勿共享**:wss 模式的 `cert.pem`/`key.pem` 是你的私钥,每人应自行生成(`openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"`)。给别人用默认 ws 模式即可,无需证书。
