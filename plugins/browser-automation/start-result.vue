<template>
  <div class="start-result" :class="{ error: !!result.error || msg.status === 'error' }">
    <div class="result-copy">
      <strong>{{ result.error ? '网页预览启动失败' : '网页预览已启动' }}</strong>
      <span v-if="result.previewUrl">{{ result.upstreamUrl || result.previewUrl }}</span>
      <span v-else-if="result.error">{{ result.error }}</span>
      <span v-else>等待本机开发服务输出 URL</span>
    </div>
    <button v-if="result.previewUrl && result.sessionId" type="button" @click="openPreview">打开实时预览</button>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  msg: { type: Object, required: true },
  toolDisplayName: { type: Function, default: name => name }
})

const result = computed(() => props.msg.result || {})

async function openPreview() {
  const activity = {
    id: `manual-${Date.now()}`,
    sessionId: result.value.sessionId,
    url: result.value.previewUrl,
    upstreamUrl: result.value.upstreamUrl,
    createdAt: Date.now()
  }
  try { sessionStorage.setItem('artificer_browser_preview_open_request', JSON.stringify(activity)) } catch {}
  try { await window.artificer?.openSession?.(activity.sessionId) } catch {}
  window.dispatchEvent(new CustomEvent('artificer:browser-preview-open', { detail: activity }))
}
</script>

<style scoped>
.start-result { display:flex; align-items:center; gap:10px; padding:8px 10px; border:1px solid var(--border-color); border-radius:7px; background:var(--bg-primary); }
.result-copy { display:flex; min-width:0; flex:1; flex-direction:column; gap:3px; }
.result-copy strong { color:var(--text-primary); font-size:11px; }
.result-copy span { overflow:hidden; color:var(--text-muted); font:10px/1.4 Consolas,monospace; text-overflow:ellipsis; white-space:nowrap; }
.start-result.error .result-copy strong,.start-result.error .result-copy span { color:#d84a4a; }
.start-result button { flex:none; padding:5px 8px; border:1px solid var(--accent); border-radius:5px; color:#fff; background:var(--accent); font-size:10px; cursor:pointer; }
</style>
