import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

const require = createRequire(import.meta.url)

function hostPackageFallback(sourceDir, name) {
  // 优先使用插件自己的依赖；旧插件没有 package.json 时使用编译器所带版本。
  if (existsSync(join(sourceDir, 'node_modules', name))) return null
  // require.resolve(name) 会选中 CommonJS 的 main，令 Vue 变成默认与命名
  // 混合导入；宿主的运行时导出收集器只识别命名导入。与宿主 Vite 构建
  // 一样优先使用浏览器 ESM 入口，避免漏收集 Vue 导出而让插件白屏。
  const packagePath = require.resolve(`${name}/package.json`)
  const manifest = JSON.parse(readFileSync(packagePath, 'utf-8'))
  return manifest.module
    ? join(dirname(packagePath), manifest.module)
    : require.resolve(name)
}

export function register(ctx) {
  ctx.registerUiCompiler({
    id: 'vue-vite',
    async build({ sourceDir, entryPath, outDir }) {
      const aliases = ['naive-ui', 'lucide-vue-next']
        .map(name => ({ find: name, replacement: hostPackageFallback(sourceDir, name) }))
        .filter(item => item.replacement)

      await build({
        configFile: false,
        root: sourceDir,
        plugins: [vue()],
        // Vite 库模式默认保留 process.env，浏览器会在组件 setup 中抛错。
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        publicDir: false,
        logLevel: 'warn',
        resolve: { alias: aliases },
        build: {
          outDir,
          emptyOutDir: true,
          cssCodeSplit: false,
          lib: {
            entry: entryPath,
            formats: ['es'],
            fileName: () => 'index.js',
            cssFileName: 'style'
          },
          rollupOptions: {
            external: ['vue'],
            output: {
              inlineDynamicImports: true,
              assetFileNames: 'assets/[name]-[hash][extname]',
              paths(id) {
                return id === 'vue' ? '/api/plugin-runtime/vue.js' : id
              }
            }
          }
        }
      })
    }
  })
}
