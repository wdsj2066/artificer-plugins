<template>
  <div class="usage-page" @scroll.capture="hoveredDay = null">
    <div class="usage-inner">
    <header class="usage-header">
      <div><h1>用量统计</h1><p>每一次探索，都留下足迹。</p></div>
      <div class="usage-controls">
        <div class="year-picker"><CalendarDays :size="14" /><n-select v-model:value="year" :options="yearOptions" size="small" aria-label="统计年份" :consistent-menu-width="false" :show-checkmark="false" /></div>
        <button class="refresh-btn" :disabled="loading" title="刷新统计" aria-label="刷新统计" @click="load"><RefreshCw :size="15" :class="{ spinning: loading }" /></button>
      </div>
    </header>

    <div v-if="error" class="usage-notice" role="alert">{{ error }} <button @click="load">重试</button></div>
    <div v-if="skipped" class="usage-notice">有 {{ skipped }} 个会话暂时无法读取，以下为其余会话的数据。</div>
    <div class="usage-period"><span>{{ selectedDate ? selectedDate + ' · 当日概览' : '消耗概览' }}</span><div class="period-tabs"><button v-for="p in periods" :key="p.days" :class="{ selected: range === p.days }" @click="range = p.days">{{ p.label }}</button></div></div>
    <div v-if="selectedDate || selectedWorkspace" class="usage-filter-strip">
      <span>正在查看</span><button v-if="selectedDate" @click="selectedDate = null">{{ selectedDate }} <span>×</span></button><button v-if="selectedWorkspace" @click="selectedWorkspace = null">{{ workspaceName }} <span>×</span></button><button class="clear-filters" @click="clearFilters">清除筛选</button>
    </div>
    <div class="usage-metrics" :aria-busy="loading">
      <div v-for="metric in metrics" :key="metric.label" class="usage-metric"><div class="metric-label">{{ metric.label }}<component :is="metric.icon" :size="15" /></div><div class="metric-number" :title="`${format(metric.value)} tokens`">{{ loading && !loaded ? '—' : compact(metric.value) }}<span>{{ metric.unit }}</span></div><small>{{ metric.detail }}</small></div>
    </div>

    <section class="usage-section activity-section">
      <div class="usage-section-title"><div><h2>每日足迹</h2><p>{{ year }} 年累计 <strong>{{ format(annualTotal) }}</strong> tokens · <strong>{{ activeDays }}</strong> 个活跃日</p></div><span class="section-caption">{{ selectedWorkspace ? workspaceName : '年度消耗分布' }}</span></div>
      <div class="heatmap-scroll">
        <div class="heatmap" :style="{ '--weeks': weeks.length }">
          <div class="month-labels"><span v-for="m in months" :key="m.label" :style="{ gridColumn: m.column }">{{ m.label }}月</span></div>
          <div class="weekday-labels"><span>一</span><span>三</span><span>五</span></div>
          <div class="heatmap-weeks"><div v-for="(week, wi) in weeks" :key="wi" class="heatmap-week"><div v-for="(day, di) in week" :key="di" class="heat-cell" :class="{ outside: !day, 'is-selected': day && selectedDate === day.date }" role="button" :aria-pressed="day ? selectedDate === day.date : undefined" @click="selectDay(day)" @keydown.enter.prevent="selectDay(day)" @keydown.space.prevent="selectDay(day)" :data-level="level(day?.total || 0)" @mouseenter="showDay($event, day)" @mouseleave="hoveredDay = null" @focus="showDay($event, day)" @blur="hoveredDay = null" @keydown.esc="hoveredDay = null" :aria-label="day ? `${day.date}，${day.total} tokens` : undefined" :tabindex="day ? 0 : undefined"></div></div></div>
        </div>
      </div>
      <div class="heatmap-footer"><span><span class="tiny-dot"></span>点击日期查看当天消耗</span><div class="heat-legend">少 <i v-for="n in 5" :key="n" :data-level="n - 1"></i> 多</div></div>
      <div v-if="loaded && !annualTotal" class="usage-empty"><Sprout :size="20" /><span>这一年还没有用量记录。开始一次对话，点亮第一格足迹。</span></div>
    </section>

    <n-popover trigger="manual" :show="!!hoveredDay" :x="hoverPoint.x" :y="hoverPoint.y" placement="top" :show-arrow="false" :animated="false" :style="{ pointerEvents: 'none' }">
      <div v-if="hoveredDay" class="day-tooltip">
        <div class="day-tooltip-date">{{ hoveredDay.date.replaceAll('-', ' / ') }}<span>{{ hoveredDay.date === today ? '今天' : '每日用量' }}</span></div>
        <div class="day-tooltip-total">{{ format(hoveredDay.total) }}<small>总消耗</small></div>
        <div class="day-tooltip-rows">
          <div><span>输入</span><strong>{{ format(hoveredDay.input) }}</strong></div>
          <div><span>输出</span><strong>{{ format(hoveredDay.output) }}</strong></div>
          <div><span>缓存命中</span><strong>{{ format(hoveredDay.cached) }}</strong></div>
        </div>
        <div class="day-tooltip-footer">{{ hoveredDay.calls }} 次响应<span>缓存已包含在输入中</span></div>
      </div>
    </n-popover>

    <div class="usage-detail-grid">
      <div class="usage-waterfall-column">
      <section class="usage-section trend-section">
        <div class="usage-section-title"><div><h2>消耗趋势</h2><p>最近 {{ trend.length }} 天 · 输入与输出</p></div><div class="chart-legend"><span><i></i>输入</span><span><i></i>输出</span></div></div>
        <div class="trend-chart"><div class="chart-scale"><span>{{ compact(chartMax) }}</span><span>{{ compact(chartMax / 2) }}</span><span>0</span></div><div class="chart-bars"><div v-for="d in trend" :key="d.date" class="chart-column" :title="`${d.date}\n输入 ${format(d.input)} · 输出 ${format(d.output)}`"><div class="chart-bar" :style="{ height: `${(d.input + d.output) / chartMax * 100}%` }"><span :style="{ flexGrow: d.output }"></span><i :style="{ flexGrow: d.input }"></i></div></div></div></div>
        <div class="chart-dates"><span>{{ trend[0]?.date.slice(5) }}</span><span>{{ trend.at(-1)?.date.slice(5) }}</span></div>
      </section>
      <section class="usage-section cache-section">
        <div class="cache-heading"><h2>输入构成</h2><span>{{ percent(totals.cached, totals.input) }}% 缓存命中</span></div>
        <div class="cache-track"><i :style="{ width: `${percent(totals.cached, totals.input)}%` }"></i></div>
        <div class="cache-breakdown"><span><i></i>缓存输入 <strong>{{ compact(totals.cached) }}</strong></span><span><i></i>非缓存输入 <strong>{{ compact(totals.input - totals.cached) }}</strong></span></div>
      </section>
      <section class="usage-section workspace-section">
        <div class="usage-section-title"><div><h2>工作区排行</h2><p>{{ selectedDate || '所选时间段' }} · 点击工作区筛选</p></div><FolderOpen :size="17" class="muted-icon" /></div>
        <div v-if="!workspaceRanking.length" class="model-empty">暂无工作区用量</div>
        <button v-for="(workspace, i) in workspaceRanking" :key="workspace.id" class="workspace-rank-row" :class="{ active: selectedWorkspace === workspace.id }" :aria-pressed="selectedWorkspace === workspace.id" @click="selectedWorkspace = selectedWorkspace === workspace.id ? null : workspace.id">
          <span class="model-rank">{{ String(i + 1).padStart(2, '0') }}</span><div class="model-body"><div class="model-line"><span>{{ workspace.name }}</span><strong>{{ compact(workspace.total) }} <small>{{ percent(workspace.total, workspaceTotal) }}%</small></strong></div><div class="model-meter"><i :style="{ width: `${percent(workspace.total, workspaceRanking[0].total)}%` }"></i></div><div class="rank-meta">{{ workspace.sessionCount }} 个会话 · {{ format(workspace.calls) }} 次响应</div></div>
        </button>
      </section>
      </div>
      <div class="usage-waterfall-column">
      <section class="usage-section models-section">
        <div class="usage-section-title"><div><h2>模型用量</h2><p>所选时间段 · 按 token 消耗排序</p></div><Layers3 :size="17" class="muted-icon" /></div>
        <div v-if="!models.length" class="model-empty">暂无模型用量</div>
        <div v-for="(model, index) in models.slice(0, 6)" :key="model.name" class="usage-model"><span class="model-rank">{{ String(index + 1).padStart(2, '0') }}</span><div class="model-body"><div class="model-line"><span :title="model.name">{{ model.name }}</span><strong>{{ compact(model.total) }} <small>{{ percent(model.total, totals.input + totals.output) }}%</small></strong></div><div class="model-meter"><i :style="{ width: `${percent(model.total, models[0].total)}%` }"></i></div></div></div>
      </section>
      <section class="usage-section session-ranking-section">
        <div class="usage-section-title"><div><h2>会话排行</h2><p>{{ selectedDate || '所选时间段' }} · {{ sessionRanking.length }} 个会话</p></div><MessageSquare :size="17" class="muted-icon" /></div>
        <div v-if="!sessionRanking.length" class="model-empty">暂无会话用量</div>
        <button v-for="(session, i) in (expandedSessions ? sessionRanking : sessionRanking.slice(0, 6))" :key="session.id" class="session-rank-row" :disabled="session.status === 'trashed'" :title="session.status === 'trashed' ? '会话已在回收站' : '打开会话：' + session.title" @click="openSession(session)">
          <span class="model-rank">{{ String(i + 1).padStart(2, '0') }}</span><div class="model-body"><div class="session-rank-title">{{ session.title }}</div><div class="rank-meta">{{ session.workspaceName }} · {{ format(session.calls) }} 次响应 <span v-if="session.status === 'trashed'">· 已回收</span></div><div class="session-rank-usage"><strong>{{ compact(session.total) }} <small>tokens</small></strong><span>{{ percent(session.total, totals.input + totals.output) }}%</span></div></div><ArrowUpRight :size="14" class="session-open-icon" />
        </button>
        <button v-if="sessionRanking.length > 6" class="show-more" @click="expandedSessions = !expandedSessions">{{ expandedSessions ? '收起' : `查看全部 ${sessionRanking.length} 个会话` }}</button>
      </section>
      </div>
    </div>
    <footer class="usage-footnote"><span>北京时间 · 已保存的模型响应 · 缓存 token 已包含在输入量中</span><span>{{ updatedAt ? `更新于 ${new Date(updatedAt).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}` : '等待加载' }}</span></footer>
    </div>
  </div>
</template>

<script setup>
import { NPopover, NSelect } from 'naive-ui'
import { computed, inject, onMounted, ref, watch } from 'vue'
import { rankUsage } from './analytics.js'
import { CalendarDays, FolderOpen, MessageSquare, RefreshCw, ArrowDownLeft, ArrowUpRight, Layers3, Sprout, Zap, Database } from 'lucide-vue-next'

const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
const currentYear = Number(today.slice(0, 4))
const year = ref(currentYear)
const yearOptions = Array.from({ length: 10 }, (_, i) => ({ label: `${currentYear - i} 年`, value: currentYear - i }))
const rows = ref([])
const sessionRows = ref([])
const sessionInfo = ref([])
const workspaceInfo = ref([])
const selectedDate = ref(null)
const selectedWorkspace = ref(null)
const expandedSessions = ref(false)
const artificer = inject('artificer', null)
const sessionLookup = computed(() => new Map(sessionInfo.value.map(s => [s.id, s])))
const scopedRows = computed(() => sessionRows.value
  .filter(r => !selectedWorkspace.value || sessionLookup.value.get(r.sessionId)?.workspaceId === selectedWorkspace.value)
  .map(r => ({ ...r, sessions: [r.sessionId] })))
const periodRows = computed(() => sessionRows.value.filter(r => selectedDate.value ? r.day === selectedDate.value : r.day >= startDate.value && r.day <= endDate.value))
const workspaceRanking = computed(() => rankUsage(periodRows.value, sessionInfo.value, workspaceInfo.value).workspaces)
const workspaceTotal = computed(() => workspaceRanking.value.reduce((n, w) => n + w.total, 0))
const sessionRanking = computed(() => rankUsage(filtered.value, sessionInfo.value, workspaceInfo.value).sessions)
const workspaceName = computed(() => workspaceInfo.value.find(w => w.id === selectedWorkspace.value)?.name || '未归属工作区')
function selectDay(day) {
  if (day) selectedDate.value = selectedDate.value === day.date ? null : day.date
  hoveredDay.value = null
}
function openSession(session) {
  if (session.status === 'trashed') return
  const api = artificer || window.artificer
  api?.openSession?.(session.id)
}
function clearFilters() { selectedDate.value = null; selectedWorkspace.value = null }

const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const skipped = ref(0)
const updatedAt = ref(0)
const range = ref(30)
const hoveredDay = ref(null)
const hoverPoint = ref({ x: 0, y: 0 })
function showDay(event, day) {
  if (!day) return
  const rect = event.currentTarget.getBoundingClientRect()
  hoverPoint.value = { x: rect.left + rect.width / 2, y: rect.top - 8 }
  hoveredDay.value = day
}
const periods = [{ days: 7, label: '近 7 天' }, { days: 30, label: '近 30 天' }, { days: 90, label: '近 90 天' }, { days: 0, label: '全年' }]
const format = n => new Intl.NumberFormat('zh-CN').format(Math.round(n || 0))
const compact = n => n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}K` : format(n)
const percent = (n, total) => total ? Math.round(n / total * 100) : 0
const dateString = n => new Date(n).toISOString().slice(0, 10)
const dayMs = 86400000
const endDate = computed(() => year.value === currentYear ? today : `${year.value}-12-31`)
const startDate = computed(() => range.value ? dateString(Date.parse(endDate.value) - (range.value - 1) * dayMs) : `${year.value}-01-01`)
const filtered = computed(() => scopedRows.value.filter(r => selectedDate.value ? r.day === selectedDate.value : r.day >= startDate.value && r.day <= endDate.value))
const totals = computed(() => filtered.value.reduce((a, r) => {
  for (const k of ['input', 'output', 'cached', 'calls']) a[k] += r[k]
  for (const id of r.sessions) a.sessions.add(id)
  return a
}, { input: 0, output: 0, cached: 0, calls: 0, sessions: new Set() }))
const metrics = computed(() => [
  { label: '总消耗', value: totals.value.input + totals.value.output, unit: 'tokens', detail: `${format(totals.value.calls)} 次有用量记录的响应`, icon: Zap },
  { label: '输入 Token', value: totals.value.input, unit: 'tokens', detail: '提示词、上下文及工具结果', icon: ArrowDownLeft },
  { label: '输出 Token', value: totals.value.output, unit: 'tokens', detail: `覆盖 ${totals.value.sessions.size} 个会话`, icon: ArrowUpRight },
  { label: '缓存命中', value: totals.value.cached, unit: 'tokens', detail: `占输入量 ${percent(totals.value.cached, totals.value.input)}%`, icon: Database }
])
const daily = computed(() => {
  const map = new Map()
  for (const r of scopedRows.value) {
    if (!map.has(r.day)) map.set(r.day, { input: 0, output: 0, cached: 0, calls: 0, total: 0 })
    const d = map.get(r.day)
    d.input += r.input; d.output += r.output; d.cached += r.cached; d.calls += r.calls; d.total += r.input + r.output
  }
  return map
})
const annualTotal = computed(() => scopedRows.value.reduce((n, r) => n + r.input + r.output, 0))
const activeDays = computed(() => [...daily.value.values()].filter(d => d.total > 0).length)
const maxDaily = computed(() => Math.max(1, ...[...daily.value.values()].map(d => d.total)))
function level(total) { return total <= 0 ? 0 : Math.max(1, Math.ceil(total / maxDaily.value * 4)) }
const weeks = computed(() => {
  const first = Date.parse(`${year.value}-01-01`)
  const last = Date.parse(endDate.value)
  const offset = (new Date(first).getUTCDay() + 6) % 7
  const days = Array(offset).fill(null)
  for (let time = first; time <= last; time += dayMs) {
    const date = dateString(time)
    days.push({ date, total: 0, input: 0, output: 0, cached: 0, calls: 0, ...daily.value.get(date) })
  }
  while (days.length % 7) days.push(null)
  return Array.from({ length: days.length / 7 }, (_, i) => days.slice(i * 7, i * 7 + 7))
})
const months = computed(() => {
  const result = []
  weeks.value.forEach((week, index) => {
    const first = week.find(d => d?.date.endsWith('-01'))
    if (first) result.push({ label: Number(first.date.slice(5, 7)), column: index + 1 })
  })
  return result
})
const trend = computed(() => {
  const end = Date.parse(endDate.value)
  const count = range.value && range.value < 30 ? range.value : 30
  return Array.from({ length: count }, (_, i) => {
    const date = dateString(end - (count - i - 1) * dayMs)
    return { date, input: 0, output: 0, ...daily.value.get(date) }
  })
})
const chartMax = computed(() => Math.max(1, ...trend.value.map(d => d.input + d.output)))
const models = computed(() => {
  const map = new Map()
  for (const r of filtered.value) map.set(r.model, (map.get(r.model) || 0) + r.input + r.output)
  return [...map].map(([name, total]) => ({ name, total })).sort((a, b) => b.total - a.total)
})
let requestId = 0
async function load() {
  const id = ++requestId
  loading.value = true
  error.value = ''
  try {
    const response = await fetch(`/api/plugins/statistics/usage?year=${year.value}`)
    if (!response.ok) throw new Error('加载用量失败，请稍后重试')
    const result = await response.json()
    if (!result.success) throw new Error(result.error || '加载用量失败')
    if (id !== requestId) return
    rows.value = result.data.rows
    sessionRows.value = result.data.sessionRows || []
    sessionInfo.value = result.data.sessions || []
    workspaceInfo.value = result.data.workspaces || []
    skipped.value = result.data.skippedSessions
    updatedAt.value = result.data.updatedAt
    loaded.value = true
  } catch (e) {
    if (id === requestId) error.value = e.message
  } finally {
    if (id === requestId) loading.value = false
  }
}
watch(year, () => { rows.value = []; sessionRows.value = []; selectedDate.value = null; hoveredDay.value = null; loaded.value = false; load() })
watch(range, () => { selectedDate.value = null })
watch([selectedDate, selectedWorkspace, range], () => { expandedSessions.value = false })
onMounted(load)
</script>

<style scoped>
.usage-page { --usage-accent: var(--accent); --heat-0: #edf0f3; --heat-1: color-mix(in srgb, var(--accent) 22%, var(--surface-solid)); --heat-2: color-mix(in srgb, var(--accent) 45%, var(--surface-solid)); --heat-3: color-mix(in srgb, var(--accent) 72%, var(--surface-solid)); --heat-4: var(--accent); padding: 32px 36px 20px; overflow-y: auto; height: 100%; color: var(--text-primary); font-family: 'Segoe UI', 'Microsoft YaHei UI', sans-serif; }
.usage-inner { max-width: 1200px; margin: 0 auto; }
:global([data-theme="dark"]) .usage-page { --heat-0: #3b3e43; }
.usage-header { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 30px; }

h1 { display: flex; align-items: center; gap: 10px; font-size: 25px; font-weight: 600; margin: 0; letter-spacing: -.5px; }
.usage-header p, .usage-section-title p { font-size: 12px; color: var(--text-muted); margin: 6px 0 0; }
.usage-controls { display: flex; align-items: center; gap: 8px; }
.year-picker, .refresh-btn { display: flex; align-items: center; gap: 7px; border: 1px solid var(--panel-border); border-radius: 7px; background: var(--surface-solid); color: var(--text-secondary); height: 32px; padding: 0 10px; }
.year-picker { padding-right: 0; gap: 3px; }
.year-picker :deep(.n-select) { width: 94px; }
.year-picker :deep(.n-base-selection) { --n-height: 30px !important; --n-font-size: 12px !important; --n-color: transparent !important; --n-color-active: transparent !important; --n-border: none !important; --n-border-hover: none !important; --n-border-active: none !important; --n-border-focus: none !important; --n-box-shadow-active: none !important; --n-box-shadow-focus: none !important; }
/* 外层统一承载底色，覆盖全局输入框填充，避免默认与聚焦状态出现双层背景。 */
.year-picker :deep(.n-base-selection),
.year-picker :deep(.n-base-selection .n-base-selection-label),
.year-picker :deep(.n-base-selection .n-base-selection-tags) { background-color: transparent !important; }
.year-picker:focus-within { border-color: var(--accent); }
button { font-family: inherit; cursor: pointer; } button:disabled { cursor: wait; opacity: .5; }
.usage-period { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; margin-bottom: 12px; }
.period-tabs { display: flex; gap: 2px; padding: 3px; background: var(--sidebar-hover); border-radius: 7px; }
.period-tabs button { border: none; padding: 4px 10px; border-radius: 5px; font-size: 11px; color: var(--text-muted); background: transparent; }
.period-tabs .selected { color: var(--text-primary); background: var(--surface-solid); box-shadow: 0 1px 3px #0000000d; }
.usage-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 26px; }
.usage-metric { padding: 17px 18px; border: 1px solid var(--panel-border); background: var(--panel-surface); border-radius: 10px; }
.metric-label { display: flex; justify-content: space-between; align-items: center; color: var(--text-secondary); font-size: 12px; }
.metric-label svg { color: var(--usage-accent); }
.metric-number { font-size: 28px; font-variant-numeric: tabular-nums; font-weight: 600; letter-spacing: -.6px; margin: 12px 0 5px; white-space: nowrap; }
.metric-number span { display: inline-block; margin-left: 6px; font-size: 10px; font-weight: 400; letter-spacing: 0; color: var(--text-muted); }
.usage-metric small { font-size: 10px; color: var(--text-muted); }
.usage-section { background: var(--panel-surface); border: 1px solid var(--panel-border); padding: 22px; border-radius: 11px; min-width: 0; }
.usage-section-title { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 22px; }
h2 { margin: 0; font-size: 14px; font-weight: 600; }
.usage-section-title p { font-size: 11px; } .usage-section-title strong { font-weight: 500; color: var(--text-secondary); }
.section-caption { font-size: 10px; color: var(--text-muted); }
.activity-section { background: var(--panel-surface); backdrop-filter: blur(18px) saturate(125%); -webkit-backdrop-filter: blur(18px) saturate(125%); }
.heatmap-scroll { width: 100%; min-width: 0; padding: 2px 2px 6px; }
.heatmap { display: grid; grid-template-columns: 20px minmax(0, 1fr); grid-template-rows: 20px 1fr; gap: 4px 6px; width: 100%; min-width: 0; --heat-gap: clamp(3px, .35vw, 5px); }
.month-labels { grid-column: 2; display: grid; grid-template-columns: repeat(var(--weeks), minmax(0, 1fr)); gap: var(--heat-gap); font-size: 10px; color: var(--text-muted); white-space: nowrap; }
.weekday-labels { grid-row: 2; display: grid; grid-template-rows: repeat(7, minmax(0, 1fr)); line-height: 1; font-size: 9px; color: var(--text-muted); align-items: center; }
.weekday-labels span:nth-child(2) { grid-row: 3; } .weekday-labels span:nth-child(3) { grid-row: 5; }
.heatmap-weeks { grid-column: 2; grid-row: 2; min-width: 0; display: grid; grid-template-columns: repeat(var(--weeks), minmax(0, 1fr)); gap: var(--heat-gap); }
.heatmap-week { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: repeat(7, auto); gap: var(--heat-gap); }
.heat-cell { cursor: pointer; width: 100%; min-width: 0; align-self: start; aspect-ratio: 1; border-radius: 2px; background: var(--heat-0); transition: outline .1s, background .15s; }
.heat-cell.is-selected, .heat-cell:hover, .heat-cell:focus-visible { outline: 2px solid var(--usage-accent); outline-offset: 1px; }
.heat-cell.outside { visibility: hidden; }
[data-level="1"] { background: var(--heat-1); } [data-level="2"] { background: var(--heat-2); } [data-level="3"] { background: var(--heat-3); } [data-level="4"] { background: var(--heat-4); }
.heatmap-footer { display: flex; align-items: center; justify-content: space-between; font-size: 10px; color: var(--text-muted); margin-top: 12px; gap: 8px; }
.heatmap-footer > span { display: flex; align-items: center; gap: 6px; }
.tiny-dot { width: 5px; height: 5px; background: var(--usage-accent); border-radius: 50%; }
.heat-legend { display: flex; align-items: center; gap: 4px; } .heat-legend i { width: 10px; height: 10px; border-radius: 2px; } .heat-legend [data-level="0"] { background: var(--heat-0); }
.usage-detail-grid { display: grid; grid-template-columns: 1.15fr 1fr; align-items: start; gap: 18px; margin-top: 18px; }
.usage-waterfall-column { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.usage-waterfall-column > .usage-section { flex: none; }
.cache-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.cache-heading > span { color: var(--usage-accent); font-size: 11px; }
.cache-track { height: 7px; border-radius: 4px; background: var(--heat-0); overflow: hidden; margin: 16px 0 12px; }
.cache-track > i { display: block; height: 100%; background: var(--heat-3); border-radius: inherit; }
.cache-breakdown { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: 10px; color: var(--text-muted); }
.cache-breakdown > span { display: flex; align-items: center; gap: 5px; }
.cache-breakdown strong { color: var(--text-secondary); font-weight: 500; margin-left: 4px; }
.cache-breakdown i { width: 6px; height: 6px; border-radius: 2px; background: var(--heat-3); }
.cache-breakdown > span:last-child i { background: var(--heat-0); }
.chart-legend { display: flex; gap: 10px; font-size: 10px; color: var(--text-muted); } .chart-legend span { display: flex; align-items: center; gap: 4px; } .chart-legend i { height: 6px; width: 6px; border-radius: 2px; background: var(--heat-3); } .chart-legend span:last-child i { background: var(--heat-1); }
.trend-chart { display: flex; height: 155px; gap: 12px; }
.chart-scale { display: flex; flex-direction: column; justify-content: space-between; font-size: 9px; color: var(--text-muted); min-width: 30px; }
.chart-bars { display: flex; align-items: flex-end; gap: 4px; flex: 1; border-bottom: 1px solid var(--panel-border); background: repeating-linear-gradient(to top, transparent 0, transparent calc(50% - 1px), var(--panel-border) 50%); }
.chart-column { height: 100%; flex: 1; display: flex; align-items: flex-end; min-width: 0; }
.chart-bar { display: flex; flex-direction: column; width: 100%; border-radius: 3px 3px 0 0; overflow: hidden; min-height: 0; } .chart-bar span { background: var(--heat-1); } .chart-bar i { background: var(--heat-3); } .chart-column:hover { opacity: .65; }
.chart-dates { display: flex; justify-content: space-between; padding-left: 42px; margin-top: 8px; color: var(--text-muted); font-size: 9px; }
.muted-icon { color: var(--text-muted); }
.usage-model { display: flex; align-items: center; gap: 12px; margin: 18px 0; } .model-rank { font-size: 10px; color: var(--text-muted); font-variant-numeric: tabular-nums; } .model-body { flex: 1; min-width: 0; }
.model-line { display: flex; justify-content: space-between; gap: 10px; font-size: 11px; } .model-line > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .model-line strong { white-space: nowrap; font-weight: 500; } .model-line small { color: var(--text-muted); margin-left: 6px; font-weight: 400; font-size: 10px; }
.model-meter { height: 4px; margin-top: 7px; background: var(--heat-0); border-radius: 3px; overflow: hidden; } .model-meter i { display: block; height: 100%; background: var(--heat-3); border-radius: inherit; }
.usage-model:last-child { margin-bottom: 0; }
.usage-footnote { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin-top: 18px; font-size: 10px; color: var(--text-muted); }
.usage-notice { padding: 10px 12px; border: 1px solid var(--panel-border); margin-bottom: 14px; font-size: 12px; } .usage-notice button { border: none; background: none; color: var(--usage-accent); }
.usage-empty, .model-empty { font-size: 12px; color: var(--text-muted); padding: 16px 0; display: flex; align-items: center; gap: 8px; }
.spinning { animation: usage-spin 1s linear infinite; } @keyframes usage-spin { to { transform: rotate(360deg); } }
@media (max-width: 1000px) { .usage-page { padding: 24px; } .usage-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } .usage-detail-grid { grid-template-columns: 1fr; } }
@media (max-width: 560px) { .usage-page { padding: 18px 14px; } .usage-section { padding: 16px; } .usage-period { align-items: flex-start; flex-direction: column; } .usage-header { gap: 10px; } .usage-header p { font-size: 11px; } .section-caption { display: none; } .usage-metric { padding: 13px; } }
@media (prefers-reduced-motion: reduce) { .spinning { animation: none; } }
.day-tooltip { min-width: 210px; padding: 4px; font-family: 'Segoe UI', 'Microsoft YaHei UI', sans-serif; }
.day-tooltip-date { display: flex; align-items: center; justify-content: space-between; gap: 20px; font-size: 12px; color: var(--text-primary); }
.day-tooltip-date > span { font-size: 10px; color: var(--text-muted); }
.day-tooltip-total { margin: 12px 0; font-size: 24px; font-weight: 600; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.day-tooltip-total small { font-size: 10px; color: var(--text-muted); font-weight: 400; margin-left: 8px; }
.day-tooltip-rows { display: grid; gap: 6px; border-top: 1px solid var(--panel-border); padding-top: 10px; }
.day-tooltip-rows > div { display: flex; justify-content: space-between; gap: 16px; font-size: 12px; }
.day-tooltip-rows span { color: var(--text-secondary); } .day-tooltip-rows strong { font-weight: 500; font-variant-numeric: tabular-nums; color: var(--text-primary); }
.day-tooltip-footer { display: flex; justify-content: space-between; gap: 18px; margin-top: 12px; font-size: 10px; color: var(--text-muted); }
.usage-filter-strip { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: -2px 0 14px; font-size: 11px; color: var(--text-muted); }
.usage-filter-strip button { display: inline-flex; align-items: center; gap: 8px; padding: 4px 8px; background: color-mix(in srgb, var(--accent) 10%, var(--surface-solid)); border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--panel-border)); border-radius: 5px; color: var(--text-primary); font-size: 11px; }
.usage-filter-strip .clear-filters { border-color: transparent; background: none; color: var(--text-secondary); }
.workspace-rank-row, .session-rank-row { display: flex; width: 100%; gap: 12px; align-items: center; text-align: left; padding: 12px 8px; border: 0; border-radius: 7px; background: transparent; color: var(--text-primary); transition: background .15s; }
.workspace-rank-row:hover, .session-rank-row:hover { background: var(--sidebar-hover); }
.workspace-rank-row.active { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.rank-meta { font-size: 10px; color: var(--text-muted); margin-top: 6px; line-height: 1.5; }
.session-rank-row + .session-rank-row { border-top: 1px solid var(--panel-border); border-radius: 0; }
.session-rank-title { font-size: 12px; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-rank-usage { margin-top: 7px; display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.session-rank-usage strong { font-weight: 500; font-size: 13px; font-variant-numeric: tabular-nums; } .session-rank-usage small, .session-rank-usage > span { font-size: 10px; font-weight: 400; color: var(--text-muted); }
.session-open-icon { color: var(--text-muted); flex-shrink: 0; } .session-rank-row:hover .session-open-icon { color: var(--accent); }
.session-rank-row:disabled { opacity: .6; cursor: default; }
.show-more { width: 100%; margin-top: 8px; padding: 8px; border: 1px solid var(--panel-border); border-radius: 6px; background: none; font-size: 11px; color: var(--text-secondary); }
.show-more:hover { background: var(--sidebar-hover); }
</style>
