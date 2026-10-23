import { createBridge } from "./bridge.js";
import { join } from "node:path";
import { homedir, networkInterfaces } from "node:os";
import QRCode from "./vendor/qrcode.js";

export async function register(ctx) {
  // 使用接收管理请求的实际套接字，避免 Host 头中的 IPv4/IPv6 别名
  // 把上游切到宿主没有监听的地址；旧宿主缺少套接字信息时才使用 Host。
  let detectedUpstream = "";
  const rememberUpstream = (hostHeader, socket) => {
    const localAddress = socket?.localAddress?.replace(/^::ffff:/, "");
    const localPort = socket?.localPort;
    if (["127.0.0.1", "::1"].includes(localAddress) &&
        Number.isInteger(localPort) && localPort > 0 && localPort <= 65535) {
      detectedUpstream = `http://${localAddress === "::1" ? "[::1]" : localAddress}:${localPort}`;
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
    } catch {}
  };
  const bridge = createBridge({
    store: ctx.getStore(),
    settings: () => ctx.getSettings(),
    lookupUpstream: () => detectedUpstream,
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
