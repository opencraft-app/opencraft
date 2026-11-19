# 第七轮：按需技能与内容插件

用户的六项持续目标包含技能目录、启用、按需获取、插件装配；要求高内聚低耦合，不做过度设计。仍在独立无界面目录，不改Join。

## 实现

SkillService独占安装、启用和读取回执。SkillRepository持久化三个表：skill为当前目录/启用状态，skill_version保留不可变内容版本，skill_load记录执行实际读取的版本。没有新增插件进程或通用插件生命周期框架；插件以显式本地JSON内容包安装，一包1..32项，总目录最多128项。安装不自动启用，不接受模型安装建议。

执行快照只包含已启用技能的ID、摘要和内容哈希版本。Pi的list_skills/load_skill工具通过窄内容port读取正文；所有安装/启用能力不暴露给模型。正文最多32000字符，摘要500字符。技能内容不授予工具、路径或凭据权限；旧委托仍沿原工具范围，不因升级自动获得技能工具。

同一执行在插件更新后继续读取原版本；新执行捕获新版本。停用会阻止后续读取，已经读入原生Pi上下文的内容无法抹去。版本历史和读取回执持久保存，读取重试不重复记账；取消/过期工作版本无法读取。沿原ExecutionLedger保存执行快照，Pi仍独占原生工具checkpoint。

## 使用

启动runner后：

```sh
node bin/assistant.mjs skill-install --profile DIR --bundle examples/personal-skills.json
node bin/assistant.mjs skill-enable --profile DIR --skill personal/weekly-review --enabled true
node bin/assistant.mjs skill-list --profile DIR
node bin/assistant.mjs submit --profile DIR --text '整理周进展 [skill:personal/weekly-review]'
```

方括号选择是fixture验收约定；真实模型依靠摘要选择load_skill，尚未实测自然选择效果。用--enabled false停用。插件是内容包，不运行任意第三方JS、网络安装脚本或安装依赖。

## 验证与限制

新增测试涵盖包验证与原子性、默认停用、启用、摘要不含正文、版本固定、更新、重开、撤销启用、旧快照不扩大、取消/修改隔离、真实Pi工具读取和本地CLI装配。最初测试的错误文本断言和产物路径预期错误，以及一次缺少files测试辅助导入，保留在phase7-skills-initial/second.log；实现实际读取成功，不把这些失败伪装通过。

schema5→6仅新增三表，旧上下文快照原样保留。没有真实模型服务、远程插件市场或外部OpenCraft插件宿主验收。
