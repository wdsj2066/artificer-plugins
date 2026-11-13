import TokenUsageFooter from './TokenUsageFooter.vue'

/** 所有界面注册均由宿主绑定插件生命周期。 */
export function register(ctx) {
  ctx.ui.registerRule({
    op: 'insert', target: 'chat.input.footer',
    node: {
      id: 'token-usage.inputFooter', type: 'component', component: TokenUsageFooter,
      props: (_services, scope) => ({ tokenCount: scope.tokenCount, promptTokens: scope.promptTokens, completionTokens: scope.completionTokens, cachedTokens: scope.cachedTokens, lastPromptTokens: scope.lastPromptTokens, contextWindow: scope.contextWindow })
    }
  })
}
