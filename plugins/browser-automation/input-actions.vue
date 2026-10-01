<template>
  <div v-if="selection && sessionId" class="browser-input-actions">
    <span class="browser-selection-label" :title="selection.selector">已选 {{ selection.tag || '元素' }}</span>
    <button type="button" :disabled="disabled" @click="insertReference">引用元素</button>
    <button type="button" :disabled="disabled" @click="insertQuestion">单独提问</button>
    <button type="button" :disabled="disabled" @click="insertEditRequest">请求修改</button>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue'

const props = defineProps({
  disabled: { type: Boolean, default: false },
  sessionId: { type: String, default: null },
  insertText: { type: Function, default: null },
  setText: { type: Function, default: null }
})

const selection = ref(null)

function applySelection(detail) {
  if (detail?.sessionId !== props.sessionId) return
  selection.value = detail.selection || null
}

async function loadSelection() {
  selection.value = null
  if (!props.sessionId) return
  try {
    const response = await fetch(`/api/plugins/browser-automation/status?sessionId=${encodeURIComponent(props.sessionId)}`, { cache: 'no-store' })
    const payload = await response.json()
    selection.value = payload?.data?.status?.selection || null
  } catch { selection.value = null }
}

function selectionContext() {
  const item = selection.value
  const classes = (item.classes || []).map(name => `.${name}`).join('')
  const identity = item.id ? `#${item.id}` : classes
  const html = String(item.html || '').slice(0, 4000)
  return [
    '【浏览器选中的网页元素】',
    `页面：${item.title || ''}（${item.url || ''}）`,
    `元素：<${item.tag || 'div'}${identity}>`,
    `CSS 选择器：${item.selector || ''}`,
    item.text ? `可见文本：${item.text}` : '',
    html ? `HTML：\n\`\`\`html\n${html}\n\`\`\`` : ''
  ].filter(Boolean).join('\n')
}

function addPrompt(kind) {
  if (!selection.value || typeof props.insertText !== 'function') return
  const context = selectionContext()
  const prompts = {
    reference: `${context}\n\n请结合这个网页元素回答我接下来的问题：\n`,
    question: `${context}\n\n请只围绕这个网页元素回答问题。我的问题是：\n`,
    edit: `${context}\n\n请在当前工作区定位该网页元素对应的 HTML、Vue 或样式代码，并按下面的要求修改；完成后说明改动：\n`
  }
  props.insertText(`\n${prompts[kind]}`)
}

function insertReference() { addPrompt('reference') }
function insertQuestion() { addPrompt('question') }
function insertEditRequest() { addPrompt('edit') }

function onSelection(event) { applySelection(event.detail || {}) }
function onCompose(event) {
  const detail = event.detail || {}
  applySelection(detail)
  if (detail.sessionId === props.sessionId) addPrompt(detail.kind || 'reference')
}

onMounted(() => {
  window.addEventListener('artificer:browser-selection', onSelection)
  window.addEventListener('artificer:browser-compose', onCompose)
  void loadSelection()
})
onUnmounted(() => {
  window.removeEventListener('artificer:browser-selection', onSelection)
  window.removeEventListener('artificer:browser-compose', onCompose)
})
watch(() => props.sessionId, loadSelection)
</script>

<style scoped>
.browser-input-actions { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.browser-selection-label { max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: 10px; }
.browser-input-actions button { padding: 3px 7px; border: 1px solid var(--border-color); border-radius: 5px; color: var(--text-secondary); background: var(--bg-secondary); font-size: 10px; cursor: pointer; white-space: nowrap; }
.browser-input-actions button:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.browser-input-actions button:disabled { opacity: .45; cursor: default; }
</style>
