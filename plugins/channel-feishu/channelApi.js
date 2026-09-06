const API_BASE = '/api'

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers }
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || data.message || `请求失败 (${response.status})`)
  return data
}

const get = path => request(path)
const post = (path, body = {}) => request(path, { method: 'POST', body: JSON.stringify(body) })
const put = (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body) })
const del = path => request(path, { method: 'DELETE' })

export const getChannels = () => get('/channels')
export const createChannel = payload => post('/channels', payload)
export const updateChannel = (id, payload) => put(`/channels/${encodeURIComponent(id)}`, payload)
export const deleteChannel = id => del(`/channels/${encodeURIComponent(id)}`)
export const testChannel = id => post(`/channels/${encodeURIComponent(id)}/test`)
export const toggleChannel = (id, enabled) => post(`/channels/${encodeURIComponent(id)}/toggle`, { enabled })
export const getChannelConversations = id => get(`/channels/${encodeURIComponent(id)}/conversations`)
export const getChannelConversationMessages = (channelId, conversationId) => get(`/channels/${encodeURIComponent(channelId)}/conversations/${encodeURIComponent(conversationId)}/messages`)

export async function getAgents() {
  const response = await get('/agents?includeArchived=true')
  if (response.success === false) throw new Error(response.error || '加载智能体失败')
  const data = response.data ?? response
  const agents = Array.isArray(data) ? data : data.agents || []
  return { agents, total: data.total ?? agents.length }
}
