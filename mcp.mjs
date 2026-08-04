#!/usr/bin/env node
// MCP stdio 入口: 浏览器工具首次调用时才拉起 bridge.mjs.
import crypto from 'node:crypto'
import { fork } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = existsSync(join(here, 'tampermonkey.user.js')) ? here : join(here, '..')
const PKG_VERSION = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')).version

if (process.argv[2] === 'install') {
  const isGlobal = process.argv.includes('--global')
  const target = process.argv.find((arg, index) => index >= 3 && arg !== '--global') || 'claude'
  const home = process.env.HOME || process.env.USERPROFILE || '', cwd = process.cwd(), cmd = 'npx', args = ['-y', 'arena-hero-mcp']
  const paths = {
    claude: { project: join(cwd, '.mcp.json'), global: join(home, '.claude.json') },
    'claude-desktop': { project: null, global: join(home, '.config', 'Claude', 'claude_desktop_config.json') },
    cursor: { project: join(cwd, '.cursor', 'mcp.json'), global: join(home, '.cursor', 'mcp.json') },
    windsurf: { project: join(cwd, '.codeium', 'windsurf', 'mcp_config.json'), global: join(home, '.codeium', 'windsurf', 'mcp_config.json') },
    cline: { project: join(cwd, '.cline', 'mcp_settings.json'), global: join(home, '.cline', 'mcp_settings.json') },
    continue: { project: join(cwd, '.continue', 'config.json'), global: join(home, '.continue', 'config.json') },
    codex: { project: null, global: join(home, '.codex', 'config.toml') },
  }
  if (!paths[target]) { console.error(`未知 agent: ${target}\n支持: ${Object.keys(paths).join(', ')}`); process.exit(1) }
  const path = isGlobal ? paths[target].global : paths[target].project
  if (!path) { console.error(`${target} 无项目级配置, 请加 --global`); process.exit(1) }
  if (target === 'codex') {
    const section = `[mcp_servers.arena-hero-mcp]\ncommand = "${cmd}"\nargs = ${JSON.stringify(args)}\n`
    let toml = existsSync(path) ? readFileSync(path, 'utf8') : ''
    toml = toml.replace(/\n?\[mcp_servers\.arena-hero-mcp\][\s\S]*?(?=\n\[|\n*$)/, '').trimEnd()
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, (toml ? toml + '\n\n' : '') + section)
  } else {
    let config = {}
    if (existsSync(path)) { try { config = JSON.parse(readFileSync(path, 'utf8')) } catch {} }
    config.mcpServers ||= {}; config.mcpServers['arena-hero-mcp'] = { command: cmd, args }
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(config, null, 2))
  }
  console.log(`✓ 已写入 ${target} ${isGlobal ? '全局' : '项目级'} MCP 配置: ${path}`)
  process.exit(0)
}

let bridge = null, bridgeReady = null
const pending = new Map()
let bridgeInfo = { bridgeRunning: false, browserConnected: false, scriptVersion: null, count: 0, namespace: null, updatedAt: null, kinds: {} }

function stderr(message) { process.stderr.write(`[arena-hero-mcp] ${message}\n`) }
function stopBridge(error = new Error('浏览器桥已退出')) {
  bridge = null; bridgeReady = null; bridgeInfo.bridgeRunning = false; bridgeInfo.browserConnected = false
  for (const { reject } of pending.values()) reject(error)
  pending.clear()
}
function ensureBridge() {
  if (bridge?.connected && bridgeReady) return bridgeReady
  bridge = fork(join(pkgRoot, 'bridge.mjs'), [], { env: process.env, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  bridgeInfo.bridgeRunning = true
  bridgeReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('浏览器桥启动超时')), 5000)
    bridge.on('message', (message) => {
      if (message.type === 'ready') { clearTimeout(timer); resolve() }
      if (message.type === 'fatal') { clearTimeout(timer); reject(new Error(message.error)) }
      if (message.type === 'browser') bridgeInfo.browserConnected = message.connected
      if (message.type === 'response' && pending.has(message.id)) {
        const request = pending.get(message.id); pending.delete(message.id)
        message.error ? request.reject(new Error(message.error)) : request.resolve(message.result)
      }
    })
    bridge.once('error', reject)
  })
  bridge.once('exit', (code) => stopBridge(new Error(`浏览器桥已退出${code ? ` (${code})` : ''}`)))
  return bridgeReady
}
async function bridgeRequest(op, options = {}) {
  await ensureBridge()
  const id = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('浏览器桥请求超时')) }, 20_000)
    pending.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(result) },
      reject: (error) => { clearTimeout(timer); reject(error) },
    })
    bridge.send({ type: 'request', id, op, ...options })
  })
}

const STALE_NOTE = '⚠️ RESOURCE 为探索记忆, 会过时(可能已被采集/补充/移位), 不可当"当前可采"; 当前可采以 WS state.objects 为准.'
const server = new McpServer({ name: 'arena-hero-mcp', version: PKG_VERSION })
function tally(cells) { const kinds = {}; for (const cell of cells) kinds[cell.kind] = (kinds[cell.kind] ?? 0) + 1; return kinds }
function wrap(value, note) { return { content: [{ type: 'text', text: note ? `${note}\n\n${JSON.stringify(value, null, 2)}` : JSON.stringify(value, null, 2) }] } }
async function freshCells() {
  try {
    const snapshot = await bridgeRequest('fetchFresh')
    bridgeInfo = { ...bridgeInfo, scriptVersion: snapshot.scriptV, count: snapshot.cells.length, namespace: snapshot.namespace, updatedAt: new Date(snapshot.updatedAt).toISOString(), kinds: tally(snapshot.cells) }
    if (snapshot.scriptV && snapshot.scriptV !== PKG_VERSION) return { error: `油猴脚本版本(${snapshot.scriptV})与 MCP server(${PKG_VERSION})不匹配. 请重新安装/更新油猴脚本.` }
    if (!snapshot.cells.length) return { error: '浏览器已连接但 IndexedDB 无探索数据. 请先进入 arena 探索地图.' }
    return { cells: snapshot.cells }
  } catch (error) { return { error: error.message } }
}
async function browserTool(tool, args) { return bridgeRequest('browserTool', { tool, args }) }

server.registerTool('get_exploration_map', {
  description: '返回已探索地图格, 包含 EMPTY、OBSTACLE 和可能过时的 RESOURCE. 可按 kind 和坐标闭区间筛选.',
  inputSchema: { kind: z.enum(['EMPTY', 'OBSTACLE', 'RESOURCE']).optional(), minX: z.number().int().optional(), maxX: z.number().int().optional(), minY: z.number().int().optional(), maxY: z.number().int().optional() },
}, async ({ kind, minX, maxX, minY, maxY }) => {
  if ((minX !== undefined && maxX !== undefined && minX > maxX) || (minY !== undefined && maxY !== undefined && minY > maxY)) return { content: [{ type: 'text', text: '❌ 坐标范围无效: min 不能大于 max' }], isError: true }
  const fresh = await freshCells()
  if (fresh.error) return { content: [{ type: 'text', text: `❌ ${fresh.error}` }] }
  const cells = fresh.cells.filter((cell) => {
    const [x, y] = cell.position ?? []
    return (!kind || cell.kind === kind) && (minX === undefined || x >= minX) && (maxX === undefined || x <= maxX) && (minY === undefined || y >= minY) && (maxY === undefined || y <= maxY)
  })
  return wrap(cells, cells.some((cell) => cell.kind === 'RESOURCE') ? STALE_NOTE : undefined)
})

for (const [name, description] of [
  ['get_movement_goals', '返回 Web localStorage 中跨 Tick 移动目标.'],
  ['get_command_context', '返回当前 Tick 的 Agent、Manual 与合并后有效指令.'],
  ['get_web_game_context', '返回浏览器旁听到的 Tick、连接阶段、指令窗口剩余时间和移动目标.'],
]) server.registerTool(name, { description, inputSchema: {} }, async () => {
  try { return wrap(await browserTool(name)) } catch (error) { return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true } }
})
server.registerTool('preview_route', { description: '使用浏览器当前游戏状态和探索记忆预览对象到目标格的路线.', inputSchema: { objectId: z.string().min(1), destination: z.tuple([z.number().int(), z.number().int()]) } }, async (args) => {
  try { return wrap(await browserTool('preview_route', args)) } catch (error) { return { content: [{ type: 'text', text: `❌ ${error.message}` }], isError: true } }
})
for (const [name, description, filter, note] of [
  ['list_resources', '列出 RESOURCE 探索记忆格.', (cell) => cell.kind === 'RESOURCE', STALE_NOTE],
  ['list_obstacles', '列出所有 OBSTACLE 记忆格.', (cell) => cell.kind === 'OBSTACLE'],
  ['get_all_cells', '列出所有非 EMPTY 记忆格.', (cell) => cell.kind !== 'EMPTY', STALE_NOTE],
]) server.registerTool(name, { description, inputSchema: {} }, async () => {
  const fresh = await freshCells(); return fresh.error ? { content: [{ type: 'text', text: `❌ ${fresh.error}` }] } : wrap(fresh.cells.filter(filter), note)
})
server.registerTool('snapshot_info', { description: '返回版本、最近快照统计和按需浏览器桥状态.', inputSchema: {} }, async () => wrap({
  serverVersion: PKG_VERSION, ...bridgeInfo, versionMatch: bridgeInfo.scriptVersion ? bridgeInfo.scriptVersion === PKG_VERSION : null,
}))
server.registerTool('refresh', { description: '强制让浏览器重读 IndexedDB 并回推最新快照.', inputSchema: {} }, async () => {
  const fresh = await freshCells(); return fresh.error ? { content: [{ type: 'text', text: `❌ ${fresh.error}` }] } : { content: [{ type: 'text', text: `已刷新: ${fresh.cells.length} cells\nkind 分布: ${JSON.stringify(tally(fresh.cells))}` }] }
})
server.registerTool('get_userscript', { description: '返回 Tampermonkey 油猴脚本全文, 不启动浏览器桥.', inputSchema: {} }, async () => {
  try { return { content: [{ type: 'text', text: '将以下全文粘进 Tampermonkey 新建脚本并保存即可.\n\n' + readFileSync(join(pkgRoot, 'tampermonkey.user.js'), 'utf8') }] } }
  catch (error) { return { content: [{ type: 'text', text: `❌ 读取油猴脚本失败: ${error.message}` }] } }
})

await server.connect(new StdioServerTransport())
stderr('mcp ready (bridge on demand)')
