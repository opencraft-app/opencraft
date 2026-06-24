# 当前执行计划

> 当前需求：LightVela Agent 控制台新增“专家/技能包”安装功能，并合并到技能页面。

- [x] 参考 SkillHub AI 搭子的 SkillSet/技能包模型，补齐 LightVela 读取 SkillSet 列表与详情的公共 API。
- [x] 在 `/agents` 左侧导航新增“专家”入口，展示金融、科技、设计、营销等专家场景和对应技能包。
- [x] 用户选择专家后，可安装该专家技能包内的一组 skills；安装链路复用 `debug/exec` 下发 `acli` 命令。
- [x] 为命令构造、SkillHub API、路由映射补充针对性测试，并运行 i18n 与类型检查。
- [x] 参考 SkillHub 技能包展示样式，为专家技能包卡片接入同源专家头像资源。
- [x] 将专家技能包页面合并到技能页面，在技能页顶部提供“技能 / 技能包”两个 tab，移除独立专家入口。

> 近期 master 已合入需求：为国际站 LightVela 安全接入 PostHog 产品分析。

- [x] 在前端 observability 层新增 consent-gated PostHog 初始化、用户识别桥和基础事件 API。
- [x] 将 PostHog 配置接入 release matrix / Vite env，并保持默认关闭直到配置项目 token。
- [x] 增加依赖供应链防护配置与测试验证，避免新 npm 包静默执行安装脚本或泄漏环境配置。
