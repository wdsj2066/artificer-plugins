<template>
  <div class="doc-tool-result" :class="{ error: isError }">
    <div class="doc-tool-head">
      <Presentation :size="13" class="doc-tool-icon" />
      <span class="doc-tool-title">{{ isError ? 'PPT 生成失败' : 'PPT 已生成' }}</span>
      <span v-if="!isError" class="doc-tool-meta">{{ slides }} 页</span>
    </div>
    <div v-if="isError" class="doc-tool-error">{{ result.error }}</div>
    <div v-else class="doc-tool-path" :title="result.filePath">{{ result.filePath }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { Presentation } from 'lucide-vue-next'

// 插件工具渲染器（声明式）：plugin.json 的 ui.toolRenderers 声明
//   "createPptx": "renderers/PptxResult.vue"   → 本组件渲染 createPptx 工具结果
// 接收 { msg, toolDisplayName } 两个 props，msg 结构与内置渲染器一致（name / args / result / status）
const props = defineProps({
  msg: { type: Object, required: true },
  toolDisplayName: { type: Function, default: (n) => n }
})

const result = computed(() => props.msg.result || {})
const isError = computed(() => props.msg.status === 'error' || !!result.value.error)
const slides = computed(() => {
  // 后端返回的 slides 已经包含封面
  const n = result.value.slides
  return typeof n === 'number' ? n : ''
})
</script>

<style scoped>
.doc-tool-result {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  background: var(--bg-primary);
  overflow: hidden;
}
.doc-tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: #161b22;
  border-bottom: 1px solid #30363d;
}
.doc-tool-icon { color: #8b949e; flex-shrink: 0; }
.doc-tool-title { font-size: 12.5px; color: #e6edf3; font-weight: 500; }
.doc-tool-meta { font-size: 11px; color: #8b949e; margin-left: auto; }
.doc-tool-error { padding: 8px 12px; font-size: 12px; color: #c62828; line-height: 1.4; }
.doc-tool-path {
  padding: 8px 12px;
  font-size: 12px;
  font-family: 'JetBrains Mono Variable', 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
