import Panel from './panel.vue'
import StartResult from './start-result.vue'
import ScreenshotResult from './screenshot-result.vue'

export function register(ctx) {
  ctx.ui.registerPanel({ id: 'browser', region: 'right', title: '网页预览', icon: 'globe-2', default: true, width: '40%', component: Panel })
  for (const [name, component] of [['browserStartPreview', StartResult], ['browserScreenshot', ScreenshotResult], ['browserDesktopScreenshot', ScreenshotResult]]) {
    ctx.ui.registerRule({ op: 'replace', target: 'chat.messages.tool.result', when: (_services, scope) => scope.msg?.name === name, node: { id: `browser-automation.result.${name}`, type: 'component', component, props: (_services, scope) => ({ msg: scope.msg, sessionId: scope.sessionId, toolDisplayName: scope.toolDisplayName }) } })
  }
}
