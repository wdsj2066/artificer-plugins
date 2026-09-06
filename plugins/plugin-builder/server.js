import { createRuntimeUiPluginTools } from './runtimeUiTools.js'

export function register(ctx) {
  for (const tool of createRuntimeUiPluginTools(ctx.runtimePlugins)) {
    ctx.registerTool(tool)
  }
  ctx.logger.info('Plugin builder registered: runtime UI plugin tools')
}
