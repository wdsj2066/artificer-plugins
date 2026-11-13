<template>
  <div class="skillhub-market">
    <div class="market-header">
      <div>
        <h3>Skill 市场</h3>
        <p>来自 SkillHub 社区，整包安装到本地技能目录</p>
      </div>
      <div class="market-header-actions">
        <n-tag v-if="hasKey" size="small" type="success" :bordered="false">已配置密钥</n-tag>
        <n-tooltip trigger="hover">
          <template #trigger>
            <n-button quaternary size="small" aria-label="刷新市场" @click="reload">
              <template #icon><RefreshCw :size="15" /></template>
            </n-button>
          </template>
          刷新市场
        </n-tooltip>
      </div>
    </div>

    <div class="market-toolbar">
      <n-input v-model:value="keyword" clearable placeholder="搜索技能..." @keydown="onSearchKeydown">
        <template #prefix><Search :size="15" /></template>
      </n-input>
      <n-select v-model:value="sortBy" :options="sortOptions" style="width: 118px" @update:value="applySearch" />
      <span v-if="!loading && !error" class="market-count">共 {{ total }} 项</span>
    </div>

    <div v-if="loading" class="market-state"><n-spin size="small" /> 正在加载市场...</div>
    <div v-else-if="error" class="market-state market-state--error">
      <span>{{ error }}</span>
      <n-button text type="primary" @click="load">重试</n-button>
    </div>
    <div v-else-if="!skills.length" class="market-state">
      {{ keyword ? '未找到匹配的技能' : '市场暂时没有可用技能' }}
    </div>
    <div v-else class="market-grid">
      <article v-for="item in skills" :key="item.slug" class="market-card">
        <div class="market-card-top">
          <img v-if="item.iconUrl" :src="item.iconUrl" class="market-icon-img" alt="" loading="lazy" />
          <div v-else class="market-icon"><Store :size="18" /></div>
          <h4>{{ item.name }}</h4>
        </div>
        <p class="market-desc">{{ item.description || '暂无描述' }}</p>
        <div class="market-meta">
          <span v-if="item.version">v{{ item.version }}</span>
          <span>{{ item.publisher || item.namespace || 'SkillHub' }}</span>
          <span class="market-download"><Download :size="12" /> {{ formatCount(item.downloads) }}</span>
        </div>
        <div class="market-tags" aria-label="技能标签">
          <n-tag v-for="tag in item.tags.slice(0, 3)" :key="tag" size="tiny" :bordered="false">{{ tag }}</n-tag>
          <n-tag v-if="item.tags.length > 3" size="tiny" :bordered="false">+{{ item.tags.length - 3 }}</n-tag>
        </div>
        <div class="market-footer">
          <span class="market-verified">
            <BadgeCheck v-if="item.verified" :size="13" />
            {{ item.verified ? '已认证' : '社区' }}
          </span>
          <n-button
            size="small"
            type="primary"
            :loading="installing === item.slug"
            :disabled="isInstalled(item)"
            @click="install(item)"
          >
            <template #icon><Download :size="14" /></template>
            {{ isInstalled(item) ? '已安装' : '安装' }}
          </n-button>
        </div>
      </article>
    </div>

    <div v-if="!loading && !error && total > pageSize" class="market-pager">
      <n-pagination
        v-model:page="page"
        :page-count="totalPages"
        :page-slot="7"
        size="small"
        @update:page="onPageChange"
      />
    </div>

    <p class="market-note">技能包会完整写入本地技能目录（references/scripts 一并保留），图片等非文本附件自动跳过；内容来自第三方社区，请自行确认来源可信。</p>
  </div>
</template>

<script setup>
import { computed, inject, onMounted, ref } from 'vue'
import { NButton, NInput, NPagination, NSelect, NSpin, NTag, NTooltip } from 'naive-ui'
import { BadgeCheck, Download, RefreshCw, Search, Store } from 'lucide-vue-next'

const api = inject('artificer', null)

const sortOptions = [
  { label: '下载量', value: 'downloads' },
  { label: '星标', value: 'stars' },
  { label: '最新更新', value: 'updated_at' },
  { label: '最新收录', value: 'created_at' }
]

const skills = ref([])
const keyword = ref('')
const activeKeyword = ref('')
const sortBy = ref('downloads')
const page = ref(1)
const pageSize = ref(20)
const total = ref(0)
const loading = ref(false)
const error = ref('')
const installing = ref('')
const hasKey = ref(false)
const installedIds = ref(new Set())

const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))

function toast(content, type = 'info') {
  if (api?.toast) api.toast(content, type)
}

function formatCount(value) {
  const count = Number(value) || 0
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`
  return String(count)
}

function toSkillId(slug) {
  const cleaned = String(slug || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return `skillhub-${cleaned || 'skill'}`
}

function isInstalled(item) {
  return installedIds.value.has(toSkillId(item.slug))
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const params = new URLSearchParams({
      page: String(page.value),
      pageSize: String(pageSize.value),
      sortBy: sortBy.value
    })
    if (activeKeyword.value) params.set('keyword', activeKeyword.value)
    const response = await fetch(`/api/plugins/skillhub-market/list?${params.toString()}`)
    const data = await response.json()
    if (!data.success) throw new Error(data.error || '加载市场失败')
    skills.value = data.skills || []
    total.value = data.total || 0
  } catch (err) {
    error.value = err.message || '加载市场失败'
  } finally {
    loading.value = false
  }
}

async function loadInstalled() {
  try {
    const response = await fetch('/api/skills')
    const data = await response.json()
    const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data?.data?.skills) ? data.data.skills : [])
    installedIds.value = new Set(list.map(item => item.id))
  } catch {
    // 仅影响按钮状态，失败时保留默认值
  }
}

async function loadAuthState() {
  try {
    const response = await fetch('/api/plugins/skillhub-market/auth-state')
    const data = await response.json()
    hasKey.value = Boolean(data.hasKey)
  } catch {
    hasKey.value = false
  }
}

function onSearchKeydown(event) {
  if (event?.key !== 'Enter') return
  event.preventDefault?.()
  applySearch()
}

function applySearch() {
  activeKeyword.value = keyword.value.trim()
  page.value = 1
  load()
}

function onPageChange(next) {
  page.value = next
  load()
}

function reload() {
  load()
  loadInstalled()
  loadAuthState()
}

async function install(item) {
  if (installing.value) return
  installing.value = item.slug
  try {
    const response = await fetch('/api/plugins/skillhub-market/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: item.slug, namespace: item.namespace || '' })
    })
    const result = await response.json()
    if (!result.success) throw new Error(result.error || '安装失败')

    await fetch('/api/skills/sync', { method: 'POST' }).catch(() => {})
    installedIds.value = new Set([...installedIds.value, result.id, result.registeredId].filter(Boolean))

    const skipped = result.skipped && result.skipped.length ? `，跳过 ${result.skipped.length} 个非文本附件` : ''
    toast(`已安装「${item.name}」（${result.files.length} 个文件${skipped}）`, 'success')
  } catch (err) {
    toast(err.message || '安装失败', 'error')
  } finally {
    installing.value = ''
  }
}

onMounted(() => {
  load()
  loadInstalled()
  loadAuthState()
})
</script>

<style scoped>
.skillhub-market {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 80vh;
  max-height: 80vh;
  overflow: hidden;
  color: var(--text-primary);
}

.market-header,
.market-toolbar,
.market-card-top,
.market-meta,
.market-footer,
.market-header-actions,
.market-download,
.market-verified {
  display: flex;
  align-items: center;
}

.market-header {
  justify-content: space-between;
  gap: 12px;
}

.market-header h3 {
  margin: 0;
  font-size: 14px;
}

.market-header p {
  margin: 4px 0 0;
  font-size: 11.5px;
  color: var(--text-muted);
}

.market-header-actions {
  gap: 6px;
}

.market-toolbar {
  gap: 10px;
}

.market-toolbar .n-input {
  flex: 1;
}

.market-count {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--text-muted);
}

.market-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: max-content;
  align-content: start;
  gap: 12px;
  flex: 1;
  min-height: 0;
  padding-right: 4px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

@media (max-width: 720px) {
  .market-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.market-card {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  overflow: hidden;
  border-radius: var(--radius-md);
  background: var(--surface);
  border: 1px solid color-mix(in srgb, var(--text-muted) 24%, transparent);
}

.market-icon {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  color: var(--accent);
  background: color-mix(in srgb, var(--text-muted) 10%, transparent);
  border-radius: var(--radius-xs);
}

.market-icon-img {
  width: 32px;
  height: 32px;
  flex: 0 0 auto;
  border-radius: var(--radius-xs);
  object-fit: cover;
}

.market-card-top {
  gap: 10px;
  min-width: 0;
}

.market-card h4 {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  color: var(--text-primary);
  font-size: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.market-desc {
  display: -webkit-box;
  min-height: 32px;
  margin: 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 11.5px;
  line-height: 1.45;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.market-meta {
  gap: 10px;
  color: var(--text-muted);
  font-size: 11px;
}

.market-download {
  gap: 3px;
}

.market-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  min-height: 20px;
}

.market-footer {
  justify-content: space-between;
  gap: 8px;
  margin-top: 2px;
  padding-top: 10px;
  border-top: 1px solid color-mix(in srgb, var(--text-muted) 18%, transparent);
}

.market-verified {
  gap: 4px;
  color: var(--text-muted);
  font-size: 11px;
}

.market-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  flex: 1;
  min-height: 90px;
  color: var(--text-muted);
  font-size: 11.5px;
}

.market-state--error {
  color: var(--error-color, #d03050);
}

.market-pager {
  display: flex;
  justify-content: center;
  flex: 0 0 auto;
}

.market-note {
  margin: 0;
  flex: 0 0 auto;
  font-size: 10.5px;
  line-height: 1.5;
  color: var(--text-muted);
}
</style>
