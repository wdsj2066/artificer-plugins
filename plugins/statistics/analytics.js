/** 统计视图的纯数据聚合，确保会话与工作区排行共享同一口径。 */
export function rankUsage(rows, sessions, workspaces) {
  const sessionInfo = new Map(sessions.map(s => [s.id, s]))
  const workspaceInfo = new Map(workspaces.map(ws => [ws.id, ws]))
  const bySession = new Map()
  const byWorkspace = new Map()
  for (const row of rows) {
    const session = sessionInfo.get(row.sessionId) || { id: row.sessionId, title: '未命名会话', workspaceId: 'ws_public', status: 'active' }
    const ws = workspaceInfo.get(session.workspaceId) || { id: session.workspaceId, name: '未归属工作区' }
    if (!bySession.has(session.id)) bySession.set(session.id, { ...session, workspaceName: ws.name, total: 0, calls: 0, input: 0, output: 0 })
    if (!byWorkspace.has(ws.id)) byWorkspace.set(ws.id, { id: ws.id, name: ws.name, total: 0, calls: 0, sessionIds: new Set() })
    const s = bySession.get(session.id)
    s.input += row.input; s.output += row.output; s.total += row.input + row.output; s.calls += row.calls
    const w = byWorkspace.get(ws.id)
    w.total += row.input + row.output; w.calls += row.calls; w.sessionIds.add(session.id)
  }
  const sort = (a, b) => b.total - a.total || a.id.localeCompare(b.id)
  return {
    sessions: [...bySession.values()].sort(sort),
    workspaces: [...byWorkspace.values()].map(({ sessionIds, ...w }) => ({ ...w, sessionCount: sessionIds.size })).sort(sort)
  }
}
