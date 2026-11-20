import PluginPanel from './panel.vue'
import StartResult from './start-result.vue'
import ScreenshotResult from './screenshot-result.vue'

/** 所有界面注册均由宿主绑定插件生命周期。 */
export function register(ctx) {
  ctx.ui.registerPanel({
    id: "browser",
    region: "right",
    title: "网页预览",
    icon: "globe-2",
    default: true,
    width: "40%",
    component: PluginPanel
  })
  ctx.ui.registerRule({
    op: 'replace', target: 'chat.messages.tool.result',
    when: (_services, scope) => scope.msg?.name === 'browserStartPreview',
    node: {
      id: 'browser-automation.tool.browserStartPreview', type: 'component', component: StartResult,
      props: (_services, scope) => ({ msg: scope.msg, sessionId: scope.sessionId, toolDisplayName: scope.toolDisplayName })
    }
  })
  ctx.ui.registerRule({
    op: 'replace', target: 'chat.messages.tool.result',
    when: (_services, scope) => scope.msg?.name === 'browserScreenshot',
    node: {
      id: 'browser-automation.tool.browserScreenshot', type: 'component', component: ScreenshotResult,
      props: (_services, scope) => ({ msg: scope.msg, sessionId: scope.sessionId, toolDisplayName: scope.toolDisplayName })
    }
  })
  ctx.ui.registerRule({
    op: 'replace', target: 'chat.messages.tool.result',
    when: (_services, scope) => scope.msg?.name === 'browserDesktopScreenshot',
    node: {
      id: 'browser-automation.tool.browserDesktopScreenshot', type: 'component', component: ScreenshotResult,
      props: (_services, scope) => ({ msg: scope.msg, sessionId: scope.sessionId, toolDisplayName: scope.toolDisplayName })
    }
  })
}
