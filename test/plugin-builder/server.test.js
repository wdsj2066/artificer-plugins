import { describe, expect, it, vi } from 'vitest'
import { register } from '../../plugins/plugin-builder/server.js'

describe('插件工坊', () => {
  it('通过注入的运行时插件 SDK 注册三个开发工具', async () => {
    const tools = []
    const runtimePlugins = {
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
      'buildRuntimeUiPlugin'
    ])

    await expect(tools[2].handler({ pluginId: 'demo' })).resolves.toMatchObject({
      success: true,
      sourceDir: '/runtime/demo'
    })
    expect(runtimePlugins.build).toHaveBeenCalledWith('demo')
  })
})
