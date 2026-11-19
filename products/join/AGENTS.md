# Join 内部产品边界

本目录属于工蜂内部发行版，遵循根 AGENTS.md 的核心实现规则，以及
[内部发行版契约](../../docs/internal-distribution/README.md)。

本机源码分支是 `env/local`，远端为 `origin/env/local`；GitHub `upstream`
只拉取。核心和产品源码可在同一批次提交，产品不得绕开核心主体、授权、会话及
资源 owner。凭据仅在部署者私有配置中，不能进入源码、测试证据或发布回执。

Web 和 Gateway 通过正式产品入口构建；不要复制核心生命周期或修改运行容器文件。
发布继续使用仓库 fast-release 锁、固定提交、完整候选镜像、独立监督器和失败回退。
新增依赖、数据库、协议或跨服务变化必须扩大对应验证，不能套用纯 Web 更新流程。
