import { randomUUID } from 'node:crypto'
import puppeteer from 'puppeteer-core'

const FRAME_WAIT_MS = 12_000
const FRAME_POLL_MS = 200
const ACTION_TIMEOUT_MS = 15_000
const INSPECT_HTML_LIMIT = 12_000
const AX_TREE_LIMIT = 10_000
const HTML_LIMIT = 60_000

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function sameOrigin(left, right) {
  try { return new URL(left).origin === new URL(right).origin } catch { return false }
}

function describeElement(element) {
  const selectorFor = node => {
    if (!(node instanceof Element)) return ''
    if (node.id) return `#${CSS.escape(node.id)}`
    const parts = []
    let current = node
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.documentElement) {
      const tag = current.tagName.toLowerCase()
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter(item => item.tagName === current.tagName)
        : []
      parts.unshift(`${tag}${siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(current) + 1})` : ''}`)
      current = current.parentElement
      if (current?.id) {
        parts.unshift(`#${CSS.escape(current.id)}`)
        break
      }
    }
    return parts.join(' > ') || node.tagName.toLowerCase()
  }
  const rect = element.getBoundingClientRect()
  const clone = element.cloneNode(true)
  if (clone.matches?.('input,textarea,select,option,[value]')) clone.removeAttribute('value')
  if (clone.tagName === 'TEXTAREA') clone.textContent = ''
  clone.querySelectorAll('input,textarea,select,option,[value]').forEach(node => {
    node.removeAttribute('value')
    if (node.tagName === 'TEXTAREA') node.textContent = ''
  })
  const classes = typeof element.className === 'string'
    ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 12)
    : []
  return {
    selector: selectorFor(element),
    tag: element.tagName.toLowerCase(),
    id: element.id || '',
    classes,
    role: element.getAttribute('role') || '',
    text: (element.innerText || element.getAttribute('aria-label') || element.title || '').replace(/\s+/g, ' ').trim().slice(0, 500),
    html: clone.outerHTML.slice(0, 5000),
    bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    url: location.href,
    title: document.title
  }
}

function inspectDocument() {
  const visible = element => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) !== 0 &&
      rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 &&
      rect.top < innerHeight && rect.left < innerWidth
  }
  const describe = element => {
    const rect = element.getBoundingClientRect()
    const tag = element.tagName.toLowerCase()
    const label = element.getAttribute('aria-label') || element.getAttribute('title') ||
      element.labels?.[0]?.innerText || element.innerText || element.value || element.getAttribute('placeholder') || ''
    const selector = element.id
      ? `#${CSS.escape(element.id)}`
      : `${tag}${element.getAttribute('name') ? `[name="${CSS.escape(element.getAttribute('name'))}"]` : ''}`
    return {
      selector,
      tag,
      type: element.getAttribute('type') || '',
      role: element.getAttribute('role') || '',
      name: element.getAttribute('name') || '',
      text: String(label).replace(/\s+/g, ' ').trim().slice(0, 240),
      disabled: Boolean(element.disabled),
      checked: Boolean(element.checked),
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
  }
  const dialogSelector = 'dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"],[popover]:popover-open'
  const dialogs = [...document.querySelectorAll(dialogSelector)].filter(visible).slice(0, 30).map(element => ({
    ...describe(element),
    text: (element.innerText || element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 3000),
    html: element.outerHTML.slice(0, 8000),
    controls: [...element.querySelectorAll('button,input,select,textarea,[role="button"],[role="menuitem"],[role="option"],[contenteditable="true"]')]
      .filter(visible).slice(0, 100).map(describe)
  }))
  const controlSelector = 'button,input,select,textarea,a[href],[role="button"],[role="menuitem"],[role="option"],[role="checkbox"],[role="radio"],[role="switch"],[contenteditable="true"]'
  const controls = [...document.querySelectorAll(controlSelector)].filter(visible).slice(0, 250).map(describe)
  const links = [...document.querySelectorAll('a[href]')].filter(visible).slice(0, 100).map(link => ({
    text: (link.innerText || link.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    href: link.href
  }))
  return {
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
    text: (document.body?.innerText || '').slice(0, 24000),
    dialogs,
    controls,
    links
  }
}

function collectFrameIds(frameTree, previewUrl, matches = []) {
  const frame = frameTree?.frame
  if (frame?.url && sameOrigin(frame.url, previewUrl)) matches.push(frame.id)
  for (const child of frameTree?.childFrames || []) collectFrameIds(child, previewUrl, matches)
  return matches
}

function formatAccessibilityTree(nodes) {
  const byId = new Map(nodes.map(node => [node.nodeId, { ...node, children: [] }]))
  const roots = []
  for (const node of byId.values()) {
    const parent = node.parentId && byId.get(node.parentId)
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const lines = []
  const valueOf = value => {
    if (value == null) return ''
    if (typeof value === 'string') return value
    try { return JSON.stringify(value) } catch { return String(value) }
  }
  const visit = (node, depth) => {
    if (lines.length > 500) return
    const ignored = Boolean(node.ignored)
    const role = valueOf(node.role?.value)
    const name = valueOf(node.name?.value)
    const value = valueOf(node.value?.value)
    const description = valueOf(node.description?.value)
    const properties = (node.properties || [])
      .filter(item => ['focused', 'disabled', 'checked', 'expanded', 'hasPopup', 'modal', 'required', 'invalid'].includes(item.name))
      .map(item => `${item.name}=${valueOf(item.value?.value)}`)
    if (!ignored && (role || name || value || description || properties.length)) {
      const content = [role, name && `name=${name}`, value && `value=${value}`, description && `description=${description}`, ...properties]
        .filter(Boolean).join(' ')
      lines.push(`${'  '.repeat(Math.min(depth, 16))}${content}`)
    }
    for (const child of node.children) visit(child, depth + (ignored ? 0 : 1))
  }
  for (const root of roots) visit(root, 0)
  let text = lines.join('\n')
  if (text.length > AX_TREE_LIMIT) text = `${text.slice(0, AX_TREE_LIMIT)}\n[accessibility tree truncated]`
  return text
}

export class CdpAutomationRuntime {
  constructor({ rpc, previewRuntime, puppeteerAdapter = puppeteer, logger = console }) {
    this.rpc = rpc
    this.previewRuntime = previewRuntime
    this.puppeteer = puppeteerAdapter
    this.logger = logger
    this.browser = null
    this.connecting = null
    this.pages = new WeakMap()
    this.dialogs = new Map()
    this.lastError = ''
    this.started = false
    this.retryTimer = null
    this.retryDelay = 500
  }

  start() {
    if (this.started) return
    this.started = true
    void this._connect().catch(error => this._scheduleReconnect(error))
  }

  _scheduleReconnect(error) {
    if (!this.started || this.retryTimer) return
    const message = error?.message || String(error)
    if (message !== this.lastError) this.logger.warn?.(`连接 Artificer Chromium CDP 失败，将自动重试：${message}`)
    this.lastError = message
    const delayMs = this.retryDelay
    this.retryDelay = Math.min(this.retryDelay * 2, 5000)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.started) return
      void this._connect().then(() => {
        this.retryDelay = 500
      }).catch(nextError => this._scheduleReconnect(nextError))
    }, delayMs)
    this.retryTimer.unref?.()
  }

  async _connect() {
    if (this.browser?.connected) return this.browser
    if (this.connecting) return this.connecting
    this.connecting = (async () => {
      let endpoint
      try {
        endpoint = await this.rpc.call('browserAutomation.cdpEndpoint')
      } catch (error) {
        const message = error?.message || String(error)
        if (/CDP 尚未启用|DevToolsActivePort/i.test(message)) {
          throw new Error('插件的 CDP 启动入口尚未生效。请完全退出并重启 Artificer 后再试。')
        }
        throw error
      }
      const browser = await this.puppeteer.connect({
        browserURL: endpoint.browserURL,
        defaultViewport: null,
        protocolTimeout: 30_000,
        handleDevToolsAsPage: false
      })
      this.browser = browser
      this.lastError = ''
      browser.on('disconnected', () => {
        if (this.browser === browser) this.browser = null
        this.connecting = null
        this.dialogs.clear()
        if (this.started) this._scheduleReconnect(new Error('Artificer Chromium CDP 连接已断开。'))
      })
      browser.on('targetcreated', target => {
        void target.page().then(page => { if (page) this._trackPage(page) }).catch(() => {})
      })
      for (const page of await browser.pages()) this._trackPage(page)
      return browser
    })()
    try {
      return await this.connecting
    } catch (error) {
      this.lastError = error?.message || String(error)
      throw error
    } finally {
      if (!this.browser?.connected) this.connecting = null
    }
  }

  _sessionIdsForPage(page) {
    const matches = []
    for (const sessionId of this.previewRuntime.sessions.keys()) {
      const status = this.previewRuntime.getStatus(sessionId)
      if (status?.previewUrl && page.frames().some(frame => sameOrigin(frame.url(), status.previewUrl))) matches.push(sessionId)
    }
    return matches
  }

  _trackPage(page) {
    if (this.pages.has(page)) return
    const binding = { dialogListener: null, frameListener: null, closeListener: null }
    binding.frameListener = () => this._syncDialogListener(page, binding)
    binding.closeListener = () => {
      for (const [sessionId, items] of this.dialogs) {
        const remaining = items.filter(item => item.page !== page)
        if (remaining.length) this.dialogs.set(sessionId, remaining)
        else this.dialogs.delete(sessionId)
      }
    }
    page.on('frameattached', binding.frameListener)
    page.on('framenavigated', binding.frameListener)
    page.on('framedetached', binding.frameListener)
    page.once('close', binding.closeListener)
    this.pages.set(page, binding)
    this._syncDialogListener(page, binding)
  }

  _syncDialogListener(page, binding) {
    const sessionIds = this._sessionIdsForPage(page)
    if (sessionIds.length && !binding.dialogListener) {
      binding.dialogListener = dialog => {
        const currentIds = this._sessionIdsForPage(page)
        const sessionId = currentIds[0]
        if (!sessionId) {
          void dialog.dismiss().catch(() => {})
          return
        }
        const items = this.dialogs.get(sessionId) || []
        const record = {
          id: randomUUID(),
          sessionId,
          page,
          dialog,
          type: dialog.type(),
          message: dialog.message(),
          defaultValue: dialog.defaultValue(),
          createdAt: Date.now()
        }
        items.push(record)
        while (items.length > 5) items.shift()
        this.dialogs.set(sessionId, items)
      }
      page.on('dialog', binding.dialogListener)
    } else if (!sessionIds.length && binding.dialogListener) {
      page.off('dialog', binding.dialogListener)
      binding.dialogListener = null
    }
  }

  async _findPreview(sessionId, waitMs = FRAME_WAIT_MS) {
    const status = this.previewRuntime.getStatus(sessionId)
    if (!status?.previewUrl) throw new Error('当前会话尚未连接网页预览。')
    const browser = await this._connect()
    const requestedWait = Number(waitMs)
    const timeout = Number.isFinite(requestedWait) ? Math.min(Math.max(requestedWait, 0), FRAME_WAIT_MS) : FRAME_WAIT_MS
    const deadline = Date.now() + timeout
    do {
      const pages = await browser.pages()
      for (const page of pages) {
        this._trackPage(page)
        const frame = page.frames().find(item => sameOrigin(item.url(), status.previewUrl))
        if (frame) return { browser, page, frame, status }
      }
      if (Date.now() >= deadline) break
      await delay(FRAME_POLL_MS)
    } while (true)
    throw new Error('CDP 已连接，但没有找到当前会话的预览 iframe。请打开“网页预览”面板并等待页面加载。')
  }

  _pendingDialogs(sessionId) {
    return (this.dialogs.get(sessionId) || []).map(({ id, type, message, defaultValue, createdAt }) => ({
      id, type, message, defaultValue, createdAt
    }))
  }

  async inspect(sessionId) {
    const target = await this._findPreview(sessionId)
    const nativeDialogs = this._pendingDialogs(sessionId)
    if (nativeDialogs.length) {
      return {
        title: target.status.title || '',
        url: target.status.currentUrl || target.frame.url(),
        nativeDialogs,
        note: '页面存在浏览器原生对话框；读取其按钮需要先调用 browserResolveDialog。'
      }
    }
    const [result, html, accessibilityTree] = await Promise.all([
      target.frame.evaluate(inspectDocument),
      target.frame.content(),
      this._accessibilityTree(target.page, target.status.previewUrl)
    ])
    return {
      ...result,
      html: html.slice(0, INSPECT_HTML_LIMIT),
      htmlTruncated: html.length > INSPECT_HTML_LIMIT,
      accessibilityTree,
      nativeDialogs
    }
  }

  async _accessibilityTree(page, previewUrl) {
    let session
    try {
      session = await page.createCDPSession()
      const { frameTree } = await session.send('Page.getFrameTree')
      const frameIds = collectFrameIds(frameTree, previewUrl)
      if (!frameIds.length) return ''
      const { nodes } = await session.send('Accessibility.getFullAXTree', { frameId: frameIds[0] })
      return formatAccessibilityTree(nodes || [])
    } catch (error) {
      this.logger.warn?.(`读取浏览器可访问性树失败：${error.message}`)
      return ''
    } finally {
      try { await session?.detach() } catch {}
    }
  }

  async readHtml(sessionId, maxChars = 30_000) {
    const target = await this._findPreview(sessionId)
    const nativeDialogs = this._pendingDialogs(sessionId)
    if (nativeDialogs.length) return { html: '', nativeDialogs, note: '浏览器原生对话框已暂停页面脚本。' }
    const html = await target.frame.content()
    const limit = Math.min(Math.max(Number(maxChars) || 30_000, 1000), HTML_LIMIT)
    return { html: html.slice(0, limit), truncated: html.length > limit, url: target.frame.url(), title: await target.frame.title() }
  }

  async selectElement(sessionId, selector) {
    const target = await this._findPreview(sessionId)
    const selection = await target.frame.$eval(selector, describeElement)
    selection.selectedAt = Date.now()
    this.previewRuntime.recordSelection(sessionId, target.status.bridgeToken, selection)
    return { selection }
  }

  async act(sessionId, args = {}) {
    const target = await this._findPreview(sessionId)
    const selector = String(args.selector || '').trim()
    if (!selector) throw new Error('缺少目标选择器。')
    const locator = target.frame.locator(selector).setTimeout(ACTION_TIMEOUT_MS)
    const action = args.action
    if (action === 'click' || action === 'doubleClick') {
      await locator.click({ clickCount: action === 'doubleClick' ? 2 : 1 })
    } else if (action === 'type') {
      await locator.fill(String(args.value ?? ''))
    } else if (action === 'select') {
      const selected = await target.frame.select(selector, String(args.value ?? ''))
      return { action, selector, selected }
    } else if (action === 'hover') {
      await locator.hover()
    } else if (action === 'press') {
      const element = await target.frame.waitForSelector(selector, { visible: true, timeout: ACTION_TIMEOUT_MS })
      if (!element) throw new Error(`未找到可见元素：${selector}`)
      await element.focus()
      await target.page.keyboard.press(String(args.value || 'Enter'))
    } else if (action === 'scroll') {
      const amount = Number(args.value) || 600
      await locator.evaluate((element, delta) => element.scrollBy({ top: delta, behavior: 'instant' }), amount)
    } else {
      throw new Error('action 仅支持 click、doubleClick、type、select、hover、press 或 scroll。')
    }
    return { action, selector, nativeDialogs: this._pendingDialogs(sessionId) }
  }

  async mouse(sessionId, args = {}) {
    const target = await this._findPreview(sessionId)
    const action = args.action || 'click'
    if (action === 'scroll') {
      return target.frame.evaluate(({ deltaX, deltaY }) => {
        window.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' })
        return { action: 'scroll', scrollX, scrollY }
      }, { deltaX: Number(args.deltaX) || 0, deltaY: Number(args.deltaY) || 600 })
    }
    const x = Number(args.x)
    const y = Number(args.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('鼠标坐标无效。')
    const frameElement = await target.frame.frameElement()
    const bounds = await frameElement.evaluate(element => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x + element.clientLeft, y: rect.y + element.clientTop }
    })
    const point = { x: bounds.x + x, y: bounds.y + y }
    const element = await target.frame.evaluate(({ x: pointX, y: pointY }) => {
      const node = document.elementFromPoint(pointX, pointY)
      if (!node) return null
      return { tag: node.tagName.toLowerCase(), text: (node.innerText || node.getAttribute('aria-label') || '').trim().slice(0, 200) }
    }, { x, y })
    if (!element) throw new Error('坐标上没有网页元素。')
    if (action === 'move') await target.page.mouse.move(point.x, point.y)
    else if (action === 'click') await target.page.mouse.click(point.x, point.y)
    else if (action === 'doubleClick') await target.page.mouse.click(point.x, point.y, { clickCount: 2 })
    else if (action === 'rightClick') await target.page.mouse.click(point.x, point.y, { button: 'right' })
    else throw new Error('鼠标 action 仅支持 move、click、doubleClick、rightClick 或 scroll。')
    return { action, x, y, element, nativeDialogs: this._pendingDialogs(sessionId) }
  }

  async resolveDialog(sessionId, { dialogId, action, promptText } = {}) {
    if (!['accept', 'dismiss'].includes(action)) throw new Error('action 必须是 accept 或 dismiss。')
    const items = this.dialogs.get(sessionId) || []
    const index = dialogId ? items.findIndex(item => item.id === dialogId) : items.length - 1
    if (index < 0 || !items[index]) throw new Error('当前会话没有待处理的浏览器原生对话框。')
    const [record] = items.splice(index, 1)
    if (!items.length) this.dialogs.delete(sessionId)
    else this.dialogs.set(sessionId, items)
    try {
      if (action === 'accept') await record.dialog.accept(String(promptText ?? ''))
      else await record.dialog.dismiss()
      return { success: true, action, dialogId: record.id, type: record.type, message: record.message }
    } catch (error) {
      throw new Error(`处理浏览器原生对话框失败：${error.message}`)
    }
  }

  async listScreens() {
    return this.rpc.call('browserAutomation.listScreens')
  }

  async captureDesktop(displayId) {
    return this.rpc.call('browserAutomation.captureDesktop', { displayId })
  }

  status() {
    return {
      connected: Boolean(this.browser?.connected),
      error: this.lastError,
      pendingDialogs: [...this.dialogs.entries()].flatMap(([sessionId, items]) => items.map(({ id, type, message }) => ({ sessionId, id, type, message })))
    }
  }

  async dispose() {
    this.started = false
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    const browser = this.browser
    this.browser = null
    this.connecting = null
    this.dialogs.clear()
    if (browser?.connected) await browser.disconnect()
  }
}
