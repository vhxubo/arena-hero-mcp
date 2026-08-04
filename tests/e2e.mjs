#!/usr/bin/env node
// 本地端到端测试: 起 MCP, 验证 bridge 按需启动, 再模拟浏览器 ws 客户端,
// 收 refresh 指令时回推假快照, 再发 MCP initialize/tools-list/tools-call 验证全链路.
// 用法: node tests/e2e.mjs
import net from 'node:net'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version
const srv = spawn('node', ['mcp.mjs'], { cwd: root, env: { ...process.env, BRIDGE_IDLE_MS: '1000' }, stdio: ['pipe', 'pipe', 'inherit'] })

let mcpBuf = '', mcpResp = []
srv.stdout.on('data', d => {
  mcpBuf += d.toString()
  let nl
  while ((nl = mcpBuf.indexOf('\n')) >= 0) {
    const l = mcpBuf.slice(0, nl); mcpBuf = mcpBuf.slice(nl + 1)
    if (l.trim()) { try { mcpResp.push(JSON.parse(l)) } catch { console.log('非JSON:', l.slice(0, 60)) } }
  }
})
const send = m => srv.stdin.write(JSON.stringify(m) + '\n')
async function waitFor(id, timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const response = mcpResp.find((item) => item.id === id)
    if (response) return response
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`等待 MCP 响应 ${id} 超时`)
}

function wsConnect() {
  const opts = { port: Number(process.env.PORT) || 7790, host: '127.0.0.1' }
  const sock = net.connect(opts, () => {
    sock.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
  })
  let buf = Buffer.alloc(0), up = false
  sock.on('data', d => {
    buf = Buffer.concat([buf, d])
    if (!up) {
      const e = buf.indexOf('\r\n\r\n'); if (e < 0) return
      const h = buf.slice(0, e).toString()
      if (!h.includes('101')) { console.log('握手失败:', h); process.exit(1) }
      console.log('✓ WS握手 OK'); up = true; buf = buf.slice(e + 4); return
    }
    if (buf.length < 2) return
    let len = buf[1] & 0x7f, mask = (buf[1] & 0x80) !== 0; let p = 2, mk = Buffer.alloc(0)
    if (len === 126) { len = buf.readUInt16BE(p); p += 2 }
    if (mask) { mk = buf.slice(2, 6); p = 6 }
    const pl = buf.slice(p, p + len); const txt = mask ? Buffer.from(pl.map((b, i) => b ^ mk[i % 4])) : pl
    const command = JSON.parse(txt.toString())
    console.log('✓ 收到浏览器指令:', command.cmd, command.tool || '')
    const result = {
      get_movement_goals: { worker: [4, 0] },
      get_command_context: { tick: 8, agent: null, manual: null, effective: { plan: { tick: 8, unit_actions: {} }, unitSources: {} } },
      get_web_game_context: { tick: 8, phase: 'open', selected_object_id: null },
      preview_route: { path: [[0, 0], [1, 0]], next_direction: 'RIGHT' },
    }[command.tool]
    const message = command.cmd === 'refresh'
      ? { type: 'snapshot', v: version, namespace: 'test', cells: [
          { kind: 'EMPTY', position: [0, 0] }, { kind: 'RESOURCE', position: [1, 2] }, { kind: 'OBSTACLE', position: [3, 4] },
        ] }
      : { type: 'tool_response', requestId: command.requestId, result }
    const data = Buffer.from(JSON.stringify(message))
    const m = Buffer.from([0, 0, 0, 0])
    const header = data.length < 126
      ? Buffer.from([0x81, 0x80 | data.length])
      : Buffer.from([0x81, 0xfe, data.length >> 8, data.length & 0xff])
    sock.write(Buffer.concat([header, m, Buffer.from(data.map((b, i) => b ^ m[i % 4]))]))
    buf = Buffer.alloc(0)
  })
  sock.on('error', e => { console.log('sock err', e.message) })
  return sock
}

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
await new Promise(r => setTimeout(r, 300))
send({ jsonrpc: '2.0', method: 'notifications/initialized' })
await new Promise(r => setTimeout(r, 200))
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
await new Promise(r => setTimeout(r, 300))
send({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'snapshot_info', arguments: {} } })
send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_userscript', arguments: {} } })
await new Promise(r => setTimeout(r, 300))
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_resources', arguments: {} } })
await new Promise(r => setTimeout(r, 500))
const sock = wsConnect()
await new Promise(r => setTimeout(r, 500))
send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_exploration_map', arguments: { kind: 'EMPTY', minX: 0, maxX: 0 } } })
send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_movement_goals', arguments: {} } })
await new Promise(r => setTimeout(r, 200))
send({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_command_context', arguments: {} } })
await new Promise(r => setTimeout(r, 200))
send({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'get_web_game_context', arguments: {} } })
await new Promise(r => setTimeout(r, 200))
send({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'preview_route', arguments: { objectId: 'worker', destination: [1, 0] } } })
await Promise.all([3, 5, 6, 7, 8, 9].map((id) => waitFor(id, 10_000)))
await new Promise(r => setTimeout(r, 1200))
send({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'snapshot_info', arguments: {} } })
await waitFor(11)

const tl = mcpResp.find(r => r.id === 2)
const lr = mcpResp.find(r => r.id === 3)
console.log('✓ tools/list 工具数:', tl?.result?.tools?.length)
const initial = mcpResp.find(r => r.id === 10)?.result?.content?.[0]?.text || ''
if (!initial.includes('"bridgeRunning": false')) { console.log('✗ bridge 未保持按需关闭:', initial); process.exit(1) }
console.log('✓ 非浏览器工具不启动 bridge')
const txt = lr?.result?.content?.[0]?.text || ''
const ok = txt.includes('RESOURCE') && txt.includes('"position"')
const us = mcpResp.find(r => r.id === 4)?.result?.content?.[0]?.text || ''
const okUs = us.includes('Tampermonkey') && us.includes('getNamespace')
console.log(okUs ? '✓ get_userscript 返回油猴脚本' : '✗ get_userscript 失败')
if (!okUs) { console.log(us.slice(0,200)); process.exit(1) }
console.log(ok ? '✓ list_resources 返回资源坐标' : '✗ list_resources 失败:\n' + txt)
if (!ok) { console.log(txt); process.exit(1) }
const map = mcpResp.find(r => r.id === 5)?.result?.content?.[0]?.text || ''
const okMap = map.includes('EMPTY') && !map.includes('RESOURCE')
console.log(okMap ? '✓ get_exploration_map 返回筛选后的可通行格' : '✗ get_exploration_map 失败')
if (!okMap) { console.log(map); process.exit(1) }
for (const [id, expected] of [[6, 'worker'], [7, 'effective'], [8, 'open'], [9, 'RIGHT']]) {
  const value = mcpResp.find(r => r.id === id)?.result?.content?.[0]?.text || ''
  if (!value.includes(expected)) { console.log(`✗ 浏览器工具 ${id} 失败:`, value); process.exit(1) }
}
console.log('✓ 四个 Web 上下文工具返回结果')
const idle = mcpResp.find(r => r.id === 11)?.result?.content?.[0]?.text || ''
if (!idle.includes('"bridgeRunning": false')) { console.log('✗ 空闲 bridge 未退出:', idle); process.exit(1) }
console.log('✓ 空闲 bridge 自动退出')

console.log('\n全部通过 ✓')
srv.kill(); sock.destroy(); process.exit(0)
