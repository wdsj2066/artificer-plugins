import { createBridge } from "./bridge.js";
import { join } from "node:path";
import { homedir, networkInterfaces } from "node:os";
import { connect } from "node:net";
import QRCode from "./vendor/qrcode.js";

const LOOPBACK_HOSTS = ["::1", "127.0.0.1"];

// 只确认端口上有进程监听，不发起业务请求，避免依赖宿主鉴权状态。
function reachable(host, port, timeout = 800) {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

export async function register(ctx) {
  // 使用接收管理请求的实际套接字，避免 Host 头中的 IPv4/IPv6 别名
  // 把上游切到宿主没有监听的地址；旧宿主缺少套接字信息时才使用 Host。
  let detectedUpstream = "";
  const persistPort = (port) => {
    try {
      if (ctx.getStore().get("upstreamPort") !== port)
        ctx.getStore().set("upstreamPort", port);
    } catch {}
  };
  const rememberUpstream = (hostHeader, socket) => {
    const localAddress = socket?.localAddress?.replace(/^::ffff:/, "");
    const localPort = socket?.localPort;
    if (["127.0.0.1", "::1"].includes(localAddress) &&
        Number.isInteger(localPort) && localPort > 0 && localPort <= 65535) {
      detectedUpstream = `http://${localAddress === "::1" ? "[::1]" : localAddress}:${localPort}`;
      persistPort(localPort);
      return;
    }
    if (!hostHeader) return;
    try {
      const url = new URL(`http://${hostHeader}`);
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      if (!["127.0.0.1", "localhost", "::1"].includes(hostname)) return;
      const port = Number(url.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return;
      const host = hostname.includes(":") ? `[${hostname}]` : hostname;
      detectedUpstream = `http://${host}:${port}`;
      persistPort(port);
    } catch {}
  };
  // 插件必须在“没人打开界面”时也能工作：管理路由只有打开配置页才会被调用，
  // 因此启动期主动解析一次上游，不能只依赖 rememberUpstream 的副作用。
  // 插件与宿主 API 同进程运行，可直接读取宿主正在监听的端口作为兜底。
  const processListeningPorts = () => {
    const ports = new Set();
    for (const handle of process._getActiveHandles?.() || []) {
      if (typeof handle?.address !== "function") continue;
      let addr;
      try {
        addr = handle.address();
      } catch {
        continue;
      }
      if (!addr || typeof addr !== "object") continue;
      const host = String(addr.address || "").replace(/^::ffff:/, "");
      if (!["127.0.0.1", "::1"].includes(host)) continue;
      if (Number.isInteger(addr.port) && addr.port > 0) ports.add(addr.port);
    }
    return [...ports];
  };
  const probeUpstream = async () => {
    const candidates = [];
    const fromEnv = Number(process.env.API_PORT);
    if (Number.isInteger(fromEnv) && fromEnv > 0 && fromEnv <= 65535)
      candidates.push(fromEnv);
    // 插件与宿主 API 同进程重启时，沿用上次确认过的端口，避免界面未打开时退化为默认值。
    const cached = Number(ctx.getStore().get("upstreamPort"));
    if (Number.isInteger(cached) && cached > 0 && cached <= 65535)
      candidates.push(cached);
    candidates.push(...processListeningPorts());
    for (const port of new Set(candidates)) {
      if (port === Number(ctx.getSettings()?.port)) continue;
      for (const host of LOOPBACK_HOSTS) {
        if (!(await reachable(host, port))) continue;
        detectedUpstream = `http://${host === "::1" ? "[::1]" : host}:${port}`;
        persistPort(port);
        return;
      }
    }
  };
  // 宿主可能先加载插件、后监听 API 端口，因此探测失败不算终态：
  // 请求到来或启动后短周期内可重试，避免手机侧必须打开配置界面才恢复。
  let probing = null;
  let retryTimer = null;
  const ensureUpstream = () => {
    if (detectedUpstream) return Promise.resolve(detectedUpstream);
    if (!probing)
      probing = probeUpstream().finally(() => {
        probing = null;
      });
    return probing.then(() => detectedUpstream);
  };
  const scheduleRetry = () => {
    if (detectedUpstream || retryTimer) return;
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      await probeUpstream();
      scheduleRetry();
    }, 1500);
    retryTimer.unref?.();
  };
  await probeUpstream();
  scheduleRetry();
  ctx.disposeWithPlugin(() => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
  });
  const bridge = createBridge({
    store: ctx.getStore(),
    settings: () => ctx.getSettings(),
    lookupUpstream: () => detectedUpstream,
    ensureUpstream,
    uploadRoot: join(
      process.env.APPDATA || homedir(),
      "Artificer",
      "remote-uploads",
    ),
  });
  const cfg = ctx.getSettings();
  const port = Number(cfg.port || 8091);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Remote 端口必须为 1024–65535");
  await new Promise((resolve, reject) => {
    bridge.server.once("error", reject);
    bridge.server.listen(port, cfg.host || "0.0.0.0", resolve);
  });
  bridge.server.on("error", (error) =>
    ctx.logger.error("Remote 服务错误", error.message),
  );
  ctx.disposeWithPlugin(() => bridge.close());
  const route = (method, suffix, handler) =>
    ctx.registerRoute({
      method,
      path: `/api/plugins/remote/${suffix}`,
      handler(input) {
        const ip = input.req.socket.remoteAddress;
        const origin = input.req.headers.origin;
        const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip);
        let trustedOrigin = !origin;
        if (origin) {
          try {
            trustedOrigin = ["localhost", "127.0.0.1", "[::1]"].includes(
              new URL(origin).hostname,
            );
          } catch {}
        }
        if (!local || !trustedOrigin) {
          input.res.status(403);
          return { success: false, error: "请在本机 Artificer 中管理远程设备" };
        }
        rememberUpstream(input.req.headers.host, input.req.socket);
        return handler(input);
      },
    });
  const addresses = () =>
    Object.values(networkInterfaces())
      .flat()
      .filter((i) => i.family === "IPv4" && !i.internal)
      .map((i) => `http://${i.address}:${port}`);
  let qrDataUrl = "";
  route("GET", "status", () => ({
    success: true,
    data: { ...bridge.status(), addresses: addresses(), qrDataUrl },
  }));
  route("POST", "pairing", async ({ body }) => {
    const address = new URL(
      body?.address || addresses()[0] || `http://127.0.0.1:${port}`,
    );
    if (
      !["http:", "https:"].includes(address.protocol) ||
      address.username ||
      address.password ||
      address.pathname !== "/" ||
      address.search ||
      address.hash
    )
      throw new Error("服务地址无效");
    const pairing = bridge.createPairing();
    const svg = await QRCode.toString(
      JSON.stringify({
        type: "artificer-remote",
        protocol: 1,
        hostId: bridge.status().hostId,
        address: address.origin,
        code: pairing.code,
      }),
      { type: "svg", margin: 2 },
    );
    qrDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    return { success: true, data: pairing };
  });
  route("POST", "requests/:id", ({ params, body }) => {
    bridge.approve(params.id, body.allow === true);
    return { success: true };
  });
  route("DELETE", "devices/:id", ({ params }) => {
    bridge.revoke(params.id);
    return { success: true };
  });
}
