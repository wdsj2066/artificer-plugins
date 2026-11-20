export function createRecipeUiState({ Vue, window, toast }) {
  const state = Vue.reactive({
    extracting: false,
    saving: false,
    editorOpen: false,
    warning: '',
    draft: { id: '', sourceKey: '', name: '', description: '', parameters: [], content: '' }
  })

  function setDraft(skill) {
    Object.assign(state.draft, {
      id: skill.id || '',
      sourceKey: skill.sourceKey || '',
      name: skill.name || '',
      description: skill.description || '',
      parameters: (skill.parameters || []).map(parameter => ({
        name: parameter.name || '',
        label: parameter.label || parameter.name || '',
        description: parameter.description || ''
      })),
      content: skill.content || ''
    })
  }

  function addParameter() {
    state.draft.parameters.push({ name: '', label: '', description: '' })
  }

  function buildParameters() {
    const parameters = {}
    for (const parameter of state.draft.parameters) {
      const name = String(parameter.name || '').trim().replace(/[^\w\u4e00-\u9fa5-]/g, '')
      if (!name) continue
      parameters[name] = {
        label: String(parameter.label || name).trim(),
        description: String(parameter.description || '').trim()
      }
    }
    return parameters
  }

  async function fingerprintSource(sessionId, messageId) {
    const source = new TextEncoder().encode(`${sessionId}:${messageId}`)
    const digest = await window.crypto.subtle.digest('SHA-256', source)
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
  }

  async function extractSkill(sessionId, msg) {
    if (state.extracting || !sessionId || !msg?.id) return
    state.extracting = true
    state.warning = ''
    try {
      const sourceKey = await fingerprintSource(sessionId, msg.id)
      const existingResponse = await window.fetch('/api/skills')
      const existingJson = await existingResponse.json()
      if (!existingResponse.ok || existingJson?.success === false) throw new Error(existingJson?.error || '无法检查已有技能')
      const existingSkills = existingJson?.data?.skills || []
      const legacyId = `workflow-${sourceKey.slice(0, 12)}`
      const existingSource = existingSkills.find(skill => skill.sourceKey === sourceKey || skill.id === legacyId)
      if (existingSource) {
        toast('warning', `这条回复已经提炼为「${existingSource.name}」，标签：${(existingSource.tags || ['对话提炼']).join('、')}`)
        return
      }

      const messagesResponse = await window.fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages?limitRounds=100`)
      const messagesJson = await messagesResponse.json()
      const messages = messagesJson?.data?.messages || []
      if (!messagesResponse.ok || !messages.length) throw new Error(messagesJson?.error || '无法读取这轮对话')

      const response = await window.fetch('/api/plugins/recipes/extract-skill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, sourceMessageId: msg.id, messages })
      })
      const json = await response.json()
      if (!response.ok || !json?.success) throw new Error(json?.error || '提炼 Skill 失败')
      if (!json.data?.skill) throw new Error('服务端没有返回 Skill 草稿')
      setDraft(json.data.skill)
      state.warning = json.data.warning || ''
      state.editorOpen = true
    } catch (error) {
      toast('error', error.message || '提炼 Skill 失败')
    } finally {
      state.extracting = false
    }
  }

  async function saveSkill() {
    const id = state.draft.id.trim()
    const name = state.draft.name.replace(/[\r\n]+/g, ' ').trim()
    const description = state.draft.description.replace(/[\r\n]+/g, ' ').trim()
    const content = state.draft.content.trim()
    if (!state.draft.sourceKey) {
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

    state.saving = true
    try {
      const existingResponse = await window.fetch('/api/skills')
      const existingJson = await existingResponse.json()
      if (!existingResponse.ok || existingJson?.success === false) throw new Error(existingJson?.error || '无法检查已有技能')
      const existingSkills = existingJson?.data?.skills || []
      if (existingSkills.some(skill => skill.sourceKey === state.draft.sourceKey)) {
        toast('warning', '这条对话来源已经保存过，不能重复创建。请在技能管理中查看或删除已有技能。')
        return
      }
      if (existingSkills.some(skill => skill.id === id)) {
        toast('warning', `Skill ID「${id}」已存在，未覆盖任何技能。请修改 ID 后重试。`)
        return
      }

      const response = await window.fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          name,
          description,
          type: 'markdown',
          content,
          parameters: buildParameters(),
          tags: ['对话提炼', '任务配方'],
          source: 'conversation-extraction',
          sourceKey: state.draft.sourceKey
        })
      })
      const json = await response.json()
      if (!response.ok || !json?.success) throw new Error(json?.error || '保存到技能库失败')
      state.editorOpen = false
      toast('success', `已创建 Skill「${name}」，已标记「对话提炼」「任务配方」`)
    } catch (error) {
      toast('error', error.message || '保存到技能库失败')
    } finally {
      state.saving = false
    }
  }

  return { state, extractSkill, addParameter, saveSkill }
}
