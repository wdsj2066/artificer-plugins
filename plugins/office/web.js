import PptxResult from './renderers/PptxResult.vue'
import DocxResult from './renderers/DocxResult.vue'

/** 所有界面注册均由宿主绑定插件生命周期。 */
export function register(ctx) {
  ctx.ui.registerRule({
    op: 'replace', target: 'chat.messages.tool.result',
    when: (_services, scope) => scope.msg?.name === 'createPptx',
    node: {
      id: 'office.tool.createPptx', type: 'component', component: PptxResult,
      props: (_services, scope) => ({ msg: scope.msg, sessionId: scope.sessionId, toolDisplayName: scope.toolDisplayName })
    }
  })
  ctx.ui.registerRule({
    op: 'replace', target: 'chat.messages.tool.result',
    when: (_services, scope) => scope.msg?.name === 'createDocx',
    node: {
      id: 'office.tool.createDocx', type: 'component', component: DocxResult,
      props: (_services, scope) => ({ msg: scope.msg, sessionId: scope.sessionId, toolDisplayName: scope.toolDisplayName })
    }
  })
}
