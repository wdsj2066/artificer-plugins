<template>
  <n-button
      v-if="visible"
      size="tiny"
      quaternary
      :loading="extracting"
      title="从这轮对话提炼原生 Skill"
      @click.stop="extractSkill"
    >
      <template #icon><Sparkles :size="13" /></template>
      提炼为 Skill
  </n-button>

    <n-modal v-model:show="editorOpen" preset="card" title="检查并保存为 Skill" class="skill-draft-modal" :mask-closable="false">
      <div class="skill-draft-form">
        <p class="skill-hint">保存后会创建用户级 Markdown Context Skill，自动标记「对话提炼」「任务配方」，并立即注册到技能库。全文由 Agent 按需通过 <code>readContext</code> 读取。</p>

        <label class="form-field">
          <span>Skill ID</span>
          <n-input v-model:value="draft.id" maxlength="64" />
          <small>只能使用英文字母开头，以及字母、数字、下划线和连字符。若提示 ID 已存在，可改名后另存。</small>
        </label>
        <label class="form-field">
          <span>名称</span>
          <n-input v-model:value="draft.name" maxlength="80" />
        </label>
        <label class="form-field">
          <span>目录说明</span>
          <n-input v-model:value="draft.description" maxlength="300" />
        </label>

        <section class="form-section">
          <div class="section-heading">
            <strong>参数占位符</strong>
            <n-button size="tiny" quaternary @click="addParameter"><Plus :size="12" />添加参数</n-button>
          </div>
          <div v-if="draft.parameters.length === 0" class="form-empty">此 Skill 不声明参数；可在正文里描述需要用户提供的信息。</div>
          <div v-for="(parameter, index) in draft.parameters" :key="index" class="parameter-row">
            <n-input v-model:value="parameter.name" placeholder="变量名" />
            <n-input v-model:value="parameter.label" placeholder="显示名称" />
            <n-input v-model:value="parameter.description" placeholder="填写说明" />
            <n-button size="tiny" quaternary type="error" title="移除参数" @click="draft.parameters.splice(index, 1)"><X :size="13" /></n-button>
          </div>
        </section>

        <label class="form-field">
          <span>Skill 正文（Markdown）</span>
          <n-input v-model:value="draft.content" type="textarea" :rows="16" placeholder="适用场景、参数、步骤、安全约束和完成标准" />
        </label>
        <p v-if="warning" class="skill-warning">{{ warning }}</p>
      </div>
      <template #footer>
        <div class="modal-actions">
          <n-button size="small" @click="editorOpen = false">取消</n-button>
          <n-button size="small" type="primary" :loading="saving" @click="saveSkill">
            <template #icon><BookOpenCheck :size="13" /></template>
            保存到技能库
          </n-button>
        </div>
      </template>
  </n-modal>
</template>

<script setup>
import { computed, reactive, ref } from 'vue'
import { BookOpenCheck, Plus, Sparkles, X } from 'lucide-vue-next'

const props = defineProps({
  msg: { type: Object, default: () => ({}) },
  sessionId: { type: String, default: null }
})

const extracting = ref(false)
const saving = ref(false)
const editorOpen = ref(false)
const warning = ref('')
const visible = computed(() => Boolean(
  props.sessionId && props.msg?.role === 'assistant' && !props.msg?.isStreaming && String(props.msg?.content || '').trim()
))

const extractionTags = ['对话提炼', '任务配方']
const draft = reactive({ id: '', sourceKey: '', name: '', description: '', parameters: [], content: '' })

function toast(type, content) {
  window.dispatchEvent(new CustomEvent('artificer:toast', { detail: { type, content } }))
}

function setDraft(skill) {
  draft.id = skill.id || ''
  draft.sourceKey = skill.sourceKey || ''
  draft.name = skill.name || ''
  draft.description = skill.description || ''
  draft.parameters = (skill.parameters || []).map(parameter => ({
    name: parameter.name || '',
    label: parameter.label || parameter.name || '',
    description: parameter.description || ''
  }))
  draft.content = skill.content || ''
}

function addParameter() {
  draft.parameters.push({ name: '', label: '', description: '' })
}

async function extractSkill() {
  if (extracting.value || !props.msg?.id) return
  extracting.value = true
  warning.value = ''
  try {
    const sourceKey = await fingerprintSource(props.sessionId, props.msg.id)
    const existingResponse = await fetch('/api/skills')
    const existingJson = await existingResponse.json()
    if (!existingResponse.ok || existingJson?.success === false) throw new Error(existingJson?.error || '无法检查已有技能')
    const existingSkills = existingJson?.data?.skills || []
    const legacyId = `workflow-${sourceKey.slice(0, 12)}`
    const existingSource = existingSkills.find(skill => skill.sourceKey === sourceKey || skill.id === legacyId)
    if (existingSource) {
      toast('warning', `这条回复已经提炼为「${existingSource.name}」，标签：${(existingSource.tags || ['对话提炼']).join('、')}`)
      return
    }

    const messagesResponse = await fetch(`/api/sessions/${encodeURIComponent(props.sessionId)}/messages?limitRounds=100`)
    const messagesJson = await messagesResponse.json()
    const messages = messagesJson?.data?.messages || []
    if (!messagesResponse.ok || !messages.length) throw new Error(messagesJson?.error || '无法读取这轮对话')

    const response = await fetch('/api/plugins/recipes/extract-skill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: props.sessionId, sourceMessageId: props.msg.id, messages })
    })
    const json = await response.json()
    if (!response.ok || !json?.success) throw new Error(json?.error || '提炼 Skill 失败')
    if (!json.data?.skill) throw new Error('服务端没有返回 Skill 草稿')
    setDraft(json.data.skill)
    warning.value = json.data.warning || ''
    editorOpen.value = true
  } catch (error) {
    toast('error', error.message || '提炼 Skill 失败')
  } finally {
    extracting.value = false
  }
}

function buildParameters() {
  const result = {}
  for (const parameter of draft.parameters) {
    const name = String(parameter.name || '').trim().replace(/[^\w\u4e00-\u9fa5-]/g, '')
    if (!name) continue
    result[name] = {
      label: String(parameter.label || name).trim(),
      description: String(parameter.description || '').trim()
    }
  }
  return result
}

async function fingerprintSource(sessionId, messageId) {
  const source = new TextEncoder().encode(`${sessionId}:${messageId}`)
  const digest = await window.crypto.subtle.digest('SHA-256', source)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function saveSkill() {
  const id = draft.id.trim()
  const name = draft.name.replace(/[\r\n]+/g, ' ').trim()
  const description = draft.description.replace(/[\r\n]+/g, ' ').trim()
  const content = draft.content.trim()
  if (!draft.sourceKey) {
    toast('error', '缺少来源指纹，请重新提炼这条回复')
    return
  }
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id)) {
    toast('warning', 'Skill ID 必须以英文字母开头，且只能包含字母、数字、下划线和连字符')
    return
  }
  if (!name || !content) {
    toast('warning', '请填写 Skill 名称和正文')
    return
  }

  saving.value = true
  try {
    const existingResponse = await fetch('/api/skills')
    const existingJson = await existingResponse.json()
    if (!existingResponse.ok || existingJson?.success === false) throw new Error(existingJson?.error || '无法检查已有技能')
    const existingSkills = existingJson?.data?.skills || []
    if (existingSkills.some(skill => skill.sourceKey === draft.sourceKey)) {
      toast('warning', '这条对话来源已经保存过，不能重复创建。请在技能管理中查看或删除已有技能。')
      return
    }
    if (existingSkills.some(skill => skill.id === id)) {
      toast('warning', `Skill ID「${id}」已存在，未覆盖任何技能。请修改 ID 后重试。`)
      return
    }

    const response = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        name,
        description,
        type: 'markdown',
        content,
        parameters: buildParameters(),
        tags: extractionTags,
        source: 'conversation-extraction',
        sourceKey: draft.sourceKey
      })
    })
    const json = await response.json()
    if (!response.ok || !json?.success) throw new Error(json?.error || '保存到技能库失败')
    editorOpen.value = false
    toast('success', `已创建 Skill「${name}」，已标记「对话提炼」「任务配方」`)
  } catch (error) {
    toast('error', error.message || '保存到技能库失败')
  } finally {
    saving.value = false
  }
}
</script>

<style scoped>
.skill-draft-modal { width: min(760px, calc(100vw - 32px)); max-height: calc(100vh - 48px); }
.skill-draft-form { display: grid; gap: 15px; max-height: calc(100vh - 220px); overflow: auto; padding: 2px 2px 8px; }
.skill-hint, .skill-warning { margin: 0; color: var(--text-secondary); font-size: 12px; line-height: 1.6; }
.skill-hint code { color: var(--text-primary); }
.skill-warning { padding: 9px 11px; border-radius: 7px; background: var(--bg-tertiary); color: var(--warning-color, #b7791f); }
.form-field { display: grid; gap: 7px; color: var(--text-secondary); font-size: 12px; }
.form-field small { color: var(--text-muted); line-height: 1.5; }
.form-section { display: grid; gap: 10px; }
.section-heading { display: flex; align-items: center; justify-content: space-between; color: var(--text-primary); font-size: 13px; }
.form-empty { color: var(--text-muted); font-size: 12px; }
.parameter-row { display: grid; grid-template-columns: 1fr 1fr 1.5fr 26px; gap: 7px; align-items: center; }
.modal-actions { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 620px) {
  .parameter-row { grid-template-columns: 1fr 1fr 26px; }
  .parameter-row > :nth-child(3) { grid-column: 1 / 3; grid-row: 2; }
  .parameter-row > :nth-child(4) { grid-column: 3; grid-row: 1; }
}
</style>
