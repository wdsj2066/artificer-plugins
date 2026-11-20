import Page from './views/App.vue'
import Panel from './views/Panel.vue'

export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) ctx.ui.registerRoute({ id: 'trace-viewer.route', name: 'trace-viewer', path: '/plugin/trace-viewer', target: 'app.view', component: Page })
  ctx.ui.registerPanel({ id: 'trace-feed', region: 'bottom', title: '运行时轨迹', icon: 'route', default: true, component: Panel })
}

