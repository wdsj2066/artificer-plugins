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

`web` 在浏览器渲染进程执行 `register(ctx)`，上下文包含 `artificer`、`Vue`、`window`、`document`、`logger` 和 `disposeWithPlugin`。禁用、更新或移除插件时会调用返回的清理函数并释放登记的资源。内置插件的 Web 入口须位于 `web.js` 或 `web/` 目录，供 Vite 在构建时收集；运行时插件的 Web 入口会并入其编译产物。`ui` 只声明样式、菜单、路由元数据、工具元数据、快捷键和主题；组件必须在 Web 入口通过 `ctx.ui` 注册。

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
- 工具必须有 handler；security 可声明 safe/risky/file/command 与 targetArg。命令 handler(args, context) 可返回 { success: true, data: { renderType, ...payload } }，通过 chat.input.command-palette.result.fallback 的条件替换规则提供渲染器。
- registerRoute({ method, path, handler }) 的 handler 接收含 query/body 的请求上下文；registerWebSocket 声明 WebSocket 路由。优先在 /api/plugins/<id>/ 命名空间组织业务路由。
- 频道用普通 ProviderClass 注册，通过 processChannelInbound 交给宿主会话管线；static getMetadata() 返回 { label, icon?, color? }。
- getStore() 是当前插件的 get/set/delete/list/clear 持久化 KV；getSettings() 读取宿主保存的声明设置。不要自行读写宿主配置或泄漏密钥。
- API 模块支持 onEnable/onDisable/onReload/onDestroy(ctx)。定时器、监听器和连接用 disposeWithPlugin 登记清理，不要假设所有运行域都有完全相同的生命周期钩子。
- host.on(point, fn, { priority?, type? }) 支持 beforeRun/runOutcome/afterRun/beforeAiCall/afterAiCall/buildMessages/buildTools/toolCall/aiCall/decideFinish/dispatchEvent/rollbackCheckpoint/tryRecover/onClear。第三方优先级用 101–200 或负数；0–100 为内部模块预留。

## 声明式能力

plugin.json 可声明 skills: [{ file: "skills/guide.md" }]（Markdown frontmatter 提供 id/name/description/tags）或 [{ id, content, name?, description?, tags? }]；scenario 可为对象或数组，包含 id/name/systemPrompt 或 promptFile，以及 access.tools/access.skills；场景仅能访问授权的工具和知识库。设置用 settings: { title, fields: [{ key, label, type, defaultValue?, options? }] }，类型 text/password/number/boolean/select。

artifacts: [{ id, name, icon?, openIn: "panel"|"view"|"window", route?, panelId?, priority?, match: ["*.html"] }]；也可 registerArtifactHandler，match 支持函数。优先级越小越优先，默认 50；view 需 /plugin/ 路由。不要通过硬编码插件 id 抢占默认打开方式。dependencies 是插件 id 数组；engines.artificer 声明最低宿主版本；security 可声明 blacklist/protectedPaths。

工坊源码写入允许 plugin.json、.vue、.css、.js、.mjs、.md；入口必须是存在的 .js 文件；单批最多 32 文件、1MB，单文件最多 256KB。纯声明插件如需通过当前运行时构建流程安装，可增加导出空 register(ctx) 的 API 入口，不要伪造 UI。

## 组件优先的 UI 契约（Artificer >=1.1.22）

界面插件必须声明 `entrypoints.web: "web.js"`。Web 入口导入 Vue 组件对象并导出 `register(ctx)`，所有 `ctx.ui` 注册随插件禁用、卸载和热重载自动撤销。不得在清单中声明组件路径。

```js
import Page from './view.vue'
import Panel from './panel.vue'

export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) {
    ctx.ui.registerRoute({ id: 'example.route', name: 'plugin-example', path: '/plugin/example', component: Page })
  }
  ctx.ui.registerPanel({ id: 'main', region: 'right', title: '示例', icon: 'puzzle', component: Panel })
}
```

独立面板窗口没有路由服务，所以页面注册须检查 `ui.router@1`；面板注册不要放进这个判断内。面板身份是全局唯一的 `pluginId/panelId`，调用 activatePanel 时使用完整 panelKey。registerPanel 支持 region=left/right/bottom/floating、order、width、default、showOnRoutes。

组件树用 `ctx.ui.registerTree(tree, { priority, detached })` 注册。节点类型是 component/fragment/route/route-switch，component 必须是导入的 Vue 组件对象，不能写字符串或路径。`ctx.ui.registerRule({ op, target, node, props, index, when })` 支持 replace/insert/props/remove 等规则；插入和替换的 node 必须是组件节点。

稳定节点：
- `chat.input.footer`：插入组件，scope 包含 tokenCount/promptTokens/completionTokens/cachedTokens/lastPromptTokens/contextWindow。
- `chat.messages.actions`：插入消息动作，scope 包含 msg/sessionId。
- `chat.messages.tool.result`：按 scope.msg.name 条件替换工具结果，props 从 scope 传入 msg/sessionId/toolDisplayName。保留宿主 ToolRenderer 折叠行。
- `chat.messages.tool`：按条件替换完整工具消息，props 为 msg/sessionId/toolDisplayName/hideCompletedStatus。
- `chat.messages.round`：替换工作回合，传入 workMessages/startTime/roundElapsed/isComplete/roundStatus/roundType/artifactStats/sessionId/toolDisplayName 与 onCopy/onRegenerate/onFork/onApprovePlan/onRejectPlan。
- `chat.input.command-palette.result.fallback`：按 scope.renderType 条件替换命令结果，scope 含 data/renderType/activeIndex/onSelect/onHover。
- `app.root`、`app.titlebar`、`app.sidebar`、`app.left-dock`、`app.view`、`app.bottom-dock`、`app.right-dock`、`app.overlays` 是外壳节点。`app.controllers` 用于插入无视觉的生命周期控制器。

规则示例：
```js
ctx.ui.registerRule({
  op: 'replace', target: 'chat.messages.tool.result',
  when: (_services, scope) => scope.msg?.name === 'exampleTool',
  node: {
    id: 'example.tool-result', type: 'component', component: Result,
    props: (_services, scope) => ({ msg: scope.msg, sessionId: scope.sessionId, toolDisplayName: scope.toolDisplayName })
  }
})
```

清单 ui 仅允许 styles/navItems/routes/toolMeta/shortcuts/theme。routes 只携带 `{path,name}` 元数据，不包含 component；真实组件与路由由 registerRoute 注册，路径必须以 /plugin/ 开头。菜单通过 ui.navItems 显式声明，不会因注册页面而自动出现。
禁止旧组件字段：view、panels、floatingPanels、toolbar、inputActions、inputFooter、statusBar、contextMenu、msgActions、sessionActions、toolRenderers、commandResults、messageRenderers、roundRenderers、components；禁止 ui.type/ui.entry/ui.panel、hasBackend、panelDefault/panelWidth。

`ctx.ui.registerService(name, service, contract)` 发布共享状态，服务名格式为 domain@major；contract 可声明 fields/methods。职责分别由 ui.shell@1、ui.sessionNavigation@1、ui.sidebarLayout@1 和 ui.panelLayout@1 提供，禁止恢复已移除的 ui.shellState@1 大对象。不要导入其他插件内部组件。

顶层 icon 和 ui.navItems[].icon 支持 Lucide 名称或已存在的资源 `{file:"assets/icon.svg"}`；不要声明不存在的资源。styles 是插件内 CSS 路径数组；theme 为 light/dark 的 cssVars/overrides；shortcuts 为 id/keys/label；toolMeta 为工具 ID 到 icon/summary/summaryExtra 的映射。这些均为纯数据。

## UI 与宿主通信

Vue 组件 inject('artificer') 或 window.artificer；Web 入口 ctx.artificer 是同一对象：openSession(sessionId)、activatePanel(region, panelKey)、toast(content, type)、openModal({ title, component, props, width })、closeModal()。无需自己重复实现弹窗和面板激活。

聊天输入提供 composeDraft({ references: [{ label, content }], text, send }) 或 addReference({ label, content })。独立窗口使用 BroadcastChannel('artificer-plugin-compose')，发送 { type: 'compose-plugin-draft', id, sessionId, references, text, send }，等待对应 id 的 compose-plugin-draft-result。label 上限 120 字，content 上限 12000 字，最多 20 条引用。其他已公开事件包括 artificer:new-session、artificer:context-menu、artificer:shortcut:<id>。卸载、启停、更新会经 /api/plugins/events 推送 plugins-changed 并同步前端。

界面使用主题变量适配明暗；顶部工作区采用 --workspace-header-height、--workspace-header-control-size、--workspace-tab-indicator-width、--workspace-tab-font-size；标签直角、中性色下划线，保留编辑器已有交互。不要在插件里硬编码局部栏高或破坏宿主布局。

UI 编译器可用 registerUiCompiler({ id, build }) 注册；build 接收宿主的构建上下文并必须在 outDir 生成 index.js，禁用插件时自动撤销注册。调用宿主模型优先通过 modelRequestService，按所用方法的实际接口传参，不猜测未公开方法或导入宿主源码。
