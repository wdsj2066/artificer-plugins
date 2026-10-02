import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { CdpAutomationRuntime } from '../../plugins/browser-automation/cdpRuntime.js'

class FakePage extends EventEmitter {
  constructor(frame) {
    super()
    this.frame = frame
    this.keyboard = { press: vi.fn() }
    this.mouse = { move: vi.fn(), click: vi.fn() }
  }
  frames() { return [this.frame] }
  async createCDPSession() {
    return {
      send: vi.fn(async (method) => {
        if (method === 'Page.getFrameTree') return {
          frameTree: {
            frame: { id: 'app-frame', url: 'http://localhost:3000/' },
            childFrames: [{ frame: { id: 'preview-frame', url: this.frame.url() } }]
          }
        }
        if (method === 'Accessibility.getFullAXTree') return {
          nodes: [
            { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Preview' }, ignored: false },
            { nodeId: '2', parentId: '1', role: { value: 'dialog' }, name: { value: '二次确认' }, ignored: false },
            { nodeId: '3', parentId: '2', role: { value: 'button' }, name: { value: '确定' }, ignored: false }
          ]
        }
        throw new Error(`Unexpected CDP method: ${method}`)
      }),
      detach: vi.fn(async () => {})
    }
  }
}

class FakeBrowser extends EventEmitter {
  connected = true
  constructor(page) { super(); this.page = page }
  async pages() { return [this.page] }
  async disconnect() { this.connected = false; this.emit('disconnected') }
}

function fixture() {
  const frame = {
    url: () => 'http://127.0.0.1:41001/demo',
    evaluate: vi.fn(async () => ({ title: 'Preview', text: 'Confirm action?', dialogs: [{ text: 'Confirm action?' }] })),
    content: vi.fn(async () => '<!doctype html><main>Preview</main>'),
    title: vi.fn(async () => 'Preview'),
    $eval: vi.fn(async () => ({ selector: '#submit', tag: 'button', selection: true })),
    locator: vi.fn(() => ({
      setTimeout: vi.fn(function () { return this }),
      click: vi.fn(async () => {}),
      fill: vi.fn(async () => {}),
      hover: vi.fn(async () => {}),
      evaluate: vi.fn(async callback => callback({ scrollBy() {} }, 600))
    })),
    waitForSelector: vi.fn(async () => ({ focus: vi.fn(async () => {}) })),
    frameElement: vi.fn(async () => ({ evaluate: vi.fn(async () => ({ x: 20, y: 30 })) }))
  }
  const page = new FakePage(frame)
  const browser = new FakeBrowser(page)
  const previewRuntime = {
    sessions: new Map([['chat-1', {}]]),
    getStatus: vi.fn(() => ({ previewUrl: 'http://127.0.0.1:41001/', bridgeToken: 'token', currentUrl: frame.url() })),
    recordSelection: vi.fn()
  }
  const rpc = { call: vi.fn(async () => ({ browserURL: 'http://127.0.0.1:58888' })) }
  const puppeteerAdapter = { connect: vi.fn(async () => browser) }
  const runtime = new CdpAutomationRuntime({ rpc, previewRuntime, puppeteerAdapter })
  return { runtime, frame, page, browser, previewRuntime, rpc, puppeteerAdapter }
}

describe('CDP automation runtime', () => {
  it('connects to the host CDP endpoint and inspects the matching iframe frame', async () => {
    const { runtime, frame, rpc, puppeteerAdapter } = fixture()

    await expect(runtime.inspect('chat-1')).resolves.toMatchObject({
      title: 'Preview',
      text: 'Confirm action?',
      dialogs: [{ text: 'Confirm action?' }],
      html: '<!doctype html><main>Preview</main>',
      accessibilityTree: expect.stringContaining('确定')
    })
    expect(rpc.call).toHaveBeenCalledWith('browserAutomation.cdpEndpoint')
    expect(puppeteerAdapter.connect).toHaveBeenCalledWith(expect.objectContaining({
      browserURL: 'http://127.0.0.1:58888',
      defaultViewport: null
    }))
    expect(frame.evaluate).toHaveBeenCalledOnce()
  })

  it('surfaces and explicitly resolves native JavaScript dialogs', async () => {
    const { runtime, page, frame } = fixture()
    runtime.start()
    await vi.waitFor(() => expect(runtime.browser?.connected).toBe(true))
    const dialog = {
      type: () => 'confirm',
      message: () => '确定要提交吗？',
      defaultValue: () => '',
      accept: vi.fn(async () => {}),
      dismiss: vi.fn(async () => {})
    }
    page.emit('dialog', dialog)

    await expect(runtime.inspect('chat-1')).resolves.toMatchObject({
      nativeDialogs: [{ type: 'confirm', message: '确定要提交吗？' }]
    })
    expect(frame.evaluate).not.toHaveBeenCalled()
    const pending = runtime.status().pendingDialogs[0]
    await expect(runtime.resolveDialog('chat-1', { dialogId: pending.id, action: 'accept' })).resolves.toMatchObject({
      success: true,
      action: 'accept',
      message: '确定要提交吗？'
    })
    expect(dialog.accept).toHaveBeenCalledWith('')
    expect(runtime.status().pendingDialogs).toEqual([])
  })

  it('uses Puppeteer locators for actions and persists element selection', async () => {
    const { runtime, frame, previewRuntime } = fixture()

    await runtime.act('chat-1', { action: 'click', selector: '::-p-text(确定)' })
    expect(frame.locator).toHaveBeenCalledWith('::-p-text(确定)')

    const result = await runtime.selectElement('chat-1', '#submit')
    expect(result.selection).toMatchObject({ selection: true, selectedAt: expect.any(Number) })
    expect(previewRuntime.recordSelection).toHaveBeenCalledWith('chat-1', 'token', result.selection)
  })

  it('reports a missing preview frame instead of hanging', async () => {
    const { runtime, page, frame } = fixture()
    frame.url = () => 'http://localhost:5173/'
    page.frames = () => [frame]
    await expect(runtime._findPreview('chat-1', 0)).rejects.toThrow('没有找到当前会话的预览 iframe')
  })
})
