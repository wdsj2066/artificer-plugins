import { createHash } from 'node:crypto'

function clip(value, max = 8000) {
  return String(value ?? '').slice(0, max)
}

function redactSecrets(value) {
  return String(value ?? '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AIza[A-Za-z0-9_-]{24,})\b/g, '[已隐藏]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret)\s*[:=]\s*["']?)[^\s"',;}]{6,}/gi, '$1[已隐藏]')
}

function contentOf(message) {
  if (typeof message?.content === 'string') return message.content
  if (message?.content == null) return ''
  try { return JSON.stringify(message.content) } catch { return String(message.content) }
}

function formatTranscript(messages) {
  return messages.slice(-36).map(message => {
    const role = clip(message?.role || 'unknown', 24)
    const toolName = message?.toolName || message?.name || message?.tool_call?.function?.name
    const parts = []
    if (toolName) parts.push(`工具: ${clip(toolName, 100)}`)
    const args = message?.args || message?.arguments || message?.tool_call?.function?.arguments
    if (args != null) parts.push(`参数: ${typeof args === 'string' ? args : JSON.stringify(args)}`)
    const metadata = message?.metadata
    if (metadata && typeof metadata === 'object') {
      const toolMetadata = Object.fromEntries(Object.entries(metadata).filter(([key]) =>
        /tool|call|argument|\bargs\b|result|error/i.test(key)
      ))
      if (Object.keys(toolMetadata).length) parts.push(`工具信息: ${JSON.stringify(toolMetadata).slice(0, 1200)}`)
    }
    const content = contentOf(message)
    if (content) parts.push(content)
    return `[${role}] ${redactSecrets(parts.join('\n')).slice(0, 1800)}`
  }).join('\n\n').slice(-28000)
}

function parseModelJson(content) {
  const text = String(content || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('模型没有返回有效的 Skill 内容')
  return JSON.parse(text.slice(start, end + 1))
}

function sourceKeyFor(sessionId, messageId) {
  return createHash('sha256').update(`${sessionId}:${messageId}`).digest('hex')
}

function skillId(sessionId, messageId) {
  return `workflow-${sourceKeyFor(sessionId, messageId).slice(0, 12)}`
}

function normalizeParameters(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  return value.slice(0, 12).map(item => {
    const name = clip(item?.name, 48).trim().replace(/[^\w\u4e00-\u9fa5-]/g, '')
    if (!name || seen.has(name)) return null
    seen.add(name)
    return {
      name,
      label: redactSecrets(clip(item?.label || name, 80)).replace(/[\r\n]+/g, ' ').trim(),
      description: redactSecrets(clip(item?.description, 300)).replace(/[\r\n]+/g, ' ').trim(),
      defaultValue: redactSecrets(clip(item?.defaultValue, 300))
    }
  }).filter(Boolean)
}

function fallbackSkill(messages, sessionId, sourceMessageId) {
  const requestText = redactSecrets(clip(contentOf([...messages].reverse().find(message => message?.role === 'user')), 4000)).trim()
  const toolNames = [...new Set(messages
    .filter(message => message?.role === 'tool')
    .map(message => message?.toolName || message?.name || message?.tool_call?.function?.name || message?.metadata?.toolName || message?.metadata?.tool_name)
    .filter(Boolean))]
  const steps = (toolNames.length ? toolNames : ['了解目标和工作区现状', '按目标完成工作', '检查结果并总结']).slice(0, 12)
  const body = [
    '## 目标',
    requestText || '根据用户提供的具体目标完成一项可复用任务。',
    '',
    '## 参数',
    '运行前确认用户提供了完成任务所需的项目、文件或目标信息；缺少关键信息时先询问。',
    '',
    '## 工作步骤',
    ...steps.map((step, index) => `${index + 1}. ${toolNames.length ? `参考对话中 ${step} 的用法` : step}`),
    '',
    '## 安全与确认',
    '- 先说明计划和预期影响，再进行文件修改、删除、覆盖、发布或外部发送。',
    '- 使用工具前检查目标路径和输入；不复用对话中的密钥、个人信息或绝对路径。',
    '- 完成后核对结果，并向用户总结改动和未完成事项。'
  ].join('\n')
  const seed = skillId(sessionId, sourceMessageId)
  return {
    id: seed,
    sourceKey: sourceKeyFor(sessionId, sourceMessageId),
    name: clip(requestText.split(/\r?\n/)[0] || '可复用工作流程', 80).replace(/[\r\n]+/g, ' '),
    description: '从已完成的对话整理而来，请检查并补充适用条件与完成标准。',
    parameters: [],
    content: body
  }
}

function normalizeSkill(value, fallback) {
  const parameters = normalizeParameters(value?.parameters)
  const content = redactSecrets(clip(value?.content, 18000))
    .replace(/^---[\s\S]*?---\s*/, '')
    .trim()
  return {
    id: fallback.id,
    sourceKey: fallback.sourceKey,
    name: redactSecrets(clip(value?.name || fallback.name, 80)).replace(/[\r\n]+/g, ' ').trim() || fallback.name,
    description: redactSecrets(clip(value?.description || fallback.description, 300)).replace(/[\r\n]+/g, ' ').trim(),
    parameters,
    content: content || fallback.content
  }
}

export function register(ctx) {
  ctx.registerRoute({
    method: 'POST',
    path: '/api/plugins/recipes/extract-skill',
    async handler({ body }) {
      const incoming = Array.isArray(body?.messages) ? body.messages.slice(-500) : []
      const sessionId = clip(body?.sessionId, 160)
      const sourceMessageId = clip(body?.sourceMessageId, 160)
      if (!sessionId || !sourceMessageId || !incoming.length) return { success: false, error: '缺少来源会话或对话内容' }

      const sourceIndex = incoming.findIndex(message => message?.id === sourceMessageId)
      if (sourceIndex < 0 || incoming[sourceIndex]?.role !== 'assistant') {
        return { success: false, error: '没有找到所选的助手回复，请刷新会话后重试' }
      }
      const selectedRound = incoming.slice(0, sourceIndex + 1)
      let userIndex = -1
      for (let index = selectedRound.length - 1; index >= 0; index--) {
        if (selectedRound[index]?.role === 'user') { userIndex = index; break }
      }
      const messages = selectedRound.slice(userIndex >= 0 ? userIndex : Math.max(0, selectedRound.length - 36))
      const fallback = fallbackSkill(messages, sessionId, sourceMessageId)
      let skill = fallback
      let warning = ''

      try {
        const result = await ctx.modelRequestService.complete({
          purpose: 'conversation_to_skill',
          temperature: 0.2,
          maxTokens: 2600,
          tools: [],
          messages: [
            {
              role: 'system',
              content: '你负责把一段已经完成的 AI 工作对话提炼成 Artificer 原生 Markdown Context Skill。只返回 JSON，不要 Markdown 代码围栏。结构：{"name":"简短技能名","description":"一行目录说明","parameters":[{"name":"变量名","label":"显示名称","description":"填写说明","defaultValue":"可选默认值"}],"content":"Markdown 正文"}。正文必须包含适用场景、需要用户提供的参数、可复用工作步骤、确认条件、安全约束和完成标准。将项目名、文件路径、日期、数量等一次性值提炼为 {{参数名}} 占位符，并在参数数组中定义；不要保存 API Key、密码、令牌、个人信息、绝对路径或只对原会话有效的细节。说明 AI 应先检查上下文，不确定或缺输入时先询问；修改文件、删除、覆盖、发布、外部发送等有影响的操作须先告知用户并等待确认。Skill 仅提供知识与操作指引，不假设工具自动授权。内容要独立于来源会话，最多 12 个参数，步骤具体但可复用。'
            },
            { role: 'user', content: `请从这轮已经完成的工作中提炼 Skill：\n\n${formatTranscript(messages)}` }
          ]
        })
        skill = normalizeSkill(parseModelJson(result?.content), fallback)
      } catch (error) {
        warning = `AI 提炼未完成，已生成可编辑的 Skill 草稿：${clip(error.message, 180)}`
        ctx.logger.warn(`Skill extraction fell back: ${error.message}`)
      }

      return { success: true, data: { skill, warning } }
    }
  })

  ctx.logger.info('Conversation-to-Skill plugin registered')
}
