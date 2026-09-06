<template>
  <div class="channel-plugin-view">
    <!-- 频道列表 -->
    <div v-if="!activeChannel" class="mgmt-view channel-mgmt">
      <div class="view-header">
        <h2>飞书频道</h2>
        <p class="view-description">管理飞书机器人频道集成</p>
      </div>

      <div class="mgmt-toolbar">
        <n-button type="primary" @click="openAddDrawer">
          <template #icon><Plus :size="16" /></template>
          添加飞书频道
        </n-button>
      </div>

      <div class="mgmt-card-grid">
        <n-card v-for="channel in channels" :key="channel.id" class="mgmt-channel-card">
          <div class="mgmt-channel-header">
            <div class="mgmt-channel-icon is-feishu">
              <MessageCircle :size="24" />
            </div>
            <div class="mgmt-channel-info">
              <h3>{{ channel.name }}</h3>
              <n-tag :type="channel.status === 'connected' ? 'success' : 'default'" size="small">
                {{ channel.status === 'connected' ? '已连接' : '未连接' }}
              </n-tag>
              <n-tag v-if="channel.agentId" size="small" type="info" style="margin-left: 6px">
                智能体: {{ channel.agentName || channel.agentId }}
              </n-tag>
            </div>
            <n-dropdown :options="getChannelOptions(channel)" @select="handleChannelAction($event, channel)">
              <n-button text><MoreVertical :size="16" /></n-button>
            </n-dropdown>
          </div>

          <div class="mgmt-channel-stats">
            <div class="mgmt-stat">
              <span class="mgmt-stat-label">消息数</span>
              <span class="mgmt-stat-value">{{ channel.messages ?? 0 }}</span>
            </div>
            <div class="mgmt-stat">
              <span class="mgmt-stat-label">最后活跃</span>
              <span class="mgmt-stat-value">{{ channel.lastActive || '从未' }}</span>
            </div>
          </div>
        </n-card>
        <n-empty v-if="channels.length === 0" description="暂无飞书频道" style="grid-column: 1 / -1; padding: 40px 0" />
      </div>

      <n-drawer v-model:show="showAddDrawer" :width="500" placement="right">
        <n-drawer-content title="添加飞书频道">
          <n-form :model="newChannel" label-placement="left" label-width="110">
            <n-form-item label="名称">
              <n-input v-model:value="newChannel.name" placeholder="频道名称" />
            </n-form-item>
            <n-form-item label="Webhook 地址">
              <n-input v-model:value="newChannel.config.webhookUrl" placeholder="飞书机器人 Webhook URL" />
            </n-form-item>
            <n-form-item label="签名密钥">
              <n-input v-model:value="newChannel.config.secret" type="password" placeholder="消息签名验证密钥（可选）" />
            </n-form-item>
            <n-form-item label="绑定智能体">
              <n-select
                v-model:value="newChannel.agentId"
                :options="agentOptions"
                placeholder="选择频道独立会话使用的智能体"
                clearable
                filterable
              />
            </n-form-item>
          </n-form>
          <template #footer>
            <div class="mgmt-form-footer">
              <n-button @click="showAddDrawer = false">取消</n-button>
              <n-button type="primary" @click="addChannel" :loading="loading">添加</n-button>
            </div>
          </template>
        </n-drawer-content>
      </n-drawer>

      <n-drawer v-model:show="showEditDrawer" :width="500" placement="right">
        <n-drawer-content title="编辑飞书频道">
          <n-form :model="editingChannel" label-placement="left" label-width="110">
            <n-form-item label="名称">
              <n-input v-model:value="editingChannel.name" placeholder="频道名称" />
            </n-form-item>
            <n-form-item label="Webhook 地址">
              <n-input v-model:value="editingChannel.config.webhookUrl" placeholder="飞书机器人 Webhook URL" />
            </n-form-item>
            <n-form-item label="签名密钥">
              <n-input v-model:value="editingChannel.config.secret" type="password" placeholder="消息签名验证密钥（可选）" />
            </n-form-item>
            <n-form-item label="绑定智能体">
              <n-select
                v-model:value="editingChannel.agentId"
                :options="agentOptions"
                placeholder="选择频道独立会话使用的智能体"
                clearable
                filterable
              />
            </n-form-item>
          </n-form>
          <template #footer>
            <div class="mgmt-form-footer">
              <n-button @click="showEditDrawer = false">取消</n-button>
              <n-button type="primary" @click="saveEditChannel" :loading="loading">保存</n-button>
            </div>
          </template>
        </n-drawer-content>
      </n-drawer>
    </div>

    <!-- 频道会话查看（设置界面风格） -->
    <div v-else class="channel-chat-view">
      <!-- 顶栏 -->
      <header class="chat-topbar">
        <div class="topbar-left">
          <n-button text size="small" @click="activeChannel = null" title="返回频道列表">
            <ArrowLeft :size="18" />
          </n-button>
          <div class="channel-icon feishu"><MessageCircle :size="16" /></div>
          <span class="topbar-title">{{ activeChannel.name }}</span>
          <n-tag :type="activeChannel.status === 'connected' ? 'success' : 'default'" size="small">
            {{ activeChannel.status === 'connected' ? '已连接' : '未连接' }}
          </n-tag>
        </div>
      </header>

      <div class="chat-main">
        <!-- 左侧会话导航 -->
        <nav class="chat-sidebar">
          <div class="sidebar-label">频道对话</div>
          <div class="sidebar-nav">
            <div
              v-for="conv in conversations"
              :key="conv.id"
              class="nav-item"
              :class="{ active: activeConversationId === conv.id }"
              @click="selectConversation(conv)"
            >
              <MessageSquare :size="14" class="nav-icon" />
              <span class="nav-item-text">{{ conv.externalUserId || '用户' }}</span>
              <span class="nav-item-count">{{ conv.messageCount }}</span>
            </div>
            <div v-if="conversations.length === 0" class="sidebar-empty">暂无对话</div>
          </div>
        </nav>

        <!-- 右侧内容区 -->
        <div class="chat-content">
          <template v-if="activeConversation">
            <div class="content-inner">
              <div class="section-header">
                <MessageCircle :size="16" class="section-header-icon" />
                <h3>{{ activeConversation.externalUserId || '用户' }} 的消息记录</h3>
                <span class="section-badge">{{ conversationMessages.length }} 条</span>
              </div>

              <div v-if="conversationMessages.length === 0" class="chat-empty">
                <p>暂无消息</p>
                <p class="hint">该对话还没有消息记录</p>
              </div>

              <div v-else class="msg-list">
                <div v-for="msg in chatMessages" :key="msg.id" class="msg-row">
                  <div class="msg-left">
                    <n-tag :type="msg.role === 'user' ? 'info' : 'success'" size="small">
                      {{ msg.role === 'user' ? '用户' : '智能体' }}
                    </n-tag>
                    <span class="msg-time">{{ msg.time }}</span>
                  </div>
                  <div class="msg-content">{{ msg.content }}</div>
                  <n-button quaternary size="tiny" title="复制" @click="copyMessage(msg.content)">
                    <template #icon><Copy :size="14" /></template>
                  </n-button>
                </div>
              </div>
            </div>
          </template>
          <div v-else class="chat-placeholder">
            <Radio :size="32" />
            <p>来自「{{ activeChannel.name }}」的消息将显示在此处</p>
            <p class="hint">选择一个左侧对话查看消息，或在外部发起对话</p>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useMessage } from 'naive-ui'
import {
  Plus, MoreVertical, MessageCircle, MessageSquare, ArrowLeft, Radio, Copy
} from 'lucide-vue-next'
import {
  getChannels, createChannel, updateChannel, deleteChannel, testChannel, toggleChannel,
  getChannelConversations, getChannelConversationMessages
} from './channelApi.js'
import { getAgents } from './channelApi.js'

const TYPE = 'feishu'

const message = useMessage()
const loading = ref(false)
const channels = ref([])
const agentOptions = ref([])
const showAddDrawer = ref(false)
const showEditDrawer = ref(false)

const newChannel = ref({ type: TYPE, name: '', config: {}, agentId: null })
const editingChannel = ref({ id: '', type: TYPE, name: '', config: {}, agentId: null })

// 会话查看状态
const activeChannel = ref(null)
const conversations = ref([])
const activeConversationId = ref(null)
const activeConversation = ref(null)
const conversationMessages = ref([])

const chatMessages = computed(() =>
  conversationMessages.value.map(msg => ({
    id: msg.id,
    role: msg.direction === 'inbound' ? 'user' : 'assistant',
    content: msg.contentText || '',
    time: formatTime(msg.createdAt)
  }))
)

function getChannelOptions(channel) {
  return [
    { label: '查看对话', key: 'view' },
    { label: '配置', key: 'configure' },
    { label: '测试连接', key: 'test' },
    { label: channel.enabled ? '禁用' : '启用', key: 'toggle' },
    { type: 'divider', key: 'd1' },
    { label: '删除', key: 'delete' }
  ]
}

function formatTime(ts) {
  const d = ts ? new Date(ts) : new Date()
  return d.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function openAddDrawer() {
  newChannel.value = { type: TYPE, name: '', config: {}, agentId: null }
  showAddDrawer.value = true
}

async function handleChannelAction(action, channel) {
  switch (action) {
    case 'view':
      activeChannel.value = { ...channel }
      await loadConversations(channel.id)
      break
    case 'configure':
      editingChannel.value = {
        id: channel.id,
        type: channel.type,
        name: channel.name,
        config: { ...(channel.config || {}) },
        agentId: channel.agentId || null
      }
      showEditDrawer.value = true
      break
    case 'test':
      message.loading(`正在测试 ${channel.name} 的连接...`)
      try {
        const result = await testChannel(channel.id)
        if (result.success) message.success(result.data?.message || '连接测试成功')
        else message.error(result.data?.message || '连接测试失败')
      } catch (error) {
        message.error(`测试失败: ${error.message}`)
      }
      break
    case 'toggle':
      try {
        const newEnabled = !channel.enabled
        const result = await toggleChannel(channel.id, newEnabled)
        if (result.success) {
          channel.enabled = newEnabled
          channel.status = newEnabled ? 'connected' : 'disconnected'
          message.success(result.message || `频道已${newEnabled ? '启用' : '禁用'}`)
        } else message.error(result.error || '操作失败')
      } catch (error) {
        message.error(`操作失败: ${error.message}`)
      }
      break
    case 'delete':
      try {
        const result = await deleteChannel(channel.id)
        if (result.success) {
          channels.value = channels.value.filter(c => c.id !== channel.id)
          message.success(`${channel.name} 已删除`)
        } else message.error(result.error || '删除失败')
      } catch (error) {
        message.error(`删除失败: ${error.message}`)
      }
      break
  }
}

async function addChannel() {
  if (!newChannel.value.name) {
    message.error('请输入频道名称')
    return
  }
  loading.value = true
  try {
    const payload = {
      name: newChannel.value.name,
      type: TYPE,
      config: newChannel.value.config,
      agentId: newChannel.value.agentId || null
    }
    const result = await createChannel(payload)
    if (result.success) {
      await loadChannels()
      showAddDrawer.value = false
      message.success('频道添加成功')
    } else message.error(result.error || '添加失败')
  } catch (error) {
    message.error(`添加失败: ${error.message}`)
  } finally {
    loading.value = false
  }
}

async function saveEditChannel() {
  if (!editingChannel.value.name) {
    message.error('请输入频道名称')
    return
  }
  loading.value = true
  try {
    const updateData = {
      name: editingChannel.value.name,
      type: TYPE,
      config: editingChannel.value.config,
      agentId: editingChannel.value.agentId || null
    }
    const result = await updateChannel(editingChannel.value.id, updateData)
    if (result.success) {
      await loadChannels()
      showEditDrawer.value = false
      message.success('频道配置已更新')
    } else message.error(result.error || '更新失败')
  } catch (error) {
    message.error(`更新失败: ${error.message}`)
  } finally {
    loading.value = false
  }
}

async function loadChannels() {
  try {
    const result = await getChannels()
    if (result.success && result.data) {
      channels.value = (result.data.channels || [])
        .filter(ch => ch.type === TYPE)
        .map(ch => ({ ...ch, status: ch.enabled ? 'connected' : 'disconnected' }))
    }
  } catch (error) {
    console.error('Failed to load channels:', error)
  }
}

async function loadAgentOptions() {
  try {
    const { agents } = await getAgents()
    agentOptions.value = (agents || []).map(a => ({ label: a.name, value: a.id }))
  } catch {
    agentOptions.value = []
  }
}

// === 会话查看 ===
async function loadConversations(channelId) {
  try {
    const result = await getChannelConversations(channelId)
    if (result.success && result.data) {
      conversations.value = result.data.conversations || []
    }
  } catch (error) {
    console.error('Failed to load conversations:', error)
  }
}

async function selectConversation(conv) {
  activeConversationId.value = conv.id
  activeConversation.value = conv
  await loadMessages(conv.id)
}

async function loadMessages(convId) {
  try {
    const result = await getChannelConversationMessages(activeChannel.value.id, convId)
    if (result.success && result.data) {
      conversationMessages.value = result.data.messages || []
    }
  } catch (e) {
    console.error('Failed to load messages:', e)
  }
}

function copyMessage(content) {
  navigator.clipboard.writeText(content)
  message.success('已复制到剪贴板')
}

onMounted(() => {
  loadChannels()
  loadAgentOptions()
})
</script>

<style scoped>
.channel-plugin-view {
  height: 100%;
  background: var(--bg-primary);
}

/* 列表态：复用全局 mgmt-view 的 900px 居中布局，插件内追加滚动 */
.channel-mgmt {
  height: 100%;
  overflow-y: auto;
}

.channel-chat-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

/* 顶栏（设置界面风格） */
.chat-topbar {
  height: 44px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  padding: 0 20px;
  border-bottom: 1px solid var(--border-color);
}

.topbar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.topbar-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
}

.channel-icon {
  width: 26px;
  height: 26px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.channel-icon.feishu { background: #3370ff; color: white; }

/* 主区域 */
.chat-main {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
}

/* 左侧会话导航（设置界面侧边栏风格） */
.chat-sidebar {
  width: 220px;
  flex-shrink: 0;
  border-right: 1px solid var(--border-color);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.chat-sidebar .sidebar-label {
  padding: 14px 16px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.6px;
}

.chat-sidebar .sidebar-nav {
  flex: 1;
  overflow-y: auto;
  padding: 4px 6px 12px;
}

.chat-sidebar .nav-item {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  text-align: left;
  padding: 7px 10px 7px 12px;
  font-size: 12px;
  color: var(--text-secondary);
  background: none;
  border: none;
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition: all .1s;
  font-family: inherit;
  line-height: 1.4;
}

.chat-sidebar .nav-item:hover { background: var(--bg-hover, var(--bg-tertiary)); color: var(--text-primary); }
.chat-sidebar .nav-item.active { background: var(--sidebar-active); color: var(--accent); font-weight: 500; }

.chat-sidebar .nav-icon { opacity: 0.5; flex-shrink: 0; }
.chat-sidebar .nav-item.active .nav-icon { opacity: 1; }

.nav-item-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.nav-item-count {
  font-size: 10px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  border-radius: var(--radius-xs);
  padding: 0 5px;
  line-height: 16px;
  flex-shrink: 0;
}

.sidebar-empty {
  padding: 16px 10px;
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}

/* 右侧内容区（设置界面内容风格） */
.chat-content {
  flex: 1;
  overflow-y: auto;
  min-width: 0;
}

.chat-content .content-inner {
  max-width: 900px;
  margin: 0 auto;
  padding: 24px 32px 60px;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
  margin-bottom: 4px;
}

.section-header h3 {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.section-header-icon { color: var(--accent); flex-shrink: 0; }

.section-badge {
  font-size: 9px;
  padding: 1px 6px;
  border-radius: var(--radius-xs);
  background: var(--bg-tertiary);
  color: var(--text-muted);
  font-weight: 600;
}

/* 消息列表（设置行风格） */
.msg-list {
  border-top: 1px solid var(--border-color);
}

.msg-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 8px;
  border-bottom: 1px solid var(--border-color);
  transition: background .1s;
}

.msg-row:hover { background: var(--bg-hover, var(--bg-tertiary)); }

.msg-left {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 130px;
  flex-shrink: 0;
  padding-top: 2px;
}

.msg-time {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
}

.msg-content {
  flex: 1;
  font-size: 13px;
  color: var(--text-primary);
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-wrap;
}

.msg-row :deep(.n-button) { opacity: 0; transition: opacity .1s; }
.msg-row:hover :deep(.n-button) { opacity: 1; }

.chat-empty {
  padding: 40px 0;
  text-align: center;
  color: var(--text-muted);
}

.chat-empty p { margin: 0; font-size: 13px; }
.chat-empty .hint { font-size: 12px; opacity: 0.7; margin-top: 4px; }

.chat-placeholder {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-muted);
  text-align: center;
  padding: 24px;
}

.chat-placeholder p { font-size: 13px; color: var(--text-muted); margin: 0; }
.chat-placeholder .hint { font-size: 12px; opacity: 0.7; }
</style>
