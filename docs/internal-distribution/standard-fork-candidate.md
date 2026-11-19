# 私有标准 fork 候选交付

此目录是隔离迁移候选，未推送 `master`、未公开 GitHub、未发布 npm、未部署。
本文件定义候选入口；旧 source-consumption 文档仅描述历史 consumer。
根目录是唯一可写源码，不运行 submodule 初始化、补丁重放或生成源码装配。
`products/join`、`relay` 及核心业务文件保持物化基线的内容。

`.ci/fork-provenance.json` 固定以下历史事实：

- 原内部 master consumer：`b8362db4f69a9ba6dce55aeeb45975fee40c6f27`。
- 原 consumer 装配的业务树：`1f4a65402e56c9f9d1b35c89be75d9c25260405f`。
- 公开核心基线：`3a813f9a49c60656b3a103ec5f0d74dd5365d3ef`。
- 候选物化提交：`ab86ae2b7ae2084818333752c5ecf4797497413b`，树与原业务树精确相同。

原 consumer tree 单独存档于 provenance，不能与装配业务树混称。原 consumer
历史由父迁移任务的独立 bundle 保留，不作为运行时源码依赖。来源检查验证候选
包含物化祖先、其树与父级 upstream；旧 consumer revision/tree 是历史回执，
候选独立 Git 数据库不声称拥有或重新验证旧 consumer 对象。

## 验证与构建入口

- `npm run ci:test:delivery`：Node 标准库及 Python 标准库回归，不安装依赖。
  包括来源污染/变更拒绝、部署安全、工作区权限、浏览器控制、流式文件清单与
  registry 上传状态机；上传测试使用内存模拟，不访问 registry。
- `npm run ci:verify`：完整 CI，要求 `.nvmrc` 的 Node 与原有系统依赖；从根目录
  `npm ci` 后运行原三项 workspace typecheck、Codex 与 Join/Relay 回归。须在独立验证 checkout 执行，结果另存外部验收记录。
- `npm run ci:build`：根目录 Web/Gateway 构建，验证版本与 Gateway 语法；回执位于
  新建的 `.local/ci/build.*/build.json`。需要事先安装依赖，须在独立验证 checkout 执行，结果另存外部验收记录。
- `npm run ci:build:image -- control`：Gateway/Brain/Proxy；`hands` / `all` 仍要求
  已验证自有 Electron 目录。Docker 内会执行 npm 安装，须在独立验证 checkout 执行，结果另存外部验收记录。
- `.ci/build-hands-electron.sh` 与缓存 runner 保留 native 来源验证、构建锁、原子产物交接。

构建前后均检查工作树干净、没有 gitlink，且当前 revision/tree 未改变。回执的
`sourceRevision/sourceTree/buildId` 是实际构建的标准 fork 身份；嵌套 `provenance`
保留原 consumer、业务树和 upstream 身份。镜像回执目录 `.local/ci/image.*` 同时
保留 source JSON 与不可变 image ID；旧 `.iid` 文件继续供既有工具消费。
每次回执目录独立，失败的 Web 构建仅可能留下 source JSON，不代表构建成功。

`docker/join-bake.hcl` 直接消费根源码，复用现有 Dockerfile 和新增 Join runtime
base。详见 [Join Docker 入口](../../docker/README.join.md)。部署模板和发布工具
迁入以保留交付能力；复制它们不授权执行。发布脚本、自动上传 timer/service
未启用，npm 不增加发布别名。需另行授权和实际 registry/部署验收。

## 仍需验收

完整 CI、Web/四角色镜像构建、自有 Electron 编译与运行、镜像内 Python/CA、
真实 cold recovery、登录、模型与外部服务均不能由轻量测试替代。独立 Gateway 基线已完成真实 592 提交导入与同机冷恢复；证据由父迁移任务保存，不等于异机容灾。本轮只允许授权的 gateway-test/* 测试分支，未更改生产、源 consumer 或正式 master。
