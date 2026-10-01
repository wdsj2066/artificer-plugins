# 网页预览与控制

Artificer 外置插件：在右侧信息面板中实时预览当前工作区网页，并提供 HTML 读取、DOM 检查、元素选择和鼠标自动化。框选元素的详情使用独立悬浮窗展示。插件不修改底部聊天输入栏的 UI。

## 使用方式

1. 在聊天中让 Agent 调用“启动网页预览”。可直接传 HTML 文件路径，也可启动开发服务；默认执行 `npm run dev`。
2. 插件从开发服务输出中识别本机 URL，并自动切换到右侧信息面板的“网页预览”页签。也可在面板中连接已经运行的 `http://localhost:<端口>/` 地址。
3. 信息面板中的页面可直接点击和输入；开发服务器模式会转发其热更新，直接 HTML 模式可手动刷新。打开“选择页面元素”，鼠标悬停预览高亮，点击默认选择最近的 `div`。
4. 用户手动框选元素后会在应用上方打开独立的详情悬浮窗，展示 CSS 选择器、页面、可见文本和 HTML 结构；Agent 通过工具选中元素时只更新状态，不打断用户或弹窗。“放入聊天框”和“围绕元素提问”会在当前会话输入区加入可移除的网页元素引用标签，后者还会填入提问引导语。点击“请求修改”后填写具体要求，再点击“发送修改请求”会把要求与引用直接提交给 Agent。元素详情在发送消息时展开为上下文，避免大段 HTML 占用编辑区。详情窗仅在聊天窗口确认接收后关闭，失败时保留内容供重试。
5. Agent 可以调用 `browserReadHtml`、`browserInspect`、`browserAct`、`browserMouse` 等工具继续读取或操作页面。

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

更完整的组件流程、消息协议和安全边界见 [DESIGN.md](./DESIGN.md)。

停止由插件启动的开发服务时，会等待 Windows 进程树终止后再返回，避免 npm 退出而 Vite 子进程继续占用端口。
