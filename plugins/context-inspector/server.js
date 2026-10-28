import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_PREVIEW = 2000;
const MAX_ITEMS = 40;
const IMAGE_TOKENS = 850;
const FILE_PATTERN = /<file[\s>]|<\/file>|filename\s*[:=]|附件[:：]|<document[\s>]|【文件】/;
const TOOL_RESULT_TYPES = new Set(['tool_result', 'function_result', 'tool']);
const SETTING_DEFAULTS = { defaultLimit: 128000, modelLimits: '', keep: 10 };
const DEBUG_DIR = join(process.env.APPDATA || process.cwd(), 'Artificer', 'plugin-data', 'context-inspector');
const LIMIT_KEYS = ['contextWindow', 'max_context_tokens', 'context_window', 'contextLength', 'maxInputTokens'];
const EXTRA_KEYS = ['systemPrompt', 'memoryContext', 'projectSkills', 'contextCatalog', 'toolResults', 'userMessage', 'toolSchemaTokens'];

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function stringifyText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(stringifyText).filter(Boolean).join('\n');
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function estimateTokens(value) {
  const text = typeof value === 'string' ? value : stringifyText(value);
  if (!text) return 0;
  let ascii = 0;
  let wide = 0;
  for (const char of text) {
    if (char.codePointAt(0) < 128) ascii += 1;
    else wide += 1;
  }
  return Math.ceil(ascii / 4) + wide;
}

function eachBlock(content, callback) {
  if (content == null) return;
  if (typeof content === 'string') {
    callback({ type: 'text', text: content });
    return;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'string') callback({ type: 'text', text: block });
      else if (block && typeof block === 'object') callback(block);
    }
    return;
  }
  if (typeof content === 'object') callback(content);
}

function isUsageLike(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  return [
    'prompt_tokens',
    'input_tokens',
    'promptTokens',
    'inputTokens',
    'total_tokens',
    'totalTokens'
  ].some((key) => typeof value[key] === 'number');
}

function isMessageLike(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return typeof value.role === 'string' && ('content' in value || 'tool_calls' in value || 'toolCalls' in value);
}

function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const details = raw.prompt_tokens_details || raw.promptTokensDetails || {};
  const prompt = firstNumber(
    raw.prompt_tokens,
    raw.input_tokens,
    raw.promptTokens,
    raw.inputTokens,
    raw.promptTokenCount
  );
  const completion = firstNumber(
    raw.completion_tokens,
    raw.output_tokens,
    raw.completionTokens,
    raw.outputTokens,
    raw.candidatesTokenCount
  );
  const total = firstNumber(raw.total_tokens, raw.totalTokens, raw.totalTokenCount);
  const cached = firstNumber(
    details.cached_tokens,
    details.cachedTokens,
    raw.cached_tokens,
    raw.cachedTokens,
    raw.cache_read_input_tokens,
    raw.cacheReadInputTokens,
    raw.prompt_cache_hit_tokens,
    raw.promptCacheHitTokens
  );
  if (prompt == null && total == null) return null;
  return {
    prompt: prompt == null ? null : prompt,
    completion,
    total: total == null ? (prompt || 0) + (completion || 0) : total,
    cached
  };
}

function looksLikeMessages(value) {
  if (!Array.isArray(value) || value.length === 0) return false;
  const sample = value.slice(0, 6);
  return sample.every((item) => {
    if (!item || typeof item !== 'object') return false;
    return ['role', 'type', 'content'].some((key) => key in item);
  });
}

function pickUsage(args) {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const arg = args[index];
    if (!arg || typeof arg !== 'object' || isMessageLike(arg)) continue;
    if (isUsageLike(arg.usage)) {
      return { usage: normalizeUsage(arg.usage), raw: JSON.stringify(arg.usage).slice(0, 1200), sourceIndex: index };
    }
    if (isUsageLike(arg)) {
      return { usage: normalizeUsage(arg), raw: JSON.stringify(arg).slice(0, 1200), sourceIndex: index };
    }
  }
  return { usage: null, raw: null, sourceIndex: -1 };
}

function extractPayload(args) {
  const out = {
    messages: null,
    system: null,
    model: null,
    sessionId: null,
    toolSchemaTokens: null,
    limitHints: [],
    extras: {}
  };
  const payload = args[0];
  if (!payload || typeof payload !== 'object') return out;

  const options = payload.options && typeof payload.options === 'object' ? payload.options : {};
  const state = payload.state && typeof payload.state === 'object' ? payload.state : {};
  const conversation = state.conversation && typeof state.conversation === 'object' ? state.conversation : {};

  if (looksLikeMessages(conversation.messages)) out.messages = conversation.messages;
  else if (looksLikeMessages(payload.messages)) out.messages = payload.messages;

  if (typeof options.systemPrompt === 'string' && options.systemPrompt.trim()) out.system = options.systemPrompt;
  else if (typeof payload.systemPrompt === 'string' && payload.systemPrompt.trim()) out.system = payload.systemPrompt;

  if (typeof options.model === 'string' && options.model.trim()) out.model = options.model.trim();
  else if (typeof payload.model === 'string' && payload.model.trim()) out.model = payload.model.trim();

  const storage = state.storage && typeof state.storage === 'object' ? state.storage : {};
  if (typeof storage.sessionId === 'string' && storage.sessionId) out.sessionId = storage.sessionId;
  else if (typeof payload.sessionId === 'string' && payload.sessionId) out.sessionId = payload.sessionId;

  if (typeof payload.toolSchemaTokens === 'number' && payload.toolSchemaTokens > 0) {
    out.toolSchemaTokens = payload.toolSchemaTokens;
  }

  const limit = firstNumber(
    options.contextWindow,
    options.modelCapabilities && options.modelCapabilities.max_context_tokens,
    state.modelCapabilities && state.modelCapabilities.max_context_tokens
  );
  if (limit) out.limitHints.push({ key: 'contextWindow', value: limit, depth: 0 });

  for (const key of EXTRA_KEYS) {
    if (payload[key] != null && key !== 'systemPrompt') out.extras[key] = estimateTokens(stringifyText(payload[key]));
  }
  if (out.system) out.extras.systemPrompt = estimateTokens(out.system);

  return out;
}

function scanArgs(args) {
  const out = {
    messages: null,
    tools: null,
    usage: null,
    usageRaw: null,
    model: null,
    sessionId: null,
    system: null,
    limitHints: [],
    keys: []
  };
  const seen = new Set();

  const visit = (value, depth, insideMessages) => {
    if (!value || typeof value !== 'object' || depth > 7 || seen.has(value)) return;
    seen.add(value);

    const messageLike = insideMessages || isMessageLike(value);

    if (!out.usage && !messageLike) {
      if (isUsageLike(value)) {
        out.usage = normalizeUsage(value);
        out.usageRaw = JSON.stringify(value).slice(0, 1200);
      } else if (value.usage && isUsageLike(value.usage)) {
        out.usage = normalizeUsage(value.usage);
        out.usageRaw = JSON.stringify(value.usage).slice(0, 1200);
      }
    }

    if (!out.messages) {
      if (looksLikeMessages(value.messages)) out.messages = value.messages;
      else if (looksLikeMessages(value.input)) out.messages = value.input;
      else if (looksLikeMessages(value.promptMessages)) out.messages = value.promptMessages;
    }
    if (!out.tools && Array.isArray(value.tools) && value.tools.length > 0) out.tools = value.tools;
    if (!out.model && typeof value.model === 'string' && value.model.trim()) out.model = value.model.trim();
    if (!out.sessionId && typeof value.sessionId === 'string' && value.sessionId) out.sessionId = value.sessionId;

    if (out.system == null && depth <= 3) {
      const candidates = [
        value.system,
        value.systemPrompt,
        value.system_prompt,
        value.instructions,
        value.systemMessage,
        value.system_message
      ];
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate.trim()) {
          out.system = candidate;
          break;
        }
        if (Array.isArray(candidate) && candidate.length > 0) {
          out.system = candidate;
          break;
        }
      }
    }

    if (depth <= 3) {
      for (const key of LIMIT_KEYS) {
        if (typeof value[key] === 'number' && value[key] > 1000 && out.limitHints.length < 10) {
          out.limitHints.push({ key, value: value[key], depth });
        }
      }
    }

    if (depth === 0) out.keys.push(...Object.keys(value).filter((key) => /^\d+$/.test(key) === false));
    for (const key of Object.keys(value)) {
      const child = value[key];
      const nextInside = messageLike || (Array.isArray(child) && looksLikeMessages(child));
      visit(child, depth + 1, nextInside);
    }
  };

  for (const arg of args) visit(arg, 0, false);
  return out;
}

function analyze(messages, tools, systemText, toolSchemaTokens) {
  const breakdown = { system: 0, tools: 0, files: 0, toolResults: 0, conversation: 0 };
  const items = new Map();
  const toolNames = new Map();
  let turn = 0;
  let toolCallCount = 0;

  const push = (kind, label, tokens, preview) => {
    if (!tokens || tokens <= 0) return;
    const key = `${kind}|${label}`;
    const existing = items.get(key);
    if (existing) {
      existing.tokens += tokens;
      existing.count += 1;
      if (!existing.preview && preview) {
        existing.preview = preview.slice(0, MAX_PREVIEW);
        existing.truncated = preview.length > MAX_PREVIEW;
      }
      return;
    }
    items.set(key, {
      kind,
      label,
      tokens,
      count: 1,
      preview: (preview || '').slice(0, MAX_PREVIEW),
      truncated: (preview || '').length > MAX_PREVIEW
    });
  };

  for (const tool of Array.isArray(tools) ? tools : []) {
    const definition = tool && tool.function ? tool.function : tool;
    const name = stringifyText(definition && (definition.name || definition.id)) || 'tool';
    const tokens = estimateTokens(JSON.stringify(tool));
    breakdown.tools += tokens;
    push('tools', name, tokens, stringifyText(definition && definition.description));
  }

  if (breakdown.tools === 0 && typeof toolSchemaTokens === 'number' && toolSchemaTokens > 0) {
    breakdown.tools = toolSchemaTokens;
    push('tools', '工具定义（宿主统计）', toolSchemaTokens, '宿主 toolSchemaTokens 字段');
  }

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || message.type || '').toLowerCase();

    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : Array.isArray(message.toolCalls) ? message.toolCalls : [];
    for (const call of calls) {
      toolCallCount += 1;
      const name = (call && call.function && call.function.name) || (call && call.name) || 'tool';
      if (call && call.id) toolNames.set(call.id, name);
    }

    const blocks = [];
    eachBlock(message.content, (block) => blocks.push(block));
    const toolOnly = blocks.length > 0 && blocks.every((block) => TOOL_RESULT_TYPES.has(String(block.type || '').toLowerCase()));
    if (role === 'user' && !toolOnly) turn += 1;

    const turnLabel = `第 ${Math.max(turn, 1)} 轮`;
    const resultToolName = role === 'tool'
      ? toolNames.get(message.tool_call_id) || stringifyText(message.name) || '工具结果'
      : '';

    for (const block of blocks) {
      const type = String(block.type || '').toLowerCase();
      let kind = role === 'system' || role === 'developer' ? 'system' : role === 'tool' ? 'toolResults' : 'conversation';
      let label = role === 'system' || role === 'developer' ? '系统提示词' : role === 'tool' ? resultToolName || '工具结果' : turnLabel;
      let tokens = 0;
      let preview = '';

      if (type === 'tool_result' || type === 'function_result' || type === 'tool') {
        const name = toolNames.get(block.tool_use_id || block.tool_call_id) || resultToolName || 'tool';
        const text = stringifyText(block.content != null ? block.content : block.output != null ? block.output : block.text);
        kind = 'toolResults';
        label = name;
        tokens = estimateTokens(text);
        preview = text;
      } else if (type === 'tool_use' || type === 'function_call' || type === 'tool_call') {
        const name = block.name || (block.function && block.function.name) || 'tool';
        const text = stringifyText(
          block.input != null ? block.input : block.arguments != null ? block.arguments : block.function && block.function.arguments
        );
        toolCallCount += 1;
        if (block.id) toolNames.set(block.id, name);
        kind = 'conversation';
        label = `${name} 调用`;
        tokens = estimateTokens(text);
        preview = text;
      } else if (/image|audio|video|附件|file/.test(type)) {
        kind = 'files';
        label = type.includes('image') ? '图片' : '附件';
        tokens = IMAGE_TOKENS;
      } else {
        const text = stringifyText(block.text != null ? block.text : block.content);
        tokens = estimateTokens(text);
        preview = text;
        if (FILE_PATTERN.test(text)) {
          kind = 'files';
          label = '文件内容';
        }
      }

      if (!tokens) continue;
      breakdown[kind] += tokens;
      push(kind, label, tokens, preview);
    }
  }

  if (systemText && breakdown.system === 0) {
    eachBlock(systemText, (block) => {
      const text = stringifyText(block && block.text != null ? block.text : block);
      const tokens = estimateTokens(text);
      if (!tokens) return;
      breakdown.system += tokens;
      push('system', '系统提示词', tokens, text);
    });
  }

  const list = Array.from(items.values()).sort((a, b) => b.tokens - a.tokens).slice(0, MAX_ITEMS);
  const estimated = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
  return {
    breakdown,
    items: list,
    estimated,
    turnCount: turn,
    toolCallCount,
    toolCount: Array.isArray(tools) ? tools.length : 0,
    messageCount: Array.isArray(messages) ? messages.length : 0
  };
}

function readSettings(ctx) {
  let raw = {};
  try {
    raw = ctx.getSettings() || {};
  } catch {
    raw = {};
  }
  return {
    defaultLimit: Number(raw.defaultLimit) || SETTING_DEFAULTS.defaultLimit,
    modelLimits: String(raw.modelLimits || ''),
    keep: Math.min(50, Math.max(1, Number(raw.keep) || SETTING_DEFAULTS.keep))
  };
}

function parseModelLimits(raw) {
  const list = [];
  for (const line of String(raw || '').split(/[\n,;]+/)) {
    const match = line.match(/^\s*([^=:]+?)\s*[=:]\s*([\d.]+)\s*([kKmM])?\s*$/);
    if (!match) continue;
    let value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    const unit = (match[3] || '').toLowerCase();
    if (unit === 'k') value *= 1000;
    if (unit === 'm') value *= 1000000;
    list.push({ key: match[1].trim().toLowerCase(), limit: Math.round(value) });
  }
  return list;
}

function resolveLimit(model, settings, hints) {
  const name = String(model || '').toLowerCase();
  if (name) {
    for (const entry of parseModelLimits(settings.modelLimits)) {
      if (entry.key && name.includes(entry.key)) return { limit: entry.limit, source: 'settings-model' };
    }
  }
  const candidates = (Array.isArray(hints) ? hints : [])
    .filter((hint) => hint && typeof hint.value === 'number' && hint.value > 1000)
    .sort((a, b) => (a.depth || 0) - (b.depth || 0));
  if (candidates.length > 0) return { limit: Math.round(candidates[0].value), source: 'host' };
  return { limit: settings.defaultLimit, source: 'settings-default' };
}

function buildSnapshot({ sessionId, model, messages, tools, usage, system, toolSchemaTokens, limitHints }, settings) {
  const analysis = analyze(messages, tools, system, toolSchemaTokens);
  const resolved = resolveLimit(model, settings, limitHints);
  const hasUsage = Boolean(usage && typeof usage.prompt === 'number');
  const promptTokens = hasUsage ? usage.prompt : analysis.estimated;
  const completionTokens = usage && typeof usage.completion === 'number' ? usage.completion : 0;
  const totalTokens = usage && typeof usage.total === 'number' ? usage.total : promptTokens + completionTokens;
  const cachedTokens = usage && typeof usage.cached === 'number' ? usage.cached : null;

  const breakdown = { ...analysis.breakdown };
  let calibratedItems = analysis.items;
  if (hasUsage && promptTokens > 0) {
    const flexible = ['files', 'toolResults', 'conversation'];
    const flexibleEstimate = flexible.reduce((sum, key) => sum + breakdown[key], 0);
    const fixedTotal = breakdown.system + breakdown.tools;
    const remaining = Math.max(0, promptTokens - fixedTotal);
    if (flexibleEstimate > 0 && remaining > 0) {
      let assigned = 0;
      flexible.forEach((key, index) => {
        if (index === flexible.length - 1) {
          breakdown[key] = Math.max(0, remaining - assigned);
          return;
        }
        const value = Math.round((breakdown[key] / flexibleEstimate) * remaining);
        breakdown[key] = value;
        assigned += value;
      });
    }
    const factors = {};
    for (const key of Object.keys(breakdown)) {
      const before = analysis.breakdown[key] || 0;
      factors[key] = before > 0 ? breakdown[key] / before : 1;
    }
    calibratedItems = analysis.items
      .map((item) => ({ ...item, tokens: Math.max(1, Math.round(item.tokens * (factors[item.kind] || 1))) }))
      .sort((a, b) => b.tokens - a.tokens);
  }

  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    sessionId: sessionId || 'global',
    model: model || '',
    source: hasUsage ? 'usage' : 'estimate',
    promptTokens,
    completionTokens,
    totalTokens,
    cachedTokens,
    cacheRate: cachedTokens != null && promptTokens > 0 ? Math.min(1, cachedTokens / promptTokens) : null,
    limit: resolved.limit,
    limitSource: resolved.source,
    estimatedPrompt: analysis.estimated,
    breakdown,
    items: calibratedItems,
    messageCount: analysis.messageCount,
    toolCount: analysis.toolCount,
    toolCallCount: analysis.toolCallCount,
    turnCount: analysis.turnCount
  };
}

function estimateJsonTokens(value) {
  try {
    return estimateTokens(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function messageStats(messages) {
  const byRole = {};
  let total = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object') continue;
    const role = String(message.role || message.type || 'unknown');
    const tokens = estimateTokens(stringifyText(message.content)) + estimateJsonTokens(message.tool_calls || message.toolCalls || []);
    total += tokens;
    if (!byRole[role]) byRole[role] = { count: 0, tokens: 0 };
    byRole[role].count += 1;
    byRole[role].tokens += tokens;
  }
  return { count: Array.isArray(messages) ? messages.length : 0, total, byRole };
}

function buildSamples(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const roles = {};
  for (const message of list) {
    const role = String(message.role || message.type || 'unknown');
    if (!roles[role]) {
      roles[role] = {
        keys: Object.keys(message),
        contentSample: stringifyText(message.content).slice(0, 300)
      };
    }
  }
  const toolMessages = list
    .filter((message) => String(message.role) === 'tool')
    .slice(-3)
    .map((message) => ({
      name: message.name || '',
      callId: message.tool_call_id || message.toolCallId || '',
      content: stringifyText(message.content).slice(0, 400)
    }));
  const assistantCalls = [];
  for (let index = list.length - 1; index >= 0 && assistantCalls.length < 2; index -= 1) {
    const message = list[index];
    const calls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : Array.isArray(message.toolCalls)
        ? message.toolCalls
        : [];
    for (const call of calls) {
      assistantCalls.push({
        name: (call.function && call.function.name) || call.name || '',
        arguments: stringifyText((call.function && call.function.arguments) || call.arguments || '').slice(0, 400)
      });
      if (assistantCalls.length >= 2) break;
    }
  }
  return { roles, toolMessages, assistantCalls };
}

async function recordDebug(point, args, info, extracted, picked, snapshot) {
  try {
    await mkdir(DEBUG_DIR, { recursive: true });
    const payloadArg = args[0];
    const topLevelTokens = {};
    if (payloadArg && typeof payloadArg === 'object') {
      for (const key of Object.keys(payloadArg)) topLevelTokens[key] = estimateJsonTokens(payloadArg[key]);
    }
    const payload = {
      at: new Date().toISOString(),
      point,
      argCount: args.length,
      argKeys: args.map((arg) => (arg && typeof arg === 'object' ? Object.keys(arg).slice(0, 40) : typeof arg)),
      topLevelTokens,
      messageStats: messageStats((extracted && extracted.messages) || info.messages),
      messageSamples: buildSamples((extracted && extracted.messages) || info.messages),
      extrasTokens: extracted ? extracted.extras : {},
      usagePick: {
        sourceIndex: picked ? picked.sourceIndex : -1,
        usage: picked ? picked.usage : null,
        raw: picked ? picked.raw : null
      },
      extracted: extracted
        ? {
            model: extracted.model,
            sessionId: extracted.sessionId,
            systemLength: extracted.system ? String(extracted.system).length : 0,
            toolSchemaTokens: extracted.toolSchemaTokens,
            limitHints: extracted.limitHints
          }
        : null,
      snapshot: snapshot
        ? {
            promptTokens: snapshot.promptTokens,
            source: snapshot.source,
            cachedTokens: snapshot.cachedTokens,
            cacheRate: snapshot.cacheRate,
            limit: snapshot.limit,
            limitSource: snapshot.limitSource,
            estimatedPrompt: snapshot.estimatedPrompt,
            breakdown: snapshot.breakdown
          }
        : null
    };
    await writeFile(join(DEBUG_DIR, 'debug.json'), JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // 诊断写入失败不影响主流程
  }
}

function snapshotKey(sessionId) {
  return `snap:${sessionId}`;
}

async function saveSnapshot(ctx, snapshot, settings, replaceBefore) {
  const store = ctx.getStore();
  const key = snapshotKey(snapshot.sessionId);
  let list = await store.get(key);
  if (!Array.isArray(list)) list = [];

  if (replaceBefore) {
    const index = list.findIndex(
      (item) => item && item.phase === 'before' && Math.abs(snapshot.at - item.at) <= 180000
    );
    if (index >= 0) {
      snapshot.id = list[index].id;
      list.splice(index, 1, snapshot);
    } else {
      list.unshift(snapshot);
    }
  } else {
    list.unshift(snapshot);
  }

  await store.set(key, list.slice(0, settings.keep));

  let meta = await store.get('sessions');
  if (!meta || typeof meta !== 'object') meta = {};
  meta[snapshot.sessionId] = {
    sessionId: snapshot.sessionId,
    updatedAt: snapshot.at,
    model: snapshot.model,
    promptTokens: snapshot.promptTokens,
    limit: snapshot.limit
  };
  await store.set('sessions', meta);
  await store.set('latest', snapshot.sessionId);
}

export function register(ctx) {
  const pending = { messages: null, tools: null, model: null, sessionId: null, at: 0 };

  const record = async (point, args, phase) => {
    try {
      const info = scanArgs(args);
      const extracted = extractPayload(args);
      const picked = pickUsage(args);
      const messages = extracted.messages || (pending.messages && pending.messages.length ? pending.messages : null);
      if (!messages || !messages.length) {
        await recordDebug(point, args, info, extracted, picked, null);
        return;
      }
      const settings = readSettings(ctx);
      const snapshot = buildSnapshot(
        {
          sessionId: extracted.sessionId || pending.sessionId || 'global',
          model: extracted.model || pending.model || '',
          messages,
          tools: info.tools || pending.tools || [],
          usage: picked.usage || info.usage,
          system: extracted.system || info.system,
          toolSchemaTokens: extracted.toolSchemaTokens,
          limitHints: [...extracted.limitHints, ...info.limitHints]
        },
        settings
      );
      snapshot.phase = phase;
      await saveSnapshot(ctx, snapshot, settings, phase === 'after');
      await recordDebug(point, args, info, extracted, picked, snapshot);
    } catch (error) {
      ctx.logger?.warn?.(`[context-inspector] ${point} 记录失败：${error && error.message}`);
    }
  };

  try {
    ctx.host.on('beforeAiCall', (...args) => {
      const info = scanArgs(args);
      const extracted = extractPayload(args);
      if (extracted.messages) pending.messages = extracted.messages;
      else if (info.messages) pending.messages = info.messages;
      if (info.tools) pending.tools = info.tools;
      if (extracted.model || info.model) pending.model = extracted.model || info.model;
      if (extracted.sessionId || info.sessionId) pending.sessionId = extracted.sessionId || info.sessionId;
      pending.at = Date.now();
      void record('beforeAiCall', args, 'before');
    });
  } catch (error) {
    ctx.logger?.warn?.(`[context-inspector] 无法挂载 beforeAiCall：${error && error.message}`);
  }

  try {
    ctx.host.on('afterAiCall', (...args) => {
      void record('afterAiCall', args, 'after');
    });
  } catch (error) {
    ctx.logger?.warn?.(`[context-inspector] 无法挂载 afterAiCall：${error && error.message}`);
  }

  ctx.registerRoute({
    method: 'GET',
    path: '/api/plugins/context-inspector/snapshot',
    handler: async ({ query }) => {
      const store = ctx.getStore();
      let sessionId = query && query.sessionId ? String(query.sessionId) : '';
      if (!sessionId) {
        const latest = await store.get('latest');
        sessionId = typeof latest === 'string' ? latest : '';
      }
      let items = sessionId ? await store.get(snapshotKey(sessionId)) : [];
      if (!Array.isArray(items)) items = [];

      let meta = await store.get('sessions');
      if (!meta || typeof meta !== 'object') meta = {};
      const sessions = Object.values(meta)
        .filter((entry) => entry && entry.sessionId)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .map((entry) => ({
          sessionId: entry.sessionId,
          updatedAt: entry.updatedAt || 0,
          model: entry.model || '',
          promptTokens: entry.promptTokens || 0,
          label: entry.sessionId === 'global' ? '未关联会话' : String(entry.sessionId).slice(0, 12)
        }));

      const payload = {
        success: true,
        sessionId: sessionId || null,
        items,
        sessions,
        settings: readSettings(ctx)
      };
      return { ...payload, data: payload };
    }
  });

  ctx.registerRoute({
    method: 'POST',
    path: '/api/plugins/context-inspector/clear',
    handler: async ({ body }) => {
      const store = ctx.getStore();
      const sessionId = body && body.sessionId ? String(body.sessionId) : '';
      const all = Boolean(body && body.all);
      if (all || !sessionId) {
        const meta = await store.get('sessions');
        if (meta && typeof meta === 'object') {
          for (const key of Object.keys(meta)) await store.delete(snapshotKey(key));
        }
        await store.set('sessions', {});
        await store.set('latest', '');
      } else {
        await store.delete(snapshotKey(sessionId));
        const meta = await store.get('sessions');
        if (meta && typeof meta === 'object') {
          delete meta[sessionId];
          await store.set('sessions', meta);
        }
      }
      return { success: true };
    }
  });
}
