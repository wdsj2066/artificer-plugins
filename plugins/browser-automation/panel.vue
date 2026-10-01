<template>
  <div class="browser-info-panel">
    <section ref="root" class="browser-panel">
    <header class="browser-toolbar" aria-label="网页预览工具栏">
      <form class="browser-address" @submit.prevent="connectUrl">
        <span class="address-field">
          <span class="connection-dot" :class="{ active: status?.bridgeReady, pending: status?.previewUrl && !status?.bridgeReady, failed: error || bridgeError }" role="status" :aria-label="bridgeError || error || statusLabel" :title="bridgeError || error || statusLabel"></span>
          <input v-model="address" type="url" placeholder="http://localhost:5173/" aria-label="预览地址" :disabled="connecting || !sessionId" />
        </span>
        <button class="toolbar-icon-button" type="submit" title="连接地址" aria-label="连接地址" :disabled="connecting || !sessionId || !address.trim()"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" /></svg></button>
      </form>
      <button class="toolbar-icon-button" type="button" :disabled="!status?.previewUrl" title="刷新页面" aria-label="刷新页面" @click="reloadFrame"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14.9-3M4 4v4h4m-4 5a8 8 0 0 0 14.9 3M20 20v-4h-4" /></svg></button>
      <button class="toolbar-icon-button" type="button" :disabled="!status?.bridgeReady || screenshotLoading" title="截取网页" aria-label="截取网页" @click="captureScreenshot('viewport')"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h-4l-2 3H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2-3Z"/><circle cx="12" cy="13" r="3.5"/></svg></button>
      <button class="toolbar-icon-button" type="button" :disabled="!status?.previewUrl" title="停止预览" aria-label="停止预览" @click="stopPreview"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="1" /></svg></button>
      <span class="toolbar-divider" aria-hidden="true"></span>
      <button class="toolbar-icon-button" :class="{ active: selecting }" type="button" :disabled="!status?.bridgeReady" :title="selecting ? '取消选择元素' : '选择页面元素'" :aria-label="selecting ? '取消选择元素' : '选择页面元素'" :aria-pressed="selecting" @click="toggleSelectMode"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 3 14 9-7 1-3 7-4-17Z" /></svg></button>
      <select v-model="preferredTag" class="tag-select" :disabled="!status?.bridgeReady || selecting" aria-label="优先选择的元素类型" title="优先选择的元素类型">
        <option value="div">div</option>
        <option value="section">section</option>
        <option value="article">article</option>
        <option value="main">main</option>
        <option value="any">任意</option>
      </select>
      <button v-if="selection" class="toolbar-icon-button" type="button" title="查看已选元素详情" aria-label="查看已选元素详情" @click="selectionDetailsOpen = true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 11v5m0-8h.01" /></svg></button>
    </header>

    <div v-if="error || bridgeError" class="browser-error" role="alert" :title="bridgeError || error">{{ bridgeError || error }}</div>

    <div v-if="status?.previewUrl" class="browser-frame-wrap">
      <iframe
        ref="frame"
        class="browser-frame"
        :src="frameUrl"
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
            <section v-if="editMode" class="selection-detail-section">
              <h3>修改要求</h3>
              <textarea ref="editInput" v-model="editInstruction" class="selection-edit-input" rows="3" placeholder="例如：缩小间距，并让按钮在手机上占满一行" aria-label="修改要求" @keydown.ctrl.enter.prevent="requestEdit"></textarea>
              <span class="selection-edit-hint">按 Ctrl + Enter 发送修改请求</span>
            </section>
            <p v-if="composeError" class="selection-compose-error" role="alert">{{ composeError }}</p>
          </div>

          <footer class="selection-dialog-footer">
            <button type="button" class="dialog-button" :disabled="composing" @click="compose('reference')">放入聊天框</button>
            <button type="button" class="dialog-button" :disabled="composing" @click="compose('question')">围绕元素提问</button>
            <button type="button" class="dialog-button dialog-button-primary" :disabled="composing" @click="requestEdit">{{ composing ? '正在送达…' : editMode ? '发送修改请求' : '请求修改' }}</button>
          </footer>
        </section>
      </div>
      <div v-if="screenshotOpen" class="screenshot-dialog-backdrop" @pointerdown.self="screenshotOpen = false">
        <section class="screenshot-dialog" role="dialog" aria-modal="true" aria-labelledby="screenshot-dialog-title">
          <header class="screenshot-dialog-header">
            <div><h2 id="screenshot-dialog-title">网页截图</h2><p>{{ screenshotResult?.title || status?.title || '当前预览页面' }}</p></div>
            <button type="button" class="selection-icon-button" title="关闭" aria-label="关闭截图" @click="screenshotOpen = false">×</button>
          </header>
          <div class="screenshot-preview">
            <div v-if="screenshotLoading" class="screenshot-placeholder">正在截取网页…</div>
            <p v-else-if="screenshotError" class="screenshot-error" role="alert">{{ screenshotError }}</p>
            <img v-else-if="screenshotResult?.dataUrl" :src="screenshotResult.dataUrl" alt="网页截图预览" />
            <div v-else class="screenshot-placeholder">选择截图范围</div>
          </div>
          <footer class="screenshot-dialog-footer">
            <button type="button" class="dialog-button" :disabled="screenshotLoading || !status?.bridgeReady" @click="captureScreenshot('viewport')">当前视口</button>
            <button type="button" class="dialog-button" :disabled="screenshotLoading || !status?.bridgeReady" @click="captureScreenshot('fullPage')">完整网页</button>
            <span class="screenshot-footer-spacer"></span>
            <a v-if="screenshotResult?.dataUrl" class="dialog-button dialog-button-primary screenshot-download" :href="screenshotResult.dataUrl" :download="screenshotFileName">保存 JPG</a>
          </footer>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'

const props = defineProps({ sessionId: { type: String, default: null } })
const ACTIVITY_URL = '/api/plugins/browser-automation/activity'
const OPEN_REQUEST_KEY = 'artificer_browser_preview_open_request'
const root = ref(null)
const frame = ref(null)
const frameUrl = ref('')
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
const editMode = ref(false)
const editInstruction = ref('')
const editInput = ref(null)
const composing = ref(false)
const composeError = ref('')
const frameReady = ref(false)
const screenshotOpen = ref(false)
const screenshotLoading = ref(false)
const screenshotError = ref('')
const screenshotResult = ref(null)
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
const screenshotFileName = computed(() => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `webpage-screenshot-${timestamp}.jpg`
})
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
  if (event.key === 'Escape') {
    selectionDetailsOpen.value = false
    screenshotOpen.value = false
  }
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
    editMode.value = false
    editInstruction.value = ''
    composeError.value = ''
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
    if (next?.previewUrl !== status.value?.previewUrl) frameUrl.value = next?.currentUrl || next?.previewUrl || ''
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
    const targetFrameUrl = payload.data?.currentUrl || payload.data?.previewUrl || ''
    frameReady.value = false
    frameDocumentId = null
    status.value = payload.data
    frameUrl.value = targetFrameUrl
    await nextTick()
    if (frame.value && targetFrameUrl) frame.value.src = targetFrameUrl
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
    frameUrl.value = ''
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
  let currentUrl = frameUrl.value || status.value.previewUrl
  try {
    if (frame.value.contentWindow?.location?.origin === new URL(status.value.previewUrl).origin) {
      currentUrl = frame.value.contentWindow.location.href
    }
  } catch {}
  const reloadUrl = new URL(currentUrl)
  reloadUrl.searchParams.set('_artificer_reload', String(Date.now()))
  frame.value.src = reloadUrl.href
}

async function captureScreenshot(mode = 'viewport') {
  if (!props.sessionId || !status.value?.bridgeReady) return
  screenshotOpen.value = true
  screenshotLoading.value = true
  screenshotError.value = ''
  screenshotResult.value = null
  try {
    const payload = await request('/api/plugins/browser-automation/screenshot', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: props.sessionId, mode })
    })
    screenshotResult.value = payload.data
  } catch (cause) {
    screenshotError.value = cause.message || '网页截图失败。'
  } finally {
    screenshotLoading.value = false
  }
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
  } else if (data.type === 'navigated') {
    if (frameDocumentId && data.documentId !== frameDocumentId) return
    try {
      await request('/api/plugins/browser-automation/bridge/ready', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: props.sessionId, token: data.token, url: data.url })
      })
    } catch (cause) { bridgeError.value = `预览地址同步失败：${cause.message || '请求失败'}` }
  } else if (data.type === 'ready') {
    frameDocumentId = data.documentId || null
    try {
      await request('/api/plugins/browser-automation/bridge/ready', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: props.sessionId, token: data.token, title: data.title, url: data.url })
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

async function requestEdit() {
  if (!editMode.value) {
    editMode.value = true
    composeError.value = ''
    await nextTick()
    editInput.value?.focus()
    return
  }
  const requirement = editInstruction.value.trim()
  if (!requirement) {
    composeError.value = '请先写明希望怎样修改这个元素。'
    editInput.value?.focus()
    return
  }
  await compose('edit', requirement, { send: true })
}

async function compose(kind, requirement = '', { send = false } = {}) {
  if (!selection.value || !props.sessionId) return
  const item = selection.value
  const html = String(item.html || '').slice(0, 4000)
  const content = [
    `页面：${item.title || ''}（${item.url || ''}）`,
    `元素：<${item.tag || 'div'}>`,
    `CSS 选择器：${item.selector || ''}`,
    item.text ? `可见文本：${item.text}` : '',
    html ? `HTML：\n\`\`\`html\n${html}\n\`\`\`` : ''
  ].filter(Boolean).join('\n')
  const prompts = {
    reference: '',
    question: '关于这个元素：',
    edit: `请定位并修改这个网页元素对应的代码：${requirement}`
  }
  composing.value = true
  composeError.value = ''
  try {
    await deliverReference({
      type: 'compose-plugin-draft', id: crypto.randomUUID(), sessionId: props.sessionId,
      references: [{ label: `网页元素 · ${item.selector || item.tag || '元素'}`, content }],
      text: prompts[kind] || '', send
    })
    selectionDetailsOpen.value = false
  } catch (cause) {
    composeError.value = cause.message || '聊天窗口没有接收请求，请重试。'
  } finally {
    composing.value = false
  }
}

function deliverReference(payload) {
  return new Promise((resolve, reject) => {
    const channel = new BroadcastChannel('artificer-plugin-compose')
    const timer = setTimeout(() => finish(new Error('聊天窗口没有接收引用，请打开对应会话后重试。')), 5000)
    function finish(error) {
      clearTimeout(timer)
      channel.close()
      window.removeEventListener('message', onResult)
      if (error) reject(error)
      else resolve()
    }
    function onResult(event) {
      if (event.origin && event.origin !== window.location.origin) return
      const result = event.data
      if (result?.type !== 'compose-plugin-draft-result' || result.id !== payload.id) return
      finish(result.success ? null : new Error(result.error || '聊天窗口没有接收引用。'))
    }
    channel.addEventListener('message', onResult)
    window.addEventListener('message', onResult)
    channel.postMessage(payload)
  })
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
  frameUrl.value = ''
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
.browser-toolbar { display:flex; flex:none; align-items:center; gap:6px; min-width:0; overflow-x:auto; white-space:nowrap; scrollbar-width:thin; }
.browser-address { display:flex; flex:1; min-width:148px; align-items:center; gap:6px; margin:0; }
.address-field { display:flex; flex:1; min-width:0; height:34px; box-sizing:border-box; align-items:center; gap:8px; padding:0 10px; border:1px solid var(--border-color); border-radius:var(--radius-sm,6px); background:var(--bg-primary); }
.connection-dot { width:7px; height:7px; flex:none; border-radius:50%; background:var(--text-muted); }
.connection-dot.active { background:#39b982; box-shadow:0 0 0 3px color-mix(in srgb,#39b982 16%,transparent); }
.connection-dot.pending { background:var(--warning-color); }
.connection-dot.failed { background:#c62828; }
.browser-address input { width:100%; min-width:0; height:100%; padding:0; border:0; outline:0; color:var(--text-primary); background:transparent; font-family:inherit; font-size:12px; line-height:1.4; }
.browser-address input:focus-visible { outline:none !important; box-shadow:none !important; }
.toolbar-icon-button { display:grid; width:34px; height:34px; flex:none; place-items:center; padding:0; border:1px solid var(--border-color); border-radius:var(--radius-sm,6px); color:var(--text-secondary); background:var(--bg-primary); cursor:pointer; }
.toolbar-icon-button:hover:not(:disabled) { color:var(--text-primary); background:var(--bg-tertiary); }
.toolbar-icon-button:focus-visible,.tag-select:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.toolbar-icon-button.active { border-color:var(--primary-bg,var(--accent)); color:var(--primary-text,#fff); background:var(--primary-bg,var(--accent)); }
.toolbar-divider { width:1px; height:20px; flex:none; margin:0 1px; background:var(--border-color); }
.tag-select { width:72px; height:34px; flex:none; padding:0 5px; border:1px solid var(--border-color); border-radius:var(--radius-sm,6px); color:var(--text-secondary); background:var(--bg-primary); font-family:inherit; font-size:12px; cursor:pointer; }
button:disabled,select:disabled { opacity:.45; cursor:default; }
.browser-error { flex:none; overflow:hidden; color:#c62828; font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.browser-frame-wrap { position:relative; flex:1; min-height:160px; overflow:hidden; border:0; border-radius:var(--radius-md,8px); background:var(--bg-primary); }
.browser-frame { display:block; width:100%; height:100%; border:0; background:var(--bg-primary); }
.browser-frame:focus { outline:none !important; }
.browser-empty { display:flex; flex:1; min-height:200px; flex-direction:column; align-items:center; justify-content:center; gap:9px; padding:20px; color:var(--text-muted); text-align:center; }
.browser-empty strong { color:var(--text-primary); font-size:13px; }
.browser-empty p { max-width:360px; margin:0; font-size:12px; line-height:1.6; }
.browser-empty code { padding:1px 4px; border-radius:3px; background:var(--bg-secondary); }
.empty-icon { display:grid; width:38px; height:38px; place-items:center; border:1px solid var(--border-color); border-radius:12px; color:var(--accent); font-size:20px; }
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
.selection-edit-input { width:100%; box-sizing:border-box; min-height:84px; padding:9px 10px; resize:vertical; border:1px solid var(--border-color); border-radius:var(--radius-sm,6px); outline:none; color:var(--text-primary); background:var(--bg-primary); font-family:inherit; font-size:13px; line-height:1.6; }
.selection-edit-input:focus { border-color:var(--accent); }
.selection-edit-hint { display:block; margin-top:5px; color:var(--text-muted); font-size:11px; }
.selection-compose-error { margin:0; color:#c62828; font-size:12px; line-height:1.5; }
.selection-text { margin:0; color:var(--text-primary); font-size:13px; line-height:1.7; white-space:pre-wrap; overflow-wrap:anywhere; }
.selection-html { max-height:260px; overflow:auto; margin:0; padding:12px; border:1px solid var(--border-color); border-radius:var(--radius-sm,6px); color:var(--text-secondary); background:var(--bg-secondary); font:12px/1.55 var(--font-mono,Consolas,monospace); white-space:pre-wrap; overflow-wrap:anywhere; }
.selection-dialog-footer { display:flex; flex:none; justify-content:flex-end; gap:8px; padding:14px 20px; border-top:1px solid var(--border-color); background:var(--bg-primary); }
.dialog-button { min-height:34px; padding:0 12px; border:1px solid var(--border-color); border-radius:var(--radius-sm,6px); color:var(--text-secondary); background:var(--bg-secondary); font-family:inherit; font-size:12px; font-weight:500; line-height:1; cursor:pointer; }
.dialog-button:hover { border-color:var(--text-muted); color:var(--text-primary); }
.dialog-button-primary { border-color:var(--primary-bg,var(--accent)); color:var(--primary-text,#fff); background:var(--primary-bg,var(--accent)); }
.dialog-button-primary:hover { border-color:var(--primary-hover,var(--accent)); color:var(--primary-text,#fff); background:var(--primary-hover,var(--accent)); }
.dialog-button:disabled { opacity:.55; cursor:default; }
.screenshot-dialog-backdrop { position:fixed; inset:0; z-index:4200; display:grid; place-items:center; padding:20px; background:rgba(20,20,20,.36); backdrop-filter:blur(3px); }
.screenshot-dialog { display:flex; width:min(980px,calc(100vw - 32px)); max-height:calc(100vh - 40px); flex-direction:column; overflow:hidden; color:var(--text-primary); background:var(--surface,var(--bg-primary)); border:1px solid var(--border-color); border-radius:var(--radius-lg,12px); box-shadow:0 24px 72px rgba(0,0,0,.28); }
.screenshot-dialog-header { display:flex; flex:none; align-items:center; justify-content:space-between; gap:12px; padding:14px 18px; border-bottom:1px solid var(--border-color); }
.screenshot-dialog-header h2 { margin:0; font-size:15px; font-weight:600; }
.screenshot-dialog-header p { max-width:min(70vw,760px); margin:3px 0 0; overflow:hidden; color:var(--text-muted); font:11px/1.45 var(--font-mono,Consolas,monospace); text-overflow:ellipsis; white-space:nowrap; }
.screenshot-preview { display:grid; min-height:180px; flex:1; place-items:center; overflow:auto; padding:12px; background:var(--bg-secondary); }
.screenshot-preview img { display:block; max-width:100%; max-height:calc(100vh - 190px); object-fit:contain; box-shadow:0 2px 14px rgba(0,0,0,.18); }
.screenshot-placeholder { color:var(--text-muted); font-size:13px; }
.screenshot-error { max-width:560px; margin:0; color:#c62828; font-size:13px; line-height:1.6; text-align:center; }
.screenshot-dialog-footer { display:flex; flex:none; align-items:center; gap:8px; padding:12px 16px; border-top:1px solid var(--border-color); }
.screenshot-footer-spacer { flex:1; }
.screenshot-download { display:inline-flex; align-items:center; justify-content:center; text-decoration:none; }
.server-output { flex:none; max-height:120px; overflow:auto; color:var(--text-muted); font-size:10px; }
.server-output summary { cursor:pointer; }
.server-output pre { white-space:pre-wrap; overflow-wrap:anywhere; }
@media (max-width:560px) {
  .selection-dialog-backdrop { padding:12px; }
  .selection-dialog { width:calc(100vw - 24px); max-height:calc(100vh - 24px); }
  .selection-dialog-header,.selection-dialog-body { padding-right:14px; padding-left:14px; }
  .selection-dialog-footer { flex-wrap:wrap; justify-content:stretch; padding:12px 14px; }
  .dialog-button { flex:1 1 calc(50% - 8px); }
  .screenshot-dialog-footer { flex-wrap:wrap; }
  .screenshot-footer-spacer { display:none; }
  .screenshot-download { flex-basis:100%; }
}
</style>
