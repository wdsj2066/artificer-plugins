import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { register } from '../../plugins/plugin-builder/server.js'

describe('插件工坊', () => {
  it('通过注入的运行时插件 SDK 注册开发和维护工具', async () => {
    const tools = []
    const runtimePlugins = {
      list: vi.fn(() => [{ id: 'demo', built: false }]),
      remove: vi.fn(async id => ({ id })),
      readSourceFile: vi.fn(() => ({
        sourceDir: '/runtime/demo',
        relativePath: 'plugin.json',
        content: '{"id":"demo"}'
      })),
      writeSourceFiles: vi.fn(() => ({
        sourceDir: '/runtime/demo',
        files: ['plugin.json'],
        bytesWritten: 13
      })),
      build: vi.fn(async () => ({ id: 'demo', sourceDir: '/runtime/demo', runtime: true }))
    }

    register({
      runtimePlugins,
      registerTool: tool => tools.push(tool),
      logger: { info: vi.fn() }
    })

    expect(tools.map(tool => tool.id)).toEqual([
      'readRuntimeUiPluginFile',
      'writeRuntimeUiPluginFiles',
      'buildRuntimeUiPlugin',
      'listRuntimeUiPlugins',
      'removeRuntimeUiPlugin'
    ])

    await expect(tools[2].handler({ pluginId: 'demo' })).resolves.toMatchObject({
      success: true,
      sourceDir: '/runtime/demo'
    })
    expect(runtimePlugins.build).toHaveBeenCalledWith('demo')
    await expect(tools[3].handler({})).resolves.toEqual({ success: true, plugins: [{ id: 'demo', built: false }] })
    await expect(tools[4].handler({ pluginId: 'demo' })).resolves.toEqual({ success: true, id: 'demo' })
    expect(runtimePlugins.remove).toHaveBeenCalledWith('demo')
    runtimePlugins.remove.mockRejectedValueOnce(new Error('不能删除内置插件'))
    await expect(tools[4].handler({ pluginId: 'builtin' })).resolves.toEqual({ success: false, error: '不能删除内置插件' })
  })
})

const manifest = JSON.parse(readFileSync(new URL('../../plugins/plugin-builder/plugin.json', import.meta.url), 'utf8'))
const knowledge = readFileSync(new URL('../../plugins/plugin-builder/skills/integration.md', import.meta.url), 'utf8')
it('工坊可读取接入知识库，覆盖运行域、SDK 和全部 UI 声明', () => {
  expect(manifest.skills).toContainEqual({ file: 'skills/integration.md' })
  expect(manifest.scenario.access.skills).toContain('plugin-builder-integration')
  expect(manifest.scenario.access.tools).toContain('readContext')
  for (const name of [
    'bootstrap', 'electron', 'api', 'agent', 'worker', 'web', 'extensions', 'rpc', 'disposeWithPlugin',
    'registerTool', 'registerCommand', 'registerRoute', 'registerWebSocket', 'registerChannel',
    'processChannelInbound', 'registerProviderAdapter', 'registerArtifactHandler', 'registerUiCompiler',
    'getStore', 'getSettings', 'importModule', 'modelRequestService', 'runtimePlugins',
    'view', 'toolbar', 'inputActions', 'inputFooter', 'statusBar', 'contextMenu', 'msgActions', 'sessionActions',
    'toolRenderers', 'commandResults', 'messageRenderers', 'roundRenderers', 'components', 'styles',
    'panels', 'floatingPanels', 'navItems', 'routes', 'toolMeta', 'shortcuts', 'theme', 'composeDraft', 'activatePanel'
  ]) expect(knowledge, `知识库遗漏 ${name}`).toContain(name)
})
