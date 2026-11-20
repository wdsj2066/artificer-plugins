import MessageActions from './msg-actions.vue'

export function register(ctx) {
  ctx.ui.registerRule({ op: 'insert', target: 'chat.messages.actions', node: {
    id: 'recipes.message-actions', type: 'component', component: MessageActions,
    props: (_services, scope) => ({ msg: scope.msg, sessionId: scope.sessionId })
  } })
}
