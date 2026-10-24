# 定时任务

独立插件，需要 Artificer 1.1.6 或更高版本。支持 cron 与固定间隔，执行 Agent 提示词、Shell 命令或 HTTP 请求。

安装后从「扩展 → 定时任务」进入，也提供右侧任务面板和五个 AI 工具。Agent 动作使用宿主 `ctx.sessions` / `ctx.workspaces` 服务，不导入宿主源码。

## 从内置版本升级

插件 ID 保持 `scheduler`，任务、历史和插件设置继续使用宿主原有的插件隔离存储，不需要导出或改写数据库。升级到不再内置此插件的宿主后，安装外部版本并启用，调度器即可加载旧任务。迁移期间宿主未安装或未启用插件时不执行调度；错过的执行按任务原有 misfirePolicy 处理。

停用、卸载或重载插件会停止调度器并释放定时器。Agent 动作默认拦截需确认的工具，只有任务明确配置 approvalMode=allow 才自动授权。Shell 和 HTTP 保留原有超时与并发限制。

## 发布

在扩展仓库运行 `scripts/package-plugin.ps1 -PluginId scheduler`，生成独立 ZIP；正式发布与市场索引由仓库发布工作流生成。
