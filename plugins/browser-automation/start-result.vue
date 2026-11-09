<template>
  <div class="start-result" :class="{ error: !!result.error || msg.status === 'error' }">
    <div class="result-copy">
      <strong>{{ result.error ? '网页预览启动失败' : '网页预览已启动' }}</strong>
      <span v-if="result.previewUrl">{{ result.upstreamUrl || result.previewUrl }}</span>
      <span v-else-if="result.error">{{ result.error }}</span>
      <span v-else>等待本机开发服务输出 URL</span>
    </div>
    <button v-if="result.previewUrl && result.sessionId" type="button" :disabled="opening" @click="openPreview">{{ opening ? '正在打开…' : '打开信息面板预览' }}</button>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  msg: { type: Object, required: true },
  toolDisplayName: { type: Function, default: name => name }
})

const result = computed(() => props.msg.result || {})

const PANEL_KEY = 'browser-automation/browser'

/**
 * 直接请求宿主展开右侧信息面板。
 * 宿主 activatePanel 内部会先把面板加回 dock 再激活，面板被关闭时同样有效；
 * 旧版本只派发 artificer:activate-panel 事件，而宿主没有该事件的监听者，
 * 面板被关闭后就再也拉不起来，因此这里必须优先走 activatePanel。
 */
function activatePanel() {
  if (window.artificer?.activatePanel) {
    try { window.artificer.activatePanel('right', PANEL_KEY) } catch {}
    return true
  }
  window.dispatchEvent(new CustomEvent('artificer:activate-panel', {
    detail: { region: 'right', panelKey: PANEL_KEY, reason: 'browser-preview' }
  }))
  return false
}

/**
 * 激活可能早于面板组件注册：宿主要先加载插件 UI 再挂载面板，
 * 首次调用可能落空，因此短暂重试几次，不阻塞工具结果展示。
 */
function activatePanelWithRetry(attempts = 6, delayMs = 400) {
  let remaining = attempts
  const tick = () => {
    const viaHost = activatePanel()
    if (viaHost) return
    if (--remaining > 0) setTimeout(tick, delayMs)
  }
  tick()
}

const OPEN_ACK_EVENT = 'artificer:browser-preview-opened'
const OPEN_ACK_TIMEOUT = 15_000
const opening = ref(false)

/**
 * 等待面板回执：面板展开、预览页可渲染后才结束。
 * activatePanel 只是同步改状态，组件挂载与 iframe 加载都在之后，不能当完成信号。
 */
function waitForOpen(requestId) {
  return new Promise(resolve => {
    const timer = setTimeout(() => finish({ success: false, timedOut: true }), OPEN_ACK_TIMEOUT)
    function finish(outcome) {
      clearTimeout(timer)
      window.removeEventListener(OPEN_ACK_EVENT, onOpened)
      resolve(outcome)
    }
    function onOpened(event) {
      if (event.detail?.requestId !== requestId) return
      finish({ success: event.detail.success !== false, error: event.detail.error || '' })
    }
    window.addEventListener(OPEN_ACK_EVENT, onOpened)
  })
}

async function openPreview() {
  if (opening.value) return
  const requestId = `manual-${Date.now()}`
  const activity = {
    id: requestId,
    requestId,
    sessionId: result.value.sessionId,
    url: result.value.previewUrl,
    upstreamUrl: result.value.upstreamUrl,
    createdAt: Date.now()
  }
  try { sessionStorage.setItem('artificer_browser_preview_open_request', JSON.stringify(activity)) } catch {}
  // 先挂回执监听再激活，避免面板挂载极快时错过完成事件。
  // 缓存请求用于面板尚未挂载（被关闭）时的兜底消费。
  const pending = waitForOpen(requestId)
  opening.value = true
  activatePanel()
  try { await window.artificer?.openSession?.(activity.sessionId) } catch {}
  window.dispatchEvent(new CustomEvent('artificer:browser-preview-open', { detail: activity }))
  const outcome = await pending
  opening.value = false
  if (outcome.timedOut) window.artificer?.toast?.('预览面板已展开，页面仍在加载', 'warning')
  else if (!outcome.success) window.artificer?.toast?.(outcome.error || '预览打开失败', 'error')
}

// Agent 启动预览后自动展开面板：用户不必再手动点卡片按钮。
// 只在工具成功返回预览地址时触发一次，错误结果不打扰用户。
let autoOpenedFor = ''
watch(() => [result.value.sessionId, result.value.previewUrl], ([sessionId, previewUrl]) => {
  if (!sessionId || !previewUrl) return
  const key = `${sessionId}::${previewUrl}`
  if (autoOpenedFor === key) return
  autoOpenedFor = key
  activatePanelWithRetry()
}, { immediate: true })
</script>

<style scoped>
.start-result { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid var(--border-color); border-radius:7px; background:var(--bg-primary); }
.result-copy { display:flex; min-width:0; flex:1; flex-direction:column; gap:3px; }
.result-copy strong { color:var(--text-primary); font-size:11px; }
.result-copy span { overflow:hidden; color:var(--text-muted); font:10px/1.4 Consolas,monospace; text-overflow:ellipsis; white-space:nowrap; }
.start-result.error .result-copy strong,.start-result.error .result-copy span { color:#d84a4a; }
.start-result button { flex:none; padding:5px 8px; border:1px solid var(--accent); border-radius:5px; color:#fff; background:var(--accent); font-size:10px; cursor:pointer; }
.start-result button:disabled { opacity:.6; cursor:default; }
</style>
