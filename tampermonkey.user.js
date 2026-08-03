// ==UserScript==
// @name         arena-hero-mcp
// @namespace    arena-hero-mcp
// @version      0.3.0
// @description  连本地 ws MCP 桥, 收 refresh 指令时读 IndexedDB 记忆格回推, 供 AI 查询
// @match        https://app.arenahero.io/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict'
  // ponytail: namespace 写死, 改账号改这里. demo 用 'demo', 匿名 'anonymous', 登录态填用户名.
  const NAMESPACE = 'demo'
  // ws 无加密. 浏览器需对 app.arenahero.io 放行"不安全内容"才能从 https 页连本 ws://
  const WS_URL = 'ws://127.0.0.1:7790'
  const RECONNECT_MS = 3000

  async function readCells() {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(`arena-hero-exploration-${NAMESPACE}`, 1)
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
    })
    const cells = await new Promise((res, rej) => {
      const tx = db.transaction('cells', 'readonly')
      const q = tx.objectStore('cells').getAll()
      q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error)
    })
    db.close()
    return cells.filter((c) => c.kind && c.kind !== 'EMPTY')
  }

  let ws = null
  let connected = false
  const btn = document.createElement('button')
  btn.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;font:12px sans-serif;padding:4px 8px;border-radius:4px;cursor:pointer'
  function setBtn(text, bg) { btn.textContent = text; btn.style.background = bg; btn.style.color = '#fff'; btn.style.border = '1px solid #374151' }

  async function handleRefresh() {
    try {
      const cells = await readCells()
      const msg = JSON.stringify({ type: 'snapshot', namespace: NAMESPACE, cells })
      ws && ws.send(msg)
      console.log('[cells-bridge] refresh ->', cells.length, 'cells')
    } catch (e) {
      ws && ws.send(JSON.stringify({ type: 'snapshot', namespace: NAMESPACE, cells: [], error: String(e) }))
      console.warn('[cells-bridge] 读取失败', e)
    }
  }

  function connect() {
    try { ws = new WebSocket(WS_URL) }
    catch (e) { setBtn('📡 桥连失败', '#b91c1c'); scheduleReconnect(); return }
    ws.onopen = () => { connected = true; setBtn('📡 已连 MCP 桥', '#16a34a'); console.log('[cells-bridge] connected', WS_URL) }
    ws.onclose = () => { connected = false; setBtn('📡 桥已断开', '#b91c1c'); scheduleReconnect() }
    ws.onerror = () => {}
    ws.onmessage = (e) => {
      let msg
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg.cmd === 'refresh') handleRefresh()
    }
  }
  let timer = null
  function scheduleReconnect() { if (timer) return; timer = setTimeout(() => { timer = null; connect() }, RECONNECT_MS) }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Arena: 重连 MCP 桥', connect)
  }
  btn.onclick = () => (connected ? handleRefresh() : connect())
  ;(document.body || document.documentElement).appendChild(btn)
  setBtn('📡 连接中...', '#6b7280')

  connect()
  console.log(`[cells-bridge] 已加载 ns=${NAMESPACE}, ws=${WS_URL}`)
})()
