import PageWrapper from './PageWrapper.vue'

export function register(ctx) {
  ctx.ui.registerRule({
    op: 'wrap',
    target: 'route.skills.page',
    node: {
      id: 'skillhub-market.page-wrapper',
      type: 'component',
      component: PageWrapper,
      props: (_services, scope) => ({ msg: scope.msg, sessionId: scope.sessionId })
    }
  })
}
