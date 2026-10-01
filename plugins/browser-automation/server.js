import { BrowserPreviewRuntime } from './previewRuntime.js'

let runtime = null

function sessionIdOf(executionContext) {
  return executionContext?.runContext?.state?.storage?.sessionId || 'default'
}

function failure(error, extra = {}) {
  return { success: false, ...extra, error: error?.message || '浏览器预览操作失败。' }
}

export function register(ctx) {
  runtime = new BrowserPreviewRuntime()

  ctx.registerTool({
    id: 'browserStartPreview',
    name: '启动网页预览',
    description: '在右侧信息面板中启动网页实时预览，并自动切换到“网页预览”面板。传 htmlFile 可直接运行工作区中的 .html/.htm 文件；否则默认运行 npm run dev，从控制台截取 localhost 地址并代理实际 HTML 响应。也可传 url 接入已运行的本机 HTTP 开发服务。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '启动开发服务的命令，默认 npm run dev' },
        directory: { type: 'string', description: '工作区内的启动目录，相对路径；默认工作区根目录' },
        htmlFile: { type: 'string', description: '直接预览工作区内的 HTML 文件路径，例如 index.html 或 dist/index.html；相对工作区根目录' },
        url: { type: 'string', description: '已运行服务的本机地址，例如 http://localhost:5173/' },
        timeoutMs: { type: 'number', description: '等待服务输出本机 URL 的超时毫秒，默认 45000，最大 120000' }
      }
    },
    tags: ['browser', 'sensitive'],
    async handler(args, executionContext) {
      const sessionId = sessionIdOf(executionContext)
      try {
        const status = args.url
          ? await runtime.attach(sessionId, args.url)
          : args.htmlFile
            ? await runtime.startHtml(sessionId, args.htmlFile, args._workspaceDir?.root)
            : await runtime.start(sessionId, {
              command: args.command || 'npm run dev',
              cwd: args.directory,
              workspaceRoot: args._workspaceDir?.root,
              timeoutMs: args.timeoutMs
            })
        return { success: true, ...status }
      } catch (error) { return failure(error, { sessionId }) }
    }
  })

  ctx.registerTool({
    id: 'browserStopPreview',
    name: '停止网页预览',
    description: '停止当前会话启动的开发服务并关闭预览代理。',
    parameters: { type: 'object', properties: {} },
    tags: ['browser', 'sensitive'],
    async handler(_args, executionContext) {
      const sessionId = sessionIdOf(executionContext)
      try { return { success: true, sessionId, ...(await runtime.stop(sessionId)) } }
      catch (error) { return failure(error, { sessionId }) }
    }
  })

  ctx.registerTool({
    id: 'browserPreviewStatus',
    name: '查看网页预览状态',
    description: '读取当前会话开发服务的运行状态、预览地址和最近控制台输出。',
    parameters: { type: 'object', properties: {} },
    tags: ['browser', 'readonly'],
    async handler(_args, executionContext) {
      const sessionId = sessionIdOf(executionContext)
      return { success: true, sessionId, status: runtime.getStatus(sessionId) }
    }
  })

  ctx.registerTool({
    id: 'browserInspect',
    name: '检查预览网页',
    description: '读取当前预览页面标题、地址、正文、链接、表单控件，并识别常见的对话框、模态框、弹出层和抽屉及其可操作控件。',
    parameters: { type: 'object', properties: {} },
    tags: ['browser', 'readonly'],
    async handler(_args, executionContext) {
      const sessionId = sessionIdOf(executionContext)
      try { return { success: true, sessionId, ...(await runtime.runInPage(sessionId, 'inspect')) } }
      catch (error) { return failure(error, { sessionId }) }
    }
  })

  ctx.registerTool({
    id: 'browserScreenshot',
    name: '网页截图',
    description: '截取当前预览 iframe 中的网页当前视口或完整页面。截图会显示在工具结果卡片中，可另存为 JPG；它不包含 Artificer 外层界面。',
    parameters: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['viewport', 'fullPage'], description: 'viewport 截取当前可视区域；fullPage 截取完整网页，默认 viewport' } }
    },
    tags: ['browser', 'readonly'],
    async handler(args, executionContext) {
      const sessionId = sessionIdOf(executionContext)
      try {
        const screenshot = await runtime.runInPage(sessionId, 'screenshot', { mode: args.mode === 'fullPage' ? 'fullPage' : 'viewport' }, 60_000)
        const screenshotId = runtime.storeScreenshot(sessionId, screenshot)
        return {
          success: true, sessionId, screenshotId, title: screenshot.title, url: screenshot.url,
          width: screenshot.width, height: screenshot.height, mode: screenshot.mode
        }
      } catch (error) { return failure(error, { sessionId }) }
    }
  })

  ctx.registerTool({
    id: 'browserReadHtml',
    name: '读取网页 HTML',
    description: '读取代理拦截到的开发服务器 HTML 响应，并请求当前预览页已渲染的 DOM HTML。最多返回 60000 个字符。',
    parameters: { type: 'object', properties: { maxChars: { type: 'number', description: 'HTML 字符上限，默认 30000，最大 60000' } } },
    tags: ['browser', 'readonly'],
    async handler(args, executionContext) {
      const sessionId = sessionIdOf(executionContext)
      try {
        const response = runtime.readHtml(sessionId, args.maxChars)
        const status = runtime.getStatus(sessionId)
        let renderedDom = null
        if (status?.bridgeReady) {
          try { renderedDom = await runtime.runInPage(sessionId, 'readHtml', { maxChars: args.maxChars }) }
          catch (error) { renderedDom = { error: error.message } }
        }
        return { success: true, sessionId, ...response, renderedDom }
      } catch (error) { return failure(error, { sessionId }) }
    }
  })

  ctx.registerTool({
    id: 'browserSelectElement',
    name: '选择预览元素',
    description: '按 CSS 选择器读取预览页中的元素，并静默更新当前选中项，不弹出用户详情窗；可继续读取元素信息或把元素作为聊天上下文。',
    parameters: { type: 'object', properties: { selector: { type: 'string', description: 'CSS 选择器，例如 #hero 或 main .card' } }, required: ['selector'] },
    tags: ['browser', 'readonly'],
    async handler(args, executionContext) {
      const sessionId = sessionIdOf(executionContext)
      try { return { success: true, sessionId, ...(await runtime.runInPage(sessionId, 'selectElement', { selector: args.selector })) } }
      catch (error) { return failure(error, { sessionId }) }
    }
  })

  ctx.registerTool({
    id: 'browserAct',
    name: '操作预览网页元素',
    description: '在当前预览页中按 CSS 选择器点击、输入、下拉选择、悬停、按键或滚动元素。提交、购买、发布等外部副作用必须先向用户确认。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['click', 'doubleClick', 'type', 'select', 'hover', 'press', 'scroll'] },
        selector: { type: 'string', description: '目标元素的 CSS 选择器' },
        value: { type: 'string', description: '输入文字、选项值、按键名称或滚动像素' }
      },
      required: ['action', 'selector']
    },
    tags: ['browser', 'sensitive'],
    async handler(args, executionContext) {
      const sessionId = sessionIdOf(executionContext)
      try { return { success: true, sessionId, ...(await runtime.runInPage(sessionId, 'act', args)) }
      } catch (error) { return failure(error, { sessionId }) }
    }
  })

  ctx.registerTool({
    id: 'browserMouse',
    name: '控制预览页鼠标',
    description: '按预览页面的 CSS 像素坐标移动鼠标、单击、双击、右击或滚动，用于多步网页自动化。滚动可只传 action 和 deltaY；其他动作需要 x/y。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['move', 'click', 'doubleClick', 'rightClick', 'scroll'] },
        x: { type: 'number', description: '视口内横坐标' },
        y: { type: 'number', description: '视口内纵坐标' },
        deltaX: { type: 'number', description: '横向滚动像素' },
        deltaY: { type: 'number', description: '纵向滚动像素' }
      },
      required: ['action']
    },
    tags: ['browser', 'sensitive'],
    async handler(args, executionContext) {
      const sessionId = sessionIdOf(executionContext)
      try { return { success: true, sessionId, ...(await runtime.runInPage(sessionId, 'mouse', args)) } }
      catch (error) { return failure(error, { sessionId }) }
    }
  })

  ctx.registerTool({
    id: 'browserGetSelection',
    name: '读取选中网页元素',
    description: '读取用户在信息面板实时预览中框选或点击选中的元素信息与 HTML。',
    parameters: { type: 'object', properties: {} },
    tags: ['browser', 'readonly'],
    async handler(_args, executionContext) {
      const sessionId = sessionIdOf(executionContext)
      return { success: true, sessionId, selection: runtime.getSelection(sessionId) }
    }
  })

  ctx.registerRoute({
    method: 'GET', path: '/api/plugins/browser-automation/activity',
    async handler() { return { success: true, data: { activity: runtime.getLatestActivity() } } }
  })

  ctx.registerRoute({
    method: 'GET', path: '/api/plugins/browser-automation/status',
    async handler({ query }) {
      const sessionId = String(query?.sessionId || '')
      if (!sessionId) return { success: false, error: '缺少会话 ID。' }
      return { success: true, data: { status: runtime.getStatus(sessionId) } }
    }
  })

  ctx.registerRoute({
    method: 'POST', path: '/api/plugins/browser-automation/start',
    async handler({ body }) {
      const sessionId = String(body?.sessionId || '')
      if (!sessionId || !body?.url) return { success: false, error: '需要会话 ID 和本机开发服务地址。' }
      try { return { success: true, data: await runtime.attach(sessionId, body.url) } }
      catch (error) { return failure(error) }
    }
  })

  ctx.registerRoute({
    method: 'POST', path: '/api/plugins/browser-automation/stop',
    async handler({ body }) {
      const sessionId = String(body?.sessionId || '')
      if (!sessionId) return { success: false, error: '缺少会话 ID。' }
      try { return { success: true, data: await runtime.stop(sessionId) } }
      catch (error) { return failure(error) }
    }
  })

  ctx.registerRoute({
    method: 'POST', path: '/api/plugins/browser-automation/screenshot',
    async handler({ body }) {
      const sessionId = String(body?.sessionId || '')
      const mode = body?.mode === 'fullPage' ? 'fullPage' : 'viewport'
      if (!sessionId) return { success: false, error: '缺少会话 ID。' }
      try {
        const screenshot = await runtime.runInPage(sessionId, 'screenshot', { mode }, 60_000)
        return { success: true, data: screenshot }
      } catch (error) { return failure(error) }
    }
  })

  ctx.registerRoute({
    method: 'GET', path: '/api/plugins/browser-automation/screenshot/image',
    async handler({ query }) {
      const sessionId = String(query?.sessionId || '')
      const screenshotId = String(query?.screenshotId || '')
      if (!sessionId || !screenshotId) return { success: false, error: '需要会话 ID 和截图 ID。' }
      try { return { success: true, data: { dataUrl: runtime.getScreenshot(sessionId, screenshotId).dataUrl } } }
      catch (error) { return failure(error) }
    }
  })

  ctx.registerRoute({
    method: 'GET', path: '/api/plugins/browser-automation/html',
    async handler({ query }) {
      const sessionId = String(query?.sessionId || '')
      if (!sessionId) return { success: false, error: '缺少会话 ID。' }
      try { return { success: true, data: runtime.readHtml(sessionId, query?.maxChars) } }
      catch (error) { return failure(error) }
    }
  })

  ctx.registerRoute({
    method: 'GET', path: '/api/plugins/browser-automation/bridge/commands',
    async handler({ query }) {
      const sessionId = String(query?.sessionId || '')
      if (!sessionId) return { success: false, error: '缺少会话 ID。' }
      return { success: true, data: { commands: runtime.getCommands(sessionId) } }
    }
  })

  ctx.registerRoute({
    method: 'POST', path: '/api/plugins/browser-automation/bridge/ready',
    async handler({ body }) {
      const ok = runtime.setBridgeReady(String(body?.sessionId || ''), String(body?.token || ''), body || {})
      return ok ? { success: true } : { success: false, error: '浏览器预览令牌无效。' }
    }
  })

  ctx.registerRoute({
    method: 'POST', path: '/api/plugins/browser-automation/bridge/selection',
    async handler({ body }) {
      try {
        const selection = runtime.recordSelection(String(body?.sessionId || ''), String(body?.token || ''), body?.selection)
        return { success: true, data: { selection } }
      } catch (error) { return failure(error) }
    }
  })

  ctx.registerRoute({
    method: 'POST', path: '/api/plugins/browser-automation/bridge/result',
    async handler({ body }) {
      const accepted = runtime.receiveResult(String(body?.sessionId || ''), body || {})
      return { success: true, data: { accepted } }
    }
  })

  ctx.logger.info('Browser preview and automation plugin registered')
}

export async function onDisable() {
  await runtime?.stopAll()
}
