# 第十二轮：模块AGENTS与分治地图

2026-11-02，提出人未确认。用户要求「每一个模块因为都是一个文件夹，弄一个Agents.md，分治地图」，并询问下一批很需要开发的能力。

本轮只改文档。为现有21个源码/工作目录增加AGENTS，加上根入口形成22份分层规则；总地图docs/module-map.md列出入口、职责、状态owner、对外接缝、验证和共享文件协作。平铺在application的核心模块按实际文件组说明，没有移动/复制业务实现，也没有为了地图创建空功能目录。

同步更新root导航、README、product/architecture当前摘要和roadmap，修正早期“技能/认证/通知尚未实现”及schema5等过时描述，保留各迭代原始背景。下一批P0为调度故障隔离、持久预算、真实模型质量验收，后续包括实际业务工具、自然语言安排、数据维护与平台装配。

通过新建隔离profile注入routine.tick异常，实际复现同一pump后续执行/接待/投递/学习都被跳过；evidence/module-map-pump-diagnosis.json记录known-gap-reproduced，未修复此运行器问题，未操作Join。还如实标记整app的旧Pi桥接、本地Vault同步校验和局部静态契约等现状，不把AGENTS当强制隔离实现。

验证为目录覆盖、本地链接、格式和原93个代码/SQL/依赖文件哈希不变；历史131/131保留为0.7.0机制证据，本轮未重跑业务测试。新验证记录见evidence/module-map-validation.json；旧源码归档和capabilities-validation.json固定不重写。
