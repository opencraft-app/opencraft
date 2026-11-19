# Join 私有 SQLite schema

员工准入和SSH凭据是Join私有数据，保持原文件、唯一owner与已发布v1历史。
每库schema.ts由Drizzle管理；baseline.json固定旧链身份；首次baseline SQL和snapshot
只作结构描述，不再次执行。migrations.generated.ts只打包冻结身份与后续增量。
公共核心的resolveMigrationContract连接同一个受管执行器，不导入产品schema。

- `npm run generate:storage -- --store join-employee-admission` 或 `join-employee-ssh`
- `npm run check:storage`
- 审查新增SQL后运行 `npm run freeze:storage -- --store <id>`，提交只追加的`published.json`
- `npm run test:storage` 与相关准入/SSH业务回归

生成由Drizzle Kit执行，编译/结构/历史/覆盖检查复用opencraft/scripts工具。
数据库中的策略、密钥与用户记录不参与生成；工具只读取源码和临时测试库。
既有SQL/name/version不改写，新增迁移从各库N+1开始；自动重建必须符合既有事务/外键契约。
generate/compile先验证冻结前缀，check要求所有条目已冻结；SQL、snapshot、tag、时间、
运行版本与编译SQL共同固定。freeze不会重新接受已冻结内容的改写。两私有owner的
legacyPolicy=reject继续有效，不因共享执行器支持跨接已知无账本基线而放宽。
