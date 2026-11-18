# 演示与验收脚本

继承[根规则](../AGENTS.md)。脚本可组合场景、采证和诊断，不拥有产品业务状态或代替用例服务。

check.mjs仅做语法检查。demo/fixture是机制演示；accept-personal-assistant.mjs拒绝fixture并调用personal-scenario。0.10.0场景拆到[scenarios](scenarios/AGENTS.md)，分别覆盖工作、记忆、自动化和技能的结构性断言，真实质量仍待模型运行与复查。扩展验收应记录模型模式、原输入、来源、产物、实际检查和未验证项。

使用新建隔离目录；不删除已有用户profile，不借共享凭据，不把质量标记改成通过来满足断言。所有进程在finally关闭，错误也留证。

验证：受影响脚本的对应tests与实际隔离演示；真实模型运行必须有当前明确授权连接。不得把自动断言与人工语义评估混为一谈。

0.9.0 personal-scenario额外采集usage/步骤保护、确认主助理已处理后台报告并测试明确秒数的自然语言interval创建。fixture演示只验证这些流程和采证脚本；accept:real仍需本人授权连接，尚未覆盖全部新能力的真实模型质量。

--scenario memory,work,automations,skills可选一项或多项，默认全部；每项必须能在新profile独立运行。未知/空/重复选择在创建目录前拒绝。失败停止后续场景并保存not_run，未选择记not_selected；诊断或关闭失败也保存并返回非零，不把未跑模块算通过。每个质量review不随自动断言变绿。

新增场景不要把业务服务搬到测试helper中，也不因已有事件/技能场景而宣称远程连接、日历理解、自动选择技能或敏感认证已验收。context里带场景前缀的输入ID只用于采证与重放身份，业务去重仍归InputInbox。
