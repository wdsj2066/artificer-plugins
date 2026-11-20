---
id: plugin-builder-integration
name: 插件底座接入契约
description: Artificer 六运行域、组件优先 UI、版本化服务、声明式清单和资源生命周期接入指南；创建或修改插件前必读。
---

# 插件清单与运行域

插件以 `plugin.json` 为唯一清单。可执行入口通过 `entrypoints` 声明：

```json
{
  "id": "example",
  "entrypoints": {
    "bootstrap": "bootstrap.js",
    "electron": "main.js",
    "api": "server.js",
    "agent": "agent.js",
    "worker": "worker.js",
    "web": "web.js"
  }
}
```

`server.js`、`agent.js`、`main.js` 和 `web.js` 都导出 `register(ctx)`。API 入口可注册工具、命令、HTTP、WebSocket、频道、AI 适配器和 Agent hooks；Electron 入口拥有主进程权限；worker 是线程隔离，不是安全沙箱；Web 入口只负责 UI 树、版本化服务、路由与资源撤销。

编译器也可以从 Web 入口导出命名函数 `registerWeb(ctx)`；宿主会把 `registerWeb` 和默认导出的 `register` 统一接入同一个插件作用域。

`permissions` 是安装时展示的真实能力说明，不是运行时沙箱。对文件、网络、子进程、密钥、远程服务或宿主数据的访问必须在设计中明确说明。

## 声明式能力

- `skills: [{ file: "skills/guide.md" }]`：Markdown Context，frontmatter 提供 id、名称和描述。
- `scenario`：系统提示词与 tool/skill 访问范围。
- `settings: { title?, fields }`：`text`、`password`、`number`、`boolean`、`select`。
- `artifacts`：产物打开动作，按 priority 与插件 panelOrder 排序。
- `runtimeDependencies`：配合 `ctx.importModule(name)` 使用宿主审计过的包。
- `engines.artificer`：声明最低宿主版本。

后端 API：

- `ctx.registerTool({ id, name?, description?, parameters?, handler, security? })`
- `ctx.registerCommand({ name, description?, usage?, parameters?, handler })`
- `ctx.registerRoute({ method, path, handler })`
- `ctx.registerWebSocket(route)`
- `ctx.registerChannel(type, ProviderClass)`
- `ctx.processChannelInbound(channelId, inbound, options)`
- `ctx.registerProviderAdapter({ name, label?, factory })`
- `ctx.registerArtifactHandler(config)`
- `ctx.registerUiCompiler({ id, async build({ sourceDir, entryPath, outDir }) { ... } })`
- `ctx.modelRequestService`：统一模型请求入口，负责模型路由、诊断和调用
- `ctx.getStore()` / `ctx.getSettings()`
- `ctx.host.on(point, handler, { priority?, type? })`
- `ctx.disposeWithPlugin(fn)`
- `ctx.runtimePlugins`：通过 `readSourceFile()`、`writeSourceFiles()`、`build()`、`list()` 和 `remove()` 管理用户运行时插件
- `ctx.worker` / `ctx.rpc` / `ctx.extensions`

第三方 hook 优先级使用 101–200 或负数；0–100 归内部模块。插件 API 路由使用 `/api/plugins/<pluginId>/` 命名空间。

## 组件优先 UI

`plugin.json.ui` 只保存 `routes`、`navItems`、`shortcuts`、`toolMeta`、`styles` 和 `theme` 等纯数据。`ui.routes` 的路径以 `/plugin/` 开头。禁止在清单中声明页面、面板、插槽或渲染器的组件路径。

插件 Web 入口导入自己的 Vue 组件，并通过组件对象注册页面和面板：

```js
import Page from './Page.vue'
import Panel from './Panel.vue'

export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) {
    ctx.ui.registerRoute({ id: 'example.page', name: 'example', path: '/plugin/example', component: Page })
  }
  ctx.ui.registerPanel({ id: 'main', region: 'right', title: '示例', component: Panel })
}
```

`ctx.ui.registerTree` 装配组件树，业务节点使用 `type: 'component'` 和已导入的组件对象；`fragment`、`route`、`route-switch` 用于结构与路由。禁止 `element`、`text`、`controller` 节点及字符串组件路径。组件内部使用 Vue 模板、状态与生命周期。

使用 `ctx.ui.registerRule` 对稳定节点进行插入或替换，组件节点的 `props(services, scope)` 和规则的 `when(services, scope)` 可以读取实例作用域。注册由插件 owner 管理，停用、热更新或卸载时自动撤销。共享服务通过 `ctx.ui.registerService('example.state@1', service)` 注册，通过 `ctx.ui.getService(name)` 获取。

Web 组件可使用 `ctx.artificer` 提供的公开操作或调用 `/api/plugins/<id>/...`；不要在 URL、日志或不必要的客户端状态中放置密钥。运行时源码工具支持 `.vue`、`.js`、`.mjs`、`.css`、`.md` 与 `plugin.json`。
## 样式与图标

样式使用 `.css` 并通过 Web 入口 `import './ui.css'`，也可以由 `ui.styles` 声明。优先使用宿主主题变量和共享尺寸变量；顶部工作区必须使用：

- `--workspace-header-height`
- `--workspace-header-control-size`
- `--workspace-tab-indicator-width`
- `--workspace-tab-font-size`

不要在插件中另写局部顶部栏高度。标签保持直角、中性色选中下划线，并适配明暗主题。

顶层 `icon` 和 `ui.navItems[].icon` 支持内置 Lucide kebab-case 名称，或已存在的 SVG/PNG/WebP 资源。运行时源码写入工具不能写二进制资源；缺少资源时使用内置图标。

## 生命周期与边界

Web 入口注册的树、规则、路由、事件、订阅、定时器和服务都绑定插件 owner。停用、热更新和卸载时，宿主先撤销树贡献，再释放其他资源。

不导入 Artificer 的 `agent/`、`providers/`、`storage/`、`core/` 等源码。使用 `ctx` API、公开服务名和插件自己的 API 路由。所有插件入口都是受信任代码，权限声明只是安装审查信息。

