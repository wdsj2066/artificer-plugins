import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

export function register(ctx) {
  ctx.registerUiCompiler({
    id: 'vue-vite',
    async build({ sourceDir, entryPath, outDir }) {
      await build({
        configFile: false,
        root: sourceDir,
        plugins: [vue()],
        // Vite 库模式默认保留 process.env，浏览器可能在没有构建替换时抛错。
        define: { 'process.env.NODE_ENV': JSON.stringify('production') },
        publicDir: false,
        logLevel: 'warn',
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
            external: ['vue', 'naive-ui', 'lucide-vue-next'],
            output: {
              inlineDynamicImports: true,
              assetFileNames: asset => asset.name === 'style.css'
                ? 'style.css'
                : 'assets/[name]-[hash][extname]',
              paths(id) {
                return ['vue', 'naive-ui', 'lucide-vue-next'].includes(id) ? `/api/plugin-runtime/${id}.js` : id
              }
            }
          }
        }
      })
    }
  })
}
