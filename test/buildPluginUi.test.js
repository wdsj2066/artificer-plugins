import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPluginUi } from '../scripts/build-plugin-ui.mjs'

const roots = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function fixture(manifest) {
  const root = mkdtempSync(join(tmpdir(), 'artificer-publish-ui-'))
  roots.push(root)
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ id: 'demo', version: '1.0.0', ...manifest }))
  writeFileSync(join(root, 'web.js'), 'export function register(ctx) { ctx.ui.registerRoute({}) }')
  return root
}

describe('发布 UI 构建协议', () => {
  it('没有 ui 数据字段的 Web 插件仍生成 registerWeb，并清理临时入口', async () => {
    const root = fixture({ entrypoints: { web: 'web.js' } })
    let entry
    const compiler = { build: vi.fn(async ({ entryPath, outDir }) => {
      entry = readFileSync(entryPath, 'utf8')
      mkdirSync(outDir)
      writeFileSync(join(outDir, 'index.js'), entry)
    }) }
    await buildPluginUi(root, { compiler })
    expect(compiler.build).toHaveBeenCalledOnce()
    expect(entry).toContain('export const registerWeb = webEntry.register')
    expect(entry).toContain('export default { components, styles, registerWeb }')
    expect(existsSync(join(root, '.artificer-runtime-entry.mjs'))).toBe(false)
  })

  it('拒绝旧组件声明和越界入口，后端插件无需编译', async () => {
    const compiler = { build: vi.fn() }
    await expect(buildPluginUi(fixture({ ui: { view: 'view.vue' } }), { compiler })).rejects.toThrow('已废弃')
    await expect(buildPluginUi(fixture({ entrypoints: { web: '../escape.js' } }), { compiler })).rejects.toThrow('越界')
    const absoluteRoot = fixture({})
    writeFileSync(join(absoluteRoot, 'plugin.json'), JSON.stringify({ entrypoints: { web: join(absoluteRoot, 'web.js') } }))
    await expect(buildPluginUi(absoluteRoot, { compiler })).rejects.toThrow('越界')
    await expect(buildPluginUi(fixture({ entrypoints: { api: 'server.js' } }), { compiler })).resolves.toBeNull()
    expect(compiler.build).not.toHaveBeenCalled()
  })

  it('编译失败也会清理临时入口', async () => {
    const root = fixture({ entrypoints: { web: 'web.js' } })
    await expect(buildPluginUi(root, { compiler: { build: async () => { throw new Error('编译失败') } } })).rejects.toThrow('编译失败')
    expect(existsSync(join(root, '.artificer-runtime-entry.mjs'))).toBe(false)
  })
})
