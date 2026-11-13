---
id: plugin-builder-integration
name: 插件工坊接入与操作手册
description: 插件工坊操作手册与 Artificer 插件底座契约：五个工坊工具的入参/返回/调用顺序、写入硬约束、构建验收清单、完整最小示例、失败排查、交付后使用方式，以及六运行域、声明式能力、菜单入口、图标资源、UI 插槽与资源生命周期。创建或修改任何插件前必读。
---

# 插件工坊操作手册

工坊只向你提供下面五个工具。没有 `executeCommand`、`readFile`、`writeFile`，不要尝试用其他方式访问插件目录；插件源码只能通过本手册的工具读写。用户说“做个插件”“改一下那个插件”时，按本手册执行。

## 一、工具速查

| 工具 | 用途 | 入参 | 成功返回 | 失败返回 |
|---|---|---|---|---|
| `listRuntimeUiPlugins` | 列出已安装外部插件与未构建完成的源码目录 | 无（`{}`） | `{ success, plugins: [{ id, name, built, sourceDir }] }` | `{ success: false, error }` |
| `readRuntimeUiPluginFile` | 读取单个源码文件 | `pluginId`、`filePath`（相对插件目录） | `{ success, sourceDir, filePath, content }` | `{ success: false, error }` |
| `writeRuntimeUiPluginFiles` | 批量写入源码文件 | `pluginId`、`files: [{ path, content }]` | `{ success, sourceDir, files: ["..."], bytesWritten, message }` | `{ success: false, error }` |
| `buildRuntimeUiPlugin` | 编译并加载插件（写入不会自动生效） | `pluginId` | `{ success, plugin, sourceDir, message }` | `{ success: false, error }` |
| `removeRuntimeUiPlugin` | 卸载并删除源码、产物和设置 | `pluginId` | `{ success, id, sourceDir }` | `{ success: false, error }` |

`listRuntimeUiPlugins` 的 `built: false` 表示源码目录存在但尚未构建成功，这类插件同样可以继续修改，不要因为看到它就新建一个带版本后缀的副本。

## 二、标准工作流

### 新建插件

1. `listRuntimeUiPlugins` 查重，确认 id 未被占用（也要避开内置插件 id）。
2. `askUser` 确认方案：插件 id、用户入口（页面/面板/命令/工具）、数据来源、需要注册的能力、将新增的文件。用户已明确说“直接做”时可省略这一步。
3. `writeRuntimeUiPluginFiles` 一次写完 `plugin.json` 与全部入口文件、组件、样式。首批就要完整，不要先写一个残缺清单再补。
4. `buildRuntimeUiPlugin` 构建。
5. 按第五节的验收清单检查返回的 `plugin` DTO，然后告诉用户在哪里启用、入口在哪里。

### 修改插件

1. `listRuntimeUiPlugins` 定位目标 id；有多个候选且用户指向不明时用 `askUser` 确认。
2. `readRuntimeUiPluginFile` 读 `plugin.json`，再读与需求相关的 `web.js`、`.vue`、`server.js`。不要凭记忆改。
3. `writeRuntimeUiPluginFiles` 只写发生变化的文件：写入是**覆盖所列文件**，未列出的旧文件保留；被省略的文件不会删除，需要删文件只能整插件 `removeRuntimeUiPlugin` 后重建。
4. `buildRuntimeUiPlugin` 重新构建，写入后不构建等于没改。

### 删除插件

仅在用户明确要求删除时调用 `removeRuntimeUiPlugin`。它不可恢复，会同时删除源码、构建产物和插件设置；不能删除内置插件。修改插件不需要先卸载。

## 三、写入硬约束（在写入阶段就会报错）

- `pluginId` 必须匹配 `^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$`，同时是目录名和 `plugin.json.id`。
- 只允许 `plugin.json`、`.vue`、`.css`、`.js`、`.mjs`、`.md`。禁止 `package.json`、`node_modules`、图片等二进制文件。
- `path` 必须是相对路径：不能以 `/` 或盘符开头，不能出现 `..`、`.` 或空段，不能用反斜杠拼接。不要写绝对路径。
- 单批最多 32 个文件，单文件不超过 256KB，单批总量不超过 1MB。超出时拆成多批写入。
- `plugin.json` 必须是有效 JSON，且 `id` 与 `pluginId` 完全一致；必须有 `ui` 对象或 `entrypoints`；二者都没有会直接拒绝。
- `ui` 的键只能是 `styles`、`navItems`、`routes`、`toolMeta`、`shortcuts`、`theme`。出现 `type`、`entry`、`panel` 等旧键直接拒绝。
- `ui.navItems[].route` 与 `ui.routes[].path` 必须以 `/plugin/` 开头，且不能正好是 `/plugin/`；`navItems` 每项为 `{ id, label, icon?, route }`。
- `ui.styles` 里列出的每个 CSS 文件必须真实存在，且扩展名是 `.css`。
- `settings` 必须是 `{ title?, fields: [...] }`；`fields` 是数组，每项含 `key`、`label`、可选 `type`（`text`/`password`/`number`/`boolean`/`select`，`select` 必须带 `options`）。不能写 `hasSettings`。
- `entrypoints` 里声明的入口文件必须真实存在，且是 `.js`；API 入口使用 `"entrypoints": { "api": "server.js" }`，禁止 `hasBackend`。
- 图标只能用 Lucide 名称，或引用**已写入**的 SVG：`{ "file": "assets/icon.svg" }`。写入工具只能写文本，因此 SVG 必须以文本 `.svg` 内容写入，且路径真实存在。

## 四、构建返回怎么读

`buildRuntimeUiPlugin` 成功时返回：

```
{ success: true, sourceDir, message, plugin: { ... } }
```

`plugin` 是清单与运行时注册表合并后的 DTO，关键字段：

- `plugin.id` / `plugin.name` / `plugin.version`：来自清单，`version` 缺省为 `0.0.0`。
- `plugin.ui.runtime.entry`：UI 产物入口。**界面插件必须非空**；纯后端插件为 `null` 属正常。
- `plugin.ui.runtime.buildId`、`plugin.ui.runtime.styles`：本次构建标识与产物样式地址。
- `plugin.entrypoints`：清单声明的运行域入口。
- `plugin.capabilities`：本插件实际注册成功的 tools / skills / commands / adapters。
- `plugin.settingsSchema`：清单 `settings` 的原始结构。
- `plugin.runtime`：运行时插件恒为 `true`。

失败时返回 `{ success: false, error }`，`error` 是中文原因，直接按第六节定位，不要跳过。

## 五、验收清单

构建成功后逐项确认，再向用户汇报：

- [ ] 界面插件：`plugin.ui.runtime.entry` 非空，且 `entrypoints.web` 指向已写入的文件。
- [ ] 纯后端插件：`entrypoints.api` 存在，`ui.runtime.entry` 为 `null` 可接受，不要为了非空伪造 UI。
- [ ] 你注册的每个 tool / command 都出现在 `plugin.capabilities` 里；缺失说明 `server.js` 的 `register(ctx)` 没执行、id 重复被拒，或清单 `entrypoints` 没声明。
- [ ] 清单声明了 `ui.navItems` 的，用户才能在侧边栏看到入口；只注册页面不会自动生成菜单。
- [ ] `ui.navItems[].route` 与 `ctx.ui.registerRoute` 的 `path` 一致。
- [ ] 配置了 `settings.fields` 的，面板能读到对应键。

## 六、常见失败与处理

| 报错或现象 | 原因 | 正确处理 |
|---|---|---|
| `UI 编译器未安装或未启用: vue-vite` | 宿主缺少 UI 编译器插件 | 告知用户安装/启用 `ui-compiler-vue`；不要改成纯后端来掩盖，也不要手工伪造 `index.js` |
| `plugin.json 的 id 必须为: xxx` | 清单 id 与 `pluginId` 不一致 | 统一成目标 id，沿用已有插件 id，不要加版本后缀 |
| `插件源码仅允许 ... 且路径不能越界` | 扩展名不支持或路径含 `..`/绝对路径 | 改成相对路径与允许的扩展名 |
| `插件源码文件不存在: xxx` | `readRuntimeUiPluginFile` 路径写错 | 先用 `listRuntimeUiPlugins` 拿 `sourceDir`，再按相对路径读 `plugin.json` |
| `一次最多写入 32 个插件源码文件` / `文件过大` / `总大小不能超过 1MB` | 单批超限 | 拆批写入 |
| `plugin.json 必须声明 ui 对象或 entrypoints` | 清单没有任何入口 | 补 `entrypoints` 或 `ui` |
| `plugin.json 的 ui.xxx 已不受支持` | 用了旧组件字段 | 改为 `entrypoints.web` + `ctx.ui` 注册组件 |
| `插件 id 已被内置插件占用` | 与内置插件重名 | 换 id，并告知用户 |
| `运行时插件不存在: xxx` | `remove` 的目标没有源码目录 | 先 `list` 确认 |
| `不能删除内置插件: xxx` | 目标是内置插件 | 停止，告知用户只能禁用 |
| 构建成功但 `ui.runtime.entry` 为 `null` | 没声明 `entrypoints.web` | 界面插件补 Web 入口后重建 |

## 七、完整最小示例（UI 页面 + 自定义工具）

`listRuntimeUiPlugins` → `writeRuntimeUiPluginFiles` → `buildRuntimeUiPlugin`，四个文件一次写完。

`plugin.json`：

```json
{
  "id": "demo-greeter",
  "name": "示例问候",
  "version": "0.1.0",
  "description": "演示页面、面板与自定义工具的最小插件",
  "entrypoints": { "web": "web.js", "api": "server.js" },
  "engines": { "artificer": ">=1.1.22" },
  "ui": {
    "navItems": [{ "id": "demo-greeter.page", "label": "示例问候", "icon": "sparkles", "route": "/plugin/demo-greeter" }]
  }
}
```

`web.js`：

```js
import Page from './page.vue'

export function register(ctx) {
  if (ctx.ui.getService('ui.router@1')) {
    ctx.ui.registerRoute({ id: 'demo-greeter.route', name: 'plugin-demo-greeter', path: '/plugin/demo-greeter', component: Page })
  }
}
```

`page.vue`：

```vue
<template>
  <div class="demo-greeter">
    <h2>示例问候</h2>
    <input v-model="name" placeholder="输入名字" />
    <button @click="greet">问候</button>
    <p v-if="message">{{ message }}</p>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const name = ref('')
const message = ref('')

function greet() {
  message.value = `你好，${name.value || '陌生人'}`
}
</script>

<style scoped>
.demo-greeter { display: flex; flex-direction: column; gap: 8px; padding: 16px; color: var(--text-color); }
</style>
```

`server.js`：

```js
export function register(ctx) {
  ctx.registerTool({
    id: 'demoGreet',
    description: '按名字生成问候语',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: '用户名字' } },
      required: ['name']
    },
    handler: ({ name }) => ({ success: true, message: `你好，${name}` })
  })
}
```

构建后应看到 `plugin.ui.runtime.entry` 非空，`plugin.capabilities.tools` 包含 `demoGreet`。

## 八、交付后用户怎么用

- 启用/禁用：用户进入“设置 → 插件”，找到对应插件切换开关；禁用会撤销它注册的页面、菜单、工具和资源。
- 页面入口：只有清单 `ui.navItems` 声明过的条目才会出现在左侧导航；路由为 `/plugin/<id>`。
- 面板入口：`ctx.ui.registerPanel` 注册的面板出现在对应 dock（`left`/`right`/`bottom`/`floating`），标识为 `pluginId/panelId`。
- 命令：`server.js` 用 `ctx.registerCommand` 注册的命令以 `/命令名` 出现在命令面板。
- 工具：注册的工具在允许其 id 的场景下对模型可见；场景 `access.tools` 未授权时不会出现。
- 生效时机：只有 `buildRuntimeUiPlugin` 成功后才生效；单纯写入文件不影响正在运行的插件。

---

以下为实现插件时必须遵循的宿主底座契约。

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
