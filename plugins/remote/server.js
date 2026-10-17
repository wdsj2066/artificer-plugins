import { createBridge } from "./bridge.js";
import { join } from "node:path";
import { homedir, networkInterfaces } from "node:os";
import QRCode from "./vendor/qrcode.js";

export async function register(ctx) {
  const bridge = createBridge({
    store: ctx.getStore(),
    settings: () => ctx.getSettings(),
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
