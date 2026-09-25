import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

const require = createRequire(import.meta.url)

function hostPackageFallback(sourceDir, name) {
  // 优先使用插件自己的依赖；旧插件没有 package.json 时使用编译器所带版本。
  if (existsSync(join(sourceDir, 'node_modules', name))) return null
  return require.resolve(name)
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
