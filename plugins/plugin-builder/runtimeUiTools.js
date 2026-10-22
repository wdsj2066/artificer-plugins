export function createRuntimeUiPluginTools(runtimePlugins) {
  const readRuntimeUiPluginFileTool = {
  id: 'readRuntimeUiPluginFile',
  name: '读取运行时插件源码',
  description: '读取受信任运行时插件的 plugin.json、.vue、.css、.js、.mjs 或 .md 源码。源码固定在 %APPDATA%/Artificer/plugins-src/<pluginId>/，不能读取目录外文件。',
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
        description: '待写入文件。允许 plugin.json、.vue、.css、.js、.mjs、.md；每项包含 path 与 content。',
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
  description: '构建用户数据目录中的运行时插件；plugin.json.entrypoints 声明的入口会作为受信任插件加载，可注册工具、命令、路由与 hooks。',
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

  const listTool = {
    id: 'listRuntimeUiPlugins',
    name: '列出外部运行时插件',
    description: '列出已有外部插件及未构建的源码目录。修改插件前先查找原插件 id，再读取 plugin.json 和相关源码，沿用原 id 写入并构建。',
    parameters: { type: 'object', properties: {} },
    tags: ['readonly', 'development'],
    async handler() {
      try {
        return { success: true, plugins: await runtimePlugins.list() }
      } catch (error) {
        return { success: false, error: error.message }
      }
    }
  }
  const removeTool = {
    id: 'removeRuntimeUiPlugin',
    name: '卸载并删除外部运行时插件',
    description: '卸载指定外部插件并删除其源码、构建产物和设置，不可恢复；仅在用户明确要求删除时调用。不能删除内置插件。修改插件无需先卸载。',
    parameters: {
      type: 'object',
      properties: { pluginId: { type: 'string', description: '用户明确要求卸载的插件 id' } },
      required: ['pluginId']
    },
    metadata: { version: '1.0.0', category: 'plugin_development', risky: true },
    tags: ['sensitive', 'development'],
    async handler({ pluginId }) {
      try {
        return { success: true, ...await runtimePlugins.remove(pluginId) }
      } catch (error) {
        return { success: false, error: error.message }
      }
    }
  }
  return [readRuntimeUiPluginFileTool, writeRuntimeUiPluginFilesTool, buildRuntimeUiPluginTool, listTool, removeTool]
}
