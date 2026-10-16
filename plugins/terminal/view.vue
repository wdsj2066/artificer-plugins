<template>
  <div class="terminal-view">
    <!-- 标签栏 -->
    <div class="term-tabbar" v-if="terminals.length > 0">
      <div class="term-tabs">
        <div
          v-for="tab in terminals"
          :key="tab.id"
          class="term-tab"
          :class="{ active: activeId === tab.id }"
          @click="switchTab(tab.id)"
          @dblclick="startRename(tab)"
          draggable="true"
          @dragstart="dragTab($event, tab.id)"
          @dragover.prevent="dragOverTab($event, tab.id)"
          @drop="dropTab($event, tab.id)"
        >
          <span class="term-tab-dot" :class="tab.alive ? (isActiveRecently(tab) ? 'dot-active' : 'dot-alive') : 'dot-dead'" />
          <span class="term-tab-name">{{ tab.name }}</span>
          <button
            v-if="terminals.length > 0"
            class="term-tab-close"
            @click.stop="closeTab(tab.id)"
            title="关闭终端"
          >×</button>
        </div>
      </div>
      <div class="term-tab-actions">
        <n-tooltip trigger="hover">
          <template #trigger>
            <n-button quaternary circle size="tiny" @click="createTerminal">
              <template #icon><Plus :size="14" /></template>
            </n-button>
          </template>
          新建终端
        </n-tooltip>
        <n-tooltip trigger="hover">
          <template #trigger>
            <n-button quaternary circle size="tiny" @click="clearScreen">
              <template #icon><Trash2 :size="14" /></template>
            </n-button>
          </template>
          清除屏幕
        </n-tooltip>
      </div>
    </div>

    <!-- xterm 终端（v-show 保持 DOM 存在使 xterm 实例持久） -->
    <div ref="xtermRef" class="term-xterm-container" v-show="activeTerm !== null && workspaceRoot"></div>

    <div v-if="contextLoaded && !workspaceRoot" class="term-empty">
      <Terminal :size="24" />
      <p>当前工作区没有可用终端目录</p>
      <p class="term-empty-hint">公共或虚拟工作区不支持终端</p>
    </div>

    <!-- 空状态 -->
    <div v-else-if="terminals.length === 0" class="term-empty">
      <Terminal :size="24" />
      <p>暂无终端</p>
      <n-button size="small" @click="createTerminal">创建终端</n-button>
    </div>
  </div>

  <!-- 重命名弹窗 -->
  <n-modal v-model:show="renameModal.show" preset="dialog" title="重命名终端" positive-text="确定" negative-text="取消" @positive-click="doRename" @negative-click="renameModal.show = false">
    <n-input v-model:value="renameModal.name" placeholder="终端名称" @keyup.enter="doRename" />
  </n-modal>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick, reactive } from 'vue'
import { NButton, NTooltip, NModal, NInput, useMessage } from 'naive-ui'
import { Terminal, Plus, Trash2 } from 'lucide-vue-next'
import { Terminal as XtermTerminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'

// 支持两种挂载形态：
// 1. 全页视图（/plugin/terminal?sessionId=...&cmd=...&terminalId=...）：参数来自地址栏 query
// 2. 面板 dock（ui.panels 声明）：sessionId 由平台 props 传入
const props = defineProps({
  sessionId: { type: String, default: null }
})

// 运行时插件的 UI 由独立的 Vue 编译器构建，只提供 vue / naive-ui / lucide-vue-next，
// 不能引用宿主路由（vue-router），全页视图的查询参数直接读地址栏。
const query = new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search)
const message = useMessage()

// ============================
// API 辅助
// ============================
function withSessionQuery(path, requestedSessionId = sessionId.value) {
  if (!requestedSessionId) return path
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}sessionId=${encodeURIComponent(requestedSessionId)}`
}

async function api(method, path, body, requestedSessionId = sessionId.value) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } }
  if (body) opts.body = JSON.stringify({ ...body, sessionId: requestedSessionId })
  const res = await fetch('/api' + withSessionQuery(path, requestedSessionId), opts)
  if (!res.ok) throw new Error(`请求失败 (${res.status})`)
  return res.json()
}
const apiGet = (p) => api('GET', p)
const apiPost = (p, b) => api('POST', p, b)
const apiPut = (p, b) => api('PUT', p, b)
const apiDel = (p) => api('DELETE', p)

// ============================
// 状态
// ============================
const terminals = ref([])
const activeId = ref(null)
const workspaceRoot = ref('')
const contextLoaded = ref(false)
const sessionId = computed(() => props.sessionId || query.get('sessionId') || '')
const xtermRef = ref(null)
const renameModal = reactive({ show: false, id: null, name: '' })

// xterm 实例（单例，切 tab 时重连 WS）
let xterm = null
let fitAddon = null
let ws = null
let currentTerminalId = null
let pendingCmd = null  // 来自路由查询参数或 panel 事件
let reloadGeneration = 0
let createRequest = null
let mounted = false
let xtermResizeObserver = null
let fitFrame = 0

// ============================
// 计算属性
// ============================
const activeTerm = computed(() => terminals.value.find(t => t.id === activeId.value) || null)

// ============================
// 主题感知（MutationObserver 监听 data-theme 变化）
// ============================
function buildXtermTheme() {
  const root = document.documentElement
  const g = (v) => getComputedStyle(root).getPropertyValue(v).trim()
  const isDark = root.getAttribute('data-theme') === 'dark'
  return {
    background: g('--bg-primary') || (isDark ? '#121214' : '#f2f0ee'),
    foreground: g('--text-primary') || (isDark ? '#e4e4e7' : '#171717'),
    cursor: g('--accent') || (isDark ? '#e4e4e7' : '#7a4f1f'),
    cursorAccent: g('--primary-text') || (isDark ? '#121214' : '#f8f7f5'),
    selectionBackground: g('--accent-light') || (isDark ? '#f0f0f5' : '#dcbc85'),
    selectionForeground: 'inherit',
    black: isDark ? '#2e2e34' : '#333333',
    red: isDark ? '#f85149' : '#C41E3A',
    green: isDark ? '#3fb950' : '#267507',
    yellow: isDark ? '#d29922' : '#8B6F00',
    blue: isDark ? '#58a6ff' : '#0550AE',
    magenta: isDark ? '#bc8cff' : '#8250DF',
    cyan: isDark ? '#39c5cf' : '#0E7E84',
    white: isDark ? '#e6edf3' : '#DDDDDD',
    brightBlack: isDark ? '#484f58' : '#666666',
    brightRed: isDark ? '#ff6b6b' : '#DA1B4B',
    brightGreen: isDark ? '#56d364' : '#2DA44E',
    brightYellow: isDark ? '#e3b341' : '#B58400',
    brightBlue: isDark ? '#79c0ff' : '#0969DA',
    brightMagenta: isDark ? '#d2a8ff' : '#A475D9',
    brightCyan: isDark ? '#56d4dd' : '#1B7C83',
    brightWhite: isDark ? '#f0f6fc' : '#FFFFFF'
  }
}

function updateXtermTheme() {
  if (!xterm) return
  xterm.options.theme = buildXtermTheme()
}

let themeObserver = null

function startThemeWatch() {
  themeObserver = new MutationObserver(() => {
    updateXtermTheme()
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme']
  })
}

function stopThemeWatch() {
  if (themeObserver) { themeObserver.disconnect(); themeObserver = null }
}

// ============================
// xterm 生命周期
// ============================
function createXterm() {
  if (xterm) return

  const fontFamily = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-code').trim() || "'JetBrains Mono Variable','Cascadia Code',monospace"

  xterm = new XtermTerminal({
    cols: 80,
    rows: 24,
    cursorBlink: true,
    cursorStyle: 'bar',
    fontSize: 13,
    fontFamily,
    allowProposedApi: true,
    theme: buildXtermTheme()
  })

  fitAddon = new FitAddon()
  xterm.loadAddon(fitAddon)
  xterm.loadAddon(new WebLinksAddon())

  xterm.onData((data) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }))
    }
  })

  startThemeWatch()
}

function destroyXterm() {
  stopThemeWatch()
  disconnectTerminal()
  if (xterm) {
    try { xterm.dispose() } catch {}
    xterm = null
    fitAddon = null
  }
}

function fitTerminal() {
  const container = xtermRef.value
  if (!fitAddon || !xterm || !container?.clientWidth || !container?.clientHeight) return

  try {
    fitAddon.fit()
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resize', cols: xterm.cols, rows: xterm.rows }))
    }
  } catch {}
}

function scheduleTerminalFit() {
  if (fitFrame) cancelAnimationFrame(fitFrame)
  fitFrame = requestAnimationFrame(() => {
    fitFrame = 0
    fitTerminal()
  })
}

// ============================
// WebSocket 连接
// ============================
function connectTerminal(id) {
  disconnectTerminal()
  currentTerminalId = id

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const sessionQuery = sessionId.value ? `&sessionId=${encodeURIComponent(sessionId.value)}` : ''
  const wsUrl = `${protocol}//${location.host}/api/plugins/terminal/ws?id=${id}${sessionQuery}`

  ws = new WebSocket(wsUrl)

  ws.onopen = () => {
    fitTerminal()
    // 连接就绪后若有待执行命令
    if (pendingCmd) {
      ws.send(JSON.stringify({ type: 'input', data: pendingCmd + '\r' }))
      pendingCmd = null
    }
  }

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data)
      switch (msg.type) {
        case 'ready':
          if (xterm) {
            xterm.clear()
            if (msg.scrollback) xterm.write(msg.scrollback)
            nextTick(scheduleTerminalFit)
            if (pendingCmd) {
              ws.send(JSON.stringify({ type: 'input', data: pendingCmd + '\r' }))
              pendingCmd = null
            }
          }
          break
        case 'data':
          if (xterm) xterm.write(msg.data)
          break
        case 'exit':
          if (xterm) {
            xterm.write(`\r\n\x1b[31m终端进程已退出 (exit: ${msg.exitCode})\x1b[0m\r\n`)
          }
          break
      }
    } catch { /* ignore parse errors */ }
  }

  ws.onclose = () => { ws = null }
  ws.onerror = () => { ws = null }
}

function disconnectTerminal() {
  if (ws) {
    ws.onclose = null
    ws.onerror = null
    ws.onmessage = null
    ws.close()
    ws = null
  }
  currentTerminalId = null
}

// ============================
// 终端管理
// ============================
async function loadTerminals(requestedSessionId = sessionId.value, generation = reloadGeneration) {
  try {
    const res = await api('GET', '/plugins/terminal/sessions', undefined, requestedSessionId)
    if (generation !== reloadGeneration || requestedSessionId !== sessionId.value) return
    if (res.success && res.data?.terminals) {
      terminals.value = res.data.terminals
    }
  } catch {}
}

async function resolveContext(requestedSessionId = sessionId.value, generation = reloadGeneration) {
  contextLoaded.value = false
  workspaceRoot.value = ''
  if (!requestedSessionId) { contextLoaded.value = true; return }
  try {
    const res = await api('GET', `/sessions/${encodeURIComponent(requestedSessionId)}/context`, undefined, requestedSessionId)
    if (generation !== reloadGeneration || requestedSessionId !== sessionId.value) return
    workspaceRoot.value = res.success ? res.data?.root || '' : ''
  } catch {}
  if (generation === reloadGeneration && requestedSessionId === sessionId.value) contextLoaded.value = true
}

async function createTerminal(requestedSessionId = sessionId.value, generation = reloadGeneration) {
  if (createRequest?.sessionId === requestedSessionId) return createRequest.promise

  const promise = (async () => {
    if (!requestedSessionId) {
      message.warning('请先选择一个会话，再创建终端')
      return
    }
    if (!contextLoaded.value) await resolveContext(requestedSessionId, generation)
    if (requestedSessionId !== sessionId.value || generation !== reloadGeneration) return
    if (!workspaceRoot.value) {
      message.error('无法解析当前会话的终端工作目录')
      return
    }

    try {
      const res = await api('POST', '/plugins/terminal/sessions', { cwd: workspaceRoot.value }, requestedSessionId)
      if (!res?.success || !res.data?.id) throw new Error(res?.error || '服务端未能创建终端')
      if (requestedSessionId !== sessionId.value || generation !== reloadGeneration) return
      if (!terminals.value.some(term => term.id === res.data.id)) terminals.value.unshift(res.data)
      activeId.value = res.data.id
    } catch (e) {
      message.error('创建终端失败: ' + e.message)
    }
  })()

  createRequest = { sessionId: requestedSessionId, promise }
  try {
    return await promise
  } finally {
    if (createRequest?.promise === promise) createRequest = null
  }
}

async function switchTab(id) {
  if (activeId.value === id) return
  activeId.value = id
  // xterm 和 WS 由 watch 处理
}

async function closeTab(id) {
  try {
    await apiDel(`/plugins/terminal/sessions/${id}`)
    terminals.value = terminals.value.filter(t => t.id !== id)
    if (activeId.value === id) {
      activeId.value = terminals.value[0]?.id || null
    }
  } catch {}
}

function isActiveRecently(tab) {
  if (!tab.alive) return false
  return Date.now() - tab.lastActiveAt < 3000
}

function clearScreen() {
  if (xterm) xterm.clear()
}

// ============================
// 重命名
// ============================
function startRename(tab) {
  renameModal.id = tab.id
  renameModal.name = tab.name
  renameModal.show = true
}

async function doRename() {
  if (!renameModal.id || !renameModal.name.trim()) return
  try {
    await apiPut(`/plugins/terminal/sessions/${renameModal.id}`, { name: renameModal.name.trim() })
    await loadTerminals()
    renameModal.show = false
  } catch {}
}

// ============================
// 拖拽排序
// ============================
let dragId = null
function dragTab(e, id) {
  dragId = id
  e.dataTransfer.effectAllowed = 'move'
}
function dragOverTab(e, id) {
  if (dragId && dragId !== id) {
    const list = [...terminals.value]
    const from = list.findIndex(t => t.id === dragId)
    const to = list.findIndex(t => t.id === id)
    if (from !== -1 && to !== -1) {
      const [item] = list.splice(from, 1)
      list.splice(to, 0, item)
      terminals.value = list
    }
  }
}
function dropTab() { dragId = null }

// ============================
// 面板事件桥接（artificer:terminal-exec）
// ============================
function handlePanelExec(e) {
  const cmd = e.detail?.command
  if (!cmd) return
  // 先确保有活跃终端
  if (!activeId.value) {
    createTerminal().then(() => {
      setTimeout(() => sendCommandToTerminal(cmd), 300)
    })
    return
  }
  sendCommandToTerminal(cmd)
}

function sendCommandToTerminal(cmd) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'input', data: cmd + '\r' }))
  } else {
    // WS 未就绪，暂存命令
    pendingCmd = cmd
  }
}

// ============================
// 检查路由查询参数（来自面板快速命令导航）
// ============================
function checkRouteCmd() {
  const cmd = query.get('cmd')
  if (cmd && cmd.trim()) {
    sendCommandToTerminal(cmd.trim())
  }
}

// ============================
// 生命周期
// ============================
async function reloadSession() {
  const generation = ++reloadGeneration
  const requestedSessionId = sessionId.value
  disconnectTerminal()
  terminals.value = []
  activeId.value = null
  workspaceRoot.value = ''
  contextLoaded.value = false
  if (xterm) xterm.clear()

  await Promise.all([
    resolveContext(requestedSessionId, generation),
    loadTerminals(requestedSessionId, generation)
  ])
  if (generation !== reloadGeneration || requestedSessionId !== sessionId.value) return

  const requestedTerminalId = query.get('terminalId') || ''
  if (requestedTerminalId && terminals.value.some(t => t.id === requestedTerminalId)) {
    activeId.value = requestedTerminalId
  } else if (terminals.value.length > 0) {
    activeId.value = terminals.value[0].id
  }
  if (terminals.value.length === 0 && workspaceRoot.value) {
    await createTerminal(requestedSessionId, generation)
  }
}

onMounted(async () => {
  createXterm()

  // xterm 挂载到 DOM
  await nextTick()
  if (xtermRef.value) {
    xterm.open(xtermRef.value)
    xtermResizeObserver = new ResizeObserver(scheduleTerminalFit)
    xtermResizeObserver.observe(xtermRef.value)
    nextTick(scheduleTerminalFit)
  }

  mounted = true
  await reloadSession()

  window.addEventListener('artificer:terminal-exec', handlePanelExec)
  checkRouteCmd()
})

watch(sessionId, () => {
  if (mounted) reloadSession()
})

// 监听 activeId 变化 → 切换 WS 连接
watch(activeId, async (newId, oldId) => {
  if (newId === oldId) return
  disconnectTerminal()
  if (newId) {
    await nextTick()  // 等待 DOM 更新（v-show 使容器可见）
    fitTerminal()
    connectTerminal(newId)
  }
})

// 窗口尺寸和 dock 尺寸变化时重新适配 xterm
const resizeHandler = scheduleTerminalFit
window.addEventListener('resize', resizeHandler)

onUnmounted(() => {
  mounted = false
  reloadGeneration++
  xtermResizeObserver?.disconnect()
  xtermResizeObserver = null
  if (fitFrame) cancelAnimationFrame(fitFrame)
  destroyXterm()
  window.removeEventListener('artificer:terminal-exec', handlePanelExec)
  window.removeEventListener('resize', resizeHandler)
})
</script>

<style scoped>
.terminal-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  font-size: 13px;
}

/* =========================================================
   标签栏
   ========================================================= */
.term-tabbar {
  display: flex;
  align-items: center;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
  min-height: 32px;
  background: var(--bg-primary);
}

.term-tabs {
  display: flex;
  flex: 1;
  overflow-x: auto;
  min-width: 0;
}

.term-tabs::-webkit-scrollbar { height: 0; }

.term-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12px;
  color: var(--text-muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  white-space: nowrap;
  user-select: none;
  transition: all 0.15s;
  min-width: 0;
  background: transparent;
}

.term-tab:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.term-tab.active {
  color: var(--text-primary);
  border-bottom-color: var(--accent);
  background: var(--bg-hover);
}

.term-tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  transition: background 0.2s;
}

.dot-alive { background: #3fb950; }
.dot-active { background: #3fb950; animation: pulse 1s infinite; }
.dot-dead { background: var(--text-muted); opacity: 0.4; }

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.term-tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
}

.term-tab-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: var(--radius-xs);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  padding: 0;
  opacity: 0;
  transition: all 0.15s;
}

.term-tab:hover .term-tab-close { opacity: 1; }
.term-tab-close:hover { background: var(--bg-hover); color: var(--warning-color); }

.term-tab-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  padding-right: 8px;
  flex-shrink: 0;
}

/* =========================================================
   xterm 容器
   ========================================================= */
.term-xterm-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 4px;
  background: var(--bg-primary);
}

.term-xterm-container :deep(.xterm) {
  height: 100%;
}

.term-xterm-container :deep(.xterm-viewport) {
  scrollbar-width: auto;
  scrollbar-color: var(--scrollbar-thumb) transparent;
}

/* =========================================================
   空状态
   ========================================================= */
.term-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: var(--text-muted);
  text-align: center;
}

.term-empty p { margin: 0; font-size: 13px; }
.term-empty .term-empty-hint { font-size: 11px; opacity: 0.65; }
</style>
