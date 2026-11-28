import Page from './page.vue'

export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) {
    ctx.ui.registerRoute({
      id: 'computer-use.route',
      name: 'plugin-computer-use',
      path: '/plugin/computer-use',
      component: Page
    })
  }
}
