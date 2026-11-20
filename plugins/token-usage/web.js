import TokenUsageFooter from './TokenUsageFooter.vue'

export function register(ctx) {
  ctx.ui.registerRule({ op: 'insert', target: 'chat.input.footer', node: {
    id: 'token-usage.footer', type: 'component', component: TokenUsageFooter,
    props: (_services, scope) => ({ tokenCount: scope.tokenCount, promptTokens: scope.promptTokens, completionTokens: scope.completionTokens, cachedTokens: scope.cachedTokens, lastPromptTokens: scope.lastPromptTokens, contextWindow: scope.contextWindow })
  } })
}
