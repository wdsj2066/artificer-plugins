export function createRuntimeUiPluginTools(runtimePlugins) {
  const readRuntimeUiPluginFileTool = {
  id: 'readRuntimeUiPluginFile',
  name: '读取运行时插件源码',
  description: '读取受信任运行时插件的 plugin.json、.vue、.css、.js 或 .mjs 源码。源码固定在 %APPDATA%/Artificer/plugins-src/<pluginId>/，不能读取目录外文件。',
  parameters: {
    type: 'object',
    properties: {
      pluginId: { type: 'string', description: '插件 id，例如 my-dashboard' },
      filePath: { type: 'string', description: '相对插件目录的文件路径，例如 plugin.json 或 views/Dashboard.vue' }
    },
    required: ['pluginId', 'filePath']
  },
  metadata: { version: '1.0.0', category: 'plugin_development' },
  tags: ['readonly', 'development'],
  async handler({ pluginId, filePath }) {
    try {
      const file = runtimePlugins.readSourceFile(pluginId, filePath)
      return { success: true, sourceDir: file.sourceDir, filePath: file.relativePath, content: file.content }
    } catch (error) {
      return { success: false, error: error.message }
    }
  }
  }

  const writeRuntimeUiPluginFilesTool = {
  id: 'writeRuntimeUiPluginFiles',
  name: '写入运行时插件源码',
  description: '将 plugin.json、Vue/CSS 与受信任的 Node.js 后端源码写入运行时插件目录。允许 server.js 及本地 .js/.mjs 模块；不允许 package.json、node_modules 或安装依赖。',
  parameters: {
    type: 'object',
    properties: {
      pluginId: { type: 'string', description: '插件 id，同时也是 plugins-src 下的目录名' },
      files: {
        type: 'array',
        description: '待写入文件。允许 plugin.json、.vue、.css、.js、.mjs；每项包含 path 与 content。',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '相对插件目录的路径' },
            content: { type: 'string', description: '完整文件内容' }
          },
          required: ['path', 'content']
        }
      }
    },
    required: ['pluginId', 'files']
  },
  metadata: { version: '1.0.0', category: 'plugin_development', risky: true },
  tags: ['sensitive', 'development'],
  async handler({ pluginId, files }) {
    try {
      const result = runtimePlugins.writeSourceFiles(pluginId, files)
      return { success: true, ...result, message: `运行时插件源码已写入: ${pluginId}` }
    } catch (error) {
      return { success: false, error: error.message }
    }
  }
  }

  const buildRuntimeUiPluginTool = {
  id: 'buildRuntimeUiPlugin',
  name: '构建并加载运行时插件',
  description: '构建用户数据目录中的运行时插件；若 plugin.json 声明 hasBackend 且提供 server.js，会作为受信任插件加载，可注册工具、命令、路由与 hooks。',
  parameters: {
    type: 'object',
    properties: {
      pluginId: { type: 'string', description: '插件 id，同时也是 plugins-src 下的目录名' }
    },
    required: ['pluginId']
  },
  metadata: { version: '1.0.0', category: 'development' },
  tags: ['development'],
  async handler({ pluginId }) {
    try {
      const plugin = await runtimePlugins.build(pluginId)
      return {
        success: true,
        plugin,
        sourceDir: plugin.sourceDir,
        message: `运行时插件已构建并加载: ${pluginId}`
      }
    } catch (error) {
      return { success: false, error: error.message }
    }
  }
  }

  return [readRuntimeUiPluginFileTool, writeRuntimeUiPluginFilesTool, buildRuntimeUiPluginTool]
}
