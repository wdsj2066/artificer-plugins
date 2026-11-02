import { describe, expect, it, vi } from 'vitest'
import { addScreenshotToModelMessages } from '../../plugins/browser-automation/screenshotModelContext.js'

const result = { success: true, sessionId: 'one', screenshotId: 'image', width: 200, height: 100, cssWidth: 100, cssHeight: 50, mode: 'viewport', scrollX: 0, scrollY: 0 }
const messages = [{ role: 'assistant', tool_calls: [{ id: 'call' }] }, { role: 'tool', tool_call_id: 'call', content: '{}' }]
const context = { state: { storage: { sessionId: 'one' }, modelCapabilities: { support_image: true } }, toolResults: [{ name: 'browserScreenshot', callId: 'call', result }] }

describe('网页截图模型上下文', () => {
  it('将本会话当前工具回合的截图临时附加给视觉模型', () => {
    const runtime = { getScreenshot: vi.fn(() => ({ dataUrl: 'data:image/jpeg;base64,abc' })) }
    const output = addScreenshotToModelMessages(runtime, context, messages)
    expect(output.at(-1)).toMatchObject({ role: 'user', content: [{ type: 'text' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,abc' } }] })
    expect(messages).toHaveLength(2)
    expect(runtime.getScreenshot).toHaveBeenCalledWith('one', 'image')
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
