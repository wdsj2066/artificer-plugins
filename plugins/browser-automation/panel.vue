<template>
  <div class="browser-info-panel">
    <section ref="root" class="browser-panel">
    <header class="browser-panel-heading">
      <div class="window-title"><span class="window-icon">◉</span><strong>网页预览与控制</strong></div>
      <span class="panel-live-state"><i class="status-dot" :class="{ active: status?.running || status?.bridgeReady }"></i>{{ status?.bridgeReady ? '实时连接' : status?.previewUrl ? '已启动' : '等待预览' }}</span>
    </header>
    <header class="browser-toolbar">
      <form class="browser-address" @submit.prevent="connectUrl">
        <input v-model="address" type="url" placeholder="http://localhost:5173/" :disabled="connecting || !sessionId" />
        <button type="submit" :disabled="connecting || !sessionId || !address.trim()">连接</button>
      </form>
      <button class="small-button" type="button" :disabled="!status?.previewUrl" title="重新加载页面" @click="reloadFrame">刷新</button>
      <button class="small-button" type="button" :disabled="!status?.previewUrl" @click="stopPreview">停止</button>
    </header>

    <div class="browser-status" :class="{ 'is-error': error || bridgeError }">
      <span class="status-dot" :class="{ active: status?.running || status?.bridgeReady }"></span>
      <span class="browser-status-text">{{ bridgeError || error || statusLabel }}</span>
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
      <button v-if="selection" class="small-button selection-reopen" type="button" @click="selectionDetailsOpen = true">已选元素 · 查看详情</button>
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
      ></iframe>
    </div>

    <div v-else class="browser-empty">
      <div class="empty-icon">⌘</div>
      <strong>启动 HTML 项目或连接本机预览</strong>
      <p>让 Agent 调用“启动网页预览”运行项目（默认 <code>npm run dev</code>），或直接传入工作区 HTML 文件路径。</p>
      <p>预览代理读取实际 HTML，并注入元素选择和自动化桥接；也可以在上方输入已运行的 localhost 地址。</p>
    </div>

    <details v-if="status?.output" class="server-output">
      <summary>开发服务输出</summary>
      <pre>{{ status.output }}</pre>
    </details>
    </section>

    <Teleport to="body">
      <div v-if="selection && selectionDetailsOpen" class="selection-dialog-backdrop" @pointerdown.self="selectionDetailsOpen = false">
        <section class="selection-dialog" :style="selectionDialogStyle" role="dialog" aria-modal="true" aria-labelledby="selection-dialog-title">
          <header class="selection-dialog-header" data-selection-dialog-handle @pointerdown="beginSelectionDialogDrag">
            <div class="selection-dialog-title-wrap">
              <span class="selection-dialog-mark">&lt;/&gt;</span>
              <div>
                <span class="selection-eyebrow">网页元素</span>
                <h2 id="selection-dialog-title">已选择 &lt;{{ selection.tag || 'div' }}&gt;</h2>
              </div>
            </div>
            <div class="selection-dialog-controls">
              <button type="button" class="selection-icon-button" title="清除选择" aria-label="清除选择" @click="clearSelection">×</button>
              <button type="button" class="selection-icon-button" title="关闭详情" aria-label="关闭详情" @click="selectionDetailsOpen = false">—</button>
            </div>
          </header>

          <div class="selection-dialog-body">
            <div class="selection-meta">
              <span class="selection-meta-label">CSS 选择器</span>
              <code>{{ selection.selector || '—' }}</code>
            </div>
            <div class="selection-meta">
              <span class="selection-meta-label">页面</span>
              <span class="selection-page-url">{{ selection.title || selection.url || '当前预览页面' }}</span>
            </div>
            <section v-if="selection.text" class="selection-detail-section">
              <h3>可见文本</h3>
              <p class="selection-text">{{ selection.text }}</p>
            </section>
            <section v-if="selection.html" class="selection-detail-section">
              <h3>HTML 结构</h3>
              <pre class="selection-html">{{ selection.html }}</pre>
            </section>
          </div>

          <footer class="selection-dialog-footer">
            <button type="button" class="dialog-button" @click="compose('reference')">放入聊天框</button>
            <button type="button" class="dialog-button" @click="compose('question')">围绕元素提问</button>
            <button type="button" class="dialog-button dialog-button-primary" @click="compose('edit')">请求修改</button>
          </footer>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'

const props = defineProps({ sessionId: { type: String, default: null } })
const ACTIVITY_URL = '/api/plugins/browser-automation/activity'
const OPEN_REQUEST_KEY = 'artificer_browser_preview_open_request'
const root = ref(null)
const frame = ref(null)
const status = ref(null)
const address = ref('')
const error = ref('')
const bridgeError = ref('')
const connecting = ref(false)
const selecting = ref(false)
const preferredTag = ref('div')
const selection = ref(null)
const selectionDetailsOpen = ref(false)
const selectionDialogPosition = ref(null)
const frameReady = ref(false)
let statusTimer = null
let commandTimer = null
let activityTimer = null
let intersectionObserver = null
let visible = true
let lastActivityId = null
let frameDocumentId = null
let lastSelectionKey = ''

const statusLabel = computed(() => {
  if (!props.sessionId) return '请先打开一个聊天会话。'
  if (connecting.value) return '正在连接本机开发服务…'
  if (!status.value?.previewUrl) return '还没有活动的预览页面。'
  if (status.value.running) return '开发服务运行中'
  return '已连接本机开发服务'
})
const selectionDialogStyle = computed(() => selectionDialogPosition.value
  ? { position: 'absolute', left: `${selectionDialogPosition.value.x}px`, top: `${selectionDialogPosition.value.y}px`, margin: '0' }
  : null)
let selectionDialogDrag = null

function beginSelectionDialogDrag(event) {
  if (event.button !== 0 || event.target.closest('button')) return
  const dialog = event.currentTarget.closest('.selection-dialog')
  if (!dialog) return
  const rect = dialog.getBoundingClientRect()
  event.preventDefault()
  selectionDialogPosition.value = { x: rect.left, y: rect.top }
  selectionDialogDrag = { startX: event.clientX, startY: event.clientY, x: rect.left, y: rect.top, dialog }
  window.addEventListener('pointermove', moveSelectionDialog)
  window.addEventListener('pointerup', endSelectionDialogDrag, { once: true })
}

function moveSelectionDialog(event) {
  if (!selectionDialogDrag) return
  const { startX, startY, x, y, dialog } = selectionDialogDrag
  const left = Math.max(8, Math.min(x + event.clientX - startX, window.innerWidth - dialog.offsetWidth - 8))
  const top = Math.max(8, Math.min(y + event.clientY - startY, window.innerHeight - dialog.offsetHeight - 8))
  selectionDialogPosition.value = { x: left, y: top }
}

function endSelectionDialogDrag() {
  window.removeEventListener('pointermove', moveSelectionDialog)
  selectionDialogDrag = null
}

function onSelectionDialogKeydown(event) {
  if (event.key === 'Escape') selectionDetailsOpen.value = false
}

async function request(url, options) {
  const response = await fetch(url, options)
  const payload = await response.json()
  if (!response.ok || payload?.success === false) throw new Error(payload?.error || `请求失败（HTTP ${response.status}）`)
  return payload
}

function applySelection(next, { showDetails = false, closeDetails = false } = {}) {
  selection.value = next || null
  const key = next ? `${next.selectedAt || ''}:${next.selector || ''}` : ''
  if (key !== lastSelectionKey) {
    lastSelectionKey = key
    window.dispatchEvent(new CustomEvent('artificer:browser-selection', {
      detail: { sessionId: props.sessionId, selection: selection.value }
    }))
  }
  if (!next || closeDetails) selectionDetailsOpen.value = false
  else if (showDetails) selectionDetailsOpen.value = true
}

async function loadStatus() {
  if (!props.sessionId) { status.value = null; applySelection(null); return }
  try {
    const payload = await request(`/api/plugins/browser-automation/status?sessionId=${encodeURIComponent(props.sessionId)}`, { cache: 'no-store' })
    const next = payload.data?.status || null
    if (next) next.bridgeReady = Boolean(next.bridgeReady && frameReady.value)
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
  bridgeError.value = ''
  try {
    const payload = await request('/api/plugins/browser-automation/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: props.sessionId, url: address.value.trim() })
    })
    frameReady.value = false
    frameDocumentId = null
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
    frameReady.value = false
    frameDocumentId = null
    bridgeError.value = ''
    selecting.value = false
    applySelection(null)
  } catch (cause) { error.value = cause.message || '停止预览失败。' }
}

function reloadFrame() {
  if (!status.value?.previewUrl || !frame.value) return
  frameReady.value = false
  frameDocumentId = null
  status.value.bridgeReady = false
  void request('/api/plugins/browser-automation/bridge/ready', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: props.sessionId, token: status.value.bridgeToken, ready: false })
  }).catch(cause => { bridgeError.value = `预览桥接重置失败：${cause.message || '请求失败'}` })
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

  if (data.type === 'unloading') {
    if (frameDocumentId && data.documentId !== frameDocumentId) return
    frameDocumentId = null
    frameReady.value = false
    status.value.bridgeReady = false
    try {
      await request('/api/plugins/browser-automation/bridge/ready', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: props.sessionId, token: data.token, ready: false })
      })
    } catch (cause) { bridgeError.value = `预览桥接状态同步失败：${cause.message || '请求失败'}` }
  } else if (data.type === 'ready') {
    frameDocumentId = data.documentId || null
    try {
      await request('/api/plugins/browser-automation/bridge/ready', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: props.sessionId, token: data.token, title: data.title })
      })
      frameReady.value = true
      status.value.bridgeReady = true
      bridgeError.value = ''
      sendToFrame({ type: 'select-mode', enabled: selecting.value, preferTag: preferredTag.value })
    } catch (cause) {
      frameReady.value = false
      status.value.bridgeReady = false
      bridgeError.value = `预览页已加载，但宿主未确认桥接：${cause.message || '请求失败'}`
    }
  } else if (data.type === 'selection') {
    selecting.value = false
    const selected = { ...data.selection, selectedAt: Date.now() }
    applySelection(selected, { showDetails: true })
    try {
      await request('/api/plugins/browser-automation/bridge/selection', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: props.sessionId, token: data.token, selection: selected })
      })
    } catch (cause) { error.value = cause.message || '保存所选元素失败。' }
  } else if (data.type === 'command-result') {
    if (data.result?.selection) applySelection(data.result.selection, { closeDetails: true })
    try {
      await request('/api/plugins/browser-automation/bridge/result', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: props.sessionId, id: data.id, success: data.success, result: data.result, error: data.error })
      })
      sendToFrame({ type: 'command-ack', id: data.id })
      bridgeError.value = ''
    } catch (cause) {
      bridgeError.value = `预览命令回包未被宿主接收：${cause.message || '请求失败'}`
    }
  }
}

async function pollCommands() {
  if (document.hidden || !frameReady.value || !props.sessionId) return
  try {
    const payload = await request(`/api/plugins/browser-automation/bridge/commands?sessionId=${encodeURIComponent(props.sessionId)}`, { cache: 'no-store' })
    for (const command of payload.data?.commands || []) sendToFrame({ type: 'command', command })
  } catch (cause) {
    bridgeError.value = `预览命令通道异常：${cause.message || '请求失败'}`
  }
}

function compose(kind) {
  if (!selection.value || !props.sessionId) return
  const item = selection.value
  const classes = (item.classes || []).map(name => `.${name}`).join('')
  const identity = item.id ? `#${item.id}` : classes
  const html = String(item.html || '').slice(0, 4000)
  const context = [
    '【浏览器选中的网页元素】',
    `页面：${item.title || ''}（${item.url || ''}）`,
    `元素：<${item.tag || 'div'}${identity}>`,
    `CSS 选择器：${item.selector || ''}`,
    item.text ? `可见文本：${item.text}` : '',
    html ? `HTML：\n\`\`\`html\n${html}\n\`\`\`` : ''
  ].filter(Boolean).join('\n')
  const prompts = {
    reference: `${context}\n\n请结合这个网页元素回答我接下来的问题：\n`,
    question: `${context}\n\n请只围绕这个网页元素回答问题。我的问题是：\n`,
    edit: `${context}\n\n请在当前工作区定位该网页元素对应的 HTML、Vue 或样式代码，并按下面的要求修改；完成后说明改动：\n`
  }
  window.dispatchEvent(new CustomEvent('artificer:chat-insert-text', {
    detail: { sessionId: props.sessionId, text: `\n${prompts[kind] || prompts.reference}` }
  }))
  selectionDetailsOpen.value = false
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
  window.dispatchEvent(new CustomEvent('artificer:activate-panel', {
    detail: { region: 'right', panelKey: 'browser-automation/browser', reason: 'browser-preview' }
  }))
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

async function openActivity(activity) {
  if (!activity?.sessionId || !activity?.url) return
  try { sessionStorage.setItem(OPEN_REQUEST_KEY, JSON.stringify(activity)) } catch {}
  try { await window.artificer?.openSession?.(activity.sessionId) } catch {}
  window.dispatchEvent(new CustomEvent('artificer:browser-preview-open', { detail: activity }))
}

async function pollActivity() {
  try {
    const response = await fetch(ACTIVITY_URL, { cache: 'no-store' })
    const payload = await response.json()
    const activity = payload?.data?.activity
    if (!activity?.id) return
    if (lastActivityId === null) {
      lastActivityId = activity.id
      if (Date.now() - Number(activity.createdAt || 0) > 15_000) return
    } else if (lastActivityId === activity.id) {
      return
    } else {
      lastActivityId = activity.id
    }
    await openActivity(activity)
  } catch {
    // 插件未启用或 API 正在重载时，下一轮继续检查。
  }
}

onMounted(() => {
  window.addEventListener('message', onFrameMessage)
  window.addEventListener('artificer:browser-preview-open', onOpenRequest)
  window.addEventListener('keydown', onSelectionDialogKeydown)
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
  void pollActivity()
  statusTimer = setInterval(() => {
    void loadStatus()
  }, 1200)
  commandTimer = setInterval(pollCommands, 300)
  activityTimer = setInterval(pollActivity, 900)
})

onUnmounted(() => {
  window.removeEventListener('message', onFrameMessage)
  window.removeEventListener('artificer:browser-preview-open', onOpenRequest)
  window.removeEventListener('keydown', onSelectionDialogKeydown)
  endSelectionDialogDrag()
  document.removeEventListener('visibilitychange', updatePolling)
  intersectionObserver?.disconnect()
  clearInterval(statusTimer)
  clearInterval(commandTimer)
  clearInterval(activityTimer)
})

watch(() => props.sessionId, (sessionId, previousSessionId) => {
  const previousToken = status.value?.bridgeToken
  if (previousSessionId && previousToken) {
    void request('/api/plugins/browser-automation/bridge/ready', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: previousSessionId, token: previousToken, ready: false })
    }).catch(() => {})
  }
  status.value = null
  bridgeError.value = ''
  frameReady.value = false
  frameDocumentId = null
  selecting.value = false
  applySelection(null)
  consumeOpenRequest()
  void loadStatus()
})
</script>

<style scoped>
.browser-info-panel { width:100%; height:100%; min-height:0; }
.browser-panel { display:flex; width:100%; height:100%; min-height:0; box-sizing:border-box; flex-direction:column; gap:10px; padding:14px; color:var(--text-primary); background:var(--bg-secondary); }
.browser-panel-heading { display:flex; flex:none; align-items:center; justify-content:space-between; gap:8px; min-height:32px; padding-bottom:9px; border-bottom:1px solid var(--border-color); }
.window-title { display:flex; align-items:center; gap:8px; min-width:0; }
.window-icon { color:var(--text-secondary); font-size:15px; }
.window-title strong { font-size:13px; font-weight:600; }
.panel-live-state { display:inline-flex; flex:none; align-items:center; gap:6px; color:var(--text-muted); font-size:11px; }
.browser-toolbar,.browser-page-toolbar { display:flex; align-items:center; gap:6px; flex:none; }
.browser-address { display:flex; flex:1; min-width:0; gap:5px; }
.browser-address input { flex:1; min-width:0; height:34px; padding:0 10px; border:1px solid var(--border-color); border-radius:var(--radius-sm,6px); color:var(--text-primary); background:var(--bg-primary); font-family:inherit; font-size:12px; line-height:1.4; }
.browser-address button,.small-button,.select-button { border:1px solid var(--border-color); border-radius:var(--radius-sm,6px); color:var(--text-secondary); background:var(--bg-primary); cursor:pointer; }
.browser-address button,.small-button { height:34px; padding:0 10px; font-size:12px; }
button:disabled,select:disabled { opacity:.45; cursor:default; }
.browser-status { display:flex; align-items:center; gap:8px; min-height:18px; color:var(--text-muted); font-size:11px; }
.browser-status.is-error { color:#c62828; }
.status-dot { width:7px; height:7px; border-radius:50%; background:#999; }
.status-dot.active { background:#39b982; box-shadow:0 0 0 3px color-mix(in srgb,#39b982 16%,transparent); }
.browser-status-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.browser-page-toolbar { min-height:34px; }
.select-button { height:34px; padding:0 10px; font-size:12px; }
.select-button.active { color:var(--primary-text,#fff); border-color:var(--primary-bg,var(--accent)); background:var(--primary-bg,var(--accent)); }
.browser-page-toolbar select { min-width:118px; max-width:170px; height:34px; padding:0 8px; border:1px solid var(--border-color); border-radius:var(--radius-sm,6px); color:var(--text-secondary); background:var(--bg-primary); font-size:12px; }
.live-indicator { margin-left:auto; color:var(--text-muted); font-size:11px; white-space:nowrap; }
.browser-frame-wrap { position:relative; flex:1; min-height:160px; overflow:hidden; border:1px solid var(--border-color); border-radius:var(--radius-md,8px); background:#fff; }
.browser-frame { display:block; width:100%; height:100%; border:0; background:#fff; }
.browser-empty { display:flex; flex:1; min-height:200px; flex-direction:column; align-items:center; justify-content:center; gap:9px; padding:20px; color:var(--text-muted); text-align:center; }
.browser-empty strong { color:var(--text-primary); font-size:13px; }
.browser-empty p { max-width:360px; margin:0; font-size:12px; line-height:1.6; }
.browser-empty code { padding:1px 4px; border-radius:3px; background:var(--bg-secondary); }
.empty-icon { display:grid; width:38px; height:38px; place-items:center; border:1px solid var(--border-color); border-radius:12px; color:var(--accent); font-size:20px; }
.selection-reopen { color:var(--text-primary); }
.selection-dialog-backdrop { position:fixed; inset:0; z-index:4100; display:grid; place-items:center; padding:24px; background:rgba(20,20,20,.28); backdrop-filter:blur(2px); }
.selection-dialog { display:flex; width:min(620px,calc(100vw - 32px)); max-height:min(760px,calc(100vh - 48px)); flex-direction:column; overflow:hidden; color:var(--text-primary); background:var(--surface,var(--bg-primary)); border:1px solid var(--border-color); border-radius:var(--radius-lg,12px); box-shadow:0 24px 72px rgba(0,0,0,.24); }
.selection-dialog-header { display:flex; flex:none; align-items:center; justify-content:space-between; gap:18px; padding:18px 20px; border-bottom:1px solid var(--border-color); background:var(--bg-primary); user-select:none; cursor:grab; touch-action:none; }
.selection-dialog-title-wrap { display:flex; min-width:0; align-items:center; gap:13px; }
.selection-dialog-mark { display:grid; width:38px; height:38px; flex:none; place-items:center; border:1px solid var(--border-color); border-radius:var(--radius-md,8px); color:var(--text-secondary); background:var(--bg-secondary); font:600 12px/1 var(--font-mono,monospace); }
.selection-eyebrow { display:block; margin-bottom:3px; color:var(--text-muted); font-size:11px; letter-spacing:.04em; }
.selection-dialog h2 { margin:0; color:var(--text-primary); font-size:16px; font-weight:600; line-height:1.4; }
.selection-dialog-controls { display:flex; gap:6px; }
.selection-icon-button { display:grid; width:30px; height:30px; place-items:center; padding:0; border:1px solid transparent; border-radius:var(--radius-sm,6px); color:var(--text-muted); background:transparent; font-size:19px; cursor:pointer; }
.selection-icon-button:hover { border-color:var(--border-color); color:var(--text-primary); background:var(--bg-secondary); }
.selection-dialog-body { display:flex; min-height:0; flex:1; flex-direction:column; gap:14px; overflow:auto; padding:18px 20px; }
.selection-meta { display:flex; min-width:0; align-items:flex-start; gap:14px; }
.selection-meta-label { width:82px; flex:none; padding-top:2px; color:var(--text-muted); font-size:12px; }
.selection-meta code,.selection-page-url { min-width:0; color:var(--text-secondary); font:12px/1.55 var(--font-mono,Consolas,monospace); overflow-wrap:anywhere; }
.selection-meta code { padding:2px 6px; border:1px solid var(--border-color); border-radius:var(--radius-xs,4px); background:var(--bg-secondary); }
.selection-detail-section { min-width:0; padding-top:12px; border-top:1px solid var(--border-color); }
.selection-detail-section h3 { margin:0 0 8px; color:var(--text-secondary); font-size:12px; font-weight:600; }
.selection-text { margin:0; color:var(--text-primary); font-size:13px; line-height:1.7; white-space:pre-wrap; overflow-wrap:anywhere; }
.selection-html { max-height:260px; overflow:auto; margin:0; padding:12px; border:1px solid var(--border-color); border-radius:var(--radius-sm,6px); color:var(--text-secondary); background:var(--bg-secondary); font:12px/1.55 var(--font-mono,Consolas,monospace); white-space:pre-wrap; overflow-wrap:anywhere; }
.selection-dialog-footer { display:flex; flex:none; justify-content:flex-end; gap:8px; padding:14px 20px; border-top:1px solid var(--border-color); background:var(--bg-primary); }
.dialog-button { min-height:34px; padding:0 12px; border:1px solid var(--border-color); border-radius:var(--radius-sm,6px); color:var(--text-secondary); background:var(--bg-secondary); font-family:inherit; font-size:12px; font-weight:500; line-height:1; cursor:pointer; }
.dialog-button:hover { border-color:var(--text-muted); color:var(--text-primary); }
.dialog-button-primary { border-color:var(--primary-bg,var(--accent)); color:var(--primary-text,#fff); background:var(--primary-bg,var(--accent)); }
.dialog-button-primary:hover { border-color:var(--primary-hover,var(--accent)); color:var(--primary-text,#fff); background:var(--primary-hover,var(--accent)); }
.server-output { flex:none; max-height:120px; overflow:auto; color:var(--text-muted); font-size:10px; }
.server-output summary { cursor:pointer; }
.server-output pre { white-space:pre-wrap; overflow-wrap:anywhere; }
@media (max-width:560px) {
  .selection-dialog-backdrop { padding:12px; }
  .selection-dialog { width:calc(100vw - 24px); max-height:calc(100vh - 24px); }
  .selection-dialog-header,.selection-dialog-body { padding-right:14px; padding-left:14px; }
  .selection-dialog-footer { flex-wrap:wrap; justify-content:stretch; padding:12px 14px; }
  .dialog-button { flex:1 1 calc(50% - 8px); }
}
</style>
