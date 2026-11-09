<template>
  <div class="tv-page">
    <header class="tv-head">
      <div class="tv-head-text">
        <h1>运行时轨迹</h1>
        <p>实时记录 Agent 运行时的轮次、AI 调用、工具调用与 hook 事件，仅保存在当前进程内存中，重启后清空。</p>
      </div>
      <div class="tv-cards">
        <div class="tv-card">
          <span class="tv-card-v">{{ live ? '实时' : '已暂停' }}</span>
          <span class="tv-card-k">采集状态</span>
        </div>
        <div class="tv-card">
          <span class="tv-card-v">{{ total }}</span>
          <span class="tv-card-k">累计事件</span>
        </div>
        <div class="tv-card">
          <span class="tv-card-v">{{ events.length }}</span>
          <span class="tv-card-k">缓冲条数</span>
        </div>
        <div class="tv-card" :class="{ danger: errorCount > 0 }">
          <span class="tv-card-v">{{ errorCount }}</span>
          <span class="tv-card-k">异常</span>
        </div>
      </div>
    </header>

    <div class="tv-tools">
      <input v-model="keyword" class="tv-input" placeholder="搜索 hook、工具名、状态或详情内容…" />
      <div class="tv-chips">
        <button
          v-for="option in kindOptions"
          :key="option.value"
          class="tv-chip"
          :class="{ on: kindFilter === option.value }"
          @click="kindFilter = option.value"
        >
          {{ option.label }}
        </button>
      </div>
      <select v-model="pointFilter" class="tv-select">
        <option value="">全部 hook</option>
        <option v-for="point in pointOptions" :key="point" :value="point">{{ point }}</option>
      </select>
      <span class="tv-grow"></span>
      <label class="tv-check">
        <input v-model="localPaused" type="checkbox" />
        暂停刷新
      </label>
      <button class="tv-btn" @click="toggleCapture">{{ paused ? '恢复采集' : '暂停采集' }}</button>
      <button class="tv-btn tv-btn-danger" @click="clearAll">清空轨迹</button>
    </div>

    <div v-if="connError" class="tv-alert">
      无法连接轨迹服务：{{ connError }}
      <span class="tv-alert-tip">请确认插件已启用，并检查宿主 API 是否在运行。</span>
    </div>

    <div class="tv-main">
      <section class="tv-list">
        <div class="tv-list-head">
          <span class="tv-col-time">时间</span>
          <span class="tv-col-kind">类型</span>
          <span class="tv-col-point">hook</span>
          <span class="tv-col-label">标签</span>
          <span class="tv-col-dur">耗时</span>
        </div>
        <div v-if="!filtered.length" class="tv-empty">
          <template v-if="!events.length">暂无轨迹。发起一次对话、调用工具或触发 hook 后即可看到实时记录。</template>
          <template v-else>没有匹配当前筛选条件的事件。</template>
        </div>
        <div
          v-for="item in filtered"
          :key="item.seq"
          class="tv-row"
          :class="['tv-k-' + item.kind, { active: selected && selected.seq === item.seq }]"
          @click="selected = item"
        >
          <span class="tv-col-time">{{ fmtTime(item.ts) }}</span>
          <span class="tv-col-kind">{{ kindLabel(item.kind) }}</span>
          <span class="tv-col-point">{{ item.point }}</span>
          <span class="tv-col-label">{{ item.label || '—' }}</span>
          <span class="tv-col-dur">{{ item.durationMs != null ? item.durationMs + ' ms' : '—' }}</span>
        </div>
      </section>

      <aside class="tv-side">
        <template v-if="selected">
          <div class="tv-side-head">
            <h2>{{ selected.point }}</h2>
            <span class="tv-side-tag">{{ kindLabel(selected.kind) }}</span>
          </div>
          <dl class="tv-fields">
            <dt>序号</dt><dd>#{{ selected.seq }}</dd>
            <dt>时间</dt><dd>{{ fmtFull(selected.ts) }}</dd>
            <dt>耗时</dt><dd>{{ selected.durationMs != null ? selected.durationMs + ' ms' : '—' }}</dd>
            <dt>状态</dt><dd>{{ selected.status || '—' }}</dd>
            <dt>标签</dt><dd>{{ selected.label || '—' }}</dd>
          </dl>
          <div v-if="selected.error" class="tv-side-err">{{ selected.error }}</div>
          <div class="tv-side-actions">
            <button class="tv-btn" @click="copyDetail">{{ copied ? '已复制' : '复制载荷' }}</button>
          </div>
          <pre class="tv-json">{{ pretty(selected) }}</pre>
        </template>
        <div v-else class="tv-side-empty">选择左侧一条事件查看完整载荷与耗时。</div>
      </aside>
    </div>
  </div>
</template>

<script>
import { computed, onMounted, onUnmounted, ref } from 'vue';

const ENDPOINT = '/api/plugins/trace-viewer';
const POLL_MS = 700;
const MAX_CLIENT = 2000;

const KIND_LABEL = {
  start: '开始',
  end: '结束',
  outcome: '结果',
  tool: '工具',
  ai: 'AI',
  decision: '决策',
  event: '事件',
  recovery: '恢复',
  lifecycle: '生命周期'
};

const KIND_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'start', label: '开始' },
  { value: 'end', label: '结束' },
  { value: 'outcome', label: '结果' },
  { value: 'tool', label: '工具' },
  { value: 'ai', label: 'AI' },
  { value: 'decision', label: '决策' },
  { value: 'event', label: '事件' },
  { value: 'recovery', label: '恢复' },
  { value: 'lifecycle', label: '生命周期' }
];

export default {
  name: 'TraceViewerPage',
  setup() {
    const events = ref([]);
    const seq = ref(0);
    const total = ref(0);
    const errorCount = ref(0);
    const paused = ref(false);
    const localPaused = ref(false);
    const connError = ref('');
    const keyword = ref('');
    const kindFilter = ref('');
    const pointFilter = ref('');
    const selected = ref(null);
    const copied = ref(false);
    let timer = null;
    let inFlight = false;

    const kindOptions = KIND_OPTIONS;
    const live = computed(() => !paused.value && !localPaused.value && !connError.value);

    const pointOptions = computed(() => {
      const set = new Set();
      for (const item of events.value) set.add(item.point);
      return Array.from(set).sort();
    });

    const filtered = computed(() => {
      const needle = keyword.value.trim().toLowerCase();
      const list = events.value.filter((item) => {
        if (kindFilter.value && item.kind !== kindFilter.value) return false;
        if (pointFilter.value && item.point !== pointFilter.value) return false;
        if (!needle) return true;
        const haystack = `${item.point} ${item.label} ${item.status || ''} ${item.detail || ''} ${item.error || ''}`.toLowerCase();
        return haystack.indexOf(needle) >= 0;
      });
      return list.slice().reverse();
    });

    function pad(n, len) {
      return String(n).padStart(len || 2, '0');
    }

    function fmtTime(ts) {
      const d = new Date(ts);
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    }

    function fmtFull(ts) {
      const d = new Date(ts);
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${fmtTime(ts)}`;
    }

    function kindLabel(kind) {
      return KIND_LABEL[kind] || kind || '事件';
    }

    function pretty(item) {
      if (!item || !item.detail) return '(当前设置未记录载荷)';
      try {
        const text = JSON.stringify(JSON.parse(item.detail), null, 2);
        return text.length > 12000 ? `${text.slice(0, 12000)}\n… 已截断` : text;
      } catch (err) {
        return item.detail;
      }
    }

    async function readJson(res) {
      let data = null;
      try {
        data = await res.json();
      } catch (err) {
        throw new Error(`响应解析失败 (HTTP ${res.status})`);
      }
      if (!res.ok) throw new Error(data && data.error ? data.error : `HTTP ${res.status}`);
      if (data && data.success === false) throw new Error(data.error || '请求失败');
      return data && data.data !== undefined ? data.data : data;
    }

    function appendEvents(list) {
      if (!list.length) return false;
      const known = new Set(events.value.map((item) => item.seq));
      const fresh = list.filter((item) => !known.has(item.seq));
      if (!fresh.length) return false;
      events.value = events.value.concat(fresh).slice(-MAX_CLIENT);
      return true;
    }

    async function poll() {
      if (localPaused.value || inFlight) return;
      inFlight = true;
      try {
        const data = await readJson(await fetch(`${ENDPOINT}/events?since=${seq.value}&limit=500`));
        const list = data && Array.isArray(data.events) ? data.events : [];
        const serverSeq = data && typeof data.seq === 'number' ? data.seq : seq.value;
        // 服务端清空或重启后 seq 回到 0，需要同步丢弃本地残留。
        if (serverSeq < seq.value || (serverSeq === 0 && events.value.length)) {
          events.value = [];
          selected.value = null;
        }
        if (appendEvents(list) && selected.value) {
          const fresh = events.value.find((item) => item.seq === selected.value.seq);
          if (fresh) selected.value = fresh;
        }
        seq.value = serverSeq;
        if (data && typeof data.total === 'number') total.value = data.total;
        if (data && typeof data.errorCount === 'number') errorCount.value = data.errorCount;
        if (data && typeof data.paused === 'boolean') paused.value = data.paused;
        connError.value = '';
      } catch (err) {
        connError.value = (err && err.message) || '连接失败';
      } finally {
        inFlight = false;
      }
    }

    async function toggleCapture() {
      try {
        const data = await readJson(
          await fetch(`${ENDPOINT}/pause`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paused: !paused.value })
          })
        );
        paused.value = !!(data && data.paused);
      } catch (err) {
        connError.value = (err && err.message) || '操作失败';
      }
    }

    async function clearAll() {
      if (!window.confirm('清空当前进程内的全部轨迹事件？')) return;
      try {
        await readJson(await fetch(`${ENDPOINT}/clear`, { method: 'POST' }));
        events.value = [];
        seq.value = 0;
        total.value = 0;
        errorCount.value = 0;
        selected.value = null;
      } catch (err) {
        connError.value = (err && err.message) || '清空失败';
      }
    }

    async function copyDetail() {
      if (!selected.value) return;
      const text = pretty(selected.value);
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          copied.value = true;
          setTimeout(() => {
            copied.value = false;
          }, 1200);
        }
      } catch (err) {
        copied.value = false;
      }
    }

    onMounted(() => {
      poll();
      timer = setInterval(poll, POLL_MS);
    });

    onUnmounted(() => {
      if (timer) clearInterval(timer);
      timer = null;
    });

    return {
      events,
      total,
      errorCount,
      paused,
      localPaused,
      connError,
      keyword,
      kindFilter,
      pointFilter,
      selected,
      copied,
      live,
      kindOptions,
      pointOptions,
      filtered,
      fmtTime,
      fmtFull,
      kindLabel,
      pretty,
      toggleCapture,
      clearAll,
      copyDetail
    };
  }
};
</script>

<style scoped>
.tv-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 16px;
  box-sizing: border-box;
  gap: 12px;
  font-size: 13px;
  color: inherit;
  width: 100%;
  max-width: 900px;
  margin: 0 auto;
}
.tv-head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
}
.tv-head-text h1 {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 600;
}
.tv-head-text p {
  margin: 0;
  font-size: 12px;
  opacity: 0.65;
  max-width: 520px;
  line-height: 1.6;
}
.tv-cards {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.tv-card {
  min-width: 78px;
  padding: 8px 12px;
  border: 1px solid rgba(128, 128, 128, 0.24);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: rgba(128, 128, 128, 0.06);
}
.tv-card-v {
  font-size: 14px;
  font-weight: 600;
}
.tv-card-k {
  font-size: 11px;
  opacity: 0.6;
}
.tv-card.danger {
  border-color: rgba(239, 68, 68, 0.5);
}
.tv-card.danger .tv-card-v {
  color: #f87171;
}
.tv-tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.tv-input {
  flex: 1;
  min-width: 180px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid rgba(128, 128, 128, 0.3);
  background: transparent;
  color: inherit;
  font-size: 12px;
  outline: none;
}
.tv-input:focus {
  border-color: #3b82f6;
}
.tv-chips {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.tv-chip {
  border: 1px solid rgba(128, 128, 128, 0.28);
  background: transparent;
  color: inherit;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11px;
  cursor: pointer;
}
.tv-chip:hover {
  background: rgba(128, 128, 128, 0.14);
}
.tv-chip.on {
  border-color: #3b82f6;
  color: #3b82f6;
  background: rgba(59, 130, 246, 0.12);
}
.tv-select {
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid rgba(128, 128, 128, 0.3);
  background: transparent;
  color: inherit;
  font-size: 12px;
}
.tv-grow {
  flex: 1;
}
.tv-check {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  opacity: 0.8;
  cursor: pointer;
}
.tv-btn {
  border: 1px solid rgba(128, 128, 128, 0.3);
  background: transparent;
  color: inherit;
  border-radius: 8px;
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
}
.tv-btn:hover {
  background: rgba(128, 128, 128, 0.14);
}
.tv-btn-danger:hover {
  border-color: #ef4444;
  color: #ef4444;
}
.tv-alert {
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid rgba(245, 158, 11, 0.5);
  background: rgba(245, 158, 11, 0.1);
  font-size: 12px;
}
.tv-alert-tip {
  opacity: 0.7;
  margin-left: 6px;
}
.tv-main {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 300px;
  gap: 12px;
  flex: 1;
  min-height: 0;
}
.tv-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid rgba(128, 128, 128, 0.24);
  border-radius: 10px;
  overflow: auto;
}
.tv-list-head,
.tv-row {
  display: grid;
  grid-template-columns: 96px 62px 150px minmax(0, 1fr) 76px;
  gap: 8px;
  align-items: center;
  padding: 6px 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.tv-list-head {
  position: sticky;
  top: 0;
  z-index: 1;
  font-size: 11px;
  opacity: 0.65;
  border-bottom: 1px solid rgba(128, 128, 128, 0.24);
  background: rgba(128, 128, 128, 0.08);
  backdrop-filter: blur(6px);
}
.tv-row {
  border-bottom: 1px solid rgba(128, 128, 128, 0.1);
  cursor: pointer;
}
.tv-row:hover {
  background: rgba(128, 128, 128, 0.1);
}
.tv-row.active {
  background: rgba(59, 130, 246, 0.16);
}
.tv-col-time,
.tv-col-dur {
  opacity: 0.7;
  font-size: 11px;
  white-space: nowrap;
}
.tv-col-kind {
  font-size: 11px;
}
.tv-col-point,
.tv-col-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tv-k-tool .tv-col-kind {
  color: #3b82f6;
}
.tv-k-ai .tv-col-kind {
  color: #a855f7;
}
.tv-k-end .tv-col-kind,
.tv-k-outcome .tv-col-kind {
  color: #22c55e;
}
.tv-k-recovery .tv-col-kind {
  color: #f59e0b;
}
.tv-empty {
  padding: 28px 16px;
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.8;
}
.tv-side {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: 1px solid rgba(128, 128, 128, 0.24);
  border-radius: 10px;
  padding: 12px;
  overflow: auto;
  gap: 10px;
}
.tv-side-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tv-side-head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.tv-side-tag {
  font-size: 10px;
  border: 1px solid rgba(128, 128, 128, 0.35);
  border-radius: 4px;
  padding: 0 5px;
  opacity: 0.75;
}
.tv-fields {
  display: grid;
  grid-template-columns: 56px minmax(0, 1fr);
  gap: 4px 8px;
  margin: 0;
  font-size: 12px;
}
.tv-fields dt {
  opacity: 0.6;
}
.tv-fields dd {
  margin: 0;
  word-break: break-all;
}
.tv-side-err {
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid rgba(239, 68, 68, 0.45);
  background: rgba(239, 68, 68, 0.1);
  color: #f87171;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
}
.tv-side-actions {
  display: flex;
  gap: 8px;
}
.tv-json {
  margin: 0;
  padding: 10px;
  border-radius: 8px;
  background: rgba(128, 128, 128, 0.1);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.tv-side-empty {
  font-size: 12px;
  opacity: 0.6;
  line-height: 1.7;
}
@media (max-width: 900px) {
  .tv-main {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
  }
  .tv-side {
    max-height: 280px;
  }
  .tv-list-head,
  .tv-row {
    grid-template-columns: 90px 52px minmax(90px, 120px) minmax(0, 1fr) 64px;
  }
}
</style>
