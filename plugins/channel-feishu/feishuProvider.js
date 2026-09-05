import { ChannelProvider } from '../../providers/channelProvider.js'
import { runtimeLogger } from '../../core/logger.js'
import crypto from 'crypto'

/**
 * 飞书频道提供者
 * 支持飞书机器人 Webhook 和自定义机器人
 */
export class FeishuProvider extends ChannelProvider {
  constructor(config) {
    super(config)
    this.name = 'feishu'
    this.webhookUrl = config.config?.webhookUrl || config.webhook || ''
    this.secret = config.config?.secret || config.secret || config.token || ''
  }

  static getConfigSchema() {
    return {
      type: 'object',
      properties: {
        webhookUrl: { type: 'string', title: 'Webhook 地址', description: '飞书机器人 Webhook URL' },
        secret: { type: 'string', title: '签名密钥', description: '消息签名验证密钥', format: 'password' }
      },
      required: ['webhookUrl']
    }
  }

  static getMetadata() {
    return { label: '飞书', icon: 'message-circle', color: '#3370ff' }
  }

  validateConfig() {
    const errors = []
    if (!this.webhookUrl) {
      errors.push('Webhook URL 不能为空')
    }
    if (!this.webhookUrl?.includes('open.feishu.cn')) {
      errors.push('Webhook URL 必须是飞书开放平台地址')
    }
    return { valid: errors.length === 0, errors }
  }

  getCapabilities() {
    return {
      inbound: true,
      outbound: true,
      richText: true,
      threading: false,
      mentions: false,
      messageUpdates: false
    }
  }

  /**
   * 生成签名（如果配置了签名密钥）
   */
  generateSign(timestamp) {
    if (!this.secret) return null
    const stringToSign = `${timestamp}\n${this.secret}`
    return crypto.createHmac('sha256', stringToSign).update('').digest('base64')
  }

  validateWebhookRequest(request) {
    if (this.config.verifyToken && request.body?.token && request.body.token !== this.config.verifyToken) {
      return { valid: false, error: 'Invalid Feishu webhook token' }
    }

    return { valid: true }
  }

  parseInboundRequest(request) {
    const body = request.body || {}

    if (body.challenge) {
      return {
        kind: 'handshake',
        response: { challenge: body.challenge }
      }
    }

    const event = body.event || {}
    const message = event.message || {}
    const sender = event.sender || {}
    const mentions = event.mentions || []
    const messageType = message.message_type || body.message_type || 'text'

    let text = ''
    if (messageType === 'text' && message.content) {
      try {
        text = JSON.parse(message.content).text || ''
      } catch {
        text = message.content
      }
    }

    if (!text && body.text?.content) {
      text = body.text.content
    }

    if (!message.message_id && !text) {
      return { kind: 'ignored', reason: 'No inbound message content' }
    }

    return {
      kind: 'message',
      eventId: body.header?.event_id || message.message_id || `feishu_${Date.now()}`,
      messageId: message.message_id || body.header?.event_id || `feishu_${Date.now()}`,
      channelUserId: sender.sender_id?.open_id || sender.sender_id?.user_id || sender.user_id || 'unknown',
      userName: sender.sender_id?.union_id || sender.name || '未知用户',
      tenantId: body.header?.tenant_key || event.tenant_key || 'default',
      chatId: message.chat_id || event.chat_id || sender.chat_id || sender.sender_id?.open_id || 'direct',
      threadId: message.root_id || message.parent_id || null,
      contentType: messageType,
      text,
      mentions: mentions.map(item => item?.name).filter(Boolean),
      occurredAt: body.header?.create_time || Date.now(),
      rawEvent: body
    }
  }

  async sendMessage(message, options = {}) {
    try {
      const validation = this.validateConfig()
      if (!validation.valid) {
        return { success: false, error: validation.errors.join(', ') }
      }

      const timestamp = Math.floor(Date.now() / 1000).toString()
      const body = {
        msg_type: 'text',
        content: {
          text: message
        },
        timestamp
      }

      // 如果配置了签名密钥，添加签名
      if (this.secret) {
        body.sign = await this.generateSign(timestamp)
      }

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })

      const result = await response.json()

      if (result.code === 0 || result.StatusCode === 0) {
        runtimeLogger.info(`Feishu message sent successfully`)
        return { success: true, messageId: result.msg_id || 'feishu_' + Date.now() }
      } else {
        runtimeLogger.error(`Feishu send failed: ${JSON.stringify(result)}`)
        return { success: false, error: result.msg || '发送失败' }
      }
    } catch (error) {
      runtimeLogger.error('Feishu send error:', error)
      return { success: false, error: error.message }
    }
  }

  async sendRichMessage(content, options = {}) {
    try {
      const validation = this.validateConfig()
      if (!validation.valid) {
        return { success: false, error: validation.errors.join(', ') }
      }

      const timestamp = Math.floor(Date.now() / 1000).toString()
      const body = {
        msg_type: 'interactive',
        card: content,
        timestamp
      }

      if (this.secret) {
        body.sign = await this.generateSign(timestamp)
      }

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })

      const result = await response.json()

      if (result.code === 0 || result.StatusCode === 0) {
        return { success: true, messageId: result.msg_id || 'feishu_' + Date.now() }
      } else {
        return { success: false, error: result.msg || '发送失败' }
      }
    } catch (error) {
      runtimeLogger.error('Feishu rich message error:', error)
      return { success: false, error: error.message }
    }
  }

  async testConnection() {
    try {
      const result = await this.sendMessage('🔍 频道连接测试成功！')
      return {
        success: result.success,
        message: result.success ? '飞书连接成功' : `飞书连接失败: ${result.error}`
      }
    } catch (error) {
      return { success: false, message: `飞书连接错误: ${error.message}` }
    }
  }

  /**
   * 构建任务结果卡片
   */
  buildTaskResultCard(taskResult) {
    const { taskId, status, result, error, duration } = taskResult
    const statusEmoji = status === 'success' ? '✅' : '❌'
    const statusText = status === 'success' ? '成功' : '失败'

    return {
      config: { wide_screen_mode: true },
      header: {
        title: {
          tag: 'plain_text',
          content: `${statusEmoji} 任务执行${statusText}`
        },
        template: status === 'success' ? 'green' : 'red'
      },
      elements: [
        {
          tag: 'div',
          fields: [
            {
              is_short: true,
              text: {
                tag: 'lark_md',
                content: `**任务 ID**\n${taskId}`
              }
            },
            {
              is_short: true,
              text: {
                tag: 'lark_md',
                content: `**耗时**\n${duration || '-'}`
              }
            }
          ]
        },
        {
          tag: 'div',
          text: {
            tag: 'lark_md',
            content: `**执行结果**\n${result || error || '无输出'}`
          }
        },
        { tag: 'hr' },
        {
          tag: 'note',
          elements: [
            {
              tag: 'plain_text',
              content: `Artificer · ${new Date().toLocaleString('zh-CN')}`
            }
          ]
        }
      ]
    }
  }

  /**
   * 推送任务结果
   */
  async pushTaskResult(taskResult) {
    const card = this.buildTaskResultCard(taskResult)
    return this.sendRichMessage(card)
  }
}
