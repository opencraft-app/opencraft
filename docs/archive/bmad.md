  📚 BMAD 开发流程指南

  工作流四阶段体系

  分析 → 规划 → 解决方案设计 → 实现

  第一阶段：分析（Analysis）

  目的: 理解产品机会和用户需求

  工作流:
  - /bmad-create-product-brief - 创建产品简报
    - 定义产品愿景、用户群体、成功指标、功能范围
    - 输出: product-brief.md
  - /bmad-product-brief-preview - 简报预览和验证
    - 多角色审查（分析师、机会审查员、怀疑论者）

  第二阶段：规划（Planning）

  目的: 详细规划产品需求和设计

  工作流:
  - /bmad-create-prd 或 /bmad-edit-prd - 创建/编辑产品需求文档
    - 详细的功能规范、用户故事、接受标准
    - 输出: prd.md
  - /bmad-validate-prd - PRD 验证
    - 检查覆盖范围、可测量性、完整性等 13 个验证点
  - /bmad-create-ux-design - UX/UI 设计规范
    - 用户研究、交互设计、组件策略
    - 输出: ux-design.md

  第三阶段：解决方案设计（Solutioning）

  目的: 架构设计和工作分解

  工作流:
  - /bmad-create-architecture - 创建系统架构
    - 技术栈决策、架构模式、系统结构
    - 输出: architecture.md
  - /bmad-create-epics-and-stories - 创建史诗和用户故事
    - 将需求转化为可执行的工作项
    - 输出: epics.md, stories.md
  - /bmad-check-implementation-readiness - 实现就绪检查
    - 验证所有前置条件是否满足

  第四阶段：实现（Implementation）

  目的: 开发、测试、部署

  工作流:
  - /bmad-sprint-planning - Sprint 规划
    - 选择故事、估算工作量、分配任务
  - /bmad-dev-story - 开发用户故事
    - TDD（测试驱动开发）
    - 检查清单: 需求理解、设计、实现、测试、文档
  - /bmad-code-review - 代码审查
    - 代码质量、架构一致性、性能审查
  - /bmad-sprint-status - Sprint 状态追踪
    - 进度汇报、障碍物识别
  - /bmad-retrospective - Sprint 回顾
    - 经验教训、改进点
  - /bmad-correct-course - 纠正方向
    - 处理偏差、调整计划

  ---
  🚀 快速流程（适合需求明确的场景）

  快速流程选项

  1. /bmad-quick-dev - 快速开发流程
    - 适合: 需求清晰、团队熟悉系统
    - 步骤: 模式检测 → 上下文收集 → 执行 → 审查 → 汇报
  2. /bmad-quick-dev-new-preview - 快速开发+预览
    - 适合: 新特性快速实现和验证
    - 步骤: 澄清 → 规划 → 实现 → 审查 → 呈现
  3. /bmad-quick-spec - 快速规范
    - 适合: 快速生成规范文档

  ---
  📖 下一步建议流程

  对于你当前的项目状态（需求大体清晰，需要进一步澄清）：

  推荐路径 1：完整流程（适合复杂项目）

  1. 运行 /bmad-create-product-brief
     → 获得产品简报

  2. 运行 /bmad-create-prd
     → 创建完整的需求文档

  3. 运行 /bmad-create-architecture
     → 设计系统架构

  4. 运行 /bmad-create-epics-and-stories
     → 分解为可执行的工作项

  5. 开始 Sprint 规划和开发

  推荐路径 2：快速流程（适合中等复杂度）

  1. 运行 /bmad-quick-dev-new-preview
     → 快速澄清、规划、实现、验证

  ---
  💡 核心概念

  代理（Agents）: 不同角色的 AI 助手
  - 产品经理 (PM): 需求和商业侧
  - 架构师 (Architect): 技术设计
  - 开发者 (Dev): 实现
  - QA: 测试和质量
  - 等等...

  工作流: 结构化的多步骤流程，涉及代理协作

  输出工件: 存储在 _bmad-output/ 下
  - planning-artifacts/ - 规划文档
  - implementation-artifacts/ - 实现产物

  ---
  🎯 现在你可以开始

  你现在有两个选择：

  1. 澄清需求 - 如果需要进一步明确需求，运行:
  /bmad-create-product-brief
  2. 快速开发 - 如果需求已很清晰，运行:
  /bmad-quick-dev-new-preview

  哪一个更符合你的需求？需要我帮你启动相应的工作流吗？