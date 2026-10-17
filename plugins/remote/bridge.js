import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const fail = (status, message) => Object.assign(new Error(message), { status });
export function allowedPath(method, path) {
  // 仅代理已审阅业务路由，管理 Remote 的路由不对手机开放。
  if (!["GET", "POST", "PUT", "DELETE"].includes(method)) return false;
  if (method === "GET" && path === "/api/plugins") return true;
  if (
    ["GET", "PUT"].includes(method) &&
    /^\/api\/plugins\/(?!remote\/)[a-zA-Z0-9_-]+\/settings$/.test(path)
  )
    return true;
  if (
    !/^\/api\/(workspaces|sessions|agents|models|chat|config|skills|tools|commands|memories)(\/|\?|$)/.test(
      path,
    ) &&
    !(method === "GET" && path.startsWith("/api/system/browse"))
  )
    return false;
  if (/\/config\/(raw|token)(\/|\?|$)/.test(path)) return false;
  // 编码斜杠在 filePath 查询值中是正常文件路径，不能按路由逃逸误拦截。
  // 仍由宿主的会话资源接口校验文件归属；插件不直接读取任意电脑文件。
  const queryAt = path.indexOf("?");
  const pathname = queryAt < 0 ? path : path.slice(0, queryAt);
  if (
    method === "GET" &&
    /^\/api\/sessions\/[a-zA-Z0-9_-]+\/artifacts\/(raw|download|content|handlers)$/.test(
      pathname,
    ) &&
    queryAt >= 0
  ) {
    const params = new URLSearchParams(path.slice(queryAt + 1));
    const filePath = params.get("filePath");
    return (
      !!filePath &&
      params.getAll("filePath").length === 1 &&
      [...params.keys()].every((key) => key === "filePath") &&
      !/[\x00-\x1f]/.test(filePath) &&
      !filePath.replace(/\\/g, "/").split("/").includes("..") &&
      !/%2e|%2f|%5c/i.test(filePath)
    );
  }
  return !path.includes("..") && !/%2e|%2f|%5c/i.test(path);
}
export function createBridge({
  store,
  settings = () => ({}),
  fetchImpl = fetch,
  now = Date.now,
  uploadRoot,
  lookupUpstream,
}) {
  let hostId = store.get("hostId");
  if (!hostId) {
    hostId = randomUUID();
    store.set("hostId", hostId);
  }
  const devices = () => store.get("devices") || [];
  const pending = new Map();
  const attempts = new Map();
  const active = new Map();
  let pairing = null;
  // 上游地址解析优先级：手动填写 > 自动探测 > 内置默认值。
  // 自动探测由 server.js 通过管理请求的 Host 头提供，避免用户手写端口。
  function resolveUpstream() {
    const cfg = settings();
    const manual = String(cfg.upstream || "").trim();
    if (manual) return { origin: manual, source: "manual" };
    const detected = lookupUpstream?.();
    if (detected) return { origin: detected, source: "auto" };
    return { origin: "http://127.0.0.1:8080", source: "default" };
  }
  const json = (res, status, data) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  async function body(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) throw fail(413, "请求过大");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  function authenticate(req) {
    const token = req.headers.authorization?.replace(/^Bearer /, "") || "";
    const digest = hash(token);
    const device = devices().find((d) =>
      timingSafeEqual(Buffer.from(d.tokenHash), Buffer.from(digest)),
    );
    if (!token || !device) throw fail(401, "设备未配对或已被撤销");
    if (req.headers["x-artificer-host"] !== hostId)
      throw fail(409, "电脑身份不匹配");
    return device;
  }
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (
      origin &&
      ![
        "https://localhost",
        "http://localhost",
        "http://127.0.0.1:5173",
        "http://localhost:5173",
      ].includes(origin)
    )
      return json(res, 403, { error: "不支持的来源" });
    if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Artificer-Host",
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS",
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Disposition, Content-Type",
    );
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    const path = req.url;
    try {
      if (req.method === "GET" && path === "/remote/info")
        return json(res, 200, {
          hostId,
          name: "Artificer",
          protocol: 1,
          capabilities: ["pairing", "api-bridge", "detached-stream"],
        });
      if (req.method === "POST" && path === "/remote/pair") {
        for (const [id, item] of pending)
          if (item.expiresAt < now()) pending.delete(id);
        for (const [ip, item] of attempts)
          if (item.until < now()) attempts.delete(ip);
        const ip = req.socket.remoteAddress;
        const a = attempts.get(ip) || { count: 0, until: now() + 60000 };
        if (a.until < now()) {
          a.count = 0;
          a.until = now() + 60000;
        }
        attempts.set(ip, a);
        if (++a.count > 8) throw fail(429, "尝试过多，请稍后重试");
        const input = JSON.parse((await body(req)).toString());
        if (
          !pairing ||
          pairing.expiresAt < now() ||
          input.code !== pairing.code
        )
          throw fail(403, "配对码无效或已过期");
        if (pending.size >= 32) throw fail(429, "待处理请求过多");
        const id = secret();
        pending.set(id, {
          id,
          name: String(input.name || "Android 手机").slice(0, 80),
          expiresAt: now() + 300000,
          state: "pending",
        });
        pairing = null;
        return json(res, 202, { requestId: id });
      }
      if (req.method === "GET" && path?.startsWith("/remote/pair/")) {
        const id = path.slice("/remote/pair/".length);
        const item = pending.get(id);
        if (!item || item.expiresAt < now()) {
          pending.delete(id);
          throw fail(404, "配对请求已过期");
        }
        if (item.state === "approved") {
          pending.delete(id);
          return json(res, 200, {
            state: item.state,
            token: item.token,
            hostId,
          });
        }
        return json(res, 200, { state: item.state });
      }
      const device = authenticate(req);
      if (active.size >= 64) throw fail(429, "连接过多，请稍后重试");
      if (req.method === "POST" && path === "/remote/upload") {
        if (!uploadRoot) throw fail(503, "文件接收未配置");
        const input = JSON.parse((await body(req)).toString());
        if (
          typeof input.content !== "string" ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)
        )
          throw fail(400, "文件编码无效");
        const bytes = Buffer.from(input.content, "base64");
        if (!bytes.length || bytes.length > 5 * 1024 * 1024)
          throw fail(413, "单个文件需在 1B–5MB 之间");
        const name = basename(String(input.name || "attachment"))
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
          .slice(0, 120);
        const dir = join(uploadRoot, device.id);
        await mkdir(dir, { recursive: true });
        const filePath = join(dir, `${randomUUID()}-${name}`);
        await writeFile(filePath, bytes, { flag: "wx" });
        return json(res, 201, {
          success: true,
          data: {
            name,
            path: filePath,
            size: bytes.length,
            mimeType: String(
              input.mimeType || "application/octet-stream",
            ).slice(0, 128),
          },
        });
      }
      if (!allowedPath(req.method, path)) throw fail(404, "接口未开放");
      const cfg = settings();
      const upstreamTarget = resolveUpstream();
      const target = new URL(upstreamTarget.origin);
      if (
        !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) ||
        target.protocol !== "http:"
      )
        throw fail(500, "上游必须是本机 HTTP API");
      const payload = ["POST", "PUT"].includes(req.method)
        ? await body(req)
        : undefined;
      const headers = { "Content-Type": "application/json" };
      if (cfg.gatewayToken)
        headers.Authorization = `Bearer ${cfg.gatewayToken}`;
      const controller = new AbortController();
      const entry = { deviceId: device.id, controller, res, streaming: false };
      const key = randomUUID();
      active.set(key, entry);
      let clientClosed = false;
      res.on("close", () => {
        clientClosed = true;
        if (!entry.streaming) controller.abort();
      });
      try {
        entry.streaming = path.split("?")[0] === "/api/chat/stream";
        const upstream = await fetchImpl(new URL(path, target.origin), {
          method: req.method,
          headers,
          body: payload,
          signal: controller.signal,
          redirect: "error",
        });
        res.writeHead(upstream.status, {
          "Content-Type":
            upstream.headers.get("content-type") || "application/json",
          "Cache-Control": "no-store",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
          ...(upstream.headers.get("content-disposition")
            ? {
                "Content-Disposition": upstream.headers.get(
                  "content-disposition",
                ),
              }
            : {}),
        });
        // 手机断线后继续消费电脑流，保持本地订阅；上游终态或插件停用后释放。
        if (upstream.body)
          for await (const chunk of upstream.body) {
            if (!clientClosed && !res.destroyed) res.write(chunk);
          }
        if (!clientClosed) res.end();
      } finally {
        active.delete(key);
      }
    } catch (error) {
      if (!res.headersSent && !res.destroyed)
        json(res, error.status || 502, {
          success: false,
          error: error.status
            ? error.message
            : "电脑端请求失败，请检查插件设置与 API 状态",
        });
      else res.end();
    }
  });
  return {
    server,
    status: () => ({
      hostId,
      address: server.address(),
      upstream: resolveUpstream(),
      pairing: pairing && pairing.expiresAt > now() ? pairing : null,
      pending: [...pending.values()]
        .filter((x) => x.expiresAt > now() && x.state === "pending")
        .map(({ id, name }) => ({ id, name })),
      devices: devices().map(({ tokenHash, ...d }) => d),
      activeRequests: active.size,
    }),
    createPairing() {
      pairing = {
        code: randomBytes(4).toString("hex").toUpperCase(),
        expiresAt: now() + 300000,
      };
      return pairing;
    },
    approve(id, allow) {
      const item = pending.get(id);
      if (!item || item.state !== "pending" || item.expiresAt < now())
        throw fail(404, "配对请求无效");
      item.state = allow ? "approved" : "rejected";
      if (allow) {
        item.token = secret();
        const all = devices();
        all.push({
          id: randomUUID(),
          name: item.name,
          tokenHash: hash(item.token),
          createdAt: now(),
        });
        store.set("devices", all);
      }
    },
    revoke(id) {
      store.set(
        "devices",
        devices().filter((d) => d.id !== id),
      );
      for (const x of active.values())
        if (x.deviceId === id) {
          x.res.destroy();
          x.controller.abort();
        }
    },
    async close() {
      for (const x of active.values()) {
        x.controller.abort();
        x.res.destroy();
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      pending.clear();
      attempts.clear();
    },
  };
}
