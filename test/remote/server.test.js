import { test as runTest, onTestFinished } from "vitest";
const test = (name, handler) => runTest(name, () => handler({ after: onTestFinished }));
import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { register } from "../../plugins/remote/server.js";

test("插件通过公开上下文启动和释放，管理接口限本机，生成二维码不依赖主项目内部模块", async (t) => {
  const reserve = http.createServer();
  await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const data = new Map(),
    routes = [],
    disposers = [];
  await register({
    getStore: () => ({
      get: (k) => data.get(k),
      set: (k, v) => data.set(k, v),
    }),
    getSettings: () => ({ port, host: "127.0.0.1" }),
    registerRoute: (r) => routes.push(r),
    disposeWithPlugin: (fn) => disposers.push(fn),
    logger: { error() {} },
  });
  t.after(async () => {
    for (const dispose of disposers) await dispose();
  });
  const input = (ip, origin, body) => ({
    req: { socket: { remoteAddress: ip }, headers: { origin } },
    res: {
      status(value) {
        this.statusCode = value;
      },
    },
    body,
  });
  const status = routes.find((r) => r.path.endsWith("/status"));
  assert.equal(status.handler(input("192.168.1.2")).success, false);
  assert.equal(
    status.handler(input("127.0.0.1", "https://evil.example")).success,
    false,
  );
  assert.equal(
    status.handler(input("127.0.0.1", "http://localhost:8080")).success,
    true,
  );
  const pair = routes.find((r) => r.path.endsWith("/pairing"));
  const result = await pair.handler(
    input("127.0.0.1", undefined, { address: `http://192.168.1.2:${port}` }),
  );
  assert.match(result.data.code, /^[A-F0-9]{8}$/);
  assert.match(
    status.handler(input("127.0.0.1")).data.qrDataUrl,
    /^data:image\/svg\+xml;base64,/,
  );
});


test("从本机管理请求的 Host 头自动获取宿主 API 地址", async (t) => {
  const reserve = http.createServer();
  await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const routes = [],
    disposers = [],
    settings = {};
  await register({
    getStore: () => ({ get: () => undefined, set: () => {} }),
    // upstream 留空即启用自动获取
    getSettings: () => ({ port, host: "127.0.0.1", upstream: "", ...settings }),
    registerRoute: (r) => routes.push(r),
    disposeWithPlugin: (fn) => disposers.push(fn),
    logger: { error() {} },
  });
  t.after(async () => {
    for (const dispose of disposers) await dispose();
  });
  const status = routes.find((r) => r.path.endsWith("/status"));
  const local = (host) => ({
    req: { socket: { remoteAddress: "127.0.0.1" }, headers: { host } },
    res: { status() {} },
  });

  const before = status.handler(local("127.0.0.1:9090")).data;
  assert.equal(before.upstream.source, "auto");
  assert.equal(before.upstream.origin, "http://127.0.0.1:9090");

  // 端口变化后跟随新的 Host 头
  const after = status.handler(local("localhost:9123")).data;
  assert.equal(after.upstream.origin, "http://localhost:9123");

  // 拒绝非本机 Host，避免把上游指向外部地址
  const remote = status.handler(local("evil.example:9999")).data;
  assert.equal(remote.upstream.origin, "http://localhost:9123");

  // 宿主仅监听 IPv6 时，即使管理页面发送 IPv4 Host 也不能切错上游。
  for (const host of ["127.0.0.1:9090", "localhost:9123", "evil.example:9999"]) {
    const actual = local(host);
    actual.req.socket.localAddress = "::1";
    actual.req.socket.localPort = 45873;
    assert.equal(status.handler(actual).data.upstream.origin, "http://[::1]:45873");
  }
  const ipv4 = local("[::1]:9090");
  ipv4.req.socket.localAddress = "::ffff:127.0.0.1";
  ipv4.req.socket.localPort = 45874;
  assert.equal(status.handler(ipv4).data.upstream.origin, "http://127.0.0.1:45874");
});


test("未打开配置界面时也能解析宿主地址，手机侧无需依赖管理路由轮询", async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, data: { sessions: [], total: 0 } }));
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        upstream.closeAllConnections();
        upstream.close(r);
      }),
  );
  const reserve = http.createServer();
  await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));

  const data = new Map(),
    routes = [],
    disposers = [];
  const previous = process.env.API_PORT;
  process.env.API_PORT = String(upstream.address().port);
  t.after(() => {
    if (previous === undefined) delete process.env.API_PORT;
    else process.env.API_PORT = previous;
  });

  await register({
    getStore: () => ({
      get: (k) => data.get(k),
      set: (k, v) => data.set(k, v),
    }),
    getSettings: () => ({ port, host: "127.0.0.1", upstream: "" }),
    registerRoute: (r) => routes.push(r),
    disposeWithPlugin: (fn) => disposers.push(fn),
    logger: { error() {} },
  });
  t.after(async () => {
    for (const dispose of disposers) await dispose();
  });

  // 关键点：全程不调用任何管理路由，模拟“配置界面从未打开”。
  const token = "detached-token";
  data.set("devices", [
    {
      id: "device-1",
      name: "Android",
      tokenHash: createHash("sha256").update(token).digest("hex"),
      createdAt: Date.now(),
    },
  ]);
  const response = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Artificer-Host": data.get("hostId"),
    },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).success, true);
  assert.equal(routes.length > 0, true);
});
