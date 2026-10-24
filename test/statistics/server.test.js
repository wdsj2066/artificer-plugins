import { beforeEach, describe, expect, it, vi } from 'vitest'
import { register } from '../../plugins/statistics/server.js'

describe('外部统计插件', () => {
  let handler, read
  beforeEach(() => {
    read = vi.fn(async year => ({ year, rows: [], sessions: [], workspaces: [] }))
    register({ usage: { read }, registerRoute: route => { handler = route.handler }, logger: { error: vi.fn() } })
  })
  it('通过宿主聚合接口读取用量并缓存同年结果', async () => {
    expect((await handler({ query: { year: '2026' } })).data.year).toBe(2026)
    await handler({ query: { year: '2026' } })
    expect(read).toHaveBeenCalledTimes(1)
    await handler({ query: { year: '2025' } })
    expect(read).toHaveBeenLastCalledWith(2025)
  })
  it('拒绝无效年份，不向客户端泄露宿主读取错误', async () => {
    expect((await handler({ query: { year: '../bad' } })).success).toBe(false)
    expect(read).not.toHaveBeenCalled()
    read.mockRejectedValueOnce(new Error('私有路径'))
    expect((await handler({ query: { year: 2026 } })).error).not.toContain('私有路径')
    expect(() => register({})).toThrow('1.1.6')
  })
})
