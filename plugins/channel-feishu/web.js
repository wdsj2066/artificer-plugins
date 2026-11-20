import Page from './view.vue'

export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) ctx.ui.registerRoute({ id: 'channel-feishu.route', name: 'channel-feishu', path: '/plugin/channel-feishu', target: 'app.view', component: Page })
}


