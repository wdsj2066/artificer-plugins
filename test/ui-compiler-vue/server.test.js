import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from '../../plugins/ui-compiler-vue/server.js'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Vue UI 编译器', () => {
  it('将插件 Vue 组件编译成宿主可加载的 ESM', async () => {
    let compiler
    register({ registerUiCompiler(value) { compiler = value } })
    const root = mkdtempSync(join(tmpdir(), 'artificer-ui-compiler-'))
    roots.push(root)
    const sourceDir = join(root, 'source')
    const outDir = join(root, 'dist')
    mkdirSync(sourceDir)
    const entryPath = join(sourceDir, 'entry.mjs')
    writeFileSync(join(sourceDir, 'Demo.vue'), '<template><main>编译成功</main></template>')
    writeFileSync(entryPath, "import Demo from './Demo.vue'; export const components = { 'Demo.vue': Demo };", 'utf-8')

    await compiler.build({ sourceDir, entryPath, outDir })

    const output = readFileSync(join(outDir, 'index.js'), 'utf-8')
    expect(output).toContain('/api/plugin-runtime/vue.js')
    expect(output).toContain('编译成功')
  })

  it('兼容尚未声明独立依赖的现有 Vue 插件', async () => {
    let compiler
    register({ registerUiCompiler(value) { compiler = value } })
    const root = mkdtempSync(join(tmpdir(), 'artificer-ui-legacy-'))
    roots.push(root)
    const sourceDir = join(root, 'source')
    const outDir = join(root, 'dist')
    mkdirSync(sourceDir)
    writeFileSync(join(sourceDir, 'View.vue'), "<script setup>import { NButton } from 'naive-ui'; import { FileText } from 'lucide-vue-next'</script><template><NButton><FileText /></NButton></template>")
    const sourceEntry = join(sourceDir, 'entry.mjs')
    writeFileSync(sourceEntry, "import View from './View.vue'; export const components = { 'View.vue': View };")
    await compiler.build({ sourceDir, entryPath: sourceEntry, outDir })
    expect(readFileSync(join(outDir, 'index.js'), 'utf-8')).toContain('/api/plugin-runtime/vue.js')
  }, 60000)

  it('Remote 产物的 Vue 导入可被宿主导出收集器完整识别', async () => {
    let compiler
    register({ registerUiCompiler(value) { compiler = value } })
    const root = mkdtempSync(join(tmpdir(), 'artificer-ui-remote-'))
    roots.push(root)
    writeFileSync(join(root, 'view.vue'), readFileSync(new URL('../../plugins/remote/view.vue', import.meta.url)))
    const entryPath = join(root, 'entry.mjs')
    writeFileSync(entryPath, "import View from './view.vue'; export const components = { 'view.vue': View };")
    await compiler.build({ sourceDir: root, entryPath, outDir: join(root, 'dist') })
    const output = readFileSync(join(root, 'dist/index.js'), 'utf-8')
    // 与宿主 collectVueExports 的协议相同：只收集纯命名导入。
    const pattern = /import\s*\{([^}]+)\}\s*from\s*["']\/api\/plugin-runtime\/vue\.js["']/g
    const imports = [...output.matchAll(pattern)]
    expect(imports.length).toBeGreaterThan(0)
    const remainder = output.replace(pattern, '')
    expect(remainder).not.toMatch(/from\s*["']\/api\/plugin-runtime\/vue\.js["']/)
    const names = imports.flatMap(match => match[1].split(',').map(specifier => specifier.trim().split(/\s+as\s+/)[0]))
    expect(names).toEqual(expect.arrayContaining(['ref', 'computed', 'onMounted', 'onUnmounted', 'createElementVNode']))
    expect(output).toContain('Remote 远程连接')
    expect(output).toContain('view.vue')
  }, 60000)
})
