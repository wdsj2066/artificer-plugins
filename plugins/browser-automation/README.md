# 网页预览与控制

Artificer 外置插件：在聊天侧边栏运行当前工作区的网页，并提供 HTML 读取、DOM 检查、元素选择和鼠标自动化。

## 使用方式

1. 在聊天中让 Agent 调用“启动网页预览”。可直接传 HTML 文件路径，也可启动开发服务；默认执行 `npm run dev`。
2. 插件从开发服务输出中识别本机 URL，读取 HTML 响应并自动打开右侧“网页预览”面板。也可在面板中连接已经运行的 `http://localhost:<端口>/` 地址。
3. 面板中的页面可直接点击和输入；开发服务器模式会转发其热更新，直接 HTML 模式可手动刷新。打开“选择页面元素”，鼠标悬停预览高亮，点击默认选择最近的 `div`。
4. 对选中的元素使用“放入聊天框”“单独提问”或“请求修改”。聊天框会获得该元素的 CSS 选择器、文本和 HTML 片段。
5. Agent 可以调用 `browserReadHtml`、`browserInspect`、`browserAct`、`browserMouse` 等工具继续读取或操作页面。

## 启动命令示例

```text
直接预览 HTML：browserStartPreview({ "htmlFile": "index.html" })
预览子目录文件：browserStartPreview({ "htmlFile": "web/demo.html" })
默认项目：browserStartPreview()
指定命令：browserStartPreview({ "command": "npm run dev -- --host 127.0.0.1" })
指定子目录：browserStartPreview({ "directory": "web", "command": "npm run dev" })
接入已运行服务：browserStartPreview({ "url": "http://localhost:5173/" })
```

直接 HTML 模式会从工作区目录提供 HTML 与相对引用的静态资源；开发服务模式会拦截服务器返回的 HTML，并代理资源和热更新连接。两种模式都在面板中加载可交互 iframe。

更完整的组件流程、消息协议和安全边界见 [DESIGN.md](./DESIGN.md)。
