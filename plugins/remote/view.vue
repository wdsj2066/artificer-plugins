<template>
  <div class="remote-view">
    <div class="remote-inner">
      <!-- 页头 -->
      <header class="view-header">
        <div class="header-text">
          <h2>Remote 远程连接</h2>
          <p>
            用 Android 客户端连接这台电脑。配对成功后，手机可在授权范围内使用本机工作区与 Agent。
          </p>
        </div>
        <div class="header-actions">
          <span class="status-pill" :class="online ? 'is-online' : 'is-offline'">
            <span class="status-dot" />
            {{ online ? "服务运行中" : "服务未运行" }}
          </span>
          <n-tooltip trigger="hover">
            <template #trigger>
              <n-button
                quaternary
                circle
                size="small"
                :loading="refreshing"
                aria-label="刷新状态"
                @click="loadStatus(true)"
              >
                <template #icon><RefreshCw :size="15" /></template>
              </n-button>
            </template>
            刷新状态
          </n-tooltip>
        </div>
      </header>

      <div v-if="loading" class="state-block">
        <n-spin size="small" />
        <span>正在读取连接状态…</span>
      </div>

      <template v-else>
        <div v-if="error" class="error-bar" role="alert">
          <ShieldAlert :size="15" class="error-icon" />
          <span class="error-text">{{ error }}</span>
          <n-button size="tiny" quaternary @click="loadStatus(true)">重试</n-button>
        </div>

        <!-- 概览 -->
        <div class="stat-strip">
          <div class="stat">
            <span class="stat-label">监听端口</span>
            <span class="stat-value mono">{{ port ?? "—" }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">局域网地址</span>
            <span class="stat-value mono">{{ addresses.length || "—" }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">活跃连接</span>
            <span class="stat-value mono">{{ status?.activeRequests ?? 0 }}</span>
          </div>
          <div class="stat">
            <span class="stat-label">已配对设备</span>
            <span class="stat-value mono">{{ devices.length }}</span>
          </div>
        </div>

        <!-- 上游 API -->
        <div class="upstream-row">
          <div class="upstream-main">
            <Cloud :size="14" class="upstream-icon" />
            <span class="upstream-label">本机 API</span>
            <span class="upstream-value mono" :title="upstreamOrigin || '未获取'">
              {{ upstreamOrigin || "未获取" }}
            </span>
            <span class="source-tag" :class="`is-${upstreamSource}`">{{ sourceLabel }}</span>
          </div>
          <span v-if="upstreamSource === 'manual'" class="upstream-hint">
            在插件设置中清空「本机 Artificer API」可恢复自动获取
          </span>
          <span v-else-if="upstreamSource === 'default'" class="upstream-hint">
            暂未识别到当前实例，请打开本页一次或在设置中手动填写
          </span>
        </div>

        <div class="remote-grid">
          <!-- 左侧：配对 -->
          <section class="panel">
            <div class="panel-head">
              <div class="panel-title">
                <QrCode :size="15" />
                <h3>手机配对</h3>
              </div>
              <span class="panel-hint">配对码五分钟内有效</span>
            </div>

            <label class="field">
              <span class="field-label">手机连接地址</span>
              <div class="field-row">
                <n-select
                  v-model:value="serviceAddress"
                  class="address-select"
                  :options="addressOptions"
                  placeholder="选择局域网地址，或输入外网域名"
                  size="small"
                  filterable
                  tag
                  :consistent-menu-width="false"
                />
                <n-tooltip trigger="hover">
                  <template #trigger>
                    <n-button
                      quaternary
                      size="small"
                      :disabled="!serviceAddress"
                      aria-label="复制连接地址"
                      @click="copy(serviceAddress, '连接地址已复制')"
                    >
                      <template #icon><Copy :size="14" /></template>
                    </n-button>
                  </template>
                  复制地址
                </n-tooltip>
              </div>
              <span class="field-hint">
                {{
                  addresses.length
                    ? "手机需与电脑处于同一网络，或改用自备 HTTPS 隧道域名"
                    : "未检测到局域网地址，请检查插件设置中的监听地址"
                }}
              </span>
            </label>

            <n-button
              class="pair-button"
              type="primary"
              size="small"
              block
              :loading="generating"
              @click="generatePairing"
            >
              <template #icon><RotateCw :size="14" /></template>
              {{ pairing ? "重新生成配对码" : "生成配对码" }}
            </n-button>

            <div v-if="pairing" class="pairing">
              <div class="qr-frame">
                <img v-if="qrDataUrl" :src="qrDataUrl" alt="手机配对二维码" />
                <QrCode v-else :size="28" class="qr-placeholder" />
              </div>
              <div class="pairing-info">
                <span class="pairing-label">一次性配对码</span>
                <button
                  class="pairing-code"
                  title="点击复制配对码"
                  @click="copy(pairing.code, '配对码已复制')"
                >
                  {{ pairing.code }}
                  <Copy :size="13" class="code-copy" />
                </button>
                <span
                  class="pairing-countdown"
                  :class="{ 'is-urgent': remainingMs < 60000 }"
                >
                  <span class="countdown-dot" />
                  {{ remainingMs > 0 ? `剩余 ${countdownText}` : "已过期，请重新生成" }}
                </span>
              </div>
            </div>
            <div v-else class="pairing-empty">
              <Smartphone :size="20" />
              <p>尚未生成配对码</p>
              <span>生成后，用手机扫描二维码或输入一次性配对码发起配对</span>
            </div>
          </section>

          <!-- 右侧：请求与设备 -->
          <section class="panel">
            <div class="panel-head">
              <div class="panel-title">
                <ShieldCheck :size="15" />
                <h3>待确认手机</h3>
              </div>
              <span v-if="pending.length" class="count-badge">{{ pending.length }}</span>
              <span v-else class="panel-hint">本机确认后才可接入</span>
            </div>

            <ul v-if="pending.length" class="list request-list">
              <li v-for="item in pending" :key="item.id" class="request-item">
                <div class="row-main">
                  <div class="row-icon"><Smartphone :size="15" /></div>
                  <div class="row-meta">
                    <span class="row-name">{{ item.name }}</span>
                    <span class="row-desc">请求接入本机业务接口</span>
                  </div>
                </div>
                <div class="request-actions">
                  <n-button
                    size="tiny"
                    type="primary"
                    :loading="actingId === item.id"
                    @click="decide(item, true)"
                  >
                    <template #icon><Check :size="13" /></template>
                    允许
                  </n-button>
                  <n-button
                    size="tiny"
                    quaternary
                    :disabled="actingId === item.id"
                    @click="decide(item, false)"
                  >
                    <template #icon><X :size="13" /></template>
                    拒绝
                  </n-button>
                </div>
              </li>
            </ul>
            <div v-else class="mini-empty">
              <ShieldCheck :size="17" />
              <span>暂无待确认请求</span>
            </div>

            <div class="divider" />

            <div class="panel-head">
              <div class="panel-title">
                <Link2 :size="15" />
                <h3>已配对设备</h3>
              </div>
              <span class="panel-hint">{{ devices.length }} 台</span>
            </div>

            <ul v-if="devices.length" class="list device-list">
              <li v-for="device in devices" :key="device.id" class="device-item">
                <div class="row-main">
                  <div class="row-icon"><Smartphone :size="14" /></div>
                  <div class="row-meta">
                    <span class="row-name">{{ device.name }}</span>
                    <span class="row-desc">{{ formatTime(device.createdAt) }} 配对</span>
                  </div>
                </div>
                <n-popconfirm
                  positive-text="撤销"
                  negative-text="取消"
                  @positive-click="revoke(device)"
                >
                  <template #trigger>
                    <n-button size="tiny" quaternary type="error">撤销</n-button>
                  </template>
                  撤销后该手机需要重新配对才能访问本机
                </n-popconfirm>
              </li>
            </ul>
            <div v-else class="mini-empty">
              <span>还没有已配对设备</span>
            </div>
          </section>
        </div>

        <p class="footnote">
          <ShieldAlert :size="13" />
          配对设备拥有本机业务操作权限；手机不会获得网关令牌，Agent 工具执行仍受原会话授权策略约束。外网访问请使用自备的 HTTPS 隧道或可信虚拟局域网。
        </p>
      </template>
    </div>

    <!-- 轻提示：插件自带的 naive-ui 与宿主 provider 实例不同，不能使用 useMessage -->
    <div class="toast-stack" aria-live="polite">
      <div v-for="item in toasts" :key="item.id" class="toast" :class="`is-${item.tone}`">
        <Check v-if="item.tone !== 'error'" :size="13" />
        <X v-else :size="13" />
        <span>{{ item.text }}</span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import { NButton, NTooltip, NSelect, NSpin, NPopconfirm } from "naive-ui";
import {
  Smartphone,
  RefreshCw,
  Copy,
  ShieldCheck,
  ShieldAlert,
  Check,
  X,
  Link2,
  RotateCw,
  QrCode,
  Cloud,
} from "lucide-vue-next";

// 插件产物自带一份 naive-ui，与宿主 n-message-provider 注入的实例不是同一份，
// useMessage() 会因找不到宿主 provider 而抛错并让整页白屏，因此这里用视图内的轻提示。
const toasts = ref([]);
let toastSeed = 0;
let toastTimer = null;

function notify(text, tone = "success") {
  const id = ++toastSeed;
  toasts.value = [...toasts.value.slice(-2), { id, text, tone }];
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toasts.value = toasts.value.filter((item) => item.id !== id);
  }, 2600);
}

function notifyError(text) {
  notify(text, "error");
}

const status = ref(null);
const loading = ref(true);
const refreshing = ref(false);
const error = ref("");
const serviceAddress = ref("");
const generating = ref(false);
const actingId = ref("");
const clock = ref(Date.now());

let pollTimer = null;
let clockTimer = null;
let expirySynced = false;

const port = computed(() => status.value?.address?.port ?? null);
const online = computed(() => Boolean(port.value));
const addresses = computed(() => status.value?.addresses || []);
const pending = computed(() => status.value?.pending || []);
const devices = computed(() => status.value?.devices || []);
const pairing = computed(() => status.value?.pairing || null);
const qrDataUrl = computed(() => status.value?.qrDataUrl || "");

const upstreamOrigin = computed(() => status.value?.upstream?.origin || "");
const upstreamSource = computed(() => status.value?.upstream?.source || "default");
const sourceLabel = computed(
  () =>
    ({ auto: "自动获取", manual: "手动指定", default: "默认值" })[upstreamSource.value] ||
    "默认值",
);

const addressOptions = computed(() =>
  addresses.value.map((address) => ({
    label: address.replace(/^https?:\/\//, ""),
    value: address,
  })),
);

const remainingMs = computed(() => {
  const expiresAt = pairing.value?.expiresAt;
  if (!expiresAt) return 0;
  return Math.max(0, expiresAt - clock.value);
});

const countdownText = computed(() => {
  const total = Math.ceil(remainingMs.value / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
});

async function request(path = "status", method = "GET", body) {
  const response = await fetch(`/api/plugins/remote/${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = await response
    .json()
    .catch(() => ({ success: false, error: "服务返回了无法解析的内容" }));
  if (!response.ok || !payload.success) {
    throw new Error(payload?.error || `请求失败 (${response.status})`);
  }
  return payload.data;
}

async function loadStatus(manual = false) {
  if (manual) refreshing.value = true;
  try {
    const data = await request("status");
    status.value = data;
    error.value = "";
    // 新的配对码出现后，允许再次触发过期同步
    if (data.pairing && data.pairing.expiresAt > Date.now()) expirySynced = false;
    if (!serviceAddress.value) serviceAddress.value = data.addresses?.[0] || "";
  } catch (e) {
    error.value = e?.message || "无法读取连接状态";
  } finally {
    loading.value = false;
    refreshing.value = false;
  }
}

async function generatePairing() {
  if (generating.value) return;
  generating.value = true;
  try {
    const address = serviceAddress.value.trim();
    await request("pairing", "POST", address ? { address } : {});
    await loadStatus();
    notify("配对码已生成，请在五分钟内完成配对");
  } catch (e) {
    notifyError(e.message || "生成配对码失败");
  } finally {
    generating.value = false;
  }
}

async function decide(item, allow) {
  if (actingId.value) return;
  actingId.value = item.id;
  try {
    await request(`requests/${encodeURIComponent(item.id)}`, "POST", { allow });
    notify(allow ? `已允许 ${item.name} 接入` : `已拒绝 ${item.name}`);
    await loadStatus();
  } catch (e) {
    notifyError(e.message || "操作失败");
  } finally {
    actingId.value = "";
  }
}

async function revoke(device) {
  try {
    await request(`devices/${encodeURIComponent(device.id)}`, "DELETE");
    notify(`${device.name} 的访问权限已撤销`);
    await loadStatus();
  } catch (e) {
    notifyError(e.message || "撤销失败");
  }
}

async function copy(text, tip) {
  const value = String(text || "").trim();
  if (!value) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(value);
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }
    document.body.removeChild(area);
    if (!copied) {
      notifyError("复制失败，请手动选择文本");
      return;
    }
  }
  notify(tip || "已复制");
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatTime(timestamp) {
  if (!timestamp) return "未知时间";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "未知时间";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

onMounted(() => {
  loadStatus();
  pollTimer = setInterval(() => {
    if (!document.hidden) loadStatus();
  }, 3000);
  clockTimer = setInterval(() => {
    clock.value = Date.now();
    // 配对码刚过期时主动刷新一次状态，避免倒计时停在 00:00
    if (pairing.value && pairing.value.expiresAt <= clock.value && !expirySynced) {
      expirySynced = true;
      loadStatus();
    }
  }, 1000);
});

onUnmounted(() => {
  clearInterval(pollTimer);
  clearInterval(clockTimer);
});
</script>

<style scoped>
.remote-view {
  height: 100%;
  overflow-y: auto;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 13px;
  line-height: 1.5;
}

.remote-inner {
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 940px;
  margin: 0 auto;
  padding: 24px 32px 48px;
}

/* 页头 */
.view-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.header-text h2 {
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 600;
}

.header-text p {
  margin: 0;
  max-width: 560px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--text-muted);
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 999px;
  white-space: nowrap;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
}

.status-pill.is-online .status-dot {
  background: #2ea043;
  box-shadow: 0 0 0 3px rgba(46, 160, 67, 0.16);
}

.status-pill.is-offline {
  color: var(--text-muted);
}

/* 概览指标 */
.stat-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 11px 14px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md, 8px);
}

.stat-label {
  font-size: 11.5px;
  color: var(--text-muted);
}

.stat-value {
  font-size: 15px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mono {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
}

/* 上游 API 来源 */
.upstream-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 9px 14px;
  font-size: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md, 8px);
}

.upstream-main {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.upstream-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.upstream-label {
  flex-shrink: 0;
  color: var(--text-muted);
}

.upstream-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-primary);
}

.source-tag {
  display: inline-flex;
  align-items: center;
  height: 17px;
  padding: 0 6px;
  flex-shrink: 0;
  font-size: 10.5px;
  border-radius: 999px;
  background: var(--bg-tertiary);
  color: var(--text-muted);
}

.source-tag.is-auto {
  color: #2ea043;
  background: rgba(46, 160, 67, 0.12);
}

.source-tag.is-manual {
  color: var(--accent);
  background: var(--sidebar-active);
}

.upstream-hint {
  font-size: 11.5px;
  color: var(--text-muted);
}

/* 轻提示 */
.toast-stack {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}

.toast {
  display: flex;
  align-items: center;
  gap: 7px;
  max-width: 320px;
  padding: 9px 13px;
  font-size: 12.5px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 6px);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.14);
  animation: toast-in 0.16s ease-out;
}

.toast.is-success svg {
  color: #2ea043;
  flex-shrink: 0;
}

.toast.is-error svg {
  color: var(--warning-color, #d29922);
  flex-shrink: 0;
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* 两栏布局 */
.remote-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.06fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

.panel {
  display: flex;
  flex-direction: column;
  padding: 16px 18px 18px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md, 8px);
}

.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 22px;
}

.panel-title {
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}

.panel-title svg {
  color: var(--accent);
  flex-shrink: 0;
}

.panel-title h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

.panel-hint {
  font-size: 11.5px;
  color: var(--text-muted);
  white-space: nowrap;
}

.count-badge {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 999px;
}

/* 表单 */
.field {
  display: block;
  margin-top: 16px;
}

.field-label {
  display: block;
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-secondary);
}

.field-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.address-select {
  flex: 1;
  min-width: 0;
}

.field-hint {
  display: block;
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.55;
  color: var(--text-muted);
}

.pair-button {
  margin-top: 14px;
}

/* 配对码 */
.pairing {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px dashed var(--border-color);
}

.qr-frame {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 128px;
  height: 128px;
  padding: 8px;
  flex-shrink: 0;
  background: #fff;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 6px);
}

.qr-frame img {
  display: block;
  width: 100%;
  height: 100%;
}

.qr-placeholder {
  color: #b8b8b8;
}

.pairing-info {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.pairing-label {
  font-size: 11px;
  color: var(--text-muted);
}

.pairing-code {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 22px;
  font-weight: 600;
  letter-spacing: 3px;
  color: var(--text-primary);
  background: none;
  border: none;
  cursor: pointer;
  transition: color 0.15s;
}

.pairing-code:hover {
  color: var(--accent);
}

.code-copy {
  opacity: 0.35;
}

.pairing-code:hover .code-copy {
  opacity: 0.9;
}

.pairing-countdown {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

.pairing-countdown.is-urgent {
  color: var(--warning-color, #d29922);
}

.countdown-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  animation: remote-pulse 1.6s ease-in-out infinite;
}

@keyframes remote-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.25;
  }
}

.pairing-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  margin-top: 16px;
  padding: 18px 12px 6px;
  text-align: center;
  color: var(--text-muted);
  border-top: 1px dashed var(--border-color);
}

.pairing-empty p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-secondary);
}

.pairing-empty span {
  max-width: 280px;
  font-size: 11.5px;
  line-height: 1.6;
}

/* 列表 */
.list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.request-item,
.device-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 11px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm, 6px);
  transition: border-color 0.15s, background 0.15s;
}

.request-item:hover,
.device-item:hover {
  background: var(--bg-hover, var(--bg-tertiary));
}

.row-main {
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
}

.row-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  color: var(--text-secondary);
  background: var(--bg-tertiary);
  border-radius: var(--radius-sm, 6px);
}

.row-meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.row-name {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row-desc {
  font-size: 11px;
  color: var(--text-muted);
}

.request-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}

.mini-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin-top: 10px;
  padding: 13px 12px;
  font-size: 12px;
  color: var(--text-muted);
  border: 1px dashed var(--border-color);
  border-radius: var(--radius-sm, 6px);
}

.divider {
  height: 1px;
  margin: 16px 0 13px;
  background: var(--border-color);
}

/* 状态与提示 */
.state-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 64px 0;
  font-size: 12px;
  color: var(--text-muted);
}

.error-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  font-size: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--warning-color, #d29922);
  border-radius: var(--radius-sm, 6px);
}

.error-icon {
  flex-shrink: 0;
  color: var(--warning-color, #d29922);
}

.error-text {
  flex: 1;
  min-width: 0;
  color: var(--text-primary);
}

.footnote {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  font-size: 11.5px;
  line-height: 1.65;
  color: var(--text-muted);
}

.footnote svg {
  flex-shrink: 0;
  margin-top: 2px;
}

/* 响应式 */
@media (max-width: 820px) {
  .remote-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 560px) {
  .remote-inner {
    padding: 18px 16px 40px;
  }

  .stat-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .view-header {
    flex-direction: column;
    gap: 10px;
  }

  .header-actions {
    align-self: flex-start;
  }

  .pairing {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
}
</style>
