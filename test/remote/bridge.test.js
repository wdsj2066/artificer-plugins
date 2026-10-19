import { test as runTest, onTestFinished } from "vitest";
const test = (name, handler) =>
  runTest(name, () => handler({ after: onTestFinished }));
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { createBridge, allowedPath, pageResource } from "../../plugins/remote/bridge.js";

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

test("上游地址留空时自动使用探测到的宿主地址，手动填写优先", async (t) => {
  const auto = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: true, data: { from: "auto" } }));
  });
  await new Promise((r) => auto.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        auto.closeAllConnections();
        auto.close(r);
      }),
  );
  const autoOrigin = `http://127.0.0.1:${auto.address().port}`;

  const f = await fixture(t, {
    settings: () => ({ upstream: "" }),
    lookupUpstream: () => autoOrigin,
  });
  const headers = await f.pair();
  const proxied = await f.call("/api/sessions", "GET", undefined, headers);
  assert.equal(proxied.status, 200);
  assert.equal(proxied.data.data.from, "auto");
  assert.deepEqual(f.bridge.status().upstream, {
    origin: autoOrigin,
    source: "auto",
  });

  // 手动填写后不再使用探测结果
  const manual = await fixture(t, {
    settings: () => ({ upstream: "http://127.0.0.1:9" }),
    lookupUpstream: () => autoOrigin,
  });
  assert.deepEqual(manual.bridge.status().upstream, {
    origin: "http://127.0.0.1:9",
    source: "manual",
  });

  // 探测为空且未填写时回落到内置默认值
  const fallback = await fixture(t, {
    settings: () => ({}),
    lookupUpstream: () => "",
  });
  assert.deepEqual(fallback.bridge.status().upstream, {
    origin: "http://127.0.0.1:8080",
    source: "default",
  });
});

test("产物路径查询允许编码目录和中文，仍拒绝路径与查询逃逸", () => {
  for (const file of [
    "images/测试 图.png",
    "C:\\Workspace\\docs\\指南.pdf",
    "docs/readme.md",
  ])
    for (const action of ["raw", "download", "content", "handlers"])
      assert.equal(
        allowedPath(
          "GET",
          `/api/sessions/session-1/artifacts/${action}?filePath=${encodeURIComponent(file)}`,
        ),
        true,
        file,
      );
  for (const path of [
    "/api/sessions/session-1/artifacts/raw?filePath=..%2Fsecret.txt",
    "/api/sessions/session-1/artifacts/raw?filePath=..%5Csecret.txt",
    "/api/sessions/session-1/artifacts/raw?filePath=%252e%252e%252fsecret.txt",
    "/api/sessions/session-1/artifacts/raw?filePath=ok.png&filePath=..%2Fsecret",
    "/api/sessions/session-1/artifacts/raw?filePath=ok.png&target=evil",
    "/api/sessions/%2e%2e/plugins/remote/pairing",
  ])
    assert.equal(allowedPath("GET", path), false, path);
});
test("图片和附件通过配对认证转发原始字节与文件名，撤销后无法继续读取", async (t) => {
  const bytes = new Uint8Array([137, 80, 78, 71, 0, 255]);
  let received;
  const f = await fixture(t, {
    fetchImpl: async (url, options) => {
      received = { url: String(url), headers: options.headers };
      return new Response(bytes, {
        headers: {
          "Content-Type": "image/png",
          "Content-Disposition": 'inline; filename="test.png"',
        },
      });
    },
  });
  const path =
    "/api/sessions/session-1/artifacts/raw?filePath=images%2Ftest.png";
  assert.equal((await fetch(f.base + path)).status, 401);
  const headers = await f.pair();
  const response = await fetch(f.base + path, { headers });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.equal(
    response.headers.get("content-disposition"),
    'inline; filename="test.png"',
  );
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(received.url, "http://127.0.0.1:8080" + path);
  assert.equal(received.headers.Authorization, undefined);
  assert.ok(!received.url.includes(headers.Authorization.slice(7)));
  f.bridge.revoke(f.bridge.status().devices[0].id);
  assert.equal((await fetch(f.base + path, { headers })).status, 401);
});

test("跨域预检允许 ngrok 提示页跳过请求头", async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/remote/info`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://localhost",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "ngrok-skip-browser-warning",
    },
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("Access-Control-Max-Age"), "600");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://localhost");
  assert.match(response.headers.get("Access-Control-Allow-Headers"), /ngrok-skip-browser-warning/i);
});

test("资源分页保留响应结构并在分页前按项目和标题筛选", async (t) => {
  const payload = { success: true, data: { sessions: [{ id: "a", workspaceId: "one", title: "测试一" }, { id: "b", workspaceId: "two", title: "测试二" }, { id: "c", workspaceId: "one", title: "测试三" }] } };
  const result = pageResource(payload, "sessions", new URLSearchParams({ remoteLimit: "1", remoteOffset: "1", remoteWorkspace: "one", remoteSearch: "测试" }));
  assert.deepEqual(result.data.sessions.map(s => s.id), ["c"]);
  assert.equal(result.data.total, 2);
  assert.equal(result.data.hasMore, false);
  const f = await fixture(t, { fetchImpl: async url => { assert.equal(url.searchParams.has("remoteLimit"), false); return Response.json({ success: true, data: { workspaces: [{ id: "1" }, { id: "2" }] } }); } });
  const headers = await f.pair();
  const response = await f.call("/api/workspaces?remoteLimit=1&remoteOffset=0", "GET", null, headers);
  assert.equal(response.data.data.workspaces.length, 1);
  assert.equal(response.data.data.hasMore, true);
});
