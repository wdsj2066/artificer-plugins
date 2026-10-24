import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { register, onEnable, onDisable, onDestroy } from '../../plugins/scheduler/server.js'

const manifest = JSON.parse(readFileSync(new URL('../../plugins/scheduler/plugin.json', import.meta.url)))
const taskInput = () => ({ name: '测试任务', schedule: { type: 'interval', interval: 10, unit: 'minute' }, action: { type: 'agent', message: '执行', sessionId: 's-1' } })

describe('外部定时任务插件', () => {
  let tools, routes, data, ctx, dispose
  const route = (method, path) => routes.find(item => item.method === method && item.path === `/api/plugins/scheduler${path}`)
  beforeEach(async () => {
    tools = new Map()
    routes = []
    data = new Map()
    ctx = {
      pluginId: 'scheduler',
      sessions: { exists: vi.fn(() => true), chat: vi.fn(async () => ({ response: 'ok', status: 'completed' })) },
      workspaces: { list: vi.fn(async () => []) },
      getStore: () => ({ get: key => structuredClone(data.get(key)), set: (key, value) => data.set(key, structuredClone(value)) }),
      getSettings: () => ({}),
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      registerTool: tool => tools.set(tool.id, tool),
      registerRoute: item => routes.push(item),
      disposeWithPlugin: fn => { dispose = fn }
    }
    register(ctx)
    await onEnable()
  })
  afterEach(async () => { await onDestroy(); vi.useRealTimers() })

  it('保留插件身份、显式菜单和右侧面板声明', () => {
    expect(manifest.id).toBe('scheduler')
    expect(manifest.ui.view).toBe('view.vue')
    expect(manifest.ui.navItems[0].route).toBe('/plugin/scheduler')
    expect(manifest.ui.panels[0]).toMatchObject({ region: 'right', component: 'panel.vue' })
    expect(manifest.engines.artificer).toBe('>=1.1.6')
  })
  it('注册全部工具与路由，创建任务并使用宿主会话 SDK 执行', async () => {
    expect([...tools.keys()]).toEqual(['createScheduledTask', 'listScheduledTasks', 'updateScheduledTask', 'deleteScheduledTask', 'runScheduledTask'])
    for (const [method, path] of [['GET', '/tasks'], ['POST', '/tasks'], ['PUT', '/tasks/:id'], ['DELETE', '/tasks/:id'], ['POST', '/tasks/:id/toggle'], ['POST', '/tasks/:id/run'], ['GET', '/runs'], ['GET', '/validate']]) {
      expect(route(method, path), `${method} ${path}`).toBeDefined()
    }
    const created = await route('POST', '/tasks').handler({ body: taskInput() })
    expect(created.success).toBe(true)
    expect(data.get('tasks')[0].id).toBe(created.data.id)
    const run = await tools.get('runScheduledTask').handler({ id: created.data.id })
    expect(run.success).toBe(true)
    expect(ctx.sessions.chat).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's-1', message: '执行', approvalMode: 'block' }))
    expect((await route('GET', '/tasks').handler({})).data).toHaveLength(1)
  })
  it('重新注册后复用原插件存储中的任务和历史', async () => {
    const { task } = await tools.get('createScheduledTask').handler(taskInput())
    await tools.get('runScheduledTask').handler({ id: task.id })
    await onDisable()
    register(ctx)
    await onEnable()
    expect((await tools.get('listScheduledTasks').handler({})).tasks[0].id).toBe(task.id)
    expect(data.get('runs')).toHaveLength(1)
  })
  it('禁用与实例释放都会停止调度，重新启用后恢复', async () => {
    vi.useFakeTimers()
    await tools.get('createScheduledTask').handler({ ...taskInput(), schedule: { type: 'interval', interval: 1, unit: 'second' } })
    await onDisable()
    await vi.advanceTimersByTimeAsync(3000)
    expect(ctx.sessions.chat).not.toHaveBeenCalled()
    await onEnable()
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctx.sessions.chat).toHaveBeenCalled()
    ctx.sessions.chat.mockClear()
    dispose()
    await vi.advanceTimersByTimeAsync(3000)
    expect(ctx.sessions.chat).not.toHaveBeenCalled()
  })
  it('校验错误通过路由返回，缺失宿主 SDK 时明确拒绝加载', async () => {
    await expect(route('POST', '/tasks').handler({ body: {} })).rejects.toThrow('任务名称不能为空')
    expect((await route('GET', '/validate').handler({ query: { cron: 'bad' } })).success).toBe(false)
    expect(() => register({})).toThrow('1.1.6')
  })
})
