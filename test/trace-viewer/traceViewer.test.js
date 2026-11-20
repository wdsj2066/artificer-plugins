import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../../plugins/trace-viewer/plugin.json', import.meta.url), 'utf8'))

function makeCtx() {
  const routes = []
  const hooks = []
  return {
    routes,
    hooks,
    ctx: {
      pluginId: manifest.id,
      logger: { warn: vi.fn(), info: vi.fn() },
      host: { on: (point, fn, opts) => hooks.push({ point, fn, type: opts?.type, priority: opts?.priority }) },
      registerRoute: (route) => routes.push(route),
      settings: {},
      dataDir: new URL('../../.config/trace-viewer-test', import.meta.url).pathname
    }
  }
}

describe('trace-viewer 插件', () => {
  it('清单声明 api 入口与 ui 视图', () => {
    expect(manifest.id).toBe('trace-viewer')
    expect(manifest.entrypoints.api).toBe('server.js')
    expect(manifest.entrypoints.web).toBe('web.js')
    expect(manifest.author).toBeTruthy()
  })

  it('注册钩子与路由', async () => {
    const { register } = await import('../../plugins/trace-viewer/server.js')
    const { ctx, hooks, routes } = makeCtx()
    await register(ctx)
    expect(hooks.length).toBeGreaterThan(0)
    expect(routes.some(route => route.path.includes('/api/plugins/trace-viewer/events'))).toBe(true)
    const toolCall = hooks.find(hook => hook.point === 'toolCall')
    expect(toolCall?.type).toBe('middleware')
  })

  it('toolCall 中间件必须把回传值继续向下传递', async () => {
    const { register } = await import('../../plugins/trace-viewer/server.js')
    const { ctx, hooks } = makeCtx()
    await register(ctx)

    const middleware = hooks.find(hook => hook.point === 'toolCall').fn

    // 下游模拟交互型工具：yield 一个问题，期望收到用户回答
    let received = null
    const downstream = async function* () {
      received = yield { type: 'ask_user', question: '用 patch 还是 minor？' }
      yield { type: 'tool_result', result: { answer: received } }
      return received
    }

    const gen = middleware({ toolCall: { id: 'tc1', function: { name: 'askUser' } } }, downstream)
    let next = undefined
    const events = []
    while (true) {
      const { value, done } = await gen.next(next)
      next = undefined
      if (done) break
      events.push(value)
      if (value.type === 'ask_user') next = 'minor'
    }

    // 回答必须穿过观察者到达下游
    expect(received).toBe('minor')
    const result = events.find(event => event.type === 'tool_result')
    expect(result.result.answer).toBe('minor')
  })
})
