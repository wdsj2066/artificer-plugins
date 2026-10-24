/**
 * SchedulerCore — 定时任务调度核心
 *
 * 职责：
 *  - 任务与执行历史的持久化（经 ctx.getStore() 写入 plugin_store.db，按插件隔离）
 *  - cron / 时间间隔两种调度方式的到期计算与心跳触发
 *  - 三种动作执行：Agent 提示词（ctx.sessions.chat 非流式）、Shell 命令、HTTP 请求
 *  - 防重入（同一任务未结束时不会再次触发）、单任务失败不影响整体调度
 */

import { randomUUID } from 'crypto'
import { exec } from 'child_process'
import { promisify } from 'util'
import { parseCron, nextAfter } from './cronParser.js'

const execAsync = promisify(exec)

export const PLUGIN_ID = 'scheduler'

/** 定时任务 agent 会话默认收拢的工作区名称（不存在时自动创建） */
export const SCHEDULER_WORKSPACE_NAME = '定时任务'

export const ACTION_TYPES = ['agent', 'shell', 'http']
export const SCHEDULE_TYPES = ['cron', 'interval']

export const INTERVAL_UNITS = {
  second: 1000,
  minute: 60 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000
}

const SUMMARY_LIMIT = 500
const DETAIL_LIMIT = 2000

export class SchedulerCore {
  constructor(ctx) {
    this.store = ctx.getStore()
    this.logger = ctx.logger
    this.pluginId = ctx.pluginId
    this.sessions = ctx.sessions
    this.workspaces = ctx.workspaces
    this._getSettings = () => ctx.getSettings?.() || {}
    this.tasks = []
    this.runs = []
    this._timer = null
    this._started = false
    this._running = new Map() // taskId -> true（内存态，不持久化）
    this._queued = new Map() // taskId -> { task, resolve, reject }（等待全局并发槽）
    this._activeRuns = 0
  }

  // ============================================================
  // 设置
  // ============================================================

  getSettings() {
    let s = {}
    try {
      s = this._getSettings()
    } catch (e) {
      // 设置存储未初始化时兜底使用默认值，不阻断调度器启动
      if (this.logger?.warn) this.logger.warn(`Scheduler settings unavailable, using defaults: ${e.message}`)
    }
    return {
      historyLimit: clampInt(s.historyLimit, 10, 1000, 100),
      defaultTimeout: clampInt(s.defaultTimeout, 5, 3600, 60),
      tickInterval: clampInt(s.tickInterval, 200, 60000, 1000),
      maxConcurrentRuns: clampInt(s.maxConcurrentRuns, 1, 20, 4)
    }
  }

  // ============================================================
  // 持久化
  // ============================================================

  load() {
    const tasks = this.store.get('tasks')
    this.tasks = Array.isArray(tasks) ? tasks.filter(t => t && typeof t.id === 'string') : []
    const runs = this.store.get('runs')
    this.runs = Array.isArray(runs) ? runs.filter(r => r && typeof r.id === 'string') : []

    // 停机期间的任务默认跳过错过的时间点，从当前时间重新计算下一次执行。
    const now = Date.now()
    let changed = false
    for (const task of this.tasks) {
      if (!task.enabled) continue
      if (task.nextRunAt == null) {
        task.nextRunAt = this._computeNextRun(task, now)
        changed = true
      } else if (task.nextRunAt <= now && task.schedule?.misfirePolicy !== 'run-once') {
        task.nextRunAt = this._computeNextRun(task, now)
        changed = true
      }
    }
    if (changed) this._persist()
    this.logger.info(`Scheduler loaded: ${this.tasks.length} tasks, ${this.runs.length} runs`)
  }

  _persist() {
    try {
      this.store.set('tasks', this.tasks)
      this.store.set('runs', this.runs)
    } catch (e) {
      this.logger.error(`Scheduler persist failed: ${e.message}`)
    }
  }

  // ============================================================
  // 调度器生命周期
  // ============================================================

  start() {
    if (this._started) return
    this._started = true
    this._tick() // 启动立即检查一次（补执行停机期间到期的任务）
    const interval = this.getSettings().tickInterval
    this._timer = setInterval(() => this._tick(), interval)
    if (this._timer.unref) this._timer.unref()
    this.logger.info(`Scheduler started (tick ${interval}ms)`)
  }

  stop() {
    this._started = false
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
    this._cancelQueued('调度器已停止')
    this.logger.info('Scheduler stopped')
  }

  _tick() {
    const now = Date.now()
    for (const task of this.tasks) {
      if (!task.enabled) continue
      if (this._running.has(task.id) || this._queued.has(task.id)) continue // 防重入/重复排队

      if (task.nextRunAt == null) {
        task.nextRunAt = this._computeNextRun(task, now)
        this._persist()
        continue
      }
      if (task.nextRunAt <= now) {
        // 先在触发前计算下一次，避免本次 tick 内重复触发
        task.nextRunAt = this._computeNextRun(task, now)
        this._persist()
        this._enqueue(task).catch(() => {})
      }
    }
  }

  // ============================================================
  // 任务 CRUD
  // ============================================================

  listTasks() {
    return this.tasks
      .slice()
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .map(t => this._toPublic(t))
  }

  getTask(id) {
    return this.tasks.find(t => t.id === id) || null
  }

  createTask(input = {}) {
    const now = Date.now()
    const task = {
      id: input.id || randomUUID(),
      name: String(input.name || '').trim(),
      enabled: input.enabled !== false,
      schedule: input.schedule || null,
      action: input.action || null,
      lastRunAt: null,
      nextRunAt: null,
      runCount: 0,
      lastStatus: null,
      lastSummary: null,
      createdAt: now,
      updatedAt: now
    }
    this.validateTask(task)
    if (this.getTask(task.id) || this._running.has(task.id) || this._queued.has(task.id)) {
      throw new Error(`任务 ID 已存在: ${task.id}`)
    }
    if (task.enabled) {
      task.nextRunAt = this._computeNextRun(task, now)
    }
    this.tasks.push(task)
    this._persist()
    this.logger.info(`Scheduled task created: ${task.name} (${task.id})`)
    return this._toPublic(task)
  }

  updateTask(id, patch = {}) {
    const task = this.getTask(id)
    if (!task) throw new Error(`任务不存在: ${id}`)

    // 先构造候选对象并校验，通过后再应用到真实任务，避免校验失败污染内存状态
    const candidate = { ...task }
    const updatable = ['name', 'enabled', 'schedule', 'action']
    for (const key of updatable) {
      if (patch[key] !== undefined) candidate[key] = patch[key]
    }
    if (patch.name !== undefined) candidate.name = String(patch.name || '').trim()
    this.validateTask(candidate)

    Object.assign(task, {
      name: candidate.name,
      enabled: candidate.enabled,
      schedule: candidate.schedule,
      action: candidate.action
    })

    // 更新调度后重算下次执行时间
    if (patch.schedule !== undefined || patch.enabled !== undefined) {
      task.nextRunAt = task.enabled ? this._computeNextRun(task, Date.now()) : null
    }
    task.updatedAt = Date.now()
    this._persist()
    this.logger.info(`Scheduled task updated: ${task.name} (${task.id})`)
    return this._toPublic(task)
  }

  setEnabled(id, enabled) {
    return this.updateTask(id, { enabled: !!enabled })
  }

  deleteTask(id) {
    const task = this.getTask(id)
    if (!task) return false
    this.tasks = this.tasks.filter(t => t.id !== id)
    this.runs = this.runs.filter(r => r.taskId !== id) // 清理孤儿历史
    task._deleted = true
    const queued = this._queued.get(id)
    if (queued) {
      this._queued.delete(id)
      queued.reject(new Error(`任务已删除: ${task.name}`))
    }
    this._persist()
    this.logger.info(`Scheduled task deleted: ${task.name} (${id})`)
    return true
  }

  /** 立即执行一次（不改变调度节奏），失败时抛错由调用方处理 */
  async runNow(id) {
    const task = this.getTask(id)
    if (!task) throw new Error(`任务不存在: ${id}`)
    if (this._running.has(id)) throw new Error(`任务正在执行中: ${task.name}`)
    if (!task.enabled) {
      // 手动执行不要求任务处于启用状态，但需保证后续调度字段一致性
      task.nextRunAt = task.nextRunAt || this._computeNextRun(task, Date.now())
      this._persist()
    }
    await this._enqueue(task)
    return this._toPublic(task)
  }

  listRuns(limit = 50) {
    return this.runs.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)))
  }

  /** 校验 cron 表达式，返回下一次匹配时间（校验用），非法时抛错 */
  validateCron(expr) {
    const parsed = parseCron(expr)
    const next = nextAfter(parsed, new Date(), 'Asia/Shanghai')
    return { valid: true, nextRunAt: next ? next.getTime() : null }
  }

  // ============================================================
  // 校验
  // ============================================================

  validateTask(task) {
    if (!task.name) throw new Error('任务名称不能为空')
    this.validateSchedule(task.schedule)
    this.validateAction(task.action)
  }

  validateSchedule(schedule) {
    if (!schedule || typeof schedule !== 'object') {
      throw new Error('缺少调度配置 schedule（{ type: "cron" | "interval", ... }）')
    }
    if (schedule.type === 'cron') {
      if (!schedule.cron || typeof schedule.cron !== 'string') {
        throw new Error('cron 调度缺少表达式 schedule.cron')
      }
      parseCron(schedule.cron) // 非法表达式在此抛错
      const timeZone = schedule.timezone || 'Asia/Shanghai'
      try { new Intl.DateTimeFormat('en-US', { timeZone }) } catch { throw new Error(`无效的时区: ${timeZone}`) }
    } else if (schedule.type === 'interval') {
      const interval = Number(schedule.interval)
      if (!Number.isFinite(interval) || interval <= 0) {
        throw new Error('interval 调度需要正数间隔 schedule.interval')
      }
      if (!INTERVAL_UNITS[schedule.unit]) {
        throw new Error(`无效的间隔单位: ${schedule.unit}（可选 second/minute/hour/day）`)
      }
    } else {
      throw new Error(`无效的调度类型: ${schedule.type}（可选 ${SCHEDULE_TYPES.join('/')}）`)
    }
    if (schedule.misfirePolicy !== undefined && !['skip', 'run-once'].includes(schedule.misfirePolicy)) {
      throw new Error('无效的错过执行策略：可选 skip/run-once')
    }
  }

  validateAction(action) {
    if (!action || typeof action !== 'object') {
      throw new Error('缺少动作配置 action（{ type: "agent" | "shell" | "http", ... }）')
    }
    if (action.type === 'agent') {
      if (!action.message || !String(action.message).trim()) {
        throw new Error('Agent 动作缺少 message（要发送给智能体的提示词）')
      }
    } else if (action.type === 'shell') {
      if (!action.command || !String(action.command).trim()) {
        throw new Error('Shell 动作缺少 command（要执行的命令）')
      }
    } else if (action.type === 'http') {
      if (!action.url || typeof action.url !== 'string') {
        throw new Error('HTTP 动作缺少 url')
      }
      try {
        new URL(action.url)
      } catch {
        throw new Error(`无效的 URL: ${action.url}`)
      }
    } else {
      throw new Error(`无效的动作类型: ${action.type}（可选 ${ACTION_TYPES.join('/')}）`)
    }
  }

  // ============================================================
  // 调度计算
  // ============================================================

  _computeNextRun(task, after) {
    const schedule = task.schedule || {}
    if (schedule.type === 'cron') {
      const parsed = parseCron(schedule.cron)
      const next = nextAfter(parsed, new Date(after), schedule.timezone || 'Asia/Shanghai')
      if (!next) {
        this.logger.warn(`Scheduled task "${task.name}" has no next run within 1 year`)
        return null
      }
      return next.getTime()
    }
    if (schedule.type === 'interval') {
      const unitMs = INTERVAL_UNITS[schedule.unit]
      const intervalMs = Number(schedule.interval) * unitMs
      // 以触发时刻为基准，避免长任务导致积压
      return Math.max(after, task.lastRunAt || 0) + intervalMs
    }
    return null
  }

  // ============================================================
  // 执行
  // ============================================================

  _enqueue(task) {
    if (this._running.has(task.id) || this._queued.has(task.id)) {
      return Promise.reject(new Error(`任务正在执行中: ${task.name}`))
    }
    return new Promise((resolve, reject) => {
      this._queued.set(task.id, { task, resolve, reject })
      this._drainQueue()
    })
  }

  _drainQueue() {
    const limit = clampInt(this.getSettings().maxConcurrentRuns, 1, 20, 4)
    while (this._activeRuns < limit && this._queued.size > 0) {
      const [id, entry] = this._queued.entries().next().value
      this._queued.delete(id)
      if (entry.task._deleted) {
        entry.reject(new Error(`任务已删除: ${entry.task.name}`))
        continue
      }
      this._activeRuns += 1
      this._execute(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          this._activeRuns -= 1
          this._drainQueue()
        })
    }
  }

  _cancelQueued(reason) {
    for (const entry of this._queued.values()) entry.reject(new Error(reason))
    this._queued.clear()
  }

  async _execute(task) {
    const startedAt = Date.now()
    this._running.set(task.id, true)
    let status = 'success'
    let summary = ''
    let error = null
    let runSessionId = null
    try {
      const action = task.action || {}
      const result =
        action.type === 'agent'
          ? await this._executeAgent(task, action)
          : action.type === 'shell'
            ? await this._executeShell(task, action)
            : action.type === 'http'
              ? await this._executeHttp(task, action)
              : (() => { throw new Error(`未知的动作类型: ${action.type}`) })()
      summary = (result && result.summary) || '执行成功'
      runSessionId = (result && result.detail && result.detail.sessionId) || null
    } catch (e) {
      status = 'error'
      error = e.message || String(e)
      summary = `失败: ${error}`
      this.logger.error(`Scheduled task "${task.name}" (${task.id}) failed: ${error}`)
    } finally {
      const finishedAt = Date.now()
      // 删除后的旧执行只负责收尾，不能把已删除任务或其历史写回存储。
      if (!task._deleted && this.getTask(task.id) === task) {
        task.lastRunAt = finishedAt
        task.runCount = (task.runCount || 0) + 1
        task.lastStatus = status
        task.lastSummary = summary
        this._recordRun(task, { startedAt, finishedAt, status, summary, error, sessionId: runSessionId })
        this._persist()
      }
      this._running.delete(task.id)
    }
    return this._toPublic(task)
  }

  /**
   * 确保"定时任务"工作区存在并返回其 ID（进程内缓存，避免并发重复创建）
   */
  async _ensureSchedulerWorkspace() {
    if (this._schedulerWorkspaceId) return this._schedulerWorkspaceId
    if (!this._schedulerWorkspacePromise) this._schedulerWorkspacePromise = (async () => {
      const ws = (await this.workspaces.list()).find(w => w.name === SCHEDULER_WORKSPACE_NAME)
      const workspace = ws || await this.workspaces.create({
          name: SCHEDULER_WORKSPACE_NAME,
          type: 'virtual',
          description: '定时任务自动创建的会话收拢工作区'
        })
      this._schedulerWorkspaceId = workspace.id
      return workspace.id
    })().finally(() => { this._schedulerWorkspacePromise = null })
    return this._schedulerWorkspacePromise
  }

  async _executeAgent(task, action) {
    const message = String(action.message || '').trim()
    let sessionId = action.sessionId || null
    let createdSession = false

    if (sessionId) {
      // 复用已有会话
      if (!await this.sessions.exists(sessionId)) {
        throw new Error(`会话不存在: ${sessionId}`)
      }
    } else {
      // 未指定会话：每次执行自动创建新会话（可绑定指定智能体，默认收拢到"定时任务"工作区）
      const workspaceId = action.workspaceId || await this._ensureSchedulerWorkspace()
      const created = await this.sessions.create({
        agentId: action.agentId || null,
        workspaceId
      })
      sessionId = created.sessionId
      createdSession = true
      this.logger.info(`Scheduled task "${task.name}" (${task.id}) created session: ${sessionId} in workspace: ${workspaceId}`)
    }

    try {
      const result = await this.sessions.chat({
        message,
        sessionId,
        model: action.model || undefined,
        scenarioId: action.scenarioId || undefined,
        approvalMode: action.approvalMode === 'allow' ? 'allow' : 'block'
      })

      const response = (result && result.response) || ''
      return {
        summary: `Agent 响应: ${truncate(response, SUMMARY_LIMIT)}`,
        detail: {
          status: result && result.status,
          sessionId,
          createdSession,
          agentId: action.agentId || null
        }
      }
    } catch (e) {
      // 新建的会话执行失败时清理，避免残留空会话
      if (createdSession) {
        try { await this.sessions.delete(sessionId) } catch { /* 忽略清理失败 */ }
      }
      throw e
    }
  }

  async _executeShell(task, action) {
    const command = String(action.command || '').trim()
    const settings = this.getSettings()
    const timeoutSec = clampInt(action.timeout, 5, 3600, settings.defaultTimeout)
    const timeoutMs = timeoutSec * 1000

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: action.cwd || undefined,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8'
      })
      const combined = [stdout, stderr].filter(Boolean).join('\n').trim()
      return {
        summary: combined
          ? `命令输出: ${truncate(combined, SUMMARY_LIMIT)}`
          : '命令执行成功（无输出）',
        detail: {
          exitCode: 0,
          stdout: truncate(stdout, DETAIL_LIMIT),
          stderr: truncate(stderr, DETAIL_LIMIT)
        }
      }
    } catch (error) {
      if (error && error.killed) {
        throw new Error(`命令执行超时（${timeoutSec} 秒）`)
      }
      const stderrText = String((error && (error.stderr || error.message)) || error).trim()
      const exitCode = error && error.code !== undefined ? error.code : 'unknown'
      throw new Error(`命令执行失败（exit ${exitCode}）: ${truncate(stderrText, 300)}`)
    }
  }

  async _executeHttp(task, action) {
    const url = String(action.url || '')
    const method = String(action.method || 'GET').toUpperCase()
    const settings = this.getSettings()
    const timeoutSec = clampInt(action.timeout, 5, 3600, settings.defaultTimeout)
    const timeoutMs = timeoutSec * 1000

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let res
    try {
      res = await fetch(url, {
        method,
        headers: action.headers || undefined,
        body: action.body || undefined,
        signal: controller.signal
      })
      const text = await res.text()
      if (!res.ok) {
        throw new Error(`HTTP 请求失败（${res.status} ${res.statusText || ''}）: ${truncate(text, 300)}`)
      }
      return {
        summary: `HTTP ${res.status} ${res.statusText || ''}: ${truncate(text, SUMMARY_LIMIT)}`,
        detail: {
          status: res.status,
          statusText: res.statusText || '',
          body: truncate(text, DETAIL_LIMIT)
        }
      }
    } catch (error) {
      if (error && error.name === 'AbortError') {
        throw new Error(`HTTP 请求超时（${timeoutSec} 秒）`)
      }
      throw new Error(`HTTP 请求失败: ${truncate((error && error.message) || String(error), 300)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  _recordRun(task, { startedAt, finishedAt, status, summary, error, sessionId = null }) {
    const settings = this.getSettings()
    this.runs.unshift({
      id: randomUUID(),
      taskId: task.id,
      taskName: task.name,
      actionType: task.action && task.action.type,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      status,
      summary,
      error: error || null,
      sessionId: sessionId || null
    })
    if (this.runs.length > settings.historyLimit) {
      this.runs.length = settings.historyLimit
    }
  }

  // ============================================================
  // 对外展示
  // ============================================================

  _toPublic(task) {
    return {
      id: task.id,
      name: task.name,
      enabled: task.enabled,
      schedule: task.schedule,
      action: task.action,
      lastRunAt: task.lastRunAt,
      nextRunAt: task.nextRunAt,
      runCount: task.runCount || 0,
      lastStatus: task.lastStatus,
      lastSummary: task.lastSummary,
      running: this._running.has(task.id),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    }
  }
}

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function truncate(text, limit) {
  const s = String(text == null ? '' : text)
  return s.length > limit ? s.slice(0, limit) + '…' : s
}
