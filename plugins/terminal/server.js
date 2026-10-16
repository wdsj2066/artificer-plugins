/**
 * 终端插件后端 — PTY 终端会话管理 + WebSocket 实时流
 *
 * API
 *   POST   /api/plugins/terminal/sessions          创建 PTY 终端
 *   GET    /api/plugins/terminal/sessions           终端列表
 *   GET    /api/plugins/terminal/sessions/:id       终端详情
 *   PUT    /api/plugins/terminal/sessions/:id       重命名 / 修改 cwd
 *   DELETE /api/plugins/terminal/sessions/:id       关闭终端
 *   POST   /api/plugins/terminal/sessions/:id/abort 强制终止进程
 *
 * WebSocket
 *   ws://host/api/plugins/terminal/ws?id=<id>
 *   Client → Server: {type:'input',data} | {type:'resize',cols,rows} | {type:'ping'}
 *   Server → Client: {type:'ready',...} | {type:'data',data} | {type:'exit',exitCode,signal}
 */

import { existsSync, statSync } from 'fs'
import path from 'path'
import crypto from 'crypto'
import pty from 'node-pty'

// ============================================================
// 终端会话（node-pty 封装）
// ============================================================

const terminals = new Map()
const MAX_SCROLLBACK_BYTES = 64 * 1024

function shellCandidates() {
  const candidates = process.platform === 'win32'
    ? [
        process.env.COMSPEC,
        path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'cmd.exe'),
        'cmd.exe'
      ]
    : [process.env.SHELL, '/bin/bash', '/bin/sh']

  return [...new Set(candidates
    .filter(Boolean)
    .map(shell => String(shell).trim().replace(/^"|"$/g, ''))
    .filter(Boolean))]
}

function spawnPty(cols, rows, cwd) {
  const options = {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor'
    }
  }
  let lastError = null
  for (const shell of shellCandidates()) {
    try {
      return pty.spawn(shell, [], options)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('找不到可用的终端 Shell')
}

function generateId() {
  return crypto.randomBytes(4).toString('hex')
}

class TerminalSession {
  constructor(id, name, cwd, cols, rows, sessionId = null) {
    this.id = id
    this.name = name
    this.cwd = cwd
    this.sessionId = sessionId
    this.cols = cols || 80
    this.rows = rows || 24
    this.alive = true
    this.createdAt = Date.now()
    this.lastActiveAt = Date.now()
    this.clients = new Set()
    this.scrollback = []        // 回滚文本行
    this._scrollbackBytes = 0
    this._lineSeq = 0

    this.pty = spawnPty(this.cols, this.rows, this.cwd)

    this.pty.onData((data) => {
      this.lastActiveAt = Date.now()
      this._addScrollback(data)
      for (const ws of this.clients) {
        try { ws.send(JSON.stringify({ type: 'data', data })) } catch {}
      }
    })

    this.pty.onExit(({ exitCode, signal }) => {
      this.alive = false
      this.pty = null
      if (this.clients.size > 0) {
        const msg = JSON.stringify({ type: 'exit', exitCode: exitCode ?? 0, signal: signal ?? null })
        for (const ws of this.clients) {
          try { ws.send(msg) } catch {}
        }
      }
    })
  }

  _addScrollback(data) {
    this.scrollback.push(data)
    this._scrollbackBytes += Buffer.byteLength(data, 'utf-8')
    while (this._scrollbackBytes > MAX_SCROLLBACK_BYTES && this.scrollback.length > 1) {
      const removed = this.scrollback.shift()
      this._scrollbackBytes -= Buffer.byteLength(removed, 'utf-8')
    }
  }

  addClient(ws) {
    this.clients.add(ws)
    ws.send(JSON.stringify({
      type: 'ready',
      scrollback: this.scrollback.join(''),
      cols: this.cols,
      rows: this.rows,
      name: this.name,
      cwd: this.cwd
    }))
  }

  removeClient(ws) {
    this.clients.delete(ws)
  }

  resize(cols, rows) {
    this.cols = cols
    this.rows = rows
    if (this.pty) this.pty.resize(cols, rows)
  }

  kill() {
    if (this.pty) {
      try { this.pty.kill('SIGKILL') } catch {}
      this.pty = null
    }
    this.alive = false
    if (this.clients.size > 0) {
      const msg = JSON.stringify({ type: 'exit', exitCode: -1, signal: 'SIGKILL' })
      for (const ws of this.clients) {
        try { ws.send(msg) } catch {}
      }
    }
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      alive: this.alive,
      cols: this.cols,
      rows: this.rows,
      onlineClients: this.clients.size,
      scrollbackBytes: this._scrollbackBytes,
      createdAt: this.createdAt,
      lastActiveAt: this.lastActiveAt
    }
  }
}

// ============================================================
// 定时期：清理已死且无客户端的终端
// ============================================================

const cleanupTimer = setInterval(() => {
  for (const [id, term] of terminals) {
    if (!term.alive && term.clients.size === 0) {
      terminals.delete(id)
    }
  }
}, 30000)

// ============================================================
// WebSocket 处理器
// ============================================================

function canAccessTerminal(term, sessionId) {
  return Boolean(sessionId) && term.sessionId === sessionId
}

function wsHandler(ws, req) {
  const parsedUrl = new URL(req.url, 'http://localhost')
  const id = parsedUrl.searchParams.get('id')
  const sessionId = parsedUrl.searchParams.get('sessionId')
  if (!id) { ws.close(4000, 'missing id'); return }

  const term = terminals.get(id)
  if (!term) { ws.close(4004, 'terminal not found'); return }
  if (!canAccessTerminal(term, sessionId)) { ws.close(4003, 'terminal forbidden'); return }

  term.addClient(ws)

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())
      switch (msg.type) {
        case 'input':
          term.lastActiveAt = Date.now()
          if (term.pty) term.pty.write(msg.data)
          break
        case 'resize':
          term.resize(msg.cols || term.cols, msg.rows || term.rows)
          break
        case 'ping':
          try { ws.send(JSON.stringify({ type: 'pong' })) } catch {}
          break
      }
    } catch { /* 忽略非法消息 */ }
  })

  ws.on('close', () => term.removeClient(ws))
  ws.on('error', () => term.removeClient(ws))
}

// ============================================================
// 进程退出清理
// ============================================================

function killAll() {
  for (const term of terminals.values()) {
    term.kill()
  }
  terminals.clear()
  clearInterval(cleanupTimer)
}

// ============================================================
// 插件注册
// ============================================================

export function register(ctx) {
  const { registerRoute, registerWebSocket, logger } = ctx
  // 插件设置由宿主保存，后端通过 ctx 读取（默认列数 / 行数等）
  const getSettings = () => (typeof ctx.getSettings === 'function' ? ctx.getSettings() : null) || {}

  // ---- 进程退出清理 ----
  // 运行时插件可被禁用 / 卸载 / 热重载，监听器需随插件销毁一同摘除，避免重复累积
  const onExit = () => killAll()
  const onSignal = () => { killAll(); process.exit(0) }
  process.on('exit', onExit)
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  if (typeof ctx.disposeWithPlugin === 'function') {
    ctx.disposeWithPlugin(() => {
      process.off('exit', onExit)
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
      killAll()
    })
  }

  // ---- WebSocket ----
  registerWebSocket({ path: '/api/plugins/terminal/ws', handler: wsHandler })

  // ---- 创建终端 ----
  registerRoute({
    method: 'POST',
    path: '/api/plugins/terminal/sessions',
    async handler({ body }) {
      try {
        if (!body?.sessionId) return { success: false, error: '缺少 sessionId' }
        const settings = getSettings()
        // 工作目录由前端解析后传入（宿主公开接口 /api/sessions/:id/context 的 root）
        if (!body?.cwd) return { success: false, error: '缺少工作目录 cwd' }
        const cwd = body.cwd
        if (!existsSync(cwd)) return { success: false, error: `目录不存在: ${cwd}` }
        if (!statSync(cwd).isDirectory()) return { success: false, error: `终端路径不是文件夹: ${cwd}` }

        const id = generateId()
        const name = body?.name || `终端 ${terminals.size + 1}`
        const cols = body?.cols || settings.defaultCols || 80
        const rows = body?.rows || settings.defaultRows || 24

        const term = new TerminalSession(id, name, cwd, cols, rows, body.sessionId)
        terminals.set(id, term)
        logger?.info?.(`[terminal] 创建终端: ${id} (${name})`)
        return { success: true, data: term.toJSON() }
      } catch (err) {
        return { success: false, error: err.message }
      }
    }
  })

  // ---- 终端列表 ----
  registerRoute({
    method: 'GET',
    path: '/api/plugins/terminal/sessions',
    async handler({ query }) {
      const list = Array.from(terminals.values())
        .filter(t => canAccessTerminal(t, query?.sessionId || null))
        .map(t => t.toJSON())
        .sort((a, b) => b.createdAt - a.createdAt)
      return { success: true, data: { terminals: list } }
    }
  })

  // ---- 终端详情 ----
  registerRoute({
    method: 'GET',
    path: '/api/plugins/terminal/sessions/:id',
    async handler({ params, query }) {
      const term = terminals.get(params.id)
      if (!term || !canAccessTerminal(term, query?.sessionId || null)) return { success: false, error: '终端不存在' }
      return { success: true, data: term.toJSON() }
    }
  })

  // ---- 重命名 / 修改 cwd ----
  registerRoute({
    method: 'PUT',
    path: '/api/plugins/terminal/sessions/:id',
    async handler({ params, body, query }) {
      const term = terminals.get(params.id)
      const sessionId = body?.sessionId || query?.sessionId || null
      if (!term || !canAccessTerminal(term, sessionId)) return { success: false, error: '终端不存在' }
      if (body?.name) term.name = body.name
      if (body?.cwd) {
        if (!existsSync(body.cwd)) return { success: false, error: `目录不存在: ${body.cwd}` }
        if (!statSync(body.cwd).isDirectory()) return { success: false, error: `终端路径不是文件夹: ${body.cwd}` }
        term.cwd = body.cwd
      }
      return { success: true, data: term.toJSON() }
    }
  })

  // ---- 关闭终端 ----
  registerRoute({
    method: 'DELETE',
    path: '/api/plugins/terminal/sessions/:id',
    async handler({ params, query }) {
      const term = terminals.get(params.id)
      if (!term || !canAccessTerminal(term, query?.sessionId || null)) return { success: false, error: '终端不存在' }
      term.kill()
      terminals.delete(params.id)
      logger?.info?.(`[terminal] 删除终端: ${params.id}`)
      return { success: true, data: { message: '终端已关闭' } }
    }
  })

  // ---- 强制终止进程 ----
  registerRoute({
    method: 'POST',
    path: '/api/plugins/terminal/sessions/:id/abort',
    async handler({ params, body, query }) {
      const term = terminals.get(params.id)
      const sessionId = body?.sessionId || query?.sessionId || null
      if (!term || !canAccessTerminal(term, sessionId)) return { success: false, error: '终端不存在' }
      term.kill()
      return { success: true, data: { message: '进程已终止' } }
    }
  })
}
