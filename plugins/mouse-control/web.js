import Page from './page.vue'

export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) {
    ctx.ui.registerRoute({
      id: 'mouse-control.route',
      name: 'plugin-mouse-control',
      path: '/plugin/mouse-control',
      component: Page
    })
  }
}
