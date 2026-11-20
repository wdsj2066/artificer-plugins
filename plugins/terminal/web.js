import Page from './view.vue'

export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) ctx.ui.registerRoute({ id: 'terminal.route', name: 'terminal', path: '/plugin/terminal', target: 'app.view', component: Page })
  ctx.ui.registerPanel({ id: 'terminal', region: 'bottom', title: '终端', icon: 'terminal', component: Page })
}

