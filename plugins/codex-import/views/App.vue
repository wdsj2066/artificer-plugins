<script setup>
import { computed, onMounted, ref } from 'vue'

const config = ref(null)
const sessions = ref([])
const workspaces = ref([])
const selectedPath = ref('')
const preview = ref(null)
const filter = ref('')
const targetWorkspace = ref('')
const includeOriginal = ref(false)
const loading = ref(false)
const previewLoading = ref(false)
const importing = ref(false)
const error = ref('')
const importResult = ref(null)

const realWorkspaces = computed(() => workspaces.value.filter((item) => item.folderPath))
const filteredSessions = computed(() => {
  const keyword = filter.value.trim().toLowerCase()
  if (!keyword) return sessions.value
  return sessions.value.filter((item) => {
    const haystack = [item.summary, item.meta && item.meta.cwd, item.relPath].join(' ').toLowerCase()
    return haystack.includes(keyword)
  })
})

async function api(path, options) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  })
  let data = null
  try { data = await response.json() } catch { data = null }
  if (!response.ok) throw new Error((data && data.error) || ('请求失败 ' + response.status))
  return data
}

function fmtTime(value) {
  if (!value) return '未知时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (number) => String(number).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fmtSize(bytes) {
  if (!bytes) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

async function loadAll() {
  loading.value = true
  error.value = ''
  try {
    const [cfg, list, workspaceData] = await Promise.all([
      api('/api/plugins/codex-import/config'),
      api('/api/plugins/codex-import/sessions'),
      api('/api/plugins/codex-import/workspaces')
    ])
    config.value = cfg
    sessions.value = list.rows || []
    workspaces.value = workspaceData.workspaces || []
    if (!targetWorkspace.value && realWorkspaces.value.length) targetWorkspace.value = realWorkspaces.value[0].id
  } catch (err) {
    error.value = String(err.message || err)
  } finally {
    loading.value = false
  }
}

async function selectSession(row) {
  selectedPath.value = row.relPath
  preview.value = null
  importResult.value = null
  previewLoading.value = true
  error.value = ''
  try {
    preview.value = await api('/api/plugins/codex-import/session?path=' + encodeURIComponent(row.relPath))
  } catch (err) {
    error.value = String(err.message || err)
  } finally {
    previewLoading.value = false
  }
}

async function runImport() {
  if (!selectedPath.value || !targetWorkspace.value) return
  importing.value = true
  error.value = ''
  try {
    const result = await api('/api/plugins/codex-import/import', {
      method: 'POST',
      body: JSON.stringify({
        path: selectedPath.value,
        workspaceId: targetWorkspace.value,
        includeOriginal: includeOriginal.value
      })
    })
    importResult.value = result
    const row = sessions.value.find((item) => item.relPath === selectedPath.value)
    if (row) row.imported = true
    await loadAll()
  } catch (err) {
    error.value = String(err.message || err)
  } finally {
    importing.value = false
  }
}

function openCreatedSession() {
  const artificer = window.artificer || null
  if (artificer && typeof artificer.openSession === 'function' && importResult.value && importResult.value.sessionId) {
    artificer.openSession(importResult.value.sessionId)
  }
}

onMounted(loadAll)
</script>

<template>
  <div class="codex-import">
    <div class="ci-inner">
      <header class="ci-head">
        <div class="ci-head-text">
          <h1>Codex 会话导入</h1>
          <p>
            读取本机 Codex 会话，写入工作区 Markdown，并在该工作区创建可续聊的会话。
            <span v-if="config" class="ci-path">{{ config.root }}</span>
          </p>
        </div>
        <button class="ci-btn" :disabled="loading" @click="loadAll">{{ loading ? '扫描中' : '重新扫描' }}</button>
      </header>

      <div v-if="config && !config.exists" class="ci-notice">
        未找到 Codex 会话目录（{{ config.root }}），请在插件设置中填写 Codex 数据目录。
      </div>

      <div class="ci-toolbar">
        <input v-model="filter" class="ci-search" type="search" placeholder="按摘要、工作目录或文件名筛选" />
        <div class="ci-target">
          <label for="codex-ws">目标工作区</label>
          <select id="codex-ws" v-model="targetWorkspace" class="ci-select">
            <option v-for="item in realWorkspaces" :key="item.id" :value="item.id">
              {{ item.name }}（{{ item.sessionCount }} 会话）
            </option>
          </select>
          <label class="ci-check"><input v-model="includeOriginal" type="checkbox" /> 同时保存原始 JSONL</label>
        </div>
        <button
          class="ci-primary"
          :disabled="!selectedPath || !targetWorkspace || importing || realWorkspaces.length === 0"
          @click="runImport"
        >
          {{ importing ? '写入中' : '导入并创建会话' }}
        </button>
      </div>

      <div v-if="realWorkspaces.length === 0" class="ci-notice">
        当前没有带文件夹路径的真实工作区，请先在工作区管理中创建一个。
      </div>

      <div v-if="error" class="ci-notice ci-error">{{ error }}</div>

      <main class="ci-grid">
        <section class="ci-pane">
          <div class="ci-pane-head">
            <span>会话列表</span>
            <span class="ci-count">{{ filteredSessions.length }} / {{ sessions.length }}</span>
          </div>
          <div class="ci-list">
            <button
              v-for="row in filteredSessions"
              :key="row.relPath"
              class="ci-row"
              :class="{ active: row.relPath === selectedPath }"
              @click="selectSession(row)"
            >
              <div class="ci-row-top">
                <span class="ci-time">{{ fmtTime(row.meta && row.meta.startedAt) }}</span>
                <span v-if="row.imported" class="ci-tag">已导入</span>
              </div>
              <div class="ci-summary">{{ row.summary || row.error || '（没有用户消息）' }}</div>
              <div class="ci-row-meta">
                <span>{{ row.meta && row.meta.cwd ? row.meta.cwd : '未知目录' }}</span>
                <span>{{ fmtSize(row.size) }}</span>
              </div>
            </button>
            <div v-if="!filteredSessions.length && !loading" class="ci-empty">没有可显示的会话</div>
          </div>
        </section>

        <section class="ci-pane">
          <div class="ci-pane-head">
            <span>预览</span>
            <span v-if="preview" class="ci-count">{{ preview.messages.length }} 条正文</span>
          </div>
          <div class="ci-preview">
            <div v-if="previewLoading" class="ci-empty">读取中…</div>
            <div v-else-if="!preview" class="ci-empty">从左侧选择一个会话查看内容</div>
            <template v-else>
              <div class="ci-meta">
                <div><span class="ci-k">开始时间</span><span class="ci-v">{{ fmtTime(preview.meta.startedAt) }}</span></div>
                <div><span class="ci-k">工作目录</span><span class="ci-v">{{ preview.meta.cwd || '未知' }}</span></div>
                <div><span class="ci-k">模型</span><span class="ci-v">{{ preview.meta.model || '未记录' }}</span></div>
                <div><span class="ci-k">工具调用</span><span class="ci-v">{{ preview.stats.toolCalls }} 次（不导出）</span></div>
                <div class="ci-wide"><span class="ci-k">会话文件</span><span class="ci-v ci-mono">{{ preview.relPath }}</span></div>
              </div>
              <div v-if="preview.truncated" class="ci-notice">部分超长消息在预览中已截断，导入时会写完整正文。</div>
              <div class="ci-messages">
                <article v-for="(message, index) in preview.messages" :key="index" class="ci-message" :class="message.role">
                  <div class="ci-message-head">
                    <span class="ci-role">{{ message.role === 'user' ? '用户' : '助手' }}</span>
                    <span class="ci-time">{{ fmtTime(message.time) }}</span>
                  </div>
                  <pre class="ci-text">{{ message.text }}</pre>
                </article>
                <div v-if="!preview.messages.length" class="ci-empty">该会话没有可导出的用户或助手正文</div>
              </div>
              <div v-if="importResult" class="ci-result">
                <div class="ci-result-title">已写入 {{ importResult.messageCount }} 条消息</div>
                <div v-if="importResult.sessionId" class="ci-mono">新会话：{{ importResult.sessionId }}</div>
                <div v-if="importResult.chatError" class="ci-notice ci-error">会话正文写入失败：{{ importResult.chatError }}</div>
                <div class="ci-mono">{{ importResult.markdownPath }}</div>
                <div v-if="importResult.originalPath" class="ci-mono">{{ importResult.originalPath }}</div>
                <button v-if="importResult.sessionId" class="ci-btn" style="align-self:flex-start;margin-top:6px" @click="openCreatedSession">打开该会话</button>
              </div>
            </template>
          </div>
        </section>
      </main>
    </div>
  </div>
</template>

<style scoped>
.codex-import {
  height: 100%;
  box-sizing: border-box;
  padding: 26px 24px 32px;
  display: flex;
  overflow: hidden;
  background: transparent;
  color: var(--text-primary, inherit);
  font-family: var(--font-body, inherit);
  font-size: 13px;
  line-height: 1.6;
}
.ci-inner {
  width: 100%;
  max-width: 900px;
  margin: 0 auto;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ci-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.ci-head-text h1 { margin: 0 0 4px; font-size: 20px; font-weight: 600; color: var(--text-primary, inherit); }
.ci-head-text p { margin: 0; font-size: 12px; color: var(--text-secondary, inherit); display: flex; flex-direction: column; gap: 2px; }
.ci-path { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; word-break: break-all; color: var(--text-muted, inherit); }
.ci-btn, .ci-primary, .ci-select {
  background: var(--bg-secondary, transparent);
  border: 1px solid var(--border-color, rgba(127, 127, 127, 0.35));
  color: var(--text-primary, inherit);
  border-radius: var(--radius-sm, 6px);
  padding: 5px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}
.ci-btn:hover:not(:disabled), .ci-primary:hover:not(:disabled) { background: var(--bg-hover, rgba(127, 127, 127, 0.12)); }
.ci-primary { background: var(--focus-outline-color, #2563eb); border-color: var(--focus-outline-color, #2563eb); color: #fff; }
.ci-primary:hover:not(:disabled) { opacity: 0.9; background: var(--focus-outline-color, #2563eb); }
.ci-btn:disabled, .ci-primary:disabled { opacity: 0.5; cursor: not-allowed; }
.ci-btn:focus-visible, .ci-primary:focus-visible, .ci-select:focus-visible, .ci-search:focus-visible { outline: 2px solid var(--focus-outline-color, #2563eb); outline-offset: 1px; }
.ci-notice {
  padding: 8px 12px;
  border-radius: var(--radius-sm, 6px);
  font-size: 12px;
  color: var(--text-secondary, inherit);
  background: color-mix(in srgb, var(--warning-color, #d97706) 12%, transparent);
}
.ci-notice.ci-error { color: var(--diff-del-color, #b42318); background: color-mix(in srgb, var(--diff-del-color, #b42318) 12%, transparent); }
.ci-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ci-search {
  flex: 1;
  min-width: 200px;
  padding: 6px 10px;
  border-radius: var(--radius-sm, 6px);
  border: 1px solid var(--border-color, rgba(127, 127, 127, 0.35));
  background: var(--bg-secondary, transparent);
  color: var(--text-primary, inherit);
  font-size: 12px;
  font-family: inherit;
}
.ci-target { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary, inherit); }
.ci-select { max-width: 190px; padding: 5px 8px; }
.ci-check { display: inline-flex; align-items: center; gap: 4px; color: var(--text-muted, inherit); font-size: 12px; }
.ci-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: 300px 1fr; gap: 12px; }
.ci-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid var(--border-color, rgba(127, 127, 127, 0.35));
  border-radius: var(--radius-md, 8px);
  overflow: hidden;
  background: var(--panel-surface, transparent);
}
.ci-pane-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary, inherit);
  border-bottom: 1px solid var(--border-color, rgba(127, 127, 127, 0.35));
  background: var(--bg-secondary, transparent);
}
.ci-count { font-weight: 400; color: var(--text-secondary, inherit); }
.ci-list { flex: 1; overflow-y: auto; scrollbar-width: thin; }
.ci-row {
  display: block;
  width: 100%;
  text-align: left;
  padding: 10px 12px;
  border: 0;
  border-bottom: 1px solid var(--border-color, rgba(127, 127, 127, 0.25));
  background: transparent;
  color: inherit;
  font-family: inherit;
  cursor: pointer;
}
.ci-row:hover { background: var(--bg-hover, rgba(127, 127, 127, 0.1)); }
.ci-row.active { background: color-mix(in srgb, var(--focus-outline-color, #2563eb) 12%, transparent); }
.ci-row-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ci-time { font-size: 11px; color: var(--text-muted, inherit); }
.ci-tag {
  font-size: 10px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--diff-add-color, #10b981) 45%, transparent);
  color: var(--diff-add-color, #0f766e);
  white-space: nowrap;
}
.ci-summary {
  margin: 4px 0;
  font-size: 13px;
  line-height: 1.45;
  color: var(--text-primary, inherit);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.ci-row-meta { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--text-muted, inherit); }
.ci-row-meta span:first-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ci-preview { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 12px; scrollbar-width: thin; }
.ci-meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px 16px; font-size: 12px; }
.ci-meta .ci-k { display: block; color: var(--text-muted, inherit); }
.ci-meta .ci-v { display: block; color: var(--text-primary, inherit); word-break: break-all; }
.ci-wide { grid-column: 1 / -1; }
.ci-mono { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; color: var(--text-secondary, inherit); }
.ci-messages { display: flex; flex-direction: column; gap: 10px; }
.ci-message {
  border: 1px solid var(--border-color, rgba(127, 127, 127, 0.35));
  border-radius: var(--radius-md, 8px);
  padding: 10px 12px;
  background: var(--bg-secondary, transparent);
}
.ci-message-head { display: flex; justify-content: space-between; font-size: 11px; color: var(--text-muted, inherit); margin-bottom: 6px; }
.ci-role { font-weight: 600; color: var(--text-secondary, inherit); }
.ci-text { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.6; font-family: inherit; color: var(--text-primary, inherit); }
.ci-empty { padding: 24px; text-align: center; color: var(--text-muted, inherit); font-size: 13px; }
.ci-result {
  border: 1px solid color-mix(in srgb, var(--diff-add-color, #10b981) 45%, transparent);
  border-radius: var(--radius-md, 8px);
  padding: 10px 12px;
  font-size: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: color-mix(in srgb, var(--diff-add-color, #10b981) 10%, transparent);
}
.ci-result-title { font-weight: 600; color: var(--diff-add-color, #067647); }
@media (max-width: 760px) {
  .ci-grid { grid-template-columns: 1fr; grid-template-rows: minmax(180px, 38%) 1fr; }
  .ci-head-text h1 { font-size: 18px; }
}
</style>
