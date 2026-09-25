import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const sourceDir = resolve(process.argv[2] || '')
const manifest = JSON.parse(readFileSync(join(sourceDir, 'plugin.json'), 'utf-8'))
if (!manifest.ui) process.exit(0)
if (manifest.ui.compiler && manifest.ui.compiler !== 'vue-vite') {
  throw new Error(`发布脚本不支持编译器: ${manifest.ui.compiler}`)
}

const singles = ['view', 'toolbar', 'inputActions', 'inputFooter', 'statusBar', 'contextMenu', 'msgActions', 'sessionActions']
const maps = ['toolRenderers', 'commandResults', 'messageRenderers', 'roundRenderers', 'components']
const components = new Set()
for (const kind of singles) if (manifest.ui[kind]) components.add(manifest.ui[kind])
for (const kind of maps) for (const path of Object.values(manifest.ui[kind] || {})) components.add(path)
for (const panel of [...(manifest.ui.panels || []), ...(manifest.ui.floatingPanels || [])]) components.add(panel.component)
for (const route of manifest.ui.routes || []) components.add(route.component)
const styles = [...new Set(manifest.ui.styles || [])]
if (components.size === 0) process.exit(0)

function checkedPath(path, extension) {
  if (typeof path !== 'string' || !path.endsWith(extension)) throw new Error(`无效的插件资源: ${path}`)
  const target = resolve(sourceDir, path)
  const rel = relative(sourceDir, target)
  if (!rel || rel.startsWith('..') || rel.includes(`${sep}..${sep}`) || !existsSync(target)) {
    throw new Error(`插件资源不存在或越界: ${path}`)
  }
  return path.replace(/\\/g, '/')
}

const componentPaths = [...components].map(path => checkedPath(path, '.vue'))
const stylePaths = styles.map(path => checkedPath(path, '.css'))
const entryPath = join(sourceDir, '.artificer-runtime-entry.mjs')
const outDir = join(sourceDir, '.artificer-dist')
rmSync(outDir, { recursive: true, force: true })
const imports = []
const componentEntries = []
const styleEntries = []
componentPaths.forEach((path, index) => {
  imports.push(`import component${index} from ${JSON.stringify(`./${path}`)};`)
  componentEntries.push(`${JSON.stringify(path)}: component${index}`)
})
stylePaths.forEach((path, index) => {
  imports.push(`import style${index} from ${JSON.stringify(`./${path}?inline`)};`)
  styleEntries.push(`${JSON.stringify(path)}: style${index}`)
})
writeFileSync(entryPath, [
  ...imports,
  `export const components = { ${componentEntries.join(', ')} };`,
  `export const styles = { ${styleEntries.join(', ')} };`,
  'export default { components, styles };'
].join('\n'))

try {
  const compilerPath = join(import.meta.dirname, '..', 'plugins', 'ui-compiler-vue', 'server.js')
  const { register } = await import(pathToFileURL(compilerPath).href)
  let compiler
  register({ registerUiCompiler(config) { compiler = config } })
  await compiler.build({ sourceDir, entryPath, outDir, manifest })
  if (!existsSync(join(outDir, 'index.js'))) throw new Error('编译器未输出 index.js')
} finally {
  rmSync(entryPath, { force: true })
}
