#!/usr/bin/env node
// 按需浏览器桥: 只负责本地 WebSocket 与油猴脚本通信, 由 mcp.mjs 拉起.
import net from 'node:net'
import crypto from 'node:crypto'

const WS_PORT = Number(process.env.PORT) || 7790
const REQUEST_TIMEOUT_MS = 8000
const IDLE_TIMEOUT_MS = Number(process.env.BRIDGE_IDLE_MS) || 120_000
const managed = typeof process.send === 'function'
let wsClient = null
let pendingResolve = null
let refreshQueue = Promise.resolve()
let idleTimer = null
let activeRequests = 0
const pendingTools = new Map()
const browserWaiters = new Set()

function stderr(message) { process.stderr.write(`[arena-hero-bridge] ${message}\n`) }
function reply(message) { if (managed && process.connected) process.send(message) }
function touch() {
  if (!managed) return
  clearTimeout(idleTimer)
  if (activeRequests) return
  idleTimer = setTimeout(() => process.exit(0), IDLE_TIMEOUT_MS)
  idleTimer.unref()
}

const wsServer = net.createServer((socket) => { socket.setNoDelay(true); handleWsUpgrade(socket) })
wsServer.on('error', (error) => { reply({ type: 'fatal', error: error.message }); stderr(error.message); process.exit(1) })
wsServer.listen(WS_PORT, '127.0.0.1', () => {
  stderr(`ws listening 127.0.0.1:${WS_PORT}`)
  reply({ type: 'ready' })
  touch()
})

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function handleWsUpgrade(socket) {
  let buf = Buffer.alloc(0), upgraded = false
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (!upgraded) {
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      const headers = buf.slice(0, end).toString()
      if (!/upgrade:\s*websocket/i.test(headers)) return socket.end()
      const key = headers.match(/sec-websocket-key:\s*(\S+)/i)?.[1]
      if (!key) return socket.end()
      const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`)
      buf = buf.slice(end + 4); upgraded = true; wsClient = socket
      for (const waiter of browserWaiters) waiter(); browserWaiters.clear()
      reply({ type: 'browser', connected: true }); stderr('browser connected'); touch(); return
    }
    for (const message of parseFrames(buf)) handleMessage(message)
    buf = Buffer.alloc(0)
  })
  socket.on('close', () => {
    if (wsClient !== socket) return
    wsClient = null; reply({ type: 'browser', connected: false }); stderr('browser disconnected'); touch()
  })
  socket.on('error', () => {})
}

function parseFrames(buf) {
  const messages = []
  let i = 0
  while (i + 2 <= buf.length) {
    const b1 = buf[i], b2 = buf[i + 1], opcode = b1 & 0x0f, masked = (b2 & 0x80) !== 0
    let len = b2 & 0x7f, p = i + 2
    if (len === 126) { len = buf.readUInt16BE(p); p += 2 }
    else if (len === 127) { len = Number(buf.readBigUInt64BE(p)); p += 8 }
    let mask = Buffer.alloc(0)
    if (masked) { mask = buf.slice(p, p + 4); p += 4 }
    if (p + len > buf.length) break
    let payload = buf.slice(p, p + len)
    if (masked) payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]))
    if (opcode === 0x8) { wsClient?.end(); return messages }
    if (opcode === 0x9) { sendFrame(wsClient, 0xa, payload); i = p + len; continue }
    if ([0x0, 0x1, 0x2].includes(opcode)) messages.push(payload.toString())
    i = p + len
  }
  return messages
}

function sendFrame(socket, opcode, payload) {
  if (!socket || socket.destroyed) return
  const data = Buffer.from(payload), len = data.length
  let header
  if (len < 126) header = Buffer.from([0x80 | opcode, len])
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2) }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2) }
  socket.write(Buffer.concat([header, data]))
}

function sendJson(socket, value) { sendFrame(socket, 0x1, JSON.stringify(value)) }
function handleMessage(text) {
  let message
  try { message = JSON.parse(text) } catch { return }
  if (message.type === 'snapshot') {
    const snapshot = { cells: Array.isArray(message.cells) ? message.cells : [], updatedAt: Date.now(), namespace: message.namespace ?? null, scriptV: message.v ?? null }
    stderr(`snapshot ${snapshot.cells.length} cells (ns=${snapshot.namespace}, v=${snapshot.scriptV})`)
    if (pendingResolve) { pendingResolve(snapshot); pendingResolve = null }
  }
  if (message.type === 'tool_response' && pendingTools.has(message.requestId)) {
    const resolve = pendingTools.get(message.requestId); pendingTools.delete(message.requestId); resolve(message)
  }
}

function waitForBrowser() {
  if (wsClient && !wsClient.destroyed) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { browserWaiters.delete(done); reject(new Error('浏览器未连接: 请打开 arena 页面并等待油猴脚本重连')) }, REQUEST_TIMEOUT_MS)
    const done = () => { clearTimeout(timer); resolve() }
    browserWaiters.add(done)
  })
}

async function browserTool(tool, args = {}) {
  await waitForBrowser()
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pendingTools.delete(requestId); reject(new Error('等待浏览器工具回包超时')) }, REQUEST_TIMEOUT_MS)
    pendingTools.set(requestId, (message) => { clearTimeout(timer); message.error ? reject(new Error(message.error)) : resolve(message.result) })
    sendJson(wsClient, { cmd: 'tool', requestId, tool, args })
  })
}

async function fetchFresh() {
  const refresh = async () => {
    await waitForBrowser()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pendingResolve = null; reject(new Error('等待浏览器回包超时')) }, REQUEST_TIMEOUT_MS)
      pendingResolve = (snapshot) => { clearTimeout(timer); resolve(snapshot) }
      sendJson(wsClient, { cmd: 'refresh' })
    })
  }
  const result = refreshQueue.then(refresh, refresh)
  refreshQueue = result.catch(() => {})
  return result
}

process.on('message', async (message) => {
  if (message?.type !== 'request') return
  activeRequests++; touch()
  try {
    const result = message.op === 'fetchFresh' ? await fetchFresh() : await browserTool(message.tool, message.args)
    reply({ type: 'response', id: message.id, result })
  } catch (error) { reply({ type: 'response', id: message.id, error: error.message }) }
  activeRequests--; touch()
})
process.on('disconnect', () => process.exit(0))
