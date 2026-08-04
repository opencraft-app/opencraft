# 平台契约快照

`platform-v1.openapi.yaml` 是 `client-core` 构建时唯一使用的 OpenAPI
输入。更新后台契约时，先显式同步并审查该快照，再运行
`bun run generate:api`；CI 不依赖工作区外的后台源码。

`src/generated/openapi-lock.test.ts` 同时锁定快照和生成结果的 SHA-256，
避免后台或生成器变化被静默带入客户端。
