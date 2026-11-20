// Codex 会话导入：解析本地 Codex 会话，写入工作区 Markdown，并在目标工作区创建可续聊的会话。
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

const MAX_FILE_BYTES = 40 * 1024 * 1024
const PREVIEW_CHARS = 8000
const CHAT_MAX_CHARS = 200000
const DEFAULTS = { codexHome: '', includeOriginal: false, maxSessions: 200 }

function settingsOf(ctx) {
  const raw = ctx.getSettings && ctx.getSettings()
  const merged = { ...DEFAULTS, ...(raw || {}) }
  const max = Number(merged.maxSessions)
  merged.maxSessions = Number.isFinite(max) ? Math.min(500, Math.max(50, max)) : DEFAULTS.maxSessions
  merged.includeOriginal = merged.includeOriginal === true || merged.includeOriginal === 'true'
  return merged
}

function expandHome(value) {
  if (!value) return ''
  const text = String(value).trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

function resolveRoots(settings) {
  const base = expandHome(settings.codexHome) || expandHome(process.env.CODEX_HOME || '') || join(homedir(), '.codex')
  const sessions = join(base, 'sessions')
  const root = existsSync(sessions) ? sessions : base
  return { home: base, root }
}

function listJsonl(dir, depth = 0, out = []) {
  if (depth > 8) return out
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listJsonl(full, depth + 1, out)
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) out.push(full)
  }
  return out
}

function readText(file, limitBytes = MAX_FILE_BYTES) {
  try {
    const size = statSync(file).size
    if (size > limitBytes) return null
    return readFileSync(file, 'utf8')
  } catch { return null }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const item of content) {
    if (typeof item === 'string') { parts.push(item); continue }
    if (!item || typeof item !== 'object') continue
    const kind = String(item.type || '')
    if (kind === 'input_text' || kind === 'output_text' || kind === 'text' || kind === 'summary_text') {
      if (typeof item.text === 'string') parts.push(item.text)
    }
  }
  return parts.join('\n')
}

function cleanUserText(text) {
  return String(text || '')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<user_instructions>[\s\S]*?<\/user_instructions>/gi, '')
    .replace(/<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/gi, '')
    .replace(/#\s*AGENTS\.md instructions for[^\n]*\n?/gi, '')
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/gi, '')
    .trim()
}

function parseSession(text, relPath) {
  const meta = { cwd: '', sessionId: '', model: '', cliVersion: '', originator: '', startedAt: '' }
  const messages = []
  const stats = { records: 0, toolCalls: 0, skipped: 0, injected: 0, types: {} }

  function push(role, content, timestamp) {
    let value = String(content || '').trim()
    if (role === 'user') {
      const cleaned = cleanUserText(value)
      if (!cleaned && value) { stats.injected += 1; return }
      value = cleaned
    }
    if (!value) { stats.skipped += 1; return }
    if (role !== 'user' && role !== 'assistant') { stats.skipped += 1; return }
    const last = messages[messages.length - 1]
    const prev = messages[messages.length - 2]
    if (last && last.role === role && last.text === value) { stats.skipped += 1; return }
    if (prev && prev.role === role && prev.text === value) { stats.skipped += 1; return }
    messages.push({ role, text: value, time: String(timestamp || '') })
  }

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    let record
    try { record = JSON.parse(line) } catch { continue }
    stats.records += 1
    const timestamp = record.timestamp || record.ts || ''
    const type = String(record.type || '')
    const payload = record.payload && typeof record.payload === 'object' ? record.payload : {}
    const typeKey = type + (payload.type ? ':' + payload.type : '')
    stats.types[typeKey] = (stats.types[typeKey] || 0) + 1

    if (type === 'session_meta' || type === 'session') {
      meta.cwd = payload.cwd || meta.cwd
      meta.sessionId = payload.session_id || payload.id || meta.sessionId
      meta.cliVersion = payload.cli_version || meta.cliVersion
      meta.originator = payload.originator || meta.originator
      meta.startedAt = payload.timestamp || timestamp || meta.startedAt
      continue
    }
    if (type === 'turn_context') {
      meta.model = payload.model || payload.model_name || meta.model
      continue
    }
    if (type === 'response_item') {
      const kind = String(payload.type || '')
      if (kind === 'message') { push(payload.role, textOf(payload.content), timestamp); continue }
      if (kind === 'function_call' || kind === 'custom_tool_call' || kind === 'local_shell_call' || kind === 'web_search_call') {
        stats.toolCalls += 1
        continue
      }
      stats.skipped += 1
      continue
    }
    if (type === 'event_msg') {
      const kind = String(payload.type || '')
      if (kind === 'user_message') { push('user', payload.message, timestamp); continue }
      if (kind === 'agent_message') { push('assistant', payload.message, timestamp); continue }
      stats.skipped += 1
      continue
    }
    if (payload.role) { push(payload.role, textOf(payload.content) || payload.message, timestamp); continue }
    stats.skipped += 1
  }

  const firstUser = messages.find((item) => item.role === 'user')
  const lastAssistant = [...messages].reverse().find((item) => item.role === 'assistant')
  return {
    relPath, meta, messages, stats,
    summary: firstUser ? firstUser.text.replace(/\s+/g, ' ').slice(0, 160) : '',
    lastReply: lastAssistant ? lastAssistant.text.replace(/\s+/g, ' ').slice(0, 140) : ''
  }
}

function walkSessions(settings) {
  const roots = resolveRoots(settings)
  const files = listJsonl(roots.root)
  const rows = []
  for (const file of files) {
    let info
    try { info = statSync(file) } catch { continue }
    const relPath = relative(roots.root, file).split(sep).join('/')
    const text = info.size <= MAX_FILE_BYTES ? readText(file) : null
    if (!text) {
      rows.push({ relPath, size: info.size, mtime: info.mtimeMs, error: '文件过大，未解析', meta: {}, stats: {} })
      continue
    }
    const parsed = parseSession(text, relPath)
    rows.push({
      relPath, size: info.size, mtime: info.mtimeMs,
      meta: parsed.meta, stats: parsed.stats, summary: parsed.summary, lastReply: parsed.lastReply
    })
  }
  rows.sort((a, b) => (b.mtime || 0) - (a.mtime || 0))
  return { roots, rows: rows.slice(0, settings.maxSessions), total: rows.length }
}

function resolveSessionPath(settings, relPath) {
  const roots = resolveRoots(settings)
  const target = resolve(roots.root, String(relPath || ''))
  const rel = relative(roots.root, target)
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) return null
  if (!target.toLowerCase().endsWith('.jsonl')) return null
  if (!existsSync(target)) return null
  return target
}

function formatMarkdown(parsed, relPath) {
  const meta = parsed.meta
  const lines = []
  lines.push(`# Codex 会话${meta.sessionId ? ` ${meta.sessionId}` : ''}`)
  lines.push('')
  lines.push(`**摘要**：${parsed.summary || '（无用户消息）'}`)
  lines.push('')
  lines.push('> 由 Codex 会话导入插件转换，仅保留用户与助手正文。')
  lines.push('')
  lines.push('| 项 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| 来源文件 | ${relPath} |`)
  if (meta.startedAt) lines.push(`| 开始时间 | ${meta.startedAt} |`)
  if (meta.cwd) lines.push(`| 工作目录 | ${meta.cwd.replace(/\|/g, '\\|')} |`)
  if (meta.model) lines.push(`| 模型 | ${meta.model} |`)
  if (meta.cliVersion) lines.push(`| CLI 版本 | ${meta.cliVersion} |`)
  lines.push(`| 消息数 | ${parsed.messages.length} |`)
  lines.push(`| 工具调用 | ${parsed.stats.toolCalls} 次（未导出正文） |`)
  lines.push(`| 已剔除注入内容 | ${parsed.stats.injected} 条 |`)
  lines.push(`| 导出时间 | ${new Date().toISOString()} |`)
  lines.push('')
  parsed.messages.forEach((message, index) => {
    const label = message.role === 'user' ? '用户' : '助手'
    lines.push(`## ${index + 1}. ${label}${message.time ? ` · ${message.time}` : ''}`)
    lines.push('')
    lines.push(message.text)
    lines.push('')
  })
  if (!parsed.messages.length) lines.push('_该会话未解析出正文消息。_')
  return lines.join('\n')
}

function formatChatMessage(parsed, relPath) {
  const meta = parsed.meta
  const lines = []
  lines.push('以下为从 Codex CLI 导入的会话记录，请作为历史上下文阅读；后续可以在本会话继续讨论。')
  lines.push('')
  lines.push(`会话 ID：${meta.sessionId || '未知'}`)
  lines.push(`来源文件：${relPath}`)
  if (meta.startedAt) lines.push(`开始时间：${meta.startedAt}`)
  if (meta.cwd) lines.push(`工作目录：${meta.cwd}`)
  if (meta.model) lines.push(`模型：${meta.model}`)
  lines.push(`正文消息：${parsed.messages.length} 条，工具调用 ${parsed.stats.toolCalls} 次未包含。`)
  lines.push('')
  parsed.messages.forEach((message, index) => {
    lines.push(`${index + 1}. ${message.role === 'user' ? '用户' : '助手'}${message.time ? `（${message.time}）` : ''}：`)
    lines.push(message.text)
    lines.push('')
  })
  return lines.join('\n').slice(0, CHAT_MAX_CHARS)
}

function safeName(value) {
  return String(value || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 60)
}

async function importSession(ctx, settings, body) {
  const relPath = String(body.path || '')
  const target = resolveSessionPath(settings, relPath)
  if (!target) throw new Error('会话文件不存在或路径不合法')
  const text = readText(target)
  if (!text) throw new Error('会话文件无法读取或体积过大')
  const parsed = parseSession(text, relPath)

  const workspaceId = String(body.workspaceId || '')
  const workspaces = await workspacesOf(ctx)
  const workspace = workspaces.find((item) => item.id === workspaceId)
  if (!workspace) throw new Error('目标工作区不存在')
  if (!workspace.folderPath) throw new Error('公共工作区没有文件夹路径，请选择真实工作区')

  const started = parsed.meta.startedAt || ''
  const datePart = (started.match(/^\d{4}-\d{2}-\d{2}/) || [new Date().toISOString().slice(0, 10)])[0].replace(/-/g, '')
  const idPart = safeName(parsed.meta.sessionId || basename(target, '.jsonl')).slice(0, 16) || 'session'
  const baseDir = join(workspace.folderPath, 'codex-import')
  let targetDir = join(baseDir, `${datePart}-${idPart}`)
  let suffix = 2
  while (existsSync(targetDir)) targetDir = join(baseDir, `${datePart}-${idPart}-${suffix++}`)
  mkdirSync(targetDir, { recursive: true })

  const markdownPath = join(targetDir, 'conversation.md')
  writeFileSync(markdownPath, formatMarkdown(parsed, relPath), 'utf8')

  let originalPath = ''
  if (settings.includeOriginal || body.includeOriginal === true) {
    originalPath = join(targetDir, 'original.jsonl')
    copyFileSync(target, originalPath)
  }

  const title = `Codex ${idPart}${parsed.summary ? ' · ' + parsed.summary.slice(0, 30) : ''}`
  const created = await ctx.sessions.create({ workspaceId: workspace.id, title })
  const sessionId = created && (created.sessionId || created.id)
  let chatError = ''
  if (sessionId) {
    try {
      await ctx.sessions.chat({ sessionId, message: formatChatMessage(parsed, relPath) })
    } catch (error) {
      chatError = String((error && error.message) || error)
    }
  }

  const store = ctx.getStore()
  store.set(`import:${relPath}`, {
    importedAt: new Date().toISOString(),
    workspaceId: workspace.id, workspaceName: workspace.name,
    markdownPath, originalPath, messageCount: parsed.messages.length,
    summary: parsed.summary, sessionId: sessionId || '', chatError
  })

  return {
    ok: true, markdownPath, originalPath,
    messageCount: parsed.messages.length,
    toolCalls: parsed.stats.toolCalls,
    sessionId: sessionId || '', chatError,
    summary: parsed.summary,
    workspace: { id: workspace.id, name: workspace.name }
  }
}

let workspacesCache = { at: 0, value: [] }
async function workspacesOf(ctx) {
  const now = Date.now()
  if (now - workspacesCache.at < 5000 && workspacesCache.value.length) return workspacesCache.value
  const list = await ctx.workspaces.list()
  workspacesCache = {
    at: now,
    value: (list || []).map((item) => ({
      id: item.id, name: item.name, type: item.type,
      folderPath: item.folderPath || null, sessionCount: item.sessionCount || 0
    }))
  }
  return workspacesCache.value
}

function importRecords(ctx) {
  const store = ctx.getStore()
  const records = {}
  try {
    for (const key of store.list()) {
      const text = String(key)
      if (text.startsWith('import:')) records[text.slice(7)] = store.get(text)
    }
  } catch {}
  return records
}

export function register(ctx) {
  const settings = () => settingsOf(ctx)

  ctx.registerRoute({
    method: 'GET', path: '/api/plugins/codex-import/config',
    handler: async () => {
      const resolved = settings()
      const roots = resolveRoots(resolved)
      return { codexHome: resolved.codexHome, home: roots.home, root: roots.root, exists: existsSync(roots.root), settings: resolved }
    }
  })

  ctx.registerRoute({
    method: 'GET', path: '/api/plugins/codex-import/sessions',
    handler: async () => {
      const resolved = settings()
      const { roots, rows, total } = walkSessions(resolved)
      const records = importRecords(ctx)
      return {
        root: roots.root, home: roots.home, exists: existsSync(roots.root),
        total, rows: rows.map((row) => ({ ...row, imported: Boolean(records[row.relPath]) }))
      }
    }
  })

  ctx.registerRoute({
    method: 'GET', path: '/api/plugins/codex-import/session',
    handler: async ({ query }) => {
      const resolved = settings()
      const target = resolveSessionPath(resolved, query.path)
      if (!target) throw new Error('会话文件不存在或路径不合法')
      const text = readText(target)
      if (!text) throw new Error('会话文件无法读取或体积过大')
      const parsed = parseSession(text, String(query.path))
      return {
        relPath: parsed.relPath, meta: parsed.meta, stats: parsed.stats,
        messages: parsed.messages.map((message) => ({ ...message, text: message.text.slice(0, PREVIEW_CHARS) })),
        truncated: parsed.messages.some((message) => message.text.length > PREVIEW_CHARS),
        imported: Boolean(importRecords(ctx)[parsed.relPath])
      }
    }
  })

  ctx.registerRoute({
    method: 'GET', path: '/api/plugins/codex-import/workspaces',
    handler: async () => ({ workspaces: await workspacesOf(ctx) })
  })

  ctx.registerRoute({
    method: 'POST', path: '/api/plugins/codex-import/import',
    handler: async ({ body }) => importSession(ctx, settings(), body || {})
  })

  ctx.registerRoute({
    method: 'GET', path: '/api/plugins/codex-import/history',
    handler: async () => ({ records: importRecords(ctx) })
  })

  ctx.registerTool({
    id: 'codexListSessions',
    name: '列出 Codex 会话',
    description: '列出本机 Codex CLI 保存的会话，返回相对路径、时间、工作目录与首条用户消息摘要',
    security: { kind: 'safe' },
    parameters: { type: 'object', properties: { limit: { type: 'number', description: '返回条数上限，默认 20' } } },
    handler: async (args = {}) => {
      const resolved = settings()
      const { rows, total, root } = walkSessions(resolved)
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 20))
      return {
        root, total,
        sessions: rows.slice(0, limit).map((row) => ({
          path: row.relPath, time: row.meta.startedAt, cwd: row.meta.cwd,
          summary: row.summary, records: row.stats.records
        }))
      }
    }
  })

  ctx.registerTool({
    id: 'codexImportSession',
    name: '导入 Codex 会话到工作区',
    description: '把指定 Codex 会话转换为 Markdown 写入目标工作区，并在该工作区创建可续聊的会话',
    security: { kind: 'file', targetArg: 'path' },
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'codexListSessions 返回的相对路径' },
        workspaceId: { type: 'string', description: '目标工作区 id' }
      },
      required: ['path', 'workspaceId']
    },
    handler: async (args = {}) => importSession(ctx, settings(), args)
  })
}
