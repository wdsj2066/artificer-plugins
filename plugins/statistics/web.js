import Page from './view.vue'

export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) ctx.ui.registerRoute({ id: 'statistics.route', name: 'statistics', path: '/plugin/statistics', target: 'app.view', component: Page })
}


