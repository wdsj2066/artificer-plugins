const API = '/api/plugins/trace-viewer'
const MAX_CLIENT = 2000

async function readJson(response) {
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`)
  if (data?.success === false) throw new Error(data.error || '请求失败')
  return data?.data !== undefined ? data.data : data
}

export function createTraceUiState(ctx) {
  const { computed, ref } = ctx.Vue
  const events = ref([])
  const seq = ref(0)
  const total = ref(0)
  const errorCount = ref(0)
  const paused = ref(false)
  const connError = ref('')
  const keyword = ref('')
  const kindFilter = ref('')
  const pointFilter = ref('')
  const selected = ref(null)
  const expanded = ref(null)
  let timer = null
  let inFlight = false

  const filtered = computed(() => {
    const needle = keyword.value.trim().toLowerCase()
    return events.value.filter(item => {
      if (kindFilter.value && item.kind !== kindFilter.value) return false
      if (pointFilter.value && item.point !== pointFilter.value) return false
      if (!needle) return true
      return `${item.point} ${item.label || ''} ${item.status || ''} ${item.detail || ''} ${item.error || ''}`
        .toLowerCase().includes(needle)
    }).slice().reverse()
  })
  const pointOptions = computed(() => [...new Set(events.value.map(item => item.point).filter(Boolean))].sort())
  const live = computed(() => !paused.value && !connError.value)

  async function poll() {
    if (inFlight) return
    inFlight = true
    try {
      const data = await readJson(await ctx.window.fetch(`${API}/events?since=${seq.value}&limit=500`))
      const list = Array.isArray(data?.events) ? data.events : []
      const serverSeq = typeof data?.seq === 'number' ? data.seq : seq.value
      if (serverSeq < seq.value || (serverSeq === 0 && events.value.length)) {
        events.value = []
        selected.value = null
        expanded.value = null
      }
      const known = new Set(events.value.map(item => item.seq))
      const fresh = list.filter(item => !known.has(item.seq))
      if (fresh.length) events.value = events.value.concat(fresh).slice(-MAX_CLIENT)
      seq.value = serverSeq
      total.value = Number(data?.total) || total.value
      errorCount.value = Number(data?.errorCount) || 0
      paused.value = Boolean(data?.paused)
      connError.value = ''
      if (selected.value) selected.value = events.value.find(item => item.seq === selected.value.seq) || null
    } catch (cause) {
      connError.value = cause?.message || '连接失败'
    } finally {
      inFlight = false
    }
  }

  async function toggleCapture() {
    try {
      const data = await readJson(await ctx.window.fetch(`${API}/pause`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused: !paused.value })
      }))
      paused.value = Boolean(data?.paused)
    } catch (cause) {
      connError.value = cause?.message || '操作失败'
    }
  }

  async function clearAll() {
    if (!ctx.window.confirm('清空当前进程内的全部轨迹事件？')) return
    try {
      await readJson(await ctx.window.fetch(`${API}/clear`, { method: 'POST' }))
      events.value = []
      seq.value = 0
      total.value = 0
      errorCount.value = 0
      selected.value = null
      expanded.value = null
    } catch (cause) {
      connError.value = cause?.message || '清空失败'
    }
  }

  async function copyDetail(item = selected.value) {
    if (!item) return
    const value = pretty(item)
    try {
      await ctx.window.navigator.clipboard.writeText(value)
      ctx.artificer.toast?.('轨迹详情已复制', 'success')
    } catch {
      ctx.artificer.toast?.('复制失败', 'error')
    }
  }

  void poll()
  timer = ctx.window.setInterval(poll, 700)
  ctx.disposeWithPlugin(() => {
    if (timer) ctx.window.clearInterval(timer)
    timer = null
  })

  return ctx.Vue.reactive({
    events,
    seq,
    total,
    errorCount,
    paused,
    connError,
    keyword,
    kindFilter,
    pointFilter,
    selected,
    expanded,
    filtered,
    pointOptions,
    live,
    poll,
    toggleCapture,
    clearAll,
    copyDetail,
    kindLabel,
    formatTime,
    pretty
  })
}

export function kindLabel(kind) {
  return {
    start: '开始', end: '结束', outcome: '结果', tool: '工具', ai: 'AI',
    decision: '决策', event: '事件', recovery: '恢复', lifecycle: '生命周期'
  }[kind] || kind || '事件'
}

export function formatTime(timestamp) {
  const date = new Date(timestamp)
  const pad = (value, size = 2) => String(value).padStart(size, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

export function pretty(item) {
  if (!item?.detail) return '(当前设置未记录载荷)'
  try {
    const value = JSON.stringify(JSON.parse(item.detail), null, 2)
    return value.length > 12_000 ? `${value.slice(0, 12_000)}\n… 已截断` : value
  } catch {
    return item.detail
  }
}
