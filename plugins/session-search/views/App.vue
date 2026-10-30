<template>
  <div class="ss-page">
    <div class="ss-inner">
      <header class="ss-head">
        <div class="ss-head-text">
          <h1>会话全文搜索</h1>
          <p>在本地全部历史会话中检索关键词，命中片段会高亮；点击结果直接打开对应会话。</p>
        </div>
        <div class="ss-head-actions">
          <button class="ss-btn ghost" :disabled="indexing" @click="reindex">
            {{ indexing ? '重建中' : '重建索引' }}
          </button>
        </div>
      </header>

      <div class="ss-stats">
        <div class="ss-stat">
          <span class="ss-stat-v">{{ status.indexing ? progressText : status.totalDocs }}</span>
          <span class="ss-stat-k">{{ status.indexing ? '索引进度' : '已索引消息' }}</span>
        </div>
        <div class="ss-stat">
          <span class="ss-stat-v">{{ status.sessionCount }}</span>
          <span class="ss-stat-k">覆盖会话</span>
        </div>
        <div class="ss-stat">
          <span class="ss-stat-v">{{ lastIndexedText }}</span>
          <span class="ss-stat-k">上次索引</span>
        </div>
      </div>

      <div class="ss-search">
        <input
          ref="inputRef"
          v-model="query"
          class="ss-input"
          type="search"
          placeholder="输入关键词，多个词用空格分隔…"
          @keydown.enter.prevent="runSearch"
        />
        <button class="ss-btn" :disabled="loading || !query.trim()" @click="runSearch">
          {{ loading ? '搜索中' : '搜索' }}
        </button>
      </div>

      <div class="ss-filters">
        <button
          v-for="option in roleOptions"
          :key="option.value"
          class="ss-chip"
          :class="{ on: roleFilter === option.value }"
          @click="setRole(option.value)"
        >
          {{ option.label }}
        </button>
        <span class="ss-grow"></span>
        <span v-if="searched && !loading" class="ss-hint">
          {{ results.length ? `命中 ${results.length} 条，模式 ${modeLabel}` : '没有命中' }}
        </span>
      </div>

      <div v-if="errorText" class="ss-error">{{ errorText }}</div>

      <div v-if="!searched && !loading" class="ss-empty">
        <p>还没有搜索。可以试试最近活跃的会话：</p>
        <div class="ss-recent">
          <button v-for="item in recent" :key="item.sessionId" class="ss-recent-row" @click="openSession(item.sessionId)">
            <span class="ss-recent-title">{{ item.sessionTitle }}</span>
            <span class="ss-recent-meta">{{ item.messageCount }} 条 · {{ formatTime(item.lastTs) }}</span>
          </button>
        </div>
        <p v-if="!recent.length" class="ss-dim">索引尚未就绪，稍等片刻或点击重建索引。</p>
      </div>

      <div v-if="results.length" class="ss-results">
        <article v-for="item in results" :key="item.msgId" class="ss-row" @click="openSession(item.sessionId)">
          <div class="ss-row-head">
            <span class="ss-role" :class="`ss-role-${item.role}`">{{ roleLabel(item) }}</span>
            <span class="ss-title">{{ item.sessionTitle }}</span>
            <span class="ss-time">{{ formatTime(item.timestamp) }}</span>
          </div>
          <p class="ss-snippet" v-html="item.snippet"></p>
        </article>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const API = '/api/plugins/session-search'

const query = ref('')
const loading = ref(false)
const searched = ref(false)
const results = ref([])
const recent = ref([])
const roleFilter = ref('')
const errorText = ref('')
const inputRef = ref(null)
const mode = ref('')
const status = ref({
  ready: false,
  indexing: false,
  progress: { done: 0, total: 0 },
  totalDocs: 0,
  sessionCount: 0,
  lastIndexedAt: 0,
  lastError: null
})

const roleOptions = [
  { value: '', label: '全部' },
  { value: 'user', label: '我的提问' },
  { value: 'assistant', label: 'AI 回复' }
]

const indexing = computed(() => status.value.indexing)
const progressText = computed(() => {
  const { done, total } = status.value.progress || {}
  return total ? `${done}/${total}` : '…'
})
const lastIndexedText = computed(() => (status.value.lastIndexedAt ? formatTime(status.value.lastIndexedAt) : '未建立'))
const modeLabel = computed(() => (mode.value === 'fts' ? '全文索引' : mode.value === 'like' ? '子串匹配' : '—'))

let pollTimer = null

function formatTime(ts) {
  const value = Number(ts)
  if (!value) return '—'
  const date = new Date(value)
  const pad = (n) => String(n).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (date.toDateString() === new Date().toDateString()) return clock
  return `${date.getMonth() + 1}/${date.getDate()} ${clock}`
}

function roleLabel(item) {
  if (item.role === 'user') return '提问'
  if (item.semanticType === 'execution_result') return '工具'
  return '回复'
}

function setRole(value) {
  roleFilter.value = value
  if (searched.value && query.value.trim()) runSearch()
}

async function loadStatus() {
  try {
    const response = await fetch(`${API}/status`)
    const json = await response.json()
    if (json?.success) status.value = json.data
  } catch { /* 状态读取失败时保留旧值 */ }
}

async function loadRecent() {
  try {
    const response = await fetch(`${API}/recent?limit=8`)
    const json = await response.json()
    if (json?.success) recent.value = json.data || []
  } catch { /* 最近列表失败时保持空 */ }
}

async function runSearch() {
  const q = query.value.trim()
  if (!q) return
  loading.value = true
  errorText.value = ''
  try {
    const params = new URLSearchParams({ q, limit: '40' })
    if (roleFilter.value) params.set('role', roleFilter.value)
    const response = await fetch(`${API}/search?${params.toString()}`)
    const json = await response.json()
    if (!response.ok || !json?.success) throw new Error(json?.error || '搜索失败')
    results.value = json.data?.results || []
    mode.value = json.data?.mode || ''
    if (json.data?.status) status.value = json.data.status
    searched.value = true
  } catch (error) {
    errorText.value = error.message || '搜索失败'
    results.value = []
  } finally {
    loading.value = false
  }
}

async function reindex() {
  errorText.value = ''
  try {
    const response = await fetch(`${API}/reindex`, { method: 'POST' })
    const json = await response.json()
    if (json?.data?.status) status.value = json.data.status
    if (!json?.success) throw new Error(json?.data?.error || json?.error || '重建索引失败')
    await loadRecent()
    if (searched.value && query.value.trim()) await runSearch()
  } catch (error) {
    errorText.value = error.message || '重建索引失败'
  }
}

function openSession(sessionId) {
  const api = window.artificer
  if (api?.openSession) api.openSession(sessionId)
}

onMounted(async () => {
  await loadStatus()
  await loadRecent()
  inputRef.value?.focus?.()
  pollTimer = setInterval(async () => {
    if (!status.value.indexing) return
    await loadStatus()
    if (!status.value.indexing) await loadRecent()
  }, 1200)
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
})
</script>

<style>
.ss-page {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 26px 24px 48px;
  box-sizing: border-box;
  color: inherit;
  font-size: 13px;
  scrollbar-width: thin;
}
.ss-page::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
.ss-page::-webkit-scrollbar-thumb {
  background: rgba(128, 128, 128, 0.45);
  border-radius: 5px;
}
.ss-page::-webkit-scrollbar-track {
  background: transparent;
}
.ss-inner {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 900px;
  margin: 0 auto;
}
.ss-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.ss-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.ss-head-text h1 {
  margin: 0 0 6px;
  font-size: 18px;
  font-weight: 600;
}
.ss-head-text p {
  margin: 0;
  font-size: 12px;
  opacity: 0.65;
  line-height: 1.6;
}
.ss-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}
.ss-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border: 1px solid rgba(128, 128, 128, 0.24);
  border-radius: 10px;
}
.ss-stat-v {
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.ss-stat-k {
  font-size: 11px;
  opacity: 0.6;
}
.ss-search {
  display: flex;
  gap: 8px;
}
.ss-input {
  flex: 1;
  min-width: 0;
  padding: 9px 12px;
  font-size: 13px;
  color: inherit;
  background: transparent;
  border: 1px solid rgba(128, 128, 128, 0.32);
  border-radius: 8px;
  outline: none;
}
.ss-input:focus {
  border-color: #3b82f6;
}
.ss-btn {
  padding: 9px 16px;
  font-size: 13px;
  color: #fff;
  background: #3b82f6;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
}
.ss-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ss-btn.ghost {
  color: inherit;
  background: transparent;
  border-color: rgba(128, 128, 128, 0.32);
}
.ss-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ss-chip {
  padding: 4px 12px;
  font-size: 12px;
  color: inherit;
  background: transparent;
  border: 1px solid rgba(128, 128, 128, 0.32);
  border-radius: 999px;
  cursor: pointer;
}
.ss-chip.on {
  color: #3b82f6;
  border-color: #3b82f6;
  background: rgba(59, 130, 246, 0.1);
}
.ss-grow { flex: 1 }
.ss-hint, .ss-dim {
  font-size: 12px;
  opacity: 0.6;
}
.ss-error {
  padding: 10px 12px;
  font-size: 12px;
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.45);
  background: rgba(239, 68, 68, 0.1);
  border-radius: 8px;
  white-space: pre-wrap;
}
.ss-empty {
  font-size: 12px;
  line-height: 1.7;
  opacity: 0.8;
}
.ss-recent {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0 0;
}
.ss-recent-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  text-align: left;
  color: inherit;
  background: transparent;
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 8px;
  cursor: pointer;
}
.ss-recent-row:hover {
  background: rgba(128, 128, 128, 0.1);
}
.ss-recent-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ss-recent-meta {
  flex-shrink: 0;
  font-size: 11px;
  opacity: 0.6;
}
.ss-results {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ss-row {
  padding: 10px 12px;
  border: 1px solid rgba(128, 128, 128, 0.2);
  border-radius: 10px;
  cursor: pointer;
}
.ss-row:hover {
  border-color: rgba(59, 130, 246, 0.5);
  background: rgba(59, 130, 246, 0.06);
}
.ss-row-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.ss-role {
  flex-shrink: 0;
  padding: 1px 6px;
  font-size: 10px;
  border-radius: 4px;
  border: 1px solid rgba(128, 128, 128, 0.35);
  opacity: 0.85;
}
.ss-role-user {
  color: #22c55e;
  border-color: rgba(34, 197, 94, 0.45);
}
.ss-role-assistant {
  color: #3b82f6;
  border-color: rgba(59, 130, 246, 0.45);
}
.ss-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  opacity: 0.75;
}
.ss-time {
  flex-shrink: 0;
  font-size: 11px;
  opacity: 0.55;
}
.ss-snippet {
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  word-break: break-word;
  opacity: 0.9;
}
.ss-snippet mark {
  padding: 0 2px;
  color: #b45309;
  background: rgba(251, 191, 36, 0.3);
  border-radius: 3px;
}
@media (max-width: 720px) {
  .ss-page {
    padding: 14px 14px 32px;
  }
  .ss-head {
    flex-direction: column;
    gap: 10px;
  }
}
</style>
