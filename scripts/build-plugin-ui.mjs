import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const sourceDir = resolve(process.argv[2] || '')
const manifestPath = join(sourceDir, 'plugin.json')
if (!existsSync(manifestPath)) throw new Error(`未找到插件清单: ${manifestPath}`)

const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
const ui = manifest.ui || {}
const removedUiFields = [
  'view',
  'components',
  'contextMenu',
  'toolRenderers',
  'commandResults',
  'messageRenderers',
  'roundRenderers',
  'toolbar',
  'inputActions',
  'inputFooter',
  'statusBar',
  'msgActions',
  'sessionActions',
  'panels',
  'floatingPanels'
].filter(key => ui[key] !== undefined)
if (removedUiFields.length > 0) {
  throw new Error(`插件 ${manifest.id} 仍声明旧 UI 字段 ui.${removedUiFields.join('/')}；请改由 entrypoints.web 注册运行时树`)
}
for (const route of ui.routes || []) {
  if (route?.component !== undefined) {
    throw new Error(`插件 ${manifest.id} 的路由仍声明 component；页面树必须由 Web 入口注册`)
  }
}
if (ui.compiler && ui.compiler !== 'vue-vite') {
  throw new Error(`发布脚本不支持编译器: ${ui.compiler}`)
}

function checkedPath(path, extensions) {
  if (typeof path !== 'string' || !path.trim()) throw new Error(`无效的插件资源: ${path}`)
  if (!extensions.some(extension => path.endsWith(extension))) {
    throw new Error(`插件资源扩展名无效: ${path}`)
  }
  const target = resolve(sourceDir, path)
  const rel = relative(sourceDir, target)
  if (!rel || rel.startsWith('..') || rel.includes(`${sep}..${sep}`) || !existsSync(target)) {
    throw new Error(`插件资源不存在或越界: ${path}`)
  }
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

const styles = [...new Set((ui.styles || []).map(path => checkedPath(path, ['.css'])))]
const webEntry = manifest.entrypoints?.web
if (ui.routes?.length) {
  if (!webEntry) throw new Error(`插件 ${manifest.id} 声明了树面板或页面路由，但未声明 entrypoints.web`)
}
if (!webEntry && !styles.length) process.exit(0)

const checkedWebEntry = webEntry ? checkedPath(webEntry, ['.js', '.mjs']) : null
const entryPath = join(sourceDir, '.artificer-runtime-entry.mjs')
const outDir = join(sourceDir, '.artificer-dist')
rmSync(outDir, { recursive: true, force: true })

const imports = [
  ...(checkedWebEntry ? [`import * as webEntry from ${JSON.stringify(`./${checkedWebEntry}`)};`] : []),
  ...styles.map((path, index) => `import style${index} from ${JSON.stringify(`./${path}?inline`)};`)
]
const styleEntries = styles.map((path, index) => `${JSON.stringify(path)}: style${index}`)
writeFileSync(entryPath, [
  ...imports,
  `export const styles = { ${styleEntries.join(', ')} };`,
  checkedWebEntry
    ? 'export const registerWeb = webEntry.register || webEntry.default?.register;'
    : 'export const registerWeb = null;',
  'export default { styles, registerWeb };'
].join('\n'))

try {
  const compilerPath = join(import.meta.dirname, '..', 'plugins', 'ui-compiler-vue', 'server.js')
  const { register } = await import(pathToFileURL(compilerPath).href)
  let compiler
  register({ registerUiCompiler(config) { compiler = config } })
  if (!compiler) throw new Error('Web UI 编译器未注册')
  await compiler.build({ sourceDir, entryPath, outDir, manifest })
  if (!existsSync(join(outDir, 'index.js'))) throw new Error('Web UI 编译器未输出 index.js')
} finally {
  rmSync(entryPath, { force: true })
}
