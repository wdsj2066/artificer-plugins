/**
 * 飞书频道插件后端
 * 通过 ctx.registerChannel 注册 FeishuProvider，让核心频道管线（入站/出站/挂载）可驱动飞书
 */
import { FeishuProvider } from './feishuProvider.js'

export function register(ctx) {
  const { registerChannel, logger } = ctx

  registerChannel('feishu', FeishuProvider)
  logger?.info?.('[channel-feishu] FeishuProvider 已注册')
}
