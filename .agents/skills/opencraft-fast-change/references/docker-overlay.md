# Docker 局部镜像与切换

仅在依赖不变、部署源码和动态入口可还原时使用。以下是操作形状，变量来自本次发现；不包含固定主机、镜像、项目或文件名。

## 发现基线

通过服务容器的 Compose 标签定位真实项目名、工作目录和全部配置文件；保留 `.env`、override 和有效启动参数。只输出必要摘要，不打印完整环境或渲染配置中的凭据。

```sh
docker inspect "$container" --format '{{.Image}}'
docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}'
docker inspect "$container" --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
```

记录 Docker 镜像 ID 与运行产物哈希。对照镜像里的 manifest、此前补丁清单和部署源码；不能假设标签、Git HEAD、manifest revision 三者相同。需要 Compose CLI 做配置验证不代表已能管理宿主机 Docker daemon。

## 构建最小镜像

先完成局部构建，在独立 context 中仅放本次编译产物、必要旁路文件和更新后的清单。完整检查 `COPY` 目录，避免夹带 `.env`、源码凭据、浏览器 profile、私有数据或其他任务产物。

若代码以 ESM/CJS bundle 交付，沿用正式构建的 target、format、externals、banner、包解析、Worker 和运行目录规则。不把替换字符串、复制 `.ts` 到运行目录视为编译。使用构建插件隔离 dirty 文件时，必须证明解析到的是基线加本次补丁，不能仅检查入口文件。

把已验证运行镜像 ID 标记为本次唯一的本地基础标签，并再次核对标签解析到该 ID。候选镜像构建示例：

```dockerfile
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
COPY overlay/ /opt/opencraft/
```

```sh
docker build --pull=false --build-arg BASE_IMAGE="$verified_base_tag" \
  --tag "$candidate_image" "$candidate_context"
```

`/opt/opencraft` 仅适用于当前正式镜像的安装契约；先核对实际镜像。基线镜像 ID 不同或正式打包方式变化时调整，不盲用示例。

在候选镜像中检查变更文件哈希和启动入口，确保所需动态文件存在。用隔离数据、独立 Compose 项目及可用端口做相关启动/请求烟测；不得复用生产数据库、生产监听端口或真实付费推理。共享认证/路由修复应验证入口拒绝行为，不能只测能启动。

如果仅网关 bundle 变化，保留原前端、Core/Brain 和执行层产物。不得为局部产物伪造一个覆盖所有组件的源码 revision；manifest 记录独立 patch/组件身份。

## 只更新目标服务

保存有效配置、容器镜像 ID、目标服务旧镜像和非目标服务的启动时间/身份。在项目实际配置中只将目标服务指向候选镜像；不要修改所有服务共用的镜像变量来完成单服务更新。

```sh
docker compose --project-name "$project" --env-file "$env_file" \
  -f "$compose_file" -f "$override_file" config --quiet
docker compose --project-name "$project" --env-file "$env_file" \
  -f "$compose_file" -f "$override_file" \
  up -d --no-deps --no-build --wait --wait-timeout 180 "$service"
```

配置文件数量、顺序和等待期限按实际部署决定。执行命令的环境也会影响 Compose 插值，独立 supervisor 应使用本次核验的环境，不能误继承测试/其他项目变量。切换必须执行在有管理入口的宿主机；当前代理依赖该服务时交给独立 supervisor。

健康检查通过后验证实际镜像 ID/清单、相关接口行为和非目标服务未被重启。保留前端不意味着已经验证浏览器中的真实操作。

## 回退与持久指针

失败恢复旧镜像和本次修改的配置文件，再按同一服务边界启动、检查健康。使用旧镜像和新 Compose 可能无法启动：镜像回退与配置回退必须匹配。超时后先查实际结果，不将同一业务 mutation 盲目重发。

独立任务应在替换前就持有回退所需脚本和配置，不能依赖稍后已被销毁容器中的 `/tmp`。宿主机 systemd 的工作目录、部署当前版本指针和持久 Compose 配置也要指向已验证版本，以免重启恢复旧部署。

不因局部代码变更自动搬数据库或会话 cwd。需要持久化迁移时退出此路径，使用正式迁移/备份策略。
