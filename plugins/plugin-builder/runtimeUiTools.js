export function createRuntimeUiPluginTools(runtimePlugins) {
  const readRuntimeUiPluginFileTool = {
  id: 'readRuntimeUiPluginFile',
  name: '读取运行时插件源码',
  description: '读取受信任运行时插件的单个源码文件。filePath 必须是相对插件目录的路径，源码固定在 %APPDATA%/Artificer/plugins-src/<pluginId>/，不能读取目录外文件；允许 plugin.json、.vue、.css、.js、.mjs、.md。成功返回 { success, sourceDir, filePath, content }；文件不存在时返回 { success: false, error }。修改插件前先用它读取现有 plugin.json 和相关入口。',
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
  description: '写入运行时插件源码：覆盖 files 中列出的文件，未列出的旧文件保留；工具不能单独删除文件。写入不会生效，必须再调用 buildRuntimeUiPlugin。允许 plugin.json、.vue、.css、.js、.mjs、.md，禁止 package.json、node_modules 和二进制资源。单批最多 32 个文件，单文件不超过 256KB，单批总量不超过 1MB；path 必须相对且不能含 ..。plugin.json 必须是有效 JSON，id 与 pluginId 完全一致，且声明 ui 或 entrypoints。成功返回 { success, sourceDir, files, bytesWritten }。',
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
  description: '构建并热加载运行时插件，plugin.json.entrypoints 声明的入口会作为受信任插件执行。成功返回 { success, plugin, sourceDir }：plugin.ui.runtime.entry 是 UI 产物入口，界面插件必须非空，纯后端插件为 null 属正常；plugin.capabilities 列出实际注册成功的 tools/skills/commands，缺失说明入口未执行或注册被拒。失败返回 { success: false, error }，按原因修改文件后重建，不要原样重试。',
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
    description: '列出外部运行时插件与未构建完成的源码目录，返回 { success, plugins: [{ id, name, built, sourceDir }] }；built=false 表示源码存在但尚未构建成功。修改插件前先用它定位 id，沿用原 id 读取并写入，不要新建带版本后缀的副本。',
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
    description: '卸载外部运行时插件并删除源码、构建产物和插件设置，不可恢复，返回 { success, id, sourceDir }。仅在用户明确要求删除时调用；修改插件不需要卸载，内置插件会被拒绝。',
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
