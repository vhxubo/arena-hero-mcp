#!/usr/bin/env node
// arena-hero MCP 桥: 浏览器油猴 ws 连入, AI 调 MCP 工具时 Node 通过该连接
// 发 {cmd:'refresh'}, 油猴读 IndexedDB 回推快照, Node 返给 AI.
// MCP 层用官方 @modelcontextprotocol/sdk; WS 层手写(零额外依赖, RFC6455 子集).
import net from 'node:net'
import crypto from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const here = dirname(fileURLToPath(import.meta.url))
// 本地开发时 server.mjs 在包根; npx/全局装时在 node_modules/<pkg>/dist? 不——仍是 server.mjs 同级. 油猴脚本在其旁.
const pkgRoot = existsSync(join(here, 'tampermonkey.user.js')) ? here : join(here, '..')

// --- install 子命令: 写入各 agent 的 MCP 配置, 跑完即退, 不启动 MCP server ---
// 用法: arena-hero-mcp install [agent] [--global]
//   默认项目级(写当前目录配置); --global 写用户级配置.
//   支持: claude | cursor | windsurf | cline | continue | claude-desktop | codex
//   注: claude-desktop/codex 只有全局配置, --global 才有效.
if (process.argv[2] === 'install') {
  const isGlobal = process.argv.includes('--global')
  const targetIdx = process.argv.findIndex((a, i) => i >= 3 && a !== '--global')
  const target = process.argv[targetIdx] || 'claude'
  const home = process.env.HOME || process.env.USERPROFILE || ''
  const cwd = process.cwd()
  const cmd = 'npx'
  const args = ['-y', 'arena-hero-mcp']
  // ponytail: 各 agent 两级配置路径. 项目级跟随 agent 自身约定(claude/.mcp.json, 其它在 <agent子目录>/文件).
  const paths = {
    'claude': { project: join(cwd, '.mcp.json'), global: join(home, '.claude.json') },
    'claude-desktop': { project: null, global: join(home, '.config', 'Claude', 'claude_desktop_config.json') },
    'cursor': { project: join(cwd, '.cursor', 'mcp.json'), global: join(home, '.cursor', 'mcp.json') },
    'windsurf': { project: join(cwd, '.codeium', 'windsurf', 'mcp_config.json'), global: join(home, '.codeium', 'windsurf', 'mcp_config.json') },
    'cline': { project: join(cwd, '.cline', 'mcp_settings.json'), global: join(home, '.cline', 'mcp_settings.json') },
    'continue': { project: join(cwd, '.continue', 'config.json'), global: join(home, '.continue', 'config.json') },
    'codex': { project: null, global: join(home, '.codex', 'config.toml') },
  }
  if (!paths[target]) { console.error(`未知 agent: ${target}\n支持: ${Object.keys(paths).join(', ')}`); process.exit(1) }
  const path = isGlobal ? paths[target].global : paths[target].project
  if (!path) { console.error(`${target} 无项目级配置(只读用户级), 请加 --global: arena-hero-mcp install ${target} --global`); process.exit(1) }
  // codex 用 TOML, 其余 JSON. ponytail: TOML 段写死, 不引 toml 库——单 server 配置几行足够.
  if (target === 'codex') {
    const section = `[mcp_servers.arena-hero-mcp]\ncommand = "${cmd}"\nargs = ${JSON.stringify(args)}\n`
    let toml = existsSync(path) ? readFileSync(path, 'utf8') : ''
    // 已存在同段则替换, 否则追加. 简化: 删旧段再加新段.
    toml = toml.replace(/\n?\[mcp_servers\.arena-hero-mcp\][\s\S]*?(?=\n\[|\n*$)/, '').trimEnd()
    toml = (toml ? toml + '\n\n' : '') + section
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, toml)
    console.log(`✓ 已写入 codex 全局 MCP 配置:\n  ${path}\n  [mcp_servers.arena-hero-mcp]\n  command = "${cmd}"\n  args = ${JSON.stringify(args)}\n重启 codex 生效。`)
    process.exit(0)
  }
  let cfg = {}
  if (existsSync(path)) { try { cfg = JSON.parse(readFileSync(path, 'utf8')) } catch { cfg = {} } }
  cfg.mcpServers = cfg.mcpServers || {}
  cfg.mcpServers['arena-hero-mcp'] = { command: cmd, args }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cfg, null, 2))
  console.log(`✓ 已写入 ${target} ${isGlobal ? '全局' : '项目级'} MCP 配置:\n  ${path}\n  arena-hero-mcp: ${cmd} ${args.join(' ')}\n重启 ${target} 生效。`)
  process.exit(0)
}

const WS_PORT = Number(process.env.PORT) || 7790
const REFRESH_TIMEOUT_MS = 5000

// --- 内存状态 ---
let snapshot = { cells: [], updatedAt: 0, namespace: null }
let wsClient = null
let pendingResolve = null

// --- WS server: ws (无加密). 浏览器需对游戏页放行"不安全内容"才能从 https 页连本 ws:// ---
net.createServer((s) => { s.setNoDelay(true); handleWsUpgrade(s) })
  .listen(WS_PORT, '127.0.0.1', () => stderr(`ws listening 127.0.0.1:${WS_PORT}`))

// --- WebSocket 协议 (RFC 6455 最小子集) ---
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function handleWsUpgrade(socket) {
  let buf = Buffer.alloc(0)
  let upgraded = false
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (!upgraded) {
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      const headers = buf.slice(0, end).toString()
      if (!/upgrade:\s*websocket/i.test(headers)) return socket.end()
      const keyMatch = headers.match(/sec-websocket-key:\s*(\S+)/i)
      if (!keyMatch) return socket.end()
      const accept = crypto.createHash('sha1').update(keyMatch[1] + WS_GUID).digest('base64')
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
      buf = buf.slice(end + 4)
      upgraded = true
      wsClient = socket
      stderr('browser ws connected')
      return
    }
    for (const msg of parseFrames(buf)) { buf = Buffer.alloc(0); handleMessage(msg) }
  })
  socket.on('close', () => { if (wsClient === socket) { wsClient = null; stderr('browser ws disconnected') } })
  socket.on('error', () => {})
}

function parseFrames(buf) {
  const msgs = []
  let i = 0
  while (i + 2 <= buf.length) {
    const b1 = buf[i], b2 = buf[i + 1]
    const opcode = b1 & 0x0f
    const masked = (b2 & 0x80) !== 0
    let len = b2 & 0x7f
    let p = i + 2
    if (len === 126) { len = buf.readUInt16BE(p); p += 2 }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(p)); p += 8 }
    let mask = Buffer.alloc(0)
    if (masked) { mask = buf.slice(p, p + 4); p += 4 }
    if (p + len > buf.length) break
    let payload = buf.slice(p, p + len)
    if (masked) payload = Buffer.from(payload.map((b, idx) => b ^ mask[idx % 4]))
    if (opcode === 0x8) { wsClient && wsClient.end(); return msgs }
    if (opcode === 0x9) { sendFrame(wsClient, 0xa, payload); i = p + len; continue }
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) msgs.push(payload.toString())
    i = p + len
  }
  if (i > 0) buf = buf.slice(i) // ponytail: 心跳级帧少, 不做流式重组.
  return msgs
}

function sendFrame(socket, opcode, payload) {
  if (!socket || socket.destroyed) return
  const data = Buffer.from(payload)
  const len = data.length
  let header
  if (len < 126) header = Buffer.from([0x80 | opcode, len])
  else if (len < 65536) { header = Buffer.alloc(4); header.writeUInt8(0x80 | opcode, 0); header.writeUInt8(126, 1); header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header.writeUInt8(0x80 | opcode, 0); header.writeUInt8(127, 1); header.writeBigUInt64BE(BigInt(len), 2) }
  socket.write(Buffer.concat([header, data])) // server->client 不掩码(RFC 允许)
}

function sendJson(socket, obj) { sendFrame(socket, 0x1, JSON.stringify(obj)) }

function handleMessage(text) {
  let msg
  try { msg = JSON.parse(text) } catch { return }
  if (msg.type === 'snapshot') {
    snapshot = { cells: Array.isArray(msg.cells) ? msg.cells : [], updatedAt: Date.now(), namespace: msg.namespace ?? null }
    stderr(`snapshot ${snapshot.cells.length} cells (ns=${snapshot.namespace})`)
    if (pendingResolve) { pendingResolve(snapshot); pendingResolve = null }
  }
}

async function fetchFresh() {
  if (!wsClient || wsClient.destroyed) throw new Error('浏览器未连接: 请在游戏页跑油猴脚本建立 ws 连接')
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingResolve = null; reject(new Error('等待浏览器回包超时, 确认游戏页油猴脚本在跑')) }, REFRESH_TIMEOUT_MS)
    pendingResolve = (snap) => { clearTimeout(timer); resolve(snap) }
    sendJson(wsClient, { cmd: 'refresh' })
  })
}

// --- MCP server (官方 SDK) ---
const STALE_NOTE = '⚠️ RESOURCE 为探索记忆, 会过时(可能已被采集/补充/移位), 不可当"当前可采"; 当前可采以 WS state.objects 为准.'
const server = new McpServer({ name: 'arena-hero-mcp', version: '0.3.1' })

function tally(cells) { const m = {}; for (const c of cells) m[c.kind] = (m[c.kind] ?? 0) + 1; return m }
function wrap(cells, note) { return { content: [{ type: 'text', text: note ? `${note}\n\n${JSON.stringify(cells, null, 2)}` : JSON.stringify(cells, null, 2) }] } }

async function freshCells() {
  let snap
  try { snap = await fetchFresh() }
  catch (e) { return { error: e.message }
  }
  const cells = snap.cells
  if (!cells.length) return { error: '浏览器已连接但 IndexedDB 无非EMPTY数据. 确认 NAMESPACE 与已探索过地图.' }
  return { cells }
}

server.registerTool('list_resources', {
  description: '列出 IndexedDB cells 中所有 kind=RESOURCE 的探索记忆格(你本局探索过的资源节点坐标). 每次调用通过 ws 让浏览器重读 IndexedDB 返回最新. ⚠️ 记忆会过时, 不可当当前可采.',
  inputSchema: {},
}, async () => {
  const f = await freshCells()
  if (f.error) return { content: [{ type: 'text', text: `❌ ${f.error}` }] }
  return wrap(f.cells.filter((c) => c.kind === 'RESOURCE'), STALE_NOTE)
})

server.registerTool('list_obstacles', {
  description: '列出所有 kind=OBSTACLE 记忆格(永久地形, 可信).',
  inputSchema: {},
}, async () => {
  const f = await freshCells()
  if (f.error) return { content: [{ type: 'text', text: `❌ ${f.error}` }] }
  return wrap(f.cells.filter((c) => c.kind === 'OBSTACLE'))
})

server.registerTool('get_all_cells', {
  description: '列出所有非 EMPTY 记忆格(RESOURCE + OBSTACLE).',
  inputSchema: {},
}, async () => {
  const f = await freshCells()
  if (f.error) return { content: [{ type: 'text', text: `❌ ${f.error}` }] }
  return wrap(f.cells.filter((c) => c.kind !== 'EMPTY'), STALE_NOTE)
})

server.registerTool('snapshot_info', {
  description: '返回最新快照元信息(数量/namespace/更新时间/kind 分布) + 浏览器连接状态.',
  inputSchema: {},
}, async () => {
  const connected = !!(wsClient && !wsClient.destroyed)
  const info = { count: snapshot.cells.length, namespace: snapshot.namespace, updatedAt: snapshot.updatedAt ? new Date(snapshot.updatedAt).toISOString() : null, kinds: tally(snapshot.cells), browserConnected: connected }
  return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] }
})

server.registerTool('refresh', {
  description: '强制让浏览器重读 IndexedDB 并回推最新快照.',
  inputSchema: {},
}, async () => {
  const f = await freshCells()
  if (f.error) return { content: [{ type: 'text', text: `❌ ${f.error}` }] }
  return { content: [{ type: 'text', text: `已刷新: ${f.cells.length} cells\nkind 分布: ${JSON.stringify(tally(f.cells))}` }] }
})

server.registerTool('get_userscript', {
  description: '返回 Tampermonkey 油猴脚本全文, 供用户粘贴进扩展安装. 顶部 NAMESPACE 需用户改成自己的 arena-hero 用户名. 不依赖浏览器连接, 随时可调.',
  inputSchema: {},
}, async () => {
  const file = join(pkgRoot, 'tampermonkey.user.js')
  try {
    const code = readFileSync(file, 'utf8')
    const note = '将以下全文粘进 Tampermonkey 新建脚本, 改顶部 NAMESPACE 为你的用户名, 保存即可. 原始文件见仓库 tampermonkey.user.js.\n\n'
    return { content: [{ type: 'text', text: note + code }] }
  } catch (e) {
    return { content: [{ type: 'text', text: `❌ 读取油猴脚本失败: ${e.message}\n请从 https://github.com/vhxubo/arena-hero-mcp 获取 tampermonkey.user.js` }] }
  }
})

// ponytail: stdio transport 由 MCP 客户端(Claude Code)驱动; 它接 stdin, server 即活着, ws 也同时听.
const transport = new StdioServerTransport()
await server.connect(transport)
stderr('mcp server ready (stdio)')

function stderr(s) { process.stderr.write(`[arena-hero-mcp] ${s}\n`) }
