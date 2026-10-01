# 网页预览与控制插件设计

## 目标

在 Artificer 的浏览器面板中运行并操作当前工作区的 HTML 页面。Agent 能启动开发服务、读取服务实际返回的 HTML 与页面运行后的 DOM，并使用 CSS 选择器或鼠标坐标操作页面。用户可以在页面里选择一个 `div`，把它作为上下文放入聊天框，或直接发起针对它的提问/修改请求。

## 结构

```text
Agent 工具
  ├─ browserStartPreview ──启动命令──> 本机开发服务 ──拦截 HTML──┐
  │                       └─htmlFile──> 工作区静态 HTML ──────────┤
  ├─ browserReadHtml ──────读取────────> HTML 反向代理捕获的原始响应
  ├─ browserInspect / browserAct / browserMouse
  │                         └─命令队列──> 预览页桥接脚本 ──结果──> Agent 工具
  └─ browserSelectElement ──命令队列──> 预览页桥接脚本

浏览器面板
  ├─ 实时 iframe ──HTTP + WebSocket──> 127.0.0.1 动态端口的代理 ──> localhost 开发服务
  ├─ 注入的桥接脚本：元素选择、DOM 信息、Agent 操作
  └─ 输入框动作：引用元素 / 单独提问 / 请求修改
```

## 关键流程

1. Agent 调用 `browserStartPreview`。传入 `htmlFile` 时，后端从当前工作区直接提供该 `.html` / `.htm` 文件和相对静态资源；否则默认运行 `npm run dev`。开发服务器地址可从 stdout/stderr 自动识别，也可传入不同命令、通过 `directory` 指定工作区子目录，或接入已运行服务的本机 URL。
2. 开发服务模式会动态分配本机代理端口，预热首页并缓存原始 HTML 响应；静态文件模式也经过同一个 HTML 代理，以便注入页面桥接脚本。
3. 顶栏监听预览活动，切换到发起调用的会话并展开右侧网页面板。面板 iframe 加载代理地址，页面可直接点击和输入；开发服务模式同时转发 WebSocket 热更新，静态 HTML 文件可手动刷新。
4. 代理仅改写 HTML 响应：插入桥接脚本，并移除阻止本机 iframe 展示的响应级 CSP / X-Frame-Options。其他资源直接流式代理，Vite WebSocket HMR 通过 TCP 隧道转发。
5. 桥接脚本在页面源内执行 DOM 查询与操作；后端把工具命令交给面板轮询，再由面板 `postMessage` 转给 iframe。命令结果和所选元素通过插件 API 返回后端。
6. 选择模式启用后，鼠标移动会高亮目标节点，点击默认选中最近的 `div`。选择结果带有 CSS 选择器、可见文本和脱敏截断的 HTML 片段，可引用到聊天框。

## 工具接口

| 工具 | 用途 |
|---|---|
| `browserStartPreview` | 启动开发命令或接入已运行的本机服务 |
| `browserStopPreview` | 关闭当前会话的开发进程和代理 |
| `browserPreviewStatus` | 查看服务状态和最近输出 |
| `browserReadHtml` | 读取代理拦截的 HTML 响应及已渲染 DOM |
| `browserInspect` | 检查页面正文、链接和表单控件 |
| `browserSelectElement` | 按 CSS 选择器选中元素 |
| `browserGetSelection` | 读取用户在面板中选中的元素 |
| `browserAct` | 通过选择器点击、输入、选择、按键、悬停或滚动 |
| `browserMouse` | 通过视口坐标移动、单击、双击、右击或滚动 |

以上工具通过外置插件 SDK 的 `ctx.registerTool()` 注册，沿用工具 JSON Schema、`tags` 与统一的 Agent 工具执行链。面板和后端之间的插件路由只承载 iframe 桥接消息，不构成额外工具类型。

## 边界与安全

- 预览代理只接受 `localhost`、`127.0.0.1` 和 `::1` 上的 HTTP 服务，防止其变成任意网络代理。
- 启动命令的工作目录限制在当前会话工作区内。启动/停止进程及网页交互工具标记为 `sensitive`。
- iframe 使用独立的本机代理源、受限 sandbox 和 `postMessage` 通信，不读取 Artificer 页面 DOM。
- 框选时仅把选中元素上下文发送给聊天；HTML 片段会截断到 5000 字符，并移除表单控件的 value 内容。
- 原始响应 HTML 最大缓存 2 MiB；工具读取最多返回 60000 字符。预览依赖已启用的网页面板，以完成 Agent 与 iframe 的命令往返。
- 当前实现面向本机 HTTP 开发服务。远程网站、HTTPS 服务、文件上传控件和需要可信用户事件的浏览器原生交互不属于首版范围。
- Agent 的鼠标工具在页面内派发 DOM 鼠标/指针事件；浏览器要求可信物理输入的安全验证或原生交互无法由这些事件完成。
