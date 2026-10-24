---
id: plugin-builder-integration
name: 插件底座接入契约
description: Artificer 六运行域、声明式能力、显式菜单入口、插件图标资源、UI 插槽及资源生命周期接入指南；创建或修改插件前必读。
---

# 多运行域插件入口

插件以 `plugin.json` 为唯一清单。所有可执行入口都必须通过 `entrypoints` 按运行域显式声明：

```json
{
  "id": "example",
  "entrypoints": {
    "bootstrap": "./bootstrap.js",
    "api": "./server.js",
    "electron": "./main.js",
    "agent": "./agent.js",
    "worker": "./worker.js",
    "web": "./web.js"
  }
}
```

各 JavaScript 入口分别导出 `register(ctx)`。API 入口沿用现有工具、命令、路由、频道和 Agent hook 注册能力。Electron 入口运行在主进程，`ctx.electron` 是完整 Electron 模块；`ctx.windows.getMain()`、`getPanels()`、`onCreated(listener)` 提供窗口访问与窗口创建通知。Electron 入口属于**完全受信任代码**，与宿主有相同的主进程权限；`permissions` 清单不构成沙箱。

所有入口都提供本运行域的 `ctx.extensions`：`register(point, value, { key?, priority? })`、`list(point)`、`first(point, key?)`。插件可自行命名扩展点并让同一运行域的其他插件消费；注册项自动归属插件生命周期。扩展点注册表是运行域内的，本身不跨进程；跨进程调用使用 RPC。现有 `ctx.registerTool` 等接口继续兼容。

`bootstrap` 在 Electron `app.ready` 前同步执行，适合设置 `app.commandLine` 等启动参数。它读取与 API 相同的禁用记录；已禁用插件不会运行。`register(ctx)` 必须同步返回，可返回清理函数；变更启动参数需要重启应用。
运行时插件只有完成构建、存在构建记录后才会被 Electron 加载。应用运行期间禁用插件会释放 bootstrap 注册的资源；已经应用的 Chromium 启动参数只能通过重启恢复。

`agent` 在 API 进程注册 Agent hooks，使用与 API 入口相同的插件生命周期；`worker` 在独立 Node worker 线程执行耗时逻辑。API 入口通过 `ctx.worker.call(method, args)` 调用 worker，worker 通过 `ctx.handle(method, fn)` 暴露方法，可用 `ctx.callApi(method, args)` 调用同一插件在 API 入口注册的 RPC 处理器。worker 是执行隔离，不是安全沙箱。
已有 AgentRuntime 会动态读取插件 hook，因此禁用和热重载会作用于现存运行时。API 退出时会给插件至多三秒释放资源。

`web` 在浏览器渲染进程执行 `register(ctx)`，上下文包含 `artificer`、`Vue`、`window`、`document`、`logger` 和 `disposeWithPlugin`。禁用、更新或移除插件时会调用返回的清理函数并释放登记的资源。内置插件的 Web 入口须位于 `web.js` 或 `web/` 目录，供 Vite 在构建时收集；运行时插件的 Web 入口会并入其编译产物。原有 `ui` 声明继续负责组件、路由、样式等纯数据扩展。

API 插件工具可以用 `security: { kind: 'safe'|'risky'|'file'|'command', targetArg?: '参数名' }` 声明执行风险。确认中间件按此元数据处理插件工具，不需要将其 ID 加进宿主风险表。未声明时保留原有内置风险表与敏感标签兜底。
这个字段控制 Agent 调用工具时的用户确认和目标围栏；它不限制已安装插件代码自身的 Node/Electron 权限。

同一插件的入口可以互相调用：

```js
// main.js
export function register(ctx) {
  ctx.rpc.handle('window-title', () => ctx.windows.getMain()?.getTitle())
}

// server.js
export function register(ctx) {
  ctx.registerTool({
    id: 'getWindowTitle',
    description: '读取应用窗口标题',
    handler: () => ctx.rpc.call('window-title')
  })
}
```

`ctx.rpc.handle()` 和 `ctx.windows.onCreated()` 返回取消函数，其资源也归当前插件实例所有。禁用或卸载时自动撤销。`ctx.disposeWithPlugin(fn)` 可登记插件自行创建的监听器、定时器等资源。主进程每五秒同步插件启用状态和入口文件变更；RPC 调用会即时核对 API 中的启用状态。

API 与 Electron 入口通过仅绑定 `127.0.0.1` 的本地 RPC 端点通信。启动时生成随机令牌，写入用户数据目录的 `plugin-rpc.json`；RPC 只接受携带该令牌的请求。令牌保护进程间通道，不限制已加载的受信任插件自身代码。

六个运行域都在同一 `entrypoints` 下声明。`ui` 继续承载声明式界面扩展；`hasBackend` 已移除，使用 `entrypoints.api` 声明 API 入口。worker 是线程，不隔离文件系统或网络权限；主进程与 API 入口也是完全受信任代码。
所有已构建的运行时插件都由同一插件管理器记录启用状态；UI 专用插件也可以同时声明 skills、settings 等能力。声明式技能、设置和安全扩展会在禁用时撤销。`permissions` 可使用插件自定义名称，作为安装展示信息；它不构成对受信任 JavaScript 的运行时限制。

## API 与 Agent 上下文补充

API/Agent 上下文支持 pluginId、pluginDir、logger、aiServiceManager、modelRequestService、modeRegistry；registerTool、registerCommand、registerRoute、registerWebSocket、registerChannel、processChannelInbound、registerProviderAdapter、registerArtifactHandler、registerUiCompiler、getStore、getSettings、importModule、host、worker、rpc、extensions、disposeWithPlugin、runtimePlugins。不能将这些 API 假定为其他运行域上下文也拥有。
- runtimePlugins.list/readSourceFile/writeSourceFiles/build/remove 用于开发维护外部插件。保持 id，修改后 build 热加载，remove 仅在用户明确要求删除时使用。
- importModule 只支持在 runtimeDependencies 声明的 ws、jszip、pptxgenjs、docx。
- 工具必须有 handler；security 可声明 safe/risky/file/command 与 targetArg。命令 handler(args, context) 可返回 { success: true, data: { renderType, ...payload } }，由 ui.commandResults 提供渲染器。
- registerRoute({ method, path, handler }) 的 handler 接收含 query/body 的请求上下文；registerWebSocket 声明 WebSocket 路由。优先在 /api/plugins/<id>/ 命名空间组织业务路由。
- 频道用普通 ProviderClass 注册，通过 processChannelInbound 交给宿主会话管线；static getMetadata() 返回 { label, icon?, color? }。
- getStore() 是当前插件的 get/set/delete/list/clear 持久化 KV；getSettings() 读取宿主保存的声明设置。不要自行读写宿主配置或泄漏密钥。
- API 模块支持 onEnable/onDisable/onReload/onDestroy(ctx)。定时器、监听器和连接用 disposeWithPlugin 登记清理，不要假设所有运行域都有完全相同的生命周期钩子。
- host.on(point, fn, { priority?, type? }) 支持 beforeRun/runOutcome/afterRun/beforeAiCall/afterAiCall/buildMessages/buildTools/toolCall/aiCall/decideFinish/dispatchEvent/rollbackCheckpoint/tryRecover/onClear。第三方优先级用 101–200 或负数；0–100 为内部模块预留。

## 声明式能力

plugin.json 可声明 skills: [{ file: "skills/guide.md" }]（Markdown frontmatter 提供 id/name/description/tags）或 [{ id, content, name?, description?, tags? }]；scenario 可为对象或数组，包含 id/name/systemPrompt 或 promptFile，以及 access.tools/access.skills；场景仅能访问授权的工具和知识库。设置用 settings: { title, fields: [{ key, label, type, defaultValue?, options? }] }，类型 text/password/number/boolean/select。

artifacts: [{ id, name, icon?, openIn: "panel"|"view"|"window", route?, panelId?, priority?, match: ["*.html"] }]；也可 registerArtifactHandler，match 支持函数。优先级越小越优先，默认 50；view 需 /plugin/ 路由。不要通过硬编码插件 id 抢占默认打开方式。dependencies 是插件 id 数组；engines.artificer 声明最低宿主版本；security 可声明 blacklist/protectedPaths。

工坊源码写入允许 plugin.json、.vue、.css、.js、.mjs、.md；入口必须是存在的 .js 文件；单批最多 32 文件、1MB，单文件最多 256KB。纯声明插件如需通过当前运行时构建流程安装，可增加导出空 register(ctx) 的 API 入口，不要伪造 UI。

## 全部 UI 接入点

Artificer 1.1.6 起，后端可用稳定异步宿主服务：`ctx.sessions.exists(id)`、`create(options)`、`delete(id)`、`chat(request)`；`ctx.workspaces.list()`、`create(options)`；`ctx.usage.read(year)`。会话与工作区创建接受对应宿主服务参数，chat 显式传递 approvalMode，用量接口只提供只读聚合结果。使用这些接口时将 engines.artificer 设为 >=1.1.6。定时任务 scheduler 和统计 statistics 已迁入外部插件仓库，保持原插件 ID，不要复制宿主内部模块。

ui 的组件路径必须指向插件内存在的 .vue 文件，不支持目录约定回退。
- view：完整页面 /plugin/<id>。
- panels: [{ id, region: "left"|"right"|"bottom", component, title?, icon?, default?, width?, showOnRoutes? }]；面板身份为 pluginId/panelId，activatePanel 使用完整 panelKey。floatingPanels 也可声明浮动面板（内部归并为面板）。
- toolbar props { isDark, online }；inputActions props { disabled, sessionId, insertText, setText, addReference, composeDraft }；inputFooter 提供输入框底部内容；statusBar props { isOnline }。
- contextMenu props { x, y, close, context }；msgActions props { msg, sessionId, toolDisplayName }；sessionActions props { session, active }。
- toolRenderers: { toolId: path }，props { msg, toolDisplayName }。
- commandResults: { renderType: path }，props { data, renderType }。
- messageRenderers: { role: path }，props { msg, sessionId, toolDisplayName }；WorkRound 内部消息不经过该分支。
- roundRenderers: { roundType: path }，类型 default/plan，props { workMessages, startTime, roundElapsed, isComplete, roundStatus, artifactStats, sessionId, toolDisplayName }；emit copy/regenerate/approvePlan/rejectPlan。roundStatus 包括 checking/starting/reconnecting/streaming/waiting_confirmation/waiting_question/waiting_plan/finalizing/completed/failed/cancelled/interrupted。
- components: { hostComponentName: path } 整体替换注册的宿主组件，props/events 透传；替换 ChatInput/ChatMessages 需用 defineExpose 暴露调用方需要的方法。
- navItems: [{ id, label, icon?, route }]；routes: [{ path, name, component }]（path 必须 /plugin/ 开头）。
- `ui.view` 只声明页面，不会自动加入扩展菜单。要展示入口必须显式声明 `ui.navItems`，默认页面地址为 `/plugin/<pluginId>`；无菜单入口时仍可从插件详情打开。按用户需要配置入口，不要给所有辅助页面和面板机械添加菜单。
- 顶层 `icon` 和 `ui.navItems[].icon` 兼容 Lucide 名称，也支持 `{ "file": "assets/icon.svg" }`。资源相对插件目录，仅支持 SVG / PNG / WebP，单文件最多 1MB；宿主校验文件并生成资源地址，加载失败回退默认图标。禁止绝对路径、外部 URL、越界路径和手填 `src`；面板、toolMeta、频道等其他位置仍用图标名。资源须事先存在，当前工坊源码写入工具不支持图片资源，不得声明不存在的文件或通过文本写入二进制图片；缺少资源时使用内置图标。
- shortcuts: [{ id, keys, label }]，触发 artificer:shortcut:<id>；toolMeta: { toolId: { icon?, summary?, summaryExtra? } }，模板支持 {{args.x}}/{{result.x}}。
- styles: ["styles/main.css"] 注入全局样式；theme: { light?: { cssVars?, overrides? }, dark?: { cssVars?, overrides? } }，cssVars 键以 -- 开头，overrides 是 naive-ui themeOverrides。组件覆盖首个插件胜出；主题深合并后者胜出。ui.compiler 可指定编译器 id。

## UI 与宿主通信

Vue 组件 inject('artificer') 或 window.artificer；Web 入口 ctx.artificer 是同一对象：openSession(sessionId)、activatePanel(region, panelKey)、toast(content, type)、openModal({ title, component, props, width })、closeModal()。无需自己重复实现弹窗和面板激活。

inputActions 可用 composeDraft({ references: [{ label, content }], text, send }) 或 addReference({ label, content })。独立窗口使用 BroadcastChannel('artificer-plugin-compose')，发送 { type: 'compose-plugin-draft', id, sessionId, references, text, send }，等待对应 id 的 compose-plugin-draft-result。label 上限 120 字，content 上限 12000 字，最多 20 条引用。其他已公开事件包括 artificer:new-session、artificer:context-menu、artificer:shortcut:<id>。卸载、启停、更新会经 /api/plugins/events 推送 plugins-changed 并同步前端。

界面使用主题变量适配明暗；顶部工作区采用 --workspace-header-height、--workspace-header-control-size、--workspace-tab-indicator-width、--workspace-tab-font-size；标签直角、中性色下划线，保留编辑器已有交互。不要在插件里硬编码局部栏高或破坏宿主布局。

UI 编译器可用 registerUiCompiler({ id, build }) 注册；build 接收宿主的构建上下文并必须在 outDir 生成 index.js，禁用插件时自动撤销注册。调用宿主模型优先通过 modelRequestService，按所用方法的实际接口传参，不猜测未公开方法或导入宿主源码。
