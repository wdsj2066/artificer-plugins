<template>
  <div class="tvp">
    <div class="tvp-bar">
      <span class="tvp-dot" :class="{ on: live }"></span>
      <span class="tvp-name">运行时轨迹</span>
      <span class="tvp-meta">{{ total }} 事件<span v-if="errorCount"> · {{ errorCount }} 异常</span></span>
      <span class="tvp-grow"></span>
      <span v-if="connError" class="tvp-warn" :title="connError">连接异常</span>
      <button class="tvp-btn" @click="localPaused = !localPaused">{{ localPaused ? '恢复刷新' : '暂停刷新' }}</button>
      <button class="tvp-btn tvp-danger" @click="clearAll">清空</button>
    </div>
    <div ref="listEl" class="tvp-list" @scroll="onScroll">
      <div v-if="!visible.length" class="tvp-empty">
        {{ connError ? '无法连接轨迹服务，请确认插件已启用。' : '暂无事件。发起一次对话或调用工具后，轨迹会实时出现在这里。' }}
      </div>
      <div
        v-for="item in visible"
        :key="item.seq"
        class="tvp-row"
        :class="['tvp-k-' + item.kind, { open: expanded === item.seq }]"
        @click="expanded = expanded === item.seq ? null : item.seq"
      >
        <span class="tvp-t">{{ fmtTime(item.ts) }}</span>
        <span class="tvp-kind">{{ kindLabel(item.kind) }}</span>
        <span class="tvp-point">{{ item.point }}</span>
        <span class="tvp-label">{{ item.label }}</span>
        <span v-if="item.durationMs != null" class="tvp-dur">{{ item.durationMs }} ms</span>
        <span v-else class="tvp-dur tvp-muted">—</span>
        <span v-if="item.error" class="tvp-tag-err">异常</span>
        <div v-if="expanded === item.seq" class="tvp-detail">
          <div v-if="item.error" class="tvp-err">{{ item.error }}</div>
          <pre>{{ pretty(item) }}</pre>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue';

const ENDPOINT = '/api/plugins/trace-viewer';
const MAX_CLIENT = 1000;
const VISIBLE = 300;
const POLL_MS = 700;

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

export default {
  name: 'TraceFeedPanel',
  setup() {
    const events = ref([]);
    const seq = ref(0);
    const total = ref(0);
    const errorCount = ref(0);
    const paused = ref(false);
    const localPaused = ref(false);
    const expanded = ref(null);
    const connError = ref('');
    const follow = ref(true);
    const listEl = ref(null);
    let timer = null;
    let inFlight = false;

    const live = computed(() => !paused.value && !localPaused.value && !connError.value);
    const visible = computed(() => events.value.slice(-VISIBLE));

    function fmtTime(ts) {
      const d = new Date(ts);
      const pad = (n, len) => String(n).padStart(len || 2, '0');
      return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    }

    function kindLabel(kind) {
      return KIND_LABEL[kind] || kind || '事件';
    }

    function pretty(item) {
      if (!item.detail) return '(未记录载荷)';
      try {
        const text = JSON.stringify(JSON.parse(item.detail), null, 2);
        return text.length > 6000 ? `${text.slice(0, 6000)}\n… 已截断` : text;
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
        const data = await readJson(await fetch(`${ENDPOINT}/events?since=${seq.value}&limit=${VISIBLE}`));
        const list = data && Array.isArray(data.events) ? data.events : [];
        const serverSeq = data && typeof data.seq === 'number' ? data.seq : seq.value;
        // 服务端被清空或重启时 seq 会回到 0，需要同步丢弃本地残留。
        if (serverSeq < seq.value || (serverSeq === 0 && events.value.length)) {
          events.value = [];
          expanded.value = null;
        }
        const appended = appendEvents(list);
        seq.value = serverSeq;
        if (data && typeof data.total === 'number') total.value = data.total;
        if (data && typeof data.errorCount === 'number') errorCount.value = data.errorCount;
        if (data && typeof data.paused === 'boolean') paused.value = data.paused;
        connError.value = '';
        if (appended) {
          await nextTick();
          const el = listEl.value;
          if (el && follow.value && expanded.value == null) el.scrollTop = el.scrollHeight;
        }
      } catch (err) {
        connError.value = (err && err.message) || '连接失败';
      } finally {
        inFlight = false;
      }
    }

    function onScroll() {
      const el = listEl.value;
      if (!el) return;
      follow.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    }

    async function clearAll() {
      if (!window.confirm('清空当前进程内的全部轨迹事件？')) return;
      try {
        await readJson(await fetch(`${ENDPOINT}/clear`, { method: 'POST' }));
        events.value = [];
        seq.value = 0;
        total.value = 0;
        errorCount.value = 0;
        expanded.value = null;
      } catch (err) {
        connError.value = (err && err.message) || '清空失败';
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
      live,
      visible,
      total,
      errorCount,
      localPaused,
      expanded,
      connError,
      listEl,
      fmtTime,
      kindLabel,
      pretty,
      onScroll,
      clearAll
    };
  }
};
</script>

<style scoped>
.tvp {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  color: inherit;
}
.tvp-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
  padding: 6px 10px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.24);
}
.tvp-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: rgba(128, 128, 128, 0.6);
}
.tvp-dot.on {
  background: #22c55e;
  box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.18);
}
.tvp-name {
  font-weight: 600;
}
.tvp-meta {
  opacity: 0.7;
}
.tvp-grow {
  flex: 1;
}
.tvp-warn {
  color: #f59e0b;
}
.tvp-btn {
  border: 1px solid rgba(128, 128, 128, 0.3);
  background: transparent;
  color: inherit;
  border-radius: 6px;
  padding: 2px 8px;
  font-size: 11px;
  cursor: pointer;
}
.tvp-btn:hover {
  background: rgba(128, 128, 128, 0.14);
}
.tvp-danger:hover {
  border-color: #ef4444;
  color: #ef4444;
}
.tvp-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
.tvp-empty {
  padding: 18px 12px;
  opacity: 0.6;
  line-height: 1.6;
}
.tvp-row {
  display: grid;
  grid-template-columns: 92px 46px 150px minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: baseline;
  padding: 3px 10px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.12);
  cursor: pointer;
}
.tvp-row:hover {
  background: rgba(128, 128, 128, 0.1);
}
.tvp-row.open {
  background: rgba(128, 128, 128, 0.08);
}
.tvp-t {
  opacity: 0.65;
  font-size: 11px;
}
.tvp-kind {
  font-size: 11px;
  opacity: 0.85;
}
.tvp-point {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tvp-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.8;
}
.tvp-dur {
  font-size: 11px;
  opacity: 0.75;
  white-space: nowrap;
}
.tvp-muted {
  opacity: 0.3;
}
.tvp-tag-err {
  font-size: 10px;
  color: #f87171;
  border: 1px solid rgba(239, 68, 68, 0.45);
  border-radius: 4px;
  padding: 0 4px;
}
.tvp-detail {
  grid-column: 1 / -1;
  margin: 4px 0 6px;
  padding: 8px 10px;
  background: rgba(128, 128, 128, 0.1);
  border-radius: 6px;
  max-height: 240px;
  overflow: auto;
}
.tvp-detail pre {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.tvp-err {
  color: #f87171;
  margin-bottom: 6px;
  font-size: 11px;
  white-space: pre-wrap;
}
.tvp-k-tool .tvp-kind {
  color: #3b82f6;
}
.tvp-k-ai .tvp-kind {
  color: #a855f7;
}
.tvp-k-outcome .tvp-kind,
.tvp-k-end .tvp-kind {
  color: #22c55e;
}
.tvp-k-recovery .tvp-kind {
  color: #f59e0b;
}
</style>
