# 网页预览与控制插件设计

## 目标

在 Artificer 右侧信息面板中运行并操作当前工作区的 HTML 页面。Agent 能启动开发服务、读取服务实际返回的 HTML 与页面运行后的 DOM，并使用 CSS 选择器或鼠标坐标操作页面。用户可以在页面里选择一个 `div`，在独立悬浮详情窗查看元素信息，再把它作为上下文放入聊天输入框或发起针对它的提问/修改请求；插件不向底部输入栏添加按钮或控件。

## 结构

```text
Agent 工具
  ├─ browserStartPreview ──启动命令──> 本机开发服务 ──拦截 HTML──┐
  │                       └─htmlFile──> 工作区静态 HTML ──────────┤
  ├─ browserInspect / browserReadHtml / browserAct / browserMouse
  │                         └─Puppeteer Core──> Chromium CDP──> 预览 iframe
  ├─ browserResolveDialog ──Puppeteer Dialog──> 页面原生 JS 对话框
  └─ browserDesktopScreenshot ──Electron RPC──> desktopCapturer──> 屏幕截图

右侧信息面板
  ├─ 实时 iframe ──HTTP + WebSocket──> 127.0.0.1 动态端口的代理 ──> localhost 开发服务
  ├─ 注入的桥接脚本：用户手动框选元素、报告当前 iframe URL
  └─ 框选元素 ──> 独立悬浮详情窗 ──选择动作──> 当前聊天输入框

启动前插件
  └─ bootstrap ──app.commandLine──> Chromium 随机 CDP 端口（只绑定 127.0.0.1）
```

## 关键流程

1. 首次安装或启用插件后重启 Artificer。bootstrap 在 Electron app.ready 前设置 Chromium CDP 开关，让 Chromium 随机选择端口并把活动端口写入用户数据目录的 DevToolsActivePort。
2. Agent 调用 browserStartPreview。传入 htmlFile 时，后端从当前工作区直接提供该 .html/.htm 文件和相对静态资源；否则默认运行 npm run dev。开发服务器地址可从 stdout/stderr 自动识别，也可传入不同命令、通过 directory 指定工作区子目录，或接入已运行的本机 URL。
3. 开发服务模式会动态分配本机代理端口，预热首页并缓存原始 HTML 响应；静态文件模式也经过同一个 HTML 代理，以便注入用户框选桥接脚本。相同会话连接相同上游 origin 时复用代理和 iframe 上下文，保留站点存储和登录态；不同上游源使用不同代理 origin。
4. API 插件通过主应用令牌保护的 RPC 向 Electron 插件请求 CDP browser URL。Puppeteer Core 连接后按会话代理 origin 找到对应 BrowserWindow 里的 iframe frame。Agent 的页面检查、HTML 读取、选择器操作和坐标鼠标操作直接运行在该 frame，不再靠面板轮询或手工拼有限控件列表。
5. Puppeteer 监听页面的原生 dialog 事件。browserInspect 返回普通 DOM 模态框、可见正文、语义控件和未处理的 JS 原生对话框；Agent 使用 browserResolveDialog 显式接受或取消 alert、confirm 和 prompt。接受操作受 sensitive 工具确认流程保护。
6. 网页截图保留当前视口/完整页面功能；全桌面截图由 browserDesktopScreenshot 调用 Electron 主进程 desktopCapturer，默认捕获主显示器，也可先用 browserListScreens 选择其他显示器。截图缩放到最长边 3200 像素后编码为 JPG。
7. 用户框选功能仍使用页面桥接脚本：鼠标高亮目标、生成脱敏元素详情并写入插件状态。Agent 工具的 DOM 检查与操作不依赖该桥接。截图图像使用短期缓存 ID，避免 Base64 图像进入对话记录。
## 工具接口

| 工具 | 用途 |
|---|---|
| `browserStartPreview` | 启动开发命令或接入已运行的本机服务 |
| `browserStopPreview` | 关闭当前会话的开发进程和代理 |
| `browserPreviewStatus` | 查看服务状态和最近输出 |
| `browserReadHtml` | 读取代理拦截的 HTML 响应及已渲染 DOM |
| `browserInspect` | 检查页面 DOM、HTML、可访问性树、对话框和控件 |
| `browserSelectElement` | 按 CSS 选择器选中元素 |
| `browserGetSelection` | 读取用户在面板中选中的元素 |
| `browserAct` | 通过选择器点击、输入、选择、按键、悬停或滚动 |
| `browserMouse` | 通过视口坐标移动、单击、双击、右击或滚动 |
| `browserScreenshot` | 截取 iframe 网页当前视口或完整页面，并在工具结果卡片中显示和保存 JPG |
| `browserDesktopScreenshot` | 截取整个主显示器或指定显示器，并在工具结果卡片中显示和保存 JPG |
| `browserListScreens` | 列出显示器名称、ID 和像素尺寸 |
| `browserResolveDialog` | 接受或取消当前预览页的原生 JavaScript 对话框 |

以上工具通过外置插件 SDK 的 `ctx.registerTool()` 注册，沿用工具 JSON Schema、`tags` 与统一的 Agent 工具执行链。面板和后端之间的插件路由只承载 iframe 桥接消息，不构成额外工具类型。

## 边界与安全

- 预览代理只接受 localhost、127.0.0.1 和 ::1 上的 HTTP 开发服务，避免成为任意网络代理。
- 启动命令的工作目录限制在当前会话工作区内；启动/停止进程、网页交互、原生对话框接受/取消和整个屏幕截图使用敏感工具标签。
- CDP 服务随机选择端口并只绑定 127.0.0.1。本机其他进程若能发现该端口，也可以控制 Artificer 的 Chromium 页面。插件的 bootstrap 与 electron 入口属于完全受信任的主进程代码。
- 禁用插件不会改变当前进程已经应用的 Chromium 启动参数；退出应用后，下次启动会根据插件启用状态决定是否再次打开 CDP。
- CDP 覆盖页面 DOM、iframe 和浏览器原生 JavaScript 对话框。操作系统级文件选择器、屏幕录制授权提示和其他桌面程序窗口不属于网页 CDP；整个桌面截图通过 Electron 桌面采集接口实现。macOS 可能要求系统授予屏幕录制权限。
- 表单当前值不包含在控件摘要中；选中元素 HTML 会截断并移除输入框的 value，以减少凭据泄露。
