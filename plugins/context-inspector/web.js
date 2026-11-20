import PluginPage from './views/App.vue'

/** 所有界面注册均由宿主绑定插件生命周期。 */
export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) {
    ctx.ui.registerRoute({
      id: 'context-inspector.route', name: 'plugin-context-inspector',
      path: '/plugin/context-inspector', component: PluginPage
    })
  }
}
