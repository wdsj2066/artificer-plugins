<template>
  <div v-if="settings.enabled" class="token-usage" aria-label="Token 用量">
    <span>Token {{ format(tokenCount) }}</span>
    <span>输入 {{ format(promptTokens) }}</span>
    <span>输出 {{ format(completionTokens) }}</span>
    <span>缓存 {{ cacheRate }}</span>
    <span>上下文 {{ format(lastPromptTokens) }} / {{ format(contextWindow) }}</span>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'

const props = defineProps({
  tokenCount: { type: Number, default: 0 },
  promptTokens: { type: Number, default: 0 },
  completionTokens: { type: Number, default: 0 },
  cachedTokens: { type: Number, default: 0 },
  lastPromptTokens: { type: Number, default: 0 },
  contextWindow: { type: Number, default: 0 }
})

const settings = ref({ enabled: true })
const cacheRate = computed(() => props.promptTokens ? `${Math.round((props.cachedTokens / props.promptTokens) * 100)}%` : '-')

function format(value) {
  return Number(value || 0).toLocaleString()
}

async function loadSettings() {
  try {
    const response = await fetch('/api/plugins/token-usage/settings')
    const result = await response.json()
    if (result.success && result.data?.values) {
      settings.value = { ...settings.value, ...result.data.values }
    }
  } catch {}
}

function applySettings(event) {
  if (event.detail?.pluginId !== 'token-usage') return
  settings.value = { ...settings.value, ...event.detail.settings }
}

onMounted(() => {
  loadSettings()
  window.addEventListener('artificer:plugin-settings-changed', applySettings)
})
onUnmounted(() => window.removeEventListener('artificer:plugin-settings-changed', applySettings))
</script>

<style scoped>
.token-usage {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  margin: 4px 8px 0;
  overflow-x: auto;
  color: var(--text-tertiary, #9ca3af);
  font-size: 10px;
  line-height: 16px;
  white-space: nowrap;
  scrollbar-width: none;
  font-variant-numeric: tabular-nums;
}
.token-usage::-webkit-scrollbar { display: none; }
.token-usage span + span::before { margin-right: 10px; color: var(--border-color, #e5e7eb); content: '·'; }
</style>
