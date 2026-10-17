<script setup>
import { ref, onMounted, onUnmounted } from "vue";
const status = ref(null),
  error = ref("");
const serviceAddress = ref("");
async function action(path = "status", method = "GET", body) {
  try {
    const r = await fetch(`/api/plugins/remote/${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json();
    if (!data.success) throw new Error(data.error);
    if (path === "status") {
      status.value = data.data;
      if (!serviceAddress.value)
        serviceAddress.value = data.data.addresses?.[0] || "";
    } else await action();
    error.value = "";
  } catch (e) {
    error.value = e.message;
  }
}
let timer;
onMounted(() => {
  action();
  timer = setInterval(() => action(), 3000);
});
onUnmounted(() => clearInterval(timer));
</script>
<template>
  <section class="remote-settings">
    <h2>Remote 远程连接</h2>
    <p>手机连接此电脑的 IP 和插件端口。首次连接需在这里确认。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="status"
      ><p>
        端口：{{ status.address?.port }} · 当前连接请求：{{
          status.activeRequests
        }}
      </p>
      <label
        >手机连接地址
        <input
          v-model="serviceAddress"
          placeholder="局域网地址或外网域名" /></label
      ><button @click="action('pairing', 'POST', { address: serviceAddress })">
        生成一次性配对码
      </button>
      <p v-if="status.pairing">
        配对码：<strong>{{ status.pairing.code }}</strong> · 五分钟有效
      </p>
      <img
        v-if="status.pairing && status.qrDataUrl"
        :src="status.qrDataUrl"
        alt="手机配对二维码"
        width="220"
        height="220"
      />
      <h3>待确认手机</h3>
      <p v-if="!status.pending.length">暂无配对请求</p>
      <div v-for="r in status.pending" :key="r.id">
        {{ r.name }}
        <button @click="action(`requests/${r.id}`, 'POST', { allow: true })">
          允许配对
        </button>
        <button @click="action(`requests/${r.id}`, 'POST', { allow: false })">
          拒绝
        </button>
      </div>
      <h3>已配对设备</h3>
      <div v-for="d in status.devices" :key="d.id">
        {{ d.name }}
        <button @click="action(`devices/${d.id}`, 'DELETE')">撤销访问</button>
      </div></template
    >
  </section>
</template>
<style scoped>
.remote-settings {
  padding: 24px;
  color: var(--text-primary);
}
button {
  padding: 8px 12px;
  margin: 6px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: inherit;
  background: var(--surface);
}
strong {
  letter-spacing: 3px;
}
p {
  color: var(--text-secondary);
}
</style>
