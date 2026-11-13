import PluginPage from './view.vue'
import PluginPanel from './panel.vue'

/** 所有界面注册均由宿主绑定插件生命周期。 */
export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) {
    ctx.ui.registerRoute({
      id: 'scheduler.route', name: 'plugin-scheduler',
      path: '/plugin/scheduler', component: PluginPage
    })
  }
  ctx.ui.registerPanel({
    region: "right",
    title: "定时任务",
    icon: "timer",
    default: true,
    id: "scheduler",
    component: PluginPanel
  })
}
