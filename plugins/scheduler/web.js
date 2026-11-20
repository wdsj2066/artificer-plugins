import Page from './view.vue'
import Panel from './panel.vue'

export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) ctx.ui.registerRoute({ id: 'scheduler.route', name: 'scheduler', path: '/plugin/scheduler', target: 'app.view', component: Page })
  ctx.ui.registerPanel({ id: 'scheduler', region: 'right', title: '定时任务', icon: 'timer', default: true, order: 30, component: Panel })
}

