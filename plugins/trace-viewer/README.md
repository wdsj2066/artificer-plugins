# 运行时轨迹

独立插件，需要 Artificer 1.1.0 或更高版本。把 Agent 运行时的 hook 事件实时记入内存环形缓冲区，供底部面板与独立页面查看轮次、AI 调用、工具调用、hook 触发与异常。

安装后从「扩展 → 运行时轨迹」进入完整页面，或在底部面板查看实时轨迹流。

## 记录内容

- `series` / `pipeline` / `waterfall` 通知型 hook：`beforeRun`、`beforeModelRound`、`stageChanged`、`runOutcome`、`afterRun`、`beforeAiCall`、`afterAiCall`、`buildMessages`、`buildTools`、`tryRecover`、`onClear`。
- `toolCall` 以 middleware 方式观察，记录工具名、参数摘要、结果状态与耗时。
- 载荷按敏感键名（`apiKey`、`token`、`secret`、`password`、`authorization`、`cookie` 等）脱敏为 `***`，深度超过 6 层或循环引用按占位符截断。

## 中间件双向转发约定

`toolCall` 是洋葱模型中间件，观察者必须把上层回传值继续向下传递：

```js
const iterator = next()
let answer
while (true) {
  const item = await iterator.next(answer)
  answer = undefined
  if (item.done) return item.value
  answer = yield item.value
}
```

若手动迭代时写成 `iterator.next()`（不透传值），交互型工具（如 `askUser`）的用户回答会在该层被吞掉，表现为「提交了回答但模型收到空内容」。宿主会把空回答判为 `empty_answer` 失败，但正确转发仍是插件自身的责任。

## 设置

| 键 | 说明 |
| --- | --- |
| `maxEvents` | 内存环形缓冲容量，100-20000，默认 1000 |
| `capturePayload` | 是否记录载荷摘要，关闭后只记事件名与耗时 |

## 接口

- `GET /api/plugins/trace-viewer/events?since=&limit=` 增量拉取轨迹事件

## 发布

在扩展仓库运行 `scripts/package-plugin.ps1 -PluginId trace-viewer` 生成独立 ZIP；正式发布、`<id>-v<version>` tag 与市场索引由 `release-plugins.yml` 工作流自动生成，无需手工修改 `registry.json`。
