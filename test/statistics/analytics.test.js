import { describe, expect, it } from 'vitest'
import { rankUsage } from '../../plugins/statistics/analytics.js'
describe('统计聚合', () => {
  it('会话和工作区排行按筛选后的输入输出汇总，不重复计算会话数', () => {
    const sessions = [{ id: 'a', title: '会话 A', workspaceId: 'w', status: 'active' }, { id: 'b', title: '会话 B', workspaceId: 'w', status: 'trashed' }, { id: 'c', title: '会话 C', workspaceId: 'x' }]
    const rows = [{ sessionId: 'a', day: '2026-10-15', input: 100, output: 10, calls: 2 }, { sessionId: 'a', day: '2026-10-16', input: 50, output: 5, calls: 1 }, { sessionId: 'b', day: '2026-10-16', input: 20, output: 2, calls: 1 }, { sessionId: 'c', day: '2026-10-16', input: 5, output: 1, calls: 1 }]
    const workspaces = [{ id: 'w', name: '项目 W' }, { id: 'x', name: '项目 X' }]
    const result = rankUsage(rows, sessions, workspaces)
    expect(result.sessions[0]).toMatchObject({ id: 'a', title: '会话 A', workspaceName: '项目 W', input: 150, output: 15, total: 165, calls: 3 })
    expect(result.workspaces[0]).toMatchObject({ id: 'w', total: 187, sessionCount: 2, calls: 4 })
    const selected = rankUsage(rows.filter(r => r.day === '2026-10-16' && r.sessionId !== 'c'), sessions, workspaces)
    expect(selected.sessions.reduce((n, s) => n + s.total, 0)).toBe(77)
    expect(selected.workspaces[0].sessionCount).toBe(2)
    expect(selected.sessions[1].status).toBe('trashed')
    expect(rankUsage([], sessions, workspaces)).toEqual({ sessions: [], workspaces: [] })
  })
})
