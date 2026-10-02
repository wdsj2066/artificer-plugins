<template>
  <section class="screenshot-result" :class="{ error: isError }">
    <header class="screenshot-result-header">
      <strong>{{ isError ? '截图失败' : result.scope === 'desktop' ? '桌面截图' : '网页截图' }}</strong>
      <span v-if="!isError && result.width && result.height">
        {{ result.scope === 'desktop' ? '整个屏幕' : result.mode === 'fullPage' ? '完整网页' : '当前视口' }} · {{ result.width }} × {{ result.height }}
      </span>
    </header>
    <p v-if="isError" class="screenshot-result-error">{{ result.error || '网页截图失败。' }}</p>
    <div v-else-if="loading" class="screenshot-result-placeholder">正在加载截图…</div>
    <p v-else-if="loadError" class="screenshot-result-error">{{ loadError }}</p>
    <div v-else-if="dataUrl" class="screenshot-result-image-wrap">
      <a :href="dataUrl" target="_blank" rel="noopener" title="在新窗口查看原图">
        <img :src="dataUrl" :alt="result.scope === 'desktop' ? '桌面截图' : '网页截图'" />
      </a>
      <a class="screenshot-result-download" :href="dataUrl" :download="fileName">保存 JPG</a>
    </div>
    <p v-if="!isError && result.url" class="screenshot-result-url" :title="result.url">{{ result.url }}</p>
  </section>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  msg: { type: Object, required: true },
  toolDisplayName: { type: Function, default: name => name }
})

const result = computed(() => props.msg.result || {})
const isError = computed(() => props.msg.status === 'error' || result.value.success === false || !!result.value.error)
const dataUrl = ref('')
const loading = ref(false)
const loadError = ref('')
const fileName = computed(() => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `${result.value.scope === 'desktop' ? 'desktop' : 'webpage'}-screenshot-${timestamp}.jpg`
})

watch(() => [result.value.sessionId, result.value.screenshotId], async ([sessionId, screenshotId], _previous, onCleanup) => {
  dataUrl.value = ''
  loadError.value = ''
  if (!sessionId || !screenshotId || isError.value) return

  const controller = new AbortController()
  onCleanup(() => controller.abort())
  loading.value = true
  try {
    const query = new URLSearchParams({ sessionId, screenshotId })
    const response = await fetch(`/api/plugins/browser-automation/screenshot/image?${query}`, { cache: 'no-store', signal: controller.signal })
    const payload = await response.json()
    if (!response.ok || payload?.success === false) throw new Error(payload?.error || `截图读取失败（HTTP ${response.status}）`)
    dataUrl.value = payload.data?.dataUrl || ''
    if (!dataUrl.value) throw new Error('截图数据为空。')
  } catch (error) {
    if (error.name !== 'AbortError') loadError.value = error.message || '截图读取失败。'
  } finally {
    if (!controller.signal.aborted) loading.value = false
  }
}, { immediate: true })
</script>

<style scoped>
.screenshot-result { overflow:hidden; border:1px solid var(--border-color); border-radius:8px; background:var(--bg-primary); }
.screenshot-result-header { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:7px 10px; border-bottom:1px solid var(--border-color); }
.screenshot-result-header strong { color:var(--text-primary); font-size:12px; font-weight:600; }
.screenshot-result-header span,.screenshot-result-url { color:var(--text-muted); font:10px/1.45 Consolas,monospace; }
.screenshot-result-placeholder,.screenshot-result-error { margin:0; padding:14px; color:var(--text-muted); font-size:11px; }
.screenshot-result-error { color:#c62828; }
.screenshot-result-image-wrap { position:relative; display:flex; max-height:360px; justify-content:center; overflow:auto; padding:8px; background:var(--bg-secondary); }
.screenshot-result-image-wrap img { display:block; max-width:100%; height:auto; object-fit:contain; }
.screenshot-result-download { position:sticky; right:0; bottom:0; align-self:flex-end; flex:none; margin:0 0 4px -78px; padding:5px 8px; border:1px solid var(--accent); border-radius:5px; color:#fff; background:var(--accent); font-size:10px; text-decoration:none; }
.screenshot-result-url { overflow:hidden; margin:0; padding:6px 10px; text-overflow:ellipsis; white-space:nowrap; }
</style>
