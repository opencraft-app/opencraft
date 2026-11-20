# 技能内容与启用

继承[应用层规则](../AGENTS.md)。SkillService独占内容包安装、启用、不可变版本和执行加载回执，存取经SkillRepository。

模型只看到执行快照中的启用摘要，再按需load；安装/启用是操作者命令，不是模型工具。跨模块只暴露所需catalog/snapshot/available/load能力，不注入完整应用。

新执行捕获新目录；旧快照固定原版本，不能因更新获得新技能。停用阻止后续读取，但不能清除Pi已读上下文。加载检查原工作revision/取消，实际工具还须走ScopePolicy动作检查。技能正文不能授予工具、文件或凭据权限。

当前插件是JSON内容包，不是任意第三方JS生命周期或远程市场。不要为了接入一个技能增加通用插件框架；具体能力需要单独的授权工具adapter。

验证：`node --test test/skills.test.mjs`，含CLI安装/启停、Pi实际读取、版本恢复和撤销隔离。
