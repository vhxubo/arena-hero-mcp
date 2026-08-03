#!/usr/bin/env node
// 本地端到端测试: 起本项目的 server, 模拟一个浏览器 ws 客户端连入,
// 收 refresh 指令时回推假快照, 再发 MCP initialize/tools-list/tools-call 验证全链路.
// 用法: node tests/e2e.mjs   (默认 ws; 想测 wss 加环境变量 USE_WSS=1)
import net from 'node:net'
import tls from 'node:tls'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const useWss = process.env.USE_WSS === '1'
const srv = spawn('node', ['server.mjs'], { cwd: root, env: { ...process.env }, stdio: ['pipe', 'pipe', 'inherit'] })

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

function wsConnect() {
  const opts = { port: Number(process.env.PORT) || 7790, host: '127.0.0.1', rejectUnauthorized: false }
  const connect = useWss ? tls.connect : net.connect
  const sock = connect(opts, () => {
    sock.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n')
  })
  let buf = Buffer.alloc(0), up = false
  sock.on('data', d => {
    buf = Buffer.concat([buf, d])
    if (!up) {
      const e = buf.indexOf('\r\n\r\n'); if (e < 0) return
      const h = buf.slice(0, e).toString()
      if (!h.includes('101')) { console.log('握手失败:', h); process.exit(1) }
      console.log(`✓ WS握手 OK (${useWss ? 'wss' : 'ws'})`); up = true; buf = buf.slice(e + 4); return
    }
    if (buf.length < 2) return
    const len = buf[1] & 0x7f, mask = (buf[1] & 0x80) !== 0; let p = 2, mk = Buffer.alloc(0)
    if (mask) { mk = buf.slice(2, 6); p = 6 }
    const pl = buf.slice(p, p + len); const txt = mask ? Buffer.from(pl.map((b, i) => b ^ mk[i % 4])) : pl
    console.log('✓ 收到 refresh 指令:', txt.toString())
    const data = Buffer.from(JSON.stringify({ type: 'snapshot', namespace: 'test', cells: [
      { kind: 'RESOURCE', position: [1, 2] }, { kind: 'OBSTACLE', position: [3, 4] },
    ] }))
    const m = Buffer.from([0, 0, 0, 0])
    sock.write(Buffer.concat([Buffer.from([0x81, 0x80 | data.length]), m, Buffer.from(data.map((b, i) => b ^ m[i % 4]))]))
    buf = Buffer.alloc(0)
  })
  sock.on('error', e => { console.log('sock err', e.message) })
  return sock
}

await new Promise(r => setTimeout(r, 1000))
const sock = wsConnect()

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
await new Promise(r => setTimeout(r, 300))
send({ jsonrpc: '2.0', method: 'notifications/initialized' })
await new Promise(r => setTimeout(r, 200))
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
await new Promise(r => setTimeout(r, 300))
send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_resources', arguments: {} } })
await new Promise(r => setTimeout(r, 2000))

const tl = mcpResp.find(r => r.id === 2)
const lr = mcpResp.find(r => r.id === 3)
console.log('✓ tools/list 工具数:', tl?.result?.tools?.length)
const txt = lr?.result?.content?.[0]?.text || ''
const ok = txt.includes('RESOURCE') && txt.includes('"position"')
console.log(ok ? '✓ list_resources 返回资源坐标' : '✗ list_resources 失败:\n' + txt)
if (!ok) { console.log(txt); process.exit(1) }

console.log('\n全部通过 ✓')
srv.kill(); sock.destroy(); process.exit(0)
