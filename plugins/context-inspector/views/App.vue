<template>
  <div class="ci-page">
    <div class="ci-inner">
      <header class="ci-head">
        <div class="ci-head-text">
          <h1>上下文查看</h1>
          <p>查看每次 AI 请求的上下文占用与分类构成；供应商返回 usage 时用真实值，缺失时按字符估算。</p>
        </div>
        <div class="ci-head-actions">
          <select v-if="sessions.length > 1" v-model="selectedSession" class="ci-select" @change="reload">
            <option v-for="item in sessions" :key="item.sessionId" :value="item.sessionId">{{ item.label }}</option>
          </select>
          <button class="ci-btn" :disabled="loading" @click="reload">{{ loading ? '刷新中' : '刷新' }}</button>
          <button class="ci-btn ghost" :disabled="!items.length" @click="clearAll">清空</button>
        </div>
      </header>

      <p v-if="error" class="ci-error">{{ error }}</p>

      <div v-if="!loading && !snapshot" class="ci-empty">
        <div class="ci-empty-title">还没有上下文记录</div>
        <p>发送一条消息后，插件会自动记录本次请求的系统提示词、工具定义、文件、工具结果与会话内容的占用。</p>
        <p class="ci-tip">数据来自 AI 调用的 buildMessages / aiCall 阶段，选择“真实用量”时读取供应商返回的 usage，否则按字符估算。</p>
      </div>

      <template v-if="snapshot">
        <section class="ci-card">
          <div class="ci-card-head">
            <div class="ci-card-title">
              上下文窗口
              <span v-if="snapshot.model" class="ci-model">{{ snapshot.model }}</span>
              <span class="ci-source" :class="snapshot.source">{{ snapshot.source === 'usage' ? '真实用量' : '估算' }}</span>
              <span class="ci-tag" :class="status.tone">{{ status.label }}</span>
            </div>
            <div class="ci-card-sub">{{ formatTime(snapshot.at) }} · 第 {{ activeIndex + 1 }} / {{ items.length }} 次请求 · 上限{{ limitSourceLabel }}</div>
          </div>

          <div class="ci-metrics">
            <div class="ci-metric">
              <div class="ci-label">已用上下文</div>
              <div class="ci-big">
                {{ formatTokens(snapshot.promptTokens) }}
                <span class="ci-big-sub">/ {{ formatTokens(snapshot.limit) }} token</span>
              </div>
              <div class="ci-note">
                已用 {{ percent(snapshot.promptTokens, snapshot.limit) }} · 约还能容纳 {{ remainingRequests }} 个同类请求
              </div>
            </div>
            <div class="ci-metric">
              <div class="ci-label">提示词缓存</div>
              <div class="ci-big">
                {{ snapshot.cacheRate == null ? '未知' : Math.round(snapshot.cacheRate * 100) + '%' }}
                <span v-if="snapshot.cacheRate != null" class="ci-big-sub">命中</span>
              </div>
              <div class="ci-note">
                <template v-if="snapshot.cachedTokens != null">
                  {{ formatTokens(snapshot.cachedTokens) }} 来自缓存 ·
                  {{ formatTokens(Math.max(0, snapshot.promptTokens - snapshot.cachedTokens)) }} 新增
                </template>
                <template v-else>该供应商未返回缓存用量</template>
              </div>
              <div v-if="snapshot.cacheRate != null" class="ci-cache-bar">
                <div class="ci-cache-fill" :style="{ width: (snapshot.cacheRate * 100).toFixed(1) + '%' }"></div>
              </div>
            </div>
          </div>

          <div class="ci-grid-wrap" @mouseleave="hideTip">
            <div class="ci-grid-bar">
              <span
                v-for="(cell, index) in cells"
                :key="index"
                class="ci-cell"
                :style="{ background: cell.color }"
                @mouseenter="onEnterCell(cell, $event)"
                @click="openKind(cell.kind || 'all')"
              ></span>
            </div>
            <div
              v-if="tip.visible"
              class="ci-cell-tip"
              :class="{ below: tip.below }"
              :style="{ left: tip.left + 'px', top: tip.top + 'px' }"
            >
              <div class="ci-tip-head">
                <i :style="{ background: tip.kind ? colorOf(tip.kind) : 'var(--bg-tertiary)' }"></i>
                <span>{{ tip.label }}</span>
                <span class="ci-tip-share">
                  <template v-if="tip.kind">{{ formatTokens(tip.tokens) }} · {{ tip.share }}</template>
                  <template v-else>剩余容量</template>
                </span>
              </div>
              <div v-for="row in tip.rows" :key="row.label" class="ci-tip-row">
                <span>{{ row.label }}</span>
                <b>{{ formatTokens(row.tokens) }}</b>
              </div>
              <div v-if="tip.more > 0" class="ci-tip-more">另外 {{ tip.more }} 项</div>
              <div v-else-if="!tip.rows.length" class="ci-tip-more">{{ tip.kind ? '该类明细未收录' : '超出已用部分' }}</div>
            </div>
          </div>

          <div class="ci-legend">
            <button
              v-for="segment in segments"
              :key="segment.key"
              class="ci-legend-item"
              :class="{ active: filter === segment.key }"
              :title="'打开 ' + segment.label + ' 明细'"
              @click="openKind(segment.key)"
            >
              <i :style="{ background: segment.color }"></i>
              {{ segment.label }}
              <b>{{ formatTokens(segment.value) }}</b>
            </button>
          </div>
        </section>

        <section class="ci-card">
          <div class="ci-section-head">
            <span class="ci-section-title">内容明细（Top {{ Math.min(items.length ? 12 : 0, 12) }}）</span>
            <div class="ci-filters">
              <button
                v-for="option in filterOptions"
                :key="option.key"
                class="ci-chip"
                :class="{ active: filter === option.key }"
                @click="filter = option.key"
              >{{ option.label }}</button>
            </div>
          </div>

          <div v-if="filter !== 'all'" class="ci-filter-bar">
            <span>已只看 {{ filterLabel }} · {{ formatTokens(filterTokens) }}</span>
            <button class="ci-filter-clear" @click="clearFilter">取消筛选</button>
          </div>

          <div v-if="!filteredItems.length" class="ci-muted">当前筛选没有内容</div>
          <ul v-else class="ci-items">
            <li v-for="item in visibleItems" :key="item.kind + item.label" class="ci-item" @click="openItem(item)">
              <i class="ci-item-dot" :style="{ background: colorOf(item.kind) }"></i>
              <span class="ci-item-label">{{ item.label }}</span>
              <span v-if="item.count > 1" class="ci-item-count">x{{ item.count }}</span>
              <span class="ci-item-bar"><i :style="{ width: barWidth(item.tokens), background: colorOf(item.kind) }"></i></span>
              <span class="ci-item-token">{{ formatTokens(item.tokens) }}</span>
            </li>
          </ul>
          <button v-if="filteredItems.length > itemLimit" class="ci-more" @click="itemLimit = itemLimit === 12 ? 100 : 12">
            {{ itemLimit === 12 ? '显示全部 ' + filteredItems.length + ' 项' : '收起' }}
          </button>
          <p class="ci-hint">点击任意条目或上方色块，打开明细窗口查看完整内容。</p>
        </section>

        <section class="ci-card">
          <div class="ci-section-head">
            <span class="ci-section-title">最近请求（{{ items.length }} / {{ keepLimit }}）</span>
            <span class="ci-muted small">点击查看单次明细</span>
          </div>
          <ul class="ci-requests">
            <li
              v-for="(item, index) in items"
              :key="item.id"
              class="ci-request"
              :class="{ active: index === activeIndex }"
              @click="activeIndex = index"
            >
              <span class="ci-request-time">{{ formatTime(item.at) }}</span>
              <span class="ci-request-phase" :class="item.phase">{{ item.phase === 'before' ? '发起' : '完成' }}</span>
              <span class="ci-request-model">{{ item.model || '未知模型' }}</span>
              <span class="ci-request-msg">{{ item.messageCount }} 条消息 · {{ item.toolCount }} 个工具</span>
              <span class="ci-request-bar"><i :style="{ width: widthPercent(item.promptTokens, item.limit), background: statusColor(item) }"></i></span>
              <span class="ci-request-token">{{ formatTokens(item.promptTokens) }}</span>
              <span class="ci-request-percent">{{ percent(item.promptTokens, item.limit) }}</span>
            </li>
          </ul>
        </section>
      </template>
    </div>

    <Teleport to="body">
      <div v-if="modal.open" class="ci-overlay" @click.self="closeModal">
        <div class="ci-modal" role="dialog" aria-modal="true">
          <header class="ci-modal-head">
            <div class="ci-modal-title">
              内容明细
              <span class="ci-modal-sub">{{ modalKindLabel }} · {{ formatTokens(modalTotal) }} token · {{ modalItems.length }} 项</span>
            </div>
            <div class="ci-modal-actions">
              <button class="ci-btn" :disabled="!currentText" @click="copyCurrent">复制</button>
              <button class="ci-btn ghost" @click="closeModal">关闭</button>
            </div>
          </header>

          <div class="ci-modal-filters">
            <button
              v-for="option in filterOptions"
              :key="option.key"
              class="ci-chip"
              :class="{ active: modal.kind === option.key }"
              @click="modal.kind = option.key; modal.itemKey = ''"
            >{{ option.label }}</button>
          </div>

          <div class="ci-modal-body">
            <ul class="ci-modal-list">
              <li
                v-for="item in modalItems"
                :key="item.kind + item.label"
                class="ci-modal-item"
                :class="{ active: currentItem && currentKey === item.kind + '|' + item.label }"
                @click="modal.itemKey = item.kind + '|' + item.label"
              >
                <i :style="{ background: colorOf(item.kind) }"></i>
                <span class="ci-modal-item-label">{{ item.label }}</span>
                <span v-if="item.count > 1" class="ci-item-count">x{{ item.count }}</span>
                <span class="ci-modal-item-token">{{ formatTokens(item.tokens) }}</span>
              </li>
            </ul>

            <div class="ci-modal-detail">
              <div class="ci-modal-detail-head">
                <span>{{ currentItem ? currentItem.label : '无内容' }}</span>
                <span v-if="currentItem" class="ci-muted small">
                  {{ formatTokens(currentItem.tokens) }} token · 出现 {{ currentItem.count }} 次
                  <template v-if="currentItem.truncated"> · 已截断</template>
                </span>
              </div>
              <pre class="ci-modal-text">{{ currentText }}</pre>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';

const props = defineProps({
  sessionId: { type: String, default: '' }
});

const SEGMENTS = [
  { key: 'system', label: '系统提示词', color: '#8b6bf0' },
  { key: 'tools', label: '工具', color: '#2fa8c2' },
  { key: 'files', label: '文件', color: '#22a877' },
  { key: 'toolResults', label: '工具结果', color: '#e2588c' },
  { key: 'conversation', label: '会话内容', color: '#4f6ef0' }
];

const GRID_TOTAL = 440;

const items = ref([]);
const sessions = ref([]);
const settings = ref({ keep: 10 });
const loading = ref(true);
const error = ref('');
const selectedSession = ref(props.sessionId || '');
const activeIndex = ref(0);
const filter = ref('all');
const itemLimit = ref(12);
const gridWrap = ref(null);
const tip = reactive({
  visible: false,
  kind: null,
  label: '',
  tokens: 0,
  share: '',
  rows: [],
  more: 0,
  below: false,
  left: 0,
  top: 0
});
const modal = reactive({ open: false, kind: 'all', itemKey: '' });

const filterOptions = computed(() => [
  { key: 'all', label: '全部' },
  ...SEGMENTS.map((segment) => ({ key: segment.key, label: segment.label }))
]);

const keepLimit = computed(() => Number(settings.value.keep) || 10);

const snapshot = computed(() => items.value[activeIndex.value] || items.value[0] || null);

const segments = computed(() => {
  const breakdown = (snapshot.value && snapshot.value.breakdown) || {};
  return SEGMENTS.map((segment) => ({ ...segment, value: breakdown[segment.key] || 0 }));
});

const limitSourceLabel = computed(() => {
  const source = (snapshot.value && snapshot.value.limitSource) || 'settings-default';
  if (source === 'host') return '来自宿主模型配置';
  if (source === 'settings-model') return '来自插件设置（按模型）';
  return '来自插件设置（默认值）';
});

const status = computed(() => {
  const snap = snapshot.value;
  if (!snap) return { label: '无数据', tone: 'muted' };
  const rate = snap.limit > 0 ? snap.promptTokens / snap.limit : 0;
  if (rate >= 1) return { label: '已满', tone: 'danger' };
  if (rate >= 0.8) return { label: '接近上限', tone: 'warn' };
  return { label: '充足', tone: 'ok' };
});

const cells = computed(() => {
  const snap = snapshot.value;
  if (!snap) return [];
  const used = segments.value.reduce((sum, segment) => sum + segment.value, 0);
  const denom = Math.max(used, snap.limit || 0, 1);
  const perCell = denom / GRID_TOTAL;
  const ranges = [];
  let accumulated = 0;
  for (const segment of segments.value) {
    const end = accumulated + segment.value;
    ranges.push({ ...segment, end });
    accumulated = end;
  }
  const result = [];
  for (let index = 0; index < GRID_TOTAL; index += 1) {
    const position = ((index + 0.5) / GRID_TOTAL) * denom;
    const hit = position <= used ? ranges.find((range) => position < range.end) : null;
    if (!hit) {
      result.push({
        kind: null,
        color: 'var(--bg-tertiary)',
        tip: '空闲容量 · 约 ' + formatTokens(Math.round(perCell)) + ' token'
      });
      continue;
    }
    result.push({
      kind: hit.key,
      color: hit.color,
      tip: hit.label + ' · 约 ' + formatTokens(Math.round(perCell)) + ' token · 点击打开明细'
    });
  }
  return result;
});

const filteredItems = computed(() => {
  const list = (snapshot.value && snapshot.value.items) || [];
  if (filter.value === 'all') return list;
  return list.filter((item) => item.kind === filter.value);
});

const visibleItems = computed(() => filteredItems.value.slice(0, itemLimit.value));

const filterLabel = computed(() => {
  const found = SEGMENTS.find((segment) => segment.key === filter.value);
  return found ? found.label : '全部';
});

const filterTokens = computed(() => {
  const found = segments.value.find((segment) => segment.key === filter.value);
  return found ? found.value : 0;
});

const maxItemTokens = computed(() => {
  let max = 0;
  for (const item of filteredItems.value) max = Math.max(max, item.tokens || 0);
  return max || 1;
});

const remainingRequests = computed(() => {
  const snap = snapshot.value;
  if (!snap || !snap.promptTokens) return '若干';
  const left = snap.limit - snap.promptTokens;
  if (left <= 0) return 0;
  return Math.floor(left / Math.max(1, snap.promptTokens));
});

const modalItems = computed(() => {
  const list = (snapshot.value && snapshot.value.items) || [];
  if (modal.kind === 'all') return list;
  return list.filter((item) => item.kind === modal.kind);
});

const modalTotal = computed(() => modalItems.value.reduce((sum, item) => sum + (item.tokens || 0), 0));

const modalKindLabel = computed(() => {
  const found = SEGMENTS.find((segment) => segment.key === modal.kind);
  return found ? found.label : '全部';
});

const currentKey = computed(() => {
  if (modal.itemKey) return modal.itemKey;
  const first = modalItems.value[0];
  return first ? first.kind + '|' + first.label : '';
});

const currentItem = computed(() => {
  const key = currentKey.value;
  if (!key) return null;
  return modalItems.value.find((item) => item.kind + '|' + item.label === key) || null;
});

const currentText = computed(() => {
  const item = currentItem.value;
  if (!item) return '';
  if (item.preview) return item.preview + (item.truncated ? '\n\n…（已截断，仅保留前 2000 字）' : '');
  return '该项没有可显示的文本内容（可能是图片、二进制或已省略）。';
});

function colorOf(kind) {
  const found = SEGMENTS.find((segment) => segment.key === kind);
  return found ? found.color : 'var(--text-muted)';
}

function statusColor(item) {
  const rate = item.limit > 0 ? item.promptTokens / item.limit : 0;
  if (rate >= 1) return 'var(--diff-del-color)';
  if (rate >= 0.8) return 'var(--warning-color)';
  return 'var(--diff-add-color)';
}

function formatTokens(value) {
  const number = Number(value) || 0;
  if (number >= 1000000) return (number / 1000000).toFixed(1) + 'M';
  if (number >= 1000) return (number / 1000).toFixed(number >= 100000 ? 0 : 1) + 'K';
  return String(number);
}

function percent(value, limit) {
  if (!limit) return '0%';
  return Math.round((value / limit) * 100) + '%';
}

function widthPercent(value, limit) {
  if (!limit) return '0%';
  return Math.min(100, Math.round((value / limit) * 100)) + '%';
}

function barWidth(tokens) {
  return Math.max(2, Math.round((tokens / maxItemTokens.value) * 100)) + '%';
}

function formatTime(value) {
  if (!value) return '--:--:--';
  const date = new Date(value);
  const pad = (num) => String(num).padStart(2, '0');
  return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
}

function onEnterCell(cell, event) {
  const wrap = gridWrap.value;
  if (!wrap) return;
  const rect = wrap.getBoundingClientRect();
  const kind = cell.kind;
  const segment = SEGMENTS.find((entry) => entry.key === kind);
  const breakdown = (snapshot.value && snapshot.value.breakdown) || {};
  const prompt = (snapshot.value && snapshot.value.promptTokens) || 0;
  const total = kind ? breakdown[kind] || 0 : 0;
  const all = ((snapshot.value && snapshot.value.items) || []).filter((item) => item.kind === kind);
  const rows = all.slice(0, 5);
  tip.kind = kind || null;
  tip.label = segment ? segment.label : (kind ? '其他' : '空闲容量');
  tip.tokens = total;
  tip.share = kind && prompt > 0 ? Math.round((total / prompt) * 100) + '%' : '';
  tip.rows = rows;
  tip.more = Math.max(0, all.length - rows.length);
  tip.below = event.clientY - rect.top < 140;
  tip.left = Math.min(Math.max(event.clientX - rect.left, 120), Math.max(120, rect.width - 120));
  tip.top = event.clientY - rect.top;
  tip.visible = true;
}

function hideTip() {
  tip.visible = false;
}

function openKind(kind) {
  if (!kind) return;
  modal.kind = kind;
  modal.itemKey = '';
  modal.open = true;
}

function openItem(item) {
  if (!item) return;
  modal.kind = item.kind;
  modal.itemKey = item.kind + '|' + item.label;
  modal.open = true;
}

function closeModal() {
  modal.open = false;
}

function clearFilter() {
  filter.value = 'all';
  itemLimit.value = 12;
}

async function copyCurrent() {
  const text = currentText.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    window.artificer?.toast?.('已复制', 'success');
  } catch (cause) {
    window.artificer?.toast?.('复制失败', 'error');
  }
}

function onKeydown(event) {
  if (event.key === 'Escape' && modal.open) closeModal();
}

async function load(showLoading = true) {
  if (showLoading) loading.value = true;
  error.value = '';
  try {
    const query = selectedSession.value ? '?sessionId=' + encodeURIComponent(selectedSession.value) : '';
    const response = await fetch('/api/plugins/context-inspector/snapshot' + query);
    const json = await response.json();
    const payload = (json && json.data) || json || {};
    items.value = Array.isArray(payload.items) ? payload.items : [];
    sessions.value = Array.isArray(payload.sessions) ? payload.sessions : [];
    if (payload.settings) settings.value = payload.settings;
    if (!selectedSession.value && payload.sessionId) selectedSession.value = payload.sessionId;
    if (activeIndex.value >= items.value.length) activeIndex.value = 0;
  } catch (cause) {
    error.value = '读取失败：' + ((cause && cause.message) || '未知错误');
  } finally {
    loading.value = false;
  }
}

function reload() {
  load(true);
}

async function clearAll() {
  try {
    await fetch('/api/plugins/context-inspector/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: selectedSession.value, all: !selectedSession.value })
    });
    await load(true);
  } catch (cause) {
    error.value = '清空失败：' + ((cause && cause.message) || '未知错误');
  }
}

watch(() => props.sessionId, (value) => {
  if (value && value !== selectedSession.value) {
    selectedSession.value = value;
    load(true);
  }
});

let timer = null;
onMounted(() => {
  load(true);
  timer = setInterval(() => load(false), 15000);
  window.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
  window.removeEventListener('keydown', onKeydown);
});
</script>

<style scoped>
.ci-page {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 26px 24px 48px;
  color: var(--text-primary);
  font-family: var(--font-body, inherit);
  font-size: 13px;
  line-height: 1.6;
  box-sizing: border-box;
  background: transparent;
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) transparent;
}

.ci-page::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}

.ci-page::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: 5px;
}

.ci-page::-webkit-scrollbar-track {
  background: transparent;
}

.ci-inner {
  max-width: 1180px;
  margin: 0 auto;
}

.ci-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 18px;
}

.ci-head-text h1 {
  margin: 0 0 4px;
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

.ci-head-text p {
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.ci-head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}

.ci-source,
.ci-tag {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  white-space: nowrap;
  font-weight: 400;
}

.ci-source.usage,
.ci-tag.ok {
  color: var(--diff-add-color);
  border-color: color-mix(in srgb, var(--diff-add-color) 45%, transparent);
}

.ci-source.estimate,
.ci-tag.warn {
  color: var(--warning-color);
  border-color: color-mix(in srgb, var(--warning-color) 45%, transparent);
}

.ci-tag.danger {
  color: var(--diff-del-color);
  border-color: color-mix(in srgb, var(--diff-del-color) 45%, transparent);
}

.ci-tag.muted {
  color: var(--text-muted);
}

.ci-select,
.ci-btn {
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-primary);
  border-radius: var(--radius-sm, 6px);
  padding: 5px 12px;
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.ci-select {
  max-width: 180px;
}

.ci-btn.ghost {
  background: transparent;
}

.ci-select:hover,
.ci-btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.ci-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ci-select:focus-visible,
.ci-btn:focus-visible,
.ci-chip:focus-visible,
.ci-more:focus-visible,
.ci-legend-item:focus-visible {
  outline: 2px solid var(--focus-outline-color);
  outline-offset: 1px;
}

.ci-error {
  margin: 0 0 12px;
  color: var(--diff-del-color);
  font-size: 12px;
}

.ci-empty {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md, 8px);
  padding: 28px 24px;
  background: var(--panel-surface);
}

.ci-empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.ci-empty p {
  margin: 6px 0;
  color: var(--text-secondary);
}

.ci-tip {
  font-size: 12px;
  color: var(--text-muted);
}

.ci-card {
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md, 8px);
  background: var(--panel-surface);
  padding: 18px 20px;
  margin-bottom: 18px;
}

.ci-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.ci-card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.ci-model {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-secondary);
}

.ci-card-sub {
  font-size: 11px;
  color: var(--text-muted);
}

.ci-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 18px;
}

.ci-label {
  font-size: 12px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.ci-big {
  font-size: 30px;
  font-weight: 600;
  line-height: 1.25;
  margin-top: 4px;
  letter-spacing: -0.5px;
  color: var(--text-primary);
}

.ci-big-sub {
  font-size: 13px;
  font-weight: 400;
  color: var(--text-muted);
}

.ci-note {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 2px;
}

.ci-cache-bar {
  margin-top: 8px;
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-muted) 24%, transparent);
  overflow: hidden;
}

.ci-cache-fill {
  height: 100%;
  background: var(--diff-add-color);
}

.ci-grid-wrap {
  position: relative;
  margin: 26px 0 16px;
}

.ci-grid-bar {
  display: grid;
  grid-template-columns: repeat(44, minmax(0, 1fr));
  gap: 3px;
}

.ci-cell {
  aspect-ratio: 1 / 1;
  border-radius: 2px;
  cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}

.ci-cell:hover {
  transform: scale(1.15);
  box-shadow: 0 0 0 1px var(--text-primary);
  position: relative;
  z-index: 2;
}

.ci-cell-tip {
  position: absolute;
  z-index: 5;
  transform: translate(-50%, calc(-100% - 16px));
  min-width: 200px;
  max-width: 260px;
  padding: 8px 10px;
  border-radius: var(--radius-sm, 6px);
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  font-size: 11px;
  pointer-events: none;
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.22);
}

.ci-cell-tip.below {
  transform: translate(-50%, 16px);
}

.ci-tip-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  font-size: 11px;
  color: var(--text-primary);
}

.ci-tip-head i {
  flex: none;
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.ci-tip-share {
  margin-left: auto;
  color: var(--text-muted);
  white-space: nowrap;
}

.ci-tip-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 1px 0;
}

.ci-tip-row span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ci-tip-row b {
  margin-left: auto;
  font-weight: 600;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.ci-tip-more {
  margin-top: 4px;
  color: var(--text-muted);
}

.ci-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 12px;
}

.ci-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm, 6px);
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.ci-legend-item:hover {
  background: var(--bg-hover);
}

.ci-legend-item.active {
  border-color: var(--selected-border);
  background: var(--sidebar-active);
  color: var(--text-primary);
}

.ci-legend-item i {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.ci-legend-item b {
  font-weight: 600;
  color: var(--text-primary);
}

.ci-section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.ci-section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.ci-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.ci-chip {
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  border-radius: var(--radius-sm, 6px);
  font-size: 11px;
  padding: 3px 10px;
  font-family: inherit;
  cursor: pointer;
}

.ci-chip:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.ci-chip.active {
  background: var(--sidebar-active);
  border-color: var(--selected-border);
  color: var(--text-primary);
}

.ci-filter-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: -2px 0 10px;
  padding: 6px 10px;
  border-radius: var(--radius-sm, 6px);
  border: 1px solid var(--selected-border);
  background: var(--sidebar-active);
  font-size: 12px;
  color: var(--text-primary);
}

.ci-filter-clear {
  margin-left: auto;
  background: transparent;
  border: none;
  padding: 0 2px;
  color: var(--accent);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
}

.ci-filter-clear:hover {
  text-decoration: underline;
}

.ci-hint {
  margin: 10px 0 0;
  font-size: 11px;
  color: var(--text-muted);
}

.ci-items,
.ci-requests {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.ci-item {
  display: grid;
  grid-template-columns: 10px minmax(120px, 1fr) auto minmax(80px, 2fr) 60px;
  align-items: center;
  gap: 10px;
  padding: 5px 4px;
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
}

.ci-item:hover {
  background: var(--bg-hover);
}

.ci-item-dot {
  width: 9px;
  height: 9px;
  border-radius: 2px;
}

.ci-item-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.ci-item-count {
  font-size: 11px;
  color: var(--text-muted);
}

.ci-item-bar {
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-muted) 22%, transparent);
  overflow: hidden;
}

.ci-item-bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
}

.ci-item-token {
  text-align: right;
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
}

.ci-more {
  margin-top: 8px;
  background: transparent;
  border: none;
  color: var(--accent);
  font-size: 12px;
  font-family: inherit;
  cursor: pointer;
  padding: 2px 0;
}

.ci-more:hover {
  text-decoration: underline;
}

.ci-muted {
  color: var(--text-muted);
  font-size: 12px;
  padding: 6px 0;
}

.ci-muted.small {
  font-size: 11px;
}

.ci-request {
  display: grid;
  grid-template-columns: 66px 46px minmax(90px, 150px) minmax(90px, 1fr) minmax(60px, 1fr) 56px 42px;
  align-items: center;
  gap: 8px;
  padding: 6px 6px;
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
  font-size: 12px;
}

.ci-request:hover {
  background: var(--bg-hover);
}

.ci-request.active {
  background: var(--sidebar-active);
}

.ci-request-time,
.ci-request-token,
.ci-request-percent {
  font-variant-numeric: tabular-nums;
  color: var(--text-secondary);
}

.ci-request-percent {
  text-align: right;
}

.ci-request-phase {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  text-align: center;
  color: var(--text-muted);
}

.ci-request-phase.before {
  color: var(--warning-color);
  border-color: color-mix(in srgb, var(--warning-color) 40%, transparent);
}

.ci-request-model,
.ci-request-msg {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-muted);
}

.ci-request-bar {
  height: 4px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--text-muted) 22%, transparent);
  overflow: hidden;
}

.ci-request-bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
}

.ci-overlay {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.45);
}

.ci-modal {
  display: flex;
  flex-direction: column;
  width: min(960px, 94vw);
  max-height: min(680px, 86vh);
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md, 10px);
  background: var(--bg-primary);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.28);
}

.ci-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border-color);
}

.ci-modal-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
}

.ci-modal-sub {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted);
}

.ci-modal-actions {
  display: flex;
  gap: 8px;
}

.ci-modal-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border-color);
}

.ci-modal-body {
  display: grid;
  grid-template-columns: 240px 1fr;
  flex: 1;
  min-height: 0;
}

.ci-modal-list {
  list-style: none;
  margin: 0;
  padding: 8px;
  overflow-y: auto;
  border-right: 1px solid var(--border-color);
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) transparent;
}

.ci-modal-item {
  display: grid;
  grid-template-columns: 8px 1fr auto auto;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--radius-sm, 6px);
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
}

.ci-modal-item:hover {
  background: var(--bg-hover);
}

.ci-modal-item.active {
  background: var(--sidebar-active);
  color: var(--text-primary);
}

.ci-modal-item i {
  width: 8px;
  height: 8px;
  border-radius: 2px;
}

.ci-modal-item-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ci-modal-item-token {
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}

.ci-modal-detail {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.ci-modal-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 16px;
  font-size: 12px;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
}

.ci-modal-text {
  flex: 1;
  margin: 0;
  padding: 12px 16px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-code, ui-monospace, SFMono-Regular, Consolas, monospace);
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-secondary);
  background: var(--code-bg);
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) transparent;
}

@media (max-width: 900px) {
  .ci-grid-bar {
    grid-template-columns: repeat(30, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .ci-page {
    padding: 14px 14px 32px;
  }

  .ci-grid-bar {
    grid-template-columns: repeat(20, minmax(0, 1fr));
  }

  .ci-request {
    grid-template-columns: 60px 44px 1fr 56px;
  }

  .ci-request-msg,
  .ci-request-model,
  .ci-request-percent {
    display: none;
  }

  .ci-overlay {
    padding: 10px;
  }

  .ci-modal-body {
    grid-template-columns: 1fr;
    grid-template-rows: minmax(120px, 200px) 1fr;
  }

  .ci-modal-list {
    border-right: none;
    border-bottom: 1px solid var(--border-color);
  }
}
</style>
