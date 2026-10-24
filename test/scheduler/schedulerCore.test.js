/**
 * scheduler/schedulerCore.test.js - 定时任务调度核心
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

import { SchedulerCore } from '../../plugins/scheduler/schedulerCore.js'
const sessionManager = { sessionExists: vi.fn(() => true), deleteSession: vi.fn() }
const chatService = { chat: vi.fn() }
const sessionService = { create: vi.fn(() => ({ sessionId: 'sess-auto-1' })) }
const workspaceStorage = { listAll: vi.fn(() => []), create: vi.fn(() => ({ id: 'ws-scheduler-test' })) }

function createMockStore() {
  const data = new Map()
  return {
    data,
    get: vi.fn(k => data.get(k)),
    set: vi.fn((k, v) => { data.set(k, v) })
  }
}

function createCore(overrides = {}) {
  const store = overrides.store || createMockStore()
  const core = new SchedulerCore({
    pluginId: 'scheduler',
    sessions: {
      exists: (...args) => sessionManager.sessionExists(...args),
      create: (...args) => sessionService.create(...args),
      delete: (...args) => sessionManager.deleteSession(...args),
      chat: (...args) => chatService.chat(...args)
    },
    workspaces: {
      list: (...args) => workspaceStorage.listAll(...args),
      create: (...args) => workspaceStorage.create(...args)
    },
    getStore: () => store,
    getSettings: overrides.getSettings || (() => ({})),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  })
  return { core, store }
}

function baseInput(overrides = {}) {
  return {
    name: '测试任务',
    schedule: { type: 'interval', interval: 5, unit: 'minute' },
    action: { type: 'agent', message: '执行一次', sessionId: 'sess-1' },
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  chatService.chat.mockResolvedValue({ response: 'ok', status: 'completed' })
  sessionManager.sessionExists.mockReturnValue(true)
})

describe('插件设置 API', () => {
  it('通过上下文读取最新设置，不缓存初次读取的值', () => {
    const settings = { maxConcurrentRuns: 2 }
    const { core } = createCore({ getSettings: () => settings })
    expect(core.getSettings().maxConcurrentRuns).toBe(2)
    settings.maxConcurrentRuns = 8
    expect(core.getSettings().maxConcurrentRuns).toBe(8)
  })

  it('宿主读取设置失败时记录日志并采用默认值', () => {
    const { core } = createCore({ getSettings: () => { throw new Error('读取失败') } })
    expect(core.getSettings().maxConcurrentRuns).toBe(4)
    expect(core.logger.warn).toHaveBeenCalledWith(expect.stringContaining('读取失败'))
  })
})

describe('createTask', () => {
  it('创建合法的间隔任务并计算 nextRunAt', () => {
    const { core } = createCore()
    const now = Date.now()
    const task = core.createTask(baseInput())
    expect(task.id).toBeTruthy()
    expect(task.enabled).toBe(true)
    expect(task.nextRunAt).toBeGreaterThanOrEqual(now + 5 * 60 * 1000)
    expect(task.runCount).toBe(0)
  })

  it('创建合法的 cron 任务', () => {
    const { core } = createCore()
    const task = core.createTask(baseInput({ schedule: { type: 'cron', cron: '*/5 * * * *' } }))
    expect(task.nextRunAt).toBeGreaterThan(Date.now())
  })

  it('缺少名称时抛错', () => {
    const { core } = createCore()
    expect(() => core.createTask(baseInput({ name: '  ' }))).toThrow(/名称/)
  })

  it('非法调度类型抛错', () => {
    const { core } = createCore()
    expect(() => core.createTask(baseInput({ schedule: { type: 'monthly' } }))).toThrow(/调度类型/)
  })

  it('非法 cron 表达式抛错', () => {
    const { core } = createCore()
    expect(() => core.createTask(baseInput({ schedule: { type: 'cron', cron: '99 * * * *' } }))).toThrow()
  })

  it('缺少动作类型抛错', () => {
    const { core } = createCore()
    expect(() => core.createTask(baseInput({ action: { message: 'x' } }))).toThrow(/动作类型/)
  })

  it('agent 动作缺少 message 抛错', () => {
    const { core } = createCore()
    expect(() => core.createTask(baseInput({ action: { type: 'agent', sessionId: 's1' } }))).toThrow(/message/)
  })

  it('http 动作缺少 url 抛错', () => {
    const { core } = createCore()
    expect(() => core.createTask(baseInput({ action: { type: 'http' } }))).toThrow(/url/)
  })

  it('创建后持久化到 store', () => {
    const { core, store } = createCore()
    core.createTask(baseInput())
    expect(store.set).toHaveBeenCalledWith('tasks', expect.any(Array))
  })
})

describe('updateTask / setEnabled / deleteTask', () => {
  it('更新名称与调度后重算 nextRunAt', () => {
    const { core } = createCore()
    const task = core.createTask(baseInput())
    const oldNext = task.nextRunAt
    const updated = core.updateTask(task.id, {
      name: '新名字',
      schedule: { type: 'interval', interval: 1, unit: 'hour' }
    })
    expect(updated.name).toBe('新名字')
    expect(updated.nextRunAt).toBeGreaterThan(oldNext)
  })

  it('禁用后 nextRunAt 置空，恢复后重新计算', () => {
    const { core } = createCore()
    const task = core.createTask(baseInput())
    const disabled = core.setEnabled(task.id, false)
    expect(disabled.enabled).toBe(false)
    expect(disabled.nextRunAt).toBeNull()
    const reEnabled = core.setEnabled(task.id, true)
    expect(reEnabled.enabled).toBe(true)
    expect(reEnabled.nextRunAt).toBeGreaterThan(Date.now())
  })

  it('删除任务同时清理其执行历史', () => {
    const { core } = createCore()
    const task = core.createTask(baseInput())
    core.runs.push({ id: 'r1', taskId: task.id, taskName: task.name })
    core.runs.push({ id: 'r2', taskId: 'other' })
    expect(core.deleteTask(task.id)).toBe(true)
    expect(core.getTask(task.id)).toBeNull()
    expect(core.runs.map(r => r.id)).toEqual(['r2'])
  })

  it('删除不存在的任务返回 false', () => {
    const { core } = createCore()
    expect(core.deleteTask('nope')).toBe(false)
  })
})

describe('执行', () => {
  it('runNow 执行 agent 动作并记录历史', async () => {
    const { core, store } = createCore()
    const task = core.createTask(baseInput())
    const result = await core.runNow(task.id)

    expect(chatService.chat).toHaveBeenCalledWith(
      expect.objectContaining({ message: '执行一次', sessionId: 'sess-1', approvalMode: 'block' })
    )
    expect(result.runCount).toBe(1)
    expect(result.lastStatus).toBe('success')
    const runs = store.data.get('runs')
    expect(runs).toHaveLength(1)
    expect(runs[0].taskId).toBe(task.id)
    expect(runs[0].status).toBe('success')
  })

  it('未指定 sessionId 时自动创建新会话并执行', async () => {
    const { core } = createCore()
    const task = core.createTask(baseInput({
      action: { type: 'agent', message: '自动会话', agentId: 'agent-9' }
    }))
    const result = await core.runNow(task.id)

    expect(workspaceStorage.create).toHaveBeenCalledWith({
      name: '定时任务',
      type: 'virtual',
      description: '定时任务自动创建的会话收拢工作区'
    })
    expect(sessionService.create).toHaveBeenCalledWith({
      agentId: 'agent-9',
      workspaceId: 'ws-scheduler-test'
    })
    expect(chatService.chat).toHaveBeenCalledWith(
      expect.objectContaining({ message: '自动会话', sessionId: 'sess-auto-1' })
    )
    expect(result.lastStatus).toBe('success')
  })

  it('approvalMode=allow 时透传给 chatService', async () => {
    const { core } = createCore()
    const task = core.createTask(baseInput({
      action: { type: 'agent', message: '自动执行', approvalMode: 'allow' }
    }))
    await core.runNow(task.id)

    expect(chatService.chat).toHaveBeenCalledWith(
      expect.objectContaining({ approvalMode: 'allow' })
    )
  })

  it('新建会话执行失败时清理会话', async () => {
    chatService.chat.mockRejectedValue(new Error('模型不可用'))
    sessionManager.deleteSession = vi.fn()
    const { core } = createCore()
    const task = core.createTask(baseInput({
      action: { type: 'agent', message: '自动会话失败' }
    }))
    await core.runNow(task.id)

    expect(sessionManager.deleteSession).toHaveBeenCalledWith('sess-auto-1')
    const t = core.getTask(task.id)
    expect(t.lastStatus).toBe('error')
  })

  it('agent 会话不存在时记录失败而非崩溃', async () => {
    sessionManager.sessionExists.mockReturnValue(false)
    const { core, store } = createCore()
    const task = core.createTask(baseInput())
    await core.runNow(task.id)

    const t = core.getTask(task.id)
    expect(t.lastStatus).toBe('error')
    expect(t.lastSummary).toContain('会话不存在')
    const runs = store.data.get('runs')
    expect(runs[0].status).toBe('error')
    expect(runs[0].error).toContain('会话不存在')
  })

  it('chatService 抛错时记录失败且不向外抛出', async () => {
    chatService.chat.mockRejectedValue(new Error('模型不可用'))
    const { core, store } = createCore()
    const task = core.createTask(baseInput())
    await expect(core.runNow(task.id)).resolves.toBeTruthy()

    const t = core.getTask(task.id)
    expect(t.lastStatus).toBe('error')
    const runs = store.data.get('runs')
    expect(runs[0].error).toContain('模型不可用')
  })

  it('shell 动作执行失败被捕获为 error 状态', async () => {
    const { core, store } = createCore()
    const task = core.createTask(baseInput({
      action: { type: 'shell', command: 'exit 1' }
    }))
    await core.runNow(task.id)
    expect(core.getTask(task.id).lastStatus).toBe('error')
    expect(store.data.get('runs')[0].status).toBe('error')
  })

  it('HTTP 非 2xx 响应记录为失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, statusText: 'Server Error', text: async () => 'boom' })))
    const { core } = createCore()
    const task = core.createTask(baseInput({ action: { type: 'http', url: 'https://example.com' } }))

    await core.runNow(task.id)

    expect(core.getTask(task.id).lastStatus).toBe('error')
    expect(core.getTask(task.id).lastSummary).toContain('500')
    vi.unstubAllGlobals()
  })

  it('运行中的任务不可重复 runNow', async () => {
    let resolveChat
    chatService.chat.mockImplementation(() => new Promise(r => { resolveChat = r }))
    const { core } = createCore()
    const task = core.createTask(baseInput())

    const first = core.runNow(task.id)
    await expect(core.runNow(task.id)).rejects.toThrow(/正在执行/)
    resolveChat({ response: 'ok', status: 'completed' })
    await first
  })

  it('执行历史超过 historyLimit 时截断', async () => {
    const store = createMockStore()
    const { core } = createCore({ store })
    const task = core.createTask(baseInput())
    for (let i = 0; i < 5; i++) {
      await core.runNow(task.id)
    }
    core.getSettings = () => ({ historyLimit: 3, defaultTimeout: 60, tickInterval: 1000 })
    await core.runNow(task.id)
    expect(store.data.get('runs')).toHaveLength(3)
  })

  it('删除运行中的任务不会在结束后回写执行历史', async () => {
    let resolveChat
    chatService.chat.mockImplementation(() => new Promise(resolve => { resolveChat = resolve }))
    const { core, store } = createCore()
    const task = core.createTask(baseInput())
    const running = core.runNow(task.id)
    await vi.waitFor(() => expect(core._running.has(task.id)).toBe(true))

    core.deleteTask(task.id)
    resolveChat({ response: 'ok', status: 'completed' })
    await running

    expect(core.getTask(task.id)).toBeNull()
    expect(store.data.get('runs') || []).toHaveLength(0)
  })

  it('超过全局并发上限的任务进入队列', async () => {
    let resolveFirst
    chatService.chat.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
    chatService.chat.mockResolvedValueOnce({ response: 'second', status: 'completed' })
    const { core } = createCore()
    core.getSettings = () => ({ historyLimit: 100, defaultTimeout: 60, tickInterval: 1000, maxConcurrentRuns: 1 })
    const first = core.createTask(baseInput({ id: 'first' }))
    const second = core.createTask(baseInput({ id: 'second' }))
    const firstRun = core.runNow(first.id)
    await vi.waitFor(() => expect(core._running.has(first.id)).toBe(true))
    const secondRun = core.runNow(second.id)
    expect(core._queued.has(second.id)).toBe(true)
    expect(chatService.chat).toHaveBeenCalledTimes(1)

    resolveFirst({ response: 'first', status: 'completed' })
    await Promise.all([firstRun, secondRun])
    expect(chatService.chat).toHaveBeenCalledTimes(2)
  })
})

describe('心跳调度 _tick', () => {
  it('到期任务被触发执行并推进 nextRunAt', async () => {
    const { core } = createCore()
    const task = core.createTask(baseInput())
    const internal = core.getTask(task.id)
    // 人为将 nextRunAt 置为过去，模拟到期
    internal.nextRunAt = Date.now() - 1000

    core._tick()
    await vi.waitFor(() => expect(internal.runCount).toBe(1))
    expect(internal.nextRunAt).toBeGreaterThan(Date.now())
  })

  it('禁用的任务不触发', async () => {
    const { core } = createCore()
    const task = core.createTask(baseInput({ enabled: false }))
    const internal = core.getTask(task.id)
    internal.nextRunAt = Date.now() - 1000
    core._tick()
    await new Promise(r => setTimeout(r, 20))
    expect(internal.runCount).toBe(0)
  })

  it('nextRunAt 缺失时补算而不执行', async () => {
    const { core } = createCore()
    const task = core.createTask(baseInput())
    const internal = core.getTask(task.id)
    internal.nextRunAt = null
    core._tick()
    await new Promise(r => setTimeout(r, 20))
    expect(internal.runCount).toBe(0)
    expect(internal.nextRunAt).toBeGreaterThan(Date.now())
  })

  it('执行中的任务不重复触发', async () => {
    let resolveChat
    chatService.chat.mockImplementation(() => new Promise(r => { resolveChat = r }))
    const { core } = createCore()
    const task = core.createTask(baseInput())
    const internal = core.getTask(task.id)
    internal.nextRunAt = Date.now() - 1000

    core._tick()
    await new Promise(r => setTimeout(r, 10))
    expect(internal.runCount).toBe(0) // 仍在执行中（未完成）
    core._tick()
    await new Promise(r => setTimeout(r, 10))
    expect(chatService.chat).toHaveBeenCalledTimes(1)
    resolveChat({ response: 'ok', status: 'completed' })
    await vi.waitFor(() => expect(internal.runCount).toBe(1))
  })
})

describe('持久化加载 load()', () => {
  it('从 store 恢复任务并补算过期 nextRunAt', () => {
    const store = createMockStore()
    store.data.set('tasks', [{
      id: 't1',
      name: '旧任务',
      enabled: true,
      schedule: { type: 'interval', interval: 10, unit: 'minute' },
      action: { type: 'http', url: 'https://example.com' },
      nextRunAt: Date.now() - 5000,
      lastRunAt: null,
      runCount: 0,
      lastStatus: null,
      lastSummary: null,
      createdAt: 1,
      updatedAt: 1
    }])
    const { core } = createCore({ store })
    core.load()
    expect(core.tasks).toHaveLength(1)
    expect(core.tasks[0].nextRunAt).toBeGreaterThan(Date.now())
    expect(store.set).toHaveBeenCalledWith('tasks', expect.any(Array))
  })

  it('空 store 时初始化为空数组', () => {
    const { core } = createCore()
    core.load()
    expect(core.tasks).toEqual([])
    expect(core.runs).toEqual([])
  })

  it('run-once 错过策略会保留过期时间供启动后的首次 tick 补执行', () => {
    const store = createMockStore()
    const past = Date.now() - 5000
    store.data.set('tasks', [{
      id: 'catch-up', name: '补执行任务', enabled: true,
      schedule: { type: 'interval', interval: 10, unit: 'minute', misfirePolicy: 'run-once' },
      action: { type: 'http', url: 'https://example.com' }, nextRunAt: past, lastRunAt: null, runCount: 0
    }])
    const { core } = createCore({ store })

    core.load()

    expect(core.tasks[0].nextRunAt).toBe(past)
  })
})
