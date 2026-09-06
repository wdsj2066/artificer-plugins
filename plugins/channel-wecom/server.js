/**
 * 企业微信频道插件后端
 * 通过 ctx.registerChannel 注册 WecomProvider，长连接由 syncEnabledChannels 统一驱动
 */
import { WecomProvider } from './wecomProvider.js'

export function register(ctx) {
  const { registerChannel, logger, getStore, importModule, processChannelInbound } = ctx

  const services = {
    logger,
    store: getStore(),
    importModule,
    processInbound: processChannelInbound
  }

  class RuntimeWecomProvider extends WecomProvider {
    constructor(config) {
      super(config, services)
    }
  }

  registerChannel('wecom', RuntimeWecomProvider)
  logger?.info?.('[channel-wecom] WecomProvider 已注册')
}
