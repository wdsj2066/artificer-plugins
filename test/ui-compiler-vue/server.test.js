import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from '../../plugins/ui-compiler-vue/server.js'

const roots = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Web UI 编译器', () => {
  it('将插件 Web 树入口编译成宿主可加载的 ESM', async () => {
    let compiler
    register({ registerUiCompiler(value) { compiler = value } })
    const root = mkdtempSync(join(tmpdir(), 'artificer-ui-compiler-'))
    roots.push(root)
    const sourceDir = join(root, 'source')
    const outDir = join(root, 'dist')
    mkdirSync(sourceDir)
    const entryPath = join(sourceDir, 'entry.mjs')
    writeFileSync(join(sourceDir, 'web.js'), `
      import { ref } from 'vue'
      export const registerWeb = ctx => {
        const marker = ref('编译成功')
        ctx.ui.registerRule({
          op: 'insert', target: 'app.root',
          node: { id: 'demo.root', type: 'text', text: () => marker.value }
        })
      }
    `)
    writeFileSync(entryPath, "export { registerWeb } from './web.js';", 'utf-8')

    await compiler.build({ sourceDir, entryPath, outDir })

    const output = readFileSync(join(outDir, 'index.js'), 'utf-8')
    expect(output).toContain('/api/plugin-runtime/vue.js')
    expect(output).toContain('编译成功')
    expect(output).toContain('registerWeb')
  })

  it('保留 Web 入口样式并排除 Node 环境变量', async () => {
    let compiler
    register({ registerUiCompiler(value) { compiler = value } })
    const root = mkdtempSync(join(tmpdir(), 'artificer-ui-legacy-'))
    roots.push(root)
    const sourceDir = join(root, 'source')
    const outDir = join(root, 'dist')
    mkdirSync(sourceDir)
    writeFileSync(join(sourceDir, 'web.css'), '.tree-view { color: red; }')
    writeFileSync(join(sourceDir, 'web.js'), "import './web.css'; export const registerWeb = () => {};")
    const sourceEntry = join(sourceDir, 'entry.mjs')
    writeFileSync(sourceEntry, "export { registerWeb } from './web.js';")
    await compiler.build({ sourceDir, entryPath: sourceEntry, outDir })
    expect(readFileSync(join(outDir, 'index.js'), 'utf-8')).toContain('registerWeb')
    expect(readFileSync(join(outDir, 'style.css'), 'utf-8')).toContain('.tree-view')
  }, 60000)

  it('Web 入口的 Vue 辅助导入可被宿主导出收集器完整识别', async () => {
    let compiler
    register({ registerUiCompiler(value) { compiler = value } })
    const root = mkdtempSync(join(tmpdir(), 'artificer-ui-remote-'))
    roots.push(root)
    writeFileSync(join(root, 'web.js'), `
      import { ref, computed, onMounted, onUnmounted } from 'vue'
      export const registerWeb = ctx => {
        const count = ref(1)
        const doubled = computed(() => count.value * 2)
        onMounted(() => {
          ctx.ui.registerRule({
            op: 'insert', target: 'app.root',
            node: { id: 'remote.value', type: 'text', text: () => doubled.value }
          })
        })
        onUnmounted(() => {})
      }
    `)
    const entryPath = join(root, 'entry.mjs')
    writeFileSync(entryPath, "export { registerWeb } from './web.js';")
    await compiler.build({ sourceDir: root, entryPath, outDir: join(root, 'dist') })
    const output = readFileSync(join(root, 'dist/index.js'), 'utf-8')
    // 与宿主 collectVueExports 的协议相同：只收集纯命名导入。
    const pattern = /import\s*\{([^}]+)\}\s*from\s*["']\/api\/plugin-runtime\/vue\.js["']/g
    const imports = [...output.matchAll(pattern)]
    expect(imports.length).toBeGreaterThan(0)
    const remainder = output.replace(pattern, '')
    expect(remainder).not.toMatch(/from\s*["']\/api\/plugin-runtime\/vue\.js["']/)
    const names = imports.flatMap(match => match[1].split(',').map(specifier => specifier.trim().split(/\s+as\s+/)[0]))
    expect(names).toEqual(expect.arrayContaining(['ref', 'computed', 'onMounted', 'onUnmounted']))
    expect(output).toContain('remote.value')
    expect(output).not.toMatch(/process\.env\.NODE_ENV/)
  }, 60000)
})
