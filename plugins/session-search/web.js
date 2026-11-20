import PluginPage from './views/App.vue'

/** 所有界面注册均由宿主绑定插件生命周期。 */
export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) {
    ctx.ui.registerRoute({
      id: 'session-search.route', name: 'plugin-session-search',
      path: '/plugin/session-search', component: PluginPage
    })
  }
}
