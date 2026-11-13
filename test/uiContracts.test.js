import { describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
vi.mock('../plugins/browser-automation/panel.vue', () => ({ default: { name: 'PluginPanel' } }))
vi.mock('../plugins/browser-automation/start-result.vue', () => ({ default: { name: 'StartResult' } }))
vi.mock('../plugins/browser-automation/screenshot-result.vue', () => ({ default: { name: 'ScreenshotResult' } }))
vi.mock('../plugins/channel-feishu/view.vue', () => ({ default: { name: 'PluginPage' } }))
vi.mock('../plugins/channel-wecom/view.vue', () => ({ default: { name: 'PluginPage' } }))
vi.mock('../plugins/context-inspector/views/App.vue', () => ({ default: { name: 'PluginPage' } }))
vi.mock('../plugins/office/renderers/PptxResult.vue', () => ({ default: { name: 'PptxResult' } }))
vi.mock('../plugins/office/renderers/DocxResult.vue', () => ({ default: { name: 'DocxResult' } }))
vi.mock('../plugins/recipes/msg-actions.vue', () => ({ default: { name: 'MessageActions' } }))
vi.mock('../plugins/remote/view.vue', () => ({ default: { name: 'PluginPage' } }))
vi.mock('../plugins/scheduler/view.vue', () => ({ default: { name: 'PluginPage' } }))
vi.mock('../plugins/scheduler/panel.vue', () => ({ default: { name: 'PluginPanel' } }))
vi.mock('../plugins/session-search/views/App.vue', () => ({ default: { name: 'PluginPage' } }))
vi.mock('../plugins/statistics/view.vue', () => ({ default: { name: 'PluginPage' } }))
vi.mock('../plugins/terminal/view.vue', () => ({ default: { name: 'PluginPage' } }))
vi.mock('../plugins/token-usage/TokenUsageFooter.vue', () => ({ default: { name: 'TokenUsageFooter' } }))
vi.mock('../plugins/trace-viewer/views/App.vue', () => ({ default: { name: 'PluginPage' } }))
vi.mock('../plugins/trace-viewer/views/Panel.vue', () => ({ default: { name: 'TracePanel' } }))

const directories = readdirSync(new URL('../plugins/', import.meta.url)).filter(id =>
  existsSync(new URL(`../plugins/${id}/plugin.json`, import.meta.url)))
const manifests = directories.map(id => JSON.parse(readFileSync(new URL(`../plugins/${id}/plugin.json`, import.meta.url), 'utf8')))
const forbidden = ['view', 'toolbar', 'inputActions', 'inputFooter', 'statusBar', 'contextMenu', 'msgActions', 'sessionActions', 'panels', 'floatingPanels', 'toolRenderers', 'commandResults', 'messageRenderers', 'roundRenderers', 'components']

function context(hasRouter) {
  const routes = [], panels = [], rules = []
  return { routes, panels, rules, ctx: { ui: {
    getService: name => name === 'ui.router@1' && hasRouter ? {} : undefined,
    registerRoute: value => routes.push(value),
    registerPanel: value => panels.push(value),
    registerRule: value => rules.push(value)
  } } }
}

describe('全部官方插件的当前 UI 契约', () => {
  it.each(manifests)('$id 清单不声明旧组件路径，运行域入口都存在', manifest => {
    expect(manifest.engines.artificer).toBe('>=1.1.22')
    for (const field of forbidden) expect(manifest.ui || {}).not.toHaveProperty(field)
    expect(manifest).not.toHaveProperty('hasBackend')
    for (const entry of Object.values(manifest.entrypoints || {})) {
      expect(existsSync(resolve('plugins', manifest.id, entry))).toBe(true)
    }
  })

  it.each(manifests.filter(manifest => manifest.entrypoints?.web))('$id 使用组件对象注册，独立窗口保留面板并跳过路由', async manifest => {
    const { register } = await import(`../plugins/${manifest.id}/web.js`)
    const main = context(true), standalone = context(false)
    register(main.ctx)
    register(standalone.ctx)
    expect(main.routes.length + main.panels.length + main.rules.length).toBeGreaterThan(0)
    for (const route of main.routes) {
      expect(route.path.startsWith('/plugin/')).toBe(true)
      expect(typeof route.component).toBe('object')
    }
    for (const item of manifest.ui?.navItems || []) {
      expect(main.routes.some(route => route.path === item.route)).toBe(true)
    }
    expect(standalone.routes).toEqual([])
    expect(standalone.panels).toEqual(main.panels)
    for (const panel of main.panels) {
      expect(panel.id).toBeTruthy()
      expect(typeof panel.component).toBe('object')
    }
    for (const rule of main.rules) {
      expect(rule.node.type).toBe('component')
      expect(typeof rule.node.component).toBe('object')
      const msg = { name: rule.node.id.split('.').at(-1), result: { success: true } }
      const scope = { msg, sessionId: 'session-a', toolDisplayName: name => name, tokenCount: 42 }
      if (rule.target === 'chat.messages.tool.result') {
        expect(rule.when({}, scope)).toBe(true)
        expect(rule.when({}, {msg: { name: 'unrelated-tool' }})).toBe(false)
      }
      const props = rule.node.props({}, scope)
      if (rule.target === 'chat.input.footer') expect(props.tokenCount).toBe(42)
      else expect(props).toMatchObject({ msg, sessionId: 'session-a' })
    }
  })
})
