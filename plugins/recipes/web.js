import MessageActions from './msg-actions.vue'

/** 所有界面注册均由宿主绑定插件生命周期。 */
export function register(ctx) {
  ctx.ui.registerRule({
    op: 'insert', target: 'chat.messages.actions',
    node: {
      id: 'recipes.msgActions', type: 'component', component: MessageActions,
      props: (_services, scope) => ({ msg: scope.msg, sessionId: scope.sessionId })
    }
  })
}
