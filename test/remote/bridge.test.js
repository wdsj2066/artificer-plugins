import { test as runTest, onTestFinished } from "vitest";
const test = (name, handler) => runTest(name, () => handler({ after: onTestFinished }));
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { createBridge, allowedPath } from "../../plugins/remote/bridge.js";


async function fixture(t, options = {}) {
  const data = new Map();
  const bridge = createBridge({
    store: { get: (k) => data.get(k), set: (k, v) => data.set(k, v) },
    ...options,
  });
  await new Promise((r) => bridge.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${bridge.server.address().port}`;
  t.after(() => bridge.close());
  const call = async (path, method = "GET", body, headers = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  };
  async function pair() {
    const code = bridge.createPairing().code;
    const request = await call("/remote/pair", "POST", {
      code,
      name: "测试手机",
    });
    assert.equal(
      (await call(`/remote/pair/${request.data.requestId}`)).data.state,
      "pending",
    );
    bridge.approve(request.data.requestId, true);
    const result = await call(`/remote/pair/${request.data.requestId}`);
    return {
      Authorization: `Bearer ${result.data.token}`,
      "X-Artificer-Host": result.data.hostId,
    };
  }
  return { bridge, base, call, pair, data };
}
test("设备必须经电脑确认，凭据只保存摘要，取走后不可重领，撤销立即生效", async (t) => {
  const f = await fixture(t, {
    fetchImpl: async () => new Response('{"success":true,"data":[]}'),
  });
  assert.equal((await f.call("/api/sessions")).status, 401);
  const headers = await f.pair();
  assert.equal(
    (await f.call("/api/sessions", "GET", null, headers)).status,
    200,
  );
  assert.equal(
    (
      await f.call("/api/sessions", "GET", null, {
        ...headers,
        "X-Artificer-Host": "wrong",
      })
    ).status,
    409,
  );
  assert.ok(
    !JSON.stringify(f.data.get("devices")).includes(
      headers.Authorization.slice(7),
    ),
  );
  const id = f.bridge.status().devices[0].id;
  assert.ok(!JSON.stringify(f.bridge.status()).includes("tokenHash"));
  f.bridge.revoke(id);
  assert.equal(
    (await f.call("/api/sessions", "GET", null, headers)).status,
    401,
  );
});
test("配对码一次性且会过期，恶意来源不允许访问", async (t) => {
  let time = 0;
  const f = await fixture(t, { now: () => time });
  const code = f.bridge.createPairing().code;
  time = 300001;
  assert.equal((await f.call("/remote/pair", "POST", { code })).status, 403);
  assert.equal(
    (
      await f.call("/remote/info", "GET", null, {
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  const fresh = f.bridge.createPairing().code;
  assert.equal(
    (await f.call("/remote/pair", "POST", { code: fresh })).status,
    202,
  );
  assert.equal(
    (await f.call("/remote/pair", "POST", { code: fresh })).status,
    403,
  );
});
test("桥接仅开放业务路径，拒绝管理路径与编码路径逃逸", () => {
  assert.ok(allowedPath("POST", "/api/chat/stream"));
  for (const p of [
    "/api/plugins/remote/pairing",
    "/api/config/raw",
    "/api/config/token/regenerate",
    "/api/sessions/../plugins",
    "/api/sessions/%2e%2e",
  ])
    assert.equal(allowedPath("GET", p), false);
});
test("手机断开后仍消费上游任务流，插件关闭时释放", async (t) => {
  let endUpstream,
    upstreamClosed = false;
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write('{"type":"start"}\n');
    req.on("close", () => {
      upstreamClosed = true;
    });
    endUpstream = () => res.end('{"type":"done"}\n');
  });
  await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        upstream.closeAllConnections();
        upstream.close(r);
      }),
  );
  const f = await fixture(t, {
    settings: () => ({
      upstream: `http://127.0.0.1:${upstream.address().port}`,
    }),
  });
  const headers = await f.pair(),
    controller = new AbortController();
  const r = await fetch(f.base + "/api/chat/stream", {
    method: "POST",
    headers,
    body: "{}",
    signal: controller.signal,
  });
  await r.body.getReader().read();
  controller.abort();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(upstreamClosed, false);
  assert.equal(f.bridge.status().activeRequests, 1);
  endUpstream();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(f.bridge.status().activeRequests, 0);
});

test("手机上传文件需认证，文件名不能逃逸上传目录", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "artificer-remote-test-"));
  t.after(async () => {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith("artificer-remote-test-")
    )
      throw new Error("测试清理路径异常");
    await rm(root, { recursive: true, force: true });
  });
  const f = await fixture(t, { uploadRoot: root });
  assert.equal(
    (
      await f.call("/remote/upload", "POST", {
        name: "a.txt",
        content: "aGVsbG8=",
      })
    ).status,
    401,
  );
  const headers = await f.pair();
  const result = await f.call(
    "/remote/upload",
    "POST",
    { name: "../../escape.txt", content: "aGVsbG8=" },
    headers,
  );
  assert.equal(result.status, 201);
  assert.ok(resolve(result.data.data.path).startsWith(resolve(root)));
  assert.equal(await readFile(result.data.data.path, "utf8"), "hello");
});
