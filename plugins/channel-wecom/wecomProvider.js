const WS_URL = 'wss://openws.work.weixin.qq.com'
const PING_INTERVAL = 30000
const RECONNECT_DELAY = 5000

/**
 * 企业微信智能机器人长连接提供者
 * 基于 WebSocket 协议，无需公网回调地址
 */
export class WecomProvider {
  constructor(config, services) {
    this.config = config
    this.services = services
    this.logger = services.logger || console
    this.name = 'wecom'
    this.botId = config.botId || config.config?.botId || ''
    this.botSecret = config.botSecret || config.config?.botSecret || ''
    this.webhookUrl = config.webhook || ''
    this.key = config.key || config.token || ''
    this.welcomeMessage = config.config?.welcomeMessage || ''
    this.channelId = config.id
    this.ws = null
    this.connected = false
    this.pingTimer = null
    this.reconnectTimer = null
    this._reqIdSeq = 0
    this._pendingResolves = new Map()
    this._queue = []
    this._busy = false
    this._connecting = false
  }

  validateConfig() {
    const errors = []
    if (!this.botId) errors.push('BotID 不能为空')
    if (!this.botSecret) errors.push('Secret 不能为空')
    return { valid: errors.length === 0, errors }
  }

  getCapabilities() {
    return {
      inbound: true,
      outbound: true,
      richText: true,
      threading: false,
      mentions: true,
      messageUpdates: true,
      longConnection: true
    }
  }

  static getConfigSchema() {
    return {
      type: 'object',
      properties: {
        botId: { type: 'string', title: 'BotID', description: '智能机器人的 BotID，从企业微信管理后台获取' },
        botSecret: { type: 'string', title: 'BotSecret', description: '长连接专用 Secret', format: 'password' },
        welcomeMessage: { type: 'string', title: '欢迎语', description: '用户首次进入会话时自动发送的欢迎消息' },
        defaultChatId: { type: 'string', title: '默认 ChatId', description: '主动推送消息的目标 userid（单聊）或 chatid（群聊）' }
      },
      required: ['botId', 'botSecret']
    }
  }

  static getMetadata() {
    return { label: '企业微信', icon: 'message-square', color: '#07c160' }
  }

  /* ========== 旧 HTTP Webhook 兼容方法 ========== */

  validateWebhookRequest(request) {
    if (this.config.verifyToken && request.query?.token && request.query.token !== this.config.verifyToken) {
      return { valid: false, error: 'Invalid WeCom webhook token' }
    }
    return { valid: true }
  }

  parseInboundRequest(request) {
    const body = request.body || {}
    if (!body.msgid && !body.text?.content) {
      return { kind: 'ignored', reason: 'No inbound message content' }
    }
    return {
      kind: 'message',
      eventId: body.msgid || `wecom_${Date.now()}`,
      messageId: body.msgid || `wecom_${Date.now()}`,
      channelUserId: body.from?.userid || body.from?.name || body.chatid || 'unknown',
      userName: body.from?.name || body.from?.userid || '未知用户',
      tenantId: this.config.corpId || 'default',
      chatId: body.chatid || body.from?.userid || 'direct',
      threadId: null,
      contentType: body.msgtype || 'text',
      text: body.text?.content || '',
      mentions: body.text?.mentioned_list || body.text?.mentioned_mobile_list || [],
      occurredAt: body.sendtime || Date.now(),
      rawEvent: body
    }
  }

  buildOutboundOptions(_message, _conversation) {
    return {}
  }

  buildConversationKey(event) {
    return [
      this.config?.id || 'channel',
      this.name,
      event.tenantId || 'default',
      event.chatId || 'unknown',
      event.channelUserId || 'all',
      event.threadId || 'root'
    ].join(':')
  }

  buildLegacyConversationKeys(event) {
    return [
      `${this.name}:${event.tenantId || 'default'}:${event.chatId || 'unknown'}:${event.channelUserId || 'all'}:${event.threadId || 'root'}`,
      `${this.name}:${event.tenantId || 'default'}:${event.chatId || event.channelUserId || 'unknown'}:${event.threadId || 'root'}`
    ]
  }

  /* ========== 长连接生命周期 ========== */

  async connect() {
    if (this.connected || this._connecting) return
    const validation = this.validateConfig()
    if (!validation.valid) {
      this.logger.warn?.(`[Wecom/${this.channelId}] 配置无效，跳过长连接: ${validation.errors.join(', ')}`)
      return
    }

    try {
      const module = await this.services.importModule('ws')
      const WebSocket = module.default || module.WebSocket || module
      this._connecting = true
      const ws = new WebSocket(WS_URL)
      this.ws = ws

      ws.on('open', () => {
        if (this.ws !== ws) return // 旧 socket 的残留事件，忽略
        this.logger.info?.(`[Wecom/${this.channelId}] WebSocket 已连接，正在订阅...`)
        this._subscribe()
      })

      ws.on('message', (raw) => {
        if (this.ws !== ws) return // 旧 socket 的残留事件，忽略
        try {
          const msg = JSON.parse(raw.toString())
          this._dispatch(msg, ws)
        } catch (e) {
          this.logger.error?.(`[Wecom/${this.channelId}] 消息解析失败:`, e.message)
        }
      })

      ws.on('close', (code, reason) => {
        if (this.ws !== ws) return // 旧 socket 的残留事件，忽略
        this._connecting = false
        this.logger.warn?.(`[Wecom/${this.channelId}] 连接关闭 code=${code}${reason ? ` reason=${reason}` : ''}`)
        this.connected = false
        this._clearTimers()
        this._scheduleReconnect()
      })

      ws.on('error', (err) => {
        if (this.ws !== ws) return // 旧 socket 的残留事件，忽略
        this._connecting = false
        this.logger.error?.(`[Wecom/${this.channelId}] WebSocket 错误:`, err.message)
      })
    } catch (e) {
      this._connecting = false
      this.logger.error?.(`[Wecom/${this.channelId}] 创建 WebSocket 失败:`, e.message)
      this._scheduleReconnect()
    }
  }

  async disconnect() {
    this._clearTimers()
    this._connecting = false
    if (this.ws) {
      try { this.ws.close(1000) } catch {}
      this.ws = null
    }
    this.connected = false
    this.logger.info?.(`[Wecom/${this.channelId}] 已断开连接`)
  }

  isConnected() {
    return this.connected
  }

  /* ========== 对外消息接口 ========== */

  async sendMessage(message, options = {}) {
    const reqId = options.reqId
    if (!reqId) {
      if (this.webhookUrl) return this._sendTextViaWebhook(message, options)
      return { success: false, error: '缺少 reqId，无法通过长连接回复' }
    }
    const streamId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    this._sendRaw({
      cmd: 'aibot_respond_msg',
      headers: { req_id: reqId },
      body: {
        msgtype: 'stream',
        stream: { id: streamId, finish: true, content: message }
      }
    })
    return { success: true, messageId: streamId }
  }

  async sendRichMessage(content, options = {}) {
    const reqId = options.reqId
    if (reqId) {
      this._sendRaw({
        cmd: 'aibot_respond_msg',
        headers: { req_id: reqId },
        body: { msgtype: 'markdown', markdown: { content } }
      })
      return { success: true, messageId: `md_${Date.now()}` }
    }
    const chatId = options.chatId || this.config.config?.defaultChatId
    if (chatId) {
      const chatType = options.chatType || 1
      this._sendRaw({
        cmd: 'aibot_send_msg',
        headers: { req_id: this._genReqId() },
        body: { chatid: chatId, chat_type: chatType, msgtype: 'markdown', markdown: { content } }
      })
      return { success: true, messageId: `push_${Date.now()}` }
    }
    if (this.webhookUrl) return this._sendMarkdownViaWebhook(content)
    return { success: false, error: '没有 chatId 且无 webhook 回退，无法发送' }
  }

  async testConnection() {
    const validation = this.validateConfig()
    if (!validation.valid && !this.webhookUrl) {
      return { success: false, message: `配置无效: ${validation.errors.join(', ')}` }
    }
    if (this.connected) {
      return { success: true, message: `企业微信长连接已连接 (BotID: ${this.botId})` }
    }
    if (this.webhookUrl) {
      const result = await this._sendTextViaWebhook('🔍 频道连接测试成功！')
      return {
        success: result.success,
        message: result.success ? '企业微信 Webhook 连接成功' : `企业微信连接失败: ${result.error}`
      }
    }
    return { success: false, message: '长连接未建立，请启用频道后重试' }
  }

  pushTaskResult(taskResult) {
    const markdown = this._buildTaskResultMarkdown(taskResult)
    return this.sendRichMessage(markdown, { chatId: this.config.config?.defaultChatId })
  }

  /* ========== 订阅 & 分发 ========== */

  async _subscribe() {
    try {
      const storedSeq = this.services.store.get(`sequence:${this.channelId}`)
      const body = { bot_id: this.botId, secret: this.botSecret }
      if (storedSeq != null) {
        body.seq = storedSeq
        this.logger.info?.(`[Wecom/${this.channelId}] 携带 seq=${storedSeq} 订阅（断线补推）`)
      }
      const res = await this._sendCommandWait('aibot_subscribe', body)
      if (res.errcode === 0) {
        this.connected = true
        this._connecting = false
        this._startPing()
        this.logger.info?.(`[Wecom/${this.channelId}] 订阅成功`)
        if (res.last_seq != null) {
          this.services.store.set(`sequence:${this.channelId}`, res.last_seq)
        }
      } else {
        this._connecting = false
        this.logger.error?.(`[Wecom/${this.channelId}] 订阅失败: errcode=${res.errcode} ${res.errmsg || ''}`)
        this._scheduleReconnect()
      }
    } catch (e) {
      this._connecting = false
      this.logger.error?.(`[Wecom/${this.channelId}] 订阅异常:`, e.message)
      this._scheduleReconnect()
    }
  }

  _dispatch(msg, ws) {
    const { cmd, headers, body } = msg

    // 事件回调：收到即保存 seq，断线重连时避免重放事件
    if (cmd === 'aibot_event_callback' && body?.seq != null) {
      this.services.store.set(`sequence:${this.channelId}`, body.seq)
    }

    if (cmd === 'aibot_msg_callback') {
      this._enqueue(() => this._handleMsgCallback(msg.body, msg.headers))
      return
    }
    if (cmd === 'aibot_event_callback') {
      this._enqueue(() => this._handleEventCallback(msg.body, msg.headers, ws))
      return
    }

    const reqId = headers?.req_id
    if (reqId && this._pendingResolves.has(reqId)) {
      const entry = this._pendingResolves.get(reqId)
      clearTimeout(entry.timer)
      this._pendingResolves.delete(reqId)
      entry.resolve(msg)
    }
  }

  _enqueue(fn) {
    this._queue.push(fn)
    this._drain()
  }

  async _drain() {
    if (this._busy) return
    this._busy = true
    while (this._queue.length > 0) {
      const fn = this._queue.shift()
      try { await fn() } catch (e) { this.logger.error?.(`[Wecom/${this.channelId}] 处理回调异常:`, e.message) }
    }
    this._busy = false
  }

  /* ========== 消息回调 ========== */

  async _handleMsgCallback(body, headers) {
    const reqId = headers?.req_id

    const inbound = this._parseCallbackToInbound(body)
    if (!inbound) return

    try {
      const result = await this.services.processInbound(this.channelId, inbound, { reqId })
      // 处理成功后保存 seq，下次重连时从该位置之后继续补推
      if (result?.success && body?.seq != null) {
        this.services.store.set(`sequence:${this.channelId}`, body.seq)
      }
      if (!result.success) {
        this.logger.error?.(`[Wecom/${this.channelId}] 消息处理失败:`, result.body?.error)
      }
    } catch (e) {
      this.logger.error?.(`[Wecom/${this.channelId}] 消息回调异常:`, e.message)
    }
  }

  /* ========== 事件回调 ========== */

  async _handleEventCallback(body, headers, ws) {
    const reqId = headers?.req_id
    const event = body?.event || {}
    const eventType = event.eventtype

    this.logger.info?.(`[Wecom/${this.channelId}] 事件回调: ${eventType}`)

    if (eventType === 'enter_chat') {
      if (this.welcomeMessage) {
        this._sendRaw({
          cmd: 'aibot_respond_welcome_msg',
          headers: { req_id: reqId },
          body: { msgtype: 'text', text: { content: this.welcomeMessage } }
        })
      }
      return
    }

    if (eventType === 'disconnected_event') {
      if (ws && this.ws !== ws) return // 排队期间连接已被替换，忽略过期事件
      this.logger.warn?.(`[Wecom/${this.channelId}] 收到断开连接事件`)
      this.connected = false
      this._connecting = false
      this._clearTimers()
      // 主动关闭底层 socket，避免服务端未立即断 TCP 时出现双连接
      const current = this.ws
      this.ws = null
      try { current?.close(1000) } catch {}
      this._scheduleReconnect()
      return
    }

    if (eventType === 'template_card_event') {
      const inbound = this._parseEventToInbound(body)
      if (inbound) {
        try {
          await this.services.processInbound(this.channelId, inbound, { reqId })
        } catch (e) {
          this.logger.error?.(`[Wecom/${this.channelId}] 卡片事件处理失败:`, e.message)
        }
      }
      return
    }

    this.logger.debug?.(`[Wecom/${this.channelId}] 未处理的事件类型: ${eventType}`)
  }

  /* ========== 入站数据转换 ========== */

  _parseCallbackToInbound(body) {
    if (!body?.msgid) return null
    if (body.msgtype !== 'text' && body.msgtype !== 'event') return null
    if (body.msgtype === 'event') return null

    return {
      kind: 'message',
      eventId: body.msgid,
      messageId: body.msgid,
      channelUserId: body.from?.userid || 'unknown',
      userName: body.from?.userid || '用户',
      tenantId: this.config.corpId || 'default',
      chatId: body.chatid || 'direct',
      threadId: null,
      contentType: 'text',
      text: body.text?.content || '',
      mentions: [],
      occurredAt: body.create_time || Date.now(),
      rawEvent: body
    }
  }

  _parseEventToInbound(body) {
    const event = body?.event || {}
    if (event.eventtype !== 'template_card_event') return null
    const cardEvent = event.template_card_event || {}
    return {
      kind: 'message',
      eventId: body.msgid || `card_${Date.now()}`,
      messageId: body.msgid || `card_${Date.now()}`,
      channelUserId: body.from?.userid || 'unknown',
      userName: body.from?.userid || '用户',
      tenantId: this.config.corpId || 'default',
      chatId: body.chatid || 'direct',
      threadId: null,
      contentType: 'text',
      text: cardEvent.event_key || '',
      mentions: [],
      occurredAt: body.create_time || Date.now(),
      rawEvent: body
    }
  }

  _buildTaskResultMarkdown(taskResult) {
    const { taskId, status, result, error, duration } = taskResult
    const statusEmoji = status === 'success' ? '✅' : '❌'
    const statusText = status === 'success' ? '成功' : '失败'
    return `## ${statusEmoji} 任务执行${statusText}\n\n**任务 ID:** ${taskId}\n**耗时:** ${duration || '-'}\n\n**执行结果:**\n${result || error || '无输出'}\n\n---\n*Artificer · ${new Date().toLocaleString('zh-CN')}*`
  }

  /* ========== HTTP Webhook 降级回退 ========== */

  async _sendTextViaWebhook(message, options = {}) {
    try {
      const body = { msgtype: 'text', text: { content: message } }
      if (options.mentionedList) body.text.mentioned_list = options.mentionedList
      if (options.mentionedMobileList) body.text.mentioned_mobile_list = options.mentionedMobileList
      const response = await fetch(this.webhookUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      })
      const result = await response.json()
      if (result.errcode === 0) return { success: true, messageId: 'wh_' + Date.now() }
      return { success: false, error: result.errmsg || '发送失败' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  async _sendMarkdownViaWebhook(content) {
    try {
      const response = await fetch(this.webhookUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ msgtype: 'markdown', markdown: { content } })
      })
      const result = await response.json()
      if (result.errcode === 0) return { success: true, messageId: 'wh_md_' + Date.now() }
      return { success: false, error: result.errmsg || '发送失败' }
    } catch (e) {
      return { success: false, error: e.message }
    }
  }

  /* ========== 底层收发 ========== */

  _genReqId() {
    this._reqIdSeq += 1
    return `bol_${Date.now()}_${this._reqIdSeq}`
  }

  _sendRaw(msg) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify(msg))
      return true
    }
    return false
  }

  _sendCommandWait(cmd, body = {}) {
    const reqId = this._genReqId()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingResolves.delete(reqId)
        reject(new Error('命令超时'))
      }, 15000)
      this._pendingResolves.set(reqId, { resolve, reject, timer })
      if (!this._sendRaw({ cmd, headers: { req_id: reqId }, body })) {
        clearTimeout(timer)
        this._pendingResolves.delete(reqId)
        reject(new Error('WebSocket 未连接'))
      }
    })
  }

  /* ========== 心跳 ========== */

  _startPing() {
    this._clearTimers()
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === 1) {
        this._sendRaw({ cmd: 'ping', headers: { req_id: this._genReqId() } })
      } else {
        this.connected = false
        this._clearTimers()
        this._scheduleReconnect()
      }
    }, PING_INTERVAL)
  }

  _clearTimers() {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return
    this.logger.info?.(`[Wecom/${this.channelId}] ${RECONNECT_DELAY / 1000}s 后重连...`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, RECONNECT_DELAY)
  }
}
