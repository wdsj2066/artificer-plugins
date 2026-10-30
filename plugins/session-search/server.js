// 会话全文搜索：读取本地会话数据库，为历史对话建立 FTS5 索引，支持跨会话关键词检索。
// 索引保存在插件数据目录，不修改任何宿主会话文件。

import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PLUGIN_ID = 'session-search'
const MESSAGE_MAX_CHARS = 4000
const SNIPPET_RADIUS = 48
const DEFAULTS = { includeToolResults: false, maxResults: 30, autoIndex: true }

// 路径每次调用时解析，便于测试注入临时目录。
function paths() {
  const appData = process.env.APPDATA || process.env.HOME || process.cwd()
  const dataDir = join(appData, 'Artificer', 'plugin-data', PLUGIN_ID)
  return {
    dataDir,
    sessionsDir: join(appData, 'Artificer', 'sessions'),
    indexPath: join(dataDir, 'index.db')
  }
}

const state = {
  sqlite: null,
  ready: false,
  indexing: false,
  progress: { done: 0, total: 0 },
  totalDocs: 0,
  sessionCount: 0,
  lastIndexedAt: 0,
  lastError: null
}

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function readSettings(ctx) {
  let saved = {}
  try { saved = ctx.getSettings?.() || {} } catch { saved = {} }
  return {
    includeToolResults: saved.includeToolResults === undefined ? DEFAULTS.includeToolResults : Boolean(saved.includeToolResults),
    maxResults: clampInt(saved.maxResults, DEFAULTS.maxResults, 10, 100),
    autoIndex: saved.autoIndex === undefined ? DEFAULTS.autoIndex : Boolean(saved.autoIndex)
  }
}

async function loadSqlite(ctx) {
  if (state.sqlite) return state.sqlite
  try {
    state.sqlite = await import('node:sqlite')
  } catch (error) {
    throw new Error(`当前运行环境不支持 node:sqlite：${error?.message || error}`)
  }
  return state.sqlite
}

function openIndexDb(sqlite, indexPath) {
  mkdirSync(join(indexPath, '..'), { recursive: true })
  const db = new sqlite.DatabaseSync(indexPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(`CREATE TABLE IF NOT EXISTS sessions_index (
    session_id TEXT PRIMARY KEY,
    title TEXT,
    msg_count INTEGER DEFAULT 0,
    last_ts INTEGER DEFAULT 0,
    mtime REAL DEFAULT 0,
    size INTEGER DEFAULT 0,
    indexed_at INTEGER DEFAULT 0
  )`)
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS msgs USING fts5(
    text,
    session_id UNINDEXED,
    msg_id UNINDEXED,
    role UNINDEXED,
    sem UNINDEXED,
    ts UNINDEXED,
    tokenize = 'trigram'
  )`)
  return db
}

function sessionFiles(sessionsDir) {
  try {
    return readdirSync(sessionsDir).filter((name) => name.endsWith('.db')).sort()
  } catch {
    return []
  }
}

function readSessionMessages(filePath, includeToolResults) {
  const sqlite = state.sqlite
  const source = new sqlite.DatabaseSync(filePath, { readOnly: true, timeout: 3000 })
  try {
    const wanted = includeToolResults
      ? "role = 'user' or sem in ('ai_response', 'execution_result')"
      : "role = 'user' or sem = 'ai_response'"
    return source.prepare(`
      SELECT id, role, semantic_type AS sem, content, timestamp
      FROM messages
      WHERE content IS NOT NULL AND length(trim(content)) > 0
        AND (${wanted})
      ORDER BY sequence
    `).all()
  } finally {
    try { source.close() } catch { /* 忽略关闭失败 */ }
  }
}

function deriveTitle(rows, sessionId) {
  const first = rows.find((row) => row.role === 'user' && row.content)
  const text = first ? String(first.content).replace(/\s+/g, ' ').trim() : ''
  if (!text) return sessionId.slice(0, 24)
  return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

function indexSession(db, sessionId, filePath, fileStat, settings) {
  const rows = readSessionMessages(filePath, settings.includeToolResults)
  const now = Date.now()
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM msgs WHERE session_id = ?').run(sessionId)
    const insert = db.prepare('INSERT INTO msgs (text, session_id, msg_id, role, sem, ts) VALUES (?, ?, ?, ?, ?, ?)')
    let lastTs = 0
    for (const row of rows) {
      const text = String(row.content || '').slice(0, MESSAGE_MAX_CHARS)
      if (!text) continue
      insert.run(text, sessionId, row.id, row.role || '', row.sem || '', Number(row.timestamp) || 0)
      lastTs = Math.max(lastTs, Number(row.timestamp) || 0)
    }
    db.prepare(`
      INSERT INTO sessions_index (session_id, title, msg_count, last_ts, mtime, size, indexed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        title = excluded.title, msg_count = excluded.msg_count, last_ts = excluded.last_ts,
        mtime = excluded.mtime, size = excluded.size, indexed_at = excluded.indexed_at
    `).run(sessionId, deriveTitle(rows, sessionId), rows.length, lastTs, fileStat.mtimeMs, fileStat.size, now)
    db.exec('COMMIT')
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* 忽略回滚失败 */ }
    throw error
  }
}

async function rebuildIndex(ctx, options = {}) {
  const force = Boolean(options.force)
  if (state.indexing) return { skipped: true }
  state.indexing = true
  state.lastError = null
  const { indexPath, sessionsDir } = paths()
  try {
    const sqlite = await loadSqlite(ctx)
    const db = openIndexDb(sqlite, indexPath)
    const settings = readSettings(ctx)
    const files = sessionFiles(sessionsDir)
    const known = new Map(db.prepare('SELECT session_id, mtime, size FROM sessions_index').all().map((row) => [row.session_id, row]))
    state.progress = { done: 0, total: files.length }
    const alive = new Set()
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i]
      const sessionId = file.slice(0, -3)
      alive.add(sessionId)
      const filePath = join(sessionsDir, file)
      let fileStat
      try { fileStat = statSync(filePath) } catch { state.progress.done += 1; continue }
      const prev = known.get(sessionId)
      const unchanged = prev && Math.abs(prev.mtime - fileStat.mtimeMs) < 1 && prev.size === fileStat.size
      if (unchanged && !force) {
        state.progress.done += 1
        continue
      }
      try {
        indexSession(db, sessionId, filePath, fileStat, settings)
      } catch (error) {
        ctx.logger?.warn?.(`[${PLUGIN_ID}] 索引会话失败 ${sessionId}: ${error?.message || error}`)
      }
      state.progress.done += 1
      if (i % 12 === 11) await new Promise((resolve) => setImmediate(resolve))
    }
    for (const sessionId of known.keys()) {
      if (alive.has(sessionId)) continue
      db.prepare('DELETE FROM msgs WHERE session_id = ?').run(sessionId)
      db.prepare('DELETE FROM sessions_index WHERE session_id = ?').run(sessionId)
    }
    state.totalDocs = db.prepare('SELECT count(*) AS c FROM msgs').get().c
    state.sessionCount = db.prepare('SELECT count(*) AS c FROM sessions_index').get().c
    state.lastIndexedAt = Date.now()
    state.ready = true
    db.close()
    return { indexed: state.totalDocs, sessions: state.sessionCount, at: state.lastIndexedAt }
  } catch (error) {
    state.lastError = error?.message || String(error)
    ctx.logger?.warn?.(`[${PLUGIN_ID}] 建立索引失败: ${state.lastError}`)
    return { error: state.lastError }
  } finally {
    state.indexing = false
  }
}

// 索引库每次按需打开、用完即关，避免长时间持有文件句柄。
function openSearchDb(ctx) {
  if (!state.sqlite) return null
  try {
    return openIndexDb(state.sqlite, paths().indexPath)
  } catch (error) {
    ctx.logger?.warn?.(`[${PLUGIN_ID}] 打开索引失败: ${error?.message || error}`)
    return null
  }
}

function closeQuietly(db) {
  try { db?.close() } catch { /* 忽略关闭失败 */ }
}

function queryTerms(raw) {
  return String(raw || '')
    .trim()
    .slice(0, 200)
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 8)
}

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// 片段只做纯文本高亮，先转义再插入 mark，避免会话内容注入 HTML。
function buildSnippet(text, terms) {
  const source = String(text || '').replace(/\s+/g, ' ')
  const lower = source.toLowerCase()
  let anchor = -1
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase())
    if (index >= 0 && (anchor < 0 || index < anchor)) anchor = index
  }
  if (anchor < 0) anchor = 0
  const start = Math.max(0, anchor - SNIPPET_RADIUS)
  const end = Math.min(source.length, anchor + SNIPPET_RADIUS * 2)
  const piece = source.slice(start, end)
  const ranges = []
  const lowerPiece = piece.toLowerCase()
  for (const term of terms) {
    const needle = term.toLowerCase()
    if (!needle) continue
    let from = 0
    while (from <= lowerPiece.length) {
      const index = lowerPiece.indexOf(needle, from)
      if (index < 0) break
      ranges.push([index, index + needle.length])
      from = index + needle.length
    }
  }
  ranges.sort((a, b) => a[0] - b[0])
  let cursor = 0
  let html = ''
  for (const [from, to] of ranges) {
    if (from < cursor) continue
    html += escapeHtml(piece.slice(cursor, from))
    html += `<mark>${escapeHtml(piece.slice(from, to))}</mark>`
    cursor = to
  }
  html += escapeHtml(piece.slice(cursor))
  return `${start > 0 ? '…' : ''}${html}${end < source.length ? '…' : ''}`
}

function ftsQuery(terms) {
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(' AND ')
}

function runSearch(ctx, rawQuery, options = {}) {
  const terms = queryTerms(rawQuery)
  if (!terms.length) return { terms, results: [], total: 0, mode: 'empty' }
  const db = openSearchDb(ctx)
  if (!db) return { terms, results: [], total: 0, mode: 'unavailable', error: state.lastError || '索引尚未就绪' }
  try {
    const limit = clampInt(options.limit, readSettings(ctx).maxResults, 1, 100)
    const sessionId = options.sessionId ? String(options.sessionId) : ''
    const role = options.role === 'user' || options.role === 'assistant' ? options.role : ''
    // trigram 分词要求每个词至少三个字符，短词退回子串匹配。
    const useFts = terms.every((term) => [...term].length >= 3)
    const filters = []
    const params = []
    if (sessionId) { filters.push('session_id = ?'); params.push(sessionId) }
    if (role) { filters.push('role = ?'); params.push(role) }
    const where = filters.length ? ` AND ${filters.join(' AND ')}` : ''
    let rows = []
    if (useFts) {
      rows = db.prepare(`
        SELECT session_id, msg_id, role, sem, ts, text, bm25(msgs) AS score
        FROM msgs
        WHERE msgs MATCH ?${where}
        ORDER BY score
        LIMIT ?
      `).all(ftsQuery(terms), ...params, limit)
    } else {
      const likes = terms.map(() => 'text LIKE ?').join(' AND ')
      rows = db.prepare(`
        SELECT session_id, msg_id, role, sem, ts, text, 0 AS score
        FROM msgs
        WHERE ${likes}${where}
        ORDER BY ts DESC
        LIMIT ?
      `).all(...terms.map((term) => `%${term}%`), ...params, limit)
    }
    const sessionIds = [...new Set(rows.map((row) => row.session_id))]
    const sessions = new Map(
      db.prepare(`SELECT session_id, title, last_ts FROM sessions_index WHERE session_id IN (${sessionIds.map(() => '?').join(',') || "''"})`)
        .all(...sessionIds)
        .map((row) => [row.session_id, row])
    )
    return {
      terms,
      mode: useFts ? 'fts' : 'like',
      total: rows.length,
      results: rows.map((row) => {
        const meta = sessions.get(row.session_id) || {}
        return {
          sessionId: row.session_id,
          sessionTitle: meta.title || row.session_id.slice(0, 24),
          msgId: row.msg_id,
          role: row.role,
          semanticType: row.sem,
          timestamp: Number(row.ts) || 0,
          snippet: buildSnippet(row.text, terms)
        }
      })
    }
  } finally {
    closeQuietly(db)
  }
}

function statusPayload() {
  return {
    ready: state.ready,
    indexing: state.indexing,
    progress: state.progress,
    totalDocs: state.totalDocs,
    sessionCount: state.sessionCount,
    lastIndexedAt: state.lastIndexedAt,
    lastError: state.lastError,
    indexPath: paths().indexPath
  }
}

export function register(ctx) {
  const base = `/api/plugins/${PLUGIN_ID}`

  // 重新注册（重载或换目录）时丢弃旧的索引状态，改为按需增量重建。
  state.ready = false
  state.totalDocs = 0
  state.sessionCount = 0
  state.lastIndexedAt = 0
  state.progress = { done: 0, total: 0 }
  state.lastError = null

  ctx.registerRoute({
    method: 'GET',
    path: `${base}/status`,
    handler: () => ({ success: true, data: statusPayload() })
  })

  ctx.registerRoute({
    method: 'GET',
    path: `${base}/search`,
    async handler({ query }) {
      const q = query?.q || query?.query || ''
      if (!state.ready && !state.indexing) await rebuildIndex(ctx, { force: false })
      const payload = runSearch(ctx, q, {
        limit: query?.limit,
        sessionId: query?.sessionId,
        role: query?.role
      })
      return { success: !payload.error, data: { ...payload, status: statusPayload() }, error: payload.error }
    }
  })

  ctx.registerRoute({
    method: 'GET',
    path: `${base}/recent`,
    handler({ query }) {
      const db = openSearchDb(ctx)
      if (!db) return { success: false, error: state.lastError || '索引尚未就绪' }
      try {
        const limit = clampInt(query?.limit, 20, 1, 100)
        const rows = db.prepare(`
          SELECT session_id, title, msg_count, last_ts FROM sessions_index
          ORDER BY last_ts DESC LIMIT ?
        `).all(limit)
        return {
          success: true,
          data: rows.map((row) => ({
            sessionId: row.session_id,
            sessionTitle: row.title || row.session_id.slice(0, 24),
            messageCount: row.msg_count,
            lastTs: row.last_ts
          }))
        }
      } finally {
        closeQuietly(db)
      }
    }
  })

  ctx.registerRoute({
    method: 'POST',
    path: `${base}/reindex`,
    async handler() {
      const result = await rebuildIndex(ctx, { force: true })
      return { success: !result.error, data: { ...result, status: statusPayload() } }
    }
  })

  ctx.registerTool({
    id: 'searchConversations',
    name: '搜索历史会话',
    description: '在本地全部历史会话中按关键词检索消息，返回命中的会话、角色、时间与片段。用于回忆之前讨论过的方案、代码或结论。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索关键词，多个词用空格分隔，按全部命中过滤' },
        limit: { type: 'number', description: '返回条数上限，默认 8，最大 20' },
        sessionId: { type: 'string', description: '只检索指定会话 ID，可省略' }
      },
      required: ['query']
    },
    security: { kind: 'safe' },
    tags: ['search', 'readonly'],
    async handler(args) {
      const query = String(args?.query || '').trim()
      if (!query) return { success: false, error: 'query 不能为空' }
      if (!state.ready && !state.indexing) await rebuildIndex(ctx, { force: false })
      const payload = runSearch(ctx, query, {
        limit: clampInt(args?.limit, 8, 1, 20),
        sessionId: args?.sessionId
      })
      if (payload.error) return { success: false, error: payload.error }
      return {
        success: true,
        data: {
          query,
          mode: payload.mode,
          count: payload.total,
          indexing: state.indexing,
          results: payload.results.map((item) => ({
            sessionId: item.sessionId,
            sessionTitle: item.sessionTitle,
            role: item.role,
            semanticType: item.semanticType,
            timestamp: item.timestamp,
            snippet: item.snippet.replace(/<\/?mark>/g, '')
          }))
        }
      }
    }
  })

  const settings = readSettings(ctx)
  if (settings.autoIndex) {
    const timer = setTimeout(() => { rebuildIndex(ctx, { force: false }) }, 1500)
    timer.unref?.()
    ctx.disposeWithPlugin?.(() => clearTimeout(timer))
  }

  return () => {
    state.ready = false
  }
}
