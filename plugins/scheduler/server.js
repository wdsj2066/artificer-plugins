/**
 * 定时任务插件后端入口
 *
 * 能力：
 *  - REST API：任务 CRUD、启停、立即执行、执行历史、cron 校验
 *  - AI 工具：创建 / 列出 / 更新 / 删除 / 立即执行定时任务
 *  - 生命周期：onEnable 加载持久化任务并启动调度器，onDisable/onDestroy 停止
 *
 * 路径前缀：/api/plugins/scheduler
 */

import { SchedulerCore } from './schedulerCore.js'

let core = null

export function register(ctx) {
  if (!ctx.sessions?.chat || !ctx.workspaces?.list) throw new Error('定时任务插件需要 Artificer 1.1.6 或更高版本')
  core = new SchedulerCore(ctx)
  const instance = core
  ctx.disposeWithPlugin?.(() => instance.stop())

  // ============================================================
  // AI 工具
  // ============================================================
  const scheduleProps = {
    type: {
      type: 'string',
      enum: ['cron', 'interval'],
      description: '调度方式：cron 表达式 或 固定时间间隔'
    },
    cron: { type: 'string', description: 'cron 表达式（5 段：分 时 日 月 周，如 "*/5 * * * *"）' },
    timezone: { type: 'string', description: 'cron 时区，默认 Asia/Shanghai（北京时间）' },
    misfirePolicy: { type: 'string', enum: ['skip', 'run-once'], description: '停机期间错过执行时：skip=跳过，run-once=启动后补执行一次；默认 skip' },
    interval: { type: 'number', description: '间隔数值（interval 调度时使用）' },
    unit: { type: 'string', enum: ['second', 'minute', 'hour', 'day'], description: '间隔单位（interval 调度时使用）' }
  }
  const actionProps = {
    type: {
      type: 'string',
      enum: ['agent', 'shell', 'http'],
      description: '动作类型：agent=向会话发送提示词触发智能体，shell=执行命令，http=发起 HTTP 请求'
    },
    message: { type: 'string', description: 'agent 动作：发送给智能体的提示词' },
    sessionId: { type: 'string', description: 'agent 动作：可选，目标会话 ID。留空则每次执行时自动创建新会话（推荐，适合独立任务）' },
    agentId: { type: 'string', description: 'agent 动作：可选，新建会话时绑定的智能体 ID，留空使用默认智能体' },
    approvalMode: { type: 'string', enum: ['allow', 'block'], description: 'agent 动作：可选，allow=自动放行工具执行（shell/网络请求等，请仅在任务可信时开启），block=拦截需确认的工具，默认 block' },
    model: { type: 'string', description: 'agent 动作：可选，指定模型' },
    scenarioId: { type: 'string', description: 'agent 动作：可选，指定场景 ID' },
    workspaceId: { type: 'string', description: 'agent 动作：可选，新建会话归属的工作区 ID。留空则自动收拢到"定时任务"工作区（不存在时自动创建）' },
    command: { type: 'string', description: 'shell 动作：要执行的命令' },
    cwd: { type: 'string', description: 'shell 动作：可选，工作目录' },
    url: { type: 'string', description: 'http 动作：请求 URL' },
    method: { type: 'string', description: 'http 动作：请求方法，默认 GET' },
    headers: { type: 'object', description: 'http 动作：可选，请求头对象' },
    body: { type: 'string', description: 'http 动作：可选，请求体' },
    timeout: { type: 'number', description: '可选，执行超时秒数（shell/http），默认取插件设置' }
  }

  const tools = [
    {
      id: 'createScheduledTask',
      name: '创建定时任务',
      description:
        '创建定时任务：按 cron 表达式或固定间隔调度，到期执行 Agent 提示词、Shell 命令或 HTTP 请求。创建后立即启用并开始调度。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '任务名称' },
          enabled: { type: 'boolean', description: '是否启用，默认 true' },
          schedule: { type: 'object', properties: scheduleProps, required: ['type'], description: '调度配置' },
          action: { type: 'object', properties: actionProps, required: ['type'], description: '动作配置' }
        },
        required: ['name', 'schedule', 'action']
      },
      tags: ['scheduler', 'sensitive'],
      handler: async args => {
        const task = core.createTask(args)
        return { success: true, task }
      }
    },
    {
      id: 'listScheduledTasks',
      name: '列出定时任务',
      description: '列出全部定时任务（含调度、动作、下次执行时间、最近状态与执行次数）。',
      parameters: { type: 'object', properties: {} },
      tags: ['scheduler', 'readonly'],
      handler: async () => ({ success: true, tasks: core.listTasks() })
    },
    {
      id: 'updateScheduledTask',
      name: '更新定时任务',
      description: '更新定时任务的名称、启用状态、调度或动作配置；更新调度后重新计算下次执行时间。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '任务 ID' },
          name: { type: 'string', description: '新名称' },
          enabled: { type: 'boolean', description: '启用 / 禁用' },
          schedule: { type: 'object', properties: scheduleProps, description: '新调度配置' },
          action: { type: 'object', properties: actionProps, description: '新动作配置' }
        },
        required: ['id']
      },
      tags: ['scheduler', 'sensitive'],
      handler: async args => {
        const { id, ...patch } = args
        const task = core.updateTask(id, patch)
        return { success: true, task }
      }
    },
    {
      id: 'deleteScheduledTask',
      name: '删除定时任务',
      description: '删除指定定时任务及其执行历史。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '任务 ID' } },
        required: ['id']
      },
      tags: ['scheduler', 'sensitive'],
      handler: async args => {
        const deleted = core.deleteTask(args.id)
        if (!deleted) throw new Error(`任务不存在: ${args.id}`)
        return { success: true, deleted }
      }
    },
    {
      id: 'runScheduledTask',
      name: '立即执行定时任务',
      description: '立即执行一次指定定时任务（不改变原有调度节奏）。任务正在执行时调用会失败。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '任务 ID' } },
        required: ['id']
      },
      tags: ['scheduler', 'sensitive'],
      handler: async args => {
        const task = await core.runNow(args.id)
        return { success: true, task }
      }
    }
  ]
  for (const tool of tools) {
    if (typeof ctx.registerTool === 'function') ctx.registerTool(tool)
  }

  // ============================================================
  // REST API
  // ============================================================
  const { registerRoute } = ctx

  // 任务列表
  registerRoute({
    method: 'GET',
    path: '/api/plugins/scheduler/tasks',
    async handler() {
      return { success: true, data: core.listTasks() }
    }
  })

  // 创建任务
  registerRoute({
    method: 'POST',
    path: '/api/plugins/scheduler/tasks',
    async handler({ body }) {
      const task = core.createTask(body || {})
      return { success: true, data: task }
    }
  })

  // 任务详情
  registerRoute({
    method: 'GET',
    path: '/api/plugins/scheduler/tasks/:id',
    async handler({ params }) {
      const task = core.getTask(params.id)
      if (!task) return { success: false, error: `任务不存在: ${params.id}`, code: 'NOT_FOUND' }
      return { success: true, data: task }
    }
  })

  // 更新任务
  registerRoute({
    method: 'PUT',
    path: '/api/plugins/scheduler/tasks/:id',
    async handler({ params, body }) {
      const task = core.updateTask(params.id, body || {})
      return { success: true, data: task }
    }
  })

  // 删除任务
  registerRoute({
    method: 'DELETE',
    path: '/api/plugins/scheduler/tasks/:id',
    async handler({ params }) {
      const deleted = core.deleteTask(params.id)
      if (!deleted) return { success: false, error: `任务不存在: ${params.id}`, code: 'NOT_FOUND' }
      return { success: true, data: { deleted: true } }
    }
  })

  // 启用 / 禁用
  registerRoute({
    method: 'POST',
    path: '/api/plugins/scheduler/tasks/:id/toggle',
    async handler({ params, body }) {
      const enabled = !!(body && body.enabled !== undefined ? body.enabled : !core.getTask(params.id)?.enabled)
      const task = core.setEnabled(params.id, enabled)
      return { success: true, data: task }
    }
  })

  // 立即执行
  registerRoute({
    method: 'POST',
    path: '/api/plugins/scheduler/tasks/:id/run',
    async handler({ params }) {
      const task = await core.runNow(params.id)
      return { success: true, data: task }
    }
  })

  // 执行历史
  registerRoute({
    method: 'GET',
    path: '/api/plugins/scheduler/runs',
    async handler({ query }) {
      return { success: true, data: core.listRuns(query && query.limit) }
    }
  })

  // cron 表达式校验
  registerRoute({
    method: 'GET',
    path: '/api/plugins/scheduler/validate',
    async handler({ query }) {
      const cron = query && query.cron
      if (!cron) return { success: false, error: '缺少 cron 参数', code: 'BAD_REQUEST' }
      try {
        const result = core.validateCron(cron)
        return { success: true, data: result }
      } catch (e) {
        return { success: false, error: e.message, code: 'INVALID_CRON' }
      }
    }
  })

  ctx.logger.info('Scheduler plugin registered')
}

// ============================================================
// 生命周期
// ============================================================

export async function onEnable() {
  if (!core) return
  core.load()
  core.start()
}

export async function onDisable() {
  if (!core) return
  core.stop()
}

export async function onDestroy() {
  if (!core) return
  core.stop()
}
