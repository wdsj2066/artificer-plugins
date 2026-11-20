import Page from './view.vue'

export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) ctx.ui.registerRoute({ id: 'remote.route', name: 'remote', path: '/plugin/remote', target: 'app.view', component: Page })
}


