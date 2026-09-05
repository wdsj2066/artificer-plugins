import { existsSync } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'
import WebSocket from 'ws'

const DEFAULT_PORT = 9222
const MAX_TEXT_LENGTH = 24000
const DEFAULT_WAIT_TIMEOUT = 10000

function endpoint(port = DEFAULT_PORT) { return `http://127.0.0.1:${port}` }

async function getJson(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`浏览器调试端点返回 HTTP ${response.status}`)
  return response.json()
}

function chromePath() {
  const candidates = process.platform === 'win32'
    ? [
        `${process.env.PROGRAMFILES || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`
      ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
  return candidates.find(existsSync) || null
}

async function ensureBrowser(port, launch = true) {
  try { return await getJson(`${endpoint(port)}/json/version`) } catch (firstError) {
    if (!launch) throw new Error('未发现可用的本机 Chrome DevTools 实例，请先启动浏览器或允许自动启动。')
    const executable = chromePath()
    if (!executable) throw new Error('未找到 Chrome。请安装 Chrome，或以 --remote-debugging-port=9222 启动 Chromium。')
    spawn(executable, [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', 'about:blank'], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 150))
      try { return await getJson(`${endpoint(port)}/json/version`) } catch { /* wait for Chrome */ }
    }
    throw new Error('Chrome 已启动但调试端口未就绪。')
  }
}

async function cdp(wsUrl, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    const timer = setTimeout(() => { socket.terminate(); reject(new Error(`浏览器操作超时: ${method}`)) }, 15000)
    socket.once('error', error => { clearTimeout(timer); reject(error) })
    socket.once('open', () => socket.send(JSON.stringify({ id: 1, method, params })))
    socket.on('message', raw => {
      try {
        const data = JSON.parse(raw.toString())
        if (data.id !== 1) return
        clearTimeout(timer)
        socket.close()
        if (data.error) reject(new Error(data.error.message))
        else resolve(data.result || {})
      } catch (error) { clearTimeout(timer); socket.close(); reject(error) }
    })
  })
}

export class BrowserService {
  constructor() { this.targets = new Map() }

  async _target(sessionId, { port = DEFAULT_PORT, launch = true, newPage = false } = {}) {
    await ensureBrowser(port, launch)
    const existing = this.targets.get(sessionId)
    // 端口属于连接身份的一部分；测试或用户切换 DevTools 实例时不能复用旧页面。
    if (newPage || !existing || existing.port !== port) {
      // 每个会话首次使用时始终创建专用页，避免读取或改动用户已有调试标签页。
      const created = await fetch(`${endpoint(port)}/json/new?about:blank`, { method: 'PUT' })
      const target = await created.json()
      if (!target?.webSocketDebuggerUrl) throw new Error('无法创建浏览器页面。')
      this.targets.set(sessionId, { port, wsUrl: target.webSocketDebuggerUrl, targetId: target.id })
    }
    return this.targets.get(sessionId)
  }

  async navigate(sessionId, url, options = {}) {
    if (!/^https?:\/\//i.test(url)) throw new Error('仅允许导航至 http 或 https 地址。')
    const target = await this._target(sessionId, options)
    const result = await cdp(target.wsUrl, 'Page.navigate', { url })
    const wait = await this.waitFor(sessionId, { ...options, condition: 'load', launch: false, timeoutMs: options.timeoutMs || DEFAULT_WAIT_TIMEOUT })
    return { url, frameId: result.frameId, ...wait }
  }

  async inspect(sessionId, options = {}) {
    const target = await this._target(sessionId, options)
    const expression = `(() => { const visible = el => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length); const describe = el => ({ tag: el.tagName.toLowerCase(), id: el.id || undefined, name: el.getAttribute('name') || undefined, type: el.getAttribute('type') || undefined, text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.value || '').trim().slice(0, 160), selector: el.id ? '#' + CSS.escape(el.id) : el.getAttribute('name') ? el.tagName.toLowerCase() + '[name="' + CSS.escape(el.getAttribute('name')) + '"]' : undefined, disabled: !!el.disabled }); return { title: document.title, url: location.href, readyState: document.readyState, text: (document.body?.innerText || '').slice(0, ${MAX_TEXT_LENGTH}), links: [...document.querySelectorAll('a[href]')].filter(visible).slice(0, 100).map(a => ({ text: (a.innerText || a.textContent || '').trim().slice(0, 160), href: a.href })).filter(a => a.text || a.href), forms: [...document.forms].map(f => ({ action: f.action, method: f.method, fields: [...f.elements].slice(0, 30).map(describe) })), elements: [...document.querySelectorAll('button, input, select, textarea, [role="button"], [contenteditable="true"]')].filter(visible).slice(0, 100).map(describe) } })()`
    const result = await cdp(target.wsUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    return result.result?.value || {}
  }

  async act(sessionId, action, selector, value, options = {}) {
    const target = await this._target(sessionId, options)
    if (action !== 'scroll' && !selector) throw new Error(`${action} 操作需要提供 selector。`)
    const selectorLiteral = JSON.stringify(selector || '')
    const valueLiteral = JSON.stringify(value || '')
    const expressions = {
      click: `(() => { const el = document.querySelector(${selectorLiteral}); if (!el) throw new Error('未找到元素: ' + ${selectorLiteral}); el.scrollIntoView({ block: 'center' }); el.click(); return { tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 200) } })()`,
      type: `(() => { const el = document.querySelector(${selectorLiteral}); if (!el) throw new Error('未找到元素: ' + ${selectorLiteral}); if (!('value' in el)) throw new Error('目标元素不可输入'); el.focus(); el.value = ${valueLiteral}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { tag: el.tagName, valueLength: el.value.length } })()`,
      select: `(() => { const el = document.querySelector(${selectorLiteral}); if (!el) throw new Error('未找到元素: ' + ${selectorLiteral}); if (el.tagName !== 'SELECT') throw new Error('目标元素不是 select'); el.value = ${valueLiteral}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { tag: el.tagName, value: el.value } })()`,
      hover: `(() => { const el = document.querySelector(${selectorLiteral}); if (!el) throw new Error('未找到元素: ' + ${selectorLiteral}); el.scrollIntoView({ block: 'center' }); el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, view: window })); el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, view: window })); return { tag: el.tagName, text: (el.innerText || '').slice(0, 200) } })()`,
      press: `(() => { const el = document.querySelector(${selectorLiteral}); if (!el) throw new Error('未找到元素: ' + ${selectorLiteral}); el.focus(); const key = ${valueLiteral}; for (const type of ['keydown', 'keyup']) el.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true })); return { tag: el.tagName, key } })()`,
      scroll: `(() => { const el = ${selector ? `document.querySelector(${selectorLiteral})` : 'window'}; if (!el) throw new Error('未找到元素: ' + ${selectorLiteral}); const top = Number(${valueLiteral}) || 600; if (el === window) window.scrollBy({ top, behavior: 'instant' }); else el.scrollBy({ top, behavior: 'instant' }); return { scrollTop: el === window ? window.scrollY : el.scrollTop } })()`
    }
    if (!expressions[action]) throw new Error('action 仅支持 click、type、select、hover、press 或 scroll。')
    const result = await cdp(target.wsUrl, 'Runtime.evaluate', { expression: expressions[action], returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || '页面脚本执行失败')
    return result.result?.value || { action, selector }
  }

  async waitFor(sessionId, options = {}) {
    const { condition = 'load', selector, text } = options
    if (!['load', 'selector', 'text'].includes(condition)) throw new Error('condition 仅支持 load、selector 或 text。')
    if (condition === 'selector' && !selector) throw new Error('等待 selector 时必须提供 selector。')
    if (condition === 'text' && !text) throw new Error('等待 text 时必须提供 text。')
    const target = await this._target(sessionId, options)
    const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || DEFAULT_WAIT_TIMEOUT, 100), 30000)
    const deadline = Date.now() + timeoutMs
    const selectorLiteral = JSON.stringify(selector || '')
    const textLiteral = JSON.stringify(text || '')
    const expression = condition === 'load'
      ? `document.readyState === 'complete'`
      : condition === 'selector'
        ? `!!document.querySelector(${selectorLiteral})`
        : `(document.body?.innerText || '').includes(${textLiteral})`
    do {
      const result = await cdp(target.wsUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.result?.value) return { condition, waitedMs: timeoutMs - Math.max(0, deadline - Date.now()) }
      await new Promise(resolve => setTimeout(resolve, 150))
    } while (Date.now() < deadline)
    throw new Error(`等待网页 ${condition} 状态超时（${timeoutMs}ms）。`)
  }

  async screenshot(sessionId, options = {}) {
    const target = await this._target(sessionId, options)
    const result = await cdp(target.wsUrl, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!options.fullPage })
    const root = path.resolve(options.workspaceRoot || process.cwd())
    const outputPath = path.resolve(root, options.outputPath || `.artificer/browser-${Date.now()}.png`)
    const relative = path.relative(root, outputPath)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('截图输出路径超出当前工作区。')
    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, Buffer.from(result.data, 'base64'))
    return { filePath: outputPath, mimeType: 'image/png' }
  }
}

export const browserService = new BrowserService()
