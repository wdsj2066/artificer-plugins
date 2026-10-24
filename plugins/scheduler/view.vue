<template>
  <div class="mgmt-view scheduler-view">
    <div class="view-header">
      <h2>
        <Timer :size="18" />
        定时任务
      </h2>
      <p class="view-description">按 cron 表达式或固定间隔调度 Agent 提示词、Shell 命令与 HTTP 请求</p>
    </div>

    <!-- 概览统计 + 操作 -->
    <div class="mgmt-toolbar mgmt-toolbar--between" style="margin-bottom: 20px">
      <div class="mgmt-toolbar-left">
        <div class="mgmt-stats">
          <span class="mgmt-stat">
            <span class="mgmt-stat-value">{{ tasks.length }}</span>
            <span class="mgmt-stat-label">任务总数</span>
          </span>
          <span class="mgmt-stat">
            <span class="mgmt-stat-value mgmt-stat-value--success">{{ enabledCount }}</span>
            <span class="mgmt-stat-label">已启用</span>
          </span>
          <span class="mgmt-stat">
            <span class="mgmt-stat-value">{{ totalRunCount }}</span>
            <span class="mgmt-stat-label">累计执行</span>
          </span>
          <span class="mgmt-stat">
            <span class="mgmt-stat-value" :class="failCount24h > 0 ? 'mgmt-stat-value--error' : ''">{{ failCount24h }}</span>
            <span class="mgmt-stat-label">24h 失败</span>
          </span>
        </div>
      </div>
      <div class="mgmt-toolbar-right">
        <n-button size="small" quaternary :loading="loading" @click="refreshAll">
          <template #icon><RefreshCw :size="13" /></template>
          刷新
        </n-button>
        <n-button size="small" type="primary" @click="openCreate">
          <template #icon><Plus :size="13" /></template>
          新建任务
        </n-button>
      </div>
    </div>

    <div class="scheduler-body">
      <!-- 左侧：任务列表 -->
      <div class="task-section">
        <div v-if="loading && tasks.length === 0" class="view-state">
          <n-spin size="small" />
          <span>加载中...</span>
        </div>
        <div v-else-if="tasks.length === 0" class="view-state empty">
          <Clock :size="36" />
          <span>暂无定时任务</span>
          <span class="hint">点击「新建任务」创建 cron 或间隔任务</span>
        </div>
        <div v-else class="view-task-list">
          <div v-for="task in tasks" :key="task.id" class="view-task-card" :class="{ running: task.running, disabled: !task.enabled }">
            <div class="card-top">
              <div class="card-title">
                <span class="task-name" :title="task.name">{{ task.name }}</span>
                <n-tag v-if="task.running" size="tiny" type="warning" :bordered="false">运行中</n-tag>
                <n-tag v-else size="tiny" :type="task.enabled ? 'success' : 'default'" :bordered="false">
                  {{ task.enabled ? '启用' : '禁用' }}
                </n-tag>
                <n-tag size="tiny" :bordered="false" type="info">{{ actionTypeLabel(task.action?.type) }}</n-tag>
              </div>
              <div class="card-actions">
                <n-button size="tiny" quaternary title="立即执行" :loading="runningIds.has(task.id)" @click="runTask(task)">
                  <template #icon><Play :size="12" /></template>
                </n-button>
                <n-button size="tiny" quaternary :title="task.enabled ? '禁用' : '启用'" @click="toggleTask(task)">
                  <template #icon><Zap :size="12" /></template>
                </n-button>
                <n-button size="tiny" quaternary title="编辑" @click="openEdit(task)">
                  <template #icon><Pencil :size="12" /></template>
                </n-button>
                <n-popconfirm @positive-click="deleteTask(task)">
                  <template #trigger>
                    <n-button size="tiny" quaternary title="删除">
                      <template #icon><Trash2 :size="12" /></template>
                    </n-button>
                  </template>
                  确定删除任务「{{ task.name }}」及其执行历史？
                </n-popconfirm>
              </div>
            </div>

            <div class="card-grid">
              <div class="card-field">
                <span class="field-label"><CalendarClock :size="12" /> 调度</span>
                <span class="field-value">{{ scheduleText(task) }}</span>
              </div>
              <div class="card-field">
                <span class="field-label"><Clock :size="12" /> 下次执行</span>
                <span class="field-value">{{ task.nextRunAt ? formatTime(task.nextRunAt) : '—' }}</span>
              </div>
              <div class="card-field">
                <span class="field-label"><History :size="12" /> 上次执行</span>
                <span class="field-value">
                  {{ task.lastRunAt ? formatTime(task.lastRunAt) : '—' }}
                  <n-tag v-if="task.lastStatus" size="tiny" :bordered="false" :type="statusType(task.lastStatus)">
                    {{ statusText(task.lastStatus) }}
                  </n-tag>
                </span>
              </div>
              <div class="card-field">
                <span class="field-label"><Zap :size="12" /> 累计执行</span>
                <span class="field-value">{{ task.runCount || 0 }} 次</span>
              </div>
            </div>

            <div class="card-summary" :title="task.lastSummary || actionSummary(task)">
              {{ task.lastSummary || actionSummary(task) }}
            </div>
          </div>
        </div>
      </div>

      <!-- 右侧：执行历史 -->
      <div class="history-section">
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
                <span class="k">动作</span>
                <span class="v">{{ actionTypeLabel(run.actionType) }}</span>
              </div>
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
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 新建 / 编辑弹窗 -->
    <n-modal
      v-model:show="modalShow"
      preset="card"
      :title="editingId ? '编辑定时任务' : '新建定时任务'"
      class="scheduler-modal"
      :style="{ width: '560px', maxWidth: 'calc(100vw - 48px)' }"
      :mask-closable="false"
    >
      <n-form label-placement="left" label-width="110" size="small">
        <n-form-item label="任务名称" required>
          <n-input v-model:value="form.name" placeholder="例如：每日早报" />
        </n-form-item>

        <n-form-item label="调度方式">
          <n-segmented v-model:value="form.schedule.type" :options="scheduleTypeOptions" size="small" />
        </n-form-item>

        <template v-if="form.schedule.type === 'cron'">
          <n-form-item label="cron 表达式">
            <n-input v-model:value="form.schedule.cron" placeholder="分 时 日 月 周，如 */5 * * * *" @blur="validateCron" />
            <div v-if="cronHint" class="cron-hint" :class="{ error: cronError }">{{ cronHint }}</div>
          </n-form-item>
        </template>
        <template v-else>
          <n-form-item label="执行间隔">
            <div class="interval-row">
              <n-input-number v-model:value="form.schedule.interval" :min="1" :max="9999" style="flex: 1" />
              <n-select v-model:value="form.schedule.unit" :options="intervalUnitOptions" style="width: 100px" />
            </div>
          </n-form-item>
        </template>

        <n-form-item label="动作类型">
          <n-segmented v-model:value="form.action.type" :options="actionTypeOptions" size="small" />
        </n-form-item>

        <template v-if="form.action.type === 'agent'">
          <n-form-item label="提示词" required>
            <n-input v-model:value="form.action.message" type="textarea" :rows="3" placeholder="发送给智能体的消息内容" />
          </n-form-item>
          <n-form-item label="会话模式">
            <n-segmented
              v-model:value="form.action.sessionMode"
              :options="sessionModeOptions"
              size="small"
              @update:value="onSessionModeChange"
            />
          </n-form-item>
          <template v-if="form.action.sessionMode === 'new'">
            <n-form-item label="智能体">
              <n-select
                v-model:value="form.action.agentId"
                :options="agentOptions"
                filterable
                clearable
                placeholder="留空使用默认智能体"
              />
            </n-form-item>
          </template>
          <template v-else>
            <n-form-item label="目标会话">
              <n-select
                v-model:value="form.action.sessionId"
                :options="sessionOptions"
                filterable
                placeholder="选择已有会话"
                :fallback-option="() => ({ label: '未知会话', value: form.action.sessionId })"
              />
            </n-form-item>
          </template>
          <n-form-item label="自动执行工具">
            <n-switch v-model:value="form.action.autoTools" />
            <span class="field-hint">开启后允许智能体自动执行 shell 命令与网络请求（仅限可信任务）</span>
          </n-form-item>
          <div class="form-row">
            <n-form-item label="模型（可选）">
              <n-input v-model:value="form.action.model" placeholder="留空使用默认模型" />
            </n-form-item>
            <n-form-item label="场景 ID（可选）">
              <n-input v-model:value="form.action.scenarioId" placeholder="留空使用默认场景" />
            </n-form-item>
          </div>
        </template>

        <template v-else-if="form.action.type === 'shell'">
          <n-form-item label="命令" required>
            <n-input v-model:value="form.action.command" type="textarea" :rows="2" placeholder="例如：git status" />
          </n-form-item>
          <div class="form-row">
            <n-form-item label="工作目录（可选）">
              <n-input v-model:value="form.action.cwd" placeholder="默认继承进程目录" />
            </n-form-item>
            <n-form-item label="超时（秒）">
              <n-input-number v-model:value="form.action.timeout" :min="5" :max="3600" placeholder="默认" style="width: 100%" />
            </n-form-item>
          </div>
        </template>

        <template v-else>
          <n-form-item label="请求 URL" required>
            <n-input v-model:value="form.action.url" placeholder="https://example.com/api" />
          </n-form-item>
          <div class="form-row">
            <n-form-item label="方法">
              <n-select v-model:value="form.action.method" :options="httpMethodOptions" />
            </n-form-item>
            <n-form-item label="超时（秒）">
              <n-input-number v-model:value="form.action.timeout" :min="5" :max="3600" placeholder="默认" style="width: 100%" />
            </n-form-item>
          </div>
          <n-form-item label="请求头（JSON，可选）">
            <n-input v-model:value="form.action.headersText" type="textarea" :rows="1" placeholder='{"Authorization": "Bearer xxx"}' />
          </n-form-item>
          <n-form-item label="请求体（可选）">
            <n-input v-model:value="form.action.body" type="textarea" :rows="2" placeholder="JSON 或原始文本" />
          </n-form-item>
        </template>

        <n-form-item label="启用">
          <n-switch v-model:value="form.enabled" />
        </n-form-item>
      </n-form>

      <template #footer>
        <div class="modal-footer">
          <n-button size="small" @click="modalShow = false">取消</n-button>
          <n-button size="small" type="primary" :loading="saving" @click="saveTask">保存</n-button>
        </div>
      </template>
    </n-modal>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onUnmounted, inject } from 'vue'
import {
  Timer, RefreshCw, Plus, Clock, CalendarClock, Zap, History, Play, Pencil, Trash2,
  ChevronDown, ChevronRight
} from 'lucide-vue-next'

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
const runningIds = ref(new Set())
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
const sessionModeOptions = [
  { label: '每次新建会话', value: 'new' },
  { label: '指定已有会话', value: 'existing' }
]

const sessionOptions = ref([])
const sessionsLoaded = ref(false)
const agentOptions = ref([])
const agentsLoaded = ref(false)

const enabledCount = computed(() => tasks.value.filter(t => t.enabled).length)
const totalRunCount = computed(() => tasks.value.reduce((sum, t) => sum + (t.runCount || 0), 0))
const failCount24h = computed(() => {
  const since = Date.now() - 24 * 60 * 60 * 1000
  return runs.value.filter(r => r.status === 'error' && (r.startedAt || 0) >= since).length
})

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
    const res = await fetch(`${API}/runs?limit=50`)
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
  return '—'
}

function actionTypeLabel(type) {
  return { agent: 'Agent', shell: 'Shell', http: 'HTTP' }[type] || type || '—'
}

function actionSummary(task) {
  const a = task.action || {}
  if (a.type === 'agent') {
    const mode = a.sessionId ? `复用会话 ${a.sessionId}` : '每次新建会话'
    return `[Agent · ${mode}] ${a.message || ''}`
  }
  if (a.type === 'shell') return `[Shell] ${a.command || ''}`
  if (a.type === 'http') return `[HTTP ${a.method || 'GET'}] ${a.url || ''}`
  return '—'
}

function statusType(status) {
  if (status === 'success') return 'success'
  if (status === 'error') return 'error'
  return 'default'
}

function statusText(status) {
  return { success: '成功', error: '失败' }[status] || status || '—'
}

function toggleRun(runId) {
  expandedRun.value = expandedRun.value === runId ? null : runId
}

function formatShortTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60 * 1000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60000)
  const s = Math.round((ms % 60000) / 1000)
  return `${m}m${s}s`
}

function formatTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// ============================================================
// 任务操作
// ============================================================

async function runTask(task) {
  runningIds.value = new Set([...runningIds.value, task.id])
  try {
    const res = await fetch(`${API}/tasks/${task.id}/run`, { method: 'POST' })
    const json = await res.json()
    if (!json.success) {
      (artificer || window.artificer)?.toast?.(json.error || '执行失败', 'error')
    }
    await refreshAll()
  } catch (e) {
    (artificer || window.artificer)?.toast?.(e.message, 'error')
  } finally {
    const next = new Set(runningIds.value)
    next.delete(task.id)
    runningIds.value = next
  }
}

async function toggleTask(task) {
  try {
    const res = await fetch(`${API}/tasks/${task.id}/toggle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !task.enabled })
    })
    const json = await res.json()
    if (!json.success) {
      (artificer || window.artificer)?.toast?.(json.error || '操作失败', 'error')
    }
    await fetchTasks()
  } catch (e) {
    (artificer || window.artificer)?.toast?.(e.message, 'error')
  }
}

async function deleteTask(task) {
  try {
    const res = await fetch(`${API}/tasks/${task.id}`, { method: 'DELETE' })
    const json = await res.json()
    if (!json.success) {
      (artificer || window.artificer)?.toast?.(json.error || '删除失败', 'error')
    }
    await refreshAll()
  } catch (e) {
    (artificer || window.artificer)?.toast?.(e.message, 'error')
  }
}

// ============================================================
// 弹窗
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
      headersText: task.action?.headers ? JSON.stringify(task.action.headers) : '',
      body: task.action?.body || '',
      timeout: task.action?.timeout || null
    }
  })
  cronHint.value = ''
  cronError.value = false
  modalShow.value = true
  loadSessions()
  loadAgents()
}

function onSessionModeChange(value) {
  if (value === 'new') {
    form.action.sessionId = null
  } else {
    form.action.agentId = null
  }
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
      const next = json.data?.nextRunAt
      cronHint.value = next
        ? `表达式有效，下次执行：${formatTime(next)}`
        : '表达式有效'
      cronError.value = false
    } else {
      cronHint.value = json.error || '表达式无效'
      cronError.value = true
    }
  } catch {
    cronHint.value = ''
    cronError.value = false
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

let refreshTimer = null

onMounted(async () => {
  await refreshAll()
  refreshTimer = setInterval(refreshAll, 10000)
})

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer)
})
</script>

<style scoped>
.scheduler-view {
  max-width: 1200px;
  margin: 0 auto;
}

.mgmt-toolbar-right {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* 全局 mgmt 样式未提供 error 修饰，此处补齐 */
.mgmt-stat-value--error {
  color: var(--error-color, #d03050);
}

/* 主体布局：左侧任务 + 右侧历史 */
.scheduler-body {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}

.task-section {
  flex: 1;
  min-width: 0;
}

.history-section {
  width: 340px;
  flex-shrink: 0;
  border: 1px solid var(--border-color, #e0e0e6);
  border-radius: var(--radius-md);
  padding: 14px;
  position: sticky;
  top: 12px;
}

/* 状态占位 */
.view-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 48px 0;
  color: var(--text-color-3, #999);
  font-size: 13px;
}

.view-state.empty.small {
  padding: 24px 0;
}

.view-state .hint {
  font-size: 12px;
  opacity: 0.7;
}

/* 任务卡片 */
.view-task-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.view-task-card {
  border: 1px solid var(--border-color, #e0e0e6);
  border-radius: var(--radius-md);
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.view-task-card.disabled {
  opacity: 0.6;
}

.card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.task-name {
  font-weight: 600;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-actions {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}

.card-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 16px;
}

.card-field {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.field-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-color-3, #999);
}

.field-value {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-summary {
  font-size: 12px;
  color: var(--text-color-2, #666);
  background: var(--code-bg, rgba(128, 128, 128, 0.06));
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* === 执行历史（参考 git 插件提交历史风格） === */
.log-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px;
  cursor: pointer;
  border-radius: var(--radius-xs, 4px);
  transition: background 0.12s ease;
  flex-shrink: 0;
  font-weight: 600;
  font-size: 13px;
}

.log-header:hover {
  background: var(--bg-hover, rgba(128, 128, 128, 0.08));
}

.group-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
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
  max-height: 60vh;
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

/* 表单 */
.interval-row {
  display: flex;
  gap: 8px;
  width: 100%;
}

.form-row {
  display: flex;
  gap: 12px;
}

.form-row > * {
  flex: 1;
  min-width: 0;
}

.field-hint {
  font-size: 11px;
  color: var(--text-muted, #999);
  margin-left: 8px;
}

.cron-hint {
  font-size: 11px;
  color: var(--text-color-3, #999);
  margin-top: 4px;
  width: 100%;
}

.cron-hint.error {
  color: var(--error-color, #d03050);
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* 响应式：窄屏时历史移到下方 */
@media (max-width: 900px) {
  .scheduler-body {
    flex-direction: column;
  }

  .history-section {
    width: 100%;
    position: static;
  }
}
</style>
