# Skills / Packages 展示边界

`SkillsDemoPanel` 持有 data layer、Bot/Profile 身份、搜索与已安装请求、批量队列和取消 ref。所有安装/卸载 key 仍为 `registry + rawId`。当前命令完成后才跳过已取消批次的剩余项；成功项保留并退出选择集。卸载确认期间不可关闭，操作结束后关闭；目标行消失时焦点回 Installed 页签。

`CuratedSkillDetailsView` 只接收名称、rawId、链接、结构化 overview、文案、installed/installing 和 `onInstall/onClose`。Dialog 的关闭不会取消安装；Portal 显式使用 `agents-ui`。运营 catalog、Featured 顺序与图片仍由原配置维护。

`CreateSkillPanel` 保留为独立可复用创建视图；当前路由未暴露 Create 页签。`LearnSkillDialog` 的 TSSH client、来源草稿、上传与学习进度仍归原 `agent-skills-panel` 容器；关闭 Dialog 不能代表远端学习取消。

`ExpertsPanel` 是 Experts/Packages 共用 controller，保留 pkg.slug、真实 skillSlugs、实例持久化、Profile 命令和完成判定。只有整包成功才记 installed，失败项重试沿用原流程；返回列表不取消安装。

`agent-experts-views` 导出 `ExpertToolbarView`、`ExpertPackageCardView`、`SkillPackageDetailLayout`、`SkillPackageModulesView`。视图接收受控 query/view/module slug、显示文案/节点和 actions，不读取 repository 或发请求。包详情仍为页面内视图，技能模块使用受控 Tabs，列表/卡片共享同一安装状态。
