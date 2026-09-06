import { BrowserService } from './browserService.js'

const browserOptions = {
  type: 'object', properties: {
    port: { type: 'number', description: 'Chrome DevTools 本机端口，默认 9222' },
    launch: { type: 'boolean', description: '未运行时是否启动本机 Chrome，默认 true' },
    newPage: { type: 'boolean', description: '是否新建独立页面，默认 false' }
  }
}

export function register(ctx) {
  const browserService = new BrowserService({ importModule: ctx.importModule })
  const sessionIdOf = executionContext => executionContext?.runContext?.state?.storage?.sessionId || 'default'
  ctx.registerTool({ id: 'browserNavigate', name: '浏览器导航', description: '在隔离的本机 Chrome 调试页面中打开一个 HTTP(S) 地址。后续使用 browserInspect 检查页面。', parameters: { type: 'object', properties: { url: { type: 'string' }, ...browserOptions.properties }, required: ['url'] }, tags: ['browser', 'sensitive'], handler: async (args, executionContext) => ({ success: true, ...(await browserService.navigate(sessionIdOf(executionContext), args.url, args)) }) })
  ctx.registerTool({ id: 'browserInspect', name: '检查网页', description: '读取当前页面的标题、地址、文本、链接、表单和可交互元素目录，便于确定后续 CSS 选择器。文本最多返回 24000 个字符。', parameters: browserOptions, tags: ['browser', 'readonly'], handler: async (args, executionContext) => ({ success: true, ...(await browserService.inspect(sessionIdOf(executionContext), { ...args, launch: false })) }) })
  ctx.registerTool({ id: 'browserWait', name: '等待网页状态', description: '等待页面加载完成、指定 CSS 元素出现，或指定文本出现在页面中。适合在导航或点击后确认结果。', parameters: { type: 'object', properties: { condition: { type: 'string', enum: ['load', 'selector', 'text'], description: '默认 load' }, selector: { type: 'string', description: 'condition 为 selector 时必填' }, text: { type: 'string', description: 'condition 为 text 时必填' }, timeoutMs: { type: 'number', description: '超时毫秒，默认 10000，最大 30000' }, ...browserOptions.properties } }, tags: ['browser', 'readonly'], handler: async (args, executionContext) => ({ success: true, ...(await browserService.waitFor(sessionIdOf(executionContext), args)) }) })
  ctx.registerTool({ id: 'browserAct', name: '操作网页元素', description: '通过 CSS 选择器点击、输入、选择、悬停、按键或滚动元素。涉及提交、购买、发布等外部副作用时必须先向用户确认。', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['click', 'type', 'select', 'hover', 'press', 'scroll'] }, selector: { type: 'string', description: 'scroll 未指定时滚动页面，其余操作必填' }, value: { type: 'string', description: '输入文本、选项值、按键名称或滚动像素' }, ...browserOptions.properties }, required: ['action'] }, tags: ['browser', 'sensitive'], handler: async (args, executionContext) => ({ success: true, ...(await browserService.act(sessionIdOf(executionContext), args.action, args.selector, args.value, args)) }) })
  ctx.registerTool({ id: 'browserScreenshot', name: '网页截图', description: '截取当前浏览器页面，将 PNG 保存到当前工作区并返回文件路径。可选择完整页面截图。', parameters: { type: 'object', properties: { ...browserOptions.properties, outputPath: { type: 'string', description: '相对工作区的 PNG 输出路径，可选' }, fullPage: { type: 'boolean', description: '是否截取完整可滚动页面，默认 false' } } }, tags: ['browser', 'readonly'], handler: async (args, executionContext) => ({ success: true, ...(await browserService.screenshot(sessionIdOf(executionContext), { ...args, workspaceRoot: args._workspaceDir?.root, launch: false })) }) })
  ctx.logger.info('Browser automation plugin registered')
}
