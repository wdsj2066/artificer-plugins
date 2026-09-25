# Artificer Official Plugins

This repository contains the source code for official Artificer plugins.

A single repository can maintain multiple plugins, but each plugin is published, installed, updated, and uninstalled independently. The repository currently includes:

- `browser-automation`
- `channel-feishu`
- `channel-wecom`
- `token-usage`
- `office`
- `plugin-builder`
- `ui-compiler-vue`

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
.\scripts\package-plugin.ps1 -PluginId ui-compiler-vue
```

The package script creates `dist/<PluginId>-<version>.zip`. Each archive has exactly one top-level directory named after its plugin ID and prints its SHA-256 hash.

Pushes to `main` that touch `plugins/**` or `scripts/**` trigger the `Release Plugins` workflow: it packages only plugins with changes since their per-plugin release tag (`<pluginId>-v<version>`), publishes the ZIP to GitHub Releases with its SHA-256 in the release notes, and regenerates `registry.json` automatically.

The Vue compiler is published as separate Windows, Linux, and macOS archives for x64 and arm64 because Vite depends on platform-specific native binaries. The marketplace selects the matching archive using the host's reported platform. Ordinary UI plugins publish prebuilt browser assets and do not require this compiler at installation time.

## Plugin SDK

Plugins must not import Artificer source files by relative path. The host injects a stable `ctx` API at registration time. Use `ctx.getStore()` for plugin-owned state, `ctx.processChannelInbound()` for channel events, and `ctx.importModule(name)` only for audited host packages declared in `plugin.json.runtimeDependencies`. A plugin with dedicated dependencies should declare them in its own `package.json`; `scripts/package-plugin.ps1` installs those dependencies into the published plugin ZIP from its `package-lock.json`. Published Vue UI is prebuilt into `.artificer-dist`, so installing a marketplace plugin needs no compiler. The optional `ui-compiler-vue` backend plugin registers through `ctx.registerUiCompiler({ id, build })` for local source development and rebuilding. Development plugins use `ctx.runtimePlugins.readSourceFile()`, `writeSourceFiles()`, and `build()` to manage user-created runtime plugins.

## Marketplace

Marketplace registry: https://raw.githubusercontent.com/wdsj2066/artificer-plugins/main/registry.json

`registry.json` is generated automatically by the `Release Plugins` workflow (`.github/workflows/release-plugins.yml`) after each release is published. Each entry carries the plugin metadata from `plugin.json`, the release ZIP download URL and the ZIP SHA-256. Releases are tagged per plugin as `<pluginId>-v<version>`.
