/**
 * 企业微信频道插件后端
 * 通过 ctx.registerChannel 注册 WecomProvider，长连接由 syncEnabledChannels 统一驱动
 */
import { WecomProvider } from './wecomProvider.js'

export function register(ctx) {
  const { registerChannel, logger } = ctx

  registerChannel('wecom', WecomProvider)
  logger?.info?.('[channel-wecom] WecomProvider 已注册')
}
