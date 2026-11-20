import Page from './views/App.vue'

export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) ctx.ui.registerRoute({ id: 'context-inspector.route', name: 'context-inspector', path: '/plugin/context-inspector', target: 'app.view', component: Page, props: services => ({ sessionId: services['ui.shellState@1']?.selectedSessionId }) })
}


