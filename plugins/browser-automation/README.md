# 网页预览与控制

Artificer 外置插件：在右侧信息面板中预览本机网页，并通过 Chromium CDP 提供 DOM 检查、元素操作和浏览器原生确认框处理。支持网页截图与整个屏幕截图。框选元素的详情使用独立悬浮窗展示；插件不修改底部聊天输入栏的 UI。

## 使用方式

1. 首次安装或启用插件后，重启 Artificer 一次。插件的 `bootstrap` 入口会在 Electron 启动前将 Chromium CDP 服务绑定到 `127.0.0.1`，并让 Chromium 随机分配端口。
2. 在聊天中让 Agent 调用“启动网页预览”。可直接传 HTML 文件路径，也可启动开发服务；默认执行 `npm run dev`。插件会从开发服务输出中识别本机 URL，并自动切换到右侧信息面板的“网页预览”页签。也可在面板中连接已运行的 `http://localhost:<端口>/` 地址。
3. 信息面板中的页面可直接点击和输入；开发服务器模式会转发热更新，直接 HTML 模式可手动刷新。相机按钮截取 iframe 网页，显示器按钮截取整个主屏幕；两种截图都可以预览并保存为 JPG。
4. Agent 的 `browserInspect`、`browserReadHtml`、`browserSelectElement`、`browserAct` 和 `browserMouse` 通过 Puppeteer Core 连接 Artificer Chromium 的 CDP browser endpoint，再按预览代理 origin 找到当前会话的 iframe。读取和交互面向 Chromium 的 frame，避免把页面转换成一组不完整的自制结构。
5. `browserInspect` 会返回实际 DOM、HTML、可访问性树、页面正文、控件和语义对话框。浏览器原生 `window.alert`、`window.confirm` 和 `window.prompt` 会作为原生对话框状态返回；Agent 使用 `browserResolveDialog` 接受或取消。接受确认框会继续执行页面动作，并经过敏感工具确认流程。
6. 用户手动框选元素后会在应用上方打开独立详情悬浮窗；“放入聊天框”和“围绕元素提问”会将网页元素引用加入当前会话。此 UI 框选功能仍使用页面桥接，Agent 的 DOM 检查与操作不依赖它。

独立信息面板窗口通过同源消息通道将元素引用送达聊天页；需要包含引用标签接收功能的 Artificer 版本。

## 启动命令示例

```text
直接预览 HTML：browserStartPreview({ "htmlFile": "index.html" })
预览子目录文件：browserStartPreview({ "htmlFile": "web/demo.html" })
默认项目：browserStartPreview()
指定命令：browserStartPreview({ "command": "npm run dev -- --host 127.0.0.1" })
指定子目录：browserStartPreview({ "directory": "web", "command": "npm run dev" })
接入已运行服务：browserStartPreview({ "url": "http://localhost:5173/" })
```

直接 HTML 模式会从工作区目录提供 HTML 与相对引用的静态资源；开发服务模式会拦截服务器返回的 HTML，并代理资源和热更新连接。两种模式都在信息面板中加载可交互 iframe。

CDP 是本机回环服务，能够完整控制 Artificer 的 Chromium 页面。Electron 插件入口是受信任的主进程代码。禁用插件后，Chromium 启动参数会在应用下次重启时恢复；macOS 屏幕截图还需要系统授予屏幕录制权限。

更完整的组件流程、消息协议和安全边界见 [DESIGN.md](./DESIGN.md)。

停止由插件启动的开发服务时，会等待 Windows 进程树终止后再返回，避免 npm 退出而 Vite 子进程继续占用端口。
