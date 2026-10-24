export function register(ctx) {
  if (!ctx.usage?.read) throw new Error('统计插件需要 Artificer 1.1.6 或更高版本')
  let cache = null
  ctx.registerRoute({
    method: 'GET',
    path: '/api/plugins/statistics/usage',
    async handler({ query }) {
      const currentYear = Number(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric' }))
      const year = query.year === undefined ? currentYear : Number(query.year)
      if (!Number.isInteger(year) || year < 2000 || year > 2100) return { success: false, error: '年份无效' }
      try {
        if (!cache || cache.year !== year || Date.now() - cache.updatedAt > 15000) cache = await ctx.usage.read(year)
        return { success: true, data: cache }
      } catch (error) {
        ctx.logger?.error('读取用量统计失败', error)
        return { success: false, error: '读取用量统计失败，请稍后重试' }
      }
    }
  })
}
