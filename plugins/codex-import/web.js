// 页面入口：在 web 运行域注册插件路由，注册项随插件生命周期自动撤销。
import './views/theme-overrides.css'
import PluginPage from './views/App.vue'

export function register(ctx) {
  if (!ctx.ui.getService('ui.router@1')) return
  ctx.ui.registerRoute({
    id: 'codex-import.route',
    name: 'plugin-codex-import',
    path: '/plugin/codex-import',
    component: PluginPage
  })
}
