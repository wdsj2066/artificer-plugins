import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const legacyComponents = ['view', 'toolbar', 'inputActions', 'inputFooter', 'statusBar', 'contextMenu', 'msgActions', 'sessionActions', 'panels', 'floatingPanels', 'toolRenderers', 'commandResults', 'messageRenderers', 'roundRenderers', 'components']

/** 发布与宿主使用同一个 registerWeb 产物协议，后端插件无需构建浏览器资源。 */
export async function buildPluginUi(directory, { compiler: providedCompiler } = {}) {
  const sourceDir = resolve(directory)
  const manifest = JSON.parse(readFileSync(join(sourceDir, 'plugin.json'), 'utf-8'))
  for (const key of legacyComponents) {
    if (key in (manifest.ui || {})) throw new Error(`ui.${key} 已废弃，请在 entrypoints.web 中使用 ctx.ui 注册组件`)
  }
  if (!manifest.entrypoints?.web) return null
  if (manifest.ui?.compiler && manifest.ui.compiler !== 'vue-vite') {
    throw new Error(`发布脚本不支持编译器: ${manifest.ui.compiler}`)
  }
  function checkedPath(file, extensions) {
    if (typeof file !== 'string' || !extensions.some(extension => file.endsWith(extension))) throw new Error(`无效的插件资源: ${file}`)
    const target = resolve(sourceDir, file)
    const rel = relative(sourceDir, target)
    if (isAbsolute(file) || isAbsolute(rel) || !rel || rel === '..' || rel.startsWith(`..${sep}`) || !existsSync(target)) {
      throw new Error(`插件资源不存在或越界: ${file}`)
    }
    return rel.replace(/\\/g, '/')
  }
  const webEntry = checkedPath(manifest.entrypoints.web, ['.js', '.mjs'])
  const styles = [...new Set(manifest.ui?.styles || [])].map(file => checkedPath(file, ['.css']))
  const entryPath = join(sourceDir, '.artificer-runtime-entry.mjs')
  const outDir = join(sourceDir, '.artificer-dist')
  const imports = styles.map((file, index) => `import style${index} from ${JSON.stringify(`./${file}?inline`)};`)
  const entries = styles.map((file, index) => `${JSON.stringify(file)}: style${index}`)
  imports.push(`import * as webEntry from ${JSON.stringify(`./${webEntry}`)};`)
  writeFileSync(entryPath, [
    ...imports,
    'export const components = {};',
    `export const styles = { ${entries.join(', ')} };`,
    'export const registerWeb = webEntry.register || Reflect.get(webEntry, "default")?.register;',
    'export default { components, styles, registerWeb };'
  ].join('\n'), 'utf-8')
  try {
    let compiler = providedCompiler
    if (!compiler) {
      const compilerPath = join(import.meta.dirname, '..', 'plugins', 'ui-compiler-vue', 'server.js')
      const { register } = await import(pathToFileURL(compilerPath).href)
      register({ registerUiCompiler(config) { compiler = config } })
    }
    await compiler.build({ sourceDir, entryPath, outDir, manifest })
    if (!existsSync(join(outDir, 'index.js'))) throw new Error('编译器未输出 index.js')
    return outDir
  } finally {
    rmSync(entryPath, { force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('请指定插件源码目录')
  await buildPluginUi(process.argv[2])
}
