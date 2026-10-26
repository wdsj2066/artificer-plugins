import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserPreviewRuntime } from '../../plugins/browser-automation/previewRuntime.js'

const servers = []
const tempRoots = []
const runtimes = []

function startUpstream(body = '<!DOCTYPE html><html><head><title>预览</title></head><body>hi</body></html>') {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(body)
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}/`))
  })
}

function runtime() {
  const instance = new BrowserPreviewRuntime()
  runtimes.push(instance)
  return instance
}

afterEach(async () => {
  for (const instance of runtimes.splice(0)) {
    for (const sessionId of [...instance.sessions.keys()]) await instance.stop(sessionId)
  }
  for (const server of servers.splice(0)) await new Promise(resolve => server.close(resolve))
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('browser preview proxy', () => {
  it('drops the panel reload timestamp so the preview address stays stable', async () => {
    const upstream = await startUpstream()
    const preview = runtime()

    const first = await preview.attach('session', `${upstream}?tab=logs&_artificer_reload=1000`)
    expect(first.upstreamUrl).toBe(`${upstream}?tab=logs`)
    expect(first.previewUrl).toBe(`http://127.0.0.1:${new URL(first.previewUrl).port}/?tab=logs`)

    const second = await preview.attach('session', `${upstream}?tab=logs&_artificer_reload=2000`)
    // 同一个上游 origin 复用代理，端口不能变，否则 iframe 会被重载。
    expect(second.previewUrl).toBe(first.previewUrl)
    expect(second.bridgeToken).toBe(first.bridgeToken)
  })

  it('injects the bridge script exactly once when the document has a head', async () => {
    const upstream = await startUpstream()
    const preview = runtime()
    const status = await preview.attach('session', upstream)

    const html = await (await fetch(status.previewUrl)).text()
    expect(html.match(/__artificer_browser_bridge\.js/g)).toHaveLength(1)
    expect(html).toContain('<head><script src="/__artificer_browser_bridge.js"></script>')
  })

  it('keeps the doctype first for documents without a head', async () => {
    const upstream = await startUpstream('<!DOCTYPE html><html><body>hi</body></html>')
    const preview = runtime()
    const status = await preview.attach('session', upstream)

    const html = await (await fetch(status.previewUrl)).text()
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<body><script src="/__artificer_browser_bridge.js"></script>')
    expect(html.match(/__artificer_browser_bridge\.js/g)).toHaveLength(1)
  })

  it('reuses a running dev server instead of restarting it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'artificer-preview-'))
    tempRoots.push(root)
    writeFileSync(join(root, 'server.mjs'), [
      "import { createServer } from 'node:http'",
      "const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html><head></head><body>ok</body></html>') })",
      "server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port + '/'))"
    ].join('\n'))

    const preview = runtime()
    const first = await preview.start('session', { command: 'node server.mjs', workspaceRoot: root, timeoutMs: 20_000 })
    const firstPid = preview.sessions.get('session').process.pid

    const second = await preview.start('session', { command: 'node server.mjs', workspaceRoot: root, timeoutMs: 20_000 })
    expect(second.previewUrl).toBe(first.previewUrl)
    expect(preview.sessions.get('session').process.pid).toBe(firstPid)
  }, 30_000)
})
