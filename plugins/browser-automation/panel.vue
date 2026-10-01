<template>
  <section ref="root" class="browser-panel">
    <header class="browser-toolbar">
      <form class="browser-address" @submit.prevent="connectUrl">
        <input v-model="address" type="url" placeholder="http://localhost:5173/" :disabled="connecting || !sessionId" />
        <button type="submit" :disabled="connecting || !sessionId || !address.trim()">连接</button>
      </form>
      <button class="small-button" type="button" :disabled="!status?.previewUrl" title="重新加载页面" @click="reloadFrame">刷新</button>
      <button class="small-button" type="button" :disabled="!status?.previewUrl" @click="stopPreview">停止</button>
    </header>

    <div class="browser-status" :class="{ 'is-error': error }">
      <span class="status-dot" :class="{ active: status?.running || status?.bridgeReady }"></span>
      <span class="browser-status-text">{{ error || statusLabel }}</span>
    </div>

    <div v-if="status?.previewUrl" class="browser-page-toolbar">
      <button class="select-button" :class="{ active: selecting }" type="button" :disabled="!status.bridgeReady" @click="toggleSelectMode">
        {{ selecting ? '取消选择' : '选择页面元素' }}
      </button>
      <select v-model="preferredTag" :disabled="!status.bridgeReady || selecting" aria-label="选择元素类型">
        <option value="div">优先选择 div</option>
        <option value="section">优先选择 section</option>
        <option value="article">优先选择 article</option>
        <option value="main">优先选择 main</option>
        <option value="any">选择鼠标下的元素</option>
      </select>
      <span class="live-indicator">{{ status.bridgeReady ? '实时交互' : '正在连接页面…' }}</span>
    </div>

    <div v-if="status?.previewUrl" class="browser-frame-wrap">
      <iframe
        ref="frame"
        class="browser-frame"
        :key="status.previewUrl"
        :src="status.previewUrl"
        title="本机网页实时预览"
        sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-same-origin"
        allow="clipboard-read; clipboard-write; fullscreen"
        @load="onFrameLoad"
      ></iframe>
    </div>

    <div v-else class="browser-empty">
      <div class="empty-icon">⌘</div>
      <strong>启动 HTML 项目或连接本机预览</strong>
      <p>让 Agent 调用“启动网页预览”运行项目（默认 <code>npm run dev</code>），或直接传入工作区 HTML 文件路径。</p>
      <p>预览代理读取实际 HTML，并注入元素选择和自动化桥接；也可以在上方输入已运行的 localhost 地址。</p>
    </div>

    <section v-if="selection" class="selection-card">
      <div class="selection-card-heading">
        <div>
          <strong>已选择 &lt;{{ selection.tag || 'div' }}&gt;</strong>
          <code>{{ selection.selector }}</code>
        </div>
        <button type="button" class="text-button" @click="clearSelection">清除</button>
      </div>
      <p v-if="selection.text" class="selection-text">{{ selection.text }}</p>
      <pre v-if="selection.html" class="selection-html">{{ selection.html }}</pre>
      <div class="selection-actions">
        <button type="button" @click="compose('reference')">放入聊天框</button>
        <button type="button" @click="compose('question')">单独提问</button>
        <button type="button" class="primary" @click="compose('edit')">请求修改</button>
      </div>
    </section>

    <details v-if="status?.output" class="server-output">
      <summary>开发服务输出</summary>
      <pre>{{ status.output }}</pre>
    </details>
  </section>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

const props = defineProps({ sessionId: { type: String, default: null } })
const root = ref(null)
const frame = ref(null)
const status = ref(null)
const address = ref('')
const error = ref('')
const connecting = ref(false)
const selecting = ref(false)
const preferredTag = ref('div')
const selection = ref(null)
const frameReady = ref(false)
let statusTimer = null
let commandTimer = null
let intersectionObserver = null
let visible = true
let lastSelectionKey = ''

const statusLabel = computed(() => {
  if (!props.sessionId) return '请先打开一个聊天会话。'
  if (connecting.value) return '正在连接本机开发服务…'
  if (!status.value?.previewUrl) return '还没有活动的预览页面。'
  if (status.value.running) return '开发服务运行中'
  return '已连接本机开发服务'
})

async function request(url, options) {
  const response = await fetch(url, options)
  const payload = await response.json()
  if (!response.ok || payload?.success === false) throw new Error(payload?.error || `请求失败（HTTP ${response.status}）`)
  return payload
}

function applySelection(next) {
  selection.value = next || null
  const key = next ? `${next.selectedAt || ''}:${next.selector || ''}` : ''
  if (key === lastSelectionKey) return
  lastSelectionKey = key
  window.dispatchEvent(new CustomEvent('artificer:browser-selection', {
    detail: { sessionId: props.sessionId, selection: selection.value }
  }))
}

async function loadStatus() {
  if (!props.sessionId) { status.value = null; applySelection(null); return }
  try {
    const payload = await request(`/api/plugins/browser-automation/status?sessionId=${encodeURIComponent(props.sessionId)}`, { cache: 'no-store' })
    const next = payload.data?.status || null
    status.value = next
    address.value = next?.upstreamUrl || address.value
    if (next?.selection) applySelection(next.selection)
    else if (!next?.previewUrl) applySelection(null)
    error.value = ''
  } catch (cause) {
    error.value = cause.message || '无法读取预览状态。'
  }
}

async function connectUrl() {
  if (!props.sessionId || !address.value.trim()) return
  connecting.value = true
  error.value = ''
  try {
    const payload = await request('/api/plugins/browser-automation/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: props.sessionId, url: address.value.trim() })
    })
    status.value = payload.data
    address.value = payload.data?.upstreamUrl || address.value
    selecting.value = false
    applySelection(null)
  } catch (cause) { error.value = cause.message || '连接预览失败。' }
  finally { connecting.value = false }
}

async function stopPreview() {
  if (!props.sessionId) return
  try {
    await request('/api/plugins/browser-automation/stop', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: props.sessionId })
    })
    status.value = null
    selecting.value = false
    applySelection(null)
  } catch (cause) { error.value = cause.message || '停止预览失败。' }
}

function reloadFrame() {
  if (!status.value?.previewUrl || !frame.value) return
  frameReady.value = false
  frame.value.src = `${status.value.previewUrl}${status.value.previewUrl.includes('?') ? '&' : '?'}_artificer_reload=${Date.now()}`
}

function sendToFrame(message) {
  const iframe = frame.value
  if (!iframe?.contentWindow || !status.value?.previewUrl) return
  try { iframe.contentWindow.postMessage({ source: 'artificer-browser-preview', token: status.value.bridgeToken, ...message }, new URL(status.value.previewUrl).origin) } catch {}
}

function toggleSelectMode() {
  selecting.value = !selecting.value
  sendToFrame({ type: 'select-mode', enabled: selecting.value, preferTag: preferredTag.value })
}

async function onFrameMessage(event) {
  const data = event.data
  if (!frame.value || event.source !== frame.value.contentWindow || !status.value) return
  try {
    if (event.origin !== new URL(status.value.previewUrl).origin) return
  } catch { return }
  if (data?.source !== 'artificer-browser-preview' || data.token !== status.value.bridgeToken) return

  if (data.type === 'ready') {
    frameReady.value = true
    status.value.bridgeReady = true
    try {
      await request('/api/plugins/browser-automation/bridge/ready', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: props.sessionId, token: data.token, title: data.title })
      })
    } catch {}
    sendToFrame({ type: 'select-mode', enabled: selecting.value, preferTag: preferredTag.value })
  } else if (data.type === 'selection') {
    selecting.value = false
    const selected = { ...data.selection, selectedAt: Date.now() }
    applySelection(selected)
    try {
      await request('/api/plugins/browser-automation/bridge/selection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: props.sessionId, token: data.token, selection: selected })
      })
    } catch (cause) { error.value = cause.message || '保存所选元素失败。' }
  } else if (data.type === 'command-result') {
    if (data.result?.selection) applySelection(data.result.selection)
    try {
      await request('/api/plugins/browser-automation/bridge/result', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: props.sessionId, id: data.id, success: data.success, result: data.result, error: data.error })
      })
    } catch {}
  }
}

function onFrameLoad() {
  frameReady.value = false
  if (status.value) status.value.bridgeReady = false
}

async function pollCommands() {
  if (!visible || !frameReady.value || !props.sessionId) return
  try {
    const payload = await request(`/api/plugins/browser-automation/bridge/commands?sessionId=${encodeURIComponent(props.sessionId)}`, { cache: 'no-store' })
    for (const command of payload.data?.commands || []) sendToFrame({ type: 'command', command })
  } catch {}
}

function compose(kind) {
  if (!selection.value || !props.sessionId) return
  window.dispatchEvent(new CustomEvent('artificer:browser-compose', {
    detail: { sessionId: props.sessionId, selection: selection.value, kind }
  }))
}

async function clearSelection() {
  applySelection(null)
  if (!props.sessionId || !status.value?.bridgeToken) return
  try {
    await request('/api/plugins/browser-automation/bridge/selection', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: props.sessionId, token: status.value.bridgeToken, selection: null })
    })
  } catch {}
}

function onOpenRequest(event) {
  const activity = event.detail || {}
  if (activity.sessionId !== props.sessionId) return
  try { sessionStorage.removeItem('artificer_browser_preview_open_request') } catch {}
  if (activity.upstreamUrl) address.value = activity.upstreamUrl
  void loadStatus()
}

function consumeOpenRequest() {
  try {
    const activity = JSON.parse(sessionStorage.getItem('artificer_browser_preview_open_request') || 'null')
    if (activity?.sessionId === props.sessionId) onOpenRequest({ detail: activity })
  } catch {}
}

function updatePolling() {
  if (!visible || document.hidden) return
  void loadStatus()
}

onMounted(() => {
  window.addEventListener('message', onFrameMessage)
  window.addEventListener('artificer:browser-preview-open', onOpenRequest)
  document.addEventListener('visibilitychange', updatePolling)
  if (root.value && 'IntersectionObserver' in window) {
    intersectionObserver = new IntersectionObserver(entries => {
      visible = !!entries[0]?.isIntersecting
      if (visible) updatePolling()
    })
    intersectionObserver.observe(root.value)
  }
  consumeOpenRequest()
  void loadStatus()
  statusTimer = setInterval(updatePolling, 1200)
  commandTimer = setInterval(pollCommands, 300)
})

onUnmounted(() => {
  window.removeEventListener('message', onFrameMessage)
  window.removeEventListener('artificer:browser-preview-open', onOpenRequest)
  document.removeEventListener('visibilitychange', updatePolling)
  intersectionObserver?.disconnect()
  clearInterval(statusTimer)
  clearInterval(commandTimer)
})

watch(() => props.sessionId, () => {
  status.value = null
  frameReady.value = false
  selecting.value = false
  applySelection(null)
  consumeOpenRequest()
  void loadStatus()
})
</script>

<style scoped>
.browser-panel { display:flex; flex-direction:column; gap:8px; width:100%; height:100%; min-height:0; padding:8px; box-sizing:border-box; color:var(--text-primary); }
.browser-toolbar,.browser-page-toolbar { display:flex; align-items:center; gap:6px; flex:none; }
.browser-address { display:flex; flex:1; min-width:0; gap:5px; }
.browser-address input { flex:1; min-width:0; height:29px; padding:0 8px; border:1px solid var(--border-color); border-radius:6px; color:var(--text-primary); background:var(--bg-primary); font-size:11px; }
.browser-address button,.small-button,.select-button,.selection-actions button { border:1px solid var(--border-color); border-radius:6px; color:var(--text-secondary); background:var(--bg-secondary); cursor:pointer; }
.browser-address button,.small-button { height:29px; padding:0 9px; font-size:11px; }
button:disabled,select:disabled { opacity:.45; cursor:default; }
.browser-status { display:flex; align-items:center; gap:7px; min-height:14px; color:var(--text-muted); font-size:10px; }
.browser-status.is-error { color:#e66; }
.status-dot { width:7px; height:7px; border-radius:50%; background:#999; }
.status-dot.active { background:#39b982; box-shadow:0 0 0 3px color-mix(in srgb,#39b982 16%,transparent); }
.browser-status-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.browser-page-toolbar { min-height:28px; }
.select-button { height:27px; padding:0 9px; font-size:11px; }
.select-button.active { color:#fff; border-color:#704de0; background:#704de0; }
.browser-page-toolbar select { min-width:118px; max-width:150px; height:27px; padding:0 5px; border:1px solid var(--border-color); border-radius:6px; color:var(--text-secondary); background:var(--bg-primary); font-size:10px; }
.live-indicator { margin-left:auto; color:var(--text-muted); font-size:10px; white-space:nowrap; }
.browser-frame-wrap { position:relative; flex:1; min-height:160px; overflow:hidden; border:1px solid var(--border-color); border-radius:7px; background:#fff; }
.browser-frame { display:block; width:100%; height:100%; border:0; background:#fff; }
.browser-empty { display:flex; flex:1; min-height:200px; flex-direction:column; align-items:center; justify-content:center; gap:9px; padding:20px; color:var(--text-muted); text-align:center; }
.browser-empty strong { color:var(--text-primary); font-size:13px; }
.browser-empty p { max-width:360px; margin:0; font-size:11px; line-height:1.6; }
.browser-empty code { padding:1px 4px; border-radius:3px; background:var(--bg-secondary); }
.empty-icon { display:grid; width:38px; height:38px; place-items:center; border:1px solid var(--border-color); border-radius:12px; color:var(--accent); font-size:20px; }
.selection-card { display:flex; flex:none; flex-direction:column; gap:6px; max-height:34%; overflow:auto; padding:8px; border:1px solid color-mix(in srgb,var(--accent) 35%,var(--border-color)); border-radius:7px; background:var(--bg-secondary); }
.selection-card-heading { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
.selection-card-heading div { display:flex; min-width:0; flex-direction:column; gap:3px; }
.selection-card-heading strong { font-size:11px; }
.selection-card-heading code { overflow:hidden; color:var(--accent); font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
.text-button { border:0; color:var(--text-muted); background:transparent; font-size:10px; cursor:pointer; }
.selection-text { margin:0; color:var(--text-secondary); font-size:10px; line-height:1.4; }
.selection-html { max-height:90px; overflow:auto; margin:0; padding:5px; border-radius:4px; color:var(--text-secondary); background:var(--bg-primary); font:9px/1.4 Consolas,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }
.selection-actions { display:flex; gap:5px; }
.selection-actions button { flex:1; min-height:27px; padding:3px 5px; font-size:10px; }
.selection-actions button:hover { border-color:var(--accent); color:var(--accent); }
.selection-actions button.primary { border-color:var(--accent); color:#fff; background:var(--accent); }
.server-output { flex:none; max-height:120px; overflow:auto; color:var(--text-muted); font-size:10px; }
.server-output summary { cursor:pointer; }
.server-output pre { white-space:pre-wrap; overflow-wrap:anywhere; }
</style>
