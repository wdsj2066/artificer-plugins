# Artificer Official Plugins

This repository contains the source code for official Artificer plugins.

A single repository can maintain multiple plugins, but each plugin is published, installed, updated, and uninstalled independently. The repository currently includes:

- `browser-automation`
- `channel-feishu`
- `channel-wecom`
- `token-usage`

Backend plugins must be manually reviewed to confirm that their declared `permissions` match their actual capabilities before installation or release.

## Release

Each plugin must be packaged into an independent ZIP file and uploaded to a GitHub Release. Do not package all plugins into a single installable ZIP.

```powershell
.\scripts\package-plugin.ps1 -PluginId browser-automation
.\scripts\package-plugin.ps1 -PluginId channel-feishu
.\scripts\package-plugin.ps1 -PluginId channel-wecom
.\scripts\package-plugin.ps1 -PluginId token-usage
```

The package script creates `dist/<PluginId>-<version>.zip`. Each archive has exactly one top-level directory named after its plugin ID and prints its SHA-256 hash.

## Marketplace

Marketplace index repository: https://github.com/wdsj2066/artificer-plugin-market

Marketplace registry: https://raw.githubusercontent.com/wdsj2066/artificer-plugin-market/main/registry.json