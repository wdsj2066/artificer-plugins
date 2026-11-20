# Token 用量插件：实验性界面树

此分支的 Web 入口通过 `ctx.ui.registerRule` 向 `chat.input.footer` 树节点插入用量 UI。用量读取版本化的 `chat.session@1` 服务，显示设置由插件自己的 `token-usage@1` 服务提供，不依赖 `scope.slot` 或旧 `ui.inputFooter` 插槽。插件停用或卸载时，规则、服务和监听器随插件实例撤销。

用量区及其文本完全由插件声明为树节点；宿主只提供可被规则修改的输入区节点与对应状态服务。修改后需要使用支持实验性界面树接口的宿主重新构建并安装插件；旧版宿主没有该接口。

