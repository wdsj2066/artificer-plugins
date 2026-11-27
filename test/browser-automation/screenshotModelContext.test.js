import { describe, expect, it, vi } from 'vitest'
import { addScreenshotToModelMessages } from '../../plugins/browser-automation/screenshotModelContext.js'

const webResult = { success: true, sessionId: 'one', screenshotId: 'web-img', width: 200, height: 100, cssWidth: 100, cssHeight: 50, mode: 'viewport', scrollX: 0, scrollY: 0 }
const webResult2 = { success: true, sessionId: 'one', screenshotId: 'web-img-2', width: 400, height: 200, cssWidth: 200, cssHeight: 100, mode: 'fullPage', scrollX: 0, scrollY: 0 }
const messages = [{ role: 'assistant', tool_calls: [{ id: 'call' }] }, { role: 'tool', tool_call_id: 'call', content: '{}' }]
const context = { state: { storage: { sessionId: 'one' }, modelCapabilities: { support_image: true } }, toolResults: [{ name: 'browserScreenshot', callId: 'call', result: webResult }] }

describe('网页截图模型上下文', () => {
  it('将本会话当前工具回合的一张或多张网页截图临时附加给视觉模型', () => {
    const runtime = {
      getScreenshot: vi.fn((_sid, id) => ({
        dataUrl: id === 'web-img' ? 'data:image/jpeg;base64,web1' : 'data:image/jpeg;base64,web2'
      }))
    }
    const multiMessages = [
      { role: 'assistant', tool_calls: [{ id: 'call-1' }, { id: 'call-2' }] },
      { role: 'tool', tool_call_id: 'call-1', content: '{}' },
      { role: 'tool', tool_call_id: 'call-2', content: '{}' }
    ]
    const multiCtx = {
      state: { storage: { sessionId: 'one' }, modelCapabilities: { support_image: true } },
      toolResults: [
        { name: 'browserScreenshot', callId: 'call-1', result: webResult },
        { name: 'browserScreenshot', callId: 'call-2', result: webResult2 }
      ]
    }

    const output = addScreenshotToModelMessages(runtime, multiCtx, multiMessages)
    expect(output.at(-1)).toMatchObject({
      role: 'user',
      content: [
        { type: 'text' },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,web1' } },
        { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,web2' } }
      ]
    })
    expect(runtime.getScreenshot).toHaveBeenCalledTimes(2)
  })

  it('宿主已通过 _modelImages 注入时跳过插件兜底，避免重复注入', () => {
    const runtime = { getScreenshot: vi.fn() }
    const hostInjectedMessages = [
      { role: 'assistant', tool_calls: [{ id: 'call' }] },
      { role: 'tool', tool_call_id: 'call', content: '{}', _modelImages: [{ dataUrl: 'data:image/jpeg;base64,abc' }] }
    ]
    expect(addScreenshotToModelMessages(runtime, context, hostInjectedMessages)).toBe(hostInjectedMessages)
    expect(runtime.getScreenshot).not.toHaveBeenCalled()
  })

  it('不向文本模型、其他会话或后续回合附加截图', () => {
    const runtime = { getScreenshot: vi.fn() }
    expect(addScreenshotToModelMessages(runtime, { ...context, state: { ...context.state, modelCapabilities: {} } }, messages)).toBe(messages)
    expect(addScreenshotToModelMessages(runtime, { ...context, state: { ...context.state, storage: { sessionId: 'two' } } }, messages)).toBe(messages)
    const next = [...messages, { role: 'assistant', content: 'done' }]
    expect(addScreenshotToModelMessages(runtime, context, next)).toBe(next)
    expect(runtime.getScreenshot).not.toHaveBeenCalled()
  })
})
