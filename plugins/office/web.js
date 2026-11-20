import DocxResult from './renderers/DocxResult.vue'
import PptxResult from './renderers/PptxResult.vue'

export function register(ctx) {
  for (const [name, component] of [['createDocx', DocxResult], ['createPptx', PptxResult]]) {
    ctx.ui.registerRule({ op: 'replace', target: 'chat.messages.tool.result', when: (_services, scope) => scope.msg?.name === name, node: { id: `office.result.${name}`, type: 'component', component, props: (_services, scope) => ({ msg: scope.msg, toolDisplayName: scope.toolDisplayName }) } })
  }
}
