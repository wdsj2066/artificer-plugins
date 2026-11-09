// 运行时轨迹：把 Agent 运行时 hook 事件记入内存环形缓冲，供底部面板与独立页面实时查看。

// SINGLE hook 是替换式扩展点，不能作为观察者注册，否则会覆盖宿主实现。
// 使用 beforeAiCall / afterAiCall 等通知型 hook 观察对应生命周期。
const HOOK_TYPES = {
  beforeRun: 'series',
  beforeModelRound: 'series',
  stageChanged: 'series',
  runOutcome: 'series',
  afterRun: 'series',
  beforeAiCall: 'series',
  afterAiCall: 'series',
  buildMessages: 'pipeline',
  buildTools: 'pipeline',
  toolCall: 'middleware',
  tryRecover: 'waterfall',
  onClear: 'series'
};

const DEFAULT_MAX_EVENTS = 1000;
const SENSITIVE_KEY = /^(?:api[-_]?key|(?:access|refresh|gateway)[-_]?token|token|secret|password|authorization|cookie|credential)$/i;

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function truncate(text, max) {
  const s = String(text);
  return s.length > max ? `${s.slice(0, max)}…(+${s.length - max})` : s;
}

function summarize(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return value;
  const type = typeof value;
  if (type === 'string') return truncate(value, 4000);
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return `${value}n`;
  if (type === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (type === 'symbol') return String(value);
  if (value instanceof Error) return { name: value.name, message: truncate(value.message, 300) };
  if (value instanceof Date) return value.toISOString();
  if (type !== 'object') return String(value);
  if (seen.has(value)) return '[Circular]';
  if (depth >= 6) return Array.isArray(value) ? `[Array(${value.length})]` : '[Object]';
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const out = value.slice(0, 20).map((item) => summarize(item, depth + 1, seen));
      if (value.length > 20) out.push(`…+${value.length - 20} more`);
      return out;
    }
    const out = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, 25)) {
      out[key] = SENSITIVE_KEY.test(key) ? '***' : summarize(value[key], depth + 1, seen);
    }
    if (keys.length > 25) out.__more = keys.length - 25;
    return out;
  } catch {
    return '[Unserializable]';
  } finally {
    seen.delete(value);
  }
}

function safeStringify(value) {
  try {
    const json = JSON.stringify(summarize(value));
    return typeof json === 'string' ? json : 'null';
  } catch {
    return '"[unserializable]"';
  }
}

// 始终返回有效 JSON，避免截断后详情无法格式化。
function boundedDetail(value) {
  const json = safeStringify(value);
  if (json.length <= 12000) return json;
  return JSON.stringify({ truncated: true, preview: json.slice(0, 11000) });
}

function runFields(run) {
  return {
    sessionId: run?.state?.storage?.sessionId ?? null,
    runId: run?.runId ?? null,
    turnId: run?.state?.turnId ?? null,
    cycleId: run?.state?.cycleId ?? null,
    iteration: run?.iteration ?? null,
    requestId: run?.aiRequestId ?? null,
    model: run?.options?.model ?? null
  };
}

function parseArguments(raw) {
  if (typeof raw !== 'string') return raw ?? null;
  try { return JSON.parse(raw); } catch { return raw; }
}

function toolFields(run) {
  const call = run?.toolCall || {};
  return {
    ...runFields(run),
    toolName: call.function?.name ?? null,
    callId: call.id ?? null,
    arguments: parseArguments(call.function?.arguments)
  };
}

function kindFor(point) {
  if (point.startsWith('before')) return 'start';
  if (point.startsWith('after')) return 'end';
  if (point === 'runOutcome') return 'outcome';
  if (point === 'toolCall' || point === 'toolResult') return 'tool';
  if (point === 'aiCall') return 'ai';
  if (point === 'buildMessages' || point === 'buildTools' || point === 'decideFinish') return 'decision';
  if (point === 'rollbackCheckpoint' || point === 'tryRecover') return 'recovery';
  if (point === 'onClear' || point === 'stageChanged') return 'lifecycle';
  return 'event';
}

function labelFor(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.tool && payload.tool.name,
    payload.toolName,
    payload.name,
    payload.model,
    payload.request && payload.request.model,
    payload.event,
    payload.type,
    payload.reason,
    payload.result && payload.result.status,
    payload.outcome,
    payload.event && payload.event.type,
    payload.tool && payload.tool.id
  ];
  for (const item of candidates) {
    if (typeof item === 'string' && item.trim()) return truncate(item.trim(), 60);
    if (item && typeof item === 'object' && typeof item.name === 'string' && item.name.trim()) {
      return truncate(item.name.trim(), 60);
    }
  }
  return '';
}

function extractStatus(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const raw =
    payload.status ??
    payload.state ??
    payload.outcome ??
    (payload.result && payload.result.status) ??
    (payload.ok === false ? 'error' : null);
  if (raw == null) return null;
  if (typeof raw === 'string') return truncate(raw, 40);
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  // 对象型状态（如 { type, message }）不能直接 String()，否则变成 [object Object]。
  try {
    return truncate(JSON.stringify(summarize(raw)), 80);
  } catch {
    return truncate(String(raw), 40);
  }
}

function extractError(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload.error ?? (payload.result && payload.result.error) ?? payload.err;
  if (!raw) return null;
  if (typeof raw === 'string') return raw;
  if (raw instanceof Error) return raw.message;
  try {
    return JSON.stringify(summarize(raw));
  } catch {
    return String(raw);
  }
}

function extractDuration(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload.durationMs ?? payload.elapsedMs ?? payload.duration;
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : null;
}

function extractId(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const raw = payload.toolCallId || payload.callId || payload.requestId || payload.runId || payload.id;
  if (typeof raw === 'string' && raw) return truncate(raw, 40);
  if (typeof raw === 'number') return String(raw);
  return '';
}

export function register(ctx) {
  const state = {
    seq: 0,
    events: [],
    totalCount: 0,
    errorCount: 0,
    paused: false,
    startedAt: Date.now()
  };
  let settingsCache = null;
  let settingsAt = 0;

  function readSettings() {
    const now = Date.now();
    if (settingsCache && now - settingsAt < 5000) return settingsCache;
    let raw = {};
    try {
      raw = ctx.getSettings?.() || {};
    } catch {
      raw = {};
    }
    settingsCache = {
      maxEvents: clampNumber(raw.maxEvents, DEFAULT_MAX_EVENTS, 100, 20000),
      capturePayload: raw.capturePayload !== false
    };
    settingsAt = now;
    return settingsCache;
  }

  function push(point, payload, meta = {}) {
    if (state.paused) return;
    try {
      const settings = readSettings();
      const error = meta.error || extractError(payload);
      const durationMs =
        typeof meta.durationMs === 'number' ? meta.durationMs : extractDuration(payload);
      const event = {
        seq: ++state.seq,
        ts: Date.now(),
        point,
        kind: kindFor(point),
        label: labelFor(payload),
        durationMs,
        status: extractStatus(payload),
        error: error ? truncate(String(error), 600) : null,
        detail: settings.capturePayload ? boundedDetail(payload) : null
      };
      state.events.push(event);
      state.totalCount += 1;
      if (event.error) state.errorCount += 1;
      const overflow = state.events.length - settings.maxEvents;
      if (overflow > 0) state.events.splice(0, overflow);
    } catch (err) {
      ctx.logger?.warn?.(`[trace-viewer] 记录事件失败: ${err?.message || err}`);
    }
  }

  // 按运行上下文配对，避免并发会话之间的耗时互相覆盖。
  const starts = new WeakMap();
  function startTiming(run, key) {
    if (!run || typeof run !== 'object') return;
    const timings = starts.get(run) || {};
    timings[key] = Date.now();
    starts.set(run, timings);
  }
  function endTiming(run, key) {
    const timings = run && typeof run === 'object' ? starts.get(run) : null;
    const started = timings?.[key];
    if (timings) delete timings[key];
    return typeof started === 'number' ? Date.now() - started : null;
  }
  function recordEvent(point, run, ...args) {
    const base = runFields(run);
    let payload = base;
    let durationMs = null;
    if (point === 'beforeRun') {
      startTiming(run, 'run');
      payload = { ...base, status: 'running', userMessage: run?.userMessage ?? null };
    } else if (point === 'beforeAiCall') {
      startTiming(run, 'model');
      const messages = Array.isArray(args[0]) ? args[0] : [];
      const tools = Array.isArray(args[1]) ? args[1] : [];
      const roles = {};
      for (const message of messages) roles[message?.role || 'unknown'] = (roles[message?.role || 'unknown'] || 0) + 1;
      payload = { ...base, status: 'running', messageCount: messages.length, roles,
        toolCount: tools.length, toolNames: tools.map(tool => tool?.function?.name || tool?.name).filter(Boolean) };
    } else if (point === 'afterAiCall') {
      const response = args[0];
      const error = args[1];
      durationMs = endTiming(run, 'model');
      payload = { ...base, status: error ? 'failed' : 'completed',
        finishReason: response?.finishReason ?? null, usage: response?.usage ?? null,
        content: response?.content ?? null, reasoningContent: response?.reasoningContent ?? null,
        toolCalls: (response?.toolCalls || []).map(call => ({ id: call.id, name: call.function?.name, arguments: parseArguments(call.function?.arguments) })),
        error: error ? (error.message || String(error)) : null };
    } else if (point === 'runOutcome') {
      payload = { ...base, ...(args[0] || {}) };
    } else if (point === 'afterRun') {
      durationMs = endTiming(run, 'run');
      payload = { ...base, status: run?.runStatus ?? null, error: run?.runError ?? null };
    } else if (point === 'stageChanged') {
      payload = { ...base, status: args[0] ?? null, description: args[1] ?? '' };
    } else if (point === 'tryRecover') {
      const error = args[0];
      payload = { ...base, error: error ? (error.message || String(error)) : null, code: error?.code ?? null };
    } else if (point === 'buildMessages' || point === 'buildTools') {
      payload = { ...base, inputCount: Array.isArray(args[0]) ? args[0].length : null };
    }
    push(point, payload, { durationMs });
  }

  function record(point, run, ...args) {
    try { recordEvent(point, run, ...args); }
    catch (error) { ctx.logger?.warn?.(`[trace-viewer] 记录 ${point} 失败: ${error?.message || error}`); }
  }

  if (ctx.host && typeof ctx.host.on === 'function') {
    for (const [point, type] of Object.entries(HOOK_TYPES)) {
      const observer = type === 'middleware'
        ? async function* (run, next) {
            const details = toolFields(run);
            const startedAt = Date.now();
            push('toolCall', { ...details, status: 'running' });
            const iterator = next();
            let completed = false;
            // 必须把上层回传值继续向下传递，否则 askUser 等交互型工具的回答会在本层丢失。
            let answer;
            try {
              while (true) {
                const item = await iterator.next(answer);
                answer = undefined;
                if (item.done) { completed = true; return item.value; }
                const event = item.value;
                if (event?.type === 'tool_result') {
                  const result = event.result;
                  push('toolResult', { ...details, status: result?.success === false ? 'failed' : 'completed',
                    result, error: result?.success === false ? (result.error || '工具执行失败') : null },
                    { durationMs: Date.now() - startedAt });
                }
                answer = yield event;
              }
            } catch (error) {
              push('toolResult', { ...details, status: 'failed', error: error?.message || String(error) },
                { durationMs: Date.now() - startedAt });
              throw error;
            } finally {
              if (!completed && typeof iterator.return === 'function') {
                try { await iterator.return(); } catch { /* 保留原始错误 */ }
              }
            }
          }
        : type === 'pipeline'
          ? (run, value, ...args) => { record(point, run, value, ...args); return value; }
          : (run, ...args) => { record(point, run, ...args); };
      try {
        ctx.host.on(point, observer, { type, priority: 120 });
      } catch (err) {
        ctx.logger?.warn?.(`[trace-viewer] 注册 ${point} 失败: ${err?.message || err}`);
      }
    }
  } else {
    ctx.logger?.warn?.('[trace-viewer] 当前运行域没有 host.on，轨迹将为空');
  }

  const base = `/api/plugins/${ctx.pluginId || 'trace-viewer'}`;

  ctx.registerRoute({
    method: 'GET',
    path: `${base}/events`,
    handler: ({ query }) => {
      const since = clampNumber(query?.since, 0, 0, Number.MAX_SAFE_INTEGER);
      const limit = clampNumber(query?.limit, 200, 1, 500);
      const list = state.events.filter((event) => event.seq > since).slice(-limit);
      return {
        seq: state.seq,
        events: list,
        total: state.totalCount,
        kept: state.events.length,
        errorCount: state.errorCount,
        paused: state.paused,
        startedAt: state.startedAt
      };
    }
  });

  ctx.registerRoute({
    method: 'GET',
    path: `${base}/stats`,
    handler: () => {
      const byPoint = {};
      const byKind = {};
      for (const event of state.events) {
        byPoint[event.point] = (byPoint[event.point] || 0) + 1;
        byKind[event.kind] = (byKind[event.kind] || 0) + 1;
      }
      return {
        seq: state.seq,
        total: state.totalCount,
        kept: state.events.length,
        errorCount: state.errorCount,
        paused: state.paused,
        startedAt: state.startedAt,
        byPoint,
        byKind
      };
    }
  });

  ctx.registerRoute({
    method: 'POST',
    path: `${base}/pause`,
    handler: ({ body }) => {
      state.paused = body?.paused !== false;
      return { paused: state.paused };
    }
  });

  ctx.registerRoute({
    method: 'POST',
    path: `${base}/clear`,
    handler: () => {
      state.events = [];
      state.seq = 0;
      state.totalCount = 0;
      state.errorCount = 0;
      return { ok: true, seq: 0 };
    }
  });

  return () => {
    state.events = [];
  };
}
