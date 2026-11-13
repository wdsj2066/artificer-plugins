import PluginPage from './views/App.vue'
import TracePanel from './views/Panel.vue'

/** 所有界面注册均由宿主绑定插件生命周期。 */
export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) {
    ctx.ui.registerRoute({
      id: 'trace-viewer.route', name: 'plugin-trace-viewer',
      path: '/plugin/trace-viewer', component: PluginPage
    })
  }
  ctx.ui.registerPanel({
    id: "trace-feed",
    region: "bottom",
    title: "运行时轨迹",
    icon: "route",
    default: true,
    component: TracePanel
  })
}
