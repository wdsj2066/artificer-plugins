# Artificer Official Plugins

This repository contains the source code for official Artificer plugins.

A single repository can maintain multiple plugins, but each plugin is published, installed, updated, and uninstalled independently. The repository currently includes:

- `browser-automation`
- `channel-feishu`
- `channel-wecom`
- `token-usage`
- `office`
- `plugin-builder`
- `recipes`
- `terminal`
- `remote`
- `ui-compiler-vue`
- `scheduler`
- `statistics`
- `session-search`
- `context-inspector`
- `trace-viewer`

Backend plugins must be manually reviewed to confirm that their declared `permissions` match their actual capabilities before installation or release.

## Release

Each plugin must be packaged into an independent ZIP file and uploaded to a GitHub Release. Do not package all plugins into a single installable ZIP.

```powershell
.\scripts\package-plugin.ps1 -PluginId browser-automation
.\scripts\package-plugin.ps1 -PluginId channel-feishu
.\scripts\package-plugin.ps1 -PluginId channel-wecom
.\scripts\package-plugin.ps1 -PluginId token-usage
.\scripts\package-plugin.ps1 -PluginId office
.\scripts\package-plugin.ps1 -PluginId plugin-builder
.\scripts\package-plugin.ps1 -PluginId recipes
.\scripts\package-plugin.ps1 -PluginId terminal
.\scripts\package-plugin.ps1 -PluginId remote
.\scripts\package-plugin.ps1 -PluginId ui-compiler-vue
.\scripts\package-plugin.ps1 -PluginId scheduler
.\scripts\package-plugin.ps1 -PluginId statistics
.\scripts\package-plugin.ps1 -PluginId session-search
.\scripts\package-plugin.ps1 -PluginId context-inspector
.\scripts\package-plugin.ps1 -PluginId trace-viewer
```

The package script creates `dist/<PluginId>-<version>.zip`. Each archive has exactly one top-level directory named after its plugin ID and prints its SHA-256 hash.

Pushes to `main` that touch `plugins/**` or `scripts/**` trigger the `Release Plugins` workflow: it packages only plugins with changes since their per-plugin release tag (`<pluginId>-v<version>`), publishes the ZIP to GitHub Releases with its SHA-256 in the release notes, and regenerates `registry.json` automatically.

The Vue compiler is published as separate Windows, Linux, and macOS archives for x64 and arm64 because Vite depends on platform-specific native binaries. The marketplace selects the matching archive using the host's reported platform. Ordinary UI plugins publish prebuilt browser assets and do not require this compiler at installation time.

## Plugin SDK

Plugins must not import Artificer source files by relative path. The host injects a stable `ctx` API at registration time. Use `ctx.getStore()` for plugin-owned state, `ctx.processChannelInbound()` for channel events, and `ctx.importModule(name)` only for audited host packages declared in `plugin.json.runtimeDependencies`. A plugin with dedicated dependencies should declare them in its own `package.json`; `scripts/package-plugin.ps1` installs those dependencies into the published plugin ZIP from its `package-lock.json`. Published Vue UI is prebuilt into `.artificer-dist`, so installing a marketplace plugin needs no compiler. The optional `ui-compiler-vue` backend plugin registers through `ctx.registerUiCompiler({ id, build })` for local source development and rebuilding. Development plugins use `ctx.runtimePlugins.readSourceFile()`, `writeSourceFiles()`, and `build()` to manage user-created runtime plugins.

## Marketplace

Marketplace registry: https://raw.githubusercontent.com/wdsj2066/artificer-plugins/main/registry.json

`registry.json` is generated automatically by the `Release Plugins` workflow (`.github/workflows/release-plugins.yml`) after each release is published. Each entry carries the plugin metadata from `plugin.json`, the release ZIP download URL and the ZIP SHA-256. Releases are tagged per plugin as `<pluginId>-v<version>`.

## 当前宿主兼容规范

本批插件要求 Artificer >=1.1.22，所有可执行入口按 bootstrap/electron/api/agent/worker/web 显式声明。每个插件独立发布，保持现有插件 ID，升级补丁版本。

界面由 `entrypoints.web` 的 `register(ctx)` 注册：页面用 `ctx.ui.registerRoute`，面板用 `ctx.ui.registerPanel`，工具结果和消息动作通过稳定节点规则注册。清单的 ui 只保存 navItems/styles/routes/toolMeta/shortcuts/theme 等纯数据，不再支持 view/panels/toolRenderers 等组件路径。独立面板窗口无路由服务，应跳过页面注册并保留面板注册。

发布脚本按 Web 入口构建 `.artificer-dist/index.js`，导出 registerWeb/styles，宿主安装时直接加载产物。没有 ui 数据字段的纯界面插件同样会构建；后端插件无需伪造界面。源码与打包产物均不导入宿主源码。

已迁移页面保留原 `/plugin/<id>` 地址，面板标识为 pluginId/panelId。旧宿主需要先升级，不能继续使用旧清单兼容分支。`registry.json` 中的下载地址和校验和由实际发布流程生成，不应将未发布构建伪装成市场版本。

验证命令：`npm test`；逐个构建界面：`node scripts/build-plugin-ui.mjs plugins/<id>`；发布工作流自动扫描所有插件清单，包含全文搜索和运行时轨迹。
