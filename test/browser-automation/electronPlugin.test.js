import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { register as registerBootstrap } from '../../plugins/browser-automation/bootstrap.js'
import { captureDesktop, dimensionsFor, ensurePreviewWindow, getBrowserEndpoint, previewWindowStatus } from '../../plugins/browser-automation/electron.js'

const tempRoots = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Electron browser automation bridge', () => {
  it('enables loopback CDP on an OS-assigned port before app.ready', () => {
    const switches = []
    const app = { isReady: () => false, commandLine: { hasSwitch: () => false, appendSwitch: (...args) => switches.push(args) } }
    registerBootstrap({ electron: { app }, logger: { info: vi.fn() } })
    expect(switches).toEqual([
      ['remote-debugging-address', '127.0.0.1'],
      ['remote-debugging-port', '0']
    ])
  })

  it('discovers and verifies Chromium DevToolsActivePort endpoint', async () => {
    const root = mkdtempSync(join(tmpdir(), 'artificer-cdp-endpoint-'))
    tempRoots.push(root)
    writeFileSync(join(root, 'DevToolsActivePort'), '54431\n/devtools/browser/fake-id\n')
    vi.stubGlobal('fetch', vi.fn(async url => ({
      ok: true,
      json: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:54431/devtools/browser/fake-id', requested: String(url) })
    })))

    await expect(getBrowserEndpoint({
      getPath: () => root,
      commandLine: { hasSwitch: () => true, getSwitchValue: () => '0' }
    })).resolves.toEqual({ browserURL: 'http://127.0.0.1:54431' })
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:54431/json/version', expect.any(Object))
  })

  it('chooses the requested display and returns a bounded JPEG screenshot', async () => {
    const displays = [
      { id: 1, bounds: { width: 3840, height: 2160 }, scaleFactor: 1 },
      { id: 2, bounds: { width: 1920, height: 1080 }, scaleFactor: 1 }
    ]
    const image = {
      isEmpty: () => false,
      getSize: () => ({ width: 3840, height: 2160 }),
      resize: vi.fn(() => ({ getSize: () => ({ width: 3200, height: 1800 }), toJPEG: () => Buffer.from('jpeg') })),
      toJPEG: () => Buffer.from('jpeg')
    }
    const electron = {
      screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => displays[0] },
      desktopCapturer: { getSources: vi.fn(async () => [
        { display_id: '1', name: 'Screen 1', thumbnail: image },
        { display_id: '2', name: 'Screen 2', thumbnail: image }
      ]) }
    }

    expect(dimensionsFor(displays[0])).toEqual({ width: 3200, height: 1800 })
    await expect(captureDesktop(electron, { displayId: '2' })).resolves.toMatchObject({
      scope: 'desktop',
      displayId: '2',
      title: 'Screen 2',
      width: 3200,
      height: 1800,
      dataUrl: `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`
    })
    expect(electron.desktopCapturer.getSources).toHaveBeenCalledWith({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    })
    expect(image.resize).toHaveBeenCalledWith({ width: 3200, height: 1800, quality: 'best' })
  })

  it('creates one hidden background window per session and reuses it', async () => {
    const { BrowserWindow } = fakeBrowserWindowModule()
    const electron = { app: { isReady: () => true }, BrowserWindow }
    const first = await ensurePreviewWindow(electron, { sessionId: 'chat-1', url: 'http://127.0.0.1:41001/' })
    expect(first).toMatchObject({ sessionId: 'chat-1', loaded: true, visible: false })
    expect(BrowserWindow.instances).toHaveLength(1)

    const win = BrowserWindow.instances[0]
    expect(win.options.show).toBe(false)
    expect(win.options.skipTaskbar).toBe(true)
    expect(win.options.webPreferences.backgroundThrottling).toBe(false)
    expect(win.loadURL).toHaveBeenCalledWith('http://127.0.0.1:41001/')

    const again = await ensurePreviewWindow(electron, { sessionId: 'chat-1', url: 'http://127.0.0.1:41001/' })
    expect(again.reused).toBe(true)
    expect(BrowserWindow.instances).toHaveLength(1)
    expect(previewWindowStatus('chat-1')).toMatchObject({ open: true, url: 'http://127.0.0.1:41001/' })
  })

  it('rejects non-loopback URLs for the background window', async () => {
    const { BrowserWindow } = fakeBrowserWindowModule()
    await expect(ensurePreviewWindow({ app: {}, BrowserWindow }, { sessionId: 'chat-1', url: 'https://example.com/' }))
      .rejects.toThrow('后台预览只接受本机回环地址')
  })
})

function fakeBrowserWindowModule() {
  class FakeWebContents {
    constructor(win) { this.win = win; this.url = ''; this.listeners = new Map() }
    getURL() { return this.url }
    isLoading() { return false }
    on(event, handler) { this.listeners.set(event, handler); return this }
    off(event) { this.listeners.delete(event); return this }
    once() { return this }
    setAudioMuted() {}
    setWindowOpenHandler() {}
    isDevToolsOpened() { return false }
  }
  class BrowserWindow {
    static instances = []
    constructor(options) {
      this.options = options
      this.webContents = new FakeWebContents(this)
      this.destroyed = false
      this.handlers = new Map()
      this.loadURL = vi.fn(async url => {
        this.webContents.url = url
        this.webContents.listeners.get('did-finish-load')?.()
      })
      BrowserWindow.instances.push(this)
    }
    static reset() { BrowserWindow.instances = [] }
    isDestroyed() { return this.destroyed }
    isVisible() { return false }
    setMenuBarVisibility() {}
    setContentSize() {}
    getContentBounds() { return { width: 1280, height: 800 } }
    destroy() { this.destroyed = true }
    once(event, handler) { this.handlers.set(event, handler); return this }
  }
  return { BrowserWindow }
}
