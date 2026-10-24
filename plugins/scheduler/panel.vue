<template>
  <div class="scheduler-panel">
    <!-- 顶部操作栏 -->
    <div class="panel-header">
      <div class="header-title">
        <Timer :size="14" />
        <span>定时任务</span>
        <n-tag v-if="tasks.length" size="tiny" :bordered="false" type="info">{{ tasks.length }}</n-tag>
      </div>
      <div class="header-actions">
        <n-button circle quaternary size="tiny" title="刷新" @click="refreshAll" :loading="loading">
          <template #icon><RefreshCw :size="13" /></template>
        </n-button>
        <n-button size="tiny" type="primary" @click="openCreate">
          <template #icon><Plus :size="13" /></template>
          新建
        </n-button>
      </div>
    </div>

    <!-- 任务列表 -->
    <div v-if="loading && tasks.length === 0" class="panel-state">
      <n-spin size="small" />
      <span>加载中...</span>
    </div>
    <div v-else-if="tasks.length === 0" class="panel-state empty">
      <Clock :size="30" />
      <span>暂无定时任务</span>
      <span class="hint">点击「新建」创建 cron 或间隔任务</span>
    </div>
    <div v-else class="task-list">
      <div v-for="task in tasks" :key="task.id" class="task-card" :class="{ running: task.running, disabled: !task.enabled }">
        <div class="task-top">
          <div class="task-name" :title="task.name">{{ task.name }}</div>
          <div class="task-actions">
            <n-tag v-if="task.running" size="tiny" type="warning" :bordered="false">运行中</n-tag>
            <n-switch size="small" :value="task.enabled" @update:value="v => toggleTask(task, v)" :loading="task._busy" />
            <n-button circle quaternary size="tiny" title="立即执行" @click="runTask(task)" :disabled="task.running" :loading="task._running">
              <template #icon><Play :size="12" /></template>
            </n-button>
            <n-button circle quaternary size="tiny" title="查看最近一次对话" :disabled="!latestSessionId(task)" @click="openSession(latestSessionId(task))">
              <template #icon><MessageSquare :size="12" /></template>
            </n-button>
            <n-button circle quaternary size="tiny" title="编辑" @click="openEdit(task)">
              <template #icon><Pencil :size="12" /></template>
            </n-button>
            <n-popconfirm positive-text="删除" negative-text="取消" @positive-click="deleteTask(task)">
              <template #trigger>
                <n-button circle quaternary size="tiny" title="删除" type="error">
                  <template #icon><Trash2 :size="12" /></template>
                </n-button>
              </template>
              确认删除任务「{{ task.name }}」及其执行历史？
            </n-popconfirm>
          </div>
        </div>

        <div class="task-meta">
          <span class="meta-item" :title="`调度：${scheduleText(task)}`">
            <CalendarClock :size="11" />{{ scheduleText(task) }}
          </span>

          <span v-if="task.nextRunAt" class="meta-item" :title="`下次执行：${formatTime(task.nextRunAt)}`">
            <Clock :size="11" />{{ formatTime(task.nextRunAt) }}
          </span>
          <span
            v-if="task.lastRunAt"
            class="meta-item last-status"
            :class="statusClass(task.lastStatus)"
            :title="task.lastSummary ? `上次结果：${task.lastSummary}` : `上次执行：${formatTime(task.lastRunAt)}`"
          >
            <History :size="11" />{{ formatTime(task.lastRunAt) }} · {{ task.lastStatus === 'success' ? '成功' : '失败' }} ({{ task.runCount }} 次)
          </span>
        </div>
      </div>
    </div>

    <!-- 执行历史（底部固定、可折叠，展开固定高度内部滚动，与 git 提交历史一致） -->
    <div class="log-section" :class="{ expanded: historyExpanded }">
      <div class="log-header" @click="historyExpanded = !historyExpanded">
        <span class="group-label">
          <ChevronDown :size="12" class="group-chevron" :class="{ collapsed: !historyExpanded }" />
          <History :size="12" />
          执行历史
        </span>
        <span class="group-count">{{ runs.length }}</span>
      </div>
      <div v-if="historyExpanded" class="log-list">
        <div v-if="runs.length === 0" class="log-hint">暂无执行记录</div>
        <div v-for="run in runs" :key="run.id" class="log-item-group">
          <div
            class="log-item"
            :class="{ expanded: expandedRun === run.id, error: run.status === 'error' }"
            @click="toggleRun(run.id)"
          >
            <ChevronRight :size="10" class="log-expand-arrow" :class="{ open: expandedRun === run.id }" />
            <span class="log-status" :class="run.status">{{ statusText(run.status) }}</span>
            <span class="log-subject" :title="run.taskName">{{ run.taskName }}</span>
            <span class="log-date">{{ formatShortTime(run.startedAt) }}</span>
          </div>
          <div v-if="expandedRun === run.id" class="run-detail">
            <div class="run-detail-row">
              <span class="k">开始</span>
              <span class="v">{{ formatTime(run.startedAt) }}</span>
            </div>
            <div class="run-detail-row">
              <span class="k">耗时</span>
              <span class="v">{{ formatDuration(run.durationMs) }}</span>
            </div>
            <div v-if="run.error" class="run-detail-block error">{{ run.error }}</div>
            <div class="run-detail-block">{{ run.summary || '—' }}</div>
            <div v-if="run.sessionId" class="run-detail-row">
              <span class="k">会话</span>
              <span class="v">
                <button class="link-btn" @click="openSession(run.sessionId)">查看本次对话详情</button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 新建 / 编辑模态框 -->
    <n-modal
      v-model:show="modalShow"
      preset="card"
      :title="editingId ? '编辑任务' : '新建任务'"
      class="scheduler-task-modal"
      :style="{ width: '680px', maxWidth: 'calc(100vw - 32px)' }"
      :mask-closable="false"
    >
      <div class="task-modal-body">
        <div class="modal-intro">
          <div class="intro-icon"><Timer :size="17" /></div>
          <div class="intro-copy">
            <strong>自动运行设置</strong>
            <span>选择触发时间与执行内容，保存后即可生效。</span>
          </div>
          <n-tag size="small" :bordered="false" :type="form.enabled ? 'success' : 'default'">
            {{ form.enabled ? '已启用' : '已暂停' }}
          </n-tag>
        </div>

        <n-form :model="form" label-placement="top" size="small" class="task-form">
          <section class="form-section">
            <div class="section-heading">
              <strong>基本信息</strong>
              <span>给任务起一个容易识别的名称</span>
            </div>
            <n-form-item label="任务名称" required>
              <n-input v-model:value="form.name" placeholder="例如：每日生成报告" maxlength="60" />
            </n-form-item>
          </section>

          <section class="form-section">
            <div class="section-heading">
              <strong>触发方式</strong>
              <span>设置任务运行的时间规则</span>
            </div>
            <div class="choice-grid choice-grid--two" role="group" aria-label="调度方式">
              <button
                v-for="option in scheduleTypeOptions"
                :key="option.value"
                type="button"
                class="choice-card"
                :class="{ selected: form.schedule.type === option.value }"
                :aria-pressed="form.schedule.type === option.value"
                @click="form.schedule.type = option.value"
              >
                <strong>{{ option.value === 'cron' ? 'Cron 表达式' : '固定间隔' }}</strong>
                <span>{{ option.value === 'cron' ? '按分钟、小时、日期等规则运行' : '每隔固定时长运行一次' }}</span>
              </button>
            </div>

            <n-form-item v-if="form.schedule.type === 'cron'" label="Cron 表达式" class="section-field">
              <div class="cron-control">
                <n-input
                  v-model:value="form.schedule.cron"
                  placeholder="分 时 日 月 周，例如 30 9 * * 1-5"
                  @blur="validateCron"
                />
                <div class="cron-hint" :class="{ error: cronError }">
                  {{ cronHint || '例：工作日 9:30' }}
                </div>
              </div>
            </n-form-item>
            <n-form-item v-else label="执行间隔" class="section-field">
              <div class="interval-row">
                <n-input-number v-model:value="form.schedule.interval" :min="1" :max="9999" style="flex: 1" />
                <n-select v-model:value="form.schedule.unit" :options="intervalUnitOptions" style="width: 126px" />
              </div>
            </n-form-item>
          </section>

          <section class="form-section">
            <div class="section-heading">
              <strong>执行内容</strong>
              <span>选择触发后要执行的动作</span>
            </div>
            <div class="choice-grid choice-grid--three" role="group" aria-label="动作类型">
              <button
                v-for="option in actionTypeOptions"
                :key="option.value"
                type="button"
                class="choice-card"
                :class="{ selected: form.action.type === option.value }"
                :aria-pressed="form.action.type === option.value"
                @click="form.action.type = option.value"
              >
                <strong>{{ option.label }}</strong>
                <span>{{ option.value === 'agent' ? '让智能体处理提示词' : option.value === 'shell' ? '运行一条命令' : '发送 HTTP 请求' }}</span>
              </button>
            </div>

            <template v-if="form.action.type === 'agent'">
              <n-form-item label="提示词（发送给智能体）" required class="section-field">
                <n-input
                  v-model:value="form.action.message"
                  type="textarea"
                  :rows="4"
                  placeholder="描述智能体需要完成的任务"
                />
              </n-form-item>

              <div class="field-label">会话模式</div>
              <div class="choice-grid choice-grid--two session-choice" role="group" aria-label="会话模式">
                <button
                  v-for="option in sessionModeOptions"
                  :key="option.value"
                  type="button"
                  class="choice-card choice-card--compact"
                  :class="{ selected: form.action.sessionMode === option.value }"
                  :aria-pressed="form.action.sessionMode === option.value"
                  @click="setSessionMode(option.value)"
                >
                  <strong>{{ option.value === 'new' ? '每次新建会话' : '指定已有会话' }}</strong>
                  <span>{{ option.value === 'new' ? '每次运行都从全新对话开始' : '继续在选定的会话中运行' }}</span>
                </button>
              </div>

              <n-form-item v-if="form.action.sessionMode === 'new'" label="智能体" class="section-field">
                <n-select
                  v-model:value="form.action.agentId"
                  :options="agentOptions"
                  filterable
                  clearable
                  placeholder="留空使用默认智能体"
                />
              </n-form-item>
              <n-form-item v-else label="目标会话" class="section-field">
                <n-select
                  v-model:value="form.action.sessionId"
                  :options="sessionOptions"
                  filterable
                  placeholder="选择已有会话"
                  :fallback-option="() => ({ label: '未知会话', value: form.action.sessionId })"
                />
              </n-form-item>

              <div class="permission-setting" :class="{ enabled: form.action.autoTools }">
                <div class="permission-copy">
                  <strong>允许自动执行工具</strong>
                  <span>允许智能体运行 Shell 命令和网络请求。仅对可信任务开启。</span>
                </div>
                <n-switch v-model:value="form.action.autoTools" />
              </div>

              <div class="field-grid field-grid--two">
                <n-form-item label="模型（可选）">
                  <n-input v-model:value="form.action.model" placeholder="使用默认模型" />
                </n-form-item>
                <n-form-item label="场景 ID（可选）">
                  <n-input v-model:value="form.action.scenarioId" placeholder="使用默认场景" />
                </n-form-item>
              </div>
            </template>

            <template v-else-if="form.action.type === 'shell'">
              <n-form-item label="命令" required class="section-field">
                <n-input v-model:value="form.action.command" type="textarea" :rows="3" placeholder="例如：git status" />
              </n-form-item>
              <div class="field-grid field-grid--two">
                <n-form-item label="工作目录（可选）">
                  <n-input v-model:value="form.action.cwd" placeholder="默认继承进程目录" />
                </n-form-item>
                <n-form-item label="超时（秒）">
                  <n-input-number v-model:value="form.action.timeout" :min="5" :max="3600" placeholder="默认" style="width: 100%" />
                </n-form-item>
              </div>
            </template>

            <template v-else>
              <n-form-item label="请求 URL" required class="section-field">
                <n-input v-model:value="form.action.url" placeholder="https://example.com/api" />
              </n-form-item>
              <div class="field-grid field-grid--two">
                <n-form-item label="方法">
                  <n-select v-model:value="form.action.method" :options="httpMethodOptions" />
                </n-form-item>
                <n-form-item label="超时（秒）">
                  <n-input-number v-model:value="form.action.timeout" :min="5" :max="3600" placeholder="默认" style="width: 100%" />
                </n-form-item>
              </div>
              <n-form-item label="请求头（JSON，可选）" class="section-field">
                <n-input v-model:value="form.action.headersText" type="textarea" :rows="2" placeholder='{"Authorization": "Bearer xxx"}' />
              </n-form-item>
              <n-form-item label="请求体（可选）" class="section-field">
                <n-input v-model:value="form.action.body" type="textarea" :rows="3" placeholder="JSON 或原始文本" />
              </n-form-item>
            </template>
          </section>
        </n-form>
      </div>

      <template #footer>
        <div class="modal-footer">
          <div class="enabled-setting">
            <n-switch v-model:value="form.enabled" />
            <span>保存后启用任务</span>
          </div>
          <div class="footer-actions">
            <n-button size="small" @click="modalShow = false">取消</n-button>
            <n-button size="small" type="primary" :loading="saving" @click="saveTask">保存任务</n-button>
          </div>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, inject } from 'vue'
import {
  Timer, RefreshCw, Plus, Clock, CalendarClock, History, Play, Pencil, Trash2,
  ChevronDown, ChevronRight, MessageSquare
} from 'lucide-vue-next'

const props = defineProps({
  sessionId: { type: String, default: null }
})

// 宿主全局插件 API（App.vue 提供，见 web/src/utils/pluginApi.js）
const artificer = inject('artificer', null)

const API = '/api/plugins/scheduler'

const tasks = ref([])
const runs = ref([])
const loading = ref(false)
const saving = ref(false)
const modalShow = ref(false)
const editingId = ref(null)
const cronHint = ref('')
const cronError = ref(false)
const historyExpanded = ref(true)
const expandedRun = ref(null)

const scheduleTypeOptions = [
  { label: 'cron 表达式', value: 'cron' },
  { label: '时间间隔', value: 'interval' }
]
const intervalUnitOptions = [
  { label: '秒', value: 'second' },
  { label: '分钟', value: 'minute' },
  { label: '小时', value: 'hour' },
  { label: '天', value: 'day' }
]
const actionTypeOptions = [
  { label: 'Agent', value: 'agent' },
  { label: 'Shell', value: 'shell' },
  { label: 'HTTP', value: 'http' }
]
const httpMethodOptions = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].map(m => ({ label: m, value: m }))

const sessionOptions = ref([])
const sessionsLoaded = ref(false)
const agentOptions = ref([])
const agentsLoaded = ref(false)

const sessionModeOptions = [
  { label: '每次新建会话', value: 'new' },
  { label: '指定已有会话', value: 'existing' }
]

const emptyForm = () => ({
  name: '',
  enabled: true,
  schedule: { type: 'cron', cron: '', interval: 5, unit: 'minute' },
  action: {
    type: 'agent',
    message: '',
    sessionMode: 'new',
    sessionId: null,
    agentId: null,
    autoTools: false,
    model: '',
    scenarioId: '',
    command: '',
    cwd: '',
    url: '',
    method: 'GET',
    headersText: '',
    body: '',
    timeout: null
  }
})

const form = reactive(emptyForm())

// ============================================================
// 数据加载
// ============================================================

async function fetchTasks() {
  try {
    const res = await fetch(`${API}/tasks`)
    const json = await res.json()
    if (json.success) tasks.value = json.data || []
  } catch {}
}

async function fetchRuns() {
  try {
    const res = await fetch(`${API}/runs?limit=20`)
    const json = await res.json()
    if (json.success) runs.value = json.data || []
  } catch {}
}

async function refreshAll() {
  loading.value = true
  await Promise.all([fetchTasks(), fetchRuns()])
  loading.value = false
}

async function loadSessions() {
  if (sessionsLoaded.value) return
  try {
    const res = await fetch('/api/sessions')
    const json = await res.json()
    const list = (json.success && json.data) || []
    sessionOptions.value = list
      .filter(s => s && s.id)
      .map(s => ({ label: s.title || s.id, value: s.id }))
    sessionsLoaded.value = true
  } catch {}
}

async function loadAgents() {
  if (agentsLoaded.value) return
  try {
    const res = await fetch('/api/agents')
    const json = await res.json()
    const list = (json.success && json.data?.agents) || []
    agentOptions.value = list
      .filter(a => a && a.id)
      .map(a => ({ label: a.name || a.id, value: a.id }))
    agentsLoaded.value = true
  } catch {}
}

function onSessionModeChange(value) {
  if (value === 'new') {
    form.action.sessionId = null
  } else {
    form.action.agentId = null
  }
}

function setSessionMode(value) {
  form.action.sessionMode = value
  onSessionModeChange(value)
}

// ============================================================
// 展示辅助
// ============================================================

function scheduleText(task) {
  const s = task.schedule || {}
  if (s.type === 'cron') return `cron: ${s.cron}`
  if (s.type === 'interval') {
    const unitLabel = intervalUnitOptions.find(u => u.value === s.unit)?.label || s.unit
    return `每 ${s.interval} ${unitLabel}`
  }
  return '未配置调度'
}

function statusClass(status) {
  return status === 'success' ? 'ok' : status === 'error' ? 'err' : ''
}

function statusText(status) {
  return { success: '成功', error: '失败' }[status] || status || '—'
}

function toggleRun(runId) {
  expandedRun.value = expandedRun.value === runId ? null : runId
}

function latestSessionId(task) {
  const run = runs.value.find(r => r.taskId === task.id && r.sessionId)
  return run ? run.sessionId : null
}

function openSession(sessionId) {
  if (!sessionId) return
  if (artificer?.openSession) {
    artificer.openSession(sessionId)
  } else if (window.artificer?.openSession) {
    window.artificer.openSession(sessionId)
  }
}

function formatTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatShortTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDuration(ms) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// ============================================================
// 任务操作
// ============================================================

async function toggleTask(task, enabled) {
  task._busy = true
  try {
    const res = await fetch(`${API}/tasks/${task.id}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    })
    const json = await res.json()
    if (json.success) Object.assign(task, json.data)
  } finally {
    task._busy = false
  }
}

async function runTask(task) {
  task._running = true
  try {
    await fetch(`${API}/tasks/${task.id}/run`, { method: 'POST' })
    await new Promise(r => setTimeout(r, 500))
  } finally {
    task._running = false
  }
  await refreshAll()
}

async function deleteTask(task) {
  try {
    await fetch(`${API}/tasks/${task.id}`, { method: 'DELETE' })
  } finally {
    await refreshAll()
  }
}

// ============================================================
// 新建 / 编辑
// ============================================================

function openCreate() {
  editingId.value = null
  Object.assign(form, emptyForm())
  cronHint.value = ''
  cronError.value = false
  modalShow.value = true
  loadSessions()
  loadAgents()
}

function openEdit(task) {
  editingId.value = task.id
  Object.assign(form, emptyForm(), {
    name: task.name,
    enabled: task.enabled,
    schedule: {
      type: task.schedule?.type || 'cron',
      cron: task.schedule?.cron || '',
      interval: task.schedule?.interval || 5,
      unit: task.schedule?.unit || 'minute'
    },
    action: {
      type: task.action?.type || 'agent',
      message: task.action?.message || '',
      sessionMode: task.action?.sessionId ? 'existing' : 'new',
      sessionId: task.action?.sessionId || null,
      agentId: task.action?.agentId || null,
      autoTools: task.action?.approvalMode === 'allow',
      model: task.action?.model || '',
      scenarioId: task.action?.scenarioId || '',
      command: task.action?.command || '',
      cwd: task.action?.cwd || '',
      url: task.action?.url || '',
      method: task.action?.method || 'GET',
      headersText: task.action?.headers ? JSON.stringify(task.action.headers, null, 0) : '',
      body: task.action?.body || '',
      timeout: task.action?.timeout ?? null
    }
  })
  cronHint.value = ''
  cronError.value = false
  modalShow.value = true
  loadSessions()
  loadAgents()
}

async function validateCron() {
  const expr = form.schedule.cron?.trim()
  if (!expr) {
    cronHint.value = ''
    cronError.value = false
    return
  }
  try {
    const res = await fetch(`${API}/validate?cron=${encodeURIComponent(expr)}`)
    const json = await res.json()
    if (json.success) {
      cronError.value = false
      cronHint.value = json.data.nextRunAt ? `下次执行: ${formatTime(json.data.nextRunAt)}` : '表达式合法（1 年内无匹配）'
    } else {
      cronError.value = true
      cronHint.value = json.error || 'cron 表达式非法'
    }
  } catch {
    cronError.value = false
    cronHint.value = ''
  }
}

function buildPayload() {
  const payload = {
    name: form.name.trim(),
    enabled: form.enabled,
    schedule: { type: form.schedule.type },
    action: { type: form.action.type }
  }
  if (form.schedule.type === 'cron') payload.schedule.cron = form.schedule.cron.trim()
  else {
    payload.schedule.interval = form.schedule.interval || 1
    payload.schedule.unit = form.schedule.unit
  }

  const a = form.action
  if (a.type === 'agent') {
    payload.action.message = a.message
    if (a.sessionMode === 'new') {
      payload.action.sessionId = null
      if (a.agentId) payload.action.agentId = a.agentId
    } else {
      if (!a.sessionId) throw new Error('请选择目标会话，或切换为“每次新建会话”模式')
      payload.action.sessionId = a.sessionId
    }
    payload.action.approvalMode = a.autoTools ? 'allow' : 'block'
    if (a.model) payload.action.model = a.model
    if (a.scenarioId) payload.action.scenarioId = a.scenarioId
  } else if (a.type === 'shell') {
    payload.action.command = a.command
    if (a.cwd) payload.action.cwd = a.cwd
    if (a.timeout) payload.action.timeout = a.timeout
  } else {
    payload.action.url = a.url
    payload.action.method = a.method || 'GET'
    if (a.headersText) {
      try {
        payload.action.headers = JSON.parse(a.headersText)
      } catch {
        throw new Error('请求头不是合法的 JSON')
      }
    }
    if (a.body) payload.action.body = a.body
    if (a.timeout) payload.action.timeout = a.timeout
  }
  return payload
}

async function saveTask() {
  if (!form.name.trim()) return
  let payload
  try {
    payload = buildPayload()
  } catch (e) {
    (artificer || window.artificer)?.toast?.(e.message, 'error')
    return
  }
  saving.value = true
  try {
    const url = editingId.value ? `${API}/tasks/${editingId.value}` : `${API}/tasks`
    const res = await fetch(url, {
      method: editingId.value ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const json = await res.json()
    if (json.success) {
      modalShow.value = false
      await refreshAll()
    } else {
      (artificer || window.artificer)?.toast?.(json.error || '保存失败', 'error')
    }
  } catch (e) {
    (artificer || window.artificer)?.toast?.(e.message, 'error')
  } finally {
    saving.value = false
  }
}

// ============================================================
// 生命周期
// ============================================================

let pollTimer = null

onMounted(() => {
  refreshAll()
  // 轻量轮询：刷新运行状态与到期时间
  pollTimer = setInterval(() => {
    fetchTasks()
    fetchRuns()
  }, 15000)
})

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer)
})
</script>

<style scoped>
.scheduler-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 10px;
  gap: 10px;
  overflow: auto;
  font-size: 12px;
  color: var(--text-primary, #333);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-shrink: 0;
}
.header-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  min-width: 0;
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.panel-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 32px 12px;
  color: var(--text-muted, #999);
  text-align: center;
}
.panel-state .hint {
  font-size: 11px;
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.task-card {
  border: 1px solid var(--border-color, #e5e5e5);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  background: var(--surface, #fff);
}
.task-card.disabled {
  opacity: 0.6;
}

.task-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.task-name {
  font-weight: 600;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.task-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

/* 元信息：并排、图标化、紧凑 */
.task-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  align-items: center;
}
.meta-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-secondary, #666);
  background: var(--bg-tertiary, rgba(128, 128, 128, 0.06));
  border-radius: var(--radius-xs);
  padding: 2px 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.meta-item svg {
  flex-shrink: 0;
  opacity: 0.7;
}
.last-status.ok {
  color: #18a058;
}
.last-status.err {
  color: #d03050;
}

/* === 执行历史（底部固定、可折叠，与 git 提交历史一致） === */
.log-section {
  border-top: 1px solid var(--border-color, #e5e5e5);
  padding-top: 6px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.log-section.expanded {
  height: 300px;
}

.log-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px;
  cursor: pointer;
  border-radius: var(--radius-xs, 4px);
  transition: background 0.12s ease;
  flex-shrink: 0;
}

.log-header:hover {
  background: var(--bg-hover, rgba(128, 128, 128, 0.08));
}

.group-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-weight: 600;
  font-size: 12px;
}

.group-chevron {
  transition: transform 0.2s ease;
  color: var(--text-muted, #999);
}

.group-chevron.collapsed {
  transform: rotate(-90deg);
}

.group-count {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted, #999);
}

.log-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  margin-top: 4px;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
}

.log-hint {
  font-size: 11px;
  color: var(--text-muted, #999);
  padding: 6px 8px;
}

.log-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: var(--radius-xs, 4px);
  font-size: 11px;
  cursor: pointer;
  transition: background 0.12s ease;
}

.log-item:hover,
.log-item.expanded {
  background: var(--bg-hover, rgba(128, 128, 128, 0.08));
}

.log-expand-arrow {
  flex-shrink: 0;
  transition: transform 0.2s ease;
  color: var(--text-muted, #999);
}

.log-expand-arrow.open {
  transform: rotate(90deg);
}

.log-status {
  font-weight: 600;
  font-size: 10px;
  flex-shrink: 0;
  padding: 1px 5px;
  border-radius: var(--radius-xs, 4px);
  color: var(--text-secondary, #666);
  background: var(--bg-tertiary, rgba(128, 128, 128, 0.12));
}

.log-status.success {
  color: var(--success-color, #18a058);
  background: rgba(24, 160, 88, 0.1);
}

.log-status.error {
  color: var(--error-color, #d03050);
  background: rgba(208, 48, 80, 0.1);
}

.log-subject {
  flex: 1;
  color: var(--text-secondary, #666);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.log-item.error .log-subject {
  color: var(--error-color, #d03050);
}

.log-date {
  color: var(--text-muted, #999);
  font-size: 10px;
  flex-shrink: 0;
}

/* 展开的执行详情 */
.run-detail {
  padding: 6px 8px 8px 22px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.run-detail-row {
  display: flex;
  gap: 8px;
  font-size: 11px;
  align-items: baseline;
}

.run-detail-row .k {
  flex-shrink: 0;
  width: 32px;
  color: var(--text-muted, #999);
}

.run-detail-row .v {
  color: var(--text-secondary, #666);
  overflow-wrap: anywhere;
}

.run-detail-block {
  font-size: 11px;
  color: var(--text-secondary, #666);
  background: var(--bg-tertiary, rgba(128, 128, 128, 0.06));
  border-radius: var(--radius-xs, 4px);
  padding: 6px 8px;
  margin-top: 2px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 180px;
  overflow-y: auto;
}

.run-detail-block.error {
  color: var(--error-color, #d03050);
  background: rgba(208, 48, 80, 0.06);
}

.link-btn {
  border: none;
  background: none;
  padding: 0;
  margin: 0;
  color: var(--primary-color, #18a058);
  font-size: 11px;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.link-btn:hover {
  opacity: 0.8;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.task-modal-body {
  max-height: min(76vh, 760px);
  overflow-y: auto;
  padding: 0 4px 2px 0;
  scrollbar-gutter: stable;
}

.modal-intro {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  margin-bottom: 2px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.18));
  border-radius: var(--radius-md);
  background: var(--bg-tertiary, rgba(128, 128, 128, 0.06));
}

.intro-icon {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  flex: 0 0 34px;
  color: var(--primary-color, #18a058);
  border-radius: var(--radius-xs);
  background: rgba(24, 160, 88, 0.12);
}

.intro-copy {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.intro-copy strong {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #333);
}

.intro-copy span,
.section-heading span {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-muted, #999);
}

.task-form :deep(.n-form-item) {
  margin-bottom: 0;
}

.task-form :deep(.n-form-item-label) {
  padding-bottom: 5px;
  font-size: 12px;
  color: var(--text-secondary, #666);
}

.task-form :deep(.n-form-item-feedback-wrapper) {
  min-height: 0;
}

.form-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 0;
  border-bottom: 1px solid var(--border-color, rgba(128, 128, 128, 0.16));
}

.form-section:last-child {
  border-bottom: 0;
  padding-bottom: 8px;
}

.section-heading {
  display: flex;
  align-items: baseline;
  gap: 9px;
}

.section-heading strong {
  flex: 0 0 auto;
  font-size: 13px;
  font-weight: 650;
  color: var(--text-primary, #333);
}

.choice-grid {
  display: grid;
  gap: 8px;
}

.choice-grid--two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.choice-grid--three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.choice-card {
  display: flex;
  min-width: 0;
  min-height: 62px;
  flex-direction: column;
  justify-content: center;
  gap: 4px;
  padding: 9px 11px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.2));
  border-radius: var(--radius-sm);
  background: var(--bg-secondary, rgba(128, 128, 128, 0.05));
  color: var(--text-primary, #333);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}

.choice-card:hover {
  border-color: var(--border-color, rgba(128, 128, 128, 0.2));
  background: var(--hover-color, var(--bg-tertiary, rgba(128, 128, 128, 0.08)));
}

.choice-card.selected {
  border-color: var(--border-color, rgba(128, 128, 128, 0.2));
  background: var(--primary-bg, #1c1c1c);
  color: var(--primary-text, #fff);
  box-shadow: none;
}

.choice-card:focus-visible {
  outline: 2px solid var(--text-muted, #999);
  outline-offset: 2px;
}

.choice-card strong {
  font-size: 12px;
  font-weight: 600;
}

.choice-card span {
  font-size: 10px;
  line-height: 1.45;
  color: var(--text-muted, #999);
}

.choice-card.selected span {
  color: currentColor;
  opacity: 0.72;
}

.choice-card--compact {
  min-height: 56px;
}

.section-field {
  width: 100%;
}

.field-label {
  margin-bottom: -5px;
  font-size: 12px;
  color: var(--text-secondary, #666);
}

.cron-hint {
  flex: 0 0 auto;
  margin-top: 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--text-muted, #999);
  white-space: nowrap;
}

.cron-hint.error {
  color: var(--error-color, #d03050);
}

.interval-row {
  display: flex;
  gap: 8px;
  width: 100%;
}

.cron-control {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.cron-control :deep(.n-input) {
  flex: 1;
  min-width: 0;
}

.field-grid {
  display: grid;
  gap: 12px;
}

.field-grid--two {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.permission-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 11px 12px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.18));
  border-radius: var(--radius-sm);
  background: var(--bg-tertiary, rgba(128, 128, 128, 0.05));
}

.permission-setting.enabled {
  border-color: var(--border-color, rgba(128, 128, 128, 0.18));
  background: var(--bg-secondary, rgba(128, 128, 128, 0.05));
}

.permission-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.permission-copy strong {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary, #333);
}

.permission-copy span {
  font-size: 10px;
  line-height: 1.45;
  color: var(--text-muted, #999);
}

.enabled-setting {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  color: var(--text-secondary, #666);
  font-size: 12px;
  cursor: pointer;
}

.footer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

@media (max-width: 560px) {
  .task-modal-body {
    max-height: 72vh;
  }

  .section-heading {
    flex-direction: column;
    gap: 2px;
  }

  .cron-control {
    align-items: stretch;
    flex-direction: column;
    gap: 6px;
  }

  .cron-hint {
    white-space: normal;
  }

  .choice-grid--three {
    grid-template-columns: 1fr;
  }

  .choice-grid--three .choice-card {
    min-height: 48px;
  }

  .field-grid--two {
    grid-template-columns: 1fr;
  }

  .modal-footer {
    align-items: flex-start;
    flex-direction: column;
  }

  .footer-actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
