<template>
  <button class="browser-toolbar-button" type="button" @click="openPanel">
    <span aria-hidden="true">◉</span>
    <span>网页预览</span>
  </button>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue'

const ACTIVITY_URL = '/api/plugins/browser-automation/activity'
const OPEN_REQUEST_KEY = 'artificer_browser_preview_open_request'
let lastActivityId = null
let timer = null
let polling = false

async function openActivity(activity) {
  if (!activity?.sessionId || !activity?.url) return
  try { sessionStorage.setItem(OPEN_REQUEST_KEY, JSON.stringify(activity)) } catch {}
  try { await window.artificer?.openSession?.(activity.sessionId) } catch {}
  window.artificer?.activatePanel?.('right', 'browser-automation/browser')
  window.dispatchEvent(new CustomEvent('artificer:browser-preview-open', { detail: activity }))
}

async function pollActivity() {
  if (polling) return
  polling = true
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
  } finally {
    polling = false
  }
}

function openPanel() {
  window.artificer?.activatePanel?.('right', 'browser-automation/browser')
}

onMounted(() => {
  void pollActivity()
  timer = setInterval(pollActivity, 900)
})

onUnmounted(() => clearInterval(timer))
</script>

<style scoped>
.browser-toolbar-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 9px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  font-size: 11px;
  cursor: pointer;
}
.browser-toolbar-button:hover { color: var(--text-primary); border-color: var(--accent); }
</style>
