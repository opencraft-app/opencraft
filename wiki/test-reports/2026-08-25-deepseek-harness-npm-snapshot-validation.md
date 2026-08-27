# DeepSeek Harness npm 快照安装复验报告

## 1. 结论

- 测试日期：2026-08-25
- 测试对象：DSH、SkillHub 与五个渠道插件的 npm-only 单文件安装器
- 测试环境：用户授权的独占 Ubuntu 24.04 测试主机
- 结果：首次安装、同快照重装、六插件加载、systemd 健康、回环 HTTP、release 保留与未知插件安全失败均通过
- 边界：本轮未覆盖北京 Hermes Sandbox 共存、浏览器到 TAT 的 `debug/exec` 端到端链路和 WebUI 同源代理

## 2. 解析快照

| 组件 | 本轮精确版本 | 来源 |
| --- | --- | --- |
| DeepSeek Harness | `0.1.1-rc.2` | npm |
| SkillHub | `0.2.16` | npm |
| QQBot | `0.1.5` | npm |
| 微信 | `0.2.5` | npm |
| 企业微信 | `0.1.5` | npm |
| Lark | `0.1.5` | npm |
| 钉钉 | `0.1.5` | npm |

安装任务先从 npm registry 解析七个 `latest` 的精确版本、HTTPS tarball 与 `dist.integrity`，写入 schema v3 manifest；runtime 和 profile 随后使用精确版本生成 lockfile，并以 `--frozen-lockfile` 安装。

## 3. 真实主机结果

| 场景 | 预期 | 结果 |
| --- | --- | --- |
| profile 含未知 `dsh-remote` | 修改服务前失败，保留旧环境 | 通过 |
| 清理后的首次安装 | 七个包全部解析、安装和校验成功 | 通过，64 秒 |
| 六插件清单 | SkillHub 与五个渠道插件版本匹配快照 | 通过 |
| systemd | enabled、active、无自动重启 | 通过，`NRestarts=0` |
| WebUI | 仅回环监听并返回成功 | 通过，`127.0.0.1:3080`、HTTP 200 |
| 同快照重装 | 复用 runtime，重新校验 profile | 通过，28 秒 |
| release 保留 | 重装不新增第三份 release | 通过，保持 2 份 |
| GitHub 依赖 | 安装日志不访问 GitHub/codeload | 通过，引用数 0 |

首次预检命中测试机原有的未知插件后，安装器未停止旧服务、未覆盖 profile。测试前对该 profile 同时保留原目录和压缩备份，随后才在干净 profile 上执行受管六插件组合。该行为证明未知插件边界是安全失败，不代表当前方案会迁移或保留任意第三方插件。

## 4. 本地回归

- Bash 语法检查通过。
- 安装器集成测试、单文件契约测试、快照复用与 release 保留测试通过。
- Hermes build 脚本测试通过。
- 前端生成器与命令测试通过。
- i18n 检查、项目检查和 `git diff --check` 通过。

## 5. 后续门禁

真实开放前仍需在北京 Hermes Sandbox 通过浏览器触发 `debug/exec`，验证 DSH 与 Hermes 共存、安装任务轮询、WebUI 同源代理、重启和模型配置完整链路。本报告的通用 Ubuntu 结果不能替代该环境验收。
