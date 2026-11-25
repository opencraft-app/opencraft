# 部署与升级

所选版本、预期装配、实际运行状态和数据版本要分别建模。升级器负责提交切换结果，发布清单定义验收内容。服务健康、实际运行产物和核心库版本分别核验。

**目标样例。** 完成切换后，从正在运行的实例读取证据，通过验收再记录新版本。

```ts
await owners.switchTo(release);

const running = await owners.inspectRunningInstallation();
verifyRelease(release, running);

await deployment.recordApplied(release);
```

`verifyRelease` 核对实际镜像标识、健康状态、核心存储 contract 和清单要求的装配。失败恢复再次执行上一个版本的验收。镜像恢复和数据恢复各自记录结果。

**如何验证。** 用隔离实例从上一版升级，保留一份可核对的旧数据。模拟切换无效、旧实例仍健康，确认升级被判失败。再模拟部分切换失败，核实恢复后的实际镜像、数据可用性和关键能力。

现有参考见 [Compose 升级与回退](../scripts/container-deployment/compose-release.mjs) 和 [Docker 部署文档](../deploy/docker/README.md)。
