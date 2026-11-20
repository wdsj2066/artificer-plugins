import PluginPage from './view.vue'

/** 所有界面注册均由宿主绑定插件生命周期。 */
export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) {
    ctx.ui.registerRoute({
      id: 'terminal.route', name: 'plugin-terminal',
      path: '/plugin/terminal', component: PluginPage
    })
  }
  ctx.ui.registerPanel({
    id: "terminal",
    region: "bottom",
    title: "终端",
    icon: "terminal",
    component: PluginPage
  })
}
