import { test as runTest, onTestFinished } from "vitest";
const test = (name, handler) => runTest(name, () => handler({ after: onTestFinished }));
import assert from "node:assert/strict";
import http from "node:http";
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
});
