import Page from './view.vue'

export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) ctx.ui.registerRoute({ id: 'channel-wecom.route', name: 'channel-wecom', path: '/plugin/channel-wecom', target: 'app.view', component: Page })
}


