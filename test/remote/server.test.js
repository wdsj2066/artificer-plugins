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
