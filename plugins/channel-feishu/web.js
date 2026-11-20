import PluginPage from './view.vue'

/** 所有界面注册均由宿主绑定插件生命周期。 */
export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) {
    ctx.ui.registerRoute({
      id: 'channel-feishu.route', name: 'plugin-channel-feishu',
      path: '/plugin/channel-feishu', component: PluginPage
    })
  }
}
