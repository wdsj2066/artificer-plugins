import { spawn } from 'child_process'
import { createServer } from 'http'
import net from 'net'
import path from 'path'
import { createReadStream, existsSync, realpathSync, statSync } from 'fs'
import { randomUUID } from 'crypto'

const MAX_OUTPUT_BYTES = 64 * 1024
const MAX_HTML_BYTES = 2 * 1024 * 1024
const DEFAULT_COMMAND_TIMEOUT = 20_000
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8'
}

function loopbackUrl(input) {
  let url
  try { url = new URL(input) } catch { throw new Error('开发服务地址无效。') }
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase())) {
    throw new Error('预览代理只连接本机 HTTP 开发服务（localhost、127.0.0.1 或 ::1）。')
  }
  if (url.username || url.password) throw new Error('开发服务地址不能包含用户名或密码。')
  return url
}

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
}

function bridgeScript(token) {
  return `(() => {
    const TOKEN = ${JSON.stringify(token)};
    const SOURCE = 'artificer-browser-preview';
    let selecting = false;
    let preferredTag = 'div';
    let hovered = null;
    const overlayHost = document.createElement('div');
    overlayHost.setAttribute('data-artificer-browser-overlay', '');
    Object.assign(overlayHost.style, { position: 'fixed', inset: '0', zIndex: '2147483647', pointerEvents: 'none' });
    const shadow = overlayHost.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<style>.box{position:fixed;border:2px solid #7c5cff;background:rgba(124,92,255,.12);box-sizing:border-box;pointer-events:none}.label{position:fixed;max-width:80vw;padding:2px 5px;background:#7c5cff;color:#fff;font:11px/1.4 sans-serif;border-radius:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}</style><div class="box"></div><div class="label"></div>';
    const box = shadow.querySelector('.box');
    const label = shadow.querySelector('.label');
    const send = (type, data = {}) => window.parent.postMessage({ source: SOURCE, token: TOKEN, type, ...data }, '*');
    const announceReady = () => {
      if (document.documentElement && !overlayHost.isConnected) document.documentElement.appendChild(overlayHost);
      send('ready', { url: location.href, title: document.title });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', announceReady, { once: true });
    else announceReady();
    const escape = value => CSS.escape(value);
    const selectorFor = element => {
      const parts = [];
      let current = element;
      while (current && current.nodeType === 1 && current !== document.documentElement) {
        if (current.id) { parts.unshift('#' + escape(current.id)); break; }
        const name = current.tagName.toLowerCase();
        const siblings = current.parentElement ? [...current.parentElement.children].filter(node => node.tagName === current.tagName) : [];
        parts.unshift(name + (siblings.length > 1 ? ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : ''));
        current = current.parentElement;
      }
      return parts.join(' > ') || element.tagName.toLowerCase();
    };
    const pick = element => {
      if (!element || element === overlayHost || overlayHost.contains(element)) return null;
      return preferredTag === 'any' ? element : (element.closest(preferredTag) || element);
    };
    const showHover = element => {
      hovered = pick(element);
      if (!hovered) { box.style.display = label.style.display = 'none'; return; }
      const rect = hovered.getBoundingClientRect();
      Object.assign(box.style, { display: 'block', left: rect.x + 'px', top: rect.y + 'px', width: rect.width + 'px', height: rect.height + 'px' });
      Object.assign(label.style, { display: 'block', left: rect.x + 'px', top: Math.max(0, rect.y - 19) + 'px' });
      label.textContent = selectorFor(hovered);
    };
    const describe = element => {
      const rect = element.getBoundingClientRect();
      const clone = element.cloneNode(true);
      if (clone.matches?.('input,textarea,select,option,[value]')) clone.removeAttribute('value');
      if (clone.tagName === 'TEXTAREA') clone.textContent = '';
      clone.querySelectorAll('input,textarea,select,option').forEach(node => {
        node.removeAttribute('value');
        if (node.tagName === 'TEXTAREA') node.textContent = '';
      });
      clone.querySelectorAll('[value]').forEach(node => node.removeAttribute('value'));
      const classes = typeof element.className === 'string' ? element.className.trim().split(/\\s+/).filter(Boolean).slice(0, 12) : [];
      return {
        selector: selectorFor(element), tag: element.tagName.toLowerCase(), id: element.id || '', classes,
        role: element.getAttribute('role') || '',
        text: (element.innerText || element.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 500),
        html: clone.outerHTML.slice(0, 5000),
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        viewport: { width: window.innerWidth, height: window.innerHeight }, url: location.href, title: document.title
      };
    };
    document.addEventListener('mousemove', event => { if (selecting) showHover(event.target); }, true);
    document.addEventListener('scroll', () => { if (selecting && hovered) showHover(hovered); }, true);
    window.addEventListener('resize', () => { if (selecting && hovered) showHover(hovered); });
    document.addEventListener('click', event => {
      if (!selecting) return;
      const element = pick(event.target);
      if (!element) return;
      event.preventDefault(); event.stopImmediatePropagation(); event.stopPropagation();
      selecting = false;
      showHover(element);
      send('selection', { selection: describe(element) });
    }, true);
    const find = selector => {
      const element = document.querySelector(selector);
      if (!element) throw new Error('未找到元素: ' + selector);
      return element;
    };
    const clickElement = (element, detail = 1, button = 0, point = null, scrollIntoView = true) => {
      if (scrollIntoView) element.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = element.getBoundingClientRect();
      const clientX = point?.x ?? rect.x + rect.width / 2;
      const clientY = point?.y ?? rect.y + rect.height / 2;
      for (let click = 1; click <= detail; click++) {
        const init = { bubbles: true, cancelable: true, view: window, clientX, clientY, button, buttons: button === 0 ? 1 : 2, detail: click };
        element.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        element.dispatchEvent(new MouseEvent('mousedown', init));
        element.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 0 }));
        element.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
        element.dispatchEvent(new MouseEvent('click', init));
      }
      if (detail > 1) element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window, clientX, clientY, button, buttons: 0, detail: 2 }));
      return { selector: selectorFor(element), tag: element.tagName.toLowerCase(), text: (element.innerText || '').trim().slice(0, 200), x: clientX, y: clientY };
    };
    const run = async command => {
      const args = command.args || {};
      switch (command.type) {
        case 'inspect': {
          const visible = element => !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
          const describeControl = element => ({ tag: element.tagName.toLowerCase(), id: element.id || '', name: element.getAttribute('name') || '', type: element.getAttribute('type') || '', text: (element.innerText || element.getAttribute('aria-label') || element.title || '').trim().slice(0, 120), selector: selectorFor(element), disabled: !!element.disabled });
          return { title: document.title, url: location.href, readyState: document.readyState, text: (document.body?.innerText || '').slice(0, 16000), links: [...document.querySelectorAll('a[href]')].filter(visible).slice(0, 60).map(a => ({ text: (a.innerText || a.textContent || '').trim().slice(0, 120), href: a.href })), elements: [...document.querySelectorAll('button,input,select,textarea,[role="button"],[contenteditable="true"]')].filter(visible).slice(0, 80).map(describeControl) };
        }
        case 'readHtml': return { html: document.documentElement?.outerHTML?.slice(0, Math.min(Number(args.maxChars) || 30000, 60000)) || '' };
        case 'selectElement': return { selection: describe(find(args.selector)) };
        case 'act': {
          const element = find(args.selector || 'body');
          const action = args.action;
          if (action === 'click') return clickElement(element);
          if (action === 'doubleClick') return clickElement(element, 2);
          if (action === 'hover') { const rect = element.getBoundingClientRect(); element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: rect.x, clientY: rect.y, view: window })); return { selector: selectorFor(element) }; }
          if (action === 'type') {
            if (!('value' in element) && !element.isContentEditable) throw new Error('目标元素不可输入。');
            element.focus();
            if (element.isContentEditable) element.textContent = String(args.value ?? '');
            else { const proto = Object.getPrototypeOf(element); const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set; setter ? setter.call(element, String(args.value ?? '')) : (element.value = String(args.value ?? '')); }
            element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: String(args.value ?? '') }));
            element.dispatchEvent(new Event('change', { bubbles: true }));
            return { selector: selectorFor(element), valueLength: String(args.value ?? '').length };
          }
          if (action === 'select') { if (element.tagName !== 'SELECT') throw new Error('目标元素不是 select。'); element.value = String(args.value ?? ''); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); return { selector: selectorFor(element), value: element.value }; }
          if (action === 'press') { element.focus(); for (const type of ['keydown', 'keyup']) element.dispatchEvent(new KeyboardEvent(type, { key: String(args.value || 'Enter'), code: String(args.value || 'Enter'), bubbles: true })); return { selector: selectorFor(element), key: String(args.value || 'Enter') }; }
          if (action === 'scroll') { element.scrollBy({ top: Number(args.value) || 600, behavior: 'instant' }); return { selector: selectorFor(element), scrollTop: element.scrollTop }; }
          throw new Error('action 仅支持 click、doubleClick、type、select、hover、press 或 scroll。');
        }
        case 'mouse': {
          const action = args.action || 'click';
          if (action === 'scroll') { window.scrollBy({ top: Number(args.deltaY) || 600, left: Number(args.deltaX) || 0, behavior: 'instant' }); return { action, scrollY: window.scrollY }; }
          const x = Number(args.x), y = Number(args.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('鼠标坐标无效。');
          const element = document.elementFromPoint(x, y);
          if (!element) throw new Error('坐标上没有网页元素。');
          if (action === 'move') {
            const init = { bubbles: true, clientX: x, clientY: y, view: window };
            element.dispatchEvent(new PointerEvent('pointermove', { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
            element.dispatchEvent(new MouseEvent('mousemove', init));
            element.dispatchEvent(new MouseEvent('mouseover', init));
            return { action, x, y, selector: selectorFor(element) };
          }
          if (!['click', 'doubleClick', 'rightClick'].includes(action)) throw new Error('鼠标 action 仅支持 move、click、doubleClick、rightClick 或 scroll。');
          if (action === 'rightClick') {
            const init = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 2, buttons: 0 };
            element.dispatchEvent(new MouseEvent('contextmenu', init));
            return { action, x, y, selector: selectorFor(element) };
          }
          return { action, ...clickElement(element, action === 'doubleClick' ? 2 : 1, 0, { x, y }, false) };
        }
        default: throw new Error('未知浏览器命令: ' + command.type);
      }
    };
    window.addEventListener('message', async event => {
      const data = event.data;
      if (event.source !== window.parent || !data || data.source !== SOURCE || data.token !== TOKEN) return;
      if (data.type === 'select-mode') { selecting = !!data.enabled; preferredTag = ['div','section','article','main','any'].includes(data.preferTag) ? data.preferTag : 'div'; if (!selecting) showHover(null); return; }
      if (data.type === 'command') {
        try { send('command-result', { id: data.command.id, success: true, result: await run(data.command) }); }
        catch (error) { send('command-result', { id: data.command.id, success: false, error: error?.message || String(error) }); }
      }
    });
  })();`
}

function stripHopHeaders(headers) {
  const result = { ...headers }
  for (const name of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade']) delete result[name]
  delete result['content-security-policy']
  delete result['content-security-policy-report-only']
  delete result['x-frame-options']
  delete result['content-length']
  delete result.etag
  return result
}

export class BrowserPreviewRuntime {
  constructor({ onActivity = () => {} } = {}) {
    this.sessions = new Map()
    this.latestActivity = null
    this.onActivity = onActivity
  }

  _session(sessionId) {
    if (!sessionId) throw new Error('缺少会话 ID。')
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = {
        sessionId, process: null, staticServer: null, command: '', cwd: '', output: '', upstreamUrl: '', previewUrl: '',
        proxy: null, proxySockets: new Set(), connectingUrl: '', html: '', htmlPath: '', htmlTruncated: false, bridgeToken: randomUUID(), bridgeReady: false,
        selection: null, pending: new Map()
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  _appendOutput(state, chunk) {
    state.output = (state.output + stripAnsi(String(chunk))).slice(-MAX_OUTPUT_BYTES)
    const match = state.output.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/[^\s]*)?/i)
    if (match && !state.upstreamUrl && !state.connectingUrl) {
      const candidate = match[0].replace(/[),.;]+$/, '')
      state.connectingUrl = candidate
      void this.attach(state.sessionId, candidate)
        .catch(error => { state.output += `\n预览连接失败：${error.message}` })
        .finally(() => { state.connectingUrl = '' })
    }
  }

  async start(sessionId, { command = 'npm run dev', cwd, workspaceRoot, timeoutMs = 45_000 } = {}) {
    if (!workspaceRoot || !existsSync(workspaceRoot)) throw new Error('当前会话没有可用的工作区目录。')
    await this.stop(sessionId)
    const root = realpathSync(workspaceRoot)
    const requestedCwd = path.resolve(root, cwd || '.')
    const workingDirectory = realpathSync(requestedCwd)
    const relative = path.relative(root, workingDirectory)
    if (!statSync(workingDirectory).isDirectory() || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('启动目录必须位于当前工作区内。')
    }
    if (typeof command !== 'string' || !command.trim()) throw new Error('启动命令不能为空。')

    const state = this._session(sessionId)
    state.command = command.trim()
    state.cwd = workingDirectory
    state.output = ''
    state.upstreamUrl = ''
    state.previewUrl = ''
    state.html = ''
    state.htmlTruncated = false
    state.selection = null
    state.bridgeReady = false

    const child = spawn(state.command, {
      cwd: workingDirectory,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BROWSER: 'none', FORCE_COLOR: '0' }
    })
    state.process = child

    let settled = false
    let resolveReady
    let rejectReady
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    const maybeReady = () => {
      if (state.previewUrl && !settled) {
        settled = true
        resolveReady(this.getStatus(sessionId))
      }
    }
    state.resolveReady = maybeReady
    child.stdout.on('data', chunk => { this._appendOutput(state, chunk); maybeReady() })
    child.stderr.on('data', chunk => { this._appendOutput(state, chunk); maybeReady() })
    child.once('error', error => { if (!settled) { settled = true; rejectReady(error) } })
    child.once('exit', (code, signal) => {
      if (state.process === child) state.process = null
      if (!settled) { settled = true; rejectReady(new Error(`开发服务已退出（${signal || code}），尚未检测到本机预览地址。\n${state.output.slice(-4000)}`)) }
    })

    const timer = setTimeout(() => {
      if (!settled) { settled = true; rejectReady(new Error(`等待开发服务地址超时（${timeoutMs}ms）。\n${state.output.slice(-4000)}`)) }
    }, Math.min(Math.max(Number(timeoutMs) || 45_000, 1000), 120_000))
    try {
      const result = await ready
      return { ...result, output: state.output }
    } catch (error) {
      await this.stop(sessionId)
      throw error
    } finally {
      clearTimeout(timer)
      delete state.resolveReady
    }
  }

  async startHtml(sessionId, htmlFile, workspaceRoot) {
    if (!workspaceRoot || !existsSync(workspaceRoot)) throw new Error('当前会话没有可用的工作区目录。')
    await this.stop(sessionId)
    const root = realpathSync(workspaceRoot)
    const requestedFile = path.resolve(root, String(htmlFile || ''))
    let filePath
    try { filePath = realpathSync(requestedFile) }
    catch { throw new Error(`找不到 HTML 文件：${String(htmlFile || '')}`) }
    const relativeFile = path.relative(root, filePath)
    if (relativeFile.startsWith('..') || path.isAbsolute(relativeFile) || !statSync(filePath).isFile()) {
      throw new Error('HTML 文件必须位于当前工作区内。')
    }
    if (!['.html', '.htm'].includes(path.extname(filePath).toLowerCase())) {
      throw new Error('直接预览的文件必须是 .html 或 .htm。')
    }

    const state = this._session(sessionId)
    state.command = `静态 HTML：${relativeFile}`
    state.cwd = root
    state.output = ''
    const staticServer = createServer((req, res) => {
      if (!['GET', 'HEAD'].includes(req.method || '')) {
        res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return
      }
      let requestedPath
      try { requestedPath = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname) }
      catch { res.writeHead(400); res.end(); return }
      const candidate = path.resolve(root, `.${requestedPath}`)
      const rel = path.relative(root, candidate)
      if (rel.startsWith('..') || path.isAbsolute(rel)) { res.writeHead(403); res.end(); return }
      let actual
      try {
        actual = realpathSync(candidate)
        const actualRelative = path.relative(root, actual)
        if (actualRelative.startsWith('..') || path.isAbsolute(actualRelative) || !statSync(actual).isFile()) throw new Error('not a file')
      } catch { res.writeHead(404); res.end('Not found'); return }
      const stat = statSync(actual)
      res.writeHead(200, {
        'content-type': MIME_TYPES[path.extname(actual).toLowerCase()] || 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': 'no-store'
      })
      if (req.method === 'HEAD') { res.end(); return }
      createReadStream(actual).on('error', () => res.destroy()).pipe(res)
    })
    state.staticServer = staticServer
    try {
      await new Promise((resolve, reject) => {
        const onError = error => { staticServer.off('listening', onListening); reject(error) }
        const onListening = () => { staticServer.off('error', onError); resolve() }
        staticServer.once('error', onError)
        staticServer.once('listening', onListening)
        staticServer.listen(0, '127.0.0.1')
      })
    } catch (error) {
      state.staticServer = null
      if (staticServer.listening) await new Promise(resolve => staticServer.close(() => resolve()))
      throw new Error(`无法启动本地 HTML 文件服务：${error.message}`)
    }
    const { port } = staticServer.address()
    try {
      return await this.attach(sessionId, `http://127.0.0.1:${port}/${relativeFile.split(path.sep).map(encodeURIComponent).join('/')}`)
    } catch (error) {
      await this.stop(sessionId)
      throw error
    }
  }

  async attach(sessionId, address) {
    const url = loopbackUrl(address)
    const state = this._session(sessionId)
    await this._closeProxy(state)
    state.upstreamUrl = url.href
    state.bridgeToken = randomUUID()
    state.bridgeReady = false
    state.selection = null
    state.html = ''
    state.htmlTruncated = false
    state.htmlPath = ''
    const proxy = createServer((req, res) => { void this._proxyRequest(state, req, res) })
    proxy.on('connection', socket => {
      state.proxySockets.add(socket)
      socket.once('close', () => state.proxySockets.delete(socket))
    })
    proxy.on('upgrade', (req, socket, head) => this._proxyUpgrade(state, req, socket, head))
    await new Promise((resolve, reject) => {
      proxy.once('error', reject)
      proxy.listen(0, '127.0.0.1', resolve)
    })
    state.proxy = proxy
    const { port } = proxy.address()
    state.previewUrl = `http://127.0.0.1:${port}${url.pathname}${url.search}`
    try {
      const response = await fetch(state.previewUrl, { signal: AbortSignal.timeout(5000), cache: 'no-store' })
      await response.arrayBuffer()
    } catch (error) {
      await this._closeProxy(state)
      state.previewUrl = ''
      state.upstreamUrl = ''
      throw new Error(`无法连接本机开发服务：${error.message}`)
    }
    this.latestActivity = { id: randomUUID(), sessionId, url: state.previewUrl, upstreamUrl: url.href, createdAt: Date.now() }
    this.onActivity(this.latestActivity)
    state.resolveReady?.()
    return this.getStatus(sessionId)
  }

  async _proxyRequest(state, req, res) {
    if (req.url === '/__artificer_browser_bridge.js') {
      const body = bridgeScript(state.bridgeToken)
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
      res.end(body)
      return
    }

    let upstreamUrl
    try {
      upstreamUrl = new URL(req.url || '/', state.upstreamUrl)
      if (upstreamUrl.origin !== new URL(state.upstreamUrl).origin) throw new Error('跨域地址')
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); res.end('无效的预览代理路径'); return
    }

    const headers = { ...req.headers, host: upstreamUrl.host, 'accept-encoding': 'identity' }
    if (headers.origin) headers.origin = new URL(state.upstreamUrl).origin
    const upstream = await import('http')
    const request = upstream.request(upstreamUrl, { method: req.method, headers }, response => {
      const responseHeaders = stripHopHeaders(response.headers)
      const location = response.headers.location
      if (location) {
        try {
          const redirected = new URL(location, state.upstreamUrl)
          if (redirected.origin === new URL(state.upstreamUrl).origin) responseHeaders.location = `${new URL(state.previewUrl).origin}${redirected.pathname}${redirected.search}${redirected.hash}`
        } catch { /* 保留外部重定向 */ }
      }
      if (response.headers['set-cookie']) responseHeaders['set-cookie'] = response.headers['set-cookie'].map(cookie => cookie.replace(/;\s*domain=[^;]+/ig, ''))
      const isHtml = String(response.headers['content-type'] || '').toLowerCase().includes('text/html')
      if (!isHtml) {
        res.writeHead(response.statusCode || 502, response.statusMessage, responseHeaders)
        response.pipe(res)
        return
      }

      state.html = ''
      state.htmlTruncated = false
      state.htmlPath = `${upstreamUrl.pathname}${upstreamUrl.search}`
      const chunks = []
      let size = 0
      let streaming = false
      response.on('data', chunk => {
        size += chunk.length
        if (streaming) { res.write(chunk); return }
        chunks.push(chunk)
        if (size > MAX_HTML_BYTES) {
          streaming = true
          state.html = Buffer.concat(chunks).toString('utf8').slice(0, MAX_HTML_BYTES)
          state.htmlTruncated = true
          res.writeHead(response.statusCode || 502, response.statusMessage, responseHeaders)
          for (const part of chunks) res.write(part)
          chunks.length = 0
        }
      })
      response.on('end', () => {
        if (streaming) { res.end(); return }
        const source = Buffer.concat(chunks).toString('utf8')
        state.html = source.slice(0, MAX_HTML_BYTES)
        state.htmlTruncated = source.length > MAX_HTML_BYTES
        const script = '<script src="/__artificer_browser_bridge.js"></script>'
        const transformed = source
          .replace(/<meta\b[^>]*http-equiv=["']?content-security-policy["']?[^>]*>/ig, '')
          .replace(/<head\b[^>]*>/i, match => `${match}${script}`)
          .replace(/<\/head\s*>/i, match => `${match}`)
        const body = transformed === source ? `${script}${source}` : transformed
        responseHeaders['content-length'] = Buffer.byteLength(body)
        res.writeHead(response.statusCode || 200, response.statusMessage, responseHeaders)
        res.end(body)
      })
    })
    request.on('error', error => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`无法连接本机开发服务：${error.message}`)
    })
    req.pipe(request)
  }

  _proxyUpgrade(state, req, socket, head) {
    let upstreamUrl
    try { upstreamUrl = new URL(req.url || '/', state.upstreamUrl) } catch { socket.destroy(); return }
    const upstreamSocket = net.connect(Number(upstreamUrl.port || 80), upstreamUrl.hostname.replace(/^\[|\]$/g, ''))
    upstreamSocket.once('connect', () => {
      const headers = { ...req.headers, host: upstreamUrl.host }
      if (headers.origin) headers.origin = new URL(state.upstreamUrl).origin
      const lines = [`${req.method} ${upstreamUrl.pathname}${upstreamUrl.search} HTTP/${req.httpVersion}`]
      for (const [key, value] of Object.entries(headers)) {
        if (Array.isArray(value)) for (const item of value) lines.push(`${key}: ${item}`)
        else if (value != null) lines.push(`${key}: ${value}`)
      }
      upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length) upstreamSocket.write(head)
      upstreamSocket.pipe(socket)
      socket.pipe(upstreamSocket)
    })
    upstreamSocket.on('error', () => socket.destroy())
    socket.on('error', () => upstreamSocket.destroy())
  }

  async _closeProxy(state) {
    if (!state.proxy) return
    const proxy = state.proxy
    state.proxy = null
    for (const socket of state.proxySockets) socket.destroy()
    state.proxySockets.clear()
    await new Promise(resolve => {
      proxy.close(() => resolve())
      proxy.closeAllConnections?.()
    })
  }

  getLatestActivity() { return this.latestActivity }

  getStatus(sessionId) {
    const state = this.sessions.get(sessionId)
    if (!state) return null
    return {
      sessionId: state.sessionId,
      command: state.command,
      cwd: state.cwd,
      output: state.output.slice(-8000),
      running: !!state.process,
      upstreamUrl: state.upstreamUrl,
      previewUrl: state.previewUrl,
      bridgeToken: state.bridgeToken,
      bridgeReady: state.bridgeReady,
      htmlPath: state.htmlPath,
      htmlBytes: Buffer.byteLength(state.html || ''),
      selection: state.selection
    }
  }

  readHtml(sessionId, maxChars = 30_000) {
    const state = this.sessions.get(sessionId)
    if (!state?.html) throw new Error('还没有拦截到 HTML。请先启动或接入开发服务，并打开预览页面。')
    const limit = Math.min(Math.max(Number(maxChars) || 30_000, 1000), 60_000)
    return { html: state.html.slice(0, limit), path: state.htmlPath, truncated: state.htmlTruncated || state.html.length > limit, source: 'http-response' }
  }

  getCommands(sessionId) {
    const state = this.sessions.get(sessionId)
    if (!state) return []
    const now = Date.now()
    const commands = []
    for (const pending of state.pending.values()) {
      if (pending.delivered) continue
      pending.lastSentAt = now
      pending.delivered = true
      commands.push({ id: pending.id, type: pending.type, args: pending.args })
    }
    return commands
  }

  runInPage(sessionId, type, args = {}, timeoutMs = DEFAULT_COMMAND_TIMEOUT) {
    const state = this.sessions.get(sessionId)
    if (!state?.previewUrl) return Promise.reject(new Error('当前会话尚未连接浏览器预览。'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pending.delete(id)
        reject(new Error('等待预览页面响应超时。请确认浏览器预览面板已打开且页面已加载。'))
      }, Math.min(Math.max(Number(timeoutMs) || DEFAULT_COMMAND_TIMEOUT, 1000), 60_000))
      state.pending.set(id, { id, type, args, resolve, reject, timeout, lastSentAt: 0, delivered: false })
    })
  }

  receiveResult(sessionId, { id, success, result, error }) {
    const state = this.sessions.get(sessionId)
    const pending = state?.pending.get(id)
    if (!pending) return false
    clearTimeout(pending.timeout)
    state.pending.delete(id)
    if (pending.type === 'selectElement' && result?.selection) {
      result = { ...result, selection: { ...result.selection, selectedAt: Date.now() } }
      state.selection = result.selection
    }
    if (success) pending.resolve(result)
    else pending.reject(new Error(error || '浏览器页面执行操作失败。'))
    return true
  }

  setBridgeReady(sessionId, token, details = {}) {
    const state = this.sessions.get(sessionId)
    if (!state || state.bridgeToken !== token) return false
    state.bridgeReady = true
    state.title = String(details.title || '')
    return true
  }

  recordSelection(sessionId, token, selection) {
    const state = this.sessions.get(sessionId)
    if (!state || state.bridgeToken !== token) throw new Error('浏览器页面令牌无效。')
    state.selection = selection || null
    return state.selection
  }

  getSelection(sessionId) { return this.sessions.get(sessionId)?.selection || null }

  async stop(sessionId) {
    const state = this.sessions.get(sessionId)
    if (!state) return { stopped: false }
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error('浏览器预览已停止。'))
    }
    state.pending.clear()
    await this._closeProxy(state)
    if (state.staticServer) {
      const staticServer = state.staticServer
      state.staticServer = null
      staticServer.closeAllConnections?.()
      await new Promise(resolve => staticServer.close(() => resolve()))
    }
    const child = state.process
    state.process = null
    if (child && child.exitCode == null) {
      try {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
          killer.unref()
        } else {
          process.kill(-child.pid, 'SIGTERM')
          setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 1500).unref()
        }
      } catch { try { child.kill('SIGTERM') } catch {} }
    }
    if (state.resolveReady) state.resolveReady()
    this.sessions.delete(sessionId)
    return { stopped: true }
  }

  async stopAll() {
    await Promise.all([...this.sessions.keys()].map(sessionId => this.stop(sessionId)))
  }
}
