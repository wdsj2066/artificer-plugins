import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))

// 指向插件自己的依赖副本：vi.mock 的路径按测试文件所在目录解析，
// 而 node-pty 安装在 plugins/terminal/node_modules 下，用裸包名无法命中断言密钥。
vi.mock('../../plugins/terminal/node_modules/node-pty', () => ({
  default: { spawn: mocks.spawn }
}))

import { register } from '../../plugins/terminal/server.js'

let routes
let websocketHandler
let sandbox
let settings
let pty

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'artificer-terminal-'))
  vi.clearAllMocks()
  routes = new Map()
  websocketHandler = null
  settings = {}
  pty = {
    onData: vi.fn(),
    onExit: vi.fn(),
    kill: vi.fn(),
    resize: vi.fn(),
    write: vi.fn()
  }
  mocks.spawn.mockReturnValue(pty)

  register({
    registerRoute: route => routes.set(`${route.method} ${route.path}`, route),
    registerWebSocket: ({ handler }) => { websocketHandler = handler },
    getSettings: () => settings,
    logger: { info: vi.fn() }
  })
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

function callRoute(method, routePath, { query = {}, body = {}, params = {} } = {}) {
  return routes.get(`${method} ${routePath}`).handler({ query, body, params })
}

describe('terminal plugin routes', () => {
  it('注册终端路由与 WebSocket 处理器', () => {
    expect([...routes.keys()]).toEqual([
      'POST /api/plugins/terminal/sessions',
      'GET /api/plugins/terminal/sessions',
      'GET /api/plugins/terminal/sessions/:id',
      'PUT /api/plugins/terminal/sessions/:id',
      'DELETE /api/plugins/terminal/sessions/:id',
      'POST /api/plugins/terminal/sessions/:id/abort'
    ])
    expect(websocketHandler).toBeTypeOf('function')
  })

  it('创建终端时要求 sessionId 与 cwd', async () => {
    const noSession = await callRoute('POST', '/api/plugins/terminal/sessions', {
      body: { cwd: sandbox }
    })
    expect(noSession).toEqual({ success: false, error: '缺少 sessionId' })

    const noCwd = await callRoute('POST', '/api/plugins/terminal/sessions', {
      body: { sessionId: 'session-1' }
    })
    expect(noCwd).toEqual({ success: false, error: '缺少工作目录 cwd' })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('创建终端时拒绝不存在的目录', async () => {
    const result = await callRoute('POST', '/api/plugins/terminal/sessions', {
      body: { sessionId: 'session-1', cwd: join(sandbox, 'missing') }
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('目录不存在')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('创建终端时使用传入的 cwd 与插件设置里的默认行列数', async () => {
    settings = { defaultCols: 120, defaultRows: 40 }

    const result = await callRoute('POST', '/api/plugins/terminal/sessions', {
      body: { sessionId: 'session-1', cwd: sandbox }
    })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ cwd: sandbox, cols: 120, rows: 40, alive: true })
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.any(String),
      [],
      expect.objectContaining({ cwd: sandbox, cols: 120, rows: 40 })
    )
  })

  it('未配置插件设置时使用默认行列数', async () => {
    const result = await callRoute('POST', '/api/plugins/terminal/sessions', {
      body: { sessionId: 'session-1', cwd: sandbox }
    })

    expect(result.data).toMatchObject({ cols: 80, rows: 24 })
  })

  it('修改终端 cwd 时校验目录存在与类型', async () => {
    const created = await callRoute('POST', '/api/plugins/terminal/sessions', {
      body: { sessionId: 'session-1', cwd: sandbox }
    })
    const filePath = join(sandbox, 'not-a-dir.txt')
    mkdirSync(join(sandbox, 'sub'))
    writeFileSync(filePath, 'x')

    const missing = await callRoute('PUT', '/api/plugins/terminal/sessions/:id', {
      body: { sessionId: 'session-1', cwd: join(sandbox, 'missing') },
      params: { id: created.data.id }
    })
    expect(missing.error).toContain('目录不存在')

    const notDir = await callRoute('PUT', '/api/plugins/terminal/sessions/:id', {
      body: { sessionId: 'session-1', cwd: filePath },
      params: { id: created.data.id }
    })
    expect(notDir.error).toContain('不是文件夹')

    const renamed = await callRoute('PUT', '/api/plugins/terminal/sessions/:id', {
      body: { sessionId: 'session-1', name: '构建', cwd: join(sandbox, 'sub') },
      params: { id: created.data.id }
    })
    expect(renamed.success).toBe(true)
    expect(renamed.data).toMatchObject({ name: '构建', cwd: join(sandbox, 'sub') })
  })

  it('按会话隔离终端，跨会话访问一律返回不存在', async () => {
    const owned = await callRoute('POST', '/api/plugins/terminal/sessions', {
      body: { sessionId: 'session-1', cwd: sandbox }
    })
    const other = await callRoute('POST', '/api/plugins/terminal/sessions', {
      body: { sessionId: 'session-2', cwd: sandbox }
    })

    const ownList = await callRoute('GET', '/api/plugins/terminal/sessions', { query: { sessionId: 'session-1' } })
    const otherList = await callRoute('GET', '/api/plugins/terminal/sessions', { query: { sessionId: 'session-2' } })
    expect(ownList.data.terminals.map(term => term.id)).toContain(owned.data.id)
    expect(ownList.data.terminals.map(term => term.id)).not.toContain(other.data.id)
    expect(otherList.data.terminals.map(term => term.id)).toContain(other.data.id)
    expect(otherList.data.terminals.map(term => term.id)).not.toContain(owned.data.id)

    const unauthorized = await callRoute('GET', '/api/plugins/terminal/sessions', { query: {} })
    expect(unauthorized.data.terminals).toEqual([])

    for (const [method, routePath, extra] of [
      ['GET', '/api/plugins/terminal/sessions/:id', {}],
      ['PUT', '/api/plugins/terminal/sessions/:id', { body: { name: '越权重命名' } }],
      ['DELETE', '/api/plugins/terminal/sessions/:id', {}],
      ['POST', '/api/plugins/terminal/sessions/:id/abort', {}]
    ]) {
      const result = await callRoute(method, routePath, {
        ...extra,
        query: { sessionId: 'session-2' },
        params: { id: owned.data.id }
      })
      expect(result).toEqual({ success: false, error: '终端不存在' })
    }
  })

  it('关闭终端后不再出现在列表中且进程被终止', async () => {
    const created = await callRoute('POST', '/api/plugins/terminal/sessions', {
      body: { sessionId: 'session-1', cwd: sandbox }
    })
    pty.kill.mockClear()

    const removed = await callRoute('DELETE', '/api/plugins/terminal/sessions/:id', {
      query: { sessionId: 'session-1' },
      params: { id: created.data.id }
    })
    expect(removed).toEqual({ success: true, data: { message: '终端已关闭' } })
    expect(pty.kill).toHaveBeenCalled()

    const list = await callRoute('GET', '/api/plugins/terminal/sessions', { query: { sessionId: 'session-1' } })
    expect(list.data.terminals.map(term => term.id)).not.toContain(created.data.id)
  })

  it('WebSocket 校验终端 owner 并推送就绪消息', async () => {
    const owned = await callRoute('POST', '/api/plugins/terminal/sessions', {
      body: { sessionId: 'session-1', cwd: sandbox }
    })
    const forbiddenSocket = { close: vi.fn(), send: vi.fn(), on: vi.fn() }
    const ownedSocket = { close: vi.fn(), send: vi.fn(), on: vi.fn() }

    websocketHandler(forbiddenSocket, { url: `/api/plugins/terminal/ws?id=${owned.data.id}&sessionId=session-2` })
    websocketHandler(ownedSocket, { url: `/api/plugins/terminal/ws?id=${owned.data.id}&sessionId=session-1` })

    expect(forbiddenSocket.close).toHaveBeenCalledWith(4003, 'terminal forbidden')
    expect(forbiddenSocket.send).not.toHaveBeenCalled()
    expect(ownedSocket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"ready"'))

    const missingSocket = { close: vi.fn(), send: vi.fn(), on: vi.fn() }
    websocketHandler(missingSocket, { url: '/api/plugins/terminal/ws' })
    expect(missingSocket.close).toHaveBeenCalledWith(4000, 'missing id')
  })
})
