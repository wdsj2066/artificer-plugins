# 会话全文搜索

独立插件，需要 Artificer 1.1.6 或更高版本。为本地历史会话建立全文索引，跨会话搜索关键词并一键跳转到命中的会话。

安装后从「扩展 → 会话全文搜索」进入页面，同时向 Agent 注册一个只读工具 `searchConversations`，用于回忆之前讨论过的方案、代码或结论。

## 索引方式

- 直接以只读方式打开 `%APPDATA%/Artificer/sessions/*.db`，只读 `messages` 表的 `content` 字段，不修改任何宿主会话文件。
- 索引写入插件数据目录 `plugin-data/session-search/index.db`，使用 FTS5 的 `trigram` 分词，天然支持中文子串检索。
- 单个关键词少于三个字符时退回 `LIKE` 子串匹配，避免 trigram 无法命中短词。
- 索引库按需打开、用完即关，不长期持有文件句柄；会话文件按 `mtime` 与大小做增量判断，未变化的会话不重复索引。
- 已删除的会话文件在下次重建索引时从索引中移除。

## 设置

| 键 | 说明 |
| --- | --- |
| `includeToolResults` | 是否索引工具执行结果，默认关闭；开启后索引体积会明显增大 |
| `maxResults` | 页面搜索默认返回上限，10-100 |
| `autoIndex` | 插件加载后是否自动建索引，关闭后仅手动重建 |

## 接口

- `GET /api/plugins/session-search/status` 索引状态与进度
- `GET /api/plugins/session-search/search?q=&role=&sessionId=&limit=` 检索，返回带高亮标记的片段
- `GET /api/plugins/session-search/recent?limit=` 最近活跃会话
- `POST /api/plugins/session-search/reindex` 强制重建索引

片段高亮先做 HTML 转义再插入 `<mark>`，避免会话内容注入标记。

## 发布

在扩展仓库运行 `scripts/package-plugin.ps1 -PluginId session-search`，生成独立 ZIP；正式发布与市场索引由仓库发布工作流生成。
