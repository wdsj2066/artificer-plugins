import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { register } from '../../plugins/session-search/server.js'

const manifest = JSON.parse(readFileSync(new URL('../../plugins/session-search/plugin.json', import.meta.url)))

// 构造一个与宿主会话库结构一致的最小数据库。
function createSessionDb(filePath, rows) {
  const db = new DatabaseSync(filePath)
  db.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, role TEXT NOT NULL, sequence INTEGER NOT NULL,
    turn_id TEXT, cycle_id TEXT, content TEXT, raw_content TEXT, model_content TEXT,
    semantic_type TEXT, metadata TEXT, sendToModel INTEGER DEFAULT 1,
    isStreaming INTEGER DEFAULT 0, timestamp INTEGER NOT NULL
  )`)
  const insert = db.prepare('INSERT INTO messages (id, role, sequence, content, semantic_type, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
  rows.forEach((row, index) => insert.run(row.id, row.role, index + 1, row.content, row.sem || '', row.ts))
  db.close()
}

describe('会话全文搜索插件', () => {
  let workDir, routes, tools, settings, originalAppData, dispose

  const route = (method, path) => routes.find((item) => item.method === method && item.path === `/api/plugins/session-search${path}`)

  beforeEach(() => {
    originalAppData = process.env.APPDATA
    workDir = mkdtempSync(join(tmpdir(), 'session-search-'))
    mkdirSync(join(workDir, 'Artificer', 'sessions'), { recursive: true })
    process.env.APPDATA = workDir
    createSessionDb(join(workDir, 'Artificer', 'sessions', 'session-a.db'), [
      { id: 'a1', role: 'user', content: '帮我做一个插件，支持全文搜索历史会话', sem: 'user_intent', ts: 1000 },
      { id: 'a2', role: 'assistant', content: '这个插件会为本地会话建立 trigram 索引。', sem: 'ai_response', ts: 1001 },
      { id: 'a3', role: 'assistant', content: '执行工具 executeCommand 成功', sem: 'execution_result', ts: 1002 }
    ])
    createSessionDb(join(workDir, 'Artificer', 'sessions', 'session-b.db'), [
      { id: 'b1', role: 'user', content: '怎么优化 token 消耗', sem: 'user_intent', ts: 2000 },
      { id: 'b2', role: 'assistant', content: '可以压缩上下文，减少重复的系统提示词。', sem: 'ai_response', ts: 2001 }
    ])
    routes = []
    tools = new Map()
    settings = {}
    const ctx = {
      pluginId: 'session-search',
      getSettings: () => settings,
      logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
      registerRoute: (item) => routes.push(item),
      registerTool: (tool) => tools.set(tool.id, tool),
      disposeWithPlugin: (fn) => { dispose = fn }
    }
    register(ctx)
  })

  afterEach(() => {
    dispose?.()
    process.env.APPDATA = originalAppData
    rmSync(workDir, { recursive: true, force: true })
  })

  it('声明独立插件身份、显式菜单入口与设置项', () => {
    expect(manifest.id).toBe('session-search')
    expect(manifest.entrypoints.api).toBe('server.js')
    expect(manifest.ui.view).toBe('views/App.vue')
    expect(manifest.ui.navItems[0].route).toBe('/plugin/session-search')
    expect(manifest.engines.artificer).toBe('>=1.1.6')
    expect(manifest.settings.fields.map((field) => field.key)).toEqual(['includeToolResults', 'maxResults', 'autoIndex'])
  })

  it('注册搜索、状态、最近会话、重建索引路由与一个只读工具', () => {
    for (const [method, path] of [['GET', '/search'], ['GET', '/status'], ['GET', '/recent'], ['POST', '/reindex']]) {
      expect(route(method, path), `${method} ${path}`).toBeDefined()
    }
    expect([...tools.keys()]).toEqual(['searchConversations'])
    expect(tools.get('searchConversations').security).toEqual({ kind: 'safe' })
  })

  it('首次搜索时自动建索引并返回高亮片段', async () => {
    const result = await route('GET', '/search').handler({ query: { q: '全文搜索' } })
    expect(result.success).toBe(true)
    expect(result.data.mode).toBe('fts')
    expect(result.data.total).toBeGreaterThan(0)
    const hit = result.data.results[0]
    expect(hit.sessionId).toBe('session-a')
    expect(hit.sessionTitle).toContain('全文搜索历史会话')
    expect(hit.snippet).toContain('<mark>全文搜索</mark>')
    expect(result.data.status.totalDocs).toBe(4)
    expect(result.data.status.sessionCount).toBe(2)
  })

  it('短关键词退回子串匹配，仍能命中', async () => {
    const result = await route('GET', '/search').handler({ query: { q: '插件' } })
    expect(result.success).toBe(true)
    expect(result.data.mode).toBe('like')
    expect(result.data.results.map((item) => item.msgId).sort()).toEqual(['a1', 'a2'])
  })

  it('按角色过滤只返回对应消息', async () => {
    const result = await route('GET', '/search').handler({ query: { q: '上下文', role: 'assistant' } })
    expect(result.data.results.every((item) => item.role === 'assistant')).toBe(true)
    expect(result.data.results[0].sessionId).toBe('session-b')
  })

  it('默认不索引工具执行结果，开启设置后索引', async () => {
    const before = await route('GET', '/search').handler({ query: { q: 'executeCommand' } })
    expect(before.data.total).toBe(0)
    settings = { includeToolResults: true }
    const after = await route('POST', '/reindex').handler({})
    expect(after.success).toBe(true)
    const search = await route('GET', '/search').handler({ query: { q: 'executeCommand' } })
    expect(search.data.total).toBe(1)
    expect(search.data.results[0].semanticType).toBe('execution_result')
  })

  it('最近会话按时间倒序，并带上消息数', async () => {
    await route('POST', '/reindex').handler({})
    const result = await route('GET', '/recent').handler({ query: { limit: '5' } })
    expect(result.success).toBe(true)
    expect(result.data.map((item) => item.sessionId)).toEqual(['session-b', 'session-a'])
    expect(result.data[1].messageCount).toBe(2)
  })

  it('工具返回纯文本片段，去掉高亮标记', async () => {
    await route('POST', '/reindex').handler({})
    const result = await tools.get('searchConversations').handler({ query: '全文搜索', limit: 3 })
    expect(result.success).toBe(true)
    expect(result.data.mode).toBe('fts')
    expect(result.data.results[0].snippet).not.toContain('<mark>')
    expect(result.data.results[0].snippet).toContain('全文搜索')
  })

  it('空查询直接返回空结果，不触发索引', async () => {
    const result = await route('GET', '/search').handler({ query: {} })
    expect(result.success).toBe(true)
    expect(result.data.total).toBe(0)
    expect(result.data.mode).toBe('empty')
    expect((await tools.get('searchConversations').handler({ query: '  ' })).success).toBe(false)
  })

  it('删除的会话文件在重建索引后从索引中移除', async () => {
    await route('POST', '/reindex').handler({})
    rmSync(join(workDir, 'Artificer', 'sessions', 'session-b.db'))
    const result = await route('POST', '/reindex').handler({})
    expect(result.success).toBe(true)
    const status = await route('GET', '/status').handler({})
    expect(status.data.sessionCount).toBe(1)
    expect(status.data.totalDocs).toBe(2)
  })
})
