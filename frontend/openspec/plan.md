# 当前执行计划

> 当前需求：为国际站 LightVela 安全接入 PostHog 产品分析。

- [x] 在前端 observability 层新增 consent-gated PostHog 初始化、用户识别桥和基础事件 API。
- [x] 将 PostHog 配置接入 release matrix / Vite env，并保持默认关闭直到配置项目 token。
- [x] 增加依赖供应链防护配置与测试验证，避免新 npm 包静默执行安装脚本或泄漏环境配置。
