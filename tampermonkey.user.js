// ==UserScript==
// @name         arena-hero-mcp
// @namespace    arena-hero-mcp
// @version      0.5.0
// @description  向本地 MCP 桥提供浏览器地图、指令上下文和路线预览
// @match        https://app.arenahero.io/*
// @match        http://localhost/*
// @match        http://127.0.0.1/*
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict'
  // ponytail: 脚本版本, 必须与 npm 包(arena-hero-mcp)version 一致, 否则 server 报版本不匹配.
  const SCRIPT_VERSION = '0.5.0'
  // 自动识别失败时使用; 本地 demo 仍固定用 demo.
  const FALLBACK_NAMESPACE = 'anonymous'
  // ws 无加密. 浏览器需对 app.arenahero.io 放行"不安全内容"才能从 https 页连本 ws://
  const WS_URL = 'ws://127.0.0.1:7790'
  const RECONNECT_MS = 3000
  const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow
  let game = { tick: null, state: null, phase: 'connecting', stateReceivedAt: null, receipts: {}, error: null }

  // 只旁听页面自己的游戏 WS; 不改写请求、响应或连接生命周期.
  const NativeWebSocket = page.WebSocket
  page.WebSocket = class extends NativeWebSocket {
    constructor(...args) {
      super(...args)
      if (!String(args[0]).includes('/api/v1/game/ws')) return
      this.addEventListener('message', ({ data }) => {
        try {
          const message = JSON.parse(String(data))
          if (message.type === 'tick') game = { ...game, tick: message.data, phase: 'syncing', receipts: {}, error: null }
          if (message.type === 'state') game = { ...game, state: message.data, phase: 'open', stateReceivedAt: Date.now(), error: null }
          if (message.type === 'received') game = { ...game, receipts: { ...game.receipts, [message.data.source]: message.data } }
        } catch {}
      })
      this.addEventListener('close', () => { game = { ...game, phase: 'offline' } })
      this.addEventListener('error', () => { game = { ...game, phase: 'offline', error: 'GAME_STREAM_OFFLINE' } })
    }
  }

  async function getNamespace() {
    if (location.pathname.startsWith('/demo')) return 'demo'
    try {
      const apiOrigin = location.hostname === 'app.arenahero.io' ? 'https://api.arenahero.io' : location.origin
      const response = await fetch(`${apiOrigin}/api/v1/me`, { credentials: 'include' })
      if (response.ok) {
        const user = await response.json()
        if (typeof user.username === 'string' && user.username) return user.username
      }
    } catch {}
    return FALLBACK_NAMESPACE
  }

  async function readCells(namespace) {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open(`arena-hero-exploration-${namespace}`, 1)
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
    })
    const cells = await new Promise((res, rej) => {
      const tx = db.transaction('cells', 'readonly')
      const q = tx.objectStore('cells').getAll()
      q.onsuccess = () => res(q.result || []); q.onerror = () => rej(q.error)
    })
    db.close()
    return cells.filter((c) => ['EMPTY', 'OBSTACLE', 'RESOURCE'].includes(c.kind))
  }

  function movementGoals(namespace) {
    try { return JSON.parse(localStorage.getItem(`arena-hero.movement-goals.${namespace}`) || '{}') } catch { return {} }
  }

  function effectivePlan() {
    const agent = game.receipts.AGENT?.tick === game.tick ? game.receipts.AGENT.plan : null
    const manual = game.receipts.MANUAL?.tick === game.tick ? game.receipts.MANUAL.plan : null
    const unit_actions = { ...(agent?.unit_actions || {}), ...(manual?.unit_actions || {}) }
    const core_action = manual?.core_action || agent?.core_action
    const unitSources = Object.fromEntries(Object.keys(unit_actions).map((id) => [id, manual?.unit_actions?.[id] ? 'MANUAL' : 'AGENT']))
    return { plan: { tick: game.tick, unit_actions, ...(core_action ? { core_action } : {}) }, unitSources, ...(core_action ? { coreSource: manual?.core_action ? 'MANUAL' : 'AGENT' } : {}) }
  }

  const steps = [[0, -1, 'UP'], [1, 0, 'RIGHT'], [0, 1, 'DOWN'], [-1, 0, 'LEFT']]
  const key = ([x, y]) => `${x},${y}`
  function visibleCells(state) {
    const obstacles = new Set(state.objects.filter((item) => item.kind === 'OBSTACLE').flatMap((item) => (item.positions || []).map(key))), visible = new Set()
    const blocked = (from, to, candidate) => key(candidate) !== key(to) && obstacles.has(key(candidate))
    const sees = (from, to) => {
      if (key(from) === key(to)) return true
      const dx = to[0] - from[0], dy = to[1] - from[1], nx = Math.abs(dx), ny = Math.abs(dy), sx = Math.sign(dx), sy = Math.sign(dy)
      let x = from[0], y = from[1], ix = 0, iy = 0
      while (ix < nx || iy < ny) {
        const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx
        if (decision === 0) { if (blocked(from, to, [x + sx, y]) || blocked(from, to, [x, y + sy])) return false; x += sx; y += sy; ix++; iy++ }
        else if (decision < 0) { x += sx; ix++ } else { y += sy; iy++ }
        if (blocked(from, to, [x, y])) return false
      }
      return true
    }
    for (const item of state.objects) {
      if (!item.controlled || !item.position || !['UNIT', 'CORE'].includes(item.kind)) continue
      const radius = item.kind === 'CORE' || item.unit_type === 'RANGER' ? 5 : item.unit_type === 'VANGUARD' ? 4 : 3
      for (let dy = -radius; dy <= radius; dy++) for (let dx = -(radius - Math.abs(dy)); dx <= radius - Math.abs(dy); dx++) {
        const position = [item.position[0] + dx, item.position[1] + dy]
        if (sees(item.position, position)) visible.add(key(position))
      }
    }
    return visible
  }
  function previewRoute(cells, objectId, destination) {
    const state = game.state, object = state?.objects?.find((item) => item.id === objectId)
    if (!object?.controlled || !object.position || !['UNIT', 'CORE'].includes(object.kind)) return { path: null, reason: 'NO_ROUTE' }
    if (key(object.position) === key(destination)) return { path: [object.position], next_direction: null }
    const terrain = new Map(cells.map((cell) => [key(cell.position), cell.kind]))
    for (const cell of visibleCells(state)) terrain.set(cell, 'EMPTY')
    for (const item of state.objects) if (['OBSTACLE', 'RESOURCE'].includes(item.kind)) for (const position of item.positions || []) terrain.set(key(position), item.kind)
    if (!terrain.has(key(destination))) return { path: null, reason: 'UNKNOWN_DESTINATION' }
    const enemies = new Set(), counts = new Map(), objects = new Map(state.objects.flatMap((item) => item.id ? [[item.id, item]] : []))
    for (const item of state.objects) if (['UNIT', 'CORE'].includes(item.kind) && item.position) {
      const cell = key(item.position); counts.set(cell, (counts.get(cell) || 0) + 1); if (item.controlled === false) enemies.add(cell)
    }
    const adjust = (cell, delta) => counts.set(cell, (counts.get(cell) || 0) + delta)
    adjust(key(object.position), -1)
    for (const [id, action] of Object.entries(effectivePlan().plan.unit_actions)) {
      if (id === objectId || action.type !== 'MOVE' || !action.direction) continue
      const moving = objects.get(id), step = steps.find((entry) => entry[2] === action.direction)
      if (!moving?.controlled || !moving.position || !step) continue
      adjust(key(moving.position), -1); adjust(key([moving.position[0] + step[0], moving.position[1] + step[1]]), 1)
    }
    const enter = (position) => { const cell = key(position), kind = terrain.get(cell); return kind && kind !== 'OBSTACLE' && !(object.kind === 'CORE' && kind === 'RESOURCE') && !enemies.has(cell) && (counts.get(cell) || 0) < 2 }
    if (!enter(destination)) return { path: null, reason: 'NO_ROUTE' }
    const queue = [object.position], parent = new Map(), positions = new Map([[key(object.position), object.position]]), seen = new Set(positions.keys())
    for (let i = 0; i < queue.length && seen.size <= 50_000; i++) for (const [dx, dy] of steps) {
      const next = [queue[i][0] + dx, queue[i][1] + dy], nextKey = key(next)
      if (seen.has(nextKey) || !enter(next)) continue
      seen.add(nextKey); parent.set(nextKey, key(queue[i])); positions.set(nextKey, next); queue.push(next)
      if (nextKey === key(destination)) {
        const path = []; let cursor = nextKey
        while (cursor) { path.push(positions.get(cursor)); cursor = parent.get(cursor) }
        path.reverse(); const step = steps.find(([x, y]) => path[1][0] - path[0][0] === x && path[1][1] - path[0][1] === y)
        return { path, next_direction: step?.[2] || null }
      }
    }
    return { path: null, reason: seen.size > 50_000 ? 'SEARCH_LIMIT' : 'NO_ROUTE' }
  }

  async function handleTool(message) {
    const namespace = await getNamespace()
    let result
    if (message.tool === 'get_movement_goals') result = movementGoals(namespace)
    if (message.tool === 'get_command_context') result = { tick: game.tick, agent: game.receipts.AGENT || null, manual: game.receipts.MANUAL || null, effective: effectivePlan() }
    // ponytail: React 选择态没有稳定浏览器资源入口; 不猜 DOM, 固定返回 null.
    if (message.tool === 'get_web_game_context') result = { tick: game.tick, phase: game.phase, state_received_at: game.stateReceivedAt, command_window_remaining_ms: game.phase === 'open' && game.stateReceivedAt ? Math.max(0, 15_000 - (Date.now() - game.stateReceivedAt)) : 0, selected_object_id: null, movement_goals: movementGoals(namespace), error: game.error }
    if (message.tool === 'preview_route') result = previewRoute(await readCells(namespace), message.args.objectId, message.args.destination)
    ws && ws.send(JSON.stringify({ type: 'tool_response', requestId: message.requestId, result }))
  }

  let ws = null
  let connected = false
  const btn = document.createElement('button')
  btn.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;font:12px sans-serif;padding:4px 8px;border-radius:4px;cursor:pointer'
  function setBtn(text, bg) { btn.textContent = text; btn.style.background = bg; btn.style.color = '#fff'; btn.style.border = '1px solid #374151' }

  async function handleRefresh() {
    let namespace = FALLBACK_NAMESPACE
    try {
      namespace = await getNamespace()
      const cells = await readCells(namespace)
      const msg = JSON.stringify({ type: 'snapshot', v: SCRIPT_VERSION, namespace, cells })
      ws && ws.send(msg)
      console.log('[cells-bridge] refresh ->', namespace, cells.length, 'cells')
    } catch (e) {
      ws && ws.send(JSON.stringify({ type: 'snapshot', v: SCRIPT_VERSION, namespace, cells: [], error: String(e) }))
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
      if (msg.cmd === 'tool') void handleTool(msg).catch((error) => ws && ws.send(JSON.stringify({ type: 'tool_response', requestId: msg.requestId, error: String(error) })))
    }
  }
  let timer = null
  function scheduleReconnect() { if (timer) return; timer = setTimeout(() => { timer = null; connect() }, RECONNECT_MS) }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Arena: 重连 MCP 桥', connect)
  }
  btn.onclick = () => (connected ? handleRefresh() : connect())
  // ponytail: 只在正式 arena 页显示状态按钮; 其它页(登录/本地开发)静默连接, 不占 UI.
  const showBtn = location.hostname === 'app.arenahero.io' && location.pathname.startsWith('/arena')
  if (showBtn) addEventListener('DOMContentLoaded', () => { ;(document.body || document.documentElement).appendChild(btn); setBtn('📡 连接中...', '#6b7280') }, { once: true })

  connect()
  console.log(`[cells-bridge] 已加载, ws=${WS_URL}`)
})()
