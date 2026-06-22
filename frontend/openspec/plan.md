# 当前执行计划

> 当前需求：LightVela Agent 控制台新增“专家”技能包安装功能。

- [x] 参考 SkillHub AI 搭子的 SkillSet/技能包模型，补齐 LightVela 读取 SkillSet 列表与详情的公共 API。
- [x] 在 `/agents` 左侧导航新增“专家”入口，展示金融、科技、设计、营销等专家场景和对应技能包。
- [x] 用户选择专家后，可安装该专家技能包内的一组 skills；安装链路复用 `debug/exec` 下发 `acli` 命令。
- [x] 为命令构造、SkillHub API、路由映射补充针对性测试，并运行 i18n 与类型检查。
